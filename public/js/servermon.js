// Server Monitoring (over the existing SSH connection) — foundation: live server facts + settings, read-only.
// Reuses the shared helpers (lib.js) and chart kit (charts.js). Everything renders through h()
// (text nodes only), so hostnames, IPs and OS strings read from the server are treated as untrusted.
// Metrics history, Health, Alerts and Recovery are shown only as clearly-labelled "future phase" panels —
// no numbers, incidents or statuses are ever invented here; what you see is read live from the server.
import { $, h, api, toast, icon, fmtDate, timeAgo, formModal } from './lib.js';
import { tile, barList } from './charts.js';

const S = 'server-monitoring';
let state = blank();

function blank() {
  return {
    tab: 'overview', server: null,
    status: null, servers: null, meta: null, settings: null,
    q: '', region: '', statusSel: '', sort: { key: 'name', dir: 1 },
  };
}

export function resetServerMonitoring() { state = blank(); }

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
  const refresh = h('button', { class: 'icon-btn', title: 'Refresh now', 'data-tip': 'Refresh now', onclick: () => refreshNow() }, icon('refresh', 16));
  return h('div', { class: 'toolbar' }, seg, h('span', { class: 'spacer' }), updated, refresh);
}

async function refreshNow() {
  state.servers = null; state.meta = null;
  await drawTab();
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

// ---------- entry ----------

async function drawTab() {
  draw([loadingBar(), skeleton()]);
  try {
    const status = await getStatus();
    if (!status.tokenSet) return drawTabResult([connectCard()]);
    switch (state.tab) {
      case 'settings': return drawTabResult(await settingsView());
      case 'server': return drawTabResult(await detailView());
      case 'servers': {
        await getServers(false);
        return drawTabResult(serversView());
      }
      default: {
        await getServers(false);
        return drawTabResult(overviewView(status));
      }
    }
  } catch (err) {
    return drawTabResult([banner('err', err.message || 'Could not load Server Monitoring.'), refreshRetry()]);
  }
}

function drawTabResult(content) { draw(content); }

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

  out.push(futurePhaseNote('Historical metric charts, uptime/incidents, alerts and recovery actions will appear here once those phases are approved. Everything shown now is read live from the server over SSH \u2014 nothing is invented.'));
  out.push(h('div', { class: 'table-foot' }, `Source: ${state.meta?.source || '—'}${state.meta?.refreshedAt ? ` · ${fmtDate(state.meta.refreshedAt)}` : ''}`));
  return out;
}

function futurePhaseNote(text) {
  return h('div', { class: 'card ov-card sm-future' },
    h('div', { class: 'ov-card-head' }, h('div', {}, h('div', { class: 'ov-card-title' }, 'Future phases'), h('div', { class: 'ov-card-sub' }, text))),
    h('div', { class: 'sm-future-grid' },
      ...[['Metrics & charts', 'Historical CPU, memory, disk and network charts, sampled from the server over SSH.'],
        ['Health & uptime', 'Rolling uptime and incident history for the server.'],
        ['Alerts & notifications', 'Threshold and health alerts (email and other channels).'],
        ['Recovery actions', 'Controlled service restarts and other safe remediations, with confirmation, cooldown and audit.']]
        .map(([t, d]) => h('div', { class: 'sm-future-item' }, icon('info', 15), h('div', {}, h('div', { class: 'strong' }, t), h('div', { class: 'muted' }, d, h('span', { class: 'badge badge-gray' }, 'Available in a future phase')))))));
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
  const spec = [
    ['Hostname', server.hostname || '—'],
    ['Provider', server.provider || '—'],
    ['Operating system', server.os || '—'],
    ['Kernel', server.kernel || '—'],
    ['Status', server.status || '—'],
    ['Public IP', server.publicIp || '—'],
    ['Interface IP', server.internalIp || '—'],
    ['CPU cores', m.cores != null ? String(m.cores) : '—'],
    ['Load (1/5/15 min)', m.load1 != null ? `${m.load1} / ${m.load5} / ${m.load15}` : '—'],
    ['Uptime', humanUptime(m.uptimeSeconds) || '—'],
    ['Memory', (m.memory && m.memory.totalMb != null) ? `${round1((m.memory.usedMb || 0) / 1024)} / ${round1(m.memory.totalMb / 1024)} GB${m.memory.usedPct != null ? ` (${m.memory.usedPct}% used)` : ''}` : (server.memoryGb != null ? `${server.memoryGb} GB` : '—')],
    [`Disk${m.disk && m.disk.mount ? ` (${m.disk.mount})` : ''}`, (m.disk && m.disk.totalGb != null) ? `${round1(m.disk.usedGb)} / ${round1(m.disk.totalGb)} GB${m.disk.usedPct != null ? ` (${m.disk.usedPct}% used)` : ''}` : (server.diskGb != null ? `${server.diskGb} GB` : '—')],
  ];
  out.push(h('div', { class: 'card sm-meta' }, ...spec.map(([k, v]) =>
    h('div', { class: 'sm-meta-row' }, h('div', { class: 'sm-meta-k' }, k), h('div', { class: 'sm-meta-v mono' }, String(v))))));

  out.push(h('div', { class: 'sm-future-grid' },
    ...[['Metrics', 'CPU, memory, disk and network charts.'],
      ['Health & uptime', 'Endpoint checks and incidents.'],
      ['Alerts', 'Threshold and health alerts.'],
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
