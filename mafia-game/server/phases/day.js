/**
 * day.js — Day discussion, voting, defense phase, and re-vote.
 */
const gm = require('../gameManager');

function startDay(io, room) {
  room.phase = 'day';
  room.votes = {};
  const alivePlayers = gm.getAlivePlayers(room);

  io.to(room.code).emit('phase-change', {
    phase: 'day', round: room.round,
    message: `☀️ Day ${room.round} — Time to discuss. Who is suspicious?`,
    alivePlayers: alivePlayers.map(p => ({ id: p.id, name: p.name })),
    timeLimit: room.settings.discussionTime
  });
  io.to(room.code).emit('sound', { type: 'day' });
  io.to(room.code).emit('timer-start', { phase: 'discussion', seconds: room.settings.discussionTime });

  // Auto-move to vote when discussion time expires
  gm.setRoomTimer(room, 'discussion', () => {
    if (room.phase === 'day') startVote(io, room);
  }, room.settings.discussionTime * 1000);
}

function startVote(io, room) {
  gm.clearRoomTimer(room, 'discussion');
  room.phase = 'vote';
  room.votes = {};
  for (const [, p] of room.players) p.voted = false;

  const alivePlayers = gm.getAlivePlayers(room);
  io.to(room.code).emit('phase-change', {
    phase: 'vote', round: room.round,
    message: '🗳️ Time to vote! Choose the player you want to eliminate.',
    alivePlayers: alivePlayers.map(p => ({ id: p.id, name: p.name })),
    timeLimit: room.settings.votingTime
  });
  io.to(room.code).emit('sound', { type: 'vote' });
  io.to(room.code).emit('timer-start', { phase: 'voting', seconds: room.settings.votingTime });

  // Auto-resolve when voting time expires
  gm.setRoomTimer(room, 'voting', () => {
    if (room.phase === 'vote') resolveVote(io, room);
  }, room.settings.votingTime * 1000);
}

function handleVote(io, room, voterId, targetId) {
  gm.castVote(room, voterId, targetId);
  const voter = room.players.get(voterId);
  if (voter) voter.voted = true;

  const alivePlayers = gm.getAlivePlayers(room);
  let votedCount = 0;
  for (const p of alivePlayers) {
    const player = room.players.get(p.id);
    if (player && player.voted) votedCount++;
  }

  io.to(room.code).emit('vote-progress', {
    votedCount, totalAlive: alivePlayers.length,
    message: `${votedCount} / ${alivePlayers.length} votes cast`
  });

  if (votedCount >= alivePlayers.length) {
    resolveVote(io, room);
    return true;
  }
  return false;
}

function resolveVote(io, room) {
  gm.clearRoomTimer(room, 'voting');
  const result = gm.tallyVotes(room);

  if (result.accusedId && room.settings.enableDefense) {
    // Enter defense phase
    const accused = room.players.get(result.accusedId);
    room.phase = 'defense';
    room.accusedId = result.accusedId;
    room.defenseText = '';

    io.to(room.code).emit('defense-phase', {
      accusedId: result.accusedId,
      accusedName: accused.name,
      tally: result.tally,
      timeLimit: room.settings.defenseTime
    });
    io.to(room.code).emit('sound', { type: 'defense' });
    io.to(room.code).emit('timer-start', { phase: 'defense', seconds: room.settings.defenseTime });

    gm.setRoomTimer(room, 'defense', () => {
      if (room.phase === 'defense') startRevote(io, room);
    }, room.settings.defenseTime * 1000);

  } else if (result.accusedId && !room.settings.enableDefense) {
    // No defense phase — eliminate directly
    const eliminated = gm.eliminatePlayer(room, result.accusedId);
    emitVoteResult(io, room, eliminated, result.tally, false);
  } else {
    // Tie or no votes
    emitVoteResult(io, room, null, result.tally, result.tie);
  }
}

function startRevote(io, room) {
  gm.clearRoomTimer(room, 'defense');
  room.phase = 'revote';
  room.votes = {};
  for (const [, p] of room.players) p.voted = false;

  const accused = room.players.get(room.accusedId);
  const alivePlayers = gm.getAlivePlayers(room);

  io.to(room.code).emit('revote-phase', {
    accusedId: room.accusedId,
    accusedName: accused?.name || 'Unknown',
    defenseText: room.defenseText,
    timeLimit: room.settings.revoteTime,
    alivePlayers: alivePlayers.map(p => ({ id: p.id, name: p.name }))
  });
  io.to(room.code).emit('sound', { type: 'vote' });
  io.to(room.code).emit('timer-start', { phase: 'revote', seconds: room.settings.revoteTime });

  gm.setRoomTimer(room, 'revote', () => {
    if (room.phase === 'revote') resolveRevote(io, room);
  }, room.settings.revoteTime * 1000);
}

function handleRevote(io, room, voterId, vote) {
  // vote is 'yes' (eliminate) or 'no' (spare)
  room.votes[voterId] = vote;
  const voter = room.players.get(voterId);
  if (voter) voter.voted = true;

  const alivePlayers = gm.getAlivePlayers(room);
  let votedCount = 0;
  for (const p of alivePlayers) {
    const player = room.players.get(p.id);
    if (player && player.voted) votedCount++;
  }

  io.to(room.code).emit('vote-progress', {
    votedCount, totalAlive: alivePlayers.length,
    message: `${votedCount} / ${alivePlayers.length} votes cast`
  });

  if (votedCount >= alivePlayers.length) {
    resolveRevote(io, room);
  }
}

function resolveRevote(io, room) {
  gm.clearRoomTimer(room, 'revote');
  let yesCount = 0, noCount = 0;
  for (const [, vote] of Object.entries(room.votes)) {
    if (vote === 'yes') yesCount++;
    else noCount++;
  }

  room.votes = {};
  for (const [, p] of room.players) p.voted = false;

  const accused = room.players.get(room.accusedId);
  const accusedName = accused?.name || 'Unknown';

  if (yesCount > noCount) {
    const eliminated = gm.eliminatePlayer(room, room.accusedId);
    const tally = { [`Eliminate ${accusedName}`]: yesCount, [`Spare ${accusedName}`]: noCount };

    // Last words
    if (eliminated && room.settings.enableLastWords) {
      io.to(room.code).emit('vote-result', {
        eliminated, tally, tie: false,
        message: `⚖️ The town has spoken! ${eliminated.name} has been eliminated. They were a ${eliminated.role}.`
      });
      io.to(eliminated.id).emit('last-words-prompt', { timeLimit: room.settings.lastWordsTime });
      io.to(room.code).emit('sound', { type: 'eliminate' });

      gm.setRoomTimer(room, 'lastWords', () => {
        proceedAfterVote(io, room);
      }, room.settings.lastWordsTime * 1000);
      return;
    }

    emitVoteResult(io, room, eliminated, tally, false);
  } else {
    const tally = { [`Eliminate ${accusedName}`]: yesCount, [`Spare ${accusedName}`]: noCount };
    gm.addLogEntry(room, { type: 'spared', text: `${accusedName} was spared by the village.` });
    emitVoteResult(io, room, null, tally, false, `⚖️ ${accusedName} has been spared! The village moves on.`);
  }

  room.accusedId = null;
  room.defenseText = '';
}

function emitVoteResult(io, room, eliminated, tally, tie, customMessage) {
  let message = customMessage;
  if (!message) {
    if (eliminated) {
      message = `⚖️ The town has spoken! ${eliminated.name} has been eliminated. They were a ${eliminated.role}.`;
    } else if (tie) {
      message = '⚖️ The vote was a tie! No one is eliminated.';
    } else {
      message = '⚖️ No one was eliminated.';
    }
  }

  io.to(room.code).emit('vote-result', { eliminated, tally, tie, message });
  if (eliminated) io.to(room.code).emit('sound', { type: 'eliminate' });

  setTimeout(() => proceedAfterVote(io, room), 4000);
}

function proceedAfterVote(io, room) {
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
      const nightPhase = require('./night');
      nightPhase.startNight(io, room);
    }, 2000);
  }
}

module.exports = { startDay, startVote, handleVote, startRevote, handleRevote, proceedAfterVote };
