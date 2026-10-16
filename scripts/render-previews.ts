#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-run
/** Render one PNG per process into previews/, for the sidebar hover.
 *
 * This runs on the controller and never in the container. Rendering goes
 * through puppeteer, which needs a Chrome -- some 150 MB of browser to draw a
 * picture that changes only when a .bpmn changes. Putting that in the image
 * would multiply its size and its idle memory for a thumbnail; putting it in
 * `just sync` costs a few seconds, once, where a browser already exists.
 *
 * The file is named after the *process id*, not the file, because that is what
 * the API is addressed by. A file holding several processes therefore yields
 * several identical PNGs -- rare, and cheaper than teaching the viewer a second
 * addressing scheme.
 *
 * Nothing invalidates these. `/api/preview/<id>.png` refuses to serve a PNG
 * older than its .bpmn, so a stale one is invisible rather than wrong, and the
 * next run replaces it.
 */

import { dirname, fromFileUrl, join, resolve } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { readFile } from "../server/bpmn.ts";

const REPO_ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "..");
const DIAGRAMS = join(REPO_ROOT, "diagrams");
const PREVIEWS = join(REPO_ROOT, "previews");

const config = parseYaml(await Deno.readTextFile(join(REPO_ROOT, "sources.yml"))) as {
  root?: string;
  pipeline?: string;
};
const home = Deno.env.get("HOME") ?? "";
const root = (config.root ?? "~/code").replace(/^~/, home);
const render = join(root, config.pipeline ?? "bpmn-pipeline", "render.sh");

if (!await Deno.stat(render).then((s) => s.isFile, () => false)) {
  console.error(`render.sh nicht gefunden: ${render}`);
  console.error("previews/ bleibt leer — die Sidebar rendert die Vorschau dann im Browser.");
  Deno.exit(1);
}

await Deno.mkdir(PREVIEWS, { recursive: true });

async function* bpmnFiles(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) yield* bpmnFiles(path);
    else if (entry.isFile && entry.name.endsWith(".bpmn")) yield path;
  }
}

const force = Deno.args.includes("--force");
let rendered = 0;
let skipped = 0;
const failed: string[] = [];

for await (const path of bpmnFiles(DIAGRAMS)) {
  const source = await Deno.stat(path);
  const sourceTime = source.mtime?.getTime() ?? 0;

  let ids: string[];
  try {
    ids = readFile(await Deno.readTextFile(path)).processes.map((p) => p.id);
  } catch (error) {
    failed.push(`${path}: ${error instanceof Error ? error.message : error}`);
    continue;
  }
  if (!ids.length) continue;

  const first = join(PREVIEWS, `${ids[0]}.png`);
  const existing = await Deno.stat(first).catch(() => null);
  if (!force && existing && (existing.mtime?.getTime() ?? 0) >= sourceTime) {
    skipped += ids.length;
    continue;
  }

  // --margin 12: a hover preview is small, so a wide white border would eat the
  // pixels the diagram needs. --scale 2 because the preview is displayed
  // narrower than the PNG is wide, and on a 2x display anything less renders
  // visibly soft -- which reads as "the diagram is unreadable", not as "the
  // thumbnail is low-res".
  const { success, stderr } = await new Deno.Command("bash", {
    args: [render, path, first, "--scale", "2", "--margin", "12"],
    stdout: "null",
    stderr: "piped",
  }).output();

  if (!success) {
    failed.push(`${ids[0]}: ${new TextDecoder().decode(stderr).trim().split("\n").pop()}`);
    continue;
  }
  for (const id of ids.slice(1)) await Deno.copyFile(first, join(PREVIEWS, `${id}.png`));
  rendered += ids.length;
  console.log(`  ${ids.join(", ")}`);
}

console.log(`\n${rendered} gerendert, ${skipped} aktuell`);
if (failed.length) {
  console.error(`\n${failed.length} fehlgeschlagen:`);
  for (const line of failed) console.error(`  ${line}`);
  Deno.exit(1);
}
