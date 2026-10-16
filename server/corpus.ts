/** The corpus: every .bpmn under the diagram directory, indexed by process id.
 *
 * Keyed by process id and not by filename, because that is the condition for
 * drill-down without a mapping file: a `callActivity` names the process it calls
 * in `@calledElement`, that value is the `@id` of a `bpmn:process` somewhere in
 * the corpus -- possibly in another file -- and a file may hold more than one
 * process. So the index is process -> file, never the other way round.
 *
 * The repository a process belongs to is its first path segment under the
 * diagram directory. That is the only source: a second one (a manifest naming
 * the repo per file) would be a second place to be wrong, and the path is
 * already the thing `just sync` decides. Same single-source rule applies to the
 * directory layout: the path is the one place the grouping is decided.
 */

import { join, relative, SEPARATOR } from "@std/path";
import { readFile } from "./bpmn.ts";

export type Entry = {
  id: string;
  name: string;
  /** path relative to the diagram directory, always with forward slashes */
  file: string;
  /** first path segment, or "" for a file lying directly in the diagram dir */
  repo: string;
  calls: string[];
  /** calls that no process in the corpus answers */
  unresolved: string[];
  /** nobody calls this one, so it is an entry point */
  is_root: boolean;
  has_layout: boolean;
  /** epoch millis of the .bpmn, so the preview route can spot a stale PNG */
  mtime: number;
};

export type Index = {
  processes: Map<string, Entry>;
  errors: { file: string; error: string }[];
};

type CacheLine = { mtime: number; size: number; entries: Omit<Entry, "unresolved" | "is_root">[] };

/** Parsing the same unchanged file on every request is the one avoidable cost
 *  here; a stat is ~50x cheaper than a parse, so the cache is keyed on it. */
const cache = new Map<string, CacheLine>();

async function* bpmnFiles(root: string): AsyncGenerator<string> {
  let entries: AsyncIterable<Deno.DirEntry>;
  try {
    entries = Deno.readDir(root);
  } catch {
    return; // a missing diagram directory is an empty corpus, which /health reports
  }
  for await (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory) yield* bpmnFiles(path);
    else if (entry.isFile && entry.name.endsWith(".bpmn")) yield path;
  }
}

export async function scan(root: string): Promise<Index> {
  const processes = new Map<string, Entry>();
  const errors: { file: string; error: string }[] = [];
  const seen = new Set<string>();

  for await (const path of bpmnFiles(root)) {
    seen.add(path);
    const rel = relative(root, path).replaceAll(SEPARATOR, "/");
    const stat = await Deno.stat(path);
    const mtime = stat.mtime?.getTime() ?? 0;

    let line = cache.get(path);
    if (!line || line.mtime !== mtime || line.size !== stat.size) {
      try {
        const file = readFile(await Deno.readTextFile(path));
        const slash = rel.indexOf("/");
        line = {
          mtime,
          size: stat.size ?? 0,
          entries: file.processes.map((p) => ({
            id: p.id,
            name: p.name,
            file: rel,
            repo: slash < 0 ? "" : rel.slice(0, slash),
            calls: p.calls,
            has_layout: file.hasLayout,
            mtime,
          })),
        };
        cache.set(path, line);
      } catch (error) {
        cache.delete(path);
        errors.push({ file: rel, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
    }

    for (const entry of line.entries) {
      processes.set(entry.id, { ...entry, unresolved: [], is_root: true });
    }
  }

  for (const path of cache.keys()) if (!seen.has(path)) cache.delete(path);

  // Only now, with every process known, can a call be classified.
  for (const entry of processes.values()) {
    entry.unresolved = entry.calls.filter((id) => !processes.has(id));
    for (const id of entry.calls) {
      const target = processes.get(id);
      if (target) target.is_root = false;
    }
  }

  return { processes, errors };
}

/** Drop the memoised parse of one file. The write path calls this so an edit is
 *  visible on the next request even inside the same second, where mtime and
 *  size can both be unchanged. */
export function forget(path: string): void {
  cache.delete(path);
}
