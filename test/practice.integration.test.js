'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadGames } = require('../lib/game-store');
const { createJeopardyServer } = require('../server');

test('practice has a separate page and assets without creating a multiplayer room', async (context) => {
  const server = createJeopardyServer({ games: loadGames(), logger: { error() {} } });
  const address = await server.start(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${address.port}`;
  context.after(() => server.stop());

  const page = await fetch(`${origin}/practice`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<title>Trivia practice<\/title>/);
  assert.doesNotMatch(html, /socket\.io/);
  assert.equal((await fetch(`${origin}/practice/`)).status, 200);
  for (const asset of ['practice.css', 'practice-data.js', 'practice-state.js', 'practice.js']) {
    const response = await fetch(`${origin}/${asset}`);
    assert.equal(response.status, 200, asset);
    assert.ok((await response.text()).length > 0, asset);
  }
  const lobby = await fetch(origin).then((response) => response.text());
  assert.match(lobby, /href="\/practice"/);
  const health = await fetch(`${origin}/health`).then((response) => response.json());
  assert.equal(health.rooms, 0);
  assert.equal((await fetch(`${origin}/practice-state.test.js`)).status, 404);
});
