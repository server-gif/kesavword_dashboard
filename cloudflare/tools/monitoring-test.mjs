// Offline test suite for the SSH-based Server Monitoring collector (src/serverfacts.js).
//
// NO real SSH is made: the collector's single upstream call is `withSftp(env, k => k.exec(PROBE))`,
// which needs the Cloudflare Workers runtime (cloudflare:sockets) and cannot run under plain Node.
// So these tests cover everything AROUND that one call — the pure parsing/normalization of the
// probe's stdout, the snapshot cache controller (with an injected `collect` standing in for the
// SSH round-trip), the settings validator and the connection-status block — and assert that no
// credential ever leaks into an output. The live SSH round-trip itself and the DOM frontend are
// verified by the real build (node tools/build.mjs), parse checks and a live post-deploy check,
// not here. Reported honestly rather than faked.
//
// Run with:  node tools/monitoring-test.mjs   (or: npm run test:monitoring)

import assert from 'node:assert/strict';
import * as sf from '../src/serverfacts.js';

// ---------- tiny runner ----------
let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err && err.message}`);
    console.log(`  \u2717 ${name} \u2014 ${err && err.message}`);
  }
}

// ---------- fixtures ----------
// A fake secret the env carries; the collector must never surface it in any returned object.
const SECRET_PASS = 'RS6HTv9u7der_SECRET_DO_NOT_LEAK';
const ENV = { SFTP_HOST: '159.89.161.137', SFTP_USER: 'master_qdwphqeydv', SFTP_PASS: SECRET_PASS };
const ENV_NO_CREDS = {};

// Representative probe stdout. Command substitution flattens multi-line sources (meminfo, df) onto
// a single labelled line, exactly as the PROBE in serverfacts.js produces.
const PROBE_STDOUT = [
  '@@HOSTNAME@@ cloud-master-1',
  '@@KERNEL@@ Linux 5.15.0-91-generic',
  '@@OS@@ "Ubuntu 22.04.3 LTS"',
  '@@IP@@ 159.89.161.137 10.66.0.5 172.17.0.1',
  '@@UPTIME@@ 123456',
  '@@LOAD@@ 0.42 0.31 0.20 1/123 4567',
  '@@CORES@@ 2',
  // two /proc/stat 'cpu' samples ~1s apart joined by '|'; designed so busy% = 25.0
  '@@CPU@@ cpu 10 0 10 70 10 0 0 0 0 0|cpu 20 0 25 140 15 0 0 0 0 0',
  '@@MEM@@ MemTotal: 4096000 kB MemAvailable: 1024000 kB',
  '@@DISK@@ /dev/vda1 31457280 12582912 18874368 40% /',
].join('\n');

function fakeStore(initial = {}, { failWrite = false } = {}) {
  const m = new Map(Object.entries(initial));
  return {
    _map: m,
    readCache: async (k) => m.get(k) || null,
    writeCache: async (k, rec) => { if (failWrite) throw new Error('d1 write failed'); m.set(k, rec); },
  };
}

function assertNoSecret(value, where) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  // The password and the master username must never appear in any returned object or message.
  assert.ok(!s.includes(SECRET_PASS), `password leaked in ${where}: ${s}`);
  assert.ok(!s.includes('master_qdwphqeydv'), `username leaked in ${where}: ${s}`);
}

// ---------- start ----------
console.log('\nServer Monitoring (serverfacts.js / SSH) offline tests\n');

// ---------- credentials + status ----------
await test('hasCreds: needs host + user + (pass or key)', () => {
  assert.equal(sf.hasCreds(ENV), true);
  assert.equal(sf.hasCreds({ SFTP_HOST: 'h', SFTP_USER: 'u', SFTP_KEY: 'k' }), true);
  assert.equal(sf.hasCreds(ENV_NO_CREDS), false);
  assert.equal(sf.hasCreds({ SFTP_HOST: 'h' }), false);
  assert.equal(sf.hasCreds({ SFTP_HOST: 'h', SFTP_USER: 'u' }), false);
  assert.equal(sf.hasCreds(null), false);
});

await test('statusBlock: creds present but never verified -> connected false', () => {
  const s = sf.statusBlock(ENV);
  assert.equal(s.tokenSet, true);
  assert.equal(s.connected, false); // this fresh module has not completed a probe yet
  assert.equal(s.connectionVerifiedAt, null);
});

await test('statusBlock: no creds -> tokenSet false', () => {
  const s = sf.statusBlock(ENV_NO_CREDS);
  assert.equal(s.tokenSet, false);
  assert.equal(s.connected, false);
});

// ---------- parseRecords ----------
await test('parseRecords: splits labelled lines into a KEY map', () => {
  const rec = sf.parseRecords(PROBE_STDOUT);
  assert.equal(rec.HOSTNAME, 'cloud-master-1');
  assert.equal(rec.OS, '"Ubuntu 22.04.3 LTS"');
  assert.equal(rec.MEM, 'MemTotal: 4096000 kB MemAvailable: 1024000 kB');
  assert.equal(rec.DISK, '/dev/vda1 31457280 12582912 18874368 40% /');
});

await test('parseRecords: ignores noise and empty input safely', () => {
  assert.deepEqual(sf.parseRecords(''), {});
  assert.deepEqual(sf.parseRecords(null), {});
  const rec = sf.parseRecords('some shell banner\n@@CORES@@ 4\ntrailing');
  assert.equal(rec.CORES, '4');
  assert.equal(rec.BANNER, undefined);
});

// ---------- normalizeHost ----------
await test('normalizeHost: full probe -> real metrics, GB/MB, ips, provider', () => {
  const h = sf.normalizeHost(sf.parseRecords(PROBE_STDOUT), ENV);
  assert.equal(h.id, sf.HOST_ID);
  assert.equal(h.name, 'cloud-master-1');
  assert.equal(h.hostname, 'cloud-master-1');
  assert.equal(h.provider, 'Cloudways (DigitalOcean Droplet)');
  assert.equal(h.status, 'RUNNING');
  assert.equal(h.os, 'Ubuntu 22.04.3 LTS'); // quotes stripped
  assert.equal(h.kernel, 'Linux 5.15.0-91-generic');
  assert.equal(h.publicIp, '159.89.161.137'); // the address the dashboard already dials
  assert.equal(h.internalIp, '10.66.0.5'); // private interface ip, picked even though public is listed first
  assert.equal(h.vcpus, 2);
  assert.equal(h.memoryGb, 3.91); // 4000 MB / 1024
  assert.equal(h.diskGb, 30);
  const m = h.metrics;
  assert.equal(m.uptimeSeconds, 123456);
  assert.equal(m.load1, 0.42); assert.equal(m.load5, 0.31); assert.equal(m.load15, 0.2);
  assert.equal(m.cpuPct, 25); // (1 - 75/100) * 100 over the sample delta
  assert.equal(m.cores, 2);
  assert.equal(m.memory.totalMb, 4000);
  assert.equal(m.memory.availMb, 1000);
  assert.equal(m.memory.usedMb, 3000);
  assert.equal(m.memory.usedPct, 75);
  assert.equal(m.disk.totalGb, 30);
  assert.equal(m.disk.usedGb, 12);
  assert.equal(m.disk.availGb, 18);
  assert.equal(m.disk.usedPct, 40);
  assert.equal(m.disk.mount, '/');
  assertNoSecret(h, 'host object');
});

await test('normalizeHost: os falls back to kernel when os-release missing', () => {
  const h = sf.normalizeHost({ HOSTNAME: 'x', KERNEL: 'Linux 6.1.0' }, ENV);
  assert.equal(h.os, 'Linux 6.1.0');
});

await test('normalizeHost: missing sources are null, never a fabricated 0', () => {
  const h = sf.normalizeHost({ HOSTNAME: 'solo' }, ENV); // only hostname known
  assert.equal(h.name, 'solo');
  assert.equal(h.os, null);
  assert.equal(h.kernel, null);
  assert.equal(h.internalIp, null);
  assert.equal(h.vcpus, null);
  assert.equal(h.memoryGb, null);
  assert.equal(h.diskGb, null);
  assert.equal(h.metrics.uptimeSeconds, null);
  assert.equal(h.metrics.load1, null);
  assert.equal(h.metrics.cpuPct, null);
  assert.equal(h.metrics.memory.usedPct, null);
  assert.equal(h.metrics.disk.totalGb, null);
  for (const v of [h.vcpus, h.memoryGb, h.diskGb, h.metrics.load1]) assert.notEqual(v, 0);
  // publicIp still reflects the configured host (non-secret by design)
  assert.equal(h.publicIp, '159.89.161.137');
});

await test('normalizeHost: blank env -> publicIp null, still no crash', () => {
  const h = sf.normalizeHost({ HOSTNAME: 'a' }, {});
  assert.equal(h.publicIp, null);
});

await test('normalizeHost: default name when hostname missing', () => {
  const h = sf.normalizeHost({}, ENV);
  assert.equal(h.name, 'this server');
  assert.equal(h.hostname, null);
});

// ---------- parseId ----------
await test('parseId: accepts positive ints, rejects the rest', () => {
  assert.equal(sf.parseId('123'), 123);
  assert.equal(sf.parseId(42), 42);
  for (const bad of ['abc', '-1', '0', '1.5', '', 'null']) {
    assert.throws(() => sf.parseId(bad), (e) => e instanceof sf.MonitorError && e.status === 400, `should reject ${bad}`);
  }
});

// ---------- cache controller (collect injected to stand in for the SSH round-trip) ----------
await test('cache: live -> L1 hit -> fresh bypass', async () => {
  const host = sf.normalizeHost(sf.parseRecords(PROBE_STDOUT), ENV);
  let clock = 1000;
  let calls = 0;
  const collect = async () => { calls++; return { host, fetchedAt: clock }; };
  const store = fakeStore();
  const cache = sf.createHostCache({ readCache: store.readCache, writeCache: store.writeCache, collect, now: () => clock });

  const a = await cache.load('k', ENV);
  assert.equal(a.source, 'live');
  assert.equal(a.snapshotSaved, true);
  assert.equal(a.servers.length, 1);

  const b = await cache.load('k', ENV);
  assert.equal(b.source, 'cache');
  assert.equal(b.stale, false);
  assert.equal(calls, 1); // served from L1, no new round-trip

  const c = await cache.load('k', ENV, { fresh: true });
  assert.equal(c.source, 'live');
  assert.equal(calls, 2); // fresh bypasses L1
});

await test('cache: concurrent fresh loads de-dupe to one round-trip', async () => {
  const host = sf.normalizeHost(sf.parseRecords(PROBE_STDOUT), ENV);
  let calls = 0;
  const collect = async () => { calls++; return { host, fetchedAt: 5000 }; };
  const store = fakeStore();
  const cache = sf.createHostCache({ readCache: store.readCache, writeCache: store.writeCache, collect });
  const [x, y] = await Promise.all([cache.load('k', ENV, { fresh: true }), cache.load('k', ENV, { fresh: true })]);
  assert.equal(calls, 1);
  assert.deepEqual(x.servers, y.servers);
});

await test('cache: serves stale last-good when the server fails after a prior success', async () => {
  const host = sf.normalizeHost(sf.parseRecords(PROBE_STDOUT), ENV);
  let broken = false;
  const collect = async () => {
    if (broken) throw new sf.MonitorError(502, 'Could not reach the server over SSH just now.');
    return { host, fetchedAt: 777 };
  };
  const store = fakeStore();
  const cache = sf.createHostCache({ readCache: store.readCache, writeCache: store.writeCache, collect });
  const first = await cache.load('k', ENV);
  assert.equal(first.source, 'live');
  broken = true;
  const second = await cache.load('k', ENV, { fresh: true });
  assert.equal(second.source, 'stale');
  assert.equal(second.stale, true);
  assert.equal(second.servers.length, 1);
  assert.equal(second.refreshedAt, 777); // real prior timestamp, not "now"
  assert.match(second.error, /reach the server over SSH/i);
  assertNoSecret(second, 'stale result');
});

await test('cache: no fabricated snapshot before any success (cold start, SSH down)', async () => {
  const collect = async () => { throw new sf.MonitorError(502, 'Could not reach the server over SSH just now.'); };
  const store = fakeStore();
  const cache = sf.createHostCache({ readCache: store.readCache, writeCache: store.writeCache, collect });
  const r = await cache.load('k', ENV);
  assert.equal(r.source, 'error');
  assert.equal(r.unavailable, true);
  assert.equal(r.stale, false);
  assert.deepEqual(r.servers, []);
  assert.equal(r.refreshedAt, null);
  assertNoSecret(r, 'unavailable result');
});

await test('cache: durable D1 last-good survives cold start and is served stale on failure', async () => {
  const host = sf.normalizeHost(sf.parseRecords(PROBE_STDOUT), ENV);
  const store = fakeStore({ k: { at: 123456, data: { host } } });
  const collect = async () => { throw new sf.MonitorError(502, 'ssh down'); };
  const cache = sf.createHostCache({ readCache: store.readCache, writeCache: store.writeCache, collect });
  const r = await cache.load('k', ENV, { fresh: true });
  assert.equal(r.source, 'stale');
  assert.equal(r.refreshedAt, 123456);
  assert.equal(r.servers.length, 1);
});

await test('cache: snapshot-write failure -> live data + snapshotSaved:false', async () => {
  const host = sf.normalizeHost(sf.parseRecords(PROBE_STDOUT), ENV);
  const collect = async () => ({ host, fetchedAt: 999 });
  const store = fakeStore({}, { failWrite: true });
  const cache = sf.createHostCache({ readCache: store.readCache, writeCache: store.writeCache, collect });
  const r = await cache.load('k', ENV, { fresh: true });
  assert.equal(r.source, 'live');
  assert.equal(r.servers.length, 1);
  assert.equal(r.snapshotSaved, false);
});

// ---------- sample shapes ----------
await test('toSample / downSample: capture metrics from a host, nulls on down', () => {
  const host = sf.normalizeHost(sf.parseRecords(PROBE_STDOUT), ENV);
  const NOW = 1700000000000;
  const s = sf.toSample(host, NOW);
  assert.equal(s.up, true);
  assert.equal(s.t, NOW);
  assert.equal(s.cpu, 25);
  assert.equal(s.load1, 0.42);
  assert.equal(s.memPct, 75);
  assert.equal(s.diskPct, 40);
  assert.deepEqual(sf.downSample(NOW), { t: NOW, up: false, cpu: null, load1: null, memPct: null, diskPct: null });
});

// ---------- appendSample / loadSamples (D1 cache ring) ----------
await test('appendSample: stores, orders, prunes stale window, survives no write errors', async () => {
  const NOW = 1700000000000;
  const day = 86400000;
  const store = fakeStore();
  const hist = { readCache: store.readCache, writeCache: store.writeCache };
  await sf.appendSample(hist, { t: NOW - 1000, up: true, cpu: 10 }, { now: NOW });
  let l = await sf.loadSamples(hist);
  assert.equal(l.length, 1);
  // an older-than-window sample is filtered out
  await sf.appendSample(hist, { t: NOW - 9 * day, up: true }, { now: NOW });
  l = await sf.loadSamples(hist);
  assert.equal(l.length, 1);
  // multiple samples stay sorted by time
  await sf.appendSample(hist, { t: NOW - 500, up: false }, { now: NOW });
  l = await sf.loadSamples(hist);
  assert.equal(l.length, 2);
  assert.ok(l[0].t < l[1].t);
  assertNoSecret(store._map.get(sf.HISTORY_KEY), 'history row');
});

await test('appendSample: write failure is swallowed (history is best-effort)', async () => {
  const store = fakeStore({}, { failWrite: true });
  const hist = { readCache: store.readCache, writeCache: store.writeCache };
  const res = await sf.appendSample(hist, { t: Date.now(), up: true }, { now: Date.now() });
  assert.ok(Array.isArray(res)); // returns the in-memory list even when the write fails
});

// ---------- buildHealth (pure, deterministic) ----------
await test('buildHealth: empty -> unknown, no uptime, blank strip', () => {
  const NOW = 1700000000000;
  const b = sf.buildHealth([], NOW);
  assert.equal(b.hasData, false);
  assert.equal(b.status, 'unknown');
  assert.equal(b.count, 0);
  assert.equal(b.uptime['24h'], null);
  assert.equal(b.uptime['7d'], null);
  assert.deepEqual(b.events, []);
  assert.equal(b.strip.length, 48);
  assert.ok(b.strip.every((v) => v === null));
});

await test('buildHealth: all-up window -> 100% with honest coverage', () => {
  const day = 86400000, hr = 3600000;
  const NOW = 1700000000000;
  const b = sf.buildHealth([{ t: NOW - 6 * hr, up: true }, { t: NOW - hr, up: true }], NOW);
  assert.equal(b.status, 'up');
  assert.equal(b.uptime['24h'].pct, 100);
  assert.equal(b.uptime['24h'].coverageMs, 6 * hr); // only the observed span counts, never the empty 18h
  assert.deepEqual(b.events, []);
});

await test('buildHealth: half up / half down -> 50% + a down event', () => {
  const day = 86400000, hr = 3600000;
  const NOW = 1700000000000;
  const b = sf.buildHealth([{ t: NOW - day, up: true }, { t: NOW - 12 * hr, up: false }], NOW);
  assert.equal(b.status, 'down');
  assert.equal(b.uptime['24h'].pct, 50);
  assert.equal(b.uptime['24h'].coverageMs, day);
  assert.equal(b.events.length, 1);
  assert.equal(b.events[0].up, false);
  assert.equal(b.strip[0], 1);   // oldest bucket was up
  assert.equal(b.strip[24], 0);  // middle bucket (12h back) went down
});

await test('buildHealth: transitions list is most-recent-first', () => {
  const NOW = 1700000000000;
  const b = sf.buildHealth([
    { t: NOW - 300000, up: true }, { t: NOW - 200000, up: false }, { t: NOW - 100000, up: true },
  ], NOW);
  assert.equal(b.events.length, 2);
  assert.equal(b.events[0].up, true); // the later flip first
  assert.equal(b.events[1].up, false);
});

// ---------- time-series (built only from real samples) ----------
await test('buildSeries: empty -> 24 buckets all null (never fabricated)', () => {
  const NOW = 1700000000000;
  const g = sf.buildSeries([], NOW);
  assert.equal(g.length, 24);
  assert.ok(g.every((b) => b.cpu.avg === null && b.cpu.n === 0 && b.mem.avg === null && b.disk.avg === null));
});

await test('buildSeries: averages readings within an hour and records the max', () => {
  const NOW = 1700000000000;
  const t = NOW - 1500000; // same hour for all three
  const g = sf.buildSeries([
    { t, cpu: 10, memPct: 50, diskPct: 40, load1: 0.5 },
    { t: t + 20000, cpu: 30, memPct: 60, diskPct: 40, load1: 0.7 },
    { t: t + 40000, cpu: 20, memPct: 70, diskPct: 40, load1: 0.6 },
  ], NOW);
  const bucket = g[23]; // most recent hour
  assert.equal(bucket.cpu.n, 3);
  assert.equal(bucket.cpu.avg, 20); // (10+30+20)/3
  assert.equal(bucket.cpu.max, 30);
  assert.equal(bucket.mem.avg, 60); // (50+60+70)/3
  assert.equal(bucket.disk.avg, 40);
});

await test('buildSeries: down samples (null metrics) do not create a fake reading', () => {
  const NOW = 1700000000000;
  const g = sf.buildSeries([{ t: NOW - 60000, up: false, cpu: null, memPct: null, diskPct: null, load1: null }], NOW);
  const last = g[23];
  assert.equal(last.cpu.n, 0);
  assert.equal(last.cpu.avg, null);
  assert.equal(last.mem.avg, null);
});

await test('buildSeries: ignores samples older than the 24h window', () => {
  const NOW = 1700000000000;
  const g = sf.buildSeries([{ t: NOW - 30 * 3600000, cpu: 90, memPct: 90, diskPct: 90 }], NOW);
  assert.ok(g.every((b) => b.cpu.n === 0));
});

await test('hostTotals: reports real capacity, null when absent', () => {
  const host = { metrics: { cores: 2, memory: { totalMb: 4000 }, disk: { totalGb: 30 } } };
  assert.deepEqual(sf.hostTotals(host), { cores: 2, memTotalGb: 3.9, diskTotalGb: 30 });
  assert.deepEqual(sf.hostTotals(null), { cores: null, memTotalGb: null, diskTotalGb: null });
  assert.deepEqual(sf.hostTotals({ metrics: {} }), { cores: null, memTotalGb: null, diskTotalGb: null });
});

await test('buildHealth: includes a 24-bucket series and passes totals through', () => {
  const NOW = 1700000000000;
  const b = sf.buildHealth([{ t: NOW - 60000, up: true, cpu: 12, memPct: 55, diskPct: 33, load1: 0.4 }], NOW, { cores: 2, memTotalGb: 3.9, diskTotalGb: 30 });
  assert.equal(b.series.length, 24);
  assert.equal(b.series[23].cpu.avg, 12);
  assert.deepEqual(b.totals, { cores: 2, memTotalGb: 3.9, diskTotalGb: 30 });
  assert.equal(sf.buildHealth([], NOW).totals, null);
});

// ---------- settings validation ----------
await test('settings: defaults shape + empty round-trip returns defaults', () => {
  assert.deepEqual(sf.DEFAULT_SETTINGS, { refreshSeconds: 60, defaultRange: '7d', regionFilter: '', notify: { email: false } });
  assert.deepEqual(sf.validateSettings({}), sf.DEFAULT_SETTINGS);
});

await test('settings: valid partial update sanitizes', () => {
  const r = sf.validateSettings({ refreshSeconds: '90', defaultRange: '1h', regionFilter: '  bang1  ', notify: { email: 'yes', bogus: 1 } });
  assert.equal(r.refreshSeconds, 90);
  assert.equal(r.defaultRange, '1h');
  assert.equal(r.regionFilter, 'bang1');
  assert.deepEqual(r.notify, { email: true });
});

await test('settings: invalid refreshSeconds rejected', () => {
  for (const bad of [0, 29, 301, 60.5, 'abc', null, NaN]) {
    assert.throws(() => sf.validateSettings({ refreshSeconds: bad }), (e) => e instanceof sf.MonitorError && e.status === 400, `reject ${bad}`);
  }
  assert.equal(sf.validateSettings({ refreshSeconds: 30 }).refreshSeconds, 30);
  assert.equal(sf.validateSettings({ refreshSeconds: 300 }).refreshSeconds, 300);
});

await test('settings: invalid defaultRange + oversized regionFilter rejected', () => {
  assert.throws(() => sf.validateSettings({ defaultRange: '30d' }), (e) => e.status === 400);
  assert.throws(() => sf.validateSettings({ regionFilter: 'x'.repeat(65) }), (e) => e.status === 400);
});

await test('settings: invalid notify shape rejected', () => {
  assert.throws(() => sf.validateSettings({ notify: 'on' }), (e) => e.status === 400);
  assert.throws(() => sf.validateSettings({ notify: [1, 2] }), (e) => e.status === 400);
});

await test('settings: describeSettingsChange is non-sensitive + no secrets', () => {
  const next = sf.validateSettings({ refreshSeconds: 120, defaultRange: '24h', regionFilter: 'NYC3', notify: { email: true } });
  const d = sf.describeSettingsChange(sf.DEFAULT_SETTINGS, next);
  assert.match(d, /refresh 60s\u2192120s/);
  assert.match(d, /email alerts on/);
  assertNoSecret(d, 'audit summary');
});

// ---------- regression / surface ----------
await test('regression: module exposes the helpers the routes rely on and holds no secret', () => {
  for (const fn of ['hasCreds', 'statusBlock', 'parseRecords', 'normalizeHost', 'collectHost', 'getHost', 'createHostCache', 'toSample', 'downSample', 'appendSample', 'loadSamples', 'buildHealth', 'buildSeries', 'hostTotals', 'validateSettings', 'describeSettingsChange', 'parseId']) {
    assert.equal(typeof sf[fn], 'function', `${fn} should be exported`);
  }
  assert.ok(!('SFTP_PASS' in sf) && !('SFTP_USER' in sf) && !('SFTP_HOST' in sf), 'module never hardcodes credentials');
  assert.ok(!('CLOUDWAYS_API_KEY' in sf) && !('CLOUDWAYS_EMAIL' in sf), 'no dead Cloudways surface');
  assert.equal(sf.HOST_ID, 1);
  assert.equal(sf.REFRESH_MIN, 30);
  assert.equal(sf.REFRESH_MAX, 300);
});

// connection-verified flag becomes true only after a real collectHost success (which needs the
// Workers runtime), so at module level here it stays unverified — asserted above.
await test('connectionVerifiedAt: reflects no probe success in this offline run', () => {
  assert.equal(sf.connectionVerifiedAt(), 0);
});

// ---------- report ----------
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
} else {
  console.log('ALL TESTS PASSED');
}
