/**
 * day.js
 * ──────
 * Handles the day phase (discussion) and vote phase (elimination voting).
 */

const gm = require('../gameManager');

/**
 * Start the day phase — open discussion.
 */
function startDay(io, room) {
  room.phase = 'day';
  room.votes = {};

  const alivePlayers = gm.getAlivePlayers(room);

  io.to(room.code).emit('phase-change', {
    phase: 'day',
    round: room.round,
    message: `☀️ Day ${room.round} — Time to discuss. Who is suspicious?`,
    alivePlayers: alivePlayers.map(p => ({ id: p.id, name: p.name }))
  });
}

/**
 * Start the vote phase.
 */
function startVote(io, room) {
  room.phase = 'vote';
  room.votes = {};
  // Reset voted flags
  for (const [, p] of room.players) p.voted = false;

  const alivePlayers = gm.getAlivePlayers(room);

  io.to(room.code).emit('phase-change', {
    phase: 'vote',
    round: room.round,
    message: '🗳️ Time to vote! Choose the player you want to eliminate.',
    alivePlayers: alivePlayers.map(p => ({ id: p.id, name: p.name }))
  });

  // Auto-vote for bots after a short delay
  let botDelay = 1000;
  for (const p of alivePlayers) {
    if (p.id.startsWith('bot-')) {
      const otherAlive = alivePlayers.filter(o => o.id !== p.id);
      if (otherAlive.length > 0) {
        const target = otherAlive[Math.floor(Math.random() * otherAlive.length)];
        setTimeout(() => {
          if (room.phase === 'vote') handleVote(io, room, p.id, target.id);
        }, botDelay);
        botDelay += 500;
      }
    }
  }
}

/**
 * Handle a player's vote.
 * Returns true if all alive players have voted.
 */
function handleVote(io, room, voterId, targetId) {
  gm.castVote(room, voterId, targetId);
  const voter = room.players.get(voterId);
  if (voter) voter.voted = true;

  // Count how many alive players have voted
  const alivePlayers = gm.getAlivePlayers(room);
  let votedCount = 0;
  for (const p of alivePlayers) {
    const player = room.players.get(p.id);
    if (player && player.voted) votedCount++;
  }

  // Broadcast vote progress
  io.to(room.code).emit('vote-progress', {
    votedCount,
    totalAlive: alivePlayers.length,
    message: `${votedCount} / ${alivePlayers.length} votes cast`
  });

  // If all alive players have voted, tally
  if (votedCount >= alivePlayers.length) {
    resolveVote(io, room);
    return true;
  }
  return false;
}

/**
 * Tally votes and announce result.
 */
function resolveVote(io, room) {
  const result = gm.tallyVotes(room);

  if (result.eliminated) {
    io.to(room.code).emit('vote-result', {
      eliminated: result.eliminated,
      tally: result.tally,
      tie: false,
      message: `⚖️ The town has spoken! ${result.eliminated.name} has been eliminated. They were a ${result.eliminated.role}.`
    });
  } else {
    io.to(room.code).emit('vote-result', {
      eliminated: null,
      tally: result.tally,
      tie: result.tie,
      message: result.tie
        ? '⚖️ The vote was a tie! No one is eliminated.'
        : '⚖️ No votes were cast. No one is eliminated.'
    });
  }

  // Check win condition
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
    // Start next night
    setTimeout(() => {
      const nightPhase = require('./night');
      nightPhase.startNight(io, room);
    }, 4000);
  }
}

module.exports = { startDay, startVote, handleVote };
