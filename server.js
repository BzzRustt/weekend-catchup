const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

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
    question: 'What did you get up to this weekend?',
    questionConfirmed: false,
    players: {},        // socketId -> { name, role, submitted, activity, score, token, connected }
    activities: [],     // [{ socketId, text }] shuffled
    currentRound: 0,
    votes: {},          // socketId -> votedForSocketId (reset each round)
    votedThisRound: new Set(),
    timerHandle: null,
    timerEnd: null,
    revealTimerEnd: null,
    revealPaused: false,
    revealRemainingMs: 15000,
    lastRevealPayload: null,
    resetHandle: null,
  };
}

let state = freshState();

function resetState() {
  if (state.timerHandle) clearTimeout(state.timerHandle);
  if (state.resetHandle) clearTimeout(state.resetHandle);
  const oldSessionId = state.sessionId;
  state = freshState();
  return oldSessionId;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function getPublicPlayers() {
  return Object.entries(state.players).map(([id, p]) => ({
    id,
    name: p.name,
    role: p.role,
    submitted: p.submitted,
    score: p.score,
    connected: p.connected !== false,
  }));
}

function connectedPlayers() {
  return Object.entries(state.players).filter(([, p]) => p.connected !== false);
}

function allVoted() {
  const connected = connectedPlayers();
  if (connected.length === 0) return false;
  return connected.every(([id]) => state.votedThisRound.has(id));
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
  const submitted = players.filter(p => p.submitted);
  const waiting = players.filter(p => !p.submitted);
  io.emit('submission_update', { players, submitted, waiting });
}

function startResetTimer() {
  state.resetHandle = setTimeout(() => {
    const oldId = resetState();
    io.emit('session_reset', { oldSessionId: oldId });
  }, 60000);
}

function currentActivity() {
  return state.activities[state.currentRound] || null;
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

  io.emit('voting_round', {
    roundIndex: state.currentRound,
    totalRounds: state.activities.length,
    activityText: act.text,
    players: getPublicPlayers(),
    timerEnd: state.timerEnd,
  });

  state.timerHandle = setTimeout(() => advanceFromVoting(), timerMs);
}

function advanceFromVoting() {
  if (state.timerHandle) clearTimeout(state.timerHandle);
  state.phase = 'reveal';

  const act = currentActivity();
  const owner = state.players[act.socketId];

  const correct = [];
  const wrong = [];
  const noVote = [];

  Object.entries(state.players).forEach(([id, p]) => {
    const votedFor = state.votes[id];
    if (!votedFor) {
      noVote.push({ id, name: p.name });
    } else if (votedFor === act.socketId) {
      correct.push({ id, name: p.name });
      p.score += 1;
    } else {
      wrong.push({ id, name: p.name });
    }
  });

  state.revealRemainingMs = 15000;
  state.revealPaused = false;
  state.revealTimerEnd = Date.now() + state.revealRemainingMs;

  const payload = {
    roundIndex: state.currentRound,
    totalRounds: state.activities.length,
    activityText: act.text,
    ownerName: owner ? owner.name : 'Unknown',
    correct,
    wrong,
    noVote,
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

  const ranked = Object.entries(state.players)
    .map(([id, p]) => ({ id, name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);

  let rank = 1;
  for (let i = 0; i < ranked.length; i++) {
    if (i > 0 && ranked[i].score < ranked[i - 1].score) rank = i + 1;
    ranked[i].rank = rank;
  }

  const noSubmissions = state.activities.length === 0;
  io.emit('leaderboard', { ranked, noSubmissions });
  startResetTimer();
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

    // Re-associate to new socket ID
    if (oldSocketId !== socket.id) {
      delete state.players[oldSocketId];
      state.players[socket.id] = player;
      if (state.hostSocketId === oldSocketId) state.hostSocketId = socket.id;
    }
    player.connected = true;

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
        hasVoted: state.votedThisRound.has(socket.id),
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
      const ranked = Object.entries(state.players)
        .map(([id, p]) => ({ id, name: p.name, score: p.score }))
        .sort((a, b) => b.score - a.score);
      let rank = 1;
      for (let i = 0; i < ranked.length; i++) {
        if (i > 0 && ranked[i].score < ranked[i - 1].score) rank = i + 1;
        ranked[i].rank = rank;
      }
      base.ranked = ranked;
      base.noSubmissions = state.activities.length === 0;
    }

    socket.emit('reconnect_success', base);

    if (state.phase === 'submission' || state.phase === 'question-setting') {
      broadcastSubmissionStatus();
    }
  });

  // ── Registration ──────────────────────────────────────────────────────────
  socket.on('claim_host', () => {
    if (state.hostSocketId || state.locked) {
      socket.emit('host_denied');
      return;
    }
    state.hostSocketId = socket.id;
    io.emit('host_claimed');
  });

  socket.on('join', ({ name, role, token }) => {
    if (state.locked) {
      socket.emit('session_locked');
      return;
    }
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

    if (role !== 'host') {
      broadcastSubmissionStatus();
    }
  });

  // ── Question setting ──────────────────────────────────────────────────────
  socket.on('confirm_question', ({ question }) => {
    if (socket.id !== state.hostSocketId || state.questionConfirmed) return;

    state.question = question && question.trim()
      ? question.trim()
      : 'What did you get up to this weekend?';
    state.questionConfirmed = true;
    state.phase = 'submission';

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
    broadcastSubmissionStatus();
  });

  socket.on('start_game', () => {
    if (socket.id !== state.hostSocketId || state.phase !== 'submission') return;
    state.locked = true;

    const acts = Object.entries(state.players)
      .filter(([, p]) => p.submitted && p.activity)
      .map(([id, p]) => ({ socketId: id, text: p.activity }));

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
    const player = state.players[socket.id];
    if (!player || state.votedThisRound.has(socket.id)) return;

    state.votes[socket.id] = votedForId;
    state.votedThisRound.add(socket.id);

    const total = connectedPlayers().length;
    io.emit('vote_update', { votedCount: state.votedThisRound.size, total });

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
  });

  socket.on('resume_reveal', () => {
    if (socket.id !== state.hostSocketId || state.phase !== 'reveal' || !state.revealPaused) return;
    state.revealPaused = false;
    state.revealTimerEnd = Date.now() + state.revealRemainingMs;
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
    if (state.currentRound + 1 >= state.activities.length) {
      endGame();
    } else {
      state.currentRound++;
      startVotingRound();
    }
  });

  socket.on('end_game', () => {
    if (socket.id !== state.hostSocketId) return;
    endGame();
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const player = state.players[socket.id];
    if (!player) return;

    // Host left before question was confirmed — free up host slot
    if (socket.id === state.hostSocketId &&
        (state.phase === 'registration' || state.phase === 'question-setting')) {
      state.hostSocketId = null;
      delete state.players[socket.id];
      io.emit('host_left');
      broadcastLobby();
      return;
    }

    // Keep player in state for reconnection; mark disconnected
    player.connected = false;

    if (state.phase === 'submission') {
      broadcastSubmissionStatus();
    } else if (state.phase === 'voting' && allVoted()) {
      advanceFromVoting();
    }
  });
});

server.listen(PORT, () => {
  console.log(`Weekend Catchup running at http://localhost:${PORT}`);
});
