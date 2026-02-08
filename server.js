const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ─── CONFIG ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const TIMER_QUESTION = 60;   // seconds to write a question
const TIMER_ANSWER = 60;     // seconds to write an answer
const TIMER_PER_PLAYER = 30; // seconds per player for guessing
const ROUNDS = 3;            // each player guesses this many times

// ─── GAME STATE ────────────────────────────────────────────────────
const lobbies = new Map(); // lobbyCode -> LobbyState

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
    phase: 'lobby', // lobby | question | answering | reveal | guessing | results | gameover
    currentRound: 0,       // 0-indexed round
    currentGuesserIdx: 0,  // index in guesser order
    guesserOrder: [],       // player IDs in rotation order
    roundNumber: 0,         // which rotation we're on (0 to ROUNDS-1)
    currentQuestion: '',
    answers: new Map(),     // playerId -> answer text
    revealIndex: 0,         // which answer is being revealed
    guesses: new Map(),     // answerId -> guessed playerId
    timer: null,
    timerEnd: null,
    votes: { best: new Map(), funniest: new Map() }, // playerId -> votedAnswerId
    shuffledAnswers: [],    // [{id, text, playerId}] shuffled for display
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
  // Build guesser order: each player guesses ROUNDS times
  const playerIds = lobby.players.map(p => p.id);
  lobby.guesserOrder = [];
  for (let r = 0; r < ROUNDS; r++) {
    lobby.guesserOrder.push(...shuffleArray(playerIds));
  }
  lobby.currentGuesserIdx = 0;
  lobby.roundNumber = 0;
  // Reset scores
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
    // Time's up — if no question, use a default
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
    // Fill in blanks for anyone who didn't answer
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
  // Shuffle answers so guesser can't tell by order
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

  // Send first answer
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

  // Send all answers (without playerIds) and player list
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
    // Time's up, score whatever they have
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
  // Count votes for best and funniest
  const bestCounts = new Map();
  const funniestCounts = new Map();

  for (const [, answerId] of lobby.votes.best) {
    bestCounts.set(answerId, (bestCounts.get(answerId) || 0) + 1);
  }
  for (const [, answerId] of lobby.votes.funniest) {
    funniestCounts.set(answerId, (funniestCounts.get(answerId) || 0) + 1);
  }

  // Find winners
  let bestAnswerId = null, bestMax = 0;
  for (const [id, count] of bestCounts) {
    if (count > bestMax) { bestMax = count; bestAnswerId = id; }
  }
  let funniestAnswerId = null, funniestMax = 0;
  for (const [id, count] of funniestCounts) {
    if (count > funniestMax) { funniestMax = count; funniestAnswerId = id; }
  }

  // Award bonus points
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

  // Award points: 1 per correct guess
  guesser.score += correct;

  // Move to voting phase
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
    // Game over!
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

// ─── WEBSOCKET SERVER ──────────────────────────────────────────────
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
      sendTo(ws, { type: 'joined', playerId: id, lobbyCode: lobby.code, isHost: true });
      broadcastLobbyState(lobby);
      break;
    }

    case 'join_lobby': {
      const code = (msg.code || '').toUpperCase().trim();
      const lobby = lobbies.get(code);
      if (!lobby) {
        sendTo(ws, { type: 'error', message: 'Lobby not found' });
        return;
      }
      if (lobby.phase !== 'lobby') {
        sendTo(ws, { type: 'error', message: 'Game already in progress' });
        return;
      }
      if (lobby.players.length >= 10) {
        sendTo(ws, { type: 'error', message: 'Lobby is full (max 10)' });
        return;
      }
      const id = generateId();
      const name = (msg.name || 'Player').slice(0, 20);
      lobby.players.push({ id, name, score: 0, connected: true });
      clients.set(ws, { id, lobbyCode: code, name });
      sendTo(ws, { type: 'joined', playerId: id, lobbyCode: code, isHost: false });
      broadcastLobbyState(lobby);
      break;
    }

    case 'start_game': {
      if (!client) return;
      const lobby = lobbies.get(client.lobbyCode);
      if (!lobby || lobby.hostId !== client.id) return;
      if (lobby.players.length < 3) {
        sendTo(ws, { type: 'error', message: 'Need at least 3 players' });
        return;
      }
      startGame(lobby);
      break;
    }

    case 'submit_question': {
      if (!client) return;
      const lobby = lobbies.get(client.lobbyCode);
      if (!lobby || lobby.phase !== 'question') return;
      const guesser = getGuesser(lobby);
      if (guesser.id !== client.id) return;
      lobby.currentQuestion = (msg.question || '').slice(0, 200);
      clearTimer(lobby);
      startAnswerPhase(lobby);
      break;
    }

    case 'submit_answer': {
      if (!client) return;
      const lobby = lobbies.get(client.lobbyCode);
      if (!lobby || lobby.phase !== 'answering') return;
      const guesserId = getGuesser(lobby).id;
      if (client.id === guesserId) return; // guesser can't answer
      lobby.answers.set(client.id, (msg.answer || '').slice(0, 300));
      sendTo(ws, { type: 'answer_submitted' });

      // Check if all answerers have submitted
      const answerers = getAnswerers(lobby);
      if (answerers.every(p => lobby.answers.has(p.id))) {
        clearTimer(lobby);
        startRevealPhase(lobby);
      } else {
        // Let everyone know progress
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
        // All revealed, move to guessing
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
      // msg.guesses = { answerId: playerId, ... }
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

      // Check if all players voted for both
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

// ─── RAW WEBSOCKET IMPLEMENTATION ──────────────────────────────────
function acceptWebSocket(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-5AB5A04DF50A')
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n` +
    '\r\n'
  );

  // Minimal WS framing
  const ws = {
    readyState: 1,
    send(data) {
      if (ws.readyState !== 1) return;
      const buf = Buffer.from(data);
      let header;
      if (buf.length < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x81;
        header[1] = buf.length;
      } else if (buf.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(buf.length, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(buf.length), 2);
      }
      try { socket.write(Buffer.concat([header, buf])); } catch {}
    },
    close() {
      ws.readyState = 3;
      try {
        const buf = Buffer.alloc(2);
        buf[0] = 0x88;
        buf[1] = 0;
        socket.write(buf);
        socket.end();
      } catch {}
    }
  };

  let buffer = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 2) {
      const firstByte = buffer[0];
      const opcode = firstByte & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let payloadLen = buffer[1] & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (buffer.length < 4) return;
        payloadLen = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buffer.length < 10) return;
        payloadLen = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskSize = masked ? 4 : 0;
      const totalLen = offset + maskSize + payloadLen;
      if (buffer.length < totalLen) return;

      let payload = buffer.slice(offset + maskSize, totalLen);
      if (masked) {
        const mask = buffer.slice(offset, offset + 4);
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= mask[i % 4];
        }
      }

      buffer = buffer.slice(totalLen);

      if (opcode === 0x08) {
        // Close
        ws.readyState = 3;
        handleDisconnect(ws);
        socket.end();
        return;
      } else if (opcode === 0x09) {
        // Ping -> Pong
        const pong = Buffer.alloc(2);
        pong[0] = 0x8A;
        pong[1] = 0;
        try { socket.write(pong); } catch {}
      } else if (opcode === 0x01) {
        // Text
        handleMessage(ws, payload.toString('utf8'));
      }
    }
  });

  socket.on('close', () => {
    ws.readyState = 3;
    handleDisconnect(ws);
  });

  socket.on('error', () => {
    ws.readyState = 3;
    handleDisconnect(ws);
  });

  return ws;
}

function handleDisconnect(ws) {
  const client = clients.get(ws);
  if (client) {
    const lobby = lobbies.get(client.lobbyCode);
    if (lobby) {
      const player = lobby.players.find(p => p.id === client.id);
      if (player) player.connected = false;
      broadcastLobbyState(lobby);

      // Clean up empty lobbies
      if (lobby.players.every(p => !p.connected)) {
        clearTimer(lobby);
        lobbies.delete(lobby.code);
      }
    }
    clients.delete(ws);
  }
}

// ─── HTTP SERVER ───────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync(path.join(__dirname, 'client', 'index.html')));
  } else if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', lobbies: lobbies.size }));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.on('upgrade', (req, socket, head) => {
  if (req.headers.upgrade?.toLowerCase() === 'websocket') {
    const ws = acceptWebSocket(req, socket);
    // ws is now tracked in handleMessage when they join/create
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`\n  🎮  WhoDat? Game Server running at http://localhost:${PORT}\n`);
});
