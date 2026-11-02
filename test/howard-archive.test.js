'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { gameFromEpisode, gamesFromHowardArchive } = require('../lib/howard-archive');
const { validateGame } = require('../lib/game-store');

function completeEpisode(epNum = '123') {
  const jeopardy = [];
  for (let x = 1; x <= 6; x += 1) {
    for (let y = 1; y <= 5; y += 1) {
      jeopardy.push({
        x,
        y,
        q: `Clue ${x}-${y}`,
        a: `Response ${x}-${y}`,
        cat: `CATEGORY ${x}`,
        dd: x === 2 && y === 3,
        val: y * 200,
      });
    }
  }
  return {
    epNum,
    airDate: '2025-01-02',
    jeopardy,
    double: [],
    final: [{ x: 1, y: 1, q: 'Final clue', a: 'Final response', cat: 'FINAL CATEGORY', dd: false, val: 0 }],
  };
}

test('converts a complete Howard episode into Aadi game data', () => {
  const game = gameFromEpisode(completeEpisode(), '123');

  assert.equal(game.id, 'archive-123');
  assert.equal(game.title, 'Jan 2, 2025');
  assert.equal(game.description, 'Episode 123 · original broadcast');
  assert.equal(game.source, 'archive');
  assert.equal(game.year, 2025);
  assert.equal(game.airDate, '2025-01-02');
  assert.equal(game.categories.length, 6);
  assert.deepEqual(game.categories[0].clues.map((clue) => clue.value), [200, 400, 600, 800, 1000]);
  assert.equal(game.categories.flatMap((category) => category.clues).filter((clue) => clue.dailyDouble).length, 1);
  assert.equal(game.finalJeopardy.category, 'FINAL CATEGORY');
  assert.deepEqual(validateGame(game, game.id), []);
});

test('skips incomplete episodes and respects the requested library limit', () => {
  const archive = {
    incomplete: { ...completeEpisode('1'), jeopardy: [] },
    first: completeEpisode('2'),
    second: { ...completeEpisode('3'), airDate: '2025-02-01' },
  };

  const games = gamesFromHowardArchive(archive, { limit: 1 });
  assert.equal(games.length, 1);
  assert.equal(games[0].id, 'archive-3');
});
