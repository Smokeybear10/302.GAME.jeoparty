'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const test = require('node:test');
const { io: createClient } = require('socket.io-client');
const { loadGames } = require('../lib/game-store');
const { createJeopardyServer } = require('../server');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function action(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    socket.timeout(3000).emit(event, payload, (error, result) => {
      if (error) return reject(error);
      resolve(result);
    });
  });
}

async function fixture(context, heldSave) {
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const secondStarted = deferred();
  const releaseSecond = deferred();
  let saves = 0;
  let tracking = false;
  let snapshot = null;
  const roomStore = {
    async load() { return null; },
    async save(next) {
      if (tracking) saves += 1;
      if (saves === heldSave) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      if (saves === heldSave + 1) {
        secondStarted.resolve();
        await releaseSecond.promise;
        throw new Error('Save failed');
      }
      snapshot = structuredClone(next);
    },
    async close() {},
  };
  const server = createJeopardyServer({ games: loadGames(), roomStore, logger: { error() {} } });
  const address = await server.start(0, '127.0.0.1');
  tracking = true;
  const sockets = [];
  context.after(async () => {
    releaseFirst.resolve();
    releaseSecond.resolve();
    sockets.forEach((socket) => socket.disconnect());
    await server.stop();
  });
  function client() {
    const socket = createClient(`http://127.0.0.1:${address.port}`, { transports: ['websocket'], reconnection: false });
    sockets.push(socket);
    return socket;
  }
  return { server, client, firstStarted, releaseFirst, secondStarted, releaseSecond, saved: () => snapshot };
}

test('an earlier broadcast cannot reveal a later score change whose save fails', { timeout: 5000 }, async (context) => {
  const f = await fixture(context, 3);
  const host = f.client();
  await action(host, 'room:create');
  await action(host, 'host:join-contestants', { name: 'Jordan' });
  const playerId = f.server.rooms.stateFor(host.id, []).you.id;
  const states = [];
  const broadcast = once(host, 'room:state');
  host.on('room:state', (state) => states.push(state.you.score));
  const first = action(host, 'host:adjust-score', { playerId, delta: 200 });
  await f.firstStarted.promise;
  const receivedSecond = once(f.server.io.sockets.sockets.get(host.id), 'host:adjust-score');
  const second = action(host, 'host:adjust-score', { playerId, delta: 400 });
  await receivedSecond;
  f.releaseFirst.resolve();
  await f.secondStarted.promise;
  assert.equal((await first).ok, true);
  await broadcast;
  f.releaseSecond.resolve();
  assert.equal((await second).ok, false);
  assert.deepEqual(states, [200]);
  assert.equal(f.server.rooms.stateFor(host.id, []).you.score, 200);
  assert.equal(f.saved().rooms[0].players[0].score, 200);
});

test('a join acknowledgement contains only state that has already been saved', { timeout: 5000 }, async (context) => {
  const f = await fixture(context, 2);
  const host = f.client();
  const player = f.client();
  const { session } = await action(host, 'room:create');
  const joining = action(player, 'room:join', { code: session.code, name: 'Jordan' });
  await f.firstStarted.promise;
  const playerId = f.server.rooms.rooms.get(session.code).players[0].id;
  const receivedScore = once(f.server.io.sockets.sockets.get(host.id), 'host:adjust-score');
  const score = action(host, 'host:adjust-score', { playerId, delta: 400 });
  await receivedScore;
  f.releaseFirst.resolve();
  await f.secondStarted.promise;
  const joined = await joining;
  f.releaseSecond.resolve();
  assert.equal((await score).ok, false);
  assert.equal(joined.ok, true);
  assert.equal(joined.state.you.score, 0);
  assert.equal(f.saved().rooms[0].players[0].score, 0);
});
