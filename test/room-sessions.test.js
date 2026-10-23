'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createStore } = require('../room-sessions');

const KEY = 'jeoparty_saved_rooms_v1';
const HOURS_12 = 12 * 60 * 60 * 1000;
const host = { code: 'ABCDE', token: 'a'.repeat(24), role: 'host', name: 'Maya', title: 'Opening Round', preferredGameId: 'opening-round', preferredGameMode: 'quick' };
const player = { code: 'ABCDE', token: 'b'.repeat(24), role: 'player', playerId: 'p_0123456789ab', name: 'Theo' };

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

test('a new tab can list saved credentials without automatically resuming a room', () => {
  const local = storage();
  createStore(local, () => 1000).save(host);
  const reopened = createStore(local, () => 2000);
  assert.deepEqual(reopened.list(), [{ ...host, savedAt: 1000 }]);
  assert.equal(reopened.persistent, true);
  assert.deepEqual(Object.keys(reopened).sort(), ['forget', 'forgetRoom', 'list', 'persistent', 'save']);
});

test('saving from separate tabs preserves multiple identities, even within one room', () => {
  const local = storage();
  let now = 1000;
  const first = createStore(local, () => now);
  const second = createStore(local, () => now);
  first.save(host);
  now = 2000;
  second.save(player);
  assert.deepEqual(first.list().map((session) => session.name), ['Theo', 'Maya']);
  assert.equal(createStore(local, () => 3000).list().length, 2);
});

test('handoff updates role and labels for the same credential without making another entry', () => {
  const local = storage();
  let now = 1000;
  const saved = createStore(local, () => now);
  saved.save(player);
  now = 2000;
  saved.save({ ...player, role: 'host', title: 'Next game' });
  assert.deepEqual(saved.list(), [{ ...player, role: 'host', title: 'Next game', savedAt: 2000 }]);
});

test('list does not refresh inactivity and expires credentials after twelve hours', () => {
  const local = storage();
  let now = 1000;
  const saved = createStore(local, () => now);
  saved.save(host);
  now = 1000 + HOURS_12 - 1;
  assert.equal(saved.list()[0].savedAt, 1000);
  now += 1;
  assert.deepEqual(saved.list(), []);
  assert.deepEqual(createStore(local, () => now).list(), []);
});

test('new activity refreshes expiry and only the latest twelve sessions are retained', () => {
  const local = storage();
  let now = 1000;
  const saved = createStore(local, () => now);
  for (let index = 0; index < 14; index += 1) {
    now += 1;
    saved.save({ ...host, token: index.toString(16).padStart(24, '0') });
  }
  assert.equal(saved.list().length, 12);
  assert.equal(saved.list()[0].token, 'd'.padStart(24, '0'));
  assert.equal(saved.list().at(-1).token, '2'.padStart(24, '0'));
  const oldest = saved.list().at(-1);
  now += 100;
  saved.save(oldest);
  assert.equal(saved.list()[0].token, oldest.token);
  assert.equal(saved.list()[0].savedAt, now);
});

test('forget removes the exact credential and other tabs do not resurrect it', () => {
  const local = storage();
  let now = 1000;
  const first = createStore(local, () => now);
  const second = createStore(local, () => now);
  first.save(host);
  now = 2000;
  second.save(player);
  first.list();
  second.forget(host);
  first.save({ ...host, code: 'FGHJK' });
  assert.deepEqual(first.list().map((session) => `${session.code}:${session.role}`).sort(), ['ABCDE:player', 'FGHJK:host']);
  second.forgetRoom('ABCDE');
  assert.deepEqual(first.list().map((session) => session.code), ['FGHJK']);
});

test('clear storage in another tab is respected rather than restored from memory', () => {
  const local = storage();
  const saved = createStore(local, () => 1000);
  saved.save(host);
  local.removeItem(KEY);
  assert.deepEqual(saved.list(), []);
});

test('blocked storage keeps this page usable and reports that credentials are not persistent', () => {
  const blocked = { getItem() { throw new Error('Blocked'); }, setItem() { throw new Error('Blocked'); } };
  const saved = createStore(blocked, () => 1000);
  assert.equal(saved.persistent, false);
  assert.deepEqual(saved.list(), []);
  saved.save(host);
  saved.save(player);
  assert.equal(saved.list().length, 2);
  saved.forget(host);
  assert.deepEqual(saved.list().map((session) => session.role), ['player']);
  saved.forgetRoom('ABCDE');
  assert.deepEqual(saved.list(), []);
  const absent = createStore(undefined, () => 1000);
  absent.save(host);
  assert.equal(absent.list().length, 1);
  assert.equal(absent.persistent, false);
});

test('quota failures preserve pending saves and deletions until storage is writable again', () => {
  const local = storage();
  let now = 1000;
  const saved = createStore(local, () => now);
  saved.save(host);
  const write = local.setItem;
  local.setItem = () => { throw new Error('Full'); };
  saved.forget(host);
  assert.deepEqual(saved.list(), []);
  now += 1;
  saved.save(player);
  assert.equal(saved.persistent, false);
  assert.deepEqual(saved.list().map((session) => session.role), ['player']);
  local.setItem = write;
  now += 1;
  saved.save(player);
  assert.equal(saved.persistent, true);
  assert.deepEqual(createStore(local, () => now).list().map((session) => session.role), ['player']);
});

test('a failed room deletion followed by a new session does not restore old room credentials', () => {
  const local = storage();
  const saved = createStore(local, () => 1000);
  saved.save(host);
  const write = local.setItem;
  local.setItem = () => { throw new Error('Full'); };
  saved.forgetRoom(host.code);
  saved.save(player);
  assert.deepEqual(saved.list().map((session) => session.role), ['player']);
  local.setItem = write;
  saved.save(player);
  assert.deepEqual(createStore(local, () => 2000).list().map((session) => session.role), ['player']);
});

test('malformed roots and invalid credentials are ignored without affecting startup', () => {
  const local = storage();
  for (const raw of ['{broken', 'false', '0', '[]', '{"version":2,"sessions":[]}', '{"version":1,"sessions":{}}']) {
    local.setItem(KEY, raw);
    const saved = createStore(local, () => 1000);
    assert.deepEqual(saved.list(), []);
    assert.equal(saved.persistent, true);
    saved.save(host);
    assert.equal(saved.list().length, 1);
  }
  const bad = [
    null, [], {}, { ...host, role: 'spectator' }, { ...host, token: 'short' },
    { ...host, token: ['a'.repeat(24)] }, { ...host, code: 'abcde' }, { ...host, code: 'ABI0L' },
    { ...player, playerId: '__proto__' }, { ...host, savedAt: -1 },
    { ...host, savedAt: 1001 }, { ...host, savedAt: '1000' },
  ];
  local.setItem(KEY, JSON.stringify({ version: 1, sessions: bad.map((value) => value && { savedAt: 1000, ...value }) }));
  assert.deepEqual(createStore(local, () => 1000).list(), []);
});

test('stored labels are bounded and private answers or unknown fields are not copied', () => {
  const local = storage();
  const saved = createStore(local, () => 1000);
  saved.save({
    ...host, name: '  Maya\n  Chen\u0000 ', title: 'x'.repeat(300),
    preferredGameId: ' y '.repeat(100), response: 'A private Final response', password: 'do not store',
    final: { wager: 500 }, privateAnswer: 'A secret clue answer', preferredGameMode: 'unknown',
  });
  const record = saved.list()[0];
  assert.equal(record.name, 'Maya Chen');
  assert.equal(record.title.length, 200);
  assert.ok(record.preferredGameId.length <= 200);
  assert.equal(record.preferredGameMode, undefined);
  assert.doesNotMatch(local.getItem(KEY), /response|password|wager|privateAnswer|secret/);
  record.token = 'changed';
  assert.equal(saved.list()[0].token, host.token);
});

test('the saved-session API loads as a standalone browser script', () => {
  const source = readFileSync(path.join(__dirname, '..', 'room-sessions.js'), 'utf8');
  const context = vm.createContext({});
  new vm.Script(source).runInContext(context);
  assert.equal(vm.runInContext('typeof RoomSessions.createStore', context), 'function');
});
