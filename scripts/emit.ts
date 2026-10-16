/** Build a .bpmn from a list of steps.
 *
 * Deliberately no DI: `just sync` runs the diagram through layout.mjs and
 * annotate.py, which place the shapes *and* the notes. Emitting positions here
 * would mean emitting worse ones, and a file that already carries `BPMNShape`
 * is treated by sync as hand-placed and left alone -- so a generated layout
 * would also block the good one.
 *
 * The shapes are the four that carry the meaning of a generated process: a task
 * is a step, a callActivity is a step that has its own diagram, a note is what
 * the source said about it, and the gateway is a fork the source declared.
 * Anything richer is a human decision and belongs in the edited file.
 */

export type Step =
  | { kind: "task"; name: string; note?: string }
  | { kind: "call"; name: string; calls: string; note?: string }
  | { kind: "fork"; name?: string; branches: Step[][] };

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** BPMN ids are XML NCNames, and the atlas addresses processes by id -- so an id
 *  is both a filename component and a URL segment. Keep it to the intersection. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "x";
}

type Node = { id: string; tag: string; attrs: string; incoming: string[]; outgoing: string[] };

export function buildProcess(
  { id, name, steps, startName = "Start", endName = "Fertig", source }: {
    id: string;
    name: string;
    steps: Step[];
    startName?: string;
    endName?: string;
    source?: string;
  },
): string {
  const nodes: Node[] = [];
  const byId = new Map<string, Node>();
  const flows: string[] = [];
  const notes: string[] = [];
  let seq = 0;
  let note = 0;

  const add = (nid: string, tag: string, attrs: string): string => {
    const node: Node = { id: nid, tag, attrs, incoming: [], outgoing: [] };
    nodes.push(node);
    byId.set(nid, node);
    return nid;
  };

  /** Every flow is recorded three times: once as the element, and once on each
   *  end as <incoming>/<outgoing>. Those two children are not decoration --
   *  bpmn-auto-layout walks the graph through them, and a file that states only
   *  sourceRef/targetRef lays out as a column of shapes with no edges at all.
   *  It renders, it validates, and it is unreadable, which is why this is the
   *  one invariant worth centralising. */
  const flow = (from: string, to: string, label?: string) => {
    const fid = `${id}_f${++seq}`;
    flows.push(
      `    <bpmn:sequenceFlow id="${fid}" sourceRef="${from}" targetRef="${to}"` +
        (label ? ` name="${esc(label)}"` : "") + " />",
    );
    byId.get(from)?.outgoing.push(fid);
    byId.get(to)?.incoming.push(fid);
  };

  const annotate = (target: string, text: string) => {
    const nid = `${id}_n${++note}`;
    notes.push(
      `    <bpmn:textAnnotation id="${nid}"><bpmn:text>${esc(text)}</bpmn:text></bpmn:textAnnotation>`,
      `    <bpmn:association id="${nid}_a" sourceRef="${target}" targetRef="${nid}" />`,
    );
  };

  /** Emit a chain and return its last node id, so a caller can wire what follows.
   *  A fork recurses: every branch is a chain between the same two gateways. */
  function chain(list: Step[], prefix: string, from: string): string {
    let previous = from;
    list.forEach((step, position) => {
      const nid = `${prefix}_${position}`;
      if (step.kind === "fork") {
        // Both gateways exist before any branch is wired: `flow()` writes to
        // the node at each end, so the join has to be there when a branch tail
        // reaches it.
        const split = add(
          `${nid}_split`,
          "parallelGateway",
          step.name ? ` name="${esc(step.name)}"` : "",
        );
        const join = add(`${nid}_join`, "parallelGateway", "");
        flow(previous, split);
        step.branches.forEach((branch, index) => {
          flow(chain(branch, `${nid}_b${index}`, split), join);
        });
        previous = join;
        return;
      }
      if (step.kind === "call") {
        add(nid, "callActivity", ` name="${esc(step.name)}" calledElement="${step.calls}"`);
      } else {
        add(nid, "task", ` name="${esc(step.name)}"`);
      }
      if (step.note) annotate(nid, step.note);
      flow(previous, nid);
      previous = nid;
    });
    return previous;
  }

  add(`${id}_start`, "startEvent", ` name="${esc(startName)}"`);
  const last = chain(steps, `${id}_s`, `${id}_start`);
  add(`${id}_end`, "endEvent", ` name="${esc(endName)}"`);
  flow(last, `${id}_end`);

  const body = nodes.map((node) => {
    const children = [
      ...node.incoming.map((f) => `<bpmn:incoming>${f}</bpmn:incoming>`),
      ...node.outgoing.map((f) => `<bpmn:outgoing>${f}</bpmn:outgoing>`),
    ];
    const open = `    <bpmn:${node.tag} id="${node.id}"${node.attrs}`;
    return children.length === 0
      ? `${open} />`
      : `${open}>\n${children.map((c) => `      ${c}`).join("\n")}\n    </bpmn:${node.tag}>`;
  });

  // Where this came from, in the file itself: a generated diagram that is edited
  // by hand stops matching its source, and the only honest place to say so is
  // next to the content.
  const provenance = source
    ? `\n  <!-- Generiert von scripts/scaffold.ts aus ${source}.\n` +
      `       Nach dem Bearbeiten von Hand: scaffold ueberschreibt nicht, es meldet. -->`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>${provenance}
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  id="Definitions_${id}"
                  targetNamespace="http://niclasedge.com/atlas">
  <bpmn:process id="${id}" name="${esc(name)}" isExecutable="false">
${[...body, ...flows, ...notes].join("\n")}
  </bpmn:process>
</bpmn:definitions>
`;
}
