// Overview (owner home page): how the site's APIs are doing, from the server logs.
import { $, h, api, toast, icon, timeAgo, fmtDate, displayPath, publicUrl, copyWithFeedback, storeGet, storeSet } from './lib.js';
import { openEditorAt } from './editor.js';
import {
  compact, num, ms, setZone, bucketLabels, periodText, columnChart, chartCard, simpleTable,
  sparkline, tile, delta, statusLine, trendBadge, countryCard,
} from './charts.js';
import DateRangePicker from './datepicker.js';

export const PERIODS = ['today', 'yesterday', '7d', '30d', 'custom'];
export const VS = { today: 'yesterday at this time', '7d': 'the 7 days before' };
const PERIOD_LABEL = { today: 'Today', yesterday: 'Yesterday', '7d': '7 days', '30d': '30 days', custom: 'Custom range' };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const state = {
  period: 'today',
  from: DATE_RE.test(storeGet('ovFrom')) ? storeGet('ovFrom') : '',
  to: DATE_RE.test(storeGet('ovTo')) ? storeGet('ovTo') : '',
  data: null,
  loading: false,
  sort: { key: 'requests', dir: -1 },
  filter: '',
  showAll: false,
  showIgnored: false,
  showProbes: false,
  hideProbes: true,
};
let timer = null;
let picker = null;

export const currentPeriod = () => state.period;
// A custom range only applies while the Overview is in custom mode; API detail reuses it.
export const currentRange = () => (state.period === 'custom' && state.from && state.to ? { from: state.from, to: state.to } : null);
export function setPeriod(p) {
  if (!PERIODS.includes(p)) return;
  state.period = p;
  storeSet('ovPeriod', p);
}

const isVisible = () => !$('view-overview').classList.contains('hidden');

export async function showOverview() {
  clearInterval(timer);
  timer = setInterval(() => { if (isVisible() && state.period !== 'yesterday' && !document.hidden) load(false); }, 120000);
  renderPeriod();
  await load(false);
}

// Clear the in-view UI state so switching back to Overview starts clean: the period falls
// back to Today (the saved custom range is kept so the picker need not be re-filled).
export function resetOverview() {
  state.period = 'today';
  state.filter = '';
  state.showAll = false;
  state.showIgnored = false;
  state.showProbes = false;
  state.hideProbes = true;
  const panel = $('ovCustom');
  if (panel) panel.hidden = true;
}

async function load(fresh) {
  if (state.loading) return;
  state.loading = true;
  $('ovBody').classList.add('refreshing'); // keep the previous render, dimmed, while refetching
  $('ovRefresh').disabled = true;
  const wanted = state.period;
  const range = currentRange();
  const rangeQs = range ? `&from=${range.from}&to=${range.to}` : '';
  try {
    const data = await api('GET', `/api/overview?period=${wanted}${rangeQs}${fresh ? '&fresh=1' : ''}`, null, { timeoutMs: 45000 });
    if (wanted === state.period) {
      state.data = data;
      render();
    }
  } catch (err) {
    toast(err.message, 'err');
    if (!state.data) $('ovBody').replaceChildren(h('div', { class: 'empty-state' }, h('div', { class: 'empty-title' }, 'Could not load the overview'), h('div', { class: 'empty-text' }, err.message)));
  } finally {
    state.loading = false;
    $('ovBody').classList.remove('refreshing');
    $('ovRefresh').disabled = false;
    if (wanted !== state.period) load(false); // the period changed while loading
  }
}

function renderPeriod() {
  const label = $('ovCalLabel');
  if (label) label.textContent = PERIOD_LABEL[state.period] || 'Today';
  // Keep the open picker in sync with the current period.
  const panel = $('ovCustom');
  if (picker && panel && !panel.hidden) {
    if (state.period === 'custom' && state.from && state.to) picker.setRange(state.from, state.to);
    else picker.markPreset(state.period);
  }
}

// ---------- page ----------

function render() {
  const d = state.data;
  const body = $('ovBody');
  setZone(d.timezone);
  if (d.unavailable || d.empty) {
    $('ovRange').textContent = d.from ? periodText({ ...d, to: d.to || d.from }) : '';
    $('ovUpdated').textContent = '';
    body.replaceChildren(h('div', { class: 'empty-state' },
      h('span', { class: 'empty-icon' }, icon('chart', 26)),
      h('div', { class: 'empty-title' }, d.unavailable ? 'No traffic log available' : 'No API calls in this period yet'),
      h('div', { class: 'empty-text' }, d.reason || 'Calls will show up here as the apps use your APIs.')));
    return;
  }
  $('ovRange').textContent = periodText(d);
  $('ovUpdated').textContent = `Updated ${new Date(d.generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: d.timezone })}`;

  body.replaceChildren(...[
    renderKpis(d),
    h('div', { class: 'ov-sub' }, `${num(d.totals.uniqueIps)} different devices (IPs) · ${num(d.totals.apis)} APIs called${d.totals.probes ? ` · ${num(d.totals.probes)} bot probe URLs` : ''} · times in ${d.timezone} · from the server's own logs`),
    renderCalls(d),
    d.totals.errors5xx ? renderErrorsChart(d) : null,
    countryCard(d.countries, { total: d.totals.requests }),
    d.bucket === 'day' && d.trendDays ? renderChanges(d) : null,
    renderAttention(d),
    renderApis(d),
    renderPhpErrors(d),
  ].filter(Boolean));
}

// ---------- KPI tiles ----------

function renderKpis(d) {
  const t = d.totals;
  const c = d.compare;
  const vs = VS[d.period];
  const errorRate = t.requests ? (t.errors5xx / t.requests) * 100 : 0;
  const phpFiles = new Set(d.phpErrors.map((e) => e.path || e.serverFile)).size;
  const days = d.bucket === 'day' ? d.hours.length : 0;
  const callsSub = c ? delta(t.requests, c.requests, { upIsGood: null, vs })
    : h('div', { class: 'kpi-delta' }, days ? `≈ ${compact(t.requests / days)} per day` : `${num(t.requests)} in total`);
  return h('div', { class: 'kpis' },
    tile(days ? `API calls · ${days} days` : 'API calls', compact(t.requests), callsSub, num(t.requests)),
    tile('Average response', ms(t.avgMs), c ? delta(t.avgMs, c.avgMs, { upIsGood: false, vs }) : h('div', { class: 'kpi-delta' }, 'per API call')),
    tile('Server errors (5xx)', num(t.errors5xx),
      statusLine(!t.errors5xx, 'No server errors', `${errorRate < 0.1 ? '<0.1' : errorRate.toFixed(1)}% of calls failed`)),
    tile('PHP errors logged', num(t.phpErrors),
      statusLine(!t.phpErrors, 'Nothing in the error log', `in ${phpFiles} file${phpFiles === 1 ? '' : 's'}`)));
}

// ---------- charts ----------

function renderCalls(d) {
  const daily = d.bucket === 'day';
  const points = d.hours.map((r) => {
    const l = bucketLabels(d.bucket, r.start);
    return {
      label: l.short,
      title: l.long,
      value: r.requests,
      rows: [[num(r.requests), 'API calls'], [ms(r.avgMs), 'average response'],
        ...(r.errors ? [[num(r.errors), 'server errors']] : []), ...(r.phpErrors ? [[num(r.phpErrors), 'PHP errors']] : [])],
    };
  });
  return chartCard(daily ? 'API calls per day' : 'API calls per hour', 'Hover a column for details',
    columnChart(points, { ariaLabel: daily ? 'API calls per day' : 'API calls per hour' }),
    simpleTable(d.hours, [
      { label: daily ? 'Day' : 'Hour', get: (r) => bucketLabels(d.bucket, r.start).long },
      { label: 'API calls', num: true, get: (r) => num(r.requests) },
      { label: 'Avg response', num: true, get: (r) => ms(r.avgMs) },
      { label: 'Server errors', num: true, get: (r) => num(r.errors) },
      { label: 'PHP errors', num: true, get: (r) => num(r.phpErrors) },
    ]));
}

function renderErrorsChart(d) {
  const daily = d.bucket === 'day';
  const points = d.hours.map((r) => {
    const l = bucketLabels(d.bucket, r.start);
    return { label: l.short, title: l.long, value: r.errors, rows: [[num(r.errors), 'server errors (5xx)'], [num(r.requests), 'API calls']] };
  });
  return chartCard(`Server errors (5xx) per ${daily ? 'day' : 'hour'}`, 'Calls where PHP crashed or the server failed',
    columnChart(points, { colorVar: '--status-critical', ariaLabel: 'Server errors' }),
    simpleTable(d.hours, [
      { label: daily ? 'Day' : 'Hour', get: (r) => bucketLabels(d.bucket, r.start).long },
      { label: 'Server errors', num: true, get: (r) => num(r.errors) },
    ]));
}

// ---------- growing / shrinking APIs ----------

function renderChanges(d) {
  const n = d.trendDays;
  const candidates = d.apis.filter((a) => (a.recent || 0) + (a.previous || 0) >= 50);
  const byChange = [...candidates].sort((x, y) => (y.recent - y.previous) - (x.recent - x.previous));
  const rising = byChange.filter((a) => a.recent > a.previous).slice(0, 5);
  const falling = byChange.filter((a) => a.recent < a.previous).reverse().slice(0, 5);
  const list = (items, empty) => (items.length
    ? h('div', { class: 'chg-list' }, ...items.map((a) => h('a', { class: 'chg-row', href: apiHref(a.script) },
      apiName(a),
      sparkline(a.daily),
      h('span', { class: 'chg-nums' }, `${compact(a.previous)} → ${compact(a.recent)}`),
      trendBadge(a.recent, a.previous))))
    : h('div', { class: 'muted chg-empty' }, empty));
  return h('div', { class: 'card ov-card' },
    h('div', { class: 'ov-card-head' }, h('div', {},
      h('div', { class: 'ov-card-title' }, 'Biggest changes'),
      h('div', { class: 'ov-card-sub' }, `Calls in the last ${n} full days compared with the ${n} days before (today is still running, so it is left out). Click an API for details.`))),
    h('div', { class: 'chg-grid' },
      h('div', {}, h('div', { class: 'chg-head' }, icon('up', 14), 'Growing'), list(rising, 'No API grew noticeably.')),
      h('div', {}, h('div', { class: 'chg-head down' }, icon('up', 14), 'Shrinking'), list(falling, 'No API dropped noticeably.'))));
}

// ---------- needs attention ----------

export const apiHref = (script) => `#/api?script=${encodeURIComponent(script)}`;
const mostly4xx = (a) => a.errors4xx >= a.requests * 0.9;
const ignoredSet = () => new Set((state.data?.ignored || []).map((x) => x.script));

function issuesFor(a) {
  const out = [];
  if (a.errors5xx) out.push(['bad', 'alert', `${num(a.errors5xx)} server error${a.errors5xx === 1 ? '' : 's'} (5xx)`]);
  if (a.phpErrors) out.push(['bad', 'alert', `${num(a.phpErrors)} PHP error${a.phpErrors === 1 ? '' : 's'} logged`]);
  if (a.avgMs >= 1000) out.push(['warn', 'info', `Slow: ${ms(a.avgMs)} on average`]);
  if (mostly4xx(a) && !a.missing && !a.probe) out.push(['warn', 'info', `${num(a.errors4xx)} of ${num(a.requests)} calls answered 4xx`]);
  if (a.missing && (a.errors5xx || a.phpErrors)) out.push(['warn', 'info', 'File no longer exists']);
  return out;
}

// Ignore = a note kept in the dashboard's own data folder; nothing on the server changes.
export async function setIgnored(script, ignore) {
  const res = await api('POST', '/api/overview/ignore', { script, ignore });
  if (state.data) state.data.ignored = res.ignored;
  toast(ignore ? `${script.split('/').pop()} hidden from Needs attention` : `${script.split('/').pop()} is shown again`);
  return res.ignored;
}

async function toggleIgnore(a, ignore) {
  try {
    await setIgnored(a.script, ignore);
    render();
  } catch (err) { toast(err.message, 'err'); }
}

function attnRow(a, issues, { ignored = false } = {}) {
  return h('div', { class: 'attn' },
    h('div', { class: 'attn-main' },
      h('a', { class: 'attn-name', href: apiHref(a.script) }, apiName(a)),
      h('div', { class: 'attn-issues' }, ...issues.map(([tone, ic, text]) => h('span', { class: `issue ${tone}` }, icon(ic, 13), text)))),
    h('div', { class: 'attn-actions' },
      a.missing ? null : h('button', { class: 'icon-btn ghost sm', title: 'Open file', onclick: () => openApi(a) }, icon('edit', 15)),
      publicUrl(a.path) ? h('button', { class: 'icon-btn ghost sm', title: 'Copy URL', onclick: () => copyWithFeedback(publicUrl(a.path), 'URL') }, icon('link', 15)) : null,
      ignored
        ? h('button', { class: 'btn btn-sm', onclick: () => toggleIgnore(a, false) }, icon('eye', 14), 'Show again')
        : h('button', { class: 'btn btn-sm', title: 'Hide this API from Needs attention (e.g. removed on purpose)', onclick: () => toggleIgnore(a, true) }, icon('eyeOff', 14), 'Ignore')));
}

const missingIssue = (a) => [['warn', 'info', `Called ${num(a.requests)}× — file not found (404)`]];

function renderAttention(d) {
  const ig = ignoredSet();
  const flagged = d.apis.map((a) => ({ a, issues: issuesFor(a) })).filter((x) => x.issues.length && !ig.has(x.a.script))
    .sort((x, y) => (y.a.errors5xx + y.a.phpErrors) - (x.a.errors5xx + x.a.phpErrors) || y.a.requests - x.a.requests);
  // Missing files the apps keep calling: one group, biggest first (often old app versions).
  const isMissingOnly = (a) => a.missing && !a.probe && mostly4xx(a) && !a.errors5xx && !a.phpErrors;
  const missing = d.apis.filter((a) => isMissingOnly(a) && !ig.has(a.script));
  const hidden = d.apis.filter((a) => ig.has(a.script) && (issuesFor(a).length || isMissingOnly(a)));
  const ignoredFooter = hidden.length ? h('div', { class: 'attn-ignored' },
    h('button', { class: 'btn btn-sm', onclick: () => { state.showIgnored = !state.showIgnored; render(); } },
      icon(state.showIgnored ? 'eye' : 'eyeOff', 14), state.showIgnored ? 'Hide ignored APIs' : `${hidden.length} ignored API${hidden.length === 1 ? '' : 's'}`),
    state.showIgnored ? h('div', { class: 'attn-list' }, ...hidden.map((a) => attnRow(a, issuesFor(a).length ? issuesFor(a) : missingIssue(a), { ignored: true }))) : null) : null;

  const probes = d.apis.filter((a) => a.probe);
  const probeFooter = probes.length ? h('div', { class: 'attn-probes' },
    h('div', { class: 'attn-group-head' }, icon('shield', 15),
      h('span', {}, h('b', {}, `${num(probes.length)} unknown URLs were tried ${num(d.totals.probeCalls)} times`),
        ' — bots scanning for weak spots (like /phpinfo.php). Every public website gets these; your files are not affected and there is nothing to fix.')),
    h('button', { class: 'btn btn-sm', onclick: () => { state.showProbes = !state.showProbes; render(); } }, state.showProbes ? 'Hide list' : 'Show the most tried'),
    state.showProbes ? h('div', { class: 'probe-list mono' }, ...probes.slice(0, 40).map((a) => h('div', {}, h('span', {}, a.script), h('span', { class: 'muted' }, `${num(a.requests)}×`)))) : null) : null;

  if (!flagged.length && !missing.length) {
    return h('div', { class: 'card ov-card' }, ...[
      h('div', { class: 'ov-allgood' }, icon('check', 18),
        h('div', {}, h('div', { class: 'ov-card-title' }, 'All APIs look healthy'), h('div', { class: 'ov-card-sub' }, 'No server errors, PHP errors, missing files or slow APIs in this period.'))),
      ignoredFooter,
      probeFooter,
    ].filter(Boolean));
  }
  const missingCalls = missing.reduce((n, a) => n + a.requests, 0);
  const missingList = h('div', { class: 'attn-list' });
  const drawMissing = (allRows) => {
    missingList.replaceChildren(...(allRows ? missing : missing.slice(0, 5)).map((a) => attnRow(a, missingIssue(a))));
    if (missing.length > 5) {
      missingList.append(h('div', { class: 'ov-more' }, h('button', { class: 'btn btn-sm', onclick: () => drawMissing(!allRows) }, allRows ? 'Show top 5' : `Show all ${missing.length}`)));
    }
  };
  drawMissing(false);
  return h('div', { class: 'card ov-card' },
    h('div', { class: 'ov-card-head' }, h('div', {},
      h('div', { class: 'ov-card-title' }, `Needs attention (${flagged.length + missing.length})`),
      h('div', { class: 'ov-card-sub' }, 'Only a list — nothing here changes your server. Use Ignore for APIs removed on purpose.'))),
    ...[
      flagged.length ? h('div', { class: 'attn-list' }, ...flagged.slice(0, 20).map(({ a, issues }) => attnRow(a, issues))) : null,
      missing.length ? h('div', { class: 'attn-group' },
        h('div', { class: 'attn-group-head' }, icon('info', 15),
          h('span', {}, h('b', {}, `${missing.length} missing file${missing.length === 1 ? '' : 's'}`),
            ` in your own folders were called ${num(missingCalls)} times. Usually an old app version still uses a removed API — restore the file, update the app, or Ignore it.`)),
        missingList) : null,
      ignoredFooter,
      probeFooter,
    ].filter(Boolean));
}

// "public_html/api_downloader/x.php" -> muted "api_downloader/" + "x.php"
export function apiName(a) {
  const rel = displayPath(a.path).replace(/^[^/]+\//, '');
  const i = rel.lastIndexOf('/');
  return h('span', { class: 'api-name', title: a.path },
    i > 0 ? h('span', { class: 'api-dir' }, rel.slice(0, i + 1)) : null,
    h('span', { class: 'api-file' }, rel.slice(i + 1)));
}

function openApi(a) {
  if (a.missing) return toast('This file does not exist on the server', 'err');
  openEditorAt(a.path);
}

// ---------- all APIs table ----------

function renderApis(d) {
  const multi = d.bucket === 'day';
  const ig = ignoredSet();
  const tableArea = h('div', {});
  const card = h('div', { class: 'card ov-card' },
    h('div', { class: 'ov-card-head' },
      h('div', {}, h('div', { class: 'ov-card-title' }, `All APIs (${num(d.totals.apis)})`), h('div', { class: 'ov-card-sub' }, 'Click a name for details · ✎ opens the file')),
      h('div', { class: 'ov-table-tools' },
        d.totals.probes ? h('label', { class: 'check-label' },
          h('input', { type: 'checkbox', class: 'check', checked: state.hideProbes, onchange: (e) => { state.hideProbes = e.target.checked; draw(); } }),
          'Hide bot probes') : null,
        h('label', { class: 'search ov-search' }, icon('search', 15),
          h('input', { type: 'search', placeholder: 'Filter APIs', value: state.filter, oninput: (e) => { state.filter = e.target.value; draw(); } })))),
    tableArea);
  const trendValue = (a) => (a.previous ? (a.recent - a.previous) / a.previous : a.recent ? 1e9 : -1e9);
  const draw = () => {
    const f = state.filter.toLowerCase();
    const { key, dir } = state.sort;
    const value = (a) => (key === 'trend' ? trendValue(a) : a[key]);
    const rows = d.apis.filter((a) => (!f || a.script.toLowerCase().includes(f)) && !(state.hideProbes && a.probe))
      .sort((x, y) => (key === 'script' ? x.script.localeCompare(y.script) : value(x) - value(y)) * dir);
    const shown = state.showAll ? rows : rows.slice(0, 25);
    const maxReq = Math.max(1, ...d.apis.map((a) => a.requests));
    const th = (label, k, numCol = true) => h('th', {
      class: `${numCol ? 'num' : ''} sortable${key === k ? ' sorted' : ''}`,
      dataset: { dir: dir > 0 ? 'asc' : 'desc' },
      onclick: () => { state.sort = { key: k, dir: key === k ? -dir : k === 'script' ? 1 : -1 }; draw(); },
    }, label);
    const flag = (n, tone) => (n ? h('span', { class: `issue ${tone}` }, icon('alert', 12), num(n)) : h('span', { class: 'muted' }, '0'));
    tableArea.replaceChildren(...[
      h('div', { class: 'ov-table-wrap' }, h('table', { class: `table compact api-table${multi ? ' with-trend' : ''}` },
        h('thead', {}, h('tr', {}, ...[th('API', 'script', false), th('Calls', 'requests'),
          multi ? th(`Trend (${d.trendDays}d)`, 'trend') : null,
          th('Avg', 'avgMs'), th('Max', 'maxMs'), th('4xx', 'errors4xx'), th('5xx', 'errors5xx'), th('PHP errors', 'phpErrors'), h('th', {})].filter(Boolean))),
        h('tbody', {}, ...shown.map((a) => h('tr', { class: a.missing ? 'dimmed' : '' }, ...[
          h('td', { class: 'cell-api' }, h('a', { href: apiHref(a.script) }, apiName(a)),
            a.probe ? h('span', { class: 'chip' }, 'bot probe') : a.missing ? h('span', { class: 'chip' }, 'missing') : null, ig.has(a.script) ? h('span', { class: 'chip' }, 'ignored') : null),
          h('td', { class: 'num' }, h('div', { class: 'calls' }, h('span', {}, num(a.requests)), h('span', { class: 'calls-bar', style: `width:${Math.max(2, (a.requests / maxReq) * 100)}%` }))),
          multi ? h('td', { class: 'num cell-trend' }, h('div', { class: 'trend-cell' }, sparkline(a.daily, { width: 72, height: 20 }), trendBadge(a.recent, a.previous))) : null,
          h('td', { class: 'num' }, ms(a.avgMs)),
          h('td', { class: 'num' }, ms(a.maxMs)),
          h('td', { class: 'num' }, a.errors4xx ? num(a.errors4xx) : h('span', { class: 'muted' }, '0')),
          h('td', { class: 'num' }, flag(a.errors5xx, 'bad')),
          h('td', { class: 'num' }, flag(a.phpErrors, 'bad')),
          h('td', { class: 'cell-actions' }, a.missing ? null : h('button', { class: 'icon-btn ghost sm', title: 'Open file', onclick: () => openApi(a) }, icon('edit', 15))),
        ].filter(Boolean)))))),
      rows.length > 25 ? h('div', { class: 'ov-more' }, h('button', { class: 'btn btn-sm', onclick: () => { state.showAll = !state.showAll; draw(); } },
        state.showAll ? 'Show top 25' : `Show all ${rows.length}`)) : null,
    ].filter(Boolean));
  };
  draw();
  return card;
}

// ---------- PHP errors ----------

export function phpErrorList(errors) {
  return h('div', { class: 'err-list' }, ...errors.map((e) => h('button', {
    class: `err-row${e.missing ? ' dimmed' : ''}`,
    onclick: () => (e.missing || !e.path ? toast(e.path ? 'This file no longer exists' : 'This file is outside the website folder', 'err') : openEditorAt(e.path, e.line)),
  },
  h('span', { class: `issue ${/error/i.test(e.kind) ? 'bad' : 'warn'}` }, icon('alert', 12), e.kind),
  h('span', { class: 'err-msg' }, e.message,
    h('span', { class: 'err-where mono' }, `${e.path ? displayPath(e.path) : e.serverFile} — line ${e.line}${e.missing ? ' · file no longer exists' : ''}`)),
  h('span', { class: 'err-count', title: `${e.count} times` }, `×${num(e.count)}`),
  h('span', { class: 'err-when', title: fmtDate(e.lastSeen) }, timeAgo(e.lastSeen)))));
}

function renderPhpErrors(d) {
  if (!d.phpErrors.length) return null;
  return h('div', { class: 'card ov-card' },
    h('div', { class: 'ov-card-head' }, h('div', {},
      h('div', { class: 'ov-card-title' }, 'PHP errors from the server log'),
      h('div', { class: 'ov-card-sub' }, 'Grouped by file and line, newest first. Click to open the file at that line.'))),
    phpErrorList(d.phpErrors));
}

// ---------- wiring ----------

const calBtn = $('ovCalBtn');
if (calBtn) calBtn.onclick = () => {
  const panel = $('ovCustom');
  if (panel && panel.hidden) openCustomPanel();
  else closeCustomPanel();
};
$('ovRefresh').onclick = () => load(true);

function openCustomPanel() {
  const panel = $('ovCustom');
  if (!panel) return;
  panel.hidden = false;
  if (!picker) {
    picker = new DateRangePicker(panel, {
      max: new Date(),
      format: 'DD-MM-YYYY',
      // A preset that maps to a dashboard period uses it (so Today keeps its hourly view,
      // 7d/30d their comparisons); any other preset or a manual range becomes the custom period.
      onApply: ({ period, from, to }) => {
        if (period && PERIODS.includes(period)) {
          setPeriod(period);
        } else {
          state.from = from; state.to = to;
          storeSet('ovFrom', from); storeSet('ovTo', to);
          setPeriod('custom');
        }
        state.showAll = false;
        closeCustomPanel();
        renderPeriod();
        load(true);
      },
      onCancel: () => closeCustomPanel(),
    });
  }
  // Sync the picker to the current selection when opening.
  if (state.period === 'custom' && state.from && state.to) picker.setRange(state.from, state.to);
  else picker.markPreset(state.period);
}

function closeCustomPanel() {
  const panel = $('ovCustom');
  if (panel) panel.hidden = true;
}
