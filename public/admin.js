/* Munch Maze admin page: live mazes (kick), settings, accounts (rename), reserved names, score resets. */
(function () {
'use strict';
const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
let state = null, editing = false;

async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || 'Failed'), { status: r.status, body: j });
  return j;
}
function msg(id, text, bad) { const m = $(id); m.textContent = text || ''; m.classList.toggle('bad', !!bad); }

async function load() {
  try { state = await api('api/admin/state'); render(); }
  catch (e) {
    $('panels').hidden = true; $('gate').hidden = false;
    const b = e.body || {};
    if (b.discord === false) { $('gateMsg').textContent = 'Discord login isn’t set up on this server yet (DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET).'; $('gateLogin').hidden = true; }
    else if (b.loggedIn) { $('gateMsg').textContent = 'You’re logged in, but your Discord account isn’t in ADMIN_DISCORD_IDS.'; $('gateLogin').hidden = true; }
  }
}

function render() {
  $('gate').hidden = true; $('panels').hidden = false;
  // live games
  const gl = $('games'); gl.textContent = '';
  const players = state.games.reduce((n, g) => n + g.players.length, 0);
  $('liveCount').textContent = state.games.length + (state.games.length === 1 ? ' maze · ' : ' mazes · ') + players + (players === 1 ? ' player' : ' players');
  if (!state.games.length) gl.appendChild(el('p', 'hint', 'No mazes running right now.'));
  for (const g of state.games) {
    const card = el('div', 'adm-game');
    const top = el('div', 'adm-gtop');
    top.append(el('b', '', g.name));
    const tags = [g.mode === 'versus' ? 'Versus' : 'Co-op', 'Level ' + g.level, g.private ? 'Invite only' : 'Public'];
    if (g.daily) tags.push('Daily'); if (g.locked) tags.push('Password'); if (g.phase === 3) tags.push('In lobby');
    for (const t of tags) top.append(el('span', 'chip', t));
    card.append(top, el('span', 'hint', 'seed ' + g.seed + ' · id ' + g.id));
    const ul = el('ul', 'adm-players');
    for (const p of g.players) {
      const li = el('li');
      li.append(el('span', 'nm', p.name + (p.uid ? ' ✓' : '')), el('span', 'hint', (p.score | 0).toLocaleString() + ' pts · ' + (p.over ? 'out' : p.lives + ' lives')));
      const k = el('button', 'btn danger', 'Kick'); k.type = 'button';
      k.addEventListener('click', async () => {
        if (!confirm('Remove ' + p.name + ' from “' + g.name + '”? They won’t be able to rejoin that maze.')) return;
        try { state = (await api('api/admin/kick', { game: g.id, player: p.id })).state; render(); } catch (e) { alert(e.message); }
      });
      li.append(k); ul.append(li);
    }
    card.append(ul); gl.append(card);
  }
  // settings (don't overwrite while someone is typing)
  if (!editing) {
    const s = state.settings;
    $('sName').value = s.serverName; $('sLobby').checked = s.showLobby; $('sTest').checked = s.testMode; $('sMax').value = s.maxPlayersPerMaze;
    $('sHook').value = ''; $('sHook').placeholder = s.webhookSet ? s.webhookUrl + ' (set: paste a new one to change, or type “off”)' : 'https://discord.com/api/webhooks/…';
  }
  // accounts
  const al = $('accounts'); al.textContent = '';
  $('acctCount').textContent = state.accounts.length + (state.accounts.length === 1 ? ' account' : ' accounts');
  if (!state.accounts.length) al.appendChild(el('p', 'hint', 'Nobody has logged in with Discord yet.'));
  for (const a of state.accounts) {
    const row = el('div', 'adm-acct');
    row.append(el('b', '', a.name + ' ✓'), el('span', 'hint', '#' + a.uid + ' · ' + (a.games | 0) + ' games · best ' + (a.best | 0).toLocaleString() + ' · seen ' + new Date(a.lastLogin).toLocaleDateString()));
    const b = el('button', 'btn', 'Rename'); b.type = 'button';
    b.addEventListener('click', async () => {
      const name = prompt('New name for ' + a.name + ':', a.name); if (!name || name === a.name) return;
      try { state = (await api('api/admin/rename', { uid: a.uid, name })).state; render(); } catch (e) { alert(e.message); }
    });
    row.append(b); al.append(row);
  }
  // reserved
  const rl = $('reserved'); rl.textContent = '';
  if (!state.reserved.length) rl.appendChild(el('span', 'hint', 'None yet.'));
  for (const n of state.reserved) {
    const c = el('span', 'chip adm-res', n); const x = el('button', '', '✕'); x.type = 'button'; x.title = 'Free this name';
    x.addEventListener('click', async () => { try { state = (await api('api/admin/reserve', { name: n, on: false })).state; render(); } catch (e) { alert(e.message); } });
    c.append(x); rl.append(c);
  }
}

$('settings').addEventListener('focusin', () => { editing = true; });
$('settings').addEventListener('submit', async e => {
  e.preventDefault();
  const body = { serverName: $('sName').value.trim(), showLobby: $('sLobby').checked, testMode: $('sTest').checked, maxPlayersPerMaze: $('sMax').value };
  const hook = $('sHook').value.trim();
  if (hook.toLowerCase() === 'off') body.webhookUrl = ''; else if (hook) body.webhookUrl = hook;
  try { state = (await api('api/admin/settings', body)).state; editing = false; render(); msg('setMsg', 'Saved.'); }
  catch (err) { msg('setMsg', err.message, true); }
});
$('testHook').addEventListener('click', async () => {
  try { state = (await api('api/admin/settings', { testWebhook: true })).state; msg('setMsg', state.settings.webhookSet ? 'Test post sent: check your channel.' : 'Set a webhook URL first.', !state.settings.webhookSet); }
  catch (err) { msg('setMsg', err.message, true); }
});
$('reserveForm').addEventListener('submit', async e => {
  e.preventDefault(); const name = $('reserveIn').value.trim(); if (!name) return;
  try { state = (await api('api/admin/reserve', { name, on: true })).state; $('reserveIn').value = ''; render(); } catch (err) { alert(err.message); }
});
for (const b of document.querySelectorAll('[data-reset]')) b.addEventListener('click', async () => {
  const which = b.dataset.reset, label = { day: 'today’s daily board', week: 'this week’s board', all: 'ALL scores (every board, forever)' }[which];
  if (!confirm('Reset ' + label + '? This can’t be undone.')) return;
  try { state = (await api('api/admin/reset', { which })).state; msg('resetMsg', 'Done: ' + label + ' cleared.'); } catch (err) { msg('resetMsg', err.message, true); }
});

fetch('api/me', { cache: 'no-store' }).then(r => r.json()).then(m => { if (m.user) $('who').textContent = 'Logged in as ' + m.user.name; }).catch(() => {});
load();
setInterval(() => { if (!editing && !document.hidden) load(); }, 4000);
})();
