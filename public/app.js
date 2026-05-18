/* ── localStorage helpers ────────────────────────────────────────────────── */
const LS_KEY = 'catchup_session';

function saveSession(data) { try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch (_) {} }
function loadSession()     { try { return JSON.parse(localStorage.getItem(LS_KEY)); } catch (_) { return null; } }
function clearSession()    { try { localStorage.removeItem(LS_KEY); } catch (_) {} }
function generateToken()   { return Date.now().toString(36) + Math.random().toString(36).slice(2); }

/* ── App state ───────────────────────────────────────────────────────────── */
const socket = io();

let myRole = 'player';
let myName = '';
let isHost = false;
let hasVoted = false;
let hostTaken = false;
let sessionPhase = 'registration';
let confirmedQuestion = '';

let timerInterval = null;
let revealTimerInterval = null;
let betweenInterval = null;

let reconnecting = false;
let pendingInitData = null;

/* ── Screen navigation ───────────────────────────────────────────────────── */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById('screen-' + id);
  if (el) el.classList.add('active');
}

/* ── Registration ────────────────────────────────────────────────────────── */
function selectRole(role) {
  if (role === 'host' && hostTaken) return;
  myRole = role;
  document.getElementById('btn-role-host').classList.toggle('selected', role === 'host');
  document.getElementById('btn-role-player').classList.toggle('selected', role === 'player');
}

function joinSession() {
  const nameEl = document.getElementById('input-name');
  const name = nameEl.value.trim();
  if (!name) { nameEl.focus(); return; }
  myName = name;
  socket.emit('join', { name, role: myRole, token: generateToken() });
}

/* ── Question setting ────────────────────────────────────────────────────── */
function useSuggestion(btn) {
  const input = document.getElementById('input-question');
  input.value = btn.textContent;
  input.focus();
}

function confirmQuestion() {
  const q = document.getElementById('input-question').value.trim();
  if (!q) {
    document.getElementById('input-question').focus();
    return;
  }
  socket.emit('confirm_question', { question: q });
}

/* ── Submission ──────────────────────────────────────────────────────────── */
function submitActivity() {
  const text = document.getElementById('input-activity').value.trim();
  socket.emit('submit_activity', { text });
  document.getElementById('sub-form-card').style.display = 'none';
  document.getElementById('sub-wait-card').style.display = 'block';
}

function startGame() { socket.emit('start_game'); }

/* ── Voting ──────────────────────────────────────────────────────────────── */
function vote(votedForId) {
  if (hasVoted) return;
  hasVoted = true;
  socket.emit('vote', { votedForId });
  document.querySelectorAll('.vote-btn').forEach(b => {
    b.disabled = true;
    if (b.dataset.id === votedForId) b.classList.add('selected');
  });
  document.getElementById('voted-msg').style.display = 'block';
}

function hostNext()       { socket.emit('next_round'); }
function skipCountdown()  { socket.emit('skip_countdown'); }
function pauseReveal()    { socket.emit('pause_reveal'); }
function resumeReveal()   { socket.emit('resume_reveal'); }
function skipReveal()     { socket.emit('skip_reveal'); }

/* ── End game confirm ────────────────────────────────────────────────────── */
function endGamePrompt(ctx) {
  document.getElementById('end-confirm-bar-vote').classList.remove('visible');
  document.getElementById('end-confirm-bar-reveal').classList.remove('visible');
  document.getElementById('end-confirm-bar-' + ctx).classList.add('visible');
}
function cancelEndGame(ctx) {
  document.getElementById('end-confirm-bar-' + ctx).classList.remove('visible');
}
function confirmEndGame() { socket.emit('end_game'); }

/* ── Host reset (leaderboard) ────────────────────────────────────────────── */
function hostResetPrompt()  { document.getElementById('reset-confirm-bar').classList.add('visible'); }
function cancelHostReset()  { document.getElementById('reset-confirm-bar').classList.remove('visible'); }
function confirmHostReset() { socket.emit('reset_session'); }

/* ── Voting timer ────────────────────────────────────────────────────────── */
function startTimer(timerEnd) {
  clearInterval(timerInterval);
  const totalMs = 45000;
  function tick() {
    const remaining = Math.max(0, timerEnd - Date.now());
    const secs = Math.ceil(remaining / 1000);
    const pct = (remaining / totalMs) * 100;
    const low = secs <= 10;
    const bar = document.getElementById('timer-bar');
    const num = document.getElementById('timer-number');
    if (bar) { bar.style.width = pct + '%'; bar.classList.toggle('low', low); }
    if (num)  { num.textContent = secs; num.classList.toggle('low', low); }
    if (remaining <= 0) clearInterval(timerInterval);
  }
  tick();
  timerInterval = setInterval(tick, 500);
}

/* ── Reveal countdown timer ──────────────────────────────────────────────── */
function startRevealTimer(timerEnd) {
  clearInterval(revealTimerInterval);
  setRevealPausedState(false, null);
  function tick() {
    const remaining = Math.max(0, timerEnd - Date.now());
    const secs = Math.ceil(remaining / 1000);
    const el = document.getElementById('reveal-timer-number');
    if (el) el.textContent = secs;
    if (remaining <= 0) clearInterval(revealTimerInterval);
  }
  tick();
  revealTimerInterval = setInterval(tick, 200);
}

function setRevealPausedState(paused, remainingMs) {
  clearInterval(revealTimerInterval);
  const timerEl  = document.getElementById('reveal-timer-number');
  const pausedEl = document.getElementById('reveal-paused-msg');
  if (pausedEl) pausedEl.style.display = paused ? 'block' : 'none';
  if (timerEl && paused && remainingMs != null) {
    timerEl.textContent = Math.ceil(remainingMs / 1000);
  }
}

/* ── Between-round countdown ─────────────────────────────────────────────── */
function startBetweenCountdown() {
  clearInterval(betweenInterval);
  let n = 3;
  const el = document.getElementById('between-countdown');
  if (el) el.textContent = n;
  betweenInterval = setInterval(() => {
    n--;
    if (el) el.textContent = Math.max(0, n);
    if (n <= 0) clearInterval(betweenInterval);
  }, 1000);
}

/* ── Render helpers ──────────────────────────────────────────────────────── */
function renderPlayerChip(p, dotClass) {
  const li = document.createElement('li');
  li.className = 'player-chip';
  li.innerHTML = `<span class="dot ${dotClass}"></span><span>${p.name}</span>` +
    (p.role === 'host' ? '<span class="host-badge">Host</span>' : '');
  return li;
}

function renderVoteGrid(players, alreadyVoted) {
  const grid = document.getElementById('vote-grid');
  grid.innerHTML = '';
  // All players are always shown — no elimination as rounds progress
  players.forEach(p => {
    const btn = document.createElement('button');
    btn.className = 'vote-btn';
    btn.textContent = p.name;
    btn.dataset.id = p.id; // stable token
    if (alreadyVoted) btn.disabled = true;
    btn.onclick = () => vote(p.id);
    grid.appendChild(btn);
  });
}

function renderRevealList(listId, items, chipClass) {
  const el = document.getElementById(listId);
  if (!el) return;
  if (!items || items.length === 0) {
    el.innerHTML = '<span style="color:var(--text-muted);font-size:0.875rem;">None</span>';
    return;
  }
  el.innerHTML = items.map(p => `<span class="reveal-chip ${chipClass}">${p.name}</span>`).join('');
}

function renderLeaderboard(ranked, noSubmissions, hostToken) {
  const list = document.getElementById('leaderboard-list');
  const subtitle = document.getElementById('lb-subtitle');
  if (noSubmissions) {
    subtitle.textContent = "Looks like everyone had a quiet one — nothing to guess!";
    list.innerHTML = '';
  } else {
    subtitle.textContent = "Here's how everyone did!";
    list.innerHTML = ranked.map(p => {
      const isFirst = p.rank === 1;
      return `<div class="lb-row">
        <span class="lb-rank ${isFirst ? 'first' : ''}">${isFirst ? '🥇' : p.rank}</span>
        <span class="lb-name">${p.name}</span>
        <span class="lb-score">${p.score} <span class="lb-pts">pts</span></span>
      </div>`;
    }).join('');
  }
  // Show host reset button only to the host
  const hostCtrl = document.getElementById('leaderboard-host-controls');
  if (hostCtrl) hostCtrl.style.display = isHost ? 'block' : 'none';
  document.getElementById('reset-confirm-bar').classList.remove('visible');
}

function renderHostSubPanel(submitted, waiting) {
  const readyList = document.getElementById('host-ready-list');
  const waitList  = document.getElementById('host-waiting-list');
  if (!readyList || !waitList) return;
  readyList.innerHTML = '';
  waitList.innerHTML  = '';
  if (submitted.length === 0) {
    readyList.innerHTML = '<li class="player-chip" style="color:var(--text-muted);font-style:italic;">None yet</li>';
  } else submitted.forEach(p => readyList.appendChild(renderPlayerChip(p, 'ready')));
  if (waiting.length === 0) {
    waitList.innerHTML = '<li class="player-chip" style="color:var(--text-muted);font-style:italic;">None yet</li>';
  } else waiting.forEach(p => waitList.appendChild(renderPlayerChip(p, 'waiting')));
}

/* ── Screen setups ───────────────────────────────────────────────────────── */
function showSubmissionScreen(alreadySubmitted) {
  sessionPhase = 'submission';
  showScreen('submission');
  document.getElementById('sub-question-text').textContent = confirmedQuestion || 'Your question';
  document.getElementById('sub-form-card').style.display = alreadySubmitted ? 'none' : 'block';
  document.getElementById('sub-wait-card').style.display = alreadySubmitted ? 'block' : 'none';
  document.getElementById('host-sub-panel').style.display = isHost ? 'block' : 'none';
}

function showVotingScreen(data) {
  sessionPhase = 'voting';
  showScreen('voting');
  document.getElementById('round-counter').textContent =
    `Round ${data.roundIndex + 1} of ${data.totalRounds}`;
  document.getElementById('vote-counter').textContent =
    `${data.votedCount || 0} of ${data.players.length} voted`;
  document.getElementById('vote-question-context').textContent =
    confirmedQuestion ? `Question: ${confirmedQuestion}` : '';
  document.getElementById('vote-activity-text').textContent = `"${data.activityText}"`;
  document.getElementById('voted-msg').style.display = hasVoted ? 'block' : 'none';
  document.getElementById('end-confirm-bar-vote').classList.remove('visible');
  document.getElementById('vote-host-controls').style.display = isHost ? 'flex' : 'none';
  renderVoteGrid(data.players, hasVoted);
  startTimer(data.timerEnd);
}

function showRevealScreen(data) {
  sessionPhase = 'reveal';
  clearInterval(timerInterval);
  showScreen('reveal');
  document.getElementById('reveal-round-label').textContent =
    `Round ${data.roundIndex + 1} of ${data.totalRounds}`;
  document.getElementById('reveal-question-context').textContent =
    confirmedQuestion ? `Question: ${confirmedQuestion}` : '';
  document.getElementById('reveal-activity-text').textContent = `"${data.activityText}"`;
  document.getElementById('reveal-owner-name').textContent = data.ownerName;
  document.getElementById('end-confirm-bar-reveal').classList.remove('visible');
  renderRevealList('reveal-correct', data.correct, 'correct');
  renderRevealList('reveal-wrong',   data.wrong,   'wrong');
  renderRevealList('reveal-novote',  data.noVote,  'novote');
  document.getElementById('reveal-host-controls').style.display = isHost ? 'flex' : 'none';
}

function resetRevealHostButtons() {
  document.getElementById('btn-pause-reveal').style.display  = '';
  document.getElementById('btn-resume-reveal').style.display = 'none';
}

/* ── Host-disconnect banner ──────────────────────────────────────────────── */
function showHostDisconnectBanner() {
  document.getElementById('host-disconnect-banner').style.display = 'block';
}
function hideHostDisconnectBanner() {
  document.getElementById('host-disconnect-banner').style.display = 'none';
}

/* ── Socket: connect ─────────────────────────────────────────────────────── */
socket.on('connect', () => {
  const saved = loadSession();
  if (saved && saved.token && saved.sessionId) {
    reconnecting = true;
    socket.emit('reconnect_attempt', { token: saved.token, sessionId: saved.sessionId });
  }
});

/* ── Socket: init ────────────────────────────────────────────────────────── */
socket.on('init', (data) => {
  pendingInitData = data;
  if (data.hostDisconnecting) showHostDisconnectBanner();
  if (reconnecting) return;
  processInit(data);
});

function processInit(data) {
  hostTaken     = data.hostTaken;
  sessionPhase  = data.phase;
  if (data.questionConfirmed) confirmedQuestion = data.question;

  if (data.locked && data.phase !== 'leaderboard') { showScreen('holding'); return; }
  if (data.phase === 'leaderboard')                { showScreen('holding'); return; }

  updateHostButton(data.hostTaken);
  showScreen('registration');
  if (data.players && data.players.length > 0) renderRegPlayers(data.players);
}

/* ── Socket: reconnect ───────────────────────────────────────────────────── */
function applyFullState(data) {
  myName        = data.name;
  myRole        = data.role;
  isHost        = data.isHost;
  sessionPhase  = data.phase;
  if (data.question) confirmedQuestion = data.question;

  const saved = loadSession();
  if (saved) saveSession({ ...saved, sessionId: data.sessionId, role: data.role });

  const phase = data.phase;

  if (phase === 'registration' || phase === 'question-setting') {
    if (isHost) {
      const inp = document.getElementById('input-question');
      if (inp && !inp.value) inp.value = data.question || '';
      showScreen('question-setting');
    } else {
      updatePlayerWaitingCount(data.players);
      showScreen('player-waiting');
    }
    return;
  }
  if (phase === 'submission') {
    showSubmissionScreen(data.submitted);
    if (isHost && data.players) {
      renderHostSubPanel(
        data.players.filter(p => p.submitted),
        data.players.filter(p => !p.submitted)
      );
    }
    return;
  }
  if (phase === 'voting') {
    hasVoted = data.hasVoted || false;
    showVotingScreen(data);
    return;
  }
  if (phase === 'reveal') {
    showRevealScreen(data);
    if (data.revealPaused) {
      setRevealPausedState(true, data.revealRemainingMs);
      if (isHost) {
        document.getElementById('btn-pause-reveal').style.display  = 'none';
        document.getElementById('btn-resume-reveal').style.display = '';
      }
    } else {
      startRevealTimer(data.revealTimerEnd);
      if (isHost) resetRevealHostButtons();
    }
    return;
  }
  if (phase === 'between') {
    showScreen('between');
    document.getElementById('between-host-controls').style.display = isHost ? 'block' : 'none';
    startBetweenCountdown();
    return;
  }
  if (phase === 'leaderboard') {
    showScreen('leaderboard');
    renderLeaderboard(data.ranked, data.noSubmissions);
    return;
  }
  showScreen('registration');
}

socket.on('reconnect_success', (data) => {
  reconnecting = false;
  applyFullState(data);
});

socket.on('reconnect_failed', () => {
  reconnecting = false;
  clearSession();
  if (pendingInitData) processInit(pendingInitData);
});

/* ── Socket: host status ─────────────────────────────────────────────────── */
socket.on('host_claimed', () => { hostTaken = true;  updateHostButton(true);  });
socket.on('host_left',    () => { hostTaken = false; updateHostButton(false); });

socket.on('host_denied', () => {
  alert('Host role is already taken.');
  selectRole('player');
});

socket.on('session_locked', () => showScreen('holding'));

socket.on('session_reset', ({ oldSessionId }) => {
  const saved = loadSession();
  if (saved && saved.sessionId === oldSessionId) clearSession();
  location.reload();
});

/* ── Host disconnect / promotion ─────────────────────────────────────────── */
socket.on('host_disconnecting', () => {
  showHostDisconnectBanner();
});

socket.on('host_reconnected', () => {
  hideHostDisconnectBanner();
});

socket.on('host_changed', ({ newHostName }) => {
  hideHostDisconnectBanner();
  // Light, non-blocking toast via banner re-use
  const banner = document.getElementById('host-disconnect-banner');
  banner.textContent = `${newHostName} is now the Host`;
  banner.style.background = 'var(--accent2)';
  banner.style.color = '#1a2e35';
  banner.style.display = 'block';
  setTimeout(() => {
    banner.style.display = 'none';
    banner.textContent = 'Host disconnected — reassigning…';
    banner.style.background = '';
    banner.style.color = '';
  }, 3500);
});

socket.on('promoted_to_host', (data) => {
  hideHostDisconnectBanner();
  // Treat as a full state restore — same machinery as reconnect_success
  applyFullState(data);
  // Brief notification
  const banner = document.getElementById('host-disconnect-banner');
  banner.textContent = "You're now the Host";
  banner.style.background = 'var(--accent)';
  banner.style.color = '#1a2e35';
  banner.style.display = 'block';
  setTimeout(() => {
    banner.style.display = 'none';
    banner.textContent = 'Host disconnected — reassigning…';
    banner.style.background = '';
    banner.style.color = '';
  }, 3500);
});

/* ── Socket: joined ──────────────────────────────────────────────────────── */
socket.on('joined', ({ role, name, sessionId, token, phase, question, questionConfirmed }) => {
  isHost   = role === 'host';
  myRole   = role;
  myName   = name;
  sessionPhase = phase;

  saveSession({ token, sessionId, name, role });

  if (questionConfirmed && question) confirmedQuestion = question;

  if (role === 'host') {
    const inp = document.getElementById('input-question');
    if (inp && !inp.value) inp.value = question || '';
    showScreen('question-setting');
  } else {
    if (questionConfirmed) showSubmissionScreen(false);
    else                   showScreen('player-waiting');
  }
});

/* ── Socket: lobby update ────────────────────────────────────────────────── */
socket.on('lobby_update', ({ players, hostTaken: ht, phase }) => {
  hostTaken = ht;
  updateHostButton(ht);
  if (phase === 'registration') renderRegPlayers(players);
  if (!isHost) updatePlayerWaitingCount(players);
});

/* ── Socket: question confirmed ──────────────────────────────────────────── */
socket.on('question_confirmed', ({ question }) => {
  confirmedQuestion = question;
  sessionPhase = 'submission';
  showSubmissionScreen(false);
});

/* ── Socket: submission update ───────────────────────────────────────────── */
socket.on('submission_update', ({ players, submitted, waiting }) => {
  if (sessionPhase !== 'submission') return;
  if (isHost) {
    renderHostSubPanel(submitted, waiting);
  } else {
    document.getElementById('sub-wait-msg').textContent =
      `${submitted.length} of ${players.length} people have submitted. Waiting for the host to start…`;
  }
});

/* ── Socket: voting ──────────────────────────────────────────────────────── */
socket.on('voting_round', (data) => {
  hasVoted = false;
  if (data.question) confirmedQuestion = data.question;
  showVotingScreen({ ...data, votedCount: 0 });
});

socket.on('vote_update', ({ votedCount, total }) => {
  document.getElementById('vote-counter').textContent = `${votedCount} of ${total} voted`;
});

/* ── Socket: reveal ──────────────────────────────────────────────────────── */
socket.on('reveal', (data) => {
  if (data.question) confirmedQuestion = data.question;
  showRevealScreen(data);
  startRevealTimer(data.revealTimerEnd);
  if (isHost) resetRevealHostButtons();
});

socket.on('reveal_paused', ({ remainingMs }) => {
  setRevealPausedState(true, remainingMs);
  if (isHost) {
    document.getElementById('btn-pause-reveal').style.display  = 'none';
    document.getElementById('btn-resume-reveal').style.display = '';
  }
});

socket.on('reveal_resumed', ({ revealTimerEnd }) => {
  startRevealTimer(revealTimerEnd);
  if (isHost) resetRevealHostButtons();
});

/* ── Socket: between rounds ──────────────────────────────────────────────── */
socket.on('between_rounds', () => {
  clearInterval(revealTimerInterval);
  showScreen('between');
  document.getElementById('between-host-controls').style.display = isHost ? 'block' : 'none';
  startBetweenCountdown();
});

/* ── Socket: leaderboard ─────────────────────────────────────────────────── */
socket.on('leaderboard', ({ ranked, noSubmissions }) => {
  sessionPhase = 'leaderboard';
  clearInterval(timerInterval);
  clearInterval(revealTimerInterval);
  clearInterval(betweenInterval);
  showScreen('leaderboard');
  renderLeaderboard(ranked, noSubmissions);
});

/* ── Local helpers ───────────────────────────────────────────────────────── */
function updateHostButton(taken) {
  const btn  = document.getElementById('btn-role-host');
  const note = document.getElementById('host-note');
  if (!btn) return;
  btn.disabled = taken;
  if (note) note.textContent = taken ? 'Already taken' : 'Run the session';
  if (taken && myRole === 'host') selectRole('player');
}

function renderRegPlayers(players) {
  const card = document.getElementById('waiting-players-card');
  const list = document.getElementById('reg-player-list');
  if (!card || !list) return;
  if (players.length === 0) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  list.innerHTML = '';
  players.forEach(p => list.appendChild(renderPlayerChip(p, '')));
}

function updatePlayerWaitingCount(players) {
  const el = document.getElementById('player-waiting-count');
  if (!el || !players) return;
  const n = players.length;
  el.textContent = n > 0 ? `${n} ${n === 1 ? 'person' : 'people'} here so far` : '';
}

/* ── Enter key support ───────────────────────────────────────────────────── */
document.getElementById('input-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') joinSession();
});
document.getElementById('input-activity').addEventListener('keydown', e => {
  if (e.key === 'Enter') submitActivity();
});
document.getElementById('input-question').addEventListener('keydown', e => {
  if (e.key === 'Enter') confirmQuestion();
});
