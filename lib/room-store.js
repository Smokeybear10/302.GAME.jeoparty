'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');

function resultTokenHash(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token)
    ? crypto.createHash('sha256').update(token).digest('hex')
    : null;
}

function resultSummary(result) {
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const validText = (value, length) => typeof value === 'string' && value.trim().length > 0 && value.length <= length;
  if (!object(result) || typeof result.id !== 'string' || !/^g_[a-f0-9]{12}$/.test(result.id)
    || !validText(result.gameId, 64) || !validText(result.title, 80) || typeof result.custom !== 'boolean'
    || !['full', 'quick'].includes(result.gameMode)
    || !Number.isSafeInteger(result.completedAt) || result.completedAt < 0
    || !Number.isSafeInteger(result.revision) || result.revision < 1
    || !Array.isArray(result.players) || result.players.length > 8) {
    throw new Error('Invalid saved result.');
  }
  const playerIds = new Set();
  for (const player of result.players) {
    if (!object(player) || typeof player.id !== 'string' || !/^p_[a-f0-9]{12}$/.test(player.id)
      || playerIds.has(player.id) || !validText(player.name, 24) || !Number.isSafeInteger(player.score)) {
      throw new Error('Invalid saved result player.');
    }
    playerIds.add(player.id);
  }
  return {
    id: result.id,
    gameId: result.gameId,
    title: result.title,
    custom: result.custom,
    gameMode: result.gameMode,
    completedAt: result.completedAt,
    revision: result.revision,
    players: result.players.map(({ id, name, score }) => ({ id, name, score })),
  };
}

function completedResults(snapshot) {
  const results = new Map();
  for (const room of snapshot?.rooms ?? []) {
    for (const result of room.completedGames ?? []) {
      // Older snapshots receive result capabilities when the room manager restores them.
      if (!Object.hasOwn(result, 'resultToken')) continue;
      const tokenHash = resultTokenHash(result.resultToken);
      if (!tokenHash) throw new Error('Invalid saved result token.');
      mergeResult(results, { tokenHash, summary: resultSummary(result) });
    }
  }
  return results;
}

function mergeResult(results, record) {
  const existing = results.get(record.summary.id);
  if (existing && existing.tokenHash !== record.tokenHash) throw new Error('Saved result identity changed.');
  if (!existing || record.summary.revision > existing.summary.revision) results.set(record.summary.id, record);
}

function resultIndex(results) {
  const index = new Map();
  for (const record of results.values()) {
    if (index.has(record.tokenHash)) throw new Error('Duplicate saved result token.');
    index.set(record.tokenHash, record.summary);
  }
  return index;
}

function uncertainSave(error) {
  return Object.assign(new Error('Could not confirm the saved games. Restart the server to reload them.', { cause: error }), { code: 'STORE_UNCERTAIN' });
}

function fileRoomStore(filename) {
  let results = new Map();
  let resultsByToken = new Map();
  let loaded = false;
  return {
    kind: 'file',
    async load() {
      try {
        const snapshot = JSON.parse(await fs.readFile(filename, 'utf8'));
        const savedResults = new Map();
        if (snapshot && Object.hasOwn(snapshot, 'results')) {
          if (!Array.isArray(snapshot.results)) throw new Error('Invalid saved results.');
          for (const record of snapshot.results) {
            if (typeof record?.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.tokenHash)) {
              throw new Error('Invalid saved result token hash.');
            }
            mergeResult(savedResults, { tokenHash: record.tokenHash, summary: resultSummary(record.summary) });
          }
          delete snapshot.results;
        }
        for (const record of completedResults(snapshot).values()) mergeResult(savedResults, record);
        const index = resultIndex(savedResults);
        results = savedResults;
        resultsByToken = index;
        loaded = true;
        return snapshot;
      } catch (error) {
        if (error.code === 'ENOENT') {
          results = new Map();
          resultsByToken = new Map();
          loaded = true;
          return null;
        }
        throw new Error('Could not read saved games. The save file has been left untouched.', { cause: error });
      }
    },
    async save(snapshot) {
      if (!loaded) await this.load();
      const nextResults = new Map(results);
      for (const record of completedResults(snapshot).values()) mergeResult(nextResults, record);
      const nextIndex = resultIndex(nextResults);
      const data = JSON.stringify(nextResults.size ? { ...snapshot, results: [...nextResults.values()] } : snapshot);
      await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
      let renamed = false;
      try {
        const file = await fs.open(temporary, 'wx', 0o600);
        try {
          await file.writeFile(data);
          await file.sync();
        } finally {
          await file.close();
        }
        await fs.rename(temporary, filename);
        renamed = true;
        const directory = await fs.open(path.dirname(filename), 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
        results = nextResults;
        resultsByToken = nextIndex;
      } catch (error) {
        if (renamed) throw uncertainSave(error);
        throw error;
      } finally {
        if (!renamed) await fs.rm(temporary, { force: true });
      }
    },
    async readResult(token) {
      const tokenHash = resultTokenHash(token);
      if (!tokenHash) return null;
      if (!loaded) await this.load();
      const summary = resultsByToken.get(tokenHash);
      return summary ? { ...structuredClone(summary), resultToken: token } : null;
    },
    async close() {},
  };
}

function postgresRoomStore(connectionString) {
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 10000, query_timeout: 10000 });
  // Idle connection failures must not terminate the game process.
  pool.on('error', () => {});
  let revision;
  let loadedResults = new Map();
  return {
    kind: 'postgres',
    async load() {
      await pool.query(`CREATE TABLE IF NOT EXISTS jeoparty_saved_rooms (
        id integer PRIMARY KEY CHECK (id = 1),
        revision bigint NOT NULL DEFAULT 0,
        snapshot jsonb
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS jeoparty_completed_results (
        id text PRIMARY KEY,
        token_hash text NOT NULL UNIQUE,
        revision bigint NOT NULL CHECK (revision >= 1),
        summary jsonb NOT NULL
      )`);
      await pool.query('INSERT INTO jeoparty_saved_rooms (id) VALUES (1) ON CONFLICT DO NOTHING');
      const result = await pool.query('SELECT revision, snapshot FROM jeoparty_saved_rooms WHERE id = 1');
      loadedResults = completedResults(result.rows[0].snapshot);
      revision = result.rows[0].revision;
      return result.rows[0].snapshot;
    },
    async save(snapshot) {
      const data = JSON.stringify(snapshot);
      const results = new Map(loadedResults);
      for (const record of completedResults(snapshot).values()) mergeResult(results, record);
      const client = await pool.connect();
      let committing = false;
      try {
        await client.query('BEGIN');
        const result = await client.query(
          'UPDATE jeoparty_saved_rooms SET snapshot = $1, revision = revision + 1 WHERE id = 1 AND revision = $2 RETURNING revision',
          [data, revision],
        );
        if (result.rowCount !== 1) {
          throw Object.assign(new Error('Another server changed the saved games. Restart this instance before accepting more actions.'), { code: 'STORE_CONFLICT' });
        }
        if (results.size) {
          const saved = await client.query(
            'SELECT id, token_hash, revision FROM jeoparty_completed_results WHERE id = ANY($1::text[])',
            [[...results.keys()]],
          );
          for (const record of saved.rows) {
            const next = results.get(record.id);
            if (record.token_hash !== next.tokenHash) throw new Error('Saved result identity changed.');
            if (BigInt(record.revision) >= BigInt(next.summary.revision)) results.delete(record.id);
          }
          if (results.size) {
            const records = [...results.values()].map(({ tokenHash, summary }) => ({
              id: summary.id, token_hash: tokenHash, revision: summary.revision, summary,
            }));
            await client.query(`INSERT INTO jeoparty_completed_results (id, token_hash, revision, summary)
              SELECT id, token_hash, revision, summary
              FROM jsonb_to_recordset($1::jsonb) AS result(id text, token_hash text, revision bigint, summary jsonb)
              ON CONFLICT (id) DO UPDATE SET revision = EXCLUDED.revision, summary = EXCLUDED.summary
              WHERE jeoparty_completed_results.token_hash = EXCLUDED.token_hash
                AND jeoparty_completed_results.revision < EXCLUDED.revision`, [JSON.stringify(records)]);
          }
        }
        committing = true;
        await client.query('COMMIT');
        revision = result.rows[0].revision;
        loadedResults = new Map();
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          throw uncertainSave(error);
        }
        if (committing) throw uncertainSave(error);
        throw error;
      } finally {
        client.release();
      }
    },
    async readResult(token) {
      const tokenHash = resultTokenHash(token);
      if (!tokenHash) return null;
      const result = await pool.query('SELECT summary FROM jeoparty_completed_results WHERE token_hash = $1', [tokenHash]);
      return result.rows.length ? { ...resultSummary(result.rows[0].summary), resultToken: token } : null;
    },
    async close() {
      await pool.end();
    },
  };
}

function configuredRoomStore(env = process.env) {
  if (env.DATABASE_URL) return postgresRoomStore(env.DATABASE_URL);
  if (env.RENDER) {
    throw new Error('Set DATABASE_URL to enable saved games on Render. Its local filesystem does not survive restarts.');
  }
  return fileRoomStore(env.JEOPARDY_SAVE_PATH || path.join(__dirname, '..', 'data', 'rooms', 'saved-games.json'));
}

module.exports = { configuredRoomStore, fileRoomStore, postgresRoomStore };
