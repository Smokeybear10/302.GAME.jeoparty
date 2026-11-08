'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadGames } = require('../lib/game-store');
const { RoomManager } = require('../lib/room-manager');

function fixture({ playingHost = false, double = false, mode = 'full' } = {}) {
  const game = structuredClone(loadGames()[0]);
  if (double) game.doubleJeopardy = {
    categories: game.categories.map((category, categoryIndex) => ({
      ...category,
      clues: category.clues.map((clue, clueIndex) => ({ ...clue, value: clue.value * 2, dailyDouble: categoryIndex < 2 && clueIndex === 0 })),
    })),
  };
  let now = 1000;
  const manager = new RoomManager({ games: [game], now: () => now++ });
  const host = manager.createRoom('host');
  if (playingHost) manager.joinHostAsPlayer('host', { name: 'Alex' });
  const first = manager.joinRoom('first', { code: host.code, name: 'Maya' });
  const second = manager.joinRoom('second', { code: host.code, name: 'Theo' });
  manager.startGame('host', game.id, { mode });
  return { manager, game, host, first, second };
}

function locate(game, dailyDouble = false) {
  return game.categories.flatMap((category, categoryIndex) => category.clues.map((clue, clueIndex) => ({ categoryIndex, clueIndex, clue })))
    .find(({ clue }) => Boolean(clue.dailyDouble) === dailyDouble);
}

function readyClue(f, { dailyDouble = false, queued = false } = {}) {
  const { manager, game, first } = f;
  const location = locate(game, dailyDouble);
  manager.openClue('host', location);
  if (dailyDouble) manager.setDailyDouble('host', { playerId: first.playerId, wager: 750 });
  else {
    manager.buzz('first');
    if (queued) manager.buzz('second');
  }
  const clueKey = manager.stateFor('first', []).currentClue.clueKey;
  manager.openPlayerAnswer('first', { clueKey });
  return { ...location, clueKey };
}

function playClues(f, count) {
  const locations = f.game.categories.flatMap((category, categoryIndex) => category.clues.map((_, clueIndex) => ({ categoryIndex, clueIndex })));
  for (const location of locations.slice(0, count)) {
    f.manager.openClue('host', location);
    f.manager.skipClue('host');
  }
}

function rollbackSnapshot(f) {
  const restored = new RoomManager({ games: [f.game], now: () => 10000 });
  restored.restoreSnapshot(JSON.parse(JSON.stringify(f.manager.exportSnapshot())), { restoreConnections: true, expire: false });
  return restored;
}

for (const correct of [true, false]) {
  test(`host undoes a ${correct ? 'correct' : 'incorrect'} judgment exactly once, restoring private review and buzz order`, () => {
    const f = fixture();
    const { clueKey } = readyClue(f, { queued: true });
    const prior = f.manager.stateFor('first', []);
    f.manager.selfScoreClue('first', { clueKey, correct });
    const undo = f.manager.stateFor('host', []).scoreUndo;
    assert.match(undo.id, /^u_[a-f0-9]{12}$/);
    assert.deepEqual(Object.keys(undo).sort(), ['id', 'label']);
    assert.equal(f.manager.stateFor('first', []).scoreUndo, null);
    assert.equal(f.manager.stateFor('second', []).scoreUndo, null);
    assert.throws(() => f.manager.undoScore('second', { actionId: undo.id }), { code: 'HOST_ONLY' });
    assert.throws(() => f.manager.undoScore('host', { actionId: 'stale' }), { code: 'UNDO_UNAVAILABLE' });
    assert.equal(f.manager.stateFor('host', []).scoreUndo.id, undo.id);
    const restored = rollbackSnapshot(f);
    restored.undoScore('host', { actionId: undo.id });
    assert.equal(restored.stateFor('first', []).you.score, prior.you.score);
    assert.deepEqual(restored.stateFor('first', []).currentClue, prior.currentClue);
    assert.equal(Object.hasOwn(restored.stateFor('host', []).currentClue, 'privateAnswer'), false);
    assert.equal(Object.hasOwn(restored.stateFor('second', []).currentClue, 'privateAnswer'), false);
    assert.throws(() => restored.undoScore('host', { actionId: undo.id }), { code: 'UNDO_UNAVAILABLE' });
    restored.selfScoreClue('first', { clueKey, correct: !correct });
    assert.equal(restored.stateFor('first', []).you.score, correct ? -200 : 200);
    assert.notEqual(restored.stateFor('host', []).scoreUndo.id, undo.id);
  });
}

test('Daily Double undo restores the exact wager and private answer without exposing them to the host', () => {
  const f = fixture();
  const { clueKey } = readyClue(f, { dailyDouble: true });
  f.manager.selfScoreClue('first', { clueKey, correct: false });
  assert.equal(f.manager.stateFor('first', []).you.score, -750);
  const undo = f.manager.stateFor('host', []).scoreUndo;
  f.manager.undoScore('host', { actionId: undo.id });
  const state = f.manager.stateFor('first', []);
  assert.equal(state.you.score, 0);
  assert.equal(state.currentClue.value, 750);
  assert.ok(state.currentClue.privateAnswer);
  f.manager.selfScoreClue('first', { clueKey, correct: true });
  assert.equal(f.manager.stateFor('first', []).you.score, 750);
});

test('undo restores the previous picker after a correct answer transfers control', () => {
  const f = fixture({ playingHost: true });
  const originalController = f.manager.stateFor('host', []).controlPlayerId;
  const { clueKey } = readyClue(f);
  f.manager.selfScoreClue('first', { clueKey, correct: true });
  assert.equal(f.manager.stateFor('host', []).controlPlayerId, f.first.playerId);
  f.manager.undoScore('host', { actionId: f.manager.stateFor('host', []).scoreUndo.id });
  assert.equal(f.manager.stateFor('host', []).controlPlayerId, originalController);
  assert.equal(f.manager.stateFor('first', []).currentClue.canSelfScore, true);
});

test('a Final judgment can be undone before progression without rescoring another contestant', () => {
  const f = fixture();
  f.manager.adjustScore('host', { playerId: f.first.playerId, delta: 1000 });
  f.manager.adjustScore('host', { playerId: f.second.playerId, delta: 1000 });
  f.manager.startFinal('host');
  f.manager.submitFinalWager('first', 300);
  f.manager.submitFinalWager('second', 500);
  f.manager.advanceFinal('host');
  f.manager.submitFinalResponse('first', 'Private Maya answer');
  f.manager.submitFinalResponse('second', 'Private Theo answer');
  f.manager.advanceFinal('host');
  f.manager.selfScoreFinal('first', { correct: true });
  f.manager.selfScoreFinal('second', { correct: false });
  const undo = f.manager.stateFor('host', []).scoreUndo;
  assert.doesNotMatch(undo.label, /500|Private Theo answer/);
  const restored = rollbackSnapshot(f);
  restored.undoScore('host', { actionId: undo.id });
  assert.equal(restored.stateFor('first', []).you.score, 1300);
  assert.equal(restored.stateFor('second', []).you.score, 1000);
  assert.equal(restored.stateFor('second', []).final.canSelfScore, true);
  assert.equal(restored.stateFor('second', []).final.yourResponse, 'Private Theo answer');
  assert.equal(JSON.stringify(restored.stateFor('host', [])).includes('Private Theo answer'), false);
  restored.selfScoreFinal('second', { correct: true });
  const lastUndo = restored.stateFor('host', []).scoreUndo;
  restored.finishFinal('host');
  assert.throws(() => restored.undoScore('host', { actionId: lastUndo.id }), { code: 'UNDO_UNAVAILABLE' });
  assert.deepEqual(restored.stateFor('host', []).completedGames[0].players.map((player) => player.score), [1300, 1500]);
});

for (const nextAction of ['new clue', 'another answer check', 'disconnect', 'score adjustment', 'reset', 'remove player', 'transfer host']) {
  test(`undo becomes unavailable after ${nextAction}`, () => {
    const f = fixture();
    const { clueKey, categoryIndex, clueIndex } = readyClue(f, { queued: true });
    f.manager.selfScoreClue('first', { clueKey, correct: nextAction !== 'another answer check' });
    const undo = f.manager.stateFor('host', []).scoreUndo;
    if (nextAction === 'new clue') f.manager.openClue('host', { categoryIndex, clueIndex: (clueIndex + 1) % 5 });
    if (nextAction === 'another answer check') f.manager.openPlayerAnswer('second', { clueKey });
    if (nextAction === 'disconnect') f.manager.disconnect('second');
    if (nextAction === 'score adjustment') f.manager.adjustScore('host', { playerId: f.first.playerId, delta: 200 });
    if (nextAction === 'reset') f.manager.resetGame('host');
    if (nextAction === 'remove player') f.manager.removePlayer('host', f.second.playerId);
    if (nextAction === 'transfer host') f.manager.transferHost('host', { playerId: f.second.playerId });
    const hostSocket = nextAction === 'transfer host' ? 'second' : 'host';
    assert.equal(f.manager.stateFor(hostSocket, []).scoreUndo, null);
    assert.throws(() => f.manager.undoScore(hostSocket, { actionId: undo.id }), { code: 'UNDO_UNAVAILABLE' });
  });
}

test('host transfer preserves contestant IDs, scores, turns and private answers while revoking old hosting privilege', () => {
  const f = fixture({ playingHost: true });
  const oldHostId = f.manager.stateFor('host', []).you.id;
  const { clueKey } = readyClue(f);
  const before = f.manager.stateFor('first', []);
  const transferred = f.manager.transferHost('host', { playerId: f.first.playerId });
  assert.equal(transferred.formerHostSocketId, 'host');
  assert.equal(transferred.newHostSocketId, 'first');
  assert.deepEqual(transferred.formerHostSession, { ...f.host, role: 'player', playerId: oldHostId });
  assert.deepEqual(transferred.newHostSession, { code: f.host.code, role: 'host', token: f.first.token });
  const after = f.manager.stateFor('first', []);
  assert.equal(after.role, 'host');
  assert.equal(after.you.id, before.you.id);
  assert.equal(after.you.score, before.you.score);
  assert.equal(after.currentClue.privateAnswer, before.currentClue.privateAnswer);
  assert.equal(after.controlPlayerId, before.controlPlayerId);
  assert.equal(f.manager.stateFor('host', []).role, 'player');
  assert.throws(() => f.manager.resetGame('host'), { code: 'HOST_ONLY' });
  const restored = rollbackSnapshot(f);
  assert.equal(restored.resumeRoom('new-old-host', f.host).role, 'player');
  assert.equal(restored.resumeRoom('new-host', f.first).role, 'host');
  restored.selfScoreClue('new-host', { clueKey, correct: true });
  assert.equal(restored.stateFor('new-host', []).you.score, 200);
  assert.equal(restored.stateFor('new-old-host', []).you.id, oldHostId);
});

test('a dedicated host leaves cleanly when handing off without creating an extra contestant', () => {
  const f = fixture();
  const { clueKey } = readyClue(f, { dailyDouble: true });
  const transfer = f.manager.transferHost('host', { playerId: f.second.playerId });
  assert.equal(transfer.formerHostSession, null);
  assert.equal(f.manager.roomCodeForSocket('host'), null);
  assert.equal(f.manager.stateFor('second', []).players.length, 2);
  assert.equal(f.manager.stateFor('second', []).controlPlayerId, f.first.playerId);
  assert.throws(() => f.manager.resumeRoom('old-host-return', f.host), { code: 'SESSION_EXPIRED' });
  assert.ok(f.manager.stateFor('first', []).currentClue.privateAnswer);
  assert.equal(Object.hasOwn(f.manager.stateFor('second', []).currentClue, 'privateAnswer'), false);
  f.manager.selfScoreClue('first', { clueKey, correct: true });
  assert.equal(f.manager.stateFor('first', []).you.score, 750);
  rollbackSnapshot(f);
});

test('handoff requires the current host and an online different contestant, including during Final', () => {
  const f = fixture({ playingHost: true });
  assert.throws(() => f.manager.transferHost('second', { playerId: f.first.playerId }), { code: 'HOST_ONLY' });
  assert.throws(() => f.manager.transferHost('host', { playerId: f.manager.stateFor('host', []).you.id }), { code: 'INVALID_HOST' });
  assert.throws(() => f.manager.transferHost('host', { playerId: 'missing' }), { code: 'INVALID_HOST' });
  f.manager.disconnect('second');
  assert.throws(() => f.manager.transferHost('host', { playerId: f.second.playerId }), { code: 'PLAYER_OFFLINE' });
  f.manager.adjustScore('host', { playerId: f.first.playerId, delta: 600 });
  f.manager.startFinal('host');
  f.manager.submitFinalWager('first', 200);
  f.manager.advanceFinal('host');
  f.manager.submitFinalResponse('first', 'Private Final answer');
  f.manager.transferHost('host', { playerId: f.first.playerId });
  assert.equal(f.manager.stateFor('first', []).final.yourResponse, 'Private Final answer');
  assert.equal(JSON.stringify(f.manager.stateFor('host', [])).includes('Private Final answer'), false);
  f.manager.advanceFinal('first');
  f.manager.selfScoreFinal('first', { correct: true });
  f.manager.finishFinal('first');
  assert.equal(f.manager.stateFor('first', []).you.score, 800);
  rollbackSnapshot(f);
});

for (const double of [false, true]) {
  test(`quick mode ends after any 15 first-board clues with ${double ? 'two-round' : 'single-round'} source data`, () => {
    const f = fixture({ double, mode: 'quick' });
    let state = f.manager.stateFor('host', []);
    assert.equal(state.gameMode, 'quick');
    assert.equal(state.game.totalClues, 15);
    assert.equal(state.game.remainingClues, 15);
    assert.equal(state.game.hasDoubleJeopardy, false);
    assert.equal(state.nextRoundName, 'Final Jeopardy');
    assert.throws(() => f.manager.startFinal('host'), { code: 'ROUND_INCOMPLETE' });
    assert.throws(() => f.manager.advanceRound('host'), { code: 'ROUND_INCOMPLETE' });
    playClues(f, 15);
    state = f.manager.stateFor('host', []);
    assert.equal(state.game.remainingClues, 0);
    assert.equal(state.canChooseClue, false);
    assert.equal(state.canStartNextRound, true);
    assert.throws(() => f.manager.openClue('host', { categoryIndex: 5, clueIndex: 4 }), { code: 'ROUND_COMPLETE' });
    f.manager.advanceRound('host');
    state = f.manager.stateFor('host', []);
    assert.equal(state.round, 'jeopardy');
    assert.equal(state.final.phase, 'complete');
    assert.equal(state.completedGames[0].gameMode, 'quick');
    assert.equal(state.completedGames[0].gameId, f.game.id);
    rollbackSnapshot(f);
    f.manager.resetGame('host');
    assert.equal(f.manager.stateFor('host', []).gameMode, 'quick');
    assert.equal(f.manager.stateFor('host', []).game.remainingClues, 15);
    f.manager.returnToLobby('host');
    assert.equal(f.manager.stateFor('host', []).gameMode, 'full');
  });
}

test('quick mode supports private Final scoring, restart, and custom boards without changing the question bank', () => {
  const f = fixture({ double: true, mode: 'quick' });
  const original = JSON.stringify(f.game);
  playClues(f, 15);
  f.manager.adjustScore('host', { playerId: f.first.playerId, delta: 500 });
  f.manager.advanceRound('host');
  f.manager.submitFinalWager('first', 200);
  f.manager.advanceFinal('host');
  f.manager.submitFinalResponse('first', 'Private answer');
  const restored = rollbackSnapshot(f);
  restored.advanceFinal('host');
  restored.selfScoreFinal('first', { correct: true });
  restored.finishFinal('host');
  assert.equal(restored.stateFor('first', []).you.score, 700);
  assert.equal(restored.stateFor('host', []).completedGames[0].gameMode, 'quick');
  assert.equal(JSON.stringify(f.game), original);
  restored.returnToLobby('host');
  const custom = restored.createCustomGame('host', { ...f.game, title: 'Quick custom' });
  restored.startGame('host', custom.gameId, { mode: 'quick' });
  assert.equal(restored.stateFor('host', []).game.totalClues, 15);
});

test('invalid quick modes fail without resetting the current game and full episodes retain both boards', () => {
  const f = fixture({ double: true });
  const runId = f.manager.stateFor('host', []).gameRunId;
  assert.throws(() => f.manager.startGame('host', f.game.id, { mode: 'fast' }), { code: 'INVALID_GAME_MODE' });
  assert.equal(f.manager.stateFor('host', []).gameRunId, runId);
  assert.equal(f.manager.stateFor('host', []).game.totalClues, 30);
  assert.equal(f.manager.stateFor('host', []).game.hasDoubleJeopardy, true);
  playClues(f, 30);
  f.manager.advanceRound('host');
  assert.equal(f.manager.stateFor('host', []).round, 'double');
  assert.equal(f.manager.stateFor('host', []).game.totalClues, 30);
});

test('old snapshots default to full mode and no undo, while corrupt mode or undo backups are rejected atomically', () => {
  const f = fixture();
  const { clueKey } = readyClue(f);
  f.manager.selfScoreClue('first', { clueKey, correct: true });
  const saved = f.manager.exportSnapshot();
  const old = structuredClone(saved);
  delete old.rooms[0].gameMode;
  delete old.rooms[0].scoreUndo;
  const restored = new RoomManager({ games: [f.game], now: () => 10000 });
  restored.restoreSnapshot(old, { restoreConnections: true, expire: false });
  assert.equal(restored.stateFor('host', []).gameMode, 'full');
  assert.equal(restored.stateFor('host', []).scoreUndo, null);
  for (const corrupt of [
    (room) => { room.gameMode = 'fast'; },
    (room) => { room.scoreUndo.playerId = 'missing'; },
    (room) => { room.scoreUndo.gameRunId = 'g_000000000000'; },
    (room) => { room.scoreUndo.previousScore = '100'; },
    (room) => { room.scoreUndo.currentClue.ineligiblePlayerIds = ['missing']; },
  ]) {
    const damaged = structuredClone(saved);
    corrupt(damaged.rooms[0]);
    assert.throws(() => restored.restoreSnapshot(damaged), /Invalid room snapshot/);
    assert.equal(restored.stateFor('host', []).gameMode, 'full');
  }
});
