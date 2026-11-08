'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadGames } = require('../lib/game-store');
const { RoomManager } = require('../lib/room-manager');

function fixture() {
  const games = loadGames();
  let now = 1000;
  const manager = new RoomManager({ games, now: () => now++ });
  const host = manager.createRoom('host');
  const first = manager.joinRoom('first', { code: host.code, name: 'Maya' });
  const second = manager.joinRoom('second', { code: host.code, name: 'Theo' });
  return { manager, games, host, first, second };
}

function complete(f, { firstScore = 600, secondScore = 600, disconnectBeforeFinish = false } = {}) {
  const { manager, first, second } = f;
  manager.adjustScore('host', { playerId: first.playerId, delta: firstScore - manager.stateFor('first', []).you.score });
  manager.adjustScore('host', { playerId: second.playerId, delta: secondScore - manager.stateFor('second', []).you.score });
  manager.startFinal('host');
  for (const socket of ['first', 'second']) {
    if (manager.stateFor(socket, []).you.score > 0) manager.submitFinalWager(socket, 0);
  }
  manager.advanceFinal('host');
  for (const socket of ['first', 'second']) {
    if (manager.stateFor(socket, []).you.score > 0) manager.submitFinalResponse(socket, `Private response from ${socket}`);
  }
  manager.advanceFinal('host');
  for (const socket of ['first', 'second']) {
    if (manager.stateFor(socket, []).you.score > 0) manager.selfScoreFinal(socket, { correct: true });
  }
  if (disconnectBeforeFinish) manager.disconnect('second');
  manager.finishFinal('host');
  return manager.stateFor('host', []).completedGames[0];
}

function finishBoard(manager) {
  manager.stateFor('host', []).game.categories.forEach((category, categoryIndex) => {
    category.clues.forEach((_clue, clueIndex) => {
      manager.openClue('host', { categoryIndex, clueIndex });
      manager.skipClue('host');
    });
  });
}

test('completed games retain tied final scores and a stable completion time without private data', () => {
  const f = fixture();
  f.manager.startGame('host', f.games[0].id);
  const runId = f.manager.stateFor('host', []).gameRunId;
  assert.match(runId, /^g_[a-f0-9]{12}$/);
  assert.deepEqual(f.manager.stateFor('host', []).completedGames, []);
  const result = complete(f);
  assert.deepEqual(result, {
    id: runId, gameId: f.games[0].id, title: f.games[0].title, custom: false,
    completedAt: result.completedAt, revision: 1,
    players: [{ id: f.first.playerId, name: 'Maya', score: 600 }, { id: f.second.playerId, name: 'Theo', score: 600 }],
  });
  assert.ok(result.completedAt > f.manager.rooms.get(f.host.code).gameStartedAt);
  const serialized = JSON.stringify(result);
  for (const privateValue of [f.host.token, f.first.token, f.second.token, 'Private response', 'wager', 'answer', 'socketId']) {
    assert.equal(serialized.includes(privateValue), false);
  }
  assert.throws(() => f.manager.finishFinal('host'), { code: 'FINAL_NOT_READY' });
  assert.deepEqual(f.manager.stateFor('first', []).completedGames, [result]);
  f.manager.disconnect('second');
  f.manager.resumeRoom('new-second', f.second);
  assert.deepEqual(f.manager.stateFor('new-second', []).completedGames, [result]);
});

test('replaying or resetting an episode creates a new run and never replaces the previous result', () => {
  const f = fixture();
  f.manager.startGame('host', f.games[0].id);
  const first = complete(f);
  f.manager.resetGame('host');
  const resetId = f.manager.stateFor('host', []).gameRunId;
  assert.notEqual(resetId, first.id);
  assert.deepEqual(f.manager.stateFor('host', []).completedGames, [first]);
  const second = complete(f, { firstScore: 800 });
  assert.equal(second.id, resetId);
  f.manager.returnToLobby('host');
  assert.equal(f.manager.stateFor('host', []).gameRunId, null);
  f.manager.startGame('host', f.games[0].id);
  const restartedId = f.manager.stateFor('host', []).gameRunId;
  assert.notEqual(restartedId, first.id);
  assert.notEqual(restartedId, second.id);
  f.manager.returnToLobby('host');
  assert.deepEqual(f.manager.stateFor('host', []).completedGames, [second, first]);
});

test('a disconnected contestant recovers prior results after another game begins but a new joiner cannot', () => {
  const f = fixture();
  f.manager.startGame('host', f.games[0].id);
  const result = complete(f, { disconnectBeforeFinish: true });
  f.manager.returnToLobby('host');
  f.manager.joinRoom('new-player', { code: f.host.code, name: 'Jordan' });
  assert.deepEqual(f.manager.stateFor('new-player', []).completedGames, []);
  f.manager.startGame('host', f.games[1].id);
  const saved = f.manager.exportSnapshot();
  const restored = new RoomManager({ games: f.games, now: () => saved.savedAt + 1 });
  restored.restoreSnapshot(saved);
  restored.resumeRoom('returning-player', f.second);
  assert.equal(restored.stateFor('returning-player', []).game.id, f.games[1].id);
  assert.deepEqual(restored.stateFor('returning-player', []).completedGames, [result]);
});

test('score corrections revise the completed result without changing its identity or completion date', () => {
  const f = fixture();
  f.manager.startGame('host', f.games[0].id);
  const result = complete(f);
  f.manager.adjustScore('host', { playerId: f.first.playerId, delta: 200 });
  const corrected = f.manager.stateFor('host', []).completedGames[0];
  assert.equal(corrected.id, result.id);
  assert.equal(corrected.completedAt, result.completedAt);
  assert.equal(corrected.revision, 2);
  assert.deepEqual(corrected.players.map((player) => player.score), [800, 600]);
  assert.deepEqual(result.players.map((player) => player.score), [600, 600]);
  f.manager.adjustScore('host', { playerId: f.first.playerId, delta: 0 });
  assert.equal(f.manager.stateFor('host', []).completedGames[0].revision, 2);
});

test('completed results retain departed players and exposed history cannot change authoritative scores', () => {
  const f = fixture();
  f.manager.startGame('host', f.games[0].id);
  const result = complete(f, { secondScore: -200 });
  f.manager.removePlayer('host', f.second.playerId);
  f.manager.adjustScore('host', { playerId: f.first.playerId, delta: 200 });
  const results = f.manager.stateFor('host', []).completedGames;
  assert.deepEqual(results[0].players[1], result.players[1]);
  results[0].players[0].score = 9000;
  assert.equal(f.manager.stateFor('host', []).completedGames[0].players[0].score, 800);
  const retained = f.manager.stateFor('first', []).completedGames;
  f.manager.closeRoom('host');
  assert.deepEqual(f.manager.exportSnapshot().rooms, []);
  assert.equal(retained[0].players.length, 2);
});

test('a completed two-round game with no eligible finalists still records zero and negative scores', () => {
  const f = fixture();
  const game = structuredClone(f.games[0]);
  game.doubleJeopardy = {
    categories: game.categories.map((category, categoryIndex) => ({
      ...category,
      clues: category.clues.map((clue, clueIndex) => ({
        ...clue, value: clue.value * 2, dailyDouble: categoryIndex < 2 && clueIndex === 0,
      })),
    })),
  };
  f.manager.gamesById.set(game.id, game);
  f.manager.startGame('host', game.id);
  finishBoard(f.manager);
  f.manager.advanceRound('host');
  finishBoard(f.manager);
  f.manager.adjustScore('host', { playerId: f.first.playerId, delta: -200 });
  f.manager.advanceRound('host');
  const state = f.manager.stateFor('host', []);
  assert.equal(state.final.phase, 'complete');
  assert.deepEqual(state.completedGames[0].players.map((player) => player.score), [-200, 0]);
  assert.equal(state.completedGames[0].id, state.gameRunId);
});

test('custom board results are identified without including their clues or answers', () => {
  const f = fixture();
  const custom = f.manager.createCustomGame('host', { ...f.games[0], title: 'Our board' });
  f.manager.startGame('host', custom.gameId);
  const result = complete(f);
  assert.equal(result.custom, true);
  assert.equal(result.title, 'Our board');
  assert.equal(result.gameId, custom.gameId);
  assert.equal(JSON.stringify(result).includes(f.games[0].categories[0].clues[0].answer), false);
});

test('rooms keep only their 25 most recently completed games', () => {
  const f = fixture();
  const ids = [];
  for (let index = 0; index < 27; index += 1) {
    f.manager.startGame('host', f.games[0].id);
    ids.push(complete(f).id);
  }
  assert.deepEqual(f.manager.stateFor('host', []).completedGames.map((game) => game.id), ids.slice(-25).reverse());
  const restored = new RoomManager({ games: f.games, now: () => 2000 });
  restored.restoreSnapshot(f.manager.exportSnapshot());
  restored.resumeRoom('host', f.host);
  assert.equal(restored.stateFor('host', []).completedGames.length, 25);
});

for (const phase of ['lobby', 'board', 'complete']) {
  test(`old ${phase} snapshots migrate without discarding rooms or inventing unfinished results`, () => {
    const f = fixture();
    if (phase !== 'lobby') f.manager.startGame('host', f.games[0].id);
    if (phase === 'complete') complete(f);
    const saved = f.manager.exportSnapshot();
    const room = saved.rooms[0];
    delete room.gameRunId;
    delete room.gameStartedAt;
    delete room.completedGames;
    const restored = new RoomManager({ games: f.games, now: () => saved.savedAt + 1 });
    restored.restoreSnapshot(saved);
    restored.resumeRoom('host', f.host);
    const state = restored.stateFor('host', []);
    assert.equal(state.completedGames.length, phase === 'complete' ? 1 : 0);
    assert.equal(state.gameRunId === null, phase === 'lobby');
    if (phase === 'complete') {
      assert.equal(state.completedGames[0].id, state.gameRunId);
      assert.equal(state.completedGames[0].completedAt, room.updatedAt);
    }
    const roundTrip = new RoomManager({ games: f.games, now: () => saved.savedAt + 2 });
    roundTrip.restoreSnapshot(restored.exportSnapshot());
    roundTrip.resumeRoom('host', f.host);
    assert.deepEqual(roundTrip.stateFor('host', []).completedGames, state.completedGames);
  });
}

test('malformed or partially missing history fields fail snapshot restore atomically', () => {
  const f = fixture();
  f.manager.startGame('host', f.games[0].id);
  complete(f);
  const saved = f.manager.exportSnapshot();
  const cases = [
    (room) => { delete room.completedGames; },
    (room) => { room.gameRunId = 'not-a-run'; },
    (room) => { room.gameStartedAt = -1; },
    (room) => { room.completedGames[0].revision = 0; },
    (room) => { room.completedGames[0].completedAt = -1; },
    (room) => { room.completedGames[0].players[0].score = '600'; },
    (room) => { room.completedGames[0].players.push(room.completedGames[0].players[0]); },
    (room) => { room.completedGames.push(room.completedGames[0]); },
  ];
  for (const corrupt of cases) {
    const damaged = structuredClone(saved);
    corrupt(damaged.rooms[0]);
    assert.throws(() => f.manager.restoreSnapshot(damaged), /Invalid room snapshot/);
    assert.equal(f.manager.stateFor('host', []).completedGames[0].id, saved.rooms[0].completedGames[0].id);
  }
});
