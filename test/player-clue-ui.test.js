'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const clientScript = new vm.Script(readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8'), { filename: 'app.js' });

function renderClue(clueOverrides = {}, { isConnected = true, hostConnected = true, role = 'player' } = {}) {
  const nodes = new Map();
  const node = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, {
      innerHTML: '', textContent: '', value: '', hidden: false, disabled: false,
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
    });
    return nodes.get(selector);
  };
  const you = { id: 'you', name: 'You', connected: true, score: 600 };
  const other = { id: 'other', name: 'Maya', connected: true, score: 400 };
  const currentClue = {
    phase: 'clue', category: 'Sports', question: 'How many yards?', value: 600,
    dailyDouble: false, dailyPlayerId: null, buzzOpen: true, revealed: false,
    buzzes: [], ineligiblePlayerIds: [], responderPlayerId: null, selfJudgePlayerId: null,
    canOpenAnswer: false, ...clueOverrides,
  };
  const context = vm.createContext({
    document: { body: node('body'), querySelector: node, querySelectorAll: () => [], addEventListener() {} },
    window: { location: { origin: 'http://127.0.0.1:3000', hostname: '127.0.0.1', search: '' }, addEventListener() {} },
    io: () => ({ on() {}, connect() {} }),
    localStorage: { getItem: () => null }, sessionStorage: { getItem: () => null },
    URLSearchParams, AbortSignal, fetch: () => new Promise(() => {}),
    fixtureRoom: { phase: 'board', role, you, players: [you, other], hostConnected, currentClue },
    fixtureConnected: isConnected,
  });
  clientScript.runInContext(context);
  return vm.runInContext(`
    roomState = fixtureRoom;
    connected = fixtureConnected;
    ({
      html: renderPlayerClue(roomState.currentClue),
      keyboardBuzz: canBuzzWithKeyboard({ repeat: false }),
      keyboardBuzzOnSummary: canBuzzWithKeyboard({ target: { matches: (selector) => selector.split(', ').includes('summary') } }),
    });
  `, context);
}

function assertInactive(result) {
  assert.doesNotMatch(result.html, /data-action="buzz"/);
  assert.equal(result.keyboardBuzz, false);
  assert.match(result.html, /role="dialog"[^>]*aria-labelledby="player-clue-question"/);
}

test('available players get an enabled buzzer and the spacebar shortcut', () => {
  const { html, keyboardBuzz } = renderClue();
  const buzzer = html.match(/<button[^>]*data-action="buzz"[^>]*>/)?.[0];
  assert.ok(buzzer);
  assert.doesNotMatch(buzzer, /disabled/);
  assert.equal(keyboardBuzz, true);
});

test('an answered player gets one status instead of a disabled buzzer', () => {
  const result = renderClue({
    ineligiblePlayerIds: ['you'], responderPlayerId: 'other',
    buzzes: [{ playerId: 'other', name: 'Maya', position: 1 }],
  });
  assertInactive(result);
  assert.match(result.html, /role="status"/);
  assert.equal((result.html.match(/class="player-turn-state is-locked"/g) || []).length, 1);
  assert.match(result.html, /answered this clue/);
  assert.match(result.html, /Maya/);
  assert.doesNotMatch(result.html, /LOCKED OUT/);
});

test('queued players keep their position while the active player checks privately', () => {
  const result = renderClue({
    buzzOpen: false, responderPlayerId: 'other', selfJudgePlayerId: 'other',
    buzzes: [{ playerId: 'other', name: 'Maya', position: 1 }, { playerId: 'you', name: 'You', position: 2 }],
  });
  assertInactive(result);
  assert.match(result.html, /is-queued/);
  assert.match(result.html, /You’re next/);
  assert.match(result.html, /<span>2<\/span>You/);
  assert.match(result.html, /Maya/);
  assert.doesNotMatch(result.html, /data-action="(?:open-player-answer|self-score-clue)"/);
});

test('later queued players see their actual position rather than being told they are next', () => {
  const result = renderClue({
    responderPlayerId: 'other',
    buzzes: [{ playerId: 'other', name: 'Maya', position: 1 }, { playerId: 'third', name: 'Alex', position: 2 }, { playerId: 'you', name: 'You', position: 3 }],
  });
  assertInactive(result);
  assert.match(result.html, /#3/);
  assert.doesNotMatch(result.html, /You’re next/);
});

test('the active player gets the answer-check action rather than a buzzer', () => {
  const result = renderClue({
    responderPlayerId: 'you', canOpenAnswer: true,
    buzzes: [{ playerId: 'you', name: 'You', position: 1 }],
  });
  assertInactive(result);
  assert.match(result.html, /self-judge-panel is-ready/);
  const checkButton = result.html.match(/<button[^>]*data-action="open-player-answer"[^>]*>/)?.[0];
  assert.ok(checkButton);
  assert.doesNotMatch(checkButton, /disabled/);
  assert.doesNotMatch(result.html, /data-action="self-score-clue"/);

  const waiting = renderClue({
    responderPlayerId: 'you', canOpenAnswer: false,
    buzzes: [{ playerId: 'you', name: 'You', position: 1 }],
  });
  assert.match(waiting.html, /data-action="open-player-answer" disabled/);
});

test('private answers and scoring actions render only for the active player', () => {
  const privateClue = {
    buzzOpen: false, responderPlayerId: 'you', selfJudgePlayerId: 'you', privateAnswer: '109 yards',
    buzzes: [{ playerId: 'you', name: 'You', position: 1 }],
  };
  const result = renderClue(privateClue);
  assertInactive(result);
  assert.match(result.html, /109 yards/);
  assert.match(result.html, /aria-labelledby="private-answer-label"/);
  assert.match(result.html, /data-action="self-score-clue" data-correct="true"/);
  assert.match(result.html, /data-action="self-score-clue" data-correct="false"/);

  const spectator = renderClue({ ...privateClue, responderPlayerId: 'other', selfJudgePlayerId: 'other' });
  assertInactive(spectator);
  assert.doesNotMatch(spectator.html, /109 yards|data-action="self-score-clue"/);
});

test('Daily Double spectators cannot buzz or receive queue instructions', () => {
  const result = renderClue({ dailyDouble: true, dailyPlayerId: 'other', responderPlayerId: 'other', buzzOpen: false });
  assertInactive(result);
  assert.match(result.html, /Maya/);
  assert.doesNotMatch(result.html, /Buzz now|Buzz when|join the queue|data-action="open-player-answer"/);
});

test('the Daily Double player retains the private answer-check action', () => {
  const result = renderClue({ dailyDouble: true, dailyPlayerId: 'you', responderPlayerId: 'you', buzzOpen: false, canOpenAnswer: true });
  assertInactive(result);
  assert.match(result.html, /data-action="open-player-answer"/);
});

test('disconnected players get a reconnecting state without an inactive buzzer', () => {
  const result = renderClue({}, { isConnected: false });
  assertInactive(result);
  assert.match(result.html, /role="status"/);
  assert.match(result.html, /reconnect|connection/i);
  assert.doesNotMatch(result.html, /Buzz when you know it/);
});

test('host disconnect pauses buzzing with a clear status', () => {
  const result = renderClue({}, { hostConnected: false });
  assertInactive(result);
  assert.match(result.html, /role="status"/);
  assert.match(result.html, /host|creator/i);
  assert.match(result.html, /reconnect|offline|disconnect|paused/i);
});

test('closed buzzers do not advertise an available buzz action', () => {
  const result = renderClue({ buzzOpen: false });
  assertInactive(result);
  assert.match(result.html, /role="status"/);
  assert.doesNotMatch(result.html, /Buzz when you know it|Buzz now/);
});

test('revealed clues show the public response without stale buzzer or scoring controls', () => {
  const result = renderClue({ revealed: true, buzzOpen: false, answer: '109 yards', ineligiblePlayerIds: ['you'] });
  assertInactive(result);
  assert.match(result.html, /self-judge-panel is-public/);
  assert.match(result.html, /109 yards/);
  assert.doesNotMatch(result.html, /You already answered|data-action="(?:open-player-answer|self-score-clue)"/);
});

test('locked-out players can confirm a skip for the exact displayed clue', () => {
  const result = renderClue({ canSkipClue: true, clueKey: '2:3', ineligiblePlayerIds: ['you'] });
  assertInactive(result);
  assert.match(result.html, /<summary[^>]*>Skip clue<\/summary>/);
  assert.match(result.html, /End this clue for everyone/);
  assert.match(result.html, /data-action="cancel-player-skip"/);
  const button = result.html.match(/<button[^>]*data-action="player-skip-clue"[^>]*>/)?.[0];
  assert.ok(button);
  assert.match(button, /data-clue-key="2:3"/);
  assert.doesNotMatch(button, /disabled/);
  assert.doesNotMatch(result.html, /<details class="player-skip-controls"[^>]*\sopen/);
});

test('player skips remain available while the host is offline but require a server connection', () => {
  const clue = { canSkipClue: true, clueKey: '0:1', ineligiblePlayerIds: ['you'] };
  const hostOffline = renderClue(clue, { hostConnected: false });
  const button = hostOffline.html.match(/<button[^>]*data-action="player-skip-clue"[^>]*>/)?.[0];
  assert.ok(button);
  assert.doesNotMatch(button, /disabled/);
  const disconnected = renderClue(clue, { isConnected: false });
  assert.match(disconnected.html, /data-action="player-skip-clue"[^>]*disabled/);
});

test('unsupported servers and Daily Double wagers do not show player skip controls', () => {
  assert.doesNotMatch(renderClue().html, /player-skip-controls|data-action="player-skip-clue"/);
  assert.doesNotMatch(renderClue({ phase: 'daily-wager', dailyDouble: true, canSkipClue: false }).html, /player-skip-controls|data-action="player-skip-clue"/);
});

test('space on the skip disclosure uses its native action instead of buzzing', () => {
  const result = renderClue({ canSkipClue: true, clueKey: '0:1' });
  assert.equal(result.keyboardBuzz, true);
  assert.equal(result.keyboardBuzzOnSummary, false);
});
