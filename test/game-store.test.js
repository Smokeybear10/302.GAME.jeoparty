'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { CLUE_VALUES, catalogGames, loadGames, validateGame } = require('../lib/game-store');

test('replacement game bank contains exactly 20 complete medium-difficulty games', () => {
  const games = loadGames();

  assert.equal(games.length, 20);
  assert.equal(new Set(games.map((game) => game.id)).size, 20);
  assert.equal(new Set(games.map((game) => game.title.toLowerCase())).size, 20);

  for (const game of games) {
    assert.equal(game.difficulty, 'Medium');
    assert.equal(game.categories.length, 6);
    assert.deepEqual(game.categories.flatMap((category) => category.clues.map((clue) => clue.value)), [
      ...CLUE_VALUES,
      ...CLUE_VALUES,
      ...CLUE_VALUES,
      ...CLUE_VALUES,
      ...CLUE_VALUES,
      ...CLUE_VALUES,
    ]);
    assert.equal(game.categories.flatMap((category) => category.clues).filter((clue) => clue.dailyDouble).length, 1);
    game.categories.flatMap((category) => category.clues).forEach((clue) => {
      assert.match(clue.answer, /^(Who|What) (is|are|was|were) /);
    });
    assert.ok(game.finalJeopardy.category);
    assert.ok(game.finalJeopardy.clue);
    assert.match(game.finalJeopardy.answer, /^(Who|What) (is|are|was|were) /);
    assert.deepEqual(validateGame(game, game.id), []);
  }
});

test('game catalog exposes topics but not clues or answers', () => {
  const catalog = catalogGames(loadGames());
  const serialized = JSON.stringify(catalog);

  assert.equal(catalog.length, 20);
  assert.equal(catalog[0].categories.length, 6);
  assert.equal(catalog[0].source, 'library');
  assert.equal(catalog[0].year, null);
  assert.equal(serialized.includes('finalJeopardy'), false);
  assert.equal(serialized.includes('answer'), false);
  assert.equal(serialized.includes('"clue":'), false);
  assert.equal(catalog[0].roundCount, 1);
  assert.equal(catalog[0].clueCount, 30);
  assert.deepEqual(catalog[0].doubleJeopardyCategories, []);
});

test('the old bundled game titles are absent', () => {
  const titles = new Set(loadGames().map((game) => game.title));
  for (const retiredTitle of ['Hail Mary', 'Extra Time', 'Throwback', 'Wanderlust', 'Postscript']) {
    assert.equal(titles.has(retiredTitle), false);
  }
});

test('board and Final Jeopardy responses are unique across the replacement bank', () => {
  const seen = new Map();
  for (const game of loadGames()) {
    const clues = [
      ...game.categories.flatMap((category) => category.clues.map((clue) => ({
        answer: clue.answer,
        location: `${game.id}/${category.name}/$${clue.value}`,
      }))),
      { answer: game.finalJeopardy.answer, location: `${game.id}/FINAL` },
    ];
    for (const clue of clues) {
      const normalized = clue.answer.toLowerCase()
        .replace(/^(who|what) (is|are|was|were) /, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
      assert.equal(seen.has(normalized), false, `${clue.location} repeats ${seen.get(normalized)}`);
      seen.set(normalized, clue.location);
    }
  }
});

test('loader reports malformed null entries without crashing', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jeopardy-games-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'broken.json'), '[null]');

  assert.throws(
    () => loadGames(directory),
    (error) => error.message.includes('broken.json[0] must be an object'),
  );
});


test('validates Double Jeopardy values and Daily Doubles and exposes both sets of topics', () => {
  const game = structuredClone(loadGames()[0]);
  game.doubleJeopardy = {
    categories: game.categories.map((category, categoryIndex) => ({
      name: `Double ${category.name}`,
      clues: category.clues.map((clue, clueIndex) => ({
        ...clue,
        value: clue.value * 2,
        dailyDouble: categoryIndex < 2 && clueIndex === 3,
      })),
    })),
  };
  assert.deepEqual(validateGame(game), []);
  const [catalog] = catalogGames([game]);
  assert.equal(catalog.roundCount, 2);
  assert.equal(catalog.clueCount, 60);
  assert.deepEqual(catalog.doubleJeopardyCategories, game.doubleJeopardy.categories.map(({ name }) => name));
  assert.equal(JSON.stringify(catalog).includes('"answer":'), false);

  game.doubleJeopardy.categories[0].clues[0].value = 200;
  assert.ok(validateGame(game).some((error) => error.includes('doubleJeopardy.categories[0].clues[0].value must be 400')));
  game.doubleJeopardy.categories[0].clues[0].value = 400;
  game.doubleJeopardy.categories[0].clues[3].dailyDouble = false;
  assert.ok(validateGame(game).some((error) => error.includes('two Daily Doubles')));
  game.doubleJeopardy = null;
  assert.ok(validateGame(game).some((error) => error.includes('doubleJeopardy must be an object')));
});
