/**
 * index.js — Express + Socket.io entry point for the Mafia party game.
 */
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const gm = require('./gameManager');
const nightPhase = require('./phases/night');
const dayPhase = require('./phases/day');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

/* ── Express config ──────────────────────────────────────── */

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/', (req, res) => {
  res.render('lobby');
});

/* ── Socket.io ───────────────────────────────────────────── */

io.on('connection', (socket) => {
  console.log(`[+] Player connected: ${socket.id}`);

  /* ─── Create Room ─── */
  socket.on('create-room', ({ playerName }) => {
    const { room, token } = gm.createRoom(socket.id, playerName);
    socket.join(room.code);
    console.log(`[ROOM] ${playerName} created room ${room.code}`);
    socket.emit('room-created', {
      roomCode: room.code, isHost: true,
      players: [{ id: socket.id, name: playerName, color: room.players.get(socket.id).color }],
      sessionToken: token, settings: room.settings
    });
  });

  /* ─── Join Room ─── */
  socket.on('join-room', ({ roomCode, playerName }) => {
    const code = roomCode.toUpperCase().trim();
    const room = gm.getRoom(code);
    if (!room) return socket.emit('join-error', { message: 'Room not found.' });
    if (room.phase !== 'lobby') return socket.emit('join-error', { message: 'Game already in progress.' });

    const result = gm.addPlayer(code, socket.id, playerName);
    if (!result) return socket.emit('join-error', { message: 'Could not join. Name may already be taken.' });

    socket.join(code);
    console.log(`[ROOM] ${playerName} joined room ${code}`);

    const players = [];
    for (const [id, p] of room.players) players.push({ id, name: p.name, color: p.color });

    socket.emit('room-joined', {
      roomCode: code, isHost: socket.id === room.hostId,
      players, sessionToken: result.token, settings: room.settings
    });
    io.to(code).emit('player-list-update', { players, hostId: room.hostId });
  });

  /* ─── Reconnection ─── */
  socket.on('attempt-reconnect', ({ token }) => {
    if (!token) return;
    const session = gm.getSession(token);
    if (!session) return socket.emit('reconnect-failed');

    const room = gm.reconnectPlayer(token, socket.id);
    if (!room) return socket.emit('reconnect-failed');

    socket.join(room.code);
    const player = room.players.get(socket.id);
    if (player && player.role) {
      if (player.role === 'Mafia') socket.join(room.code + '-mafia');
      if (player.role === 'Doctor') socket.join(room.code + '-doctor');
      if (player.role === 'Cheikh') socket.join(room.code + '-cheikh');
    }
    console.log(`[RECONNECT] ${session.playerName} reconnected to room ${room.code}`);

    const state = gm.getReconnectState(room, socket.id);
    socket.emit('reconnect-success', state);
    io.to(room.code).emit('player-reconnected', { name: session.playerName });

    const players = [];
    for (const [id, p] of room.players) players.push({ id, name: p.name, color: p.color });
    io.to(room.code).emit('player-list-update', { players, hostId: room.hostId });
  });

  /* ─── Chat ─── */
  socket.on('send-chat-message', (data) => {
    const room = gm.getRoomBySocket(socket.id);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    io.to(room.code).emit('chat-message', {
      senderId: socket.id, senderName: player.name,
      message: data.message, isAlive: player.alive, color: player.color
    });
  });

  /* ─── Mafia Night Chat ─── */
  socket.on('mafia-chat', (data) => {
    const room = gm.getRoomBySocket(socket.id);
    if (!room || room.phase !== 'night') return;
    const player = room.players.get(socket.id);
    if (!player || player.role !== 'Mafia' || !player.alive) return;
    io.to(room.code + '-mafia').emit('mafia-chat-message', {
      senderId: socket.id, senderName: player.name,
      message: data.message, color: player.color
    });
  });

  /* ─── Game Settings (host only) ─── */
  socket.on('update-settings', (settings) => {
    const room = gm.getRoomBySocket(socket.id);
    if (!room || socket.id !== room.hostId || room.phase !== 'lobby') return;
    Object.assign(room.settings, settings);
    io.to(room.code).emit('settings-updated', room.settings);
  });

  /* ─── Kick Player (host only, lobby only) ─── */
  socket.on('kick-player', ({ targetId }) => {
    const room = gm.getRoomBySocket(socket.id);
    if (!room || socket.id !== room.hostId || room.phase !== 'lobby') return;
    if (targetId === socket.id) return; // can't kick yourself

    const kicked = gm.kickPlayer(room, targetId);
    if (!kicked) return;

    console.log(`[KICK] ${kicked.name} was kicked from room ${room.code}`);
    io.to(targetId).emit('kicked', { message: 'You have been kicked from the room.' });
    const targetSocket = io.sockets.sockets.get(targetId);
    if (targetSocket) targetSocket.leave(room.code);

    const players = [];
    for (const [id, p] of room.players) players.push({ id, name: p.name, color: p.color });
    io.to(room.code).emit('player-list-update', { players, hostId: room.hostId });
    io.to(room.code).emit('player-disconnected', {
      name: kicked.name, message: `${kicked.name} was kicked by the host.`
    });
  });

  /* ─── Start Game ─── */
  socket.on('start-game', () => {
    const room = gm.getRoomBySocket(socket.id);
    if (!room || socket.id !== room.hostId) return;
    if (room.players.size < 4) {
      return socket.emit('start-error', { message: 'Need at least 4 players to start.' });
    }

    gm.assignRoles(room.code);
    console.log(`[GAME] Game started in room ${room.code} with ${room.players.size} players`);

    for (const [id, p] of room.players) {
      if (p.role === 'Mafia') socket.server.sockets.sockets.get(id)?.join(room.code + '-mafia');
      if (p.role === 'Doctor') socket.server.sockets.sockets.get(id)?.join(room.code + '-doctor');
      if (p.role === 'Cheikh') socket.server.sockets.sockets.get(id)?.join(room.code + '-cheikh');
    }

    const playerColors = gm.getPlayerColors(room);
    for (const [id, p] of room.players) {
      const roleInfo = gm.ROLE_INFO[p.role];
      io.to(id).emit('role-assigned', {
        role: p.role, emoji: roleInfo.emoji,
        description: roleInfo.description, instruction: roleInfo.instruction,
        team: roleInfo.team, playerColors
      });
    }

    io.to(room.code).emit('sound', { type: 'gamestart' });
    gm.addLogEntry(room, { type: 'start', text: `Game started with ${room.players.size} players.` });

    setTimeout(() => nightPhase.startNight(io, room), 8000);
  });

  /* ─── Night Action ─── */
  socket.on('night-action', ({ targetId }) => {
    const room = gm.getRoomBySocket(socket.id);
    if (!room || room.phase !== 'night') return;
    const player = room.players.get(socket.id);
    if (!player || !player.alive) return;
    const expectedRole = room.nightStep.charAt(0).toUpperCase() + room.nightStep.slice(1);
    if (player.role !== expectedRole) return;
    console.log(`[NIGHT] ${player.name} (${player.role}) targets ${targetId} in room ${room.code}`);
    nightPhase.handleNightAction(io, room, room.nightStep, targetId);
  });

  /* ─── Day: Move to Vote ─── */
  socket.on('move-to-vote', () => {
    const room = gm.getRoomBySocket(socket.id);
    if (!room || room.phase !== 'day' || socket.id !== room.hostId) return;
    dayPhase.startVote(io, room);
  });

  /* ─── Vote ─── */
  socket.on('cast-vote', ({ targetId }) => {
    const room = gm.getRoomBySocket(socket.id);
    if (!room || room.phase !== 'vote') return;
    const player = room.players.get(socket.id);
    if (!player || !player.alive || player.voted) return;
    console.log(`[VOTE] ${player.name} votes for ${targetId} in room ${room.code}`);
    dayPhase.handleVote(io, room, socket.id, targetId);
  });

  /* ─── Defense Text ─── */
  socket.on('submit-defense', ({ text }) => {
    const room = gm.getRoomBySocket(socket.id);
    if (!room || room.phase !== 'defense') return;
    if (socket.id !== room.accusedId) return;
    room.defenseText = text || '';
    // Proceed to re-vote immediately after defense is submitted
    dayPhase.startRevote(io, room);
  });

  /* ─── Re-vote (yes/no) ─── */
  socket.on('cast-revote', ({ vote }) => {
    const room = gm.getRoomBySocket(socket.id);
    if (!room || room.phase !== 'revote') return;
    const player = room.players.get(socket.id);
    if (!player || !player.alive || player.voted) return;
    if (socket.id === room.accusedId) return; // accused can't vote
    dayPhase.handleRevote(io, room, socket.id, vote);
  });

  /* ─── Last Words ─── */
  socket.on('submit-last-words', ({ text }) => {
    const room = gm.getRoomBySocket(socket.id);
    if (!room) return;
    io.to(room.code).emit('last-words', { playerName: room.players.get(socket.id)?.name || 'Unknown', text });

    // Proceed based on current phase
    if (room.phase === 'vote' || room.phase === 'revote' || room.phase === 'gameover') {
      dayPhase.proceedAfterVote(io, room);
    } else {
      nightPhase.proceedAfterNight(io, room);
    }
  });

  /* ─── Return to Lobby ─── */
  socket.on('return-to-lobby', () => {
    const room = gm.getRoomBySocket(socket.id);
    if (!room) return;
    const player = room.players.get(socket.id);
    const token = player ? player.token : null;
    if (token) gm.cancelDisconnectTimer(token);

    socket.leave(room.code + '-mafia');
    socket.leave(room.code + '-doctor');
    socket.leave(room.code + '-cheikh');
    socket.leave(room.code);

    gm.removePlayer(socket.id);
    socket.emit('returned-to-lobby');

    if (room.players.size > 0) {
      const players = [];
      for (const [id, p] of room.players) players.push({ id, name: p.name, color: p.color });
      io.to(room.code).emit('player-list-update', { players, hostId: room.hostId });
    }
  });

  /* ─── Play Again ─── */
  socket.on('play-again', () => {
    const room = gm.getRoomBySocket(socket.id);
    if (!room || socket.id !== room.hostId || room.phase !== 'gameover') return;

    room.phase = 'lobby';
    room.round = 0;
    room.nightStep = null;
    room.nightActions = {};
    room.eliminatedTonight = null;
    room.votes = {};
    room.winner = null;
    room.mafiaChat = [];
    room.gameLog = [];
    room.accusedId = null;
    room.defenseText = '';
    gm.clearRoomTimers(room);

    for (const [id, p] of room.players) {
      p.role = null; p.alive = true; p.voted = false;
      const s = io.sockets.sockets.get(id);
      if (s) { s.leave(room.code + '-mafia'); s.leave(room.code + '-doctor'); s.leave(room.code + '-cheikh'); }
    }

    console.log(`[GAME] Room ${room.code} reset for new game`);
    const players = [];
    for (const [id, p] of room.players) players.push({ id, name: p.name, color: p.color });
    io.to(room.code).emit('back-to-waiting', { roomCode: room.code, players, hostId: room.hostId });
  });

  /* ─── Disconnect ─── */
  socket.on('disconnect', () => {
    console.log(`[-] Player disconnected: ${socket.id}`);
    const room = gm.getRoomBySocket(socket.id);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    const playerName = player.name;
    const token = player.token;

    if (room.phase === 'lobby') {
      const updatedRoom = gm.removePlayer(socket.id);
      if (updatedRoom) {
        const players = [];
        for (const [id, p] of updatedRoom.players) players.push({ id, name: p.name, color: p.color });
        io.to(updatedRoom.code).emit('player-list-update', { players, hostId: updatedRoom.hostId });
        io.to(updatedRoom.code).emit('player-disconnected', { name: playerName, message: `${playerName} has left.` });
      }
      return;
    }

    io.to(room.code).emit('player-disconnected', {
      name: playerName, message: `${playerName} lost connection… waiting 30s for reconnect.`
    });

    gm.setDisconnectTimer(token, () => {
      console.log(`[TIMEOUT] ${playerName} did not reconnect.`);
      const updatedRoom = gm.removePlayer(socket.id);
      if (updatedRoom) {
        const players = [];
        for (const [id, p] of updatedRoom.players) players.push({ id, name: p.name, color: p.color });
        io.to(updatedRoom.code).emit('player-list-update', { players, hostId: updatedRoom.hostId });
        io.to(updatedRoom.code).emit('player-disconnected', { name: playerName, message: `${playerName} has been removed (timed out).` });
      }
    }, 30000);
  });
});

/* ── Start server ────────────────────────────────────────── */

const PORT = process.env.PORT || 3002;
server.listen(PORT, () => {
  console.log(`\n🎭 Mafia Game Server running at http://localhost:${PORT}\n`);
});
