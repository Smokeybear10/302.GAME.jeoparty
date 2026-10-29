'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Pool } = require('pg');
const { loadGames } = require('../lib/game-store');
const { RoomManager } = require('../lib/room-manager');
const { fileRoomStore, postgresRoomStore } = require('../lib/room-store');

function completedResult(overrides = {}) {
  return {
    id: `g_${crypto.randomBytes(6).toString('hex')}`,
    resultToken: crypto.randomBytes(32).toString('base64url'),
    gameId: 'saved-board', title: 'Saved board', custom: false, gameMode: 'full',
    completedAt: 1000, revision: 1,
    players: [{ id: 'p_012345abcdef', name: 'Maya', score: 600 }],
    ...overrides,
  };
}

function snapshot(results = []) {
  return { version: 1, savedAt: 1001, rooms: results.length ? [{ completedGames: results }] : [] };
}

async function storageFixture(context, backend) {
  const stores = [];
  if (backend === 'file') {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jeoparty-results-'));
    const filename = path.join(directory, 'rooms.json');
    context.after(() => fs.rm(directory, { recursive: true, force: true }));
    return { filename, create: () => fileRoomStore(filename) };
  }
  const schema = `result_test_${crypto.randomBytes(10).toString('hex')}`;
  const admin = new Pool({ connectionString: process.env.JEOPARDY_TEST_DATABASE_URL });
  const connection = new URL(process.env.JEOPARDY_TEST_DATABASE_URL);
  connection.searchParams.set('options', `-csearch_path=${schema}`);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = new Pool({ connectionString: connection.toString() });
  context.after(async () => {
    await Promise.all(stores.map((store) => store.close()));
    await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  return {
    db,
    create() {
      const store = postgresRoomStore(connection.toString());
      stores.push(store);
      return store;
    },
  };
}

for (const backend of ['file', 'postgres']) {
  const options = { skip: backend === 'postgres' && !process.env.JEOPARDY_TEST_DATABASE_URL };

  for (const removal of ['closure', 'expiry', 'startup expiry']) {
    test(`${backend} results survive room ${removal} and another restart`, options, async (context) => {
      const f = await storageFixture(context, backend);
      const store = f.create();
      await store.load();
      const games = loadGames();
      let now = 1000;
      let manager = new RoomManager({ games, now: () => now++ });
      const host = manager.createRoom('host');
      const player = manager.joinRoom('player', { code: host.code, name: 'Maya' });
      manager.startGame('host', games[0].id);
      manager.adjustScore('host', { playerId: player.playerId, delta: 600 });
      manager.startFinal('host');
      manager.submitFinalWager('player', 200);
      manager.advanceFinal('host');
      manager.submitFinalResponse('player', 'Private Final response');
      manager.advanceFinal('host');
      manager.selfScoreFinal('player', { correct: true });
      manager.finishFinal('host');
      const result = manager.stateFor('host', []).completedGames[0];
      await store.save(manager.exportSnapshot());
      assert.deepEqual(await store.readResult(result.resultToken), result);

      if (removal === 'closure') {
        manager.closeRoom('host');
      } else {
        manager.disconnect('host');
        manager.disconnect('player');
        await store.save(manager.exportSnapshot());
        now += 13 * 60 * 60 * 1000;
        if (removal === 'expiry') manager.cleanup();
        else {
          manager = new RoomManager({ games, now: () => now++ });
          manager.restoreSnapshot(await store.load());
        }
      }
      assert.equal(manager.rooms.size, 0);
      await store.save(manager.exportSnapshot());
      const restarted = f.create();
      assert.deepEqual((await restarted.load()).rooms, []);
      assert.deepEqual(await restarted.readResult(result.resultToken), result);
      await restarted.save(manager.exportSnapshot());
      const secondRestart = f.create();
      await secondRestart.load();
      assert.deepEqual(await secondRestart.readResult(result.resultToken), result);
    });
  }

  test(`${backend} results are private capabilities with only whitelisted fields`, options, async (context) => {
    const f = await storageFixture(context, backend);
    const store = f.create();
    await store.load();
    const expected = completedResult();
    const privateFields = {
      participantTokens: ['private-participant-token'], host: { token: 'private-host-token' },
      roomCode: 'ABCDE', answer: 'Private answer', response: 'Private response', wager: 500,
    };
    const result = {
      ...expected, ...privateFields,
      players: expected.players.map((player) => ({ ...player, token: 'private-player-token', socketId: 'private-socket' })),
    };
    await store.save(snapshot([result]));
    assert.deepEqual(await store.readResult(expected.resultToken), expected);
    const returned = await store.readResult(expected.resultToken);
    returned.players[0].score = 99999;
    assert.deepEqual(await store.readResult(expected.resultToken), expected);
    for (const token of [null, 42, {}, [], '', 'x'.repeat(42), 'x'.repeat(44), '/'.repeat(43), expected.id, crypto.randomBytes(32).toString('base64url')]) {
      assert.equal(await store.readResult(token), null);
    }
    const records = backend === 'file'
      ? JSON.parse(await fs.readFile(f.filename, 'utf8')).results
      : (await f.db.query('SELECT * FROM jeoparty_completed_results')).rows;
    const serialized = JSON.stringify(records);
    for (const secret of [expected.resultToken, ...Object.keys(privateFields), 'private-player-token', 'private-socket', 'socketId', 'resultToken']) {
      assert.equal(serialized.includes(secret), false, `Result records leaked ${secret}`);
    }
    assert.ok(serialized.includes(crypto.createHash('sha256').update(expected.resultToken).digest('hex')));
  });

  test(`${backend} keeps the newest result revision after room history drops it`, options, async (context) => {
    const f = await storageFixture(context, backend);
    const store = f.create();
    await store.load();
    const first = completedResult();
    const corrected = { ...first, revision: 2, players: [{ ...first.players[0], score: 800 }] };
    await store.save(snapshot([first]));
    await store.save(snapshot([corrected]));
    await store.save(snapshot([first]));
    assert.deepEqual(await store.readResult(first.resultToken), corrected);
    await store.save(snapshot([completedResult()]));
    const restarted = f.create();
    await restarted.load();
    assert.deepEqual(await restarted.readResult(first.resultToken), corrected);
  });

  test(`${backend} preserves results from an existing snapshot before room expiry removes them`, options, async (context) => {
    const f = await storageFixture(context, backend);
    const result = completedResult();
    if (backend === 'file') await fs.writeFile(f.filename, JSON.stringify(snapshot([result])));
    else {
      await f.create().load();
      await f.db.query('UPDATE jeoparty_saved_rooms SET snapshot = $1, revision = revision + 1', [JSON.stringify(snapshot([result]))]);
    }
    const store = f.create();
    await store.load();
    await store.save(snapshot());
    const restarted = f.create();
    assert.deepEqual((await restarted.load()).rooms, []);
    assert.deepEqual(await restarted.readResult(result.resultToken), result);
  });

  test(`${backend} rejects changed result capabilities without saving rooms or results`, options, async (context) => {
    const f = await storageFixture(context, backend);
    const store = f.create();
    await store.load();
    const result = completedResult();
    const before = snapshot([result]);
    await store.save(before);
    const changed = { ...result, revision: 2, resultToken: crypto.randomBytes(32).toString('base64url') };
    await assert.rejects(store.save(snapshot([changed])), /identity changed/);
    assert.equal(await store.readResult(changed.resultToken), null);
    assert.deepEqual(await store.readResult(result.resultToken), result);
    const reader = f.create();
    assert.deepEqual(await reader.load(), before);
    await store.save(snapshot());
    assert.deepEqual(await store.readResult(result.resultToken), result);
  });
}

test('file result storage keeps legacy snapshots unchanged and lazy saves preserve results', async (context) => {
  const f = await storageFixture(context, 'file');
  const legacy = snapshot();
  await fs.writeFile(f.filename, JSON.stringify(legacy));
  assert.deepEqual(await f.create().load(), legacy);
  const result = completedResult();
  await f.create().save(snapshot([result]));
  await f.create().save(legacy);
  const reader = f.create();
  assert.deepEqual(await reader.load(), legacy);
  assert.deepEqual(await reader.readResult(result.resultToken), result);
});

test('a failed file rename changes neither room snapshot nor the result index', async (context) => {
  const f = await storageFixture(context, 'file');
  const store = f.create();
  const result = completedResult();
  const before = snapshot([result]);
  await store.save(before);
  const rename = context.mock.method(fs, 'rename', async () => { throw new Error('Disk unavailable'); });
  const next = completedResult();
  await assert.rejects(store.save(snapshot([{ ...result, revision: 2 }, next])), /Disk unavailable/);
  rename.mock.restore();
  assert.deepEqual(await store.readResult(result.resultToken), result);
  assert.equal(await store.readResult(next.resultToken), null);
  assert.deepEqual(await f.create().load(), before);
  assert.deepEqual(await fs.readdir(path.dirname(f.filename)), ['rooms.json']);
});

test('an uncertain file save does not expose new results until a restart confirms the file', async (context) => {
  const f = await storageFixture(context, 'file');
  const store = f.create();
  await store.save(snapshot());
  const open = fs.open;
  const failingOpen = context.mock.method(fs, 'open', async (...args) => {
    const file = await open(...args);
    return args[0] === path.dirname(f.filename) && args[1] === 'r'
      ? { async sync() { throw new Error('Directory sync unavailable'); }, close: () => file.close() }
      : file;
  });
  const result = completedResult();
  await assert.rejects(store.save(snapshot([result])), { code: 'STORE_UNCERTAIN' });
  failingOpen.mock.restore();
  assert.equal(await store.readResult(result.resultToken), null);
  const restarted = f.create();
  await restarted.load();
  assert.deepEqual(await restarted.readResult(result.resultToken), result);
});

test('PostgreSQL rolls back both a room write and result upserts and retains its prior revision', {
  skip: !process.env.JEOPARDY_TEST_DATABASE_URL,
}, async (context) => {
  const f = await storageFixture(context, 'postgres');
  const store = f.create();
  await store.load();
  const result = completedResult();
  const before = snapshot([result]);
  await store.save(before);
  const beforeRevision = (await f.db.query('SELECT revision FROM jeoparty_saved_rooms')).rows[0].revision;
  await f.db.query(`CREATE FUNCTION reject_result_save() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.summary->>'title' = 'Reject write' THEN RAISE EXCEPTION 'Result write rejected'; END IF;
      RETURN NEW;
    END;
  $$`);
  await f.db.query(`CREATE TRIGGER reject_result BEFORE INSERT OR UPDATE ON jeoparty_completed_results
    FOR EACH ROW EXECUTE FUNCTION reject_result_save()`);
  const next = completedResult({ title: 'Reject write' });
  await assert.rejects(store.save(snapshot([{ ...result, revision: 2 }, next])), /Result write rejected/);
  assert.deepEqual(await store.readResult(result.resultToken), result);
  assert.equal(await store.readResult(next.resultToken), null);
  const saved = (await f.db.query('SELECT revision, snapshot FROM jeoparty_saved_rooms')).rows[0];
  assert.equal(saved.revision, beforeRevision);
  assert.deepEqual(saved.snapshot, before);
  await store.save(snapshot([{ ...result, revision: 2 }]));
  assert.equal((await store.readResult(result.resultToken)).revision, 2);
});

test('PostgreSQL rejects stale room writers without publishing their completed results', {
  skip: !process.env.JEOPARDY_TEST_DATABASE_URL,
}, async (context) => {
  const f = await storageFixture(context, 'postgres');
  const first = f.create();
  const second = f.create();
  await first.load();
  await second.load();
  const accepted = completedResult();
  const rejected = completedResult();
  await first.save(snapshot([accepted]));
  await assert.rejects(second.save(snapshot([rejected])), { code: 'STORE_CONFLICT' });
  assert.deepEqual(await second.readResult(accepted.resultToken), accepted);
  assert.equal(await first.readResult(rejected.resultToken), null);
});

test('PostgreSQL fences an unconfirmed commit without advancing the in-memory revision', {
  skip: !process.env.JEOPARDY_TEST_DATABASE_URL,
}, async (context) => {
  const f = await storageFixture(context, 'postgres');
  const store = f.create();
  await store.load();
  const connect = Pool.prototype.connect;
  const failingConnect = context.mock.method(Pool.prototype, 'connect', function (callback) {
    if (callback) return connect.call(this, callback);
    return connect.call(this).then((client) => {
      const query = client.query;
      client.query = async function (sql, ...args) {
        const result = await query.call(this, sql, ...args);
        if (sql === 'COMMIT') {
          client.query = query;
          throw new Error('Commit confirmation lost');
        }
        return result;
      };
      return client;
    });
  });
  const result = completedResult();
  await assert.rejects(store.save(snapshot([result])), { code: 'STORE_UNCERTAIN' });
  failingConnect.mock.restore();
  await assert.rejects(store.save(snapshot()), { code: 'STORE_CONFLICT' });
  const restarted = f.create();
  assert.deepEqual(await restarted.load(), snapshot([result]));
  assert.deepEqual(await restarted.readResult(result.resultToken), result);
});
