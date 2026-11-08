'use strict';

const fs = require('node:fs');
const zlib = require('node:zlib');

const BOARD_VALUES = [200, 400, 600, 800, 1000];
const DOUBLE_BOARD_VALUES = [400, 800, 1200, 1600, 2000];
const PREPARED_ARCHIVE_VERSION = 2;

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

function requiresMissingMedia(clue) {
  const text = cleanText(clue?.q);
  const category = cleanText(clue?.cat);
  return /\b(?:seen|shown|heard|pictured|displayed|depicted|highlighted|indicated|marked|outlined|circled) (?:right )?(?:here|above|below)\b/i.test(text)
    || /seen here\b/i.test(text)
    || /\bhere (?:seen|shown|pictured|displayed|depicted|portrayed)\b/i.test(text)
    || /\b(?:creature|organism|animal|bird|plant|flower|flag|symbol|person|man|woman|fellow|building|painting|sculpture|map|diagram) here\b/i.test(text)
    || /^here(?:['’]s this| (?:he|she|it|they) (?:is|are))\b/i.test(text)
    || /\bhere(?:'s| is| are) (?:a |an |the |two |three |some |your )?(?:piece|photo(?:graph)?|image|portrait|painting|statue|map|diagram|route|view)\b/i.test(text)
    || /^here are\b/i.test(text)
    || /\b(?:this|these|the following) (?:photo(?:graph)?s?|images?|clips?|illustrations?|recordings?)\b/i.test(text)
    || /\b(?:in|on) (?:this|the) (?:picture|video(?! game)|audio|map)\b/i.test(text)
    || /\b(?:audio|video) (?:daily double|dd|clue)\b/i.test(text)
    || /\b(?:hear|listen to) the following (?:sound|music|audio|recording)\b/i.test(text)
    || /[[(][^\])]*\b(?:is|are) shown\b[^\])]*[\])]/i.test(text)
    || /[[(][^\])]*\b(?:shows?|shown|displays?|displayed)\b[^\])]*\b(?:monitor|screen)\b[^\])]*[\])]/i.test(text)
    || /[[(](?:[^\])]*?\b)?(?:audio|video|music|song|clip) (?:plays?|playing|played)\b/i.test(text)
    || /^(?:listen to|watch|identify (?:this|the) (?:sound|song|voice|tune))\b/i.test(text)
    || /\b(?:picture|photo|audio|video) clues?\b/i.test(category)
    || /^picture (?:the|this|that)\b/i.test(category)
    || /\b(?:picture puzzles|partial marquees|a picture is worth|(?:\d+|two) pictures say)\b/i.test(category);
}

function boardFromRound(round, values, expectedDailyDoubles) {
  if (!Array.isArray(round) || round.length !== 30) return null;
  const categories = [];
  let dailyDoubleCount = 0;

  for (let x = 1; x <= 6; x += 1) {
    const categoryClues = [];
    let categoryName = '';

    for (let y = 1; y <= 5; y += 1) {
      const raw = clueAt(round, x, y);
      const clue = cleanText(raw?.q);
      const rawAnswer = cleanText(raw?.a);
      const currentCategory = cleanText(raw?.cat);
      if (!raw || !clue || !rawAnswer || !currentCategory || requiresMissingMedia(raw)) return null;
      if (clue.length > 500 || rawAnswer.length > 220 || currentCategory.length > 60) return null;
      if (!categoryName) categoryName = currentCategory;
      if (currentCategory.toLowerCase() !== categoryName.toLowerCase()) return null;
      if (raw.dd === true) dailyDoubleCount += 1;

      categoryClues.push({
        value: values[y - 1],
        clue,
        answer: formatResponse(rawAnswer),
        dailyDouble: raw.dd === true,
      });
    }

    categories.push({ name: categoryName, clues: categoryClues });
  }

  if (new Set(categories.map((category) => category.name.toLowerCase())).size !== 6) return null;
  if (dailyDoubleCount !== expectedDailyDoubles) return null;
  return categories;
}

function gameFromEpisode(episode, episodeKey) {
  if (!episode || typeof episode !== 'object') return null;
  if (!Array.isArray(episode.final) || episode.final.length !== 1) return null;

  const categories = boardFromRound(episode.jeopardy, BOARD_VALUES, 1);
  const doubleCategories = boardFromRound(episode.double, DOUBLE_BOARD_VALUES, 2);
  if (!categories || !doubleCategories) return null;

  const rawFinal = episode.final[0];
  const finalCategory = cleanText(rawFinal?.cat);
  const finalClue = cleanText(rawFinal?.q);
  const finalAnswer = cleanText(rawFinal?.a);
  if (!finalCategory || !finalClue || !finalAnswer || requiresMissingMedia(rawFinal)) return null;
  if (finalCategory.length > 80 || finalClue.length > 500 || finalAnswer.length > 220) return null;

  const epNum = cleanText(episode.epNum) || String(episodeKey);
  const airDate = cleanText(episode.airDate);
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
    doubleJeopardy: { categories: doubleCategories },
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
  DOUBLE_BOARD_VALUES,
  PREPARED_ARCHIVE_VERSION,
  gameFromEpisode,
  gamesFromHowardArchive,
  loadHowardGames,
  requiresMissingMedia,
};
