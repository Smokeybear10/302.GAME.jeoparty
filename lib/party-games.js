'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PARTY_DIRECTORY = path.join(__dirname, '..', 'data', 'party');
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEED_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function validText(value, maxLength) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function validatePartyGame(game) {
  if (!game || typeof game !== 'object' || Array.isArray(game)) return ['Board must be an object.'];
  const errors = [];
  if (!validText(game.id, 64) || !ID_PATTERN.test(game.id)) errors.push('Board ID must be a short lowercase slug.');
  if (!validText(game.title, 100)) errors.push('Board title must contain 1–100 characters.');
  if (!validText(game.description, 180)) errors.push('Board description must contain 1–180 characters.');
  if (!Array.isArray(game.categories) || game.categories.length < 2 || game.categories.length > 10) {
    return [...errors, 'Board must have 2–10 categories.'];
  }

  const categoryNames = new Set();
  for (const category of game.categories) {
    if (!validText(category?.name, 50)) errors.push('Category names must contain 1–50 characters.');
    const name = typeof category?.name === 'string' ? category.name.trim().toLowerCase() : '';
    if (categoryNames.has(name)) errors.push(`Duplicate category: ${name}.`);
    categoryNames.add(name);
    if (!Array.isArray(category?.clues) || category.clues.length < 2 || category.clues.length > 10) {
      errors.push('Categories must have 2–10 clues.');
      continue;
    }
    let previousValue = 0;
    for (const clue of category.clues) {
      if (!Number.isInteger(clue?.value) || clue.value <= previousValue || clue.value > 10000) {
        errors.push('Clue values must be ascending positive integers up to 10000.');
      }
      previousValue = clue?.value;
      if (!validText(clue?.prompt, 500)) errors.push('Clue prompts must contain 1–500 characters.');
      if (!validText(clue?.answer, 200)) errors.push('Clue answers must contain 1–200 characters.');
    }
  }
  return errors;
}

function loadPartyGames(directory = path.join(PARTY_DIRECTORY, 'games')) {
  const filenames = fs.readdirSync(directory).filter((filename) => filename.endsWith('.json')).sort();
  if (filenames.length === 0) throw new Error('No party boards were found.');
  const ids = new Set();
  return filenames.map((filename) => {
    const source = fs.readFileSync(path.join(directory, filename), 'utf8');
    const game = JSON.parse(source);
    const errors = validatePartyGame(game);
    if (ids.has(game?.id)) errors.push(`Duplicate board ID: ${game.id}.`);
    if (errors.length) throw new Error(`${filename}: ${errors.join(' ')}`);
    ids.add(game.id);
    return { ...game, boardVersion: crypto.createHash('sha256').update(source).digest('hex').slice(0, 12) };
  });
}

function catalogPartyGames(games) {
  return games.map((game) => ({
    id: game.id,
    title: game.title,
    description: game.description,
    categories: game.categories.map((category) => category.name),
    clueCount: game.categories.reduce((count, category) => count + category.clues.length, 0),
  }));
}

function loadPartyPool(filepath = path.join(PARTY_DIRECTORY, 'random-pool.json')) {
  const source = fs.readFileSync(filepath, 'utf8');
  const raw = JSON.parse(source);
  if (!Array.isArray(raw) || raw.length < 7 || raw.length > 20000) throw new Error('Party pool must contain 7–20000 categories.');
  const grouped = new Map();
  for (const category of raw) {
    if (!validText(category?.name, 50) || !Array.isArray(category.clues) || category.clues.length < 7 || category.clues.length > 100) {
      throw new Error('Party pool categories need a name and 7–100 clues.');
    }
    const key = category.name.trim().toLowerCase();
    if (!grouped.has(key)) grouped.set(key, { name: category.name, clues: [], prompts: new Set() });
    const entry = grouped.get(key);
    for (const clue of category.clues) {
      if (!validText(clue?.prompt, 500) || !validText(clue?.answer, 200)) throw new Error(`Invalid party clue in ${category.name}.`);
      const prompt = clue.prompt.trim().toLowerCase();
      if (entry.prompts.has(prompt)) continue;
      entry.prompts.add(prompt);
      entry.clues.push({ prompt: clue.prompt, answer: clue.answer });
    }
  }
  const categories = [...grouped.values()].filter((category) => category.clues.length >= 7)
    .map(({ name, clues }) => ({ name, clues }));
  if (categories.length < 7) throw new Error('Party pool needs seven distinct complete categories.');
  return { categories, version: crypto.createHash('sha256').update(source).digest('hex').slice(0, 12) };
}

function seededRandom(seed) {
  let value = crypto.createHash('sha256').update(seed).digest().readUInt32LE(0);
  return () => {
    value = (value + 0x6D2B79F5) | 0;
    let next = Math.imul(value ^ (value >>> 15), value | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function sample(items, count, random) {
  const remaining = [...items];
  return Array.from({ length: count }, () => remaining.splice(Math.floor(random() * remaining.length), 1)[0]);
}

function randomPartyGame(pool, seed = crypto.randomBytes(8).toString('hex')) {
  if (typeof seed !== 'string' || !SEED_PATTERN.test(seed)) throw new Error('Seed must contain 1–64 letters, numbers, underscores, or hyphens.');
  const random = seededRandom(seed);
  return {
    id: 'random',
    title: 'Random Board',
    description: '7 categories · 49 clues',
    seed,
    poolVersion: pool.version,
    categories: sample(pool.categories, 7, random).map((category) => ({
      name: category.name,
      clues: sample(category.clues, 7, random).map((clue, index) => ({ value: (index + 1) * 200, ...clue })),
    })),
  };
}

module.exports = { catalogPartyGames, loadPartyGames, loadPartyPool, randomPartyGame, validatePartyGame };
