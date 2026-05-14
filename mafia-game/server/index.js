/**
 * index.js
 * ────────
 * Express + Socket.io entry point for the Mafia party game.
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

/* ── Routes (serve pages — all game logic goes through Socket.io) */

app.get('/', (req, res) => {
  res.render('lobby');
});

/* ── Socket.io event handling ────────────────────────────── */

io.on('connection', (socket) => {
  console.log(`[+] Player connected: ${socket.id}`);

  /* ─── LOBBY: Create Room ─── */
  socket.on('create-room', ({ playerName }) => {
    const room = gm.createRoom(socket.id, playerName);
    socket.join(room.code);
    console.log(`[ROOM] ${playerName} created room ${room.code}`);

    socket.emit('room-created', {
      roomCode: room.code,
      isHost: true,
      players: [{ id: socket.id, name: playerName }]
    });
  });

  /* ─── LOBBY: Join Room ─── */
  socket.on('join-room', ({ roomCode, playerName }) => {
    const code = roomCode.toUpperCase().trim();
    const room = gm.getRoom(code);

    if (!room) {
      socket.emit('join-error', { message: 'Room not found. Check the code and try again.' });
      return;
    }
    if (room.phase !== 'lobby') {
      socket.emit('join-error', { message: 'Game already in progress. Cannot join.' });
      return;
    }

    const updated = gm.addPlayer(code, socket.id, playerName);
    if (!updated) {
      socket.emit('join-error', { message: 'Could not join. Name may already be taken.' });
      return;
    }

    socket.join(code);
    console.log(`[ROOM] ${playerName} joined room ${code}`);

    // Build player list
    const players = [];
    for (const [id, p] of room.players) {
      players.push({ id, name: p.name });
    }

    // Notify joiner
    socket.emit('room-joined', {
      roomCode: code,
      isHost: socket.id === room.hostId,
      players
    });

    // Notify everyone in room about updated player list
    io.to(code).emit('player-list-update', { players, hostId: room.hostId });
  });

  /* ─── DEBUG: Add Bot Players (for solo testing) ─── */
  socket.on('add-bots', ({ count }) => {
    const room = gm.getRoomBySocket(socket.id);
    if (!room || socket.id !== room.hostId || room.phase !== 'lobby') return;

    const botNames = ['Alice', 'Bob', 'Carlos', 'Diana', 'Eve', 'Frank', 'Grace', 'Hank', 'Ivy', 'Jack'];
    const existingNames = [...room.players.values()].map(p => p.name.toLowerCase());
    let added = 0;

    for (const name of botNames) {
      if (added >= count) break;
      if (existingNames.includes(name.toLowerCase())) continue;
      const botId = `bot-${name.toLowerCase()}-${Date.now()}`;
      room.players.set(botId, { name, role: null, alive: true, voted: false });
      added++;
    }

    console.log(`[DEBUG] Added ${added} bots to room ${room.code}`);

    const players = [];
    for (const [id, p] of room.players) {
      players.push({ id, name: p.name });
    }
    io.to(room.code).emit('player-list-update', { players, hostId: room.hostId });
  });

  /* ─── CHAT ─── */
  socket.on('send-chat-message', (data) => {
    const room = gm.getRoomBySocket(socket.id);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    
    // Broadcast message to everyone in the room
    io.to(room.code).emit('chat-message', {
      senderId: socket.id,
      senderName: player.name,
      message: data.message,
      isAlive: player.alive
    });
  });

  /* ─── LOBBY: Start Game ─── */
  socket.on('start-game', () => {
    const room = gm.getRoomBySocket(socket.id);
    if (!room) return;
    if (socket.id !== room.hostId) return;
    if (room.players.size < 4) {
      socket.emit('start-error', { message: 'Need at least 4 players to start.' });
      return;
    }

    gm.assignRoles(room.code);
    console.log(`[GAME] Game started in room ${room.code} with ${room.players.size} players`);

    // Join Mafia players to a sub-room for targeted events
    for (const [id, p] of room.players) {
      if (p.role === 'Mafia') socket.server.sockets.sockets.get(id)?.join(room.code + '-mafia');
      if (p.role === 'Doctor') socket.server.sockets.sockets.get(id)?.join(room.code + '-doctor');
      if (p.role === 'Cheikh') socket.server.sockets.sockets.get(id)?.join(room.code + '-cheikh');
    }

    // Send each player their private role card
    for (const [id, p] of room.players) {
      const roleInfo = gm.ROLE_INFO[p.role];
      io.to(id).emit('role-assigned', {
        role: p.role,
        emoji: roleInfo.emoji,
        description: roleInfo.description,
        instruction: roleInfo.instruction,
        team: roleInfo.team
      });
    }

    // After showing roles for a few seconds, start night
    setTimeout(() => {
      nightPhase.startNight(io, room);
    }, 8000);
  });

  /* ─── NIGHT: Submit Action ─── */
  socket.on('night-action', ({ targetId }) => {
    const room = gm.getRoomBySocket(socket.id);
    if (!room || room.phase !== 'night') return;

    const player = room.players.get(socket.id);
    if (!player || !player.alive) return;

    const step = room.nightStep;

    // Validate that the acting player has the right role for the current step
    const expectedRole = step.charAt(0).toUpperCase() + step.slice(1);
    if (player.role !== expectedRole) return;

    console.log(`[NIGHT] ${player.name} (${player.role}) targets ${targetId} in room ${room.code}`);
    nightPhase.handleNightAction(io, room, step, targetId);
  });

  /* ─── DAY: Move to Vote ─── */
  socket.on('move-to-vote', () => {
    const room = gm.getRoomBySocket(socket.id);
    if (!room || room.phase !== 'day') return;
    if (socket.id !== room.hostId) return;

    dayPhase.startVote(io, room);
  });

  /* ─── VOTE: Cast Vote ─── */
  socket.on('cast-vote', ({ targetId }) => {
    const room = gm.getRoomBySocket(socket.id);
    if (!room || room.phase !== 'vote') return;

    const player = room.players.get(socket.id);
    if (!player || !player.alive || player.voted) return;

    console.log(`[VOTE] ${player.name} votes for ${targetId} in room ${room.code}`);
    dayPhase.handleVote(io, room, socket.id, targetId);
  });

  /* ─── GAME OVER: Return to Lobby ─── */
  socket.on('return-to-lobby', () => {
    const room = gm.getRoomBySocket(socket.id);
    if (!room) return;

    // Leave all sub-rooms
    socket.leave(room.code + '-mafia');
    socket.leave(room.code + '-doctor');
    socket.leave(room.code + '-cheikh');
    socket.leave(room.code);

    gm.removePlayer(socket.id);
    socket.emit('returned-to-lobby');
  });

  /* ─── Disconnect ─── */
  socket.on('disconnect', () => {
    console.log(`[-] Player disconnected: ${socket.id}`);
    const room = gm.getRoomBySocket(socket.id);
    if (!room) return;

    const player = room.players.get(socket.id);
    const playerName = player?.name || 'Unknown';

    const updatedRoom = gm.removePlayer(socket.id);
    if (updatedRoom) {
      // Notify remaining players
      const players = [];
      for (const [id, p] of updatedRoom.players) {
        players.push({ id, name: p.name });
      }
      io.to(updatedRoom.code).emit('player-list-update', {
        players,
        hostId: updatedRoom.hostId
      });
      io.to(updatedRoom.code).emit('player-disconnected', {
        name: playerName,
        message: `${playerName} has disconnected.`
      });
    }
  });
});

/* ── Start server ────────────────────────────────────────── */

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎭 Mafia Game Server running at http://localhost:${PORT}\n`);
});
