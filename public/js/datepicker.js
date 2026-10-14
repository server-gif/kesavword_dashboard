/*
 * Vanilla JS DateRangePicker — uses the same .drp-* CSS classes from
 * /datepicker/DateRangePicker.css. No React, no external libs.
 *
 * Usage:
 *   import DateRangePicker from './datepicker.js';
 *   const dp = new DateRangePicker(containerEl, {
 *     min: '2026-09-01',
 *     max: new Date(),
 *     format: 'DD-MM-YYYY',
 *     onApply: ({ from, to }) => {},  // from/to are 'YYYY-MM-DD'
 *     onCancel: () => {},
 *   });
 *   dp.show(); dp.hide(); dp.destroy();
 */

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const PRESETS = [
  { key: 'today', label: 'Today Only', calc: (n) => [n, n] },
  { key: 'yesterday', label: 'Yesterday Only', calc: (n) => { const d = addDays(n, -1); return [d, d]; } },
  { key: '3d', label: '3 Days', calc: (n) => [addDays(n, -2), n] },
  { key: '5d', label: '5 Days', calc: (n) => [addDays(n, -4), n] },
  { key: '1w', label: '1 Week', calc: (n) => [addDays(n, -6), n] },
  { key: '2w', label: '2 Weeks', calc: (n) => [addDays(n, -13), n] },
  { key: '1m', label: '1 Month', calc: (n) => [addMonths(n, -1), n] },
  { key: '90d', label: '90 Days', calc: (n) => [addDays(n, -89), n] },
  { key: '1y', label: '1 Year', calc: (n) => [addYears(n, -1), n] },
  { key: 'custom', label: 'Custom Range' },
];

function pad(n) { return String(n).padStart(2, '0'); }
function iso(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function parseISO(s) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; }
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function addMonths(d, n) { const r = new Date(d); r.setMonth(r.getMonth() + n); return r; }
function addYears(d, n) { const r = new Date(d); r.setFullYear(r.getFullYear() + n); return r; }
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
function dayNum(d) { return Math.floor(d.getTime() / 86400000); }
function isBefore(a, b) { return dayNum(a) < dayNum(b); }
function isAfter(a, b) { return dayNum(a) > dayNum(b); }
function fmtDisplay(d, format) {
  const dd = pad(d.getDate()), mm = pad(d.getMonth() + 1), yyyy = d.getFullYear();
  if (format === 'MM-DD-YYYY') return `${mm}-${dd}-${yyyy}`;
  if (format === 'YYYY-MM-DD') return `${yyyy}-${mm}-${dd}`;
  return `${dd}-${mm}-${yyyy}`; // DD-MM-YYYY default
}
function parseDisplay(text, format) {
  const m = format === 'MM-DD-YYYY' ? /^(\d{2})-(\d{2})-(\d{4})$/.exec(text)
    : format === 'YYYY-MM-DD' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
    : /^(\d{2})-(\d{2})-(\d{4})$/.exec(text);
  if (!m) return null;
  let y, mo, d;
  if (format === 'YYYY-MM-DD') { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if (format === 'MM-DD-YYYY') { mo = +m[1]; d = +m[2]; y = +m[3]; }
  else { d = +m[1]; mo = +m[2]; y = +m[3]; }
  const dt = new Date(y, mo - 1, d);
  return (dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d) ? dt : null;
}
function clamp(d, min, max) {
  if (max && isAfter(d, max)) return max;
  if (min && isBefore(d, min)) return min;
  return d;
}
function el(tag, cls, ...children) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const c of children) { if (c == null) continue; e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }
  return e;
}

export default class DateRangePicker {
  constructor(container, opts = {}) {
    this.container = typeof container === 'string' ? document.getElementById(container) : container;
    this.min = opts.min ? (typeof opts.min === 'string' ? parseISO(opts.min) : opts.min) : null;
    this.max = opts.max ? (typeof opts.max === 'string' ? parseISO(opts.max) : opts.max) : opts.max === undefined ? new Date() : null;
    this.format = opts.format || 'DD-MM-YYYY';
    this.onApply = opts.onApply || (() => {});
    this.onCancel = opts.onCancel || (() => {});

    this.start = this.min || new Date();
    this.end = this.max || new Date();
    this.selecting = 'from';
    this.hover = null;
    this.activePreset = 'custom';
    this.leftView = startOfMonth(addDays(this.end, -30));
    this.rightView = startOfMonth(this.end);
    this._build();
  }

  show() { this.container.style.display = ''; }
  hide() { this.container.style.display = 'none'; }
  destroy() { this.container.replaceChildren(); }

  setRange(from, to) {
    this.start = clamp(parseISO(from) || new Date(), this.min, this.max);
    this.end = clamp(parseISO(to) || new Date(), this.min, this.max);
    if (isBefore(this.end, this.start)) [this.start, this.end] = [this.end, this.start];
    this.leftView = startOfMonth(this.start);
    this.rightView = startOfMonth(this.end);
    this.activePreset = 'custom';
    this.render();
  }

  _build() {
    this.root = el('div', 'drp');
    this.container.appendChild(this.root);
    this.render();
    document.addEventListener('mousemove', (e) => {
      if (!this.container.contains(e.target) && this.container.style.display !== 'none') {
        // Optional: close on outside click — but keep open for toolbar panel use
      }
    });
  }

  render() {
    this.root.replaceChildren(
      el('div', 'drp-main', this._panels(), this._footer())
    );
  }

  _presets() {
    const wrap = el('div', 'drp-presets');
    for (const p of PRESETS) {
      const btn = el('button', `drp-preset${this.activePreset === p.key ? ' active' : ''}`, p.label);
      btn.type = 'button';
      btn.onclick = () => this._choosePreset(p);
      wrap.appendChild(btn);
    }
    return wrap;
  }

  _panels() {
    return el('div', 'drp-panels',
      this._side('from'),
      this._side('to')
    );
  }

  _side(which) {
    const dt = which === 'from' ? this.start : this.end;
    const view = which === 'from' ? this.leftView : this.rightView;
    const setView = which === 'from' ? (v) => { this.leftView = v; this.render(); } : (v) => { this.rightView = v; this.render(); };
    return el('div', 'drp-side',
      this._box(which, dt),
      this._calendar(which, view, setView),
      el('div', 'drp-status', ...(this.selecting === which ? [document.createTextNode(`Selecting ${which === 'from' ? 'From' : 'To'} `), el('span', 'drp-dot')] : []))
    );
  }

  _box(which, dt) {
    const title = el('div', 'drp-box-title', which === 'from' ? 'From Date' : 'To Date');
    const input = document.createElement('input');
    input.className = 'drp-input';
    input.value = fmtDisplay(dt, this.format);
    input.placeholder = this.format;
    input.onfocus = () => { this.selecting = which; this.render(); };
    input.onblur = () => { this._commitInput(which, input.value); };
    input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); this._commitInput(which, input.value); } };
    const addon = el('span', 'drp-input-addon');
    addon.innerHTML = `<svg width="17" height="17" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M4 0h2v2h4V0h2v2h3v14H1V2h3V0zM2.5 5.5v9h11v-9h-11z"/><path d="M4 7h2v2H4zM7 7h2v2H7zM10 7h2v2h-2zM4 10h2v2H4zM7 10h2v2H7zM10 10h2v2h-2z"/></svg>`;
    return el('div', 'drp-box', title, el('div', 'drp-input-group', addon, input));
  }

  _calendar(which, view, setView) {
    const isLeft = which === 'from';
    const cal = el('div', 'drp-cal');
    // Header with nav + selects
    const prevBtn = el('button', 'drp-nav'); prevBtn.type = 'button'; prevBtn.setAttribute('aria-label', 'Previous month');
    prevBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="3"><path d="M10.5 2.5L5 8l5.5 5.5"/></svg>';
    prevBtn.disabled = this.min && !monthAfter(view, this.min);
    prevBtn.onclick = () => setView(addMonths(view, -1));

    const nextBtn = el('button', 'drp-nav'); nextBtn.type = 'button'; nextBtn.setAttribute('aria-label', 'Next month');
    nextBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="3"><path d="M5.5 2.5L11 8l-5.5 5.5"/></svg>';
    nextBtn.disabled = this.max && !monthBefore(view, this.max);
    nextBtn.onclick = () => setView(addMonths(view, 1));

    const monthSel = document.createElement('select');
    monthSel.className = 'drp-select drp-month'; monthSel.setAttribute('aria-label', 'Month');
    MONTHS.forEach((m, i) => { const o = document.createElement('option'); o.value = i; o.textContent = m; if (i === view.getMonth()) o.selected = true; monthSel.appendChild(o); });
    monthSel.onchange = () => setView(new Date(view.getFullYear(), +monthSel.value, 1));

    const yearSel = document.createElement('select');
    yearSel.className = 'drp-select drp-year'; yearSel.setAttribute('aria-label', 'Year');
    const yFrom = this.min ? this.min.getFullYear() : (this.max ? this.max.getFullYear() : now().getFullYear()) - 30;
    const yTo = this.max ? this.max.getFullYear() : (this.min ? this.min.getFullYear() : now().getFullYear()) + 10;
    for (let y = yFrom; y <= yTo; y++) { const o = document.createElement('option'); o.value = y; o.textContent = y; if (y === view.getFullYear()) o.selected = true; yearSel.appendChild(o); }
    yearSel.onchange = () => setView(new Date(+yearSel.value, view.getMonth(), 1));

    cal.appendChild(el('div', 'drp-cal-head', prevBtn, el('div', 'drp-cal-selects', monthSel, yearSel), nextBtn));

    // Grid
    const table = el('table', 'drp-grid');
    const thead = el('thead'); const hrow = el('tr');
    WEEKDAYS.forEach((w) => hrow.appendChild(el('th', null, w)));
    thead.appendChild(hrow); table.appendChild(thead);

    const tbody = el('tbody');
    const first = startOfMonth(view);
    const gridStart = addDays(first, -((first.getDay() + 6) % 7)); // Monday first
    const rangeEnd = this.selecting === 'to' && this.hover && !isBefore(this.hover, this.start) ? this.hover : this.end;

    for (let row = 0; row < 6; row++) {
      const tr = el('tr');
      for (let col = 0; col < 7; col++) {
        const d = addDays(gridStart, row * 7 + col);
        const td = document.createElement('td');
        td.textContent = d.getDate();
        if (d.getMonth() !== view.getMonth()) {
          td.className = 'off';
        } else {
          const disabled = (this.min && isBefore(d, this.min)) || (this.max && isAfter(d, this.max));
          if (disabled) { td.className = 'disabled'; }
          else {
            const active = sameDay(d, this.start) || sameDay(d, rangeEnd);
            const inRange = isAfter(d, this.start) && isBefore(d, rangeEnd);
            if (active) td.className = 'active';
            else if (inRange) td.className = 'in-range';
            td.onclick = () => this._pickDay(d);
            td.onmouseenter = () => { this.hover = d; this._updateHover(which, isLeft); };
          }
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.onmouseleave = () => { this.hover = null; this.render(); };
    table.appendChild(tbody);
    cal.appendChild(table);
    return cal;
  }

  _updateHover(which, isLeft) {
    // Only re-render the grid cells for range highlight — simple approach: full re-render
    if (this.selecting === 'to') this.render();
  }

  _footer() {
    const maxSpan = el('span', 'drp-maxdate', this.max ? `Max Date: ${fmtDisplay(this.max, this.format)}` : '');
    const applyBtn = el('button', 'drp-btn drp-apply', 'Apply'); applyBtn.type = 'button';
    applyBtn.onclick = () => this._apply();
    const cancelBtn = el('button', 'drp-btn drp-cancel', 'Cancel'); cancelBtn.type = 'button';
    cancelBtn.onclick = () => { this.onCancel(); };
    return el('div', 'drp-footer', ...(this.max ? [maxSpan] : []), applyBtn, cancelBtn);
  }

  _choosePreset(p) {
    this.selecting = 'from'; this.hover = null; this.activePreset = p.key;
    if (p.calc) {
      const ref = this.max && isAfter(new Date(), this.max) ? this.max : new Date();
      let [s, e] = p.calc(ref);
      s = clamp(s, this.min, this.max); e = clamp(e, this.min, this.max);
      this.start = s; this.end = e;
      this.leftView = startOfMonth(s); this.rightView = startOfMonth(e);
    }
    this.render();
  }

  _pickDay(d) {
    this.activePreset = 'custom';
    if (this.selecting === 'from') {
      this.start = clamp(d, this.min, this.max);
      if (isBefore(this.end, this.start)) this.end = clamp(d, this.min, this.max);
      this.selecting = 'to';
    } else if (isBefore(d, this.start)) {
      this.start = clamp(d, this.min, this.max);
    } else {
      this.end = clamp(d, this.min, this.max);
      this.selecting = 'from'; this.hover = null;
    }
    this.render();
  }

  _commitInput(which, text) {
    const d = parseDisplay(text.trim(), this.format);
    if (!d) { this.render(); return; }
    this.activePreset = 'custom';
    if (which === 'from') {
      this.start = clamp(d, this.min, this.max);
      if (isBefore(this.end, this.start)) this.end = clamp(d, this.min, this.max);
      this.leftView = startOfMonth(this.start);
    } else {
      this.end = clamp(d, this.min, this.max);
      if (isBefore(this.end, this.start)) this.start = clamp(d, this.min, this.max);
      this.rightView = startOfMonth(this.end);
    }
    this.render();
  }

  _apply() {
    let s = this.start, e = this.end;
    if (isBefore(e, s)) [s, e] = [e, s];
    this.onApply({ from: iso(s), to: iso(e) });
  }
}

function monthAfter(viewMonth, minDate) {
  return viewMonth.getFullYear() > minDate.getFullYear() ||
    (viewMonth.getFullYear() === minDate.getFullYear() && viewMonth.getMonth() >= minDate.getMonth());
}
function monthBefore(viewMonth, maxDate) {
  return viewMonth.getFullYear() < maxDate.getFullYear() ||
    (viewMonth.getFullYear() === maxDate.getFullYear() && viewMonth.getMonth() <= maxDate.getMonth());
}
function now() { return new Date(); }
