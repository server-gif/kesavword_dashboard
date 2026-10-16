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
  for (const fn of ['hasCreds', 'statusBlock', 'parseRecords', 'normalizeHost', 'collectHost', 'getHost', 'createHostCache', 'validateSettings', 'describeSettingsChange', 'parseId']) {
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
