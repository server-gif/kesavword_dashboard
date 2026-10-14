// Recycle Bin view.
import { $, h, api, toast, dialog, icon, fileTile, fmtSize, fmtDate, timeAgo, parentOf, avatar, isAdmin, displayPath } from './lib.js';

const DAY = 86400000;
const state = { items: [], selected: new Set() };

export async function showTrash() {
  $('trashLoading').classList.remove('hidden');
  try {
    const data = await api('GET', '/api/trash');
    state.items = data.items;
    const ids = new Set(data.items.map((i) => i.id));
    for (const id of state.selected) if (!ids.has(id)) state.selected.delete(id);
    render();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    $('trashLoading').classList.add('hidden');
  }
}

function render() {
  const admin = isAdmin();
  $('trashRows').replaceChildren(...state.items.map((item) => {
    const daysLeft = Math.max(0, Math.ceil((item.expiresAt - Date.now()) / DAY));
    const tone = daysLeft <= 1 ? 'danger' : daysLeft <= 3 ? 'warn' : 'muted';
    const check = h('input', {
      type: 'checkbox', class: 'check', checked: state.selected.has(item.id),
      onchange: () => { check.checked ? state.selected.add(item.id) : state.selected.delete(item.id); render(); },
    });
    return h('tr', { class: state.selected.has(item.id) ? 'selected' : '' },
      h('td', { class: 'cell-check' }, check),
      h('td', { class: 'cell-name' },
        h('div', { class: 'name static' },
          fileTile(item),
          h('div', { class: 'name-stack' },
            h('span', { class: 'name-text' }, item.name),
            h('span', { class: 'name-sub mono', title: item.path }, displayPath(parentOf(item.path)))))),
      h('td', { class: 'cell-size' }, item.type === 'dir' ? 'Folder' : fmtSize(item.size)),
      h('td', { class: 'cell-user' }, h('span', { class: 'who' }, avatar(item.deletedByName, item.deletedBy, 'xs'), item.deletedByName)),
      h('td', { class: 'cell-date', title: fmtDate(item.deletedAt) }, timeAgo(item.deletedAt)),
      h('td', {}, h('span', { class: `pill pill-${tone}`, title: `Deleted forever on ${fmtDate(item.expiresAt)}` },
        daysLeft === 0 ? 'today' : `${daysLeft} day${daysLeft === 1 ? '' : 's'} left`)),
      h('td', { class: 'cell-actions' },
        h('div', { class: 'row-actions visible' },
          h('button', { class: 'btn btn-sm', onclick: () => restore([item.id]) }, icon('restore', 15), 'Restore'),
          admin ? h('button', { class: 'icon-btn ghost sm danger', title: 'Delete forever', onclick: () => purge([item.id]) }, icon('trash', 16)) : null)));
  }));

  const empty = $('trashEmpty');
  empty.classList.toggle('hidden', state.items.length > 0);
  empty.replaceChildren(
    h('span', { class: 'empty-icon' }, icon('trash', 26)),
    h('div', { class: 'empty-title' }, 'Recycle Bin is empty'),
    h('div', { class: 'empty-text' }, 'Deleted files and folders will show up here.'));

  const n = state.selected.size;
  $('trashSelCount').textContent = `${n} selected`;
  $('trashSelBar').classList.toggle('hidden', n === 0);
  $('btnTrashPurgeSel').classList.toggle('hidden', !admin);
  $('btnEmptyTrash').classList.toggle('hidden', !admin || state.items.length === 0 || n > 0);
  $('trashCheckAll').checked = n > 0 && n === state.items.length;
  $('trashCheckAll').indeterminate = n > 0 && n < state.items.length;
  $('trashFoot').textContent = state.items.length
    ? `${state.items.length} item${state.items.length === 1 ? '' : 's'} in Recycle Bin`
    : '';
}

async function restore(ids) {
  try {
    const res = await api('POST', '/api/trash/restore', { ids });
    toast(res.restored.length === 1 ? `Restored to ${res.restored[0]}` : `Restored ${res.restored.length} items`);
    ids.forEach((id) => state.selected.delete(id));
  } catch (err) { toast(err.message, 'err'); }
  window.dispatchEvent(new Event('trash-changed'));
  showTrash();
}

async function purge(ids, all = false) {
  const count = all ? state.items.length : ids.length;
  const ok = await dialog({
    title: all ? 'Empty the Recycle Bin?' : count === 1 ? 'Delete forever?' : `Delete ${count} items forever?`,
    message: 'These files will be permanently removed from the server. This cannot be undone.',
    okText: 'Delete forever',
    danger: true,
  });
  if (!ok) return;
  try {
    await api('POST', '/api/trash/purge', all ? { all: true } : { ids });
    toast(all ? 'Recycle Bin emptied' : 'Deleted forever');
    state.selected.clear();
  } catch (err) { toast(err.message, 'err'); }
  window.dispatchEvent(new Event('trash-changed'));
  showTrash();
}

$('btnTrashRestoreSel').onclick = () => restore([...state.selected]);
$('btnTrashPurgeSel').onclick = () => purge([...state.selected]);
$('btnTrashClearSel').onclick = () => { state.selected.clear(); render(); };
$('btnEmptyTrash').onclick = () => purge([], true);
$('trashCheckAll').onchange = (e) => {
  state.selected = new Set(e.target.checked ? state.items.map((i) => i.id) : []);
  render();
};
