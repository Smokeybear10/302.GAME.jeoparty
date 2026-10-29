'use strict';

(() => {
  const dialog = document.querySelector('#saved-result-dialog');
  const title = document.querySelector('#saved-result-title');
  const status = document.querySelector('#saved-result-status');
  const scores = document.querySelector('#saved-result-scores');
  const link = document.querySelector('#saved-result-link');
  const retry = document.querySelector('#retry-saved-result');
  const save = document.querySelector('#save-result-locally');
  let currentResult = null;
  let generation = 0;
  let controller = null;

  function tokenFromHash() {
    return new URLSearchParams(window.location.hash.slice(1)).get('result');
  }

  async function loadResult() {
    const token = tokenFromHash();
    if (token === null) {
      if (dialog.open) dialog.close();
      return;
    }
    const attempt = ++generation;
    controller?.abort();
    const requestController = new AbortController();
    controller = requestController;
    currentResult = null;
    title.textContent = 'Saved game';
    scores.replaceChildren();
    status.textContent = 'Loading results…';
    retry.hidden = true;
    save.disabled = true;
    link.value = window.location.href;
    if (!dialog.open) dialog.showModal();
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      status.textContent = 'This results link is invalid. Check that you copied the whole link.';
      return;
    }
    const timeout = window.setTimeout(() => requestController.abort(), 15000);
    try {
      const response = await fetch('/api/results', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }), signal: requestController.signal, cache: 'no-store',
      });
      const body = await response.json();
      if (attempt !== generation) return;
      if (!response.ok) throw new Error(body.error || 'Results could not be loaded. Try again.');
      const result = body.result;
      if (!result || result.resultToken !== token || typeof result.title !== 'string'
        || !Number.isSafeInteger(result.completedAt) || result.completedAt < 0 || result.completedAt > 8640000000000000
        || !Array.isArray(result.players) || result.players.length > 8
        || result.players.some((player) => !player || typeof player.name !== 'string' || !Number.isSafeInteger(player.score))) {
        throw new Error('These results could not be read. Try again.');
      }
      currentResult = result;
      title.textContent = result.title;
      status.textContent = `${new Date(result.completedAt).toLocaleString()} · ${result.gameMode === 'quick' ? 'Quick game' : 'Full game'}`;
      const ranked = [...result.players].sort((first, second) => second.score - first.score);
      for (const player of ranked) {
        const row = document.createElement('li');
        const place = document.createElement('span');
        const name = document.createElement('strong');
        const score = document.createElement('span');
        place.textContent = String(ranked.findIndex((candidate) => candidate.score === player.score) + 1);
        name.textContent = player.name;
        score.textContent = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(player.score);
        row.append(place, name, score);
        scores.append(row);
      }
      save.disabled = false;
    } catch (error) {
      if (attempt !== generation) return;
      status.textContent = error.name === 'AbortError' ? 'The server is taking longer than expected. Try again in a moment.' : error.message;
      retry.hidden = false;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  document.querySelector('#close-saved-result').addEventListener('click', () => dialog.close());
  dialog.addEventListener('keydown', (event) => event.stopPropagation());
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    generation += 1;
    controller?.abort();
    if (tokenFromHash() !== null) {
      const url = new URL(window.location.href);
      url.hash = '';
      window.history.replaceState(null, '', url);
    }
  });
  retry.addEventListener('click', () => void loadResult());
  save.addEventListener('click', () => {
    if (!currentResult) return;
    window.dispatchEvent(new CustomEvent('jeoparty:save-result', { detail: currentResult }));
  });
  document.querySelector('#copy-result-link').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(link.value);
      status.textContent = 'Results link copied.';
    } catch {
      link.focus();
      link.select();
      status.textContent = 'Copy the selected link to keep these results.';
    }
  });
  window.addEventListener('hashchange', () => void loadResult());
  void loadResult();
})();
