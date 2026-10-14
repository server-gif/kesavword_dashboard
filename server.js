require('dotenv').config({ path: require('path').join(__dirname, '.env'), quiet: true });

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

if (!process.env.SFTP_HOST || !process.env.SFTP_USER || !(process.env.SFTP_PASS || process.env.SFTP_KEY_FILE)) {
  console.error('Missing SFTP_HOST / SFTP_USER / SFTP_PASS (or SFTP_KEY_FILE) in .env');
  process.exit(1);
}

const sftp = require('./lib/sftp');
const store = require('./lib/store');
const auth = require('./lib/auth');
const { lintPhp, isPhpPath } = require('./lib/lint');
const { buildOverview, buildApiDetail, findLogs, PERIODS } = require('./lib/overview');
const { loadGeo } = require('./lib/geo');

const { withSftp, withSftpWrite, getClient, readTextIfSmall, isBinary, getBuffer, writeFileFast } = sftp;
const { users, saveUsers, trash, saveTrash, logActivity } = store;
const { PORT = 3000, HOST = '127.0.0.1' } = process.env;
const SITE_NAME = (process.env.SITE_NAME || 'Server Dashboard').trim();
// Public web address of ROOT_DIR, used to build "Copy URL" links (e.g. http://example.com).
const SITE_URL = (process.env.SITE_URL || '').trim().replace(/\/+$/, '');

const posix = path.posix;
const TRASH_DAYS = 15;
const DAY = 86400000;
const MAX_EDIT_BYTES = 5 * 1024 * 1024;
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const MAX_UPLOAD_LINTS = 300; // PHP files checked per upload batch
const INLINE_SAFE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'avif', 'pdf', 'mp4', 'webm', 'mp3', 'wav', 'ogg', 'm4a']);
// Hosting-managed folders: deleting or renaming these would take sites offline.
const PROTECTED = /^\/applications(\/[^/]+(\/(public_html|private_html|conf|logs|ssl|tmp|\.cw))?)?$/;

// Everyone works inside ROOT_DIR only (set in .env); nothing above it can be opened.
const ROOT_DIR = (() => {
  const r = posix.normalize((process.env.ROOT_DIR || '/').trim() || '/');
  return r.length > 1 ? r.replace(/\/+$/, '') : r;
})();
const insideRoot = (p) => ROOT_DIR === '/' || p === ROOT_DIR || p.startsWith(ROOT_DIR + '/');

// The bin lives in the SFTP home, outside the website folder, so deleted files are never publicly reachable.
const trashDir = () => (process.env.TRASH_DIR || '').trim() || posix.join(sftp.getHome(), '.dashboard_trash');

// ---------- helpers ----------

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function cleanPath(p) {
  if (typeof p !== 'string' || !p.trim()) throw httpError(400, 'Path is required');
  const n = posix.normalize(p.trim());
  if (!n.startsWith('/')) throw httpError(400, 'Path must be absolute');
  const out = n.length > 1 ? n.replace(/\/+$/, '') : n;
  if (!insideRoot(out)) throw httpError(403, `You can only work inside ${ROOT_DIR}`);
  const t = trashDir();
  if (out === t || out.startsWith(t + '/')) throw httpError(403, 'That folder is reserved for the recycle bin');
  return out;
}

function guardProtected(p) {
  if (p === '/' || p === ROOT_DIR || p === sftp.getHome() || PROTECTED.test(p)) {
    throw httpError(403, `"${p}" is a system folder — it can't be deleted, renamed or have its permissions changed here`);
  }
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

// If the connection drops mid-rename, look at the server: if the file did move, carry on as normal.
async function renameChecked(from, to) {
  try {
    await withSftpWrite((c) => c.rename(from, to));
  } catch (err) {
    if (err.status !== 503) throw err;
    const [src, dst] = await Promise.all([stat(from), stat(to)]);
    if (dst && !src) return;
    throw err;
  }
}

const stat = (p) => withSftp((c) => c.stat(p)).catch(() => null);

const validName = (s) => typeof s === 'string' && s.trim().length >= 1 && s.trim().length <= 60;
const validUsername = (s) => typeof s === 'string' && /^[a-z0-9._@+-]{3,64}$/.test(s);
const validPassword = (s) => typeof s === 'string' && s.length >= 8 && s.length <= 200;

async function freePath(target) {
  if (!(await stat(target))) return target;
  const dir = posix.dirname(target);
  const ext = posix.extname(target);
  const base = posix.basename(target, ext);
  for (let n = 1; n < 100; n++) {
    const candidate = posix.join(dir, `${base} (restored${n > 1 ? ' ' + n : ''})${ext}`);
    if (!(await stat(candidate))) return candidate;
  }
  throw httpError(409, `Could not find a free name to restore ${target}`);
}

// ---------- app ----------

const app = express();
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '25mb' }));
app.use(auth.sameOrigin);
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ dest: path.join(os.tmpdir(), 'server-dashboard-uploads') });

// ---------- session (public) ----------

app.get('/api/session', (req, res) => {
  const user = auth.currentUser(req);
  res.json({
    setupRequired: users.length === 0,
    user: user ? auth.publicUser(user) : null,
    site: { name: SITE_NAME },
  });
});

app.post('/api/setup', (req, res) => {
  if (users.length) throw httpError(409, 'Owner account already exists');
  const { name, password } = req.body;
  const username = String(req.body.username || '').trim().toLowerCase();
  if (!validName(name)) throw httpError(400, 'Enter your name');
  if (!validUsername(username)) throw httpError(400, 'Username: 3–64 characters — letters, numbers or an email address, no spaces');
  if (!validPassword(password)) throw httpError(400, 'Password must be at least 8 characters');
  const user = {
    id: store.newId(),
    name: name.trim(),
    username,
    role: 'admin',
    active: true,
    passwordHash: auth.hashPassword(password),
    tokenVersion: 1,
    createdAt: Date.now(),
    lastLoginAt: Date.now(),
  };
  users.push(user);
  saveUsers();
  logActivity(user, 'setup', { detail: 'Owner account created' });
  auth.setSessionCookie(req, res, user);
  res.json({ user: auth.publicUser(user) });
});

app.post('/api/login', (req, res) => {
  const username = String(req.body.username || '').replace(/\s+/g, '').toLowerCase();
  const password = String(req.body.password || '');
  const key = `${req.ip}|${username}`;
  const locked = auth.loginLockedFor(key);
  if (locked) throw httpError(429, `Too many wrong attempts. Try again in ${Math.ceil(locked / 60000)} min.`);

  const user = users.find((u) => u.username === username);
  if (!user || !auth.verifyPassword(password, user.passwordHash)) {
    auth.recordLoginFail(key);
    logActivity({ username: username || '?', name: username || '?' }, 'login_failed', { detail: `from ${req.ip}` });
    throw httpError(401, 'Wrong username or password');
  }
  if (!user.active) throw httpError(403, 'This account has been disabled. Ask the owner to enable it.');

  auth.clearLoginFails(key);
  user.lastLoginAt = Date.now();
  saveUsers();
  logActivity(user, 'login', { detail: `from ${req.ip}` });
  auth.setSessionCookie(req, res, user);
  res.json({ user: auth.publicUser(user) });
});

app.post('/api/logout', (req, res) => {
  const user = auth.currentUser(req);
  if (user) logActivity(user, 'logout');
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

// Everything below needs a signed-in user.
app.use('/api', auth.requireAuth);

app.post('/api/account/password', (req, res) => {
  const { current, next } = req.body;
  if (!auth.verifyPassword(String(current || ''), req.user.passwordHash)) throw httpError(400, 'Current password is wrong');
  if (!validPassword(next)) throw httpError(400, 'New password must be at least 8 characters');
  req.user.passwordHash = auth.hashPassword(next);
  req.user.tokenVersion += 1;
  saveUsers();
  logActivity(req.user, 'password_change', { detail: 'Changed own password' });
  auth.setSessionCookie(req, res, req.user);
  res.json({ ok: true });
});

app.get('/api/info', wrap(async (req, res) => {
  await getClient();
  res.json({ name: SITE_NAME, url: SITE_URL, home: ROOT_DIR, trashDays: TRASH_DAYS, trashCount: trash.length });
}));

// ---------- files ----------

app.get('/api/list', wrap(async (req, res) => {
  const dir = cleanPath(req.query.path || ROOT_DIR);
  const hidden = posix.basename(trashDir());
  const hideTrash = dir === posix.dirname(trashDir());
  const items = (await withSftp((c) => c.list(dir))).filter(
    (i) => i.name !== '.' && i.name !== '..' && !(hideTrash && i.name === hidden)
  );
  // Resolve symlinks so linked folders open like folders
  const linkIsDir = {};
  for (const i of items.filter((x) => x.type === 'l')) {
    linkIsDir[i.name] = !!(await stat(posix.join(dir, i.name)))?.isDirectory;
  }
  res.json({
    path: dir,
    items: items.map((i) => ({
      name: i.name,
      type: i.type === 'd' || linkIsDir[i.name] ? 'dir' : 'file',
      link: i.type === 'l',
      size: i.size,
      modified: i.modifyTime,
      rights: [i.rights.user, i.rights.group, i.rights.other]
        .map((s) => `${s.includes('r') ? 'r' : '-'}${s.includes('w') ? 'w' : '-'}${s.includes('x') ? 'x' : '-'}`)
        .join(''),
    })),
  });
}));

// Last known text of recently opened/saved files, keyed by mtime. Lets a save skip
// re-downloading the old version (needed for the change history) when nothing changed since.
const textCache = new Map();
const TEXT_CACHE_MAX = 30;
function rememberText(file, mtime, text) {
  textCache.delete(file);
  if (!mtime || typeof text !== 'string' || text.length > MAX_DIFF_BYTES) return;
  textCache.set(file, { mtime, size: Buffer.byteLength(text, 'utf8'), text });
  if (textCache.size > TEXT_CACHE_MAX) textCache.delete(textCache.keys().next().value);
}

// A file (or everything inside a folder) changed some other way: drop what we remembered about it.
function forgetText(p) {
  for (const key of [...textCache.keys()]) if (key === p || key.startsWith(`${p}/`)) textCache.delete(key);
}

app.get('/api/read', wrap(async (req, res) => {
  const file = cleanPath(req.query.path);
  const st = await withSftp((c) => c.stat(file));
  if (st.isDirectory) throw httpError(400, 'That is a folder');
  if (st.size > MAX_EDIT_BYTES) throw httpError(413, 'File is larger than 5 MB — download it instead');
  const buf = await getBuffer(file);
  if (isBinary(buf)) throw httpError(415, 'Binary file — cannot edit as text');
  const content = buf.toString('utf8');
  rememberText(file, st.modifyTime, content);
  res.json({ path: file, content, mtime: st.modifyTime, size: st.size });
}));

// Results are remembered by content hash: the editor checks while you type,
// so by the time you press Save the server usually already knows the answer.
const lintCache = new Map();
const lintInFlight = new Map(); // same text being checked right now → share that check
const LINT_CACHE_MAX = 200;

function safeLint(content) {
  const key = crypto.createHash('sha1').update(content).digest('hex');
  const hit = lintCache.get(key);
  if (hit) {
    lintCache.delete(key);
    lintCache.set(key, hit);
    return Promise.resolve(hit);
  }
  if (!lintInFlight.has(key)) {
    lintInFlight.set(key, runLint(key, content).finally(() => lintInFlight.delete(key)));
  }
  return lintInFlight.get(key);
}

async function runLint(key, content) {
  try {
    const result = await lintPhp(content, ROOT_DIR);
    if (result.available) {
      lintCache.set(key, result);
      if (lintCache.size > LINT_CACHE_MAX) lintCache.delete(lintCache.keys().next().value);
    }
    return result;
  } catch (err) {
    console.error('PHP check failed:', err.message);
    return { available: false, checker: null, errors: [], warnings: [], error: err.message };
  }
}

const describeLint = (errors) => errors.slice(0, 3).map((e) => `line ${e.line}: ${e.message}`).join('; ');

app.post('/api/check', wrap(async (req, res) => {
  const file = cleanPath(req.body.path);
  if (typeof req.body.content !== 'string') throw httpError(400, 'Content is required');
  if (!isPhpPath(file)) return res.json({ available: false, checker: null, errors: [], warnings: [] });
  res.json(await safeLint(req.body.content));
}));

app.post('/api/save', wrap(async (req, res) => {
  const file = cleanPath(req.body.path);
  const { content, expectedMtime, force } = req.body;
  if (typeof content !== 'string') throw httpError(400, 'Content is required');

  // The PHP check and the file lookup don't depend on each other, so run them together.
  const [lint, st] = await Promise.all([isPhpPath(file) ? safeLint(content) : null, stat(file)]);

  // PHP with a syntax error would break the live site: block it (only the owner may save anyway).
  const ownerOverride = req.body.allowErrors === true && req.user.role === 'admin';
  if (lint?.errors.length && !ownerOverride) {
    return res.status(422).json({
      lint: true,
      ...lint,
      error: `Not saved — PHP error on ${describeLint(lint.errors)}`,
    });
  }
  if (st?.isDirectory) throw httpError(400, 'That is a folder');
  // mtime has 1-second resolution, so the size is compared too
  const { expectedSize } = req.body;
  if (st && expectedMtime && !force && (st.modifyTime !== expectedMtime || (typeof expectedSize === 'number' && st.size !== expectedSize))) {
    return res.status(409).json({ conflict: true, error: 'Someone changed this file on the server after you opened it.' });
  }

  let before = { exists: false, text: null };
  if (st) {
    const cached = textCache.get(file);
    before = cached && cached.mtime === st.modifyTime && cached.size === st.size
      ? { exists: true, text: cached.text }
      : await readTextIfSmall(file, MAX_DIFF_BYTES);
  }

  let mtime = await writeFileFast(file, Buffer.from(content, 'utf8'));
  if (!mtime) mtime = (await stat(file))?.modifyTime || null;
  rememberText(file, mtime, content);

  const lintNote = lint?.errors.length ? `⚠ Saved with PHP error — ${describeLint(lint.errors)}` : null;
  if (!before.exists) {
    logActivity(req.user, 'create_file', { path: file, detail: lintNote });
  } else if (before.text !== content) {
    const diff = before.text !== null && content.length <= MAX_DIFF_BYTES
      ? { path: file, before: before.text, after: content }
      : null;
    const detail = [lintNote, diff ? null : 'File too large to keep a copy of the change'].filter(Boolean).join(' · ') || null;
    logActivity(req.user, 'edit', { path: file, detail }, diff);
  }
  res.json({ ok: true, mtime, size: Buffer.byteLength(content, 'utf8'), lint });
}));

app.get('/api/download', wrap(async (req, res) => {
  const file = cleanPath(req.query.path);
  const st = await withSftp((c) => c.stat(file));
  if (st.isDirectory) throw httpError(400, 'Folders cannot be downloaded directly');
  const name = posix.basename(file);
  res.setHeader('Content-Length', st.size);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Showing a file inside the dashboard's own origin is only safe for types that can't run scripts
  // (an uploaded .html or .svg could otherwise act as the signed-in owner). Everything else downloads.
  const ext = posix.extname(name).slice(1).toLowerCase();
  if (req.query.inline && INLINE_SAFE.has(ext)) {
    res.type(name);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
    if (ext !== 'pdf') res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox");
  } else {
    res.attachment(name);
    logActivity(req.user, 'download', { path: file, size: st.size });
  }
  const c = await getClient();
  const stream = c.createReadStream(file);
  stream.on('error', (err) => res.destroy(err));
  stream.pipe(res);
}));

app.post('/api/upload', upload.array('files'), wrap(async (req, res) => {
  const files = req.files || [];
  try {
    const dir = cleanPath(req.body.dir);
    const relPaths = req.body.relPaths ? JSON.parse(req.body.relPaths) : [];
    const madeDirs = new Set();
    const lintProblems = [];
    const rejected = [];
    const isOwner = req.user.role === 'admin';
    let lintsLeft = MAX_UPLOAD_LINTS;
    let written = 0;
    for (let i = 0; i < files.length; i++) {
      const rel = relPaths[i] || files[i].originalname;
      const target = cleanPath(posix.join(dir, rel));
      if (!target.startsWith(dir === '/' ? '/' : dir + '/')) throw httpError(400, `Bad file name: ${rel}`);

      // PHP is checked before it is written, so a broken file never reaches the live site
      // unless the owner chooses to upload it anyway.
      let lint = null;
      if (isPhpPath(target) && files[i].size <= MAX_DIFF_BYTES && lintsLeft > 0) {
        lintsLeft--;
        lint = await safeLint(fs.readFileSync(files[i].path, 'utf8'));
      }
      if (lint?.errors.length && !isOwner) {
        rejected.push({ path: target, ...lint.errors[0] });
        continue;
      }
      const parent = posix.dirname(target);
      if (parent !== dir && !madeDirs.has(parent)) {
        await withSftpWrite((c) => c.mkdir(parent, true));
        madeDirs.add(parent);
      }

      const before = await readTextIfSmall(target, MAX_DIFF_BYTES);
      await withSftpWrite((c) => c.fastPut(files[i].path, target));

      let diff = null;
      if (before.text !== null && files[i].size <= MAX_DIFF_BYTES) {
        const buf = fs.readFileSync(files[i].path);
        if (!isBinary(buf)) diff = { path: target, before: before.text, after: buf.toString('utf8') };
      }

      forgetText(target);
      written++;
      let lintNote = null;
      if (lint?.errors.length) {
        lintNote = `⚠ PHP error — ${describeLint(lint.errors)}`;
        lintProblems.push({ path: target, ...lint.errors[0] });
      }
      logActivity(req.user, 'upload', {
        path: target,
        size: files[i].size,
        detail: [before.exists ? 'Replaced existing file' : null, lintNote].filter(Boolean).join(' · ') || null,
      }, diff);
    }
    res.json({ ok: true, count: written, lintProblems, rejected });
  } finally {
    for (const f of files) fs.unlink(f.path, () => {});
  }
}));

app.post('/api/mkdir', wrap(async (req, res) => {
  const dir = cleanPath(req.body.path);
  if (await stat(dir)) throw httpError(409, 'Something with that name already exists');
  await withSftpWrite((c) => c.mkdir(dir, true));
  logActivity(req.user, 'create_folder', { path: dir });
  res.json({ ok: true });
}));

app.post('/api/newfile', wrap(async (req, res) => {
  const file = cleanPath(req.body.path);
  if (await stat(file)) throw httpError(409, 'A file with that name already exists');
  await withSftpWrite((c) => c.put(Buffer.alloc(0), file));
  logActivity(req.user, 'create_file', { path: file });
  res.json({ ok: true });
}));

app.post('/api/rename', wrap(async (req, res) => {
  const from = cleanPath(req.body.from);
  const to = cleanPath(req.body.to);
  guardProtected(from);
  if (await stat(to)) throw httpError(409, 'Something with that name already exists');
  await renameChecked(from, to);
  forgetText(from);
  forgetText(to);
  logActivity(req.user, 'rename', { path: from, to });
  res.json({ ok: true });
}));

app.post('/api/chmod', wrap(async (req, res) => {
  const target = cleanPath(req.body.path);
  const mode = String(req.body.mode);
  if (!/^[0-7]{3,4}$/.test(mode)) throw httpError(400, 'Mode must look like 644 or 755');
  guardProtected(target);
  await withSftpWrite((c) => c.chmod(target, parseInt(mode, 8)));
  logActivity(req.user, 'chmod', { path: target, detail: mode });
  res.json({ ok: true });
}));

// ---------- API tester ----------
// Sends a request to the site's own URLs from the dashboard server (no browser CORS limits)
// and returns status, timing, headers and body. Only the SITE_URL host can be called.
const TEST_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

// PHP errors are usually hidden from responses (display_errors off) but written to the web
// server's error log. The tester notes the log size before a request and reads only what was
// appended afterwards. Cloudways keeps it in <app>/logs/backend_*.error.log; ERROR_LOG overrides.
let errorLogPath; // undefined = not looked up yet, null = none found
let errorLogLookup = null;
function findErrorLog() {
  if (errorLogPath !== undefined) return Promise.resolve(errorLogPath);
  if (!errorLogLookup) errorLogLookup = lookUpErrorLog().finally(() => { errorLogLookup = null; });
  return errorLogLookup;
}

async function lookUpErrorLog() {
  if (process.env.ERROR_LOG) return (errorLogPath = process.env.ERROR_LOG.trim());
  const dir = posix.join(posix.dirname(ROOT_DIR), 'logs');
  try {
    const logs = (await withSftp((c) => c.list(dir))).filter((f) => f.type === '-' && /\.error\.log$/.test(f.name));
    const pick = logs.find((f) => /^backend_/.test(f.name))
      || logs.find((f) => /php/i.test(f.name))
      || logs.sort((a, b) => b.modifyTime - a.modifyTime)[0];
    errorLogPath = pick ? posix.join(dir, pick.name) : null;
  } catch (err) {
    // couldn't read the folder right now — don't remember "no error log"; try again next time
    console.error('Could not look for the PHP error log:', err.message);
    return null;
  }
  if (errorLogPath) console.log(`API tester reads PHP errors from ${errorLogPath}`);
  return errorLogPath;
}

function readRange(file, start, end) {
  return withSftp((c) => new Promise((resolve, reject) => {
    const chunks = [];
    const stream = c.createReadStream(file, { start, end });
    stream.on('data', (d) => chunks.push(d));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  }));
}

// Server paths look like /home/<id>.cloudwaysapps.com/<app>/public_html/x.php — map to dashboard paths.
function toRootPath(serverFile) {
  const marker = `/${posix.basename(ROOT_DIR)}/`;
  const i = serverFile.indexOf(marker);
  return ROOT_DIR !== '/' && i >= 0 ? ROOT_DIR + serverFile.slice(i + marker.length - 1) : null;
}

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

app.post('/api/test-log', wrap(async (req, res) => {
  const file = await findErrorLog();
  const since = Number(req.body.since);
  if (!file || !Number.isFinite(since)) return res.json({ available: false, errors: [] });
  await new Promise((r) => setTimeout(r, 250)); // give the web server a moment to flush the log
  const st = await stat(file);
  if (!st) return res.json({ available: false, errors: [] });
  const start = st.size < since ? 0 : since; // smaller than before = the log was rotated
  const end = Math.min(st.size, start + 256 * 1024) - 1;
  const text = end >= start ? await readRange(file, start, end) : '';
  res.json({ available: true, errors: parsePhpLog(text) });
}));
const TEST_MAX_BODY = 2 * 1024 * 1024;

app.post('/api/test-request', wrap(async (req, res) => {
  if (!SITE_URL) throw httpError(400, 'Set SITE_URL in .env to test APIs');
  const method = String(req.body.method || 'GET').toUpperCase();
  if (!TEST_METHODS.has(method)) throw httpError(400, 'Unsupported method');
  let target;
  try { target = new URL(String(req.body.url || '')); } catch { throw httpError(400, 'Enter a full URL starting with http:// or https://'); }
  const site = new URL(SITE_URL);
  // Same host, http/https, and no unusual port (so the tester can't be pointed at other services).
  const onSite = (u) => /^https?:$/.test(u.protocol) && u.hostname === site.hostname && (u.port === '' || u.port === site.port);
  if (!onSite(target)) throw httpError(400, `Only ${site.hostname} URLs can be tested here`);

  const headers = new Headers();
  for (const { key, value } of Array.isArray(req.body.headers) ? req.body.headers : []) {
    if (!key) continue;
    try { headers.set(String(key).trim(), String(value ?? '')); } catch { throw httpError(400, `Invalid header: ${key}`); }
  }
  let body;
  if (method !== 'GET') {
    if (req.body.bodyType === 'json') {
      body = String(req.body.json ?? '');
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    } else if (req.body.bodyType === 'form') {
      body = new URLSearchParams((req.body.form || []).filter((f) => f.key).map((f) => [String(f.key), String(f.value ?? '')]));
    }
  }

  // Remember where the error log ends now; /api/test-log reads what this request adds.
  const logFile = await findErrorLog();
  const logSize = logFile ? (await stat(logFile))?.size ?? null : null;

  const started = performance.now();
  const signal = AbortSignal.timeout(30000);
  let r;
  let url = target;
  let reqMethod = method;
  let reqBody = body;
  let redirected = false;
  let blockedRedirect = null;
  try {
    // Follow redirects by hand, and only while they stay on the site.
    for (let hop = 0; hop <= 5; hop++) {
      r = await fetch(url, { method: reqMethod, headers, body: reqBody, redirect: 'manual', signal });
      const location = r.status >= 300 && r.status < 400 ? r.headers.get('location') : null;
      if (!location || hop === 5) break;
      const next = new URL(location, url);
      if (!onSite(next)) { blockedRedirect = next.href; break; }
      if (r.status === 303 || ((r.status === 301 || r.status === 302) && reqMethod === 'POST')) {
        reqMethod = 'GET';
        reqBody = undefined;
      }
      await r.arrayBuffer().catch(() => {});
      url = next;
      redirected = true;
    }
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? 'no answer within 30 seconds' : (err.cause?.code || err.cause?.message || err.message);
    throw httpError(502, `Could not reach ${target.host}: ${reason}`);
  }
  const buf = Buffer.from(await r.arrayBuffer());
  const timeMs = Math.round(performance.now() - started);
  const binary = isBinary(buf);
  res.json({
    status: r.status,
    statusText: r.statusText,
    url: url.href,
    redirected,
    blockedRedirect,
    timeMs,
    size: buf.length,
    headers: [...r.headers],
    binary,
    truncated: buf.length > TEST_MAX_BODY,
    body: binary ? '' : buf.subarray(0, TEST_MAX_BODY).toString('utf8'),
    logMark: logSize === null ? null : { size: logSize },
  });
}));

// ---------- overview (owner only) ----------
// Traffic summaries from the server logs (read-only). Cached; a stale copy is served at once
// while a fresh one is built in the background. Today moves quickly, past days don't.
let logPaths; // { access, web } once looked up
const summaryCache = new Map(); // key -> { at, data }
const summaryInFlight = new Map();

function cachedSummary(key, build) {
  if (!summaryInFlight.has(key)) {
    summaryInFlight.set(key, (async () => {
      if (!logPaths) logPaths = await findLogs(ROOT_DIR); // null when the folder couldn't be read (retried next time)
      const data = logPaths?.access
        ? await build({ accessLog: logPaths.access, webLog: logPaths.web, errorLog: await findErrorLog(), rootDir: ROOT_DIR, toRootPath })
        : { unavailable: true, reason: logPaths ? 'No PHP access log was found next to the website folder.' : 'The server log folder could not be read just now. Try Refresh in a moment.' };
      if (logPaths) summaryCache.set(key, { at: Date.now(), data });
      if (summaryCache.size > 60) summaryCache.delete(summaryCache.keys().next().value);
      return data;
    })().finally(() => summaryInFlight.delete(key)));
  }
  return summaryInFlight.get(key);
}

async function serveSummary(req, res, key, period, build) {
  const fresh = req.query.fresh === '1';
  // today changes by the minute; multi-day totals barely move; yesterday is fixed
  const maxAge = period === 'today' ? (fresh ? 10000 : 60000) : period === 'yesterday' ? 30 * 60000 : (fresh ? 30000 : 10 * 60000);
  const cached = summaryCache.get(key);
  if (cached && Date.now() - cached.at < maxAge) return cached.data;
  if (cached && !fresh) {
    cachedSummary(key, build).catch((err) => console.error('Summary refresh failed:', err.message));
    return cached.data;
  }
  return cachedSummary(key, build);
}

const pickPeriod = (p) => (PERIODS.includes(p) ? p : 'today');
const refreshOverview = (period) => cachedSummary(`overview|${period}`, (ctx) => buildOverview({ ...ctx, period }));

app.get('/api/overview', auth.requireAdmin, wrap(async (req, res) => {
  const period = pickPeriod(req.query.period);
  const data = await serveSummary(req, res, `overview|${period}`, period, (ctx) => buildOverview({ ...ctx, period }));
  // Ignored APIs are the owner's notes, kept on this computer — not part of the cached log summary.
  res.json({ ...data, ignored: Object.values(store.ignored) });
}));

app.get('/api/overview/api', auth.requireAdmin, wrap(async (req, res) => {
  const period = pickPeriod(req.query.period);
  const script = String(req.query.script || '');
  if (!script.startsWith('/')) throw httpError(400, 'Which API?');
  const data = await serveSummary(req, res, `api|${period}|${script}`, period, (ctx) => buildApiDetail({ ...ctx, period, script }));
  res.json({ ...data, ignored: store.ignored[script] || null, url: SITE_URL ? SITE_URL + script : null });
}));

// "Ignore" an API in Needs attention (e.g. a file removed on purpose). Stored only in ./data.
app.post('/api/overview/ignore', auth.requireAdmin, (req, res) => {
  const script = String(req.body.script || '');
  if (!script.startsWith('/') || script.length > 500) throw httpError(400, 'Which API?');
  if (req.body.ignore) {
    store.ignored[script] = { script, by: req.user.username, byName: req.user.name, at: Date.now(), note: String(req.body.note || '').slice(0, 200) };
  } else {
    delete store.ignored[script];
  }
  store.saveIgnored();
  logActivity(req.user, req.body.ignore ? 'ignore_api' : 'unignore_api', { detail: script });
  res.json({ ok: true, ignored: Object.values(store.ignored) });
});

// Duplicate a file or a whole folder under a new name (same content and permissions).
async function copyFile(src, dst, mode) {
  await withSftpWrite((c) => c.rcopy(src, dst));
  await withSftpWrite((c) => c.chmod(dst, mode & 0o7777)).catch(() => {});
}

async function copyDir(src, dst, mode, counter) {
  await withSftpWrite((c) => c.mkdir(dst));
  await withSftpWrite((c) => c.chmod(dst, mode & 0o7777)).catch(() => {});
  for (const item of await withSftp((c) => c.list(src))) {
    if (item.name === '.' || item.name === '..') continue;
    const from = posix.join(src, item.name);
    const to = posix.join(dst, item.name);
    const st = await withSftp((c) => c.lstat(from));
    if (item.type === 'd') await copyDir(from, to, st.mode, counter);
    else if (item.type === '-') { await copyFile(from, to, st.mode); counter.files++; }
    else counter.skipped++; // symlinks are not copied
  }
}

app.post('/api/duplicate', wrap(async (req, res) => {
  const from = cleanPath(req.body.from);
  const to = cleanPath(req.body.to);
  if (to === from || to.startsWith(from + '/')) throw httpError(400, 'Choose a different name for the copy');
  const st = await stat(from);
  if (!st) throw httpError(404, 'The original no longer exists');
  if (await stat(to)) throw httpError(409, 'Something with that name already exists');
  const counter = { files: 0, skipped: 0 };
  if (st.isDirectory) await copyDir(from, to, st.mode, counter);
  else { await copyFile(from, to, st.mode); counter.files = 1; }
  logActivity(req.user, 'duplicate', {
    path: from,
    to,
    detail: st.isDirectory ? `${counter.files} file${counter.files === 1 ? '' : 's'} copied${counter.skipped ? `, ${counter.skipped} link(s) skipped` : ''}` : null,
  });
  res.json({ ok: true, files: counter.files });
}));

// Delete = move into the recycle bin on the server (kept TRASH_DAYS days).
app.post('/api/delete', wrap(async (req, res) => {
  const paths = (Array.isArray(req.body.paths) ? req.body.paths : [req.body.path]).map(cleanPath);
  paths.forEach(guardProtected);
  await withSftpWrite((c) => c.mkdir(trashDir(), true));
  for (const p of paths) {
    const st = await stat(p);
    if (!st) continue;
    const id = store.newId();
    const name = posix.basename(p);
    await withSftpWrite((c) => c.mkdir(posix.join(trashDir(), id)));
    await renameChecked(p, posix.join(trashDir(), id, name));
    forgetText(p);
    const now = Date.now();
    trash.push({
      id,
      path: p,
      name,
      type: st.isDirectory ? 'dir' : 'file',
      size: st.isDirectory ? null : st.size,
      deletedBy: req.user.username,
      deletedByName: req.user.name,
      deletedAt: now,
      expiresAt: now + TRASH_DAYS * DAY,
    });
    saveTrash();
    logActivity(req.user, 'delete', { path: p, detail: 'Moved to recycle bin' });
  }
  res.json({ ok: true });
}));

// ---------- recycle bin ----------

app.get('/api/trash', (req, res) => {
  res.json({ days: TRASH_DAYS, items: [...trash].sort((a, b) => b.deletedAt - a.deletedAt) });
});

app.post('/api/trash/restore', wrap(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  const restored = [];
  for (const id of ids) {
    const item = trash.find((t) => t.id === id);
    if (!item) continue;
    await withSftpWrite((c) => c.mkdir(posix.dirname(item.path), true));
    const target = await freePath(item.path);
    await renameChecked(posix.join(trashDir(), id, item.name), target);
    forgetText(target);
    await withSftpWrite((c) => c.rmdir(posix.join(trashDir(), id), true)).catch(() => {});
    trash.splice(trash.indexOf(item), 1);
    saveTrash();
    logActivity(req.user, 'restore', { path: target, detail: target !== item.path ? `Original name was taken, restored as ${posix.basename(target)}` : null });
    restored.push(target);
  }
  res.json({ ok: true, restored });
}));

async function purgeTrashItem(item, user, reason) {
  const dir = posix.join(trashDir(), item.id);
  if (await stat(dir)) await withSftpWrite((c) => c.rmdir(dir, true));
  const idx = trash.indexOf(item);
  if (idx >= 0) trash.splice(idx, 1);
  saveTrash();
  logActivity(user, 'purge', { path: item.path, detail: reason });
}

app.post('/api/trash/purge', auth.requireAdmin, wrap(async (req, res) => {
  const items = req.body.all ? [...trash] : trash.filter((t) => (req.body.ids || []).includes(t.id));
  for (const item of items) await purgeTrashItem(item, req.user, 'Deleted forever from recycle bin');
  res.json({ ok: true, count: items.length });
}));

let purging = false;
async function purgeExpired() {
  if (purging) return;
  purging = true;
  try {
    for (const item of trash.filter((t) => t.expiresAt <= Date.now())) {
      await purgeTrashItem(item, null, `Auto-deleted after ${TRASH_DAYS} days`)
        .catch((err) => console.error('Auto-purge failed for', item.path, err.message));
    }
  } finally {
    purging = false;
  }
}

// ---------- activity log (owner only) ----------

app.get('/api/activity', auth.requireAdmin, (req, res) => {
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const q = String(req.query.q || '').toLowerCase();
  const all = store.readActivity();
  const filtered = all.filter((e) =>
    (!req.query.user || e.user === req.query.user) &&
    (!req.query.action || e.action === req.query.action) &&
    (!q || `${e.path || ''} ${e.to || ''} ${e.detail || ''}`.toLowerCase().includes(q))
  );
  res.json({
    total: filtered.length,
    items: filtered.slice(offset, offset + limit),
    users: [...new Set(all.map((e) => e.user))].sort(),
  });
});

app.get('/api/activity/:id/diff', auth.requireAdmin, (req, res) => {
  const diff = store.readDiff(req.params.id);
  if (!diff) throw httpError(404, 'No saved change for this entry');
  const entry = store.findActivity(req.params.id);
  res.json({ ...diff, entry });
});

app.post('/api/activity/:id/revert', auth.requireAdmin, wrap(async (req, res) => {
  const diff = store.readDiff(req.params.id);
  if (!diff || typeof diff.before !== 'string') throw httpError(404, 'No earlier version saved for this entry');
  const file = cleanPath(diff.path);
  const current = await readTextIfSmall(file, MAX_DIFF_BYTES);
  await withSftpWrite((c) => c.put(Buffer.from(diff.before, 'utf8'), file));
  forgetText(file);
  logActivity(req.user, 'revert', { path: file, detail: 'Restored the version from before an earlier change' },
    current.text !== null ? { path: file, before: current.text, after: diff.before } : null);
  res.json({ ok: true });
}));

// ---------- team (owner only) ----------

app.get('/api/users', auth.requireAdmin, (req, res) => {
  res.json({ users: users.map(auth.publicUser) });
});

app.post('/api/users', auth.requireAdmin, (req, res) => {
  const { name, password } = req.body;
  const username = String(req.body.username || '').trim().toLowerCase();
  if (!validName(name)) throw httpError(400, 'Enter a name');
  if (!validUsername(username)) throw httpError(400, 'Username: 3–64 characters — letters, numbers or an email address, no spaces');
  if (users.some((u) => u.username === username)) throw httpError(409, 'That username is already taken');
  if (!validPassword(password)) throw httpError(400, 'Password must be at least 8 characters');
  const user = {
    id: store.newId(),
    name: name.trim(),
    username,
    role: 'member',
    active: true,
    passwordHash: auth.hashPassword(password),
    tokenVersion: 1,
    createdAt: Date.now(),
  };
  users.push(user);
  saveUsers();
  logActivity(req.user, 'user_add', { detail: `Added ${user.name} (@${user.username})` });
  res.json({ user: auth.publicUser(user) });
});

app.post('/api/users/:id', auth.requireAdmin, (req, res) => {
  const user = users.find((u) => u.id === req.params.id);
  if (!user) throw httpError(404, 'User not found');
  if (user.role === 'admin') throw httpError(400, 'Use "Change password" to update the owner account');
  const changes = [];
  if (req.body.name !== undefined) {
    if (!validName(req.body.name)) throw httpError(400, 'Enter a name');
    user.name = req.body.name.trim();
    changes.push('name');
  }
  if (req.body.password !== undefined) {
    if (!validPassword(req.body.password)) throw httpError(400, 'Password must be at least 8 characters');
    user.passwordHash = auth.hashPassword(req.body.password);
    user.tokenVersion += 1;
    changes.push('password reset');
  }
  if (req.body.active !== undefined) {
    user.active = !!req.body.active;
    if (!user.active) user.tokenVersion += 1;
    changes.push(user.active ? 'enabled' : 'disabled');
  }
  saveUsers();
  logActivity(req.user, 'user_update', { detail: `${user.name} (@${user.username}): ${changes.join(', ')}` });
  res.json({ user: auth.publicUser(user) });
});

app.post('/api/users/:id/delete', auth.requireAdmin, (req, res) => {
  const idx = users.findIndex((u) => u.id === req.params.id);
  if (idx < 0) throw httpError(404, 'User not found');
  if (users[idx].role === 'admin') throw httpError(400, 'The owner account cannot be removed');
  const [user] = users.splice(idx, 1);
  saveUsers();
  logActivity(req.user, 'user_remove', { detail: `Removed ${user.name} (@${user.username})` });
  res.json({ ok: true });
});

// ---------- errors ----------

app.use((err, req, res, next) => {
  const status = err.status || (err.code === 2 || /no such file/i.test(err.message) ? 404 : 500);
  if (status >= 500) console.error(err);
  if (res.headersSent) return res.destroy();
  // Our own errors are already worded for people; SFTP errors start with a method prefix like "list: ".
  const message = err.status ? err.message : (err.message || 'Error').replace(/^[\w.]+: /, '');
  res.status(status).json({ error: message });
});

app.listen(Number(PORT), HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`Server dashboard running at http://${shown}:${PORT}`);
  console.log(`Folder: ${ROOT_DIR}`);
  if (!users.length) console.log('First visit: create the owner account in the browser.');
  getClient()
    .then(async () => {
      const st = await stat(ROOT_DIR);
      if (!st?.isDirectory) console.error(`WARNING: ROOT_DIR ${ROOT_DIR} does not exist on the server — check .env`);
    })
    .then(() => safeLint("<?php\n")) // find the PHP binary now so the first check is quick
    .then(() => findErrorLog())
    .then(() => loadGeo()) // country database (downloads on first run / once a month)
    .then(() => refreshOverview('today')) // so the owner's home page opens instantly
    .then(() => refreshOverview('7d'))
    .then(() => refreshOverview('30d'))
    .then(purgeExpired)
    .catch((err) => console.error('SFTP connection failed:', err.message));
  setInterval(() => purgeExpired().catch(() => {}), 60 * 60 * 1000);
});
