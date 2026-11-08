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

function startClient(fetchResponse = () => new Promise(() => {}), {
  connectImmediately = true, search = '', localStore = storage(), sessionStore = storage(),
} = {}) {
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
      ...eventTarget(),
      location: { origin: 'http://127.0.0.1:3000', hostname: '127.0.0.1', search },
      scrollTo: (x, y) => scrollPositions.push([x, y]),
    },
    io: () => socket,
    RoomSessions: require('../room-sessions'),
    localStorage: localStore,
    sessionStorage: sessionStore,
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

test('a closed-tab seat is offered explicitly and its credential never appears in the page', async () => {
  const localStore = storage();
  const games = loadGames();
  const manager = new RoomManager({ games });
  const session = manager.createRoom('host');
  manager.joinHostAsPlayer('host', { name: 'Alex' });
  const first = startClient(undefined, { localStore });
  first.evaluate(`roomState = ${JSON.stringify(manager.stateFor('host', catalogGames(games)))}; saveSession(${JSON.stringify(session)});`);
  const second = startClient(undefined, { localStore });
  assert.equal(second.evaluate('savedSession()'), null);
  assert.equal(second.evaluate('roomState'), null);
  assert.equal(second.node('#saved-rooms').hidden, false);
  assert.match(second.node('#saved-rooms-list').innerHTML, /Alex/);
  assert.doesNotMatch(second.node('#saved-rooms-list').innerHTML, new RegExp(session.token));
  second.evaluate(`var resumePayload; request = async (event, payload) => { resumePayload = payload; return ${JSON.stringify({ session, state: manager.stateFor('host', catalogGames(games)) })}; };`);
  second.node('#saved-rooms-list').dispatch('click', { target: { closest: (selector) => selector.includes('data-resume') ? { dataset: { resumeSessionIndex: '0' } } : null } });
  await flushAsync();
  assert.equal(second.evaluate('resumePayload.token'), session.token);
  assert.equal(second.evaluate('savedSession().token'), session.token);
  assert.equal(second.evaluate('roomState.you.name'), 'Alex');
});

test('Continue saves its credential before the request so an interrupted rejoin can reconnect', async () => {
  const localStore = storage();
  const session = new RoomManager({ games: loadGames() }).createRoom('host');
  require('../room-sessions').createStore(localStore).save(session);
  const client = startClient(undefined, { localStore });
  client.evaluate("showToast = () => {}; request = async () => { throw new Error('Connection interrupted'); };");
  await client.evaluate(`resumeSavedSession(${JSON.stringify(session)})`);
  assert.equal(client.evaluate('savedSession().token'), session.token);
  assert.equal(client.evaluate('roomSessions.list().length'), 1);
});

test('an expired Continue entry is removed without discarding a different room', async () => {
  const localStore = storage();
  const manager = new RoomManager({ games: loadGames() });
  const stale = manager.createRoom('stale');
  const valid = manager.createRoom('valid');
  const store = require('../room-sessions').createStore(localStore);
  store.save(stale);
  store.save(valid);
  const client = startClient(undefined, { localStore });
  client.evaluate("request = async () => { throw Object.assign(new Error('Room expired'), {code:'ROOM_NOT_FOUND'}); };");
  await client.evaluate(`resumeSavedSession(${JSON.stringify(stale)})`);
  assert.equal(client.evaluate('roomSessions.list().length'), 1);
  assert.equal(client.evaluate('roomSessions.list()[0].code'), valid.code);
  assert.equal(client.evaluate('savedSession()'), null);
});

test('a hosting handoff updates the saved seat role without losing its player identity', () => {
  const localStore = storage();
  const client = startClient(undefined, { localStore });
  const manager = new RoomManager({ games: loadGames() });
  const host = manager.createRoom('host');
  manager.joinHostAsPlayer('host', { name: 'Alex' });
  const next = manager.joinRoom('next', { code: host.code, name: 'Maya' });
  client.evaluate(`showToast = () => {}; roomState = ${JSON.stringify(manager.stateFor('host', []))}; saveSession(${JSON.stringify(host)});`);
  const transfer = manager.transferHost('host', { playerId: next.playerId });
  client.emit('room:session', { session: transfer.formerHostSession, state: manager.stateFor('host', []), message: 'Hosting passed.' });
  assert.equal(client.evaluate('savedSession().role'), 'player');
  assert.equal(client.evaluate('roomSessions.list()[0].role'), 'player');
  assert.equal(client.evaluate('roomState.you.name'), 'Alex');
  assert.doesNotMatch(client.node('#room-content').innerHTML, /host-transfer-form/);
});

test('quick game selection is retained and sent with the start request', async () => {
  const client = startClient();
  const games = loadGames();
  const manager = new RoomManager({ games });
  const session = manager.createRoom('host');
  manager.joinHostAsPlayer('host', { name: 'Alex' });
  client.evaluate(`saveSession(${JSON.stringify(session)}); preferredGameId = ${JSON.stringify(games[0].id)};`);
  client.emit('room:state', manager.stateFor('host', catalogGames(games)));
  client.node('#room-content').dispatch('change', { target: { id: 'game-mode', value: 'quick' } });
  assert.match(client.node('#room-content').innerHTML, /Choose any 15 clues/);
  assert.equal(client.evaluate('savedSession().preferredGameMode'), 'quick');
  client.evaluate('var startPayload; request = async (event, payload) => { startPayload = payload; return {ok:true}; };');
  client.node('#room-content').dispatch('click', { target: { closest: () => ({ dataset: { action: 'start-game', gameId: games[0].id } }) } });
  await flushAsync();
  assert.equal(client.evaluate('startPayload.mode'), 'quick');
});

test('a completed quick board shows 15 of 15, stops picking, and allows zero-score standings', () => {
  const client = startClient();
  const games = loadGames();
  const manager = new RoomManager({ games });
  const host = manager.createRoom('host');
  manager.joinRoom('player', { code: host.code, name: 'Alex' });
  manager.startGame('host', games[0].id, { mode: 'quick' });
  client.emit('room:state', manager.stateFor('host', []));
  assert.match(client.node('#room-content').innerHTML, /data-action="next-round"[^>]*disabled[^>]*>Final Jeopardy/);
  for (let categoryIndex = 0; categoryIndex < 3; categoryIndex += 1) {
    for (let clueIndex = 0; clueIndex < 5; clueIndex += 1) {
      manager.openClue('host', { categoryIndex, clueIndex });
      manager.skipClue('host');
    }
  }
  client.emit('room:state', manager.stateFor('host', []));
  const html = client.node('#room-content').innerHTML;
  assert.match(html, /Quick game · 15\/15 played/);
  assert.match(html, /data-action="next-round"[^>]*>Final standings/);
  assert.doesNotMatch(html, /data-action="next-round"[^>]*disabled/);
  const tiles = [...html.matchAll(/<button\s+class="clue-tile [\s\S]*?<\/button>/g)];
  assert.ok(tiles.every(([tile]) => tile.includes('disabled')));
});

test('undo controls are host-only and submit the exact scoring action displayed', async () => {
  const client = startClient();
  const games = loadGames();
  const manager = new RoomManager({ games });
  const host = manager.createRoom('host');
  manager.joinRoom('player', { code: host.code, name: 'Alex' });
  manager.startGame('host', games[0].id);
  const location = games[0].categories.flatMap((category, categoryIndex) => category.clues.map((clue, clueIndex) => ({ categoryIndex, clueIndex, clue }))).find(({ clue }) => !clue.dailyDouble);
  manager.openClue('host', location);
  manager.buzz('player');
  const clueKey = manager.stateFor('player', []).currentClue.clueKey;
  manager.openPlayerAnswer('player', { clueKey });
  manager.selfScoreClue('player', { clueKey, correct: false });
  client.emit('room:state', manager.stateFor('host', []));
  const actionId = manager.stateFor('host', []).scoreUndo.id;
  assert.match(client.node('#room-content').innerHTML, /Undo last score/);
  client.evaluate('var undoPayload; request = async (event, payload) => { undoPayload = payload; return {ok:true}; };');
  client.node('#room-content').dispatch('click', { target: { closest: () => ({ dataset: { action: 'undo-score', scoreActionId: actionId } }) } });
  await flushAsync();
  assert.equal(client.evaluate('undoPayload.actionId'), actionId);
  client.emit('room:state', manager.stateFor('player', []));
  assert.doesNotMatch(client.node('#room-content').innerHTML, /Undo last score/);
});

function completedResult(overrides = {}) {
  return {
    id: 'g_0123456789ab', gameId: 'sample-board', title: 'Test episode', custom: false,
    completedAt: 1794171600000, revision: 1,
    players: [
      { id: 'p_111111111111', name: 'Jordan', score: 1200 },
      { id: 'p_222222222222', name: 'Taylor', score: -200 },
    ],
    ...overrides,
  };
}

test('finished games survive room closure and a new browser session without retaining credentials', () => {
  const localStore = storage();
  const result = completedResult({ token: 'do-not-save', response: 'private response' });
  const first = startClient(undefined, { localStore });
  first.evaluate(`rememberCompletedGames({ completedGames: ${JSON.stringify([result])} }); clearSession(); roomState = null; render();`);
  const second = startClient(undefined, { localStore });
  const html = second.node('#history-list').innerHTML;
  assert.match(html, /Test episode/);
  assert.match(html, /Jordan won/);
  assert.match(html, /\$1,200/);
  assert.match(html, /-\$200/);
  assert.equal(second.node('#history-count').textContent, '1');
  const saved = localStore.getItem('jeoparty_game_history_v1');
  assert.doesNotMatch(saved, /do-not-save|private response|token|response/);
  assert.equal(second.evaluate('savedSession()'), null);
});

test('repeated results deduplicate by play, and the same episode can have separate games', () => {
  const client = startClient();
  const first = completedResult();
  const replay = completedResult({ id: 'g_abcdef012345', completedAt: first.completedAt + 1000 });
  client.evaluate(`rememberCompletedGames({ completedGames: ${JSON.stringify([first, first, replay])} }); renderGameHistory();`);
  assert.equal(client.node('#history-count').textContent, '2');
  assert.equal(client.evaluate('readGameHistory()[0].id'), replay.id);
});

test('two tabs merge histories and an older result cannot overwrite a corrected score', () => {
  const localStore = storage();
  const first = startClient(undefined, { localStore });
  const second = startClient(undefined, { localStore });
  const original = completedResult();
  const correction = completedResult({ revision: 2, players: [{ id: 'p_111111111111', name: 'Jordan', score: 1600 }] });
  first.evaluate(`rememberCompletedGames({ completedGames: ${JSON.stringify([original])} });`);
  second.evaluate(`rememberCompletedGames({ completedGames: ${JSON.stringify([correction])} });`);
  first.evaluate(`rememberCompletedGames({ completedGames: ${JSON.stringify([original, completedResult({ id: 'g_abcdef012345' })])} });`);
  const games = JSON.parse(localStore.getItem('jeoparty_game_history_v1')).games;
  assert.equal(games.length, 2);
  assert.equal(games.find((game) => game.id === original.id).players[0].score, 1600);
  second.evaluate("window.dispatch('storage', { key: HISTORY_KEY });");
  assert.equal(second.node('#history-count').textContent, '2');
});

test('invalid saved records are ignored and rendered player names cannot inject markup', () => {
  const localStore = storage();
  const hostile = completedResult({ title: '<img src=x onerror=x>', players: [{ id: 'p_111111111111', name: '<svg onload=x>', score: 100 }] });
  localStore.setItem('jeoparty_game_history_v1', JSON.stringify({ version: 1, games: [
    null, {}, completedResult({ completedAt: 99999999999999999 }), completedResult({ players: [{ name: 'Missing id', score: 10 }] }), hostile,
  ] }));
  const client = startClient(undefined, { localStore });
  assert.equal(client.node('#history-count').textContent, '1');
  assert.match(client.node('#history-list').innerHTML, /&lt;img src=x onerror=x&gt;/);
  assert.match(client.node('#history-list').innerHTML, /&lt;svg onload=x&gt;/);
  assert.doesNotMatch(client.node('#history-list').innerHTML, /<img|<svg/);
});

test('simultaneous tab writes converge by merging the storage event with the latest history', () => {
  const localStore = storage();
  const first = completedResult();
  const second = completedResult({ id: 'g_abcdef012345' });
  const client = startClient(undefined, { localStore });
  client.evaluate(`rememberCompletedGames({ completedGames: ${JSON.stringify([second])} });`);
  const earlierWrite = JSON.stringify({ version: 1, games: [first] });
  client.evaluate(`window.dispatch('storage', { key: HISTORY_KEY, newValue: ${JSON.stringify(earlierWrite)} });`);
  assert.equal(JSON.parse(localStore.getItem('jeoparty_game_history_v1')).games.length, 2);
  localStore.removeItem('jeoparty_game_history_v1');
  client.evaluate("window.dispatch('storage', { key: null, newValue: null });");
  assert.equal(client.node('#history-count').textContent, '0');
});

test('malformed stored history does not prevent startup or saving a new result', () => {
  const localStore = storage();
  localStore.setItem('jeoparty_game_history_v1', '{broken');
  const client = startClient(undefined, { localStore });
  client.evaluate(`rememberCompletedGames({ completedGames: ${JSON.stringify([completedResult()])} }); renderGameHistory();`);
  assert.equal(JSON.parse(localStore.getItem('jeoparty_game_history_v1')).games.length, 1);
  assert.equal(client.evaluate('historyStorageUnavailable'), false);
});

test('unavailable or full storage retains history for this page and reports that it cannot be saved', () => {
  for (const localStore of [blockedStorage(), { ...storage(), setItem() { throw new Error('Quota exceeded'); } }]) {
    const client = startClient(undefined, { localStore });
    client.evaluate(`rememberCompletedGames({ completedGames: ${JSON.stringify([completedResult()])} }); renderGameHistory();`);
    assert.equal(client.node('#history-count').textContent, '1');
    assert.equal(client.evaluate('historyStorageUnavailable'), true);
    assert.match(client.node('#history-note').textContent, /storage is unavailable/);
  }
});

test('past games keep ties and solo scores without inventing a multiplayer win', () => {
  const client = startClient();
  const tie = completedResult({ players: [
    { id: 'p_111111111111', name: 'Jordan', score: -200 },
    { id: 'p_222222222222', name: 'Taylor', score: -200 },
  ] });
  const solo = completedResult({ id: 'g_abcdef012345', players: [{ id: 'p_111111111111', name: 'Sam', score: 800 }] });
  client.evaluate(`rememberCompletedGames({ completedGames: ${JSON.stringify([tie, solo])} }); renderGameHistory();`);
  assert.match(client.node('#history-list').innerHTML, /Tie · Jordan, Taylor/);
  assert.match(client.node('#history-list').innerHTML, /Solo game/);
  assert.doesNotMatch(client.node('#history-list').innerHTML, /Sam won/);
});

test('history replay only creates a room for a board still available in the loaded archive', async () => {
  const client = startClient();
  client.evaluate(`rememberCompletedGames({ completedGames: ${JSON.stringify([completedResult()])} }); renderGameHistory();`);
  assert.doesNotMatch(client.node('#history-list').innerHTML, /data-replay-game-id/);
  client.evaluate("publicGameCatalog = [{ id: 'sample-board' }]; catalogStatus = 'ready'; renderGameHistory(); var replayedBoard; createRoom = async (id) => { replayedBoard = id; };");
  assert.match(client.node('#history-list').innerHTML, /data-replay-game-id="sample-board"/);
  client.node('#history-list').dispatch('click', { target: { closest: () => ({ disabled: false, dataset: { replayGameId: 'sample-board' } }) } });
  await flushAsync();
  assert.equal(client.evaluate('replayedBoard'), 'sample-board');
  client.evaluate("replayedBoard = null; publicGameCatalog = []; renderGameHistory();");
  client.node('#history-list').dispatch('click', { target: { closest: () => ({ disabled: false, dataset: { replayGameId: 'sample-board' } }) } });
  assert.equal(client.evaluate('replayedBoard'), null);
  assert.match(client.node('#history-list').innerHTML, /no longer in the archive/);
});

test('custom game results remain readable without retaining their private boards', () => {
  const client = startClient();
  const custom = completedResult({ custom: true });
  client.evaluate(`rememberCompletedGames({ completedGames: ${JSON.stringify([custom])} }); publicGameCatalog = [{ id: 'sample-board' }]; renderGameHistory();`);
  assert.match(client.node('#history-list').innerHTML, /Custom board/);
  assert.doesNotMatch(client.node('#history-list').innerHTML, /data-replay-game-id/);
});

test('history retains the newest 100 results and remains readable while offline', () => {
  const client = startClient(undefined, { connectImmediately: false });
  const games = Array.from({ length: 105 }, (_, index) => completedResult({ id: `g_${index.toString(16).padStart(12, '0')}`, completedAt: index }));
  client.evaluate(`rememberCompletedGames({ completedGames: ${JSON.stringify(games)} }); renderGameHistory();`);
  assert.equal(client.node('#history-count').textContent, '100');
  assert.equal(client.evaluate('readGameHistory().at(-1).completedAt'), 5);
  assert.equal(client.evaluate('readGameHistory()[0].completedAt'), 104);
});

function blockedStorage() {
  return {
    getItem() { throw new Error('Storage denied'); },
    setItem() { throw new Error('Storage denied'); },
    removeItem() { throw new Error('Storage denied'); },
  };
}

test('blocked browser storage does not prevent startup or joining a room', async () => {
  const client = startClient(undefined, { localStore: blockedStorage(), sessionStore: blockedStorage() });
  assert.deepEqual(client.operations, ['connect', '/api/games', '/api/network']);
  assert.equal(client.node('#join-room-button').disabled, false);

  const games = loadGames();
  const manager = new RoomManager({ games });
  const host = manager.createRoom('creator');
  const session = manager.joinRoom('player', { code: host.code, name: 'Jordan' });
  const response = { session, state: manager.stateFor('player', []) };
  client.evaluate(`
    let notices = [];
    showToast = (message) => notices.push(message);
    request = async () => (${JSON.stringify(response)});
  `);
  await client.evaluate(`joinRoom({ code: { value: '${host.code}' }, name: { value: 'Jordan' } })`);
  assert.equal(client.node('#landing-screen').classList.contains('hidden'), true);
  assert.match(client.node('#room-content').innerHTML, /Waiting for the game to start/);
  assert.equal(client.evaluate('savedSession().token'), session.token);
  assert.equal(client.evaluate('savedName()'), 'Jordan');
  assert.equal(client.evaluate('notices.length'), 1);
  assert.match(client.evaluate('notices[0]'), /Keep this tab open/);
});

test('a full session store keeps room creation and same-tab reconnect working', async () => {
  const sessionStore = storage();
  sessionStore.setItem = () => { throw new Error('Quota exceeded'); };
  const client = startClient(undefined, { sessionStore });
  const games = loadGames();
  const manager = new RoomManager({ games });
  const session = manager.createRoom('creator');
  const response = { session, state: manager.stateFor('creator', catalogGames(games)) };
  client.evaluate(`
    let notices = [];
    let requests = [];
    showToast = (message) => notices.push(message);
    request = async (event, payload) => {
      requests.push({ event, payload });
      return ${JSON.stringify(response)};
    };
  `);
  await client.evaluate('createRoom()');
  assert.equal(client.node('#landing-screen').classList.contains('hidden'), true);
  assert.equal(client.evaluate('savedSession().token'), session.token);
  client.emit('disconnect');
  client.emit('connect');
  await flushAsync();
  assert.equal(client.evaluate('requests.at(-1).event'), 'room:resume');
  assert.equal(client.evaluate('requests.at(-1).payload.token'), session.token);
  assert.equal(client.evaluate('notices.length'), 1);
  assert.equal(client.evaluate('resuming'), false);
});

test('clearing an in-memory session does not resurrect legacy credentials when storage removal fails', () => {
  const localStore = storage();
  localStore.setItem('jeopardy_multiplayer_session_v1', JSON.stringify({ code: 'ABCDE', token: 'legacy-token' }));
  localStore.removeItem = () => { throw new Error('Storage denied'); };
  const sessionStore = storage();
  sessionStore.removeItem = () => { throw new Error('Storage denied'); };
  const client = startClient(undefined, { localStore, sessionStore, connectImmediately: false });
  assert.equal(client.evaluate('savedSession().token'), 'legacy-token');
  client.evaluate('clearSession()');
  assert.equal(client.evaluate('savedSession()'), null);
  assert.equal(client.evaluate('savedSession()'), null);
});

for (const operation of ['create', 'join']) {
  test(`${operation} retries a lost acknowledgement once with the same request and saves the recovered session`, async () => {
    const client = startClient();
    const games = loadGames();
    const manager = new RoomManager({ games });
    const host = manager.createRoom('creator');
    const session = operation === 'create' ? host : manager.joinRoom('player', { code: host.code, name: 'Jordan' });
    const state = manager.stateFor(operation === 'create' ? 'creator' : 'player', catalogGames(games));
    client.evaluate(`
      let requests = [];
      request = async (event, payload) => {
        requests.push({ event, payload });
        if (requests.length === 1) throw Object.assign(new Error('Timed out'), { code: 'REQUEST_TIMEOUT' });
        return ${JSON.stringify({ session, state })};
      };
    `);
    await client.evaluate(operation === 'create' ? 'createRoom()' : `joinRoom({ code: { value: '${host.code}' }, name: { value: 'Jordan' } })`);
    assert.equal(client.evaluate('requests.length'), 2);
    assert.equal(client.evaluate('requests[0].event'), `room:${operation}`);
    assert.equal(client.evaluate('requests[0].payload === requests[1].payload'), true);
    assert.equal(client.evaluate('savedSession().token'), session.token);
    assert.equal(client.node('#landing-screen').classList.contains('hidden'), true);
    assert.equal(client.evaluate('mutationPending'), false);
    assert.equal(client.evaluate('joining'), false);
  });
}

for (const code of ['REQUEST_TIMEOUT', 'NAME_TAKEN']) {
  test(`failed join ${code === 'REQUEST_TIMEOUT' ? 'stops after one retry' : 'does not retry a definitive rejection'}`, async () => {
    const client = startClient();
    client.evaluate(`
      let requestCount = 0;
      request = async () => {
        requestCount += 1;
        throw Object.assign(new Error('Could not join'), { code: '${code}' });
      };
    `);
    await client.evaluate("joinRoom({ code: { value: 'ABCDE' }, name: { value: 'Jordan' } })");
    assert.equal(client.evaluate('requestCount'), code === 'REQUEST_TIMEOUT' ? 2 : 1);
    assert.equal(client.evaluate('mutationPending'), false);
    assert.equal(client.evaluate('joining'), false);
    assert.equal(client.node('#join-room-button').disabled, false);
    assert.equal(client.node('#join-error').hidden, false);
    assert.equal(client.evaluate('savedSession()'), null);
  });
}

test('request marks acknowledgement timeouts without retrying ordinary game mutations', async () => {
  const client = startClient();
  client.evaluate(`
    let emits = 0;
    socket.timeout = () => ({ emit(event, payload, acknowledge) {
      emits += 1;
      acknowledge(new Error('Lost acknowledgement'));
    } });
  `);
  await assert.rejects(client.evaluate("request('host:adjust-score', { delta: 200 })"), { code: 'REQUEST_TIMEOUT' });
  assert.equal(client.evaluate('emits'), 1);
});

function twoRoundGame() {
  const game = structuredClone(loadGames()[0]);
  game.doubleJeopardy = {
    categories: game.categories.map((category, index) => ({
      name: `Second round ${index + 1}`,
      clues: category.clues.map((clue, clueIndex) => ({
        ...clue, value: clue.value * 2, dailyDouble: index < 2 && clueIndex === 0,
      })),
    })),
  };
  return game;
}

test('episode preview and search include Double Jeopardy without mixing the two boards', () => {
  const client = startClient();
  const game = twoRoundGame();
  const manager = new RoomManager({ games: [game] });
  manager.createRoom('creator');
  client.evaluate(`preferredGameId = ${JSON.stringify(game.id)}`);
  client.emit('room:state', manager.stateFor('creator', catalogGames([game])));
  const html = client.node('#room-content').innerHTML;
  assert.match(html, /60 clues · 2 rounds · Final Jeopardy/);
  assert.match(html, /Double Jeopardy<\/strong><p>Second round 1/);
  assert.equal((html.match(/class="lobby-preview-category"/g) || []).length, 6);
  assert.equal(client.evaluate(`filterCatalog(${JSON.stringify(catalogGames([game]))}, 'Second round 6', 'all').length`), 1);
});

test('round controls unlock after the board, submit the displayed round, and show second-round wager limits', async () => {
  const client = startClient();
  const game = twoRoundGame();
  const manager = new RoomManager({ games: [game] });
  const session = manager.createRoom('creator');
  manager.joinRoom('player', { code: session.code, name: 'Jordan' });
  manager.startGame('creator', game.id);
  const render = () => client.emit('room:state', manager.stateFor('creator', []));
  const html = () => client.node('#room-content').innerHTML;
  render();
  assert.match(html(), /data-action="next-round"[^>]*disabled/);
  assert.doesNotMatch(html(), /data-action="start-final"/);
  for (let categoryIndex = 0; categoryIndex < 6; categoryIndex += 1) {
    for (let clueIndex = 0; clueIndex < 5; clueIndex += 1) {
      manager.openClue('creator', { categoryIndex, clueIndex });
      manager.skipClue('creator');
    }
  }
  render();
  assert.doesNotMatch(html().match(/<button[^>]*data-action="next-round"[^>]*>/)[0], /disabled/);
  assert.match(html(), /Continue to Double Jeopardy/);
  client.evaluate('request = async (event, payload) => { globalThis.lastRequest = { event, payload }; };');
  const button = { disabled: false, dataset: { action: 'next-round', round: 'jeopardy' } };
  client.node('#room-content').dispatch('click', { target: { closest: () => button } });
  await flushAsync();
  assert.equal(client.evaluate('lastRequest.event'), 'host:next-round');
  assert.equal(client.evaluate('lastRequest.payload.expectedRound'), 'jeopardy');

  const priorScrolls = client.scrollPositions.length;
  manager.advanceRound('creator', { expectedRound: 'jeopardy' });
  render();
  assert.match(html(), /Double Jeopardy · 0\/30 played/);
  assert.match(html(), /Second round 1/);
  assert.match(html(), /data-round="double"/);
  assert.equal(client.scrollPositions.length, priorScrolls + 1);
  manager.openClue('creator', { categoryIndex: 0, clueIndex: 0, round: 'double' });
  render();
  assert.match(html(), /Wager \(max \$2,000\)/);
  assert.match(html(), /max="2000"/);
});

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

test('a displaced tab keeps a reload instruction and never automatically retakes the room', () => {
  const client = startClient();
  client.evaluate(`
    showToast = () => {};
    saveSession({ code: 'ABCDE', token: 'saved-host-token' });
    let resumeRequests = 0;
    request = async () => { resumeRequests += 1; };
  `);
  client.emit('room:replaced', { message: 'This room was resumed in another tab or device.' });
  const instruction = 'Room opened in another tab. Reload this page to take control here.';
  assert.equal(client.node('#connection-label').textContent, instruction);
  client.emit('disconnect');
  client.evaluate('render()');
  assert.equal(client.node('#connection-label').textContent, instruction);
  assert.equal(client.node('#create-room-button').disabled, true);
  assert.equal(client.node('#create-custom-room-button').disabled, true);
  assert.equal(client.node('#join-room-button').disabled, true);
  assert.equal(client.evaluate('savedSession().token'), 'saved-host-token');
  client.emit('connect');
  assert.equal(client.evaluate('resumeRequests'), 0);
  assert.equal(client.node('#connection-label').textContent, instruction);
  assert.equal(client.operations.filter((operation) => operation === 'connect').length, 1);
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
  assert.match(client.node('#room-content').innerHTML, /Saved to Past games/);
  assert.equal(client.evaluate('readGameHistory()[0].players[0].score'), 600);
  manager.returnToLobby('creator');
  render();
  assert.equal(client.evaluate('readGameHistory().length'), 1);
  assert.equal(client.evaluate('readGameHistory()[0].players[0].score'), 600);
});

test('resuming after completion records the result even when the finishing broadcast was missed', async () => {
  const client = startClient();
  const games = loadGames();
  const manager = new RoomManager({ games });
  const session = manager.createRoom('host');
  manager.joinHostAsPlayer('host', { name: 'Maya' });
  manager.startGame('host', games[0].id);
  const playerId = manager.stateFor('host', []).you.id;
  manager.adjustScore('host', { playerId, delta: 1000 });
  manager.startFinal('host');
  manager.submitFinalWager('host', 200);
  manager.advanceFinal('host');
  manager.submitFinalResponse('host', 'My response');
  manager.advanceFinal('host');
  manager.selfScoreFinal('host', { correct: true });
  manager.finishFinal('host');
  manager.returnToLobby('host');
  const state = manager.stateFor('host', catalogGames(games));
  client.evaluate(`saveSession(${JSON.stringify(session)}); request = async () => (${JSON.stringify({ session, state })});`);
  await client.evaluate('resumeSavedSession()');
  assert.equal(client.evaluate('readGameHistory().length'), 1);
  assert.equal(client.evaluate('readGameHistory()[0].players[0].score'), 1200);
});
