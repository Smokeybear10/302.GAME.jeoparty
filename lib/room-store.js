'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');

function fileRoomStore(filename) {
  return {
    kind: 'file',
    async load() {
      try {
        return JSON.parse(await fs.readFile(filename, 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw new Error('Could not read saved games. The save file has been left untouched.', { cause: error });
      }
    },
    async save(snapshot) {
      const data = JSON.stringify(snapshot);
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
      } catch (error) {
        if (renamed) {
          throw Object.assign(new Error('Could not confirm the saved games. Restart the server to reload them.', { cause: error }), { code: 'STORE_UNCERTAIN' });
        }
        throw error;
      } finally {
        if (!renamed) await fs.rm(temporary, { force: true });
      }
    },
    async close() {},
  };
}

function postgresRoomStore(connectionString) {
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 10000, query_timeout: 10000 });
  // Idle connection failures must not terminate the game process.
  pool.on('error', () => {});
  let revision;
  return {
    kind: 'postgres',
    async load() {
      await pool.query(`CREATE TABLE IF NOT EXISTS jeoparty_saved_rooms (
        id integer PRIMARY KEY CHECK (id = 1),
        revision bigint NOT NULL DEFAULT 0,
        snapshot jsonb
      )`);
      await pool.query('INSERT INTO jeoparty_saved_rooms (id) VALUES (1) ON CONFLICT DO NOTHING');
      const result = await pool.query('SELECT revision, snapshot FROM jeoparty_saved_rooms WHERE id = 1');
      revision = result.rows[0].revision;
      return result.rows[0].snapshot;
    },
    async save(snapshot) {
      const data = JSON.stringify(snapshot);
      let result;
      try {
        result = await pool.query(
          'UPDATE jeoparty_saved_rooms SET snapshot = $1, revision = revision + 1 WHERE id = 1 AND revision = $2 RETURNING revision',
          [data, revision],
        );
      } catch (error) {
        throw Object.assign(new Error('Could not confirm the saved games. Restart the server to reload them.', { cause: error }), { code: 'STORE_UNCERTAIN' });
      }
      if (result.rowCount !== 1) {
        throw Object.assign(new Error('Another server changed the saved games. Restart this instance before accepting more actions.'), { code: 'STORE_CONFLICT' });
      }
      revision = result.rows[0].revision;
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
