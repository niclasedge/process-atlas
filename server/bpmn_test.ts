import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { emptyDiagram, readFile, validate } from "./bpmn.ts";

const wrap = (inner: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL">
${inner}
</bpmn:definitions>`;

Deno.test("collects processes with their calls, deduplicated and sorted", () => {
  const info = readFile(wrap(`
  <bpmn:process id="Root" name="Gesamtsicht">
    <bpmn:callActivity id="a" calledElement="Zwei" />
    <bpmn:callActivity id="b" calledElement="Eins" />
    <bpmn:callActivity id="c" calledElement="Eins" />
  </bpmn:process>
  <bpmn:process id="Eins" name="Erster" />`));

  assertEquals(info.processes.map((p) => p.id), ["Root", "Eins"]);
  assertEquals(info.processes[0].calls, ["Eins", "Zwei"]);
  assertEquals(info.processes[1].name, "Erster");
});

Deno.test("a nested callActivity still belongs to its process", () => {
  // bpmn-js writes sub-processes and lanes; a call two levels down is a call.
  const info = readFile(wrap(`
  <bpmn:process id="Root">
    <bpmn:subProcess id="sub">
      <bpmn:callActivity id="a" calledElement="Deep" />
    </bpmn:subProcess>
  </bpmn:process>`));
  assertEquals(info.processes[0].calls, ["Deep"]);
});

Deno.test("a call outside any process belongs to none", () => {
  const info = readFile(wrap(`
  <bpmn:process id="Root" />
  <bpmn:callActivity id="stray" calledElement="Nowhere" />`));
  assertEquals(info.processes[0].calls, []);
});

Deno.test("hasLayout keys on BPMNShape, not on BPMNDiagram", () => {
  // An empty <BPMNDiagram> renders to nothing just the same, so it must not
  // count as layout -- the viewer would skip its fallback and show a blank.
  const empty = readFile(wrap(`
  <bpmn:process id="P" />
  <bpmndi:BPMNDiagram xmlns:bpmndi="http://x" id="D"><bpmndi:BPMNPlane id="Pl" /></bpmndi:BPMNDiagram>`));
  assert(!empty.hasLayout);

  const real = readFile(wrap(`
  <bpmn:process id="P" />
  <bpmndi:BPMNDiagram xmlns:bpmndi="http://x" id="D"><bpmndi:BPMNPlane id="Pl">
    <bpmndi:BPMNShape id="S" bpmnElement="P" /></bpmndi:BPMNPlane></bpmndi:BPMNDiagram>`));
  assert(real.hasLayout);
});

Deno.test("comments and CDATA cannot forge a tag", () => {
  const info = readFile(wrap(`
  <!-- <bpmn:process id="Kommentar" /> -->
  <bpmn:process id="Echt">
    <bpmn:documentation><![CDATA[ <bpmn:process id="CDATA" /> ]]></bpmn:documentation>
  </bpmn:process>`));
  assertEquals(info.processes.map((p) => p.id), ["Echt"]);
});

Deno.test("an unescaped '>' inside an attribute does not end the tag", () => {
  // XML allows it, and a name like "A > B" is exactly what a modeller types.
  const info = readFile(wrap(`<bpmn:process id="P" name="Pruefen > Freigeben" />`));
  assertEquals(info.processes[0].name, "Pruefen > Freigeben");
});

Deno.test("entities in names and ids are resolved", () => {
  const info = readFile(wrap(`<bpmn:process id="P" name="A &amp; B &#252;ber C" />`));
  assertEquals(info.processes[0].name, "A & B über C");
});

Deno.test("validate rejects what would break the next scan", () => {
  assertEquals(validate(wrap(`<bpmn:process id="P" />`)), null);
  assertStringIncludes(validate(`<a><b></a>`) ?? "", "</a> closes <b>");
  assertStringIncludes(validate(`<a>`) ?? "", "unclosed <a>");
  assertStringIncludes(validate(`<a/><b/>`) ?? "", "second root");
  assertStringIncludes(validate(``) ?? "", "no elements");
  assertStringIncludes(validate(`<a attr="unterminated`) ?? "", "unterminated tag");
});

Deno.test("a new diagram carries DI and parses", () => {
  const xml = emptyDiagram("neuer_prozess", "Neu & schön");
  assertEquals(validate(xml), null);
  const info = readFile(xml);
  assertEquals(info.processes[0].name, "Neu & schön");
  assert(info.hasLayout, "without DI the viewer falls back to browser layout");
});
