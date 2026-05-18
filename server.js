const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

const HOST_DISCONNECT_GRACE_MS = 30 * 1000;
const IDLE_PREGAME_MS  = 15 * 60 * 1000;
const IDLE_INGAME_MS   = 30 * 60 * 1000;

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// ── State factory ────────────────────────────────────────────────────────────
function freshState() {
  return {
    sessionId: generateId(),
    // registration | question-setting | submission | voting | reveal | between | leaderboard
    phase: 'registration',
    locked: false,
    hostSocketId: null,
    question: '',
    questionConfirmed: false,
    // socketId -> { name, role, submitted, activity, score, token, connected }
    players: {},
    activities: [],     // [{ token, text }] shuffled
    currentRound: 0,
    votes: {},          // voterToken -> votedForToken (reset each round)
    votedThisRound: new Set(),  // voter tokens
    timerHandle: null,
    timerEnd: null,
    revealTimerEnd: null,
    revealPaused: false,
    revealRemainingMs: 15000,
    lastRevealPayload: null,
    resetHandle: null,
    hostDisconnectTimerHandle: null,
    idleTimerHandle: null,
  };
}

let state = freshState();
resetIdleTimer();

function resetState() {
  if (state.timerHandle) clearTimeout(state.timerHandle);
  if (state.resetHandle) clearTimeout(state.resetHandle);
  if (state.hostDisconnectTimerHandle) clearTimeout(state.hostDisconnectTimerHandle);
  if (state.idleTimerHandle) clearTimeout(state.idleTimerHandle);
  const oldSessionId = state.sessionId;
  state = freshState();
  resetIdleTimer();
  return oldSessionId;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function getPublicPlayers() {
  // Public `id` is the player's stable TOKEN — survives reconnection.
  return Object.values(state.players).map(p => ({
    id: p.token,
    name: p.name,
    role: p.role,
    submitted: p.submitted,
    score: p.score,
    connected: p.connected !== false,
  }));
}

function playerByToken(token) {
  return Object.values(state.players).find(p => p.token === token) || null;
}

function socketIdByToken(token) {
  const entry = Object.entries(state.players).find(([, p]) => p.token === token);
  return entry ? entry[0] : null;
}

function connectedPlayerTokens() {
  return Object.values(state.players)
    .filter(p => p.connected !== false)
    .map(p => p.token);
}

function allVoted() {
  const tokens = connectedPlayerTokens();
  if (tokens.length === 0) return false;
  return tokens.every(t => state.votedThisRound.has(t));
}

function broadcastLobby() {
  io.emit('lobby_update', {
    players: getPublicPlayers(),
    hostTaken: !!state.hostSocketId,
    phase: state.phase,
    locked: state.locked,
  });
}

function broadcastSubmissionStatus() {
  const players = getPublicPlayers();
  io.emit('submission_update', {
    players,
    submitted: players.filter(p => p.submitted),
    waiting:   players.filter(p => !p.submitted),
  });
}

function startResetTimer() {
  if (state.resetHandle) clearTimeout(state.resetHandle);
  state.resetHandle = setTimeout(() => {
    const oldId = resetState();
    io.emit('session_reset', { oldSessionId: oldId, reason: 'auto' });
  }, 60000);
}

function currentActivity() { return state.activities[state.currentRound] || null; }

// ── Idle timer (15 min pre-game, 30 min in-game) ─────────────────────────────
function resetIdleTimer() {
  if (state.idleTimerHandle) clearTimeout(state.idleTimerHandle);
  const inGame = ['voting', 'reveal', 'between'].includes(state.phase);
  const ms = inGame ? IDLE_INGAME_MS : IDLE_PREGAME_MS;
  state.idleTimerHandle = setTimeout(() => {
    const oldId = resetState();
    io.emit('session_reset', { oldSessionId: oldId, reason: 'idle_timeout' });
  }, ms);
}

// ── Game flow ────────────────────────────────────────────────────────────────
function startVotingRound() {
  state.votes = {};
  state.votedThisRound = new Set();
  if (state.timerHandle) clearTimeout(state.timerHandle);

  const act = currentActivity();
  if (!act) { endGame(); return; }

  const timerMs = 45000;
  state.timerEnd = Date.now() + timerMs;
  state.phase = 'voting';
  resetIdleTimer();

  io.emit('voting_round', {
    roundIndex: state.currentRound,
    totalRounds: state.activities.length,
    activityText: act.text,
    question: state.question,
    players: getPublicPlayers(),
    timerEnd: state.timerEnd,
  });

  state.timerHandle = setTimeout(() => advanceFromVoting(), timerMs);
}

function advanceFromVoting() {
  if (state.timerHandle) clearTimeout(state.timerHandle);
  state.phase = 'reveal';
  resetIdleTimer();

  const act = currentActivity();
  const ownerPlayer = playerByToken(act.token);

  const correct = [];
  const wrong = [];
  const noVote = [];

  Object.values(state.players).forEach(p => {
    const votedFor = state.votes[p.token];
    if (!votedFor) {
      noVote.push({ id: p.token, name: p.name });
    } else if (votedFor === act.token) {
      correct.push({ id: p.token, name: p.name });
      p.score += 1;
    } else {
      wrong.push({ id: p.token, name: p.name });
    }
  });

  state.revealRemainingMs = 15000;
  state.revealPaused = false;
  state.revealTimerEnd = Date.now() + state.revealRemainingMs;

  const payload = {
    roundIndex: state.currentRound,
    totalRounds: state.activities.length,
    activityText: act.text,
    ownerName: ownerPlayer ? ownerPlayer.name : 'Unknown',
    question: state.question,
    correct, wrong, noVote,
    players: getPublicPlayers(),
    revealTimerEnd: state.revealTimerEnd,
  };
  state.lastRevealPayload = payload;
  io.emit('reveal', payload);
  scheduleRevealAdvance(state.revealRemainingMs);
}

function scheduleRevealAdvance(ms) {
  if (state.timerHandle) clearTimeout(state.timerHandle);
  state.timerHandle = setTimeout(() => {
    if (!state.revealPaused) advanceFromReveal();
  }, ms);
}

function advanceFromReveal() {
  if (state.timerHandle) clearTimeout(state.timerHandle);
  if (state.currentRound + 1 >= state.activities.length) {
    endGame();
  } else {
    state.phase = 'between';
    resetIdleTimer();
    io.emit('between_rounds', { countdown: 3 });
    state.timerHandle = setTimeout(() => {
      state.currentRound++;
      startVotingRound();
    }, 3500);
  }
}

function endGame() {
  if (state.timerHandle) clearTimeout(state.timerHandle);
  state.phase = 'leaderboard';
  resetIdleTimer();

  const ranked = Object.values(state.players)
    .map(p => ({ id: p.token, name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);

  let rank = 1;
  for (let i = 0; i < ranked.length; i++) {
    if (i > 0 && ranked[i].score < ranked[i - 1].score) rank = i + 1;
    ranked[i].rank = rank;
  }

  io.emit('leaderboard', {
    ranked,
    noSubmissions: state.activities.length === 0,
    hostToken: state.players[state.hostSocketId]?.token || null,
  });
  startResetTimer();
}

// ── Host abandonment / promotion ─────────────────────────────────────────────
function startHostDisconnectTimer() {
  if (state.hostDisconnectTimerHandle) clearTimeout(state.hostDisconnectTimerHandle);
  io.emit('host_disconnecting', { gracePeriodMs: HOST_DISCONNECT_GRACE_MS });
  state.hostDisconnectTimerHandle = setTimeout(() => {
    state.hostDisconnectTimerHandle = null;
    promoteNewHost();
  }, HOST_DISCONNECT_GRACE_MS);
}

function cancelHostDisconnectTimer() {
  if (state.hostDisconnectTimerHandle) {
    clearTimeout(state.hostDisconnectTimerHandle);
    state.hostDisconnectTimerHandle = null;
    io.emit('host_reconnected');
  }
}

function promoteNewHost() {
  // Pick first connected non-host player
  const candidates = Object.entries(state.players)
    .filter(([sid, p]) => p.connected !== false && sid !== state.hostSocketId);

  if (candidates.length === 0) {
    const oldId = resetState();
    io.emit('session_reset', { oldSessionId: oldId, reason: 'no_host' });
    return;
  }

  // Clean up the old host entry (they didn't come back)
  if (state.hostSocketId && state.players[state.hostSocketId]) {
    delete state.players[state.hostSocketId];
  }

  const [newHostSid, newPlayer] = candidates[0];
  newPlayer.role = 'host';
  state.hostSocketId = newHostSid;

  io.to(newHostSid).emit('promoted_to_host', buildReconnectPayload(newHostSid));
  io.emit('host_changed', { newHostName: newPlayer.name });
  broadcastLobby();
  if (state.phase === 'submission' || state.phase === 'question-setting') {
    broadcastSubmissionStatus();
  }
}

// ── Reconnect payload builder (shared by reconnect + promotion) ──────────────
function buildReconnectPayload(socketId) {
  const player = state.players[socketId];
  if (!player) return null;

  const base = {
    name: player.name,
    role: player.role,
    isHost: player.role === 'host',
    phase: state.phase,
    question: state.question,
    questionConfirmed: state.questionConfirmed,
    players: getPublicPlayers(),
    sessionId: state.sessionId,
    submitted: player.submitted,
  };

  if (state.phase === 'voting') {
    const act = currentActivity();
    Object.assign(base, {
      roundIndex: state.currentRound,
      totalRounds: state.activities.length,
      activityText: act ? act.text : '',
      timerEnd: state.timerEnd,
      votedCount: state.votedThisRound.size,
      hasVoted: state.votedThisRound.has(player.token),
    });
  }

  if (state.phase === 'reveal' && state.lastRevealPayload) {
    Object.assign(base, {
      ...state.lastRevealPayload,
      revealTimerEnd: state.revealTimerEnd,
      revealPaused: state.revealPaused,
      revealRemainingMs: state.revealRemainingMs,
    });
  }

  if (state.phase === 'leaderboard') {
    const ranked = Object.values(state.players)
      .map(p => ({ id: p.token, name: p.name, score: p.score }))
      .sort((a, b) => b.score - a.score);
    let rank = 1;
    for (let i = 0; i < ranked.length; i++) {
      if (i > 0 && ranked[i].score < ranked[i - 1].score) rank = i + 1;
      ranked[i].rank = rank;
    }
    base.ranked = ranked;
    base.noSubmissions = state.activities.length === 0;
  }

  return base;
}

// ── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  socket.emit('init', {
    sessionId: state.sessionId,
    phase: state.phase,
    locked: state.locked,
    hostTaken: !!state.hostSocketId,
    players: getPublicPlayers(),
    question: state.question,
    questionConfirmed: state.questionConfirmed,
    hostDisconnecting: !!state.hostDisconnectTimerHandle,
  });

  // ── Reconnection ──────────────────────────────────────────────────────────
  socket.on('reconnect_attempt', ({ token, sessionId }) => {
    if (sessionId !== state.sessionId) {
      socket.emit('reconnect_failed', { reason: 'session_mismatch' });
      return;
    }
    const entry = Object.entries(state.players).find(([, p]) => p.token === token);
    if (!entry) {
      socket.emit('reconnect_failed', { reason: 'not_found' });
      return;
    }
    const [oldSocketId, player] = entry;

    if (oldSocketId !== socket.id) {
      delete state.players[oldSocketId];
      state.players[socket.id] = player;
      if (state.hostSocketId === oldSocketId) {
        state.hostSocketId = socket.id;
        cancelHostDisconnectTimer();  // host is back
      }
    }
    player.connected = true;

    socket.emit('reconnect_success', buildReconnectPayload(socket.id));

    if (state.phase === 'submission' || state.phase === 'question-setting') {
      broadcastSubmissionStatus();
    }
  });

  // ── Registration ──────────────────────────────────────────────────────────
  socket.on('claim_host', () => {
    if (state.hostSocketId || state.locked) { socket.emit('host_denied'); return; }
    state.hostSocketId = socket.id;
    io.emit('host_claimed');
  });

  socket.on('join', ({ name, role, token }) => {
    if (state.locked) { socket.emit('session_locked'); return; }
    if (!name || !name.trim()) return;

    if (role === 'host' && state.hostSocketId && state.hostSocketId !== socket.id) {
      socket.emit('host_denied');
      return;
    }

    const playerToken = token || generateId();

    state.players[socket.id] = {
      name: name.trim(),
      role,
      submitted: false,
      activity: null,
      score: 0,
      token: playerToken,
      connected: true,
    };

    if (role === 'host') {
      state.hostSocketId = socket.id;
      if (state.phase === 'registration') state.phase = 'question-setting';
    }

    resetIdleTimer();
    broadcastLobby();

    socket.emit('joined', {
      role,
      name: name.trim(),
      sessionId: state.sessionId,
      token: playerToken,
      phase: state.phase,
      question: state.question,
      questionConfirmed: state.questionConfirmed,
    });

    if (role !== 'host') broadcastSubmissionStatus();
  });

  // ── Question setting ──────────────────────────────────────────────────────
  socket.on('confirm_question', ({ question }) => {
    if (socket.id !== state.hostSocketId || state.questionConfirmed) return;

    const trimmed = question && question.trim();
    if (!trimmed) return; // require non-empty question

    state.question = trimmed;
    state.questionConfirmed = true;
    state.phase = 'submission';
    resetIdleTimer();

    io.emit('question_confirmed', {
      question: state.question,
      players: getPublicPlayers(),
    });
    broadcastSubmissionStatus();
  });

  // ── Submission ────────────────────────────────────────────────────────────
  socket.on('submit_activity', ({ text }) => {
    const player = state.players[socket.id];
    if (!player || player.submitted || state.phase !== 'submission') return;
    player.submitted = true;
    player.activity = text ? text.trim() : '';
    resetIdleTimer();
    broadcastSubmissionStatus();
  });

  socket.on('start_game', () => {
    if (socket.id !== state.hostSocketId || state.phase !== 'submission') return;
    state.locked = true;

    const acts = Object.values(state.players)
      .filter(p => p.submitted && p.activity)
      .map(p => ({ token: p.token, text: p.activity }));

    for (let i = acts.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [acts[i], acts[j]] = [acts[j], acts[i]];
    }

    state.activities = acts;
    state.currentRound = 0;

    if (acts.length === 0) { endGame(); return; }
    startVotingRound();
  });

  // ── Voting ────────────────────────────────────────────────────────────────
  socket.on('vote', ({ votedForId }) => {
    if (state.phase !== 'voting') return;
    const voter = state.players[socket.id];
    if (!voter || state.votedThisRound.has(voter.token)) return;
    if (!playerByToken(votedForId)) return; // invalid target token

    state.votes[voter.token] = votedForId;
    state.votedThisRound.add(voter.token);
    resetIdleTimer();

    io.emit('vote_update', {
      votedCount: state.votedThisRound.size,
      total: connectedPlayerTokens().length,
    });

    if (allVoted()) advanceFromVoting();
  });

  socket.on('next_round', () => {
    if (socket.id !== state.hostSocketId || state.phase !== 'voting') return;
    advanceFromVoting();
  });

  // ── Reveal pause / resume / skip ─────────────────────────────────────────
  socket.on('pause_reveal', () => {
    if (socket.id !== state.hostSocketId || state.phase !== 'reveal' || state.revealPaused) return;
    if (state.timerHandle) clearTimeout(state.timerHandle);
    state.revealPaused = true;
    state.revealRemainingMs = Math.max(0, state.revealTimerEnd - Date.now());
    io.emit('reveal_paused', { remainingMs: state.revealRemainingMs });
    // Idle timer keeps running — pause counts as "stuck in place"
  });

  socket.on('resume_reveal', () => {
    if (socket.id !== state.hostSocketId || state.phase !== 'reveal' || !state.revealPaused) return;
    state.revealPaused = false;
    state.revealTimerEnd = Date.now() + state.revealRemainingMs;
    resetIdleTimer();
    io.emit('reveal_resumed', { revealTimerEnd: state.revealTimerEnd });
    scheduleRevealAdvance(state.revealRemainingMs);
  });

  socket.on('skip_reveal', () => {
    if (socket.id !== state.hostSocketId || state.phase !== 'reveal') return;
    advanceFromReveal();
  });

  socket.on('skip_countdown', () => {
    if (socket.id !== state.hostSocketId || state.phase !== 'between') return;
    if (state.timerHandle) clearTimeout(state.timerHandle);
    if (state.currentRound + 1 >= state.activities.length) endGame();
    else { state.currentRound++; startVotingRound(); }
  });

  socket.on('end_game', () => {
    if (socket.id !== state.hostSocketId) return;
    endGame();
  });

  // ── Host reset (leaderboard) ─────────────────────────────────────────────
  socket.on('reset_session', () => {
    if (socket.id !== state.hostSocketId) return;
    if (state.phase !== 'leaderboard') return;
    const oldId = resetState();
    io.emit('session_reset', { oldSessionId: oldId, reason: 'host_reset' });
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const player = state.players[socket.id];
    if (!player) return;

    const wasHost = (socket.id === state.hostSocketId);
    player.connected = false;

    if (wasHost) {
      if (state.phase === 'registration') {
        // Host never even joined fully — clear slot
        state.hostSocketId = null;
        delete state.players[socket.id];
        io.emit('host_left');
        broadcastLobby();
        return;
      }
      // Start 30s grace; promote if no reconnect
      startHostDisconnectTimer();
    }

    if (state.phase === 'submission') broadcastSubmissionStatus();
    else if (state.phase === 'voting' && allVoted()) advanceFromVoting();
  });
});

server.listen(PORT, () => {
  console.log(`Team Catchup running at http://localhost:${PORT}`);
});
