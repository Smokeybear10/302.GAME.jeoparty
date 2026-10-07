'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { loadGames, catalogGames } = require('../lib/game-store');
const { RoomManager } = require('../lib/room-manager');

const clientSource = readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      const callbacks = listeners.get(type) || [];
      callbacks.push(listener);
      listeners.set(type, callbacks);
    },
    dispatch(type, event) {
      for (const listener of listeners.get(type) || []) listener(event);
    },
  };
}

function element() {
  const classes = new Set();
  return {
    ...eventTarget(),
    innerHTML: '',
    textContent: '',
    value: '',
    disabled: false,
    hidden: false,
    dataset: {},
    classList: {
      add: (...tokens) => tokens.forEach((token) => classes.add(token)),
      remove: (...tokens) => tokens.forEach((token) => classes.delete(token)),
      contains: (token) => classes.has(token),
      toggle(token, force) {
        const enabled = force ?? !classes.has(token);
        if (enabled) classes.add(token);
        else classes.delete(token);
        return enabled;
      },
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    contains: () => false,
    getClientRects: () => [{}],
    focus() {},
  };
}

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

function startClient(fetchResponse = () => new Promise(() => {}), { connectImmediately = true, search = '' } = {}) {
  const nodes = new Map();
  const operations = [];
  const scrollPositions = [];
  const socketListeners = new Map();
  const node = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, element());
    return nodes.get(selector);
  };
  const document = {
    ...eventTarget(),
    body: element(),
    activeElement: null,
    querySelector: node,
    querySelectorAll: () => [],
  };
  const socket = {
    on: (type, listener) => socketListeners.set(type, listener),
    connect() {
      operations.push('connect');
      if (connectImmediately) socketListeners.get('connect')();
    },
  };
  const context = vm.createContext({
    document,
    window: {
      location: { origin: 'http://127.0.0.1:3000', hostname: '127.0.0.1', search },
      scrollTo: (x, y) => scrollPositions.push([x, y]),
    },
    io: () => socket,
    localStorage: storage(),
    sessionStorage: storage(),
    URLSearchParams,
    AbortSignal,
    CSS: { escape: (value) => value },
    fetch(url, options) {
      operations.push(url);
      assert.ok(options.signal instanceof AbortSignal);
      return fetchResponse(url, options);
    },
  });
  new vm.Script(clientSource, { filename: 'app.js' }).runInContext(context);
  return { document, node, operations, scrollPositions, emit: (type, state) => socketListeners.get(type)(state), evaluate: (source) => vm.runInContext(source, context) };
}

const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

test('app.js parses as a classic browser script, without a CommonJS wrapper', () => {
  assert.doesNotThrow(() => new vm.Script(clientSource, { filename: 'app.js' }));
});

test('multiplayer connects before pending archive and network metadata requests', () => {
  const client = startClient();
  assert.deepEqual(client.operations, ['connect', '/api/games', '/api/network']);
  assert.equal(client.node('#join-room-button').disabled, false);
  assert.equal(client.node('#create-room-button').disabled, false);
});

test('connection status distinguishes first connection from reconnecting', () => {
  const client = startClient(undefined, { connectImmediately: false });
  assert.equal(client.node('#connection-label').textContent, 'Connecting…');
  assert.equal(client.node('#join-room-button').disabled, true);
  client.emit('connect');
  assert.equal(client.node('#connection-label').textContent, '');
  assert.equal(client.node('#join-room-button').disabled, false);
  client.emit('disconnect');
  assert.equal(client.node('#connection-label').textContent, 'Connection lost. Reconnecting…');
  assert.equal(client.node('#join-room-button').disabled, true);
});

test('opening an invite sanitizes and prefills its room code and presents the join screen', () => {
  const client = startClient(undefined, { search: '?room=%20a-bc1d9!' });
  assert.equal(client.node('#join-code').value, 'ABC1D');
  assert.equal(client.node('#landing-title').textContent, 'Join game');
  assert.equal(client.node('#invite-intro').hidden, false);
  assert.equal(client.node('#landing-screen').classList.contains('is-invite'), true);
  assert.equal(client.node('#join-room-button').disabled, false);
});

test('ordinary visits and empty sanitized invite codes keep the full game lobby', () => {
  for (const search of ['', '?room=%3C%3E%20']) {
    const client = startClient(undefined, { search });
    assert.equal(client.node('#join-code').value, '');
    assert.equal(client.node('#landing-title').textContent, 'Game lobby');
    assert.equal(client.node('#invite-intro').hidden, true);
    assert.equal(client.node('#landing-screen').classList.contains('is-invite'), false);
  }
});

test('the host lobby displays the LAN invite with its room code', () => {
  const client = startClient();
  const games = loadGames();
  const manager = new RoomManager({ games });
  const session = manager.createRoom('creator');
  client.evaluate("networkUrls = ['http://localhost:3000', 'http://192.168.1.10:3000'];");
  client.emit('room:state', manager.stateFor('creator', catalogGames(games)));
  assert.ok(client.node('#room-content').innerHTML.includes(`<code>192.168.1.10:3000/?room=${session.code}</code>`));
});

test('public HTTPS invites use the website address without same-Wi-Fi instructions', () => {
  const client = startClient();
  client.evaluate(`
    window.location = { protocol: 'https:', hostname: 'jeopardy.example', origin: 'https://jeopardy.example' };
    networkUrls = ['http://localhost:10000', 'http://10.0.0.1:10000'];
    renderPublicLobby();
  `);
  assert.equal(client.node('#landing-network-address').textContent, 'jeopardy.example');
  assert.equal(client.node('#landing-network-help').textContent, 'Share this address with your players:');
  const games = loadGames();
  const manager = new RoomManager({ games });
  const session = manager.createRoom('creator');
  client.emit('room:state', manager.stateFor('creator', catalogGames(games)));
  const lobby = client.node('#room-content').innerHTML;
  assert.ok(lobby.includes(`<code>jeopardy.example/?room=${session.code}</code>`));
  assert.ok(!lobby.includes('same Wi-Fi'));
});

test('invites replace IPv6 localhost with the LAN address and preserve an existing LAN origin', () => {
  const client = startClient();
  client.evaluate(`
    roomState = { code: 'ABCDE' };
    networkUrls = ['http://localhost:3000', 'http://192.168.1.10:3000'];
    window.location.hostname = '[::1]';
    window.location.origin = 'http://[::1]:3000';
  `);
  assert.equal(client.evaluate('inviteUrl()'), 'http://192.168.1.10:3000/?room=ABCDE');
  client.evaluate(`
    window.location.hostname = '10.0.0.20';
    window.location.origin = 'http://10.0.0.20:3000';
  `);
  assert.equal(client.evaluate('inviteUrl()'), 'http://10.0.0.20:3000/?room=ABCDE');
});

test('copying an invite reports success after the Clipboard API writes the link', async () => {
  const client = startClient();
  client.evaluate(`
    roomState = { code: 'ABCDE' };
    let clipboardValue;
    let copyNotice;
    globalThis.navigator = { clipboard: { async writeText(value) { clipboardValue = value; } } };
    showToast = (...args) => { copyNotice = args; };
  `);
  await client.evaluate('copyInvite()');
  assert.equal(client.evaluate('clipboardValue'), 'http://127.0.0.1:3000/?room=ABCDE');
  assert.equal(client.evaluate('copyNotice[1]'), 'success');
});

for (const outcome of ['success', 'false', 'throw']) {
  test(`legacy invite copying handles ${outcome}, removes its textarea, and restores focus`, async () => {
    const client = startClient();
    client.evaluate(`
      roomState = { code: 'ABCDE' };
      globalThis.navigator = {};
      let copyTextarea;
      let copyNotice;
      let copyPrompt;
      let restoredFocus = 0;
      document.activeElement = { focus() { restoredFocus += 1; } };
      document.createElement = () => (copyTextarea = {
        style: {}, focus() {}, select() {}, remove() { this.removed = true; },
      });
      document.body.appendChild = () => {};
      document.execCommand = () => {
        if (${JSON.stringify(outcome)} === 'throw') throw new Error('Copy is blocked');
        return ${JSON.stringify(outcome)} === 'success';
      };
      window.prompt = (...args) => { copyPrompt = args; return null; };
      showToast = (...args) => { copyNotice = args; };
    `);
    await client.evaluate('copyInvite()');
    assert.equal(client.evaluate('copyTextarea.removed'), true);
    assert.equal(client.evaluate('restoredFocus'), 1);
    if (outcome === 'success') {
      assert.equal(client.evaluate('copyNotice[1]'), 'success');
      assert.equal(client.evaluate('copyPrompt'), undefined);
    } else {
      assert.equal(client.evaluate('copyNotice'), undefined);
      assert.deepEqual(JSON.parse(client.evaluate('JSON.stringify(copyPrompt)')), [
        'Copy this player link:', 'http://127.0.0.1:3000/?room=ABCDE',
      ]);
    }
  });
}

test('room resume restores the selected episode without sending UI preferences to the server', async () => {
  const client = startClient();
  const games = loadGames();
  const manager = new RoomManager({ games });
  const session = manager.createRoom('creator');
  const state = manager.stateFor('creator', catalogGames(games));
  client.evaluate(`
    saveSession(${JSON.stringify(session)});
    setPreferredGame(${JSON.stringify(games[1].id)});
    preferredGameId = '';
    let resumePayload;
    request = async (event, payload) => {
      resumePayload = payload;
      return ${JSON.stringify({ session, state })};
    };
  `);
  await client.evaluate('resumeSavedSession()');
  assert.equal(client.evaluate('preferredGameId'), games[1].id);
  assert.equal(client.evaluate('savedSession().preferredGameId'), games[1].id);
  assert.deepEqual(JSON.parse(client.evaluate('JSON.stringify(resumePayload)')), { code: session.code, token: session.token });
  assert.match(client.node('#room-content').innerHTML, new RegExp(`data-game-id="${games[1].id}"[^>]*>Start game`));

  client.evaluate("setPreferredGame('removed-board'); preferredGameId = '';");
  await client.evaluate('resumeSavedSession()');
  assert.equal(client.evaluate('preferredGameId'), '', 'a missing board must not remain selected');
});

test('creating a new room stores its episode instead of the previous room selection', async () => {
  const client = startClient();
  const games = loadGames();
  const manager = new RoomManager({ games });
  const session = manager.createRoom('creator');
  const state = manager.stateFor('creator', catalogGames(games));
  client.evaluate(`
    preferredGameId = 'previous-room-board';
    showToast = () => {};
    request = async () => (${JSON.stringify({ session, state })});
  `);
  await client.evaluate(`createRoom(${JSON.stringify(games[0].id)})`);
  assert.equal(client.evaluate('savedSession().preferredGameId'), games[0].id);
  await client.evaluate('createRoom()');
  assert.equal(client.evaluate('savedSession().preferredGameId'), '');
});

test('joining shows pending feedback, blocks duplicate submissions, and keeps errors inline', async () => {
  const client = startClient();
  client.node('#join-code').value = 'ZZZZZ';
  client.node('#join-name').value = 'Alex';
  client.evaluate(`
    let rejectJoin;
    let joinRequests = 0;
    request = () => { joinRequests += 1; return new Promise((resolve, reject) => { rejectJoin = reject; }); };
    showToast = () => { throw new Error('Join errors should stay in the form'); };
    void joinRoom({ code: elements.joinCode, name: elements.joinName });
    void joinRoom({ code: elements.joinCode, name: elements.joinName });
  `);
  assert.equal(client.evaluate('joinRequests'), 1);
  assert.equal(client.node('#join-room-button').disabled, true);
  assert.equal(client.node('#join-room-button').textContent, 'Joining…');
  assert.equal(client.node('#join-room-form').ariaBusy, 'true');
  client.evaluate("rejectJoin(Object.assign(new Error('Room not found. Check the code and try again.'), { code: 'ROOM_NOT_FOUND' }));");
  await flushAsync();
  assert.equal(client.node('#join-room-button').disabled, false);
  assert.equal(client.node('#join-room-button').textContent, 'Join room');
  assert.equal(client.node('#join-room-form').ariaBusy, 'false');
  assert.equal(client.node('#join-error').hidden, false);
  assert.match(client.node('#join-error').textContent, /Room not found/);
  assert.equal(client.node('#join-code').ariaInvalid, 'true');
  assert.equal(client.node('#join-name').value, 'Alex');
  client.node('#join-code').dispatch('input');
  assert.equal(client.node('#join-error').hidden, true);
  assert.equal(client.node('#join-code').ariaInvalid, 'false');
});

test('duplicate player names identify the name field and can be corrected', async () => {
  const client = startClient();
  client.evaluate(`request = async () => { throw Object.assign(new Error('That name is already in this room.'), { code: 'NAME_TAKEN' }); };`);
  await client.evaluate("joinRoom({ code: { value: 'ABCDE' }, name: { value: 'Alex' } })");
  assert.equal(client.node('#join-name').ariaInvalid, 'true');
  assert.equal(client.node('#join-code').ariaInvalid, 'false');
  assert.match(client.node('#join-error').textContent, /already in this room/);
  client.node('#join-name').dispatch('input');
  assert.equal(client.node('#join-error').hidden, true);
  assert.equal(client.node('#join-name').ariaInvalid, 'false');
});

test('page scroll resets only when entering another room or top-level game phase', () => {
  const client = startClient();
  const games = loadGames();
  const manager = new RoomManager({ games });
  manager.createRoom('creator');
  manager.joinHostAsPlayer('creator', { name: 'Alex' });
  const render = () => client.emit('room:state', manager.stateFor('creator', catalogGames(games)));
  assert.deepEqual(client.scrollPositions, [], 'initial landing render must preserve page position');
  render();
  assert.deepEqual(client.scrollPositions, [[0, 0]]);
  render();
  assert.equal(client.scrollPositions.length, 1, 'presence updates must not reset scroll');

  manager.startGame('creator', games[0].id);
  render();
  assert.equal(client.scrollPositions.length, 2);
  const location = games[0].categories.flatMap((category, categoryIndex) => category.clues.map((clue, clueIndex) => ({ categoryIndex, clueIndex, clue }))).find(({ clue }) => !clue.dailyDouble);
  manager.openClue('creator', location);
  render();
  manager.buzz('creator');
  render();
  const clueKey = manager.stateFor('creator', []).currentClue.clueKey;
  manager.openPlayerAnswer('creator', { clueKey });
  render();
  manager.selfScoreClue('creator', { clueKey, correct: true });
  render();
  assert.equal(client.scrollPositions.length, 2, 'clue phases must not reset page scroll');

  manager.startFinal('creator');
  render();
  assert.equal(client.scrollPositions.length, 3);
  manager.submitFinalWager('creator', 100);
  manager.advanceFinal('creator');
  render();
  assert.equal(client.scrollPositions.length, 3, 'Final submission steps stay within the same page');
  client.emit('room:state', { ...manager.stateFor('creator', []), code: 'OTHER' });
  assert.equal(client.scrollPositions.length, 4, 'switching room resets scroll even in the same phase');
});

test('archive errors leave joining available and the retry control reloads games', async () => {
  let archiveRequests = 0;
  const game = { id: 'test-game', title: 'Recovered board', description: 'Test', categories: ['Science'], difficulty: 'Mixed', year: 2026 };
  const client = startClient(async (url) => {
    if (url === '/api/network') return { ok: true, json: async () => ({ urls: [] }) };
    archiveRequests += 1;
    if (archiveRequests === 1) return { ok: false };
    return { ok: true, json: async () => [game] };
  });
  await flushAsync();
  assert.equal(client.node('#public-game-count').textContent, 'Archive unavailable');
  assert.match(client.node('#public-game-list').innerHTML, /data-catalog-retry/);
  assert.equal(client.node('#join-room-button').disabled, false);

  client.node('#public-game-list').dispatch('click', {
    target: { closest: (selector) => selector === '[data-catalog-retry]' ? {} : null },
  });
  await flushAsync();
  assert.equal(archiveRequests, 2);
  assert.match(client.node('#public-game-list').innerHTML, /Recovered board/);
  assert.doesNotMatch(client.node('#public-game-list').innerHTML, /data-catalog-retry/);
  assert.equal(client.node('#public-game-count').textContent, '1 board');
});

test('an empty successful archive is not displayed as loading', async () => {
  const client = startClient(async (url) => ({
    ok: true,
    json: async () => url === '/api/games' ? [] : { urls: [] },
  }));
  await flushAsync();
  assert.equal(client.node('#public-game-count').textContent, '0 boards match');
  assert.doesNotMatch(client.node('#public-game-list').innerHTML, /Loading/);
});

test('Tab from a custom-board textarea follows normal order and wraps at dialog ends', () => {
  const client = startClient();
  const controls = ['button', 'textarea', 'input'].map((tag) => ({
    ...element(),
    matches: (selector) => selector.split(',').some((part) => part.trim().split(':')[0] === tag),
    focus() { client.document.activeElement = this; },
  }));
  const overlay = { querySelectorAll: (selector) => controls.filter((control) => control.matches(selector)) };
  client.node('#room-content').querySelector = () => overlay;
  client.document.activeElement = controls[1];
  let prevented = false;
  client.document.dispatch('keydown', {
    key: 'Tab',
    preventDefault() { prevented = true; },
  });
  assert.equal(prevented, false, 'Tab from a textarea must not jump to the first dialog control');
  assert.equal(client.document.activeElement, controls[1]);

  client.document.activeElement = controls[2];
  client.document.dispatch('keydown', { key: 'Tab', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(client.document.activeElement, controls[0]);
  client.document.dispatch('keydown', { key: 'Tab', shiftKey: true, preventDefault() {} });
  assert.equal(client.document.activeElement, controls[2]);
});

test('Final response drafts survive a presence update without suppressing the render', () => {
  const client = startClient();
  const player = { id: 'p1', name: 'Jordan', score: 1000, connected: true };
  const state = {
    code: 'ABCDE', role: 'player', phase: 'final', hostConnected: true,
    game: { id: 'test-game' }, players: [player], you: player,
    final: {
      phase: 'clue', category: 'Science', clue: 'Name this element.', eligible: true,
      submissions: [{ playerId: 'p1', name: 'Jordan', wagerSubmitted: true, responseSubmitted: false }],
    },
  };
  client.emit('room:state', state);
  const selections = [];
  let focused = false;
  const input = {
    ...element(), id: 'final-response', name: 'response', value: 'What is helium?',
    selectionStart: 8, selectionEnd: 14,
    matches: () => true,
    focus() { focused = true; },
    setSelectionRange: (start, end) => selections.push([start, end]),
  };
  const content = client.node('#room-content');
  content.contains = (target) => target === input;
  content.querySelector = (selector) => selector === '#final-response' ? input : null;
  client.document.activeElement = input;
  content.dispatch('input', { target: input });
  client.emit('room:state', { ...state, hostConnected: false });

  assert.match(content.innerHTML, /Host disconnected/);
  assert.match(content.innerHTML, /value="What is helium\?"/);
  assert.equal(focused, true);
  assert.deepEqual(selections, [[8, 14]]);
  assert.deepEqual(client.scrollPositions, [[0, 0]], 'typing and presence updates must preserve page position');
});

test('creator can opt in, buzz privately, and transfer the playable board to a remote contestant', () => {
  const client = startClient();
  const games = loadGames();
  const manager = new RoomManager({ games });
  const host = manager.createRoom('creator');
  const render = (socket = 'creator') => {
    client.emit('room:state', manager.stateFor(socket, catalogGames(games)));
    return client.node('#room-content').innerHTML;
  };
  assert.match(render(), /id="host-contestant-form"/);
  manager.joinHostAsPlayer('creator', { name: 'Alex' });
  manager.joinRoom('remote', { code: host.code, name: 'Maya' });
  assert.match(render(), /Switch to host only/);
  manager.startGame('creator', games[0].id);
  assert.match(render(), /Your pick/);
  assert.match(render(), /class="mobile-board"/);
  const location = games[0].categories.flatMap((category, categoryIndex) => category.clues.map((clue, clueIndex) => ({ categoryIndex, clueIndex, clue }))).find(({ clue }) => !clue.dailyDouble);
  manager.openClue('creator', location);
  assert.match(render(), /data-action="buzz"/);
  assert.equal(client.evaluate('canBuzzWithKeyboard({})'), true);
  manager.buzz('creator');
  assert.match(render(), /Check my response/);
  const clueKey = manager.stateFor('creator', []).currentClue.clueKey;
  manager.openPlayerAnswer('creator', { clueKey });
  assert.match(render(), /aria-labelledby="private-answer-label"/);
  assert.match(render(), /data-action="self-score-clue"/);
  manager.selfScoreClue('creator', { clueKey, correct: false });
  manager.buzz('remote');
  manager.openPlayerAnswer('remote', { clueKey });
  assert.doesNotMatch(render(), /aria-labelledby="private-answer-label"/);
  manager.selfScoreClue('remote', { clueKey, correct: true });
  assert.match(render(), /Maya picks next/);
  const remoteBoard = render('remote');
  assert.match(remoteBoard, /Your pick/);
  const availableTiles = [...remoteBoard.matchAll(/<button\s+class="clue-tile [\s\S]*?<\/button>/g)].filter(([tile]) => !tile.includes('disabled'));
  assert.equal(availableTiles.length, 58, '29 remaining clues appear in desktop and mobile boards');
});

test('creator can enter Daily Double and Final wagers, responses, and self-judgments', () => {
  const client = startClient();
  const games = loadGames();
  const manager = new RoomManager({ games });
  manager.createRoom('creator');
  manager.joinHostAsPlayer('creator', { name: 'Alex' });
  manager.startGame('creator', games[0].id);
  const render = () => {
    client.emit('room:state', manager.stateFor('creator', catalogGames(games)));
    return client.node('#room-content').innerHTML;
  };
  const location = games[0].categories.flatMap((category, categoryIndex) => category.clues.map((clue, clueIndex) => ({ categoryIndex, clueIndex, clue }))).find(({ clue }) => clue.dailyDouble);
  manager.openClue('creator', location);
  assert.match(render(), /id="daily-wager-form"/);
  const creatorId = manager.stateFor('creator', []).you.id;
  manager.setDailyDouble('creator', { playerId: creatorId, wager: 500 });
  assert.match(render(), /data-action="open-player-answer"/);
  const clueKey = manager.stateFor('creator', []).currentClue.clueKey;
  manager.openPlayerAnswer('creator', { clueKey });
  manager.selfScoreClue('creator', { clueKey, correct: true });
  manager.startFinal('creator');
  assert.match(render(), /id="final-wager-form"/);
  assert.match(render(), /data-action="advance-final" disabled/);
  manager.submitFinalWager('creator', 100);
  assert.doesNotMatch(render(), /data-action="advance-final" disabled/);
  manager.advanceFinal('creator');
  assert.match(render(), /id="final-response-form"/);
  manager.submitFinalResponse('creator', 'My response');
  manager.advanceFinal('creator');
  assert.match(render(), /data-action="self-score-final"/);
  assert.match(render(), /data-action="finish-final" disabled/);
  manager.selfScoreFinal('creator', { correct: true });
  assert.doesNotMatch(render(), /data-action="finish-final" disabled/);
  manager.finishFinal('creator');
  assert.match(render(), /FINAL SCORES/);
});
