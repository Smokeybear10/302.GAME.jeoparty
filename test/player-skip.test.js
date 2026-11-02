'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { io: createClient } = require('socket.io-client');
const { loadGames, catalogGames } = require('../lib/game-store');
const { RoomManager } = require('../lib/room-manager');
const { createJeopardyServer } = require('../server');

function setup({ creatorPlays = true } = {}) {
  const games = loadGames();
  const manager = new RoomManager({ games });
  const host = manager.createRoom('host');
  if (creatorPlays) manager.joinHostAsPlayer('host', { name: 'Creator' });
  const first = manager.joinRoom('first', { code: host.code, name: 'Maya' });
  const second = manager.joinRoom('second', { code: host.code, name: 'Theo' });
  const state = (socket = 'host') => manager.stateFor(socket, catalogGames(games));
  manager.startGame('host', games[0].id);
  const clues = games[0].categories.flatMap((category, categoryIndex) =>
    category.clues.map((clue, clueIndex) => ({ categoryIndex, clueIndex, clue })));
  return { manager, host, first, second, state, clues };
}

function assertSkipped(state, before, location) {
  assert.equal(state.currentClue, null);
  assert.equal(state.game.categories[location.categoryIndex].clues[location.clueIndex].answered, true);
  assert.deepEqual(state.players, before.players);
  assert.equal(state.controlPlayerId, before.controlPlayerId);
}

test('a locked-out player can force-skip while another player checks their answer', () => {
  const { manager, first, host, state, clues } = setup();
  const location = clues.find(({ clue }) => !clue.dailyDouble);
  manager.openClue('host', location);
  const { clueKey } = state().currentClue;
  manager.buzz('first');
  manager.buzz('second');
  manager.openPlayerAnswer('first', { clueKey });
  manager.selfScoreClue('first', { clueKey, correct: false });
  assert.deepEqual(state('first').currentClue.ineligiblePlayerIds, [first.playerId]);
  assert.equal(state('first').currentClue.canSkipClue, true);
  manager.openPlayerAnswer('second', { clueKey });
  assert.equal(state('second').currentClue.privateAnswer, location.clue.answer);
  assert.equal(state('second').currentClue.canSkipClue, true);
  const before = state();
  assert.equal(manager.skipPlayerClue('first', { clueKey }), host.code);
  for (const socket of ['host', 'first', 'second']) assertSkipped(state(socket), before, location);
  assert.throws(() => manager.selfScoreClue('second', { clueKey, correct: true }), { code: 'NO_ACTIVE_CLUE' });
  assert.throws(() => manager.openClue('host', location), { code: 'CLUE_ALREADY_USED' });
});

test('a queued contestant can force-skip without stealing the current selection turn', () => {
  const { manager, first, state, clues } = setup();
  const [scored, location] = clues.filter(({ clue }) => !clue.dailyDouble);
  manager.openClue('host', scored);
  const firstKey = state().currentClue.clueKey;
  manager.buzz('first');
  manager.openPlayerAnswer('first', { clueKey: firstKey });
  manager.selfScoreClue('first', { clueKey: firstKey, correct: true });
  assert.equal(state().controlPlayerId, first.playerId);
  manager.openClue('first', location);
  const { clueKey } = state().currentClue;
  manager.buzz('first');
  manager.buzz('second');
  assert.equal(state('second').currentClue.canSkipClue, true);
  const before = state();
  manager.skipPlayerClue('second', { clueKey });
  assertSkipped(state(), before, location);
  assert.equal(state('first').canChooseClue, true);
  assert.equal(state('second').canChooseClue, false);
});

test('creator contestants and active responders can force-skip their own private check', () => {
  const { manager, state, clues } = setup();
  const location = clues.find(({ clue }) => !clue.dailyDouble);
  manager.openClue('host', location);
  const { clueKey } = state().currentClue;
  assert.equal(state().currentClue.canSkipClue, true);
  manager.buzz('host');
  manager.openPlayerAnswer('host', { clueKey });
  const before = state();
  manager.skipPlayerClue('host', { clueKey });
  assertSkipped(state(), before, location);
});

test('force-skip rejects missing and stale keys without consuming another clue', () => {
  const { manager, state, clues } = setup();
  const [first, second] = clues.filter(({ clue }) => !clue.dailyDouble);
  manager.openClue('host', first);
  const { clueKey } = state().currentClue;
  for (const payload of [undefined, null, {}, { clueKey: null }, { clueKey: 'stale' }]) {
    assert.throws(() => manager.skipPlayerClue('first', payload), { code: 'STALE_CLUE' });
    assert.equal(state().currentClue.clueKey, clueKey);
  }
  manager.skipPlayerClue('first', { clueKey });
  assert.throws(() => manager.skipPlayerClue('second', { clueKey }), { code: 'NO_ACTIVE_CLUE' });
  manager.openClue('host', second);
  const before = state();
  assert.throws(() => manager.skipPlayerClue('first', { clueKey }), { code: 'STALE_CLUE' });
  assert.deepEqual(state(), before);
});

test('a player can force-skip even with the host offline', () => {
  const { manager, state, clues } = setup();
  const location = clues.find(({ clue }) => !clue.dailyDouble);
  manager.openClue('host', location);
  const { clueKey } = state().currentClue;
  manager.disconnect('host');
  const before = state('first');
  assert.equal(before.hostConnected, false);
  assert.equal(before.currentClue.canSkipClue, true);
  manager.skipPlayerClue('first', { clueKey });
  assertSkipped(state('first'), before, location);
});

test('force-skip is contestant-only and does not expose other host controls', () => {
  const { manager, first, state, clues } = setup({ creatorPlays: false });
  const location = clues.find(({ clue }) => !clue.dailyDouble);
  manager.openClue('host', location);
  const { clueKey } = state().currentClue;
  assert.equal(state().currentClue.canSkipClue, false);
  assert.equal(state('first').currentClue.canSkipClue, true);
  assert.throws(() => manager.skipPlayerClue('outsider', { clueKey }), { code: 'NOT_IN_ROOM' });
  assert.throws(() => manager.skipPlayerClue('host', { clueKey }), { code: 'CONTESTANT_ONLY' });
  assert.throws(() => manager.skipClue('first'), { code: 'HOST_ONLY' });
  assert.throws(() => manager.resetBuzzers('first'), { code: 'HOST_ONLY' });
  assert.throws(() => manager.adjustScore('first', { playerId: first.playerId, delta: 1000 }), { code: 'HOST_ONLY' });
  manager.removePlayer('host', first.playerId);
  assert.throws(() => manager.skipPlayerClue('first', { clueKey }), { code: 'NOT_IN_ROOM' });
  const before = state();
  manager.skipPlayerClue('second', { clueKey });
  assertSkipped(state(), before, location);
});

test('Daily Double questions can be force-skipped, but uncommitted wagers cannot', () => {
  const { manager, state, clues } = setup();
  const location = clues.find(({ clue }) => clue.dailyDouble);
  manager.openClue('host', location);
  const { clueKey } = state().currentClue;
  const awaitingWager = state();
  assert.equal(awaitingWager.currentClue.canSkipClue, false);
  assert.equal(state('first').currentClue.canSkipClue, false);
  assert.throws(() => manager.skipPlayerClue('first', { clueKey }), { code: 'NO_ACTIVE_CLUE' });
  assert.deepEqual(state(), awaitingWager);
  manager.setDailyDouble('host', { playerId: state().you.id, wager: 800 });
  const before = state();
  assert.equal(before.currentClue.canSkipClue, true);
  assert.equal(state('first').currentClue.canSkipClue, true);
  manager.skipPlayerClue('first', { clueKey });
  assertSkipped(state(), before, location);
});

test('force-skip rejects the lobby, an idle board, and Final Jeopardy', () => {
  const { manager, first, state } = setup();
  assert.throws(() => manager.skipPlayerClue('first', { clueKey: '0:0' }), { code: 'NO_ACTIVE_CLUE' });
  manager.adjustScore('host', { playerId: first.playerId, delta: 200 });
  manager.startFinal('host');
  const beforeFinal = state();
  assert.throws(() => manager.skipPlayerClue('first', { clueKey: '0:0' }), { code: 'NO_ACTIVE_CLUE' });
  assert.deepEqual(state(), beforeFinal);
  manager.returnToLobby('host');
  assert.throws(() => manager.skipPlayerClue('first', { clueKey: '0:0' }), { code: 'NO_ACTIVE_CLUE' });
});

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

test('player force-skip broadcasts to everyone and rejects stale, unauthorized, and malformed requests', async (context) => {
  const games = loadGames();
  const serverErrors = [];
  const server = createJeopardyServer({ games, logger: { error(error) { serverErrors.push(error); } } });
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
  const host = client();
  const first = client();
  const second = client();
  const outsider = client();
  const created = await action(host, 'room:create');
  const firstJoined = await action(first, 'room:join', { code: created.session.code, name: 'Maya' });
  await action(second, 'room:join', { code: created.session.code, name: 'Theo' });
  await action(host, 'host:start-game', { gameId: games[0].id });
  const [location, next] = games[0].categories.flatMap((category, categoryIndex) =>
    category.clues.map((clue, clueIndex) => ({ categoryIndex, clueIndex, clue })))
    .filter(({ clue }) => !clue.dailyDouble);
  const opened = nextState(first, (state) => Boolean(state.currentClue));
  await action(host, 'host:open-clue', location);
  const { clueKey } = (await opened).currentClue;
  await assert.rejects(action(outsider, 'player:skip-clue', { clueKey }), { code: 'NOT_IN_ROOM' });
  await assert.rejects(action(host, 'player:skip-clue', { clueKey }), { code: 'CONTESTANT_ONLY' });
  await assert.rejects(action(first, 'player:skip-clue', null), { code: 'STALE_CLUE' });
  await assert.rejects(action(first, 'player:skip-clue'), { code: 'STALE_CLUE' });
  await assert.rejects(action(first, 'host:skip-clue'), { code: 'HOST_ONLY' });
  await assert.rejects(action(first, 'host:reset-buzzers'), { code: 'HOST_ONLY' });
  await action(first, 'player:buzz');
  await action(second, 'player:buzz');
  await action(first, 'player:open-answer', { clueKey });
  await action(first, 'player:self-score-clue', { clueKey, correct: false });
  await action(second, 'player:open-answer', { clueKey });
  const states = [host, first, second].map((socket) => nextState(socket,
    (state) => !state.currentClue && state.game?.categories[location.categoryIndex].clues[location.clueIndex].answered));
  const skipped = await action(first, 'player:skip-clue', { clueKey });
  assert.equal(skipped.result, created.session.code);
  for (const state of await Promise.all(states)) {
    assert.equal(state.players.find(({ id }) => id === firstJoined.session.playerId).score, -location.clue.value);
    assert.equal(state.controlPlayerId, null);
  }
  await assert.rejects(action(second, 'player:self-score-clue', { clueKey, correct: true }), { code: 'NO_ACTIVE_CLUE' });
  await assert.rejects(action(first, 'player:skip-clue', { clueKey }), { code: 'NO_ACTIVE_CLUE' });
  const nextOpened = nextState(first, (state) => Boolean(state.currentClue));
  await action(host, 'host:open-clue', next);
  const nextClueKey = (await nextOpened).currentClue.clueKey;
  await assert.rejects(action(first, 'player:skip-clue', { clueKey }), { code: 'STALE_CLUE' });
  const results = await Promise.allSettled([
    action(first, 'player:skip-clue', { clueKey: nextClueKey }),
    action(second, 'player:skip-clue', { clueKey: nextClueKey }),
  ]);
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(results.find(({ status }) => status === 'rejected').reason.code, 'NO_ACTIVE_CLUE');
  assert.deepEqual(serverErrors, []);
});
