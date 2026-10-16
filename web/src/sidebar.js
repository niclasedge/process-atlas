/** The sidebar: repositories, entry points, and the tree of what they call.
 *
 * Grouping is by repository because that is what the corpus is: several repos'
 * worth of processes in one atlas. The group name is the directory under
 * `diagrams/`, which the server reports as `repo` -- there is no manifest that
 * says which process belongs where, and there must not be one, or the two
 * sources would eventually disagree.
 *
 * Below a repository the tree follows `calls`, so it is the same relation the
 * drill-down uses. A process therefore appears under every caller that reaches
 * it, which is a feature: "where is this called from" is answered by looking,
 * not by searching.
 */

/** Expansion survives re-renders (creating a process rebuilds the list) and is
 *  keyed by path, since the same process can sit under several callers. */
const expanded = new Set();
/** Repositories start open, but only once: re-opening them on every render is
 *  indistinguishable from a collapse button that does nothing. */
let seededRepos = false;
/** Same reason, for the path to the current diagram: it is opened when the
 *  navigation lands, not on the re-render a twisty causes. */
let lastShown = null;

function reachable(processes, index) {
  const seen = new Set();
  const queue = processes.filter((p) => p.is_root).map((p) => p.id);
  while (queue.length) {
    const id = queue.pop();
    for (const child of index[id]?.calls ?? []) {
      if (index[child] && !seen.has(child)) {
        seen.add(child);
        queue.push(child);
      }
    }
  }
  return seen;
}

/** Entry points first, and among them the one calling the most others -- the
 *  overview -- leads. It is the only structural hint the corpus gives about
 *  where a reader should start. */
function byImportance(a, b) {
  return b.calls.length - a.calls.length || a.name.localeCompare(b.name);
}

export function rootsFirst(processes) {
  return processes.filter((p) => p.is_root).sort(byImportance);
}

function group(processes, index) {
  const covered = reachable(processes, index);
  const repos = new Map();

  for (const process of processes) {
    const key = process.repo || '(no repo)';
    if (!repos.has(key)) repos.set(key, { roots: [], orphans: [] });
    const bucket = repos.get(key);
    if (process.is_root) bucket.roots.push(process);
    // Neither an entry point nor called by one: reachable from nowhere, so it
    // would be invisible if the tree were the only way in.
    else if (!covered.has(process.id)) bucket.orphans.push(process);
  }

  for (const bucket of repos.values()) {
    bucket.roots.sort(byImportance);
    bucket.orphans.sort(byImportance);
  }
  return [...repos.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function twisty(open, label) {
  const button = document.createElement('button');
  button.className = 'twisty';
  button.type = 'button';
  button.setAttribute('aria-expanded', String(open));
  button.setAttribute('aria-label', label);
  return button;
}

/** `opts` is kept whole so the re-renders below can hand it back unchanged --
 *  destructuring it into a fresh literal is how a later option silently stops
 *  surviving a twisty click. */
export function renderSidebar(listEl, opts) {
  const { processes, index, trail, onSelect, onHover, onCreate } = opts;
  const current = trail[trail.length - 1];

  if (!seededRepos) {
    seededRepos = true;
    for (const process of processes) expanded.add(`repo:${process.repo || '(no repo)'}`);
  }
  // Everything on the way to the current diagram is opened, so arriving from a
  // link, the breadcrumb or a drill-down never lands in a collapsed tree -- and
  // a newly created process is visible in a repository that did not exist yet.
  if (current !== lastShown) {
    lastShown = current;
    trail.forEach((_, i) => expanded.add(trail.slice(0, i + 1).join('/')));
    expanded.add(`repo:${index[current]?.repo || '(no repo)'}`);
  }
  listEl.replaceChildren();

  function node(id, path, ancestors) {
    const process = index[id];
    const row = document.createElement('div');
    row.className = 'row';

    const children = (process.calls ?? []).filter((c) => index[c]);
    // A cycle is drawn as a leaf: the process is already open further up, so
    // expanding it here would be the same subtree forever.
    const cyclic = children.length > 0 && children.every((c) => ancestors.has(c));
    const key = path.join('/');
    const open = expanded.has(key);

    if (children.length && !cyclic) {
      const toggle = twisty(open, `${process.name} expand/collapse`);
      toggle.addEventListener('click', () => {
        if (expanded.has(key)) expanded.delete(key);
        else expanded.add(key);
        renderSidebar(listEl, opts);
      });
      row.append(toggle);
    } else {
      row.append(Object.assign(document.createElement('span'), { className: 'twisty-gap' }));
    }

    const button = document.createElement('button');
    button.className = 'process';
    button.type = 'button';
    button.dataset.id = id;
    button.textContent = process.name;
    // The full name goes in the tooltip: the label is clipped to one line, so
    // without this a long name is simply unreadable.
    button.title = process.name === id ? id : `${process.name} — ${id}`;
    if (id === current) button.classList.add('active');
    if (process.unresolved?.length) {
      button.classList.add('has-dangling');
      button.title += `\nCalls a missing process: ${process.unresolved.join(', ')}`;
    }
    button.addEventListener('click', () => onSelect(path));
    onHover(button, id);
    row.append(button);

    if (children.length) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = children.length;
      row.append(badge);
    }

    const wrap = document.createElement('div');
    wrap.className = 'node';
    wrap.append(row);

    if (open && !cyclic) {
      const kids = document.createElement('div');
      kids.className = 'children';
      const nextAncestors = new Set(ancestors).add(id);
      for (const child of children) {
        if (nextAncestors.has(child)) continue;
        kids.append(node(child, [...path, child], nextAncestors));
      }
      wrap.append(kids);
    }
    return wrap;
  }

  for (const [repo, bucket] of group(processes, index)) {
    const open = expanded.has(`repo:${repo}`);
    // A row, not a button: the "+" next to it is a second, independent action,
    // and a button inside a button is invalid HTML -- the parser hoists the
    // inner one out and the click lands on whichever it feels like.
    const head = document.createElement('div');
    head.className = 'repo-head';

    const toggle = document.createElement('button');
    toggle.className = 'repo-toggle';
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', String(open));
    toggle.append(Object.assign(document.createElement('span'), { className: 'twisty' }));
    toggle.append(Object.assign(document.createElement('span'), {
      className: 'repo-name',
      textContent: repo,
    }));
    toggle.append(Object.assign(document.createElement('span'), {
      className: 'badge',
      textContent: processes.filter((p) => (p.repo || '(no repo)') === repo).length,
    }));
    toggle.addEventListener('click', () => {
      if (open) expanded.delete(`repo:${repo}`);
      else expanded.add(`repo:${repo}`);
      renderSidebar(listEl, opts);
    });
    head.append(toggle);

    // Edit mode only, and not on the "(no repo)" bucket -- that one is not a
    // directory, so there is no answer to "where would the file go". The first
    // process of a NEW repository still comes from the toolbar, where the field
    // is free to type into.
    if (onCreate && repo !== '(no repo)') {
      const add = document.createElement('button');
      add.className = 'repo-add';
      add.type = 'button';
      add.textContent = '+';
      add.title = `Create a new process in ${repo}`;
      add.setAttribute('aria-label', add.title);
      add.addEventListener('click', () => onCreate(repo));
      head.append(add);
    }
    listEl.append(head);

    if (!open) continue;
    const body = document.createElement('div');
    body.className = 'repo-body';
    for (const process of bucket.roots) body.append(node(process.id, [process.id], new Set()));

    if (bucket.orphans.length) {
      const label = document.createElement('h2');
      label.textContent = 'Not called';
      label.title = 'No entry point calls these processes — reachable only from here.';
      body.append(label);
      for (const process of bucket.orphans) body.append(node(process.id, [process.id], new Set()));
    }
    listEl.append(body);
  }
}
