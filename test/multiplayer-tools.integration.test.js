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

function nextMessage(socket, event, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(event, receive);
      reject(new Error(`Expected ${event} was not received`));
    }, 3000);
    function receive(message) {
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.off(event, receive);
      resolve(message);
    }
    socket.on(event, receive);
  });
}

async function fixture(context, options = {}) {
  const games = options.games || loadGames();
  const server = createJeopardyServer({ games, logger: { error() {} }, roomStore: options.roomStore || null });
  const address = await server.start(0, '127.0.0.1');
  const sockets = [];
  function client() {
    const socket = createClient(`http://127.0.0.1:${address.port}`, { transports: ['websocket'], forceNew: true, reconnection: false });
    socket.states = [];
    socket.sessions = [];
    socket.on('room:state', (state) => socket.states.push(state));
    socket.on('room:session', (session) => socket.sessions.push(session));
    sockets.push(socket);
    return socket;
  }
  context.after(async () => {
    sockets.forEach((socket) => socket.disconnect());
    await server.stop();
  });
  const host = client();
  const player = client();
  const hostSession = (await action(host, 'room:create')).session;
  const playerSession = (await action(player, 'room:join', { code: hostSession.code, name: 'Maya' })).session;
  return { server, games, host, player, hostSession, playerSession, client };
}

function findClue(game, dailyDouble = false) {
  return game.categories.flatMap((category, categoryIndex) => category.clues.map((clue, clueIndex) => ({ categoryIndex, clueIndex, clue })))
    .find(({ clue }) => Boolean(clue.dailyDouble) === dailyDouble);
}

test('host undo restores a private clue judgment once and never exposes its backup to contestants', async (context) => {
  const f = await fixture(context);
  const clue = findClue(f.games[0]);
  await action(f.host, 'host:start-game', { gameId: f.games[0].id });
  await action(f.host, 'host:open-clue', clue);
  await action(f.player, 'player:buzz');
  const clueKey = f.player.states.at(-1).currentClue.clueKey;
  await action(f.player, 'player:open-answer', { clueKey });
  const undoAvailable = nextMessage(f.host, 'room:state', (state) => Boolean(state.scoreUndo));
  await action(f.player, 'player:self-score-clue', { clueKey, correct: true });
  const state = await undoAvailable;
  const undo = state.scoreUndo;
  assert.deepEqual(Object.keys(undo).sort(), ['id', 'label']);
  assert.equal(JSON.stringify(state).includes(clue.clue.answer), false);
  assert.equal(Boolean(f.player.states.at(-1).scoreUndo), false);
  assert.equal(f.player.states.at(-1).you.score, clue.clue.value);
  await assert.rejects(action(f.player, 'host:undo-score', { actionId: undo.id }), { code: 'HOST_ONLY' });
  await assert.rejects(action(f.host, 'host:undo-score', { actionId: 'stale-action' }));

  const restored = nextMessage(f.player, 'room:state', (candidate) => candidate.currentClue?.canSelfScore && candidate.you.score === 0);
  await action(f.host, 'host:undo-score', { actionId: undo.id });
  const privateState = await restored;
  assert.equal(privateState.currentClue.privateAnswer, clue.clue.answer);
  assert.equal(privateState.game.remainingClues, 30);
  assert.equal(f.host.states.at(-1).currentClue.selfJudgePlayerId, f.playerSession.playerId);
  assert.equal(Object.hasOwn(f.host.states.at(-1).currentClue, 'privateAnswer'), false);
  await assert.rejects(action(f.host, 'host:undo-score', { actionId: undo.id }));

  const nextUndo = nextMessage(f.host, 'room:state', (candidate) => Boolean(candidate.scoreUndo));
  await action(f.player, 'player:self-score-clue', { clueKey, correct: false });
  const previousId = (await nextUndo).scoreUndo.id;
  await action(f.host, 'host:skip-clue');
  await assert.rejects(action(f.host, 'host:undo-score', { actionId: previousId }));
  assert.equal(Boolean(f.host.states.at(-1).scoreUndo), false);
});

test('undo preserves Daily Double wagers and Final responses over real socket events', async (context) => {
  const f = await fixture(context);
  await action(f.host, 'host:start-game', { gameId: f.games[0].id });
  const daily = findClue(f.games[0], true);
  await action(f.host, 'host:open-clue', daily);
  const clueKey = f.host.states.at(-1).currentClue.clueKey;
  await action(f.host, 'host:set-daily-double', { playerId: f.playerSession.playerId, wager: 700 });
  await action(f.player, 'player:open-answer', { clueKey });
  const undoDaily = nextMessage(f.host, 'room:state', (state) => Boolean(state.scoreUndo));
  await action(f.player, 'player:self-score-clue', { clueKey, correct: true });
  const dailyRestored = nextMessage(f.player, 'room:state', (state) => state.currentClue?.canSelfScore && state.you.score === 0);
  await action(f.host, 'host:undo-score', { actionId: (await undoDaily).scoreUndo.id });
  const restoredDaily = await dailyRestored;
  assert.equal(restoredDaily.currentClue.value, 700);
  assert.equal(restoredDaily.currentClue.privateAnswer, daily.clue.answer);
  await action(f.player, 'player:self-score-clue', { clueKey, correct: true });
  await action(f.host, 'host:start-final');
  await action(f.player, 'player:final-wager', { wager: 200 });
  await action(f.host, 'host:advance-final', { phase: 'wager' });
  await action(f.player, 'player:final-response', { response: 'A private final response' });
  await action(f.host, 'host:advance-final', { phase: 'clue' });
  const undoFinal = nextMessage(f.host, 'room:state', (state) => Boolean(state.scoreUndo));
  await action(f.player, 'player:self-score-final', { correct: true });
  const finalRestored = nextMessage(f.player, 'room:state', (state) => state.final?.canSelfScore && state.you.score === 700);
  await action(f.host, 'host:undo-score', { actionId: (await undoFinal).scoreUndo.id });
  const final = (await finalRestored).final;
  assert.equal(final.yourWager, 200);
  assert.equal(final.yourResponse, 'A private final response');
  assert.equal(JSON.stringify(f.host.states.at(-1)).includes('A private final response'), false);
  await action(f.player, 'player:self-score-final', { correct: false });
  await action(f.host, 'host:finish-final');
  assert.equal(f.host.states.at(-1).players[0].score, 500);
});

test('hosting handoff preserves contestants and private answers while changing each token’s authority', async (context) => {
  const f = await fixture(context);
  await action(f.host, 'host:join-contestants', { name: 'Alex' });
  const oldHostId = f.host.states.at(-1).you.id;
  const observer = f.client();
  await action(observer, 'room:join', { code: f.hostSession.code, name: 'Theo' });
  await action(f.host, 'host:start-game', { gameId: f.games[0].id });
  await action(f.host, 'host:adjust-score', { playerId: oldHostId, delta: 400 });
  await action(f.host, 'host:adjust-score', { playerId: f.playerSession.playerId, delta: 600 });
  const clue = findClue(f.games[0]);
  await action(f.host, 'host:open-clue', clue);
  await action(f.player, 'player:buzz');
  const clueKey = f.player.states.at(-1).currentClue.clueKey;
  await action(f.player, 'player:open-answer', { clueKey });
  await assert.rejects(action(f.player, 'host:transfer-host', { playerId: oldHostId }), { code: 'HOST_ONLY' });

  const oldSessionEvent = nextMessage(f.host, 'room:session');
  const newSessionEvent = nextMessage(f.player, 'room:session');
  const observerChange = nextMessage(observer, 'room:state', (state) => state.players.some((player) => player.id === f.playerSession.playerId && player.isHost));
  const acknowledgement = await action(f.host, 'host:transfer-host', { playerId: f.playerSession.playerId });
  const [former, promoted, observed] = await Promise.all([oldSessionEvent, newSessionEvent, observerChange]);
  assert.deepEqual(acknowledgement, { ok: true });
  assert.equal(former.session.role, 'player');
  assert.equal(former.session.token, f.hostSession.token);
  assert.equal(former.session.playerId, oldHostId);
  assert.equal(promoted.session.role, 'host');
  assert.equal(promoted.session.token, f.playerSession.token);
  assert.equal(promoted.state.you.id, f.playerSession.playerId);
  assert.equal(promoted.state.you.score, 600);
  assert.equal(former.state.you.score, 400);
  assert.equal(promoted.state.currentClue.privateAnswer, clue.clue.answer);
  assert.equal(Object.hasOwn(former.state.currentClue, 'privateAnswer'), false);
  assert.equal(JSON.stringify([acknowledgement, former]).includes(f.playerSession.token), false);
  assert.equal(JSON.stringify(observed).includes(f.playerSession.token), false);
  assert.equal(JSON.stringify(observed).includes(f.hostSession.token), false);
  assert.equal(observer.sessions.length, 0);
  await assert.rejects(action(f.host, 'host:reset-game'), { code: 'HOST_ONLY' });
  await action(f.player, 'host:adjust-score', { playerId: oldHostId, delta: 200 });

  const oldDisconnected = nextMessage(f.player, 'room:state', (state) => state.players.some((player) => player.id === oldHostId && !player.connected));
  f.host.disconnect();
  await oldDisconnected;
  const oldReturning = f.client();
  const formerResume = await action(oldReturning, 'room:resume', f.hostSession);
  assert.equal(formerResume.session.role, 'player');
  assert.equal(formerResume.state.you.id, oldHostId);
  assert.equal(formerResume.state.you.score, 600);
  const newDisconnected = nextMessage(oldReturning, 'room:state', (state) => !state.hostConnected);
  f.player.disconnect();
  await newDisconnected;
  const newReturning = f.client();
  const promotedResume = await action(newReturning, 'room:resume', f.playerSession);
  assert.equal(promotedResume.session.role, 'host');
  assert.equal(promotedResume.state.you.id, f.playerSession.playerId);
  assert.equal(promotedResume.state.currentClue.privateAnswer, clue.clue.answer);
});

test('a dedicated host leaves after handoff without receiving the promoted player’s credential', async (context) => {
  const f = await fixture(context);
  const formerSession = nextMessage(f.host, 'room:session');
  const promotedSession = nextMessage(f.player, 'room:session');
  const ack = await action(f.host, 'host:transfer-host', { playerId: f.playerSession.playerId });
  const former = await formerSession;
  assert.equal(former.session, null);
  assert.equal(former.state, null);
  assert.equal(JSON.stringify([former, ack]).includes(f.playerSession.token), false);
  assert.equal((await promotedSession).state.players.length, 1);
  await assert.rejects(action(f.host, 'host:start-game', { gameId: f.games[0].id }));
  const returning = f.client();
  await assert.rejects(action(returning, 'room:resume', f.hostSession), { code: 'SESSION_EXPIRED' });
  const formerStates = f.host.states.length;
  await action(f.player, 'host:start-game', { gameId: f.games[0].id });
  assert.equal(f.host.states.length, formerStates);
  assert.equal(f.player.states.at(-1).role, 'host');
});

test('a failed handoff save rolls back authority and never sends a replacement session', async (context) => {
  let fail = false;
  let snapshot = null;
  const roomStore = {
    async load() { return snapshot; },
    async save(next) {
      if (fail) throw new Error('Save unavailable');
      snapshot = structuredClone(next);
    },
    async close() {},
  };
  const f = await fixture(context, { roomStore });
  fail = true;
  await assert.rejects(action(f.host, 'host:transfer-host', { playerId: f.playerSession.playerId }), { code: 'SERVER_ERROR' });
  assert.equal(f.server.rooms.stateFor(f.host.id, []).role, 'host');
  assert.equal(f.server.rooms.stateFor(f.player.id, []).role, 'player');
  assert.equal(snapshot.rooms[0].host.token, f.hostSession.token);
  fail = false;
  const unchangedPlayer = nextMessage(f.player, 'room:state', (state) => state.you.score === 200);
  await action(f.host, 'host:adjust-score', { playerId: f.playerSession.playerId, delta: 200 });
  await unchangedPlayer;
  assert.equal(f.host.sessions.length, 0);
  assert.equal(f.player.sessions.length, 0);
});

test('quick games stop at fifteen first-board clues and full games retain both rounds', async (context) => {
  const game = structuredClone(loadGames()[0]);
  game.doubleJeopardy = {
    categories: game.categories.map((category, categoryIndex) => ({
      ...category,
      clues: category.clues.map((clue, clueIndex) => ({ ...clue, value: clue.value * 2, dailyDouble: categoryIndex < 2 && clueIndex === 0 })),
    })),
  };
  const f = await fixture(context, { games: [game] });
  await assert.rejects(action(f.player, 'host:start-game', { gameId: game.id, mode: 'quick' }), { code: 'HOST_ONLY' });
  await action(f.host, 'host:start-game', { gameId: game.id, mode: 'quick' });
  const starting = f.host.states.at(-1);
  assert.equal(starting.gameMode, 'quick');
  assert.equal(starting.game.hasDoubleJeopardy, false);
  assert.equal(starting.game.totalClues, 15);
  assert.equal(starting.game.remainingClues, 15);
  assert.equal(starting.nextRoundName, 'Final Jeopardy');
  await assert.rejects(action(f.host, 'host:start-final'), { code: 'ROUND_INCOMPLETE' });
  for (let index = 0; index < 15; index += 1) {
    await action(f.host, 'host:open-clue', { categoryIndex: Math.floor(index / 5), clueIndex: index % 5, round: 'jeopardy' });
    await action(f.host, 'host:skip-clue');
  }
  const complete = f.host.states.at(-1);
  assert.equal(complete.canChooseClue, false);
  assert.equal(complete.canStartNextRound, true);
  assert.equal(complete.game.remainingClues, 0);
  await assert.rejects(action(f.host, 'host:open-clue', { categoryIndex: 3, clueIndex: 0, round: 'jeopardy' }));
  await action(f.host, 'host:next-round', { expectedRound: 'jeopardy' });
  assert.equal(f.host.states.at(-1).final.phase, 'complete');
  assert.equal(f.host.states.at(-1).completedGames[0].gameMode, 'quick');
  await action(f.host, 'host:reset-game');
  assert.equal(f.host.states.at(-1).gameMode, 'quick');
  assert.equal(f.host.states.at(-1).game.remainingClues, 15);
  await action(f.host, 'host:return-lobby');
  await action(f.host, 'host:start-game', { gameId: game.id, mode: 'full' });
  assert.equal(f.host.states.at(-1).gameMode, 'full');
  assert.equal(f.host.states.at(-1).game.hasDoubleJeopardy, true);
  assert.equal(f.host.states.at(-1).game.totalClues, 30);
  assert.equal(f.host.states.at(-1).nextRoundName, 'Double Jeopardy');
});
