import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { buildProcess, slug, type Step } from "./emit.ts";
import { parseJustfile } from "./scaffold.ts";

/** Every sequenceFlow id that a node names as incoming or outgoing. */
function wired(xml: string): Set<string> {
  return new Set(
    [...xml.matchAll(/<bpmn:(?:incoming|outgoing)>([^<]+)</g)].map((m) => m[1]),
  );
}

function flowIds(xml: string): string[] {
  return [...xml.matchAll(/<bpmn:sequenceFlow id="([^"]+)"/g)].map((m) => m[1]);
}

Deno.test("every flow is stated on both of its ends", () => {
  // This is the invariant that makes the file layoutable. bpmn-auto-layout
  // walks the graph through incoming/outgoing, not through sourceRef/targetRef,
  // so a file missing them produces a column of shapes with no edges at all --
  // valid, renderable, unreadable. It failed silently once; this is the guard.
  const xml = buildProcess({
    id: "p",
    name: "P",
    steps: [
      { kind: "task", name: "eins" },
      { kind: "fork", name: "gabel", branches: [[{ kind: "task", name: "a" }], [{
        kind: "call",
        name: "b",
        calls: "other",
      }]] },
      { kind: "task", name: "drei" },
    ],
  });
  const flows = flowIds(xml);
  assert(flows.length > 0);
  assertEquals(wired(xml), new Set(flows));
  // and each one exactly twice: once as an outgoing, once as an incoming
  for (const id of flows) {
    assertEquals(xml.split(`>${id}<`).length - 1, 2, `${id} is not stated twice`);
  }
});

Deno.test("a fork joins back, so the process has one end", () => {
  const xml = buildProcess({
    id: "p",
    name: "P",
    steps: [{
      kind: "fork",
      branches: [
        [{ kind: "task", name: "a" }],
        [{ kind: "task", name: "b" }, { kind: "task", name: "c" }],
      ],
    }],
  });
  assertEquals((xml.match(/<bpmn:parallelGateway/g) ?? []).length, 2);
  assertEquals((xml.match(/<bpmn:endEvent/g) ?? []).length, 1);
  assertStringIncludes(xml, 'targetRef="p_end"');
});

Deno.test("a callActivity names the process it opens", () => {
  const xml = buildProcess({
    id: "p",
    name: "P",
    steps: [{ kind: "call", name: "Deploy", calls: "other-process", note: "aus dem justfile" }],
  });
  assertStringIncludes(xml, 'calledElement="other-process"');
  assertStringIncludes(xml, "<bpmn:text>aus dem justfile</bpmn:text>");
});

Deno.test("names that carry XML are escaped, not dropped", () => {
  const xml = buildProcess({
    id: "p",
    name: "P",
    steps: [{ kind: "task", name: 'a & b <c> "d"' }],
  });
  assertStringIncludes(xml, 'name="a &amp; b &lt;c&gt; &quot;d&quot;"');
});

Deno.test("slug yields something usable as both a filename and a URL segment", () => {
  assertEquals(slug("Deploy & Sync!"), "deploy-sync");
  assertEquals(slug("__"), "x");
  assertEquals(slug("CI / CD"), "ci-cd");
});

Deno.test("the justfile parser finds recipes, deps, bodies and their doc line", () => {
  const recipes = parseJustfile(`
set shell := ["bash", "-c"]

# --- section banner, not a description ---

# Run the tests
test: build
    deno test
    @echo done

_private:
    true

build:
    deno check server/
`);
  assertEquals(recipes.map((r) => r.name), ["test", "build"]);
  const test = recipes[0];
  assertEquals(test.doc, "Run the tests");
  assertEquals(test.deps, ["build"]);
  assertEquals(test.body, ["deno test", "@echo done"]);
});

Deno.test("a fork of one branch stays a straight line", () => {
  // Emitted by scaffold whenever a CI wave holds a single job. A gateway there
  // costs a column and says nothing.
  const step: Step = { kind: "fork", branches: [[{ kind: "task", name: "nur eins" }]] };
  const xml = buildProcess({ id: "p", name: "P", steps: [step] });
  // emit.ts does not collapse it -- scaffold does, via forkOrChain. Assert the
  // shape emit actually produces so the split of responsibility stays visible.
  assertEquals((xml.match(/<bpmn:parallelGateway/g) ?? []).length, 2);
});
