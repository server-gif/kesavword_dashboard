// Team view (owner only): add, edit, disable and remove members.
import { $, h, api, toast, dialog, icon, avatar, fmtDate, timeAgo, formModal, session } from './lib.js';

let users = [];

export async function showTeam() {
  $('teamLoading').classList.remove('hidden');
  try {
    users = (await api('GET', '/api/users')).users;
    render();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    $('teamLoading').classList.add('hidden');
  }
}

function render() {
  const sorted = [...users].sort((a, b) => (a.role === 'admin' ? -1 : b.role === 'admin' ? 1 : a.name.localeCompare(b.name)));
  $('teamRows').replaceChildren(...sorted.map((u) => {
    const owner = u.role === 'admin';
    const you = u.id === session.user.id;
    return h('tr', { class: u.active ? '' : 'dimmed' },
      h('td', { class: 'cell-user' },
        h('span', { class: 'who' }, avatar(u.name, u.username, 'md'),
          h('span', { class: 'who-text' },
            h('span', { class: 'strong' }, u.name, you ? h('span', { class: 'muted' }, ' (you)') : null),
            h('span', { class: 'muted' }, `@${u.username}`)))),
      h('td', {}, h('span', { class: `badge ${owner ? 'badge-violet' : 'badge-gray'}` }, icon(owner ? 'shield' : 'users', 13), owner ? 'Owner' : 'Member')),
      h('td', {}, h('span', { class: `status ${u.active ? 'on' : 'off'}` }, u.active ? 'Active' : 'Disabled')),
      h('td', { class: 'cell-date', title: u.lastLoginAt ? fmtDate(u.lastLoginAt) : '' }, u.lastLoginAt ? timeAgo(u.lastLoginAt) : 'Never'),
      h('td', { class: 'cell-date', title: fmtDate(u.createdAt) }, timeAgo(u.createdAt)),
      h('td', { class: 'cell-actions' },
        owner ? null : h('div', { class: 'row-actions visible' },
          h('button', { class: 'btn btn-sm', onclick: () => resetPassword(u) }, icon('key', 15), 'Reset password'),
          h('button', { class: 'btn btn-sm', onclick: () => toggleActive(u) }, icon(u.active ? 'ban' : 'check', 15), u.active ? 'Disable' : 'Enable'),
          h('button', { class: 'icon-btn ghost sm danger', title: 'Remove member', onclick: () => removeUser(u) }, icon('trash', 16)))));
  }));
  const members = users.filter((u) => u.role !== 'admin').length;
  $('teamFoot').textContent = `${members} team member${members === 1 ? '' : 's'}`;
}

async function addMember() {
  const created = await formModal({
    title: 'Add team member',
    description: 'They can browse, upload, edit, rename and delete files. They will not see Team or Activity.',
    submitText: 'Add member',
    fields: [
      { name: 'name', label: 'Full name', placeholder: 'Ravi Patel' },
      { name: 'username', label: 'Username', placeholder: 'ravi', hint: 'Used to sign in. Letters, numbers or an email address — no spaces.' },
      { name: 'password', label: 'Password', type: 'text', generate: true, hint: 'At least 8 characters. Share it with them privately.' },
    ],
    onSubmit: (v) => api('POST', '/api/users', { name: v.name, username: v.username.trim().toLowerCase(), password: v.password })
      .then((r) => ({ ...r.user, password: v.password })),
  });
  if (!created) return;
  showCredentials(created.name, created.username, created.password);
  showTeam();
}

function showCredentials(name, username, password) {
  const text = `${session.info.name} login\nLink: ${location.origin}\nUsername: ${username}\nPassword: ${password}`;
  dialog({
    title: `${name} can sign in now`,
    message: `Username: ${username}\nPassword: ${password}\n\nCopy these and send them privately. The password will not be shown again.`,
    okText: 'Copy login details',
  }).then((ok) => {
    if (ok) navigator.clipboard.writeText(text).then(() => toast('Login details copied'));
  });
}

async function resetPassword(u) {
  const result = await formModal({
    title: `Reset password for ${u.name}`,
    description: 'They will be signed out everywhere and must use the new password.',
    submitText: 'Reset password',
    fields: [{ name: 'password', label: 'New password', type: 'text', generate: true, hint: 'At least 8 characters.' }],
    onSubmit: (v) => api('POST', `/api/users/${u.id}`, { password: v.password }).then(() => v.password),
  });
  if (!result) return;
  showCredentials(u.name, u.username, result);
}

async function toggleActive(u) {
  if (u.active) {
    const ok = await dialog({
      title: `Disable ${u.name}?`,
      message: 'They will be signed out right away and cannot sign in until you enable them again.',
      okText: 'Disable',
      danger: true,
    });
    if (!ok) return;
  }
  try {
    await api('POST', `/api/users/${u.id}`, { active: !u.active });
    toast(`${u.name} ${u.active ? 'disabled' : 'enabled'}`);
    showTeam();
  } catch (err) { toast(err.message, 'err'); }
}

async function removeUser(u) {
  const ok = await dialog({
    title: `Remove ${u.name}?`,
    message: 'Their account will be deleted and they will lose access. Their past activity stays in the log.',
    okText: 'Remove',
    danger: true,
  });
  if (!ok) return;
  try {
    await api('POST', `/api/users/${u.id}/delete`);
    toast(`${u.name} removed`);
    showTeam();
  } catch (err) { toast(err.message, 'err'); }
}

$('btnAddMember').onclick = addMember;
