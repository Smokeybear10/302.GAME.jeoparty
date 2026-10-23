'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { io: createClient } = require('socket.io-client');
const { loadGames } = require('../lib/game-store');
const { createJeopardyServer } = require('../server');

function emitAck(socket, eventName, payload = {}) {
  return new Promise((resolve, reject) => {
    socket.timeout(3000).emit(eventName, payload, (timeoutError, response) => {
      if (timeoutError) return reject(timeoutError);
      if (!response?.ok) {
        const error = new Error(response?.error?.message || 'Socket action failed');
        error.code = response?.error?.code;
        return reject(error);
      }
      resolve(response);
    });
  });
}

function nextState(socket, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('room:state', onState);
      reject(new Error('Timed out waiting for room state'));
    }, 3000);
    function onState(state) {
      if (!predicate(state)) return;
      clearTimeout(timeout);
      socket.off('room:state', onState);
      resolve(state);
    }
    socket.on('room:state', onState);
  });
}

test('retired party links lead home and party assets and APIs are unavailable', async (context) => {
  const server = createJeopardyServer({ games: loadGames(), logger: { error() {} } });
  const address = await server.start(0, '127.0.0.1');
  context.after(() => server.stop());
  const origin = `http://127.0.0.1:${address.port}`;

  for (const path of ['/party', '/party/', '/party.html', '/party?board=business&version=old']) {
    const response = await fetch(`${origin}${path}`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/');
  }
  for (const path of ['/api/party/games', '/api/party/games/business', '/api/party/random', '/party.js', '/party-state.js', '/party.css']) {
    assert.equal((await fetch(`${origin}${path}`)).status, 404);
  }
  for (const path of ['/', '/practice']) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200);
    assert.doesNotMatch(await response.text(), /href=["']\/party(?:["'?/])/);
  }
});

test('HTTP and Socket.IO clients can host, join, start, and buzz without leaking answers', async (context) => {
  const games = loadGames();
  const jeopardy = createJeopardyServer({ games, logger: { error() {} } });
  const address = await jeopardy.start(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${address.port}`;
  const host = createClient(origin, { transports: ['websocket'], forceNew: true });
  const player = createClient(origin, { transports: ['websocket'], forceNew: true });

  context.after(async () => {
    host.disconnect();
    player.disconnect();
    await jeopardy.stop();
  });

  const health = await fetch(`${origin}/health`).then((response) => response.json());
  assert.deepEqual(health, { ok: true, games: 20, rooms: 0 });
  assert.equal((await fetch(`${origin}/data/games/set-a.json`)).status, 404);
  assert.equal((await fetch(`${origin}/games.js`)).status, 404);

  const created = await emitAck(host, 'room:create');
  assert.equal(created.state.role, 'host');
  const hostSawJoin = nextState(host, (state) => state.players.length === 1);
  const joined = await emitAck(player, 'room:join', { code: created.session.code, name: 'Jordan' });
  assert.equal(joined.state.role, 'player');
  await hostSawJoin;

  const playerSawBoard = nextState(player, (state) => state.phase === 'board');
  await emitAck(host, 'host:start-game', { gameId: games[0].id });
  await playerSawBoard;

  let location;
  games[0].categories.some((category, categoryIndex) => category.clues.some((clue, clueIndex) => {
    if (clue.dailyDouble) return false;
    location = { categoryIndex, clueIndex, clue };
    return true;
  }));

  const playerSawClue = nextState(player, (state) => Boolean(state.currentClue));
  const hostSawClue = nextState(host, (state) => Boolean(state.currentClue));
  await emitAck(host, 'host:open-clue', location);
  const [playerClueState, hostClueState] = await Promise.all([playerSawClue, hostSawClue]);
  assert.equal(playerClueState.currentClue.question, location.clue.clue);
  assert.equal(Object.hasOwn(playerClueState.currentClue, 'answer'), false);
  assert.equal(Object.hasOwn(playerClueState.currentClue, 'privateAnswer'), false);
  assert.equal(Object.hasOwn(hostClueState.currentClue, 'answer'), false);
  assert.equal(Object.hasOwn(hostClueState.currentClue, 'privateAnswer'), false);

  const hostSawBuzz = nextState(host, (state) => state.currentClue?.buzzes.length === 1);
  await emitAck(player, 'player:buzz');
  const buzzState = await hostSawBuzz;
  assert.equal(buzzState.currentClue.buzzes[0].name, 'Jordan');
  const clueKey = buzzState.currentClue.clueKey;
  await assert.rejects(
    emitAck(host, 'player:open-answer', { clueKey }),
    (error) => error.code === 'CONTESTANT_ONLY',
  );

  const hostSawChecking = nextState(host, (state) => state.currentClue?.selfJudgePlayerId === joined.session.playerId);
  const playerSawPrivateAnswer = nextState(player, (state) => state.currentClue?.privateAnswer === location.clue.answer);
  await emitAck(player, 'player:open-answer', { clueKey });
  const [checkingHostState, privatePlayerState] = await Promise.all([hostSawChecking, playerSawPrivateAnswer]);
  assert.equal(Object.hasOwn(checkingHostState.currentClue, 'answer'), false);
  assert.equal(Object.hasOwn(checkingHostState.currentClue, 'privateAnswer'), false);
  assert.equal(privatePlayerState.currentClue.privateAnswer, location.clue.answer);

  const hostSawScore = nextState(host, (state) => !state.currentClue && state.players[0]?.score === location.clue.value);
  await emitAck(player, 'player:self-score-clue', { clueKey, correct: true });
  await hostSawScore;
});

test('malformed removal requests leave the server and existing room usable', async (context) => {
  const jeopardy = createJeopardyServer({ games: loadGames(), logger: { error() {} } });
  const address = await jeopardy.start(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${address.port}`;
  const sockets = Array.from({ length: 3 }, () => createClient(origin, { transports: ['websocket'], forceNew: true }));
  const [host, player, stranger] = sockets;

  context.after(async () => {
    sockets.forEach((socket) => socket.disconnect());
    await jeopardy.stop();
  });

  const created = await emitAck(host, 'room:create');
  const joined = await emitAck(player, 'room:join', { code: created.session.code, name: 'Jordan' });

  await assert.rejects(
    emitAck(stranger, 'host:remove-player', null),
    (error) => error.code === 'NOT_IN_ROOM',
  );
  await assert.rejects(
    emitAck(host, 'host:remove-player', null),
    (error) => error.code === 'PLAYER_NOT_FOUND',
  );
  await assert.rejects(
    emitAck(player, 'host:remove-player', { playerId: joined.session.playerId }),
    (error) => error.code === 'HOST_ONLY',
  );

  const health = await fetch(`${origin}/health`).then((response) => response.json());
  assert.deepEqual(health, { ok: true, games: 20, rooms: 1 });
  assert.equal(jeopardy.rooms.rooms.get(created.session.code).players.length, 1);

  const hostSawRemoval = nextState(host, (state) => state.players.length === 0);
  await emitAck(host, 'host:remove-player', { playerId: joined.session.playerId });
  await hostSawRemoval;
});

test('stable resume credentials recover from a lost acknowledgement and keep host-offline buzzes authoritative', async (context) => {
  const games = loadGames();
  const jeopardy = createJeopardyServer({ games, logger: { error() {} } });
  const address = await jeopardy.start(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${address.port}`;
  const sockets = [
    createClient(origin, { transports: ['websocket'], forceNew: true }),
    createClient(origin, { transports: ['websocket'], forceNew: true }),
  ];
  const [host, player] = sockets;

  context.after(async () => {
    sockets.forEach((socket) => socket.disconnect());
    await jeopardy.stop();
  });

  const created = await emitAck(host, 'room:create');
  await emitAck(player, 'room:join', { code: created.session.code, name: 'Jordan' });
  await emitAck(host, 'host:start-game', { gameId: games[0].id });

  let location;
  games[0].categories.some((category, categoryIndex) => category.clues.some((clue, clueIndex) => {
    if (clue.dailyDouble) return false;
    location = { categoryIndex, clueIndex };
    return true;
  }));
  await emitAck(host, 'host:open-clue', location);

  const playerSawHostOffline = nextState(player, (state) => state.hostConnected === false);
  host.disconnect();
  await playerSawHostOffline;
  await assert.rejects(
    emitAck(player, 'player:buzz'),
    (error) => error.code === 'HOST_OFFLINE',
  );

  const firstReplacement = createClient(origin, { transports: ['websocket'], forceNew: true });
  sockets.push(firstReplacement);
  const playerSawHostReturn = nextState(player, (state) => state.hostConnected === true);
  firstReplacement.emit('room:resume', {
    code: created.session.code,
    token: created.session.token,
  }, () => {
    // Intentionally ignore the acknowledgement, matching a client that lost it in transit.
  });
  await playerSawHostReturn;

  const retryingHost = createClient(origin, { transports: ['websocket'], forceNew: true });
  sockets.push(retryingHost);
  const retried = await emitAck(retryingHost, 'room:resume', {
    code: created.session.code,
    token: created.session.token,
  });
  assert.equal(retried.session.role, 'host');
  assert.equal(retried.session.token, created.session.token);

  const retryingHostSawBuzz = nextState(retryingHost, (state) => state.currentClue?.buzzes.length === 1);
  await emitAck(player, 'player:buzz');
  const buzzState = await retryingHostSawBuzz;
  assert.equal(buzzState.currentClue.buzzes[0].name, 'Jordan');
});

test('Daily Double is selected by the host and privately self-scored by its contestant', async (context) => {
  const games = loadGames();
  const jeopardy = createJeopardyServer({ games, logger: { error() {} } });
  const address = await jeopardy.start(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${address.port}`;
  const host = createClient(origin, { transports: ['websocket'], forceNew: true });
  const player = createClient(origin, { transports: ['websocket'], forceNew: true });

  context.after(async () => {
    host.disconnect();
    player.disconnect();
    await jeopardy.stop();
  });

  const created = await emitAck(host, 'room:create');
  const hostSawPlayer = nextState(host, (state) => state.players.length === 1);
  const joinedPlayer = await emitAck(player, 'room:join', { code: created.session.code, name: 'Jordan' });
  await hostSawPlayer;
  const playerId = joinedPlayer.session.playerId;

  await emitAck(host, 'host:start-game', { gameId: games[0].id });
  let location;
  games[0].categories.some((category, categoryIndex) => category.clues.some((clue, clueIndex) => {
    if (!clue.dailyDouble) return false;
    location = { categoryIndex, clueIndex, clue };
    return true;
  }));
  const playerSawWager = nextState(player, (state) => state.currentClue?.phase === 'daily-wager');
  await emitAck(host, 'host:open-clue', location);
  await playerSawWager;

  const playerSawClue = nextState(player, (state) => state.currentClue?.phase === 'question');
  await emitAck(host, 'host:set-daily-double', { playerId, wager: 600 });
  const dailyState = await playerSawClue;
  const clueKey = dailyState.currentClue.clueKey;
  assert.equal(dailyState.currentClue.responderPlayerId, playerId);

  const hostSawChecking = nextState(host, (state) => state.currentClue?.selfJudgePlayerId === playerId);
  const playerSawAnswer = nextState(player, (state) => state.currentClue?.privateAnswer === location.clue.answer);
  await emitAck(player, 'player:open-answer', { clueKey });
  const [hostState, playerState] = await Promise.all([hostSawChecking, playerSawAnswer]);
  assert.equal(Object.hasOwn(hostState.currentClue, 'privateAnswer'), false);
  assert.equal(Object.hasOwn(hostState.currentClue, 'answer'), false);
  assert.equal(playerState.currentClue.privateAnswer, location.clue.answer);

  const hostSawResult = nextState(host, (state) => !state.currentClue && state.players[0]?.score === -600);
  await emitAck(player, 'player:self-score-clue', { clueKey, correct: false });
  await hostSawResult;
});

test('host can cancel an uncommitted Daily Double without consuming it', async (context) => {
  const games = loadGames();
  const jeopardy = createJeopardyServer({ games, logger: { error() {} } });
  const address = await jeopardy.start(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${address.port}`;
  const host = createClient(origin, { transports: ['websocket'], forceNew: true });
  const player = createClient(origin, { transports: ['websocket'], forceNew: true });

  context.after(async () => {
    host.disconnect();
    player.disconnect();
    await jeopardy.stop();
  });

  const created = await emitAck(host, 'room:create');
  await emitAck(player, 'room:join', { code: created.session.code, name: 'Jordan' });
  await emitAck(host, 'host:start-game', { gameId: games[0].id });

  let location;
  games[0].categories.some((category, categoryIndex) => category.clues.some((clue, clueIndex) => {
    if (!clue.dailyDouble) return false;
    location = { categoryIndex, clueIndex };
    return true;
  }));

  await emitAck(host, 'host:open-clue', location);
  await assert.rejects(
    emitAck(player, 'host:cancel-clue'),
    (error) => error.code === 'HOST_ONLY',
  );

  const playerSawCancellation = nextState(player, (state) => state.currentClue === null);
  await emitAck(host, 'host:cancel-clue');
  const cancelledState = await playerSawCancellation;
  assert.equal(cancelledState.game.categories[location.categoryIndex].clues[location.clueIndex].answered, false);

  const playerSawReopen = nextState(player, (state) => state.currentClue?.phase === 'daily-wager');
  await emitAck(host, 'host:open-clue', location);
  await playerSawReopen;
});

test('incorrect self-judgment promotes the next authenticated buzzer', async (context) => {
  const games = loadGames();
  const jeopardy = createJeopardyServer({ games, logger: { error() {} } });
  const address = await jeopardy.start(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${address.port}`;
  const host = createClient(origin, { transports: ['websocket'], forceNew: true });
  const firstPlayer = createClient(origin, { transports: ['websocket'], forceNew: true });
  const secondPlayer = createClient(origin, { transports: ['websocket'], forceNew: true });

  context.after(async () => {
    host.disconnect();
    firstPlayer.disconnect();
    secondPlayer.disconnect();
    await jeopardy.stop();
  });

  const created = await emitAck(host, 'room:create');
  const first = await emitAck(firstPlayer, 'room:join', { code: created.session.code, name: 'Jordan' });
  const second = await emitAck(secondPlayer, 'room:join', { code: created.session.code, name: 'Taylor' });
  await emitAck(host, 'host:start-game', { gameId: games[0].id });

  let location;
  games[0].categories.some((category, categoryIndex) => category.clues.some((clue, clueIndex) => {
    if (clue.dailyDouble) return false;
    location = { categoryIndex, clueIndex, clue };
    return true;
  }));
  await emitAck(host, 'host:open-clue', location);
  await emitAck(firstPlayer, 'player:buzz');
  const hostSawQueue = nextState(host, (state) => state.currentClue?.buzzes.length === 2);
  await emitAck(secondPlayer, 'player:buzz');
  const queuedState = await hostSawQueue;
  assert.deepEqual(
    queuedState.currentClue.buzzes.map((buzz) => buzz.playerId),
    [first.session.playerId, second.session.playerId],
  );
  await assert.rejects(
    emitAck(host, 'player:buzz'),
    (error) => error.code === 'CONTESTANT_ONLY',
  );

  const clueKey = queuedState.currentClue.clueKey;
  await emitAck(firstPlayer, 'player:open-answer', { clueKey });
  const hostSawPromotion = nextState(host, (state) => state.currentClue?.buzzes[0]?.playerId === second.session.playerId);
  const secondSawPromotion = nextState(secondPlayer, (state) => state.currentClue?.canOpenAnswer === true);
  await emitAck(firstPlayer, 'player:self-score-clue', { clueKey, correct: false });
  const promotedState = await hostSawPromotion;
  await secondSawPromotion;
  assert.equal(Object.hasOwn(promotedState.currentClue, 'privateAnswer'), false);
  assert.equal(promotedState.players.find((player) => player.id === first.session.playerId).score, -location.clue.value);

  await emitAck(secondPlayer, 'player:open-answer', { clueKey });
  const hostSawClose = nextState(host, (state) => state.currentClue === null);
  await emitAck(secondPlayer, 'player:self-score-clue', { clueKey, correct: true });
  const completedState = await hostSawClose;
  assert.equal(completedState.players.find((player) => player.id === second.session.playerId).score, location.clue.value);
});

test('Socket.IO blocks incomplete Final submissions and honors an explicit host force', async (context) => {
  const games = loadGames();
  const jeopardy = createJeopardyServer({ games, logger: { error() {} } });
  const address = await jeopardy.start(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${address.port}`;
  const host = createClient(origin, { transports: ['websocket'], forceNew: true });
  const player = createClient(origin, { transports: ['websocket'], forceNew: true });

  context.after(async () => {
    host.disconnect();
    player.disconnect();
    await jeopardy.stop();
  });

  const created = await emitAck(host, 'room:create');
  const joined = await emitAck(player, 'room:join', { code: created.session.code, name: 'Jordan' });
  await emitAck(host, 'host:start-game', { gameId: games[0].id });
  await emitAck(host, 'host:adjust-score', { playerId: joined.session.playerId, delta: 500 });
  await emitAck(host, 'host:start-final');

  await assert.rejects(
    emitAck(host, 'host:advance-final', { phase: 'wager' }),
    (error) => error.code === 'FINAL_SUBMISSIONS_PENDING',
  );

  const playerSawClue = nextState(player, (state) => state.final?.phase === 'clue');
  await emitAck(host, 'host:advance-final', { phase: 'wager', force: true });
  const forcedWagerState = await playerSawClue;
  assert.equal(forcedWagerState.final.yourWager, 0);
  assert.equal(forcedWagerState.final.yourWagerSubmitted, false);

  await assert.rejects(
    emitAck(host, 'host:advance-final', { phase: 'clue' }),
    (error) => error.code === 'FINAL_SUBMISSIONS_PENDING',
  );

  const hostSawAnswerPhase = nextState(host, (state) => state.final?.phase === 'answer');
  await emitAck(host, 'host:advance-final', { phase: 'clue', force: true });
  const forcedResponseState = await hostSawAnswerPhase;
  assert.equal(forcedResponseState.final.submissions[0].responseSubmitted, false);
  assert.equal(forcedResponseState.final.submissions[0].scored, true);
  assert.equal(forcedResponseState.final.submissions[0].correct, false);
});
