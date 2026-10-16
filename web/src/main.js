import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-js.css';
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn.css';
import './style.css';

import { renderSidebar, rootsFirst } from './sidebar.js';
import { createPreview } from './preview.js';

const canvasEl = document.querySelector('#canvas');
const listEl = document.querySelector('#process-list');
const crumbEl = document.querySelector('#breadcrumb');
const statusEl = document.querySelector('#status');
const errorsEl = document.querySelector('#corpus-errors');

/** process id -> metadata, filled from /api/diagrams */
let index = {};
let processes = [];
let editable = false;
let editor = null;
let viewer = null;
let preview = null;
/** the drill-down path; the last entry is what is on screen */
let trail = [];

function say(text, kind = 'info') {
  statusEl.textContent = text;
  statusEl.dataset.kind = kind;
  statusEl.hidden = !text;
}

/** The Modeler is a superset of the Viewer, so edit mode is a swap, not a port.
 *  Dynamic so the ~1 MB of editing code is never shipped to a read-only atlas. */
async function createViewer() {
  const module = editable
    ? await import('bpmn-js/lib/Modeler')
    : await import('bpmn-js/lib/NavigatedViewer');
  return new module.default({ container: canvasEl });
}

/** Set when a fit was asked for while the canvas had no size yet. */
let pendingFit = false;

/** Fit the whole diagram into view -- or remember to, once that is possible.
 *
 *  A canvas of zero size is not an edge case: it is the normal state of a page
 *  loaded in a background tab or a hidden pane. diagram-js caches the size it
 *  measured at import time, and `fit-viewport` then computes
 *  `width / bbox.width` against a zero width -- which surfaces as
 *  "SVGMatrix scale: non-finite", a message that points at the diagram and not
 *  at the container. `resized()` alone does not help: it re-measures the same
 *  zero. So check the number diagram-js itself will use, and let the
 *  ResizeObserver below finish the job when the box becomes real. */
function fit() {
  if (!viewer) return;
  const canvas = viewer.get('canvas');
  canvas.resized();
  const { width, height } = canvas.getSize();
  if (!width || !height) {
    pendingFit = true;
    return;
  }
  pendingFit = false;
  canvas.zoom('fit-viewport');
  // fit-viewport is flush against the frame, which clips the label hanging off
  // the leftmost start event. Back off a notch, keeping the centre.
  canvas.zoom(canvas.zoom() * 0.94, 'auto');
}

async function loadIndex() {
  const response = await fetch('/api/diagrams');
  if (!response.ok) throw new Error(`/api/diagrams -> HTTP ${response.status}`);
  const payload = await response.json();

  editable = payload.edit;
  processes = payload.processes;
  index = Object.fromEntries(processes.map((p) => [p.id, p]));

  errorsEl.hidden = !payload.errors.length;
  errorsEl.textContent = payload.errors.map((e) => `${e.file}: ${e.error}`).join('\n');
  return processes;
}

function renderList() {
  renderSidebar(listEl, {
    processes,
    index,
    trail,
    onSelect: (path) => navigate(path),
    onHover: (button, id) => preview.attach(button, id),
    // Null in read-only mode, which is what hides the per-repo "+": the route
    // behind it answers 403 there, so an enabled button would be a promise the
    // server does not keep.
    onCreate: editable ? (repo) => editor?.openFor(repo) : null,
  });
}

function renderCrumbs() {
  crumbEl.replaceChildren();
  trail.forEach((id, position) => {
    if (position) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '›';
      crumbEl.append(sep);
    }
    const button = document.createElement('button');
    button.textContent = index[id]?.name ?? id;
    button.disabled = position === trail.length - 1;
    button.addEventListener('click', () => navigate(trail.slice(0, position + 1)));
    crumbEl.append(button);
  });
}

async function fetchDiagram(id) {
  const response = await fetch(`/api/diagrams/${encodeURIComponent(id)}`);
  if (!response.ok) throw new Error(`${id}: HTTP ${response.status}`);
  let xml = await response.text();

  // Files kept without DI are the normal case here -- they are hand-written and
  // laid out by the pipeline. Laying out in the browser is the fallback, and it
  // silently drops text annotations (bpmn-auto-layout walks sequence flows only).
  if (!index[id]?.has_layout) {
    const { layoutProcess } = await import('bpmn-auto-layout');
    xml = await layoutProcess(xml);
    say('Layout generated in the browser — text annotations are missing.', 'warn');
  }
  return xml;
}

/** Mark every callActivity whose target exists, so a click has a visible promise. */
function markDrillable() {
  const registry = viewer.get('elementRegistry');
  const canvas = viewer.get('canvas');
  let count = 0;

  for (const element of registry.getAll()) {
    const target = element.businessObject?.calledElement;
    if (!target) continue;
    canvas.addMarker(element.id, index[target] ? 'atlas-drillable' : 'atlas-dangling');
    if (index[target]) count += 1;
  }
  return count;
}

/** In edit mode a plain click has to stay a selection -- it is how a shape is
 *  moved or relabelled -- so drilling down moves onto Alt. Read-only keeps the
 *  plain click, where nothing competes for it. */
function onElementClick({ element, originalEvent }) {
  const target = element.businessObject?.calledElement;
  if (!target) return;
  if (editable && !originalEvent?.altKey) return;
  if (!index[target]) {
    say(`"${target}" is called but does not exist.`, 'error');
    return;
  }
  navigate([...trail, target]);
}

async function show(id) {
  if (!index[id]) {
    say(`Process "${id}" is not in the diagram directory.`, 'error');
    return;
  }
  say('loading …');
  try {
    const xml = await fetchDiagram(id);
    if (!viewer) {
      viewer = await createViewer();
      viewer.get('eventBus').on('element.click', onElementClick);
    }
    await viewer.importXML(xml);
    // After the import, because importXML resets the command stack the dirty
    // flag hangs off -- an import would otherwise register as an edit.
    editor?.watch(viewer);
    fit();
    const drillable = markDrillable();
    if (statusEl.dataset.kind !== 'warn') {
      const how = editable ? 'Alt+click to drill down' : 'click to drill down';
      say(drillable ? `${drillable} subprocess(es) — ${how}.` : '');
    }
  } catch (error) {
    say(String(error.message ?? error), 'error');
  }
}

function navigate(nextTrail, { push = true } = {}) {
  // The Modeler holds the only copy of an unsaved change; loading another
  // diagram over it is the one destructive thing this UI can do.
  if (editor?.dirty && nextTrail[nextTrail.length - 1] !== trail[trail.length - 1]) {
    if (!confirm('Discard unsaved changes?')) return;
  }
  trail = nextTrail;
  const id = trail[trail.length - 1];
  if (push) {
    history.pushState({ trail }, '', `?p=${encodeURIComponent(trail.join('/'))}`);
  }
  renderCrumbs();
  renderList();
  show(id);
}

document.querySelector('#fit').addEventListener('click', fit);

// Covers both halves of the sizing problem: the deferred first fit above, and
// a plain window resize, where a stale cache shows up as a diagram keeping the
// old scale inside a new frame.
new ResizeObserver(() => {
  if (!viewer) return;
  if (pendingFit) fit();
  else viewer.get('canvas').resized();
}).observe(canvasEl);

window.addEventListener('popstate', (event) => {
  const restored = event.state?.trail;
  if (restored?.length) navigate(restored, { push: false });
});

/** A new diagram exists on disk but not in the index -- reload it, then show it.
 *  The server dropped its cache line on write, so this sees the new file. */
async function afterCreate(id) {
  await loadIndex();
  navigate([id]);
}

async function boot() {
  try {
    await loadIndex();
    preview = createPreview({
      el: document.querySelector('#preview'),
      stage: document.querySelector('#preview-stage'),
      index,
    });

    if (editable) {
      const { createEditor } = await import('./edit.js');
      editor = createEditor({
        say,
        getViewer: () => viewer,
        getCurrentId: () => trail[trail.length - 1],
        onCreated: afterCreate,
      });
    }

    const requested = new URLSearchParams(location.search).get('p');
    const wanted = requested ? requested.split('/').filter((id) => index[id]) : [];
    const start = wanted.length ? wanted : [(rootsFirst(processes)[0] ?? processes[0])?.id];

    if (!start[0]) {
      say('No processes found. Is there a .bpmn in the diagram directory?', 'error');
      renderList();
      return;
    }
    navigate(start, { push: false });
  } catch (error) {
    say(String(error.message ?? error), 'error');
  }
}

// A handle for the browser console: the diagram is the thing you debug here,
// and without this every question needs a rebuild to answer.
window.atlas = {
  get viewer() {
    return viewer;
  },
  get trail() {
    return trail;
  },
  get index() {
    return index;
  },
  fit,
};

boot();
