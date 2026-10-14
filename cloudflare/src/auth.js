// Same signed-cookie sessions and scrypt passwords as lib/auth.js, on pure-JS scrypt
// (@noble/hashes) so existing scryptSync hashes keep verifying (Workers have no crypto.scryptSync).
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { scrypt as nobleScrypt } from '@noble/hashes/scrypt';
import { listUsers } from './store.js';

const COOKIE = 'sd_session';
const SESSION_DAYS = 7;

const enc = new TextEncoder();

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const b64url = (buf) => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

const digest = (algo, data) => crypto.subtle.digest(algo, data);

const hmacKey = (secret) =>
  crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);

// Node crypto.scryptSync defaults: N=2^14, r=8, p=1. Match them so imported hashes verify.
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 128 * 16384 * 8 * 2 };
const scryptBytes = (password, salt, keyLen) =>
  nobleScrypt(enc.encode(password), salt, { ...SCRYPT_OPTS, dkLen: keyLen });

const toHex = (buf) => Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (s) => Uint8Array.from((s.match(/../g) || []), (h) => parseInt(h, 16));
// Original hashes are hex-encoded; any new hash we mint is hex too, but accept base64url defensively.
const isHex = (s) => /^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0;
const parseBytes = (s) => (isHex(s) ? fromHex(s) : fromB64url(s));

// ---------- passwords ----------

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = scryptBytes(password, salt, 64);
  return `scrypt$${toHex(salt)}$${toHex(hash)}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, saltStr, hashStr] = parts;
  let salt, expected;
  try { salt = parseBytes(saltStr); expected = parseBytes(hashStr); } catch { return false; }
  const actual = scryptBytes(password, salt, expected.length);
  let d = 0;
  for (let i = 0; i < expected.length; i++) d |= expected[i] ^ actual[i];
  return d === 0;
}

// ---------- session tokens (invalidated by bumping user.tokenVersion) ----------

async function sign(payload, secret) {
  const key = await hmacKey(secret);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(payload)));
}

async function makeToken(user, secret) {
  const payload = b64url(enc.encode(JSON.stringify({
    uid: user.id,
    v: user.tokenVersion,
    exp: Date.now() + SESSION_DAYS * 86400000,
  })));
  return `${payload}.${await sign(payload, secret)}`;
}

export async function userFromToken(token, secret) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const expected = await sign(payload, secret);
  if (sig.length !== expected.length || sig !== expected) return null;
  let data;
  try { data = JSON.parse(new TextDecoder().decode(fromB64url(payload))); } catch { return null; }
  if (data.exp < Date.now()) return null;
  const user = (await listUsers()).find((u) => u.id === data.uid);
  if (!user || !user.active || user.tokenVersion !== data.v) return null;
  return user;
}

export async function setSessionCookie(c, user) {
  setCookie(c, COOKIE, await makeToken(user, c.env.AUTH_SECRET), {
    httpOnly: true,
    sameSite: 'Lax',
    secure: true,
    maxAge: SESSION_DAYS * 86400,
    path: '/',
  });
}

export function clearSessionCookie(c) {
  deleteCookie(c, COOKIE, { path: '/' });
}

export const currentUser = (c) => userFromToken(getCookie(c, COOKIE), c.env.AUTH_SECRET);

// ---------- middleware helpers ----------

export const publicUser = (u) => ({
  id: u.id,
  name: u.name,
  username: u.username,
  role: u.role,
  active: u.active,
  createdAt: u.createdAt,
  lastLoginAt: u.lastLoginAt || null,
});

// ---------- login throttling (per Worker instance — best effort, like the local Map) ----------

const attempts = new Map();
const MAX_FAILS = 5;
const LOCK_MS = 10 * 60 * 1000;

export function loginLockedFor(key) {
  const a = attempts.get(key);
  if (!a || a.fails < MAX_FAILS) return 0;
  const left = a.until - Date.now();
  if (left <= 0) { attempts.delete(key); return 0; }
  return left;
}

export function recordLoginFail(key) {
  const a = attempts.get(key) || { fails: 0, until: 0 };
  a.fails += 1;
  if (a.fails >= MAX_FAILS) a.until = Date.now() + LOCK_MS;
  attempts.set(key, a);
}

export const clearLoginFails = (key) => attempts.delete(key);

export { digest };
