// File browser view.
import {
  $, h, api, toast, dialog, icon, fileTile, fmtSize, fmtDate, timeAgo, joinPath, parentOf, extOf, baseName,
  storeSet, session, showMenu, anyModalOpen, publicUrl, copyWithFeedback, displayPath,
} from './lib.js';
import { openEditor, downloadFile } from './editor.js';

const PREVIEW_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'avif', 'pdf', 'mp4', 'webm', 'mp3']);
const BINARY_EXT = new Set([
  'zip', 'gz', 'tgz', 'tar', 'rar', '7z', 'bz2', 'xz', 'mov', 'wav', 'ogg', 'm4a',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'exe', 'bin', 'so', 'jar', 'psd',
]);

const state = {
  cwd: null,
  items: [],
  sort: { key: 'name', dir: 1 },
  selected: new Set(),
  filter: '',
  loadSeq: 0,
};

export const currentDir = () => state.cwd;

export function navigate(path) {
  const hash = `#/files?path=${encodeURIComponent(path)}`;
  if (location.hash === hash) load(path);
  else location.hash = hash;
}

export function showFiles(path) {
  if (path !== state.cwd || !state.items.length) {
    state.filter = '';
    $('filter').value = '';
  }
  return load(path);
}

async function load(path) {
  const seq = ++state.loadSeq;
  $('filesLoading').classList.remove('hidden');
  try {
    const data = await api('GET', `/api/list?path=${encodeURIComponent(path)}`);
    if (seq !== state.loadSeq) return;
    if (data.path !== state.cwd) state.selected.clear();
    state.cwd = data.path;
    state.items = data.items;
    // drop selections that no longer exist
    const names = new Set(data.items.map((i) => joinPath(data.path, i.name)));
    for (const p of state.selected) if (!names.has(p)) state.selected.delete(p);
    storeSet('lastPath', state.cwd);
    render();
  } catch (err) {
    if (seq !== state.loadSeq) return;
    toast(err.message, 'err');
    if (state.cwd === null) navigate(session.info.home);
  } finally {
    if (seq === state.loadSeq) $('filesLoading').classList.add('hidden');
  }
}

const refresh = () => state.cwd && load(state.cwd);

function visibleItems() {
  const { key, dir } = state.sort;
  const f = state.filter.toLowerCase();
  return state.items
    .filter((i) => !f || i.name.toLowerCase().includes(f))
    .sort((a, b) => {
      const ad = a.type === 'dir' ? 0 : 1;
      const bd = b.type === 'dir' ? 0 : 1;
      if (ad !== bd) return ad - bd;
      if (key === 'name') return dir * a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      return dir * (a[key] - b[key]);
    });
}

function permOctal(rights) {
  const bits = (s) => (s[0] === 'r' ? 4 : 0) + (s[1] === 'w' ? 2 : 0) + (s[2] === 'x' ? 1 : 0);
  return rights.match(/.{3}/g).map(bits).join('');
}

// ---------- render ----------

function render() {
  renderCrumbs();
  const items = visibleItems();
  const tbody = $('fileRows');
  tbody.replaceChildren(...items.map(renderRow));

  const empty = $('filesEmpty');
  empty.classList.toggle('hidden', items.length > 0);
  empty.replaceChildren(
    h('span', { class: 'empty-icon' }, icon(state.items.length ? 'search' : 'folderUp', 26)),
    h('div', { class: 'empty-title' }, state.items.length ? 'No matches' : 'This folder is empty'),
    h('div', { class: 'empty-text' }, state.items.length ? `Nothing here matches "${state.filter}".` : 'Drag files or folders here, or use Upload.'));

  document.querySelectorAll('#view-files th[data-sort]').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.sort === state.sort.key);
    th.dataset.dir = state.sort.dir > 0 ? 'asc' : 'desc';
  });

  const dirs = state.items.filter((i) => i.type === 'dir').length;
  const files = state.items.length - dirs;
  const total = state.items.filter((i) => i.type !== 'dir').reduce((s, i) => s + i.size, 0);
  $('filesFoot').textContent = `${dirs} folder${dirs === 1 ? '' : 's'} · ${files} file${files === 1 ? '' : 's'} · ${fmtSize(total)}`;
  updateSelection();
}

function renderRow(item) {
  const full = joinPath(state.cwd, item.name);
  const selected = state.selected.has(full);
  const check = h('input', {
    type: 'checkbox', class: 'check', checked: selected,
    onchange: () => toggleSelect(full, check.checked),
    onclick: (e) => e.stopPropagation(),
  });
  const quick = [];
  if (item.type !== 'dir') {
    if (publicUrl(full)) quick.push(h('button', { class: 'icon-btn ghost sm quick', title: 'Copy URL', onclick: (e) => { e.stopPropagation(); copyUrl(full); } }, icon('link', 16)));
    quick.push(h('button', { class: 'icon-btn ghost sm quick', title: 'Edit', onclick: (e) => { e.stopPropagation(); editFile(full); } }, icon('edit', 16)));
    quick.push(h('button', { class: 'icon-btn ghost sm quick', title: 'Download', onclick: (e) => { e.stopPropagation(); downloadFile(full); } }, icon('download', 16)));
  }
  const more = h('button', {
    class: 'icon-btn ghost sm', title: 'More',
    onclick: (e) => {
      e.stopPropagation();
      const r = e.currentTarget.getBoundingClientRect();
      showMenu(menuFor(item, full), r.right - 200, r.bottom + 4);
    },
  }, icon('more', 16));

  const tr = h('tr', {
    class: selected ? 'selected' : '',
    onclick: (e) => {
      if (e.target.closest('button, a, input')) return;
      toggleSelect(full, !state.selected.has(full));
    },
    ondblclick: (e) => { if (!e.target.closest('button, input')) openItem(item); },
    oncontextmenu: (e) => {
      e.preventDefault();
      showMenu(menuFor(item, full), e.clientX, e.clientY);
    },
  },
  h('td', { class: 'cell-check' }, check),
  h('td', { class: 'cell-name' },
    h('a', { class: 'name', href: item.type === 'dir' ? `#/files?path=${encodeURIComponent(full)}` : null, title: item.name, onclick: (e) => { e.preventDefault(); openItem(item); } },
      fileTile(item),
      h('span', { class: 'name-text' }, item.name),
      item.link ? h('span', { class: 'chip' }, 'link') : null)),
  h('td', { class: 'cell-size' }, item.type === 'dir' ? '—' : fmtSize(item.size)),
  h('td', { class: 'cell-date', title: fmtDate(item.modified) }, timeAgo(item.modified)),
  h('td', { class: 'cell-perm' }, h('span', { class: 'perm', title: item.rights }, permOctal(item.rights))),
  h('td', { class: 'cell-actions' }, h('div', { class: 'row-actions' }, ...quick, more)));
  return tr;
}

// Crumbs start at the working folder; nothing above it is shown.
function renderCrumbs() {
  const root = session.info.home;
  const rel = state.cwd === root ? '' : state.cwd.slice(root === '/' ? 0 : root.length);
  const parts = rel.split('/').filter(Boolean);
  const crumbs = [h('a', {
    class: `crumb crumb-root${parts.length ? '' : ' current'}`,
    href: `#/files?path=${encodeURIComponent(root)}`,
  }, icon(root === '/' ? 'server' : 'home', 15), root === '/' ? null : baseName(root))];
  parts.forEach((p, i) => {
    crumbs.push(h('span', { class: 'crumb-sep' }, icon('chevron', 14)));
    const path = (root === '/' ? '' : root) + '/' + parts.slice(0, i + 1).join('/');
    crumbs.push(h('a', { class: `crumb${i === parts.length - 1 ? ' current' : ''}`, href: `#/files?path=${encodeURIComponent(path)}` }, p));
  });
  $('crumbs').replaceChildren(...crumbs);
  $('btnUp').disabled = state.cwd === root;
}

// ---------- selection ----------

function toggleSelect(full, on) {
  on ? state.selected.add(full) : state.selected.delete(full);
  render();
}

function updateSelection() {
  const n = state.selected.size;
  $('selCount').textContent = `${n} selected`;
  $('selectionBar').classList.toggle('hidden', n === 0);
  $('fileActions').classList.toggle('hidden', n > 0);
  const visible = visibleItems().length;
  $('checkAll').checked = n > 0 && n >= visible;
  $('checkAll').indeterminate = n > 0 && n < visible;
}

// ---------- actions ----------

function menuFor(item, full) {
  const isDir = item.type === 'dir';
  const url = publicUrl(full);
  return [
    isDir
      ? { label: 'Open', icon: 'folder', onClick: () => navigate(full) }
      : { label: 'Edit', icon: 'edit', onClick: () => editFile(full) },
    PREVIEW_EXT.has(extOf(item.name)) ? { label: 'Preview', icon: 'eye', onClick: () => preview(full) } : null,
    isDir ? null : { label: 'Download', icon: 'download', onClick: () => downloadFile(full) },
    'sep',
    url ? { label: 'Open in browser', icon: 'globe', onClick: () => window.open(url, '_blank', 'noopener') } : null,
    url ? { label: 'Copy URL', icon: 'link', onClick: () => copyUrl(full) } : null,
    { label: 'Duplicate', icon: 'copy', onClick: () => duplicateItem(item) },
    { label: 'Rename', icon: 'rename', onClick: () => renameItem(item) },
    { label: 'Permissions', icon: 'lock', onClick: () => chmodItem(item) },
    { label: 'Copy server path', icon: 'server', onClick: () => copyWithFeedback(full, 'Server path') },
    'sep',
    { label: 'Delete', icon: 'trash', danger: true, onClick: () => deletePaths([full]) },
  ].filter(Boolean);
}

const editFile = (full) => openEditor(full, refresh);
const preview = (full) => window.open(`/api/download?inline=1&path=${encodeURIComponent(full)}`, '_blank');

function openItem(item) {
  const full = joinPath(state.cwd, item.name);
  if (item.type === 'dir') return navigate(full);
  const ext = extOf(item.name);
  if (PREVIEW_EXT.has(ext)) return preview(full);
  if (BINARY_EXT.has(ext)) return downloadFile(full);
  editFile(full);
}

function copyUrl(full) {
  const url = publicUrl(full);
  if (url) copyWithFeedback(url, 'URL');
}

// "name.php" -> "name-copy.php", "folder" -> "folder-copy" (adds -2, -3 … if taken)
function copyName(item) {
  const taken = new Set(state.items.map((i) => i.name));
  const dot = item.type === 'dir' ? -1 : item.name.lastIndexOf('.');
  const base = dot > 0 ? item.name.slice(0, dot) : item.name;
  const ext = dot > 0 ? item.name.slice(dot) : '';
  for (let n = 1; ; n++) {
    const candidate = `${base}-copy${n > 1 ? '-' + n : ''}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

async function duplicateItem(item) {
  const isDir = item.type === 'dir';
  const name = await dialog({
    title: isDir ? 'Duplicate folder' : 'Duplicate file',
    message: `A new ${isDir ? 'folder' : 'file'} with the same ${isDir ? 'files inside' : 'content'} as "${item.name}" will be created here. Name for the copy:`,
    value: copyName(item),
    okText: 'Duplicate',
  });
  if (!name || name === item.name) return;
  if (name.includes('/')) return toast('Name cannot contain "/"', 'err');
  $('filesLoading').classList.remove('hidden');
  if (isDir) toast(`Copying folder ${item.name}… this can take a moment`);
  try {
    await api('POST', '/api/duplicate', { from: joinPath(state.cwd, item.name), to: joinPath(state.cwd, name) });
    toast(`Created ${name}`);
  } catch (err) { toast(err.message, 'err'); }
  refresh();
}

async function renameItem(item) {
  const name = await dialog({ title: 'Rename', value: item.name, okText: 'Rename' });
  if (!name || name === item.name) return;
  if (name.includes('/')) return toast('Name cannot contain "/"', 'err');
  try {
    await api('POST', '/api/rename', { from: joinPath(state.cwd, item.name), to: joinPath(state.cwd, name) });
    toast(`Renamed to ${name}`);
    refresh();
  } catch (err) { toast(err.message, 'err'); }
}

async function chmodItem(item) {
  const mode = await dialog({
    title: 'Change permissions',
    message: `${item.name} — usually 644 for files and 755 for folders.`,
    value: permOctal(item.rights),
    okText: 'Apply',
  });
  if (!mode) return;
  try {
    await api('POST', '/api/chmod', { path: joinPath(state.cwd, item.name), mode });
    toast(`Permissions set to ${mode}`);
    refresh();
  } catch (err) { toast(err.message, 'err'); }
}

async function deletePaths(paths) {
  const names = paths.map((p) => p.split('/').pop());
  const ok = await dialog({
    title: paths.length === 1 ? `Delete "${names[0]}"?` : `Delete ${paths.length} items?`,
    message: `${paths.length === 1 ? 'It' : 'They'} will move to the Recycle Bin and can be restored for ${session.info.trashDays} days.`,
    okText: 'Move to Recycle Bin',
    danger: true,
  });
  if (!ok) return;
  try {
    await api('POST', '/api/delete', { paths });
    toast(paths.length === 1 ? `${names[0]} moved to Recycle Bin` : `${paths.length} items moved to Recycle Bin`);
    state.selected.clear();
  } catch (err) {
    toast(err.message, 'err');
  }
  window.dispatchEvent(new Event('trash-changed'));
  refresh();
}

async function newFolder() {
  const name = await dialog({ title: 'New folder', value: '', placeholder: 'folder-name', okText: 'Create' });
  if (!name) return;
  try {
    await api('POST', '/api/mkdir', { path: joinPath(state.cwd, name) });
    toast(`Folder ${name} created`);
    refresh();
  } catch (err) { toast(err.message, 'err'); }
}

async function newFile() {
  const name = await dialog({ title: 'New file', value: '', placeholder: 'index.php', okText: 'Create' });
  if (!name) return;
  const full = joinPath(state.cwd, name);
  try {
    await api('POST', '/api/newfile', { path: full });
    await load(state.cwd);
    editFile(full);
  } catch (err) { toast(err.message, 'err'); }
}

// ---------- upload ----------

function uploadFiles(entries) {
  if (!entries.length) return;
  const dir = state.cwd;
  const total = entries.reduce((s, e) => s + e.file.size, 0);
  const form = new FormData();
  form.append('dir', dir);
  form.append('relPaths', JSON.stringify(entries.map((e) => e.rel)));
  entries.forEach((e) => form.append('files', e.file, e.file.name));

  const label = entries.length === 1 ? entries[0].rel : `${entries.length} files`;
  const bar = $('progress');
  bar.classList.remove('hidden');
  $('progressFill').style.width = '0%';
  $('progressLabel').textContent = `Uploading ${label}`;
  $('progressMeta').textContent = fmtSize(total);

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/upload');
  xhr.upload.onprogress = (e) => {
    if (!e.lengthComputable) return;
    const pct = Math.round((e.loaded / e.total) * 100);
    $('progressFill').style.width = `${pct}%`;
    $('progressMeta').textContent = pct >= 100 ? 'Saving on server…' : `${pct}% of ${fmtSize(total)}`;
  };
  xhr.onload = () => {
    bar.classList.add('hidden');
    let data = {};
    try { data = JSON.parse(xhr.responseText); } catch {}
    if (xhr.status >= 200 && xhr.status < 300) {
      if (data.rejected?.length) {
        if (data.count) toast(`Uploaded ${data.count} of ${entries.length} files`);
        warnRejected(data.rejected);
      } else {
        toast(`Uploaded ${label}`);
      }
      if (data.lintProblems?.length) warnUploadErrors(data.lintProblems);
    } else toast(data.error || `Upload failed (${xhr.status})`, 'err');
    if (state.cwd === dir) refresh();
  };
  xhr.onerror = () => {
    bar.classList.add('hidden');
    toast('Upload failed — is the dashboard still running?', 'err');
  };
  xhr.send(form);
}

// Team members can't put PHP with syntax errors on the live site (same rule as Save).
async function warnRejected(rejected) {
  const list = rejected.slice(0, 5).map((p) => `${displayPath(p.path)} — line ${p.line}: ${p.message}`).join('\n');
  const more = rejected.length > 5 ? `\n…and ${rejected.length - 5} more` : '';
  await dialog({
    title: `${rejected.length} PHP file${rejected.length === 1 ? ' was' : 's were'} not uploaded`,
    message: `${list}${more}\n\nThese files have errors, so they were kept off the live site. Fix them and upload again.`,
    okText: 'OK',
    cancelText: 'Close',
  });
}

async function warnUploadErrors(problems) {
  const list = problems.slice(0, 5).map((p) => `${displayPath(p.path)} — line ${p.line}: ${p.message}`).join('\n');
  const more = problems.length > 5 ? `\n…and ${problems.length - 5} more` : '';
  const ok = await dialog({
    title: `Uploaded, but ${problems.length} PHP file${problems.length === 1 ? ' has an error' : 's have errors'}`,
    message: `${list}${more}\n\nThese files are live now and may not work until fixed.`,
    okText: 'Open to fix',
    cancelText: 'Close',
    danger: true,
  });
  if (ok) editFile(problems[0].path);
}

function readAllEntries(reader) {
  return new Promise((resolve, reject) => {
    const all = [];
    const next = () => reader.readEntries((batch) => {
      if (!batch.length) return resolve(all);
      all.push(...batch);
      next();
    }, reject);
    next();
  });
}

async function collectDropped(dataTransfer) {
  const roots = [...dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!roots.length) return [...dataTransfer.files].map((file) => ({ file, rel: file.name }));
  const out = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, rel: prefix + file.name });
    } else if (entry.isDirectory) {
      for (const child of await readAllEntries(entry.createReader())) await walk(child, prefix + entry.name + '/');
    }
  };
  for (const r of roots) await walk(r, '');
  return out;
}

// ---------- wiring ----------

$('btnUp').onclick = () => state.cwd && state.cwd !== session.info.home && navigate(parentOf(state.cwd));
$('btnHome').onclick = () => navigate(session.info.home);
$('btnRefresh').onclick = refresh;
$('btnNewFolder').onclick = newFolder;
$('btnNewFile').onclick = newFile;
$('btnUpload').onclick = () => $('fileInput').click();
$('btnUploadDir').onclick = () => $('dirInput').click();
$('btnDeleteSel').onclick = () => deletePaths([...state.selected]);
$('btnClearSel').onclick = () => { state.selected.clear(); render(); };

$('fileInput').onchange = (e) => {
  uploadFiles([...e.target.files].map((file) => ({ file, rel: file.name })));
  e.target.value = '';
};
$('dirInput').onchange = (e) => {
  uploadFiles([...e.target.files].map((file) => ({ file, rel: file.webkitRelativePath || file.name })));
  e.target.value = '';
};

$('checkAll').onchange = (e) => {
  state.selected.clear();
  if (e.target.checked) visibleItems().forEach((i) => state.selected.add(joinPath(state.cwd, i.name)));
  render();
};

document.querySelectorAll('#view-files th[data-sort]').forEach((th) => {
  th.onclick = () => {
    const key = th.dataset.sort;
    state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : 1 };
    render();
  };
});

$('filter').oninput = (e) => { state.filter = e.target.value; render(); };

// Click the empty part of the breadcrumb bar to type a path.
$('crumbs').onclick = (e) => {
  if (e.target.closest('a')) return;
  const input = $('pathInput');
  $('crumbs').classList.add('hidden');
  input.classList.remove('hidden');
  input.value = state.cwd;
  input.focus();
  input.select();
};
$('pathInput').onkeydown = (e) => {
  if (e.key === 'Enter') { const v = e.target.value.trim() || '/'; e.target.blur(); navigate(v); }
  if (e.key === 'Escape') { e.stopPropagation(); e.target.blur(); }
};
$('pathInput').onblur = () => {
  $('pathInput').classList.add('hidden');
  $('crumbs').classList.remove('hidden');
};

// Drag & drop upload
let dragDepth = 0;
const zone = $('dropZone');
const hasFiles = (e) => e.dataTransfer?.types.includes('Files');
zone.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  $('dropOverlay').classList.remove('hidden');
});
zone.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
zone.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; $('dropOverlay').classList.add('hidden'); }
});
zone.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('dropOverlay').classList.add('hidden');
  uploadFiles(await collectDropped(e.dataTransfer));
});

// Delete key removes the selection (when not typing somewhere)
document.addEventListener('keydown', (e) => {
  if ($('view-files').classList.contains('hidden') || anyModalOpen()) return;
  if (e.target.closest('input, textarea, [contenteditable]')) return;
  if ((e.key === 'Delete' || (e.key === 'Backspace' && e.metaKey)) && state.selected.size) {
    e.preventDefault();
    deletePaths([...state.selected]);
  }
});
