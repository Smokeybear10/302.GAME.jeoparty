'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadHowardGames } = require('./howard-archive');

const CLUE_VALUES = [200, 400, 600, 800, 1000];

function assertText(value, label, errors, maxLength = 500) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(`${label} must be a non-empty string`);
    return;
  }
  if (value.length > maxLength) errors.push(`${label} must be ${maxLength} characters or fewer`);
}

function validateGame(game, source = 'game') {
  const errors = [];

  if (!game || typeof game !== 'object' || Array.isArray(game)) {
    return [`${source} must be an object`];
  }

  assertText(game.id, `${source}.id`, errors, 64);
  assertText(game.title, `${source}.title`, errors, 80);
  assertText(game.description, `${source}.description`, errors, 180);
  assertText(game.difficulty, `${source}.difficulty`, errors, 30);

  if (!Array.isArray(game.categories) || game.categories.length !== 6) {
    errors.push(`${source}.categories must contain exactly 6 categories`);
  } else {
    const categoryNames = new Set();
    let dailyDoubleCount = 0;

    game.categories.forEach((category, categoryIndex) => {
      const categoryLabel = `${source}.categories[${categoryIndex}]`;
      assertText(category?.name, `${categoryLabel}.name`, errors, 60);
      const normalizedName = typeof category?.name === 'string' ? category.name.trim().toLowerCase() : '';
      if (normalizedName && categoryNames.has(normalizedName)) {
        errors.push(`${source} repeats the category name "${category.name}"`);
      }
      categoryNames.add(normalizedName);

      if (!Array.isArray(category?.clues) || category.clues.length !== 5) {
        errors.push(`${categoryLabel}.clues must contain exactly 5 clues`);
        return;
      }

      category.clues.forEach((clue, clueIndex) => {
        const clueLabel = `${categoryLabel}.clues[${clueIndex}]`;
        if (clue?.value !== CLUE_VALUES[clueIndex]) {
          errors.push(`${clueLabel}.value must be ${CLUE_VALUES[clueIndex]}`);
        }
        assertText(clue?.clue, `${clueLabel}.clue`, errors, 500);
        assertText(clue?.answer, `${clueLabel}.answer`, errors, 240);
        if (clue?.dailyDouble === true) dailyDoubleCount += 1;
        if (clue?.dailyDouble !== undefined && typeof clue.dailyDouble !== 'boolean') {
          errors.push(`${clueLabel}.dailyDouble must be a boolean when provided`);
        }
      });
    });

    if (dailyDoubleCount !== 1) {
      errors.push(`${source} must contain exactly one Daily Double; found ${dailyDoubleCount}`);
    }
  }

  if (!game.finalJeopardy || typeof game.finalJeopardy !== 'object') {
    errors.push(`${source}.finalJeopardy must be an object`);
  } else {
    assertText(game.finalJeopardy.category, `${source}.finalJeopardy.category`, errors, 80);
    assertText(game.finalJeopardy.clue, `${source}.finalJeopardy.clue`, errors, 500);
    assertText(game.finalJeopardy.answer, `${source}.finalJeopardy.answer`, errors, 240);
  }

  return errors;
}

function loadGames(directory = path.join(__dirname, '..', 'data', 'games')) {
  const filenames = fs.readdirSync(directory)
    .filter((filename) => filename.endsWith('.json'))
    .sort();

  if (filenames.length === 0) throw new Error(`No game files found in ${directory}`);

  const games = [];
  const errors = [];

  for (const filename of filenames) {
    const filepath = path.join(directory, filename);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    } catch (error) {
      errors.push(`${filename}: invalid JSON (${error.message})`);
      continue;
    }

    if (!Array.isArray(parsed)) {
      errors.push(`${filename}: top-level value must be an array`);
      continue;
    }

    parsed.forEach((game, index) => {
      errors.push(...validateGame(game, `${filename}[${index}]`));
      if (!game || typeof game !== 'object' || Array.isArray(game)) return;
      games.push(game);
    });
  }

  const seenIds = new Set();
  const seenTitles = new Set();
  for (const game of games) {
    const normalizedTitle = typeof game?.title === 'string' ? game.title.trim().toLowerCase() : '';
    if (seenIds.has(game.id)) errors.push(`Duplicate game id: ${game.id}`);
    if (seenTitles.has(normalizedTitle)) errors.push(`Duplicate game title: ${game.title}`);
    seenIds.add(game.id);
    seenTitles.add(normalizedTitle);
  }

  if (errors.length > 0) {
    throw new Error(`Game bank validation failed:\n- ${errors.join('\n- ')}`);
  }

  return games;
}

function loadPreferredGames({
  archivePath = path.join(__dirname, '..', 'data', 'archive', 'howard-jeopardy.json.gz'),
  archiveLimit = Number.parseInt(process.env.JEOPARDY_ARCHIVE_LIMIT || '0', 10),
} = {}) {
  if (!fs.existsSync(archivePath)) return loadGames();
  const limit = Number.isFinite(archiveLimit) && archiveLimit >= 0 ? archiveLimit : 0;
  return loadHowardGames(archivePath, { limit });
}

function catalogGames(games) {
  return games.map((game) => ({
    id: game.id,
    title: game.title,
    description: game.description,
    difficulty: game.difficulty,
    source: game.source || 'library',
    year: Number.isInteger(game.year) ? game.year : null,
    categories: game.categories.map((category) => category.name),
  }));
}

module.exports = {
  CLUE_VALUES,
  catalogGames,
  loadGames,
  loadPreferredGames,
  validateGame,
};
