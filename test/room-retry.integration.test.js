'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
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

for (const role of ['host', 'player']) {
  test(`a ${role} can retry a lost resume acknowledgement on the same connection`, { timeout: 5000 }, async (context) => {
    const games = loadGames();
    const server = createJeopardyServer({ games, logger: { error() {} } });
    const address = await server.start(0, '127.0.0.1');
    const origin = `http://127.0.0.1:${address.port}`;
    const sockets = [];
    const client = () => {
      const socket = createClient(origin, { transports: ['websocket'], forceNew: true, reconnection: false });
      sockets.push(socket);
      return socket;
    };
    context.after(async () => {
      sockets.forEach((socket) => socket.disconnect());
      await server.stop();
    });

    const host = client();
    const player = client();
    const hostSession = (await emitAck(host, 'room:create')).session;
    await emitAck(host, 'host:join-contestants', { name: 'Host' });
    const playerSession = (await emitAck(player, 'room:join', { code: hostSession.code, name: 'Player' })).session;
    await emitAck(host, 'host:start-game', { gameId: games[0].id });
    await emitAck(host, 'host:adjust-score', { playerId: playerSession.playerId, delta: 600 });

    const session = role === 'host' ? hostSession : playerSession;
    const otherSession = role === 'host' ? playerSession : hostSession;
    const returning = client();
    const resumed = once(returning, 'room:state');
    returning.emit('room:resume', session);
    await resumed;
    const before = server.rooms.exportSnapshot().rooms;

    const retried = await emitAck(returning, 'room:resume', { code: session.code.toLowerCase(), token: session.token });
    assert.equal(retried.session.role, role);
    assert.equal(retried.session.token, session.token);
    assert.equal(retried.session.playerId, session.playerId);
    assert.equal(retried.state.phase, 'board');
    assert.equal(retried.state.players.find((candidate) => candidate.id === playerSession.playerId).score, 600);
    assert.deepEqual(server.rooms.exportSnapshot().rooms, before);
    assert.equal(server.rooms.sessions.size, 2);

    const invalidToken = `${session.token[0] === 'A' ? 'B' : 'A'}${session.token.slice(1)}`;
    await assert.rejects(emitAck(returning, 'room:resume', { ...session, token: invalidToken }), { code: 'ALREADY_IN_ROOM' });
    await assert.rejects(emitAck(returning, 'room:resume', otherSession), { code: 'ALREADY_IN_ROOM' });
    await assert.rejects(emitAck(returning, 'room:resume', { ...session, code: session.code === 'AAAAA' ? 'BBBBB' : 'AAAAA' }), { code: 'ALREADY_IN_ROOM' });
    assert.deepEqual(server.rooms.exportSnapshot().rooms, before);
  });
}
