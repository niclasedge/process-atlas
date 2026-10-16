/** Hover preview for the sidebar.
 *
 * The picture comes from `previews/<id>.png`, rendered by `just previews` on the
 * controller. That is the whole point of the cache: a preview must appear inside
 * the ~250 ms a hover lasts, and parsing plus laying out a diagram does not fit
 * in that budget -- the first hover would show nothing and the reader would
 * conclude the feature is broken.
 *
 * When there is no PNG the fallback renders an SVG in the browser. That path
 * exists for exactly one case: a diagram created in edit mode, which has no PNG
 * until the next `just previews`. It is slow, it is per-session, and it must not
 * become the normal path -- if every hover lands here, the render step did not
 * run.
 *
 * Freshness is not handled here. `/api/preview/<id>.png` answers 404 when the
 * PNG is older than its .bpmn, so a stale preview turns into the fallback rather
 * than into a wrong picture.
 */

const DELAY_MS = 220;

/** id -> a ready node to clone, or null for "asked, nothing to show". The 404s
 *  are worth remembering too: without that, every hover over a fresh diagram
 *  re-renders. */
const cache = new Map();

export function createPreview({ el, stage, index }) {
  let timer = 0;
  let token = 0;
  let fallbackViewer = null;

  function hide() {
    clearTimeout(timer);
    token += 1;
    el.hidden = true;
    el.replaceChildren();
  }

  function place(anchor) {
    const box = anchor.getBoundingClientRect();
    // Measured, not assumed: the box is already filled at this point, and its
    // height depends on the diagram's aspect ratio.
    const height = el.offsetHeight;
    el.style.left = `${box.right + 12}px`;
    el.style.top = `${Math.max(8, Math.min(box.top - 8, innerHeight - height - 8))}px`;
  }

  /** Render in a container that has a real size. A zero-size one makes
   *  diagram-js compute a non-finite scale, the same trap as the main canvas. */
  async function renderFallback(id) {
    const response = await fetch(`/api/diagrams/${encodeURIComponent(id)}`);
    if (!response.ok) return null;
    let xml = await response.text();

    if (!index[id]?.has_layout) {
      const { layoutProcess } = await import('bpmn-auto-layout');
      xml = await layoutProcess(xml);
    }
    if (!fallbackViewer) {
      const { default: Viewer } = await import('bpmn-js/lib/NavigatedViewer');
      fallbackViewer = new Viewer({ container: stage });
    }
    await fallbackViewer.importXML(xml);
    const { svg } = await fallbackViewer.saveSVG();
    return svg;
  }

  /** Load the PNG by loading it, not by asking about it first: a decoded image
   *  is what we need anyway, and a HEAD followed by a GET would show a blank
   *  frame for the length of the second request. */
  function loadPng(id) {
    return new Promise((resolve) => {
      const img = new Image();
      img.alt = '';
      img.addEventListener('load', () => {
        // Rendered at 2x (see render-previews.ts), so its intended size is half
        // its pixel width. Without this the preview is twice as large as meant
        // and `max-width` decides the size instead.
        img.style.width = `${img.naturalWidth / 2}px`;
        resolve(img);
      });
      img.addEventListener('error', () => resolve(null));
      img.src = `/api/preview/${encodeURIComponent(id)}.png`;
    });
  }

  async function content(id) {
    if (cache.has(id)) return cache.get(id);

    let node = await loadPng(id);
    if (!node) {
      const svg = await renderFallback(id).catch(() => null);
      if (svg) {
        node = document.createElement('div');
        node.className = 'preview-svg';
        node.innerHTML = svg;
      }
    }
    cache.set(id, node);
    return node;
  }

  function attach(anchor, id) {
    anchor.addEventListener('mouseenter', () => {
      clearTimeout(timer);
      const mine = ++token;
      timer = setTimeout(async () => {
        const node = await content(id);
        // The pointer moved on while this was loading; showing it now would put
        // a preview next to a row nobody is pointing at.
        if (mine !== token || !node) return;
        // Cloned, because the cached node would otherwise be moved out of the
        // cache and into the DOM on first use.
        el.replaceChildren(node.cloneNode(true));
        el.hidden = false;
        place(anchor);
      }, DELAY_MS);
    });
    anchor.addEventListener('mouseleave', hide);
    // A click navigates, and the preview would otherwise hang over the diagram
    // it was a preview of.
    anchor.addEventListener('click', hide);
    anchor.addEventListener('focus', hide);
  }

  // Scrolling the sidebar moves the anchor out from under a preview pinned to
  // the viewport; re-placing it on every scroll frame is not worth the code.
  addEventListener('scroll', hide, true);

  return { attach, hide, forget: (id) => cache.delete(id) };
}
