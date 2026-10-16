/** Edit mode: write a diagram back, and create a new one.
 *
 * Both halves only appear when the server reports `edit: true`. That flag comes
 * from `ATLAS_EDIT`, which is off in the deployed image -- the buttons are not
 * hidden decoration there, the routes behind them answer 403.
 *
 * Saving is a whole-file PUT of what the Modeler holds, and the server validates
 * before it writes: a diagram that does not parse leaves the file untouched.
 * There is no merge and no conflict detection, because there is one editor and
 * the file is the state.
 */

const dialogEl = document.querySelector('#new-dialog');
const repoEl = document.querySelector('#new-repo');
const idEl = document.querySelector('#new-id');
const nameEl = document.querySelector('#new-name');
const errorEl = document.querySelector('#new-error');
const repoOptionsEl = document.querySelector('#repo-options');

export function createEditor({ say, getViewer, getCurrentId, onCreated }) {
  const saveBtn = document.querySelector('#save');
  const newBtn = document.querySelector('#new-process');
  let dirty = false;

  function setDirty(value) {
    dirty = value;
    saveBtn.classList.toggle('dirty', value);
    saveBtn.title = value ? 'Unsaved changes' : 'Write the diagram back to disk';
  }

  /** Called after every import, because the Modeler's command stack is reset by
   *  it -- the listener has to be re-attached and the state is clean again. */
  function watch(viewer) {
    setDirty(false);
    viewer.get('eventBus').on('commandStack.changed', () => setDirty(true));
  }

  async function save() {
    const viewer = getViewer();
    const id = getCurrentId();
    if (!viewer || !id) return;

    const { xml } = await viewer.saveXML({ format: true });
    const response = await fetch(`/api/diagrams/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/xml' },
      body: xml,
    });
    const payload = await response.json().catch(() => ({}));
    if (response.ok) {
      setDirty(false);
      say(`saved: ${payload.written} (${payload.bytes} bytes)`);
    } else {
      say(`Save failed: ${payload.detail ?? response.status}`, 'error');
    }
  }

  /** `presetRepo` comes from the "+" on a repository heading. The field is then
   *  filled and locked: the button already answered "where does this go", and a
   *  field that still invites a change turns that answer back into a question.
   *  Without a preset (the toolbar's "Neu") the field stays free -- that is the
   *  only way the first process of a new repository comes into being. */
  function openDialog(index, presetRepo = null) {
    // The repo list is derived from the corpus, not configured: `sources.yml`
    // is a controller-side file the server never reads.
    const repos = [...new Set(Object.values(index).map((p) => p.repo).filter(Boolean))].sort();
    repoOptionsEl.replaceChildren(
      ...repos.map((repo) => Object.assign(document.createElement('option'), { value: repo })),
    );
    repoEl.value = presetRepo ?? index[getCurrentId()]?.repo ?? repos[0] ?? '';
    // readOnly, not disabled: a disabled field is skipped by the form and its
    // value would never reach `create()`.
    repoEl.readOnly = Boolean(presetRepo);
    idEl.value = '';
    nameEl.value = '';
    errorEl.hidden = true;
    dialogEl.showModal();
    idEl.focus();
  }

  async function create() {
    const body = {
      id: idEl.value.trim(),
      repo: repoEl.value.trim(),
      name: nameEl.value.trim() || idEl.value.trim(),
    };
    const response = await fetch('/api/diagrams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      // Re-open rather than swallow: the entered values are still in the fields,
      // so a duplicate id costs one edit and not a retype.
      errorEl.textContent = payload.detail ?? `HTTP ${response.status}`;
      errorEl.hidden = false;
      dialogEl.showModal();
      return;
    }
    say(`created: ${payload.file}`);
    onCreated(payload.id);
  }

  saveBtn.addEventListener('click', save);
  newBtn.addEventListener('click', () => openDialog(window.atlas.index));
  dialogEl.addEventListener('close', () => {
    if (dialogEl.returnValue === 'create') create();
  });

  // Ctrl/Cmd-S is what a hand reaches for in an editor, and the browser's own
  // "save page" is useless here.
  addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 's') {
      event.preventDefault();
      save();
    }
  });

  addEventListener('beforeunload', (event) => {
    if (dirty) event.preventDefault();
  });

  saveBtn.hidden = false;
  newBtn.hidden = false;
  return {
    watch,
    save,
    openFor: (repo) => openDialog(window.atlas.index, repo),
    get dirty() { return dirty; },
  };
}
