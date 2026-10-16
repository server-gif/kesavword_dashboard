// Cloudflare Worker entry point — the Hono port of server.js.
//
// The UI in public/ is served from static assets (env.ASSETS); every /api/* route is handled
// here. Local-file storage moved to D1 (store.js) and the SFTP/SSH transport to the
// cloudflare:sockets bridge (sftp.js). Response shapes match the local server so the existing
// frontend (public/js/*) works unchanged.
import { Hono } from 'hono';
import { setEnv, getEnv } from './env.js';
import * as auth from './auth.js';
import * as store from './store.js';
import { withSftp, isBinary } from './sftp.js';
import { lintPhp, isPhpPath } from './lint.js';
import { buildOverview, buildApiDetail, findLogs, findErrorLog, PERIODS } from './overview.js';
import * as cw from './cloudways.js';

const DAY = 86400000;
const TRASH_DAYS = 15;
const MAX_EDIT_BYTES = 5 * 1024 * 1024;
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const MAX_UPLOAD_LINTS = 300;
const INLINE_SAFE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'avif', 'pdf', 'mp4', 'webm', 'mp3', 'wav', 'ogg', 'm4a']);
const PROTECTED = /^\/applications(\/[^/]+(\/(public_html|private_html|conf|logs|ssl|tmp|\.cw))?)?$/;

const posix = {
  join: (...p) => p.join('/').replace(/\/{2,}/g, '/'),
  dirname: (p) => { const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); },
  basename: (p, stripExt) => {
    const s = p.replace(/\/+$/, '');
    const b = s.slice(s.lastIndexOf('/') + 1);
    if (stripExt && b.endsWith(stripExt)) return b.slice(0, -stripExt.length);
    return b;
  },
  extname: (p) => { const b = posix.basename(p); const i = b.lastIndexOf('.'); return i < 0 ? '' : b.slice(i); },
};

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const app = new Hono();

// ---- config + path helpers (mirror server.js) ----

const cfg = () => getEnv();
const rootDir = () => {
  const n = ((getEnv().ROOT_DIR || '/').trim()) || '/';
  return n.length > 1 ? n.replace(/\/+$/, '') : '/';
};
const insideRoot = (p) => { const R = rootDir(); return R === '/' || p === R || p.startsWith(R + '/'); };
const trashDir = () => (getEnv().TRASH_DIR || '').trim() || posix.join(getEnv().__home || '/', '.dashboard_trash');

function cleanPath(p) {
  if (typeof p !== 'string' || !p.trim()) throw new ApiError(400, 'Path is required');
  const raw = p.trim();
  const joined = posix.join('/' + raw.replace(/^\/+/, ''));
  const out = joined.length > 1 ? joined.replace(/\/+$/, '') : '/';
  if (!insideRoot(out)) throw new ApiError(403, `You can only work inside ${rootDir()}`);
  const t = trashDir();
  if (out === t || out.startsWith(t + '/')) throw new ApiError(403, 'That folder is reserved for the recycle bin');
  return out;
}

function guardProtected(p) {
  if (p === '/' || p === rootDir() || p === (getEnv().__home || '\u0000') || PROTECTED.test(p)) {
    throw new ApiError(403, `"${p}" is a system folder — it can't be deleted, renamed or have its permissions changed here`);
  }
}

const validName = (s) => typeof s === 'string' && s.trim().length >= 1 && s.trim().length <= 60;
const validUsername = (s) => typeof s === 'string' && /^[a-z0-9._@+-]{3,64}$/.test(s);
const validPassword = (s) => typeof s === 'string' && s.length >= 8 && s.length <= 200;

const stat = (k, p) => k.stat(p).catch(() => null);

async function freePath(k, target) {
  if (!(await stat(k, target))) return target;
  const dir = posix.dirname(target);
  const ext = posix.extname(target);
  const base = posix.basename(target, ext);
  for (let n = 1; n < 100; n++) {
    const candidate = posix.join(dir, `${base} (restored${n > 1 ? ' ' + n : ''})${ext}`);
    if (!(await stat(k, candidate))) return candidate;
  }
  throw new ApiError(409, `Could not find a free name to restore ${target}`);
}

async function renameChecked(k, from, to) {
  try {
    await k.rename(from, to);
  } catch (err) {
    const [src, dst] = await Promise.all([stat(k, from), stat(k, to)]);
    if (dst && !src) return;
    throw err;
  }
}

// Open one SSH/SFTP connection for the whole handler and remember the home folder.
const withConn = (c, fn) => withSftp(c.env, async (k) => {
  const e = getEnv();
  if (!e.__home) { try { e.__home = await k.cwd(); } catch { e.__home = '/'; } }
  return fn(k);
});

// ---- middleware: origin check + auth ----

app.use('/api/*', async (c, next) => {
  setEnv(c.env);
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const origin = c.req.header('origin');
    if (origin) {
      let host = null;
      try { host = new URL(origin).host; } catch {}
      if (host !== c.req.header('host')) return c.json({ error: 'Cross-site request blocked' }, 403);
    }
  }
  await next();
});

const PUBLIC_API = new Set(['/api/session', '/api/setup', '/api/login', '/api/logout']);

app.use('/api/*', async (c, next) => {
  if (PUBLIC_API.has(new URL(c.req.url).pathname)) return next();
  setEnv(c.env);
  const u = await auth.currentUser(c);
  if (!u) return c.json({ error: 'Please sign in again' }, 401);
  c.set('user', u);
  await next();
});

const user = (c) => c.get('user');
const adminOnly = (c) => (user(c)?.role === 'admin' ? null : c.json({ error: 'Only the owner can do this' }, 403));

// ---- session (public) ----

app.get('/api/session', async (c) => {
  const users = await store.listUsers();
  const u = await auth.currentUser(c);
  return c.json({
    setupRequired: users.length === 0,
    user: u ? auth.publicUser(u) : null,
    site: { name: (c.env.SITE_NAME || 'Server Dashboard').trim() },
  });
});

app.post('/api/setup', async (c) => {
  const users = await store.listUsers();
  if (users.length) throw new ApiError(409, 'Owner account already exists');
  const body = await c.req.json();
  const name = body.name;
  const username = String(body.username || '').trim().toLowerCase();
  const password = body.password;
  if (!validName(name)) throw new ApiError(400, 'Enter your name');
  if (!validUsername(username)) throw new ApiError(400, 'Username: 3–64 characters — letters, numbers or an email address, no spaces');
  if (!validPassword(password)) throw new ApiError(400, 'Password must be at least 8 characters');
  const u = {
    id: store.newId(), name: name.trim(), username, role: 'admin', active: true,
    passwordHash: await auth.hashPassword(password), tokenVersion: 1, createdAt: Date.now(), lastLoginAt: Date.now(),
  };
  users.push(u);
  await store.saveUsers(users);
  await store.logActivity(u, 'setup', { detail: 'Owner account created' });
  await auth.setSessionCookie(c, u);
  return c.json({ user: auth.publicUser(u) });
});

app.post('/api/login', async (c) => {
  const body = await c.req.json();
  const username = String(body.username || '').replace(/\s+/g, '').toLowerCase();
  const password = String(body.password || '');
  const ip = c.req.header('cf-connecting-ip') || 'local';
  const key = `${ip}|${username}`;
  const locked = auth.loginLockedFor(key);
  if (locked) throw new ApiError(429, `Too many wrong attempts. Try again in ${Math.ceil(locked / 60000)} min.`);

  const users = await store.listUsers();
  const u = users.find((x) => x.username === username);
  if (!u || !await auth.verifyPassword(password, u.passwordHash)) {
    auth.recordLoginFail(key);
    await store.logActivity({ username: username || '?', name: username || '?' }, 'login_failed', { detail: `from ${ip}` });
    throw new ApiError(401, 'Wrong username or password');
  }
  if (!u.active) throw new ApiError(403, 'This account has been disabled. Ask the owner to enable it.');

  auth.clearLoginFails(key);
  u.lastLoginAt = Date.now();
  await store.saveUsers(users);
  await store.logActivity(u, 'login', { detail: `from ${ip}` });
  await auth.setSessionCookie(c, u);
  return c.json({ user: auth.publicUser(u) });
});

app.post('/api/logout', async (c) => {
  const u = await auth.currentUser(c);
  if (u) await store.logActivity(u, 'logout');
  auth.clearSessionCookie(c);
  return c.json({ ok: true });
});

// ---- account ----

app.post('/api/account/password', async (c) => {
  const { current, next } = await c.req.json();
  const me = user(c);
  if (!await auth.verifyPassword(String(current || ''), me.passwordHash)) throw new ApiError(400, 'Current password is wrong');
  if (!validPassword(next)) throw new ApiError(400, 'New password must be at least 8 characters');
  const users = await store.listUsers();
  const target = users.find((x) => x.id === me.id);
  target.passwordHash = await auth.hashPassword(next);
  target.tokenVersion += 1;
  await store.saveUsers(users);
  await store.logActivity(me, 'password_change', { detail: 'Changed own password' });
  await auth.setSessionCookie(c, target);
  return c.json({ ok: true });
});

app.get('/api/info', (c) => withConn(c, async () => {
  const items = await store.getSetting('trash', []);
  return c.json({ name: (c.env.SITE_NAME || 'Server Dashboard').trim(), url: (c.env.SITE_URL || '').trim(), home: rootDir(), trashDays: TRASH_DAYS, trashCount: items.length });
}));

// ---- files ----

app.get('/api/list', (c) => withConn(c, async (k) => {
  const dir = cleanPath(c.req.query('path') || rootDir());
  const hidden = posix.basename(trashDir());
  const hideTrash = posix.dirname(trashDir()) === dir;
  const items = (await k.list(dir)).filter((i) => i.name !== '.' && i.name !== '..' && !(hideTrash && i.name === hidden));
  const linkIsDir = {};
  for (const i of items.filter((x) => x.type === 'l')) {
    linkIsDir[i.name] = !!(await stat(k, posix.join(dir, i.name)))?.isDirectory;
  }
  return c.json({
    path: dir,
    items: items.map((i) => ({
      name: i.name,
      type: i.type === 'd' || linkIsDir[i.name] ? 'dir' : 'file',
      link: i.type === 'l',
      size: i.size,
      modified: i.modifyTime,
      rights: [i.rights.user, i.rights.group, i.rights.other].join(''),
    })),
  });
}));

app.get('/api/read', (c) => withConn(c, async (k) => {
  const file = cleanPath(c.req.query('path'));
  let st = await stat(k, file);
  if (!st) {
    // stat() follows symlinks — if it fails the path may be a broken/outside-chroot link.
    const ls = await k.lstat(file).catch(() => null);
    if (!ls) throw new ApiError(404, 'File not found');
    // Try reading directly (open+read works even when stat can't resolve the link target).
    let buf;
    try { buf = await k.readFile(file); } catch { throw new ApiError(404, 'This symlink\'s target cannot be accessed from the dashboard'); }
    if (isBinary(buf)) throw new ApiError(415, 'Binary file — cannot edit as text');
    return c.json({ path: file, content: buf.toString('utf8'), mtime: ls.modifyTime, size: buf.length });
  }
  if (st.isDirectory) throw new ApiError(400, 'That is a folder');
  if (st.size > MAX_EDIT_BYTES) throw new ApiError(413, 'File is larger than 5 MB — download it instead');
  const buf = await k.get(file);
  if (isBinary(buf)) throw new ApiError(415, 'Binary file — cannot edit as text');
  return c.json({ path: file, content: buf.toString('utf8'), mtime: st.modifyTime, size: st.size });
}));

// lint result cache (per Worker isolate): the editor checks while typing, so Save usually hits it
const lintCache = new Map();
const LINT_CACHE_MAX = 200;
async function safeLint(k, content) {
  const key = await sha1(content);
  const hit = lintCache.get(key);
  if (hit) return hit;
  try {
    const result = await lintPhp(k, content, rootDir(), cfg());
    if (result.available) {
      lintCache.set(key, result);
      if (lintCache.size > LINT_CACHE_MAX) lintCache.delete(lintCache.keys().next().value);
    }
    return result;
  } catch (err) {
    return { available: false, checker: null, errors: [], warnings: [], error: err.message };
  }
}

async function sha1(text) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const describeLint = (errors) => errors.slice(0, 3).map((e) => `line ${e.line}: ${e.message}`).join('; ');

app.post('/api/check', (c) => withConn(c, async (k) => {
  const body = await c.req.json();
  const file = cleanPath(body.path);
  if (typeof body.content !== 'string') throw new ApiError(400, 'Content is required');
  if (!isPhpPath(file)) return c.json({ available: false, checker: null, errors: [], warnings: [] });
  return c.json(await safeLint(k, body.content));
}));

app.post('/api/save', (c) => withConn(c, async (k) => {
  const body = await c.req.json();
  const file = cleanPath(body.path);
  const { content, expectedMtime, force, expectedSize } = body;
  if (typeof content !== 'string') throw new ApiError(400, 'Content is required');

  const [lint, st] = await Promise.all([isPhpPath(file) ? safeLint(k, content) : null, stat(k, file)]);

  const ownerOverride = body.allowErrors === true && user(c).role === 'admin';
  if (lint?.errors.length && !ownerOverride) {
    return c.json({ lint: true, ...lint, error: `Not saved — PHP error on ${describeLint(lint.errors)}` }, 422);
  }
  if (st?.isDirectory) throw new ApiError(400, 'That is a folder');
  if (st && expectedMtime && !force && (st.modifyTime !== expectedMtime || (typeof expectedSize === 'number' && st.size !== expectedSize))) {
    return c.json({ conflict: true, error: 'Someone changed this file on the server after you opened it.' }, 409);
  }

  let before = { exists: false, text: null };
  if (st) {
    const buf = st.size <= MAX_DIFF_BYTES ? await k.get(file).catch(() => null) : null;
    if (buf && !isBinary(buf)) before = { exists: true, text: buf.toString('utf8') };
    else if (buf) before = { exists: true, text: null };
  }

  const mtime = await k.writeFast(file, Buffer.from(content, 'utf8')) || (await stat(k, file))?.modifyTime || null;

  const lintNote = lint?.errors.length ? `⚠ Saved with PHP error — ${describeLint(lint.errors)}` : null;
  if (!before.exists) {
    await store.logActivity(user(c), 'create_file', { path: file, detail: lintNote });
  } else if (before.text !== content) {
    const diff = before.text !== null && content.length <= MAX_DIFF_BYTES ? { path: file, before: before.text, after: content } : null;
    const detail = [lintNote, diff ? null : 'File too large to keep a copy of the change'].filter(Boolean).join(' · ') || null;
    await store.logActivity(user(c), 'edit', { path: file, detail }, diff);
  }
  return c.json({ ok: true, mtime, size: Buffer.byteLength(content, 'utf8'), lint });
}));

app.get('/api/download', (c) => withConn(c, async (k) => {
  const file = cleanPath(c.req.query('path'));
  const st = await k.stat(file);
  if (st.isDirectory) throw new ApiError(400, 'Folders cannot be downloaded directly');
  const name = posix.basename(file);
  const buf = await k.get(file);
  const headers = { 'X-Content-Type-Options': 'nosniff', 'Content-Length': String(buf.length) };
  const ext = posix.extname(name).slice(1).toLowerCase();
  if (c.req.query('inline') && INLINE_SAFE.has(ext)) {
    headers['Content-Disposition'] = `inline; filename*=UTF-8''${encodeURIComponent(name)}`;
    headers['Content-Type'] = mimeFor(name);
    if (ext !== 'pdf') headers['Content-Security-Policy'] = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox";
  } else {
    headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
    headers['Content-Type'] = 'application/octet-stream';
    await store.logActivity(user(c), 'download', { path: file, size: st.size });
  }
  return new Response(new Uint8Array(buf), { headers });
}));

function mimeFor(name) {
  const e = posix.extname(name).slice(1).toLowerCase();
  return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', bmp: 'image/bmp', avif: 'image/avif', pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4' }[e] || 'application/octet-stream';
}

app.post('/api/upload', async (c) => {
  const form = await c.req.formData();
  const dir = cleanPath(form.get('dir'));
  const relPaths = JSON.parse(String(form.get('relPaths') || '[]'));
  const files = form.getAll('files');
  return withConn(c, async (k) => {
    const madeDirs = new Set();
    const lintProblems = [];
    const rejected = [];
    const isOwner = user(c).role === 'admin';
    let lintsLeft = MAX_UPLOAD_LINTS;
    let written = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (!f || typeof f.arrayBuffer !== 'function') continue;
      const rel = relPaths[i] || f.name;
      const target = cleanPath(posix.join(dir, rel));
      if (!target.startsWith(dir === '/' ? '/' : dir + '/')) throw new ApiError(400, `Bad file name: ${rel}`);
      const buf = Buffer.from(await f.arrayBuffer());

      let lint = null;
      if (isPhpPath(target) && buf.length <= MAX_DIFF_BYTES && lintsLeft > 0) {
        lintsLeft--;
        lint = await safeLint(k, buf.toString('utf8'));
      }
      if (lint?.errors.length && !isOwner) {
        rejected.push({ path: target, ...lint.errors[0] });
        continue;
      }
      const parent = posix.dirname(target);
      if (parent !== dir && !madeDirs.has(parent)) {
        await k.mkdir(parent, true);
        madeDirs.add(parent);
      }
      const before = buf.length <= MAX_DIFF_BYTES ? await readBefore(k, target) : { exists: false, text: null };
      await k.put(buf, target);

      let diff = null;
      if (before.text !== null && buf.length <= MAX_DIFF_BYTES && !isBinary(buf)) {
        diff = { path: target, before: before.text, after: buf.toString('utf8') };
      }
      written++;
      let lintNote = null;
      if (lint?.errors.length) {
        lintNote = `⚠ PHP error — ${describeLint(lint.errors)}`;
        lintProblems.push({ path: target, ...lint.errors[0] });
      }
      await store.logActivity(user(c), 'upload', {
        path: target, size: buf.length,
        detail: [before.exists ? 'Replaced existing file' : null, lintNote].filter(Boolean).join(' · ') || null,
      }, diff);
    }
    return c.json({ ok: true, count: written, lintProblems, rejected });
  });
});

async function readBefore(k, path) {
  const st = await stat(k, path);
  if (!st) return { exists: false, text: null };
  if (st.isDirectory || st.size > MAX_DIFF_BYTES) return { exists: true, text: null };
  const buf = await k.get(path).catch(() => null);
  return { exists: true, text: buf && !isBinary(buf) ? buf.toString('utf8') : null };
}

app.post('/api/mkdir', (c) => withConn(c, async (k) => {
  const dir = cleanPath((await c.req.json()).path);
  if (await stat(k, dir)) throw new ApiError(409, 'Something with that name already exists');
  await k.mkdir(dir, true);
  await store.logActivity(user(c), 'create_folder', { path: dir });
  return c.json({ ok: true });
}));

app.post('/api/newfile', (c) => withConn(c, async (k) => {
  const file = cleanPath((await c.req.json()).path);
  if (await stat(k, file)) throw new ApiError(409, 'A file with that name already exists');
  await k.put(Buffer.alloc(0), file);
  await store.logActivity(user(c), 'create_file', { path: file });
  return c.json({ ok: true });
}));

app.post('/api/rename', (c) => withConn(c, async (k) => {
  const body = await c.req.json();
  const from = cleanPath(body.from);
  const to = cleanPath(body.to);
  guardProtected(from);
  if (await stat(k, to)) throw new ApiError(409, 'Something with that name already exists');
  await renameChecked(k, from, to);
  await store.logActivity(user(c), 'rename', { path: from, to });
  return c.json({ ok: true });
}));

app.post('/api/chmod', (c) => withConn(c, async (k) => {
  const body = await c.req.json();
  const target = cleanPath(body.path);
  const mode = String(body.mode);
  if (!/^[0-7]{3,4}$/.test(mode)) throw new ApiError(400, 'Mode must look like 644 or 755');
  guardProtected(target);
  await k.chmod(target, parseInt(mode, 8));
  await store.logActivity(user(c), 'chmod', { path: target, detail: mode });
  return c.json({ ok: true });
}));

// ---- duplicate ----

async function copyFile(k, src, dst, mode) {
  const buf = await k.get(src);
  await k.put(buf, dst);
  await k.chmod(dst, mode & 0o7777).catch(() => {});
}

async function copyDir(k, src, dst, mode, counter) {
  await k.mkdir(dst);
  await k.chmod(dst, mode & 0o7777).catch(() => {});
  for (const item of await k.list(src)) {
    if (item.name === '.' || item.name === '..') continue;
    const from = posix.join(src, item.name);
    const to = posix.join(dst, item.name);
    const st = await k.lstat(from);
    if (item.type === 'd') await copyDir(k, from, to, st.mode, counter);
    else if (item.type === '-') { await copyFile(k, from, to, st.mode); counter.files++; }
    else counter.skipped++;
  }
}

app.post('/api/duplicate', (c) => withConn(c, async (k) => {
  const body = await c.req.json();
  const from = cleanPath(body.from);
  const to = cleanPath(body.to);
  if (to === from || to.startsWith(from + '/')) throw new ApiError(400, 'Choose a different name for the copy');
  const st = await stat(k, from);
  if (!st) throw new ApiError(404, 'The original no longer exists');
  if (await stat(k, to)) throw new ApiError(409, 'Something with that name already exists');
  const counter = { files: 0, skipped: 0 };
  if (st.isDirectory) await copyDir(k, from, to, st.mode, counter);
  else { await copyFile(k, from, to, st.mode); counter.files = 1; }
  await store.logActivity(user(c), 'duplicate', {
    path: from, to,
    detail: st.isDirectory ? `${counter.files} file${counter.files === 1 ? '' : 's'} copied${counter.skipped ? `, ${counter.skipped} link(s) skipped` : ''}` : null,
  });
  return c.json({ ok: true, files: counter.files });
}));

// ---- delete (move to recycle bin) ----

app.post('/api/delete', (c) => withConn(c, async (k) => {
  const body = await c.req.json();
  const paths = (Array.isArray(body.paths) ? body.paths : [body.path]).map(cleanPath);
  paths.forEach(guardProtected);
  const t = trashDir();
  await k.mkdir(t, true);
  const trash = await store.getSetting('trash', []);
  for (const p of paths) {
    const st = await stat(k, p);
    if (!st) continue;
    const id = store.newId();
    const name = posix.basename(p);
    await k.mkdir(posix.join(t, id));
    await renameChecked(k, p, posix.join(t, id, name));
    const now = Date.now();
    trash.push({
      id, path: p, name, type: st.isDirectory ? 'dir' : 'file', size: st.isDirectory ? null : st.size,
      deletedBy: user(c).username, deletedByName: user(c).name, deletedAt: now, expiresAt: now + TRASH_DAYS * DAY,
    });
    await store.setSetting('trash', trash);
    await store.logActivity(user(c), 'delete', { path: p, detail: 'Moved to recycle bin' });
  }
  return c.json({ ok: true });
}));

// ---- recycle bin ----

app.get('/api/trash', async (c) => {
  const trash = await store.getSetting('trash', []);
  return c.json({ days: TRASH_DAYS, items: [...trash].sort((a, b) => b.deletedAt - a.deletedAt) });
});

app.post('/api/trash/restore', (c) => withConn(c, async (k) => {
  const body = await c.req.json();
  const ids = Array.isArray(body.ids) ? body.ids : [];
  const trash = await store.getSetting('trash', []);
  const t = trashDir();
  const restored = [];
  for (const id of ids) {
    const item = trash.find((x) => x.id === id);
    if (!item) continue;
    await k.mkdir(posix.dirname(item.path), true);
    const target = await freePath(k, item.path);
    await renameChecked(k, posix.join(t, id, item.name), target);
    await k.rmdir(posix.join(t, id), true).catch(() => {});
    trash.splice(trash.indexOf(item), 1);
    await store.setSetting('trash', trash);
    await store.logActivity(user(c), 'restore', { path: target, detail: target !== item.path ? `Original name was taken, restored as ${posix.basename(target)}` : null });
    restored.push(target);
  }
  return c.json({ ok: true, restored });
}));

async function purgeTrashItem(k, item, u, reason, trash) {
  const dir = posix.join(trashDir(), item.id);
  if (await stat(k, dir)) await k.rmdir(dir, true);
  const idx = trash.indexOf(item);
  if (idx >= 0) trash.splice(idx, 1);
  await store.setSetting('trash', trash);
  await store.logActivity(u, 'purge', { path: item.path, detail: reason });
}

app.post('/api/trash/purge', async (c) => {
  const d = adminOnly(c); if (d) return d;
  const body = await c.req.json();
  return withConn(c, async (k) => {
    const trash = await store.getSetting('trash', []);
    const items = body.all ? [...trash] : trash.filter((x) => (body.ids || []).includes(x.id));
    for (const item of items) await purgeTrashItem(k, item, user(c), 'Deleted forever from recycle bin', trash);
    return c.json({ ok: true, count: items.length });
  });
});

async function purgeExpired() {
  const env = getEnv();
  const trash = await store.getSetting('trash', []);
  const expired = trash.filter((x) => x.expiresAt <= Date.now());
  if (!expired.length) return;
  await withSftp(env, async (k) => {
    for (const item of expired) {
      await purgeTrashItem(k, item, null, `Auto-deleted after ${TRASH_DAYS} days`, trash)
        .catch((err) => console.error('Auto-purge failed for', item.path, err.message));
    }
  }).catch(() => {});
}

// ---- activity log (owner only) ----

app.get('/api/activity', async (c) => {
  const d = adminOnly(c); if (d) return d;
  const offset = Math.max(0, parseInt(c.req.query('offset'), 10) || 0);
  const limit = Math.min(200, Math.max(1, parseInt(c.req.query('limit'), 10) || 50));
  return c.json(await store.queryActivity({
    offset, limit,
    q: String(c.req.query('q') || '').toLowerCase(),
    user: c.req.query('user') || '',
    action: c.req.query('action') || '',
  }));
});

app.get('/api/activity/:id/diff', async (c) => {
  const d = adminOnly(c); if (d) return d;
  const diff = await store.readDiff(c.req.param('id'));
  if (!diff) throw new ApiError(404, 'No saved change for this entry');
  const entry = await store.findActivity(c.req.param('id'));
  return c.json({ ...diff, entry });
});

app.post('/api/activity/:id/revert', (c) => {
  const d = adminOnly(c); if (d) return d;
  return withConn(c, async (k) => {
    const diff = await store.readDiff(c.req.param('id'));
    if (!diff || typeof diff.before !== 'string') throw new ApiError(404, 'No earlier version saved for this entry');
    const file = cleanPath(diff.path);
    const current = await readBefore(k, file);
    await k.put(Buffer.from(diff.before, 'utf8'), file);
    await store.logActivity(user(c), 'revert', { path: file, detail: 'Restored the version from before an earlier change' },
      current.text !== null ? { path: file, before: current.text, after: diff.before } : null);
    return c.json({ ok: true });
  });
});

// ---- team (owner only) ----

app.get('/api/users', async (c) => {
  const d = adminOnly(c); if (d) return d;
  return c.json({ users: (await store.listUsers()).map(auth.publicUser) });
});

app.post('/api/users', async (c) => {
  const d = adminOnly(c); if (d) return d;
  const body = await c.req.json();
  const username = String(body.username || '').trim().toLowerCase();
  if (!validName(body.name)) throw new ApiError(400, 'Enter a name');
  if (!validUsername(username)) throw new ApiError(400, 'Username: 3–64 characters — letters, numbers or an email address, no spaces');
  const users = await store.listUsers();
  if (users.some((u) => u.username === username)) throw new ApiError(409, 'That username is already taken');
  if (!validPassword(body.password)) throw new ApiError(400, 'Password must be at least 8 characters');
  const u = {
    id: store.newId(), name: body.name.trim(), username, role: 'member', active: true,
    passwordHash: await auth.hashPassword(body.password), tokenVersion: 1, createdAt: Date.now(),
  };
  users.push(u);
  await store.saveUsers(users);
  await store.logActivity(user(c), 'user_add', { detail: `Added ${u.name} (@${u.username})` });
  return c.json({ user: auth.publicUser(u) });
});

app.post('/api/users/:id', async (c) => {
  const d = adminOnly(c); if (d) return d;
  const body = await c.req.json();
  const users = await store.listUsers();
  const u = users.find((x) => x.id === c.req.param('id'));
  if (!u) throw new ApiError(404, 'User not found');
  if (u.role === 'admin') throw new ApiError(400, 'Use "Change password" to update the owner account');
  const changes = [];
  if (body.name !== undefined) {
    if (!validName(body.name)) throw new ApiError(400, 'Enter a name');
    u.name = body.name.trim(); changes.push('name');
  }
  if (body.password !== undefined) {
    if (!validPassword(body.password)) throw new ApiError(400, 'Password must be at least 8 characters');
    u.passwordHash = await auth.hashPassword(body.password); u.tokenVersion += 1; changes.push('password reset');
  }
  if (body.active !== undefined) {
    u.active = !!body.active; if (!u.active) u.tokenVersion += 1; changes.push(u.active ? 'enabled' : 'disabled');
  }
  await store.saveUsers(users);
  await store.logActivity(user(c), 'user_update', { detail: `${u.name} (@${u.username}): ${changes.join(', ')}` });
  return c.json({ user: auth.publicUser(u) });
});

app.post('/api/users/:id/delete', async (c) => {
  const d = adminOnly(c); if (d) return d;
  const users = await store.listUsers();
  const idx = users.findIndex((x) => x.id === c.req.param('id'));
  if (idx < 0) throw new ApiError(404, 'User not found');
  if (users[idx].role === 'admin') throw new ApiError(400, 'The owner account cannot be removed');
  const [removed] = users.splice(idx, 1);
  await store.saveUsers(users);
  await store.logActivity(user(c), 'user_remove', { detail: `Removed ${removed.name} (@${removed.username})` });
  return c.json({ ok: true });
});

// ---- overview (owner only) ----

const summaryCache = new Map();
const summaryInFlight = new Map();

function cachedSummary(key, build) {
  if (!summaryInFlight.has(key)) {
    summaryInFlight.set(key, (async () => {
      const data = await build();
      const rec = { at: Date.now(), data };
      summaryCache.set(key, rec);
      if (summaryCache.size > 60) summaryCache.delete(summaryCache.keys().next().value);
      store.writeCache(key, rec).catch(() => {}); // persist so other isolates/colos skip the build
      return data;
    })().finally(() => summaryInFlight.delete(key)));
  }
  return summaryInFlight.get(key);
}

async function serveSummary(c, key, period, build) {
  const fresh = c.req.query('fresh') === '1';
  const maxAge = period === 'today' ? (fresh ? 10000 : 60000) : period === 'yesterday' ? 30 * 60000 : (fresh ? 30000 : 10 * 60000);
  const now = Date.now();
  const mem = summaryCache.get(key);
  if (mem && now - mem.at < maxAge) return mem.data;                 // L1 hit — no D1, no SSH
  const disk = await store.readCache(key).catch(() => null);
  if (disk && now - disk.at < maxAge) { summaryCache.set(key, disk); return disk.data; } // L2 hit
  const stale = mem && (!disk || mem.at >= disk.at) ? mem : disk;
  // A multi-day rescan is CPU-heavy (many gzipped logs over a pure-JS SSH handshake). Forcing it to
  // block the response hangs the request and can starve the isolate. For the fixed expensive presets
  // we serve what we have and rebuild in the background. A custom range is NOT treated as expensive,
  // because an explicit refresh (fresh=1) of a custom range must rebuild synchronously — otherwise a
  // previously-cached result for that exact from/to would keep being served stale and the user would
  // never see their chosen range take effect. Auto-refresh (no fresh) already avoids blocking via !fresh.
  const expensive = period === '7d' || period === '30d';
  if (stale && (!fresh || expensive)) {
    const pending = cachedSummary(key, build).catch(() => {});
    try { c.executionCtx?.waitUntil(pending); } catch {} // keep the rebuild alive after we respond
    return stale.data;
  }
  return cachedSummary(key, build);
}

const pickPeriod = (p) => (PERIODS.includes(p) ? p : 'today');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// period=custom is honoured only when both from and to are real dates; otherwise fall back to a preset.
function resolvePeriod(raw, fromStr, toStr) {
  if (raw === 'custom' && DATE_RE.test(fromStr || '') && DATE_RE.test(toStr || '')) {
    return { period: 'custom', custom: { from: fromStr, to: toStr } };
  }
  return { period: pickPeriod(raw), custom: null };
}
const periodKey = ({ period, custom }) => (period === 'custom' ? `custom|${custom.from}|${custom.to}` : period);

function buildOverviewCtx(c, k, home, period, custom) {
  return async () => {
    const logs = await findLogs(k, rootDir(), cfg());
    if (!logs?.access) {
      return { unavailable: true, reason: logs ? 'No PHP access log was found next to the website folder.' : 'The server log folder could not be read just now. Try Refresh in a moment.' };
    }
    return buildOverview({
      c: k, home, accessLog: logs.access, webLog: logs.web, errorLog: await findErrorLog(k, rootDir(), cfg()),
      rootDir: rootDir(), toRootPath: (f) => toRootPath(f), timezone: (cfg().TIMEZONE || 'Asia/Kolkata').trim(), period, custom,
      retentionDays: Number(cfg().LOG_RETENTION_DAYS) || undefined,
    });
  };
}

function toRootPath(serverFile) {
  const R = rootDir();
  const marker = `/${posix.basename(R)}/`;
  const i = serverFile.indexOf(marker);
  return R !== '/' && i >= 0 ? R + serverFile.slice(i + marker.length - 1) : null;
}

app.get('/api/overview', async (c) => {
  const d = adminOnly(c); if (d) return d;
  const { period, custom } = resolvePeriod(c.req.query('period'), c.req.query('from'), c.req.query('to'));
  const key = `overview|${periodKey({ period, custom })}`;
  // The SSH connection is opened only inside `build`, i.e. only on a cache miss.
  const data = await serveSummary(c, key, period,
    () => withConn(c, (k) => buildOverviewCtx(c, k, getEnv().__home || '/', period, custom)()));
  const ignored = await store.getSetting('ignored', {});
  return c.json({ ...data, ignored: Object.values(ignored) });
});

app.get('/api/overview/api', async (c) => {
  const d = adminOnly(c); if (d) return d;
  const { period, custom } = resolvePeriod(c.req.query('period'), c.req.query('from'), c.req.query('to'));
  const script = String(c.req.query('script') || '');
  if (!script.startsWith('/')) throw new ApiError(400, 'Which API?');
  const ignored = await store.getSetting('ignored', {});
  const data = await serveSummary(c, `api|${periodKey({ period, custom })}|${script}`, period, () => withConn(c, async (k) => {
    const logs = await findLogs(k, rootDir(), cfg());
    return buildApiDetail({
      c: k, home: getEnv().__home || '/', accessLog: logs?.access, webLog: logs?.web, errorLog: await findErrorLog(k, rootDir(), cfg()),
      rootDir: rootDir(), toRootPath: (f) => toRootPath(f), timezone: (cfg().TIMEZONE || 'Asia/Kolkata').trim(), period, script, custom,
      retentionDays: Number(cfg().LOG_RETENTION_DAYS) || undefined,
    });
  }));
  return c.json({ ...data, ignored: ignored[script] || null, url: c.env.SITE_URL ? c.env.SITE_URL + script : null });
});

app.post('/api/overview/ignore', async (c) => {
  const d = adminOnly(c); if (d) return d;
  const body = await c.req.json();
  const script = String(body.script || '');
  if (!script.startsWith('/') || script.length > 500) throw new ApiError(400, 'Which API?');
  const ignored = await store.getSetting('ignored', {});
  if (body.ignore) {
    ignored[script] = { script, by: user(c).username, byName: user(c).name, at: Date.now(), note: String(body.note || '').slice(0, 200) };
  } else {
    delete ignored[script];
  }
  await store.setSetting('ignored', ignored);
  await store.logActivity(user(c), body.ignore ? 'ignore_api' : 'unignore_api', { detail: script });
  return c.json({ ok: true, ignored: Object.values(ignored) });
});

// ---- API tester ----

const TEST_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const TEST_MAX_BODY = 2 * 1024 * 1024;

app.post('/api/test-log', (c) => withConn(c, async (k) => {
  const body = await c.req.json();
  const file = await findErrorLog(k, rootDir(), cfg());
  const since = Number(body.since);
  if (!file || !Number.isFinite(since)) return c.json({ available: false, errors: [] });
  await new Promise((r) => setTimeout(r, 250));
  const st = await stat(k, file);
  if (!st) return c.json({ available: false, errors: [] });
  const start = st.size < since ? 0 : since;
  const end = Math.min(st.size, start + 256 * 1024) - 1;
  const text = end >= start ? (await k.readRange(file, start, end)).toString('utf8') : '';
  return c.json({ available: true, errors: parsePhpLog(text) });
}));

function parsePhpLog(text) {
  const re = /PHP (Fatal error|Parse error|Warning|Notice|Deprecated):\s+(.+?) in (\/\S+?\.php)(?: on line |:)(\d+)/g;
  const seen = new Set();
  const out = [];
  let m;
  while ((m = re.exec(text)) && out.length < 20) {
    const key = `${m[3]}|${m[4]}|${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: m[1], message: m[2].trim(), serverFile: m[3], line: Number(m[4]), path: toRootPath(m[3]) });
  }
  return out;
}

app.post('/api/test-request', async (c) => {
  const SITE_URL = (c.env.SITE_URL || '').trim();
  if (!SITE_URL) throw new ApiError(400, 'Set SITE_URL to test APIs');
  const body = await c.req.json();
  const method = String(body.method || 'GET').toUpperCase();
  if (!TEST_METHODS.has(method)) throw new ApiError(400, 'Unsupported method');
  let target;
  try { target = new URL(String(body.url || '')); } catch { throw new ApiError(400, 'Enter a full URL starting with http:// or https://'); }
  const site = new URL(SITE_URL);
  const onSite = (u) => /^https?:$/.test(u.protocol) && u.hostname === site.hostname && (u.port === '' || u.port === site.port);
  if (!onSite(target)) throw new ApiError(400, `Only ${site.hostname} URLs can be tested here`);

  const headers = new Headers();
  for (const { key, value } of Array.isArray(body.headers) ? body.headers : []) {
    if (!key) continue;
    try { headers.set(String(key).trim(), String(value ?? '')); } catch { throw new ApiError(400, `Invalid header: ${key}`); }
  }
  let reqBody;
  if (method !== 'GET') {
    if (body.bodyType === 'json') {
      reqBody = String(body.json ?? '');
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    } else if (body.bodyType === 'form') {
      reqBody = new URLSearchParams((body.form || []).filter((f) => f.key).map((f) => [String(f.key), String(f.value ?? '')]));
    }
  }

  const started = performance.now();
  const signal = AbortSignal.timeout(30000);
  let r;
  let url = target;
  let reqMethod = method;
  let curBody = reqBody;
  let redirected = false;
  let blockedRedirect = null;
  try {
    for (let hop = 0; hop <= 5; hop++) {
      r = await fetch(url, { method: reqMethod, headers, body: curBody, redirect: 'manual', signal });
      const location = r.status >= 300 && r.status < 400 ? r.headers.get('location') : null;
      if (!location || hop === 5) break;
      const next = new URL(location, url);
      if (!onSite(next)) { blockedRedirect = next.href; break; }
      if (r.status === 303 || ((r.status === 301 || r.status === 302) && reqMethod === 'POST')) { reqMethod = 'GET'; curBody = undefined; }
      await r.arrayBuffer().catch(() => {});
      url = next;
      redirected = true;
    }
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? 'no answer within 30 seconds' : (err.cause?.code || err.cause?.message || err.message);
    throw new ApiError(502, `Could not reach ${target.host}: ${reason}`);
  }
  const buf = Buffer.from(await r.arrayBuffer());
  const timeMs = Math.round(performance.now() - started);
  const binary = isBinary(buf);
  return c.json({
    status: r.status, statusText: r.statusText, url: url.href, redirected, blockedRedirect,
    timeMs, size: buf.length, headers: [...r.headers], binary,
    truncated: buf.length > TEST_MAX_BODY,
    body: binary ? '' : buf.subarray(0, TEST_MAX_BODY).toString('utf8'),
    logMark: null,
  });
});

// ---- server monitoring (Cloudways, owner only, read-only inventory) ----

// Reuses the existing D1 cache conventions (store.readCache/writeCache) for a durable last-good
// snapshot; the in-isolate Map is only the fast TTL layer. Concurrent (even ?fresh=1) requests share
// a single upstream call via the controller's in-flight de-dupe.
const serversCache = cw.createServersCache({
  readCache: (k) => store.readCache(k),
  writeCache: (k, rec) => store.writeCache(k, rec),
});

// Single-account, rotation-stable cache key (the API credentials never appear in it).
const serversCacheKey = 'sm:servers|cloudways';
const noCredsResponse = () => ({
  servers: [], refreshedAt: null, source: 'error', stale: false, partial: false, unavailable: true,
  error: 'Cloudways is not connected yet. The owner needs to set the CLOUDWAYS_EMAIL and CLOUDWAYS_API_KEY secrets.',
});
const cwErrorMessage = (err) => (err instanceof cw.CwError ? err.message : 'Could not reach Cloudways just now.');

app.get('/api/server-monitoring/status', async (c) => {
  const d = adminOnly(c); if (d) return d;
  return c.json({ ...cw.statusBlock(cfg()), site: (c.env.SITE_NAME || 'Server Dashboard').trim() });
});

app.get('/api/server-monitoring/servers', async (c) => {
  const d = adminOnly(c); if (d) return d;
  const env = cfg();
  if (!cw.hasCreds(env)) return c.json(noCredsResponse());
  return c.json(await serversCache.load(serversCacheKey, env, { fresh: c.req.query('fresh') === '1' }));
});

app.get('/api/server-monitoring/servers/:id', async (c) => {
  const d = adminOnly(c); if (d) return d;
  const env = cfg();
  if (!cw.hasCreds(env)) return c.json({ error: noCredsResponse().error, unavailable: true }, 503);
  let id;
  try { id = cw.parseId(c.req.param('id')); } catch (err) { return c.json({ error: err.message }, err.status || 400); }
  try {
    const { server, fetchedAt } = await cw.getServer(env, id);
    return c.json({ server, refreshedAt: fetchedAt, source: 'live', stale: false });
  } catch (err) {
    // Serve a labelled cached inventory record when one exists; never pass it off as current.
    const snap = await store.readCache(serversCacheKey).catch(() => null);
    const rec = snap?.data?.servers?.find((s) => s.id === id);
    if (rec) return c.json({ server: rec, refreshedAt: snap.at, source: 'stale', stale: true, error: cwErrorMessage(err) });
    return c.json({ error: cwErrorMessage(err) }, err.status || 502);
  }
});

app.get('/api/server-monitoring/settings', async (c) => {
  const d = adminOnly(c); if (d) return d;
  return c.json(await store.getSetting('monitoring', cw.DEFAULT_SETTINGS));
});

app.put('/api/server-monitoring/settings', async (c) => {
  const d = adminOnly(c); if (d) return d;
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid request body' }, 400); }
  let next;
  try { next = cw.validateSettings(body); } catch (err) { return c.json({ error: err.message }, err.status || 400); }
  const prev = await store.getSetting('monitoring', cw.DEFAULT_SETTINGS);
  await store.setSetting('monitoring', next);
  await store.logActivity(user(c), 'monitoring_settings', { detail: cw.describeSettingsChange(prev, next) });
  return c.json(next);
});

// ---- errors ----

app.onError((err, c) => {
  const status = err.status || (/no such file|not found|enoent/i.test(err.message || '') ? 404 : 500);
  if (status >= 500) console.error(err);
  const message = err.status ? err.message : (err.message || 'Error').replace(/^[\w.]+: /, '');
  return c.json({ error: message }, status);
});

// ---- static assets (the existing UI) ----

app.all('*', (c) => {
  if (new URL(c.req.url).pathname.startsWith('/api/')) return c.json({ error: 'Not found' }, 404);
  return c.env.ASSETS.fetch(c.req.raw);
});

// ---- scheduled: auto-purge + warm the owner overview (same jobs the local timer ran) ----

export default {
  async fetch(request, env, ctx) {
    setEnv(env);
    ctx.waitUntil(purgeExpired().catch(() => {}));
    return app.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    setEnv(env);
    ctx.waitUntil((async () => {
      await purgeExpired().catch(() => {});
      await store.purgeCache(Date.now() - 12 * 3600000).catch(() => {}); // drop stale L2 rows
      // Rebuild today's summary and persist it to D1 (via cachedSummary) so the owner's home
      // page opens instantly even on a brand-new/cold isolate that has no in-memory cache yet.
      try {
        await cachedSummary('overview|today', () => withSftp(env, async (k) => {
          const home = (await k.cwd().catch(() => '/'));
          env.__home = home;
          const logs = await findLogs(k, rootDir(), env);
          if (!logs?.access) return { unavailable: true, reason: 'The server log folder could not be read. Try Refresh in a moment.' };
          return buildOverview({
            c: k, home, accessLog: logs.access, webLog: logs.web, errorLog: await findErrorLog(k, rootDir(), env),
            rootDir: rootDir(), toRootPath: (f) => toRootPath(f), timezone: (env.TIMEZONE || 'Asia/Kolkata').trim(), period: 'today',
          });
        }));
      } catch {}
    })());
  },
};
