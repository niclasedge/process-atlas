#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-run
/** Pull .bpmn sources into diagrams/<repo>/, laid out and annotated.
 *
 *   <root>/<dir>/docs/processes/*.bpmn --> layout.mjs --> annotate.py --> diagrams/<repo>/
 *
 * Why the layout happens here and not in the browser: bpmn-auto-layout walks
 * sequence flows, so a textAnnotation -- which hangs off an association -- never
 * gets a shape and the note is silently missing. annotate.py fills that gap and
 * is Python, so the step runs on the controller. The frontend still falls back
 * to browser layout when a file arrives without DI; it says so in the status bar,
 * because that is the one case where a diagram is complete but its notes are not.
 *
 * This never deletes. A file in diagrams/ that no source produced is reported,
 * not removed -- edit mode writes new diagrams into exactly this directory, and
 * a sync that tidied them away would silently delete work done in the editor.
 */

import { parse as parseYaml } from "@std/yaml";
import { basename, dirname, fromFileUrl, join, resolve } from "@std/path";

type Sources = { root?: string; pipeline?: string; repos?: Record<string, string> };

const REPO_ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "..");

function expandHome(path: string): string {
  if (!path.startsWith("~")) return path;
  const home = Deno.env.get("HOME");
  if (!home) throw new Error("~ in a path but no $HOME");
  return join(home, path.slice(1));
}

async function run(cmd: string, args: string[]): Promise<{ ok: boolean; err: string }> {
  const { success, stderr } = await new Deno.Command(cmd, {
    args,
    stdout: "null",
    stderr: "piped",
  }).output();
  return { ok: success, err: new TextDecoder().decode(stderr).trim() };
}

async function exists(path: string): Promise<boolean> {
  return await Deno.stat(path).then(() => true, () => false);
}

async function onPath(binary: string): Promise<boolean> {
  return (await run("sh", ["-c", `command -v ${binary}`])).ok;
}

const config = parseYaml(
  await Deno.readTextFile(join(REPO_ROOT, "sources.yml")),
) as Sources;

const root = expandHome(config.root ?? "~/code");
const pipeline = config.pipeline ? join(root, config.pipeline) : "";
const layout = pipeline ? join(pipeline, "layout.mjs") : "";
const annotate = pipeline ? join(pipeline, "annotate.py") : "";

const canLayout = Boolean(layout) && await exists(layout) && await onPath("node");
const canAnnotate = Boolean(annotate) && await exists(annotate) && await onPath("uv");
if (!canLayout) {
  console.error(`warn: ${layout || "<no pipeline>"} nicht nutzbar — rohe Kopie, Browser layoutet`);
} else if (!canAnnotate) {
  console.error(`warn: ${annotate} nicht nutzbar — Notizen fehlen in generierten Layouts`);
}

let copied = 0;
let laidOut = 0;
const produced = new Set<string>();
const problems: string[] = [];

for (const [repo, dir] of Object.entries(config.repos ?? {})) {
  const source = join(root, dir, "docs", "processes");
  if (!await exists(source)) {
    problems.push(`${repo}: ${source} existiert nicht`);
    continue;
  }
  const target = join(REPO_ROOT, "diagrams", repo);
  await Deno.mkdir(target, { recursive: true });

  let found = 0;
  for await (const entry of Deno.readDir(source)) {
    if (!entry.isFile || !entry.name.endsWith(".bpmn")) continue;
    found++;
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    produced.add(to);

    // A file that brought its own DI keeps it: hand-placed shapes are a
    // decision, and re-layouting would throw it away without saying so.
    const xml = await Deno.readTextFile(from);
    if (canLayout && !xml.includes("BPMNShape")) {
      const built = await run("node", [layout, from, to]);
      if (!built.ok) {
        problems.push(`${repo}/${entry.name}: layout.mjs — ${built.err.split("\n").pop()}`);
        continue;
      }
      if (canAnnotate) {
        const noted = await run("uv", ["run", "--quiet", annotate, to]);
        if (!noted.ok) problems.push(`${repo}/${entry.name}: annotate.py — ${noted.err}`);
      }
      laidOut++;
    } else {
      await Deno.copyFile(from, to);
      copied++;
    }
  }
  console.log(`${repo}: ${found} aus ${source}`);
}

// Anything in diagrams/ that no source produced. Usually a diagram created in
// edit mode -- which is why this reports instead of deleting.
for await (const repoDir of Deno.readDir(join(REPO_ROOT, "diagrams"))) {
  if (!repoDir.isDirectory) continue;
  for await (const file of Deno.readDir(join(REPO_ROOT, "diagrams", repoDir.name))) {
    const path = join(REPO_ROOT, "diagrams", repoDir.name, file.name);
    if (file.name.endsWith(".bpmn") && !produced.has(path)) {
      console.log(`  nur lokal: ${repoDir.name}/${basename(path)}`);
    }
  }
}

console.log(`\n${laidOut} layoutet, ${copied} übernommen (DI schon vorhanden)`);
if (problems.length) {
  console.error(`\n${problems.length} Problem(e):`);
  for (const line of problems) console.error(`  ${line}`);
  Deno.exit(1);
}
