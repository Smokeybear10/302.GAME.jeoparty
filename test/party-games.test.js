'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { catalogPartyGames, loadPartyGames, loadPartyPool, randomPartyGame, validatePartyGame } = require('../lib/party-games');
const { loadGames } = require('../lib/game-store');
const { createJeopardyServer } = require('../server');

test('all twelve migrated themes retain their complete five-by-five boards', () => {
  const games = loadPartyGames();
  assert.deepEqual(games.map((game) => game.id), [
    'business', 'food', 'geography', 'history', 'literature', 'movies', 'music',
    'pop-culture', 'random-mix', 'science', 'sports', 'tv',
  ]);
  for (const game of games) {
    assert.deepEqual(validatePartyGame(game), []);
    assert.equal(game.categories.length, 5);
    for (const category of game.categories) assert.equal(category.clues.length, 5);
  }
  const catalog = catalogPartyGames(games);
  assert.equal(catalog[0].clueCount, 25);
  assert.equal(JSON.stringify(catalog).includes('answer'), false);
  assert.equal(JSON.stringify(catalog).includes('prompt'), false);
});

test('shared random seeds reproduce a complete board without mutating the pool', () => {
  const pool = loadPartyPool();
  const original = JSON.stringify(pool);
  const first = randomPartyGame(pool, 'party-night');
  assert.deepEqual(first, randomPartyGame(pool, 'party-night'));
  assert.notDeepEqual(first.categories, randomPartyGame(pool, 'another-night').categories);
  assert.deepEqual(validatePartyGame(first), []);
  assert.equal(first.categories.length, 7);
  assert.equal(new Set(first.categories.map((category) => category.name.toLowerCase())).size, 7);
  for (const category of first.categories) {
    assert.equal(category.clues.length, 7);
    assert.equal(new Set(category.clues.map((clue) => clue.prompt.toLowerCase())).size, 7);
    assert.deepEqual(category.clues.map((clue) => clue.value), [200, 400, 600, 800, 1000, 1200, 1400]);
  }
  assert.match(first.poolVersion, /^[a-f0-9]{12}$/);
  assert.match(randomPartyGame(pool).seed, /^[a-f0-9]{16}$/);
  assert.equal(JSON.stringify(pool), original);
  for (const seed of ['', 'a'.repeat(65), '../game', [], null]) {
    assert.throws(() => randomPartyGame(pool, seed), /Seed must/);
  }
});

test('pool loading merges case-insensitive duplicate categories without dropping unique clues', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jeoparty-party-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filepath = path.join(directory, 'pool.json');
  const source = Array.from({ length: 7 }, (_, index) => ({
    name: `Category ${index}`,
    clues: Array.from({ length: 7 }, (_, clue) => ({ prompt: `Question ${index}:${clue}`, answer: `Answer ${index}:${clue}` })),
  }));
  source.push({ name: 'CATEGORY 0', clues: [...source[0].clues.slice(0, 6), { prompt: 'Extra question', answer: 'Extra answer' }] });
  fs.writeFileSync(filepath, JSON.stringify(source));
  const pool = loadPartyPool(filepath);
  assert.equal(pool.categories.length, 7);
  assert.equal(pool.categories[0].clues.length, 8);
  assert.ok(pool.categories[0].clues.some((clue) => clue.prompt === 'Extra question'));
  source[0].clues[0].prompt = '';
  fs.writeFileSync(filepath, JSON.stringify(source));
  assert.throws(() => loadPartyPool(filepath), /Invalid party clue/);
});

test('party board validation rejects malformed and oversized data', () => {
  const original = loadPartyGames()[0];
  assert.ok(validatePartyGame(null).length);
  const duplicate = structuredClone(original);
  duplicate.categories[1].name = duplicate.categories[0].name.toUpperCase();
  assert.ok(validatePartyGame(duplicate).some((error) => error.startsWith('Duplicate category')));
  const malformed = structuredClone(original);
  malformed.categories[0].clues[1].value = 0;
  malformed.categories[0].clues[0].prompt = 'x'.repeat(501);
  assert.equal(validatePartyGame(malformed).length, 2);
});

test('party HTTP routes serve local boards without changing the multiplayer catalog', async (context) => {
  const server = createJeopardyServer({ games: loadGames(), logger: { error() {} } });
  const address = await server.start(0, '127.0.0.1');
  context.after(() => server.stop());
  const origin = `http://127.0.0.1:${address.port}`;
  const catalog = await fetch(`${origin}/api/party/games`).then((response) => response.json());
  assert.equal(catalog.length, 12);
  const board = await fetch(`${origin}/api/party/games/business`).then((response) => response.json());
  assert.equal(board.categories[0].clues.length, 5);
  assert.ok(board.categories[0].clues[0].answer);
  assert.match(board.boardVersion, /^[a-f0-9]{12}$/);
  const sharedTheme = await fetch(`${origin}/api/party/games/business?version=${board.boardVersion}`).then((response) => response.json());
  assert.deepEqual(sharedTheme, board);
  assert.equal((await fetch(`${origin}/api/party/games/business?version=outdated`)).status, 409);
  assert.equal((await fetch(`${origin}/api/party/games/not-a-board`)).status, 404);
  assert.equal((await fetch(`${origin}/api/party/games/__proto__`)).status, 404);
  const first = await fetch(`${origin}/api/party/random?seed=night-1`).then((response) => response.json());
  const shared = await fetch(`${origin}/api/party/random?seed=night-1&version=${first.poolVersion}`).then((response) => response.json());
  assert.deepEqual(shared, first);
  assert.equal((await fetch(`${origin}/api/party/random?seed=night-1&version=outdated`)).status, 409);
  assert.equal((await fetch(`${origin}/api/party/random?seed=bad!`)).status, 400);
  assert.equal((await fetch(`${origin}/api/party/random?seed=a&seed=b`)).status, 400);
  const multiplayer = await fetch(`${origin}/api/games`).then((response) => response.json());
  assert.equal(multiplayer.length, 20);
  assert.equal(JSON.stringify(multiplayer).includes('answer'), false);
  assert.equal((await fetch(`${origin}/data/party/random-pool.json`)).status, 404);
});
