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

test('socket clients receive Double Jeopardy, resume private responses, and advance to Final', async (context) => {
  const game = structuredClone(loadGames()[0]);
  game.doubleJeopardy = {
    categories: game.categories.map((category, categoryIndex) => ({
      name: `DOUBLE ${categoryIndex + 1}`,
      clues: category.clues.map((clue, clueIndex) => ({
        ...clue,
        value: clue.value * 2,
        clue: `Second round: ${clue.clue}`,
        dailyDouble: categoryIndex < 2 && clueIndex === 0,
      })),
    })),
  };
  const server = createJeopardyServer({ games: [game], logger: { error() {} } });
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
  const player = client();
  const created = await action(host, 'room:create');
  const joined = await action(player, 'room:join', { code: created.session.code, name: 'Jordan' });
  await action(host, 'host:start-game', { gameId: game.id });
  await assert.rejects(action(player, 'host:next-round', { expectedRound: 'jeopardy' }), { code: 'HOST_ONLY' });
  await assert.rejects(action(host, 'host:next-round', { expectedRound: 'jeopardy' }), { code: 'ROUND_INCOMPLETE' });
  await assert.rejects(action(host, 'host:start-final'), { code: 'DOUBLE_JEOPARDY_PENDING' });

  function finishBoard() {
    const state = server.rooms.stateFor(host.id, []);
    state.game.categories.forEach((category, categoryIndex) => {
      category.clues.forEach((clue, clueIndex) => {
        if (clue.answered) return;
        server.rooms.openClue(host.id, { categoryIndex, clueIndex, round: state.round });
        server.rooms.skipClue(host.id);
      });
    });
  }
  finishBoard();
  const hostSawDouble = nextState(host, (state) => state.round === 'double');
  const playerSawDouble = nextState(player, (state) => state.round === 'double');
  await action(host, 'host:next-round', { expectedRound: 'jeopardy' });
  for (const state of await Promise.all([hostSawDouble, playerSawDouble])) {
    assert.equal(state.game.categories[0].name, 'DOUBLE 1');
    assert.equal(state.game.categories[0].clues[0].value, 400);
    assert.equal(state.game.remainingClues, 30);
    assert.equal(Object.hasOwn(state.game.categories[0].clues[0], 'answer'), false);
    assert.equal(Object.hasOwn(state.game.categories[0].clues[0], 'dailyDouble'), false);
  }
  await assert.rejects(action(host, 'host:next-round', { expectedRound: 'jeopardy' }), { code: 'STALE_ROUND' });
  await assert.rejects(action(host, 'host:open-clue', { categoryIndex: 2, clueIndex: 1, round: 'jeopardy' }), { code: 'STALE_ROUND' });
  const playerSawQuestion = nextState(player, (state) => state.currentClue?.clueKey === 'double:2:1');
  await action(host, 'host:open-clue', { categoryIndex: 2, clueIndex: 1, round: 'double' });
  const clue = (await playerSawQuestion).currentClue;
  assert.equal(clue.question, game.doubleJeopardy.categories[2].clues[1].clue);
  assert.equal(Object.hasOwn(clue, 'answer'), false);
  await action(player, 'player:buzz');
  const privateAnswer = nextState(player, (state) => Boolean(state.currentClue?.privateAnswer));
  const hostSawChecking = nextState(host, (state) => state.currentClue?.selfJudgePlayerId === joined.session.playerId);
  await action(player, 'player:open-answer', { clueKey: clue.clueKey });
  assert.equal((await privateAnswer).currentClue.privateAnswer, game.doubleJeopardy.categories[2].clues[1].answer);
  assert.equal(Object.hasOwn((await hostSawChecking).currentClue, 'privateAnswer'), false);

  const sawDisconnect = nextState(host, (state) => !state.players[0].connected);
  player.disconnect();
  await sawDisconnect;
  const resumedPlayer = client();
  const resumed = await action(resumedPlayer, 'room:resume', joined.session);
  assert.equal(resumed.state.round, 'double');
  assert.equal(resumed.state.currentClue.clueKey, clue.clueKey);
  assert.equal(resumed.state.currentClue.privateAnswer, game.doubleJeopardy.categories[2].clues[1].answer);
  await action(resumedPlayer, 'player:self-score-clue', { clueKey: clue.clueKey, correct: true });
  await assert.rejects(action(host, 'host:start-final'), { code: 'ROUND_INCOMPLETE' });
  finishBoard();
  const playerSawFinal = nextState(resumedPlayer, (state) => state.phase === 'final');
  await action(host, 'host:next-round', { expectedRound: 'double' });
  const final = (await playerSawFinal).final;
  assert.equal(final.phase, 'wager');
  assert.equal(final.yourMaxWager, 800);
  assert.equal(Object.hasOwn(final, 'answer'), false);
});
