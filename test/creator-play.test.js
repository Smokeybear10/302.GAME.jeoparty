'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadGames, catalogGames } = require('../lib/game-store');
const { RoomManager } = require('../lib/room-manager');

function setup() {
  const games = loadGames();
  const manager = new RoomManager({ games });
  const host = manager.createRoom('host');
  manager.joinHostAsPlayer('host', { name: 'Creator' });
  const first = manager.joinRoom('first', { code: host.code, name: 'Maya' });
  const second = manager.joinRoom('second', { code: host.code, name: 'Theo' });
  const state = (socket = 'host') => manager.stateFor(socket, catalogGames(games));
  const creatorId = state().you.id;
  manager.startGame('host', games[0].id);
  const clues = games[0].categories.flatMap((category, categoryIndex) =>
    category.clues.map((clue, clueIndex) => ({ categoryIndex, clueIndex, clue })));
  return { games, manager, host, first, second, state, creatorId, clues };
}

function assertNoAnswer(clue) {
  assert.equal(Object.hasOwn(clue, 'answer'), false);
  assert.equal(Object.hasOwn(clue, 'privateAnswer'), false);
}

test('creator joins the same buzz queue and can privately check only their own response', () => {
  const { manager, state, creatorId, first, second, clues } = setup();
  const location = clues.find(({ clue }) => !clue.dailyDouble);
  manager.openClue('host', location);
  const { clueKey } = state().currentClue;
  for (const socket of ['host', 'first', 'second']) assertNoAnswer(state(socket).currentClue);
  manager.buzz('host');
  manager.buzz('first');
  manager.buzz('second');
  assert.deepEqual(state().currentClue.buzzes.map(({ playerId }) => playerId), [creatorId, first.playerId, second.playerId]);
  assert.equal(state().currentClue.canOpenAnswer, true);
  assert.equal(state('first').currentClue.canOpenAnswer, false);
  assert.throws(() => manager.openPlayerAnswer('first', { clueKey }), { code: 'NOT_RESPONDER' });
  assert.throws(() => manager.selfScoreClue('host', { clueKey, correct: true }), { code: 'ANSWER_NOT_OPEN' });
  manager.openPlayerAnswer('host', { clueKey });
  assert.equal(state().currentClue.privateAnswer, location.clue.answer);
  assert.equal(state().currentClue.canSelfScore, true);
  assertNoAnswer(state('first').currentClue);
  assertNoAnswer(state('second').currentClue);
  manager.selfScoreClue('host', { clueKey, correct: false });
  assert.equal(state().you.score, -location.clue.value);
  assert.equal(state().controlPlayerId, creatorId);
  assert.equal(state('first').currentClue.canOpenAnswer, true);
  assertNoAnswer(state().currentClue);
  assert.throws(() => manager.selfScoreClue('host', { clueKey, correct: false }), { code: 'NOT_RESPONDER' });
  manager.openPlayerAnswer('first', { clueKey });
  assertNoAnswer(state().currentClue);
  manager.selfScoreClue('first', { clueKey, correct: true });
  assert.equal(state().currentClue, null);
  assert.equal(state().controlPlayerId, first.playerId);
  assert.throws(() => manager.selfScoreClue('first', { clueKey, correct: true }), { code: 'NO_ACTIVE_CLUE' });
});

test('correct responses transfer clue selection, with no creator override and no transfer for skips', () => {
  const { manager, state, creatorId, first, clues } = setup();
  const [initial, next, skipped] = clues.filter(({ clue }) => !clue.dailyDouble);
  assert.equal(state().controlPlayerId, creatorId);
  assert.equal(state().canChooseClue, true);
  assert.equal(state('first').canChooseClue, false);
  assert.throws(() => manager.openClue('first', initial), { code: 'NOT_YOUR_TURN' });
  manager.openClue('host', initial);
  assert.equal(state().canChooseClue, false);
  const { clueKey } = state().currentClue;
  manager.buzz('first');
  manager.openPlayerAnswer('first', { clueKey });
  manager.selfScoreClue('first', { clueKey, correct: true });
  assert.equal(state('first').canChooseClue, true);
  assert.equal(state().canChooseClue, false);
  assert.throws(() => manager.openClue('host', next), { code: 'NOT_YOUR_TURN' });
  manager.openClue('first', next);
  manager.skipClue('host');
  assert.equal(state().controlPlayerId, first.playerId);
  manager.openClue('first', skipped);
  manager.skipClue('host');
  manager.resetGame('host');
  assert.equal(state().controlPlayerId, creatorId);
  manager.returnToLobby('host');
  assert.equal(state().controlPlayerId, null);
  assert.equal(state().canChooseClue, false);
});

test('selection falls back after disconnect or removal and creator reconnect retains identity and private answer', () => {
  const { manager, state, creatorId, host, first, second, clues } = setup();
  const location = clues.find(({ clue }) => !clue.dailyDouble);
  manager.openClue('host', location);
  const { clueKey } = state().currentClue;
  manager.buzz('host');
  manager.openPlayerAnswer('host', { clueKey });
  manager.disconnect('host');
  assert.equal(state('first').controlPlayerId, first.playerId);
  assert.equal(state('first').players.find(({ id }) => id === creatorId).connected, false);
  const resumed = manager.resumeRoom('host-resumed', { code: host.code, token: host.token });
  assert.equal(resumed.role, 'host');
  assert.equal(state('host-resumed').you.id, creatorId);
  assert.equal(state('host-resumed').currentClue.privateAnswer, location.clue.answer);
  assertNoAnswer(state('first').currentClue);
  manager.selfScoreClue('host-resumed', { clueKey, correct: true });
  assert.equal(state('host-resumed').controlPlayerId, creatorId);
  const takeover = manager.resumeRoom('host-takeover', { code: host.code, token: host.token });
  assert.equal(takeover.replacedSocketId, 'host-resumed');
  assert.throws(() => state('host-resumed'), { code: 'NOT_IN_ROOM' });
  manager.disconnect('host-takeover');
  manager.disconnect('first');
  assert.equal(state('second').controlPlayerId, second.playerId);
  manager.resumeRoom('host', { code: host.code, token: host.token });
  manager.removePlayer('host', second.playerId);
  assert.equal(state().controlPlayerId, creatorId);
  assert.throws(() => manager.removePlayer('host', creatorId), { code: 'CANNOT_REMOVE_HOST' });
  manager.disconnect('host');
  manager.resumeRoom('first-resumed', { code: host.code, token: first.token });
  assert.equal(state('first-resumed').controlPlayerId, first.playerId);
});

test('reloading restores an earned selection turn and score before another clue is picked', () => {
  const { manager, state, creatorId, host, first, clues } = setup();
  const location = clues.find(({ clue }) => !clue.dailyDouble);
  manager.openClue('host', location);
  const { clueKey } = state().currentClue;
  manager.buzz('first');
  manager.openPlayerAnswer('first', { clueKey });
  manager.selfScoreClue('first', { clueKey, correct: true });
  manager.disconnect('first');
  assert.equal(state().controlPlayerId, creatorId);
  assert.equal(state().canChooseClue, true);
  assert.throws(() => manager.openClue('host', location), { code: 'CLUE_ALREADY_USED' });

  manager.resumeRoom('first-resumed', { code: host.code, token: first.token });
  const resumed = state('first-resumed');
  assert.equal(resumed.you.id, first.playerId);
  assert.equal(resumed.you.score, location.clue.value);
  assert.equal(resumed.players.length, 3);
  assert.equal(resumed.controlPlayerId, first.playerId);
  assert.equal(resumed.canChooseClue, true);
  assert.equal(state().canChooseClue, false);
});

test('a fallback selection consumes the disconnected contestant’s claim to the turn', () => {
  const { manager, state, host, first, clues } = setup();
  const location = clues.find(({ clue }) => !clue.dailyDouble);
  manager.disconnect('host');
  assert.equal(state('first').canChooseClue, true);
  manager.openClue('first', location);
  manager.resumeRoom('host-resumed', { code: host.code, token: host.token });
  manager.skipClue('host-resumed');
  assert.equal(state('first').controlPlayerId, first.playerId);
  assert.equal(state('first').canChooseClue, true);
  assert.equal(state('host-resumed').canChooseClue, false);
});

test('chained disconnects preserve the first rightful picker until they return', () => {
  const { manager, state, creatorId, host, first, second } = setup();
  manager.disconnect('host');
  manager.disconnect('first');
  assert.equal(state('second').controlPlayerId, second.playerId);
  manager.resumeRoom('first-resumed', { code: host.code, token: first.token });
  assert.equal(state('second').controlPlayerId, second.playerId);
  manager.resumeRoom('host-resumed', { code: host.code, token: host.token });
  assert.equal(state('host-resumed').controlPlayerId, creatorId);
  assert.equal(state('host-resumed').canChooseClue, true);
});

test('a correct response takes priority over a disconnected picker’s previous turn', () => {
  const { manager, state, host, first, clues } = setup();
  const location = clues.find(({ clue }) => !clue.dailyDouble);
  manager.openClue('host', location);
  const { clueKey } = state().currentClue;
  manager.buzz('first');
  manager.openPlayerAnswer('first', { clueKey });
  manager.disconnect('host');
  manager.selfScoreClue('first', { clueKey, correct: true });
  manager.resumeRoom('host-returned', { code: host.code, token: host.token });
  assert.equal(state('first').controlPlayerId, first.playerId);
  assert.equal(state('first').canChooseClue, true);
  assert.equal(state('host-returned').canChooseClue, false);
});

test('resetting a game clears an offline contestant’s claim to the next selection', () => {
  const { manager, state, creatorId, host, first, clues } = setup();
  const location = clues.find(({ clue }) => !clue.dailyDouble);
  manager.openClue('host', location);
  const { clueKey } = state().currentClue;
  manager.buzz('first');
  manager.openPlayerAnswer('first', { clueKey });
  manager.selfScoreClue('first', { clueKey, correct: true });
  manager.disconnect('first');
  manager.resetGame('host');
  manager.resumeRoom('first-resumed', { code: host.code, token: first.token });
  assert.equal(state().controlPlayerId, creatorId);
  assert.equal(state().canChooseClue, true);
  assert.equal(state('first-resumed').canChooseClue, false);
});

test('creator Daily Double hides the question before the wager and cannot be reassigned to another contestant', () => {
  const { manager, state, creatorId, first, clues } = setup();
  const location = clues.find(({ clue }) => clue.dailyDouble);
  manager.openClue('host', location);
  const { clueKey } = state().currentClue;
  assert.equal(state().currentClue.question, null);
  assertNoAnswer(state().currentClue);
  assert.throws(() => manager.setDailyDouble('host', { playerId: first.playerId, wager: 400 }), { code: 'NOT_YOUR_DAILY_DOUBLE' });
  assert.throws(() => manager.setDailyDouble('host', { playerId: creatorId, wager: 1001 }), { code: 'INVALID_WAGER' });
  manager.setDailyDouble('host', { playerId: creatorId, wager: 400 });
  assert.equal(state().currentClue.question, location.clue.clue);
  assert.throws(() => manager.buzz('first'), { code: 'BUZZ_CLOSED' });
  assert.throws(() => manager.openPlayerAnswer('first', { clueKey }), { code: 'NOT_RESPONDER' });
  manager.openPlayerAnswer('host', { clueKey });
  assert.equal(state().currentClue.privateAnswer, location.clue.answer);
  assertNoAnswer(state('first').currentClue);
  manager.selfScoreClue('host', { clueKey, correct: false });
  assert.equal(state().you.score, -400);
  assert.equal(state().currentClue, null);
  assert.equal(state().controlPlayerId, creatorId);
});

test('a creator can play a complete board and Final once, with private responses and reconnectable submissions', () => {
  const { games, manager, state, creatorId, first, host, clues } = setup();
  let total = 0;
  for (const location of clues) {
    manager.openClue('host', location);
    const { clueKey } = state().currentClue;
    if (location.clue.dailyDouble) {
      manager.setDailyDouble('host', { playerId: creatorId, wager: 400 });
      total += 400;
    } else {
      manager.buzz('host');
      total += location.clue.value;
    }
    manager.openPlayerAnswer('host', { clueKey });
    manager.selfScoreClue('host', { clueKey, correct: true });
  }
  assert.equal(state().you.score, total);
  assert.equal(state().game.categories.flatMap(({ clues: entries }) => entries).filter(({ answered }) => answered).length, 30);
  manager.adjustScore('host', { playerId: first.playerId, delta: 800 });
  manager.startFinal('host');
  assert.equal(state().final.eligible, true);
  assertNoAnswer(state().final);
  assert.throws(() => manager.submitFinalWager('host', total + 1), { code: 'INVALID_WAGER' });
  manager.submitFinalWager('host', 500);
  manager.submitFinalWager('first', 300);
  assert.throws(() => manager.submitFinalWager('host', 0), { code: 'ALREADY_SUBMITTED' });
  manager.advanceFinal('host', 'wager');
  manager.submitFinalResponse('host', 'Creator response');
  manager.submitFinalResponse('first', 'Maya response');
  assertNoAnswer(state().final);
  assert.equal(JSON.stringify(state().final).includes('Maya response'), false);
  assert.equal(JSON.stringify(state('first').final).includes('Creator response'), false);
  manager.disconnect('host');
  manager.resumeRoom('host-return', { code: host.code, token: host.token });
  assert.equal(state('host-return').final.yourResponse, 'Creator response');
  assert.equal(state('host-return').final.yourWager, 500);
  manager.advanceFinal('host-return', 'clue');
  assert.equal(state('host-return').final.answer, games[0].finalJeopardy.answer);
  manager.selfScoreFinal('host-return', { correct: true });
  assert.throws(() => manager.selfScoreFinal('host-return', { correct: true }), { code: 'ALREADY_SCORED' });
  manager.selfScoreFinal('first', { correct: false });
  manager.finishFinal('host-return');
  assert.equal(state('host-return').final.phase, 'complete');
  assert.equal(state('host-return').you.score, total + 500);
  assert.equal(state('first').you.score, 500);
});
