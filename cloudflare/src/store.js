// D1-backed replacement for the local ./data files (users, recycle bin, activity, diffs, ignored).
// The users/trash/ignored lists are small and were previously read/written whole — kept that way.
import zlib from 'node:zlib';
import { getEnv } from './env.js';

const db = () => getEnv().DB;

const newId = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');

// ---------- users ----------

export async function listUsers() {
  const rows = await db().prepare('SELECT data FROM users ORDER BY rowid').all();
  return rows.results.map((r) => JSON.parse(r.data));
}

export async function saveUsers(list) {
  const now = Date.now();
  const stmts = [db().prepare('DELETE FROM users')];
  for (const u of list) {
    stmts.push(db().prepare('INSERT INTO users (id, data, updated_at) VALUES (?1, ?2, ?3)')
      .bind(u.id, JSON.stringify(u), now));
  }
  await db().batch(stmts);
}

// ---------- settings blobs (trash index, ignored APIs) ----------

export async function getSetting(key, fallback) {
  const row = await db().prepare('SELECT value FROM settings WHERE key = ?1').bind(key).first();
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}

export async function setSetting(key, value) {
  await db().prepare('INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2')
    .bind(key, JSON.stringify(value)).run();
}

// ---------- activity log ----------

export async function logActivity(user, action, fields = {}, diff = null) {
  const entry = {
    id: newId(),
    ts: Date.now(),
    user: user ? user.username : 'system',
    name: user ? user.name : 'System',
    action,
    ...fields,
    hasDiff: !!diff,
  };
  const stmts = [
    db().prepare(`INSERT INTO activity (id, ts, user, name, action, path, to_path, detail, size, has_diff)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`)
      .bind(entry.id, entry.ts, entry.user, entry.name, entry.action,
        entry.path ?? null, entry.to ?? null, entry.detail ?? null, entry.size ?? null, entry.hasDiff ? 1 : 0),
  ];
  if (diff) {
    stmts.push(db().prepare('INSERT INTO diffs (id, gz) VALUES (?1, ?2)')
      .bind(entry.id, new Uint8Array(zlib.gzipSync(Buffer.from(JSON.stringify(diff), 'utf8')).buffer)));
  }
  await db().batch(stmts);
  return entry;
}

// Same shape as the old /api/activity response: newest first, filtered + paged in SQL.
export async function queryActivity({ offset = 0, limit = 50, q = '', user = '', action = '' } = {}) {
  const where = ['1=1'];
  const binds = [];
  if (user) { where.push('user = ?' + (binds.push(user), binds.length)); }
  if (action) { where.push('action = ?' + (binds.push(action), binds.length)); }
  if (q) {
    where.push(`(coalesce(path, '') || ' ' || coalesce(to_path, '') || ' ' || coalesce(detail, '')) LIKE ?${(binds.push('%' + q.toLowerCase() + '%'), binds.length)}`);
  }
  const w = where.join(' AND ');
  const countRow = await db().prepare(`SELECT COUNT(*) AS n FROM activity WHERE ${w}`).bind(...binds).first();
  const items = await db().prepare(
    `SELECT * FROM activity WHERE ${w} ORDER BY ts DESC LIMIT ?${binds.length + 1} OFFSET ?${binds.length + 2}`
  ).bind(...binds, limit, offset).all();
  const usersRow = await db().prepare('SELECT DISTINCT user FROM activity ORDER BY user').all();
  return {
    total: countRow?.n || 0,
    items: items.results.map((r) => ({
      id: r.id, ts: r.ts, user: r.user, name: r.name, action: r.action,
      path: r.path, to: r.to_path, detail: r.detail, size: r.size, hasDiff: !!r.has_diff,
    })),
    users: usersRow.results.map((r) => r.user),
  };
}

export async function findActivity(id) {
  const r = await db().prepare('SELECT * FROM activity WHERE id = ?1').bind(id).first();
  if (!r) return null;
  return {
    id: r.id, ts: r.ts, user: r.user, name: r.name, action: r.action,
    path: r.path, to: r.to_path, detail: r.detail, size: r.size, hasDiff: !!r.has_diff,
  };
}

export async function readDiff(id) {
  if (!/^[0-9a-f]{16}$/.test(id)) return null;
  const row = await db().prepare('SELECT gz FROM diffs WHERE id = ?1').bind(id).first();
  if (!row) return null;
  try {
    return JSON.parse(zlib.gunzipSync(Buffer.from(row.gz)).toString('utf8'));
  } catch { return null; }
}

export { newId };
