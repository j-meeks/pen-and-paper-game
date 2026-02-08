const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// ─── CONFIG ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const TIMER_QUESTION = 60;
const TIMER_ANSWER = 60;
const TIMER_PER_PLAYER = 30;
const ROUNDS = 3;

// ─── RESOLVE CLIENT HTML FIRST ─────────────────────────────────────
const possiblePaths = [
  path.join(__dirname, 'client', 'index.html'),
  path.join(__dirname, 'index.html'),
  path.join(process.cwd(), 'client', 'index.html'),
  path.join(process.cwd(), 'index.html'),
];

let clientHtml = null;
for (const p of possiblePaths) {
  if (fs.existsSync(p)) {
    clientHtml = fs.readFileSync(p, 'utf8');
    console.log(`  ✔ Found client at: ${p}`);
    break;
  }
}

if (!clientHtml) {
  console.error('\n  ❌ Could not find index.html!');
  console.error('  Make sure your folder looks like this:\n');
  console.error('    your-folder/');
  console.error('    ├── server.js');
  console.error('    └── client/');
  console.error('        └── index.html\n');
  process.exit(1);
}

// ─── GAME STATE ────────────────────────────────────────────────────
const lobbies = new Map();

function generateLobbyCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return lobbies.has(code) ? generateLobbyCode() : code;
}

function generateId() {
  return crypto.randomBytes(8).toString('hex');
}

function createLobby(hostId, hostName) {
  const code = generateLobbyCode();
  const lobby = {
    code,
    hostId,
    players: [{ id: hostId, name: hostName, score: 0, connected: true }],
    phase: 'lobby',
    currentGuesserIdx: 0,
    guesserOrder: [],
    currentQuestion: '',
    answers: new Map(),
    revealIndex: 0,
    guesses: new Map(),
    timer: null,
    timerEnd: null,
    votes: { best: new Map(), funniest: new Map() },
    shuffledAnswers: [],
    guessResults: null,
  };
  lobbies.set(code, lobby);
  return lobby;
}

function getGuesser(lobby) {
  const id = lobby.guesserOrder[lobby.currentGuesserIdx];
  return lobby.players.find(p => p.id === id);
}

function getAnswerers(lobby) {
  const guesserId = lobby.guesserOrder[lobby.currentGuesserIdx];
  return lobby.players.filter(p => p.id !== guesserId);
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── TIMER HELPERS ─────────────────────────────────────────────────
function startTimer(lobby, seconds, callback) {
  clearTimer(lobby);
  lobby.timerEnd = Date.now() + seconds * 1000;
  lobby.timer = setTimeout(() => {
    lobby.timer = null;
    lobby.timerEnd = null;
    callback();
  }, seconds * 1000);
  broadcastToLobby(lobby, { type: 'timer', seconds, endsAt: lobby.timerEnd });
}

function clearTimer(lobby) {
  if (lobby.timer) {
    clearTimeout(lobby.timer);
    lobby.timer = null;
    lobby.timerEnd = null;
  }
}

// ─── PHASE TRANSITIONS ────────────────────────────────────────────
function startGame(lobby) {
  const playerIds = lobby.players.map(p => p.id);
  lobby.guesserOrder = [];
  for (let r = 0; r < ROUNDS; r++) {
    lobby.guesserOrder.push(...shuffleArray(playerIds));
  }
  lobby.currentGuesserIdx = 0;
  lobby.players.forEach(p => p.score = 0);
  startQuestionPhase(lobby);
}

function startQuestionPhase(lobby) {
  lobby.phase = 'question';
  lobby.currentQuestion = '';
  lobby.answers = new Map();
  lobby.guesses = new Map();
  lobby.votes = { best: new Map(), funniest: new Map() };
  lobby.shuffledAnswers = [];
  lobby.revealIndex = 0;
  lobby.guessResults = null;

  const guesser = getGuesser(lobby);
  const turnNumber = lobby.currentGuesserIdx + 1;
  const totalTurns = lobby.guesserOrder.length;

  broadcastToLobby(lobby, {
    type: 'phase',
    phase: 'question',
    guesser: { id: guesser.id, name: guesser.name },
    turnNumber,
    totalTurns,
    roundNumber: Math.floor(lobby.currentGuesserIdx / lobby.players.length) + 1,
    totalRounds: ROUNDS,
  });

  startTimer(lobby, TIMER_QUESTION, () => {
    if (!lobby.currentQuestion) {
      lobby.currentQuestion = "What's the best thing about being alive?";
    }
    startAnswerPhase(lobby);
  });
}

function startAnswerPhase(lobby) {
  lobby.phase = 'answering';
  broadcastToLobby(lobby, {
    type: 'phase',
    phase: 'answering',
    question: lobby.currentQuestion,
    guesser: { id: getGuesser(lobby).id, name: getGuesser(lobby).name },
  });

  startTimer(lobby, TIMER_ANSWER, () => {
    const answerers = getAnswerers(lobby);
    answerers.forEach(p => {
      if (!lobby.answers.has(p.id)) {
        lobby.answers.set(p.id, '...');
      }
    });
    startRevealPhase(lobby);
  });
}

function startRevealPhase(lobby) {
  const entries = [];
  for (const [playerId, text] of lobby.answers) {
    entries.push({ id: generateId(), text, playerId });
  }
  lobby.shuffledAnswers = shuffleArray(entries);
  lobby.revealIndex = 0;
  lobby.phase = 'reveal';

  broadcastToLobby(lobby, {
    type: 'phase',
    phase: 'reveal',
    question: lobby.currentQuestion,
    totalAnswers: lobby.shuffledAnswers.length,
    guesser: { id: getGuesser(lobby).id, name: getGuesser(lobby).name },
  });

  sendRevealAnswer(lobby);
}

function sendRevealAnswer(lobby) {
  if (lobby.revealIndex < lobby.shuffledAnswers.length) {
    const answer = lobby.shuffledAnswers[lobby.revealIndex];
    broadcastToLobby(lobby, {
      type: 'reveal_answer',
      index: lobby.revealIndex,
      total: lobby.shuffledAnswers.length,
      answer: { id: answer.id, text: answer.text },
    });
  }
}

function startGuessingPhase(lobby) {
  lobby.phase = 'guessing';
  const answerers = getAnswerers(lobby);
  const timerSeconds = TIMER_PER_PLAYER * answerers.length;

  const answers = lobby.shuffledAnswers.map(a => ({ id: a.id, text: a.text }));
  const players = answerers.map(p => ({ id: p.id, name: p.name }));

  broadcastToLobby(lobby, {
    type: 'phase',
    phase: 'guessing',
    question: lobby.currentQuestion,
    answers,
    players,
    guesser: { id: getGuesser(lobby).id, name: getGuesser(lobby).name },
  });

  startTimer(lobby, timerSeconds, () => {
    scoreGuesses(lobby);
  });
}

function startVotingPhase(lobby) {
  lobby.phase = 'voting';
  const answers = lobby.shuffledAnswers.map(a => ({ id: a.id, text: a.text }));
  const guesserId = getGuesser(lobby).id;

  broadcastToLobby(lobby, {
    type: 'phase',
    phase: 'voting',
    question: lobby.currentQuestion,
    answers,
    guesser: { id: guesserId, name: getGuesser(lobby).name },
  });

  startTimer(lobby, 20, () => {
    tallyVotes(lobby);
  });
}

function tallyVotes(lobby) {
  const bestCounts = new Map();
  const funniestCounts = new Map();

  for (const [, answerId] of lobby.votes.best) {
    bestCounts.set(answerId, (bestCounts.get(answerId) || 0) + 1);
  }
  for (const [, answerId] of lobby.votes.funniest) {
    funniestCounts.set(answerId, (funniestCounts.get(answerId) || 0) + 1);
  }

  let bestAnswerId = null, bestMax = 0;
  for (const [id, count] of bestCounts) {
    if (count > bestMax) { bestMax = count; bestAnswerId = id; }
  }
  let funniestAnswerId = null, funniestMax = 0;
  for (const [id, count] of funniestCounts) {
    if (count > funniestMax) { funniestMax = count; funniestAnswerId = id; }
  }

  if (bestAnswerId) {
    const answer = lobby.shuffledAnswers.find(a => a.id === bestAnswerId);
    if (answer) {
      const player = lobby.players.find(p => p.id === answer.playerId);
      if (player) player.score += 1;
    }
  }
  if (funniestAnswerId) {
    const answer = lobby.shuffledAnswers.find(a => a.id === funniestAnswerId);
    if (answer) {
      const player = lobby.players.find(p => p.id === answer.playerId);
      if (player) player.score += 1;
    }
  }

  showResults(lobby, bestAnswerId, funniestAnswerId);
}

function scoreGuesses(lobby) {
  const guesser = getGuesser(lobby);
  let correct = 0;
  const results = [];

  for (const answer of lobby.shuffledAnswers) {
    const guessedPlayerId = lobby.guesses.get(answer.id);
    const actualPlayer = lobby.players.find(p => p.id === answer.playerId);
    const guessedPlayer = lobby.players.find(p => p.id === guessedPlayerId);
    const isCorrect = guessedPlayerId === answer.playerId;
    if (isCorrect) correct++;

    results.push({
      answerId: answer.id,
      answerText: answer.text,
      actualPlayer: { id: actualPlayer.id, name: actualPlayer.name },
      guessedPlayer: guessedPlayer ? { id: guessedPlayer.id, name: guessedPlayer.name } : null,
      correct: isCorrect,
    });
  }

  guesser.score += correct;
  lobby.guessResults = { correct, total: lobby.shuffledAnswers.length, results };
  startVotingPhase(lobby);
}

function showResults(lobby, bestAnswerId, funniestAnswerId) {
  lobby.phase = 'results';

  const bestAnswer = lobby.shuffledAnswers.find(a => a.id === bestAnswerId);
  const funniestAnswer = lobby.shuffledAnswers.find(a => a.id === funniestAnswerId);

  broadcastToLobby(lobby, {
    type: 'phase',
    phase: 'results',
    guessResults: lobby.guessResults,
    bestAnswer: bestAnswer ? {
      text: bestAnswer.text,
      player: lobby.players.find(p => p.id === bestAnswer.playerId)?.name,
    } : null,
    funniestAnswer: funniestAnswer ? {
      text: funniestAnswer.text,
      player: lobby.players.find(p => p.id === funniestAnswer.playerId)?.name,
    } : null,
    scoreboard: lobby.players.map(p => ({ id: p.id, name: p.name, score: p.score }))
      .sort((a, b) => b.score - a.score),
  });
}

function nextTurn(lobby) {
  lobby.currentGuesserIdx++;
  if (lobby.currentGuesserIdx >= lobby.guesserOrder.length) {
    lobby.phase = 'gameover';
    broadcastToLobby(lobby, {
      type: 'phase',
      phase: 'gameover',
      scoreboard: lobby.players.map(p => ({ id: p.id, name: p.name, score: p.score }))
        .sort((a, b) => b.score - a.score),
    });
  } else {
    startQuestionPhase(lobby);
  }
}

// ─── WEBSOCKET ─────────────────────────────────────────────────────
const clients = new Map(); // ws -> { id, lobbyCode, name }

function broadcastToLobby(lobby, msg) {
  const data = JSON.stringify(msg);
  for (const [ws, client] of clients) {
    if (client.lobbyCode === lobby.code && ws.readyState === 1) {
      ws.send(data);
    }
  }
}

function sendTo(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcastLobbyState(lobby) {
  broadcastToLobby(lobby, {
    type: 'lobby_update',
    players: lobby.players.map(p => ({ id: p.id, name: p.name, score: p.score, connected: p.connected })),
    hostId: lobby.hostId,
    code: lobby.code,
  });
}

function handleDisconnect(ws) {
  const client = clients.get(ws);
  if (client) {
    console.log(`  ← Player ${client.name} disconnected`);
    const lobby = lobbies.get(client.lobbyCode);
    if (lobby) {
      const player = lobby.players.find(p => p.id === client.id);
      if (player) player.connected = false;
      broadcastLobbyState(lobby);
      if (lobby.players.every(p => !p.connected)) {
        clearTimer(lobby);
        lobbies.delete(lobby.code);
        console.log(`  🗑  Lobby ${lobby.code} removed (empty)`);
      }
    }
    clients.delete(ws);
  }
}

// ─── MESSAGE HANDLER ───────────────────────────────────────────────
function handleMessage(ws, data) {
  let msg;
  try { msg = JSON.parse(data); } catch { return; }

  const client = clients.get(ws);

  switch (msg.type) {
    case 'create_lobby': {
      const id = generateId();
      const name = (msg.name || 'Player').slice(0, 20);
      const lobby = createLobby(id, name);
      clients.set(ws, { id, lobbyCode: lobby.code, name });
      console.log(`  + ${name} created lobby ${lobby.code}`);
      sendTo(ws, { type: 'joined', playerId: id, lobbyCode: lobby.code, isHost: true });
      broadcastLobbyState(lobby);
      break;
    }

    case 'join_lobby': {
      const code = (msg.code || '').toUpperCase().trim();
      const lobby = lobbies.get(code);
      if (!lobby) return sendTo(ws, { type: 'error', message: 'Lobby not found' });
      if (lobby.phase !== 'lobby') return sendTo(ws, { type: 'error', message: 'Game already in progress' });
      if (lobby.players.length >= 10) return sendTo(ws, { type: 'error', message: 'Lobby is full (max 10)' });

      const id = generateId();
      const name = (msg.name || 'Player').slice(0, 20);
      lobby.players.push({ id, name, score: 0, connected: true });
      clients.set(ws, { id, lobbyCode: code, name });
      console.log(`  + ${name} joined lobby ${code}`);
      sendTo(ws, { type: 'joined', playerId: id, lobbyCode: code, isHost: false });
      broadcastLobbyState(lobby);
      break;
    }

    case 'start_game': {
      if (!client) return;
      const lobby = lobbies.get(client.lobbyCode);
      if (!lobby || lobby.hostId !== client.id) return;
      if (lobby.players.length < 3) return sendTo(ws, { type: 'error', message: 'Need at least 3 players' });
      console.log(`  ▶ Game started in lobby ${lobby.code} with ${lobby.players.length} players`);
      startGame(lobby);
      break;
    }

    case 'submit_question': {
      if (!client) return;
      const lobby = lobbies.get(client.lobbyCode);
      if (!lobby || lobby.phase !== 'question') return;
      if (getGuesser(lobby).id !== client.id) return;
      lobby.currentQuestion = (msg.question || '').slice(0, 200);
      clearTimer(lobby);
      startAnswerPhase(lobby);
      break;
    }

    case 'submit_answer': {
      if (!client) return;
      const lobby = lobbies.get(client.lobbyCode);
      if (!lobby || lobby.phase !== 'answering') return;
      if (client.id === getGuesser(lobby).id) return;
      lobby.answers.set(client.id, (msg.answer || '').slice(0, 300));
      sendTo(ws, { type: 'answer_submitted' });

      const answerers = getAnswerers(lobby);
      if (answerers.every(p => lobby.answers.has(p.id))) {
        clearTimer(lobby);
        startRevealPhase(lobby);
      } else {
        broadcastToLobby(lobby, {
          type: 'answer_progress',
          submitted: lobby.answers.size,
          total: answerers.length,
        });
      }
      break;
    }

    case 'next_reveal': {
      if (!client) return;
      const lobby = lobbies.get(client.lobbyCode);
      if (!lobby || lobby.phase !== 'reveal') return;
      if (getGuesser(lobby).id !== client.id) return;
      lobby.revealIndex++;
      if (lobby.revealIndex >= lobby.shuffledAnswers.length) {
        startGuessingPhase(lobby);
      } else {
        sendRevealAnswer(lobby);
      }
      break;
    }

    case 'submit_guesses': {
      if (!client) return;
      const lobby = lobbies.get(client.lobbyCode);
      if (!lobby || lobby.phase !== 'guessing') return;
      if (getGuesser(lobby).id !== client.id) return;
      lobby.guesses = new Map(Object.entries(msg.guesses || {}));
      clearTimer(lobby);
      scoreGuesses(lobby);
      break;
    }

    case 'vote': {
      if (!client) return;
      const lobby = lobbies.get(client.lobbyCode);
      if (!lobby || lobby.phase !== 'voting') return;
      if (msg.category === 'best' && msg.answerId) {
        lobby.votes.best.set(client.id, msg.answerId);
      }
      if (msg.category === 'funniest' && msg.answerId) {
        lobby.votes.funniest.set(client.id, msg.answerId);
      }
      const allVoted = lobby.players.every(p =>
        lobby.votes.best.has(p.id) && lobby.votes.funniest.has(p.id)
      );
      if (allVoted) {
        clearTimer(lobby);
        tallyVotes(lobby);
      }
      break;
    }

    case 'next_turn': {
      if (!client) return;
      const lobby = lobbies.get(client.lobbyCode);
      if (!lobby || lobby.phase !== 'results') return;
      if (lobby.hostId !== client.id) return;
      nextTurn(lobby);
      break;
    }

    case 'play_again': {
      if (!client) return;
      const lobby = lobbies.get(client.lobbyCode);
      if (!lobby || lobby.hostId !== client.id) return;
      lobby.phase = 'lobby';
      lobby.players.forEach(p => p.score = 0);
      broadcastToLobby(lobby, { type: 'phase', phase: 'lobby' });
      broadcastLobbyState(lobby);
      break;
    }
  }
}

// ─── HTTP SERVER ───────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(clientHtml);
  } else if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', lobbies: lobbies.size }));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// ─── WEBSOCKET SERVER (using ws package) ───────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('  ✔ New WebSocket connection');

  ws.on('message', (data) => {
    handleMessage(ws, data.toString());
  });

  ws.on('close', () => {
    handleDisconnect(ws);
  });

  ws.on('error', (err) => {
    console.error('  ❌ WS error:', err.message);
    handleDisconnect(ws);
  });
});

// ─── START ─────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log('');
  console.log('  🎮  WhoDat? Game Server');
  console.log(`  🌐  http://localhost:${PORT}`);
  console.log('  📋  Share the lobby code with friends on your network');
  console.log('');
});