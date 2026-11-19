/* Page versions: compare whole-page versions and record which one the client picks.
 *
 * A comparison ("set") is one stored value, key `sets/<id>`, in project storage:
 *   { id, title, versions: [{ id, label, path }], decision: { versionId, comment, by, byName, at } | null, createdAt }
 * Project storage commits with the site, so choices travel through Git.
 */

const KEY_PREFIX = 'sets/';
const VERSION_FOLDER = 'src/pages/review';

const setsElement = document.getElementById('sets');
const emptyElement = document.getElementById('empty');
const newSetButton = document.getElementById('new-set');
const viewOnlyChip = document.getElementById('view-only');

const state = {
  sets: [],
  pages: [],
  openPath: undefined,
  person: { id: '', name: undefined },
  canChoose: false,
  canManage: false,
};

/* ---------- helpers ---------- */

function element(tag, properties = {}, children = []) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(properties)) {
    if (value === undefined || value === false) continue;
    if (name === 'class') node.className = value;
    else if (name === 'text') node.textContent = value;
    else if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
    else node.setAttribute(name, value === true ? '' : value);
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

function newId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

function slug(text) {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'version'
  );
}

async function notify(message, kind = 'info') {
  await stacki.ui.notify({ message: String(message).slice(0, 280), kind });
}

function pageName(path) {
  const page = state.pages.find((entry) => entry.path === path);
  if (page?.title) return page.title;
  if (page?.route) return page.route === '/' ? 'Home' : page.route;
  return path.split('/').pop().replace(/\.astro$/, '');
}

/* ---------- storage ---------- */

async function loadSets() {
  const { keys } = await stacki.storage.keys({});
  const loaded = await Promise.all(
    keys
      .filter((key) => key.startsWith(KEY_PREFIX))
      .map(async (key) => {
        try {
          const { value } = await stacki.storage.get({ key });
          const set = value ? JSON.parse(value) : undefined;
          return set && Array.isArray(set.versions) ? set : undefined;
        } catch {
          return undefined;
        }
      }),
  );
  state.sets = loaded.filter(Boolean).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

async function saveSet(set) {
  const outcome = await stacki.storage.set({ key: KEY_PREFIX + set.id, value: JSON.stringify(set) });
  if (!outcome.applied) await notify(outcome.reason, 'error');
  return outcome.applied;
}

/* ---------- actions ---------- */

async function openVersion(version) {
  try {
    const outcome = await stacki.page.open({ path: version.path });
    if (!outcome.applied) await notify(outcome.reason, 'error');
  } catch (error) {
    await notify(error.code === 'role-denied' ? 'Your role cannot open other pages.' : error.message, 'error');
  }
}

async function createSet() {
  if (!state.openPath || !state.openPath.startsWith('src/pages/')) {
    await notify('Open the page you want to compare first.', 'error');
    return;
  }
  if (state.sets.some((set) => set.versions.some((version) => version.path === state.openPath))) {
    await notify('This page is already part of a comparison.', 'error');
    return;
  }
  const set = {
    id: newId(),
    title: pageName(state.openPath),
    versions: [{ id: newId(), label: 'Version A', path: state.openPath }],
    decision: null,
    createdAt: new Date().toISOString(),
  };
  if (await saveSet(set)) {
    state.sets.push(set);
    render();
  }
}

function nextLabel(set) {
  return `Version ${String.fromCharCode(65 + Math.min(set.versions.length, 25))}`;
}

async function addExistingPage(set, path) {
  if (!path || set.versions.some((version) => version.path === path)) return;
  set.versions.push({ id: newId(), label: nextLabel(set), path });
  if (await saveSet(set)) render();
}

/** Copies the first version's file to a new page, so the copy can be redesigned. Needs the role's code access. */
async function duplicateAsVersion(set) {
  const source = set.versions[0];
  const label = nextLabel(set);
  const base = source.path.split('/').pop().replace(/\.astro$/, '');
  const name = `${base === 'index' ? slug(set.title) : base}-${slug(label)}`;
  try {
    const { content, encoding } = await stacki.files.read({ path: source.path });
    let path = `${VERSION_FOLDER}/${name}.astro`;
    let taken = [];
    try {
      taken = (await stacki.files.list({ dir: VERSION_FOLDER })).entries.map((entry) => entry.path);
    } catch {
      taken = [];
    }
    for (let count = 2; taken.includes(path); count += 1) path = `${VERSION_FOLDER}/${name}-${count}.astro`;
    const outcome = await stacki.files.write({ path, content, encoding, label: `Add ${label} of ${set.title}` });
    if (!outcome.applied) {
      await notify(outcome.reason, 'error');
      return;
    }
    set.versions.push({ id: newId(), label, path });
    if (await saveSet(set)) {
      await refreshPages();
      render();
      await notify(`${label} created at ${path}. Open it and change the design.`, 'success');
    }
  } catch (error) {
    await notify(
      error.code === 'role-denied' ? 'Your role cannot create files. Ask an admin to add the version.' : error.message,
      'error',
    );
  }
}

async function removeVersion(set, version) {
  set.versions = set.versions.filter((entry) => entry.id !== version.id);
  if (set.decision?.versionId === version.id) set.decision = null;
  if (await saveSet(set)) render();
}

async function removeSet(set) {
  const outcome = await stacki.storage.remove({ key: KEY_PREFIX + set.id });
  if (!outcome.applied) {
    await notify(outcome.reason, 'error');
    return;
  }
  state.sets = state.sets.filter((entry) => entry.id !== set.id);
  render();
}

async function choose(set, version, comment) {
  if (!(await stacki.role.can({ permission: 'choose' }))) {
    await notify('Your role cannot choose a version.', 'error');
    return;
  }
  set.decision = {
    versionId: version.id,
    comment: comment.trim().slice(0, 2000),
    by: state.person.id,
    byName: state.person.name ?? 'Someone',
    at: new Date().toISOString(),
  };
  if (await saveSet(set)) {
    render();
    await notify(`${version.label} chosen for ${set.title}.`, 'success');
  }
}

async function resetDecision(set) {
  set.decision = null;
  if (await saveSet(set)) render();
}

/* ---------- rendering ---------- */

function renderSet(set) {
  const chosen = set.versions.find((version) => version.id === set.decision?.versionId);
  const openVersionHere = set.versions.find((version) => version.path === state.openPath);

  const versions = element(
    'ul',
    { class: 'versions' },
    set.versions.map((version) =>
      element(
        'li',
        {
          class: `version${version.path === state.openPath ? ' open' : ''}`,
          title: version.path,
          onclick: () => openVersion(version),
        },
        [
          element('span', { class: 'version-label', text: version.label }),
          version.id === chosen?.id && element('span', { class: 'chip chosen', text: 'Chosen' }),
          state.canManage &&
            set.versions.length > 1 &&
            element('stacki-button', {
              variant: 'ghost',
              icon: 'trash',
              'aria-label': `Remove ${version.label} from the comparison`,
              onclick: (event) => {
                event.stopPropagation();
                removeVersion(set, version);
              },
            }),
        ],
      ),
    ),
  );

  const section = element('section', { class: 'set' }, [
    element('div', { class: 'set-head' }, [
      element('span', { class: 'set-title', text: set.title }),
      state.canManage &&
        element('stacki-button', {
          variant: 'ghost',
          icon: 'trash',
          'aria-label': `Delete the comparison for ${set.title}`,
          onclick: () => removeSet(set),
        }),
    ]),
    versions,
  ]);

  if (chosen) {
    const when = new Date(set.decision.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    const line = element('p', { class: 'decision', text: `${set.decision.byName} chose ${chosen.label} on ${when}. ` });
    if (set.decision.comment) line.append(element('q', { text: set.decision.comment }));
    section.append(line);
  }

  if (state.canChoose && set.versions.length > 1) {
    if (openVersionHere && openVersionHere.id !== chosen?.id) {
      const comment = element('stacki-textarea', {
        class: 'grow',
        rows: '2',
        label: 'Comment',
        placeholder: 'Why this one? (optional)',
      });
      section.append(
        comment,
        element('div', { class: 'row' }, [
          element('stacki-button', {
            variant: 'primary',
            text: `Choose ${openVersionHere.label}`,
            onclick: () => choose(set, openVersionHere, comment.value ?? ''),
          }),
        ]),
      );
    } else if (!openVersionHere) {
      section.append(element('p', { class: 'hint', text: 'Click a version to view it, then choose it.' }));
    }
  }

  if (state.canManage) {
    const used = new Set(state.sets.flatMap((entry) => entry.versions.map((version) => version.path)));
    const candidates = state.pages.filter((page) => !used.has(page.path));
    const picker = element('stacki-dropdown', {
      class: 'grow',
      label: 'Add an existing page as a version',
      placeholder: 'Add existing page…',
      searchable: true,
    });
    picker.options = candidates.slice(0, 500).map((page) => ({ value: page.path, label: `${pageName(page.path)} (${page.route})` }));
    picker.addEventListener('change', () => addExistingPage(set, picker.value));
    section.append(
      element('div', { class: 'row' }, [
        picker,
        element('stacki-button', {
          text: 'Duplicate',
          title: `Copy ${set.versions[0].label} to a new page in ${VERSION_FOLDER}`,
          onclick: () => duplicateAsVersion(set),
        }),
      ]),
    );
    if (chosen) {
      section.append(
        element('div', { class: 'row' }, [
          element('stacki-button', { variant: 'ghost', text: 'Reset choice', onclick: () => resetDecision(set) }),
        ]),
      );
    }
  }

  return section;
}

function render() {
  newSetButton.hidden = !state.canManage;
  viewOnlyChip.hidden = state.canChoose || state.canManage;
  setsElement.replaceChildren(...state.sets.map(renderSet));
  emptyElement.hidden = state.sets.length > 0;
  emptyElement.textContent = state.canManage
    ? 'No comparisons yet. Open a page and press + to start one.'
    : 'There is nothing to compare yet.';
  const open = state.sets.filter((set) => set.versions.length > 1 && !set.decision).length;
  stacki.app.badge({ count: open }).catch(() => {});
}

/* ---------- startup ---------- */

async function refreshPages() {
  try {
    state.pages = await stacki.page.list();
  } catch {
    state.pages = [];
  }
}

function applyRole(role) {
  state.canManage = role.isAdmin || role.permissions?.manage === true;
  state.canChoose = role.isAdmin || role.permissions?.choose === true;
}

async function start() {
  const [role, person, page] = await Promise.all([
    stacki.role.get(),
    stacki.person.get(),
    stacki.page.get().catch(() => undefined),
  ]);
  applyRole(role);
  state.person = person;
  state.openPath = page?.path;
  await Promise.all([refreshPages(), loadSets()]);
  render();

  newSetButton.addEventListener('click', createSet);
  stacki.on('page.change', ({ path }) => {
    state.openPath = path;
    render();
  });
  stacki.on('role.change', (next) => {
    applyRole(next);
    render();
  });
  stacki.on('person.change', (next) => {
    state.person = next;
  });
  stacki.on('storage.change', async ({ origin }) => {
    if (origin !== 'other') return;
    await loadSets();
    render();
  });
  stacki.on('project.change', async ({ source }) => {
    if (source !== 'files') return;
    await refreshPages();
    render();
  });
}

start().catch((error) => {
  emptyElement.hidden = false;
  emptyElement.textContent = `Page versions could not start: ${error.message}`;
});
