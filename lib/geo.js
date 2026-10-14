// IP address -> country, from the free DB-IP "IP to Country Lite" database (CC BY 4.0, https://db-ip.com).
// The file lives on this computer (data/geo) and is refreshed about once a month; lookups never leave
// this machine, so callers' IP addresses are not sent to any outside service.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const GEO_DIR = path.join(DATA_DIR, 'geo');
const FILE = path.join(GEO_DIR, 'dbip-country-lite.csv.gz');
const MAX_AGE = 35 * 86400000;

let db = null; // { starts: Uint32Array, ends: Uint32Array, codeIdx: Uint16Array, codes: string[] }
let loading = null;
let failedAt = 0; // when the database last could not be loaded (no retry for an hour)
const RETRY_MS = 3600000;
const WAIT_MS = 5000; // a page never waits longer than this for the database

const ipv4ToInt = (ip) => {
  const p = ip.split('.');
  if (p.length !== 4) return -1;
  const n = p.map(Number);
  if (n.some((x) => !(x >= 0 && x <= 255))) return -1;
  return n[0] * 16777216 + n[1] * 65536 + n[2] * 256 + n[3];
};

async function download() {
  fs.mkdirSync(GEO_DIR, { recursive: true });
  const now = new Date();
  const months = [0, 1].map((back) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    return d.toISOString().slice(0, 7);
  });
  for (const m of months) {
    try {
      const res = await fetch(`https://download.db-ip.com/free/dbip-country-lite-${m}.csv.gz`, { signal: AbortSignal.timeout(90000) });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      zlib.gunzipSync(buf); // make sure it is a complete gzip file before replacing the old one
      const tmp = `${FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, FILE);
      console.log(`Country database updated (DB-IP ${m})`);
      return true;
    } catch {}
  }
  return false;
}

function parse(buf) {
  const text = zlib.gunzipSync(buf).toString('utf8');
  const starts = [];
  const ends = [];
  const idx = [];
  const codes = [];
  const codeMap = new Map();
  for (const line of text.split('\n')) {
    if (!line || line.includes(':')) continue; // IPv6 rows are skipped: the logs are almost all IPv4
    const [a, b, cc] = line.trim().split(',');
    const s = ipv4ToInt(a);
    const e = ipv4ToInt(b);
    if (s < 0 || e < 0 || !/^[A-Z]{2}$/.test(cc || '')) continue;
    if (!codeMap.has(cc)) { codeMap.set(cc, codes.length); codes.push(cc); }
    starts.push(s);
    ends.push(e);
    idx.push(codeMap.get(cc));
  }
  return { starts: Uint32Array.from(starts), ends: Uint32Array.from(ends), codeIdx: Uint16Array.from(idx), codes };
}

// Loads the database (downloading it first if missing or older than ~a month). Resolves to null if unavailable.
function load() {
  if (db) return Promise.resolve(db);
  if (!loading && failedAt && Date.now() - failedAt < RETRY_MS) return Promise.resolve(null);
  if (!loading) {
    loading = (async () => {
      const st = fs.statSync(FILE, { throwIfNoEntry: false });
      if (!st || Date.now() - st.mtimeMs > MAX_AGE) await download();
      if (!fs.existsSync(FILE)) { failedAt = Date.now(); return null; }
      db = parse(fs.readFileSync(FILE));
      return db;
    })().catch((err) => {
      console.error('Country database unavailable:', err.message);
      failedAt = Date.now();
      return null;
    }).finally(() => { loading = null; });
  }
  return loading;
}

function countryOf(ipInt) {
  const { starts, ends, codeIdx, codes } = db;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= ipInt) lo = mid + 1;
    else hi = mid - 1;
  }
  return hi >= 0 && ipInt <= ends[hi] ? codes[codeIdx[hi]] : null;
}

let regionNames;
const countryName = (code) => {
  try {
    regionNames ??= new Intl.DisplayNames(['en'], { type: 'region' });
    return regionNames.of(code) || code;
  } catch {
    return code;
  }
};

// prefixCounts: Map of "a.b.c" (the /24 of the caller's IPv4) or "v6" -> calls.
// Returns [{ code, name, calls }] biggest first, or null when the database is unavailable.
async function countriesFor(prefixCounts) {
  if (!prefixCounts?.size) return [];
  // still downloading (first run)? don't hold the page — it fills in on the next refresh
  const ready = await Promise.race([load(), new Promise((r) => setTimeout(() => r(null), WAIT_MS))]);
  if (!ready) return null;
  const totals = new Map();
  for (const [prefix, calls] of prefixCounts) {
    let code = 'unknown';
    if (prefix !== 'v6') {
      const ip = ipv4ToInt(`${prefix}.1`);
      code = (ip >= 0 && countryOf(ip)) || 'unknown';
      if (code === 'ZZ') code = 'unknown';
    }
    totals.set(code, (totals.get(code) || 0) + calls);
  }
  return [...totals].map(([code, calls]) => ({
    code: code === 'unknown' ? null : code,
    name: code === 'unknown' ? 'Unknown' : countryName(code),
    calls,
  })).sort((a, b) => b.calls - a.calls);
}

module.exports = { countriesFor, loadGeo: load };
