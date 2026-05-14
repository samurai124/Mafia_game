/**
 * gameManager.js
 * ──────────────
 * Manages all in-memory game state.
 * Each room is stored in a Map keyed by its short room code.
 */

const rooms = new Map();
const sessions = new Map();          // token → { roomCode, socketId, playerName }
const disconnectTimers = new Map();  // token → setTimeout id

/* ── helpers ─────────────────────────────────────────────── */

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? generateRoomCode() : code;
}

function generateToken() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  for (let i = 0; i < 32; i++) token += chars[Math.floor(Math.random() * chars.length)];
  return token;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ── player colors ───────────────────────────────────────── */

const PLAYER_COLORS = [
  '#e74c3c', '#3498db', '#2ecc71', '#f39c12',
  '#9b59b6', '#1abc9c', '#e67e22', '#e91e63',
  '#00bcd4', '#8bc34a', '#ff5722', '#607d8b'
];

/* ── role descriptions ───────────────────────────────────── */

const ROLE_INFO = {
  Mafia: {
    emoji: '🔪',
    description: 'You are part of the Mafia. Each night you choose a player to eliminate.',
    instruction: 'During the night phase, secretly pick a target with your fellow Mafia members.',
    team: 'mafia'
  },
  Doctor: {
    emoji: '💉',
    description: 'You are the Doctor. Each night you can protect one player from elimination.',
    instruction: 'During the night phase, choose one player to save. You may save yourself.',
    team: 'citizen'
  },
  Cheikh: {
    emoji: '🔍',
    description: 'You are the Cheikh (Investigator). Each night you can investigate one player\'s allegiance.',
    instruction: 'During the night phase, choose a player to investigate. You will learn if they are Mafia or not.',
    team: 'citizen'
  },
  Citizen: {
    emoji: '🏘️',
    description: 'You are a Citizen. You have no special power, but your vote is your weapon.',
    instruction: 'Stay alert during discussions and vote wisely to eliminate the Mafia.',
    team: 'citizen'
  }
};

/* ── default game settings ───────────────────────────────── */

const DEFAULT_SETTINGS = {
  discussionTime: 120,   // seconds
  votingTime: 30,
  defenseTime: 30,
  nightActionTime: 30,
  revoteTime: 15,
  lastWordsTime: 15,
  enableDefense: true,
  enableLastWords: true,
  enableCheikh: true
};

/* ── room CRUD ───────────────────────────────────────────── */

function createRoom(hostSocketId, hostName) {
  const code = generateRoomCode();
  const token = generateToken();
  const room = {
    code,
    hostId: hostSocketId,
    phase: 'lobby',
    nightStep: null,
    round: 0,
    players: new Map(),
    nightActions: {},
    eliminatedTonight: null,
    votes: {},
    winner: null,
    mafiaChat: [],
    gameLog: [],
    settings: { ...DEFAULT_SETTINGS },
    timers: {},              // active server-side timers
    accusedId: null,         // player being defended in defense phase
    defenseText: '',         // the accused's defense message
    colorIndex: 0            // tracks next color to assign
  };
  room.players.set(hostSocketId, {
    name: hostName, role: null, alive: true, voted: false,
    token, color: PLAYER_COLORS[0]
  });
  room.colorIndex = 1;
  sessions.set(token, { roomCode: code, socketId: hostSocketId, playerName: hostName });
  rooms.set(code, room);
  return { room, token };
}

function getRoom(code) {
  return rooms.get(code) || null;
}

function getRoomBySocket(socketId) {
  for (const [, room] of rooms) {
    if (room.players.has(socketId)) return room;
  }
  return null;
}

function addPlayer(code, socketId, name) {
  const room = rooms.get(code);
  if (!room) return null;
  if (room.phase !== 'lobby') return null;
  for (const [, p] of room.players) {
    if (p.name.toLowerCase() === name.toLowerCase()) return null;
  }
  const token = generateToken();
  const color = PLAYER_COLORS[room.colorIndex % PLAYER_COLORS.length];
  room.colorIndex++;
  room.players.set(socketId, { name, role: null, alive: true, voted: false, token, color });
  sessions.set(token, { roomCode: code, socketId, playerName: name });
  return { room, token };
}

function removePlayer(socketId) {
  const room = getRoomBySocket(socketId);
  if (!room) return null;
  const player = room.players.get(socketId);
  if (player && player.token) {
    sessions.delete(player.token);
  }
  room.players.delete(socketId);
  if (socketId === room.hostId && room.players.size > 0) {
    room.hostId = room.players.keys().next().value;
  }
  if (room.players.size === 0) {
    clearRoomTimers(room);
    rooms.delete(room.code);
    return null;
  }
  return room;
}

function kickPlayer(room, targetId) {
  const player = room.players.get(targetId);
  if (!player) return null;
  if (player.token) sessions.delete(player.token);
  room.players.delete(targetId);
  return player;
}

/* ── reconnection ────────────────────────────────────────── */

function getSession(token) {
  return sessions.get(token) || null;
}

function reconnectPlayer(token, newSocketId) {
  const session = sessions.get(token);
  if (!session) return null;
  const room = rooms.get(session.roomCode);
  if (!room) { sessions.delete(token); return null; }
  const oldSocketId = session.socketId;
  const playerData = room.players.get(oldSocketId);
  if (!playerData) { sessions.delete(token); return null; }

  room.players.delete(oldSocketId);
  room.players.set(newSocketId, playerData);
  if (room.hostId === oldSocketId) room.hostId = newSocketId;
  if (room.votes) {
    if (room.votes[oldSocketId]) {
      room.votes[newSocketId] = room.votes[oldSocketId];
      delete room.votes[oldSocketId];
    }
  }
  if (room.accusedId === oldSocketId) room.accusedId = newSocketId;
  session.socketId = newSocketId;

  if (disconnectTimers.has(token)) {
    clearTimeout(disconnectTimers.get(token));
    disconnectTimers.delete(token);
  }
  return room;
}

function setDisconnectTimer(token, callback, delayMs = 30000) {
  if (disconnectTimers.has(token)) clearTimeout(disconnectTimers.get(token));
  const timer = setTimeout(() => { disconnectTimers.delete(token); callback(); }, delayMs);
  disconnectTimers.set(token, timer);
}

function cancelDisconnectTimer(token) {
  if (disconnectTimers.has(token)) {
    clearTimeout(disconnectTimers.get(token));
    disconnectTimers.delete(token);
  }
}

function getTokenBySocket(socketId) {
  const room = getRoomBySocket(socketId);
  if (!room) return null;
  const player = room.players.get(socketId);
  return player ? player.token : null;
}

function getReconnectState(room, socketId) {
  const player = room.players.get(socketId);
  if (!player) return null;
  const alivePlayers = getAlivePlayers(room);
  const roleInfo = player.role ? ROLE_INFO[player.role] : null;
  return {
    phase: room.phase,
    round: room.round,
    roomCode: room.code,
    isHost: room.hostId === socketId,
    role: player.role,
    roleInfo,
    alive: player.alive,
    nightStep: room.nightStep,
    alivePlayers: alivePlayers.map(p => ({ id: p.id, name: p.name })),
    players: [...room.players.entries()].map(([id, p]) => ({ id, name: p.name, color: p.color })),
    winner: room.winner,
    gameLog: room.gameLog,
    settings: room.settings
  };
}

/* ── game log ────────────────────────────────────────────── */

function addLogEntry(room, entry) {
  const timestamp = `Night ${room.round}`;
  if (room.phase === 'day' || room.phase === 'vote' || room.phase === 'defense' || room.phase === 'revote') {
    entry.timestamp = `Day ${room.round}`;
  } else {
    entry.timestamp = timestamp;
  }
  room.gameLog.push(entry);
}

/* ── room timers ─────────────────────────────────────────── */

function setRoomTimer(room, name, callback, delayMs) {
  clearRoomTimer(room, name);
  room.timers[name] = setTimeout(() => {
    delete room.timers[name];
    callback();
  }, delayMs);
}

function clearRoomTimer(room, name) {
  if (room.timers[name]) {
    clearTimeout(room.timers[name]);
    delete room.timers[name];
  }
}

function clearRoomTimers(room) {
  for (const name of Object.keys(room.timers)) {
    clearTimeout(room.timers[name]);
  }
  room.timers = {};
}

/* ── role assignment ─────────────────────────────────────── */

function assignRoles(code) {
  const room = rooms.get(code);
  if (!room) return null;
  const playerIds = [...room.players.keys()];
  const count = playerIds.length;
  if (count < 4) return null;

  const mafiaCount = count >= 7 ? 2 : 1;
  const roles = [];
  for (let i = 0; i < mafiaCount; i++) roles.push('Mafia');
  roles.push('Doctor');
  if (room.settings.enableCheikh) roles.push('Cheikh');
  while (roles.length < count) roles.push('Citizen');
  shuffle(roles);

  playerIds.forEach((id, i) => {
    room.players.get(id).role = roles[i];
  });
  room.phase = 'roles';
  return room;
}

/* ── game state queries ──────────────────────────────────── */

function getAlivePlayers(room) {
  const alive = [];
  for (const [id, p] of room.players) {
    if (p.alive) alive.push({ id, name: p.name, role: p.role, color: p.color });
  }
  return alive;
}

function getPlayersByRole(room, role) {
  const result = [];
  for (const [id, p] of room.players) {
    if (p.role === role && p.alive) result.push({ id, name: p.name });
  }
  return result;
}

function getAllPlayers(room) {
  const list = [];
  for (const [id, p] of room.players) {
    list.push({ id, name: p.name, role: p.role, alive: p.alive, color: p.color });
  }
  return list;
}

function getPlayerColors(room) {
  const colors = {};
  for (const [id, p] of room.players) {
    colors[id] = p.color;
  }
  return colors;
}

/* ── night actions ───────────────────────────────────────── */

function setNightAction(room, actionType, targetId) {
  room.nightActions[actionType] = targetId;
}

function resolveNight(room) {
  const { mafiaTarget, doctorTarget } = room.nightActions;
  let result = { saved: false, victim: null, victimName: null, victimRole: null };

  if (mafiaTarget === doctorTarget) {
    result.saved = true;
    addLogEntry(room, { type: 'save', text: 'The Doctor saved someone tonight.' });
  } else if (mafiaTarget) {
    const victim = room.players.get(mafiaTarget);
    if (victim && victim.alive) {
      victim.alive = false;
      result.victim = mafiaTarget;
      result.victimName = victim.name;
      result.victimRole = victim.role;
      addLogEntry(room, { type: 'kill', text: `${victim.name} was killed. They were a ${victim.role}.` });
    }
  } else {
    addLogEntry(room, { type: 'safe', text: 'No one was targeted last night.' });
  }

  room.nightActions = {};
  room.eliminatedTonight = result;
  return result;
}

/* ── voting ──────────────────────────────────────────────── */

function castVote(room, voterId, targetId) {
  room.votes[voterId] = targetId;
}

function tallyVotes(room) {
  const tally = {};
  for (const [, targetId] of Object.entries(room.votes)) {
    tally[targetId] = (tally[targetId] || 0) + 1;
  }

  let maxVotes = 0;
  let maxTargets = [];
  for (const [targetId, count] of Object.entries(tally)) {
    if (count > maxVotes) { maxVotes = count; maxTargets = [targetId]; }
    else if (count === maxVotes) maxTargets.push(targetId);
  }

  const tallySummary = {};
  for (const [targetId, count] of Object.entries(tally)) {
    const p = room.players.get(targetId);
    if (p) tallySummary[p.name] = count;
  }

  room.votes = {};
  for (const [, p] of room.players) p.voted = false;

  if (maxTargets.length === 1) {
    return { accusedId: maxTargets[0], tally: tallySummary, tie: false };
  }
  return { accusedId: null, tally: tallySummary, tie: maxTargets.length > 1 };
}

function eliminatePlayer(room, playerId) {
  const target = room.players.get(playerId);
  if (target && target.alive) {
    target.alive = false;
    addLogEntry(room, { type: 'vote_kill', text: `${target.name} was voted out. They were a ${target.role}.` });
    return { id: playerId, name: target.name, role: target.role };
  }
  return null;
}

/* ── win condition ───────────────────────────────────────── */

function checkWinCondition(room) {
  let mafiaAlive = 0;
  let citizenAlive = 0;
  for (const [, p] of room.players) {
    if (!p.alive) continue;
    if (p.role === 'Mafia') mafiaAlive++;
    else citizenAlive++;
  }
  if (mafiaAlive === 0) { room.winner = 'Citizens'; room.phase = 'gameover'; return 'Citizens'; }
  if (mafiaAlive >= citizenAlive) { room.winner = 'Mafia'; room.phase = 'gameover'; return 'Mafia'; }
  return null;
}

/* ── cleanup ─────────────────────────────────────────────── */

function deleteRoom(code) {
  const room = rooms.get(code);
  if (room) clearRoomTimers(room);
  rooms.delete(code);
}

module.exports = {
  ROLE_INFO, PLAYER_COLORS, DEFAULT_SETTINGS,
  createRoom, getRoom, getRoomBySocket, addPlayer, removePlayer, kickPlayer,
  assignRoles, getAlivePlayers, getPlayersByRole, getAllPlayers, getPlayerColors,
  setNightAction, resolveNight,
  castVote, tallyVotes, eliminatePlayer,
  checkWinCondition, deleteRoom,
  addLogEntry, setRoomTimer, clearRoomTimer, clearRoomTimers,
  getSession, reconnectPlayer, setDisconnectTimer, cancelDisconnectTimer,
  getTokenBySocket, getReconnectState
};
