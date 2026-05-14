/**
 * night.js
 * ────────
 * Handles the night phase logic: sequential wake-ups for Mafia → Doctor → Cheikh,
 * collecting actions via Socket.io, and resolving the night.
 */

const gm = require('../gameManager');

/**
 * Start the night phase for a room.
 * Sets up the sequential wake-up flow.
 */
function startNight(io, room) {
  room.phase = 'night';
  room.round++;
  room.nightStep = 'mafia';
  room.nightActions = {};

  // Broadcast to all players: night has begun
  io.to(room.code).emit('phase-change', {
    phase: 'night',
    round: room.round,
    message: 'Night falls over the town… Everyone close your eyes.'
  });

  // After a short delay, wake up the Mafia
  setTimeout(() => wakeUpRole(io, room, 'mafia'), 2000);
}

/**
 * Wake up a specific role group.
 * Only those players see the action UI.
 */
function wakeUpRole(io, room, step) {
  room.nightStep = step;

  const alivePlayers = gm.getAlivePlayers(room);

  // Notify host/all about which role is awake (without revealing who)
  io.to(room.code).emit('night-step', {
    step,
    message: getNightStepMessage(step)
  });

  // Send action UI only to the relevant role's players
  const roleName = step.charAt(0).toUpperCase() + step.slice(1);
  const rolePlayers = gm.getPlayersByRole(room, roleName);

  // Build target list (exclude self for some roles, exclude dead)
  const targets = alivePlayers.filter(p => {
    // Mafia can't target fellow Mafia
    if (step === 'mafia') {
      const targetPlayer = room.players.get(p.id);
      return targetPlayer && targetPlayer.role !== 'Mafia';
    }
    return true;
  });

  rolePlayers.forEach(rp => {
    io.to(rp.id).emit('night-action-prompt', {
      step,
      role: roleName,
      targets: targets.map(t => ({ id: t.id, name: t.name })),
      message: getActionPrompt(step)
    });
  });

  // If no alive players with this role, auto-skip
  if (rolePlayers.length === 0) {
    handleNightAction(io, room, step, null);
    return;
  }
}

/**
 * Handle a submitted night action from a player.
 */
function handleNightAction(io, room, step, targetId) {
  if (step === 'mafia') {
    gm.setNightAction(room, 'mafiaTarget', targetId);
    // Confirm to Mafia players
    const mafiaPlayers = gm.getPlayersByRole(room, 'Mafia');
    const targetName = targetId ? room.players.get(targetId)?.name : 'no one';
    mafiaPlayers.forEach(mp => {
      io.to(mp.id).emit('night-action-confirmed', {
        message: `Target selected: ${targetName}. Close your eyes.`
      });
    });
    // Move to Doctor
    setTimeout(() => wakeUpRole(io, room, 'doctor'), 2000);

  } else if (step === 'doctor') {
    gm.setNightAction(room, 'doctorTarget', targetId);
    // Confirm to Doctor
    const doctors = gm.getPlayersByRole(room, 'Doctor');
    const targetName = targetId ? room.players.get(targetId)?.name : 'no one';
    doctors.forEach(d => {
      io.to(d.id).emit('night-action-confirmed', {
        message: `You chose to protect ${targetName}. Close your eyes.`
      });
    });
    // Move to Cheikh
    setTimeout(() => wakeUpRole(io, room, 'cheikh'), 2000);

  } else if (step === 'cheikh') {
    gm.setNightAction(room, 'cheikhTarget', targetId);
    // Send investigation result privately
    const cheikhs = gm.getPlayersByRole(room, 'Cheikh');
    if (targetId) {
      const targetPlayer = room.players.get(targetId);
      const isMafia = targetPlayer?.role === 'Mafia';
      const targetName = targetPlayer?.name || 'Unknown';
      cheikhs.forEach(c => {
        io.to(c.id).emit('cheikh-result', {
          targetName,
          result: isMafia ? 'Mafia' : 'Not Mafia',
          message: `${targetName} is ${isMafia ? '🔴 Mafia' : '🟢 Not Mafia'}.`
        });
      });
    } else {
      cheikhs.forEach(c => {
        io.to(c.id).emit('night-action-confirmed', {
          message: 'You chose not to investigate anyone. Close your eyes.'
        });
      });
    }
    // Resolve the night
    setTimeout(() => resolveNightPhase(io, room), 2500);
  }
}

/**
 * Resolve the night: compare Mafia target vs Doctor save, broadcast results.
 */
function resolveNightPhase(io, room) {
  room.nightStep = 'resolve';
  const result = gm.resolveNight(room);

  // Broadcast night result to all players
  if (result.saved) {
    io.to(room.code).emit('night-result', {
      saved: true,
      message: '☀️ Dawn breaks… The Doctor saved someone tonight! No one was eliminated.',
      victim: null
    });
  } else if (result.victim) {
    io.to(room.code).emit('night-result', {
      saved: false,
      message: `☀️ Dawn breaks… ${result.victimName} was found dead. They were a ${result.victimRole}.`,
      victim: {
        id: result.victim,
        name: result.victimName,
        role: result.victimRole
      }
    });
  } else {
    io.to(room.code).emit('night-result', {
      saved: false,
      message: '☀️ Dawn breaks… Surprisingly, no one was targeted last night.',
      victim: null
    });
  }

  // Check win condition after night
  const winner = gm.checkWinCondition(room);
  if (winner) {
    setTimeout(() => {
      io.to(room.code).emit('game-over', {
        winner,
        players: gm.getAllPlayers(room),
        message: winner === 'Citizens'
          ? '🎉 The Citizens have rooted out all the Mafia! Town wins!'
          : '💀 The Mafia has taken over the town! Mafia wins!'
      });
    }, 3000);
  } else {
    // Transition to day phase after a pause
    setTimeout(() => {
      const dayPhase = require('./day');
      dayPhase.startDay(io, room);
    }, 4000);
  }
}

/* ── helper text ─────────────────────────────────────────── */

function getNightStepMessage(step) {
  switch (step) {
    case 'mafia': return '🔪 Mafia, wake up and choose your victim…';
    case 'doctor': return '💉 Doctor, wake up and choose someone to save…';
    case 'cheikh': return '🔍 Cheikh, wake up and investigate a player…';
    default: return '';
  }
}

function getActionPrompt(step) {
  switch (step) {
    case 'mafia': return 'Choose a player to eliminate tonight.';
    case 'doctor': return 'Choose a player to protect tonight.';
    case 'cheikh': return 'Choose a player to investigate.';
    default: return '';
  }
}

module.exports = { startNight, handleNightAction };
