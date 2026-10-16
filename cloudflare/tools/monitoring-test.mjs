// Offline test suite for the Cloudways Server Monitoring client (src/cloudways.js).
//
// No real Cloudways calls are made: globalThis.fetch is mocked per test. The Cloudways API is
// two-step (OAuth access token, then bearer-authenticated resource calls), so the mock routes the
// token endpoint separately from data calls. Run with:
//   node tools/monitoring-test.mjs   (or: npm run test:monitoring)
//
// Scope note: this exercises the pure Cloudways client (auth caching, SSRF-origin guard, shape
// validation, normalization, pagination, error mapping, token/credential redaction), the servers
// snapshot cache controller and the settings validator. Route-level authorization (adminOnly), the
// cookie+CSRF middleware and the DOM frontend are covered by inspection + the real build
// (node tools/build.mjs) + parse checks, not these offline tests (they need the Worker runtime or a
// browser). Reported honestly rather than faked.

import assert from 'node:assert/strict';
import * as cw from '../src/cloudways.js';

// ---------- tiny runner ----------
let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    cw._resetAuth(); // each test starts with a cold token cache
    await fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err && err.message}`);
    console.log(`  \u2717 ${name} \u2014 ${err && err.message}`);
  }
}

// ---------- secrets + fixtures ----------
const EMAIL = 'cw_owner@example.com';
const API_KEY = 'cw_master_key_SECRET_9f3a';
const FAKE_TOKEN = 'access_token_zzz_SECRET_77';
const ENV = { CLOUDWAYS_EMAIL: EMAIL, CLOUDWAYS_API_KEY: API_KEY };
const ENV_NO_CREDS = {};

function makeResponse({ status = 200, data, headers = {} } = {}) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [String(k).toLowerCase(), String(v)]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => (map.has(String(name).toLowerCase()) ? map.get(String(name).toLowerCase()) : null) },
    json: async () => data,
  };
}

const isTokenUrl = (url) => url.includes('/oauth/access_token');
const pageOf = (url) => Number(new URL(url).searchParams.get('page') || 0);
const detailIdOf = (url) => { const m = /\/servers\/(\d+)/.exec(url); return m ? Number(m[1]) : null; };

// Mock that answers the OAuth token call itself, delegating all other (data) calls to dataHandler.
function mockCW(dataHandler, { tokenStatus } = {}) {
  const calls = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, opts });
    if (isTokenUrl(u)) {
      if (tokenStatus) return makeResponse({ status: tokenStatus, data: { message: `bad ${API_KEY}` } });
      return makeResponse({ data: { access_token: FAKE_TOKEN, token_type: 'bearer', expires_in: 3600 } });
    }
    const out = dataHandler(u, opts, calls);
    if (out instanceof Error) throw out;
    return out;
  };
  return {
    calls,
    data: () => calls.filter((c) => !isTokenUrl(c.url)),
    tokens: () => calls.filter((c) => isTokenUrl(c.url)),
    restore() { globalThis.fetch = prev; },
  };
}

function cwServer(i) {
  return {
    id: i,
    name: `web-${i}`,
    server: `159.89.0.${i}`,
    region: 'London',
    provider: 'DigitalOcean',
    status: 'RUNNING',
    os: 'Ubuntu 22.04',
    created: '2024-01-01 00:00:00',
    size: '1 GB',
    cpu_core_count: 1,
    memory_size: 1,
    disk_size: 20,
    labels: ['prod'],
  };
}

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
  for (const secret of [EMAIL, API_KEY, FAKE_TOKEN]) {
    assert.ok(!s.includes(secret), `secret "${secret}" leaked in ${where}: ${s}`);
  }
}

// ---------- start ----------
console.log('\nServer Monitoring (cloudways.js) offline tests\n');

// status before any success: creds set but never verified -> connected false.
await test('status: creds present but unverified -> tokenSet true, connected false', () => {
  const s = cw.statusBlock(ENV);
  assert.equal(s.tokenSet, true);
  assert.equal(s.connected, false);
  assert.equal(s.connectionVerifiedAt, null);
  assert.equal(cw.hasCreds(ENV), true);
  assert.equal(cw.hasCreds(ENV_NO_CREDS), false);
});

await test('status: no creds -> 503 and never fetches', async () => {
  const f = mockCW(() => makeResponse({ data: { servers: [] } }));
  try {
    await assert.rejects(() => cw.listServers(ENV_NO_CREDS), (e) => e instanceof cw.CwError && e.status === 503);
    assert.equal(f.calls.length, 0);
  } finally { f.restore(); }
});

// ---------- OAuth token flow ----------
await test('auth: token is fetched once and reused (bearer) across data calls', async () => {
  const f = mockCW((url) => {
    const id = detailIdOf(url);
    return makeResponse({ data: { server: cwServer(id) } });
  });
  try {
    await cw.getServer(ENV, 1);
    await cw.getServer(ENV, 2);
    assert.equal(f.tokens().length, 1); // only ONE token exchange, cached
    assert.equal(f.data().length, 2);
    for (const c of f.data()) assert.equal(c.opts.headers.Authorization, `Bearer ${FAKE_TOKEN}`);
  } finally { f.restore(); }
});

await test('auth: bad credentials -> 401 safe message, token not cached', async () => {
  const f = mockCW(() => makeResponse({ data: {} }), { tokenStatus: 401 });
  try {
    const err = await cw.getServer(ENV, 1).catch((e) => e);
    assert.ok(err instanceof cw.CwError && err.status === 401);
    assert.match(err.message, /rejected the api credentials/i);
    assertNoSecret(err.message, 'auth error message');
    // a second attempt must re-request a token (nothing was cached)
    await cw.getServer(ENV, 1).catch(() => {});
    assert.ok(f.tokens().length >= 2);
  } finally { f.restore(); }
});

await test('auth: a stale data 401 refreshes the token once and retries', async () => {
  let dataHits = 0;
  const f = mockCW(() => {
    dataHits += 1;
    return makeResponse({ status: 401, data: { message: 'expired' } });
  });
  try {
    const err = await cw.getServer(ENV, 5).catch((e) => e);
    assert.ok(err instanceof cw.CwError && err.status === 401);
    assert.equal(f.tokens().length, 2); // initial + forced refresh
    assert.equal(f.data().length, 2); // original + one retry
  } finally { f.restore(); }
});

// ---------- normalization ----------
await test('normalize: maps Cloudways fields, IP from server/ip keys', () => {
  const n = cw.normalizeServer(cwServer(7));
  assert.equal(n.id, 7);
  assert.equal(n.name, 'web-7');
  assert.equal(n.region, 'London');
  assert.equal(n.provider, 'DigitalOcean');
  assert.equal(n.status, 'RUNNING');
  assert.equal(n.os, 'Ubuntu 22.04');
  assert.equal(n.publicIp, '159.89.0.7');
  assert.equal(n.memoryGb, 1);
  assert.equal(n.diskGb, 20);
  assert.equal(n.vcpus, 1);
  assert.deepEqual(n.labels, ['prod']);
});

await test('normalize: ip preferred from ip over server field', () => {
  const n = cw.normalizeServer({ id: 8, ip: '203.0.113.8', server: 'some-name' });
  assert.equal(n.publicIp, '203.0.113.8');
});

await test('normalize: missing fields are null, never 0', () => {
  const n = cw.normalizeServer({ id: 9 });
  assert.equal(n.name, null);
  assert.equal(n.region, null);
  assert.equal(n.publicIp, null);
  assert.equal(n.status, null);
  assert.equal(n.vcpus, null);
  assert.equal(n.memoryGb, null);
  assert.equal(n.diskGb, null);
  assert.equal(n.labels, null);
  for (const v of [n.vcpus, n.memoryGb, n.diskGb]) assert.notEqual(v, 0);
  const empty = cw.normalizeServer(null);
  assert.equal(empty.id, null);
});

// ---------- pagination + shape ----------
await test('listServers: single short page -> complete inventory', async () => {
  const f = mockCW(() => makeResponse({ data: { servers: [cwServer(1), cwServer(2)] } }));
  try {
    const r = await cw.listServers(ENV, { perPage: 100, maxPages: 5 });
    assert.equal(r.servers.length, 2);
    assert.equal(r.partial, false);
    assert.equal(f.data().length, 1);
  } finally { f.restore(); }
});

await test('listServers: aggregates pages until a short page ends it', async () => {
  const f = mockCW((url) => {
    const p = pageOf(url);
    if (p === 1) return makeResponse({ data: { servers: [cwServer(1), cwServer(2)] } });
    if (p === 2) return makeResponse({ data: { servers: [cwServer(3)] } }); // < perPage -> last page
    return makeResponse({ data: { servers: [] } });
  });
  try {
    const r = await cw.listServers(ENV, { perPage: 2, maxPages: 5 });
    assert.equal(r.servers.length, 3);
    assert.equal(r.partial, false);
    assert.equal(f.data().length, 2);
  } finally { f.restore(); }
});

await test('listServers: page cap is flagged partial (never shown as complete)', async () => {
  const f = mockCW(() => makeResponse({ data: { servers: [cwServer(1), cwServer(2)] } })); // always full
  try {
    const r = await cw.listServers(ENV, { perPage: 2, maxPages: 2 });
    assert.equal(r.servers.length, 4);
    assert.equal(r.partial, true);
    assert.equal(f.data().length, 2);
  } finally { f.restore(); }
});

await test('listServers: empty account is a genuine empty, not an error', async () => {
  const f = mockCW(() => makeResponse({ data: { servers: [] } }));
  try {
    const r = await cw.listServers(ENV);
    assert.deepEqual(r.servers, []);
    assert.equal(r.partial, false);
  } finally { f.restore(); }
});

await test('listServers: unexpected shape -> safe 502, no fabricated data', async () => {
  const f = mockCW(() => makeResponse({ data: { nope: true } }));
  try {
    await assert.rejects(() => cw.listServers(ENV), (e) => e instanceof cw.CwError && e.status === 502);
  } finally { f.restore(); }
});

// ---------- SSRF / origin guard ----------
await test('cwRequest: absolute off-origin URL rejected (400) before any fetch', async () => {
  const f = mockCW(() => makeResponse({ data: {} }));
  try {
    await assert.rejects(() => cw.cwRequest(ENV, 'https://evil.example.com/servers'), (e) => e instanceof cw.CwError && e.status === 400 && /non-cloudways host/i.test(e.message));
    assert.equal(f.calls.length, 0);
  } finally { f.restore(); }
});

// ---------- getServer detail ----------
await test('getServer: normalizes single server', async () => {
  const f = mockCW((url) => makeResponse({ data: { server: cwServer(detailIdOf(url)) } }));
  try {
    const r = await cw.getServer(ENV, '42');
    assert.equal(r.server.id, 42);
    assert.equal(r.server.publicIp, '159.89.0.42');
    assert.ok(r.fetchedAt > 0);
  } finally { f.restore(); }
});

await test('getServer: 404 passes through as CwError 404', async () => {
  const f = mockCW(() => makeResponse({ status: 404, data: { message: 'nope' } }));
  try {
    await assert.rejects(() => cw.getServer(ENV, '999'), (e) => e instanceof cw.CwError && e.status === 404);
  } finally { f.restore(); }
});

await test('parseId: rejects non-positive/non-integer ids', () => {
  for (const bad of ['abc', '-1', '0', '1.5', '', 'null']) {
    assert.throws(() => cw.parseId(bad), (e) => e instanceof cw.CwError && e.status === 400, `should reject ${bad}`);
  }
  assert.equal(cw.parseId('123'), 123);
  assert.equal(cw.parseId(42), 42);
});

// ---------- HTTP error mapping + secret redaction ----------
await test('errors: 403 on data -> permission message, secrets redacted', async () => {
  const f = mockCW(() => makeResponse({ status: 403, data: { message: `secret upstream ${API_KEY}` } }));
  try {
    const err = await cw.listServers(ENV).catch((e) => e);
    assert.ok(err instanceof cw.CwError && err.status === 403);
    assert.match(err.message, /rejected the credentials/i);
    assertNoSecret(err.message, 'error message');
  } finally { f.restore(); }
});

await test('errors: 429 + reset header -> rate-limit message with seconds', async () => {
  const f = mockCW(() => makeResponse({ status: 429, headers: { 'RateLimit-Reset': '37' } }));
  try {
    const err = await cw.listServers(ENV).catch((e) => e);
    assert.ok(err instanceof cw.CwError && err.status === 429);
    assert.match(err.message, /rate limit/i);
    assert.match(err.message, /37s/);
  } finally { f.restore(); }
});

await test('errors: network failure -> 502, timeout -> 504 (safe, redacted)', async () => {
  const f1 = mockCW(() => new Error('socket hang up'));
  try {
    const err = await cw.listServers(ENV).catch((e) => e);
    assert.ok(err instanceof cw.CwError && err.status === 502);
    assert.match(err.message, /could not reach/i);
    assertNoSecret(err.message, 'network message');
  } finally { f1.restore(); }

  const f2 = mockCW(() => Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
  try {
    const err = await cw.listServers(ENV).catch((e) => e);
    assert.ok(err instanceof cw.CwError && err.status === 504);
    assert.match(err.message, /did not respond in time/i);
  } finally { f2.restore(); }
});

await test('secrets: email/key/token never appear in any request URL', async () => {
  const f = mockCW((url) => makeResponse({ data: { server: cwServer(detailIdOf(url) || 1) } }));
  try {
    await cw.getServer(ENV, 3);
    for (const c of f.calls) {
      assertNoSecret(c.url, 'request url');
      assert.equal(new URL(c.url).origin, cw.CW_ORIGIN); // every request stays on the Cloudways origin
    }
  } finally { f.restore(); }
});

// ---------- servers cache controller ----------
await test('cache: live -> L1 cache hit -> fresh bypass', async () => {
  const f = mockCW(() => makeResponse({ data: { servers: [cwServer(1)] } }));
  const store = fakeStore();
  try {
    const cache = cw.createServersCache({ readCache: store.readCache, writeCache: store.writeCache });
    const a = await cache.load('k', ENV);
    assert.equal(a.source, 'live');
    assert.equal(a.snapshotSaved, true);
    const dataAfterFirst = f.data().length;

    const b = await cache.load('k', ENV);
    assert.equal(b.source, 'cache');
    assert.equal(b.stale, false);
    assert.equal(f.data().length, dataAfterFirst); // no new upstream call

    const c = await cache.load('k', ENV, { fresh: true });
    assert.equal(c.source, 'live');
    assert.equal(f.data().length, dataAfterFirst + 1); // fresh bypasses L1
  } finally { f.restore(); }
});

await test('cache: concurrent fresh loads de-dupe to one upstream data call', async () => {
  const f = mockCW(() => makeResponse({ data: { servers: [cwServer(1)] } }));
  const store = fakeStore();
  try {
    const cache = cw.createServersCache({ readCache: store.readCache, writeCache: store.writeCache });
    const [x, y] = await Promise.all([cache.load('k', ENV, { fresh: true }), cache.load('k', ENV, { fresh: true })]);
    assert.equal(f.data().length, 1);
    assert.deepEqual(x.servers, y.servers);
  } finally { f.restore(); }
});

await test('cache: serves stale last-good when Cloudways fails after a prior success', async () => {
  let broken = false;
  const f = mockCW(() => {
    if (broken) throw new Error('boom');
    return makeResponse({ data: { servers: [cwServer(5)] } });
  });
  const store = fakeStore();
  try {
    const cache = cw.createServersCache({ readCache: store.readCache, writeCache: store.writeCache });
    const first = await cache.load('k', ENV);
    assert.equal(first.source, 'live');
    const priorAt = first.refreshedAt;
    broken = true;
    const second = await cache.load('k', ENV, { fresh: true });
    assert.equal(second.source, 'stale');
    assert.equal(second.stale, true);
    assert.equal(second.servers.length, 1);
    assert.equal(second.refreshedAt, priorAt); // real prior timestamp, not "now"
    assert.ok(/could not load|reach|cloudways/i.test(second.error));
    assertNoSecret(second.error, 'stale error');
  } finally { f.restore(); }
});

await test('cache: no fabricated snapshot before any success (cold start, API down)', async () => {
  const f = mockCW(() => { throw new Error('down'); });
  const store = fakeStore();
  try {
    const cache = cw.createServersCache({ readCache: store.readCache, writeCache: store.writeCache });
    const r = await cache.load('k', ENV);
    assert.equal(r.source, 'error');
    assert.equal(r.unavailable, true);
    assert.equal(r.stale, false);
    assert.deepEqual(r.servers, []);
    assert.equal(r.refreshedAt, null);
  } finally { f.restore(); }
});

await test('cache: durable D1 last-good survives cold start and is served stale on failure', async () => {
  const snapshot = { at: 123456, data: { servers: [cw.normalizeServer(cwServer(3))], partial: false } };
  const store = fakeStore({ k: snapshot });
  const f = mockCW(() => { throw new Error('down'); });
  try {
    const cache = cw.createServersCache({ readCache: store.readCache, writeCache: store.writeCache });
    const r = await cache.load('k', ENV, { fresh: true });
    assert.equal(r.source, 'stale');
    assert.equal(r.refreshedAt, 123456);
    assert.equal(r.servers.length, 1);
  } finally { f.restore(); }
});

await test('cache: snapshot-write failure -> live data + snapshotSaved:false', async () => {
  const f = mockCW(() => makeResponse({ data: { servers: [cwServer(1)] } }));
  const store = fakeStore({}, { failWrite: true });
  try {
    const cache = cw.createServersCache({ readCache: store.readCache, writeCache: store.writeCache });
    const r = await cache.load('k', ENV, { fresh: true });
    assert.equal(r.source, 'live');
    assert.equal(r.servers.length, 1);
    assert.equal(r.snapshotSaved, false);
  } finally { f.restore(); }
});

// ---------- settings validation ----------
await test('settings: defaults shape + empty round-trip returns defaults', () => {
  assert.deepEqual(cw.DEFAULT_SETTINGS, { refreshSeconds: 60, defaultRange: '7d', regionFilter: '', notify: { email: false } });
  assert.deepEqual(cw.validateSettings({}), cw.DEFAULT_SETTINGS);
});

await test('settings: valid partial update sanitizes', () => {
  const r = cw.validateSettings({ refreshSeconds: '90', defaultRange: '1h', regionFilter: '  London  ', notify: { email: 'yes', bogus: 1 } });
  assert.equal(r.refreshSeconds, 90);
  assert.equal(r.defaultRange, '1h');
  assert.equal(r.regionFilter, 'London');
  assert.deepEqual(r.notify, { email: true });
});

await test('settings: invalid refreshSeconds rejected', () => {
  for (const bad of [0, 29, 301, 60.5, 'abc', null, NaN]) {
    assert.throws(() => cw.validateSettings({ refreshSeconds: bad }), (e) => e instanceof cw.CwError && e.status === 400, `reject ${bad}`);
  }
  assert.equal(cw.validateSettings({ refreshSeconds: 30 }).refreshSeconds, 30);
  assert.equal(cw.validateSettings({ refreshSeconds: 300 }).refreshSeconds, 300);
});

await test('settings: invalid defaultRange + oversized regionFilter rejected', () => {
  assert.throws(() => cw.validateSettings({ defaultRange: '30d' }), (e) => e.status === 400);
  assert.throws(() => cw.validateSettings({ regionFilter: 'x'.repeat(65) }), (e) => e.status === 400);
});

await test('settings: invalid notify shape rejected', () => {
  assert.throws(() => cw.validateSettings({ notify: 'on' }), (e) => e.status === 400);
  assert.throws(() => cw.validateSettings({ notify: [1, 2] }), (e) => e.status === 400);
});

await test('settings: describeSettingsChange is non-sensitive + no secrets', () => {
  const next = cw.validateSettings({ refreshSeconds: 120, defaultRange: '24h', regionFilter: 'NYC3', notify: { email: true } });
  const d = cw.describeSettingsChange(cw.DEFAULT_SETTINGS, next);
  assert.match(d, /refresh 60s\u2192120s/);
  assert.match(d, /email alerts on/);
  assertNoSecret(d, 'audit summary');
});

// ---------- regression / surface ----------
await test('regression: client exposes the helpers the routes rely on and holds no secret', () => {
  for (const fn of ['hasCreds', 'statusBlock', 'listServers', 'getServer', 'createServersCache', 'validateSettings', 'cwRequest']) {
    assert.equal(typeof cw[fn], 'function');
  }
  assert.ok(!('CLOUDWAYS_API_KEY' in cw) && !('CLOUDWAYS_EMAIL' in cw), 'client never hardcodes credentials');
  assert.equal(cw.CW_ORIGIN, 'https://api.cloudways.com');
});

// connection verified becomes true after a real success (ran after many successes now).
await test('status: connected becomes true after a successful authenticated call', () => {
  const s = cw.statusBlock(ENV);
  assert.equal(s.tokenSet, true);
  assert.equal(s.connected, true);
  assert.ok(cw.connectionVerifiedAt() > 0);
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
