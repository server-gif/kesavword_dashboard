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
  const updated = h('span', { class: 'ov-updated', 'data-live': 'updated' }, state.meta && state.meta.refreshedAt ? `Updated ${timeAgo(state.meta.refreshedAt)}` : '');
  const refresh = h('button', { class: 'icon-btn', 'data-tip': 'Refresh now \u2014 re-read the server over SSH', onclick: () => refreshNow() }, icon('refresh', 16));

  const parts = [seg, h('span', { class: 'spacer' })];
  if (canLive()) {
    const pill = h('span', { class: 'live-pill' },
      h('span', { class: `live-dot${state.live ? ' on' : ''}`, 'data-live': 'live-dot' }),
      h('span', { 'data-live': 'live-state' }, state.live ? 'Live' : 'Paused'),
      h('span', { class: 'live-count', 'data-live': 'next' }, ''));
    const btn = h('button', { class: 'btn btn-sm', 'data-live': 'live-btn', 'data-tip': state.live ? 'Pause automatic refresh' : 'Resume automatic refresh', onclick: () => toggleLive() }, state.live ? 'Pause' : 'Go live');
    parts.push(pill, intervalSelect(), btn);
  }
  parts.push(updated, refresh);
  return h('div', { class: 'toolbar' }, ...parts);
}

async function refreshNow() {
  // First load (or after an error): the normal skeleton path.
  if (!(state.servers && state.servers.length)) {
    state.servers = null; state.meta = null; state.health = null;
    await drawTab(true);
    return;
  }
  // Otherwise keep the numbers on screen and re-read in the background (stale-while-revalidate):
  // only the “Updated” label shows progress, and applyLive swaps the values in place when they arrive.
  setLive('updated', 'Re-reading…');
  try {
    await getServers(true);
    await getHealth(true).catch(() => {});
    const host = currentHost();
    if (host) applyLive(host, state.health);
    liveFails = 0;
    if (state.live && canLive()) { nextAt = Date.now() + liveInterval(); syncLiveChrome(); } // this read counts as this interval's poll
  } catch (err) {
    toast(err.message || 'Could not re-read the server just now — showing the last good reading.', 'err');
    setLive('updated', state.meta && state.meta.refreshedAt ? `Updated ${timeAgo(state.meta.refreshedAt)}` : '');
  }
}

// The live re-read interval, changeable right from the toolbar (same setting as in Settings — the
// choice is saved to the server, so it also applies to the next visit and the Settings page).
const INTERVAL_CHOICES = [[30, 'every 30s'], [60, 'every 1 min'], [120, 'every 2 min'], [180, 'every 3 min'], [300, 'every 5 min']];
// A small custom dropdown: the native <select> popup is drawn by the browser and can't be themed
// (that bright highlight box), so we use a plain button + a themed menu that matches the dashboard.
let openInterval = null; // { wrap, menu, btn } while the picker is showing
function closeIntervalMenu() {
  if (!openInterval) return;
  openInterval.menu.hidden = true;
  openInterval.btn.setAttribute('aria-expanded', 'false');
  openInterval = null;
  document.removeEventListener('pointerdown', onIntervalOutside, true);
  document.removeEventListener('keydown', onIntervalKey, true);
}
function onIntervalOutside(e) { if (openInterval && !openInterval.wrap.contains(e.target)) closeIntervalMenu(); }
function onIntervalKey(e) { if (e.key === 'Escape') closeIntervalMenu(); }
function intervalSelect() {
  const cur = Number(state.settings && state.settings.refreshSeconds) || 60;
  const choices = INTERVAL_CHOICES.map(([v, l]) => [v, l]);
  if (!choices.some(([v]) => v === cur)) { choices.push([cur, `every ${cur}s`]); choices.sort((a, b) => a[0] - b[0]); }
  const labelFor = (v) => (choices.find(([cv]) => cv === v) || choices[0])[1];
  const menu = h('div', { class: 'sm-menu', role: 'listbox', hidden: true },
    ...choices.map(([v, l]) => h('button', {
      class: `sm-menu-item${v === cur ? ' sel' : ''}`, type: 'button', role: 'option', 'aria-selected': v === cur,
      onclick: () => { closeIntervalMenu(); setRefreshSeconds(v, labelFor(v)); },
    }, l, v === cur ? icon('check', 13) : null)));
  const btn = h('button', {
    class: 'live-interval', type: 'button',
    'data-tip': 'How often the reading is re-checked live over SSH \u2014 saved in Monitoring settings',
    'aria-haspopup': 'listbox', 'aria-expanded': 'false',
    onclick: () => {
      if (openInterval && openInterval.menu === menu) { closeIntervalMenu(); return; }
      closeIntervalMenu();
      menu.hidden = false; btn.setAttribute('aria-expanded', 'true');
      openInterval = { wrap, menu, btn };
      document.addEventListener('pointerdown', onIntervalOutside, true);
      document.addEventListener('keydown', onIntervalKey, true);
    },
  }, h('span', { 'data-live': 'interval-label' }, labelFor(cur)), icon('chevron', 13));
  const wrap = h('div', { class: 'live-interval-wrap' }, btn, menu);
  return wrap;
}
async function setRefreshSeconds(n, label) {
  const s = state.settings || {};
  try {
    const saved = await api('PUT', `/api/${S}/settings`, {
      refreshSeconds: n,
      defaultRange: s.defaultRange || '7d',
      regionFilter: s.regionFilter || '',
      notify: { email: Boolean(s.notify && s.notify.email) },
    });
    state.settings = saved;
    if (label) setLive('interval-label', label); // reflect the new choice on the trigger right away
    toast(`Live refresh set to every ${saved.refreshSeconds >= 60 ? `${saved.refreshSeconds / 60} min` : `${saved.refreshSeconds}s`}`);
    if (state.live && canLive()) startLive(); // re-arm the schedule at the new interval right away
    else syncLiveChrome();
  } catch (err) {
    toast(err.message || 'Could not save the refresh interval', 'err');
  }
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
  closeIntervalMenu(); // an open picker belongs to the previous DOM; drop it before replacing
  const root = $('view-servermon');
  const prev = root.querySelector('.sm-body')?.scrollTop || 0;
  root.replaceChildren(toolbar(), h('div', { class: 'sm-body' }, ...content));
  const body = root.querySelector('.sm-body');
  if (body && prev) body.scrollTop = prev; // keep position on any full redraw
}

// ---------- data loading ----------

async function getStatus() {
  if (state.status) return state.status;
  state.status = await api('GET', `/api/${S}/status`, null, { timeoutMs: 12000 });
  return state.status;
}

async function getServers(force) {
  if (state.servers && !force) return state.servers;
  // The Worker answers this from a ~15s SSH deadline at the latest, so the page gives up shortly
  // after that and shows the retry banner instead of sitting on a request that never returns.
  const data = await api('GET', `/api/${S}/servers${force ? '?fresh=1' : ''}`, null, { timeoutMs: 25000 });
  state.servers = Array.isArray(data.servers) ? data.servers : [];
  state.meta = data;
  return state.servers;
}

async function getHealth(force) {
  if (state.health && !force) return state.health;
  state.health = await api('GET', `/api/${S}/health`, null, { timeoutMs: 15000 });
  return state.health;
}

async function getSettings() {
  if (state.settings) return state.settings;
  try { state.settings = await api('GET', `/api/${S}/settings`, null, { timeoutMs: 10000 }); } catch { state.settings = null; }
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
let pollBusy = false; // true while a poll's SSH re-read is in flight, so slow ticks never stack
let liveFails = 0;    // consecutive poll failures, used for exponential back-off when the backend is busy

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
  clockTimer = setInterval(syncLiveChrome, 1000);
  syncLiveChrome();
}
function stopLive() { state.live = false; clearTimers(); nextAt = 0; }
// The host whose numbers drive the current view: the detail server, or the overview/servers host.
function currentHost() {
  const list = state.servers || [];
  if (state.tab === 'server') return list.find((s) => String(s.id) === String(state.server)) || (state.meta && state.meta.host) || null;
  return (state.meta && state.meta.host) || list[0] || null;
}
// Live tick re-reads the server over SSH, then updates values IN PLACE (applyLive) — the page
// structure, the trend chart and the health panel are touched only when a genuinely new sample
// arrives, so counts moving never rebuild the view and the scroll position stays put (no jump).
async function liveTick() {
  if (!state.live || !canLive()) return;
  const view = $('view-servermon');
  if (view && view.classList.contains('hidden')) { clearTimers(); return; } // navigated away
  if (inputFocused()) { nextAt = Date.now() + liveInterval(); return; }      // don't disturb typing
  if (pollBusy) return;                                                       // previous re-read still running — never pile up requests
  pollBusy = true;
  try {
    await getServers(true);
    await getHealth(true).catch(() => {});
    const host = currentHost();
    if (state.live && canLive() && host) applyLive(host, state.health);
    liveFails = 0;
    nextAt = Date.now() + liveInterval();
  } catch {
    // Transient backend pressure (e.g. the database briefly backing off): keep the last good reading
    // and wait longer before retrying (exponential back-off, capped at 5 min) so we don't hammer it.
    liveFails++;
    nextAt = Date.now() + Math.min(liveInterval() * 2 ** liveFails, 300000);
  } finally {
    pollBusy = false;
    syncLiveChrome();
  }
}
// Update the live pill / pause button / countdown without re-rendering the body.
function syncLiveChrome() {
  const dot = liveEl('live-dot');
  if (dot) dot.classList.toggle('on', !!state.live);
  setLive('live-state', state.live ? 'Live' : 'Paused');
  const btn = liveEl('live-btn');
  if (btn) {
    const want = state.live ? 'Pause' : 'Go live';
    if (btn.textContent !== want) btn.textContent = want;
    btn.setAttribute('data-tip', state.live ? 'Pause automatic refresh' : 'Resume automatic refresh');
  }
  const next = liveEl('next');
  if (next) next.textContent = state.live && nextAt ? ` \u00b7 next ${Math.max(0, Math.round((nextAt - Date.now()) / 1000))}s` : '';
}
async function toggleLive() {
  if (state.live) { state.live = false; clearTimers(); nextAt = 0; syncLiveChrome(); return; }
  state.live = true;
  await getSettings().catch(() => {});
  startLive();
  await liveTick();
  syncLiveChrome();
}

// ---------- entry ----------

async function drawTab(fresh = false) {
  clearTimers(); // stop any previous schedule; re-armed below for live tabs
  refs = {};     // fresh live-update handles for this tab render
  draw([loadingBar(), skeleton()]);
  let content;
  try {
    const status = await getStatus();
    if (!status.tokenSet) content = [connectCard()];
    else {
      if (canLive()) await getSettings().catch(() => {}); // toolbar interval dropdown shows the saved value
      if (state.tab === 'settings') content = await settingsView();
      else if (state.tab === 'server') content = await detailView();
      else if (state.tab === 'servers') { await getServers(fresh); content = serversView(); }
      else { await getServers(fresh); await getHealth(fresh).catch(() => {}); content = overviewView(status); }
    }
  } catch (err) {
    content = [banner('err', err.message || 'Could not load Server Monitoring.'), refreshRetry()];
  }
  draw(content);
  const gotData = Boolean(state.servers && state.servers.length);
  if (state.live && canLive() && gotData) startLive();
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

// ---------- in-place live update (no full rebuild → no scroll jump / down-up flicker) ----------
// Values are tagged with data-live / data-slot during render; applyLive() mutates only what changed.
let refs = {};
const viewRoot = () => $('view-servermon');
const liveEl = (key) => viewRoot().querySelector(`[data-live="${key}"]`);
const slotEl = (name) => viewRoot().querySelector(`[data-slot="${name}"]`);
function setLive(key, text) {
  const el = liveEl(key);
  if (!el) return;
  const s = text == null ? '' : String(text);
  if (el.textContent !== s) el.textContent = s;
}
function normPct(x) { const n = Number(x); return (x == null || !Number.isFinite(n)) ? null : Math.max(0, Math.min(100, n)); }
// Signature that changes only when a genuinely new up/down sample arrives, so the trend/health cards
// are rebuilt then and not on every numeric-only tick.
function healthSig(health) { const hd = health || {}; return `${hd.count || 0}|${hd.status || ''}|${hd.lastSampleAt || 0}`; }

// local KPI tile mirroring charts.js tile() but with a tagged value node for live updates.
// The explanation shows as the dashboard's own themed tooltip (tip-long), not the slow native one.
function kpiTile(key, label, valueText, sub, tip) {
  return h('div', { class: tip ? 'kpi tip-long' : 'kpi', 'data-tip': tip || null },
    h('div', { class: 'kpi-label' }, label),
    h('div', { class: 'kpi-value', 'data-live': `v-${key}` }, valueText == null ? '—' : String(valueText)),
    sub);
}
function kpiDelta(key, text) { return h('div', { class: 'kpi-delta', 'data-live': `v-${key}` }, text == null ? '' : String(text)); }

function meter(key, name, pct, detail) {
  const p = normPct(pct);
  return h('div', { class: 'barlist-row tip-long', 'data-tip': `${name}: ${p == null ? 'not available' : p + '%'}` },
    h('div', { class: 'barlist-label' }, h('span', {}, name)),
    h('div', { class: 'barlist-track' }, h('span', { class: `barlist-bar${p != null && p >= 85 ? ' hot' : ''}`, 'data-live': `m-${key}-bar`, style: `width:${p == null ? 0 : p}%` })),
    h('div', { class: 'barlist-value' },
      h('span', { 'data-live': `m-${key}-v` }, p == null ? '—' : `${p}%`),
      detail ? h('span', { class: 'muted', 'data-live': `m-${key}-d` }, ` \u00b7 ${detail}`) : null));
}
function applyMeter(key, name, pct, detail) {
  const p = normPct(pct);
  const bar = liveEl(`m-${key}-bar`);
  if (bar) {
    bar.style.width = `${p == null ? 0 : p}%`; bar.classList.toggle('hot', p != null && p >= 85);
    const row = bar.closest('.barlist-row');
    if (row) row.setAttribute('data-tip', `${name}: ${p == null ? 'not available' : p + '%'}`); // keep the themed hint current too
  }
  setLive(`m-${key}-v`, p == null ? '—' : `${p}%`);
  if (detail != null) setLive(`m-${key}-d`, ` \u00b7 ${detail}`);
}
function applyMeters(host) {
  const m = (host && host.metrics) || {};
  const mem = m.memory || {};
  const disk = m.disk || {};
  applyMeter('cpu', 'CPU', m.cpuPct, m.cores != null ? `busy of ${m.cores} core${m.cores === 1 ? '' : 's'}` : null);
  applyMeter('mem', 'Memory', mem.usedPct, mem.totalMb != null ? `${round1((mem.usedMb || 0) / 1024)} / ${round1(mem.totalMb / 1024)} GB used` : null);
  applyMeter('disk', 'Disk', disk.usedPct, disk.totalGb != null ? `${round1(disk.usedGb)} / ${round1(disk.totalGb)} GB used` : null);
}

// The single live-refresh routine for Overview / Servers / Detail. Each setLive is a no-op where the
// node isn't present, so one call safely updates whichever tab is showing. The trend chart and health
// panel are re-rendered only when a genuinely new sample arrived (their signature changes), so a tick
// that only moves CPU/mem numbers never touches the charts or the page height.
function applyLive(host, health) {
  const m = (host && host.metrics) || {};
  setLive('v-uptime', dash(humanUptime(m.uptimeSeconds)));
  setLive('v-load1', m.load1 != null ? String(m.load1) : '—');
  setLive('v-cpu', m.cpuPct != null ? `${m.cpuPct}%` : '—');
  setLive('v-mem', m.memory && m.memory.usedPct != null ? `${m.memory.usedPct}%` : '—');
  setLive('v-disk', m.disk && m.disk.usedPct != null ? `${m.disk.usedPct}%` : '—');
  if (m.memory && m.memory.totalMb != null) setLive('v-memsub', `${round1((m.memory.usedMb || 0) / 1024)}/${round1(m.memory.totalMb / 1024)} GB`);
  if (m.disk && m.disk.totalGb != null) setLive('v-disksub', `${round1(m.disk.usedGb)}/${round1(m.disk.totalGb)} GB`);
  // detail spec dynamic cells
  setLive('s-status', host.status || 'unknown');
  setLive('s-cpu', m.cpuPct != null ? `${m.cpuPct}%` : '—');
  setLive('s-load', m.load1 != null ? `${m.load1} / ${m.load5} / ${m.load15}` : '—');
  setLive('s-uptime', humanUptime(m.uptimeSeconds) || '—');
  setLive('s-mem', (m.memory && m.memory.totalMb != null) ? `${round1((m.memory.usedMb || 0) / 1024)} / ${round1(m.memory.totalMb / 1024)} GB${m.memory.usedPct != null ? ` (${m.memory.usedPct}% used)` : ''}` : '—');
  setLive('s-disk', (m.disk && m.disk.totalGb != null) ? `${round1(m.disk.usedGb)} / ${round1(m.disk.totalGb)} GB${m.disk.usedPct != null ? ` (${m.disk.usedPct}% used)` : ''}` : '—');
  // servers table row (single host) status + uptime
  setLive('r-status', host.status || 'unknown');
  setLive('r-uptime', humanUptime(m.uptimeSeconds) || '—');
  applyMeters(host);
  const hd = health || {};
  const sig = healthSig(hd);
  if (refs.sig !== sig) {
    refs.sig = sig;
    const cs = slotEl('chart'); if (cs) cs.replaceChildren(trendCard(hd));
    const hs = slotEl('health'); if (hs) hs.replaceChildren(healthPanel(hd));
    setLive('s-up24', uptimeLine(hd, '24h'));
    setLive('s-up7', uptimeLine(hd, '7d'));
  }
  setLive('updated', state.meta && state.meta.refreshedAt ? `Updated ${timeAgo(state.meta.refreshedAt)}` : '');
  setLive('source', `Source: ${(state.meta && state.meta.source) || '—'}${state.meta && state.meta.refreshedAt ? ` \u00b7 ${fmtDate(state.meta.refreshedAt)}` : ''}`);
  return true;
}

// ---------- overview ----------

function overviewView(status) {
  const host = (state.meta && state.meta.host) || (state.servers && state.servers[0]) || null;
  const out = [];
  out.push(...metaBanners());
  if (!host) return [...out, banner('err', (state.meta && state.meta.error) || 'No server status is available yet.'), refreshRetry()];

  const m = host.metrics || {};
  out.push(h('div', { class: 'kpis' },
    kpiTile('conn', 'Connection', status && status.connected ? 'Verified' : 'Live', h('div', { class: 'kpi-delta' }, host.hostname ? `read from ${host.hostname}` : 'read over SSH'), 'Whether the dashboard could reach your server over the secure SSH connection it already uses'),
    kpiTile('uptime', 'Uptime', dash(humanUptime(m.uptimeSeconds)), h('div', { class: 'kpi-delta' }, 'continuous since boot'), 'How long the server has been running since it last restarted'),
    kpiTile('load1', 'Load (1 min)', m.load1 != null ? String(m.load1) : '—', m.cores != null ? h('div', { class: 'kpi-delta' }, `${m.cores} core${m.cores === 1 ? '' : 's'}`) : null, 'Tasks waiting for the CPU in the last minute — close to the core count means fully busy'),
    kpiTile('cpu', 'CPU', m.cpuPct != null ? `${m.cpuPct}%` : '—', m.cores != null ? h('div', { class: 'kpi-delta' }, `busy of ${m.cores} core${m.cores === 1 ? '' : 's'}`) : null, 'How busy the processor was during the last 1-second sample'),
    kpiTile('mem', 'Memory', m.memory && m.memory.usedPct != null ? `${m.memory.usedPct}%` : '—', m.memory && m.memory.totalMb != null ? kpiDelta('memsub', `${round1((m.memory.usedMb || 0) / 1024)}/${round1(m.memory.totalMb / 1024)} GB`) : null, 'RAM currently in use out of the total installed'),
    kpiTile('disk', 'Disk', m.disk && m.disk.usedPct != null ? `${m.disk.usedPct}%` : '—', m.disk && m.disk.totalGb != null ? kpiDelta('disksub', `${round1(m.disk.usedGb)}/${round1(m.disk.totalGb)} GB`) : null, 'Storage used on the main drive out of its total capacity')));
  out.push(legendStrip());

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

  out.push(metersCard(host));
  out.push(h('div', { class: 'sm-slot', 'data-slot': 'chart' }, trendCard(state.health)));
  out.push(h('div', { class: 'sm-slot', 'data-slot': 'health' }, healthPanel(state.health)));
  refs.sig = healthSig(state.health);

  out.push(futurePhaseNote('Everything above is read live from the server over SSH, and the usage trend and up/down history build from real checks — nothing is invented. Proactive alerting (email/other channels) and guided recovery actions arrive in later phases.'));
  out.push(h('div', { class: 'table-foot', 'data-live': 'source' }, `Source: ${state.meta?.source || '—'}${state.meta?.refreshedAt ? ` · ${fmtDate(state.meta.refreshedAt)}` : ''}`));
  return out;
}

// A one-line plain-language key right under the KPI tiles: what each number means and where it comes
// from, so the page never reads as unexplained numbers.
function legendStrip() {
  const parts = [['CPU', 'processor busy right now'], ['Memory', 'RAM used of total'], ['Disk', 'storage used'], ['Load', 'tasks waiting for the CPU'], ['Uptime', 'time since last restart']];
  return h('div', { class: 'sm-legend' },
    icon('info', 14),
    h('span', { class: 'sm-legend-lead' }, 'What you\u2019re seeing:'),
    ...parts.map(([k, v]) => h('span', { class: 'sm-legend-part' }, h('b', {}, k), h('span', { class: 'muted' }, ` ${v}`))),
    h('span', { class: 'muted' }, '— every value is read live from your server over the existing secure SSH connection, nothing is estimated.'));
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

// Same duration without the word, so it can be read inside a sentence: "18h watched of 7 days".
function spanText(ms) {
  const hrs = ms / 3600e3;
  if (hrs < 1) return `${Math.max(1, Math.round(ms / 60000))} min`;
  if (hrs < 48) return `${Math.round(hrs)}h`;
  return `${Math.round(hrs / 24)}d`;
}

// Must match the server's strip: 48 fixed windows covering the last 24 hours.
const STRIP_BUCKETS = 48;
const STRIP_WINDOW_MS = 24 * 3600e3;
const WINDOWS = {
  '24h': { title: '24 hours', ms: STRIP_WINDOW_MS },
  '7d': { title: '7 days', ms: 7 * STRIP_WINDOW_MS },
};
const CHIP_KEYS = { up: 'answered', down: 'no answer', none: 'not checked' };
const CHIP_TIPS = {
  up: 'The server answered the SSH check in this 30-minute window.',
  down: 'No answer from the server in this window. Your website can still have been serving traffic — this block is about the SSH check.',
  none: 'No check ran in this window, so nothing is claimed for it — not up, not down.',
};

// A centred tooltip over the first or last strip block hangs off the scrolling card and gets cut, so
// whichever edge is too close anchors the box to it instead. One listener covers every view's tips.
function autoTipAnchor(e) {
  const el = e.target.closest?.('[data-tip]');
  if (!el || !el.dataset.tip) return;
  const box = el.getBoundingClientRect();
  const host = (el.closest('.sm-body') || document.body).getBoundingClientRect();
  const half = 120; // half the widest box a tip is allowed to grow to
  el.classList.toggle('tip-start', box.left - host.left < half);
  el.classList.toggle('tip-end', host.right - box.right < half);
}
document.addEventListener('pointerover', autoTipAnchor, true);

function statusDot(health) {
  const st = (health && health.status) || 'unknown';
  const map = {
    up: ['badge-green', 'Online', 'The last SSH check from this dashboard was answered. It is not a test of your website pages or APIs.'],
    down: ['badge-amber', 'Not responding', 'The last SSH check was not answered — the server could not be reached from the dashboard at that moment.'],
    unknown: ['badge-gray', 'Unknown', 'No check has landed yet, so the state is genuinely unknown rather than reported.'],
  };
  const [cls, label, tip] = map[st] || map.unknown;
  return h('span', { class: `badge ${cls} tip-long`, 'data-tip': tip }, label);
}

// One block per 30-minute window, each labelled with the real clock range it stands for, plus the
// axis it sits on — so the bar reads as a timeline instead of a row of mystery squares.
function stripBlocks(hd, tip) {
  const end = hd.generatedAt || Date.now();
  const start = end - STRIP_WINDOW_MS;
  const size = STRIP_WINDOW_MS / STRIP_BUCKETS;
  const blocks = h('div', { class: 'sm-strip' }, ...(hd.strip || []).map((v, i) => {
    const from = start + i * size;
    const state = v === 1 ? 'up' : v === 0 ? 'down' : 'none';
    // Short on purpose (one line): the long explanation lives on the legend chips and the title.
    return h('div', { class: `sm-seg ${state}`, 'data-tip': `${timeLabel(from)} – ${timeLabel(from + size)} · ${CHIP_KEYS[state]}` });
  }));
  const axis = h('div', { class: 'sm-axis' }, h('span', {}, timeLabel(start)), h('span', {}, '12h ago'), h('span', {}, 'now'));
  return h('div', { class: 'sm-stripblock' },
    h('div', { class: 'sm-strip-head' },
      h('div', { class: 'sm-strip-title tip-long', 'data-tip': tip }, 'Did the server answer? · last 24 hours'),
      h('div', { class: 'sm-chips' }, ...Object.keys(CHIP_KEYS).map((k) => h('span', { class: 'sm-chip tip-long', 'data-tip': CHIP_TIPS[k] }, h('i', { class: `sm-dot ${k}` }), CHIP_KEYS[k])))),
    blocks, axis);
}

// "100% · 18h watched of 24 hours" — the detail spec row uses the same wording as the overview tiles.
function uptimeLine(hd, key) {
  const u = (hd && hd.uptime && hd.uptime[key]) || null;
  if (!u) return '—';
  const w = WINDOWS[key];
  return `${uptimeText(u)} · ${u.coverageMs >= w.ms * 0.98 ? `all ${w.title} watched` : `${spanText(u.coverageMs)} watched of ${w.title}`}`;
}

function uptimeCell(hd, key) {
  const w = WINDOWS[key];
  const u = (hd.uptime && hd.uptime[key]) || null;
  const watched = u && u.coverageMs ? u.coverageMs : 0;
  const full = watched >= w.ms * 0.98;
  const since = hd.firstSampleAt ? timeAgo(hd.firstSampleAt) : null;
  const tip = u
    ? `Share of the time we actually watched in the last ${w.title} when the server answered an SSH check. History covers ${spanText(watched)} of ${w.title}${since ? `, recording started ${since}` : ''}${full ? '.' : ' — the rest is unknown, so it is never counted as uptime.'}${!full && key === '7d' ? ' This is why the 7-day figure looks the same as the 24-hour one today.' : ''}`
    : `No SSH check has landed in the last ${w.title} yet, so there is nothing honest to show.`;
  return h('div', { class: 'sm-up-cell tip-long', 'data-tip': tip },
    h('div', { class: 'sm-up-k' }, `Uptime · ${w.title}`),
    h('div', { class: 'sm-up-v' }, uptimeText(u)),
    h('div', { class: 'muted sm-up-n' }, u ? (full ? `all ${w.title} watched` : `${spanText(watched)} watched of ${w.title}`) : coverageNote(u)));
}

function healthPanel(health) {
  const hd = health || {};
  if (!hd.hasData) {
    return h('div', { class: 'card ov-card sm-health' },
      h('div', { class: 'ov-card-head' }, h('div', {}, h('div', { class: 'ov-card-title' }, 'Health & uptime'), h('div', { class: 'ov-card-sub' }, 'Up/down history is being collected.'))),
      banner('info', 'Nothing here is invented: the first readings appear as automatic checks run (about every 30 minutes, and whenever you refresh). Once enough accumulate you\u2019ll see uptime %, an up/down timeline and a list of up/down events.'));
  }
  const windows = hd.strip || [];
  const checked = windows.filter((v) => v !== null).length;
  const answered = windows.filter((v) => v === 1).length;
  const missed = windows.filter((v) => v === 0).length;
  const grey = windows.length - checked;
  const since = hd.firstSampleAt ? timeAgo(hd.firstSampleAt) : null;
  const strip = stripBlocks(hd, `Each block is one 30-minute window of the last 24 hours — oldest on the left, newest on the right. ${checked} of ${windows.length} windows hold a real check${since ? `; recording started ${since}` : ''}. Hover any block for its exact time.`);
  const note = h('div', { class: 'muted sm-strip-note' },
    checked ? `${answered} of ${checked} checked window${checked === 1 ? '' : 's'} answered${missed ? `, ${missed} did not` : ' — none failed'}.` : `No window in the last 24 hours has a check yet (${coverageNote(hd.uptime && hd.uptime['24h'])}).`,
    grey ? ` ${grey} window${grey === 1 ? '' : 's'} were never probed${since ? ` — they cover the time before recording started (${since})` : ', so nothing is claimed for them'}.` : '');
  const upTiles = h('div', { class: 'sm-uptime' }, uptimeCell(hd, '24h'), uptimeCell(hd, '7d'));
  const events = hd.events || [];
  const eventBlock = h('div', { class: 'sm-events-block' },
    h('div', { class: 'sm-sec-head tip-long', 'data-tip': 'Every moment the server flipped between answering and not answering an SSH check, newest first. Only real checks create a line here.' }, 'Up/down changes'),
    events.length
      ? h('div', { class: 'sm-events' }, ...events.map((ev) => h('div', { class: 'sm-event' },
          h('span', { class: `badge ${ev.up ? 'badge-green' : 'badge-amber'}` }, ev.up ? 'Up' : 'Down'),
          h('span', { class: 'muted' }, timeAgo(ev.t)))))
      : h('div', { class: 'muted sm-noevents' }, `No changes in the ${hd.count} check${hd.count === 1 ? '' : 's'} recorded so far — the server answered every one.`));
  return h('div', { class: 'card ov-card sm-health' },
    h('div', { class: 'ov-card-head' }, h('div', {},
      h('div', { class: 'ov-card-title' }, 'Health & uptime'),
      h('div', { class: 'ov-card-sub' }, 'Right now: ', statusDot(hd), h('span', { class: 'muted tip-long', 'data-tip': `When the dashboard last probed the server over SSH — automatically on your refresh interval and whenever you press Refresh. ${hd.count} check${hd.count === 1 ? '' : 's'} are recorded in total.` }, ` · last check ${hd.lastSampleAt ? timeAgo(hd.lastSampleAt) : '—'}`)))),
    h('div', { class: 'sm-stripwrap' }, strip, note), upTiles, eventBlock,
    h('div', { class: 'muted sm-health-foot' }, '“Down” means the server did not answer an SSH check at that moment; it is not the same as your website being healthy.'));
}

// ---------- resource usage: "how much of total" + real 24h trend ----------

// Meters use live metrics (always available from the host); tagged for in-place refresh.
function metersCard(host) {
  const m = (host && host.metrics) || {};
  const mem = m.memory || {};
  const disk = m.disk || {};
  return h('div', { class: 'card ov-card' },
    h('div', { class: 'ov-card-head' }, h('div', {}, h('div', { class: 'ov-card-title' }, 'Resource usage'), h('div', { class: 'ov-card-sub' }, 'How much of the server\u2019s total each resource is using right now \u2014 read live over SSH.'))),
    h('div', { class: 'barlist' },
      meter('cpu', 'CPU', m.cpuPct, m.cores != null ? `busy of ${m.cores} core${m.cores === 1 ? '' : 's'}` : null),
      meter('mem', 'Memory', mem.usedPct, mem.totalMb != null ? `${round1((mem.usedMb || 0) / 1024)} / ${round1(mem.totalMb / 1024)} GB used` : null),
      meter('disk', 'Disk', disk.usedPct, disk.totalGb != null ? `${round1(disk.usedGb)} / ${round1(disk.totalGb)} GB used` : null)));
}

// The 24h trend chart is built only from real collected samples (no data yet -> an honest banner).
function trendCard(health) {
  const series = (health && health.series) || [];
  const pts = series.map((b) => ({
    label: timeLabel(b.from),
    title: `${timeLabel(b.from)} \u2013 ${timeLabel(b.from + 3600000)}`,
    vals: { cpu: b.cpu.avg, mem: b.mem.avg, disk: b.disk.avg },
    raw: b,
  }));
  const withData = pts.filter((p) => p.raw.cpu.n || p.raw.mem.n || p.raw.disk.n);
  if (!withData.length) {
    return banner('info', 'Usage-over-time charts appear once enough automatic checks have been sampled (about every 30 minutes). Nothing is plotted until there is a real reading.');
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
  return chartCard('Usage over time', 'Last 24 hours · hourly averages of the real SSH checks (a gap means nothing was sampled that hour)', chart, table);
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

function statusPill(s, liveKey, tip = true) {
  const map = { running: 'badge-green', provision: 'badge-blue', provisioning: 'badge-blue', maintenance: 'badge-blue', suspended: 'badge-amber', stopped: 'badge-gray' };
  const key = String(s || '').toLowerCase();
  const props = { class: tip ? `badge tip-long ${map[key] || 'badge-amber'}` : `badge ${map[key] || 'badge-amber'}` };
  if (tip) props['data-tip'] = 'Status is whether the server answered over SSH (not application health)';
  if (liveKey) props['data-live'] = liveKey;
  return h('span', props, s || 'unknown');
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
    h('td', {}, statusPill(s.status, s === (state.servers && state.servers[0]) ? 'r-status' : null, false)),
    h('td', { 'data-live': s === (state.servers && state.servers[0]) ? 'r-uptime' : null }, (s.metrics && humanUptime(s.metrics.uptimeSeconds)) || '—')));

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
    const data = await api('GET', `/api/${S}/servers/${encodeURIComponent(id)}`, null, { timeoutMs: 25000 });
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
  const upCell = (w) => uptimeLine(hd, w);
  const spec = [
    ['Hostname', server.hostname || '—'],
    ['Provider', server.provider || '—'],
    ['Operating system', server.os || '—'],
    ['Kernel', server.kernel || '—'],
    ['Status', server.status || '—', 's-status'],
    ['Public IP', server.publicIp || '—'],
    ['Interface IP', server.internalIp || '—'],
    ['CPU cores', m.cores != null ? String(m.cores) : '—'],
    ['CPU usage (now)', m.cpuPct != null ? `${m.cpuPct}%` : '—', 's-cpu'],
    ['Load (1/5/15 min)', m.load1 != null ? `${m.load1} / ${m.load5} / ${m.load15}` : '—', 's-load'],
    ['Uptime (this boot)', humanUptime(m.uptimeSeconds) || '—', 's-uptime'],
    ['Uptime · 24h', upCell('24h'), 's-up24'],
    ['Uptime · 7d', upCell('7d'), 's-up7'],
    ['Memory', (m.memory && m.memory.totalMb != null) ? `${round1((m.memory.usedMb || 0) / 1024)} / ${round1(m.memory.totalMb / 1024)} GB${m.memory.usedPct != null ? ` (${m.memory.usedPct}% used)` : ''}` : (server.memoryGb != null ? `${server.memoryGb} GB` : '—'), 's-mem'],
    [`Disk${m.disk && m.disk.mount ? ` (${m.disk.mount})` : ''}`, (m.disk && m.disk.totalGb != null) ? `${round1(m.disk.usedGb)} / ${round1(m.disk.totalGb)} GB${m.disk.usedPct != null ? ` (${m.disk.usedPct}% used)` : ''}` : (server.diskGb != null ? `${server.diskGb} GB` : '—'), 's-disk'],
  ];
  out.push(h('div', { class: 'card sm-meta' }, ...spec.map(([k, v, lk]) =>
    h('div', { class: 'sm-meta-row' }, h('div', { class: 'sm-meta-k' }, k), h('div', { class: 'sm-meta-v mono', 'data-live': lk || null }, String(v))))));

  out.push(metersCard(server));
  out.push(h('div', { class: 'sm-slot', 'data-slot': 'chart' }, trendCard(state.health)));
  out.push(h('div', { class: 'sm-slot', 'data-slot': 'health' }, healthPanel(state.health)));
  refs.sig = healthSig(state.health);


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
