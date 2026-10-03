'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { PRACTICE_TOPICS, PRACTICE_QUESTIONS } = require('../practice-data');

test('practice topics have stable unique IDs and readable labels', () => {
  assert.equal(PRACTICE_TOPICS.length, 8);
  assert.equal(new Set(PRACTICE_TOPICS.map(({ id }) => id)).size, PRACTICE_TOPICS.length);
  for (const topic of PRACTICE_TOPICS) {
    assert.match(topic.id, /^[a-z]+$/);
    assert.equal(typeof topic.label, 'string');
    assert.ok(topic.label.trim().length >= 4);
  }
});

test('every practice topic has at least eight distinct questions', () => {
  const topicIds = new Set(PRACTICE_TOPICS.map(({ id }) => id));
  const counts = new Map(PRACTICE_TOPICS.map(({ id }) => [id, 0]));
  const ids = new Set();
  const prompts = new Set();

  for (const question of PRACTICE_QUESTIONS) {
    assert.match(question.id, /^[a-z]+(?:-[a-z0-9]+)+$/);
    assert.ok(!ids.has(question.id), `Duplicate question ID: ${question.id}`);
    assert.ok(!prompts.has(question.question), `Duplicate prompt: ${question.id}`);
    assert.ok(topicIds.has(question.topic), `Unknown topic: ${question.topic}`);
    ids.add(question.id);
    prompts.add(question.question);
    counts.set(question.topic, counts.get(question.topic) + 1);
  }

  for (const [topic, count] of counts) {
    assert.ok(count >= 8, `${topic} has only ${count} questions`);
  }
});

test('practice questions include complete prompts, answers, hints, and explanations', () => {
  for (const question of PRACTICE_QUESTIONS) {
    for (const field of ['question', 'answer', 'hint', 'explanation']) {
      assert.equal(typeof question[field], 'string', `${question.id}.${field}`);
      assert.equal(question[field], question[field].trim(), `${question.id}.${field} has surrounding whitespace`);
      assert.ok(question[field].length > 0, `${question.id}.${field} is empty`);
    }
    assert.ok(question.question.length >= 15, `${question.id} needs a complete prompt`);
    assert.ok(question.question.endsWith('?'), `${question.id} needs a question mark`);
    assert.ok(question.hint.length >= 15, `${question.id} needs a useful hint`);
    assert.ok(question.explanation.length >= 80, `${question.id} needs a teaching explanation`);
    assert.notEqual(question.explanation, question.answer, `${question.id} only repeats its answer`);
    assert.notEqual(question.hint, question.answer, `${question.id} reveals its answer as the hint`);
  }
});

test('every practice question has a supported positive point value', () => {
  const allowedPoints = new Set([200, 400, 600, 800, 1000]);
  for (const question of PRACTICE_QUESTIONS) {
    assert.ok(allowedPoints.has(question.points), `${question.id} has an invalid point value: ${question.points}`);
  }
});

test('practice data also loads as a standalone browser script without CommonJS', () => {
  const context = vm.createContext({});
  const source = readFileSync(path.join(__dirname, '..', 'practice-data.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'practice-data.js' });
  const browserData = vm.runInContext('JSON.stringify({ PRACTICE_TOPICS, PRACTICE_QUESTIONS })', context);
  assert.deepEqual(JSON.parse(browserData), { PRACTICE_TOPICS, PRACTICE_QUESTIONS });
});
