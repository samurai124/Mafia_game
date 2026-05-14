/**
 * gameManager.js
 * ──────────────
 * Manages all in-memory game state.
 * Each room is stored in a Map keyed by its short room code.
 */

const rooms = new Map();

/* ── helpers ─────────────────────────────────────────────── */

/** Generate a short alphanumeric room code (6 chars). */
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? generateRoomCode() : code;
}

/** Fisher-Yates shuffle (in-place). */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

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

/* ── room CRUD ───────────────────────────────────────────── */

function createRoom(hostSocketId, hostName) {
  const code = generateRoomCode();
  const room = {
    code,
    hostId: hostSocketId,
    phase: 'lobby',          // lobby | roles | night | day | vote | gameover
    nightStep: null,         // mafia | doctor | cheikh | resolve
    round: 0,
    players: new Map(),      // socketId → { name, role, alive, voted }
    nightActions: {},        // { mafiaTarget, doctorTarget, cheikhTarget }
    eliminatedTonight: null,
    votes: {},               // socketId → targetSocketId
    winner: null,
    mafiaChat: []            // optional: mafia night chat
  };
  // Add host as first player
  room.players.set(hostSocketId, { name: hostName, role: null, alive: true, voted: false });
  rooms.set(code, room);
  return room;
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
  // Check for duplicate name
  for (const [, p] of room.players) {
    if (p.name.toLowerCase() === name.toLowerCase()) return null;
  }
  room.players.set(socketId, { name, role: null, alive: true, voted: false });
  return room;
}

function removePlayer(socketId) {
  const room = getRoomBySocket(socketId);
  if (!room) return null;
  room.players.delete(socketId);
  // If host left and there are still players, assign new host
  if (socketId === room.hostId && room.players.size > 0) {
    room.hostId = room.players.keys().next().value;
  }
  // If room is empty, delete it
  if (room.players.size === 0) {
    rooms.delete(room.code);
    return null;
  }
  return room;
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
  roles.push('Cheikh');
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
    if (p.alive) alive.push({ id, name: p.name, role: p.role });
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
    list.push({ id, name: p.name, role: p.role, alive: p.alive });
  }
  return list;
}

/* ── night actions ───────────────────────────────────────── */

function setNightAction(room, actionType, targetId) {
  room.nightActions[actionType] = targetId;
}

function resolveNight(room) {
  const { mafiaTarget, doctorTarget } = room.nightActions;
  let result = { saved: false, victim: null, victimName: null, victimRole: null };

  if (mafiaTarget === doctorTarget) {
    // Doctor saved the target
    result.saved = true;
  } else if (mafiaTarget) {
    const victim = room.players.get(mafiaTarget);
    if (victim && victim.alive) {
      victim.alive = false;
      result.victim = mafiaTarget;
      result.victimName = victim.name;
      result.victimRole = victim.role;
    }
  }

  // Reset night actions for next round
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

  // Find max votes
  let maxVotes = 0;
  let maxTargets = [];
  for (const [targetId, count] of Object.entries(tally)) {
    if (count > maxVotes) {
      maxVotes = count;
      maxTargets = [targetId];
    } else if (count === maxVotes) {
      maxTargets.push(targetId);
    }
  }

  let eliminated = null;
  if (maxTargets.length === 1) {
    // Clear majority — eliminate
    const target = room.players.get(maxTargets[0]);
    if (target && target.alive) {
      target.alive = false;
      eliminated = {
        id: maxTargets[0],
        name: target.name,
        role: target.role
      };
    }
  }
  // Tie → no elimination

  // Build tally summary for display
  const tallySummary = {};
  for (const [targetId, count] of Object.entries(tally)) {
    const p = room.players.get(targetId);
    if (p) tallySummary[p.name] = count;
  }

  // Reset votes
  room.votes = {};
  for (const [, p] of room.players) p.voted = false;

  return { eliminated, tally: tallySummary, tie: maxTargets.length > 1 };
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

  if (mafiaAlive === 0) {
    room.winner = 'Citizens';
    room.phase = 'gameover';
    return 'Citizens';
  }
  if (mafiaAlive >= citizenAlive) {
    room.winner = 'Mafia';
    room.phase = 'gameover';
    return 'Mafia';
  }
  return null;
}

/* ── cleanup ─────────────────────────────────────────────── */

function deleteRoom(code) {
  rooms.delete(code);
}

module.exports = {
  ROLE_INFO,
  createRoom,
  getRoom,
  getRoomBySocket,
  addPlayer,
  removePlayer,
  assignRoles,
  getAlivePlayers,
  getPlayersByRole,
  getAllPlayers,
  setNightAction,
  resolveNight,
  castVote,
  tallyVotes,
  checkWinCondition,
  deleteRoom
};
