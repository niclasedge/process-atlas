import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { type Config, createHandler } from "./main.ts";

const CALLER = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <bpmn:process id="Uebersicht" name="Gesamtsicht">
    <bpmn:callActivity id="c1" calledElement="Teil" />
    <bpmn:callActivity id="c2" calledElement="Fehlt" />
  </bpmn:process>
</bpmn:definitions>`;

const CALLEE = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <bpmn:process id="Teil" name="Teilprozess" />
</bpmn:definitions>`;

/** Caller and callee land in different files and different repos on purpose: an
 *  index keyed by filename, or one that resolves calls only within a file,
 *  passes every single-file test and fails here -- which is the whole point. */
async function fixture(
  edit = false,
): Promise<{ config: Config; handle: (r: Request) => Promise<Response>; dir: string }> {
  const dir = await Deno.makeTempDir({ prefix: "atlas-test-" });
  await Deno.mkdir(join(dir, "diagrams", "demo-repo"), { recursive: true });
  await Deno.mkdir(join(dir, "diagrams", "andere-repo"), { recursive: true });
  await Deno.mkdir(join(dir, "previews"), { recursive: true });
  await Deno.writeTextFile(join(dir, "diagrams", "demo-repo", "overview.bpmn"), CALLER);
  await Deno.writeTextFile(join(dir, "diagrams", "andere-repo", "part.bpmn"), CALLEE);

  const config: Config = {
    diagramDir: join(dir, "diagrams"),
    staticDir: join(dir, "static"),
    previewDir: join(dir, "previews"),
    edit,
  };
  return { config, handle: createHandler(config), dir };
}

const get = (handle: (r: Request) => Promise<Response>, path: string) =>
  handle(new Request(`http://t${path}`));

Deno.test("the index resolves calls across files and repos", async () => {
  const { handle, dir } = await fixture();
  const body = await (await get(handle, "/api/diagrams")).json();
  const byId = Object.fromEntries(body.processes.map((p: { id: string }) => [p.id, p]));

  assertEquals(byId.Uebersicht.calls, ["Fehlt", "Teil"]);
  assertEquals(byId.Uebersicht.unresolved, ["Fehlt"], "a call nobody answers must be named");
  assertEquals(byId.Uebersicht.is_root, true);
  assertEquals(byId.Teil.is_root, false, "being called is what makes a process not a root");
  assertEquals(byId.Uebersicht.repo, "demo-repo");
  assertEquals(byId.Teil.repo, "andere-repo", "the repo is the path, not the caller");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("diagrams are addressed by process id, never by filename", async () => {
  const { handle, dir } = await fixture();
  assertEquals((await get(handle, "/api/diagrams/Teil")).status, 200);
  assertStringIncludes(await (await get(handle, "/api/diagrams/Teil")).text(), 'id="Teil"');
  assertEquals((await get(handle, "/api/diagrams/part")).status, 404, "filename is not a key");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("a traversal attempt is rejected before it reaches the filesystem", async () => {
  const { handle, dir } = await fixture();
  const response = await get(handle, "/api/diagrams/..%2F..%2Fetc%2Fpasswd");
  assertEquals(response.status, 400);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("/health reports the corpus, not the process", async () => {
  const { handle, dir } = await fixture();
  const ok = await get(handle, "/health");
  assertEquals(ok.status, 200);
  assertEquals((await ok.json()).processes, 2);

  // Container up, nothing to show -- the failure a process check cannot see.
  await Deno.remove(join(dir, "diagrams", "demo-repo", "overview.bpmn"));
  await Deno.remove(join(dir, "diagrams", "andere-repo", "part.bpmn"));
  const empty = await get(handle, "/health");
  assertEquals(empty.status, 503);
  assertEquals((await empty.json()).status, "empty");

  await Deno.writeTextFile(join(dir, "diagrams", "kaputt.bpmn"), "<bpmn:process");
  const degraded = await get(handle, "/health");
  assertEquals(degraded.status, 503);
  assertEquals((await degraded.json()).status, "degraded");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("writing is refused unless edit mode is on", async () => {
  const { handle, dir } = await fixture(false);
  const put = await handle(
    new Request("http://t/api/diagrams/Teil", { method: "PUT", body: CALLEE }),
  );
  assertEquals(put.status, 403);
  const post = await handle(
    new Request("http://t/api/diagrams", {
      method: "POST",
      body: JSON.stringify({ id: "Neu", repo: "demo-repo" }),
    }),
  );
  assertEquals(post.status, 403);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("a malformed write leaves the file untouched", async () => {
  const { handle, dir } = await fixture(true);
  const target = join(dir, "diagrams", "andere-repo", "part.bpmn");

  const bad = await handle(
    new Request("http://t/api/diagrams/Teil", { method: "PUT", body: "<bpmn:process id=" }),
  );
  assertEquals(bad.status, 400);
  assertEquals(await Deno.readTextFile(target), CALLEE, "a rejected write must not land");

  const good = CALLEE.replace('name="Teilprozess"', 'name="Umbenannt"');
  const ok = await handle(new Request("http://t/api/diagrams/Teil", { method: "PUT", body: good }));
  assertEquals(ok.status, 200);
  assertStringIncludes(await Deno.readTextFile(target), 'name="Umbenannt"');

  // Same second, same size class -- the write path has to drop its own cache.
  const index = await (await get(handle, "/api/diagrams")).json();
  const teil = index.processes.find((p: { id: string }) => p.id === "Teil");
  assertEquals(teil.name, "Umbenannt", "an edit must be visible on the next request");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("creating a process places it in its repo directory", async () => {
  const { handle, dir } = await fixture(true);
  const created = await handle(
    new Request("http://t/api/diagrams", {
      method: "POST",
      body: JSON.stringify({ id: "Neuer", name: "Neuer Prozess", repo: "demo-repo" }),
    }),
  );
  assertEquals(created.status, 201);
  assertEquals((await created.json()).file, "demo-repo/Neuer.bpmn");

  const index = await (await get(handle, "/api/diagrams")).json();
  const entry = index.processes.find((p: { id: string }) => p.id === "Neuer");
  assertEquals(entry.repo, "demo-repo");
  assert(entry.has_layout, "a new diagram must carry DI or the viewer re-lays it out");

  const twice = await handle(
    new Request("http://t/api/diagrams", {
      method: "POST",
      body: JSON.stringify({ id: "Neuer", repo: "demo-repo" }),
    }),
  );
  assertEquals(twice.status, 409, "a duplicate id would make the index ambiguous");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("a repo name cannot escape the diagram directory", async () => {
  const { handle, dir } = await fixture(true);
  for (const repo of ["../etc", "..", "Gross", "a/b"]) {
    const response = await handle(
      new Request("http://t/api/diagrams", {
        method: "POST",
        body: JSON.stringify({ id: "X", repo }),
      }),
    );
    assertEquals(response.status, 400, `repo ${JSON.stringify(repo)} must be rejected`);
  }
  await Deno.remove(dir, { recursive: true });
});

Deno.test("a preview older than its diagram is not served", async () => {
  const { handle, dir } = await fixture();
  const png = join(dir, "previews", "Teil.png");
  assertEquals((await get(handle, "/api/preview/Teil.png")).status, 404, "none rendered yet");

  await Deno.writeFile(png, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  assertEquals((await get(handle, "/api/preview/Teil.png")).status, 200);

  // The whole point of the timestamp check: an edited diagram must not keep
  // showing the picture of what it used to be.
  const stale = new Date(Date.now() - 60_000);
  await Deno.utime(png, stale, stale);
  assertEquals((await get(handle, "/api/preview/Teil.png")).status, 404);
  await Deno.remove(dir, { recursive: true });
});
