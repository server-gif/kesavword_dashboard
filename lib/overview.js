// Traffic overview from the web server's own logs (read-only).
// Logs are summarised ON the server with awk, so only a few KB travel back instead of
// hundreds of MB of log.
//
// Days follow the owner's time zone (TIMEZONE, default Asia/Kolkata), not the server's UTC day.
// Logs rotate at 00:00 UTC (".1", then ".2.gz" … ".30.gz"), so a local day spans two files;
// awk keeps only the lines inside the requested window.
const path = require('path');
const { getClient, withSftp, getHome } = require('./sftp');
const { countriesFor } = require('./geo');

const posix = path.posix;
const DAY = 86400000;
const TIMEZONE = (process.env.TIMEZONE || 'Asia/Kolkata').trim();
const PERIODS = ['today', 'yesterday', '7d', '30d'];

// ---------- time zone helpers ----------

function zonedParts(ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), min: get('minute'), s: get('second') };
}

// Minutes the zone is ahead of UTC at that moment (330 for Asia/Kolkata).
function offsetMinutes(ms) {
  const p = zonedParts(ms);
  return Math.round((Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(ms / 1000) * 1000) / 60000);
}

// UTC ms of local midnight for the local day containing `ms`.
function localDayStart(ms) {
  const p = zonedParts(ms);
  const guess = Date.UTC(p.y, p.m - 1, p.d);
  return guess - offsetMinutes(guess) * 60000;
}

// ms -> "YYYYMMDDHHMMSS" in UTC, the same shape awk builds from each log line.
const awkKey = (ms) => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14);
const parseKey = (k) => (/^\d{14}$/.test(k || '')
  ? Date.UTC(+k.slice(0, 4), +k.slice(4, 6) - 1, +k.slice(6, 8), +k.slice(8, 10), +k.slice(10, 12), +k.slice(12, 14))
  : null);

// The window a period covers, how it is bucketed, and what it is compared with.
function periodWindow(period, now = Date.now()) {
  const today = localDayStart(now);
  const daysBack = (n) => localDayStart(today - n * DAY + 12 * 3600000);
  switch (period) {
    case 'yesterday':
      return { from: daysBack(1), to: today, size: 3600, buckets: 24, compare: null };
    case '7d':
      return { from: daysBack(6), to: now + 60000, size: 86400, buckets: 7, compare: { from: daysBack(13), to: daysBack(6) } };
    case '30d':
      return { from: daysBack(29), to: now + 60000, size: 86400, buckets: 30, compare: null };
    default: // today, compared with yesterday up to the same time
      return { from: today, to: now + 60000, size: 3600, buckets: zonedParts(now).h + 1, compare: { from: daysBack(1), to: daysBack(1) + (now - today) } };
  }
}

// Rotated files that can hold lines between `from` and `to` (oldest first). Missing ones are skipped later.
function logFiles(base, from, to, now = Date.now()) {
  const utcDay = (ms) => Math.floor(ms / DAY);
  const first = utcDay(now) - utcDay(from);
  const last = Math.max(0, utcDay(now) - utcDay(Math.min(to, now) - 1));
  const out = [];
  for (let i = Math.min(first, 30); i >= last; i--) out.push(i === 0 ? base : i === 1 ? `${base}.1` : `${base}.${i}.gz`);
  return out;
}

// ---------- running awk on the server ----------

function exec(cmd) {
  return getClient().then((c) => new Promise((resolve, reject) => {
    c.client.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      let errOut = '';
      const timer = setTimeout(() => { stream.close(); reject(new Error('Log summary timed out')); }, 120000);
      stream.on('data', (d) => { out += d; });
      stream.stderr.on('data', (d) => { errOut += d; });
      stream.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(errOut.trim() || `awk exited with ${code}`));
        resolve(out);
      });
      stream.end();
    });
  }));
}

// When SFTP is locked into the user's home (Cloudways: the SFTP "/" is the SSH user's $HOME),
// the shell sees "/applications/…" as "$HOME/applications/…". Without that lock the paths are the same.
const SAFE_PATH = /^\/[\w./-]+$/;
const shellPath = (p) => (getHome() === '/' ? `"$HOME${p}"` : `"${p}"`);

function catFiles(files) {
  for (const f of files) if (!SAFE_PATH.test(f)) throw new Error(`Unsupported log path: ${f}`);
  return `for f in ${files.map(shellPath).join(' ')}; do [ -f "$f" ] && zcat -f "$f"; done`;
}

// Plain arithmetic for UTC seconds (days-from-civil), so any awk works — mktime() is gawk-only.
const MONTH_MAP = String.raw`
function utc(y, m, d, H, M, S,   a, yy, mm) {
  a = int((14 - m) / 12); yy = y + 4800 - a; mm = m + 12 * a - 3
  return (d + int((153 * mm + 2) / 5) + 365 * yy + int(yy / 4) - int(yy / 100) + int(yy / 400) - 32045 - 2440588) * 86400 + H * 3600 + M * 60 + S
}
BEGIN {
  split("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec", mn, " ")
  for (i = 1; i <= 12; i++) mon[mn[i]] = sprintf("%02d", i)
}`;

// ts = "[13/Oct/2026:13:18:13" -> key "20261013131813" and UTC epoch seconds.
const KEY = String.raw`
  key = substr(ts, 9, 4) mon[substr(ts, 5, 3)] substr(ts, 2, 2) substr(ts, 14, 2) substr(ts, 17, 2) substr(ts, 20, 2)`;
const TIME_PARTS = `${KEY}
  if (key < from || key >= to) next`;
const EPOCH = String.raw`
  ep = utc(substr(ts, 9, 4) + 0, mon[substr(ts, 5, 3)] + 0, substr(ts, 2, 2) + 0, substr(ts, 14, 2) + 0, substr(ts, 17, 2) + 0, substr(ts, 20, 2) + 0)
  b = int((ep - fromEp) / size)`;

// PHP-FPM access line (Cloudways):
// IP - [13/Oct/2026:13:18:13 +0000] "POST /api/x.php" 200 1434 - … 0.095 2097152 42.26% 0.00% "/api/x.php?q=1"
//                                                  status        duration(s) memory cpu         request
// Passed inline in single quotes, so these programs must never contain a single quote.
const ACCESS_AWK = `${MONTH_MAP}
{
  if (!match($0, /" [0-9][0-9][0-9] /)) next
  ts = $3
  ${KEY}
  if ((key < from || key >= to) && (cfrom == "" || key < cfrom || key >= cto)) next
  status = substr($0, RSTART + 2, 3) + 0
  script = $NF; gsub(/"/, "", script); sub(/\\?.*/, "", script)
  if (want != "" && script != want) next
  dur = $(NF - 4) + 0
  # the comparison window (e.g. the 7 days before) is counted in the same pass
  if (cfrom != "" && key >= cfrom && key < cto) { cn++; ctot += dur; if (status >= 500) c5++ }
  if (key < from || key >= to) next
  n++; tot += dur
  if (status >= 500) t5++; else if (status >= 400) t4++; else if (status >= 300) t3++; else t2++
  if (first == "" || key < first) first = key
  if (key > last) last = key
  ip[$1] = 1
  if (geo) { gp = $1; if (index(gp, ":")) gp = "v6"; else sub(/\\.[0-9]+$/, "", gp); pc[gp]++ }
  if (totalsOnly) next
  ${EPOCH}
  h[b]++; hd[b] += dur; if (status >= 500) he[b]++; if (dur > hm[b]) hm[b] = dur
  if (want != "") next
  c[script]++; d[script] += dur; if (dur > mx[script]) mx[script] = dur
  if (status >= 500) e5[script]++; else if (status >= 400) e4[script]++
  if (perScript) sb[script SUBSEP b]++
}
END {
  u = 0; for (k in ip) u++
  printf "T\\t%d\\t%d\\t%d\\t%.4f\\t%d\\t%s\\t%s\\t%d\\t%d\\n", n, t5, t4, tot, u, first, last, t2, t3
  if (cfrom != "") printf "C\\t%d\\t%d\\t%.4f\\n", cn, c5, ctot
  if (totalsOnly) exit
  if (geo) for (k in pc) printf "G\\t%s\\t%d\\n", k, pc[k]
  for (k in h) printf "H\\t%d\\t%d\\t%d\\t%.4f\\t%.4f\\n", k, h[k], he[k] + 0, hd[k], hm[k]
  for (k in c) printf "S\\t%s\\t%d\\t%d\\t%d\\t%.4f\\t%.4f\\n", k, c[k], e5[k] + 0, e4[k] + 0, d[k], mx[k]
  for (k in sb) { split(k, kk, SUBSEP); printf "B\\t%s\\t%d\\t%d\\n", kk[1], kk[2], sb[k] }
}`;

// Web server access line, which carries the user agent:
// IP - - [13/Oct/2026:13:18:13 +0000] "POST /api/x.php HTTP/1.1" 200 1027 "-" "Dalvik/2.1.0 (Linux; U; Android 12; V2204 Build/…)"
const CLIENTS_AWK = `${MONTH_MAP}
{
  ts = $4
  if (substr(ts, 1, 1) != "[") next
  ${TIME_PARTS}
  if (!match($0, /"[A-Z]+ [^ "]+ HTTP\\/[0-9.]+"/)) next
  req = substr($0, RSTART + 1, RLENGTH - 2)
  split(req, rp, " "); p = rp[2]; sub(/\\?.*/, "", p)
  if (p != want) next
  nq = split($0, q, "\\""); ua = q[nq - 1]
  n++
  if (ua ~ /^Dalvik/) kind = "Android app"
  else if (ua ~ /UnityPlayer/) kind = "Unity game"
  else if (ua ~ /okhttp/) kind = "Android app (okhttp)"
  else if (ua ~ /Mozilla/) kind = "Web browser"
  else if (ua == "-" || ua == "") kind = "No user agent"
  else { kind = ua; sub(/[\\/ (].*/, "", kind) }
  K[kind]++
  if (match(ua, /Android [0-9]+/)) A[substr(ua, RSTART + 8, RLENGTH - 8)]++
  if (match(ua, /; [^;()]+ Build\\//)) M[substr(ua, RSTART + 2, RLENGTH - 9)]++
}
END {
  printf "N\\t%d\\n", n
  for (k in K) printf "K\\t%s\\t%d\\n", k, K[k]
  for (k in A) printf "A\\t%s\\t%d\\n", k, A[k]
  for (k in M) printf "M\\t%s\\t%d\\n", k, M[k]
}`;
for (const p of [ACCESS_AWK, CLIENTS_AWK]) if (p.includes("'")) throw new Error('awk program must not contain single quotes');

async function summarise(files, { from, to, size = 3600, want = '', perScript = false, totalsOnly = false, compare = null, geo = false }) {
  if (want && !SAFE_PATH.test(want)) throw new Error('This API path has characters that cannot be analysed');
  const cmp = compare ? `-v cfrom=${awkKey(compare.from)} -v cto=${awkKey(compare.to)} ` : '';
  const out = await exec(
    `${catFiles(files)} | awk -v from=${awkKey(from)} -v to=${awkKey(to)} -v fromEp=${Math.floor(from / 1000)} ${cmp}`
    + `-v size=${size} -v want='${want}' -v perScript=${perScript ? 1 : 0} -v totalsOnly=${totalsOnly ? 1 : 0} -v geo=${geo ? 1 : 0} '${ACCESS_AWK}'`
  );
  const res = { totals: null, compare: null, buckets: [], scripts: [], scriptBuckets: new Map(), geo: new Map() };
  for (const line of out.split('\n')) {
    const f = line.split('\t');
    if (f[0] === 'T') {
      res.totals = {
        requests: +f[1], errors5xx: +f[2], errors4xx: +f[3], seconds: +f[4], uniqueIps: +f[5],
        first: parseKey(f[6]), last: parseKey(f[7]), ok2xx: +f[8], redirects3xx: +f[9],
      };
    } else if (f[0] === 'G') {
      res.geo.set(f[1], +f[2]);
    } else if (f[0] === 'C') {
      res.compare = { totals: { requests: +f[1], errors5xx: +f[2], seconds: +f[3] } };
    } else if (f[0] === 'H') {
      res.buckets.push({ i: +f[1], requests: +f[2], errors: +f[3], seconds: +f[4], maxSeconds: +f[5] });
    } else if (f[0] === 'S') {
      res.scripts.push({ script: f[1], requests: +f[2], errors5xx: +f[3], errors4xx: +f[4], seconds: +f[5], maxSeconds: +f[6] });
    } else if (f[0] === 'B') {
      if (!res.scriptBuckets.has(f[1])) res.scriptBuckets.set(f[1], new Map());
      res.scriptBuckets.get(f[1]).set(+f[2], +f[3]);
    }
  }
  return res;
}

async function summariseClients(files, { from, to, want }) {
  if (!SAFE_PATH.test(want)) throw new Error('This API path has characters that cannot be analysed');
  const out = await exec(`${catFiles(files)} | awk -v from=${awkKey(from)} -v to=${awkKey(to)} -v want='${want}' '${CLIENTS_AWK}'`);
  const res = { total: 0, kinds: [], android: [], models: [] };
  for (const line of out.split('\n')) {
    const f = line.split('\t');
    if (f[0] === 'N') res.total = +f[1];
    else if (f[0] === 'K') res.kinds.push([f[1], +f[2]]);
    else if (f[0] === 'A') res.android.push([f[1], +f[2]]);
    else if (f[0] === 'M') res.models.push([f[1], +f[2]]);
  }
  const byCount = (a, b) => b[1] - a[1];
  res.kinds.sort(byCount);
  res.android.sort(byCount);
  res.models.sort(byCount);
  // Brand from the model name (a best guess from common naming patterns).
  const brands = new Map();
  for (const [model, n] of res.models) brands.set(guessBrand(model), (brands.get(guessBrand(model)) || 0) + n);
  res.brands = [...brands].sort(byCount).slice(0, 12);
  res.models = res.models.slice(0, 15).map(([m, n]) => [m, n, guessBrand(m)]);
  return res;
}

const BRANDS = [
  [/^(SM-|Galaxy)/i, 'Samsung'], [/^RMX/i, 'realme'], [/^(OnePlus|IN20|KB20|LE21|NE22|GM19|HD19)/i, 'OnePlus'],
  [/^CPH/i, 'OPPO'], [/^(V2\d{3}|vivo)/i, 'vivo'], [/^(I2\d{3}|iQOO)/i, 'iQOO'], [/^(moto|motorola|XT\d)/i, 'Motorola'],
  [/^(Redmi|Mi |MI |POCO|M2\d{3}|2\d{3}[0-9A-Z]{5,})/i, 'Xiaomi'], [/^(Infinix|X6\d{2})/i, 'Infinix'], [/^(TECNO|KG\d|CK\d|KI\d)/i, 'TECNO'],
  [/^itel/i, 'itel'], [/^Pixel/i, 'Google'], [/^(LAVA|LZX|LXX)/i, 'Lava'], [/^(Nokia|TA-)/i, 'Nokia'], [/^(Nothing|A0\d{2})/i, 'Nothing'],
  [/^(ASUS|ZS\d)/i, 'ASUS'], [/^(Lenovo|TB-)/i, 'Lenovo'], [/^HUAWEI|^HONOR/i, 'Huawei/Honor'],
];
function guessBrand(model) {
  for (const [re, name] of BRANDS) if (re.test(model)) return name;
  return 'Unknown brand';
}

// ---------- PHP error log ----------

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
// "[Tue Oct 13 13:00:00.785555 2026] … PHP message: PHP Warning:  … in /path.php on line 4" (server time = UTC)
const ERR_LINE = /^\[\w{3} (\w{3}) +(\d+) (\d\d):(\d\d):(\d\d)[.\d]* (\d{4})\]/;
const PHP_MSG = /PHP (Fatal error|Parse error|Warning|Notice|Deprecated):\s+(.+?) in (\/\S+?\.php)(?: on line |:)(\d+)/g;

async function readErrorLines(errorLog, from, to) {
  if (!errorLog) return '';
  try {
    // one extra older file: the error log rotates at a different hour than the access log
    return await exec(`${catFiles(logFiles(errorLog, from - DAY, to))} | grep -F "PHP message:" | tail -n 50000`);
  } catch {
    return ''; // grep exits 1 when nothing matches
  }
}

function parseErrorLog(text, toRootPath, from, to) {
  const groups = new Map();
  for (const line of text.split('\n')) {
    const t = ERR_LINE.exec(line);
    if (!t) continue;
    const ts = Date.UTC(+t[6], MONTHS[t[1]], +t[2], +t[3], +t[4], +t[5]);
    if (ts < from || ts >= to) continue;
    PHP_MSG.lastIndex = 0;
    let m;
    while ((m = PHP_MSG.exec(line))) {
      const message = m[2].replace(/\\n.*$/, '').trim(); // drop the escaped stack trace
      const key = `${m[3]}|${m[4]}|${message}`;
      const g = groups.get(key) || { kind: m[1], message, serverFile: m[3], path: toRootPath(m[3]), line: +m[4], count: 0, lastSeen: 0, times: [] };
      g.count++;
      g.lastSeen = Math.max(g.lastSeen, ts);
      g.times.push(ts);
      groups.set(key, g);
    }
  }
  return [...groups.values()].sort((a, b) => b.lastSeen - a.lastSeen);
}

// ---------- shared shaping ----------

const avgMs = (seconds, n) => (n ? Math.round((seconds / n) * 1000) : 0);

function bucketSeries(win, raw, phpErrors) {
  const byI = new Map(raw.map((x) => [x.i, x]));
  const php = new Array(win.buckets).fill(0);
  for (const e of phpErrors) {
    for (const t of e.times) {
      const i = Math.floor((t - win.from) / (win.size * 1000));
      if (i >= 0 && i < win.buckets) php[i]++;
    }
  }
  const out = [];
  for (let i = 0; i < win.buckets; i++) {
    const x = byI.get(i) || { requests: 0, errors: 0, seconds: 0, maxSeconds: 0 };
    out.push({
      start: win.from + i * win.size * 1000,
      requests: x.requests,
      errors: x.errors,
      phpErrors: php[i],
      avgMs: avgMs(x.seconds, x.requests),
      maxMs: Math.round(x.maxSeconds * 1000),
    });
  }
  return out;
}

const shapeTotals = (t) => ({
  requests: t.requests,
  errors5xx: t.errors5xx,
  errors4xx: t.errors4xx,
  ok2xx: t.ok2xx,
  redirects3xx: t.redirects3xx,
  avgMs: avgMs(t.seconds, t.requests),
  uniqueIps: t.uniqueIps,
});

const shapeCompare = (c) => (c?.totals?.requests ? {
  requests: c.totals.requests,
  errors5xx: c.totals.errors5xx,
  avgMs: avgMs(c.totals.seconds, c.totals.requests),
} : null);

const stripTimes = (errs) => errs.map(({ times, ...rest }) => rest);

async function markMissing(paths, cap = 150) {
  const unique = [...new Set(paths.filter(Boolean))].slice(0, cap);
  return new Map(await Promise.all(unique.map(async (p) => [p, !(await withSftp((c) => c.stat(p)).catch(() => null))])));
}

// ---------- overview ----------

async function buildOverview({ accessLog, errorLog, rootDir, toRootPath, period }) {
  const now = Date.now();
  const win = periodWindow(period, now);
  const multiDay = win.size === 86400;

  // Independent steps run at once — each is a round trip to a far-away server.
  const scanFrom = win.compare ? Math.min(win.from, win.compare.from) : win.from;
  const [main, errText] = await Promise.all([
    summarise(logFiles(accessLog, scanFrom, win.to, now), { from: win.from, to: win.to, size: win.size, perScript: multiDay, compare: win.compare, geo: true }),
    readErrorLines(errorLog, win.from, win.to),
  ]);
  const compare = main.compare;
  const t = main.totals;
  const base = { period, timezone: TIMEZONE, from: win.from, bucket: multiDay ? 'day' : 'hour', generatedAt: now };
  if (!t || !t.requests) return { ...base, empty: true, to: Math.min(win.to, now) };

  const phpErrors = parseErrorLog(errText, toRootPath, win.from, win.to);
  const countries = await countriesFor(main.geo);
  const phpByPath = new Map();
  for (const e of phpErrors) if (e.path) phpByPath.set(e.path, (phpByPath.get(e.path) || 0) + e.count);

  // Trend: compare the recent half of the complete days with the half before (today is partial, so skipped).
  const complete = multiDay ? win.buckets - 1 : 0;
  const half = Math.floor(complete / 2);

  const apis = main.scripts.map((s) => {
    const p = rootDir === '/' ? s.script : posix.join(rootDir, s.script);
    const api = {
      script: s.script,
      path: p,
      requests: s.requests,
      errors5xx: s.errors5xx,
      errors4xx: s.errors4xx,
      avgMs: avgMs(s.seconds, s.requests),
      maxMs: Math.round(s.maxSeconds * 1000),
      phpErrors: phpByPath.get(p) || 0,
    };
    if (multiDay) {
      const days = main.scriptBuckets.get(s.script) || new Map();
      api.daily = Array.from({ length: win.buckets }, (_, i) => days.get(i) || 0);
      if (half) {
        const sum = (a, b) => api.daily.slice(a, b).reduce((x, y) => x + y, 0);
        api.recent = sum(complete - half, complete);
        api.previous = sum(complete - 2 * half, complete - half);
      }
    }
    return api;
  }).sort((a, b) => b.requests - a.requests);

  // URLs that (almost) always answer 4xx are one of two things:
  //  - a real API file that was removed while apps still call it: it sits in one of the site's own
  //    folders and keeps getting called (a missing API — worth a look);
  //  - bots trying file names that never existed (/phpinfo.php, /alfa-rex2.php …) — normal noise.
  const minCalls = { today: 5, yesterday: 5, '7d': 10, '30d': 20 }[period] || 5;
  const mostly4xx = apis.filter((a) => a.errors4xx >= a.requests * 0.9);
  const parents = [...new Set(mostly4xx.map((a) => posix.dirname(a.path)).filter((p) => p !== rootDir))];
  const parentMissing = await markMissing(parents, 400);
  for (const a of mostly4xx) {
    const parent = posix.dirname(a.path);
    const inSiteFolder = parent !== rootDir && parentMissing.get(parent) === false;
    const days = a.daily ? a.daily.filter((x) => x > 0).length : 1;
    a.probe = !(inSiteFolder && (a.requests >= minCalls || days >= 3));
  }
  const missing = await markMissing([
    ...phpErrors.map((e) => e.path),
    ...mostly4xx.filter((a) => !a.probe).map((a) => a.path),
  ], 300);
  for (const a of apis) if (missing.has(a.path)) a.missing = missing.get(a.path);
  for (const e of phpErrors) if (missing.has(e.path)) e.missing = missing.get(e.path);

  return {
    ...base,
    to: multiDay || period === 'today' ? t.last : win.to,
    trendDays: half,
    totals: {
      ...shapeTotals(t),
      apis: apis.filter((a) => !a.probe).length,
      probes: apis.filter((a) => a.probe).length,
      probeCalls: apis.filter((a) => a.probe).reduce((n, a) => n + a.requests, 0),
      phpErrors: phpErrors.reduce((n, e) => n + e.count, 0),
    },
    compare: shapeCompare(compare),
    hours: bucketSeries(win, main.buckets, phpErrors),
    countries,
    apis,
    phpErrors: stripTimes(phpErrors.slice(0, 50)),
  };
}

// ---------- one API in detail ----------

async function buildApiDetail({ accessLog, webLog, errorLog, rootDir, toRootPath, period, script }) {
  if (!SAFE_PATH.test(script)) throw new Error('This API path has characters that cannot be analysed');
  const now = Date.now();
  const win = periodWindow(period, now);
  const apiPath = rootDir === '/' ? script : posix.join(rootDir, script);

  const scanFrom = win.compare ? Math.min(win.from, win.compare.from) : win.from;
  const [main, clients, errText] = await Promise.all([
    summarise(logFiles(accessLog, scanFrom, win.to, now), { from: win.from, to: win.to, size: win.size, want: script, compare: win.compare, geo: true }),
    webLog ? summariseClients(logFiles(webLog, win.from, win.to, now), { from: win.from, to: win.to, want: script }).catch(() => null) : null,
    readErrorLines(errorLog, win.from, win.to),
  ]);
  const compare = main.compare;
  const countries = await countriesFor(main.geo);
  const phpErrors = parseErrorLog(errText, toRootPath, win.from, win.to).filter((e) => e.path === apiPath);
  const exists = !(await markMissing([apiPath])).get(apiPath);
  const t = main.totals;
  return {
    period,
    timezone: TIMEZONE,
    script,
    path: apiPath,
    exists,
    from: win.from,
    to: period === 'yesterday' ? win.to : Math.min(win.to, now),
    bucket: win.size === 86400 ? 'day' : 'hour',
    generatedAt: now,
    totals: t && t.requests ? { ...shapeTotals(t), maxMs: Math.max(0, ...main.buckets.map((b) => Math.round(b.maxSeconds * 1000))), phpErrors: phpErrors.reduce((s, e) => s + e.count, 0) } : null,
    compare: shapeCompare(compare),
    hours: bucketSeries(win, main.buckets, phpErrors),
    clients,
    countries,
    phpErrors: stripTimes(phpErrors.slice(0, 30)),
  };
}

// ---------- log discovery ----------

// <app>/logs next to the website folder: php-app.access.log (timing) and backend_*.access.log (user agents).
async function findLogs(rootDir) {
  const dir = posix.join(posix.dirname(rootDir), 'logs');
  let names;
  try {
    names = (await withSftp((c) => c.list(dir))).map((f) => f.name);
  } catch (err) {
    if (process.env.ACCESS_LOG) names = [];
    else { console.error('Could not read the log folder:', err.message); return null; }
  }
  const pick = (test) => names.find(test);
  const access = process.env.ACCESS_LOG?.trim() || (pick((n) => n === 'php-app.access.log') ? posix.join(dir, 'php-app.access.log') : null);
  const webName = pick((n) => /^backend_.*\.access\.log$/.test(n));
  const web = process.env.WEB_ACCESS_LOG?.trim() || (webName ? posix.join(dir, webName) : null);
  return { access, web };
}

module.exports = { buildOverview, buildApiDetail, findLogs, PERIODS, TIMEZONE };
