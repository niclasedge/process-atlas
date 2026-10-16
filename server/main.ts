/** HTTP surface of the atlas: the index, the diagrams, the previews, the app.
 *
 * Deno rather than a Python framework for one reason that shows up in `docker
 * stats`: `deno compile` produces a single binary with no interpreter, no
 * package manager and no import resolution at start-up, so the image is one
 * FROM-scratch-ish layer and the resident set is roughly half of uvicorn's.
 * Nothing here needs a framework -- there are six routes and one of them is a
 * static file server.
 */

import { serveDir } from "@std/http/file-server";
import { dirname, join } from "@std/path";
import { emptyDiagram, validate } from "./bpmn.ts";
import { type Entry, forget, scan } from "./corpus.ts";

export type Config = {
  diagramDir: string;
  staticDir: string;
  previewDir: string;
  edit: boolean;
};

/** Ids end up in filesystem lookups, so they get the narrow charset BPMN's own
 *  NCName allows anyway. Belt and braces against `../`. */
const ID_RE = /^[A-Za-z_][\w.\-]*$/;
/** A repo name becomes a directory. No dots, so `..` cannot be spelled at all. */
const REPO_RE = /^[a-z0-9][a-z0-9_-]*$/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function problem(status: number, detail: string): Response {
  return json({ detail }, status);
}

/** Write through a temp file in the same directory, then rename. A half-written
 *  .bpmn is a file the next scan cannot parse, and the index would go degraded
 *  for every reader at once. */
async function writeAtomic(target: string, body: string): Promise<void> {
  const tmp = `${target}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  try {
    await Deno.writeTextFile(tmp, body);
    await Deno.rename(tmp, target);
  } catch (error) {
    await Deno.remove(tmp).catch(() => {});
    throw error;
  }
  forget(target);
}

function view(entry: Entry) {
  const { mtime: _mtime, ...rest } = entry;
  return rest;
}

export function createHandler(config: Config): (request: Request) => Promise<Response> {
  const staticHandler = (request: Request) =>
    serveDir(request, { fsRoot: config.staticDir, quiet: true, showIndex: true });

  async function findEntry(id: string): Promise<Entry | Response> {
    if (!ID_RE.test(id)) return problem(400, "invalid process id");
    const index = await scan(config.diagramDir);
    const entry = index.processes.get(id);
    return entry ?? problem(404, `no process ${JSON.stringify(id)}`);
  }

  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);

    // ---- /health ---------------------------------------------------------
    // Monitoring (uptime checks) read this, and it reports the corpus rather than the process.
    // A viewer answering 200 with an empty diagram directory is exactly the
    // failure this endpoint exists to catch: the container is up and useless.
    if (path === "/health") {
      const index = await scan(config.diagramDir);
      const count = index.processes.size;
      // A parse error outranks an empty corpus even though both answer 503:
      // "empty" reads as "nothing was ever put here" and sends the reader to
      // the sync, while the actual cause is a file that does not parse.
      const status = index.errors.length ? "degraded" : count === 0 ? "empty" : "ok";
      return json({
        status,
        processes: count,
        parse_errors: index.errors,
        edit: config.edit,
      }, status === "ok" ? 200 : 503);
    }

    // ---- the index -------------------------------------------------------
    if (path === "/api/diagrams" && request.method === "GET") {
      const index = await scan(config.diagramDir);
      const processes = [...index.processes.values()]
        .sort((a, b) => a.repo.localeCompare(b.repo) || a.name.localeCompare(b.name))
        .map(view);
      return json({ edit: config.edit, errors: index.errors, processes });
    }

    // ---- create a process ------------------------------------------------
    if (path === "/api/diagrams" && request.method === "POST") {
      if (!config.edit) return problem(403, "edit mode is off (ATLAS_EDIT)");
      const body = await request.json().catch(() => null) as
        | { id?: string; name?: string; repo?: string }
        | null;
      if (!body) return problem(400, "expected a JSON body");

      const id = (body.id ?? "").trim();
      const repo = (body.repo ?? "").trim();
      const name = (body.name ?? "").trim() || id;
      if (!ID_RE.test(id)) {
        return problem(400, "id must start with a letter and hold only letters, digits, . - _");
      }
      if (!REPO_RE.test(repo)) return problem(400, "repo must be lowercase [a-z0-9_-]");

      const index = await scan(config.diagramDir);
      if (index.processes.has(id)) return problem(409, `process ${id} already exists`);

      const file = `${repo}/${id}.bpmn`;
      const target = join(config.diagramDir, repo, `${id}.bpmn`);
      // A file that exists without holding this id means the corpus disagrees
      // with itself -- refuse rather than overwrite whatever is there.
      if (await Deno.stat(target).then(() => true, () => false)) {
        return problem(409, `${file} already exists`);
      }
      await Deno.mkdir(dirname(target), { recursive: true });
      await writeAtomic(target, emptyDiagram(id, name));
      return json({ id, name, repo, file }, 201);
    }

    // ---- one diagram -----------------------------------------------------
    const diagramMatch = /^\/api\/diagrams\/(.+)$/.exec(path);
    if (diagramMatch) {
      const found = await findEntry(diagramMatch[1]);
      if (found instanceof Response) return found;
      const target = join(config.diagramDir, found.file);

      if (request.method === "GET") {
        return new Response(await Deno.readFile(target), {
          headers: { "content-type": "application/xml; charset=utf-8" },
        });
      }

      if (request.method === "PUT") {
        if (!config.edit) return problem(403, "edit mode is off (ATLAS_EDIT)");
        const body = await request.text();
        const broken = validate(body);
        if (broken) return problem(400, `not well-formed XML: ${broken}`);
        await writeAtomic(target, body);
        return json({ written: found.file, bytes: new TextEncoder().encode(body).length });
      }

      return problem(405, `${request.method} not allowed here`);
    }

    // ---- preview ---------------------------------------------------------
    // A PNG older than its .bpmn is not served at all. Comparing timestamps is
    // what makes the cache safe without an invalidation step: nothing has to
    // remember to delete anything, and a read-only image cannot get it wrong.
    const previewMatch = /^\/api\/preview\/(.+)\.png$/.exec(path);
    if (previewMatch) {
      const found = await findEntry(previewMatch[1]);
      if (found instanceof Response) return found;
      const png = join(config.previewDir, `${found.id}.png`);
      const stat = await Deno.stat(png).catch(() => null);
      if (!stat?.isFile) return problem(404, "no preview rendered");
      const rendered = stat.mtime?.getTime() ?? 0;
      if (rendered < found.mtime) return problem(404, "preview is older than the diagram");
      return new Response(await Deno.readFile(png), {
        headers: {
          "content-type": "image/png",
          "cache-control": "no-cache",
          etag: `"${rendered.toString(36)}-${stat.size.toString(36)}"`,
        },
      });
    }

    if (path.startsWith("/api/")) return problem(404, "no such endpoint");

    // Last, and it has to stay last: this one answers for every path.
    return await staticHandler(request);
  };
}

export function configFromEnv(): Config {
  return {
    diagramDir: Deno.env.get("ATLAS_DIAGRAM_DIR") ?? "diagrams",
    staticDir: Deno.env.get("ATLAS_STATIC_DIR") ?? "web/dist",
    previewDir: Deno.env.get("ATLAS_PREVIEW_DIR") ?? "previews",
    // Off by default: a viewer anyone who reaches it can write to is a
    // different service than a viewer. Turn it on together with a volume.
    edit: ["1", "true", "yes"].includes((Deno.env.get("ATLAS_EDIT") ?? "").toLowerCase()),
  };
}

if (import.meta.main) {
  const config = configFromEnv();
  const hostname = Deno.env.get("ATLAS_HOST") ?? "0.0.0.0";
  const port = Number(Deno.env.get("ATLAS_PORT") ?? 8080);

  // `atlas --health` is the container's HEALTHCHECK. Asking the binary that is
  // already there costs nothing; the alternative is a base image chosen for
  // whether it ships curl, which is how a 25 MB runtime becomes a 75 MB one.
  if (Deno.args.includes("--health")) {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(4000),
    }).catch(() => null);
    const body = await response?.text().catch(() => "") ?? "";
    console.log(body || "no response");
    Deno.exit(response?.ok ? 0 : 1);
  }

  Deno.serve({ hostname, port }, createHandler(config));
}
