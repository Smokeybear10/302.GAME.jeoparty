'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { io: createClient } = require('socket.io-client');
const { loadGames } = require('../lib/game-store');
const { fileRoomStore } = require('../lib/room-store');
const { createJeopardyServer } = require('../server');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function action(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    socket.timeout(3000).emit(event, payload, (timeout, result) => {
      if (timeout) return reject(timeout);
      if (!result?.ok) return reject(Object.assign(new Error(result?.error?.message), { code: result?.error?.code }));
      resolve(result);
    });
  });
}

function nextState(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('room:state', receive);
      reject(new Error('Expected room state was not received'));
    }, 3000);
    function receive(state) {
      if (!predicate(state)) return;
      clearTimeout(timeout);
      socket.off('room:state', receive);
      resolve(state);
    }
    socket.on('room:state', receive);
  });
}

function client(address, sockets) {
  const socket = createClient(`http://127.0.0.1:${address.port}`, { transports: ['websocket'], reconnection: false, forceNew: true });
  socket.sessions = [];
  socket.states = [];
  socket.on('room:session', (session) => socket.sessions.push(session));
  socket.on('room:state', (state) => socket.states.push(state));
  sockets.push(socket);
  return socket;
}

async function fixture(context) {
  let now = 1000;
  let snapshot = null;
  let heldSave = null;
  const sockets = [];
  const roomStore = {
    async load() { return snapshot; },
    async save(next) {
      const held = heldSave;
      heldSave = null;
      if (held) {
        held.started.resolve();
        await held.release.promise;
        if (held.fail) throw new Error('Save unavailable');
      }
      snapshot = structuredClone(next);
    },
    async close() {},
  };
  const server = createJeopardyServer({ games: loadGames(), roomStore, now: () => now, logger: { error() {} } });
  const address = await server.start(0, '127.0.0.1');
  const holds = [];
  context.after(async () => {
    holds.forEach((held) => held.release.resolve());
    sockets.forEach((socket) => socket.disconnect());
    await server.stop();
  });
  const host = client(address, sockets);
  const player = client(address, sockets);
  const hostSession = (await action(host, 'room:create')).session;
  const playerSession = (await action(player, 'room:join', { code: hostSession.code, name: 'Maya' })).session;
  return {
    server, host, player, hostSession, playerSession,
    client: () => client(address, sockets),
    saved: () => snapshot,
    setNow(value) { now = value; },
    holdNextSave({ fail = false } = {}) {
      const held = { started: deferred(), release: deferred(), fail };
      holds.push(held);
      heldSave = held;
      return held;
    },
  };
}

async function disconnectHost(f) {
  const offline = nextState(f.player, (state) => !state.hostConnected);
  f.host.disconnect();
  await offline;
  f.setNow(61000);
}

test('a failed recovery save rolls back authority and sends no replacement session or state', async (context) => {
  const f = await fixture(context);
  await disconnectHost(f);
  const before = f.saved();
  const stateCount = f.player.states.length;
  const held = f.holdNextSave({ fail: true });
  const failure = assert.rejects(action(f.player, 'player:claim-host'), { code: 'SERVER_ERROR' });
  await held.started.promise;
  assert.equal(f.player.sessions.length, 0);
  assert.equal(f.player.states.length, stateCount);
  assert.deepEqual(f.saved(), before);
  held.release.resolve();
  await failure;
  assert.equal(f.server.rooms.stateFor(f.player.id, []).role, 'player');
  assert.equal(f.server.rooms.stateFor(f.player.id, []).hostRecovery.availableAt, 61000);
  assert.equal(f.player.sessions.length, 0);
  assert.equal(f.player.states.length, stateCount);
  assert.deepEqual(f.saved(), before);

  const promoted = once(f.player, 'room:session');
  assert.deepEqual(await action(f.player, 'player:claim-host'), { ok: true });
  assert.equal((await promoted)[0].session.role, 'host');
  assert.equal(f.saved().rooms[0].host.token, f.playerSession.token);
});

test('a host reconnect queued before recovery wins even while its durable save is pending', async (context) => {
  const f = await fixture(context);
  await disconnectHost(f);
  const returningHost = f.client();
  const held = f.holdNextSave();
  const reconnecting = action(returningHost, 'room:resume', f.hostSession);
  await held.started.promise;
  const claimReceived = once(f.server.io.sockets.sockets.get(f.player.id), 'player:claim-host');
  const rejectedClaim = assert.rejects(action(f.player, 'player:claim-host'), { code: 'HOST_CONNECTED' });
  await claimReceived;
  assert.equal(f.player.sessions.length, 0);
  held.release.resolve();
  assert.equal((await reconnecting).session.role, 'host');
  await rejectedClaim;
  assert.equal(f.player.sessions.length, 0);
  assert.equal(f.server.rooms.stateFor(f.player.id, []).hostConnected, true);
  assert.equal(f.saved().rooms[0].host.token, f.hostSession.token);
  await action(returningHost, 'host:adjust-score', { playerId: f.playerSession.playerId, delta: 200 });
  assert.equal(f.saved().rooms[0].players[0].score, 200);
});

test('the first durable recovery wins and only its claimant receives host credentials', async (context) => {
  const f = await fixture(context);
  const contender = f.client();
  const contenderSession = (await action(contender, 'room:join', { code: f.hostSession.code, name: 'Theo' })).session;
  await disconnectHost(f);
  const held = f.holdNextSave();
  const promoted = once(f.player, 'room:session');
  const recovering = action(f.player, 'player:claim-host');
  await held.started.promise;
  const contenderReceived = once(f.server.io.sockets.sockets.get(contender.id), 'player:claim-host');
  const rejectedContender = assert.rejects(action(contender, 'player:claim-host'), { code: 'HOST_CONNECTED' });
  await contenderReceived;
  assert.equal(f.player.sessions.length, 0);
  assert.equal(contender.sessions.length, 0);
  held.release.resolve();
  assert.deepEqual(await recovering, { ok: true });
  const promotion = (await promoted)[0];
  await rejectedContender;
  assert.deepEqual(promotion.session, { code: f.hostSession.code, token: f.playerSession.token, role: 'host' });
  assert.equal(promotion.state.you.id, f.playerSession.playerId);
  assert.equal(promotion.state.role, 'host');
  assert.equal(contender.sessions.length, 0);
  assert.equal(JSON.stringify(contender.states).includes(f.playerSession.token), false);
  assert.equal(JSON.stringify(promotion).includes(contenderSession.token), false);
  const returningOldHost = f.client();
  await assert.rejects(action(returningOldHost, 'room:resume', f.hostSession), { code: 'SESSION_EXPIRED' });

  const offline = nextState(contender, (state) => !state.hostConnected);
  f.player.disconnect();
  await offline;
  const returningNewHost = f.client();
  const resumed = await action(returningNewHost, 'room:resume', f.playerSession);
  assert.equal(resumed.session.role, 'host');
  assert.equal(resumed.state.you.id, f.playerSession.playerId);
  await action(returningNewHost, 'host:adjust-score', { playerId: contenderSession.playerId, delta: 400 });
  assert.equal(f.saved().rooms[0].players.find((player) => player.id === contenderSession.playerId).score, 400);
});

test('recovered host and former host contestant retain their correct roles after a file-store restart', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jeoparty-host-recovery-'));
  const filename = path.join(directory, 'rooms.json');
  const servers = new Set();
  const sockets = [];
  let now = 1000;
  context.after(async () => {
    sockets.forEach((socket) => socket.disconnect());
    for (const server of servers) await server.stop();
    await fs.rm(directory, { recursive: true, force: true });
  });
  async function start() {
    const server = createJeopardyServer({ games: loadGames(), roomStore: fileRoomStore(filename), now: () => now });
    servers.add(server);
    const address = await server.start(0, '127.0.0.1');
    return { server, client: () => client(address, sockets) };
  }
  const first = await start();
  const host = first.client();
  const player = first.client();
  const hostSession = (await action(host, 'room:create')).session;
  await action(host, 'host:join-contestants', { name: 'Alex' });
  const formerHostId = host.states.at(-1).you.id;
  const playerSession = (await action(player, 'room:join', { code: hostSession.code, name: 'Maya' })).session;
  await action(host, 'host:adjust-score', { playerId: formerHostId, delta: 800 });
  const offline = nextState(player, (state) => !state.hostConnected);
  host.disconnect();
  await offline;
  now = 61000;
  const promoted = once(player, 'room:session');
  await action(player, 'player:claim-host');
  const newHostSession = (await promoted)[0].session;
  await first.server.stop();
  servers.delete(first.server);
  now = 62000;
  const second = await start();
  const returningFormerHost = second.client();
  const returningNewHost = second.client();
  const former = await action(returningFormerHost, 'room:resume', hostSession);
  assert.equal(former.session.role, 'player');
  assert.equal(former.state.you.id, formerHostId);
  assert.equal(former.state.you.score, 800);
  await assert.rejects(action(returningFormerHost, 'host:adjust-score', { playerId: formerHostId, delta: 200 }), { code: 'HOST_ONLY' });
  const resumed = await action(returningNewHost, 'room:resume', newHostSession);
  assert.equal(resumed.session.role, 'host');
  assert.equal(resumed.session.token, playerSession.token);
  assert.equal(resumed.state.you.id, playerSession.playerId);
  await action(returningNewHost, 'host:adjust-score', { playerId: formerHostId, delta: 200 });
  const saved = JSON.parse(await fs.readFile(filename, 'utf8'));
  assert.equal(saved.rooms[0].host.token, playerSession.token);
  assert.equal(saved.rooms[0].players.find((candidate) => candidate.id === formerHostId).score, 1000);
});
