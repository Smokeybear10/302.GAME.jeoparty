'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { io: createClient } = require('socket.io-client');
const { loadGames } = require('../lib/game-store');
const { fileRoomStore, configuredRoomStore, postgresRoomStore } = require('../lib/room-store');
const { createJeopardyServer } = require('../server');

function action(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    socket.timeout(3000).emit(event, payload, (timeout, result) => {
      if (timeout) return reject(timeout);
      if (!result?.ok) return reject(Object.assign(new Error(result?.error?.message), { code: result?.error?.code }));
      resolve(result);
    });
  });
}

async function temporarySave(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jeoparty-saves-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'rooms.json');
}

for (const backend of ['file', 'postgres']) {
test(`a new server resumes private Final responses, scores, and the original game from ${backend}`, {
  skip: backend === 'postgres' && !process.env.JEOPARDY_TEST_DATABASE_URL,
}, async (context) => {
  const filename = await temporarySave(context);
  const store = () => backend === 'file' ? fileRoomStore(filename) : postgresRoomStore(process.env.JEOPARDY_TEST_DATABASE_URL);
  if (backend === 'postgres') {
    const initial = store();
    await initial.load();
    await initial.save({ version: 1, savedAt: Date.now(), rooms: [] });
    await initial.close();
  }
  const games = loadGames();
  const servers = [];
  const sockets = [];
  context.after(async () => {
    sockets.forEach((socket) => socket.disconnect());
    for (const server of servers) await server.stop();
  });
  async function start(games) {
    const server = createJeopardyServer({ games, roomStore: store() });
    servers.push(server);
    const address = await server.start(0, '127.0.0.1');
    function client() {
      const socket = createClient(`http://127.0.0.1:${address.port}`, { transports: ['websocket'], reconnection: false });
      sockets.push(socket);
      return socket;
    }
    return { server, host: client(), player: client() };
  }
  const first = await start(games);
  const hostSession = (await action(first.host, 'room:create')).session;
  const playerSession = (await action(first.player, 'room:join', { code: hostSession.code, name: 'Jordan' })).session;
  await action(first.host, 'host:start-game', { gameId: games[0].id });
  await action(first.host, 'host:adjust-score', { playerId: playerSession.playerId, delta: 600 });
  await action(first.host, 'host:start-final');
  await action(first.player, 'player:final-wager', { wager: 200 });
  await action(first.host, 'host:advance-final', { phase: 'wager' });
  await action(first.player, 'player:final-response', { response: 'My private response' });
  await action(first.host, 'host:advance-final', { phase: 'clue' });
  await first.server.stop();
  servers.splice(servers.indexOf(first.server), 1);

  const second = await start([games[1]]);
  const hostState = (await action(second.host, 'room:resume', hostSession)).state;
  const playerState = (await action(second.player, 'room:resume', playerSession)).state;
  assert.equal(hostState.game.id, games[0].id);
  assert.equal(hostState.players[0].connected, false);
  assert.equal(JSON.stringify(hostState).includes('My private response'), false);
  assert.equal(playerState.final.phase, 'answer');
  assert.equal(playerState.final.yourResponse, 'My private response');
  assert.equal(playerState.final.yourWager, 200);
  assert.equal(playerState.you.score, 600);
  await action(second.player, 'player:self-score-final', { correct: true });
  await assert.rejects(action(second.player, 'player:self-score-final', { correct: true }), { code: 'ALREADY_SCORED' });
  const reader = store();
  const saved = await reader.load();
  await reader.close();
  assert.equal(saved.rooms[0].players[0].score, 800);
  if (backend === 'file') assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
  await action(second.host, 'room:close');
  const closedReader = store();
  assert.deepEqual((await closedReader.load()).rooms, []);
  await closedReader.close();
});
}

for (const removal of ['leave', 'remove', 'legacy save']) {
  test(`Final survives a controller ${removal} and restarts alongside another room`, async (context) => {
    const filename = await temporarySave(context);
    const games = loadGames();
    const servers = new Set();
    const sockets = [];
    context.after(async () => {
      sockets.forEach((socket) => socket.disconnect());
      for (const server of servers) await server.stop();
    });
    async function start() {
      const server = createJeopardyServer({ games, roomStore: fileRoomStore(filename) });
      servers.add(server);
      const address = await server.start(0, '127.0.0.1');
      const client = () => {
        const socket = createClient(`http://127.0.0.1:${address.port}`, { transports: ['websocket'], reconnection: false });
        sockets.push(socket);
        return socket;
      };
      return { server, host: client(), departing: client(), staying: client(), otherHost: client() };
    }

    const first = await start();
    const hostSession = (await action(first.host, 'room:create')).session;
    const otherSession = (await action(first.otherHost, 'room:create')).session;
    await action(first.host, 'host:join-contestants', { name: 'Host' });
    const departing = (await action(first.departing, 'room:join', { code: hostSession.code, name: 'Departing' })).session;
    const staying = (await action(first.staying, 'room:join', { code: hostSession.code, name: 'Staying' })).session;
    await action(first.host, 'host:start-game', { gameId: games[0].id });
    const clue = games[0].categories.flatMap((category, categoryIndex) => category.clues
      .map((clue, clueIndex) => ({ clue, categoryIndex, clueIndex }))).find(({ clue }) => !clue.dailyDouble);
    await action(first.host, 'host:open-clue', { categoryIndex: clue.categoryIndex, clueIndex: clue.clueIndex });
    await action(first.departing, 'player:buzz');
    const clueKey = first.server.rooms.stateFor(first.departing.id, []).currentClue.clueKey;
    await action(first.departing, 'player:open-answer', { clueKey });
    await action(first.departing, 'player:self-score-clue', { clueKey, correct: true });
    assert.equal(first.server.rooms.stateFor(first.host.id, []).controlPlayerId, departing.playerId);
    await action(first.host, 'host:adjust-score', { playerId: staying.playerId, delta: 600 });
    await action(first.host, 'host:start-final');
    await action(first.departing, 'player:final-wager', { wager: 100 });
    await action(first.staying, 'player:final-wager', { wager: 200 });
    await action(first.host, 'host:advance-final', { phase: 'wager' });
    await action(first.departing, 'player:final-response', { response: 'Departing response' });
    await action(first.staying, 'player:final-response', { response: 'Private surviving response' });
    await action(first.host, 'host:advance-final', { phase: 'clue' });
    if (removal === 'remove') await action(first.host, 'host:remove-player', { playerId: departing.playerId });
    else await action(first.departing, 'room:leave');
    await first.server.stop();
    servers.delete(first.server);

    if (removal === 'legacy save') {
      const snapshot = JSON.parse(await fs.readFile(filename, 'utf8'));
      snapshot.rooms.find((room) => room.code === hostSession.code).controlPlayerId = departing.playerId;
      await fs.writeFile(filename, JSON.stringify(snapshot));
    } else {
      const snapshot = JSON.parse(await fs.readFile(filename, 'utf8'));
      assert.equal(snapshot.rooms.find((room) => room.code === hostSession.code).controlPlayerId, null);
    }

    const second = await start();
    const hostState = (await action(second.host, 'room:resume', hostSession)).state;
    const playerState = (await action(second.staying, 'room:resume', staying)).state;
    const otherState = (await action(second.otherHost, 'room:resume', otherSession)).state;
    assert.equal(second.server.rooms.rooms.size, 2);
    assert.equal(hostState.controlPlayerId, null);
    assert.equal(hostState.final.phase, 'answer');
    assert.equal(hostState.players.some((player) => player.id === departing.playerId), false);
    assert.equal(JSON.stringify(hostState).includes('Private surviving response'), false);
    assert.equal(playerState.final.yourResponse, 'Private surviving response');
    assert.equal(playerState.final.yourWager, 200);
    assert.equal(playerState.you.score, 600);
    assert.equal(otherState.code, otherSession.code);
    assert.equal(otherState.phase, 'lobby');
    await assert.rejects(action(second.departing, 'room:resume', departing), { code: 'SESSION_EXPIRED' });
    await action(second.staying, 'player:self-score-final', { correct: true });
    await action(second.host, 'host:finish-final');
    assert.equal(second.server.rooms.stateFor(second.staying.id, []).you.score, 800);
    const saved = JSON.parse(await fs.readFile(filename, 'utf8'));
    assert.equal(saved.rooms.find((room) => room.code === hostSession.code).controlPlayerId, null);
  });
}

test('failed saves roll back score changes and queued actions cannot overwrite each other', async (context) => {
  let snapshot = null;
  let fail = false;
  const roomStore = {
    async load() { return snapshot; },
    async save(next) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (fail) throw new Error('Disk full');
      snapshot = structuredClone(next);
    },
    async close() {},
  };
  const server = createJeopardyServer({ games: loadGames(), roomStore, logger: { error() {} } });
  const address = await server.start(0, '127.0.0.1');
  const host = createClient(`http://127.0.0.1:${address.port}`, { transports: ['websocket'], reconnection: false });
  context.after(async () => { host.disconnect(); await server.stop(); });
  const session = (await action(host, 'room:create')).session;
  await action(host, 'host:join-contestants', { name: 'Jordan' });
  const playerId = server.rooms.rooms.get(session.code).host.playerId;
  const score = (delta) => action(host, 'host:adjust-score', { playerId, delta });
  await Promise.all([score(200), score(400)]);
  assert.equal(snapshot.rooms[0].players[0].score, 600);
  fail = true;
  await assert.rejects(score(1000), { code: 'SERVER_ERROR' });
  assert.equal(server.rooms.stateFor(host.id, []).you.score, 600);
  assert.equal(snapshot.rooms[0].players[0].score, 600);
  fail = false;
  await score(200);
  assert.equal(snapshot.rooms[0].players[0].score, 800);
});

test('corrupt save files are preserved and never silently replaced with empty rooms', async (context) => {
  const filename = await temporarySave(context);
  const damaged = '{damaged save';
  await fs.writeFile(filename, damaged);
  const server = createJeopardyServer({ games: loadGames(), roomStore: fileRoomStore(filename) });
  context.after(() => server.stop());
  await assert.rejects(server.start(0, '127.0.0.1'), /save file has been left untouched/);
  assert.equal(await fs.readFile(filename, 'utf8'), damaged);
});

for (const invalid of [false, 0, '']) {
  test(`a saved ${JSON.stringify(invalid)} is rejected before the server listens or replaces it`, async (context) => {
    const filename = await temporarySave(context);
    const contents = JSON.stringify(invalid);
    await fs.writeFile(filename, contents);
    const server = createJeopardyServer({ games: loadGames(), roomStore: fileRoomStore(filename) });
    context.after(() => server.stop());
    await assert.rejects(server.start(0, '127.0.0.1'), /Invalid room snapshot/);
    assert.equal(server.httpServer.listening, false);
    assert.equal(await fs.readFile(filename, 'utf8'), contents);
  });
}

test('an uncertain save makes the server unhealthy and blocks queued and later mutations', { timeout: 5000 }, async (context) => {
  let snapshot = null;
  let writes = 0;
  let uncertain = false;
  let releaseFailure;
  let signalFailure;
  const failureGate = new Promise((resolve) => { releaseFailure = resolve; });
  const failureStarted = new Promise((resolve) => { signalFailure = resolve; });
  const roomStore = {
    async load() { return snapshot; },
    async save(next) {
      writes += 1;
      snapshot = structuredClone(next);
      if (uncertain) {
        signalFailure();
        await failureGate;
        throw Object.assign(new Error('The write committed but confirmation was lost'), { code: 'STORE_UNCERTAIN' });
      }
    },
    async close() {},
  };
  const server = createJeopardyServer({ games: loadGames(), roomStore, logger: { error() {} } });
  const address = await server.start(0, '127.0.0.1');
  const url = `http://127.0.0.1:${address.port}`;
  const host = createClient(url, { transports: ['websocket'], reconnection: false });
  context.after(async () => { releaseFailure(); host.disconnect(); await server.stop(); });
  const { session } = await action(host, 'room:create');
  await action(host, 'host:join-contestants', { name: 'Jordan' });
  const playerId = server.rooms.rooms.get(session.code).host.playerId;
  uncertain = true;
  const failed = assert.rejects(action(host, 'host:adjust-score', { playerId, delta: 200 }));
  await failureStarted;
  const receivedSecond = once(server.io.sockets.sockets.get(host.id), 'host:adjust-score');
  const queued = assert.rejects(action(host, 'host:adjust-score', { playerId, delta: 400 }), { code: 'SERVER_RESTARTING' });
  await receivedSecond;
  const writesBeforeFailure = writes;
  releaseFailure();
  await Promise.all([failed, queued]);
  const health = await fetch(`${url}/health`);
  assert.equal(health.status, 503);
  assert.equal((await health.json()).ok, false);
  await assert.rejects(action(host, 'host:adjust-score', { playerId, delta: 800 }), { code: 'SERVER_RESTARTING' });
  assert.equal(writes, writesBeforeFailure);
  assert.equal(snapshot.rooms[0].players[0].score, 200);
});

test('Render cannot silently fall back to ephemeral file saves', () => {
  assert.throws(() => configuredRoomStore({ RENDER: 'true' }), /Set DATABASE_URL/);
  assert.equal(configuredRoomStore({ JEOPARDY_SAVE_PATH: '/tmp/jeoparty-test-unused.json' }).kind, 'file');
});

test('PostgreSQL restores saved games and rejects writes from an outdated server', {
  skip: !process.env.JEOPARDY_TEST_DATABASE_URL,
}, async (context) => {
  const first = postgresRoomStore(process.env.JEOPARDY_TEST_DATABASE_URL);
  const second = postgresRoomStore(process.env.JEOPARDY_TEST_DATABASE_URL);
  context.after(async () => { await first.close(); await second.close(); });
  await first.load();
  await second.load();
  const snapshot = { version: 1, savedAt: Date.now(), rooms: [] };
  await first.save(snapshot);
  await assert.rejects(second.save({ ...snapshot, savedAt: snapshot.savedAt + 1 }), /Another server changed/);
  assert.deepEqual(await second.load(), snapshot);
});

test('PostgreSQL startup retries a racing claim and fences the previous server', {
  skip: !process.env.JEOPARDY_TEST_DATABASE_URL,
  timeout: 10000,
}, async (context) => {
  const connectionString = process.env.JEOPARDY_TEST_DATABASE_URL;
  const initial = postgresRoomStore(connectionString);
  await initial.load();
  await initial.save({ version: 1, savedAt: Date.now(), rooms: [] });
  await initial.close();

  const games = loadGames();
  const servers = [];
  const sockets = [];
  let releaseClaim;
  let signalLoaded;
  const claimGate = new Promise((resolve) => { releaseClaim = resolve; });
  const loaded = new Promise((resolve) => { signalLoaded = resolve; });
  context.after(async () => {
    releaseClaim();
    sockets.forEach((socket) => socket.disconnect());
    for (const server of servers) await server.stop();
  });
  function client(address) {
    const socket = createClient(`http://127.0.0.1:${address.port}`, { transports: ['websocket'], reconnection: false });
    sockets.push(socket);
    return socket;
  }
  const first = createJeopardyServer({ games, roomStore: postgresRoomStore(connectionString), logger: { error() {} } });
  servers.push(first);
  const firstAddress = await first.start(0, '127.0.0.1');
  const oldHost = client(firstAddress);
  const { session } = await action(oldHost, 'room:create');
  await action(oldHost, 'host:join-contestants', { name: 'Jordan' });
  const playerId = first.rooms.rooms.get(session.code).host.playerId;
  await action(oldHost, 'host:adjust-score', { playerId, delta: 200 });

  const secondStore = postgresRoomStore(connectionString);
  let loads = 0;
  const second = createJeopardyServer({ games, logger: { error() {} }, roomStore: {
    async load() {
      const snapshot = await secondStore.load();
      loads += 1;
      if (loads === 1) {
        signalLoaded();
        await claimGate;
      }
      return snapshot;
    },
    save: (snapshot) => secondStore.save(snapshot),
    close: () => secondStore.close(),
  } });
  servers.push(second);
  const starting = second.start(0, '127.0.0.1');
  await loaded;
  assert.equal(second.httpServer.listening, false);
  await action(oldHost, 'host:adjust-score', { playerId, delta: 400 });
  releaseClaim();
  const secondAddress = await starting;
  assert.equal(loads, 2);
  const newHost = client(secondAddress);
  const resumed = await action(newHost, 'room:resume', session);
  assert.equal(resumed.state.you.score, 600);

  await assert.rejects(action(oldHost, 'host:adjust-score', { playerId, delta: 1000 }));
  const staleHealth = await fetch(`http://127.0.0.1:${firstAddress.port}/health`);
  assert.equal(staleHealth.status, 503);
  assert.equal((await staleHealth.json()).ok, false);
  await assert.rejects(action(oldHost, 'host:adjust-score', { playerId, delta: 2000 }), { code: 'SERVER_RESTARTING' });
  await action(newHost, 'host:adjust-score', { playerId, delta: 200 });
  const reader = postgresRoomStore(connectionString);
  try {
    const saved = await reader.load();
    assert.equal(saved.rooms[0].players[0].score, 800);
  } finally {
    await reader.close();
  }
  const currentHealth = await fetch(`http://127.0.0.1:${secondAddress.port}/health`);
  assert.equal(currentHealth.status, 200);
});
