'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadGames } = require('../lib/game-store');
const { HOST_RECOVERY_GRACE_MS, RoomManager } = require('../lib/room-manager');

function fixture({ playingHost = false } = {}) {
  const games = [loadGames()[0]];
  let now = 1000;
  const manager = new RoomManager({ games, now: () => now });
  const host = manager.createRoom('host');
  if (playingHost) manager.joinHostAsPlayer('host', { name: 'Alex' });
  const first = manager.joinRoom('first', { code: host.code, name: 'Maya' });
  const second = manager.joinRoom('second', { code: host.code, name: 'Theo' });
  return { manager, games, host, first, second, setNow(value) { now = value; } };
}

function restore(f, snapshot, now, options) {
  const manager = new RoomManager({ games: f.games, now: () => now });
  manager.restoreSnapshot(snapshot, options);
  return manager;
}

function location(game, dailyDouble = false) {
  return game.categories.flatMap((category, categoryIndex) => category.clues.map((clue, clueIndex) => ({ categoryIndex, clueIndex, clue })))
    .find(({ clue }) => Boolean(clue.dailyDouble) === dailyDouble);
}

function finishGame(f) {
  f.manager.startGame('host', f.games[0].id);
  f.manager.adjustScore('host', { playerId: f.first.playerId, delta: 600 });
  f.manager.startFinal('host');
  f.manager.submitFinalWager('first', 100);
  f.manager.advanceFinal('host');
  f.manager.submitFinalResponse('first', 'Private Final response');
  f.manager.advanceFinal('host');
  f.manager.selfScoreFinal('first', { correct: true });
  f.manager.finishFinal('host');
  return f.manager.stateFor('first', []).completedGames[0];
}

test('only an existing connected contestant can explicitly take over after the full grace period', () => {
  const f = fixture();
  assert.deepEqual(f.manager.stateFor('first', []).hostRecovery, { availableAt: null, eligible: false });
  assert.throws(() => f.manager.claimHost('first'), { code: 'HOST_CONNECTED' });
  f.manager.disconnect('host');
  assert.deepEqual(f.manager.stateFor('first', []).hostRecovery, { availableAt: 1000 + HOST_RECOVERY_GRACE_MS, eligible: true });
  f.manager.joinRoom('late', { code: f.host.code, name: 'Late arrival' });
  assert.equal(f.manager.stateFor('late', []).hostRecovery.eligible, false);
  const before = f.manager.exportSnapshot();
  f.setNow(1000 + HOST_RECOVERY_GRACE_MS - 1);
  assert.throws(() => f.manager.claimHost('first'), { code: 'HOST_RECOVERY_WAIT' });
  assert.deepEqual(f.manager.exportSnapshot().rooms, before.rooms);
  f.setNow(1000 + HOST_RECOVERY_GRACE_MS);
  assert.equal(f.manager.stateFor('first', []).role, 'player');
  assert.throws(() => f.manager.claimHost('late'), { code: 'HOST_RECOVERY_INELIGIBLE' });
  assert.throws(() => f.manager.claimHost('unknown'), { code: 'NOT_IN_ROOM' });
  f.manager.disconnect('second');
  assert.throws(() => f.manager.claimHost('second'), { code: 'NOT_IN_ROOM' });
  const recovered = f.manager.claimHost('first');
  assert.deepEqual(recovered, {
    code: f.host.code, formerHostSocketId: null, newHostSocketId: 'first', formerHostSession: null,
    newHostSession: { code: f.host.code, role: 'host', token: f.first.token },
  });
  assert.equal(f.manager.stateFor('first', []).role, 'host');
  assert.deepEqual(f.manager.stateFor('first', []).hostRecovery, { availableAt: null, eligible: false });
  assert.equal(f.manager.sessions.has(null), false);
  assert.throws(() => f.manager.resumeRoom('old-host', f.host), { code: 'SESSION_EXPIRED' });
});

test('the first claimant wins and an original host reconnect before the claim cancels recovery', () => {
  const f = fixture();
  f.manager.disconnect('host');
  f.setNow(61000);
  f.manager.resumeRoom('host-returned', f.host);
  assert.throws(() => f.manager.claimHost('first'), { code: 'HOST_CONNECTED' });
  f.manager.disconnect('host-returned');
  assert.equal(f.manager.stateFor('first', []).hostRecovery.availableAt, 121000);
  assert.throws(() => f.manager.claimHost('first'), { code: 'HOST_RECOVERY_WAIT' });
  f.setNow(121000);
  f.manager.claimHost('first');
  assert.throws(() => f.manager.claimHost('second'), { code: 'HOST_CONNECTED' });
  assert.throws(() => f.manager.resumeRoom('old-host-again', f.host), { code: 'SESSION_EXPIRED' });
  assert.equal(f.manager.stateFor('second', []).role, 'player');
});

test('an existing offline player can resume to claim but replacing its socket revokes the previous connection', () => {
  const f = fixture();
  f.manager.disconnect('first');
  f.manager.disconnect('host');
  f.setNow(61000);
  f.manager.resumeRoom('first-returned', f.first);
  f.manager.resumeRoom('first-latest', f.first);
  assert.throws(() => f.manager.claimHost('first-returned'), { code: 'NOT_IN_ROOM' });
  f.manager.claimHost('first-latest');
  assert.equal(f.manager.stateFor('first-latest', []).you.id, f.first.playerId);
});

test('a former playing host keeps its contestant credential and cannot regain host permissions', () => {
  const f = fixture({ playingHost: true });
  const formerHostId = f.manager.stateFor('host', []).you.id;
  f.manager.startGame('host', f.games[0].id);
  f.manager.adjustScore('host', { playerId: formerHostId, delta: 800 });
  f.manager.disconnect('host');
  f.setNow(61000);
  const result = f.manager.claimHost('first');
  assert.deepEqual(result.formerHostSession, { ...f.host, role: 'player', playerId: formerHostId });
  assert.equal(f.manager.sessions.has(null), false);
  const recovered = restore(f, f.manager.exportSnapshot(), 62000);
  const session = recovered.resumeRoom('former-host', f.host);
  assert.equal(session.role, 'player');
  assert.equal(recovered.stateFor('former-host', []).you.id, formerHostId);
  assert.equal(recovered.stateFor('former-host', []).you.score, 800);
  assert.throws(() => recovered.resetGame('former-host'), { code: 'HOST_ONLY' });
  assert.equal(recovered.resumeRoom('new-host', f.first).role, 'host');
});

test('recovery preserves a private response, buzz order, scores, and existing contestant control', () => {
  const f = fixture({ playingHost: true });
  f.manager.startGame('host', f.games[0].id);
  f.manager.openClue('host', location(f.games[0]));
  f.manager.buzz('second');
  f.manager.buzz('first');
  const clueKey = f.manager.stateFor('second', []).currentClue.clueKey;
  f.manager.openPlayerAnswer('second', { clueKey });
  f.manager.disconnect('host');
  const before = f.manager.stateFor('second', []);
  f.setNow(61000);
  f.manager.claimHost('first');
  const after = f.manager.stateFor('second', []);
  assert.deepEqual(after.currentClue, before.currentClue);
  assert.equal(after.controlPlayerId, before.controlPlayerId);
  assert.deepEqual(after.players.map(({ id, score }) => ({ id, score })), before.players.map(({ id, score }) => ({ id, score })));
  assert.equal(Object.hasOwn(f.manager.stateFor('first', []).currentClue, 'privateAnswer'), false);
  f.manager.selfScoreClue('second', { clueKey, correct: true });
  assert.equal(f.manager.stateFor('second', []).you.score, 200);
  assert.equal(f.manager.stateFor('first', []).controlPlayerId, f.second.playerId);
});

test('recovery from a dedicated host preserves the active Daily Double contestant and wager', () => {
  const f = fixture();
  f.manager.startGame('host', f.games[0].id);
  f.manager.openClue('host', location(f.games[0], true));
  f.manager.setDailyDouble('host', { playerId: f.second.playerId, wager: 750 });
  const clueKey = f.manager.stateFor('second', []).currentClue.clueKey;
  f.manager.openPlayerAnswer('second', { clueKey });
  const before = f.manager.stateFor('second', []).currentClue;
  f.manager.disconnect('host');
  f.setNow(61000);
  f.manager.claimHost('first');
  assert.deepEqual(f.manager.stateFor('second', []).currentClue, before);
  assert.equal(f.manager.stateFor('first', []).controlPlayerId, f.second.playerId);
  assert.equal(Object.hasOwn(f.manager.stateFor('first', []).currentClue, 'privateAnswer'), false);
  f.manager.selfScoreClue('second', { clueKey, correct: true });
  assert.equal(f.manager.stateFor('second', []).you.score, 750);
});

test('Final Jeopardy resumes after recovery without losing wagers or exposing another contestant response', () => {
  const f = fixture();
  f.manager.startGame('host', f.games[0].id);
  for (const player of [f.first, f.second]) f.manager.adjustScore('host', { playerId: player.playerId, delta: 600 });
  f.manager.startFinal('host');
  f.manager.submitFinalWager('first', 200);
  f.manager.submitFinalWager('second', 300);
  f.manager.advanceFinal('host');
  f.manager.submitFinalResponse('first', 'Private first response');
  f.manager.submitFinalResponse('second', 'Private second response');
  const before = f.manager.stateFor('second', []).final;
  f.manager.disconnect('host');
  f.setNow(61000);
  f.manager.claimHost('first');
  assert.deepEqual(f.manager.stateFor('second', []).final, before);
  assert.equal(f.manager.stateFor('first', []).final.yourResponse, 'Private first response');
  assert.equal(JSON.stringify(f.manager.stateFor('first', [])).includes('Private second response'), false);
  f.manager.advanceFinal('first');
  f.manager.selfScoreFinal('first', { correct: true });
  f.manager.selfScoreFinal('second', { correct: false });
  f.manager.finishFinal('first');
  assert.deepEqual(f.manager.stateFor('first', []).completedGames[0].players.map((player) => player.score), [800, 300]);
});

test('restart preserves a known host outage and excludes players who joined after that outage', () => {
  const f = fixture();
  f.manager.disconnect('host');
  const late = f.manager.joinRoom('late', { code: f.host.code, name: 'Late' });
  f.setNow(31000);
  const recovered = restore(f, f.manager.exportSnapshot(), 62000);
  recovered.resumeRoom('late-restored', late);
  recovered.resumeRoom('first-restored', f.first);
  assert.deepEqual(recovered.stateFor('first-restored', []).hostRecovery, { availableAt: 61000, eligible: true });
  assert.equal(recovered.stateFor('late-restored', []).hostRecovery.eligible, false);
  assert.throws(() => recovered.claimHost('late-restored'), { code: 'HOST_RECOVERY_INELIGIBLE' });
  recovered.claimHost('first-restored');
  assert.equal(recovered.stateFor('first-restored', []).role, 'host');
});

test('restart gives a previously connected host a fresh grace even when its saved activity is old', () => {
  const f = fixture();
  const saved = f.manager.exportSnapshot();
  const recovered = restore(f, saved, 121000);
  recovered.resumeRoom('first-restored', f.first);
  assert.equal(recovered.stateFor('first-restored', []).hostRecovery.availableAt, 181000);
  assert.throws(() => recovered.claimHost('first-restored'), { code: 'HOST_RECOVERY_WAIT' });
  const nextRestart = restore(f, recovered.exportSnapshot(), 181000);
  nextRestart.resumeRoom('first-restored-again', f.first);
  nextRestart.claimHost('first-restored-again');
});

for (const connected of [true, false]) {
  test(`legacy ${connected ? 'connected' : 'offline'} snapshots start a fresh grace with the persisted roster`, () => {
    const f = fixture();
    if (!connected) f.manager.disconnect('host');
    const saved = f.manager.exportSnapshot();
    delete saved.rooms[0].host.disconnectedAt;
    delete saved.rooms[0].host.recoveryPlayerIds;
    const recovered = restore(f, saved, 121000);
    recovered.resumeRoom('first-restored', f.first);
    assert.deepEqual(recovered.stateFor('first-restored', []).hostRecovery, { availableAt: 181000, eligible: true });
    assert.throws(() => recovered.claimHost('first-restored'), { code: 'HOST_RECOVERY_WAIT' });
    const roundTrip = restore(f, recovered.exportSnapshot(), 181000);
    roundTrip.resumeRoom('first-returned', f.first);
    roundTrip.claimHost('first-returned');
  });
}

test('rollback restores the exact host recovery deadline and eligibility without renewing the grace', () => {
  const f = fixture();
  f.manager.disconnect('host');
  const saved = f.manager.exportSnapshot();
  f.setNow(61000);
  f.manager.claimHost('first');
  f.manager.restoreSnapshot(saved, { restoreConnections: true, expire: false });
  assert.deepEqual(f.manager.stateFor('first', []).hostRecovery, { availableAt: 61000, eligible: true });
  f.manager.claimHost('second');
  assert.equal(f.manager.stateFor('second', []).role, 'host');
});

test('malformed host recovery metadata fails restore atomically', () => {
  const f = fixture();
  f.manager.disconnect('host');
  const saved = f.manager.exportSnapshot();
  for (const corrupt of [
    (host) => { delete host.disconnectedAt; },
    (host) => { delete host.recoveryPlayerIds; },
    (host) => { host.disconnectedAt = -1; },
    (host) => { host.disconnectedAt = 1001; },
    (host) => { host.recoveryPlayerIds = [f.first.playerId, f.first.playerId]; },
    (host) => { host.recoveryPlayerIds = ['p_000000000000']; },
  ]) {
    const damaged = structuredClone(saved);
    corrupt(damaged.rooms[0].host);
    assert.throws(() => f.manager.restoreSnapshot(damaged), /Invalid room snapshot/);
    assert.deepEqual(f.manager.stateFor('first', []).hostRecovery, { availableAt: 61000, eligible: true });
  }
});

test('completed results use independent access tokens retained through amendments, handoff, and restore', () => {
  const f = fixture();
  const result = finishGame(f);
  assert.match(result.resultToken, /^[A-Za-z0-9_-]{43}$/);
  for (const credential of [f.host.token, f.first.token, f.second.token]) assert.notEqual(result.resultToken, credential);
  assert.equal(f.manager.stateFor('host', []).completedGames[0].resultToken, result.resultToken);
  assert.equal(f.manager.stateFor('second', []).completedGames[0].resultToken, result.resultToken);
  f.manager.adjustScore('host', { playerId: f.first.playerId, delta: 200 });
  const amended = f.manager.stateFor('first', []).completedGames[0];
  assert.equal(amended.revision, 2);
  assert.equal(amended.resultToken, result.resultToken);
  f.manager.returnToLobby('host');
  f.manager.joinRoom('late', { code: f.host.code, name: 'Late' });
  assert.deepEqual(f.manager.stateFor('late', []).completedGames, []);
  f.manager.transferHost('host', { playerId: f.first.playerId });
  const recovered = restore(f, f.manager.exportSnapshot(), 2000);
  recovered.resumeRoom('new-host', f.first);
  assert.equal(recovered.stateFor('new-host', []).completedGames[0].resultToken, result.resultToken);
  assert.equal(JSON.stringify(amended).includes('Private Final response'), false);
});

test('each completed run gets its own access token and legacy results migrate to stable tokens', () => {
  const f = fixture();
  const first = finishGame(f);
  const second = finishGame(f);
  assert.notEqual(first.resultToken, second.resultToken);
  const saved = f.manager.exportSnapshot();
  for (const result of saved.rooms[0].completedGames) delete result.resultToken;
  const recovered = restore(f, saved, 2000, { restoreConnections: true });
  const migrated = recovered.stateFor('first', []).completedGames;
  for (const result of migrated) assert.match(result.resultToken, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(migrated[0].resultToken, migrated[1].resultToken);
  const roundTrip = restore(f, recovered.exportSnapshot(), 3000, { restoreConnections: true });
  assert.deepEqual(roundTrip.stateFor('first', []).completedGames, migrated);
});

test('malformed result access tokens reject a snapshot without replacing live state', () => {
  const f = fixture();
  const result = finishGame(f);
  const saved = f.manager.exportSnapshot();
  for (const bad of [null, 42, f.host.token, 'a'.repeat(44), '/'.repeat(43)]) {
    const damaged = structuredClone(saved);
    damaged.rooms[0].completedGames[0].resultToken = bad;
    assert.throws(() => f.manager.restoreSnapshot(damaged), /Invalid room snapshot/);
    assert.equal(f.manager.stateFor('first', []).completedGames[0].resultToken, result.resultToken);
  }
});
