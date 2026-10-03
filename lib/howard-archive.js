'use strict';

const fs = require('node:fs');
const zlib = require('node:zlib');

const BOARD_VALUES = [200, 400, 600, 800, 1000];

function cleanText(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function formatResponse(value) {
  const answer = cleanText(value).replace(/[?]+$/, '');
  if (/^(who|what|where|when) (is|are|was|were)\b/i.test(answer)) return `${answer}?`;
  return `What is ${answer}?`;
}

function formatAirDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function clueAt(round, x, y) {
  return round.find((clue) => Number(clue?.x) === x && Number(clue?.y) === y) || null;
}

function gameFromEpisode(episode, episodeKey) {
  if (!episode || typeof episode !== 'object' || !Array.isArray(episode.jeopardy)) return null;
  if (!Array.isArray(episode.final) || episode.final.length === 0) return null;

  const epNum = cleanText(episode.epNum) || String(episodeKey);
  const airDate = cleanText(episode.airDate);
  const boardClues = [];
  const categories = [];

  for (let x = 1; x <= 6; x += 1) {
    const categoryClues = [];
    let categoryName = '';

    for (let y = 1; y <= 5; y += 1) {
      const raw = clueAt(episode.jeopardy, x, y);
      const clue = cleanText(raw?.q);
      const rawAnswer = cleanText(raw?.a);
      const currentCategory = cleanText(raw?.cat);
      if (!raw || !clue || !rawAnswer || !currentCategory) return null;
      if (clue.length > 500 || rawAnswer.length > 220 || currentCategory.length > 60) return null;
      if (!categoryName) categoryName = currentCategory;
      if (currentCategory.toLowerCase() !== categoryName.toLowerCase()) return null;

      const normalized = {
        value: BOARD_VALUES[y - 1],
        clue,
        answer: formatResponse(rawAnswer),
        dailyDouble: raw.dd === true,
      };
      categoryClues.push(normalized);
      boardClues.push(normalized);
    }

    categories.push({ name: categoryName, clues: categoryClues });
  }

  if (new Set(categories.map((category) => category.name.toLowerCase())).size !== 6) return null;

  const dailyDoubles = boardClues.filter((clue) => clue.dailyDouble);
  if (dailyDoubles.length !== 1) {
    boardClues.forEach((clue) => { clue.dailyDouble = false; });
    const fallbackIndex = Number.parseInt(epNum, 10);
    boardClues[Number.isFinite(fallbackIndex) ? fallbackIndex % boardClues.length : 0].dailyDouble = true;
  }

  const rawFinal = episode.final[0];
  const finalCategory = cleanText(rawFinal?.cat);
  const finalClue = cleanText(rawFinal?.q);
  const finalAnswer = cleanText(rawFinal?.a);
  if (!finalCategory || !finalClue || !finalAnswer) return null;
  if (finalCategory.length > 80 || finalClue.length > 500 || finalAnswer.length > 220) return null;

  return {
    id: `archive-${epNum}`,
    title: airDate ? formatAirDate(airDate) : `Episode ${epNum}`,
    description: airDate
      ? `Episode ${epNum} · original broadcast`
      : `Episode ${epNum}`,
    difficulty: 'Archive',
    source: 'archive',
    airDate: airDate || null,
    year: /^\d{4}/.test(airDate) ? Number(airDate.slice(0, 4)) : null,
    categories,
    finalJeopardy: {
      category: finalCategory,
      clue: finalClue,
      answer: formatResponse(finalAnswer),
    },
  };
}

function gamesFromHowardArchive(archive, { limit = 500 } = {}) {
  if (!archive || typeof archive !== 'object' || Array.isArray(archive)) {
    throw new Error('Howard archive must be an object keyed by episode number');
  }

  const episodes = Object.entries(archive).sort(([, first], [, second]) => {
    const byDate = cleanText(second?.airDate).localeCompare(cleanText(first?.airDate));
    if (byDate !== 0) return byDate;
    return Number(second?.epNum || 0) - Number(first?.epNum || 0);
  });

  const games = [];
  for (const [episodeKey, episode] of episodes) {
    const game = gameFromEpisode(episode, episodeKey);
    if (!game) continue;
    games.push(game);
    if (limit > 0 && games.length >= limit) break;
  }

  if (games.length === 0) throw new Error('Howard archive did not contain any complete playable episodes');
  return games;
}

function loadHowardGames(filepath, options) {
  const compressed = fs.readFileSync(filepath);
  const archive = JSON.parse(zlib.gunzipSync(compressed).toString('utf8'));
  return gamesFromHowardArchive(archive, options);
}

module.exports = {
  BOARD_VALUES,
  gameFromEpisode,
  gamesFromHowardArchive,
  loadHowardGames,
};
