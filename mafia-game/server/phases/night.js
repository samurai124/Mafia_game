/**
 * night.js — Night phase with timers and auto-skip.
 */
const gm = require('../gameManager');

function startNight(io, room) {
  room.phase = 'night';
  room.round++;
  room.nightStep = 'mafia';
  room.nightActions = {};

  io.to(room.code).emit('phase-change', {
    phase: 'night', round: room.round,
    message: 'Night falls over the town… Everyone close your eyes.'
  });

  setTimeout(() => wakeUpRole(io, room, 'mafia'), 2000);
}

function wakeUpRole(io, room, step) {
  if (room.phase !== 'night') return;
  room.nightStep = step;

  // Skip Cheikh if disabled
  if (step === 'cheikh' && !room.settings.enableCheikh) {
    handleNightAction(io, room, step, null);
    return;
  }

  const alivePlayers = gm.getAlivePlayers(room);

  io.to(room.code).emit('night-step', {
    step, message: getNightStepMessage(step)
  });

  const roleName = step.charAt(0).toUpperCase() + step.slice(1);
  const rolePlayers = gm.getPlayersByRole(room, roleName);

  const targets = alivePlayers.filter(p => {
    if (step === 'mafia') {
      const tp = room.players.get(p.id);
      return tp && tp.role !== 'Mafia';
    }
    return true;
  });

  rolePlayers.forEach(rp => {
    io.to(rp.id).emit('night-action-prompt', {
      step, role: roleName,
      targets: targets.map(t => ({ id: t.id, name: t.name })),
      message: getActionPrompt(step),
      timeLimit: room.settings.nightActionTime
    });
  });

  if (rolePlayers.length === 0) {
    handleNightAction(io, room, step, null);
    return;
  }

  // Auto-skip timer
  const timerSec = room.settings.nightActionTime;
  io.to(room.code).emit('timer-start', { phase: 'night-action', seconds: timerSec });

  gm.setRoomTimer(room, 'nightAction', () => {
    if (room.phase === 'night' && room.nightStep === step) {
      handleNightAction(io, room, step, null);
    }
  }, timerSec * 1000);
}

function handleNightAction(io, room, step, targetId) {
  gm.clearRoomTimer(room, 'nightAction');

  if (step === 'mafia') {
    gm.setNightAction(room, 'mafiaTarget', targetId);
    const mafiaPlayers = gm.getPlayersByRole(room, 'Mafia');
    const targetName = targetId ? room.players.get(targetId)?.name : 'no one';
    mafiaPlayers.forEach(mp => {
      io.to(mp.id).emit('night-action-confirmed', {
        message: `Target selected: ${targetName}. Close your eyes.`
      });
    });
    setTimeout(() => wakeUpRole(io, room, 'doctor'), 2000);

  } else if (step === 'doctor') {
    gm.setNightAction(room, 'doctorTarget', targetId);
    const doctors = gm.getPlayersByRole(room, 'Doctor');
    const targetName = targetId ? room.players.get(targetId)?.name : 'no one';
    doctors.forEach(d => {
      io.to(d.id).emit('night-action-confirmed', {
        message: `You chose to protect ${targetName}. Close your eyes.`
      });
    });
    setTimeout(() => wakeUpRole(io, room, 'cheikh'), 2000);

  } else if (step === 'cheikh') {
    gm.setNightAction(room, 'cheikhTarget', targetId);
    const cheikhs = gm.getPlayersByRole(room, 'Cheikh');
    if (targetId) {
      const targetPlayer = room.players.get(targetId);
      const isMafia = targetPlayer?.role === 'Mafia';
      const targetName = targetPlayer?.name || 'Unknown';
      cheikhs.forEach(c => {
        io.to(c.id).emit('cheikh-result', {
          targetName, result: isMafia ? 'Mafia' : 'Not Mafia',
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
    setTimeout(() => resolveNightPhase(io, room), 2500);
  }
}

function resolveNightPhase(io, room) {
  room.nightStep = 'resolve';
  const result = gm.resolveNight(room);

  if (result.saved) {
    io.to(room.code).emit('night-result', {
      saved: true,
      message: '☀️ Dawn breaks… The Doctor saved someone tonight! No one was eliminated.',
      victim: null
    });
  } else if (result.victim) {
    io.to(room.code).emit('night-result', {
      saved: false,
      message: `☀️ Dawn breaks… ${result.victimName} was found dead.`,
      victim: { id: result.victim, name: result.victimName, role: result.victimRole }
    });
    // Last words
    if (room.settings.enableLastWords) {
      io.to(result.victim).emit('last-words-prompt', {
        timeLimit: room.settings.lastWordsTime
      });
      gm.setRoomTimer(room, 'lastWords', () => {
        proceedAfterNight(io, room);
      }, room.settings.lastWordsTime * 1000);
      return;
    }
  } else {
    io.to(room.code).emit('night-result', {
      saved: false,
      message: '☀️ Dawn breaks… Surprisingly, no one was targeted last night.',
      victim: null
    });
  }

  setTimeout(() => proceedAfterNight(io, room), 4000);
}

function proceedAfterNight(io, room) {
  gm.clearRoomTimer(room, 'lastWords');
  const winner = gm.checkWinCondition(room);
  if (winner) {
    setTimeout(() => {
      io.to(room.code).emit('game-over', {
        winner, players: gm.getAllPlayers(room),
        message: winner === 'Citizens'
          ? '🎉 The Citizens have rooted out all the Mafia! Town wins!'
          : '💀 The Mafia has taken over the town! Mafia wins!',
        gameLog: room.gameLog
      });
      io.to(room.code).emit('sound', { type: 'gameover' });
    }, 1000);
  } else {
    setTimeout(() => {
      const dayPhase = require('./day');
      dayPhase.startDay(io, room);
    }, 2000);
  }
}

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

module.exports = { startNight, handleNightAction, proceedAfterNight };
