const crypto = require('crypto');
const { users, secret } = require('./store');

const COOKIE = 'sd_session';
const SESSION_DAYS = 7;

// ---------- passwords ----------

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [, saltHex, hashHex] = String(stored).split('$');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

// ---------- session tokens (signed cookie, invalidated by bumping user.tokenVersion) ----------

const sign = (data) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

function makeToken(user) {
  const payload = Buffer.from(JSON.stringify({
    uid: user.id,
    v: user.tokenVersion,
    exp: Date.now() + SESSION_DAYS * 86400000,
  })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function userFromToken(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
  if (data.exp < Date.now()) return null;
  const user = users.find((u) => u.id === data.uid);
  if (!user || !user.active || user.tokenVersion !== data.v) return null;
  return user;
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function setSessionCookie(req, res, user) {
  res.cookie(COOKIE, makeToken(user), {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: SESSION_DAYS * 86400000,
    path: '/',
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

const currentUser = (req) => userFromToken(readCookie(req, COOKIE));

// ---------- middleware ----------

function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Please sign in again' });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Only the owner can do this' });
  next();
}

// Blocks cross-site form posts: a state-changing request must come from this same site.
function sameOrigin(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.headers.origin;
  if (origin) {
    let host = null;
    try { host = new URL(origin).host; } catch {}
    if (host !== req.headers.host) return res.status(403).json({ error: 'Cross-site request blocked' });
  }
  next();
}

// ---------- login throttling ----------

const attempts = new Map();
const MAX_FAILS = 5;
const LOCK_MS = 10 * 60 * 1000;

function loginLockedFor(key) {
  const a = attempts.get(key);
  if (!a || a.fails < MAX_FAILS) return 0;
  const left = a.until - Date.now();
  if (left <= 0) { attempts.delete(key); return 0; }
  return left;
}

function recordLoginFail(key) {
  const a = attempts.get(key) || { fails: 0, until: 0 };
  a.fails += 1;
  if (a.fails >= MAX_FAILS) a.until = Date.now() + LOCK_MS;
  attempts.set(key, a);
}

const clearLoginFails = (key) => attempts.delete(key);

// ---------- helpers ----------

function publicUser(u) {
  return {
    id: u.id,
    name: u.name,
    username: u.username,
    role: u.role,
    active: u.active,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt || null,
  };
}

module.exports = {
  hashPassword, verifyPassword,
  setSessionCookie, clearSessionCookie, currentUser,
  requireAuth, requireAdmin, sameOrigin,
  loginLockedFor, recordLoginFail, clearLoginFails,
  publicUser,
};
