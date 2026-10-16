// Cloudways API client for the Server Monitoring section (read-only inventory in this phase).
//
// Context: the production server is a DigitalOcean Droplet, but it is provisioned and owned through
// Cloudways, so the customer has NO DigitalOcean PAT for it — the correct integration is Cloudways'
// own Platform API. Endpoints/shapes follow the public docs (developers.cloudways.com, Oct 2026).
//
// SECURITY rules that must always hold here:
//   - CLOUDWAYS_EMAIL and CLOUDWAYS_API_KEY are Worker secrets. The short-lived OAuth access_token
//     derived from them is ALSO a secret. None of the three is ever returned, logged, put in a URL,
//     or included in any error message. Errors we build carry only fixed, safe text.
//   - Requests are only ever sent to the official https://api.cloudways.com origin. Any other target
//     host is rejected before the fetch.
//   - Nothing is invented: missing server fields are null (never numeric 0), and failures surface as
//     honest errors or a real last-known-good snapshot rather than fabricated zeros or empty "success"
//     lists. Because the exact v2 response shape could not be fully pinned from public docs, list
//     responses are shape-validated: an unexpected body becomes a safe error, not fake data.
//
// Single-account (matches this app's single-server, single-tenant design); multi-account is deferred.

export const CW_ORIGIN = 'https://api.cloudways.com';

// Centralised so a wrong assumption is a one-line fix after the first live smoke test.
export const CW_BASE = 'https://api.cloudways.com/api/v2';
export const CW_TOKEN_PATH = '/oauth/access_token';
export const CW_SERVERS_PATH = '/servers';

// v2 (current) uses this; kept next to CW_BASE for reference. The access-token request itself uses
// CW_BASE + CW_TOKEN_PATH below.
export class CwError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'CwError';
    this.status = status;
  }
}

// ---------- connection status (per isolate) ----------
// `connected` reflects that an authenticated Cloudways request actually succeeded in this isolate.
let lastVerifiedAt = 0;
function markVerified(at = Date.now()) { lastVerifiedAt = at; }
export const connectionVerifiedAt = () => lastVerifiedAt;
export const hasCreds = (env) => Boolean(env && env.CLOUDWAYS_EMAIL && env.CLOUDWAYS_API_KEY);

export function statusBlock(env) {
  const tokenSet = hasCreds(env);
  const verified = tokenSet && lastVerifiedAt > 0;
  return { tokenSet, connected: verified, connectionVerifiedAt: verified ? lastVerifiedAt : null };
}

// ---------- OAuth access token (cached per isolate, refreshed on demand) ----------
let accessToken = null;
let accessTokenExpiresAt = 0;

export function _resetAuth() { accessToken = null; accessTokenExpiresAt = 0; } // test hook

async function getAccessToken(env, { force = false } = {}) {
  if (!hasCreds(env)) throw new CwError(503, 'Cloudways is not connected yet. The owner needs to set the CLOUDWAYS_EMAIL and CLOUDWAYS_API_KEY secrets.');
  const now = Date.now();
  if (!force && accessToken && now < accessTokenExpiresAt - 60000) return accessToken;

  let res;
  try {
    res = await fetch(`${CW_BASE}${CW_TOKEN_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      // Credentials go in the body (never the URL). The body is over TLS to the CW origin only.
      body: new URLSearchParams({ email: env.CLOUDWAYS_EMAIL, password: env.CLOUDWAYS_API_KEY }).toString(),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    const name = err && err.name;
    if (name === 'TimeoutError' || name === 'AbortError') throw new CwError(504, 'Cloudways did not respond in time.');
    throw new CwError(502, 'Could not reach Cloudways.');
  }

  if (res.status === 401 || res.status === 403) throw new CwError(res.status, 'Cloudways rejected the API credentials.');
  if (!res.ok) throw new CwError(502, `Cloudways returned an error while signing in (HTTP ${res.status}).`);

  let json;
  try { json = await res.json(); } catch { throw new CwError(502, 'Cloudways returned a sign-in response we could not read.'); }
  const token = typeof json?.access_token === 'string' ? json.access_token : null;
  if (!token) throw new CwError(502, 'Cloudways did not return an access token.');

  const expiresIn = Number(json.expires_in) || 3600; // seconds; default 1h
  accessToken = token;
  accessTokenExpiresAt = Date.now() + expiresIn * 1000;
  markVerified();
  return token;
}

// ---------- low-level request (bearer, origin-locked, safe errors) ----------
export async function cwRequest(env, target, opts = {}) {
  if (!hasCreds(env)) throw new CwError(503, 'Cloudways is not connected yet. The owner needs to set the CLOUDWAYS_EMAIL and CLOUDWAYS_API_KEY secrets.');

  let url;
  if (/^https?:\/\//i.test(target)) {
    url = new URL(target);
    if (url.origin !== CW_ORIGIN) throw new CwError(400, 'Refused to send the Cloudways token to a non-Cloudways host.');
  } else {
    url = new URL(CW_BASE + (target.startsWith('/') ? target : '/' + target));
  }
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  const send = async (token) => {
    try {
      return await fetch(url.toString(), {
        method: opts.method || 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs || 10000),
      });
    } catch (err) {
      const name = err && err.name;
      if (name === 'TimeoutError' || name === 'AbortError') throw new CwError(504, 'Cloudways did not respond in time.');
      throw new CwError(502, 'Could not reach Cloudways.');
    }
  };

  let token = await getAccessToken(env);
  let res = await send(token);

  // A stale/rotated token -> refresh once and retry a single time.
  if (res.status === 401) {
    token = await getAccessToken(env, { force: true });
    res = await send(token);
  }

  const reset = res.headers.get('ratelimit-reset');
  if (res.status === 429) throw new CwError(429, `Cloudways rate limit reached${reset ? `, try again in ${Math.max(1, Number(reset) || 1)}s` : ''}.`);
  if (res.status === 401 || res.status === 403) throw new CwError(res.status, 'Cloudways rejected the credentials, or they do not allow this request.');
  if (res.status === 404) throw new CwError(404, 'That server was not found on Cloudways.');
  if (!res.ok) throw new CwError(502, `Cloudways returned an error (HTTP ${res.status}).`);

  markVerified();

  let json;
  try {
    json = await res.json();
  } catch {
    throw new CwError(502, 'Cloudways returned a response we could not read.');
  }
  return json;
}

// ---------- normalization (defensive: null, never 0) ----------
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

function str(x) { return typeof x === 'string' && x.trim() ? x.trim() : null; }
function intOrNull(x) { const n = Number(x); return Number.isFinite(n) ? Math.trunc(n) : null; }

// Cloudways list items vary; IP may be under `ip`, `server`, or `master_ip`.
function pickIp(s) {
  for (const cand of [s.ip, s.master_ip, s.server, s.public_ip]) {
    if (typeof cand === 'string' && IPV4.test(cand)) return cand;
  }
  return null;
}

export function normalizeServer(s) {
  if (!s || typeof s !== 'object') return { id: null, name: null, region: null, provider: null, size: null, publicIp: null, status: null, os: null, createdAt: null, labels: null, vcpus: null, memoryGb: null, diskGb: null };
  return {
    id: intOrNull(s.id),
    name: str(s.name) ?? str(s.label) ?? str(s.server_label) ?? null,
    region: str(s.region) ?? str(s.location) ?? null,
    provider: str(s.provider) ?? str(s.cloud_provider) ?? null,
    size: str(s.size) ?? str(s.server_size) ?? str(s.plan) ?? null,
    publicIp: pickIp(s),
    status: str(s.status) ?? null,
    os: str(s.os) ?? str(s.os_name) ?? null,
    createdAt: str(s.created) ?? str(s.created_at) ?? null,
    labels: Array.isArray(s.labels) ? s.labels : null,
    vcpus: intOrNull(s.cpu_core_count ?? s.vcpus),
    memoryGb: Number.isFinite(Number(s.memory_size)) ? Number(Number(s.memory_size).toFixed(2)) : null,
    diskGb: Number.isFinite(Number(s.disk_size)) ? Number(Number(s.disk_size).toFixed(2)) : null,
  };
}

// ---------- read operations ----------
export function parseId(x) {
  const n = Number(x);
  if (!Number.isInteger(n) || n <= 0) throw new CwError(400, 'Invalid server id.');
  return n;
}

// Extract a servers array from the several shapes the API has used: {servers:[...]}, a bare array,
// or {data:{servers:[...]}}. Anything else is treated as an unexpected shape (safe error, no data).
function extractList(json) {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.servers)) return json.servers;
  if (Array.isArray(json?.data?.servers)) return json.data.servers;
  if (json && typeof json === 'object' && Array.isArray(json.data) && json.data.every((d) => d && typeof d === 'object' && ('id' in d || 'server' in d))) return json.data;
  return null;
}

// Paginate defensively with a hard page cap; a capped/ambiguous result is flagged partial and is
// never presented as a complete inventory.
export async function listServers(env, { perPage = 100, maxPages = 5 } = {}) {
  const servers = [];
  let partial = false;

  for (let page = 1; page <= maxPages; page++) {
    const json = await cwRequest(env, CW_SERVERS_PATH, { query: { page, per_page: perPage } });
    const list = extractList(json);
    if (!Array.isArray(list)) throw new CwError(502, 'Unexpected response from the Cloudways servers API.');
    for (const s of list) servers.push(normalizeServer(s));

    if (list.length === 0) break; // no more pages
    if (list.length < perPage) break; // last (partial) page reached the end
    if (page === maxPages && list.length === perPage) partial = true; // hit the cap, more may exist
  }

  return { servers, fetchedAt: Date.now(), partial };
}

export async function getServer(env, id) {
  const num = parseId(id);
  const json = await cwRequest(env, `${CW_SERVERS_PATH}/${num}`);
  const raw = json?.server ?? (Array.isArray(json?.data) ? json.data[0] : json?.data) ?? json;
  if (!raw || typeof raw !== 'object' || !('id' in raw || 'server' in raw || 'name' in raw)) {
    throw new CwError(502, 'Unexpected response from the Cloudways server API.');
  }
  return { server: normalizeServer(raw), fetchedAt: Date.now() };
}

// ---------- servers snapshot cache controller (L1 Map + durable L2 via injected D1 fns) ----------
// Provider-agnostic: identical semantics to the previous design, but calls listServers(). The durable
// last-good snapshot lives in the existing D1 `cache` table via the injected readCache/writeCache; the
// in-isolate Map is only a fast TTL layer. Concurrent (even ?fresh=1) requests share a single upstream
// call via the in-flight de-dupe.
export function createServersCache({ readCache, writeCache, now = () => Date.now(), l1Ttl = 30000 } = {}) {
  const good = new Map();     // key -> { at, servers, partial } — last-known-good in this isolate
  const inflight = new Map(); // key -> Promise (de-dupes concurrent, including fresh)

  async function load(key, env, { fresh = false } = {}) {
    const t = now();

    if (!fresh) {
      const g = good.get(key);
      if (g && t - g.at < l1Ttl) {
        return { servers: g.servers, refreshedAt: g.at, source: 'cache', stale: false, partial: !!g.partial, snapshotSaved: true };
      }
    }
    if (inflight.has(key)) return inflight.get(key); // never fire duplicate/parallel upstream calls

    const run = (async () => {
      const disk = await Promise.resolve(readCache ? readCache(key) : null).catch(() => null);

      if (!fresh && disk && Array.isArray(disk.data?.servers) && t - disk.at < l1Ttl) {
        const rec = { at: disk.at, servers: disk.data.servers, partial: !!disk.data.partial };
        good.set(key, rec);
        return { servers: rec.servers, refreshedAt: rec.at, source: 'cache', stale: false, partial: rec.partial, snapshotSaved: true };
      }

      try {
        const { servers, fetchedAt, partial } = await listServers(env);
        let snapshotSaved = false;
        try {
          await Promise.resolve(writeCache ? writeCache(key, { at: fetchedAt, data: { servers, partial } }) : undefined);
          snapshotSaved = true;
        } catch {
          snapshotSaved = false; // persistence failed — we still have accurate live data
        }
        good.set(key, { at: fetchedAt, servers, partial });
        return { servers, refreshedAt: fetchedAt, source: 'live', stale: false, partial, snapshotSaved };
      } catch (err) {
        const error = err instanceof CwError ? err.message : 'Could not load servers from Cloudways just now.';
        const diskHas = disk && Array.isArray(disk.data?.servers);
        const baseServers = diskHas ? disk.data.servers : (good.get(key)?.servers ?? null);
        if (Array.isArray(baseServers)) {
          const at = diskHas ? disk.at : good.get(key).at;
          const partial = diskHas ? !!disk.data.partial : !!good.get(key).partial;
          return { servers: baseServers, refreshedAt: at, source: 'stale', stale: true, partial, snapshotSaved: true, error };
        }
        // No prior success at all: honest unavailable, never a fabricated empty "success".
        return { servers: [], refreshedAt: null, source: 'error', stale: false, partial: false, unavailable: true, error };
      }
    })().finally(() => inflight.delete(key));

    inflight.set(key, run);
    return run;
  }

  return { load, _good: good, _inflight: inflight };
}

// ---------- settings (pure validation, shared by the route and tests) ----------
export const REFRESH_MIN = 30;
export const REFRESH_MAX = 300;
export const DEFAULT_RANGES = ['1h', '6h', '24h', '7d'];
export const DEFAULT_SETTINGS = { refreshSeconds: 60, defaultRange: '7d', regionFilter: '', notify: { email: false } };

export function validateSettings(raw) {
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = { ...DEFAULT_SETTINGS, notify: { ...DEFAULT_SETTINGS.notify } };

  if (s.refreshSeconds !== undefined) {
    const n = Number(s.refreshSeconds);
    if (!Number.isInteger(n) || n < REFRESH_MIN || n > REFRESH_MAX) {
      throw new CwError(400, `Refresh interval must be a whole number between ${REFRESH_MIN} and ${REFRESH_MAX} seconds.`);
    }
    out.refreshSeconds = n;
  }
  if (s.defaultRange !== undefined) {
    if (!DEFAULT_RANGES.includes(s.defaultRange)) throw new CwError(400, 'Unsupported default range.');
    out.defaultRange = s.defaultRange;
  }
  if (s.regionFilter !== undefined) {
    const r = s.regionFilter === null ? '' : String(s.regionFilter).trim();
    if (r.length > 64) throw new CwError(400, 'Region filter must be 64 characters or fewer.');
    out.regionFilter = r;
  }
  if (s.notify !== undefined) {
    const n = s.notify;
    if (!n || typeof n !== 'object' || Array.isArray(n)) throw new CwError(400, 'Invalid notification settings.');
    out.notify = { email: Boolean(n.email) }; // only known keys, coerced to booleans
  }
  return out;
}

// Non-sensitive summary for the audit log (never includes any credential).
export function describeSettingsChange(prev, next) {
  const p = prev || DEFAULT_SETTINGS;
  const bits = [];
  if (p.refreshSeconds !== next.refreshSeconds) bits.push(`refresh ${p.refreshSeconds}s→${next.refreshSeconds}s`);
  if (p.defaultRange !== next.defaultRange) bits.push(`range ${p.defaultRange}→${next.defaultRange}`);
  if ((p.regionFilter || '') !== (next.regionFilter || '')) bits.push(`region filter ${next.regionFilter ? 'set' : 'cleared'}`);
  if (Boolean(p.notify?.email) !== Boolean(next.notify.email)) bits.push(`email alerts ${next.notify.email ? 'on' : 'off'}`);
  return bits.length ? `Monitoring settings updated: ${bits.join(', ')}` : 'Monitoring settings saved (no changes)';
}
