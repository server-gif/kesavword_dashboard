// Local JSON storage for users, recycle-bin index and the activity log (in ./data).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const HISTORY_DIR = path.join(DATA_DIR, 'history');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const TRASH_FILE = path.join(DATA_DIR, 'trash.json');
const LOG_FILE = path.join(DATA_DIR, 'activity.jsonl');
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');
const IGNORED_FILE = path.join(DATA_DIR, 'ignored.json');

fs.mkdirSync(HISTORY_DIR, { recursive: true });

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const newId = () => crypto.randomBytes(8).toString('hex');

function loadSecret() {
  try { return fs.readFileSync(SECRET_FILE); } catch {}
  const s = crypto.randomBytes(32);
  fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
  return s;
}

// Kept in memory and written through on every change, so concurrent requests never lose updates.
const users = readJson(USERS_FILE, []);
const trash = readJson(TRASH_FILE, []);

const saveUsers = () => writeJson(USERS_FILE, users);
const saveTrash = () => writeJson(TRASH_FILE, trash);

// APIs the owner marked "ignore" in the overview: { "/api/x.php": { script, by, byName, at, note } }
const ignored = readJson(IGNORED_FILE, {});
const saveIgnored = () => writeJson(IGNORED_FILE, ignored);

// ---------- activity log ----------

function logActivity(user, action, fields = {}, diff = null) {
  const entry = {
    id: newId(),
    ts: Date.now(),
    user: user ? user.username : 'system',
    name: user ? user.name : 'System',
    action,
    ...fields,
    hasDiff: !!diff,
  };
  if (diff) {
    fs.writeFileSync(path.join(HISTORY_DIR, `${entry.id}.json.gz`), zlib.gzipSync(JSON.stringify(diff)));
  }
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  const log = activityLog();
  log.list.push(entry);
  log.byId.set(entry.id, entry);
  return entry;
}

// The log file is read once; after that new entries are added in memory as they are written,
// so the Activity page never re-reads (and re-parses) a file that keeps growing.
let activity = null;
function activityLog() {
  if (activity) return activity;
  activity = { list: [], byId: new Map() };
  let raw = '';
  try { raw = fs.readFileSync(LOG_FILE, 'utf8'); } catch {}
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      activity.list.push(e);
      activity.byId.set(e.id, e);
    } catch {}
  }
  return activity;
}

// Newest first.
const readActivity = () => activityLog().list.slice().reverse();
const findActivity = (id) => activityLog().byId.get(id) || null;

function readDiff(id) {
  if (!/^[0-9a-f]{16}$/.test(id)) return null;
  try {
    return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(HISTORY_DIR, `${id}.json.gz`))).toString('utf8'));
  } catch { return null; }
}

module.exports = {
  users, saveUsers,
  trash, saveTrash,
  ignored, saveIgnored,
  logActivity, readActivity, findActivity, readDiff,
  newId, secret: loadSecret(),
};
