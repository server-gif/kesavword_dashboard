// Code editor and change (diff) viewer, both on Monaco (the VS Code editor).
import { $, h, api, toast, dialog, icon, openModal, closeModal, baseName, parentOf, extOf, isAdmin, fileTile, fmtDate, avatar, displayPath, publicUrl, copyWithFeedback } from './lib.js';
import { initTester, testerFileOpened, testerOpen, sendTest } from './test.js';

const MONACO_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min';
const LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  json: 'json', html: 'html', htm: 'html', vue: 'html', css: 'css', scss: 'scss', less: 'less', php: 'php',
  py: 'python', md: 'markdown', xml: 'xml', svg: 'xml', yml: 'yaml', yaml: 'yaml', sh: 'shell', bash: 'shell',
  sql: 'sql', java: 'java', go: 'go', rb: 'ruby', ini: 'ini', conf: 'ini', env: 'ini', htaccess: 'ini',
  twig: 'twig', dockerfile: 'dockerfile',
};
const languageFor = (path) => LANG[extOf(baseName(path))] || 'plaintext';

let monacoReady = null;

export function loadMonaco() {
  if (monacoReady) return monacoReady;
  monacoReady = new Promise((resolve) => {
    if (!window.require) return resolve(null);
    window.MonacoEnvironment = {
      getWorkerUrl: () => `data:text/javascript;charset=utf-8,${encodeURIComponent(
        `self.MonacoEnvironment={baseUrl:'${MONACO_BASE}/'};importScripts('${MONACO_BASE}/vs/base/worker/workerMain.js');`
      )}`,
    };
    window.require.config({ paths: { vs: `${MONACO_BASE}/vs` } });
    window.require(['vs/editor/editor.main'], () => resolve(window.monaco), () => resolve(null));
    setTimeout(() => resolve(window.monaco || null), 15000);
  });
  return monacoReady;
}

const monacoTheme = () => (document.documentElement.dataset.resolvedTheme === 'dark' ? 'vs-dark' : 'vs');
export function syncMonacoTheme() { window.monaco?.editor.setTheme(monacoTheme()); }

export function downloadFile(path) {
  const a = h('a', { href: `/api/download?path=${encodeURIComponent(path)}`, download: '' });
  document.body.append(a);
  a.click();
  a.remove();
}

function pathTitle(path) {
  const dir = displayPath(parentOf(path));
  return h('div', { class: 'modal-path', title: path },
    h('span', { class: 'modal-path-dir' }, dir.endsWith('/') ? dir : dir + '/'),
    h('span', { class: 'modal-path-name' }, baseName(path)));
}

// ---------- editor ----------

let editor = null;
let errorLines = null; // whole-line red highlight for lines with errors
let fallback = null;
let editing = null; // { path, mtime, savedVersion | savedText, onClosed }

// Monaco checks these itself; PHP is checked by the web server's own PHP ("php -l").
const BUILTIN_CHECKS = new Set(['javascript', 'typescript', 'json', 'css', 'scss', 'less']);
const PHP_OWNER = 'php-lint';
const check = { seq: 0, timer: null, lastEditAt: 0, php: 'idle', checker: null, lintedVersion: null };
const isPhp = (path) => /\.(php\d?|phtml)$/i.test(path);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isDirty() {
  if (!editing) return false;
  if (editor) return editor.getModel().getAlternativeVersionId() !== editing.savedVersion;
  return fallback.value !== editing.savedText;
}

function refreshDirty() { $('editorDirty').classList.toggle('hidden', !isDirty()); }

export const editorIsDirty = isDirty;

// ---------- error checking ----------

function checkMode() {
  if (!editing || !editor) return 'none';
  if (isPhp(editing.path)) return 'php';
  return BUILTIN_CHECKS.has(editor.getModel().getLanguageId()) ? 'builtin' : 'none';
}

function currentMarkers() {
  if (!editor) return [];
  const { MarkerSeverity, editor: ed } = window.monaco;
  return ed.getModelMarkers({ resource: editor.getModel().uri })
    .filter((m) => m.severity >= MarkerSeverity.Warning)
    .sort((a, b) => b.severity - a.severity || a.startLineNumber - b.startLineNumber);
}

const RUNTIME_OWNER = 'runtime';
const currentErrors = () => currentMarkers().filter((m) => m.severity === window.monaco.MarkerSeverity.Error);
const blockingErrors = () => currentErrors().filter((m) => m.owner !== RUNTIME_OWNER);

function setRuntimeErrors(list) {
  if (!editor) return;
  const model = editor.getModel();
  window.monaco.editor.setModelMarkers(model, RUNTIME_OWNER, list.map((e) => {
    const line = Math.min(Math.max(1, e.line), model.getLineCount());
    return {
      severity: window.monaco.MarkerSeverity.Error,
      startLineNumber: line,
      endLineNumber: line,
      startColumn: model.getLineFirstNonWhitespaceColumn(line) || 1,
      endColumn: model.getLineMaxColumn(line),
      message: e.message,
      source: 'API test',
    };
  }));
  renderProblems();
}

function applyPhpMarkers(model, res) {
  const { MarkerSeverity, editor: ed } = window.monaco;
  const toMarker = (severity) => (e) => {
    const line = Math.min(Math.max(1, e.line), model.getLineCount());
    return {
      severity,
      startLineNumber: line,
      endLineNumber: line,
      startColumn: model.getLineFirstNonWhitespaceColumn(line) || 1,
      endColumn: model.getLineMaxColumn(line),
      message: e.message,
      source: res.checker || 'PHP',
    };
  };
  ed.setModelMarkers(model, PHP_OWNER, [
    ...(res.errors || []).map(toMarker(MarkerSeverity.Error)),
    ...(res.warnings || []).map(toMarker(MarkerSeverity.Warning)),
  ]);
}

async function lintPhpNow() {
  const seq = ++check.seq;
  const model = editor.getModel();
  const version = model.getAlternativeVersionId();
  check.php = 'checking';
  renderProblems();
  let res;
  try {
    res = await api('POST', '/api/check', { path: editing.path, content: model.getValue() });
  } catch {
    res = { available: false, errors: [], warnings: [] };
  }
  if (seq !== check.seq || !editor || editor.getModel() !== model) return;
  check.php = res.available ? 'done' : 'unavailable';
  check.checker = res.checker;
  check.lintedVersion = res.available ? version : null;
  applyPhpMarkers(model, res);
  renderProblems();
}

// Runs the check right away (instead of waiting for the typing pause) and returns the errors.
async function checkBeforeSave() {
  const mode = checkMode();
  if (mode === 'php') {
    clearTimeout(check.timer);
    // Already checked this exact text? Use that. Otherwise the server checks while saving
    // (it refuses to write a file with errors), which saves a round trip.
    if (check.lintedVersion === editor.getModel().getAlternativeVersionId()) return blockingErrors();
    return [];
  } else if (mode === 'builtin') {
    const wait = 900 - (Date.now() - check.lastEditAt); // Monaco re-validates shortly after typing stops
    if (wait > 0) await sleep(wait);
  }
  return blockingErrors();
}

function onContentChanged() {
  refreshDirty();
  check.lastEditAt = Date.now();
  if (checkMode() === 'php') {
    clearTimeout(check.timer);
    check.timer = setTimeout(lintPhpNow, 1000);
  }
}

function goToLine(line, column = 1) {
  if (!editor) return;
  editor.revealLineInCenter(line);
  editor.setPosition({ lineNumber: line, column });
  editor.focus();
}

function renderProblems() {
  const bar = $('editorProblems');
  const mode = checkMode();
  bar.classList.toggle('hidden', !editor);
  if (!editor) return;
  errorLines?.set(currentErrors().map((m) => ({
    range: new window.monaco.Range(m.startLineNumber, 1, m.startLineNumber, 1),
    options: { isWholeLine: true, className: 'line-has-error', linesDecorationsClassName: 'line-error-gutter' },
  })));
  const setHead = (cls, iconName, ...text) => {
    bar.className = `problems ${cls}`;
    bar.replaceChildren(h('div', { class: 'problems-head' }, icon(iconName, 15), h('span', {}, ...text)));
  };
  if (mode === 'none') return setHead('muted', 'info', 'No automatic error check for this file type');
  const markers = currentMarkers();
  const label = mode === 'php' ? `${check.checker || 'PHP'} check` : `${editor.getModel().getLanguageId().toUpperCase()} check`;
  if (mode === 'php' && check.php === 'unavailable') return setHead('muted', 'info', 'PHP check is not available right now — save carefully');
  if (mode === 'php' && check.php === 'checking' && !markers.length) return setHead('muted checking', 'refresh', `Checking for errors… · ${label}`);
  if (!markers.length) return setHead('ok', 'check', 'No errors found', h('span', { class: 'problems-src' }, ` · ${label}`));

  const errors = markers.filter((m) => m.severity === window.monaco.MarkerSeverity.Error).length;
  const warnings = markers.length - errors;
  const summary = [errors ? `${errors} error${errors === 1 ? '' : 's'}` : null, warnings ? `${warnings} warning${warnings === 1 ? '' : 's'}` : null].filter(Boolean).join(', ');
  bar.className = `problems ${errors ? 'err' : 'warn'}${check.php === 'checking' ? ' checking' : ''}`;
  bar.replaceChildren(
    h('div', { class: 'problems-head' }, icon(errors ? 'alert' : 'info', 15), h('span', {}, summary, h('span', { class: 'problems-src' }, ` · ${label}`))),
    h('div', { class: 'problems-list' }, markers.slice(0, 50).map((m) => h('button', {
      class: `problem ${m.severity === window.monaco.MarkerSeverity.Error ? 'is-err' : 'is-warn'}`,
      onclick: () => goToLine(m.startLineNumber, m.startColumn),
    }, h('span', { class: 'problem-line' }, `Line ${m.startLineNumber}`), h('span', { class: 'problem-msg' }, m.message, m.owner === RUNTIME_OWNER ? h('span', { class: 'problem-tag' }, 'from API test') : null)))));
}

// Owner may save anyway; team members must fix the error first.
async function confirmErrors(errors) {
  const line = (e) => e.startLineNumber ?? e.line;
  const list = errors.slice(0, 3).map((e) => `Line ${line(e)}: ${e.message}`).join('\n');
  const more = errors.length > 3 ? `\n…and ${errors.length - 3} more` : '';
  goToLine(line(errors[0]));
  const title = `${errors.length} error${errors.length === 1 ? '' : 's'} in this file`;
  if (isAdmin()) {
    return dialog({
      title,
      message: `${list}${more}\n\nIf you save now, the live site will run this broken code.`,
      okText: 'Save anyway',
      cancelText: 'Fix it',
      danger: true,
    });
  }
  await dialog({
    title: `${title} — fix before saving`,
    message: `${list}${more}\n\nFiles with errors can't be saved, so the live site keeps working.`,
    okText: 'Go to error',
    cancelText: 'Close',
  });
  return false;
}

// Open a file and put the cursor on a line (used by the overview's error list).
export async function openEditorAt(path, line, onClosed) {
  await openEditor(path, onClosed);
  if (line && editing?.path === path) setTimeout(() => goToLine(line), 200);
}

export async function openEditor(path, onClosed) {
  let data;
  try {
    data = await api('GET', `/api/read?path=${encodeURIComponent(path)}`);
  } catch (err) {
    if (err.status === 415 || err.status === 413) {
      const ok = await dialog({ title: "This file can't be edited here", message: err.message, okText: 'Download' });
      if (ok) downloadFile(path);
    } else toast(err.message, 'err');
    return;
  }

  const modal = $('editorModal');
  $('editorTitle').replaceChildren(fileTile({ name: baseName(path), type: 'file' }, 'sm'), pathTitle(path));
  const lang = languageFor(path);
  $('editorLang').textContent = lang === 'plaintext' ? 'Plain text' : lang;
  $('editorCopyUrl').classList.toggle('hidden', !publicUrl(path));
  openModal(modal, () => { if (!editor?.hasTextFocus()) closeEditor(); });

  const monaco = await loadMonaco();
  if (monaco) {
    if (!editor) {
      // Syntax errors only — "unknown variable" style hints are too noisy for site code.
      monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
      monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
      editor = monaco.editor.create($('editorHost'), {
        automaticLayout: true,
        fontSize: 13,
        fontFamily: 'JetBrains Mono, ui-monospace, Menlo, monospace',
        minimap: { enabled: innerWidth > 900 },
        theme: monacoTheme(),
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        padding: { top: 12 },
      });
      errorLines = editor.createDecorationsCollection();
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveEditor());
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => { if (testerOpen()) sendTest(); });
      editor.onDidChangeModelContent(onContentChanged);
      monaco.editor.onDidChangeMarkers((uris) => {
        const uri = editor?.getModel()?.uri.toString();
        if (uri && uris.some((u) => u.toString() === uri)) renderProblems();
      });
    }
    clearTimeout(check.timer);
    check.seq++;
    check.php = 'idle';
    check.lintedVersion = null;
    editor.getModel()?.dispose();
    editor.setModel(monaco.editor.createModel(data.content, lang));
    editing = { path, mtime: data.mtime, size: data.size, savedVersion: editor.getModel().getAlternativeVersionId(), onClosed };
    testerFileOpened(path);
    editor.focus();
    renderProblems();
    if (checkMode() === 'php') lintPhpNow();
  } else {
    if (!fallback) {
      fallback = h('textarea', { class: 'fallback-editor', spellcheck: false, oninput: refreshDirty });
      fallback.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); saveEditor(); }
      });
      $('editorHost').append(fallback);
    }
    fallback.value = data.content;
    editing = { path, mtime: data.mtime, size: data.size, savedText: data.content, onClosed };
    testerFileOpened(path);
    fallback.focus();
    renderProblems();
  }
  refreshDirty();
}

let saveInFlight = false;

// close: true = "Save & Close" — closes only after a clean save, so errors stay on screen to fix.
async function saveEditor({ close = false } = {}) {
  if (!editing || saveInFlight) return undefined;
  saveInFlight = true;
  const buttons = [$('editorSave'), $('editorSaveOnly')];
  buttons.forEach((b) => { b.disabled = true; });
  let result = null;
  try {
    result = await doSave({});
  } finally {
    saveInFlight = false;
    buttons.forEach((b) => { b.disabled = false; });
  }
  if (close && result === 'ok') closeEditor();
  return result;
}

async function doSave({ force = false, allowErrors = false, skipCheck = false }) {
  if (!skipCheck && editor && !allowErrors) {
    const errors = await checkBeforeSave();
    if (errors.length) {
      if (!(await confirmErrors(errors))) return undefined;
      allowErrors = true;
    }
  }
  const content = editor ? editor.getValue() : fallback.value;
  try {
    const res = await api('POST', '/api/save', { path: editing.path, content, expectedMtime: editing.mtime, expectedSize: editing.size, force, allowErrors });
    editing.mtime = res.mtime;
    editing.size = res.size;
    if (editor) editing.savedVersion = editor.getModel().getAlternativeVersionId();
    else editing.savedText = content;
    refreshDirty();
    const name = baseName(editing.path);
    if (res.lint?.errors?.length || allowErrors) {
      toast(`Saved ${name} — with errors`, 'err');
      return 'with-errors';
    }
    if (editor) setRuntimeErrors([]); // code changed — re-run the test to check again
    toast(res.lint?.available ? `Saved ${name} · no PHP errors` : `Saved ${name}`);
    return 'ok';
  } catch (err) {
    if (err.data?.conflict) {
      const ok = await dialog({
        title: 'File changed on the server',
        message: `${err.message} Saving now will replace their changes with yours.`,
        okText: 'Overwrite anyway',
        danger: true,
      });
      if (ok) return doSave({ force: true, allowErrors, skipCheck: true });
    } else if (err.data?.lint) {
      // The server found a PHP error the editor had not shown yet.
      if (editor) {
        check.php = 'done';
        check.checker = err.data.checker;
        applyPhpMarkers(editor.getModel(), err.data);
        renderProblems();
      }
      if (await confirmErrors(err.data.errors)) return doSave({ force, allowErrors: true, skipCheck: true });
    } else toast(`Save failed: ${err.message}`, 'err');
  }
}

async function closeEditor() {
  if (!editing) return;
  if (isDirty()) {
    const ok = await dialog({ title: 'Discard unsaved changes?', message: 'Your edits to this file have not been saved.', okText: 'Discard', danger: true });
    if (!ok) return;
  }
  clearTimeout(check.timer);
  check.seq++;
  const { onClosed } = editing;
  editing = null;
  closeModal($('editorModal'));
  onClosed?.();
}

initTester({
  isDirty,
  save: () => saveEditor(),
  goToLine,
  setRuntimeErrors,
  currentPath: () => editing?.path,
  getContent: () => (editor ? editor.getValue() : fallback?.value || ''),
  // An error from the API test points at another file (e.g. an included db.php): open it.
  openFile: async (path, line) => {
    if (isDirty()) {
      const ok = await dialog({ title: 'Discard unsaved changes?', message: `Open ${baseName(path)} instead? Your edits to ${baseName(editing.path)} have not been saved.`, okText: 'Discard and open', danger: true });
      if (!ok) return;
    }
    const { onClosed } = editing;
    editing = null;
    await openEditor(path, onClosed);
    if (line) setTimeout(() => goToLine(line), 300);
  },
});

$('editorSave').onclick = () => saveEditor({ close: true });
$('editorSaveOnly').onclick = () => saveEditor();
$('editorCopyUrl').onclick = () => {
  const url = editing && publicUrl(editing.path);
  if (url) copyWithFeedback(url, 'URL');
};
$('editorClose').onclick = closeEditor;

// ---------- diff viewer ----------

let diffEditor = null;

export async function openDiff(entryId, { onReverted } = {}) {
  let data;
  try {
    data = await api('GET', `/api/activity/${entryId}/diff`);
  } catch (err) {
    return toast(err.message, 'err');
  }
  const { entry } = data;
  $('diffTitle').replaceChildren(fileTile({ name: baseName(data.path), type: 'file' }, 'sm'), pathTitle(data.path));
  $('diffMeta').replaceChildren(
    entry ? avatar(entry.name, entry.user, 'xs') : '',
    entry ? h('span', {}, h('b', {}, entry.name), ` · ${fmtDate(entry.ts)}`) : '');
  const revert = $('diffRevert');
  revert.classList.toggle('hidden', !isAdmin());
  revert.onclick = async () => {
    const ok = await dialog({
      title: 'Restore the old version?',
      message: `${baseName(data.path)} will be put back to how it was before this change. The current content is kept in the history, so this can be undone too.`,
      okText: 'Restore old version',
    });
    if (!ok) return;
    try {
      await api('POST', `/api/activity/${entryId}/revert`);
      toast('Old version restored');
      closeModal($('diffModal'));
      onReverted?.();
    } catch (err) { toast(err.message, 'err'); }
  };

  const modal = $('diffModal');
  openModal(modal, () => closeModal(modal));
  const host = $('diffHost');
  const monaco = await loadMonaco();
  if (monaco) {
    if (!diffEditor) {
      diffEditor = monaco.editor.createDiffEditor(host, {
        readOnly: true,
        automaticLayout: true,
        renderSideBySide: innerWidth > 900,
        theme: monacoTheme(),
        fontSize: 13,
        scrollBeyondLastLine: false,
      });
    }
    const old = diffEditor.getModel();
    const lang = languageFor(data.path);
    diffEditor.setModel({
      original: monaco.editor.createModel(data.before ?? '', lang),
      modified: monaco.editor.createModel(data.after ?? '', lang),
    });
    old?.original.dispose();
    old?.modified.dispose();
  } else {
    host.replaceChildren(h('div', { class: 'diff-fallback' },
      h('div', {}, h('div', { class: 'diff-label' }, 'Before'), h('pre', {}, data.before ?? '')),
      h('div', {}, h('div', { class: 'diff-label' }, 'After'), h('pre', {}, data.after ?? ''))));
  }
}

$('diffClose').onclick = () => closeModal($('diffModal'));
