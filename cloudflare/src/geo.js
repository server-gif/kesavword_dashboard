// IP -> country using the DB-IP "IP to Country Lite" ranges, loaded into the D1 `geo` table.
// The 100MB CSV cannot be downloaded inside a Worker, so it is converted once locally with
// tools/export-geo.mjs and imported with `wrangler d1 execute`. Lookups are a single indexed
// range query, so nothing leaves Cloudflare and no big file is held in memory.
import { getEnv } from './env.js';

const ipv4ToInt = (ip) => {
  const p = ip.split('.');
  if (p.length !== 4) return -1;
  const n = p.map(Number);
  if (n.some((x) => !(x >= 0 && x <= 255))) return -1;
  return n[0] * 16777216 + n[1] * 65536 + n[2] * 256 + n[3];
};

async function countryOf(ipInt) {
  const row = await getEnv().DB.prepare(
    'SELECT cc FROM geo WHERE start <= ?1 ORDER BY start DESC LIMIT 1'
  ).bind(ipInt).first();
  return row ? row.cc : null;
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
// Returns [{ code, name, calls }] biggest first, or null when the geo table is empty.
export async function countriesFor(prefixCounts) {
  if (!prefixCounts?.size) return [];
  const db = getEnv().DB;
  // Cheap probe: when the geo table is empty/missing, skip per-IP lookups entirely. A busy day
  // has hundreds of /24 prefixes; one D1 query each blows the "too many API requests by single
  // Worker invocation" limit and stalls the page (this is what made /api/overview return 503).
  const probe = await db.prepare('SELECT COUNT(*) AS n FROM geo').first().catch(() => null);
  if (!probe || !probe.n) return null;
  const v4 = [...prefixCounts].filter(([p]) => p !== 'v6');
  const totals = new Map();
  let any = false;
  const add = (code, calls) => totals.set(code, (totals.get(code) || 0) + calls);
  // Batch the range lookups (D1 allows up to 100 statements per batch) so the whole country
  // breakdown costs a handful of API calls instead of hundreds.
  const CHUNK = 90;
  for (let i = 0; i < v4.length; i += CHUNK) {
    const chunk = v4.slice(i, i + CHUNK);
    const ints = chunk.map(([prefix]) => ipv4ToInt(`${prefix}.1`));
    const stmts = ints.map((ip) => db.prepare(
      'SELECT cc FROM geo WHERE start <= ?1 ORDER BY start DESC LIMIT 1'
    ).bind(ip >= 0 ? ip : -1));
    const results = await db.batch(stmts).catch(() => null);
    chunk.forEach(([, calls], j) => {
      if (ints[j] < 0) return add('unknown', calls);
      any = true;
      let code = results?.[j]?.results?.[0]?.cc || 'unknown';
      if (code === 'ZZ') code = 'unknown';
      add(code, calls);
    });
  }
  // geo table not populated yet: report unavailable so the page just hides the country list
  if (!any) return null;
  return [...totals].map(([code, calls]) => ({
    code: code === 'unknown' ? null : code,
    name: code === 'unknown' ? 'Unknown' : countryName(code),
    calls,
  })).sort((a, b) => b.calls - a.calls);
}
