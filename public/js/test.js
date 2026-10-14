// API tester panel inside the editor: run the open file's URL and show the response.
import { $, h, api, toast, icon, storeGet, storeSet, publicUrl, copyWithFeedback, fmtSize, baseName, session } from './lib.js';

let hooks = null; // { isDirty, save, goToLine, setRuntimeErrors, openFile, currentPath }
const state = {
  path: null,
  method: 'GET',
  url: '',
  params: [],
  form: [],
  headers: [],
  bodyType: 'form',
  json: '',
  tab: 'params',
  last: null,
  sending: false,
  seq: 0,
};
let view = storeGet('testerView') || 'pretty';

const panel = () => $('testPanel');
export const testerOpen = () => !panel().classList.contains('hidden');

export function initTester(h) { hooks = h; }

// ---------- what the PHP file reads ----------

// Finds $_POST['x'], $_GET['x'], $_REQUEST['x'] and php://input in the open file.
function detectInputs() {
  const code = hooks?.getContent() || '';
  const grab = (src) => {
    const re = new RegExp(`\\$_${src}\\s*\\[\\s*['"]([^'"]+)['"]\\s*\\]`, 'g');
    return [...new Set([...code.matchAll(re)].map((m) => m[1]))];
  };
  return { post: grab('POST'), get: grab('GET'), request: grab('REQUEST'), json: /php:\/\/input/.test(code) };
}

// First time a file is tested: pick the method and pre-fill the fields its code reads.
function smartDefaults(path) {
  const d = detectInputs();
  const base = defaults(path);
  const usesBody = d.post.length > 0 || d.json;
  if (usesBody && !d.get.length) base.method = 'POST';
  base.params = d.get.map((key) => ({ key, value: '' }));
  base.form = [...d.post, ...d.request.filter((k) => !d.post.includes(k))].map((key) => ({ key, value: '' }));
  if (d.json && !d.post.length) base.bodyType = 'json';
  return { ...base, tab: base.method === 'GET' ? 'params' : 'body' };
}

// ---------- per-file settings (remembered in this browser) ----------

const storeKey = (path) => `apitest:${path}`;

function defaults(path) {
  return { method: 'GET', url: publicUrl(path) || '', params: [], form: [], headers: [], bodyType: 'form', json: '' };
}

function loadSettings(path) {
  let saved = null;
  try { saved = JSON.parse(storeGet(storeKey(path)) || 'null'); } catch {}
  Object.assign(state, saved ? { ...defaults(path), ...saved } : smartDefaults(path), { path, last: null });
}

function persist() {
  if (!state.path) return;
  const { method, url, params, form, headers, bodyType, json } = state;
  storeSet(storeKey(state.path), JSON.stringify({ method, url, params, form, headers, bodyType, json }));
}

// ---------- open / close ----------

export function testerFileOpened(path) {
  const testable = !!publicUrl(path);
  $('editorTest').classList.toggle('hidden', !testable);
  loadSettings(path);
  renderRequest();
  renderResponse();
  toggleTester(testable && storeGet('testerOpen') === '1', false);
}

export function toggleTester(open = !testerOpen(), remember = true) {
  panel().classList.toggle('hidden', !open);
  $('editorTest').classList.toggle('active', open);
  if (remember) storeSet('testerOpen', open ? '1' : '0');
}

// ---------- request form ----------

function renderKv(el, rows) {
  el.replaceChildren(
    ...rows.map((row, i) => h('div', { class: 'kv-row' },
      h('input', { class: 'input mono', value: row.key, placeholder: 'key', spellcheck: false, oninput: (e) => { row.key = e.target.value; persist(); updateTabs(); } }),
      h('input', { class: 'input mono', value: row.value, placeholder: 'value', spellcheck: false, oninput: (e) => { row.value = e.target.value; persist(); renderHints(); } }),
      h('button', { class: 'icon-btn ghost sm', title: 'Remove', onclick: () => { rows.splice(i, 1); renderKv(el, rows); persist(); updateTabs(); } }, icon('x', 14)))),
    h('button', {
      class: 'btn btn-sm kv-add',
      onclick: () => {
        rows.push({ key: '', value: '' });
        renderKv(el, rows);
        el.querySelectorAll('.kv-row input')[rows.length * 2 - 2]?.focus();
      },
    }, icon('plus', 14), 'Add'));
}

function chip(label, onClick) {
  return h('button', { class: 'chip-btn mono', title: 'Add this field', onclick: onClick }, label);
}

function addField(where, key) {
  const rows = where === 'form' ? state.form : state.params;
  if (!rows.some((r) => r.key === key)) rows.push({ key, value: '' });
  if (where === 'form') {
    if (state.method === 'GET') state.method = 'POST';
    state.bodyType = 'form';
    state.tab = 'body';
  } else state.tab = 'params';
  persist();
  renderRequest();
  const input = [...document.querySelectorAll(`#${where === 'form' ? 'tpForm' : 'tpParams'} .kv-row`)]
    .find((row) => row.querySelector('input').value === key)?.querySelectorAll('input')[1];
  input?.focus();
}

function renderHints() {
  const d = detectInputs();
  const detect = $('tpDetect');
  const chips = [
    ...d.post.map((k) => chip(`$_POST['${k}']`, () => addField('form', k))),
    ...d.get.map((k) => chip(`$_GET['${k}']`, () => addField('params', k))),
    ...d.request.map((k) => chip(`$_REQUEST['${k}']`, () => addField('form', k))),
    d.json ? h('span', { class: 'chip-static mono' }, 'php://input (JSON)') : null,
  ].filter(Boolean);
  detect.classList.toggle('hidden', !chips.length);
  detect.replaceChildren(h('span', { class: 'tp-detect-label' }, 'This file reads:'), ...chips);

  const keys = (rows) => new Set(rows.filter((r) => r.key).map((r) => r.key));
  const inParams = keys(state.params);
  const inForm = keys(state.form);
  const warns = [];
  const isGet = state.method === 'GET';
  if (isGet && (d.post.length || d.json) && !d.get.length && !d.request.length) {
    warns.push([`This file reads ${d.post.length ? '$_POST' : 'php://input'}, which is empty for GET requests.`, 'Switch to POST', () => {
      state.method = 'POST';
      state.tab = 'body';
      persist();
      renderRequest();
    }]);
  }
  if (!isGet) {
    const misplaced = d.post.filter((k) => inParams.has(k) && !inForm.has(k) && !d.get.includes(k) && !d.request.includes(k));
    if (misplaced.length) {
      warns.push([`${misplaced.join(', ')} is in Params (sent in the URL as $_GET), but the file reads $_POST['${misplaced[0]}'].`, 'Move to Body', () => {
        for (const k of misplaced) {
          const i = state.params.findIndex((r) => r.key === k);
          const [row] = state.params.splice(i, 1);
          const existing = state.form.find((r) => r.key === k);
          if (existing) existing.value = existing.value || row.value;
          else state.form.push(row);
        }
        state.bodyType = 'form';
        state.tab = 'body';
        persist();
        renderRequest();
      }]);
    }
    if (state.bodyType === 'json' && d.post.length && !d.json) {
      warns.push(['The file reads $_POST, which stays empty when the body is JSON.', 'Use Form fields', () => { state.bodyType = 'form'; persist(); renderRequest(); }]);
    }
    if (state.bodyType === 'form' && d.json && !d.post.length && !d.request.length) {
      warns.push(['The file reads php://input (a JSON body), not $_POST.', 'Use JSON', () => { state.bodyType = 'json'; persist(); renderRequest(); }]);
    }
    const empty = d.post.filter((k) => state.bodyType === 'form' && inForm.has(k) && !state.form.find((r) => r.key === k).value);
    if (empty.length && !misplaced.length) warns.push([`No value yet for ${empty.join(', ')}.`, null, null]);
  }
  $('tpWarns').replaceChildren(...warns.map(([text, label, fn]) => h('div', { class: 'tp-warn' },
    icon('alert', 14), h('span', {}, text), label ? h('button', { class: 'btn btn-sm', onclick: fn }, label) : null)));
}

function updateTabs() {
  renderHints();
  const count = (rows) => rows.filter((r) => r.key).length;
  const p = count(state.params);
  const hd = count(state.headers);
  const hasBody = state.method !== 'GET' && (state.bodyType === 'json' ? state.json.trim() : count(state.form));
  $('tpTabParams').textContent = p ? `Params (${p})` : 'Params';
  $('tpTabHeaders').textContent = hd ? `Headers (${hd})` : 'Headers';
  $('tpTabBody').textContent = hasBody ? 'Body •' : 'Body';
  document.querySelectorAll('#testPanel .tp-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === state.tab));
  document.querySelectorAll('#testPanel .tp-pane').forEach((p2) => p2.classList.toggle('hidden', p2.dataset.pane !== state.tab));
}

function renderRequest() {
  $('tpMethod').value = state.method;
  $('tpUrl').value = state.url;
  renderKv($('tpParams'), state.params);
  renderKv($('tpForm'), state.form);
  renderKv($('tpHeaders'), state.headers);
  $('tpJson').value = state.json;
  renderBodyType();
  $('tpParamsHint').textContent = 'Added to the URL as ?key=value — read in PHP with $_GET[\'key\'].';
  updateTabs();
}

function renderBodyType() {
  const isGet = state.method === 'GET';
  document.querySelectorAll('#tpBodyType button').forEach((b) => b.classList.toggle('active', b.dataset.type === state.bodyType));
  $('tpBodyType').classList.toggle('hidden', isGet);
  $('tpForm').classList.toggle('hidden', isGet || state.bodyType !== 'form');
  $('tpJson').classList.toggle('hidden', isGet || state.bodyType !== 'json');
  $('tpBodyHint').textContent = isGet
    ? 'GET requests have no body. Switch the method to POST to send form fields or JSON.'
    : state.bodyType === 'form'
      ? 'Sent like an HTML form — read in PHP with $_POST[\'key\'].'
      : 'Sent as raw JSON — read in PHP with json_decode(file_get_contents(\'php://input\'), true).';
}

// ---------- sending ----------

export async function sendTest() {
  if (state.sending || !state.path) return;
  if (hooks.isDirty()) {
    const saved = await hooks.save();
    if (!saved) return; // not saved (e.g. there was an error to fix)
  }
  let finalUrl;
  try {
    const u = new URL(state.url.trim());
    state.params.filter((p) => p.key).forEach((p) => u.searchParams.append(p.key, p.value));
    finalUrl = u.toString();
  } catch {
    toast('Enter a full URL starting with http:// or https://', 'err');
    return $('tpUrl').focus();
  }

  state.sending = true;
  const seq = ++state.seq;
  setSending(true);
  hooks.setRuntimeErrors([]);
  try {
    state.last = await api('POST', '/api/test-request', {
      method: state.method,
      url: finalUrl,
      headers: state.headers,
      bodyType: state.method === 'GET' ? 'none' : state.bodyType,
      form: state.form,
      json: state.json,
    });
    state.last.sentUrl = finalUrl;
  } catch (err) {
    state.last = { error: err.message };
  } finally {
    state.sending = false;
    setSending(false);
  }
  renderResponse();

  // PHP errors are often hidden from the response but written to the server's error log.
  const mark = state.last?.logMark;
  if (!mark) return;
  state.last.logPending = true;
  renderResponse();
  let log = { available: false, errors: [] };
  try { log = await api('POST', '/api/test-log', { since: mark.size }); } catch {}
  if (seq !== state.seq) return; // a newer test started meanwhile
  state.last.logPending = false;
  state.last.logChecked = log.available;
  state.last.logErrors = log.errors || [];
  renderResponse();
}

function setSending(on) {
  $('tpSend').disabled = on;
  $('tpSendLabel').textContent = on ? 'Sending…' : 'Send';
  panel().classList.toggle('sending', on);
}

// ---------- response ----------

// PHP prints errors like "Warning: Undefined variable $x in /home/…/public_html/api.php on line 12"
// or "Fatal error: Uncaught Error: … in /home/…/api.php:12". Map those paths back to dashboard paths.
function findPhpErrors(body) {
  const text = body.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
  const re = /(?:PHP )?(Fatal error|Parse error|Warning|Notice|Deprecated)\s*:\s*([\s\S]+?)\s+in\s+(\/\S+?\.php)(?:\s+on\s+line\s+|:)(\d+)/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) && out.length < 10) {
    out.push({ kind: m[1], message: m[2].replace(/\s+/g, ' ').trim(), serverFile: m[3], line: Number(m[4]), path: toDashboardPath(m[3]) });
  }
  return out;
}

function toDashboardPath(serverFile) {
  const root = session.info?.home || '/';
  const marker = `/${baseName(root)}/`;
  const i = serverFile.indexOf(marker);
  if (root === '/' || i < 0) return null;
  return root + serverFile.slice(i + marker.length - 1);
}

function highlightJson(text) {
  const esc = text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  return esc.replace(/("(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g, (m) => {
    let cls = 'j-num';
    if (m.startsWith('"')) cls = /:$/.test(m) ? 'j-key' : 'j-str';
    else if (m === 'true' || m === 'false') cls = 'j-bool';
    else if (m === 'null') cls = 'j-null';
    return `<span class="${cls}">${m}</span>`;
  });
}

function renderResponse() {
  const box = $('tpResponse');
  const r = state.last;
  if (!r) {
    box.replaceChildren(h('div', { class: 'tp-empty' },
      'Press ', h('b', {}, 'Send'), ' (or ⌘↵) to run this API. Unsaved changes are saved first.'));
    return;
  }
  if (r.error) {
    box.replaceChildren(h('div', { class: 'tp-banner err' }, icon('alert', 15), h('span', {}, r.error)));
    return;
  }

  const type = (r.headers.find(([k]) => k === 'content-type') || [])[1] || '';
  let pretty = null;
  if (!r.binary && r.body.trim()) {
    try { pretty = JSON.stringify(JSON.parse(r.body), null, 2); } catch {}
  }
  // Errors printed in the response + errors written to the server log (same error may be in both).
  const errors = [];
  const seen = new Set();
  for (const e of [...(r.binary ? [] : findPhpErrors(r.body)), ...(r.logErrors || []).map((x) => ({ ...x, fromLog: true }))]) {
    const key = `${e.path || e.serverFile}|${e.line}|${e.kind}`;
    if (!seen.has(key)) { seen.add(key); errors.push(e); }
  }
  const here = errors.filter((e) => e.path === hooks.currentPath());
  hooks.setRuntimeErrors(here.map((e) => ({ line: e.line, message: `${e.kind}: ${e.message}` })));

  const tone = r.status >= 500 ? 'err' : r.status >= 400 ? 'warn' : r.status >= 300 ? 'info' : 'ok';
  const showPretty = pretty !== null && view === 'pretty';
  const bodyText = showPretty ? pretty : r.body;

  const code = h('code', {});
  if (r.binary) code.textContent = `(binary response, ${fmtSize(r.size)})`;
  else if (!r.body) code.textContent = '(empty response)';
  else if (showPretty) code.innerHTML = highlightJson(pretty);
  else code.textContent = r.body;

  // replaceChildren() would print a literal "null" for skipped parts, so drop them first.
  box.replaceChildren(...[
    h('div', { class: 'tp-status' },
      h('span', { class: `status-pill ${tone}` }, `${r.status} ${r.statusText || ''}`.trim()),
      h('span', { class: 'tp-meta' }, `${r.timeMs} ms`),
      h('span', { class: 'tp-meta' }, fmtSize(r.size)),
      type ? h('span', { class: 'tp-meta mono' }, type.split(';')[0]) : null,
      h('span', { class: 'spacer' }),
      pretty !== null ? h('div', { class: 'seg seg-sm' },
        h('button', { class: view === 'pretty' ? 'active' : '', onclick: () => { view = 'pretty'; storeSet('testerView', view); renderResponse(); } }, 'Pretty'),
        h('button', { class: view === 'raw' ? 'active' : '', onclick: () => { view = 'raw'; storeSet('testerView', view); renderResponse(); } }, 'Raw')) : null,
      r.body ? h('button', { class: 'icon-btn ghost sm', title: 'Copy response', onclick: () => copyWithFeedback(bodyText, 'Response') }, icon('copy', 15)) : null),
    r.redirected ? h('div', { class: 'tp-note' }, 'Redirected to ', h('span', { class: 'mono' }, r.url)) : null,
    r.blockedRedirect ? h('div', { class: 'tp-note' }, 'The API redirects to another address, which the tester does not follow: ', h('span', { class: 'mono' }, r.blockedRedirect)) : null,
    ...errors.map((e) => h('div', { class: `tp-banner ${/error/i.test(e.kind) ? 'err' : 'warn'}` },
      icon('alert', 15),
      h('div', { class: 'tp-banner-text' },
        h('b', {}, `${e.kind}: `), e.message,
        h('div', { class: 'tp-banner-where mono' }, `${e.path ? baseName(e.path) : e.serverFile} — line ${e.line}${e.fromLog ? ' · from server log' : ''}`)),
      e.path === hooks.currentPath()
        ? h('button', { class: 'btn btn-sm', onclick: () => hooks.goToLine(e.line) }, 'Go to line')
        : e.path ? h('button', { class: 'btn btn-sm', onclick: () => hooks.openFile(e.path, e.line) }, 'Open file') : null)),
    r.logPending ? h('div', { class: 'tp-note tp-checking' }, icon('refresh', 13), 'Checking the server error log for PHP errors…') : null,
    r.logChecked && !errors.length ? h('div', { class: 'tp-note tp-clean' }, icon('check', 13), 'No PHP errors in the server log for this request') : null,
    r.logChecked && !errors.length && r.status >= 500 ? h('div', { class: 'tp-banner warn' }, icon('alert', 15),
      h('div', { class: 'tp-banner-text' }, `The server answered ${r.status} but logged no PHP error — the problem may be in .htaccess or the server setup.`)) : null,
    r.truncated ? h('div', { class: 'tp-note' }, 'Response is larger than 2 MB — only the first 2 MB is shown.') : null,
    h('pre', { class: 'tp-body' }, code),
    h('details', { class: 'tp-headers' },
      h('summary', {}, `Response headers (${r.headers.length})`),
      h('div', { class: 'tp-headers-list mono' }, r.headers.map(([k, v]) => h('div', {}, h('span', { class: 'hk' }, k), ': ', v)))),
    h('div', { class: 'tp-note' }, 'Sent: ', h('span', { class: 'mono' }, `${state.method} ${r.sentUrl}`)),
  ].filter(Boolean));
}

// ---------- wiring ----------

$('editorTest').onclick = () => toggleTester();
$('tpClose').onclick = () => toggleTester(false);
$('tpSend').onclick = () => sendTest();
$('tpReset').onclick = () => {
  if (!state.path) return;
  storeSet(storeKey(state.path), '');
  loadSettings(state.path);
  renderRequest();
  renderResponse();
};
$('tpMethod').onchange = (e) => { state.method = e.target.value; persist(); renderBodyType(); updateTabs(); };
$('tpUrl').oninput = (e) => { state.url = e.target.value; persist(); };
$('tpJson').oninput = (e) => { state.json = e.target.value; persist(); updateTabs(); };
document.querySelectorAll('#testPanel .tp-tab').forEach((t) => {
  t.onclick = () => { state.tab = t.dataset.tab; updateTabs(); };
});
document.querySelectorAll('#tpBodyType button').forEach((b) => {
  b.onclick = () => { state.bodyType = b.dataset.type; persist(); renderBodyType(); updateTabs(); };
});
panel().addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); sendTest(); }
});
