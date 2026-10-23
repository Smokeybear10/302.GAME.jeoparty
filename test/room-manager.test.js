'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { catalogGames, loadGames } = require('../lib/game-store');
const { RoomError, RoomManager } = require('../lib/room-manager');

function setupRoom() {
  const games = loadGames();
  let timestamp = 1000;
  const manager = new RoomManager({ games, now: () => timestamp++ });
  const host = manager.createRoom('host-1');
  const first = manager.joinRoom('player-1', { code: host.code, name: 'Maya' });
  const second = manager.joinRoom('player-2', { code: host.code, name: 'Theo' });
  return { catalog: catalogGames(games), first, games, host, manager, second };
}

function locateClue(game, predicate) {
  for (let categoryIndex = 0; categoryIndex < game.categories.length; categoryIndex += 1) {
    for (let clueIndex = 0; clueIndex < game.categories[categoryIndex].clues.length; clueIndex += 1) {
      const clue = game.categories[categoryIndex].clues[clueIndex];
      if (predicate(clue)) return { categoryIndex, clueIndex, clue };
    }
  }
  throw new Error('Matching clue not found');
}

function customGameInput(game) {
  return {
    title: 'Thomas Custom Board',
    description: 'Made in the room editor',
    categories: game.categories.map((category) => ({
      name: category.name,
      clues: category.clues.map((clue) => ({
        clue: clue.clue,
        answer: clue.answer,
        dailyDouble: clue.dailyDouble === true,
      })),
    })),
    finalJeopardy: { ...game.finalJeopardy },
  };
}

for (const departure of ['leave', 'remove']) {
  test(`buzzing reopens when the promoted responder ${departure}s before checking their answer`, () => {
    const { catalog, games, host, manager, second } = setupRoom();
    const third = manager.joinRoom('player-3', { code: host.code, name: 'Jordan' });
    manager.startGame('host-1', games[0].id);
    manager.openClue('host-1', locateClue(games[0], (clue) => !clue.dailyDouble));
    manager.buzz('player-1');
    manager.buzz('player-2');
    const clueKey = manager.stateFor('player-1', catalog).currentClue.clueKey;
    manager.openPlayerAnswer('player-1', { clueKey });
    manager.selfScoreClue('player-1', { clueKey, correct: false });
    assert.equal(manager.stateFor('player-2', catalog).currentClue.responderPlayerId, second.playerId);

    if (departure === 'leave') manager.leaveRoom('player-2');
    else manager.removePlayer('host-1', second.playerId);

    assert.equal(manager.stateFor('player-3', catalog).currentClue.buzzOpen, true);
    manager.buzz('player-3');
    assert.equal(manager.stateFor('player-3', catalog).currentClue.responderPlayerId, third.playerId);
  });
}

test('host can create, select, and play a room-scoped custom board', () => {
  const { catalog, games, manager } = setupRoom();
  const created = manager.createCustomGame('host-1', customGameInput(games[0]));

  assert.match(created.gameId, /^custom-/);
  const hostLobby = manager.stateFor('host-1', catalog);
  assert.equal(hostLobby.gameCatalog[0].id, created.gameId);
  assert.equal(hostLobby.gameCatalog[0].title, 'Thomas Custom Board');
  assert.equal(hostLobby.gameCatalog[0].source, 'custom');
  assert.equal(hostLobby.gameCatalog[0].year, null);
  assert.equal(Object.hasOwn(manager.stateFor('player-1', catalog), 'gameCatalog'), false);

  manager.startGame('host-1', created.gameId);
  const board = manager.stateFor('host-1', catalog).game;
  assert.equal(board.id, created.gameId);
  assert.equal(board.title, 'Thomas Custom Board');
  assert.equal(board.categories.length, 6);
});

test('the episode catalog is available in the lobby but excluded from gameplay broadcasts', () => {
  const { catalog, first, games, manager } = setupRoom();
  const created = manager.createCustomGame('host-1', customGameInput(games[0]));
  assert.equal(manager.stateFor('host-1', catalog).gameCatalog.length, catalog.length + 1);
  manager.startGame('host-1', games[0].id);
  assert.equal(Object.hasOwn(manager.stateFor('host-1', catalog), 'gameCatalog'), false);
  manager.openClue('host-1', locateClue(games[0], (clue) => !clue.dailyDouble));
  manager.buzz('player-1');
  assert.equal(Object.hasOwn(manager.stateFor('host-1', catalog), 'gameCatalog'), false);
  manager.skipClue('host-1');
  manager.adjustScore('host-1', { playerId: first.playerId, delta: 200 });
  manager.startFinal('host-1');
  assert.equal(Object.hasOwn(manager.stateFor('host-1', catalog), 'gameCatalog'), false);
  manager.returnToLobby('host-1');
  assert.equal(manager.stateFor('host-1', catalog).gameCatalog[0].id, created.gameId);
});

test('custom boards are validated and remain host-only', () => {
  const { games, manager } = setupRoom();
  const incomplete = customGameInput(games[0]);
  incomplete.finalJeopardy.answer = '';

  assert.throws(
    () => manager.createCustomGame('host-1', incomplete),
    (error) => error instanceof RoomError && error.code === 'INVALID_CUSTOM_GAME',
  );
  assert.throws(
    () => manager.createCustomGame('player-1', customGameInput(games[0])),
    (error) => error instanceof RoomError && error.code === 'HOST_ONLY',
  );
});

test('creates rooms, enforces unique names, and resumes disconnected sessions', () => {
  const { catalog, first, host, manager } = setupRoom();

  assert.equal(host.code.length, 5);
  assert.throws(
    () => manager.joinRoom('player-3', { code: host.code, name: '  maya  ' }),
    (error) => error instanceof RoomError && error.code === 'NAME_TAKEN',
  );

  manager.disconnect('player-1');
  assert.equal(manager.stateFor('host-1', catalog).players.find((player) => player.id === first.playerId).connected, false);

  const resumed = manager.resumeRoom('player-1-new', { code: host.code, token: first.token });
  assert.equal(resumed.playerId, first.playerId);
  assert.equal(resumed.token, first.token);
  assert.equal(manager.stateFor('player-1-new', catalog).you.name, 'Maya');
  assert.equal(manager.stateFor('host-1', catalog).players.find((player) => player.id === first.playerId).connected, true);
});

test('an active session takeover ejects the previous socket without risking lost credentials', () => {
  const { catalog, first, host, manager } = setupRoom();
  const resumed = manager.resumeRoom('player-1-new', { code: host.code, token: first.token });

  assert.equal(resumed.replacedSocketId, 'player-1');
  assert.throws(() => manager.stateFor('player-1', catalog), (error) => error.code === 'NOT_IN_ROOM');
  assert.equal(manager.stateFor('player-1-new', catalog).you.id, first.playerId);
  const retried = manager.resumeRoom('player-1-retry', { code: host.code, token: first.token });
  assert.equal(retried.replacedSocketId, 'player-1-new');
  assert.equal(retried.token, first.token);
});

test('host stays a dedicated controller while remote contestants own the buzzer and answer check', () => {
  const { catalog, first, games, manager, second } = setupRoom();
  const location = locateClue(games[0], (clue) => !clue.dailyDouble);
  manager.startGame('host-1', games[0].id);
  manager.openClue('host-1', location);
  manager.buzz('player-2');
  manager.buzz('player-1');
  assert.throws(() => manager.buzz('host-1'), (error) => error.code === 'CONTESTANT_ONLY');
  assert.deepEqual(
    manager.stateFor('host-1', catalog).currentClue.buzzes.map((buzz) => buzz.playerId),
    [second.playerId, first.playerId],
  );
  const clueKey = manager.stateFor('player-2', catalog).currentClue.clueKey;
  assert.throws(
    () => manager.openPlayerAnswer('host-1', { clueKey }),
    (error) => error.code === 'CONTESTANT_ONLY',
  );
  manager.openPlayerAnswer('player-2', { clueKey });
  assert.equal(Object.hasOwn(manager.stateFor('host-1', catalog).currentClue, 'privateAnswer'), false);
  assert.equal(manager.stateFor('player-2', catalog).currentClue.privateAnswer, location.clue.answer);
});

test('host contestant membership is lobby-only, counts toward the cap, and cannot be generically removed', () => {
  const games = loadGames();
  const manager = new RoomManager({ games });
  const host = manager.createRoom('host-cap');
  manager.joinHostAsPlayer('host-cap', { name: 'Host Player' });
  const hostPlayerId = manager.stateFor('host-cap', catalogGames(games)).you.id;

  for (let index = 1; index <= 7; index += 1) {
    manager.joinRoom(`player-cap-${index}`, { code: host.code, name: `Player ${index}` });
  }
  assert.equal(manager.stateFor('host-cap', catalogGames(games)).players.length, 8);
  assert.throws(
    () => manager.joinRoom('player-cap-8', { code: host.code, name: 'Player 8' }),
    (error) => error.code === 'ROOM_FULL',
  );
  assert.throws(
    () => manager.removePlayer('host-cap', hostPlayerId),
    (error) => error.code === 'CANNOT_REMOVE_HOST',
  );

  manager.leaveHostAsPlayer('host-cap');
  assert.equal(manager.stateFor('host-cap', catalogGames(games)).you, null);
  assert.equal(manager.stateFor('host-cap', catalogGames(games)).players.length, 7);
  manager.startGame('host-cap', games[0].id);
  assert.throws(
    () => manager.joinHostAsPlayer('host-cap', { name: 'Host Player' }),
    (error) => error.code === 'LOBBY_ONLY',
  );
  assert.throws(
    () => manager.leaveHostAsPlayer('host-cap'),
    (error) => error.code === 'LOBBY_ONLY',
  );
});

test('host reconnect never receives a contestant private answer', () => {
  const { catalog, games, host, manager } = setupRoom();
  manager.joinHostAsPlayer('host-1', { name: 'Alex' });
  const beforeDisconnect = manager.stateFor('host-1', catalog).you;
  manager.startGame('host-1', games[0].id);
  manager.adjustScore('host-1', { playerId: beforeDisconnect.id, delta: 600 });
  const location = locateClue(games[0], (clue) => !clue.dailyDouble);
  manager.openClue('host-1', location);
  manager.buzz('player-1');
  const clueKey = manager.stateFor('player-1', catalog).currentClue.clueKey;
  manager.openPlayerAnswer('player-1', { clueKey });
  manager.disconnect('host-1');

  const disconnectedHost = manager.stateFor('player-1', catalog).players.find((player) => player.id === beforeDisconnect.id);
  assert.equal(disconnectedHost.connected, false);
  assert.equal(disconnectedHost.isHost, true);

  manager.resumeRoom('host-resumed', { code: host.code, token: host.token });
  const resumedState = manager.stateFor('host-resumed', catalog);
  assert.equal(resumedState.role, 'host');
  assert.equal(resumedState.you.id, beforeDisconnect.id);
  assert.equal(resumedState.you.connected, true);
  assert.equal(resumedState.you.score, 600);
  assert.equal(resumedState.currentClue.selfJudgePlayerId, manager.stateFor('player-1', catalog).you.id);
  assert.equal(Object.hasOwn(resumedState.currentClue, 'answer'), false);
  assert.equal(Object.hasOwn(resumedState.currentClue, 'privateAnswer'), false);

  const takeover = manager.resumeRoom('host-takeover', { code: host.code, token: host.token });
  assert.equal(takeover.replacedSocketId, 'host-resumed');
  assert.throws(() => manager.stateFor('host-resumed', catalog), (error) => error.code === 'NOT_IN_ROOM');
  const takeoverState = manager.stateFor('host-takeover', catalog);
  assert.equal(takeoverState.you.id, beforeDisconnect.id);
  assert.equal(takeoverState.you.connected, true);
  assert.equal(takeoverState.players.filter((player) => player.isHost).length, 1);
});

test('only the active contestant sees the answer and self-scoring promotes the buzz queue', () => {
  const { catalog, first, games, manager, second } = setupRoom();
  const game = games[0];
  const location = locateClue(game, (clue) => !clue.dailyDouble);
  manager.startGame('host-1', game.id);
  manager.openClue('host-1', location);

  const hostState = manager.stateFor('host-1', catalog);
  const playerState = manager.stateFor('player-1', catalog);
  assert.equal(Object.hasOwn(hostState.currentClue, 'answer'), false);
  assert.equal(Object.hasOwn(hostState.currentClue, 'privateAnswer'), false);
  assert.equal(Object.hasOwn(playerState.currentClue, 'answer'), false);
  assert.equal(Object.hasOwn(playerState.currentClue, 'privateAnswer'), false);
  assert.equal(JSON.stringify(playerState.game).includes(location.clue.clue), false);

  manager.buzz('player-2');
  manager.buzz('player-1');
  assert.deepEqual(
    manager.stateFor('host-1', catalog).currentClue.buzzes.map((buzz) => buzz.playerId),
    [second.playerId, first.playerId],
  );
  const clueKey = manager.stateFor('player-2', catalog).currentClue.clueKey;
  assert.throws(
    () => manager.openPlayerAnswer('player-1', { clueKey }),
    (error) => error.code === 'NOT_RESPONDER',
  );
  assert.throws(
    () => manager.selfScoreClue('player-2', { clueKey, correct: true }),
    (error) => error.code === 'ANSWER_NOT_OPEN',
  );
  manager.openPlayerAnswer('player-2', { clueKey });
  const activeState = manager.stateFor('player-2', catalog);
  assert.equal(activeState.currentClue.privateAnswer, location.clue.answer);
  assert.equal(activeState.currentClue.canSelfScore, true);
  assert.equal(Object.hasOwn(manager.stateFor('host-1', catalog).currentClue, 'privateAnswer'), false);
  assert.equal(Object.hasOwn(manager.stateFor('player-1', catalog).currentClue, 'privateAnswer'), false);
  assert.throws(() => manager.resetBuzzers('host-1'), (error) => error.code === 'RESPONSE_IN_REVIEW');
  assert.throws(() => manager.revealAnswer('host-1'), (error) => error.code === 'RESPONDER_ACTIVE');
  assert.throws(
    () => manager.selfScoreClue('player-2', { clueKey, correct: 'yes' }),
    (error) => error.code === 'INVALID_JUDGMENT',
  );

  manager.selfScoreClue('player-2', { clueKey, correct: false });
  const afterMiss = manager.stateFor('host-1', catalog);
  assert.equal(afterMiss.players.find((player) => player.id === second.playerId).score, -location.clue.value);
  assert.equal(afterMiss.currentClue.buzzOpen, false);
  assert.equal(afterMiss.currentClue.responderPlayerId, first.playerId);
  assert.equal(afterMiss.currentClue.selfJudgePlayerId, null);
  assert.deepEqual(afterMiss.currentClue.buzzes.map((buzz) => buzz.playerId), [first.playerId]);
  manager.openPlayerAnswer('player-1', { clueKey });
  manager.selfScoreClue('player-1', { clueKey, correct: true });
  const completeState = manager.stateFor('host-1', catalog);
  assert.equal(completeState.currentClue, null);
  assert.equal(completeState.players.find((player) => player.id === first.playerId).score, location.clue.value);
  assert.equal(completeState.game.categories[location.categoryIndex].clues[location.clueIndex].answered, true);
});

test('a private answer survives contestant reconnect and rejects stale clue actions', () => {
  const { catalog, first, games, manager } = setupRoom();
  const location = locateClue(games[0], (clue) => !clue.dailyDouble);
  manager.startGame('host-1', games[0].id);
  manager.openClue('host-1', location);
  manager.buzz('player-1');
  const clueKey = manager.stateFor('player-1', catalog).currentClue.clueKey;
  assert.throws(
    () => manager.openPlayerAnswer('player-1', { clueKey: 'stale:key' }),
    (error) => error.code === 'STALE_CLUE',
  );
  manager.openPlayerAnswer('player-1', { clueKey });
  manager.disconnect('player-1');
  assert.equal(Object.hasOwn(manager.stateFor('host-1', catalog).currentClue, 'privateAnswer'), false);

  manager.resumeRoom('player-reconnected', { code: manager.stateFor('host-1', catalog).code, token: first.token });
  const resumed = manager.stateFor('player-reconnected', catalog);
  assert.equal(resumed.currentClue.privateAnswer, location.clue.answer);
  assert.equal(resumed.currentClue.canSelfScore, true);
  manager.selfScoreClue('player-reconnected', { clueKey, correct: true });
  assert.equal(manager.stateFor('host-1', catalog).players.find((player) => player.id === first.playerId).score, location.clue.value);
});

test('host can reset a queued buzzer before any private answer is opened', () => {
  const { catalog, games, manager } = setupRoom();
  const location = locateClue(games[0], (clue) => !clue.dailyDouble);
  manager.startGame('host-1', games[0].id);
  manager.openClue('host-1', location);
  manager.buzz('player-1');
  manager.buzz('player-2');
  manager.resetBuzzers('host-1');

  const clue = manager.stateFor('host-1', catalog).currentClue;
  assert.deepEqual(clue.buzzes, []);
  assert.equal(clue.responderPlayerId, null);
  assert.equal(clue.buzzOpen, true);
  manager.buzz('player-2');
  assert.equal(manager.stateFor('host-1', catalog).currentClue.buzzes[0].name, 'Theo');
});

test('leaving during a private check safely promotes the next queued contestant', () => {
  const { catalog, first, games, manager, second } = setupRoom();
  const location = locateClue(games[0], (clue) => !clue.dailyDouble);
  manager.startGame('host-1', games[0].id);
  manager.openClue('host-1', location);
  manager.buzz('player-1');
  manager.buzz('player-2');
  const clueKey = manager.stateFor('player-1', catalog).currentClue.clueKey;
  manager.openPlayerAnswer('player-1', { clueKey });
  manager.leaveRoom('player-1');

  const clue = manager.stateFor('host-1', catalog).currentClue;
  assert.equal(clue.responderPlayerId, second.playerId);
  assert.equal(clue.selfJudgePlayerId, null);
  assert.equal(clue.buzzOpen, false);
  assert.equal(clue.buzzes.some((buzz) => buzz.playerId === first.playerId), false);
  manager.openPlayerAnswer('player-2', { clueKey });
  manager.selfScoreClue('player-2', { clueKey, correct: true });
  assert.equal(manager.stateFor('host-1', catalog).players[0].score, location.clue.value);
});

test('host can show an unclaimed answer to players without receiving it', () => {
  const { catalog, games, manager } = setupRoom();
  const location = locateClue(games[0], (clue) => !clue.dailyDouble);
  manager.startGame('host-1', games[0].id);
  manager.openClue('host-1', location);
  manager.revealAnswer('host-1');
  const hostClue = manager.stateFor('host-1', catalog).currentClue;
  assert.equal(hostClue.revealed, true);
  assert.equal(Object.hasOwn(hostClue, 'answer'), false);
  assert.equal(Object.hasOwn(hostClue, 'privateAnswer'), false);
  assert.equal(manager.stateFor('player-1', catalog).currentClue.answer, location.clue.answer);
  assert.equal(Object.hasOwn(manager.stateFor('player-1', catalog).currentClue, 'privateAnswer'), false);
});

test('authoritative buzz handling pauses while the host is disconnected', () => {
  const { catalog, first, games, host, manager } = setupRoom();
  const location = locateClue(games[0], (clue) => !clue.dailyDouble);
  manager.startGame('host-1', games[0].id);
  manager.openClue('host-1', location);
  manager.disconnect('host-1');

  assert.equal(manager.stateFor('player-1', catalog).hostConnected, false);
  assert.throws(() => manager.buzz('player-1'), (error) => error.code === 'HOST_OFFLINE');

  manager.resumeRoom('host-2', { code: host.code, token: host.token });
  manager.buzz('player-1');
  assert.equal(manager.stateFor('host-2', catalog).currentClue.buzzes[0].playerId, first.playerId);
});

test('Daily Double answer stays private to its selected contestant, who self-scores', () => {
  const { catalog, first, games, manager } = setupRoom();
  const game = games[0];
  const location = locateClue(game, (clue) => clue.dailyDouble);
  manager.startGame('host-1', game.id);
  manager.openClue('host-1', location);
  assert.equal(manager.stateFor('player-1', catalog).currentClue.phase, 'daily-wager');
  assert.equal(manager.stateFor('player-1', catalog).currentClue.question, null);
  assert.equal(Object.hasOwn(manager.stateFor('host-1', catalog).currentClue, 'answer'), false);

  assert.throws(
    () => manager.setDailyDouble('host-1', { playerId: first.playerId, wager: 1001 }),
    (error) => error.code === 'INVALID_WAGER',
  );
  manager.setDailyDouble('host-1', { playerId: first.playerId, wager: 600 });
  const questionState = manager.stateFor('player-1', catalog);
  assert.equal(questionState.currentClue.phase, 'question');
  assert.equal(questionState.currentClue.dailyPlayerId, first.playerId);
  assert.equal(questionState.currentClue.value, 600);
  assert.throws(() => manager.buzz('player-1'), (error) => error.code === 'BUZZ_CLOSED');
  const clueKey = questionState.currentClue.clueKey;
  assert.throws(
    () => manager.openPlayerAnswer('player-2', { clueKey }),
    (error) => error.code === 'NOT_RESPONDER',
  );
  manager.openPlayerAnswer('player-1', { clueKey });
  assert.equal(manager.stateFor('player-1', catalog).currentClue.privateAnswer, location.clue.answer);
  assert.equal(Object.hasOwn(manager.stateFor('host-1', catalog).currentClue, 'privateAnswer'), false);
  manager.selfScoreClue('player-1', { clueKey, correct: false });
  assert.equal(manager.stateFor('host-1', catalog).players.find((player) => player.id === first.playerId).score, -600);
  assert.equal(manager.stateFor('host-1', catalog).currentClue, null);
});

test('an uncommitted Daily Double can return to the board without consuming its tile', () => {
  const { catalog, games, manager } = setupRoom();
  const location = locateClue(games[0], (clue) => clue.dailyDouble);
  manager.startGame('host-1', games[0].id);
  manager.openClue('host-1', location);

  manager.cancelClue('host-1');
  let hostState = manager.stateFor('host-1', catalog);
  assert.equal(hostState.currentClue, null);
  assert.equal(hostState.game.categories[location.categoryIndex].clues[location.clueIndex].answered, false);

  manager.openClue('host-1', location);
  hostState = manager.stateFor('host-1', catalog);
  assert.equal(hostState.currentClue.dailyDouble, true);
  assert.equal(hostState.currentClue.phase, 'daily-wager');
});

test('Daily Double cancellation is host-only and closes after the wager is committed', () => {
  const { first, games, manager } = setupRoom();
  const dailyLocation = locateClue(games[0], (clue) => clue.dailyDouble);
  const regularLocation = locateClue(games[0], (clue) => !clue.dailyDouble);
  manager.startGame('host-1', games[0].id);

  manager.openClue('host-1', dailyLocation);
  assert.throws(
    () => manager.cancelClue('player-1'),
    (error) => error instanceof RoomError && error.code === 'HOST_ONLY',
  );
  manager.setDailyDouble('host-1', { playerId: first.playerId, wager: 400 });
  assert.throws(
    () => manager.cancelClue('host-1'),
    (error) => error instanceof RoomError && error.code === 'CANCEL_NOT_ALLOWED',
  );

  manager.skipClue('host-1');
  manager.openClue('host-1', regularLocation);
  assert.throws(
    () => manager.cancelClue('host-1'),
    (error) => error instanceof RoomError && error.code === 'CANCEL_NOT_ALLOWED',
  );
});

test('Daily Doubles in hosted mode require a connected contestant', () => {
  const { catalog, first, games, manager, second } = setupRoom();
  const location = locateClue(games[0], (clue) => clue.dailyDouble);
  manager.startGame('host-1', games[0].id);
  manager.openClue('host-1', location);

  manager.disconnect('player-1');
  assert.throws(
    () => manager.setDailyDouble('host-1', { playerId: first.playerId, wager: 400 }),
    (error) => error.code === 'PLAYER_OFFLINE',
  );
  manager.setDailyDouble('host-1', { playerId: second.playerId, wager: 400 });
  const clueKey = manager.stateFor('player-2', catalog).currentClue.clueKey;
  manager.openPlayerAnswer('player-2', { clueKey });
  manager.selfScoreClue('player-2', { clueKey, correct: true });
  assert.equal(manager.stateFor('host-1', catalog).players.find((player) => player.id === second.playerId).score, 400);
});

test('Daily Double wager reopens when its contestant leaves before checking', () => {
  const { catalog, first, games, manager, second } = setupRoom();
  const location = locateClue(games[0], (clue) => clue.dailyDouble);
  manager.startGame('host-1', games[0].id);
  manager.openClue('host-1', location);
  manager.setDailyDouble('host-1', { playerId: first.playerId, wager: 400 });

  manager.leaveRoom('player-1');
  const reopened = manager.stateFor('host-1', catalog).currentClue;
  assert.equal(reopened.phase, 'daily-wager');
  assert.equal(reopened.dailyPlayerId, null);
  assert.equal(reopened.question, null);
  manager.setDailyDouble('host-1', { playerId: second.playerId, wager: 400 });
  const clueKey = manager.stateFor('player-2', catalog).currentClue.clueKey;
  manager.openPlayerAnswer('player-2', { clueKey });
  manager.selfScoreClue('player-2', { clueKey, correct: true });
  assert.equal(manager.stateFor('host-1', catalog).players.find((player) => player.id === second.playerId).score, 400);
});

test('Daily Double rejects answer checks and judgments from the wrong contestant', () => {
  const { catalog, first, games, manager } = setupRoom();
  const location = locateClue(games[0], (clue) => clue.dailyDouble);
  manager.startGame('host-1', games[0].id);
  manager.openClue('host-1', location);
  manager.setDailyDouble('host-1', { playerId: first.playerId, wager: 500 });
  const clueKey = manager.stateFor('player-1', catalog).currentClue.clueKey;
  assert.throws(
    () => manager.openPlayerAnswer('player-2', { clueKey }),
    (error) => error.code === 'NOT_RESPONDER',
  );
  assert.throws(
    () => manager.selfScoreClue('player-2', { clueKey, correct: true }),
    (error) => error.code === 'NOT_RESPONDER',
  );
  manager.openPlayerAnswer('player-1', { clueKey });
  assert.throws(
    () => manager.selfScoreClue('player-1', { clueKey: 'stale:key', correct: true }),
    (error) => error.code === 'STALE_CLUE',
  );
  manager.selfScoreClue('player-1', { clueKey, correct: true });
  assert.equal(manager.stateFor('host-1', catalog).players.find((player) => player.id === first.playerId).score, 500);
});

test('a Daily Double closes if its contestant leaves after seeing the private answer', () => {
  const { catalog, first, games, manager } = setupRoom();
  const location = locateClue(games[0], (clue) => clue.dailyDouble);
  manager.startGame('host-1', games[0].id);
  manager.openClue('host-1', location);
  manager.setDailyDouble('host-1', { playerId: first.playerId, wager: 400 });
  const clueKey = manager.stateFor('player-1', catalog).currentClue.clueKey;
  manager.openPlayerAnswer('player-1', { clueKey });
  manager.leaveRoom('player-1');

  const hostState = manager.stateFor('host-1', catalog);
  assert.equal(hostState.currentClue, null);
  assert.equal(hostState.game.categories[location.categoryIndex].clues[location.clueIndex].answered, true);
});

test('runs private Final Jeopardy wagers and responses through final standings', () => {
  const { catalog, first, games, manager, second } = setupRoom();
  manager.startGame('host-1', games[0].id);
  manager.adjustScore('host-1', { playerId: first.playerId, delta: 1200 });
  manager.adjustScore('host-1', { playerId: second.playerId, delta: 800 });
  manager.startFinal('host-1');

  manager.submitFinalWager('player-1', 1000);
  manager.submitFinalWager('player-2', 500);
  let hostState = manager.stateFor('host-1', catalog);
  assert.equal(hostState.final.phase, 'wager');
  assert.equal(Object.hasOwn(hostState.final.submissions[0], 'wager'), false);

  manager.advanceFinal('host-1');
  manager.submitFinalResponse('player-1', 'What is a test response?');
  manager.submitFinalResponse('player-2', 'What is another response?');
  hostState = manager.stateFor('host-1', catalog);
  assert.equal(hostState.final.phase, 'clue');
  assert.equal(Object.hasOwn(hostState.final.submissions[0], 'response'), false);
  assert.equal(Object.hasOwn(manager.stateFor('player-1', catalog).final, 'answer'), false);

  manager.advanceFinal('host-1');
  hostState = manager.stateFor('host-1', catalog);
  assert.equal(Object.hasOwn(hostState.final.submissions[0], 'response'), false);
  assert.equal(Object.hasOwn(hostState.final, 'answer'), false);
  const firstFinal = manager.stateFor('player-1', catalog).final;
  assert.ok(firstFinal.answer);
  assert.equal(firstFinal.yourResponse, 'What is a test response?');
  assert.equal(firstFinal.canSelfScore, true);

  manager.selfScoreFinal('player-1', { correct: true });
  manager.selfScoreFinal('player-2', { correct: false });
  manager.finishFinal('host-1');
  hostState = manager.stateFor('host-1', catalog);
  assert.equal(hostState.final.phase, 'complete');
  assert.equal(hostState.players.find((player) => player.id === first.playerId).score, 2200);
  assert.equal(hostState.players.find((player) => player.id === second.playerId).score, 300);
});

test('a creator who joins the roster is eligible for Final Jeopardy without seeing the answer early', () => {
  const { catalog, first, games, manager } = setupRoom();
  manager.joinHostAsPlayer('host-1', { name: 'Alex' });
  const hostPlayerId = manager.stateFor('host-1', catalog).you.id;
  manager.startGame('host-1', games[0].id);
  manager.adjustScore('host-1', { playerId: hostPlayerId, delta: 1000 });
  manager.adjustScore('host-1', { playerId: first.playerId, delta: 800 });
  manager.startFinal('host-1');

  const hostState = manager.stateFor('host-1', catalog);
  assert.equal(hostState.final.submissions.some((entry) => entry.playerId === hostPlayerId), true);
  assert.equal(hostState.final.eligible, true);
  assert.equal(hostState.final.yourMaxWager, 1000);
  assert.equal(Object.hasOwn(hostState.final, 'answer'), false);
  manager.submitFinalWager('host-1', 500);
  assert.equal(manager.stateFor('host-1', catalog).final.yourWager, 500);
  assert.throws(() => manager.selfScoreFinal('host-1', { correct: true }), (error) => error.code === 'FINAL_NOT_READY');
});

test('Final answer is sent to contestant screens but never the host display', () => {
  const { catalog, first, games, manager } = setupRoom();
  manager.startGame('host-1', games[0].id);
  manager.adjustScore('host-1', { playerId: first.playerId, delta: 200 });
  manager.startFinal('host-1');
  manager.submitFinalWager('player-1', 100);
  manager.advanceFinal('host-1', 'wager');
  manager.submitFinalResponse('player-1', 'What is my final response?');
  manager.advanceFinal('host-1', 'clue');

  const hostState = manager.stateFor('host-1', catalog);
  const playerState = manager.stateFor('player-1', catalog);
  assert.equal(Object.hasOwn(hostState.final, 'answer'), false);
  assert.equal(Object.hasOwn(hostState.final.submissions[0], 'response'), false);
  assert.ok(playerState.final.answer);
  assert.equal(playerState.final.yourResponse, 'What is my final response?');
});

test('removing a remote finalist cannot remove the host contestant or deadlock Final', () => {
  const { catalog, first, games, manager, second } = setupRoom();
  manager.joinHostAsPlayer('host-1', { name: 'Alex' });
  const hostPlayerId = manager.stateFor('host-1', catalog).you.id;
  manager.startGame('host-1', games[0].id);
  manager.adjustScore('host-1', { playerId: hostPlayerId, delta: 600 });
  manager.adjustScore('host-1', { playerId: first.playerId, delta: 400 });
  manager.adjustScore('host-1', { playerId: second.playerId, delta: 200 });
  manager.startFinal('host-1');
  manager.advanceFinal('host-1', { expectedPhase: 'wager', force: true });
  manager.advanceFinal('host-1', { expectedPhase: 'clue', force: true });

  assert.throws(
    () => manager.removePlayer('host-1', hostPlayerId),
    (error) => error.code === 'CANNOT_REMOVE_HOST',
  );
  manager.removePlayer('host-1', second.playerId);
  assert.throws(() => manager.stateFor('player-2', catalog), (error) => error.code === 'NOT_IN_ROOM');
  manager.finishFinal('host-1');
  assert.equal(manager.stateFor('host-1', catalog).final.phase, 'complete');
});

test('Final Jeopardy excludes nonpositive scores, locks submissions, and rejects stale advances', () => {
  const { catalog, first, games, host, manager } = setupRoom();
  manager.startGame('host-1', games[0].id);
  manager.adjustScore('host-1', { playerId: first.playerId, delta: 500 });
  manager.startFinal('host-1');

  assert.equal(manager.stateFor('player-1', catalog).final.eligible, true);
  assert.equal(manager.stateFor('player-2', catalog).final.eligible, false);
  assert.throws(
    () => manager.joinRoom('late-player', { code: host.code, name: 'Latecomer' }),
    (error) => error.code === 'GAME_IN_FINAL',
  );
  assert.throws(() => manager.submitFinalWager('player-2', 0), (error) => error.code === 'NOT_ELIGIBLE');
  assert.throws(() => manager.submitFinalWager('player-1', 501), (error) => error.code === 'INVALID_WAGER');
  manager.submitFinalWager('player-1', 500);
  assert.throws(() => manager.submitFinalWager('player-1', 100), (error) => error.code === 'ALREADY_SUBMITTED');

  manager.advanceFinal('host-1', 'wager');
  assert.throws(() => manager.advanceFinal('host-1', 'wager'), (error) => error.code === 'STALE_ACTION');
  manager.submitFinalResponse('player-1', 'What is locked?');
  assert.throws(
    () => manager.submitFinalResponse('player-1', 'What is changed?'),
    (error) => error.code === 'ALREADY_SUBMITTED',
  );
});

test('Final Jeopardy waits for every submission unless the host explicitly forces an advance', () => {
  const { catalog, first, games, manager, second } = setupRoom();
  manager.startGame('host-1', games[0].id);
  manager.adjustScore('host-1', { playerId: first.playerId, delta: 500 });
  manager.adjustScore('host-1', { playerId: second.playerId, delta: 300 });
  manager.startFinal('host-1');

  manager.submitFinalWager('player-1', 200);
  assert.throws(
    () => manager.advanceFinal('host-1', { expectedPhase: 'wager' }),
    (error) => error.code === 'FINAL_SUBMISSIONS_PENDING',
  );
  assert.equal(manager.stateFor('host-1', catalog).final.phase, 'wager');

  manager.advanceFinal('host-1', { expectedPhase: 'wager', force: true });
  const forcedWagerState = manager.stateFor('player-2', catalog);
  assert.equal(forcedWagerState.final.phase, 'clue');
  assert.equal(forcedWagerState.final.yourWager, 0);
  assert.equal(forcedWagerState.final.yourWagerSubmitted, false);

  manager.submitFinalResponse('player-1', 'What is ready?');
  assert.throws(
    () => manager.advanceFinal('host-1', { expectedPhase: 'clue' }),
    (error) => error.code === 'FINAL_SUBMISSIONS_PENDING',
  );
  assert.equal(manager.stateFor('host-1', catalog).final.phase, 'clue');

  manager.advanceFinal('host-1', { expectedPhase: 'clue', force: true });
  const forcedResponseState = manager.stateFor('host-1', catalog);
  const missingResponse = forcedResponseState.final.submissions.find((entry) => entry.playerId === second.playerId);
  assert.equal(forcedResponseState.final.phase, 'answer');
  assert.equal(missingResponse.responseSubmitted, false);
  assert.equal(missingResponse.scored, true);
  assert.equal(missingResponse.correct, false);
  assert.equal(forcedResponseState.players.find((player) => player.id === second.playerId).score, 300);
});

test('cleanup retains connected rooms and expires only fully disconnected idle rooms', () => {
  const games = loadGames();
  let timestamp = 0;
  const manager = new RoomManager({ games, now: () => timestamp });
  const host = manager.createRoom('host-cleanup');
  manager.joinRoom('player-cleanup', { code: host.code, name: 'Maya' });

  timestamp = 20;
  assert.deepEqual(manager.cleanup(10), []);
  manager.disconnect('player-cleanup');
  manager.disconnect('host-cleanup');
  timestamp = 40;
  assert.deepEqual(manager.cleanup(10), [host.code]);
  assert.equal(manager.rooms.has(host.code), false);
});

test('rejects player attempts to use host actions', () => {
  const { games, manager } = setupRoom();
  assert.throws(
    () => manager.startGame('player-1', games[0].id),
    (error) => error.code === 'HOST_ONLY',
  );
  assert.throws(
    () => manager.joinHostAsPlayer('player-1', { name: 'Impostor' }),
    (error) => error.code === 'HOST_ONLY',
  );
  manager.startGame('host-1', games[0].id);
  const location = locateClue(games[0], (clue) => !clue.dailyDouble);
  manager.openClue('host-1', location);
  assert.throws(
    () => manager.revealAnswer('player-1'),
    (error) => error.code === 'HOST_ONLY',
  );
  assert.throws(
    () => manager.openPlayerAnswer('host-1', { clueKey: '0:0' }),
    (error) => error.code === 'CONTESTANT_ONLY',
  );
  assert.throws(
    () => manager.buzz('host-1'),
    (error) => error.code === 'CONTESTANT_ONLY',
  );
});

function setupDoubleRoom({ creatorPlays = false } = {}) {
  const game = structuredClone(loadGames()[0]);
  game.doubleJeopardy = {
    categories: Array.from({ length: 6 }, (_, categoryIndex) => ({
      name: `DOUBLE CATEGORY ${categoryIndex + 1}`,
      clues: Array.from({ length: 5 }, (_, clueIndex) => ({
        value: (clueIndex + 1) * 400,
        clue: `Second-round clue ${categoryIndex}-${clueIndex}`,
        answer: `Second-round answer ${categoryIndex}-${clueIndex}`,
        dailyDouble: categoryIndex < 2 && clueIndex === 0,
      })),
    })),
  };
  const manager = new RoomManager({ games: [game] });
  const host = manager.createRoom('host');
  if (creatorPlays) manager.joinHostAsPlayer('host', { name: 'Creator' });
  const first = manager.joinRoom('player-1', { code: host.code, name: 'Maya' });
  const second = manager.joinRoom('player-2', { code: host.code, name: 'Theo' });
  manager.startGame('host', game.id);
  const state = (socket = 'host') => manager.stateFor(socket, catalogGames([game]));
  return { manager, game, host, first, second, state };
}

function finishBoard(manager, state) {
  const board = state().game;
  for (let categoryIndex = 0; categoryIndex < board.categories.length; categoryIndex += 1) {
    for (let clueIndex = 0; clueIndex < board.categories[categoryIndex].clues.length; clueIndex += 1) {
      if (board.categories[categoryIndex].clues[clueIndex].answered) continue;
      const controller = ['host', 'player-1', 'player-2'].find((socket) => state(socket).canChooseClue);
      manager.openClue(controller, { categoryIndex, clueIndex, round: state().round });
      manager.skipClue('host');
    }
  }
}

test('Double Jeopardy starts only after the first board and carries scores onto a fresh board', () => {
  const { manager, first, second, state } = setupDoubleRoom({ creatorPlays: true });
  manager.adjustScore('host', { playerId: first.playerId, delta: 1200 });
  manager.adjustScore('host', { playerId: second.playerId, delta: -400 });
  assert.equal(state().round, 'jeopardy');
  assert.equal(state().nextRoundName, 'Double Jeopardy');
  assert.equal(state().canStartNextRound, false);
  assert.throws(() => manager.advanceRound('host', { expectedRound: 'jeopardy' }), { code: 'ROUND_INCOMPLETE' });
  assert.throws(() => manager.startFinal('host'), { code: 'DOUBLE_JEOPARDY_PENDING' });
  finishBoard(manager, state);
  assert.equal(state().canStartNextRound, true);
  manager.advanceRound('host', { expectedRound: 'jeopardy' });

  const next = state();
  assert.equal(next.round, 'double');
  assert.equal(next.roundName, 'Double Jeopardy');
  assert.equal(next.nextRoundName, 'Final Jeopardy');
  assert.equal(next.controlPlayerId, second.playerId);
  assert.equal(next.game.remainingClues, 30);
  assert.equal(next.game.dailyDoubleFloor, 2000);
  assert.deepEqual(next.players.map((player) => player.score), [0, 1200, -400]);
  assert.deepEqual(next.game.categories[0].clues.map((clue) => clue.value), [400, 800, 1200, 1600, 2000]);
  assert.equal(next.game.categories.flatMap((category) => category.clues).every((clue) => !clue.answered), true);
  assert.equal(next.canStartNextRound, false);
  assert.equal(next.game.categories.some((category) => category.clues.some((clue) => 'answer' in clue || 'dailyDouble' in clue)), false);
  assert.throws(() => manager.advanceRound('host', { expectedRound: 'jeopardy' }), { code: 'STALE_ROUND' });
  assert.throws(() => manager.startFinal('host'), { code: 'ROUND_INCOMPLETE' });
});

test('Double Jeopardy selects the first connected lowest scorer when scores tie', () => {
  const { manager, first, state } = setupDoubleRoom({ creatorPlays: true });
  const creatorId = state().you.id;
  manager.adjustScore('host', { playerId: creatorId, delta: 1000 });
  finishBoard(manager, state);
  manager.advanceRound('host', { expectedRound: 'jeopardy' });
  assert.equal(state().controlPlayerId, first.playerId);
});

test('second-round Daily Doubles accept wagers up to $2000 and preserve answer privacy', () => {
  const { manager, first, game, state } = setupDoubleRoom();
  finishBoard(manager, state);
  manager.advanceRound('host', { expectedRound: 'jeopardy' });
  manager.openClue('host', { categoryIndex: 0, clueIndex: 0, round: 'double' });
  assert.equal(state().currentClue.question, null);
  assert.throws(() => manager.setDailyDouble('host', { playerId: first.playerId, wager: 2001 }), { code: 'INVALID_WAGER' });
  manager.setDailyDouble('host', { playerId: first.playerId, wager: 2000 });
  const { clueKey } = state().currentClue;
  assert.equal(clueKey, 'double:0:0');
  assert.equal(state().currentClue.question, game.doubleJeopardy.categories[0].clues[0].clue);
  manager.openPlayerAnswer('player-1', { clueKey });
  assert.equal(state('player-1').currentClue.privateAnswer, game.doubleJeopardy.categories[0].clues[0].answer);
  assert.equal(Object.hasOwn(state().currentClue, 'privateAnswer'), false);
  assert.equal(Object.hasOwn(state('player-2').currentClue, 'privateAnswer'), false);
  manager.selfScoreClue('player-1', { clueKey, correct: true });
  assert.equal(state('player-1').you.score, 2000);
  assert.equal(state().game.categories[0].clues[0].answered, true);
});

test('old round selections and judgments cannot affect matching tiles in Double Jeopardy', () => {
  const { manager, first, host, state } = setupDoubleRoom();
  manager.openClue('host', { categoryIndex: 2, clueIndex: 1, round: 'jeopardy' });
  const oldKey = state().currentClue.clueKey;
  manager.skipClue('host');
  finishBoard(manager, state);
  manager.advanceRound('host', { expectedRound: 'jeopardy' });
  assert.throws(() => manager.openClue('host', { categoryIndex: 2, clueIndex: 1, round: 'jeopardy' }), { code: 'STALE_ROUND' });
  manager.openClue('host', { categoryIndex: 2, clueIndex: 1, round: 'double' });
  manager.buzz('player-1');
  assert.throws(() => manager.openPlayerAnswer('player-1', { clueKey: oldKey }), { code: 'STALE_CLUE' });
  assert.throws(() => manager.skipPlayerClue('player-1', { clueKey: oldKey }), { code: 'STALE_CLUE' });
  const { clueKey } = state().currentClue;
  manager.openPlayerAnswer('player-1', { clueKey });
  assert.throws(() => manager.selfScoreClue('player-1', { clueKey: oldKey, correct: true }), { code: 'STALE_CLUE' });
  manager.disconnect('player-1');
  manager.resumeRoom('player-returned', { code: host.code, token: first.token });
  assert.equal(state('player-returned').round, 'double');
  assert.equal(state('player-returned').currentClue.clueKey, clueKey);
  assert.match(state('player-returned').currentClue.privateAnswer, /^Second-round answer/);
  manager.selfScoreClue('player-returned', { clueKey, correct: true });
  assert.equal(state('player-returned').you.score, 800);
});

test('completed Double Jeopardy advances to Final and reset returns to the first board', () => {
  const { manager, first, state } = setupDoubleRoom();
  manager.adjustScore('host', { playerId: first.playerId, delta: 1200 });
  finishBoard(manager, state);
  manager.advanceRound('host', { expectedRound: 'jeopardy' });
  finishBoard(manager, state);
  assert.equal(state().canStartNextRound, true);
  manager.advanceRound('host', { expectedRound: 'double' });
  assert.equal(state().phase, 'final');
  assert.equal(state().final.phase, 'wager');
  assert.equal(state('player-1').final.yourMaxWager, 1200);
  manager.resetGame('host');
  assert.equal(state().round, 'jeopardy');
  assert.equal(state().game.dailyDoubleFloor, 1000);
  assert.equal(state().game.remainingClues, 30);
  assert.equal(state().players.every((player) => player.score === 0), true);
});

test('completed Double Jeopardy ends cleanly when nobody qualifies for Final', () => {
  const { manager, state } = setupDoubleRoom();
  finishBoard(manager, state);
  manager.advanceRound('host', { expectedRound: 'jeopardy' });
  finishBoard(manager, state);
  assert.equal(state().canStartNextRound, true);
  manager.advanceRound('host', { expectedRound: 'double' });
  assert.equal(state().phase, 'final');
  assert.equal(state().final.phase, 'complete');
  assert.deepEqual(state().final.submissions, []);
});
