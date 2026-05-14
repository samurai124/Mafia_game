/* game.js — Part 1: Core state, utilities, landing & lobby */
const socket = io();
const AVATARS = ['😎','🤠','🤓','😇','🤫','😈','👽','👻','🐱','🐶'];

let mySocketId = null, isHost = false, myRole = null;
let myRoomCode = null, myAlive = true, myColor = null;
let playerColors = {};
let gameSettings = {};
let activeTimers = {};

/* ── DOM helpers ── */
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

/* ── Screen management ── */
const screens = {
  landing: $('#landing-screen'), waiting: $('#waiting-screen'),
  role: $('#role-screen'), night: $('#night-screen'),
  nightResult: $('#night-result-screen'), day: $('#day-screen'),
  vote: $('#vote-screen'), defense: $('#defense-screen'),
  revote: $('#revote-screen'), voteResult: $('#vote-result-screen'),
  gameover: $('#gameover-screen')
};

function showScreen(name) {
  Object.values(screens).forEach(s => s && s.classList.remove('active'));
  if (screens[name]) screens[name].classList.add('active');
}

/* ── Toast ── */
function showToast(msg, type = 'info') {
  const c = $('#toast-container');
  const t = document.createElement('div');
  t.className = 'toast';
  if (type === 'error') Object.assign(t.style, { backgroundColor: 'var(--danger)' });
  if (type === 'success') Object.assign(t.style, { backgroundColor: 'var(--success)' });
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.classList.add('visible'), 10);
  setTimeout(() => { t.classList.remove('visible'); setTimeout(() => t.remove(), 400); }, 3500);
}

function showError(msg) {
  const el = $('#error-msg');
  el.textContent = msg; el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 3000);
}

/* ── Phase overlay ── */
function showPhaseOverlay(text, type = 'night', duration = 2000) {
  const overlay = $('#phase-overlay');
  $('#overlay-text').textContent = text;
  overlay.className = `phase-overlay ${type}-overlay active`;
  setTimeout(() => overlay.classList.remove('active'), duration);
}

/* ── Timer bar ── */
function startTimer(fillId, labelId, seconds) {
  const fill = $(`#${fillId}`);
  const label = $(`#${labelId}`);
  if (!fill || !label) return;
  if (activeTimers[fillId]) clearInterval(activeTimers[fillId]);

  let remaining = seconds;
  fill.style.width = '100%';
  fill.classList.remove('urgent');
  label.classList.remove('urgent');
  label.textContent = `${remaining}s`;

  activeTimers[fillId] = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(activeTimers[fillId]);
      fill.style.width = '0%';
      label.textContent = '0s';
      return;
    }
    const pct = (remaining / seconds) * 100;
    fill.style.width = `${pct}%`;
    label.textContent = `${remaining}s`;
    if (remaining <= 10) {
      fill.classList.add('urgent');
      label.classList.add('urgent');
    }
  }, 1000);
}

function stopTimer(fillId) {
  if (activeTimers[fillId]) { clearInterval(activeTimers[fillId]); delete activeTimers[fillId]; }
}

/* ── Role color helper ── */
function getRoleColor(role, opacity) {
  const rgb = { Mafia: '220,53,69', Doctor: '25,135,84', Cheikh: '126,34,206', Citizen: '13,110,253' }[role] || '108,117,125';
  return `rgba(${rgb},${opacity})`;
}

/* ── Win stats (localStorage) ── */
function getStats() {
  return JSON.parse(localStorage.getItem('mafia-stats') || '{"wins":0,"games":0}');
}
function saveStats(stats) { localStorage.setItem('mafia-stats', JSON.stringify(stats)); }
function recordGame(won) {
  const s = getStats(); s.games++; if (won) s.wins++;
  saveStats(s); renderStats();
}
function renderStats() {
  const s = getStats();
  if (s.games === 0) { $('#landing-stats').style.display = 'none'; return; }
  $('#landing-stats').style.display = 'flex';
  $('#stat-wins').textContent = s.wins;
  $('#stat-games').textContent = s.games;
  $('#stat-winrate').textContent = Math.round((s.wins / s.games) * 100) + '%';
}

/* ── Game Log ── */
function addToGameLog(entry) {
  const container = $('#log-entries');
  if (!container) return;
  const div = document.createElement('div');
  div.className = `log-entry ${entry.type || ''}`;
  div.innerHTML = `<span class="log-time">${entry.timestamp || ''}</span>${entry.text}`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

$('#btn-game-log').addEventListener('click', () => {
  $('#game-log-panel').classList.toggle('hidden');
});

/* ── Connect / Reconnect ── */
socket.on('connect', () => {
  mySocketId = socket.id;
  const savedToken = localStorage.getItem('mafia-session-token');
  if (savedToken) socket.emit('attempt-reconnect', { token: savedToken });
});

/* ── Landing ── */
renderStats();

$('#btn-create').addEventListener('click', () => {
  const name = $('#player-name').value.trim();
  if (!name) { showError('Please enter your name.'); return; }
  socket.emit('create-room', { playerName: name });
});

$('#btn-join').addEventListener('click', () => {
  const name = $('#player-name').value.trim();
  const code = $('#room-code-input').value.trim().toUpperCase();
  if (!name) { showError('Please enter your name.'); return; }
  if (!code) { showError('Please enter a room code.'); return; }
  socket.emit('join-room', { roomCode: code, playerName: name });
});

$('#player-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') { const c = $('#room-code-input').value.trim(); c ? $('#btn-join').click() : $('#btn-create').click(); }
});
$('#room-code-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btn-join').click(); });

/* ── Lobby events ── */
socket.on('room-created', ({ roomCode, players, sessionToken, settings }) => {
  isHost = true; myRoomCode = roomCode; gameSettings = settings || {};
  localStorage.setItem('mafia-session-token', sessionToken);
  enterWaiting(roomCode, players);
});

socket.on('room-joined', ({ roomCode, isHost: h, players, sessionToken, settings }) => {
  isHost = h; myRoomCode = roomCode; gameSettings = settings || {};
  localStorage.setItem('mafia-session-token', sessionToken);
  enterWaiting(roomCode, players);
});

socket.on('join-error', ({ message }) => showError(message));
socket.on('start-error', ({ message }) => showToast(message, 'error'));

socket.on('settings-updated', (settings) => {
  gameSettings = settings;
  applySettingsToUI(settings);
});

socket.on('kicked', ({ message }) => {
  localStorage.removeItem('mafia-session-token');
  showToast(message, 'error');
  showScreen('landing');
});

function enterWaiting(code, players) {
  showScreen('waiting');
  $('#display-room-code').textContent = code;
  updatePlayerList(players);
  if (isHost) {
    $('#host-controls').classList.remove('hidden');
    $('#waiting-note').classList.add('hidden');
  } else {
    $('#host-controls').classList.add('hidden');
    $('#waiting-note').classList.remove('hidden');
  }
  $('#chat-sidebar').classList.remove('hidden');
}

$('#btn-copy-code').addEventListener('click', () => {
  navigator.clipboard.writeText(myRoomCode).then(() => showToast('Code copied!', 'success'));
});

/* ── Settings ── */
$('#btn-toggle-settings').addEventListener('click', () => {
  $('#settings-panel').classList.toggle('hidden');
});

function applySettingsToUI(s) {
  if ($('#set-discussion')) $('#set-discussion').value = s.discussionTime;
  if ($('#set-voting')) $('#set-voting').value = s.votingTime;
  if ($('#set-defense')) $('#set-defense').value = s.defenseTime;
  if ($('#set-enableDefense')) $('#set-enableDefense').checked = s.enableDefense;
  if ($('#set-enableLastWords')) $('#set-enableLastWords').checked = s.enableLastWords;
  if ($('#set-enableCheikh')) $('#set-enableCheikh').checked = s.enableCheikh;
}

['set-discussion', 'set-voting', 'set-defense', 'set-enableDefense', 'set-enableLastWords', 'set-enableCheikh'].forEach(id => {
  const el = $(`#${id}`);
  if (!el) return;
  el.addEventListener('change', () => {
    socket.emit('update-settings', {
      discussionTime: +$('#set-discussion').value,
      votingTime: +$('#set-voting').value,
      defenseTime: +$('#set-defense').value,
      enableDefense: $('#set-enableDefense').checked,
      enableLastWords: $('#set-enableLastWords').checked,
      enableCheikh: $('#set-enableCheikh').checked
    });
  });
});

/* ── Player list ── */
socket.on('player-list-update', ({ players, hostId }) => {
  updatePlayerList(players);
  if (hostId === mySocketId && !isHost) {
    isHost = true; showToast('You are now the host!', 'success');
    if (screens.waiting.classList.contains('active')) {
      $('#host-controls').classList.remove('hidden');
      $('#waiting-note').classList.add('hidden');
    }
    if (screens.day.classList.contains('active')) {
      $('#day-host-controls').classList.remove('hidden');
      $('#day-waiting-note').classList.add('hidden');
    }
  }
});

function updatePlayerList(players) {
  const list = $('#player-list'); list.innerHTML = '';
  players.forEach((p, i) => {
    const li = document.createElement('li');
    li.className = 'player-card';
    const isMe = p.id === mySocketId;
    const avatar = AVATARS[i % AVATARS.length];
    const color = p.color || '#6c757d';
    if (isMe) myColor = color;
    li.innerHTML = `
      <div class="player-avatar" style="filter:drop-shadow(0 2px 4px ${color}66)">${avatar}</div>
      <div class="player-name" style="color:${color}">${p.name}</div>
      ${isMe ? '<div><span class="tag tag-you">YOU</span></div>' : ''}
      ${isHost && !isMe ? `<button class="btn-kick" data-id="${p.id}">Kick</button>` : ''}
    `;
    list.appendChild(li);
  });
  $('#player-count-num').textContent = players.length;
  const btn = $('#btn-start');
  if (btn) { btn.disabled = players.length < 4; btn.textContent = players.length < 4 ? `Need ${4 - players.length} more` : 'Start Game'; }

  // Kick buttons
  $$('.btn-kick').forEach(btn => {
    btn.addEventListener('click', () => socket.emit('kick-player', { targetId: btn.dataset.id }));
  });
}

socket.on('player-disconnected', ({ name, message }) => showToast(message || `${name} disconnected.`));
socket.on('player-reconnected', ({ name }) => showToast(`${name} reconnected!`, 'success'));

$('#btn-start').addEventListener('click', () => socket.emit('start-game'));

/* ── Sound events ── */
socket.on('sound', ({ type }) => { if (typeof playSound === 'function') playSound(type); });

/* ── Timer events ── */
socket.on('timer-start', ({ phase, seconds }) => {
  const map = { discussion: ['timer-fill-day','timer-label-day'], voting: ['timer-fill-vote','timer-label-vote'], defense: ['timer-fill-defense','timer-label-defense'], revote: ['timer-fill-revote','timer-label-revote'], 'night-action': ['timer-fill-night','timer-label-night'], lastwords: ['timer-fill-lastwords','timer-label-lastwords'] };
  if (map[phase]) { const [f,l] = map[phase]; startTimer(f, l, seconds); }
});

/* ── Roles ── */
socket.on('role-assigned', ({ role, emoji, description, instruction, team, playerColors: colors }) => {
  myRole = role; playerColors = colors || {};
  showScreen('role');
  $('#role-card-container').className = `role-card-large ${team === 'mafia' ? 'mafia' : 'citizen'}`;
  $('#role-emoji').textContent = emoji;
  $('#role-name').textContent = role;
  $('#role-name').className = `role-name-large ${team === 'mafia' ? 'role-mafia' : 'role-citizen'}`;
  $('#role-desc').textContent = description;
  $('#role-instruction-box').className = `instruction-box ${team === 'mafia' ? 'mafia' : 'citizen'}`;
  $('#role-instruction-text').textContent = instruction;
});

/* ── Phase changes ── */
socket.on('phase-change', ({ phase, round, message, alivePlayers, timeLimit }) => {
  if (phase === 'night') {
    showPhaseOverlay('🌙 Night Falls', 'night', 2000);
    setTimeout(() => {
      showScreen('night');
      $('#night-round').textContent = round;
      $('#night-message').textContent = message;
      $('#night-action-panel').classList.add('hidden');
      $('#night-confirmed').classList.add('hidden');
      $('#cheikh-result-panel').classList.add('hidden');
      $('#night-waiting').classList.remove('hidden');
      $('#timer-bar-night').classList.add('hidden');
      $$('.step-dot').forEach(s => s.classList.remove('active','done'));
      if (myRole === 'Mafia') $('#mafia-night-chat-night').classList.remove('hidden');
    }, 1500);
  } else if (phase === 'day') {
    showPhaseOverlay('☀️ Day Begins', 'day', 2000);
    setTimeout(() => {
      showScreen('day');
      $('#day-round').textContent = round;
      renderAliveList('#day-alive-list', alivePlayers);
      if (isHost) { $('#day-host-controls').classList.remove('hidden'); $('#day-waiting-note').classList.add('hidden'); }
      else { $('#day-host-controls').classList.add('hidden'); $('#day-waiting-note').classList.remove('hidden'); }
      if (timeLimit) startTimer('timer-fill-day','timer-label-day', timeLimit);
      $('#mafia-night-chat-night').classList.add('hidden');
    }, 1500);
  } else if (phase === 'vote') {
    showScreen('vote');
    renderVoteTargets(alivePlayers);
    $('#vote-submitted').classList.add('hidden');
    $('#vote-progress').textContent = `0 / ${alivePlayers.length} votes cast`;
    if (timeLimit) startTimer('timer-fill-vote','timer-label-vote', timeLimit);
  }
});

socket.on('night-step', ({ step, message }) => {
  $('#night-message').textContent = message;
  ['mafia','doctor','cheikh'].forEach((s,si) => {
    const el = $(`.step-dot[data-step="${s}"]`); if (!el) return;
    el.classList.remove('active','done');
    const ci = ['mafia','doctor','cheikh'].indexOf(step);
    if (si < ci) el.classList.add('done'); if (si === ci) el.classList.add('active');
  });
});

socket.on('night-action-prompt', ({ role, targets, message, timeLimit }) => {
  $('#night-waiting').classList.add('hidden');
  $('#night-confirmed').classList.add('hidden');
  $('#cheikh-result-panel').classList.add('hidden');
  $('#night-action-panel').classList.remove('hidden');
  $('#action-prompt').textContent = message;
  $('#timer-bar-night').classList.remove('hidden');
  if (timeLimit) startTimer('timer-fill-night','timer-label-night', timeLimit);
  const list = $('#action-targets'); list.innerHTML = '';
  targets.forEach((t,i) => {
    const li = document.createElement('li');
    const color = playerColors[t.id] || '#6c757d';
    li.innerHTML = `<button class="target-btn" data-target-id="${t.id}"><div class="target-avatar-small">${AVATARS[i%AVATARS.length]}</div><span style="color:${color}">${t.name}</span></button>`;
    const btn = li.querySelector('button');
    btn.addEventListener('click', () => { socket.emit('night-action', { targetId: t.id }); $$('#action-targets .target-btn').forEach(b=>b.disabled=true); btn.classList.add(role==='Mafia'?'selected-danger':'selected'); stopTimer('timer-fill-night'); });
    list.appendChild(li);
  });
});

socket.on('night-action-confirmed', ({ message }) => {
  $('#night-action-panel').classList.add('hidden');
  $('#timer-bar-night').classList.add('hidden');
  $('#night-confirmed').classList.remove('hidden');
  $('#confirmed-message').textContent = message;
  stopTimer('timer-fill-night');
});

socket.on('cheikh-result', ({ result, message }) => {
  $('#night-action-panel').classList.add('hidden');
  $('#cheikh-result-panel').classList.remove('hidden');
  const el = $('#cheikh-result-text');
  el.textContent = message;
  el.style.color = result === 'Mafia' ? 'var(--danger)' : 'var(--success)';
});

socket.on('night-result', ({ saved, message, victim }) => {
  showScreen('nightResult');
  $('#night-result-message').textContent = message;
  $('#last-words-display-night').classList.add('hidden');
  $('#last-words-input-panel').classList.add('hidden');
  if (victim) {
    $('#night-victim-info').classList.remove('hidden');
    $('#night-victim-name').textContent = victim.name;
    $('#night-victim-role').textContent = victim.role;
    if (victim.id === mySocketId) myAlive = false;
  } else { $('#night-victim-info').classList.add('hidden'); }
});

socket.on('last-words-prompt', ({ timeLimit }) => {
  $('#last-words-input-panel').classList.remove('hidden');
  startTimer('timer-fill-lastwords','timer-label-lastwords', timeLimit);
  showToast('Say your last words!', 'error');
});

$('#btn-submit-last-words').addEventListener('click', () => {
  const text = $('#last-words-textarea').value.trim();
  socket.emit('submit-last-words', { text: text || '...' });
  $('#last-words-input-panel').classList.add('hidden');
  stopTimer('timer-fill-lastwords');
});

socket.on('last-words', ({ playerName, text }) => {
  const msg = `💬 "${text}" — ${playerName}`;
  ['#last-words-display-night','#last-words-display-vote'].forEach(sel => { const el=$(sel); if(el){el.textContent=msg;el.classList.remove('hidden');} });
  showToast(`${playerName}: "${text.substring(0,40)}"`, 'info');
  if (typeof playSound === 'function') playSound('notification');
});

/* ── Day / Vote ── */
function renderAliveList(sel, players) {
  const list = $(sel); list.innerHTML = '';
  players.forEach((p,i) => {
    const li = document.createElement('li'); li.className = 'player-card';
    const color = playerColors[p.id] || p.color || '#6c757d';
    li.innerHTML = `<div class="player-avatar">${AVATARS[i%AVATARS.length]}</div><div class="player-name" style="color:${color}">${p.name}</div>${p.id===mySocketId?'<div><span class="tag tag-you">YOU</span></div>':''}`;
    list.appendChild(li);
  });
}

$('#btn-move-to-vote').addEventListener('click', () => socket.emit('move-to-vote'));

function renderVoteTargets(players) {
  const list = $('#vote-targets'); list.innerHTML = '';
  if (!myAlive) { list.innerHTML = '<li><p class="info-text">You are eliminated and cannot vote.</p></li>'; return; }
  players.forEach((p,i) => {
    if (p.id === mySocketId) return;
    const li = document.createElement('li');
    const color = playerColors[p.id] || p.color || '#6c757d';
    li.innerHTML = `<button class="target-btn" data-target-id="${p.id}"><div class="target-avatar-small">${AVATARS[i%AVATARS.length]}</div><span style="color:${color}">${p.name}</span></button>`;
    const btn = li.querySelector('button');
    btn.addEventListener('click', () => { socket.emit('cast-vote',{targetId:p.id}); $$('#vote-targets .target-btn').forEach(b=>b.disabled=true); btn.classList.add('selected-danger'); $('#vote-submitted').classList.remove('hidden'); stopTimer('timer-fill-vote'); });
    list.appendChild(li);
  });
}

socket.on('vote-progress', ({ message }) => { if ($('#vote-progress')) $('#vote-progress').textContent = message; if ($('#vote-progress-revote')) $('#vote-progress-revote').textContent = message; });

socket.on('vote-result', ({ eliminated, tally, tie, message }) => {
  showScreen('voteResult');
  $('#vote-result-message').textContent = message;
  $('#last-words-display-vote').classList.add('hidden');
  const tallyDiv = $('#vote-tally'); tallyDiv.innerHTML = '';
  const maxV = Math.max(...Object.values(tally),1);
  for (const [name,count] of Object.entries(tally).sort((a,b)=>b[1]-a[1])) {
    const row = document.createElement('div'); row.className = 'tally-row';
    row.innerHTML = `<div class="tally-name">${name}</div><div class="tally-bar-wrap"><div class="tally-bar" style="width:${(count/maxV)*100}%"></div></div><div class="tally-count">${count}</div>`;
    tallyDiv.appendChild(row);
  }
  if (eliminated) { $('#vote-victim-info').classList.remove('hidden'); $('#vote-victim-name').textContent=eliminated.name; $('#vote-victim-role').textContent=eliminated.role; if(eliminated.id===mySocketId){myAlive=false;showToast('You were voted out!','error');} }
  else { $('#vote-victim-info').classList.add('hidden'); }
});

/* ── Defense ── */
socket.on('defense-phase', ({ accusedId, accusedName, tally, timeLimit }) => {
  showScreen('defense');
  $('#defense-accused-name').textContent = accusedName;
  startTimer('timer-fill-defense','timer-label-defense', timeLimit||30);
  if (accusedId === mySocketId) { $('#defense-input-area').classList.remove('hidden'); $('#defense-waiting-area').classList.add('hidden'); }
  else { $('#defense-input-area').classList.add('hidden'); $('#defense-waiting-area').classList.remove('hidden'); }
});

$('#btn-submit-defense').addEventListener('click', () => {
  const text = $('#defense-textarea').value.trim();
  socket.emit('submit-defense', { text });
  stopTimer('timer-fill-defense');
  $('#defense-input-area').innerHTML = '<p style="color:var(--success);font-weight:700">Defense submitted! Waiting for re-vote...</p>';
});

/* ── Re-vote ── */
socket.on('revote-phase', ({ accusedId, accusedName, defenseText, timeLimit, alivePlayers }) => {
  showScreen('revote');
  $('#revote-accused-label').textContent = `Should ${accusedName} be eliminated?`;
  startTimer('timer-fill-revote','timer-label-revote', timeLimit||15);
  if (defenseText) { $('#revote-defense-text').textContent=`"${defenseText}"`; $('#revote-defense-text').classList.remove('hidden'); } else { $('#revote-defense-text').classList.add('hidden'); }
  $('#revote-submitted').classList.add('hidden'); $('#revote-accused-wait').classList.add('hidden'); $('#revote-btns').classList.remove('hidden');
  if (accusedId === mySocketId || !myAlive) { $('#revote-btns').classList.add('hidden'); $('#revote-accused-wait').classList.remove('hidden'); }
});

$('#btn-revote-yes').addEventListener('click', () => { socket.emit('cast-revote',{vote:'yes'}); $$('.revote-btn').forEach(b=>b.disabled=true); $('#revote-submitted').classList.remove('hidden'); stopTimer('timer-fill-revote'); });
$('#btn-revote-no').addEventListener('click', () => { socket.emit('cast-revote',{vote:'no'}); $$('.revote-btn').forEach(b=>b.disabled=true); $('#revote-submitted').classList.remove('hidden'); stopTimer('timer-fill-revote'); });

/* ── Game Over ── */
socket.on('game-over', ({ winner, players, message, gameLog }) => {
  showScreen('gameover');
  $('#gameover-title').textContent = winner==='Citizens'?'Citizens Win!':'Mafia Wins!';
  $('#gameover-emoji').textContent = winner==='Citizens'?'🎉':'🔪';
  $('#gameover-message').textContent = message;
  $('#gameover-badge').className='phase-badge';
  $('#gameover-badge').style.backgroundColor = winner==='Citizens'?'var(--success-bg)':'var(--danger-bg)';
  $('#gameover-badge').style.color = winner==='Citizens'?'var(--success)':'var(--danger)';
  const list=$('#gameover-players'); list.innerHTML='';
  players.forEach((p,i)=>{ const li=document.createElement('li'); li.className=`player-card ${!p.alive?'eliminated':''}`; const color=playerColors[p.id]||'#6c757d';
    li.innerHTML=`<div class="player-avatar">${AVATARS[i%AVATARS.length]}</div><div class="player-name" style="color:${color}">${p.name}</div><div><span class="tag" style="background:${getRoleColor(p.role,0.1)};color:${getRoleColor(p.role,1)}">${p.role}</span>${!p.alive?'<span class="tag" style="background:var(--border);color:var(--text-secondary);margin-left:4px">DEAD</span>':''}</div>`; list.appendChild(li); });
  if (gameLog&&gameLog.length) { $('#btn-game-log').classList.remove('hidden'); $('#log-entries').innerHTML=''; gameLog.forEach(e=>addToGameLog(e)); }
  const myP=players.find(p=>p.id===mySocketId);
  if(myP){ const won=(winner==='Citizens'&&myP.role!=='Mafia')||(winner==='Mafia'&&myP.role==='Mafia'); recordGame(won); }
  if (isHost) { $('#btn-play-again').classList.remove('hidden'); $('#play-again-note').classList.add('hidden'); }
  else { $('#btn-play-again').classList.add('hidden'); $('#play-again-note').classList.remove('hidden'); }
});

$('#btn-play-again').addEventListener('click', () => socket.emit('play-again'));
$('#btn-back-lobby').addEventListener('click', () => { localStorage.removeItem('mafia-session-token'); socket.emit('return-to-lobby'); });

socket.on('returned-to-lobby', () => {
  isHost=false; myRole=null; myRoomCode=null; myAlive=true; playerColors={};
  localStorage.removeItem('mafia-session-token');
  $('#chat-sidebar').classList.add('hidden'); $('#btn-game-log').classList.add('hidden'); $('#game-log-panel').classList.add('hidden');
  $('#chat-messages').innerHTML='<div style="text-align:center;color:var(--text-muted);font-size:0.85rem;margin-top:20px">Welcome to the chat!</div>';
  showScreen('landing'); renderStats();
});

socket.on('back-to-waiting', ({ roomCode, players, hostId }) => {
  myRoomCode=roomCode; isHost=(mySocketId===hostId); myRole=null; myAlive=true; playerColors={};
  $('#btn-game-log').classList.add('hidden'); $('#game-log-panel').classList.add('hidden');
  showToast('New game! Waiting room is open.','success'); enterWaiting(roomCode, players);
});

/* ── Reconnection ── */
socket.on('reconnect-success', (state) => {
  myRoomCode=state.roomCode; isHost=state.isHost; myRole=state.role; myAlive=state.alive; playerColors={};
  if(state.players) state.players.forEach(p=>{ if(p.color) playerColors[p.id]=p.color; });
  showToast('Reconnected!','success'); $('#chat-sidebar').classList.remove('hidden');
  if(state.phase==='lobby') enterWaiting(state.roomCode,state.players);
  else if(state.phase==='roles'&&state.roleInfo){ showScreen('role'); const t=state.roleInfo.team; $('#role-card-container').className=`role-card-large ${t==='mafia'?'mafia':'citizen'}`; $('#role-emoji').textContent=state.roleInfo.emoji; $('#role-name').textContent=state.role; $('#role-name').className=`role-name-large ${t==='mafia'?'role-mafia':'role-citizen'}`; $('#role-desc').textContent=state.roleInfo.description; $('#role-instruction-box').className=`instruction-box ${t==='mafia'?'mafia':'citizen'}`; $('#role-instruction-text').textContent=state.roleInfo.instruction; }
  else if(state.phase==='night'){ showScreen('night'); $('#night-round').textContent=state.round; $('#night-message').textContent='Rejoining...'; $('#night-waiting').classList.remove('hidden'); }
  else if(state.phase==='day'){ showScreen('day'); $('#day-round').textContent=state.round; renderAliveList('#day-alive-list',state.alivePlayers); if(isHost){$('#day-host-controls').classList.remove('hidden');$('#day-waiting-note').classList.add('hidden');} }
  else if(state.phase==='vote'){ showScreen('vote'); renderVoteTargets(state.alivePlayers); }
  else if(state.phase==='gameover'){ showScreen('gameover'); if(isHost) $('#btn-play-again').classList.remove('hidden'); }
  else showScreen('landing');
});
socket.on('reconnect-failed', () => localStorage.removeItem('mafia-session-token'));

/* ── Chat ── */
$('#chat-form').addEventListener('submit', e => {
  e.preventDefault();
  const input=$('#chat-input'); const msg=input.value.trim(); if(!msg) return;
  socket.emit('send-chat-message',{message:msg}); input.value='';
});
socket.on('chat-message', ({ senderId, senderName, message, isAlive, color }) => {
  const isMe=senderId===mySocketId; const list=$('#chat-messages');
  const div=document.createElement('div'); div.className=`chat-msg ${isMe?'my-msg':''}`;
  const sc=isMe?'rgba(255,255,255,0.8)':(color||'var(--text-secondary)');
  div.innerHTML=`<div class="chat-sender" style="color:${sc}">${senderName}${!isAlive?' <span style="opacity:0.6;font-size:0.7rem">(DEAD)</span>':''}</div><div>${message.replace(/</g,'&lt;')}</div>`;
  list.appendChild(div); list.scrollTop=list.scrollHeight;
  if(!isMe&&typeof playSound==='function') playSound('notification');
});

/* ── Mafia Private Chat ── */
['','night'].forEach(suffix => {
  const form=$(`#mafia-chat-form${suffix?'-'+suffix:''}`); if(!form) return;
  form.addEventListener('submit', e=>{ e.preventDefault(); const inp=$(`#mafia-chat-input${suffix?'-'+suffix:''}`); const msg=inp.value.trim(); if(!msg) return; socket.emit('mafia-chat',{message:msg}); inp.value=''; });
});
socket.on('mafia-chat-message', ({ senderId, senderName, message, color }) => {
  ['mafia-chat-messages','mafia-chat-messages-night'].forEach(id=>{ const c=$(`#${id}`); if(!c) return; const d=document.createElement('div'); d.className='mafia-chat-msg'; d.innerHTML=`<span style="color:${color||'var(--danger)'};font-weight:700">${senderName}:</span> ${message.replace(/</g,'&lt;')}`; c.appendChild(d); c.scrollTop=c.scrollHeight; });
});
