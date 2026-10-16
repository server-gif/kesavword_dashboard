// Server Monitoring (over the existing SSH connection) — foundation: live server facts + settings, read-only.
// Reuses the shared helpers (lib.js) and chart kit (charts.js). Everything renders through h()
// (text nodes only), so hostnames, IPs and OS strings read from the server are treated as untrusted.
// Metrics history, Health, Alerts and Recovery are shown only as clearly-labelled "future phase" panels —
// no numbers, incidents or statuses are ever invented here; what you see is read live from the server.
import { $, h, api, toast, icon, fmtDate, timeAgo, formModal } from './lib.js';
import { tile, lineChart, chartCard, simpleTable, timeLabel } from './charts.js';

const S = 'server-monitoring';
let state = blank();

function blank() {
  return {
    tab: 'overview', server: null,
    status: null, servers: null, meta: null, health: null, settings: null,
    live: true,
    q: '', region: '', statusSel: '', sort: { key: 'name', dir: 1 },
  };
}

export function resetServerMonitoring() { stopLive(); state = blank(); }

export async function showServerMonitoring(params) {
  const tab = params.get('tab');
  if (['overview', 'servers', 'settings'].includes(tab)) state.tab = tab;
  const server = params.get('server');
  if (server) { state.server = server; state.tab = 'server'; }
  await drawTab();
}

function go(tab, server) {
  const q = new URLSearchParams();
  q.set('tab', tab);
  if (server) q.set('server', String(server));
  location.hash = `#/servermon?${q.toString()}`;
}

// ---------- shared chrome ----------

function toolbar() {
  const tabs = [['overview', 'Overview'], ['servers', 'Servers'], ['settings', 'Settings']];
  const activeFor = (k) => state.tab === k || (state.tab === 'server' && k === 'servers');
  const seg = h('div', { class: 'seg' }, ...tabs.map(([k, l]) =>
    h('button', { class: activeFor(k) ? 'active' : '', onclick: () => go(k) }, l)));
  const updated = h('span', { class: 'ov-updated' }, state.meta && state.meta.refreshedAt ? `Updated ${timeAgo(state.meta.refreshedAt)}` : '');
  const refresh = h('button', { class: 'icon-btn', title: 'Refresh now \u2014 re-read the server over SSH', 'data-tip': 'Refresh now', onclick: () => refreshNow() }, icon('refresh', 16));

  const parts = [seg, h('span', { class: 'spacer' })];
  if (canLive()) {
    const pill = h('span', { class: 'live-pill' },
      h('span', { class: `live-dot${state.live ? ' on' : ''}` }),
      h('span', {}, state.live ? 'Live' : 'Paused'),
      h('span', { class: 'live-count' }, ''));
    const btn = h('button', { class: 'btn btn-sm', title: state.live ? 'Pause automatic refresh' : 'Resume automatic refresh', onclick: () => toggleLive() }, state.live ? 'Pause' : 'Go live');
    parts.push(pill, btn);
  }
  parts.push(updated, refresh);
  return h('div', { class: 'toolbar' }, ...parts);
}

async function refreshNow() {
  state.servers = null; state.meta = null; state.health = null;
  await drawTab(true);
}

function loadingBar() { return h('div', { class: 'loading-bar' }); }

function skeleton(n = 4) {
  return h('div', { class: 'sm-skel' }, ...Array.from({ length: n }, () => h('div', { class: 'sm-skel-row' })));
}

function banner(kind, msg, extra) {
  return h('div', { class: `sm-banner ${kind}` }, icon(kind === 'warn' ? 'alert' : 'info', 15), h('span', {}, msg), extra || null);
}

function metaBanners() {
  const out = [];
  const m = state.meta;
  if (!m) return out;
  if (m.unavailable) out.push(banner('err', m.error || 'Server data is unavailable right now.'));
  else {
    if (m.stale) out.push(banner('warn', `Showing the last known reading (from ${m.refreshedAt ? fmtDate(m.refreshedAt) : 'earlier'}) — ${m.error || 'the server could not be reached just now.'}`));
    if (m.partial) out.push(banner('warn', 'Partial reading: the server returned more than the safety limit allowed.'));
    if (m.source === 'live' && m.snapshotSaved === false) out.push(banner('info', 'This snapshot could not be saved for offline viewing; the data shown is live.'));
  }
  return out;
}

function draw(content) {
  const root = $('view-servermon');
  root.replaceChildren(toolbar(), h('div', { class: 'sm-body' }, ...content));
}

// ---------- data loading ----------

async function getStatus() {
  if (state.status) return state.status;
  state.status = await api('GET', `/api/${S}/status`);
  return state.status;
}

async function getServers(force) {
  if (state.servers && !force) return state.servers;
  const data = await api('GET', `/api/${S}/servers${force ? '?fresh=1' : ''}`);
  state.servers = Array.isArray(data.servers) ? data.servers : [];
  state.meta = data;
  return state.servers;
}

async function getHealth(force) {
  if (state.health && !force) return state.health;
  state.health = await api('GET', `/api/${S}/health`);
  return state.health;
}

async function getSettings() {
  if (state.settings) return state.settings;
  try { state.settings = await api('GET', `/api/${S}/settings`); } catch { state.settings = null; }
  return state.settings;
}

// ---------- live auto-refresh ----------
// The reading keeps itself current while you watch: every refresh interval (from Settings, 30–300s)
// we re-read the server over SSH and redraw. Nothing is invented — a failed poll just keeps the last
// good reading until the next tick. A re-render is skipped while a field is focused so typing in the
// server search is never interrupted, and polling stops when you leave this section or pause it.
let pollTimer = null;
let clockTimer = null;
let nextAt = 0;

const canLive = () => state.tab === 'overview' || state.tab === 'servers' || state.tab === 'server';
function liveInterval() {
  const rs = Number(state.settings && state.settings.refreshSeconds);
  return (Number.isFinite(rs) && rs >= 30 && rs <= 300 ? rs : 60) * 1000;
}
function inputFocused() {
  const a = document.activeElement;
  return !!a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName);
}
function clearTimers() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
}
function startLive() {
  clearTimers();
  nextAt = Date.now() + liveInterval();
  pollTimer = setInterval(() => { liveTick(); }, liveInterval());
  clockTimer = setInterval(updateClock, 1000);
  updateClock();
}
function stopLive() { state.live = false; clearTimers(); nextAt = 0; }
function renderLive() {
  if (state.tab === 'overview') draw(overviewView(state.status));
  else if (state.tab === 'servers') draw(serversView());
  else if (state.tab === 'server') detailView().then(draw).catch(() => {});
}
async function liveTick() {
  if (!state.live || !canLive()) return;
  const view = $('view-servermon');
  if (view && view.classList.contains('hidden')) { clearTimers(); return; } // navigated away
  try {
    if (state.tab === 'server') {
      const content = await detailView();
      if (state.live && state.tab === 'server' && !inputFocused()) draw(content);
    } else {
      await getServers(true);
      await getHealth(true).catch(() => {});
      if (state.live && !inputFocused() && state.tab !== 'server') renderLive();
    }
  } catch { /* transient SSH miss: keep the last good reading, retry next tick */ }
  nextAt = Date.now() + liveInterval();
}
function updateClock() {
  const el = document.querySelector('.live-count');
  if (!el) return;
  el.textContent = state.live && nextAt ? ` \u00b7 next ${Math.max(0, Math.round((nextAt - Date.now()) / 1000))}s` : '';
}
async function toggleLive() {
  if (state.live) { state.live = false; clearTimers(); nextAt = 0; renderLive(); return; }
  state.live = true;
  await getSettings().catch(() => {});
  startLive();
  await liveTick();
}

// ---------- entry ----------

async function drawTab(fresh = false) {
  clearTimers(); // stop any previous schedule; re-armed below for live tabs
  draw([loadingBar(), skeleton()]);
  let content;
  try {
    const status = await getStatus();
    if (!status.tokenSet) content = [connectCard()];
    else if (state.tab === 'settings') content = await settingsView();
    else if (state.tab === 'server') content = await detailView();
    else if (state.tab === 'servers') { await getServers(fresh); content = serversView(); }
    else { await getServers(fresh); await getHealth(fresh).catch(() => {}); content = overviewView(status); }
  } catch (err) {
    content = [banner('err', err.message || 'Could not load Server Monitoring.'), refreshRetry()];
  }
  draw(content);
  const gotData = Boolean(state.servers && state.servers.length);
  if (state.live && canLive() && gotData) {
    getSettings().catch(() => {}).finally(() => { if (state.live && canLive()) startLive(); });
  }
}

function refreshRetry() {
  return h('div', { class: 'sm-actions' }, h('button', { class: 'btn btn-sm', onclick: () => refreshNow() }, icon('refresh', 14), 'Retry'));
}

// ---------- connect / empty state ----------

function connectCard() {
  return h('div', { class: 'card ov-card sm-connect' },
    h('div', { class: 'ov-card-head' }, h('div', {}, h('div', { class: 'ov-card-title' }, 'Server connection'), h('div', { class: 'ov-card-sub' }, 'Server Monitoring reads this server\u2019s live status over the same secure SSH connection the dashboard already uses.'))),
    h('div', { class: 'sm-connect-body' },
      icon('shield', 28),
      h('p', {}, 'No extra keys are needed \u2014 it reuses the server credentials that are already configured on the dashboard, which stay entirely server-side and are never placed in the browser or any API response. If this message persists, the owner should confirm the SFTP host/user/password secrets are set on the Worker.'),
      h('div', { class: 'sm-actions' }, h('button', { class: 'btn btn-sm', onclick: () => { state.status = null; drawTab(); } }, icon('refresh', 14), 'Re-check connection'))));
}

// ---------- small formatters (values are read live; an unreadable value stays a dash) ----------

function dash(v) { return (v === null || v === undefined || v === '') ? '—' : String(v); }
function round1(x) { return x == null ? '—' : Number(x).toFixed(1); }

function humanUptime(sec) {
  if (sec == null || !Number.isFinite(sec)) return null;
  const d = Math.floor(sec / 86400), hr = Math.floor((sec % 86400) / 3600), mn = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${hr}h` : hr ? `${hr}h ${mn}m` : `${mn}m`;
}

// ---------- overview ----------

function overviewView(status) {
  const host = (state.meta && state.meta.host) || (state.servers && state.servers[0]) || null;
  const out = [];
  out.push(...metaBanners());
  if (!host) return [...out, banner('err', (state.meta && state.meta.error) || 'No server status is available yet.'), refreshRetry()];

  const m = host.metrics || {};
  out.push(h('div', { class: 'kpis' },
    tile('Connection', status && status.connected ? 'Verified' : 'Live', h('div', { class: 'kpi-delta' }, host.hostname ? `read from ${host.hostname}` : 'read over SSH')),
    tile('Uptime', dash(humanUptime(m.uptimeSeconds)), h('div', { class: 'kpi-delta' }, 'continuous since boot')),
    tile('Load (1 min)', m.load1 != null ? String(m.load1) : '—', m.cores != null ? h('div', { class: 'kpi-delta' }, `${m.cores} core${m.cores === 1 ? '' : 's'}`) : null),
    tile('CPU', m.cpuPct != null ? `${m.cpuPct}%` : '—', m.cores != null ? h('div', { class: 'kpi-delta' }, `busy of ${m.cores} core${m.cores === 1 ? '' : 's'}`) : null),
    tile('Memory', m.memory && m.memory.usedPct != null ? `${m.memory.usedPct}%` : '—', m.memory && m.memory.totalMb != null ? h('div', { class: 'kpi-delta' }, `${round1((m.memory.usedMb || 0) / 1024)}/${round1(m.memory.totalMb / 1024)} GB`) : null),
    tile('Disk', m.disk && m.disk.usedPct != null ? `${m.disk.usedPct}%` : '—', m.disk && m.disk.totalGb != null ? h('div', { class: 'kpi-delta' }, `${round1(m.disk.usedGb)}/${round1(m.disk.totalGb)} GB`) : null)));

  out.push(h('div', { class: 'card sm-meta' },
    ...[
      ['Operating system', dash(host.os)],
      ['Kernel', dash(host.kernel)],
      ['Provider', dash(host.provider)],
      ['Public IP', dash(host.publicIp)],
      ['Interface IP', dash(host.internalIp)],
      ['Status', statusPill(host.status)],
    ].map(([k, v]) => h('div', { class: 'sm-meta-row' },
      h('div', { class: 'sm-meta-k' }, k),
      h('div', { class: 'sm-meta-v mono' }, typeof v === 'object' ? v : h('span', {}, v))))));

  out.push(...usageCards(host, state.health));
  out.push(healthPanel(state.health));

  out.push(futurePhaseNote('Everything above is read live from the server over SSH, and the usage trend and up/down history build from real checks — nothing is invented. Proactive alerting (email/other channels) and guided recovery actions arrive in later phases.'));
  out.push(h('div', { class: 'table-foot' }, `Source: ${state.meta?.source || '—'}${state.meta?.refreshedAt ? ` · ${fmtDate(state.meta.refreshedAt)}` : ''}`));
  return out;
}

function futurePhaseNote(text) {
  return h('div', { class: 'card ov-card sm-future' },
    h('div', { class: 'ov-card-head' }, h('div', {}, h('div', { class: 'ov-card-title' }, 'Future phases'), h('div', { class: 'ov-card-sub' }, text))),
    h('div', { class: 'sm-future-grid' },
      ...[['Alerts & notifications', 'Threshold and health alerts sent to you (email and other channels).'],
        ['Recovery actions', 'Controlled service restarts and other safe remediations, with confirmation, cooldown and audit.']]
        .map(([t, d]) => h('div', { class: 'sm-future-item' }, icon('info', 15), h('div', {}, h('div', { class: 'strong' }, t), h('div', { class: 'muted' }, d, h('span', { class: 'badge badge-gray' }, 'Available in a future phase')))))));
}

// ---------- health & uptime (built only from real collected samples) ----------

function uptimeText(u) { return (u && u.pct != null) ? `${u.pct}%` : '—'; }

function coverageNote(u) {
  if (!u || !u.coverageMs) return 'not enough history yet';
  const hrs = u.coverageMs / 3600e3;
  if (hrs < 1) return `${Math.max(1, Math.round(u.coverageMs / 60000))} min observed`;
  if (hrs < 48) return `${Math.round(hrs)}h observed`;
  return `${Math.round(hrs / 24)}d observed`;
}

function statusDot(health) {
  const map = { up: ['badge-green', 'Online'], down: ['badge-amber', 'Not responding'], unknown: ['badge-gray', 'Unknown'] };
  const [cls, label] = map[(health && health.status) || 'unknown'] || map.unknown;
  return h('span', { class: `badge ${cls}` }, label);
}

function healthPanel(health) {
  const hd = health || {};
  if (!hd.hasData) {
    return h('div', { class: 'card ov-card sm-health' },
      h('div', { class: 'ov-card-head' }, h('div', {}, h('div', { class: 'ov-card-title' }, 'Health & uptime'), h('div', { class: 'ov-card-sub' }, 'Up/down history is being collected.'))),
      banner('info', 'Nothing here is invented: the first readings appear as automatic checks run (about every 30 minutes, and whenever you refresh). Once enough accumulate you\u2019ll see uptime %, an up/down timeline and a list of up/down events.'));
  }
  const strip = h('div', { class: 'sm-strip', title: 'Last 24 hours' },
    ...(hd.strip || []).map((v) => h('div', { class: `sm-seg ${v === 1 ? 'up' : v === 0 ? 'down' : 'none'}`, title: v === 1 ? 'up' : v === 0 ? 'down' : 'no check' })));
  const upTiles = h('div', { class: 'sm-uptime' },
    h('div', { class: 'sm-up-cell' }, h('div', { class: 'sm-up-k' }, 'Uptime · 24h'), h('div', { class: 'sm-up-v' }, uptimeText(hd.uptime && hd.uptime['24h'])), h('div', { class: 'muted sm-up-n' }, coverageNote(hd.uptime && hd.uptime['24h']))),
    h('div', { class: 'sm-up-cell' }, h('div', { class: 'sm-up-k' }, 'Uptime · 7d'), h('div', { class: 'sm-up-v' }, uptimeText(hd.uptime && hd.uptime['7d'])), h('div', { class: 'muted sm-up-n' }, coverageNote(hd.uptime && hd.uptime['7d']))));
  const events = hd.events || [];
  const eventList = events.length
    ? h('div', { class: 'sm-events' }, ...events.map((ev) => h('div', { class: 'sm-event' },
        h('span', { class: `badge ${ev.up ? 'badge-green' : 'badge-amber'}` }, ev.up ? 'Up' : 'Down'),
        h('span', { class: 'muted' }, timeAgo(ev.t)))))
    : h('div', { class: 'muted sm-noevents' }, 'No up/down changes recorded yet — the server has stayed reachable.');
  return h('div', { class: 'card ov-card sm-health' },
    h('div', { class: 'ov-card-head' }, h('div', {},
      h('div', { class: 'ov-card-title' }, 'Health & uptime'),
      h('div', { class: 'ov-card-sub' }, 'Current: ', statusDot(hd), h('span', { class: 'muted' }, ` · last check ${hd.lastSampleAt ? timeAgo(hd.lastSampleAt) : '—'}`)))),
    strip, upTiles, eventList,
    h('div', { class: 'muted sm-health-foot' }, '“Down” means the server did not answer an SSH check at that moment; it is not the same as your website being healthy.'));
}

// ---------- resource usage: "how much of total" + real 24h trend ----------

function meterRow(name, pct, detail) {
  const p = (pct == null || !Number.isFinite(Number(pct))) ? null : Math.max(0, Math.min(100, Number(pct)));
  return h('div', { class: 'barlist-row', title: `${name}: ${p == null ? 'not available' : p + '%'}` },
    h('div', { class: 'barlist-label' }, h('span', {}, name)),
    h('div', { class: 'barlist-track' }, h('span', { class: `barlist-bar${p != null && p >= 85 ? ' hot' : ''}`, style: `width:${p == null ? 0 : p}%` })),
    h('div', { class: 'barlist-value' }, p == null ? '—' : `${p}%`, detail ? h('span', { class: 'muted' }, ` · ${detail}`) : null));
}

// Meters use live metrics (always available from the host); the trend chart uses only real samples.
function usageCards(host, health) {
  const out = [];
  const m = (host && host.metrics) || {};
  const mem = m.memory || {};
  const disk = m.disk || {};
  out.push(h('div', { class: 'card ov-card' },
    h('div', { class: 'ov-card-head' }, h('div', {}, h('div', { class: 'ov-card-title' }, 'Resource usage'), h('div', { class: 'ov-card-sub' }, 'How much of the server\u2019s total each resource is using right now \u2014 read live over SSH.'))),
    h('div', { class: 'barlist' },
      meterRow('CPU', m.cpuPct, m.cores != null ? `busy of ${m.cores} core${m.cores === 1 ? '' : 's'}` : null),
      meterRow('Memory', mem.usedPct, mem.totalMb != null ? `${round1((mem.usedMb || 0) / 1024)} / ${round1(mem.totalMb / 1024)} GB used` : null),
      meterRow('Disk', disk.usedPct, disk.totalGb != null ? `${round1(disk.usedGb)} / ${round1(disk.totalGb)} GB used` : null))));

  const series = (health && health.series) || [];
  const pts = series.map((b) => ({
    label: timeLabel(b.from),
    title: `${timeLabel(b.from)} \u2013 ${timeLabel(b.from + 3600000)}`,
    vals: { cpu: b.cpu.avg, mem: b.mem.avg, disk: b.disk.avg },
    raw: b,
  }));
  const withData = pts.filter((p) => p.raw.cpu.n || p.raw.mem.n || p.raw.disk.n);
  if (!withData.length) {
    out.push(banner('info', 'Usage-over-time charts appear once enough automatic checks have been sampled (about every 30 minutes). Nothing is plotted until there is a real reading.'));
    return out;
  }
  const chart = lineChart(pts, {
    ariaLabel: 'CPU, memory and disk usage over the last 24 hours',
    yMax: 100,
    valueFormat: (v) => `${Math.round(v)}%`,
    series: [
      { key: 'cpu', name: 'CPU', colorVar: '--series-1' },
      { key: 'mem', name: 'Memory', colorVar: '--series-2' },
      { key: 'disk', name: 'Disk', colorVar: '--series-3' },
    ],
  });
  const table = simpleTable(withData, [
    { label: 'Hour', get: (r) => r.label },
    { label: 'CPU avg', num: true, get: (r) => (r.vals.cpu == null ? '—' : `${r.vals.cpu}%`) },
    { label: 'CPU max', num: true, get: (r) => (r.raw.cpu.max == null ? '—' : `${r.raw.cpu.max}%`) },
    { label: 'Memory', num: true, get: (r) => (r.vals.mem == null ? '—' : `${r.vals.mem}%`) },
    { label: 'Disk', num: true, get: (r) => (r.vals.disk == null ? '—' : `${r.vals.disk}%`) },
    { label: 'Readings', num: true, get: (r) => String(Math.max(r.raw.cpu.n, r.raw.mem.n, r.raw.disk.n)) },
  ]);
  out.push(chartCard('Usage over time', 'Last 24 hours · hourly averages of the real SSH checks (a gap means nothing was sampled that hour)', chart, table));
  return out;
}

// ---------- servers ----------

function filteredServers() {
  const list = [...(state.servers || [])];
  const q = state.q.trim().toLowerCase();
  let out = list.filter((s) => {
    if (state.region && s.region !== state.region) return false;
    if (state.statusSel && (s.status || 'unknown') !== state.statusSel) return false;
    if (!q) return true;
    return [s.name, s.publicIp, s.region, s.provider, String(s.id)].filter(Boolean).some((v) => String(v).toLowerCase().includes(q));
  });
  const { key, dir } = state.sort;
  out.sort((a, b) => {
    const av = a[key] ?? ''; const bv = b[key] ?? '';
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });
  return out;
}

function statusPill(s) {
  const map = { running: 'badge-green', provision: 'badge-blue', provisioning: 'badge-blue', maintenance: 'badge-blue', suspended: 'badge-amber', stopped: 'badge-gray' };
  const key = String(s || '').toLowerCase();
  return h('span', { class: `badge ${map[key] || 'badge-amber'}`, title: 'Status is whether the server answered over SSH (not application health)' }, s || 'unknown');
}

function sortHeader(label, key, cls) {
  const on = state.sort.key === key;
  return h('th', {
    class: cls, onclick: () => { if (state.sort.key === key) state.sort.dir *= -1; else state.sort = { key, dir: 1 }; draw(serversView()); },
  }, label, on ? h('span', { class: 'sort-ind' }, state.sort.dir > 0 ? ' ▲' : ' ▼') : null);
}

function serversView() {
  const servers = state.servers || [];
  const statuses = [...new Set(servers.map((s) => s.status || 'unknown'))].sort();

  const search = h('input', {
    class: 'input sm-search', type: 'search', placeholder: 'Search hostname, IP or ID', value: state.q, autocomplete: 'off',
    oninput: (e) => { state.q = e.target.value; draw(serversView()); },
  });
  const statusSel = h('select', { class: 'select', onchange: (e) => { state.statusSel = e.target.value; draw(serversView()); } },
    h('option', { value: '' }, 'All statuses'), ...statuses.map((s) => h('option', { value: s, selected: s === state.statusSel }, s)));

  const head = h('div', { class: 'toolbar' },
    search, statusSel,
    h('span', { class: 'muted' }, `${filteredServers().length} of ${servers.length}`));

  const rows = filteredServers().map((s) => h('tr', {
    class: 'sm-row', onclick: () => go('server', s.id),
  },
    h('td', {}, h('div', { class: 'strong' }, s.hostname || s.name || `server-${s.id}`), h('div', { class: 'muted mono' }, `#${s.id ?? '—'}`)),
    h('td', {}, s.os || '—'),
    h('td', { class: 'mono' }, s.publicIp || h('span', { class: 'muted' }, 'none')),
    h('td', { class: 'mono' }, s.internalIp || h('span', { class: 'muted' }, '—')),
    h('td', {}, statusPill(s.status)),
    h('td', {}, (s.metrics && humanUptime(s.metrics.uptimeSeconds)) || '—')));

  const table = servers.length
    ? h('table', { class: 'table' },
      h('thead', {}, h('tr', {},
        sortHeader('Server', 'name'), h('th', {}, 'Operating system'),
        sortHeader('Public IP', 'publicIp'), h('th', {}, 'Interface IP'), sortHeader('Status', 'status'), h('th', {}, 'Uptime'))),
      h('tbody', {}, ...rows))
    : h('div', { class: 'empty-state' }, h('div', { class: 'empty-text' }, state.meta && state.meta.unavailable ? 'Server data unavailable.' : 'No server status yet.'));

  return [...metaBanners(), head, h('div', { class: 'card table-card' }, table),
    h('div', { class: 'table-foot muted' }, 'Status shows whether the server answered over SSH; it is not the same as your application being healthy.')];
}

// ---------- server detail ----------

async function detailView() {
  const id = state.server;
  const out = [...metaBanners()];
  await getHealth(true).catch(() => {});
  let server = (state.servers || []).find((s) => String(s.id) === String(id));
  let meta = { source: server ? 'cache' : null };
  try {
    const data = await api('GET', `/api/${S}/servers/${encodeURIComponent(id)}`);
    server = data.server || server;
    meta = data;
  } catch (err) {
    if (!server) return [banner('err', err.message || 'Could not load this server.'), backLink(), refreshRetry()];
    out.push(banner('warn', `Showing a cached copy — ${err.message || 'the server could not be reached.'}`));
  }
  if (!server) return [...out, banner('err', 'That server could not be found.'), backLink()];

  const refreshed = meta.refreshedAt ? h('div', { class: 'ov-updated' }, `${meta.source === 'live' ? 'Live' : 'Cached'} · ${timeAgo(meta.refreshedAt)}`) : null;

  out.push(h('div', { class: 'sm-detail-head' },
    h('a', { class: 'btn btn-sm', href: '#/servermon?tab=servers' }, icon('back', 14), 'Servers'),
    h('h2', { class: 'sm-detail-title' }, server.name || `Server #${server.id}`),
    statusPill(server.status), refreshed));

  const m = server.metrics || {};
  const hd = state.health || {};
  const upCell = (w) => (hd.uptime && hd.uptime[w]) ? `${uptimeText(hd.uptime[w])} (${coverageNote(hd.uptime[w])})` : '—';
  const spec = [
    ['Hostname', server.hostname || '—'],
    ['Provider', server.provider || '—'],
    ['Operating system', server.os || '—'],
    ['Kernel', server.kernel || '—'],
    ['Status', server.status || '—'],
    ['Public IP', server.publicIp || '—'],
    ['Interface IP', server.internalIp || '—'],
    ['CPU cores', m.cores != null ? String(m.cores) : '—'],
    ['CPU usage (now)', m.cpuPct != null ? `${m.cpuPct}%` : '—'],
    ['Load (1/5/15 min)', m.load1 != null ? `${m.load1} / ${m.load5} / ${m.load15}` : '—'],
    ['Uptime (this boot)', humanUptime(m.uptimeSeconds) || '—'],
    ['Uptime · 24h', upCell('24h')],
    ['Uptime · 7d', upCell('7d')],
    ['Memory', (m.memory && m.memory.totalMb != null) ? `${round1((m.memory.usedMb || 0) / 1024)} / ${round1(m.memory.totalMb / 1024)} GB${m.memory.usedPct != null ? ` (${m.memory.usedPct}% used)` : ''}` : (server.memoryGb != null ? `${server.memoryGb} GB` : '—')],
    [`Disk${m.disk && m.disk.mount ? ` (${m.disk.mount})` : ''}`, (m.disk && m.disk.totalGb != null) ? `${round1(m.disk.usedGb)} / ${round1(m.disk.totalGb)} GB${m.disk.usedPct != null ? ` (${m.disk.usedPct}% used)` : ''}` : (server.diskGb != null ? `${server.diskGb} GB` : '—')],
  ];
  out.push(h('div', { class: 'card sm-meta' }, ...spec.map(([k, v]) =>
    h('div', { class: 'sm-meta-row' }, h('div', { class: 'sm-meta-k' }, k), h('div', { class: 'sm-meta-v mono' }, String(v))))));

  out.push(...usageCards(server, state.health));

  out.push(h('div', { class: 'sm-future-grid' },
    ...[['Alerts', 'Threshold and health alerts sent to you.'],
      ['Recovery', 'Start / stop / restart actions with safeguards.']]
      .map(([t, d]) => h('div', { class: 'card ov-card sm-future-item lg' },
        h('div', { class: 'ov-card-title' }, t), h('div', { class: 'muted' }, d),
        h('span', { class: 'badge badge-gray' }, 'Available in a future phase')))));

  return out;
}

function backLink() { return h('a', { class: 'btn btn-sm', href: '#/servermon?tab=servers' }, icon('back', 14), 'Back to servers'); }

// ---------- settings ----------

async function settingsView() {
  if (!state.settings) {
    try { state.settings = await api('GET', `/api/${S}/settings`); } catch { state.settings = null; }
  }
  const s = state.settings || { refreshSeconds: 60, defaultRange: '7d', regionFilter: '', notify: { email: false } };
  const rangeLabel = { '1h': '1 hour', '6h': '6 hours', '24h': '24 hours', '7d': '7 days' }[s.defaultRange] || s.defaultRange;

  const rows = [
    ['Refresh interval', `${s.refreshSeconds} seconds`, 'How often the reading is considered fresh before the server is queried again over SSH.'],
    ['Default chart range', rangeLabel, 'Time range used by the historical metric charts in a future phase.'],
    ['Email alerts', s.notify?.email ? 'On' : 'Off', 'Preference only — alert delivery is not enabled in this phase.'],
  ];
  return [
    h('div', { class: 'card ov-card' },
      h('div', { class: 'ov-card-head' }, h('div', {}, h('div', { class: 'ov-card-title' }, 'Monitoring settings'), h('div', { class: 'ov-card-sub' }, 'Saved on the server and recorded in the activity log. The server connection credentials are never stored here.'))),
      h('table', { class: 'table' },
        h('tbody', {}, ...rows.map(([k, v, hint]) => h('tr', {},
          h('td', {}, h('div', { class: 'strong' }, k), h('div', { class: 'muted' }, hint)),
          h('td', { class: 'num' }, v))))),
      h('div', { class: 'sm-actions' },
        h('button', { class: 'btn btn-primary', onclick: () => editSettings(s) }, icon('settings', 15), 'Edit settings'))),
    h('div', { class: 'table-foot muted' }, 'These values drive a read-only inventory for now. Metrics, alerts and recovery are configured in later phases.'),
  ];
}

async function editSettings(s) {
  const saved = await formModal({
    title: 'Monitoring settings',
    description: 'Values are validated on the server before saving.',
    submitText: 'Save',
    fields: [
      { name: 'refreshSeconds', label: 'Refresh interval (seconds)', value: String(s.refreshSeconds), placeholder: '30 to 300', hint: 'Between 30 and 300.' },
      { name: 'defaultRange', label: 'Default chart range', value: s.defaultRange, placeholder: '1h, 6h, 24h or 7d', hint: 'One of: 1h, 6h, 24h, 7d.' },
      { name: 'regionFilter', label: 'Default region filter', value: s.regionFilter || '', placeholder: 'e.g. bang1 (blank for all)' },
      { name: 'email', label: 'Email alerts (preference)', value: s.notify?.email ? 'on' : '', placeholder: 'type "on" to enable later (no delivery yet)' },
    ],
    onSubmit: (v) => api('PUT', `/api/${S}/settings`, {
      refreshSeconds: Number(v.refreshSeconds),
      defaultRange: v.defaultRange.trim(),
      regionFilter: v.regionFilter.trim(),
      notify: { email: v.email.trim().toLowerCase() === 'on' },
    }),
  });
  if (!saved) return;
  state.settings = saved;
  toast('Monitoring settings saved');
  draw(await settingsView());
}
