'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { io: createClient } = require('socket.io-client');
const { loadGames } = require('../lib/game-store');
const { createJeopardyServer } = require('../server');

function emitAck(socket, eventName, payload = {}) {
  return new Promise((resolve, reject) => {
    socket.timeout(3000).emit(eventName, payload, (timeoutError, response) => {
      if (timeoutError) return reject(timeoutError);
      if (!response?.ok) {
        return reject(Object.assign(new Error(response?.error?.message), { code: response?.error?.code }));
      }
      resolve(response);
    });
  });
}

test('same-socket create and join retries recover credentials without duplicating or changing a room', async (context) => {
  const games = loadGames();
  const server = createJeopardyServer({ games, logger: { error() {} } });
  const address = await server.start(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${address.port}`;
  const host = createClient(origin, { transports: ['websocket'], forceNew: true });
  const player = createClient(origin, { transports: ['websocket'], forceNew: true });
  context.after(async () => {
    host.disconnect();
    player.disconnect();
    await server.stop();
  });

  await emitAck(host, 'room:create').then(() => undefined);
  const code = server.rooms.roomCodeForSocket(host.id);
  const room = server.rooms.rooms.get(code);
  const originalHostToken = room.host.token;
  const created = await emitAck(host, 'room:create');
  assert.equal(created.session.code, code);
  assert.equal(created.session.token, originalHostToken);
  assert.equal(server.rooms.rooms.size, 1);

  await emitAck(player, 'room:join', { code, name: 'Jordan Lee' }).then(() => undefined);
  const originalPlayer = { ...room.players[0] };
  const joined = await emitAck(player, 'room:join', { code: code.toLowerCase(), name: '  Jordan   Lee  ' });
  assert.equal(joined.session.playerId, originalPlayer.id);
  assert.equal(joined.session.token, originalPlayer.token);
  assert.equal(room.players.length, 1);

  await emitAck(host, 'host:start-game', { gameId: games[0].id });
  await emitAck(host, 'host:adjust-score', { playerId: joined.session.playerId, delta: 600 });
  await emitAck(host, 'host:start-final');
  const finalRetry = await emitAck(player, 'room:join', { code, name: 'Jordan Lee' });
  const hostRetry = await emitAck(host, 'room:create');
  assert.equal(finalRetry.session.token, originalPlayer.token);
  assert.equal(finalRetry.state.phase, 'final');
  assert.equal(finalRetry.state.you.score, 600);
  assert.equal(hostRetry.state.phase, 'final');
  assert.equal(hostRetry.session.token, originalHostToken);
  assert.equal(room.players.length, 1);

  await assert.rejects(emitAck(player, 'room:join', { code, name: 'Different player' }), { code: 'ALREADY_IN_ROOM' });
  await assert.rejects(emitAck(player, 'room:join', { code: code === 'AAAAA' ? 'BBBBB' : 'AAAAA', name: 'Jordan Lee' }), { code: 'ALREADY_IN_ROOM' });
  await assert.rejects(emitAck(player, 'room:create'), { code: 'ALREADY_IN_ROOM' });
  await assert.rejects(emitAck(host, 'room:join', { code, name: 'Jordan Lee' }), { code: 'ALREADY_IN_ROOM' });
});
