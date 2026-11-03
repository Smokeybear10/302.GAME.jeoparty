'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createState, normalizeBoard, normalizeState, reduce, isComplete, allClueKeys } = require('../party-state');

const board = {
  id: 'history', title: 'History', description: 'A history board', boardVersion: '123456abcdef',
  categories: [
    { name: 'Cities', clues: [{ value: 200, prompt: 'French capital?', answer: 'Paris' }, { value: 400, prompt: 'Italian capital?', answer: 'Rome' }] },
    { name: 'Numbers', clues: [{ value: 200, prompt: 'Two plus two?', answer: 'Four' }, { value: 400, prompt: 'Two squared?', answer: 'Four' }] },
  ],
};
const fresh = () => createState(board, ['Alice', 'Bob']);

test('party setup requires two to six named players and starts everyone at zero', () => {
  assert.deepEqual(fresh().players, [{ id: 'p1', name: 'Alice', score: 0 }, { id: 'p2', name: 'Bob', score: 0 }]);
  for (const names of [[], ['Alice'], ['Alice', ' '], Array(7).fill('Player'), ['Alice', 'x'.repeat(33)]]) {
    assert.equal(createState(board, names), null);
  }
  assert.equal(createState(board, Array(6).fill(' Player ')).players[0].name, 'Player');
});

test('played clues cannot reopen and both correct and incorrect responses consume a clue exactly once', () => {
  let state = reduce(fresh(), { type: 'open', key: '0:0' });
  const correct = { type: 'score', key: '0:0', playerId: 'p1', correct: true };
  state = reduce(state, correct);
  assert.equal(state.players[0].score, 200);
  assert.deepEqual(state.used, ['0:0']);
  assert.equal(reduce(state, correct), state);
  assert.equal(reduce(state, { type: 'open', key: '0:0' }), state);
  state = reduce(state, { type: 'open', key: '0:1' });
  state = reduce(state, { type: 'score', key: '0:1', playerId: 'p2', correct: false });
  assert.equal(state.players[1].score, -400);
  assert.deepEqual(state.used, ['0:0', '0:1']);
  assert.equal(state.activeClue, null);
});

test('closing a clue leaves it playable and clears its revealed answer', () => {
  let state = reduce(fresh(), { type: 'open', key: '0:0' });
  state = reduce(state, { type: 'reveal', key: '0:0' });
  assert.equal(state.answerVisible, true);
  state = reduce(state, { type: 'close' });
  assert.deepEqual(state.used, []);
  state = reduce(state, { type: 'open', key: '0:0' });
  assert.equal(state.answerVisible, false);
});

test('stale scoring and reveal actions cannot affect a different open clue', () => {
  let state = reduce(fresh(), { type: 'open', key: '1:0' });
  for (const action of [
    { type: 'score', key: '0:0', playerId: 'p1', correct: true },
    { type: 'skip', key: '0:0' },
    { type: 'reveal', key: '0:0' },
    { type: 'open', key: '0:0' },
    { type: 'score', key: '1:0', playerId: 'missing', correct: true },
    { type: 'score', key: '1:0', playerId: 'p1', correct: 'true' },
  ]) assert.equal(reduce(state, action), state);
  for (const key of ['0:99', '99:0', '00:0', '-1:0', '__proto__', null]) {
    const empty = fresh();
    assert.equal(reduce(empty, { type: 'open', key }), empty);
  }
});

test('all skipped or scored clues finish the board, and restart preserves names and the exact board', () => {
  let state = fresh();
  state = reduce(state, { type: 'rename', playerId: 'p2', name: ' Blake ' });
  for (const key of allClueKeys(board)) {
    state = reduce(state, { type: 'open', key });
    state = reduce(state, { type: 'skip', key });
  }
  assert.equal(isComplete(state), true);
  assert.deepEqual(state.players.map((player) => player.score), [0, 0]);
  const restarted = reduce(state, { type: 'restart' });
  assert.equal(isComplete(restarted), false);
  assert.equal(restarted.players[1].name, 'Blake');
  assert.deepEqual(restarted.board, state.board);
  assert.equal(reduce(restarted, { type: 'rename', playerId: 'p1', name: ' ' }), restarted);
});

test('save and reload preserve the selected random board, seed, version, scores, and an open revealed clue', () => {
  const randomBoard = { ...board, id: 'random', seed: 'session_123', poolVersion: 'abcdef123456' };
  delete randomBoard.boardVersion;
  let state = createState(randomBoard, ['A', 'B']);
  state = reduce(state, { type: 'open', key: '1:0' });
  state = reduce(state, { type: 'score', key: '1:0', playerId: 'p2', correct: false });
  state = reduce(state, { type: 'open', key: '0:1' });
  state = reduce(state, { type: 'reveal', key: '0:1' });
  assert.deepEqual(normalizeState(JSON.parse(JSON.stringify(state))), state);
  assert.equal(state.board.poolVersion, 'abcdef123456');
  assert.equal(normalizeState(JSON.parse(JSON.stringify(fresh()))).board.boardVersion, '123456abcdef');
});

test('malformed saved state cannot inject scores, players, duplicate used clues, or an already used active clue', () => {
  for (const saved of [null, [], {}, { ...fresh(), version: 9 }, { ...fresh(), board: {} },
    { ...fresh(), players: [{ id: 'p1', name: 'A', score: Infinity }, { id: 'p2', name: 'B', score: 0 }] },
    { ...fresh(), players: [{ id: 'p1', name: 'A', score: 0 }, { id: 'p1', name: 'B', score: 0 }] },
  ]) assert.equal(normalizeState(saved), null);
  const restored = normalizeState({ ...fresh(), used: ['0:0', '0:0', 'bad', '0:9'], activeClue: '0:0', answerVisible: true });
  assert.deepEqual(restored.used, ['0:0']);
  assert.equal(restored.activeClue, null);
  assert.equal(restored.answerVisible, false);
});

test('invalid board data and share identities are rejected at the saved-data boundary', () => {
  for (const candidate of [null, [], { ...board, id: '../history' }, { ...board, categories: [] },
    { ...board, seed: '../bad' }, { ...board, poolVersion: 'stale' }, { ...board, boardVersion: 123456789012 },
    { ...board, categories: [{ name: 'Bad', clues: [{ value: -2, prompt: 'Prompt', answer: 'Answer' }] }] },
  ]) assert.equal(normalizeBoard(candidate), null);
});

test('a full seven by seven board retains all forty-nine clues through save and restart', () => {
  const largeBoard = { ...board, categories: Array.from({ length: 7 }, (_, category) => ({
    name: `Category ${category}`, clues: Array.from({ length: 7 }, (_, row) => ({ value: 200 * (row + 1), prompt: `Question ${category}:${row}`, answer: 'Answer' })),
  })) };
  let state = createState(largeBoard, ['A', 'B']);
  assert.equal(allClueKeys(state.board).length, 49);
  state = reduce(state, { type: 'open', key: '6:6' });
  state = reduce(state, { type: 'score', key: '6:6', playerId: 'p1', correct: true });
  assert.equal(state.players[0].score, 1400);
  assert.deepEqual(normalizeState(JSON.parse(JSON.stringify(state))), state);
});
