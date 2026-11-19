/* Page versions: compare whole-page versions and record which one the client picks.
 *
 * A comparison ("set") is one stored value, key `sets/<id>`, in project storage:
 *   { id, title, versions: [{ id, label, path }], decision: { versionId, comment, by, byName, at } | null, createdAt }
 * Project storage commits with the site, so choices travel through Git.
 */

const KEY_PREFIX = 'sets/';
const VERSION_FOLDER = 'src/pages/review';

/* Section variants: a wrapper element on the page holds several designs of one section.
 *   <div data-variant-group="Hero" data-variant-active="a">
 *     <div data-variant="a">…</div>
 *     <div data-variant="b" data-variant-label="Light">…</div>
 *   </div>
 * The site's CSS shows the active one only. A choice is one stored value, key `variants/<hash>`:
 *   { path, group, decision: { variantId, comment, by, byName, at } | null }
 *
 * An admin confirms a choice: `decision.confirmed = { by, byName, at }`, on a set or a variant
 * choice. A new choice is a new decision, so it is unconfirmed again.
 *
 * Every page (a comparison counts as one page) is approved once its choices are confirmed:
 * `approval = { by, byName, at }` on the set, or in a page record, key `pages/<hash>`:
 *   { path, approval | null, excluded }
 * All pages approved: ready for build. `access` holds for whom feedback is closed:
 *   { closedAll, closed: [handle] }
 */
const RECORD_PREFIX = 'pages/';
const ACCESS_KEY = 'access';
const CHOICE_PREFIX = 'variants/';
const GROUP_ATTRIBUTE = 'data-variant-group';
const ACTIVE_ATTRIBUTE = 'data-variant-active';
const OPTION_ATTRIBUTE = 'data-variant';
const LABEL_ATTRIBUTE = 'data-variant-label';

const treeElement = document.getElementById('tree');
const accessElement = document.getElementById('access');
const statusElement = document.getElementById('status');
const emptyElement = document.getElementById('empty');
const viewOnlyChip = document.getElementById('view-only');

const state = {
  sets: [],
  groups: [],
  choices: new Map(),
  /** Variant groups across the project, as `path\ngroup`; undefined when the editor cannot list them. */
  allGroups: undefined,
  records: new Map(),
  access: { closedAll: false, closed: [] },
  members: [],
  pages: [],
  openPath: undefined,
  person: { id: '', name: undefined },
  canChoose: false,
  canManage: false,
  isAdmin: false,
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

/* ---------- section variants ---------- */

function flatten(nodes) {
  const out = [];
  const stack = [...(nodes || [])].reverse();
  while (stack.length > 0 && out.length < 20000) {
    const node = stack.pop();
    out.push(node);
    const children = node.children || [];
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
  }
  return out;
}

function attribute(node, name) {
  const value = node.attributes?.[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The variant groups written on the open page, in page order. */
function readGroups(view) {
  const groups = [];
  for (const node of flatten(view?.nodes)) {
    const name = attribute(node, GROUP_ATTRIBUTE);
    if (!name) continue;
    const options = (node.children || [])
      .filter((child) => attribute(child, OPTION_ATTRIBUTE))
      .map((child) => {
        const id = attribute(child, OPTION_ATTRIBUTE);
        return { id, label: attribute(child, LABEL_ATTRIBUTE) ?? `Variant ${id.toUpperCase()}` };
      });
    if (options.length < 2) continue;
    const active = attribute(node, ACTIVE_ATTRIBUTE);
    groups.push({
      nodeId: node.id,
      name,
      options,
      active: options.some((option) => option.id === active) ? active : options[0].id,
    });
  }
  return groups;
}

function choiceId(path, group) {
  return `${path}\n${group}`;
}

/** FNV-1a, as hex: a storage key that holds any page path and group name. */
function hashed(text) {
  let hash = 0x811c9dc5;
  for (const char of text) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function choiceKey(path, group) {
  return CHOICE_PREFIX + hashed(choiceId(path, group));
}

async function loadChoices() {
  const { keys } = await stacki.storage.keys({});
  const loaded = await Promise.all(
    keys
      .filter((key) => key.startsWith(CHOICE_PREFIX))
      .map(async (key) => {
        try {
          const { value } = await stacki.storage.get({ key });
          const choice = value ? JSON.parse(value) : undefined;
          return choice && typeof choice.path === 'string' && typeof choice.group === 'string' ? choice : undefined;
        } catch {
          return undefined;
        }
      }),
  );
  state.choices = new Map(loaded.filter(Boolean).map((choice) => [choiceId(choice.path, choice.group), choice]));
}

function decisionFor(group) {
  return state.choices.get(choiceId(state.openPath, group.name))?.decision ?? undefined;
}

async function saveDecision(group, decision) {
  const choice = { path: state.openPath, group: group.name, decision };
  const outcome = await stacki.storage.set({ key: choiceKey(choice.path, choice.group), value: JSON.stringify(choice) });
  if (!outcome.applied) {
    await notify(outcome.reason, 'error');
    return false;
  }
  state.choices.set(choiceId(choice.path, choice.group), choice);
  return true;
}

/** Shows one variant on the canvas by writing the group's active attribute; the page reloads with it. */
async function showVariant(group, option) {
  if (group.active === option.id) {
    stacki.canvas.scrollTo({ nodeId: group.nodeId, block: 'start' }).catch(() => {});
    return;
  }
  try {
    const outcome = await stacki.node.setAttribute({
      nodeId: group.nodeId,
      name: ACTIVE_ATTRIBUTE,
      value: option.id,
      label: `Show ${option.label} of ${group.name}`,
    });
    if (outcome && outcome.applied === false) {
      await notify(outcome.reason, 'error');
      return;
    }
    group.active = option.id;
    render();
    await refreshView();
    const shown = state.groups.find((entry) => entry.name === group.name);
    if (shown) stacki.canvas.scrollTo({ nodeId: shown.nodeId, block: 'start' }).catch(() => {});
  } catch (error) {
    await notify(error.code === 'role-denied' ? 'Your role cannot switch variants on the page.' : error.message, 'error');
  }
}

async function chooseVariant(group, option, comment) {
  if (!mayChoose() || !(await stacki.role.can({ permission: 'choose' }))) {
    await notify('You cannot choose a variant right now.', 'error');
    return;
  }
  const decision = {
    variantId: option.id,
    comment: comment.trim().slice(0, 2000),
    by: state.person.id,
    byName: state.person.name ?? 'Someone',
    at: new Date().toISOString(),
  };
  if (await saveDecision(group, decision)) {
    render();
    await notify(`${option.label} chosen for ${group.name}.`, 'success');
  }
}

async function resetVariant(group) {
  if (await saveDecision(group, null)) render();
}

/* ---------- confirmation ---------- */

function confirmation() {
  return { by: state.person.id, byName: state.person.name ?? 'Someone', at: new Date().toISOString() };
}

async function confirmSet(set, confirmed) {
  if (!state.isAdmin || !set.decision) return;
  const before = set.decision;
  set.decision = { ...before, confirmed: confirmed ? confirmation() : undefined };
  if (await saveSet(set)) render();
  else set.decision = before;
}

async function confirmVariant(group, confirmed) {
  const decision = decisionFor(group);
  if (!state.isAdmin || !decision) return;
  if (await saveDecision(group, { ...decision, confirmed: confirmed ? confirmation() : undefined })) render();
}

/** Every variant group in the project, so the status counts pages that are not open too. */
async function refreshAllGroups() {
  try {
    const answer = await stacki.page.findByAttribute({ name: GROUP_ATTRIBUTE });
    const matches = Array.isArray(answer) ? answer : (answer?.matches ?? answer?.items ?? answer?.nodes);
    if (!Array.isArray(matches)) throw new Error('No matches');
    const found = new Set();
    for (const match of matches) {
      const path = match.path ?? match.file;
      const name = match.value ?? match.attributes?.[GROUP_ATTRIBUTE];
      if (typeof path === 'string' && typeof name === 'string' && name !== '') found.add(choiceId(path, name));
    }
    state.allGroups = found;
  } catch {
    state.allGroups = undefined;
  }
}

/* ---------- pages, approval and access ---------- */

async function loadRecords() {
  const { keys } = await stacki.storage.keys({});
  const loaded = await Promise.all(
    keys
      .filter((key) => key.startsWith(RECORD_PREFIX))
      .map(async (key) => {
        try {
          const { value } = await stacki.storage.get({ key });
          const record = value ? JSON.parse(value) : undefined;
          return record && typeof record.path === 'string' ? record : undefined;
        } catch {
          return undefined;
        }
      }),
  );
  state.records = new Map(loaded.filter(Boolean).map((record) => [record.path, record]));
}

async function saveRecord(path, changes) {
  const record = { path, approval: null, excluded: false, ...state.records.get(path), ...changes };
  const outcome = await stacki.storage.set({ key: RECORD_PREFIX + hashed(path), value: JSON.stringify(record) });
  if (!outcome.applied) {
    await notify(outcome.reason, 'error');
    return false;
  }
  state.records.set(path, record);
  return true;
}

async function loadAccess() {
  try {
    const { value } = await stacki.storage.get({ key: ACCESS_KEY });
    const access = value ? JSON.parse(value) : {};
    state.access = {
      closedAll: access.closedAll === true,
      closed: Array.isArray(access.closed) ? access.closed.filter((handle) => typeof handle === 'string') : [],
    };
  } catch {
    state.access = { closedAll: false, closed: [] };
  }
}

async function saveAccess(access) {
  if (!state.isAdmin) return;
  const outcome = await stacki.storage.set({ key: ACCESS_KEY, value: JSON.stringify(access) });
  if (!outcome.applied) {
    await notify(outcome.reason, 'error');
    return;
  }
  state.access = access;
  render();
}

/** How a person is named in `access`: their GitHub login, else their name. */
function handleOf(person) {
  return String(person?.github || person?.login || person?.name || '')
    .trim()
    .toLowerCase();
}

/** Admins always may; for others an admin can close feedback, for everyone or for one person. */
function feedbackClosed() {
  if (state.isAdmin) return false;
  return state.access.closedAll || state.access.closed.includes(handleOf(state.person));
}

function mayChoose() {
  return state.canChoose && !feedbackClosed();
}

function depthOf(route) {
  return Math.max(0, String(route || '/').split('/').filter(Boolean).length - 1);
}

/** What the tree lists: every page once, a comparison's versions together as one page. */
function items() {
  const setOf = new Map();
  for (const set of state.sets) for (const version of set.versions) setOf.set(version.path, set);
  const routeOf = new Map(state.pages.map((page) => [page.path, page.route ?? '/']));
  const out = [];
  const seen = new Set();
  for (const set of state.sets) {
    if (seen.has(set.id) || set.versions.length === 0) continue;
    seen.add(set.id);
    out.push({
      kind: 'set',
      id: `set:${set.id}`,
      set,
      title: set.title,
      route: routeOf.get(set.versions[0].path) ?? '/',
      paths: set.versions.map((version) => version.path),
    });
  }
  for (const page of state.pages) {
    if (setOf.has(page.path)) continue;
    out.push({ kind: 'page', id: `page:${page.path}`, path: page.path, title: pageName(page.path), route: page.route ?? '/', paths: [page.path] });
  }
  return out.sort((a, b) => (a.route === b.route ? 0 : a.route < b.route ? -1 : 1));
}

/** The page whose variants and approval count: the chosen version of a comparison, or the page itself. */
function effectivePath(item) {
  if (item.kind === 'page') return item.path;
  if (item.set.versions.length === 1) return item.set.versions[0].path;
  return item.set.versions.find((version) => version.id === item.set.decision?.versionId)?.path;
}

function groupNames(path) {
  if (path === state.openPath) return state.groups.map((group) => group.name);
  const prefix = `${path}\n`;
  return [...(state.allGroups ?? state.choices.keys())].filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length));
}

function approvalOf(item) {
  return (item.kind === 'set' ? item.set.approval : state.records.get(item.path)?.approval) ?? undefined;
}

/** Where a page stands: what is still to choose, what an admin still has to confirm, and its approval. */
function statusOf(item) {
  if (item.kind === 'page' && state.records.get(item.path)?.excluded) return { state: 'excluded', label: 'Not needed', toChoose: 0, toConfirm: 0 };
  let toChoose = 0;
  let toConfirm = 0;
  if (item.kind === 'set' && item.set.versions.length > 1) {
    if (!item.set.decision) toChoose += 1;
    else if (!item.set.decision.confirmed) toConfirm += 1;
  }
  const path = effectivePath(item);
  for (const name of path ? groupNames(path) : []) {
    const decision = state.choices.get(choiceId(path, name))?.decision;
    if (!decision) toChoose += 1;
    else if (!decision.confirmed) toConfirm += 1;
  }
  const approval = approvalOf(item);
  if (toChoose > 0) return { state: 'open', label: `${toChoose} to choose`, toChoose, toConfirm };
  if (toConfirm > 0) return { state: 'waiting', label: `${toConfirm} to confirm`, toChoose, toConfirm };
  if (approval) return { state: 'approved', label: 'Approved', toChoose, toConfirm, approval };
  return { state: 'open', label: 'To approve', toChoose, toConfirm };
}

async function approve(item, approved) {
  if (approved ? !mayChoose() : !state.isAdmin) return;
  const approval = approved ? confirmation() : null;
  if (item.kind === 'set') {
    const before = item.set.approval;
    item.set.approval = approval;
    if (!(await saveSet(item.set))) {
      item.set.approval = before;
      return;
    }
  } else if (!(await saveRecord(item.path, { approval }))) return;
  render();
  if (approved) await notify(`${item.title} approved.`, 'success');
}

async function exclude(item, excluded) {
  if (!state.isAdmin || item.kind !== 'page') return;
  if (await saveRecord(item.path, { excluded })) render();
}

async function openItem(item) {
  if (item.paths.includes(state.openPath)) return;
  await openVersion({ path: effectivePath(item) ?? item.paths[0] });
}

/** The check, the note and the admin's button that a chosen item carries. */
function confirmationParts(decision, onConfirm) {
  const parts = [];
  if (decision?.confirmed) {
    const when = new Date(decision.confirmed.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    parts.push(element('p', { class: 'decision confirmed', text: `✓ Confirmed by ${decision.confirmed.byName} on ${when}.` }));
  }
  if (state.isAdmin && decision) {
    parts.push(
      element('div', { class: 'row' }, [
        decision.confirmed
          ? element('stacki-button', { variant: 'ghost', text: 'Undo confirmation', onclick: () => onConfirm(false) })
          : element('stacki-button', { variant: 'primary', text: 'Confirm choice', onclick: () => onConfirm(true) }),
      ]),
    );
  }
  return parts;
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
  if (!mayChoose() || !(await stacki.role.can({ permission: 'choose' }))) {
    await notify('You cannot choose a version right now.', 'error');
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

function dated(at) {
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function decisionLine(decision, label) {
  const line = element('p', { class: 'decision', text: `${decision.byName} chose ${label} on ${dated(decision.at)}. ` });
  if (decision.comment) line.append(element('q', { text: decision.comment }));
  return line;
}

function chooseParts(label, onChoose) {
  const comment = element('stacki-textarea', { class: 'grow', rows: '2', label: 'Comment', placeholder: 'Why this one? (optional)' });
  return [
    comment,
    element('div', { class: 'row' }, [
      element('stacki-button', { variant: 'primary', text: `Choose ${label}`, onclick: () => onChoose(comment.value ?? '') }),
    ]),
  ];
}

/** The versions of a comparison: which one is open, which one is chosen, and the choice itself. */
function versionParts(set) {
  const chosen = set.versions.find((version) => version.id === set.decision?.versionId);
  const open = set.versions.find((version) => version.path === state.openPath);
  const parts = [
    element('p', { class: 'part-title', text: 'Page versions' }),
    element(
      'ul',
      { class: 'versions' },
      set.versions.map((version) =>
        element('li', { class: `version${version.path === state.openPath ? ' open' : ''}`, title: version.path, onclick: () => openVersion(version) }, [
          element('span', { class: 'version-label', text: version.label }),
          version.path === state.openPath && element('span', { class: 'chip', text: 'Shown' }),
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
        ]),
      ),
    ),
  ];
  if (chosen) parts.push(decisionLine(set.decision, chosen.label), ...confirmationParts(set.decision, (confirmed) => confirmSet(set, confirmed)));
  if (mayChoose() && set.versions.length > 1 && open && open.id !== chosen?.id && !set.decision?.confirmed) {
    parts.push(...chooseParts(open.label, (comment) => choose(set, open, comment)));
  }
  return parts;
}

function groupParts(group) {
  const decision = decisionFor(group);
  const chosen = group.options.find((option) => option.id === decision?.variantId);
  const shown = group.options.find((option) => option.id === group.active);
  const parts = [
    element('p', { class: 'part-title', text: `Section: ${group.name}` }),
    element(
      'ul',
      { class: 'versions' },
      group.options.map((option) =>
        element('li', { class: `version${option.id === group.active ? ' open' : ''}`, onclick: () => showVariant(group, option) }, [
          element('span', { class: 'version-label', text: option.label }),
          option.id === group.active && element('span', { class: 'chip', text: 'Shown' }),
          option.id === chosen?.id && element('span', { class: 'chip chosen', text: 'Chosen' }),
        ]),
      ),
    ),
  ];
  if (chosen) parts.push(decisionLine(decision, chosen.label), ...confirmationParts(decision, (confirmed) => confirmVariant(group, confirmed)));
  if (mayChoose() && shown && shown.id !== chosen?.id && !decision?.confirmed) {
    parts.push(...chooseParts(shown.label, (comment) => chooseVariant(group, shown, comment)));
  }
  if (state.canManage && chosen && !decision.confirmed) {
    parts.push(element('div', { class: 'row' }, [element('stacki-button', { variant: 'ghost', text: 'Reset choice', onclick: () => resetVariant(group) })]));
  }
  return parts;
}

function approvalParts(item, status) {
  if (status.state === 'excluded') {
    return [
      element('p', { class: 'hint', text: 'This page does not need approval.' }),
      state.isAdmin &&
        element('div', { class: 'row' }, [element('stacki-button', { variant: 'ghost', text: 'Include in approval', onclick: () => exclude(item, false) })]),
    ];
  }
  if (status.state === 'approved') {
    return [
      element('p', { class: 'decision confirmed', text: `✓ Approved by ${status.approval.byName} on ${dated(status.approval.at)}.` }),
      state.isAdmin &&
        element('div', { class: 'row' }, [element('stacki-button', { variant: 'ghost', text: 'Undo approval', onclick: () => approve(item, false) })]),
    ];
  }
  const parts = [];
  if (status.toChoose + status.toConfirm > 0) {
    parts.push(
      element('p', {
        class: 'hint',
        text: status.toChoose > 0 ? 'Make every choice on this page before it can be approved.' : 'An admin confirms the choices before this page can be approved.',
      }),
    );
  } else if (mayChoose()) {
    parts.push(element('div', { class: 'row' }, [element('stacki-button', { variant: 'primary', text: 'Approve page', onclick: () => approve(item, true) })]));
  }
  return parts;
}

function manageParts(item) {
  const parts = [];
  if (state.canManage && item.kind === 'set') {
    const set = item.set;
    const used = new Set(state.sets.flatMap((entry) => entry.versions.map((version) => version.path)));
    const picker = element('stacki-dropdown', { class: 'grow', label: 'Add an existing page as a version', placeholder: 'Add existing page…', searchable: true });
    picker.options = state.pages
      .filter((page) => !used.has(page.path))
      .slice(0, 500)
      .map((page) => ({ value: page.path, label: `${pageName(page.path)} (${page.route})` }));
    picker.addEventListener('change', () => addExistingPage(set, picker.value));
    parts.push(
      element('div', { class: 'row' }, [
        picker,
        element('stacki-button', { text: 'Duplicate', title: `Copy ${set.versions[0].label} to a new page in ${VERSION_FOLDER}`, onclick: () => duplicateAsVersion(set) }),
      ]),
      element('div', { class: 'row' }, [
        set.decision && !set.decision.confirmed && element('stacki-button', { variant: 'ghost', text: 'Reset choice', onclick: () => resetDecision(set) }),
        element('stacki-button', { variant: 'ghost', icon: 'trash', text: 'Delete comparison', onclick: () => removeSet(set) }),
      ]),
    );
  }
  if (item.kind === 'page' && (state.canManage || state.isAdmin)) {
    parts.push(
      element('div', { class: 'row' }, [
        state.canManage && element('stacki-button', { variant: 'ghost', icon: 'plus', text: 'Compare versions', onclick: createSet }),
        state.isAdmin && !state.records.get(item.path)?.excluded && element('stacki-button', { variant: 'ghost', text: 'Not needed', title: 'Leave this page out of the approval', onclick: () => exclude(item, true) }),
      ]),
    );
  }
  return parts;
}

/** What the open page shows under its row: its versions, its section variants, its approval. */
function detailOf(item, status) {
  const parts = [];
  if (status.state !== 'excluded') {
    if (item.kind === 'set') parts.push(...versionParts(item.set));
    const counted = effectivePath(item);
    if (!counted || counted === state.openPath) for (const group of state.groups) parts.push(...groupParts(group));
  }
  parts.push(...approvalParts(item, status), ...manageParts(item));
  return element('div', { class: 'detail' }, parts.filter(Boolean));
}

const MARKS = { approved: '✓', waiting: '●', open: '○', excluded: '–' };

function rowOf(item, status, active) {
  return element(
    'div',
    {
      class: `page ${status.state}${active ? ' active' : ''}`,
      style: `--depth: ${depthOf(item.route)}`,
      title: item.route,
      role: 'button',
      onclick: () => openItem(item),
    },
    [
      element('span', { class: 'mark', text: MARKS[status.state] }),
      element('span', { class: 'page-title', text: item.title }),
      item.kind === 'set' && item.set.versions.length > 1 && element('span', { class: 'chip', text: `${item.set.versions.length} versions` }),
      element('span', { class: 'page-status', text: status.label }),
    ],
  );
}

function renderAccess() {
  if (!state.isAdmin) {
    accessElement.hidden = true;
    return;
  }
  accessElement.hidden = false;
  const access = state.access;
  const toggle = (closed, onclick) => element('stacki-button', { variant: 'ghost', text: closed ? 'Closed' : 'Open', class: closed ? 'closed' : '', onclick });
  const rows = [
    element('div', { class: 'row' }, [
      element('span', { class: 'grow', text: 'Everyone' }),
      toggle(access.closedAll, () => saveAccess({ ...access, closedAll: !access.closedAll })),
    ]),
  ];
  const mine = handleOf(state.person);
  const seen = new Set([mine]);
  for (const member of state.members) {
    const handle = handleOf(member);
    if (!handle || seen.has(handle)) continue;
    seen.add(handle);
    const closed = access.closedAll || access.closed.includes(handle);
    rows.push(
      element('div', { class: 'row' }, [
        element('span', { class: 'grow', text: member.name || member.login }),
        access.closedAll
          ? element('span', { class: 'chip', text: 'Closed' })
          : toggle(closed, () =>
              saveAccess({ ...access, closed: closed ? access.closed.filter((entry) => entry !== handle) : [...access.closed, handle] }),
            ),
      ]),
    );
  }
  const open = accessElement.querySelector('details')?.open ?? false;
  const closedCount = access.closedAll ? 'closed for everyone' : access.closed.length > 0 ? `closed for ${access.closed.length}` : 'open';
  accessElement.replaceChildren(
    element('details', { open }, [
      element('summary', { text: `Feedback access: ${closedCount}` }),
      element('p', { class: 'hint', text: 'Closed: the person can look, but cannot choose or approve. Admins always can.' }),
      ...rows,
    ]),
  );
}

function render() {
  const closed = feedbackClosed();
  viewOnlyChip.hidden = !closed && (state.canChoose || state.canManage);
  viewOnlyChip.textContent = closed ? 'Feedback closed' : 'View only';

  const all = items().map((item) => ({ item, status: statusOf(item) }));
  const rows = [];
  for (const { item, status } of all) {
    const active = item.paths.includes(state.openPath);
    rows.push(rowOf(item, status, active));
    if (active) rows.push(detailOf(item, status));
  }
  treeElement.replaceChildren(...rows);
  emptyElement.hidden = all.length > 0;
  emptyElement.textContent = 'No pages found.';

  const counted = all.filter(({ status }) => status.state !== 'excluded');
  const approved = counted.filter(({ status }) => status.state === 'approved').length;
  const percent = counted.length === 0 ? 0 : Math.round((approved / counted.length) * 100);
  const ready = counted.length > 0 && approved === counted.length;
  statusElement.hidden = counted.length === 0;
  statusElement.classList.toggle('ready', ready);
  statusElement.replaceChildren(
    element('div', { class: 'status-line' }, [
      element('span', { class: 'status-count', text: `${approved} of ${counted.length} pages approved` }),
      element('span', { class: 'status-percent', text: `${percent}%` }),
    ]),
    element('div', { class: 'bar' }, [element('div', { class: 'bar-fill', style: `width: ${percent}%` })]),
    element('p', { class: 'hint', text: ready ? '✓ Everything is approved. Ready for build.' : 'The build starts when every page is approved.' }),
  );
  renderAccess();
  stacki.app.badge({ count: counted.length - approved }).catch(() => {});
}

/* ---------- startup ---------- */

async function refreshPages() {
  try {
    state.pages = await stacki.page.list();
  } catch {
    state.pages = [];
  }
}

/** Reads the open page: its path and the variant groups written on it. The latest read wins. */
let viewRead = 0;
async function refreshView() {
  const read = ++viewRead;
  const view = await stacki.page.get().catch(() => undefined);
  if (read !== viewRead) return;
  state.openPath = view?.path;
  state.groups = readGroups(view);
  render();
}

function applyRole(role) {
  state.canManage = role.isAdmin || role.permissions?.manage === true;
  state.canChoose = role.isAdmin || role.permissions?.choose === true;
  state.isAdmin = role.isAdmin === true;
}

async function start() {
  const [role, person] = await Promise.all([stacki.role.get(), stacki.person.get()]);
  applyRole(role);
  state.person = person;
  await Promise.all([
    refreshPages(),
    loadSets(),
    loadChoices(),
    loadRecords(),
    loadAccess(),
    refreshAllGroups(),
    stacki.people
      .list()
      .then((members) => {
        state.members = (Array.isArray(members) ? members : []).filter((member) => member && (member.login || member.name)).slice(0, 200);
      })
      .catch(() => {}),
  ]);
  await refreshView();
  // The event does not carry the open file's path: read the page again.
  stacki.on('page.change', refreshView);
  stacki.on('role.change', (next) => {
    applyRole(next);
    render();
  });
  stacki.on('person.change', (next) => {
    state.person = next;
    render();
  });
  stacki.on('storage.change', async ({ origin }) => {
    if (origin !== 'other') return;
    await Promise.all([loadSets(), loadChoices(), loadRecords(), loadAccess()]);
    render();
  });
  stacki.on('project.change', async ({ source }) => {
    // An edit to the open page may add, remove or switch a variant group.
    if (source === 'page' || source === 'files') {
      await Promise.all([refreshAllGroups(), refreshView()]);
      render();
    }
    if (source !== 'files') return;
    await refreshPages();
    render();
  });
}

start().catch((error) => {
  emptyElement.hidden = false;
  emptyElement.textContent = `Page versions could not start: ${error.message}`;
});
