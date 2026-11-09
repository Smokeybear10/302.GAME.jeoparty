'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const { once } = require('node:events');
const { Socket } = require('engine.io-client');
const { io } = require('socket.io-client');
const { createJeopardyServer } = require('../server');
const { loadGames, validateGame } = require('../lib/game-store');
const { tokenBucket, clientAddress } = require('../lib/request-limits');

function action(socket, event, payload = {}) {
  return new Promise((resolve, reject) => socket.timeout(2000).emit(event, payload, (error, response) => {
    if (error) return reject(error);
    if (!response.ok) return reject(Object.assign(new Error(response.error.message), response.error));
    resolve(response);
  }));
}

async function fixture(context, limits, extra = {}) {
  let time = 1000;
  const server = createJeopardyServer({ games: loadGames(), limits, now: () => time, logger: { error() {} }, ...extra });
  const address = await server.start(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${address.port}`;
  const clients = [];
  context.after(async () => { clients.forEach((socket) => socket.disconnect()); await server.stop(); });
  return { server, origin, advance: (ms) => { time += ms; }, client() {
    const socket = io(origin, { transports: ['websocket'], forceNew: true, reconnection: false });
    clients.push(socket);
    return socket;
  } };
}

test('room creation is limited across connections and refills without blocking a join', async (context) => {
  const f = await fixture(context, { createBurst: 1, createRate: 1 });
  const host = f.client();
  const created = await action(host, 'room:create');
  assert.equal((await action(host, 'room:create')).session.code, created.session.code);
  const player = f.client();
  await assert.rejects(action(player, 'room:create'), { code: 'RATE_LIMITED' });
  await action(player, 'room:join', { code: created.session.code, name: 'Jordan' });
  f.advance(1000);
  await action(f.client(), 'room:create');
  assert.equal(f.server.rooms.rooms.size, 2);
});

test('room capacity checks are serialized and closed rooms free capacity', async (context) => {
  const f = await fixture(context, { maxRooms: 1 });
  const host = f.client();
  await action(host, 'room:create');
  const second = f.client();
  await assert.rejects(action(second, 'room:create'), { code: 'ROOM_LIMIT' });
  await action(host, 'room:close');
  await action(second, 'room:create');
  assert.equal(f.server.rooms.rooms.size, 1);
});

test('action floods are rejected before saving and legitimate actions recover after refill', async (context) => {
  let writes = 0;
  const roomStore = { load: async () => null, save: async () => { writes += 1; }, close: async () => {} };
  const f = await fixture(context, { actionBurst: 2, actionRate: 1 }, { roomStore });
  const host = f.client();
  await action(host, 'room:create');
  await action(host, 'host:join-contestants', { name: 'Alex' });
  const before = writes;
  await assert.rejects(action(host, 'host:reset-game'), { code: 'RATE_LIMITED' });
  assert.equal(writes, before);
  f.advance(1000);
  await action(host, 'room:close');
});

test('active connection caps release slots on disconnect', { timeout: 5000 }, async (context) => {
  const f = await fixture(context, { connectionsPerAddress: 1 });
  const first = f.client();
  await once(first, 'connect');
  const rejected = f.client();
  const [error] = await once(rejected, 'connect_error');
  assert.match(error.message, /busy|websocket error/);
  const disconnected = once(f.server.io.sockets.sockets.get(first.id).conn, 'close');
  first.disconnect();
  await disconnected;
  const next = f.client();
  await once(next, 'connect');
  assert.ok(next.connected);
});

test('simultaneous packets reserve queue capacity before waiting on storage', async (context) => {
  let writes = 0;
  const roomStore = { load: async () => null, close: async () => {}, save: async () => {
    writes += 1;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } };
  const f = await fixture(context, { maxPending: 1 }, { roomStore });
  const host = f.client();
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => action(host, 'room:create')));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.reason?.code === 'SERVER_BUSY').length, 19);
  assert.equal(writes, 2);
});

test('raw transport connections cannot bypass connection caps', { timeout: 5000 }, async (context) => {
  const f = await fixture(context, { maxConnections: 1, connectionsPerAddress: 1 });
  const raw = new Socket(f.origin, { path: '/socket.io', transports: ['websocket'] });
  context.after(() => raw.close());
  await once(raw, 'open');
  const blocked = new Socket(f.origin, { path: '/socket.io', transports: ['websocket'] });
  context.after(() => blocked.close());
  await once(blocked, 'error');
  assert.equal(f.server.io.engine.clientsCount, 1);
  assert.equal(f.server.io.sockets.sockets.size, 0);
});

test('pending handshakes reserve capacity until the admitted transport closes', { timeout: 5000 }, async (context) => {
  const f = await fixture(context, { maxConnections: 1, connectionsPerAddress: 1 });
  let started;
  let release;
  const handshakeStarted = new Promise((resolve) => { started = resolve; });
  const holdHandshake = new Promise((resolve) => { release = resolve; });
  const generateId = f.server.io.engine.generateId;
  context.mock.method(f.server.io.engine, 'generateId', async function (request) {
    started();
    await holdHandshake;
    return generateId.call(this, request);
  });
  const admitted = new Socket(f.origin, { path: '/socket.io', transports: ['websocket'] });
  const opened = once(admitted, 'open');
  let blocked;
  try {
    await handshakeStarted;
    blocked = new Socket(f.origin, { path: '/socket.io', transports: ['websocket'] });
    await once(blocked, 'error');
    assert.equal(f.server.io.engine.clientsCount, 0);
    release();
    await opened;
    assert.equal(f.server.io.engine.clientsCount, 1);
    const transportClosed = once(f.server.io.engine.clients[admitted.id], 'close');
    admitted.close();
    await transportClosed;
    const next = f.client();
    await once(next, 'connect');
    assert.ok(next.connected);
  } finally {
    release();
    admitted.close();
    blocked?.close();
  }
});

test('a rejected WebSocket handshake releases its reserved connection slot immediately', { timeout: 5000 }, async (context) => {
  const f = await fixture(context, { maxConnections: 1, connectionsPerAddress: 1 });
  const status = await new Promise((resolve, reject) => {
    const request = http.get(`${f.origin}/socket.io/?EIO=4&transport=websocket`, {
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'invalid' },
    }, (response) => {
      response.resume();
      request.once('close', () => resolve(response.statusCode));
    });
    request.on('error', reject);
  });
  assert.equal(status, 400);
  assert.equal(f.server.io.engine.clientsCount, 0);
  const next = f.client();
  await new Promise((resolve, reject) => {
    next.once('connect', resolve);
    next.once('connect_error', reject);
  });
  assert.ok(next.connected);
});

test('a custom board accepts maximum-length Unicode fields without disconnecting its host', async (context) => {
  const f = await fixture(context);
  const host = f.client();
  const { session } = await action(host, 'room:create');
  const game = structuredClone(loadGames()[0]);
  game.title = '界'.repeat(80);
  game.description = '界'.repeat(180);
  game.categories.forEach((category, categoryIndex) => {
    category.name = `${categoryIndex}${'界'.repeat(59)}`;
    category.clues.forEach((clue) => {
      clue.clue = '界'.repeat(500);
      clue.answer = '界'.repeat(240);
      clue.dailyDouble = clue.dailyDouble === true;
    });
  });
  game.finalJeopardy = { category: '界'.repeat(80), clue: '界'.repeat(500), answer: '界'.repeat(240) };
  assert.deepEqual(validateGame(game), []);
  const payload = { game };
  const bytes = Buffer.byteLength(JSON.stringify(['host:create-custom-game', payload]));
  assert.ok(bytes > 64 * 1024 && bytes < 128 * 1024);
  const response = await action(host, 'host:create-custom-game', payload);
  assert.ok(host.connected);
  const saved = f.server.rooms.rooms.get(session.code).customGames[0];
  assert.equal(saved.id, response.result.gameId);
  assert.deepEqual(saved.categories, game.categories);
  assert.deepEqual(saved.finalJeopardy, game.finalJeopardy);
});

test('forwarded IPs are ignored locally and only the final trusted hop is used behind a proxy', () => {
  const request = { headers: { 'x-forwarded-for': '1.2.3.4, 198.51.100.2' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(clientAddress(request), '127.0.0.1');
  assert.equal(clientAddress(request, true), '198.51.100.2');
  request.headers['x-forwarded-for'] = '1.2.3.4, junk';
  assert.equal(clientAddress(request, true), '127.0.0.1');
});

test('limiter bounds address memory, refills over time and tolerates clock changes', () => {
  let time = 1000;
  const limiter = tokenBucket({ capacity: 2, refillPerSecond: 1, maxKeys: 1, now: () => time });
  assert.equal(limiter.take('a'), true);
  assert.equal(limiter.take('a'), true);
  assert.equal(limiter.take('a'), false);
  assert.equal(limiter.take('b'), false);
  time = 500;
  assert.equal(limiter.take('a'), false);
  time = 2500;
  assert.equal(limiter.take('b'), true);
});

test('private results endpoints require a capability and never cache results', async (context) => {
  let reads = 0;
  const validToken = 'x'.repeat(43);
  const roomStore = {
    load: async () => null, save: async () => {}, close: async () => {},
    readResult: async (token) => { reads += 1; return token === validToken ? { title: 'Saved game', resultToken: token } : null; },
  };
  const f = await fixture(context, {}, { roomStore });
  const read = (token) => fetch(`${f.origin}/api/results`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  assert.equal((await fetch(`${f.origin}/api/results?token=${validToken}`)).status, 404);
  assert.equal((await read('bad')).status, 400);
  assert.equal(reads, 0);
  assert.equal((await read('z'.repeat(43))).status, 404);
  const response = await read(validToken);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal((await response.json()).result.title, 'Saved game');
  for (let index = 0; index < 27; index += 1) await read(validToken);
  assert.equal((await read(validToken)).status, 429);
});
