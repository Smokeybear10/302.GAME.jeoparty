'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadGames } = require('../lib/game-store');
const { RoomManager } = require('../lib/room-manager');

const HOUR = 60 * 60 * 1000;

function setup() {
  const games = loadGames();
  const game = structuredClone(games[0]);
  game.doubleJeopardy = {
    categories: game.categories.map((category, categoryIndex) => ({
      ...category,
      clues: category.clues.map((clue, clueIndex) => ({
        ...clue, value: clue.value * 2, dailyDouble: categoryIndex < 2 && clueIndex === 0,
      })),
    })),
  };
  const manager = new RoomManager({ games: [game], now: () => 1000 });
  const host = manager.createRoom('host');
  const first = manager.joinRoom('first', { code: host.code, name: 'Maya' });
  const second = manager.joinRoom('second', { code: host.code, name: 'Theo' });
  return { games, game, manager, host, first, second };
}

function finishBoard(manager) {
  const state = manager.stateFor('host', []);
  state.game.categories.forEach((category, categoryIndex) => {
    category.clues.forEach((clue, clueIndex) => {
      if (clue.answered) return;
      manager.openClue('host', { categoryIndex, clueIndex });
      manager.skipClue('host');
    });
  });
}

function reload(manager, games) {
  const restored = new RoomManager({ games, now: () => 2000 });
  restored.restoreSnapshot(JSON.parse(JSON.stringify(manager.exportSnapshot())));
  return restored;
}

test('restart restores Double Jeopardy, private Daily Double, scores, and the original game data', () => {
  const { games, game, manager, host, first, second } = setup();
  manager.startGame('host', game.id);
  manager.adjustScore('host', { playerId: first.playerId, delta: 400 });
  finishBoard(manager);
  manager.advanceRound('host', { expectedRound: 'jeopardy' });
  manager.openClue('host', { categoryIndex: 0, clueIndex: 0 });
  manager.setDailyDouble('host', { playerId: first.playerId, wager: 1200 });
  const clueKey = manager.stateFor('first', []).currentClue.clueKey;
  manager.openPlayerAnswer('first', { clueKey });
  const restored = reload(manager, [games[1]]);
  assert.equal(restored.sessions.size, 0);
  const room = restored.rooms.get(host.code);
  assert.equal(room.host.socketId, null);
  assert.equal(room.host.connected, false);
  assert.ok(room.players.every((player) => player.socketId === null && !player.connected));
  assert.ok(room.answered instanceof Set);
  assert.ok(room.currentClue.ineligiblePlayerIds instanceof Set);
  restored.resumeRoom('new-host', host);
  restored.resumeRoom('new-first', first);
  restored.resumeRoom('new-second', second);
  const state = restored.stateFor('new-first', []);
  assert.equal(state.round, 'double');
  assert.equal(state.you.score, 400);
  assert.equal(state.currentClue.privateAnswer, game.doubleJeopardy.categories[0].clues[0].answer);
  assert.equal(state.currentClue.value, 1200);
  assert.equal(Object.hasOwn(restored.stateFor('new-host', []).currentClue, 'privateAnswer'), false);
  assert.equal(Object.hasOwn(restored.stateFor('new-second', []).currentClue, 'privateAnswer'), false);
  restored.selfScoreClue('new-first', { clueKey, correct: true });
  assert.equal(restored.stateFor('new-first', []).you.score, 1600);
  assert.throws(() => restored.selfScoreClue('new-first', { clueKey, correct: true }), { code: 'NO_ACTIVE_CLUE' });
  assert.equal(manager.stateFor('first', []).you.score, 400, 'restored state must not alias the original');
});

test('restart preserves the buzz queue, wrong-answer eligibility, and private answer ownership', () => {
  const { game, manager, host, first, second } = setup();
  manager.startGame('host', game.id);
  const categoryIndex = game.categories.findIndex((category) => !category.clues[0].dailyDouble);
  manager.openClue('host', { categoryIndex, clueIndex: 0 });
  manager.buzz('first');
  manager.buzz('second');
  const clueKey = manager.stateFor('first', []).currentClue.clueKey;
  manager.openPlayerAnswer('first', { clueKey });
  manager.selfScoreClue('first', { clueKey, correct: false });
  manager.openPlayerAnswer('second', { clueKey });
  const restored = reload(manager, [game]);
  restored.resumeRoom('new-host', host);
  restored.resumeRoom('new-first', first);
  restored.resumeRoom('new-second', second);
  assert.throws(() => restored.buzz('new-first'), { code: 'BUZZ_CLOSED' });
  assert.equal(restored.stateFor('new-first', []).you.score, -200);
  assert.deepEqual(restored.stateFor('new-first', []).currentClue.ineligiblePlayerIds, [first.playerId]);
  assert.equal(restored.stateFor('new-second', []).currentClue.responderPlayerId, second.playerId);
  assert.equal(Object.hasOwn(restored.stateFor('new-first', []).currentClue, 'privateAnswer'), false);
  restored.selfScoreClue('new-second', { clueKey, correct: true });
  assert.equal(restored.stateFor('new-second', []).you.score, 200);
});

test('Final wagers, responses, and scored results survive multiple restarts without applying a score twice', () => {
  const { games, manager, host, first } = setup();
  const custom = manager.createCustomGame('host', { ...games[0], title: 'Saved custom game' });
  manager.startGame('host', custom.gameId);
  manager.adjustScore('host', { playerId: first.playerId, delta: 1000 });
  manager.startFinal('host');
  manager.submitFinalWager('first', 300);
  let restored = reload(manager, [games[1]]);
  restored.resumeRoom('host', host);
  restored.resumeRoom('first', first);
  assert.equal(restored.stateFor('first', []).final.yourWager, 300);
  assert.equal(restored.rooms.get(host.code).customGames[0].title, 'Saved custom game');
  restored.advanceFinal('host');
  restored.submitFinalResponse('first', 'What is the correct response?');
  restored = reload(restored, [games[1]]);
  restored.resumeRoom('host', host);
  restored.resumeRoom('first', first);
  assert.equal(restored.stateFor('first', []).final.yourResponse, 'What is the correct response?');
  assert.equal(Object.hasOwn(restored.stateFor('host', []).final, 'yourResponse'), false);
  restored.advanceFinal('host');
  restored.selfScoreFinal('first', { correct: true });
  restored = reload(restored, [games[1]]);
  restored.resumeRoom('host', host);
  restored.resumeRoom('first', first);
  assert.equal(restored.stateFor('first', []).you.score, 1300);
  assert.throws(() => restored.selfScoreFinal('first', { correct: true }), { code: 'ALREADY_SCORED' });
  restored.finishFinal('host');
  const completed = reload(restored, [games[1]]);
  completed.resumeRoom('host', host);
  assert.equal(completed.stateFor('host', []).final.phase, 'complete');
});

test('restored creator-play rooms preserve control while reconnecting in a different order', () => {
  const { game, manager, host, first } = setup();
  manager.joinHostAsPlayer('host', { name: 'Alex' });
  manager.startGame('host', game.id);
  const categoryIndex = game.categories.findIndex((category) => !category.clues[0].dailyDouble);
  manager.openClue('host', { categoryIndex, clueIndex: 0 });
  manager.buzz('first');
  const clueKey = manager.stateFor('first', []).currentClue.clueKey;
  manager.openPlayerAnswer('first', { clueKey });
  manager.selfScoreClue('first', { clueKey, correct: true });
  const restored = reload(manager, [game]);
  restored.resumeRoom('new-host', host);
  const hostState = restored.stateFor('new-host', []);
  assert.equal(hostState.you.isHost, true);
  restored.resumeRoom('new-first', first);
  assert.equal(restored.stateFor('new-first', []).controlPlayerId, first.playerId);
});

test('closed rooms and removed contestants stay removed after restart', () => {
  const { game, manager, host, first, second } = setup();
  manager.removePlayer('host', second.playerId);
  let restored = reload(manager, [game]);
  assert.throws(() => restored.resumeRoom('removed', second), { code: 'SESSION_EXPIRED' });
  restored.resumeRoom('host', host);
  restored.resumeRoom('first', first);
  restored.closeRoom('host');
  restored = reload(restored, [game]);
  assert.equal(restored.rooms.size, 0);
  assert.throws(() => restored.resumeRoom('old-host', host), { code: 'ROOM_NOT_FOUND' });
});

test('inactive rooms expire while a recent snapshot keeps a long-running connected room recoverable', () => {
  let now = 0;
  const game = loadGames()[0];
  const manager = new RoomManager({ games: [game], now: () => now });
  const active = manager.createRoom('active-host');
  const inactive = manager.createRoom('inactive-host');
  manager.disconnect('inactive-host');
  now = 13 * HOUR;
  const snapshot = manager.exportSnapshot();
  const restored = new RoomManager({ games: [game], now: () => now + 1000 });
  restored.restoreSnapshot(snapshot);
  assert.equal(restored.rooms.has(active.code), true);
  assert.equal(restored.rooms.has(inactive.code), false);
  assert.deepEqual(restored.cleanup(), []);
  now += 13 * HOUR;
  restored.restoreSnapshot(snapshot);
  assert.equal(restored.rooms.size, 0);
});

test('rollback restores connected sessions and exact private state without expiring rooms', () => {
  const { game, manager, host, first } = setup();
  manager.joinHostAsPlayer('host', { name: 'Alex' });
  manager.startGame('host', game.id);
  const before = manager.exportSnapshot();
  manager.removePlayer('host', first.playerId);
  manager.disconnect('host');
  manager.restoreSnapshot(before, { restoreConnections: true, expire: false });
  assert.deepEqual(manager.exportSnapshot(), before);
  assert.equal(manager.roomCodeForSocket('first'), host.code);
  assert.equal(manager.roomCodeForSocket('host'), host.code);
  assert.equal(manager.stateFor('host', []).hostConnected, true);
});

test('invalid snapshots fail atomically instead of silently discarding saved rooms', () => {
  const { game, manager } = setup();
  manager.startGame('host', game.id);
  const original = manager.exportSnapshot();
  const corruptions = [
    (snapshot) => { snapshot.version = 99; },
    (snapshot) => { snapshot.rooms[0].host.token = ''; },
    (snapshot) => { snapshot.rooms[0].selectedGame = null; },
    (snapshot) => { snapshot.rooms[0].players[0].score = '100'; },
    (snapshot) => { snapshot.rooms[0].answered = ['double:0:0']; },
    (snapshot) => { snapshot.rooms[0].controlPlayerId = 'missing'; },
    (snapshot) => { snapshot.rooms[0].controlPlayerId = 'p_deadbeef1234'; },
    (snapshot) => { snapshot.rooms.push(structuredClone(snapshot.rooms[0])); },
  ];
  for (const corrupt of corruptions) {
    const snapshot = structuredClone(original);
    corrupt(snapshot);
    assert.throws(() => manager.restoreSnapshot(snapshot), /Invalid room snapshot/);
    assert.deepEqual(manager.exportSnapshot(), original);
  }
});

test('uncommitted wagers, revealed clues, and forced Final submissions remain valid saved states', () => {
  const games = loadGames();
  const manager = new RoomManager({ games, now: () => 1000 });
  const host = manager.createRoom('host');
  const first = manager.joinRoom('first', { code: host.code, name: 'Maya' });
  manager.startGame('host', games[0].id);
  const clues = games[0].categories.flatMap((category, categoryIndex) => category.clues.map((clue, clueIndex) => ({ clue, categoryIndex, clueIndex })));
  manager.openClue('host', clues.find(({ clue }) => clue.dailyDouble));
  assert.equal(reload(manager, games).rooms.get(host.code).currentClue.phase, 'daily-wager');
  manager.cancelClue('host');
  manager.openClue('host', clues.find(({ clue }) => !clue.dailyDouble));
  manager.revealAnswer('host');
  assert.equal(reload(manager, games).rooms.get(host.code).currentClue.revealed, true);
  manager.skipClue('host');
  manager.adjustScore('host', { playerId: first.playerId, delta: 1000 });
  manager.startFinal('host');
  assert.equal(reload(manager, games).rooms.get(host.code).final.entries[first.playerId].wager, null);
  manager.advanceFinal('host', { force: true });
  assert.equal(reload(manager, games).rooms.get(host.code).final.entries[first.playerId].wager, 0);
  manager.advanceFinal('host', { force: true });
  const restored = reload(manager, games);
  restored.resumeRoom('new-host', host);
  assert.equal(restored.rooms.get(host.code).final.entries[first.playerId].scored, true);
  restored.finishFinal('new-host');
  assert.equal(reload(restored, games).rooms.get(host.code).final.phase, 'complete');
});

for (const phase of ['wager', 'clue', 'answer', 'complete']) {
  test(`restoring an older Final ${phase} save clears only its departed controller`, () => {
    const games = loadGames();
    const manager = new RoomManager({ games, now: () => 1000 });
    const host = manager.createRoom('host');
    manager.joinHostAsPlayer('host', { name: 'Host' });
    const player = manager.joinRoom('player', { code: host.code, name: 'Player' });
    manager.startGame('host', games[0].id);
    manager.adjustScore('host', { playerId: player.playerId, delta: 600 });
    manager.startFinal('host');
    if (phase !== 'wager') {
      manager.submitFinalWager('player', 200);
      manager.advanceFinal('host');
    }
    if (['answer', 'complete'].includes(phase)) {
      manager.submitFinalResponse('player', 'Private response');
      manager.advanceFinal('host');
    }
    if (phase === 'complete') {
      manager.selfScoreFinal('player', { correct: true });
      manager.finishFinal('host');
    }
    const snapshot = manager.exportSnapshot();
    snapshot.rooms[0].controlPlayerId = 'p_deadbeef1234';
    const original = structuredClone(snapshot);
    const expected = structuredClone(snapshot);
    expected.rooms[0].controlPlayerId = null;
    const restored = new RoomManager({ games, now: () => 1000 });
    restored.restoreSnapshot(snapshot, { restoreConnections: true, expire: false });
    assert.deepEqual(restored.exportSnapshot(), expected);
    assert.deepEqual(snapshot, original);

    for (const corrupt of [
      (room) => { room.controlPlayerId = 'missing'; },
      (room) => { room.disconnectedControlPlayerId = 'p_deadbeef1234'; },
      (room) => { room.players[0].score = '600'; },
      (room) => { room.final = null; },
    ]) {
      const damaged = structuredClone(snapshot);
      corrupt(damaged.rooms[0]);
      assert.throws(() => restored.restoreSnapshot(damaged), /Invalid room snapshot/);
      assert.deepEqual(restored.exportSnapshot(), expected);
    }
  });
}
