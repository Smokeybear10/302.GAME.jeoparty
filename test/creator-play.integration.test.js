'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { io: createClient } = require('socket.io-client');
const { loadGames } = require('../lib/game-store');
const { createJeopardyServer } = require('../server');

function action(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    socket.timeout(3000).emit(event, payload, (timeoutError, response) => {
      if (timeoutError) return reject(timeoutError);
      if (!response?.ok) return reject(Object.assign(new Error(response?.error?.message), { code: response?.error?.code }));
      resolve(response);
    });
  });
}

function nextState(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('room:state', onState);
      reject(new Error('Expected room state was not received'));
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

async function setup(context) {
  const games = loadGames();
  const server = createJeopardyServer({ games, logger: { error() {} } });
  const address = await server.start(0, '127.0.0.1');
  const sockets = [];
  function client() {
    const socket = createClient(`http://127.0.0.1:${address.port}`, { transports: ['websocket'], forceNew: true });
    sockets.push(socket);
    return socket;
  }
  context.after(async () => {
    sockets.forEach((socket) => socket.disconnect());
    await server.stop();
  });
  return { games, client };
}

test('socket creator can opt into the roster, play, transfer selection, and resume a private answer', async (context) => {
  const { games, client } = await setup(context);
  const host = client();
  const player = client();
  const created = await action(host, 'room:create');
  assert.equal(created.state.you, null);
  assert.equal(created.state.controlPlayerId, null);
  const sawCreator = nextState(host, (state) => state.you?.name === 'Creator');
  const joined = await action(host, 'host:join-contestants', { name: 'Creator' });
  assert.equal(joined.result, created.session.code);
  const creator = (await sawCreator).you;
  assert.equal(creator.isHost, true);
  const remote = await action(player, 'room:join', { code: created.session.code, name: 'Maya' });
  await assert.rejects(action(player, 'host:join-contestants', { name: 'Other creator' }), { code: 'HOST_ONLY' });
  await assert.rejects(action(host, 'host:remove-player', { playerId: creator.id }), { code: 'CANNOT_REMOVE_HOST' });

  const creatorTurn = nextState(host, (state) => state.canChooseClue);
  await action(host, 'host:start-game', { gameId: games[0].id });
  assert.equal((await creatorTurn).controlPlayerId, creator.id);
  await assert.rejects(action(host, 'host:leave-contestants'), { code: 'LOBBY_ONLY' });
  const [first, second] = games[0].categories.flatMap((category, categoryIndex) =>
    category.clues.map((clue, clueIndex) => ({ categoryIndex, clueIndex, clue })))
    .filter(({ clue }) => !clue.dailyDouble);
  await assert.rejects(action(player, 'player:open-clue', first), { code: 'NOT_YOUR_TURN' });
  const opened = nextState(host, (state) => Boolean(state.currentClue));
  await action(host, 'host:open-clue', first);
  const { clueKey } = (await opened).currentClue;
  await action(host, 'player:buzz');
  await action(player, 'player:buzz');
  const hostPrivate = nextState(host, (state) => state.currentClue?.privateAnswer === first.clue.answer);
  const playerSawChecking = nextState(player, (state) => state.currentClue?.selfJudgePlayerId === creator.id);
  await action(host, 'player:open-answer', { clueKey });
  assert.equal((await hostPrivate).currentClue.canSelfScore, true);
  assert.equal(Object.hasOwn((await playerSawChecking).currentClue, 'privateAnswer'), false);

  const disconnected = nextState(player, (state) => !state.hostConnected);
  host.disconnect();
  assert.equal((await disconnected).controlPlayerId, remote.session.playerId);
  const resumedHost = client();
  const resumed = await action(resumedHost, 'room:resume', created.session);
  assert.equal(resumed.state.you.id, creator.id);
  assert.equal(resumed.state.currentClue.privateAnswer, first.clue.answer);
  const promoted = nextState(player, (state) => state.currentClue?.canOpenAnswer);
  await action(resumedHost, 'player:self-score-clue', { clueKey, correct: false });
  await promoted;
  await assert.rejects(action(resumedHost, 'player:self-score-clue', { clueKey, correct: false }), { code: 'NOT_RESPONDER' });
  const hiddenFromCreator = nextState(resumedHost, (state) => state.currentClue?.selfJudgePlayerId === remote.session.playerId);
  await action(player, 'player:open-answer', { clueKey });
  assert.equal(Object.hasOwn((await hiddenFromCreator).currentClue, 'privateAnswer'), false);
  const remoteTurn = nextState(player, (state) => state.canChooseClue);
  await action(player, 'player:self-score-clue', { clueKey, correct: true });
  assert.equal((await remoteTurn).controlPlayerId, remote.session.playerId);
  await assert.rejects(action(resumedHost, 'host:open-clue', second), { code: 'NOT_YOUR_TURN' });
  await action(player, 'player:open-clue', second);
  await action(resumedHost, 'host:skip-clue');

  await action(resumedHost, 'host:return-lobby');
  const controllerOnly = nextState(resumedHost, (state) => !state.you);
  await action(resumedHost, 'host:leave-contestants');
  assert.equal((await controllerOnly).players.length, 1);
  await action(resumedHost, 'host:start-game', { gameId: games[0].id });
  await assert.rejects(action(player, 'player:open-clue', first), { code: 'HOST_ONLY' });
  await action(resumedHost, 'host:open-clue', first);
  await assert.rejects(action(resumedHost, 'player:buzz'), { code: 'CONTESTANT_ONLY' });
});

test('socket creator plays a Daily Double and Final without early answer or other response leakage', async (context) => {
  const { games, client } = await setup(context);
  const host = client();
  const player = client();
  const created = await action(host, 'room:create');
  const membership = nextState(host, (state) => Boolean(state.you));
  await action(host, 'host:join-contestants', { name: 'Creator' });
  const creatorId = (await membership).you.id;
  const remote = await action(player, 'room:join', { code: created.session.code, name: 'Maya' });
  await action(host, 'host:start-game', { gameId: games[0].id });
  const daily = games[0].categories.flatMap((category, categoryIndex) =>
    category.clues.map((clue, clueIndex) => ({ categoryIndex, clueIndex, clue })))
    .find(({ clue }) => clue.dailyDouble);
  const awaitingWager = nextState(host, (state) => state.currentClue?.phase === 'daily-wager');
  await action(host, 'host:open-clue', daily);
  const beforeWager = (await awaitingWager).currentClue;
  assert.equal(beforeWager.question, null);
  assert.equal(Object.hasOwn(beforeWager, 'privateAnswer'), false);
  await assert.rejects(action(host, 'host:set-daily-double', { playerId: remote.session.playerId, wager: 500 }), { code: 'NOT_YOUR_DAILY_DOUBLE' });
  await action(host, 'host:set-daily-double', { playerId: creatorId, wager: 500 });
  await action(host, 'player:open-answer', { clueKey: beforeWager.clueKey });
  await action(host, 'player:self-score-clue', { clueKey: beforeWager.clueKey, correct: true });
  await action(host, 'host:adjust-score', { playerId: remote.session.playerId, delta: 500 });
  const finalWager = nextState(host, (state) => state.final?.phase === 'wager');
  await action(host, 'host:start-final');
  const initialFinal = (await finalWager).final;
  assert.equal(initialFinal.eligible, true);
  assert.equal(initialFinal.yourMaxWager, 500);
  assert.equal(initialFinal.clue, null);
  assert.equal(Object.hasOwn(initialFinal, 'answer'), false);
  await action(host, 'player:final-wager', { wager: 200 });
  await action(player, 'player:final-wager', { wager: 300 });
  await action(host, 'host:advance-final', { expectedPhase: 'wager' });
  await action(host, 'player:final-response', { response: 'Creator private response' });
  const bothSubmitted = nextState(host, (state) => state.final?.submissions.every(({ responseSubmitted }) => responseSubmitted));
  await action(player, 'player:final-response', { response: 'Maya private response' });
  const privateState = (await bothSubmitted).final;
  assert.equal(JSON.stringify(privateState).includes('Maya private response'), false);
  assert.equal(Object.hasOwn(privateState, 'answer'), false);
  const answer = nextState(host, (state) => state.final?.phase === 'answer');
  await action(host, 'host:advance-final', { expectedPhase: 'clue' });
  assert.equal((await answer).final.answer, games[0].finalJeopardy.answer);
  await action(host, 'player:self-score-final', { correct: true });
  await assert.rejects(action(host, 'player:self-score-final', { correct: true }), { code: 'ALREADY_SCORED' });
  await action(player, 'player:self-score-final', { correct: false });
  const complete = nextState(host, (state) => state.final?.phase === 'complete');
  await action(host, 'host:finish-final');
  assert.equal((await complete).you.score, 700);
});
