// Small chart kit shared by the overview and API detail pages (plain SVG, no library).
// Colors come from CSS roles (--series-1, --status-critical) validated against the page surfaces.
import { h, icon } from './lib.js';

export const compact = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K` : String(Math.round(n)));
export const num = (n) => Number(n || 0).toLocaleString();
export const ms = (v) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)} s` : `${v} ms`);

// Labels in the server's configured zone (Asia/Kolkata by default), whatever the viewer's clock says.
let zone;
export const setZone = (tz) => { zone = tz || undefined; };
export const timeLabel = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: zone });
export const dayLabel = (t) => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short', timeZone: zone });
export const longDay = (t) => new Date(t).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', timeZone: zone });

// Bucket labels for a series: hours ("2:00 pm") or days ("13 Oct").
export function bucketLabels(bucket, start) {
  if (bucket === 'day') return { short: dayLabel(start), long: longDay(start) };
  return { short: timeLabel(start), long: `${timeLabel(start)} – ${timeLabel(start + 3600000)}` };
}

export function periodText(d) {
  const kind = { today: 'Today', yesterday: 'Yesterday', '7d': 'Last 7 days', '30d': 'Last 30 days', custom: 'Custom range' }[d.period];
  if (d.bucket === 'day') return `${kind}: ${dayLabel(d.from)} – ${dayLabel(d.to)}`;
  return `${longDay(d.from)}, ${timeLabel(d.from)} – ${d.period === 'yesterday' ? 'midnight' : timeLabel(d.to)}`;
}

// Axis top = 4 clean steps (each 1, 2, 2.5 or 5 × a power of ten), so ticks read 0 / 5K / 10K …
function niceMax(v) {
  if (v <= 4) return 4; // small counts: 0 / 1 / 2 / 3 / 4
  const raw = v / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw);
  return step * 4;
}

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// Column chart. points: [{ label, title, value, rows: [[valueText, labelText], …] }]
// valueFormat formats axis ticks and the peak label.
export function columnChart(points, { colorVar = '--series-1', ariaLabel, valueFormat = compact, height = 220 } = {}) {
  const wrap = h('div', { class: 'chart', role: 'img', 'aria-label': ariaLabel || '' });
  const tip = h('div', { class: 'chart-tip hidden' });
  wrap.append(tip);
  const pad = { l: 48, r: 8, t: 18, b: 28 };

  const draw = () => {
    const W = wrap.clientWidth;
    if (!W) return;
    wrap.querySelector('svg')?.remove();
    const H = height;
    const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` });
    const plotW = W - pad.l - pad.r;
    const plotH = H - pad.t - pad.b;
    const max = niceMax(Math.max(...points.map((p) => p.value)));
    const y = (v) => pad.t + plotH - (v / max) * plotH;

    for (let i = 0; i <= 4; i++) {
      const v = (max / 4) * i;
      const yy = Math.round(y(v)) + 0.5;
      svg.append(svgEl('line', { x1: pad.l, x2: W - pad.r, y1: yy, y2: yy, class: i === 0 ? 'chart-base' : 'chart-grid' }));
      const t = svgEl('text', { x: pad.l - 8, y: yy + 4, 'text-anchor': 'end', class: 'chart-tick' });
      t.textContent = valueFormat(v);
      svg.append(t);
    }

    const band = plotW / points.length;
    const barW = Math.max(2, Math.min(24, band * 0.62));
    const every = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor(plotW / 64))));
    const peak = points.reduce((best, p, i) => (p.value > points[best].value ? i : best), 0);

    points.forEach((p, i) => {
      const cx = pad.l + band * i + band / 2;
      const x = cx - barW / 2;
      const top = y(p.value);
      const base = pad.t + plotH;
      if (p.value > 0) {
        const r = Math.min(4, barW / 2, base - top);
        svg.append(svgEl('path', {
          d: `M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${base} Z`,
          class: 'chart-bar',
          style: `fill: var(${colorVar})`,
          'data-i': i,
        }));
      }
      if (i % every === 0) {
        const t = svgEl('text', { x: cx, y: H - 8, 'text-anchor': 'middle', class: 'chart-tick' });
        t.textContent = p.label;
        svg.append(t);
      }
      if (i === peak && p.value > 0) {
        const t = svgEl('text', { x: cx, y: top - 6, 'text-anchor': 'middle', class: 'chart-value' });
        t.textContent = valueFormat(p.value);
        svg.append(t);
      }
      // the whole column band is the hover/focus target, not just the painted bar
      const hit = svgEl('rect', { x: pad.l + band * i, y: pad.t, width: band, height: plotH, class: 'chart-hit', tabindex: 0 });
      const show = () => {
        svg.querySelectorAll('.chart-bar').forEach((b) => b.classList.toggle('dim', b.dataset.i !== String(i)));
        tip.replaceChildren(
          h('div', { class: 'tip-title' }, p.title || p.label),
          ...p.rows.map(([v, l]) => h('div', { class: 'tip-row' }, h('span', { class: 'tip-key', style: `background: var(${colorVar})` }), h('b', {}, v), h('span', {}, l))));
        tip.classList.remove('hidden');
        const tw = tip.offsetWidth;
        tip.style.left = `${Math.min(Math.max(cx - tw / 2, 0), W - tw)}px`;
        tip.style.top = `${Math.max(0, top - tip.offsetHeight - 10)}px`;
      };
      const hide = () => {
        tip.classList.add('hidden');
        svg.querySelectorAll('.chart-bar').forEach((b) => b.classList.remove('dim'));
      };
      hit.addEventListener('pointerenter', show);
      hit.addEventListener('focus', show);
      hit.addEventListener('pointerleave', hide);
      hit.addEventListener('blur', hide);
      svg.append(hit);
    });
    wrap.prepend(svg);
  };
  new ResizeObserver(draw).observe(wrap);
  return wrap;
}

// Card with a Chart/Table toggle — every chart has a table twin.
export function chartCard(title, subtitle, chart, table) {
  let asTable = false;
  const tableWrap = h('div', { class: 'chart-table hidden' }, table);
  const chartWrap = h('div', {}, chart);
  const toggle = h('button', {
    class: 'btn btn-sm',
    onclick: () => {
      asTable = !asTable;
      tableWrap.classList.toggle('hidden', !asTable);
      chartWrap.classList.toggle('hidden', asTable);
      toggle.textContent = asTable ? 'Chart' : 'Table';
    },
  }, 'Table');
  return h('div', { class: 'card ov-card' },
    h('div', { class: 'ov-card-head' }, h('div', {}, h('div', { class: 'ov-card-title' }, title), subtitle ? h('div', { class: 'ov-card-sub' }, subtitle) : null), toggle),
    chartWrap, tableWrap);
}

export function simpleTable(rows, cols) {
  return h('table', { class: 'table compact' },
    h('thead', {}, h('tr', {}, ...cols.map((c) => h('th', { class: c.num ? 'num' : '' }, c.label)))),
    h('tbody', {}, ...rows.map((r) => h('tr', {}, ...cols.map((c) => h('td', { class: c.num ? 'num' : '' }, c.get(r)))))));
}

// Tiny trend line: muted line, the latest point marked in the accent.
export function sparkline(values, { width = 96, height = 24 } = {}) {
  const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, class: 'spark', 'aria-hidden': 'true' });
  if (!values.length) return svg;
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? (width - 6) / (values.length - 1) : 0;
  const pts = values.map((v, i) => [3 + i * step, height - 3 - (v / max) * (height - 6)]);
  svg.append(svgEl('polyline', { points: pts.map((p) => p.join(',')).join(' '), class: 'spark-line' }));
  const [lx, ly] = pts[pts.length - 1];
  svg.append(svgEl('circle', { cx: lx, cy: ly, r: 2.5, class: 'spark-dot' }));
  return svg;
}

// Horizontal bars for a ranked list (Android versions, brands, …). items: [[label, count, sub?]]
export function barList(items, { total, max = 8, otherLabel = 'Other' } = {}) {
  const shown = items.slice(0, max);
  const rest = items.slice(max).reduce((s, x) => s + x[1], 0);
  if (rest) shown.push([otherLabel, rest]);
  const top = Math.max(1, ...shown.map((x) => x[1]));
  const sum = total || items.reduce((s, x) => s + x[1], 0) || 1;
  return h('div', { class: 'barlist' }, ...shown.map(([label, count, sub]) => h('div', { class: 'barlist-row', title: `${label}: ${num(count)}` },
    h('div', { class: 'barlist-label' }, h('span', {}, label), sub ? h('span', { class: 'muted' }, ` ${sub}`) : null),
    h('div', { class: 'barlist-track' }, h('span', { class: 'barlist-bar', style: `width:${Math.max(1.5, (count / top) * 100)}%` })),
    h('div', { class: 'barlist-value' }, `${Math.round((count / sum) * 100)}%`, h('span', { class: 'muted' }, ` · ${compact(count)}`)))));
}

// ---------- countries ----------

const flagOf = (code) => (code ? String.fromCodePoint(...[...code].map((c) => 127397 + c.charCodeAt(0))) : '🌐');

// countries: [{ code, name, calls }] from the server, or null when the country database is unavailable.
export function countryCard(countries, { title = 'Calls by country', total } = {}) {
  const card = h('div', { class: 'card ov-card' });
  const head = (sub) => h('div', { class: 'ov-card-head' }, h('div', {}, h('div', { class: 'ov-card-title' }, title), h('div', { class: 'ov-card-sub' }, sub)));
  if (countries === null || countries === undefined) {
    card.append(head('Country data is not available right now (the IP database could not be loaded).'));
    return card;
  }
  const known = countries.filter((c) => c.code).length;
  const sum = total || countries.reduce((s, c) => s + c.calls, 0);
  let showAll = false;
  const listArea = h('div', {});
  const draw = () => {
    listArea.replaceChildren(...[
      barList(countries.map((c) => [`${flagOf(c.code)}  ${c.name}`, c.calls]), { total: sum, max: showAll ? countries.length : 8, otherLabel: 'Other countries' }),
      countries.length > 8 ? h('div', { class: 'ov-more' }, h('button', { class: 'btn btn-sm', onclick: () => { showAll = !showAll; draw(); } },
        showAll ? 'Show top 8' : `Show all ${countries.length}`)) : null,
    ].filter(Boolean));
  };
  draw();
  card.append(
    head(`${known} countr${known === 1 ? 'y' : 'ies'} · worked out from each caller's IP address, so it is approximate (VPNs show the VPN's country)`),
    listArea,
    h('div', { class: 'attribution' }, 'IP-to-country data by ', h('a', { href: 'https://db-ip.com', target: '_blank', rel: 'noopener' }, 'DB-IP'), ' (CC BY 4.0)'));
  return card;
}

// ---------- stat tiles ----------

export function tile(label, value, sub, title) {
  return h('div', { class: 'kpi', title: title || null }, h('div', { class: 'kpi-label' }, label), h('div', { class: 'kpi-value' }, value), sub);
}

// upIsGood: true / false, or null when up is neither good nor bad (e.g. traffic).
export function delta(now, before, { upIsGood, vs }) {
  if (!before) return null;
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return h('div', { class: 'kpi-delta' }, `Same as ${vs}`);
  const good = pct > 0 === upIsGood;
  return h('div', { class: `kpi-delta ${upIsGood === null ? '' : good ? 'good' : 'bad'}` }, `${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)}% vs ${vs}`);
}

export function statusLine(ok, okText, badText) {
  return h('div', { class: `kpi-status ${ok ? 'good' : 'bad'}` }, icon(ok ? 'check' : 'alert', 14), h('span', {}, ok ? okText : badText));
}

export function trendBadge(recent, previous) {
  if (!previous && !recent) return h('span', { class: 'muted' }, '—');
  if (!previous) return h('span', { class: 'trend up' }, 'new');
  const pct = Math.round(((recent - previous) / previous) * 100);
  if (Math.abs(pct) < 5) return h('span', { class: 'trend' }, '≈ same');
  // past +300% a multiplier reads better than "▲ 238361%"
  const text = pct >= 300 ? `▲ ${num(Math.round(recent / previous))}×` : `${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)}%`;
  return h('span', { class: `trend ${pct > 0 ? 'up' : 'down'}`, title: `${num(previous)} → ${num(recent)}` }, text);
}
