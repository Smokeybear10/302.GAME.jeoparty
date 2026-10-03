'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { normalizeProgress, recordResult, selectNextQuestion } = require('../practice-state');

const questions = [
  { id: 'history-1', topic: 'history' },
  { id: 'science-1', topic: 'science' },
  { id: 'history-2', topic: 'history' },
  { id: 'arts-1', topic: 'arts' },
];

test('new progress selects every topic for mixed practice', () => {
  assert.deepEqual(normalizeProgress(null, questions), {
    version: 1,
    selectedTopics: ['history', 'science', 'arts'],
    reviewOnly: false,
    records: {},
  });
});

test('progress survives a JSON save and reload with topic and review preferences', () => {
  const initial = normalizeProgress({ selectedTopics: ['science'], reviewOnly: true }, questions);
  const progress = recordResult(initial, 'science-1', false, 1234);
  assert.deepEqual(normalizeProgress(JSON.parse(JSON.stringify(progress)), questions), progress);
});

test('malformed storage roots and invalid preferences fall back to mixed practice', () => {
  const expected = normalizeProgress(null, questions);
  for (const value of [undefined, false, 42, 'bad JSON', [], { selectedTopics: 'science' }, { selectedTopics: ['removed'] }]) {
    assert.deepEqual(normalizeProgress(value, questions), expected);
  }
  assert.equal(normalizeProgress({ reviewOnly: 'true' }, questions).reviewOnly, false);
});

test('an intentionally empty topic selection stays empty after reload', () => {
  const progress = normalizeProgress({ selectedTopics: [] }, questions);
  assert.deepEqual(progress.selectedTopics, []);
  assert.equal(selectNextQuestion(questions, progress), null);
  assert.deepEqual(normalizeProgress(JSON.parse(JSON.stringify(progress)), questions).selectedTopics, []);
});

test('saved topic selections remove duplicates and unknown topics', () => {
  const progress = normalizeProgress({ selectedTopics: ['science', 'removed', 'science', null] }, questions);
  assert.deepEqual(progress.selectedTopics, ['science']);
});

test('unknown and malformed saved records are discarded', () => {
  const record = { attempts: 1, correct: 0, needsReview: true, lastReviewed: 123 };
  const progress = normalizeProgress({
    records: {
      removed: record,
      'history-1': null,
      'history-2': { ...record, attempts: '1' },
      'science-1': { ...record, needsReview: 'true' },
      'arts-1': [],
    },
  }, questions);
  assert.deepEqual(progress.records, {});
  for (const records of [false, 3, [], 'bad']) assert.deepEqual(normalizeProgress({ records }, questions).records, {});
});

test('saved counters and timestamps are bounded nonnegative integers', () => {
  const progress = normalizeProgress({ records: {
    'history-1': { attempts: 2.9, correct: 99.8, needsReview: false, lastReviewed: -50 },
    'science-1': { attempts: Number.MAX_VALUE, correct: Number.MAX_VALUE, needsReview: false, lastReviewed: Number.MAX_VALUE },
    'history-2': { attempts: Infinity, correct: 0, needsReview: true, lastReviewed: 10 },
    'arts-1': { attempts: -1, correct: -1, needsReview: false, lastReviewed: 10 },
  } }, questions);
  assert.deepEqual(progress.records['history-1'], { attempts: 2, correct: 2, needsReview: false, lastReviewed: 0 });
  assert.deepEqual(progress.records['science-1'], {
    attempts: Number.MAX_SAFE_INTEGER, correct: Number.MAX_SAFE_INTEGER,
    needsReview: false, lastReviewed: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(progress.records['history-2'], undefined);
  assert.equal(progress.records['arts-1'], undefined);
});

test('unsafe IDs cannot become records or pollute object prototypes', () => {
  const saved = JSON.parse('{"records":{"__proto__":{"attempts":1,"correct":0,"needsReview":true,"lastReviewed":1}}}');
  const progress = normalizeProgress(saved, [...questions, { id: '__proto__', topic: 'history' }]);
  assert.deepEqual(progress.records, {});
  for (const id of ['__proto__', 'constructor', 'prototype', null, '']) {
    assert.equal(recordResult(progress, id, false), progress);
  }
  assert.equal(Object.prototype.needsReview, undefined);
});

test('recording a result leaves the previous progress and records unchanged', () => {
  const progress = normalizeProgress(null, questions);
  Object.freeze(progress.records);
  Object.freeze(progress);
  const updated = recordResult(progress, 'history-1', true, 500);
  assert.deepEqual(progress.records, {});
  assert.notEqual(updated, progress);
  assert.notEqual(updated.records, progress.records);
  assert.deepEqual(updated.records['history-1'], { attempts: 1, correct: 1, needsReview: false, lastReviewed: 500 });
});

test('each explicit result increments attempts once and only correct responses increment correct', () => {
  let progress = normalizeProgress(null, questions);
  progress = recordResult(progress, 'history-1', true, 100);
  progress = recordResult(progress, 'history-1', false, 200);
  progress = recordResult(progress, 'history-1', true, 300);
  assert.deepEqual(progress.records['history-1'], { attempts: 3, correct: 2, needsReview: false, lastReviewed: 300 });
  assert.equal(recordResult(progress, 'history-1', 'true', 400), progress);
});

test('a miss enters review and a subsequent correct response removes it', () => {
  let progress = normalizeProgress({ reviewOnly: true }, questions);
  assert.equal(selectNextQuestion(questions, progress), null);
  progress = recordResult(progress, 'history-1', false, 100);
  assert.equal(selectNextQuestion(questions, progress).id, 'history-1');
  progress = recordResult(progress, 'history-1', true, 200);
  assert.equal(selectNextQuestion(questions, progress), null);
  assert.deepEqual(progress.records['history-1'], { attempts: 2, correct: 1, needsReview: false, lastReviewed: 200 });
});

test('topic filtering applies to both mixed practice and review mode', () => {
  let progress = normalizeProgress({ selectedTopics: ['science'] }, questions);
  for (const random of [() => 0, () => 0.5, () => 0.99]) {
    assert.equal(selectNextQuestion(questions, progress, { random }).id, 'science-1');
  }
  progress = recordResult(progress, 'history-1', false, 100);
  progress.reviewOnly = true;
  assert.equal(selectNextQuestion(questions, progress), null);
  progress = recordResult(progress, 'science-1', false, 200);
  assert.equal(selectNextQuestion(questions, progress).id, 'science-1');
});

test('new questions are preferred over answered questions after reload', () => {
  let progress = normalizeProgress(null, questions);
  progress = recordResult(progress, 'history-1', true, 100);
  progress = normalizeProgress(JSON.parse(JSON.stringify(progress)), questions);
  assert.equal(selectNextQuestion(questions, progress, { random: () => 0 }).id, 'science-1');
});

test('a practice cycle visits every question before repeating', () => {
  let progress = normalizeProgress(null, questions);
  const seenIds = [];
  let currentId = null;
  for (let index = 0; index < questions.length; index += 1) {
    const question = selectNextQuestion(questions, progress, { seenIds, currentId, random: () => 0 });
    assert.equal(seenIds.includes(question.id), false);
    seenIds.push(question.id);
    currentId = question.id;
    progress = recordResult(progress, question.id, true, index);
  }
  assert.equal(new Set(seenIds).size, questions.length);
  const recycled = selectNextQuestion(questions, progress, { seenIds, currentId, random: () => 0.99 });
  assert.notEqual(recycled.id, currentId);
});

test('a seen unanswered question does not displace unseen answered questions in a cycle', () => {
  const progress = recordResult(normalizeProgress(null, questions), 'science-1', true, 100);
  const question = selectNextQuestion(questions, progress, {
    seenIds: ['history-1', 'history-2', 'arts-1'], currentId: 'arts-1', random: () => 0,
  });
  assert.equal(question.id, 'science-1');
});

test('one remaining eligible question can repeat without stalling', () => {
  const progress = normalizeProgress({ selectedTopics: ['science'] }, questions);
  assert.equal(selectNextQuestion(questions, progress, {
    seenIds: ['science-1'], currentId: 'science-1',
  }).id, 'science-1');
});

test('empty and malformed question banks return empty progress and no question', () => {
  for (const bank of [undefined, null, [], {}, [null, {}, { id: 'bad' }]]) {
    assert.deepEqual(normalizeProgress(null, bank).selectedTopics, []);
    assert.equal(selectNextQuestion(bank, null), null);
  }
});

test('the same state API loads as a plain browser script without CommonJS', () => {
  const context = vm.createContext({});
  const script = readFileSync(path.join(__dirname, '..', 'practice-state.js'), 'utf8');
  vm.runInContext(script, context);
  assert.equal(vm.runInContext('typeof PracticeState.normalizeProgress', context), 'function');
  assert.equal(vm.runInContext('typeof PracticeState.recordResult', context), 'function');
  assert.equal(vm.runInContext('typeof PracticeState.selectNextQuestion', context), 'function');
});
