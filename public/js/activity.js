// Activity log view (owner only): who did what, to which file, and the exact change.
import { $, h, api, toast, icon, fmtDate, fmtSize, avatar, parentOf, displayPath } from './lib.js';
import { openDiff } from './editor.js';

export const ACTIONS = {
  edit: ['Edited', 'blue', 'edit'],
  upload: ['Uploaded', 'green', 'upload'],
  create_file: ['Created file', 'green', 'filePlus'],
  create_folder: ['Created folder', 'green', 'folderPlus'],
  rename: ['Renamed', 'violet', 'rename'],
  duplicate: ['Duplicated', 'blue', 'copy'],
  chmod: ['Permissions', 'violet', 'lock'],
  delete: ['Deleted', 'red', 'trash'],
  purge: ['Deleted forever', 'red', 'trash'],
  restore: ['Restored', 'amber', 'restore'],
  revert: ['Reverted', 'amber', 'history'],
  download: ['Downloaded', 'gray', 'download'],
  login: ['Signed in', 'gray', 'login'],
  logout: ['Signed out', 'gray', 'logout'],
  login_failed: ['Failed sign-in', 'red', 'alert'],
  password_change: ['Password changed', 'gray', 'key'],
  user_add: ['Added member', 'teal', 'userPlus'],
  user_update: ['Updated member', 'teal', 'users'],
  user_remove: ['Removed member', 'red', 'users'],
  setup: ['Owner created', 'teal', 'shield'],
  ignore_api: ['Ignored API', 'gray', 'eyeOff'],
  unignore_api: ['Un-ignored API', 'gray', 'eye'],
};

const PAGE = 60;
const state = { items: [], total: 0, seq: 0 };

const actionSelect = $('actAction');
for (const [key, [label]] of Object.entries(ACTIONS)) actionSelect.append(h('option', { value: key }, label));

function query(offset) {
  const p = new URLSearchParams({ offset, limit: PAGE });
  if ($('actSearch').value.trim()) p.set('q', $('actSearch').value.trim());
  if ($('actUser').value) p.set('user', $('actUser').value);
  if ($('actAction').value) p.set('action', $('actAction').value);
  return `/api/activity?${p}`;
}

export async function showActivity(append = false) {
  const seq = ++state.seq;
  $('actLoading').classList.remove('hidden');
  try {
    const data = await api('GET', query(append ? state.items.length : 0));
    if (seq !== state.seq) return;
    state.items = append ? state.items.concat(data.items) : data.items;
    state.total = data.total;
    const userSel = $('actUser');
    const chosen = userSel.value;
    userSel.replaceChildren(h('option', { value: '' }, 'Everyone'), ...data.users.map((u) => h('option', { value: u }, `@${u}`)));
    userSel.value = chosen;
    render();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    if (seq === state.seq) $('actLoading').classList.add('hidden');
  }
}

// Reset the filter controls so switching back to Activity shows the full, newest log again.
export function resetActivity() {
  state.items = [];
  state.total = 0;
  $('actSearch').value = '';
  $('actUser').value = '';
  $('actAction').value = '';
}

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function pathLink(path) {
  return h('a', { class: 'mono path-link', href: `#/files?path=${encodeURIComponent(parentOf(path))}`, title: `Open folder ${parentOf(path)}` }, displayPath(path));
}

function render() {
  const rows = [];
  let lastDay = null;
  for (const e of state.items) {
    const day = dayLabel(e.ts);
    if (day !== lastDay) {
      rows.push(h('tr', { class: 'day-row' }, h('td', { colspan: 5 }, day)));
      lastDay = day;
    }
    const [label, tone, iconName] = ACTIONS[e.action] || [e.action, 'gray', 'info'];
    const target = e.to
      ? h('div', { class: 'path-change' }, pathLink(e.path), h('span', { class: 'arrow' }, '→'), h('span', { class: 'mono' }, e.to.split('/').pop()))
      : e.path ? pathLink(e.path) : null;
    const extra = [e.detail, e.size !== undefined && e.action !== 'delete' ? fmtSize(e.size) : null].filter(Boolean).join(' · ');
    rows.push(h('tr', {},
      h('td', { class: 'cell-time', title: fmtDate(e.ts) },
        new Date(e.ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })),
      h('td', { class: 'cell-user' },
        h('span', { class: 'who' }, avatar(e.name, e.user, 'xs'),
          h('span', { class: 'who-text' }, h('span', {}, e.name), h('span', { class: 'muted' }, `@${e.user}`)))),
      h('td', {}, h('span', { class: `badge badge-${tone}` }, icon(iconName, 13), label)),
      h('td', { class: 'cell-target' }, target, extra ? h('div', { class: 'detail' }, extra) : null),
      h('td', { class: 'cell-actions' },
        e.hasDiff
          ? h('button', { class: 'btn btn-sm', onclick: () => openDiff(e.id, { onReverted: () => showActivity() }) }, icon('eye', 15), 'View changes')
          : null)));
  }
  $('actRows').replaceChildren(...rows);

  const empty = $('actEmpty');
  empty.classList.toggle('hidden', state.items.length > 0);
  empty.replaceChildren(
    h('span', { class: 'empty-icon' }, icon('history', 26)),
    h('div', { class: 'empty-title' }, 'No activity found'),
    h('div', { class: 'empty-text' }, 'Every upload, edit, rename and delete by anyone on the team will be listed here.'));

  $('actFoot').textContent = state.total ? `Showing ${state.items.length} of ${state.total}` : '';
  $('actMore').classList.toggle('hidden', state.items.length >= state.total);
}

let searchTimer = null;
$('actSearch').oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => showActivity(), 250);
};
$('actUser').onchange = () => showActivity();
$('actAction').onchange = () => showActivity();
$('actMore').onclick = () => showActivity(true);
$('actRefresh').onclick = () => showActivity();
