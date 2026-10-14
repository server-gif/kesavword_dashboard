// Entry point: theme, sign-in, sidebar and routing between views.
import { $, api, toast, icon, hydrateIcons, avatar, formModal, session, isAdmin, storeGet, storeSet } from './js/lib.js';
import { loadMonaco, syncMonacoTheme, editorIsDirty } from './js/editor.js';
import { showFiles } from './js/files.js';
import { showTrash, resetTrash } from './js/trash.js';
import { showActivity, resetActivity } from './js/activity.js';
import { showTeam } from './js/team.js';
import { showOverview, resetOverview } from './js/overview.js';
import { showApiDetail } from './js/apidetail.js';

hydrateIcons();

// ---------- theme ----------

const THEMES = ['system', 'light', 'dark'];
const media = matchMedia('(prefers-color-scheme: dark)');

function applyTheme() {
  const pref = storeGet('theme') || 'system';
  const root = document.documentElement;
  if (pref === 'system') delete root.dataset.theme;
  else root.dataset.theme = pref;
  root.dataset.resolvedTheme = pref === 'system' ? (media.matches ? 'dark' : 'light') : pref;
  const btn = $('btnTheme');
  btn.replaceChildren(icon({ system: 'monitor', light: 'sun', dark: 'moon' }[pref], 17));
  btn.title = `Theme: ${pref}`;
  syncMonacoTheme();
}
media.addEventListener('change', applyTheme);
$('btnTheme').onclick = () => {
  const cur = storeGet('theme') || 'system';
  storeSet('theme', THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length]);
  applyTheme();
};
applyTheme();

// ---------- sign in / first-time setup ----------

let authMode = 'login';

function showAuth(mode) {
  authMode = mode;
  $('app').classList.add('hidden');
  $('auth').classList.remove('hidden');
  $('authBrand').textContent = session.info?.name || 'Server Dashboard';
  const setup = mode === 'setup';
  $('authTitle').textContent = setup ? 'Create the owner account' : 'Welcome back';
  $('authSub').textContent = setup
    ? 'You are the first one here. This account will be the owner — only you can add team members and see the activity log.'
    : 'Sign in to manage your server files.';
  document.querySelectorAll('.setup-only').forEach((el) => el.classList.toggle('hidden', !setup));
  $('authSubmit').querySelector('span:last-child').textContent = setup ? 'Create account' : 'Sign in';
  $('authPassword').autocomplete = setup ? 'new-password' : 'current-password';
  setPasswordVisible(false);
  $('authError').classList.add('hidden');
  setTimeout(() => (setup ? $('authName') : $('authUsername')).focus(), 0);
}

function setPasswordVisible(show) {
  for (const id of ['authPassword', 'authConfirm']) $(id).type = show ? 'text' : 'password';
  $('pwToggle').replaceChildren(icon(show ? 'eyeOff' : 'eye', 16));
  $('pwToggle').title = show ? 'Hide password' : 'Show password';
}
$('pwToggle').onclick = () => setPasswordVisible($('authPassword').type === 'password');

// While creating the owner account, keep the username to what the server accepts.
$('authUsername').addEventListener('input', (e) => {
  if (authMode !== 'setup') return;
  const clean = e.target.value.toLowerCase().replace(/[^a-z0-9._@+-]/g, '');
  if (clean !== e.target.value) e.target.value = clean;
});

$('authForm').onsubmit = async (e) => {
  e.preventDefault();
  const err = $('authError');
  err.classList.add('hidden');
  const body = {
    username: $('authUsername').value.trim().toLowerCase(),
    password: $('authPassword').value,
  };
  if (authMode === 'setup') {
    body.name = $('authName').value.trim();
    const problem = !body.name ? 'Enter your name'
      : body.username.length < 3 ? 'Username needs at least 3 letters'
      : body.password.length < 8 ? `Password must be at least 8 characters (you typed ${body.password.length})`
      : body.password !== $('authConfirm').value ? 'Passwords do not match — tap the eye icon to check them'
      : null;
    if (problem) {
      err.textContent = problem;
      return err.classList.remove('hidden');
    }
  }
  $('authSubmit').disabled = true;
  try {
    const res = await api('POST', authMode === 'setup' ? '/api/setup' : '/api/login', body);
    session.user = res.user;
    $('authForm').reset();
    await startApp();
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove('hidden');
  } finally {
    $('authSubmit').disabled = false;
  }
};

window.addEventListener('session-expired', () => {
  if ($('app').classList.contains('hidden')) return;
  session.user = null;
  toast('Your session ended — please sign in again', 'err');
  showAuth('login', session.info);
});

// ---------- app shell ----------

const VIEWS = {
  overview: { title: 'Overview', sub: () => `How your APIs are doing${session.info.url ? ` on ${session.info.url.replace(/^https?:\/\//, '')}` : ''}`, show: () => showOverview(), reset: () => resetOverview(), admin: true },
  api: { title: 'API details', sub: () => '', show: (params) => showApiDetail(params), admin: true, nav: 'overview' },
  files: { title: 'Files', sub: () => (session.info.url ? `Website files of ${session.info.url.replace(/^https?:\/\//, '')}` : `Everything inside ${session.info.home}`), show: (params) => showFiles(params.get('path') || session.info.home) },
  trash: { title: 'Recycle Bin', sub: () => `Deleted items are kept for ${session.info.trashDays} days, then removed forever automatically.`, show: () => showTrash(), reset: () => resetTrash() },
  activity: { title: 'Activity', sub: () => 'Every change made by you and your team, newest first.', show: () => showActivity(), reset: () => resetActivity(), admin: true },
  team: { title: 'Team', sub: () => 'People who can sign in to this dashboard.', show: () => showTeam(), admin: true },
};

async function startApp() {
  try {
    session.info = await api('GET', '/api/info');
  } catch (err) {
    toast(`Could not connect to the server: ${err.message}`, 'err');
    session.info = { ...session.info, home: '/', trashDays: 15, trashCount: 0 };
  }
  $('auth').classList.add('hidden');
  $('app').classList.remove('hidden');

  const u = session.user;
  $('meAvatar').replaceChildren(avatar(u.name, u.username, 'md'));
  $('meName').textContent = u.name;
  $('meRole').textContent = u.role === 'admin' ? 'Owner' : 'Team member';
  document.querySelectorAll('.admin-only').forEach((el) => el.classList.toggle('hidden', !isAdmin()));
  $('sideBrand').textContent = session.info.name || 'Server Dashboard';
  setTrashBadge(session.info.trashCount);
  route();
  loadMonaco();
}

function setTrashBadge(n) {
  const b = $('trashBadge');
  b.textContent = n;
  b.classList.toggle('hidden', !n);
}

window.addEventListener('trash-changed', async () => {
  try { setTrashBadge((await api('GET', '/api/trash')).items.length); } catch {}
});

let lastViewName = null;

function route() {
  if (!session.user) return;
  const [rawName, qs] = location.hash.replace(/^#\/?/, '').split('?');
  // The owner lands on the overview; team members on their files.
  let name = VIEWS[rawName] ? rawName : isAdmin() ? 'overview' : 'files';
  if (VIEWS[name].admin && !isAdmin()) name = 'files';
  const view = VIEWS[name];

  // A genuine sidebar section change: reset the view so it opens fresh instead of
  // resuming filters, scroll or selections left over from the previous visit.
  const switching = name !== lastViewName;
  lastViewName = name;

  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${name}`));
  document.querySelectorAll('.nav-item').forEach((a) => a.classList.toggle('active', a.dataset.view === (view.nav || name)));
  $('pageTitle').textContent = view.title;
  $('pageSub').textContent = view.sub();
  document.title = `${view.title} · ${session.info.name || 'Server Dashboard'}`;
  // (views that know better, like API details, set their own title and subtitle when they render)
  $('sidebar').classList.remove('open');
  if (switching) {
    view.reset?.();
    const sec = $(`view-${name}`);
    sec?.querySelectorAll('.ov-body, .table-card').forEach((el) => { el.scrollTop = 0; });
  }
  view.show(new URLSearchParams(qs || ''));
}

window.addEventListener('hashchange', route);

// ---------- account ----------

$('btnLogout').onclick = async () => {
  if (editorIsDirty()) return toast('Save or close the open file first', 'err');
  await api('POST', '/api/logout').catch(() => {});
  session.user = null;
  showAuth('login', session.info);
};

$('btnPassword').onclick = () => formModal({
  title: 'Change your password',
  submitText: 'Change password',
  fields: [
    { name: 'current', label: 'Current password', type: 'password', autocomplete: 'current-password' },
    { name: 'next', label: 'New password', type: 'password', autocomplete: 'new-password', hint: 'At least 8 characters.' },
    { name: 'confirm', label: 'Confirm new password', type: 'password', autocomplete: 'new-password' },
  ],
  onSubmit: async (v) => {
    if (v.next !== v.confirm) throw new Error('New passwords do not match');
    await api('POST', '/api/account/password', { current: v.current, next: v.next });
    toast('Password changed');
  },
});

$('btnMenu').onclick = () => $('sidebar').classList.toggle('open');
$('sidebarScrim').onclick = () => $('sidebar').classList.remove('open');

// ---------- boot ----------

(async () => {
  try {
    const s = await api('GET', '/api/session');
    session.info = { ...s.site };
    document.title = s.site.name;
    if (s.setupRequired) return showAuth('setup');
    if (!s.user) return showAuth('login');
    session.user = s.user;
    await startApp();
  } catch (err) {
    showAuth('login');
    $('authError').textContent = `Dashboard server is not reachable: ${err.message}`;
    $('authError').classList.remove('hidden');
  }
})();
