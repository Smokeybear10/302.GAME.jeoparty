'use strict';

const PartyState = (() => {
  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const text = (value, limit) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
  const token = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
  const clueKey = (category, clue) => `${category}:${clue}`;

  function normalizeBoard(value) {
    if (!isObject(value) || !token(value.id) || !text(value.title, 120)
      || !Array.isArray(value.categories) || value.categories.length < 1 || value.categories.length > 10
      || (value.seed !== undefined && !token(value.seed))
      || (value.poolVersion !== undefined && (typeof value.poolVersion !== 'string' || !/^[a-f0-9]{12}$/.test(value.poolVersion)))
      || (value.boardVersion !== undefined && (typeof value.boardVersion !== 'string' || !/^[a-f0-9]{12}$/.test(value.boardVersion)))) return null;

    const categories = [];
    for (const category of value.categories) {
      if (!isObject(category) || !text(category.name, 100) || !Array.isArray(category.clues)
        || category.clues.length < 1 || category.clues.length > 10) return null;
      const clues = [];
      for (const clue of category.clues) {
        if (!isObject(clue) || !Number.isInteger(clue.value) || clue.value < 1 || clue.value > 10000
          || !text(clue.prompt, 2000) || !text(clue.answer, 1000)) return null;
        clues.push({ value: clue.value, prompt: clue.prompt, answer: clue.answer });
      }
      categories.push({ name: category.name, clues });
    }
    return {
      id: value.id,
      title: value.title,
      description: typeof value.description === 'string' ? value.description.slice(0, 500) : '',
      ...(value.seed ? { seed: value.seed } : {}),
      ...(value.poolVersion ? { poolVersion: value.poolVersion } : {}),
      ...(value.boardVersion ? { boardVersion: value.boardVersion } : {}),
      categories,
    };
  }

  function allClueKeys(board) {
    return board.categories.flatMap((category, categoryIndex) =>
      category.clues.map((_, clueIndex) => clueKey(categoryIndex, clueIndex)));
  }

  function clueAt(board, key) {
    if (typeof key !== 'string' || !/^\d+:\d+$/.test(key)) return null;
    const [categoryIndex, clueIndex] = key.split(':').map(Number);
    if (clueKey(categoryIndex, clueIndex) !== key) return null;
    return board?.categories[categoryIndex]?.clues[clueIndex] ?? null;
  }

  function createState(board, names) {
    const normalizedBoard = normalizeBoard(board);
    if (!normalizedBoard || !Array.isArray(names) || names.length < 2 || names.length > 6
      || !names.every((name) => text(name, 32))) return null;
    return {
      version: 1,
      board: normalizedBoard,
      players: names.map((name, index) => ({ id: `p${index + 1}`, name: name.trim(), score: 0 })),
      used: [],
      activeClue: null,
      answerVisible: false,
    };
  }

  function normalizeState(value) {
    if (!isObject(value) || value.version !== 1) return null;
    const board = normalizeBoard(value.board);
    if (!board || !Array.isArray(value.players) || value.players.length < 2 || value.players.length > 6
      || !value.players.every((player) => isObject(player) && token(player.id) && text(player.name, 32)
        && Number.isSafeInteger(player.score) && Math.abs(player.score) <= 1000000)
      || new Set(value.players.map((player) => player.id)).size !== value.players.length
      || !Array.isArray(value.used)) return null;
    const validKeys = new Set(allClueKeys(board));
    const used = [...new Set(value.used.filter((key) => validKeys.has(key)))];
    const activeClue = validKeys.has(value.activeClue) && !used.includes(value.activeClue) ? value.activeClue : null;
    return {
      version: 1,
      board,
      players: value.players.map(({ id, name, score }) => ({ id, name: name.trim(), score })),
      used,
      activeClue,
      answerVisible: activeClue !== null && value.answerVisible === true,
    };
  }

  function isComplete(state) {
    return state.used.length === allClueKeys(state.board).length;
  }

  function reduce(state, action) {
    if (!state || !isObject(action)) return state;
    if (action.type === 'open') {
      if (state.activeClue || !clueAt(state.board, action.key) || state.used.includes(action.key)) return state;
      return { ...state, activeClue: action.key, answerVisible: false };
    }
    if (action.type === 'close') return { ...state, activeClue: null, answerVisible: false };
    if (action.type === 'rename') {
      if (!text(action.name, 32)) return state;
      return { ...state, players: state.players.map((player) =>
        player.id === action.playerId ? { ...player, name: action.name.trim() } : player) };
    }
    if (action.type === 'restart') return createState(state.board, state.players.map((player) => player.name));
    if (!state.activeClue || action.key !== state.activeClue) return state;
    if (action.type === 'reveal') return { ...state, answerVisible: true };
    if (action.type !== 'score' && action.type !== 'skip') return state;
    let players = state.players;
    if (action.type === 'score') {
      if (!players.some((player) => player.id === action.playerId) || typeof action.correct !== 'boolean') return state;
      const delta = clueAt(state.board, state.activeClue).value * (action.correct ? 1 : -1);
      players = players.map((player) => player.id === action.playerId ? { ...player, score: player.score + delta } : player);
    }
    return {
      ...state,
      players,
      used: [...state.used, state.activeClue],
      activeClue: null,
      answerVisible: false,
    };
  }

  return { normalizeBoard, normalizeState, createState, allClueKeys, clueKey, clueAt, isComplete, reduce };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PartyState;
