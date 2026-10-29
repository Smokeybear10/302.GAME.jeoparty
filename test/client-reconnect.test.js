'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { loadGames } = require('../lib/game-store');
const { RoomManager } = require('../lib/room-manager');

const clientScript = new vm.Script(readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8'));
const games = loadGames();
const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

function element() {
  const listeners = new Map();
  const classes = new Set();
  return {
    innerHTML: '', textContent: '', value: '', hidden: false, disabled: false, inert: false,
    dataset: {},
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) || []), listener]);
    },
    dispatch(type, event) {
      for (const listener of listeners.get(type) || []) listener(event);
    },
    classList: {
      add: (...tokens) => tokens.forEach((token) => classes.add(token)),
      remove: (...tokens) => tokens.forEach((token) => classes.delete(token)),
      contains: (token) => classes.has(token),
      toggle(token, enabled = !classes.has(token)) {
        if (enabled) classes.add(token);
        else classes.delete(token);
      },
    },
    querySelector: () => null, querySelectorAll: () => [], contains: () => false,
    focus() {},
  };
}

function storage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

function startClient() {
  const nodes = new Map();
  const listeners = new Map();
  const requests = [];
  const timers = new Map();
  let timerId = 0;
  let now = 0;
  const node = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, element());
    return nodes.get(selector);
  };
  const socket = {
    on: (event, listener) => listeners.set(event, listener),
    connect: () => listeners.get('connect')(),
    timeout: () => ({ emit: (event, payload, acknowledge) => requests.push({ event, payload, acknowledge }) }),
  };
  const document = { ...element(), body: node('body'), querySelector: node, activeElement: null };
  const localStore = storage();
  const context = vm.createContext({
    document,
    window: {
      ...element(),
      location: { origin: 'http://localhost:3000', hostname: 'localhost', search: '' },
      scrollTo() {}, confirm: () => true,
      setTimeout(callback, delay) {
        const id = ++timerId;
        timers.set(id, { callback, time: now + delay });
        return id;
      },
      clearTimeout: (id) => timers.delete(id),
    },
    io: () => socket,
    RoomSessions: require('../room-sessions'),
    localStorage: localStore, sessionStorage: storage(),
    URLSearchParams, AbortSignal, CSS: { escape: (value) => value },
    fetch: () => new Promise(() => {}),
  });
  clientScript.runInContext(context);
  const evaluate = (source) => vm.runInContext(source, context);
  evaluate('showToast = () => {};');
  const manager = new RoomManager({ games });
  const host = manager.createRoom('host');
  const session = manager.joinRoom('player', { code: host.code, name: 'Alex' });
  manager.startGame('host', games[0].id);
  manager.openClue('host', { categoryIndex: 0, clueIndex: 1 });
  const state = manager.stateFor('player', []);
  evaluate(`saveSession(${JSON.stringify(session)});`);
  listeners.get('room:state')(state);
  return {
    node, document, evaluate, requests, timers, session, state, manager, localStore,
    emit: (event, payload) => listeners.get(event)(payload),
    reconnect() {
      listeners.get('disconnect')();
      listeners.get('connect')();
    },
    retry() {
      node('#connection-label').dispatch('click', {
        target: { closest: () => ({ disabled: false, dataset: { retryRoom: '' } }) },
      });
    },
    async advance(milliseconds) {
      now += milliseconds;
      for (const [id, timer] of [...timers]) {
        if (timer.time > now) continue;
        timers.delete(id);
        timer.callback();
      }
      await flushAsync();
    },
    async fail(request = requests.at(-1), code = 'REQUEST_TIMEOUT') {
      if (code === 'REQUEST_TIMEOUT') request.acknowledge(new Error('timeout'));
      else request.acknowledge(null, { ok: false, error: { code, message: 'Restore failed' } });
      await flushAsync();
    },
    async succeed(request = requests.at(-1), response = { session, state }) {
      request.acknowledge(null, { ok: true, ...response });
      await flushAsync();
    },
  };
}

test('a resume timeout keeps the board, saved seat, and controls paused until an automatic retry restores them', async () => {
  const client = startClient();
  const board = client.node('#room-content').innerHTML;
  client.evaluate(`rememberCompletedGames({ completedGames: [{
    id: 'g_123456789abc', gameId: 'game-01', title: 'Saved game', custom: false,
    completedAt: 1700000000000, revision: 1,
    players: [{ id: 'p_123456789abc', name: 'Alex', score: 1200 }],
  }] });`);
  const history = client.localStore.getItem('jeoparty_game_history_v1');
  client.reconnect();
  await client.fail();

  assert.equal(client.node('#room-content').innerHTML, board);
  assert.equal(client.evaluate('savedSession().token'), client.session.token);
  assert.equal(client.localStore.getItem('jeoparty_game_history_v1'), history);
  assert.equal(client.node('#room-content').inert, true);
  assert.equal(client.evaluate('canBuzzWithKeyboard({ repeat: false })'), false);
  await assert.rejects(client.evaluate("request('player:buzz')"), /Restoring/);
  assert.equal(client.requests.length, 1);
  assert.match(client.node('#connection-label').innerHTML, /Restoring|Retrying/);
  assert.match(client.node('#connection-label').innerHTML, /data-retry-room/);

  await client.advance(1000);
  assert.equal(client.requests.length, 2);
  assert.equal(client.requests[1].event, 'room:resume');
  await client.succeed();
  assert.equal(client.node('#room-content').inert, false);
  assert.equal(client.evaluate('resuming'), false);
  assert.equal(client.node('#connection-label').textContent, '');
});

test('automatic restoration is bounded and Retry works while the stale room is still visible', async () => {
  const client = startClient();
  client.reconnect();
  for (const delay of [1000, 3000, 7000]) {
    await client.fail();
    await client.advance(delay);
  }
  await client.fail();
  assert.equal(client.requests.length, 4);
  assert.equal(client.timers.size, 0);
  assert.equal(client.evaluate('roomState.code'), client.session.code);
  assert.equal(client.node('#room-content').inert, true);
  assert.match(client.node('#connection-label').innerHTML, /Retry/);
  client.retry();
  client.retry();
  assert.equal(client.requests.length, 5);
  await client.succeed();
  assert.equal(client.node('#room-content').inert, false);
  assert.equal(client.evaluate('savedSession().token'), client.session.token);
});

test('manual Retry replaces the scheduled retry without duplicate attempts', async () => {
  const client = startClient();
  client.reconnect();
  await client.fail();
  client.retry();
  assert.equal(client.requests.length, 2);
  await client.advance(60000);
  assert.equal(client.requests.length, 2);
  await client.succeed();
  assert.equal(client.node('#room-content').inert, false);
});

test('the active clue focus trap releases Tab so the restoration Retry control stays reachable', async () => {
  const client = startClient();
  client.reconnect();
  await client.fail();
  client.node('#room-content').querySelector = () => ({ querySelectorAll: () => [] });
  let prevented = false;
  client.document.dispatch('keydown', { key: 'Tab', preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false);
});

test('disconnect invalidates pending responses and immediately starts a fresh restore after reconnecting', async () => {
  const client = startClient();
  client.reconnect();
  const interrupted = client.requests[0];
  client.emit('disconnect');
  await client.succeed(interrupted, { session: client.session, state: { ...client.state, code: 'WRONG' } });
  assert.equal(client.evaluate('roomState.code'), client.session.code);
  assert.equal(client.node('#room-content').inert, true);
  client.emit('connect');
  assert.equal(client.requests.length, 2);
  await client.succeed();
  assert.equal(client.node('#room-content').inert, false);
});

test('disconnect cancels the retry timer without losing the saved seat', async () => {
  const client = startClient();
  client.reconnect();
  await client.fail();
  client.emit('disconnect');
  await client.advance(60000);
  assert.equal(client.requests.length, 1);
  assert.equal(client.timers.size, 0);
  assert.equal(client.evaluate('savedSession().token'), client.session.token);
  client.emit('connect');
  assert.equal(client.requests.length, 2);
});

test('a replaced seat cannot be retaken by a late acknowledgment, queued retry, or reconnect', async () => {
  for (const timeoutFirst of [false, true]) {
    const client = startClient();
    client.reconnect();
    const interrupted = client.requests[0];
    if (timeoutFirst) await client.fail();
    client.emit('room:replaced', { message: 'Resumed elsewhere.' });
    if (!timeoutFirst) await client.succeed(interrupted);
    await client.advance(60000);
    client.emit('connect');
    assert.equal(client.requests.length, 1);
    assert.equal(client.evaluate('roomState'), null);
    assert.equal(client.evaluate('savedSession().token'), client.session.token);
    assert.match(client.node('#connection-label').textContent, /another tab/);
  }
});

test('definitive invalid credentials remove only that seat and stop restoration', async () => {
  for (const code of ['ROOM_NOT_FOUND', 'SESSION_EXPIRED']) {
    const client = startClient();
    const other = client.manager.createRoom('other');
    client.evaluate(`roomSessions.save(${JSON.stringify(other)});`);
    client.reconnect();
    await client.fail(undefined, code);
    await client.advance(60000);
    assert.equal(client.requests.length, 1);
    assert.equal(client.evaluate('roomState'), null);
    assert.equal(client.evaluate('savedSession()'), null);
    assert.equal(client.evaluate('roomSessions.list().length'), 1);
    assert.equal(client.evaluate('roomSessions.list()[0].token'), other.token);
    assert.equal(client.node('#create-room-button').disabled, false);
  }
});

test('a newer session cannot be overwritten or forgotten by an old restoration response', async () => {
  for (const outcome of ['success', 'SESSION_EXPIRED']) {
    const client = startClient();
    client.reconnect();
    const pending = client.requests[0];
    const session = client.manager.createRoom('other');
    const state = client.manager.stateFor('other', []);
    client.emit('room:session', { session, state, message: 'Hosting changed.' });
    if (outcome === 'success') await client.succeed(pending);
    else await client.fail(pending, outcome);
    assert.equal(client.evaluate('roomState.code'), session.code);
    assert.equal(client.evaluate('savedSession().token'), session.token);
    assert.equal(client.evaluate('resuming'), false);
  }
});

test('room closure and removal cancel restoration and ignore late responses', async () => {
  for (const event of ['room:closed', 'room:removed']) {
    const client = startClient();
    client.reconnect();
    client.emit(event, { message: 'Room ended.' });
    await client.succeed(client.requests[0]);
    client.emit('room:state', client.state);
    await client.advance(60000);
    assert.equal(client.evaluate('roomState'), null);
    assert.equal(client.evaluate('savedSession()'), null);
    assert.equal(client.requests.length, 1);
  }
});

test('leaving a restored room prevents a delayed state update from bringing it back', async () => {
  const client = startClient();
  client.reconnect();
  await client.succeed();
  const leaving = client.evaluate('leaveRoom()');
  assert.equal(client.requests.at(-1).event, 'room:leave');
  client.requests.at(-1).acknowledge(null, { ok: true });
  await leaving;
  client.emit('room:state', client.state);
  assert.equal(client.evaluate('roomState'), null);
  assert.equal(client.evaluate('savedSession()'), null);
  assert.equal(client.timers.size, 0);
});
