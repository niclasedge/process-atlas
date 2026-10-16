#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env
/** Derive process candidates for a repo from what the repo already declares.
 *
 *   <root>/<dir>/.github/workflows/*.yml   --> deployment / CI processes
 *   <root>/<dir>/justfile                  --> testing + function processes
 *   <root>/<dir>/package.json "scripts"    --> the same, when there is no justfile
 *                                          --> plus one <repo>-overview over all of it
 *
 * Written to `<root>/<dir>/docs/processes/`, next to the code they describe --
 * not into `diagrams/`. That is where `just sync` reads from, so a scaffolded
 * file goes through layout.mjs and annotate.py like a hand-written one, and the
 * repo keeps its own processes when process-atlas is not around.
 *
 * Two rules, both borrowed from sync.ts:
 *
 *   - It never overwrites. An existing file is reported and left alone; the
 *     first generation is a starting point, everything after it is a human
 *     decision. `--force` is there for the case where the source really did
 *     change and the file was never touched -- it says what it replaces.
 *   - It never caps silently. A group that has more recipes than fit gets a
 *     note naming the ones left out, because a diagram that quietly shows 8 of
 *     23 steps reads as "this is the process".
 *
 * Why these three sources and not a code parser: they are the places where a
 * repo has *already* written down what its processes are. A workflow file is a
 * deployment process someone maintains because CI fails otherwise; a justfile
 * recipe exists because a human wanted a name for a sequence of commands. That
 * makes them the highest-yield input per line of code here -- and it means the
 * output is wrong in the same way the repo is wrong, which is visible, rather
 * than wrong in a way only this script understands.
 */

import { parse as parseYaml } from "@std/yaml";
import { basename, dirname, fromFileUrl, join, resolve } from "@std/path";
import { buildProcess, slug, type Step } from "./emit.ts";

const REPO_ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "..");

/** How many steps a generated process shows before the rest becomes a note.
 *  Past roughly this many, auto-layout produces a diagram longer than a screen,
 *  which is the point where a picture stops being easier than the source. */
const MAX_STEPS = 9;

type Group = "deployment" | "testing" | "funktion";

type Candidate = {
  id: string;
  name: string;
  group: Group;
  source: string;
  startName?: string;
  steps: Step[];
  /** Only the entry points go into the overview -- a sub-process reached by a
   *  callActivity is already visible from its caller. */
  top: boolean;
};

// ---------------------------------------------------------------------------
// helpers

function expandHome(path: string): string {
  if (!path.startsWith("~")) return path;
  const home = Deno.env.get("HOME");
  if (!home) throw new Error("~ in a path but no $HOME");
  return join(home, path.slice(1));
}

async function exists(path: string): Promise<boolean> {
  return await Deno.stat(path).then(() => true, () => false);
}

async function readIfPresent(path: string): Promise<string | null> {
  return await Deno.readTextFile(path).catch(() => null);
}

/** One line, short enough to read inside a note box. */
function oneLine(text: string, limit = 90): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/** A fork of one branch is just that branch; BPMN gateways that split into a
 *  single path are noise that auto-layout still spends a column on. */
function forkOrChain(branches: Step[][], name?: string): Step[] {
  const real = branches.filter((branch) => branch.length > 0);
  if (real.length === 0) return [];
  if (real.length === 1) return real[0];
  return [{ kind: "fork", name, branches: real }];
}

/** Leaves, not entries: a process whose whole body is one fork is not a
 *  one-step process, and the report is the only place anyone checks. */
function countSteps(steps: Step[]): number {
  return steps.reduce(
    (total, step) =>
      total + (step.kind === "fork" ? step.branches.reduce((n, b) => n + countSteps(b), 0) : 1),
    0,
  );
}

/** Keep the first MAX_STEPS and say what was dropped, on the last step that
 *  survived -- a note nobody reads is still better than a number nobody sees. */
function capped(steps: Step[], what: string): Step[] {
  if (steps.length <= MAX_STEPS) return steps;
  const kept = steps.slice(0, MAX_STEPS);
  const dropped = steps.slice(MAX_STEPS)
    .map((step) => (step.kind === "fork" ? step.name ?? "fork" : step.name));
  const last = kept[kept.length - 1];
  const note = `${dropped.length} weitere ${what}: ${oneLine(dropped.join(", "), 160)}`;
  kept[kept.length - 1] = last.kind === "fork"
    ? last
    : { ...last, note: last.note ? `${last.note}\n${note}` : note };
  return kept;
}

// ---------------------------------------------------------------------------
// detector 1: GitHub Actions

type Workflow = {
  name?: string;
  on?: unknown;
  jobs?: Record<string, { name?: string; needs?: string | string[]; steps?: unknown[] }>;
};

/** `on:` is the honest start event: it is literally the trigger. */
function triggerName(on: unknown): string {
  if (typeof on === "string") return on;
  if (Array.isArray(on)) return on.join(", ");
  if (on && typeof on === "object") return Object.keys(on).join(", ");
  return "Trigger";
}

function stepName(raw: unknown): { name: string; note?: string } {
  const step = (raw ?? {}) as { name?: string; uses?: string; run?: string };
  if (step.name) {
    return { name: oneLine(step.name, 60), note: step.uses ?? (step.run ? oneLine(step.run) : undefined) };
  }
  if (step.uses) return { name: oneLine(step.uses.split("@")[0], 60), note: step.uses };
  if (step.run) return { name: oneLine(step.run.split("\n")[0], 60), note: oneLine(step.run, 200) };
  return { name: "Schritt" };
}

async function fromWorkflows(repo: string, dir: string): Promise<Candidate[]> {
  const workflowDir = join(dir, ".github", "workflows");
  if (!await exists(workflowDir)) return [];
  const out: Candidate[] = [];

  for await (const entry of Deno.readDir(workflowDir)) {
    if (!entry.isFile || !/\.ya?ml$/.test(entry.name)) continue;
    const relative = `.github/workflows/${entry.name}`;
    const text = await readIfPresent(join(workflowDir, entry.name));
    if (!text) continue;

    let workflow: Workflow;
    try {
      workflow = parseYaml(text) as Workflow;
    } catch (error) {
      console.error(`  warn: ${relative} — ${(error as Error).message.split("\n")[0]}`);
      continue;
    }
    const jobs = Object.entries(workflow.jobs ?? {});
    if (jobs.length === 0) continue;

    const label = workflow.name ?? entry.name.replace(/\.ya?ml$/, "");
    const base = `${repo}-ci-${slug(entry.name.replace(/\.ya?ml$/, ""))}`;
    // YAML 1.1 reads a bare `on` as the boolean true. @std/yaml does not, but
    // a file that went through a tool which does will have the other key.
    const trigger = triggerName(workflow.on ?? (workflow as Record<string, unknown>)["true"]);

    // A single-job workflow is its own process; there is nothing to call into.
    if (jobs.length === 1) {
      const [, job] = jobs[0];
      out.push({
        id: base,
        name: label,
        group: "deployment",
        source: relative,
        startName: trigger,
        steps: capped(
          (job.steps ?? []).map((raw) => ({ kind: "task", ...stepName(raw) } as Step)),
          "Schritte",
        ),
        top: true,
      });
      continue;
    }

    // Several jobs: the dependency graph is the process, each job is a diagram.
    const waves: string[][] = [];
    const placed = new Set<string>();
    const needsOf = (name: string) => {
      const needs = workflow.jobs?.[name]?.needs;
      return needs === undefined ? [] : Array.isArray(needs) ? needs : [needs];
    };
    let guard = jobs.length + 1;
    while (placed.size < jobs.length && guard-- > 0) {
      const wave = jobs
        .map(([name]) => name)
        .filter((name) => !placed.has(name) && needsOf(name).every((n) => placed.has(n)));
      // A cycle, or a `needs:` naming a job that does not exist. Put the rest in
      // one wave rather than dropping them -- a missing job is the sort of thing
      // the picture should show.
      const next = wave.length ? wave : jobs.map(([name]) => name).filter((n) => !placed.has(n));
      next.forEach((name) => placed.add(name));
      waves.push(next);
    }

    const steps: Step[] = [];
    for (const wave of waves) {
      steps.push(...forkOrChain(
        wave.map((name) => [{
          kind: "call",
          name: workflow.jobs?.[name]?.name ?? name,
          calls: `${base}-${slug(name)}`,
        } as Step]),
        wave.length > 1 ? "parallel" : undefined,
      ));
    }
    out.push({
      id: base,
      name: label,
      group: "deployment",
      source: relative,
      startName: trigger,
      steps,
      top: true,
    });

    for (const [name, job] of jobs) {
      out.push({
        id: `${base}-${slug(name)}`,
        name: `${label}: ${job.name ?? name}`,
        group: "deployment",
        source: `${relative} (job ${name})`,
        startName: needsOf(name).length ? `nach ${needsOf(name).join(", ")}` : trigger,
        steps: capped(
          (job.steps ?? []).map((raw) => ({ kind: "task", ...stepName(raw) } as Step)),
          "Schritte",
        ),
        top: false,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// detector 2: justfile — and 3: package.json, which is the same shape

type Recipe = { name: string; doc?: string; deps: string[]; body: string[] };

/** Enough of just's grammar to find recipes: a name at column 0, a `:`, its
 *  dependencies, and the indented block under it. Not a parser -- assignments
 *  (`x := y`), settings and attributes are skipped by shape, and anything this
 *  gets wrong shows up as a step with a strange name, not as silence. */
export function parseJustfile(text: string): Recipe[] {
  const lines = text.split("\n");
  const recipes: Recipe[] = [];
  let doc: string | undefined;
  let current: Recipe | null = null;

  for (const line of lines) {
    if (/^\s/.test(line) && line.trim()) {
      if (current) current.body.push(line.trim());
      continue;
    }
    const comment = /^#\s?(.*)$/.exec(line.trim());
    if (comment) {
      // Only a comment directly above a recipe is its description; a section
      // banner ("# --- corpus ---") is not, and reads badly as a process name.
      doc = /^-+|^=+/.test(comment[1]) ? undefined : comment[1];
      continue;
    }
    if (!line.trim()) {
      current = null;
      doc = undefined;
      continue;
    }
    const head = /^([a-zA-Z_][\w-]*)((?:\s+[^\s:=]+)*)\s*:(?!=)\s*(.*)$/.exec(line);
    if (!head) {
      current = null;
      doc = undefined;
      continue;
    }
    current = {
      name: head[1],
      doc,
      deps: head[3].split(/\s+/).filter((d) => d && !d.startsWith("(")),
      body: [],
    };
    recipes.push(current);
    doc = undefined;
  }
  return recipes.filter((recipe) => !recipe.name.startsWith("_"));
}

const DEPLOY_RE = /^(deploy|release|publish|ship|up|down|push|sync|provision|bootstrap)/;
const TEST_RE = /^(test|lint|check|verify|audit|validate|fmt|typecheck|coverage)/;

function classify(name: string): Group {
  if (DEPLOY_RE.test(name)) return "deployment";
  if (TEST_RE.test(name)) return "testing";
  return "funktion";
}

/** `just build`, `pnpm run build`, `npm run build` -- a recipe calling a sibling.
 *  That sibling gets a callActivity when it is substantial enough to have its
 *  own diagram, which is what turns a flat list into a navigable atlas. */
function callee(command: string, known: Set<string>): string | null {
  const match = /(?:^|&&\s*|\|\s*)@?(?:just|pnpm run|npm run|yarn)\s+([\w:-]+)/.exec(command);
  return match && known.has(match[1]) ? match[1] : null;
}

function recipeSteps(
  recipe: Recipe,
  ownProcess: Map<string, string>,
  known: Set<string>,
): Step[] {
  const steps: Step[] = [];
  for (const dep of recipe.deps) {
    if (!known.has(dep)) continue;
    const target = ownProcess.get(dep);
    steps.push(
      target
        ? { kind: "call", name: dep, calls: target, note: "Abhängigkeit — läuft vorher" }
        : { kind: "task", name: dep, note: "Abhängigkeit — läuft vorher" },
    );
  }
  for (const line of recipe.body) {
    const command = line.replace(/^[@-]+/, "");
    const target = callee(command, known);
    const called = target ? ownProcess.get(target) : undefined;
    steps.push(
      called
        ? { kind: "call", name: target!, calls: called, note: oneLine(command) }
        : { kind: "task", name: oneLine(command.split(/\s+/).slice(0, 4).join(" "), 48), note: oneLine(command, 200) },
    );
  }
  return capped(steps, "Kommandos");
}

function fromRecipes(repo: string, recipes: Recipe[], source: string): Candidate[] {
  const known = new Set(recipes.map((r) => r.name));
  // A recipe earns its own diagram once it is more than one command: below
  // that the diagram says exactly what the one-line note in the group already
  // said, and every extra file makes the sidebar harder to read.
  const substantial = recipes.filter((r) => r.deps.length + r.body.length >= 3);
  const ownProcess = new Map(
    substantial.map((r) => [r.name, `${repo}-${classify(r.name)}-${slug(r.name)}`]),
  );

  const out: Candidate[] = substantial.map((recipe) => ({
    id: ownProcess.get(recipe.name)!,
    name: recipe.doc ?? `${basename(source)} ${recipe.name}`,
    group: classify(recipe.name),
    source: `${source} (${recipe.name})`,
    startName: `${basename(source) === "package.json" ? "pnpm run" : "just"} ${recipe.name}`,
    steps: recipeSteps(recipe, ownProcess, known),
    top: false,
  }));

  // One process per group over everything in it, so a repo with 40 recipes gets
  // three readable entry points instead of 40 equal ones.
  for (const group of ["deployment", "testing", "funktion"] as Group[]) {
    const members = recipes.filter((r) => classify(r.name) === group);
    if (members.length === 0) continue;
    const steps: Step[] = members.map((recipe) => {
      const target = ownProcess.get(recipe.name);
      const note = recipe.doc ?? (oneLine(recipe.body[0] ?? "", 120) || undefined);
      return target
        ? { kind: "call", name: recipe.name, calls: target, note }
        : { kind: "task", name: recipe.name, note };
    });
    out.push({
      id: `${repo}-${group}`,
      name: {
        deployment: "Deployment & Sync",
        testing: "Tests & Gates",
        funktion: "Funktionen",
      }[group],
      group,
      source,
      startName: `${members.length} Rezepte`,
      // Unordered on purpose: these are alternatives someone picks between, not
      // a sequence. A fork is BPMN's way of saying "all of these exist".
      // Cap before wrapping: capping afterwards counts the fork as one step and
      // silently lets every branch through, which is the case the cap is for.
      steps: forkOrChain(capped(steps, "Rezepte").map((step) => [step]), "wähle"),
      top: true,
    });
  }
  return out;
}

function fromPackageJson(repo: string, text: string): Candidate[] {
  let scripts: Record<string, string> = {};
  try {
    scripts = (JSON.parse(text).scripts ?? {}) as Record<string, string>;
  } catch {
    return [];
  }
  const recipes: Recipe[] = Object.entries(scripts).map(([name, command]) => ({
    name,
    deps: [],
    // `pre<x>`/`post<x>` are npm's own dependency edges; naming them as such is
    // more use than a diagram that pretends `prebuild` runs on its own.
    body: command.split(/\s*&&\s*/).map((part) => part.trim()).filter(Boolean),
  }));
  for (const recipe of recipes) {
    const pre = `pre${recipe.name}`;
    const post = `post${recipe.name}`;
    if (scripts[pre]) recipe.deps.push(pre);
    if (scripts[post]) recipe.body.push(`pnpm run ${post}`);
  }
  return fromRecipes(repo, recipes, "package.json");
}

// ---------------------------------------------------------------------------

function overview(repo: string, tops: Candidate[]): Candidate {
  return {
    id: `${repo}-overview`,
    name: `${repo}: Überblick`,
    group: "funktion",
    source: "scaffold",
    startName: "Repo",
    steps: forkOrChain(
      // No notes here on purpose: every branch would carry the same "justfile",
      // and n identical annotations are n rectangles competing for the same
      // white space. The source is already in the file's provenance comment.
      tops.map((candidate) => [{
        kind: "call",
        name: candidate.name,
        calls: candidate.id,
      } as Step]),
      "Prozesse",
    ),
    top: false,
  };
}

async function main() {
  const args = Deno.args.filter((a) => !a.startsWith("--"));
  const write = Deno.args.includes("--write");
  const force = Deno.args.includes("--force");
  if (args.length !== 1) {
    console.error("usage: scaffold.ts <repo> [--write] [--force]");
    Deno.exit(2);
  }

  const config = parseYaml(await Deno.readTextFile(join(REPO_ROOT, "sources.yml"))) as {
    root?: string;
    repos?: Record<string, string>;
  };
  const root = expandHome(config.root ?? "~/code");
  const key = args[0];
  // A repo that is not in sources.yml still scaffolds -- the diagrams land in
  // that repo either way, and the line to add here is printed at the end. The
  // alternative is editing a config file before finding out there is anything
  // worth generating.
  const dirName = config.repos?.[key] ?? key;
  const dir = join(root, dirName);
  const repo = slug(key);
  if (!await exists(dir)) {
    console.error(`${dir} existiert nicht`);
    Deno.exit(1);
  }

  const candidates: Candidate[] = [...await fromWorkflows(repo, dir)];
  const justfile = await readIfPresent(join(dir, "justfile")) ??
    await readIfPresent(join(dir, "Justfile"));
  if (justfile) {
    candidates.push(...fromRecipes(repo, parseJustfile(justfile), "justfile"));
  } else {
    const pkg = await readIfPresent(join(dir, "package.json"));
    if (pkg) candidates.push(...fromPackageJson(repo, pkg));
  }

  if (candidates.length === 0) {
    console.error(
      `${key}: nichts gefunden — weder .github/workflows/, justfile noch package.json-scripts`,
    );
    Deno.exit(1);
  }
  candidates.push(overview(repo, candidates.filter((c) => c.top)));

  const target = join(dir, "docs", "processes");
  if (write) await Deno.mkdir(target, { recursive: true });

  let written = 0;
  let skipped = 0;
  console.log(`${key} → ${target}${write ? "" : "   (Trockenlauf, --write schreibt)"}\n`);
  for (const candidate of candidates) {
    const file = join(target, `${candidate.id}.bpmn`);
    const there = await exists(file);
    const steps = countSteps(candidate.steps);
    if (there && !force) {
      skipped++;
      console.log(`  = ${candidate.id.padEnd(38)} existiert, unangetastet`);
      continue;
    }
    const verb = there ? "ersetzt" : "neu";
    console.log(
      `  ${write ? (there ? "~" : "+") : "?"} ${candidate.id.padEnd(38)} ${
        String(steps).padStart(2)
      } Schritte  ${verb}  ← ${candidate.source}`,
    );
    if (!write) continue;
    await Deno.writeTextFile(
      file,
      buildProcess({
        id: candidate.id,
        name: candidate.name,
        steps: candidate.steps,
        startName: candidate.startName,
        source: `${dirName}/${candidate.source}`,
      }),
    );
    written++;
  }

  console.log(`\n${written} geschrieben, ${skipped} übersprungen (existiert)`);
  if (!config.repos?.[key]) {
    console.log(`\nDamit sie im Atlas landen, in sources.yml unter repos:\n  ${repo}: ${dirName}`);
  }
  if (write) console.log("Danach: just sync && just previews");
}

if (import.meta.main) await main();
