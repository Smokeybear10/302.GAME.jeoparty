'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const PartyState = require('../party-state');

const scripts = ['party-state.js', 'party.js'].map((filename) => new vm.Script(
  readFileSync(path.join(__dirname, '..', filename), 'utf8'), { filename }));
const storageKey = 'jeoparty_party_v1';
const board = {
  id: 'history', title: 'History', description: '', boardVersion: '123456abcdef',
  categories: [
    { name: 'Cities', clues: [{ value: 200, prompt: 'French capital?', answer: 'Paris' }, { value: 400, prompt: 'Italian capital?', answer: 'Rome' }] },
    { name: 'Math', clues: [{ value: 200, prompt: 'Two plus two?', answer: 'Four' }, { value: 400, prompt: 'Two squared?', answer: 'Four' }] },
  ],
};
const randomBoard = { ...board, id: 'random', title: 'Random Board', seed: 'fixed-seed', poolVersion: 'abcdef123456' };
delete randomBoard.boardVersion;

async function startClient({ saved = null, url = 'https://jeoparty.test/party', storageDenied = false, resolveFetch, clipboardDenied = false, confirm = true } = {}) {
  const nodes = new Map();
  const listeners = new Map();
  const storage = new Map(saved === null ? [] : [[storageKey, typeof saved === 'string' ? saved : JSON.stringify(saved)]]);
  const requests = [];
  const copied = [];
  const prompted = [];
  let focused = null;
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      innerHTML: '', textContent: '', hidden: false, disabled: false, value: '', open: false,
      style: { setProperty() {} }, classList: { toggle() {} },
      addEventListener: (type, callback) => listeners.set(`${id}:${type}`, callback),
      querySelector: (selector) => node(`${id} ${selector}`),
      focus: () => { focused = id; },
      close() { this.open = false; }, showModal() { this.open = true; },
    });
    return nodes.get(id);
  };
  const browser = {
    location: new URL(url),
    history: { replaceState(_state, _title, next) { browser.location = new URL(next, browser.location); } },
    confirm: () => confirm,
    prompt: (_message, value) => { prompted.push(value); return null; },
  };
  const context = vm.createContext({
    URL, window: browser,
    document: { getElementById: node, addEventListener: (type, callback) => listeners.set(`document:${type}`, callback) },
    navigator: { clipboard: { async writeText(value) { if (clipboardDenied) throw new Error('Clipboard denied'); copied.push(value); } } },
    localStorage: {
      getItem(key) { if (storageDenied) throw new Error('Storage denied'); return storage.get(key) ?? null; },
      setItem(key, value) { if (storageDenied) throw new Error('Storage denied'); storage.set(key, value); },
    },
    async fetch(request) {
      requests.push(request);
      if (resolveFetch) {
        const custom = resolveFetch(request);
        if (custom) return custom;
      }
      const body = request === '/api/party/games' ? [{ id: board.id, title: board.title }]
        : request.startsWith('/api/party/random') ? randomBoard : board;
      return { ok: true, async json() { return structuredClone(body); } };
    },
  });
  scripts[0].runInContext(context);
  await scripts[1].runInContext(context);
  return {
    node, storage, requests, copied, prompted,
    evaluate: (source) => vm.runInContext(source, context),
    state: () => JSON.parse(vm.runInContext('JSON.stringify(partyState)', context)),
    focus: () => focused,
    event(id, type, event = {}) { return listeners.get(`${id}:${type}`)({ preventDefault() {}, target: {}, ...event }); },
    open(key) { return this.event('party-board', 'click', { target: { closest: () => ({ disabled: false, dataset: { clue: key } }) } }); },
    score(key, player, correct) { return this.event('score-actions', 'click', { target: { closest: () => ({ dataset: { scoreKey: key, scorePlayer: player, correct: String(correct) } }) } }); },
    key(key, code, extras = {}) { return this.event('document', 'keydown', { key, code, repeat: false, shiftKey: false, target: { tagName: 'BODY' }, ...extras }); },
  };
}

test('setup, reveal, adjudication, and reload keep the actual selected board and score', async () => {
  const client = await startClient();
  await client.event('party-setup-form', 'submit');
  assert.equal(client.node('party-game').hidden, false);
  client.open('0:1');
  assert.equal(client.node('clue-dialog').open, true);
  assert.equal(client.node('clue-answer-text').textContent, '');
  client.event('reveal-answer', 'click');
  assert.equal(client.node('clue-answer-text').textContent, 'Rome');
  client.score('0:1', 'p1', true);
  assert.equal(client.state().players[0].score, 400);
  assert.equal(client.node('clue-dialog').open, false);
  const reloaded = await startClient({ saved: client.storage.get(storageKey) });
  assert.equal(reloaded.node('party-game').hidden, false);
  assert.equal(reloaded.state().board.boardVersion, board.boardVersion);
  assert.equal(reloaded.state().players[0].score, 400);
  assert.deepEqual(reloaded.state().used, ['0:1']);
});

test('an open revealed random clue survives reload without regenerating its board', async () => {
  let saved = PartyState.createState(randomBoard, ['Alice', 'Bob']);
  saved = PartyState.reduce(saved, { type: 'open', key: '1:1' });
  saved = PartyState.reduce(saved, { type: 'reveal', key: '1:1' });
  const client = await startClient({ saved, url: 'https://jeoparty.test/party?seed=fixed-seed&version=abcdef123456' });
  assert.equal(client.node('clue-dialog').open, true);
  assert.equal(client.node('clue-answer-text').textContent, 'Four');
  assert.equal(client.requests.some((request) => request.startsWith('/api/party/random')), false);
  assert.equal(client.state().board.seed, 'fixed-seed');
});

test('shift-number keyboard scoring deducts the clue value and held or stale inputs cannot score twice', async () => {
  const client = await startClient({ saved: PartyState.createState(board, ['Alice', 'Bob']) });
  client.open('0:0');
  client.key('!', 'Digit1', { shiftKey: true });
  assert.equal(client.state().players[0].score, -200);
  client.key('!', 'Digit1', { shiftKey: true });
  assert.equal(client.state().players[0].score, -200);
  client.open('0:1');
  client.score('0:0', 'p1', true);
  client.key('1', 'Digit1', { repeat: true });
  assert.equal(client.state().players[0].score, -200);
  assert.equal(client.state().activeClue, '0:1');
  client.key('0', 'Digit0');
  assert.deepEqual(client.state().used, ['0:0', '0:1']);
  assert.equal(client.state().players[0].score, -200);
});

test('blocked storage does not prevent play and clearly explains persistence is unavailable', async () => {
  const client = await startClient({ storageDenied: true });
  client.event('party-setup-form', 'submit');
  client.open('0:0');
  client.score('0:0', 'p1', true);
  assert.equal(client.state().players[0].score, 200);
  assert.match(client.node('party-save-note').textContent, /unavailable.*only for this visit/);
});

test('malformed saved JSON falls back to setup, and completing a board announces a tie', async () => {
  const client = await startClient({ saved: '{broken' });
  assert.equal(client.state(), null);
  assert.equal(client.node('party-save-note').textContent, 'Your game saves in this browser.');
  client.event('party-setup-form', 'submit');
  for (const key of PartyState.allClueKeys(board)) {
    client.open(key);
    client.event('skip-clue', 'click');
  }
  assert.equal(client.node('party-results').hidden, false);
  assert.equal(client.node('results-title').textContent, 'A 2-way tie');
  assert.equal(client.focus(), 'results-title');
  client.event('play-again', 'click');
  assert.equal(client.node('party-results').hidden, true);
  assert.deepEqual(client.state().used, []);
});

test('random and themed links share a compact, versioned board identity without scores or names', async () => {
  for (const selected of [board, randomBoard]) {
    const client = await startClient({ saved: PartyState.createState(selected, ['Private Alice', 'Private Bob']) });
    await client.event('share-game', 'click');
    const shared = new URL(client.copied[0]);
    assert.equal(shared.pathname, '/party');
    assert.equal(shared.searchParams.get('version'), selected.poolVersion ?? selected.boardVersion);
    assert.equal(shared.searchParams.get(selected.seed ? 'seed' : 'board'), selected.seed ?? selected.id);
    assert.ok(client.copied[0].length < 150);
    assert.doesNotMatch(client.copied[0], /Alice|Bob|score|Paris/);
  }
});

test('a blocked clipboard offers a copyable link instead of silently failing', async () => {
  const client = await startClient({ saved: PartyState.createState(board, ['A', 'B']), clipboardDenied: true });
  await client.event('share-game', 'click');
  assert.match(client.prompted[0], /board=history&version=123456abcdef/);
});

test('an expired shared version leaves an existing save untouched and never presents a substituted board', async () => {
  const saved = PartyState.createState(board, ['Alice', 'Bob']);
  const client = await startClient({ saved, url: 'https://jeoparty.test/party?seed=old-seed&version=111111111111', resolveFetch(request) {
    if (request.startsWith('/api/party/random')) return { ok: false, async json() { return { error: 'This shared board uses an older pool. Create a new board.' }; } };
  } });
  assert.equal(client.node('party-setup').hidden, false);
  assert.match(client.node('setup-error').textContent, /older pool/);
  assert.equal(client.node('start-party').disabled, true);
  assert.equal(client.evaluate('partySelectedBoard'), null);
  assert.deepEqual(JSON.parse(client.storage.get(storageKey)), saved);
  assert.ok(client.requests.includes('/api/party/random?seed=old-seed&version=111111111111'));
  client.event('resume-game', 'click');
  assert.equal(client.node('party-game').hidden, false);
  assert.deepEqual(client.state().board, saved.board);
});

test('a new shared theme passes its version to the server but does not replace a saved game without starting', async () => {
  const saved = PartyState.createState(randomBoard, ['Alice', 'Bob']);
  const client = await startClient({ saved, url: 'https://jeoparty.test/party?board=history&version=123456abcdef', confirm: false });
  assert.ok(client.requests.includes('/api/party/games/history?version=123456abcdef'));
  client.event('party-setup-form', 'submit');
  assert.deepEqual(client.state(), saved);
  assert.deepEqual(JSON.parse(client.storage.get(storageKey)), saved);
});

test('player names and board text are escaped, editable, and persisted without treating markup as HTML', async () => {
  const saved = PartyState.createState(board, ['<img src=x>', 'Bob']);
  const client = await startClient({ saved });
  assert.match(client.node('party-scoreboard').innerHTML, /&lt;img src=x&gt;/);
  assert.doesNotMatch(client.node('party-scoreboard').innerHTML, /<img src=x>/);
  client.event('party-scoreboard', 'change', { target: { value: 'Renamed', dataset: { renamePlayer: 'p1' } } });
  assert.equal(client.state().players[0].name, 'Renamed');
  assert.equal(JSON.parse(client.storage.get(storageKey)).players[0].name, 'Renamed');
});
