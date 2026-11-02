'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const scripts = ['practice-data.js', 'practice-state.js', 'practice.js'].map((filename) =>
  new vm.Script(readFileSync(path.join(__dirname, '..', filename), 'utf8'), { filename }));
const key = 'jeopardy_practice_v1';
const reviewProgress = {
  version: 1, selectedTopics: ['history'], reviewOnly: true,
  records: { 'history-magna-carta': { attempts: 1, correct: 0, needsReview: true, lastReviewed: 100 } },
};

function startPractice({ saved = null, unavailable = false } = {}) {
  const nodes = new Map();
  const listeners = new Map();
  const values = new Map(saved === null ? [] : [[key, typeof saved === 'string' ? saved : JSON.stringify(saved)]]);
  let focused = null;
  const node = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, {
      innerHTML: '', textContent: '', checked: false, hidden: false,
      classList: { toggle() {} },
      addEventListener: (type, callback) => listeners.set(`${selector}:${type}`, callback),
      querySelector: (child) => node(`${selector} ${child}`),
      querySelectorAll: () => [],
      focus: () => { focused = selector; },
    });
    return nodes.get(selector);
  };
  const context = vm.createContext({
    document: { querySelector: node },
    window: {
      addEventListener: (type, callback) => listeners.set(`window:${type}`, callback),
      matchMedia: () => ({ matches: false }),
    },
    localStorage: {
      getItem(name) {
        if (unavailable) throw new Error('Storage denied');
        return values.get(name) ?? null;
      },
      setItem(name, value) {
        if (unavailable) throw new Error('Storage denied');
        values.set(name, value);
      },
    },
  });
  scripts.forEach((script) => script.runInContext(context));
  return {
    node, values,
    evaluate: (source) => vm.runInContext(source, context),
    focus: () => focused,
    click(action) {
      listeners.get('#question-area:click')({ target: { closest: () => ({ dataset: { practiceAction: action } }) } });
    },
    storage(progress) {
      listeners.get('window:storage')({ key, newValue: JSON.stringify(progress) });
    },
  };
}

test('reload restores saved reviews, filters, and visible progress', () => {
  const client = startPractice({ saved: reviewProgress });
  assert.equal(client.evaluate('practiceQuestion.id'), 'history-magna-carta');
  assert.equal(client.node('#review-only').checked, true);
  assert.equal(client.node('#topic-selection-count').textContent, '1 selected');
  assert.equal(client.node('#studied-count').textContent, 1);
  assert.equal(client.node('#review-count').textContent, 1);
  assert.match(client.node('#question-area').innerHTML, /King John/);
  client.click('reveal');
  client.click('known');
  const reloaded = startPractice({ saved: client.values.get(key) });
  assert.equal(reloaded.node('#review-count').textContent, 0);
  assert.match(reloaded.node('#question-area').innerHTML, /caught up/);
});

test('unavailable storage shows its notice while practice and scoring remain usable', () => {
  const client = startPractice({ unavailable: true });
  assert.match(client.node('#save-note').textContent, /unavailable.*only for this visit/);
  const firstId = client.evaluate('practiceQuestion.id');
  client.click('reveal');
  assert.equal(client.node('#question-area #practice-answer').hidden, false);
  client.click('review');
  assert.equal(client.evaluate(`practiceProgress.records[${JSON.stringify(firstId)}].attempts`), 1);
  assert.equal(client.node('#review-count').textContent, 1);
  assert.notEqual(client.evaluate('practiceQuestion.id'), firstId);
  assert.match(client.node('#save-note').textContent, /unavailable/);
});

test('malformed saved JSON resets practice without falsely reporting unavailable storage', () => {
  const client = startPractice({ saved: '{broken' });
  assert.ok(client.evaluate('practiceQuestion'));
  assert.equal(client.node('#save-note').textContent, 'Progress saves in this browser.');
  client.click('reveal');
  client.click('known');
  assert.equal(Object.keys(JSON.parse(client.values.get(key)).records).length, 1);
});

test('cross-tab topic restoration replaces an empty question area', () => {
  const client = startPractice({ saved: { selectedTopics: [] } });
  assert.equal(client.evaluate('practiceQuestion'), null);
  assert.match(client.node('#question-area').innerHTML, /Choose a topic/);
  client.storage({ selectedTopics: ['history'], records: {} });
  assert.equal(client.evaluate('practiceQuestion.topic'), 'history');
  assert.match(client.node('#question-area').innerHTML, /practice-question-title/);
});

test('cross-tab saved misses replace an empty review state', () => {
  const client = startPractice({ saved: { selectedTopics: ['history'], reviewOnly: true } });
  assert.equal(client.evaluate('practiceQuestion'), null);
  client.storage(reviewProgress);
  assert.equal(client.evaluate('practiceQuestion.id'), 'history-magna-carta');
  assert.equal(client.node('#review-count').textContent, 1);
});

test('stale and repeated rating clicks cannot score an unrevealed question', () => {
  const client = startPractice();
  client.click('known');
  client.click('review');
  assert.equal(client.evaluate('Object.keys(practiceProgress.records).length'), 0);
  const firstId = client.evaluate('practiceQuestion.id');
  client.click('reveal');
  client.click('known');
  const nextId = client.evaluate('practiceQuestion.id');
  client.click('known');
  client.click('review');
  assert.equal(client.evaluate(`practiceProgress.records[${JSON.stringify(firstId)}].attempts`), 1);
  assert.equal(client.evaluate(`practiceProgress.records[${JSON.stringify(nextId)}]`), undefined);
  assert.equal(client.evaluate('Object.keys(practiceProgress.records).length'), 1);
  client.click('reveal');
  client.click('skip');
  client.click('review');
  assert.equal(client.evaluate('Object.keys(practiceProgress.records).length'), 1);
});

test('empty-state actions focus the new question heading', () => {
  for (const [saved, action] of [
    [{ selectedTopics: [] }, 'all-topics'],
    [{ reviewOnly: true }, 'mixed'],
  ]) {
    const client = startPractice({ saved });
    client.click(action);
    assert.ok(client.evaluate('practiceQuestion'));
    assert.equal(client.focus(), '#question-area h2');
  }
});
