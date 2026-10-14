// One API in detail: traffic, speed, status codes, PHP errors and which phones call it.
import { $, h, api, toast, icon, publicUrl, copyWithFeedback, displayPath, session } from './lib.js';
import { openEditorAt } from './editor.js';
import { toggleTester } from './test.js';
import { VS, currentPeriod, setPeriod, setIgnored, phpErrorList } from './overview.js';
import {
  compact, num, ms, setZone, bucketLabels, periodText, columnChart, chartCard, simpleTable, barList, tile, delta, statusLine, countryCard,
} from './charts.js';

const state = { script: null, data: null, loading: false, seq: 0 };

export async function showApiDetail(params) {
  const script = params.get('script') || '';
  if (state.script !== script) state.data = null;
  state.script = script;
  renderPeriod();
  renderHeader();
  await load(false);
}

function renderHeader() {
  const file = state.script.split('/').pop();
  $('pageTitle').textContent = file || 'API details';
  const home = session.info?.home && session.info.home !== '/' ? session.info.home : '';
  $('pageSub').textContent = displayPath(home + state.script);
  document.title = `${file} · API details`;
}

async function load(fresh) {
  const seq = ++state.seq;
  const period = currentPeriod();
  state.loading = true;
  $('apiRefresh').disabled = true;
  const body = $('apiBody');
  if (!state.data || state.data.period !== period) {
    body.classList.remove('refreshing');
    body.replaceChildren(h('div', { class: 'empty-state' },
      h('span', { class: 'empty-icon spin' }, icon('refresh', 22)),
      h('div', { class: 'empty-title' }, 'Reading the server logs…'),
      h('div', { class: 'empty-text' }, period === '7d' || period === '30d' ? 'Going through many days of logs can take a few seconds.' : 'One moment.')));
  } else body.classList.add('refreshing');
  try {
    const data = await api('GET', `/api/overview/api?period=${period}&script=${encodeURIComponent(state.script)}${fresh ? '&fresh=1' : ''}`);
    if (seq !== state.seq) return;
    state.data = data;
    render();
  } catch (err) {
    if (seq !== state.seq) return;
    toast(err.message, 'err');
    body.replaceChildren(h('div', { class: 'empty-state' }, h('div', { class: 'empty-title' }, 'Could not load this API'), h('div', { class: 'empty-text' }, err.message)));
  } finally {
    if (seq === state.seq) {
      state.loading = false;
      body.classList.remove('refreshing');
      $('apiRefresh').disabled = false;
    }
  }
}

function renderPeriod() {
  document.querySelectorAll('#apiPeriod button').forEach((b) => b.classList.toggle('active', b.dataset.p === currentPeriod()));
}

// ---------- page ----------

function render() {
  const d = state.data;
  setZone(d.timezone);
  $('apiRange').textContent = periodText(d);
  $('apiUpdated').textContent = `Updated ${new Date(d.generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: d.timezone })}`;
  $('apiBody').replaceChildren(...[
    renderIdentity(d),
    d.totals ? renderKpis(d) : h('div', { class: 'card ov-card' }, h('div', { class: 'empty-text' }, 'No calls to this API in this period.')),
    d.totals ? renderStatus(d) : null,
    d.totals ? renderSeries(d, 'requests') : null,
    d.totals ? renderSeries(d, 'avgMs') : null,
    d.totals ? countryCard(d.countries, { title: 'Calls by country', total: d.totals.requests }) : null,
    d.clients?.total ? renderClients(d) : null,
    d.phpErrors.length ? h('div', { class: 'card ov-card' },
      h('div', { class: 'ov-card-head' }, h('div', {},
        h('div', { class: 'ov-card-title' }, 'PHP errors in this file'),
        h('div', { class: 'ov-card-sub' }, 'From the server error log. Click to open the file at that line.'))),
      phpErrorList(d.phpErrors)) : null,
  ].filter(Boolean));
}

function renderIdentity(d) {
  const url = publicUrl(d.path) || d.url;
  const ignored = !!d.ignored;
  const ignoreBtn = h('button', {
    class: 'btn btn-sm',
    onclick: async () => {
      try {
        await setIgnored(d.script, !ignored);
        d.ignored = ignored ? null : { script: d.script };
        render();
      } catch (err) { toast(err.message, 'err'); }
    },
  }, icon(ignored ? 'eye' : 'eyeOff', 14), ignored ? 'Show in Needs attention' : 'Ignore in Needs attention');
  return h('div', { class: 'card ov-card api-id' },
    h('div', { class: 'api-id-main' },
      h('div', { class: 'api-id-path mono' }, displayPath(d.path)),
      url ? h('div', { class: 'api-id-url' },
        h('a', { href: url, target: '_blank', rel: 'noopener', class: 'mono' }, url),
        h('button', { class: 'icon-btn ghost sm', title: 'Copy URL', onclick: () => copyWithFeedback(url, 'URL') }, icon('copy', 14))) : null,
      h('div', { class: 'api-id-tags' },
        d.exists ? h('span', { class: 'issue good' }, icon('check', 12), 'File exists') : h('span', { class: 'issue warn' }, icon('info', 12), 'File not on the server'),
        ignored ? h('span', { class: 'chip' }, 'ignored in Needs attention') : null)),
    h('div', { class: 'api-id-actions' },
      d.exists ? h('button', { class: 'btn btn-sm', onclick: () => openEditorAt(d.path) }, icon('edit', 14), 'Open file') : null,
      d.exists ? h('button', { class: 'btn btn-sm btn-primary', onclick: async () => { await openEditorAt(d.path); toggleTester(true); } }, icon('play', 14), 'Test API') : null,
      ignoreBtn));
}

function renderKpis(d) {
  const t = d.totals;
  const c = d.compare;
  const vs = VS[d.period];
  const failed = t.errors5xx;
  return h('div', { class: 'kpis kpis-5' },
    tile('Calls', compact(t.requests), c ? delta(t.requests, c.requests, { upIsGood: null, vs }) : h('div', { class: 'kpi-delta' }, `${num(t.requests)} in total`), num(t.requests)),
    tile('Average response', ms(t.avgMs), h('div', { class: 'kpi-delta' }, `slowest call ${ms(t.maxMs)}`)),
    tile('Devices (IPs)', compact(t.uniqueIps), h('div', { class: 'kpi-delta' }, `≈ ${(t.requests / Math.max(1, t.uniqueIps)).toFixed(1)} calls each`), num(t.uniqueIps)),
    tile('Server errors (5xx)', num(failed), statusLine(!failed, 'None', `${((failed / t.requests) * 100).toFixed(1)}% of calls`)),
    tile('PHP errors logged', num(t.phpErrors), statusLine(!t.phpErrors, 'None', 'see the list below')));
}

function renderStatus(d) {
  const t = d.totals;
  const part = (label, n, cls) => h('div', { class: `status-part ${cls}` }, h('span', { class: 'status-n' }, num(n)), h('span', { class: 'status-l' }, label));
  return h('div', { class: 'card ov-card status-strip' },
    part('OK (2xx)', t.ok2xx, 'ok'),
    part('Redirect (3xx)', t.redirects3xx, ''),
    part('Not found / bad request (4xx)', t.errors4xx, t.errors4xx ? 'warn' : ''),
    part('Server error (5xx)', t.errors5xx, t.errors5xx ? 'bad' : ''));
}

function renderSeries(d, key) {
  const daily = d.bucket === 'day';
  const per = daily ? 'day' : 'hour';
  const isTime = key === 'avgMs';
  const points = d.hours.map((r) => {
    const l = bucketLabels(d.bucket, r.start);
    return {
      label: l.short,
      title: l.long,
      value: r[key],
      rows: isTime ? [[ms(r.avgMs), 'average'], [ms(r.maxMs), 'slowest'], [num(r.requests), 'calls']]
        : [[num(r.requests), 'calls'], ...(r.errors ? [[num(r.errors), 'server errors']] : []), ...(r.phpErrors ? [[num(r.phpErrors), 'PHP errors']] : [])],
    };
  });
  return chartCard(isTime ? `Average response per ${per}` : `Calls per ${per}`, isTime ? 'How long the API took to answer' : 'Hover a column for details',
    columnChart(points, { ariaLabel: isTime ? 'Average response time' : 'Calls', valueFormat: isTime ? (v) => ms(Math.round(v)) : compact, height: 200 }),
    simpleTable(d.hours, isTime
      ? [{ label: daily ? 'Day' : 'Hour', get: (r) => bucketLabels(d.bucket, r.start).long }, { label: 'Average', num: true, get: (r) => ms(r.avgMs) }, { label: 'Slowest', num: true, get: (r) => ms(r.maxMs) }]
      : [{ label: daily ? 'Day' : 'Hour', get: (r) => bucketLabels(d.bucket, r.start).long }, { label: 'Calls', num: true, get: (r) => num(r.requests) }, { label: 'Server errors', num: true, get: (r) => num(r.errors) }]));
}

function renderClients(d) {
  const c = d.clients;
  const card = (title, sub, list) => h('div', { class: 'card ov-card' },
    h('div', { class: 'ov-card-head' }, h('div', {}, h('div', { class: 'ov-card-title' }, title), sub ? h('div', { class: 'ov-card-sub' }, sub) : null)), list);
  const androidTotal = c.android.reduce((s, x) => s + x[1], 0);
  return h('div', { class: 'client-grid' },
    card('Android version', androidTotal ? `${num(androidTotal)} calls from Android` : null,
      c.android.length ? barList(c.android.map(([v, n]) => [`Android ${v}`, n]), { total: androidTotal }) : h('div', { class: 'muted' }, 'No Android calls.')),
    card('Phone brand', 'Guessed from the model name', c.brands.length ? barList(c.brands) : h('div', { class: 'muted' }, 'No phone models in the calls.')),
    card('Top phone models', null, c.models.length ? barList(c.models.map(([m, n, b]) => [m, n, b !== 'Unknown brand' ? `· ${b}` : null]), { total: c.models.reduce((s, x) => s + x[1], 0), max: 10, otherLabel: 'Other models' }) : h('div', { class: 'muted' }, '—')),
    card('Called from', 'What kind of client made the calls', barList(c.kinds, { total: c.total, max: 6 })));
}

// ---------- wiring ----------

document.querySelectorAll('#apiPeriod button').forEach((b) => {
  b.onclick = () => {
    if (currentPeriod() === b.dataset.p) return;
    setPeriod(b.dataset.p);
    renderPeriod();
    load(false);
  };
});
$('apiRefresh').onclick = () => load(true);
