// Shared helpers: DOM, icons, API, toasts, dialogs, formatting.

export const session = { user: null, info: null };
export const isAdmin = () => session.user?.role === 'admin';

export const $ = (id) => document.getElementById(id);

// h('div', { class: 'x', onclick: fn }, child, 'text', ...)
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined) continue;
    if (v === false) { if (k in el) el[k] = false; continue; }
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// ---------- icons (Lucide-style, stroke) ----------

const FOLDER = '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>';
const FILE = '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>';
const ICONS = {
  folder: FOLDER,
  file: FILE,
  code: FILE + '<path d="m10 13-2 2 2 2"/><path d="m14 17 2-2-2-2"/>',
  text: FILE + '<path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
  image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  media: '<circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/>',
  settings: '<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  folderUp: FOLDER + '<path d="M12 10v6"/><path d="m9 13 3-3 3 3"/>',
  folderPlus: FOLDER + '<line x1="12" x2="12" y1="10" y2="16"/><line x1="9" x2="15" y1="13" y2="13"/>',
  filePlus: FILE + '<path d="M9 15h6"/><path d="M12 18v-6"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
  edit: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  rename: '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" x2="15" y1="20" y2="20"/><line x1="12" x2="12" y1="4" y2="20"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  restore: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  userPlus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>',
  home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  up: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  server: '<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>',
  diff: '<path d="M12 3v14"/><path d="M5 10h14"/><path d="M5 21h14"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  menu: '<line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/>',
  back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  chart: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  save: '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  login: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" x2="3" y1="12" y2="12"/>',
  ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  calendar: '<rect width="18" height="18" x="3" y="4" rx="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/>',
};

export function icon(name, size = 18) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  return span;
}

// Fill every [data-icon] placeholder in static markup.
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    el.prepend(icon(el.dataset.icon, Number(el.dataset.size) || 18));
    el.removeAttribute('data-icon');
  });
}

// ---------- files ----------

export const joinPath = (dir, name) => (dir === '/' ? '' : dir) + '/' + name;
export const parentOf = (p) => p.replace(/\/[^/]+$/, '') || '/';
export const baseName = (p) => p.split('/').pop() || '/';

// Public web link of a file or folder inside the working folder, e.g. http://example.com/api/x.php
export function publicUrl(path) {
  const { url, home = '/' } = session.info || {};
  if (!url || !(home === '/' || path === home || path.startsWith(home + '/'))) return null;
  const rel = home === '/' ? path : path.slice(home.length);
  return url + rel.split('/').map(encodeURIComponent).join('/');
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}
  // Fallback for plain-http addresses where the clipboard API is unavailable
  const ta = h('textarea', { style: 'position:fixed;top:0;left:0;opacity:0' });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  ta.remove();
  return ok;
}

// Copies text and confirms with a toast; if the browser blocks copying, shows it selected so ⌘C works.
export async function copyWithFeedback(text, label) {
  if (await copyText(text)) return toast(`${label} copied: ${text}`);
  await dialog({ title: `Copy ${label}`, message: 'Press ⌘C (or Ctrl+C) to copy it.', value: text, okText: 'Done', selectAll: true });
}

// Paths inside the working folder are shown from that folder's name, e.g. "public_html/css/app.css".
export function displayPath(p) {
  const root = session.info?.home || '/';
  if (root === '/' || !p) return p;
  if (p === root) return baseName(root);
  return p.startsWith(root + '/') ? baseName(root) + p.slice(root.length) : p;
}

export function extOf(name) {
  const lower = name.toLowerCase();
  if (lower === 'dockerfile') return 'dockerfile';
  const i = lower.lastIndexOf('.');
  return i > 0 ? lower.slice(i + 1) : lower.startsWith('.') ? lower.slice(1) : '';
}

const KINDS = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif'],
  archive: ['zip', 'gz', 'tgz', 'tar', 'rar', '7z', 'bz2', 'xz'],
  media: ['mp4', 'mov', 'webm', 'mp3', 'wav', 'ogg', 'm4a'],
  pdf: ['pdf'],
  code: ['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'php', 'py', 'html', 'htm', 'css', 'scss', 'less', 'vue', 'java', 'go', 'rb', 'sh', 'sql', 'twig', 'json', 'xml'],
  config: ['env', 'ini', 'conf', 'yml', 'yaml', 'htaccess', 'toml', 'lock', 'gitignore', 'dockerfile'],
  text: ['txt', 'md', 'log', 'csv'],
};

export function fileKind(item) {
  if (item.type === 'dir') return { icon: item.link ? 'link' : 'folder', tone: 'folder' };
  const e = extOf(item.name);
  for (const [kind, exts] of Object.entries(KINDS)) {
    if (exts.includes(e)) {
      const iconName = { pdf: 'text', config: 'settings' }[kind] || kind;
      return { icon: iconName, tone: kind };
    }
  }
  return { icon: item.link ? 'link' : 'file', tone: 'file' };
}

export function fileTile(item, size = 'md') {
  const k = fileKind(item);
  return h('span', { class: `tile tile-${size} t-${k.tone}` }, icon(k.icon, size === 'sm' ? 15 : 17));
}

// ---------- formatting ----------

export function fmtSize(n) {
  if (n === null || n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

export function fmtDate(ms) {
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function timeAgo(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hrs = Math.round(m / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const d = Math.round(hrs / 24);
  if (d === 1) return 'yesterday';
  if (d < 30) return `${d} days ago`;
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function avatar(name = '?', username = '', size = 'md') {
  let hash = 0;
  for (const ch of username || name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const initials = name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || '').join('') || '?';
  return h('span', { class: `avatar avatar-${size}`, style: `--h:${hash % 360}` }, initials);
}

// ---------- api ----------

export async function api(method, url, body, opts = {}) {
  let signal = opts.signal;
  let timer = null;
  if (!signal && opts.timeoutMs) {
    const ac = new AbortController();
    signal = ac.signal;
    timer = setTimeout(() => ac.abort(), opts.timeoutMs);
  }
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      const e = new Error('The server is still catching up — try again in a moment.');
      e.aborted = true;
      throw e;
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith('/api/login') && !url.startsWith('/api/session')) {
    window.dispatchEvent(new Event('session-expired'));
  }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ---------- storage ----------

export function storeGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
export function storeSet(key, val) { try { localStorage.setItem(key, val); } catch {} }

// ---------- toasts ----------

export function toast(msg, type = 'ok') {
  const el = h('div', { class: `toast toast-${type}` },
    icon(type === 'err' ? 'alert' : 'check', 16),
    h('span', {}, msg));
  $('toasts').append(el);
  requestAnimationFrame(() => el.classList.add('in'));
  setTimeout(() => { el.classList.remove('in'); setTimeout(() => el.remove(), 250); }, type === 'err' ? 6000 : 3200);
}

// ---------- modal stack (Escape closes the top one) ----------

const modalStack = [];

export function openModal(el, onEscape) {
  el.classList.remove('hidden');
  const existing = modalStack.find((m) => m.el === el);
  if (existing) existing.onEscape = onEscape; // already open (e.g. switching files in the editor)
  else modalStack.push({ el, onEscape });
}

export function closeModal(el) {
  el.classList.add('hidden');
  const i = modalStack.findIndex((m) => m.el === el);
  if (i >= 0) modalStack.splice(i, 1);
}

export const anyModalOpen = () => modalStack.length > 0;

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !modalStack.length) return;
  e.preventDefault();
  modalStack[modalStack.length - 1].onEscape?.();
});

// ---------- dialog: confirm / prompt ----------

export function dialog({ title, message = '', value = null, okText = 'OK', cancelText = 'Cancel', danger = false, placeholder = '', selectAll = false }) {
  return new Promise((resolve) => {
    const input = h('input', { class: 'input mono', value: value ?? '', placeholder, spellcheck: false, autocomplete: 'off' });
    const form = h('form', { class: 'dialog' },
      h('div', { class: 'dialog-head' },
        danger ? h('span', { class: 'dialog-badge danger' }, icon('alert', 18)) : null,
        h('div', {},
          h('div', { class: 'dialog-title' }, title),
          message ? h('div', { class: 'dialog-msg' }, message) : null)),
      value !== null ? input : null,
      h('div', { class: 'dialog-actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => done(null) }, cancelText),
        h('button', { type: 'submit', class: `btn ${danger ? 'btn-danger' : 'btn-primary'}` }, okText)));
    const overlay = h('div', { class: 'overlay' }, form);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) done(null); });
    form.onsubmit = (e) => {
      e.preventDefault();
      done(value === null ? true : input.value.trim() || null);
    };
    function done(result) {
      closeModal(overlay);
      overlay.remove();
      resolve(result);
    }
    document.body.append(overlay);
    openModal(overlay, () => done(null));
    setTimeout(() => {
      if (value === null) return form.querySelector('[type=submit]').focus();
      input.focus();
      const dot = selectAll ? -1 : input.value.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
    }, 0);
  });
}

// ---------- form modal ----------

export function generatePassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  return [...bytes].map((b) => chars[b % chars.length]).join('');
}

// fields: [{ name, label, type, value, placeholder, hint, generate }]
// onSubmit(values) may throw — the message is shown in the form.
export function formModal({ title, description, fields, submitText = 'Save', onSubmit }) {
  return new Promise((resolve) => {
    const inputs = {};
    const error = h('div', { class: 'form-error hidden' });
    const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, submitText);
    const form = h('form', { class: 'dialog dialog-form' },
      h('div', { class: 'dialog-head' },
        h('div', {},
          h('div', { class: 'dialog-title' }, title),
          description ? h('div', { class: 'dialog-msg' }, description) : null),
        h('button', { type: 'button', class: 'icon-btn ghost', title: 'Close', onclick: () => done(null) }, icon('x'))),
      ...fields.map((f) => {
        const input = h('input', {
          class: 'input', name: f.name, type: f.type || 'text', value: f.value || '',
          placeholder: f.placeholder || '', autocomplete: f.autocomplete || 'off', spellcheck: false,
        });
        inputs[f.name] = input;
        let control = input;
        if (f.generate) {
          const gen = h('button', {
            type: 'button', class: 'btn btn-sm', onclick: () => {
              input.type = 'text';
              input.value = generatePassword();
              input.select();
            },
          }, 'Generate');
          control = h('div', { class: 'input-row' }, input, gen);
        }
        return h('label', { class: 'field' },
          h('span', { class: 'field-label' }, f.label),
          control,
          f.hint ? h('span', { class: 'field-hint' }, f.hint) : null);
      }),
      error,
      h('div', { class: 'dialog-actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => done(null) }, 'Cancel'),
        submit));
    const overlay = h('div', { class: 'overlay' }, form);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) done(null); });

    form.onsubmit = async (e) => {
      e.preventDefault();
      const values = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]));
      submit.disabled = true;
      error.classList.add('hidden');
      try {
        const result = await onSubmit(values);
        done(result ?? true);
      } catch (err) {
        error.textContent = err.message;
        error.classList.remove('hidden');
      } finally {
        submit.disabled = false;
      }
    };
    function done(result) {
      closeModal(overlay);
      overlay.remove();
      resolve(result);
    }
    document.body.append(overlay);
    openModal(overlay, () => done(null));
    setTimeout(() => form.querySelector('input')?.focus(), 0);
  });
}

// ---------- popup menu ----------

let openMenuEl = null;

export function closeMenu() {
  openMenuEl?.remove();
  openMenuEl = null;
}

// items: [{ label, icon, onClick, danger }] or 'sep'
export function showMenu(items, x, y) {
  closeMenu();
  const menu = h('div', { class: 'menu', role: 'menu' },
    items.map((it) => it === 'sep'
      ? h('div', { class: 'menu-sep' })
      : h('button', {
        class: `menu-item${it.danger ? ' danger' : ''}`,
        onclick: () => { closeMenu(); it.onClick(); },
      }, icon(it.icon, 16), it.label)));
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  menu.style.top = `${y + r.height > innerHeight - 8 ? Math.max(8, y - r.height) : y}px`;
  openMenuEl = menu;
}

document.addEventListener('mousedown', (e) => { if (openMenuEl && !openMenuEl.contains(e.target)) closeMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);
