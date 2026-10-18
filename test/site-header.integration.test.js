'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadGames } = require('../lib/game-store');
const { createJeopardyServer } = require('../server');

test('multiplayer and practice share navigation while room controls stay separate', async (context) => {
  const server = createJeopardyServer({ games: loadGames(), logger: { error() {} } });
  const address = await server.start(0, '127.0.0.1');
  context.after(() => server.stop());
  const origin = `http://127.0.0.1:${address.port}`;

  const [lobby, practice] = await Promise.all(['/', '/practice'].map(async (route) => {
    const response = await fetch(`${origin}${route}`);
    assert.equal(response.status, 200, route);
    return response.text();
  }));

  const headers = [lobby, practice].map((html, index) => {
    assert.match(html, /<link\b[^>]*rel="stylesheet"[^>]*href="\/site-header\.css"/);
    const header = html.match(/<header class="site-header">[\s\S]*?<\/header>/)?.[0];
    assert.ok(header, 'Each page exposes the shared site header');
    assert.match(header, /class="site-brand"/);
    assert.doesNotMatch(header, /create-(?:custom-)?room-button/);

    const navigation = header.match(/<nav\b[^>]*aria-label="Main navigation"[^>]*>([\s\S]*?)<\/nav>/)?.[1];
    assert.ok(navigation, 'Each header exposes main navigation');
    const links = [...navigation.matchAll(/<a\b([^>]*)>([^<]*)<\/a>/g)].map(([, attributes, label]) => ({
      href: attributes.match(/\bhref="([^"]*)"/)?.[1],
      label: label.trim(),
      current: /\baria-current="page"/.test(attributes),
    }));
    assert.deepEqual(links, [
      { href: '/', label: 'Multiplayer', current: index === 0 },
      { href: '/practice', label: 'Practice', current: index === 1 },
    ]);

    return header.replace(/\s+aria-current="page"/g, '').replace(/\s+/g, ' ').replace(/>\s+</g, '><');
  });
  assert.equal(headers[0], headers[1], 'Switching pages preserves the header apart from the active link');
  assert.match(lobby, /id="create-custom-room-button"/);
  assert.match(lobby, /id="create-room-button"/);

  const roomHeader = lobby.match(/<header class="room-header">[\s\S]*?<\/header>/)?.[0];
  assert.ok(roomHeader);
  assert.match(roomHeader, /class="site-brand"/);
  assert.match(roomHeader, /id="room-code-button"/);
  assert.match(roomHeader, /id="leave-room-button"/);
  assert.doesNotMatch(roomHeader, /<nav\b|href="\/practice"/);

  const stylesheet = await fetch(`${origin}/site-header.css`);
  assert.equal(stylesheet.status, 200);
  assert.match(stylesheet.headers.get('content-type'), /^text\/css\b/);
  assert.ok((await stylesheet.text()).trim().length > 0);
});
