// Server Monitoring (Cloudways) — foundation: inventory + settings, read-only.
// Reuses the shared helpers (lib.js) and chart kit (charts.js). Everything renders through h()
// (text nodes only), so server names, IPs and labels from the API are treated as untrusted.
// Metrics, Health, Alerts and Recovery are shown only as clearly-labelled "future phase" panels —
// no numbers, incidents or statuses are ever invented here.
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
  await draw();
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
  await draw();
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
    if (m.stale) out.push(banner('warn', `Showing the last known inventory (from ${m.refreshedAt ? fmtDate(m.refreshedAt) : 'earlier'}) — ${m.error || 'Cloudways could not be reached just now.'}`));
    if (m.partial) out.push(banner('warn', 'Partial inventory: there may be more servers than Cloudways returned within the safety limit.'));
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
    h('div', { class: 'ov-card-head' }, h('div', {}, h('div', { class: 'ov-card-title' }, 'Connect Cloudways'), h('div', { class: 'ov-card-sub' }, 'Server Monitoring reads your server inventory from the Cloudways Platform API.'))),
    h('div', { class: 'sm-connect-body' },
      icon('shield', 28),
      h('p', {}, 'Your Cloudways API credentials are stored securely as server-side secrets — they are never placed in the browser, this page, or any API response. The dashboard owner runs:'),
      h('pre', { class: 'sm-cmd' }, 'cd cloudflare\nnpx wrangler secret put CLOUDWAYS_EMAIL\nnpx wrangler secret put CLOUDWAYS_API_KEY'),
      h('p', { class: 'muted' }, 'Get these from the Cloudways dashboard at platform.cloudways.com/api (API access). Once both secrets are set, open this page again to load your servers.'),
      h('div', { class: 'sm-actions' }, h('button', { class: 'btn btn-sm', onclick: () => { state.status = null; drawTab(); } }, icon('refresh', 14), 'Re-check connection'))));
}

// ---------- overview ----------

function overviewView(status) {
  const servers = state.servers || [];
  const out = [];
  out.push(...metaBanners());
  if (status) {
    out.push(h('div', { class: 'kpis' },
      tile('Connection', status.connected ? 'Verified' : 'Not verified',
        status.connected && status.connectionVerifiedAt ? h('div', { class: 'kpi-delta' }, `Last check ${timeAgo(status.connectionVerifiedAt)}`) : h('div', { class: 'kpi-delta' }, 'Credentials are set but no successful API call yet')),
      tile('Servers', String(servers.length), state.meta && state.meta.partial ? h('div', { class: 'kpi-delta' }, 'partial') : null),
      tile('Public IP', String(servers.filter((s) => s.publicIp).length), h('div', { class: 'kpi-delta' }, 'reported by Cloudways')),
      tile('Online now', String(servers.filter((s) => String(s.status).toUpperCase() === 'RUNNING').length), h('div', { class: 'kpi-delta' }, 'Cloudways status, not app health'))));
  }

  // Region distribution from returned data only.
  const byRegion = new Map();
  for (const s of servers) byRegion.set(s.region || 'Unknown', (byRegion.get(s.region || 'Unknown') || 0) + 1);
  const regionItems = [...byRegion].map(([label, count]) => [label, count]);

  const statusCounts = new Map();
  for (const s of servers) statusCounts.set(s.status || 'unknown', (statusCounts.get(s.status || 'unknown') || 0) + 1);

  out.push(h('div', { class: 'sm-two' },
    h('div', { class: 'card ov-card' },
      h('div', { class: 'ov-card-head' }, h('div', {}, h('div', { class: 'ov-card-title' }, 'By region'))),
      regionItems.length ? barList(regionItems, { max: 12 }) : h('div', { class: 'muted pad' }, 'No servers returned.')),
    h('div', { class: 'card ov-card' },
      h('div', { class: 'ov-card-head' }, h('div', {}, h('div', { class: 'ov-card-title' }, 'Server status'))),
      statusCounts.size ? barList([...statusCounts].map(([k, v]) => [k, v]), { max: 12 }) : h('div', { class: 'muted pad' }, 'No servers returned.'))));

  out.push(futurePhaseNote('Per-server metrics, uptime, alerts and recovery actions will appear here once those phases are approved.'));
  out.push(h('div', { class: 'table-foot' }, `Source: ${state.meta?.source || '—'}${state.meta?.refreshedAt ? ` · ${fmtDate(state.meta.refreshedAt)}` : ''}`));
  return out;
}

function futurePhaseNote(text) {
  return h('div', { class: 'card ov-card sm-future' },
    h('div', { class: 'ov-card-head' }, h('div', {}, h('div', { class: 'ov-card-title' }, 'Future phases'), h('div', { class: 'ov-card-sub' }, text))),
    h('div', { class: 'sm-future-grid' },
      ...[['Metrics & charts', 'CPU, memory, disk, network — from the Cloudways monitoring graph / server monitor API.'],
        ['Health & uptime', 'Server status plus Cloudways monitoring and CloudwaysBot alerts.'],
        ['Alerts & notifications', 'Threshold and health alerts via CloudwaysBot alert channels.'],
        ['Recovery actions', 'Controlled start / stop / restart via the Cloudways server API, with confirmation, cooldown and audit.']]
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
  return h('span', { class: `badge ${map[key] || 'badge-amber'}`, title: 'Server status reported by Cloudways (not application health)' }, s || 'unknown');
}

function sortHeader(label, key, cls) {
  const on = state.sort.key === key;
  return h('th', {
    class: cls, onclick: () => { if (state.sort.key === key) state.sort.dir *= -1; else state.sort = { key, dir: 1 }; draw(serversView()); },
  }, label, on ? h('span', { class: 'sort-ind' }, state.sort.dir > 0 ? ' ▲' : ' ▼') : null);
}

function serversView() {
  const servers = state.servers || [];
  const regions = [...new Set(servers.map((s) => s.region).filter(Boolean))].sort();
  const statuses = [...new Set(servers.map((s) => s.status || 'unknown'))].sort();

  const search = h('input', {
    class: 'input sm-search', type: 'search', placeholder: 'Search name, IP or ID', value: state.q, autocomplete: 'off',
    oninput: (e) => { state.q = e.target.value; draw(serversView()); },
  });
  const regionSel = h('select', { class: 'select', onchange: (e) => { state.region = e.target.value; draw(serversView()); } },
    h('option', { value: '' }, 'All regions'), ...regions.map((r) => h('option', { value: r, selected: r === state.region }, r)));
  const statusSel = h('select', { class: 'select', onchange: (e) => { state.statusSel = e.target.value; draw(serversView()); } },
    h('option', { value: '' }, 'All statuses'), ...statuses.map((s) => h('option', { value: s, selected: s === state.statusSel }, s)));

  const head = h('div', { class: 'toolbar' },
    search, regionSel, statusSel,
    h('span', { class: 'muted' }, `${filteredServers().length} of ${servers.length}`));

  const rows = filteredServers().map((s) => h('tr', {
    class: 'sm-row', onclick: () => go('server', s.id),
  },
    h('td', {}, h('div', { class: 'strong' }, s.name || `server-${s.id}`), h('div', { class: 'muted mono' }, `#${s.id ?? '—'}`)),
    h('td', {}, s.region || '—'),
    h('td', {}, s.size || '—'),
    h('td', { class: 'mono' }, s.publicIp || h('span', { class: 'muted' }, 'none')),
    h('td', {}, statusPill(s.status)),
    h('td', { class: 'cell-date' }, s.createdAt ? fmtDate(Date.parse(s.createdAt)) : '—')));

  const table = servers.length
    ? h('table', { class: 'table' },
      h('thead', {}, h('tr', {},
        sortHeader('Server', 'name'), sortHeader('Region', 'region'), sortHeader('Size', 'size'),
        sortHeader('Public IP', 'publicIp'), sortHeader('Status', 'status'), sortHeader('Created', 'createdAt'))),
      h('tbody', {}, ...rows))
    : h('div', { class: 'empty-state' }, h('div', { class: 'empty-text' }, state.meta && state.meta.unavailable ? 'Server data unavailable.' : 'No servers found on this account.'));

  return [...metaBanners(), head, h('div', { class: 'card table-card' }, table),
    h('div', { class: 'table-foot muted' }, 'The status column is what Cloudways reports for the server, which is not the same as your application being healthy.')];
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
    out.push(banner('warn', `Showing a cached copy — ${err.message || 'Cloudways could not be reached.'}`));
  }
  if (!server) return [...out, banner('err', 'That server could not be found.'), backLink()];

  const refreshed = meta.refreshedAt ? h('div', { class: 'ov-updated' }, `${meta.source === 'live' ? 'Live' : 'Cached'} · ${timeAgo(meta.refreshedAt)}`) : null;

  out.push(h('div', { class: 'sm-detail-head' },
    h('a', { class: 'btn btn-sm', href: '#/servermon?tab=servers' }, icon('back', 14), 'Servers'),
    h('h2', { class: 'sm-detail-title' }, server.name || `Server #${server.id}`),
    statusPill(server.status), refreshed));

  const spec = [
    ['Server ID', String(server.id ?? '—')],
    ['Region', server.region || '—'],
    ['Provider', server.provider || '—'],
    ['Size / plan', server.size || '—'],
    ['Status', server.status || '—'],
    ['OS', server.os || '—'],
    ['vCPUs', server.vcpus ?? '—'],
    ['Memory', server.memoryGb != null ? `${server.memoryGb} GB` : '—'],
    ['Disk', server.diskGb != null ? `${server.diskGb} GB` : '—'],
    ['Public IP', server.publicIp || '—'],
    ['Created', server.createdAt ? fmtDate(Date.parse(server.createdAt)) : '—'],
    ['Labels', server.labels && server.labels.length ? server.labels.join(', ') : '—'],
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
    ['Refresh interval', `${s.refreshSeconds} seconds`, 'How often the inventory is considered fresh before Cloudways is queried again.'],
    ['Default chart range', rangeLabel, 'Time range used by the metrics charts in a future phase.'],
    ['Default region filter', s.regionFilter || '(all)', 'Pre-selected region filter for the Servers list.'],
    ['Email alerts', s.notify?.email ? 'On' : 'Off', 'Preference only — alert delivery is not enabled in this phase.'],
  ];
  return [
    h('div', { class: 'card ov-card' },
      h('div', { class: 'ov-card-head' }, h('div', {}, h('div', { class: 'ov-card-title' }, 'Monitoring settings'), h('div', { class: 'ov-card-sub' }, 'Saved on the server and recorded in the activity log. Your Cloudways credentials are never stored here.'))),
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
