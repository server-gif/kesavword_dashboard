// Server Monitoring — SSH-based collector (read-only server facts).
//
// WHY SSH AND NOT A CLOUD PROVIDER API: this dashboard already connects to the production server
// (a DigitalOcean Droplet managed through Cloudways) over SSH/SFTP using the master credentials that
// are already configured and working in production (env.SFTP_HOST / SFTP_USER / SFTP_PASS / SFTP_KEY).
// The Cloudways Platform API would have needed a separate API key + API secret the owner does not
// have, so instead we read REAL, current system facts straight from the server over that existing,
// authenticated SSH channel — one source of truth, no extra secret, no third-party dependency.
//
// SECURITY rules that must always hold here:
//   - Credentials (SFTP_PASS / SFTP_KEY) are Worker secrets. They are only ever used by lib/sftp.js to
//     open the connection; they are NEVER run in a command, logged, put in a URL, or returned. The
//     probe below reads only non-secret system files and is entirely read-only.
//   - We reuse the SAME vetted SSH bridge as the rest of the app (cloudflare/src/sftp.js), so there is
//     no new network surface. It is already origin-scoped to the configured SFTP_HOST.
//   - Nothing is invented: any value we cannot read from the server is null (never a fabricated 0), and
//     a failed/unreachable probe surfaces as an honest error or the last-known-good snapshot — never a
//     fake "healthy" reading.
//
// Single-host by design (matches this app's single-server, single-tenant model). A stable synthetic id
// is used so the list/detail routes keep working; multi-host is out of scope for this phase.

// NOTE: ./sftp.js pulls in `cloudflare:sockets` (Workers-only), so it is imported lazily inside
// collectHost() rather than at module top level. That keeps the pure helpers here (parseRecords,
// normalizeHost, the cache controller and the settings validator) loadable and unit-testable in plain
// Node, with the single real SSH round-trip injected via the cache's `collect` option in tests.

export const HOST_ID = 1;

// ---------- error type (safe, fixed messages only) ----------
export class MonitorError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'MonitorError';
    this.status = status;
  }
}

// ---------- connection status (per isolate) ----------
// `connected` reflects that a probe actually succeeded from this isolate (real SSH round-trip).
let lastVerifiedAt = 0;
function markVerified(at = Date.now()) { lastVerifiedAt = at; }
export const connectionVerifiedAt = () => lastVerifiedAt;

// The monitoring reuses the existing server SSH/SFTP credentials, so "connected" is possible whenever
// the app is configured to reach the server at all (same gate every other feature already relies on).
export const hasCreds = (env) => Boolean(env && env.SFTP_HOST && env.SFTP_USER && (env.SFTP_PASS || env.SFTP_KEY));

export function statusBlock(env) {
  const tokenSet = hasCreds(env);
  const verified = tokenSet && lastVerifiedAt > 0;
  return { tokenSet, connected: verified, connectionVerifiedAt: verified ? lastVerifiedAt : null };
}

// ---------- the probe (read-only, one shell round-trip) ----------
// Emits labelled single-line records. Values with spaces are kept on the record line; we parse per
// line by the @@KEY@@ marker so nothing depends on column order. All commands are read-only and touch
// only public system files/commands. If a source is missing the marker line comes back empty and the
// matching field becomes null.
const PROBE = [
  'echo "@@HOSTNAME@@" $(hostname 2>/dev/null)',
  'echo "@@KERNEL@@" $(uname -sr 2>/dev/null)',
  'echo "@@OS@@" $(grep -m1 ^PRETTY_NAME= /etc/os-release 2>/dev/null | cut -d= -f2-)',
  'echo "@@IP@@" $(hostname -I 2>/dev/null)',
  'echo "@@UPTIME@@" $(cut -d. -f1 /proc/uptime 2>/dev/null)',
  'echo "@@LOAD@@" $(cat /proc/loadavg 2>/dev/null)',
  'echo "@@CORES@@" $(nproc 2>/dev/null)',
  'echo "@@MEM@@" $(grep -E "^MemTotal:|^MemAvailable:" /proc/meminfo 2>/dev/null)',
  'echo "@@DISK@@" $(df -Pk / 2>/dev/null | tail -1)',
].join('\n');

// ---------- parsing helpers (null, never 0) ----------
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

function stripQuotes(x) { return typeof x === 'string' ? x.replace(/^"|"$/g, '').trim() : null; }
function str(x) { const s = typeof x === 'string' ? x.trim() : ''; return s || null; }
function num(x) { const n = Number(x); return Number.isFinite(n) ? n : null; }
function round(x, dp = 2) { return x == null ? null : Number(Number(x).toFixed(dp)); }

// Turn the probe's stdout into a map of KEY -> raw line value (text after the marker).
export function parseRecords(stdout) {
  const rec = {};
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = /^@@([A-Z]+)@@\s?(.*)$/.exec(line.trim());
    if (m) rec[m[1]] = m[2];
  }
  return rec;
}

const KB = 1024;
const GB = KB * 1024;

// Normalise raw records into a single, stable, defensively-shaped host object.
export function normalizeHost(rec, env) {
  const mem = {};
  const mt = /MemTotal:\s*(\d+)/.exec(rec.MEM || '');
  const ma = /MemAvailable:\s*(\d+)/.exec(rec.MEM || '');
  mem.totalMb = mt ? Math.round(Number(mt[1]) / KB) : null;      // /proc/meminfo values are in kB
  mem.availMb = ma ? Math.round(Number(ma[1]) / KB) : null;
  if (mem.totalMb != null && mem.availMb != null) {
    mem.usedMb = Math.max(0, mem.totalMb - mem.availMb);
    mem.usedPct = mem.totalMb ? round((mem.usedMb / mem.totalMb) * 100, 1) : null;
  } else {
    mem.usedMb = null; mem.usedPct = null;
  }

  const disk = {};
  const dcols = String(rec.DISK || '').trim().split(/\s+/);
  // df -P line: <Filesystem> <1024-blocks> <Used> <Available> <Capacity%> <Mounted-on>
  if (dcols.length >= 5) {
    disk.totalGb = round(num(dcols[1]) / GB, 2);
    disk.usedGb = round(num(dcols[2]) / GB, 2);
    disk.availGb = round(num(dcols[3]) / GB, 2);
    disk.usedPct = num(String(dcols[4]).replace('%', ''));
    disk.mount = str(dcols[5]) || '/';
  } else {
    disk.totalGb = disk.usedGb = disk.availGb = disk.usedPct = null; disk.mount = null;
  }

  const loads = String(rec.LOAD || '').trim().split(/\s+/).filter(Boolean).slice(0, 3).map((v) => round(num(v), 2));
  const uptimeSeconds = num(rec.UPTIME);

  // Public IP: the address the whole dashboard already dials is env.SFTP_HOST; report that as the
  // server's public IP (accurate and what the owner expects). The interface IP from `hostname -I` is
  // exposed separately as internalIp (what the OS itself sees), never conflated.
  const publicIp = str(env && env.SFTP_HOST);
  const ipTok = String(rec.IP || '').trim().split(/\s+/)[0];
  const internalIp = ipTok && IPV4.test(ipTok) ? ipTok : null;

  const hostname = str(rec.HOSTNAME);
  const cores = num(rec.CORES);

  return {
    id: HOST_ID,
    name: hostname || 'this server',
    hostname: hostname,
    provider: 'Cloudways (DigitalOcean Droplet)',
    region: null,
    size: null,
    publicIp,
    internalIp,
    status: 'RUNNING', // reachable over SSH = running; an unreachable probe throws instead of faking this
    os: stripQuotes(rec.OS) || str(rec.KERNEL),
    kernel: str(rec.KERNEL),
    createdAt: null,
    labels: null,
    vcpus: cores,
    memoryGb: mem.totalMb != null ? round(mem.totalMb / KB, 2) : null,
    diskGb: disk.totalGb,
    metrics: {
      uptimeSeconds,
      load1: loads[0] ?? null,
      load5: loads[1] ?? null,
      load15: loads[2] ?? null,
      cores,
      memory: mem,
      disk,
    },
  };
}

// ---------- read operations ----------
export function parseId(x) {
  const n = Number(x);
  if (!Number.isInteger(n) || n <= 0) throw new MonitorError(400, 'Invalid server id.');
  return n;
}

// Open the existing SSH channel and run the probe once, returning the normalized host.
export async function collectHost(env) {
  if (!hasCreds(env)) throw new MonitorError(503, 'The server connection is not configured, so its facts cannot be read.');
  let res;
  try {
    const { withSftp } = await import('./sftp.js');
    res = await withSftp(env, (k) => k.exec(PROBE));
  } catch (err) {
    // Never surface the underlying SSH error text (it can carry host/user detail); a fixed message only.
    throw new MonitorError(502, 'Could not reach the server over SSH just now.');
  }
  if (!res || res.code !== 0 || !res.stdout) {
    throw new MonitorError(502, 'The server did not return its status information.');
  }
  markVerified();
  const host = normalizeHost(parseRecords(res.stdout), env);
  return { host, fetchedAt: Date.now() };
}

export async function getHost(env) {
  const { host, fetchedAt } = await collectHost(env);
  return { server: host, fetchedAt };
}

// ---------- snapshot cache controller (L1 Map + durable L2 via injected D1 fns) ----------
// Identical semantics to the previous design, but the upstream call is collectHost() instead of a
// provider API. The durable last-good snapshot lives in the existing D1 `cache` table via the injected
// readCache/writeCache; the in-isolate Map is only a fast TTL layer. Concurrent (even ?fresh=1)
// requests share a single SSH round-trip via the in-flight de-dupe (SSH handshakes are expensive).
export function createHostCache({ readCache, writeCache, now = () => Date.now(), l1Ttl = 30000, collect = collectHost } = {}) {
  const good = new Map();     // key -> { at, host } — last-known-good in this isolate
  const inflight = new Map(); // key -> Promise (de-dupes concurrent, including fresh)

  function pack(host, at, source, extra) {
    return { servers: [host], host, refreshedAt: at, source, stale: false, partial: false, ...extra };
  }

  async function load(key, env, { fresh = false } = {}) {
    const t = now();

    if (!fresh) {
      const g = good.get(key);
      if (g && t - g.at < l1Ttl) return pack(g.host, g.at, 'cache', { snapshotSaved: true });
    }
    if (inflight.has(key)) return inflight.get(key); // never fire duplicate/parallel SSH round-trips

    const run = (async () => {
      const disk = await Promise.resolve(readCache ? readCache(key) : null).catch(() => null);

      if (!fresh && disk && disk.data?.host && t - disk.at < l1Ttl) {
        good.set(key, { at: disk.at, host: disk.data.host });
        return pack(disk.data.host, disk.at, 'cache', { snapshotSaved: true });
      }

      try {
        const { host, fetchedAt } = await collect(env);
        let snapshotSaved = false;
        try {
          await Promise.resolve(writeCache ? writeCache(key, { at: fetchedAt, data: { host } }) : undefined);
          snapshotSaved = true;
        } catch {
          snapshotSaved = false; // persistence failed — we still have accurate live data
        }
        good.set(key, { at: fetchedAt, host });
        return pack(host, fetchedAt, 'live', { snapshotSaved });
      } catch (err) {
        const error = err instanceof MonitorError ? err.message : 'Could not load server status just now.';
        const baseHost = (disk && disk.data?.host) ? disk.data.host : (good.get(key)?.host ?? null);
        if (baseHost) {
          const at = (disk && disk.data?.host) ? disk.at : good.get(key).at;
          return { servers: [baseHost], host: baseHost, refreshedAt: at, source: 'stale', stale: true, partial: false, snapshotSaved: true, error };
        }
        // No prior success at all: honest unavailable, never a fabricated "healthy" reading.
        return { servers: [], host: null, refreshedAt: null, source: 'error', stale: false, partial: false, unavailable: true, error };
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
      throw new MonitorError(400, `Refresh interval must be a whole number between ${REFRESH_MIN} and ${REFRESH_MAX} seconds.`);
    }
    out.refreshSeconds = n;
  }
  if (s.defaultRange !== undefined) {
    if (!DEFAULT_RANGES.includes(s.defaultRange)) throw new MonitorError(400, 'Unsupported default range.');
    out.defaultRange = s.defaultRange;
  }
  if (s.regionFilter !== undefined) {
    const r = s.regionFilter === null ? '' : String(s.regionFilter).trim();
    if (r.length > 64) throw new MonitorError(400, 'Region filter must be 64 characters or fewer.');
    out.regionFilter = r;
  }
  if (s.notify !== undefined) {
    const n = s.notify;
    if (!n || typeof n !== 'object' || Array.isArray(n)) throw new MonitorError(400, 'Invalid notification settings.');
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
