'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const script = new vm.Script(readFileSync(path.join(__dirname, '..', 'result-view.js'), 'utf8'), { filename: 'result-view.js' });
const firstToken = 'a'.repeat(43);
const secondToken = 'b'.repeat(43);

function result(overrides = {}) {
  return {
    id: 'g_0123456789ab', gameId: 'opening-round', title: 'Opening round', custom: false,
    gameMode: 'full', completedAt: 1000, revision: 1, resultToken: firstToken,
    players: [
      { id: 'p_0123456789ab', name: 'Maya', score: 600 },
      { id: 'p_0123456789ac', name: 'Theo', score: -200 },
      { id: 'p_0123456789ad', name: 'Alex', score: 600 },
    ],
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function settle() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

function fixture({ hash = `#result=${firstToken}`, clipboard } = {}) {
  const nodes = new Map();
  const windowListeners = new Map();
  const requests = [];
  const timers = new Map();
  const closeEvents = [];
  const events = [];
  const copies = [];
  const location = new URL(`https://jeoparty.example/${hash}`);
  let timerId = 0;
  function element(tag = 'div') {
    const listeners = new Map();
    return {
      tag, textContent: '', value: '', hidden: false, disabled: false, open: false,
      children: [], focused: false, selected: false,
      set innerHTML(_value) { throw new Error('Result content must be rendered as text'); },
      addEventListener: (event, callback) => listeners.set(event, callback),
      fire(event, payload = {}) { return listeners.get(event)?.(payload); },
      replaceChildren(...children) { this.children = children; },
      append(...children) { this.children.push(...children); },
      focus() { this.focused = true; },
      select() { this.selected = true; },
      showModal() { this.open = true; },
      close() {
        if (!this.open) return;
        this.open = false;
        closeEvents.push(() => this.fire('close'));
      },
    };
  }
  function node(selector) {
    if (!nodes.has(selector)) nodes.set(selector, element());
    return nodes.get(selector);
  }
  const context = vm.createContext({
    document: { querySelector: node, createElement: element },
    window: {
      location,
      history: { replaceState(_state, _unused, url) { location.href = String(url); } },
      addEventListener: (event, callback) => windowListeners.set(event, callback),
      dispatchEvent: (event) => events.push(event),
      setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
      clearTimeout: (id) => timers.delete(id),
    },
    navigator: { clipboard: clipboard === null ? undefined : {
      async writeText(text) { copies.push(text); if (clipboard) await clipboard(text); },
    } },
    CustomEvent: class CustomEvent { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    URL, URLSearchParams, AbortController,
    fetch(url, options) {
      const pending = deferred();
      requests.push({ url, options, ...pending });
      return pending.promise;
    },
  });
  script.runInContext(context);
  return {
    node, requests, timers, location, events, copies,
    click: (selector) => node(selector).fire('click'),
    hash(value) { location.hash = value; windowListeners.get('hashchange')(); },
    flushClose() { while (closeEvents.length) closeEvents.shift()(); },
    async respond(index, body, { ok = true } = {}) {
      requests[index].resolve({ ok, json: async () => body });
      await settle();
    },
  };
}

test('result links open a loading dialog and send the capability only in the POST body', async () => {
  const f = fixture();
  assert.equal(f.node('#saved-result-dialog').open, true);
  assert.equal(f.node('#saved-result-title').textContent, 'Saved game');
  assert.equal(f.node('#saved-result-status').textContent, 'Loading results…');
  assert.equal(f.node('#save-result-locally').disabled, true);
  assert.equal(f.node('#retry-saved-result').hidden, true);
  assert.equal(f.node('#saved-result-link').value, f.location.href);
  assert.equal(f.requests.length, 1);
  const request = f.requests[0];
  assert.equal(request.url, '/api/results');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.cache, 'no-store');
  assert.equal(request.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(request.options.body), { token: firstToken });
  assert.equal([...f.timers.values()][0].delay, 15000);
  await f.respond(0, { result: result() });
  assert.equal(f.node('#saved-result-title').textContent, 'Opening round');
  assert.match(f.node('#saved-result-status').textContent, /Full game$/);
  assert.equal(f.node('#save-result-locally').disabled, false);
  assert.equal(f.timers.size, 0);
});

test('missing or malformed hash tokens never send a request', () => {
  const absent = fixture({ hash: '#unrelated=value' });
  assert.equal(absent.requests.length, 0);
  assert.equal(absent.node('#saved-result-dialog').open, false);
  for (const hash of ['#result=', '#result=short', `#result=${'/'.repeat(43)}`, `#result=${'a'.repeat(44)}`]) {
    const f = fixture({ hash });
    assert.equal(f.requests.length, 0);
    assert.equal(f.node('#saved-result-dialog').open, true);
    assert.match(f.node('#saved-result-status').textContent, /link is invalid/);
    assert.equal(f.node('#save-result-locally').disabled, true);
    assert.equal(f.timers.size, 0);
  }
});

test('standings render escaped text, sort scores, and give tied contestants the same place', async () => {
  const f = fixture();
  const saved = result({ title: '<script>title</script>', gameMode: 'quick' });
  saved.players[0].name = '<img src=x onerror=bad>';
  await f.respond(0, { result: saved });
  assert.equal(f.node('#saved-result-title').textContent, saved.title);
  assert.match(f.node('#saved-result-status').textContent, /Quick game$/);
  const rows = f.node('#saved-result-scores').children;
  assert.deepEqual(rows.map((row) => row.tag), ['li', 'li', 'li']);
  assert.deepEqual(rows.map((row) => row.children.map((child) => child.textContent)), [
    ['1', '<img src=x onerror=bad>', '$600'], ['1', 'Alex', '$600'], ['3', 'Theo', '-$200'],
  ]);
});

test('malformed responses keep saving disabled and offer a retry without displaying standings', async () => {
  for (const damaged of [
    null, {}, result({ resultToken: secondToken }), result({ title: null }),
    result({ completedAt: -1 }), result({ completedAt: 8640000000000001 }),
    result({ players: {} }), result({ players: Array.from({ length: 9 }, () => result().players[0]) }),
    result({ players: [null] }), result({ players: [{ name: null, score: 10 }] }),
    result({ players: [{ name: 'Maya', score: 1.5 }] }),
  ]) {
    const f = fixture();
    await f.respond(0, { result: damaged });
    assert.match(f.node('#saved-result-status').textContent, /could not be read/);
    assert.equal(f.node('#retry-saved-result').hidden, false);
    assert.equal(f.node('#save-result-locally').disabled, true);
    assert.deepEqual(f.node('#saved-result-scores').children, []);
    f.click('#save-result-locally');
    assert.deepEqual(f.events, []);
  }
});

test('HTTP and network failures can be retried with a fresh request and cleared errors', async () => {
  const f = fixture();
  await f.respond(0, { error: 'This saved game could not be found.' }, { ok: false });
  assert.equal(f.node('#saved-result-status').textContent, 'This saved game could not be found.');
  assert.equal(f.node('#retry-saved-result').hidden, false);
  f.click('#retry-saved-result');
  assert.equal(f.requests.length, 2);
  assert.equal(f.node('#saved-result-status').textContent, 'Loading results…');
  assert.equal(f.node('#retry-saved-result').hidden, true);
  assert.equal(f.requests[0].options.signal.aborted, true);
  f.requests[1].reject(new Error('Network unavailable'));
  await settle();
  assert.equal(f.node('#saved-result-status').textContent, 'Network unavailable');
  f.click('#retry-saved-result');
  await f.respond(2, { result: result() });
  assert.equal(f.node('#save-result-locally').disabled, false);
  assert.equal(f.node('#retry-saved-result').hidden, true);
});

test('a request timeout aborts its own request and shows a retry without leaving the timer active', async () => {
  const f = fixture();
  [...f.timers.values()][0].callback();
  assert.equal(f.requests[0].options.signal.aborted, true);
  f.requests[0].reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
  await settle();
  assert.match(f.node('#saved-result-status').textContent, /taking longer than expected/);
  assert.equal(f.node('#retry-saved-result').hidden, false);
  assert.equal(f.timers.size, 0);
});

test('changing the result hash ignores old responses and old timeouts cannot abort the new request', async () => {
  const f = fixture();
  const oldTimeout = [...f.timers.values()][0].callback;
  f.hash(`#result=${secondToken}`);
  assert.equal(f.requests[0].options.signal.aborted, true);
  assert.equal(f.requests[1].options.signal.aborted, false);
  oldTimeout();
  assert.equal(f.requests[1].options.signal.aborted, false);
  const latest = result({ title: 'New result', resultToken: secondToken });
  await f.respond(1, { result: latest });
  await f.respond(0, { result: result({ title: 'Stale result' }) });
  assert.equal(f.node('#saved-result-title').textContent, 'New result');
  assert.equal(f.node('#saved-result-link').value, `https://jeoparty.example/#result=${secondToken}`);
  f.click('#save-result-locally');
  assert.equal(f.events[0].detail, latest);
});

test('close cancels the request, removes its fragment, and ignores a late successful response', async () => {
  const f = fixture();
  f.click('#close-saved-result');
  f.flushClose();
  assert.equal(f.node('#saved-result-dialog').open, false);
  assert.equal(f.requests[0].options.signal.aborted, true);
  assert.equal(f.location.hash, '');
  await f.respond(0, { result: result() });
  assert.equal(f.node('#save-result-locally').disabled, true);
  assert.deepEqual(f.node('#saved-result-scores').children, []);
  f.click('#save-result-locally');
  assert.deepEqual(f.events, []);
});

test('removing a result hash closes the viewer and does not fetch unrelated fragments', () => {
  const f = fixture();
  f.hash('#another-section');
  f.flushClose();
  assert.equal(f.node('#saved-result-dialog').open, false);
  assert.equal(f.requests[0].options.signal.aborted, true);
  assert.equal(f.location.hash, '#another-section');
  assert.equal(f.requests.length, 1);
});

test('a queued close event from the previous dialog cannot cancel a newly opened result', async () => {
  const f = fixture();
  f.click('#close-saved-result');
  f.hash(`#result=${secondToken}`);
  assert.equal(f.node('#saved-result-dialog').open, true);
  f.flushClose();
  assert.equal(f.requests[1].options.signal.aborted, false);
  assert.equal(f.location.hash, `#result=${secondToken}`);
  await f.respond(1, { result: result({ title: 'New result', resultToken: secondToken }) });
  assert.equal(f.node('#saved-result-title').textContent, 'New result');
});

test('copying a private link uses the clipboard and unavailable clipboard selects a manual fallback', async () => {
  const f = fixture();
  await f.click('#copy-result-link');
  assert.deepEqual(f.copies, [`https://jeoparty.example/#result=${firstToken}`]);
  assert.equal(f.node('#saved-result-status').textContent, 'Results link copied.');
  for (const clipboard of [null, async () => { throw new Error('Clipboard denied'); }]) {
    const unavailable = fixture({ clipboard });
    await unavailable.click('#copy-result-link');
    assert.equal(unavailable.node('#saved-result-link').focused, true);
    assert.equal(unavailable.node('#saved-result-link').selected, true);
    assert.match(unavailable.node('#saved-result-status').textContent, /Copy the selected link/);
  }
});

test('saving dispatches the validated result once per click and dialog key presses stay local', async () => {
  const f = fixture();
  f.click('#save-result-locally');
  assert.equal(f.events.length, 0);
  const saved = result();
  await f.respond(0, { result: saved });
  f.click('#save-result-locally');
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].type, 'jeoparty:save-result');
  assert.equal(f.events[0].detail, saved);
  let stopped = false;
  f.node('#saved-result-dialog').fire('keydown', { stopPropagation() { stopped = true; } });
  assert.equal(stopped, true);
  f.hash('#result=invalid');
  f.click('#save-result-locally');
  assert.equal(f.events.length, 1);
});
