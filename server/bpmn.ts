/** Read the three facts an atlas needs out of a .bpmn file, and nothing else.
 *
 * The three facts are: which processes a file declares, which processes each of
 * them calls, and whether the file carries diagram interchange. A tag scanner
 * gets all three in one pass, and the same pass answers "is this well-formed?"
 * for the write path -- which is why there is no XML library here. A DOM parser
 * would build the whole tree to hand back a shape where a child is an object or
 * an array depending on how many siblings it has, and the code to navigate that
 * is longer than the scanner below.
 *
 * The scanner is deliberately not a general XML parser: it does not resolve
 * entities, does not validate against a schema, and treats namespaces as a
 * prefix to drop. BPMN files are tool-generated and every producer writes the
 * same handful of constructs, so what it does not do never comes up. What it
 * does do -- quoting, comments, CDATA, tag balance -- is what actually varies.
 */

export type Tag = {
  /** local name; the namespace prefix is dropped, since it varies by tool */
  name: string;
  attrs: Record<string, string>;
  kind: "open" | "close" | "self";
};

const ATTR_RE = /([A-Za-z_:][\w:.\-]*)\s*=\s*"([^"]*)"|([A-Za-z_:][\w:.\-]*)\s*=\s*'([^']*)'/g;

/** XML's five predefined entities plus numeric ones. Enough for names and ids. */
function unescape(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(/&(#x?[0-9A-Fa-f]+|amp|lt|gt|quot|apos);/g, (whole, body: string) => {
    switch (body) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
    }
    const code = body[1] === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
  });
}

function attributes(inner: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR_RE.exec(inner)) !== null) {
    const qname = match[1] ?? match[3];
    const value = match[2] ?? match[4];
    attrs[qname.slice(qname.indexOf(":") + 1)] = unescape(value);
  }
  return attrs;
}

/** Walk the tags of an XML document. Throws SyntaxError on anything unterminated. */
export function* tags(xml: string): Generator<Tag> {
  let i = 0;
  for (;;) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) return;

    // Comments, CDATA and processing instructions can all contain something
    // that looks like a tag, so they are skipped as units, not scanned into.
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end < 0) throw new SyntaxError("unterminated comment");
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end < 0) throw new SyntaxError("unterminated CDATA section");
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      if (end < 0) throw new SyntaxError("unterminated processing instruction");
      i = end + 2;
      continue;
    }
    if (xml.startsWith("<!", lt)) {
      // A DOCTYPE may carry a bracketed internal subset whose own '>' must not
      // end it. BPMN files have no DOCTYPE at all; this is here so that one
      // does not silently derail the scan.
      const bracket = xml.indexOf("[", lt);
      const end = bracket >= 0 && bracket < (xml.indexOf(">", lt) + 1 || Infinity)
        ? xml.indexOf("]>", bracket) + 1
        : xml.indexOf(">", lt);
      if (end < 1) throw new SyntaxError("unterminated declaration");
      i = end + 1;
      continue;
    }

    // A real tag. Attribute values may contain '>' unescaped -- XML allows it --
    // so the closing bracket has to be found with quote state, not indexOf.
    let j = lt + 1;
    let quote = "";
    for (; j < xml.length; j++) {
      const ch = xml[j];
      if (quote) {
        if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        break;
      }
    }
    if (j >= xml.length) throw new SyntaxError("unterminated tag");

    const body = xml.slice(lt + 1, j);
    i = j + 1;

    const closing = body.startsWith("/");
    const selfClosing = !closing && body.endsWith("/");
    const inner = body.slice(closing ? 1 : 0, selfClosing ? -1 : undefined);
    const nameMatch = /^\s*([^\s/>]+)/.exec(inner);
    if (!nameMatch) throw new SyntaxError(`tag without a name: <${body.slice(0, 40)}>`);

    const qname = nameMatch[1];
    yield {
      name: qname.slice(qname.indexOf(":") + 1),
      attrs: closing ? {} : attributes(inner.slice(nameMatch[0].length)),
      kind: closing ? "close" : selfClosing ? "self" : "open",
    };
  }
}

export type ProcessInfo = {
  id: string;
  name: string;
  /** process ids this one calls, deduplicated and sorted */
  calls: string[];
};

export type FileInfo = {
  processes: ProcessInfo[];
  /** BPMNShape, not BPMNDiagram: an empty <BPMNDiagram> renders to nothing too */
  hasLayout: boolean;
};

/** Scan one document. Throws SyntaxError when tags do not balance. */
export function readFile(xml: string): FileInfo {
  const stack: string[] = [];
  const processes: ProcessInfo[] = [];
  let hasLayout = false;
  let roots = 0;

  let current: ProcessInfo | null = null;
  let currentCalls = new Set<string>();
  let currentDepth = -1;

  const finish = () => {
    if (!current) return;
    current.calls = [...currentCalls].sort();
    processes.push(current);
    current = null;
    currentCalls = new Set();
  };

  const observe = (tag: Tag) => {
    if (tag.name === "BPMNShape") hasLayout = true;
    // A callActivity outside any process is meaningless; ignoring it here keeps
    // the "calls" list an honest property of the process that owns it.
    if (tag.name === "callActivity" && tag.attrs.calledElement && current) {
      currentCalls.add(tag.attrs.calledElement);
    }
  };

  for (const tag of tags(xml)) {
    if (tag.kind === "close") {
      const opened = stack.pop();
      if (opened === undefined) throw new SyntaxError(`</${tag.name}> closes nothing`);
      if (opened !== tag.name) throw new SyntaxError(`</${tag.name}> closes <${opened}>`);
      if (current && stack.length === currentDepth) finish();
      continue;
    }

    if (stack.length === 0 && ++roots > 1) {
      throw new SyntaxError(`second root element <${tag.name}>`);
    }

    if (tag.name === "process" && tag.attrs.id && !current) {
      current = { id: tag.attrs.id, name: tag.attrs.name || tag.attrs.id, calls: [] };
      currentDepth = stack.length;
      if (tag.kind === "self") finish();
    } else {
      observe(tag);
    }

    if (tag.kind === "open") stack.push(tag.name);
  }

  if (stack.length) throw new SyntaxError(`unclosed <${stack[stack.length - 1]}>`);
  if (roots === 0) throw new SyntaxError("no elements");
  finish();

  return { processes, hasLayout };
}

/** Cheap well-formedness gate for the write path. Returns the error, or null. */
export function validate(xml: string): string | null {
  try {
    readFile(xml);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

function escapeXml(value: string): string {
  return value.replace(/[&<>"]/g, (ch) => ESCAPES[ch]);
}

/** A new, empty process -- with DI, so the viewer never falls back to browser
 *  layout for it (that path silently drops text annotations). */
export function emptyDiagram(id: string, name: string): string {
  const start = `${id}_start`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
                  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
                  id="Definitions_${escapeXml(id)}"
                  targetNamespace="http://niclasedge.com/atlas">
  <bpmn:process id="${escapeXml(id)}" name="${escapeXml(name)}" isExecutable="false">
    <bpmn:startEvent id="${escapeXml(start)}" name="Start" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="Diagram_${escapeXml(id)}">
    <bpmndi:BPMNPlane id="Plane_${escapeXml(id)}" bpmnElement="${escapeXml(id)}">
      <bpmndi:BPMNShape id="Shape_${escapeXml(start)}" bpmnElement="${escapeXml(start)}">
        <dc:Bounds x="180" y="180" width="36" height="36" />
      </bpmndi:BPMNShape>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>
`;
}
