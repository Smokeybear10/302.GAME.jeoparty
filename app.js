'use strict';

const SESSION_KEY = 'jeopardy_multiplayer_session_v1';
const NAME_KEY = 'jeopardy_multiplayer_name_v1';
const CATALOG_RENDER_LIMIT = 60;

const elements = {
  connectionLabel: document.querySelector('#connection-label'),
  createCustomRoomButton: document.querySelector('#create-custom-room-button'),
  createRoomButton: document.querySelector('#create-room-button'),
  joinRoomButton: document.querySelector('#join-room-button'),
  joinRoomForm: document.querySelector('#join-room-form'),
  joinCode: document.querySelector('#join-code'),
  joinError: document.querySelector('#join-error'),
  landingGameFilter: document.querySelector('#landing-game-filter'),
  landingYearFilter: document.querySelector('#landing-year-filter'),
  librarySummary: document.querySelector('#library-summary'),
  landingNetworkAddress: document.querySelector('#landing-network-address'),
  joinName: document.querySelector('#join-name'),
  landingScreen: document.querySelector('#landing-screen'),
  leaveRoomButton: document.querySelector('#leave-room-button'),
  roleChip: document.querySelector('#role-chip'),
  roomCodeButton: document.querySelector('#room-code-button'),
  roomConnectionPill: document.querySelector('#room-connection-pill'),
  roomContent: document.querySelector('#room-content'),
  roomHeader: document.querySelector('.room-header'),
  roomScreen: document.querySelector('#room-screen'),
  publicGameCount: document.querySelector('#public-game-count'),
  publicGameList: document.querySelector('#public-game-list'),
  toastRegion: document.querySelector('#toast-region'),
};

const socket = io({ autoConnect: false });
let roomState = null;
let connected = false;
let hasConnected = false;
let resuming = false;
let mutationPending = false;
let joining = false;
let shouldResumeOnConnect = true;
let networkUrls = [window.location.origin];
let publicGameCatalog = [];
let catalogStatus = 'loading';
let gameFilter = '';
let landingGameFilter = '';
let gameYearFilter = 'all';
let landingYearFilter = 'all';
let preferredGameId = '';
let activeDialogKey = '';
let renderedScreenKey = 'landing';
let renderedClueKey = '';
let hostGameListScroll = 0;
let customBuilderOpen = false;
let customBuilderSection = 0;
const drafts = {
  hostName: null,
  dailyPlayerId: '',
  dailyWager: '',
  finalWager: '',
  finalResponse: '',
};

function emptyCustomBoardDraft() {
  return {
    title: '',
    description: '',
    dailyDouble: '0:0',
    categories: Array.from({ length: 6 }, () => ({
      name: '',
      clues: Array.from({ length: 5 }, () => ({ clue: '', answer: '' })),
    })),
    finalJeopardy: { category: '', clue: '', answer: '' },
  };
}

let customBoardDraft = emptyCustomBoardDraft();

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function catalogYears(catalog) {
  return [...new Set(catalog.map((game) => game.year).filter(Number.isInteger))]
    .sort((first, second) => second - first);
}

function filterCatalog(catalog, search, year) {
  const normalizedSearch = search.trim().toLowerCase();
  return catalog.filter((game) => {
    if (year !== 'all' && String(game.year) !== year) return false;
    const haystack = `${game.title} ${game.description} ${game.categories.join(' ')}`.toLowerCase();
    return haystack.includes(normalizedSearch);
  });
}

function yearOptions(catalog, selectedYear) {
  return [
    '<option value="all">All years</option>',
    ...catalogYears(catalog).map((year) => `<option value="${year}" ${String(year) === selectedYear ? 'selected' : ''}>${year}</option>`),
  ].join('');
}

function formatMoney(value) {
  const number = Number(value) || 0;
  return `${number < 0 ? '-' : ''}$${Math.abs(number).toLocaleString()}`;
}

function savedSession() {
  let tabSession;
  try {
    tabSession = sessionStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
  if (tabSession !== null) {
    try {
      return JSON.parse(tabSession);
    } catch {
      try {
        sessionStorage.removeItem(SESSION_KEY);
      } catch {
        // Storage may be unavailable in a restricted browser context.
      }
      return null;
    }
  }

  // Migrate the old shared credential once so existing rooms survive the update
  // without making every same-origin tab resume the same host or player.
  let legacySession;
  try {
    legacySession = localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
  if (legacySession === null) return null;

  let session;
  try {
    session = JSON.parse(legacySession);
  } catch {
    localStorage.removeItem(SESSION_KEY);
    return null;
  }

  try {
    sessionStorage.setItem(SESSION_KEY, legacySession);
  } catch {
    return session;
  }
  localStorage.removeItem(SESSION_KEY);
  return session;
}

function saveSession(session) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ ...session, preferredGameId }));
  localStorage.removeItem(SESSION_KEY);
}

function setPreferredGame(gameId) {
  preferredGameId = gameId;
  const session = savedSession();
  if (session) saveSession(session);
}

function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(SESSION_KEY);
}

function showToast(message, tone = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${tone}`;
  if (tone === 'error') toast.setAttribute('role', 'alert');
  toast.textContent = message;
  elements.toastRegion.appendChild(toast);
  window.setTimeout(() => {
    toast.classList.add('toast-out');
    window.setTimeout(() => toast.remove(), 220);
  }, 3500);
}

function setConnectionState(isConnected) {
  connected = isConnected;
  if (isConnected) hasConnected = true;
  elements.connectionLabel.textContent = isConnected
    ? 'Game server connected'
    : hasConnected ? 'Connection lost — trying to reconnect…' : 'Connecting to game server…';
  elements.createRoomButton.disabled = !isConnected || resuming;
  elements.createCustomRoomButton.disabled = !isConnected || resuming;
  elements.joinRoomButton.disabled = !isConnected || resuming || joining;
  document.querySelectorAll('.public-game-row').forEach((row) => {
    row.disabled = !isConnected || resuming;
  });
  elements.roomConnectionPill.classList.toggle('offline', !isConnected);
  elements.roomConnectionPill.innerHTML = `<span></span> ${isConnected ? 'Live' : hasConnected ? 'Reconnecting' : 'Connecting'}`;
  document.body.classList.toggle('is-offline', !isConnected);
}

function request(eventName, payload = {}, { allowWhileResuming = false } = {}) {
  if (!connected) return Promise.reject(new Error('The game server is reconnecting.'));
  if (resuming && !allowWhileResuming) return Promise.reject(new Error('Restoring your room session…'));
  return new Promise((resolve, reject) => {
    socket.timeout(8000).emit(eventName, payload, (timeoutError, response) => {
      if (timeoutError) {
        reject(new Error('The server took too long to respond. Try again.'));
        return;
      }
      if (!response?.ok) {
        const error = new Error(response?.error?.message || 'That action did not work.');
        error.code = response?.error?.code;
        reject(error);
        return;
      }
      resolve(response);
    });
  });
}

async function runAction(action, { quiet = false, lock = true, onError } = {}) {
  if (lock && mutationPending) return null;
  if (lock) {
    mutationPending = true;
    document.body.classList.add('mutation-pending');
  }
  try {
    return await action();
  } catch (error) {
    onError?.(error);
    if (!quiet) showToast(error.message, 'error');
    return null;
  } finally {
    if (lock) {
      mutationPending = false;
      document.body.classList.remove('mutation-pending');
    }
  }
}

function resetDrafts() {
  drafts.dailyPlayerId = '';
  drafts.dailyWager = '';
  drafts.finalWager = '';
  drafts.finalResponse = '';
}

async function resumeSavedSession() {
  const session = savedSession();
  if (!session?.code || !session?.token || resuming) return;
  resuming = true;
  setConnectionState(connected);
  try {
    const response = await request('room:resume', { code: session.code, token: session.token }, { allowWhileResuming: true });
    roomState = response.state;
    preferredGameId = roomState.gameCatalog?.some((game) => game.id === session.preferredGameId)
      ? session.preferredGameId : '';
    saveSession(response.session);
    render();
  } catch (error) {
    const definitiveFailure = error.code === 'ROOM_NOT_FOUND' || error.code === 'SESSION_EXPIRED';
    if (definitiveFailure) {
      clearSession();
      roomState = null;
      shouldResumeOnConnect = false;
      render();
    } else {
      showToast(`${error.message} Your saved session was kept.`, 'error');
    }
  } finally {
    resuming = false;
    setConnectionState(connected);
  }
}

function preferredNetworkUrl() {
  const currentHostIsLoopback = ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
  if (!currentHostIsLoopback) return window.location.origin;
  return networkUrls.find((url) => !url.includes('localhost') && !url.includes('127.0.0.1')) || window.location.origin;
}

function inviteUrl() {
  if (!roomState) return preferredNetworkUrl();
  return `${preferredNetworkUrl()}/?room=${encodeURIComponent(roomState.code)}`;
}

async function copyInvite() {
  const value = inviteUrl();
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }
  showToast('Player link copied.', 'success');
}

function playerById(playerId) {
  return roomState?.players.find((player) => player.id === playerId) || null;
}

function focusSelectorFor(element) {
  if (!element || !elements.roomContent.contains(element)) return '';
  if (element.id) return `#${CSS.escape(element.id)}`;
  if (element.name && element.matches('input, textarea, select')) {
    return `[name="${CSS.escape(element.name)}"]`;
  }
  const actionElement = element.closest('[data-action]');
  if (!actionElement) return '';
  const attributes = ['action', 'playerId', 'gameId', 'correct', 'delta', 'categoryIndex', 'clueIndex'];
  return attributes.reduce((selector, attribute) => {
    const value = actionElement.dataset[attribute];
    return value === undefined ? selector : `${selector}[data-${attribute.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}="${CSS.escape(value)}"]`;
  }, '');
}

function dialogKeyForState() {
  if (customBuilderOpen && roomState?.phase === 'lobby' && roomState?.role === 'host') return 'custom-builder';
  if (roomState?.phase !== 'board' || !roomState.currentClue) return '';
  const clue = roomState.currentClue;
  return `${clue.category}:${clue.boardValue}:${clue.phase}`;
}

function manageDialogFocus(previousDialogKey, focusSelector) {
  const overlay = elements.roomContent.querySelector('.clue-overlay, .custom-builder-overlay');
  const gameShell = elements.roomContent.querySelector('.game-shell');
  const nextDialogKey = dialogKeyForState();
  const hasDialog = Boolean(overlay);
  if (gameShell) gameShell.inert = hasDialog;
  elements.roomHeader.inert = hasDialog;

  if (hasDialog) {
    const preservedTarget = previousDialogKey === nextDialogKey && focusSelector
      ? elements.roomContent.querySelector(focusSelector)
      : null;
    (preservedTarget || overlay.querySelector('.clue-stage, .custom-builder-dialog'))?.focus();
  } else if (previousDialogKey) {
    elements.roomContent.querySelector('.game-titlebar h2')?.focus();
  } else if (focusSelector) {
    elements.roomContent.querySelector(focusSelector)?.focus();
  }
  activeDialogKey = nextDialogKey;
}

function renderPublicLobby() {
  if (!elements.publicGameList) return;
  if (elements.librarySummary && publicGameCatalog.length > 0) {
    elements.librarySummary.textContent = `${publicGameCatalog.length.toLocaleString()} games`;
  }
  const options = yearOptions(publicGameCatalog, landingYearFilter);
  if (elements.landingYearFilter.innerHTML !== options) elements.landingYearFilter.innerHTML = options;
  elements.landingYearFilter.value = landingYearFilter;
  const filteredGames = filterCatalog(publicGameCatalog, landingGameFilter, landingYearFilter);

  if (catalogStatus === 'loading') {
    elements.publicGameList.innerHTML = '<div class="lobby-loading"><span></span>Loading the game library…</div>';
    elements.publicGameCount.textContent = 'Loading boards…';
  } else if (catalogStatus === 'error') {
    elements.publicGameList.innerHTML = '<div class="public-game-empty"><p>The archive could not be loaded. You can still join a room or create a custom board.</p><button class="button button-ghost" type="button" data-catalog-retry>Try again</button></div>';
    elements.publicGameCount.textContent = 'Archive unavailable';
  } else if (filteredGames.length === 0) {
    elements.publicGameList.innerHTML = `<div class="public-game-empty">${publicGameCatalog.length ? 'No boards match that search.' : 'No boards are available yet. Create a custom board to play.'}</div>`;
    elements.publicGameCount.textContent = '0 boards match';
  } else {
    const visibleGames = filteredGames.slice(0, CATALOG_RENDER_LIMIT);
    elements.publicGameList.innerHTML = visibleGames.map((game) => `
      <button class="public-game-row" type="button" data-public-game-id="${escapeAttr(game.id)}" ${!connected || resuming ? 'disabled' : ''} aria-label="Create room with ${escapeAttr(game.title)}. Categories: ${escapeAttr(game.categories.join(', '))}.">
        <span class="public-game-title"><span><strong>${escapeHtml(game.title)}</strong><small>${escapeHtml(game.description.replace(' · original broadcast', ''))}</small></span></span>
        <span class="public-game-topics" title="${escapeAttr(game.categories.join(' · '))}">${escapeHtml(game.categories.join(' · '))}</span>
        <span class="public-game-level" aria-hidden="true"><b>→</b></span>
      </button>
    `).join('');
    elements.publicGameCount.textContent = visibleGames.length < filteredGames.length
      ? `${visibleGames.length} of ${filteredGames.length} shown`
      : `${filteredGames.length} board${filteredGames.length === 1 ? '' : 's'}`;
  }

  if (elements.landingNetworkAddress) {
    elements.landingNetworkAddress.textContent = preferredNetworkUrl().replace(/^https?:\/\//, '');
  }
}

async function loadCatalog() {
  catalogStatus = 'loading';
  renderPublicLobby();
  try {
    const response = await fetch('/api/games', { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('Archive unavailable');
    const games = await response.json();
    if (!Array.isArray(games)) throw new Error('Invalid archive response');
    publicGameCatalog = games;
    catalogStatus = 'ready';
  } catch {
    catalogStatus = 'error';
  }
  renderPublicLobby();
}

function renderRoster({ hostControls = false } = {}) {
  if (!roomState.players.length) {
    return '<div class="empty-roster"><strong>No players yet.</strong><span>Share the room link to fill the scoreboard.</span></div>';
  }
  return `<ul class="roster-list">
    ${roomState.players.map((player) => `
      <li class="roster-item ${player.id === roomState.you?.id ? 'is-you' : ''} ${player.isHost ? 'is-host' : ''}">
        <span class="presence-dot ${player.connected ? '' : 'offline'}" aria-label="${player.connected ? 'Connected' : 'Disconnected'}"></span>
        <span class="roster-name"><span>${escapeHtml(player.name)}</span>${player.isHost ? '<em class="host-badge">Host</em>' : ''}${player.id === roomState.you?.id ? '<em>You</em>' : ''}</span>
        ${roomState.phase !== 'lobby' ? `<strong>${formatMoney(player.score)}</strong>` : ''}
        ${hostControls && !player.isHost ? `<button class="icon-button" type="button" data-action="remove-player" data-player-id="${escapeAttr(player.id)}" aria-label="Remove ${escapeAttr(player.name)}">×</button>` : ''}
      </li>
    `).join('')}
  </ul>`;
}

function customSectionComplete(sectionIndex) {
  if (sectionIndex < 6) {
    const category = customBoardDraft.categories[sectionIndex];
    return Boolean(category.name.trim() && category.clues.every((clue) => clue.clue.trim() && clue.answer.trim()));
  }
  const final = customBoardDraft.finalJeopardy;
  return Boolean(final.category.trim() && final.clue.trim() && final.answer.trim());
}

function customDraftProblem() {
  if (!customBoardDraft.title.trim()) return { section: 0, message: 'Give the board a title.' };
  for (let categoryIndex = 0; categoryIndex < 6; categoryIndex += 1) {
    const category = customBoardDraft.categories[categoryIndex];
    if (!category.name.trim()) return { section: categoryIndex, message: `Name category ${categoryIndex + 1}.` };
    for (let clueIndex = 0; clueIndex < 5; clueIndex += 1) {
      if (!category.clues[clueIndex].clue.trim()) {
        return { section: categoryIndex, message: `Add the $${(clueIndex + 1) * 200} clue in category ${categoryIndex + 1}.` };
      }
      if (!category.clues[clueIndex].answer.trim()) {
        return { section: categoryIndex, message: `Add the response for the $${(clueIndex + 1) * 200} clue in category ${categoryIndex + 1}.` };
      }
    }
  }
  const final = customBoardDraft.finalJeopardy;
  if (!final.category.trim() || !final.clue.trim() || !final.answer.trim()) {
    return { section: 6, message: 'Finish the Final Jeopardy category, clue, and response.' };
  }
  return null;
}

function customGamePayload() {
  return {
    title: customBoardDraft.title,
    description: customBoardDraft.description,
    categories: customBoardDraft.categories.map((category, categoryIndex) => ({
      name: category.name,
      clues: category.clues.map((clue, clueIndex) => ({
        clue: clue.clue,
        answer: clue.answer,
        dailyDouble: customBoardDraft.dailyDouble === `${categoryIndex}:${clueIndex}`,
      })),
    })),
    finalJeopardy: { ...customBoardDraft.finalJeopardy },
  };
}

function renderCustomBuilderSection() {
  if (customBuilderSection === 6) {
    const final = customBoardDraft.finalJeopardy;
    return `
      <section class="custom-editor-page final-editor-page" aria-labelledby="custom-section-title">
        <div class="custom-page-heading"><span>Final</span><h3 id="custom-section-title">Final Jeopardy</h3></div>
        <div class="custom-final-fields">
          <label><span>Category</span><input name="final-category" data-custom-field="final-category" maxlength="80" value="${escapeAttr(final.category)}" placeholder="WORLD CAPITALS"></label>
          <label><span>Clue</span><textarea name="final-clue" data-custom-field="final-clue" maxlength="500" rows="4" placeholder="Enter the Final Jeopardy clue">${escapeHtml(final.clue)}</textarea></label>
          <label><span>Correct response</span><input name="final-answer" data-custom-field="final-answer" maxlength="240" value="${escapeAttr(final.answer)}" placeholder="What is ...?"></label>
        </div>
      </section>`;
  }

  const category = customBoardDraft.categories[customBuilderSection];
  return `
    <section class="custom-editor-page" aria-labelledby="custom-section-title">
      <div class="custom-page-heading">
        <span>Category ${customBuilderSection + 1} of 6</span>
        <label><span class="sr-only">Category name</span><input id="custom-section-title" name="category-${customBuilderSection}" data-custom-field="category-name" data-category-index="${customBuilderSection}" maxlength="60" value="${escapeAttr(category.name)}" placeholder="CATEGORY NAME"></label>
      </div>
      <div class="custom-clue-list">
        ${category.clues.map((clue, clueIndex) => {
          const clueValue = (clueIndex + 1) * 200;
          const clueKey = `${customBuilderSection}:${clueIndex}`;
          return `
            <article class="custom-clue-row">
              <div class="custom-clue-value">
                <strong>$${clueValue}</strong>
                <label><input type="radio" name="daily-double" value="${clueKey}" data-custom-field="daily-double" ${customBoardDraft.dailyDouble === clueKey ? 'checked' : ''}> Daily Double</label>
              </div>
              <label><span>Clue</span><textarea name="clue-${clueKey}" data-custom-field="clue" data-category-index="${customBuilderSection}" data-clue-index="${clueIndex}" maxlength="500" rows="2" placeholder="Write the clue">${escapeHtml(clue.clue)}</textarea></label>
              <label><span>Correct response</span><input name="answer-${clueKey}" data-custom-field="answer" data-category-index="${customBuilderSection}" data-clue-index="${clueIndex}" maxlength="240" value="${escapeAttr(clue.answer)}" placeholder="What is ...?"></label>
            </article>`;
        }).join('')}
      </div>
    </section>`;
}

function renderCustomBuilder() {
  const sections = ['1', '2', '3', '4', '5', '6', 'Final'];
  return `
    <div class="custom-builder-overlay" role="dialog" aria-modal="true" aria-labelledby="custom-builder-title">
      <form class="custom-builder-dialog" id="custom-game-form" tabindex="-1">
        <header class="custom-builder-header">
          <div><p class="panel-label">Board editor</p><h2 id="custom-builder-title">Make your own game</h2></div>
          <button class="icon-button custom-builder-close" type="button" data-action="close-custom-builder" aria-label="Close board editor">×</button>
        </header>
        <div class="custom-board-meta">
          <label><span>Board title</span><input name="custom-title" data-custom-field="title" maxlength="80" value="${escapeAttr(customBoardDraft.title)}" placeholder="Friday night game" required></label>
          <label><span>Note <em>optional</em></span><input name="custom-description" data-custom-field="description" maxlength="180" value="${escapeAttr(customBoardDraft.description)}" placeholder="Family reunion, study group, etc."></label>
        </div>
        <nav class="custom-builder-tabs" aria-label="Board sections">
          ${sections.map((label, sectionIndex) => `<button type="button" data-action="custom-section" data-section="${sectionIndex}" class="${sectionIndex === customBuilderSection ? 'is-active' : ''} ${customSectionComplete(sectionIndex) ? 'is-complete' : ''}" aria-current="${sectionIndex === customBuilderSection ? 'step' : 'false'}"><span>${customSectionComplete(sectionIndex) ? '✓' : sectionIndex + 1}</span>${label === 'Final' ? 'Final' : `Cat. ${label}`}</button>`).join('')}
        </nav>
        ${renderCustomBuilderSection()}
        <footer class="custom-builder-footer">
          <button class="text-button clear-custom-button" type="button" data-action="reset-custom-builder">Clear board</button>
          <div>
            <button class="button button-secondary" type="button" data-action="previous-custom-section" ${customBuilderSection === 0 ? 'disabled' : ''}>Back</button>
            ${customBuilderSection < 6
              ? '<button class="button button-primary" type="button" data-action="next-custom-section">Next</button>'
              : '<button class="button button-gold" type="submit">Save and select board</button>'}
          </div>
        </footer>
      </form>
    </div>`;
}

function renderHostLobby() {
  const catalog = roomState.gameCatalog || [];
  const connectedPlayers = roomState.players.filter((player) => player.connected).length;
  const preferredGame = catalog.find((game) => game.id === preferredGameId) || null;
  const previewGame = preferredGame || catalog[0];
  const previewCategories = previewGame?.categories || Array.from({ length: 6 }, (_, index) => `Category ${index + 1}`);
  const filteredGames = filterCatalog(catalog, gameFilter, gameYearFilter).sort((firstGame, secondGame) => {
    if (firstGame.id === preferredGameId) return -1;
    if (secondGame.id === preferredGameId) return 1;
    return catalog.indexOf(firstGame) - catalog.indexOf(secondGame);
  });
  const visibleGames = filteredGames.slice(0, CATALOG_RENDER_LIMIT);
  const urls = [preferredNetworkUrl()];

  return `
    <div class="lobby-layout">
      <section class="lobby-preview ${preferredGame ? 'has-selection' : 'is-unselected'}" aria-labelledby="lobby-preview-title">
        <header class="lobby-preview-header">
          <div class="lobby-preview-heading">
            <h2 id="lobby-preview-title">${escapeHtml(preferredGame?.title || 'Choose an episode below')}</h2>
            <p>${preferredGame ? escapeHtml(preferredGame.description) : 'Your selected board will appear here.'}</p>
          </div>
          <button class="button button-primary lobby-start-button" type="button" data-action="start-game" data-game-id="${escapeAttr(preferredGame?.id || '')}" ${preferredGame && connectedPlayers ? '' : 'disabled'}>Start game <span aria-hidden="true">→</span></button>
        </header>
        <div class="lobby-board-preview" role="img" aria-label="${preferredGame ? 'Selected board' : 'Example board preview'}: ${escapeAttr(previewCategories.join(', '))}. Five clues per category, from $200 to $1,000.">
          ${previewCategories.map((category) => `<div class="lobby-preview-category" aria-hidden="true">${escapeHtml(category)}</div>`).join('')}
        </div>
        <div class="lobby-preview-status">
          <span>${preferredGame ? '30 clues · 6 categories · Final Jeopardy' : 'Select a row in the archive to use that episode.'}</span>
          <span>${!connectedPlayers ? 'At least one player needed to start' : `${connectedPlayers} player${connectedPlayers === 1 ? '' : 's'} ready`}</span>
        </div>
      </section>

      <aside class="lobby-room">
        <section class="broadcast-card">
          <div class="broadcast-heading">
            <p class="panel-label">Room code</p>
            <span class="live-note"><i></i> Open</span>
          </div>
          <button class="giant-code" type="button" data-action="copy-invite" aria-label="Copy player link for room ${escapeAttr(roomState.code)}">${escapeHtml(roomState.code)}<small>Copy player link</small></button>
          <div class="network-addresses">
            <span>Join on the same Wi-Fi</span>
            ${urls.map((url) => `<code>${escapeHtml(url.replace(/^https?:\/\//, ''))}</code>`).join('')}
          </div>
        </section>
        <section class="roster-card">
          <div class="panel-heading">
            <h2>Players <span>${roomState.players.length} / 8</span></h2>
          </div>
          ${renderRoster({ hostControls: true })}
        </section>
        <section class="host-play-station">
          ${roomState.you
            ? `<p class="panel-label">You're playing</p>
              <h2>${escapeHtml(roomState.you.name)}</h2>
              <button class="text-button" type="button" data-action="leave-contestants">Switch to host only</button>`
            : `<h2>Playing too?</h2>
              <form class="host-contestant-form" id="host-contestant-form">
                <label class="sr-only" for="host-contestant-name">Your name</label>
                <input id="host-contestant-name" name="name" maxlength="24" autocomplete="nickname" value="${escapeAttr(drafts.hostName ?? localStorage.getItem(NAME_KEY) ?? '')}" placeholder="Your name" required>
                <button class="button button-primary" type="submit" ${roomState.players.length >= 8 ? 'disabled' : ''}>${roomState.players.length >= 8 ? 'Room is full' : 'Join as player'}</button>
              </form>
              <p>Or stay on this screen to host.</p>`}
        </section>
      </aside>

      <section class="game-library">
        <div class="library-heading">
          <div class="library-title">
            <h2>Episode archive</h2>
            <span>${visibleGames.length < filteredGames.length ? `${visibleGames.length} of ${filteredGames.length}` : filteredGames.length} shown</span>
          </div>
          <div class="library-tools">
            <button class="button button-secondary" type="button" data-action="open-custom-builder">Custom board</button>
            <label class="year-select"><span>Year</span><select id="game-year-filter" aria-label="Filter games by year">${yearOptions(catalog, gameYearFilter)}</select></label>
            <label class="search-field">
              <span class="sr-only">Filter games</span>
              <input id="game-filter" type="search" value="${escapeAttr(gameFilter)}" placeholder="Search dates or categories">
            </label>
          </div>
        </div>
        <div class="host-game-table">
          <div class="host-game-head" aria-hidden="true"><span>Episode</span><span>Categories</span><span></span></div>
          <div class="host-game-list">
            ${visibleGames.map((game) => `
              <button class="host-game-row ${game.id === preferredGameId ? 'is-preferred' : ''}" type="button" data-action="select-game" data-game-id="${escapeAttr(game.id)}" aria-pressed="${game.id === preferredGameId}" aria-label="Select ${escapeAttr(game.title)}. Topics: ${escapeAttr(game.categories.join(', '))}. ${escapeAttr(game.description)}">
                <span class="host-game-copy">
                  <strong>${escapeHtml(game.title)}</strong>
                  <small>${escapeHtml(game.description.replace(' · original broadcast', ''))}</small>
                </span>
                <span class="host-game-topics" title="${escapeAttr(game.categories.join(' · '))}">${escapeHtml(game.categories.join(' · '))}</span>
                <span class="row-select-mark" aria-hidden="true">${game.id === preferredGameId ? '✓' : ''}</span>
              </button>
            `).join('') || '<div class="no-results">No games match that search.</div>'}
          </div>
        </div>
      </section>
    </div>
    ${customBuilderOpen ? renderCustomBuilder() : ''}`;
}

function renderPlayerLobby() {
  return `
    <div class="waiting-stage">
      <div class="waiting-pulse" aria-hidden="true"><span></span><span></span><span></span></div>
      <p class="panel-label">You're in room ${escapeHtml(roomState.code)}</p>
      <h2>Waiting for the host</h2>
      <p>Keep this screen open. The board will appear as soon as the host chooses a game.</p>
      <div class="player-ticket">
        <span>Playing as</span>
        <strong>${escapeHtml(roomState.you?.name || 'Player')}</strong>
      </div>
      <section class="waiting-roster">
        <p class="panel-label">Players</p>
        ${renderRoster()}
      </section>
    </div>`;
}

function renderScoreboard() {
  const ranked = [...roomState.players].sort((first, second) => second.score - first.score);
  const showScoreControls = roomState.role === 'host' && roomState.phase === 'board';
  return `
    <section class="score-rail" aria-label="Scoreboard">
      <div class="score-heading">
        <p class="panel-label">Scoreboard</p>
        <span>${roomState.players.length} player${roomState.players.length === 1 ? '' : 's'}</span>
      </div>
      <div class="score-list">
        ${ranked.map((player, index) => `
          <article class="score-card ${player.id === roomState.you?.id ? 'is-you' : ''} ${player.id === roomState.controlPlayerId ? 'has-control' : ''}">
            <div class="place-number">${String(ranked.findIndex((candidate) => candidate.score === player.score) + 1).padStart(2, '0')}</div>
            <div class="score-copy">
              <span class="score-name"><i class="presence-dot ${player.connected ? '' : 'offline'}"></i><b>${escapeHtml(player.name)}</b>${player.isHost ? '<em>Host</em>' : ''}</span>
              <strong class="${player.score < 0 ? 'negative' : ''}">${formatMoney(player.score)}</strong>
            </div>
            ${showScoreControls
              ? !player.connected && !player.isHost
                ? `<button class="icon-button score-remove-player" type="button" data-action="remove-player" data-player-id="${escapeAttr(player.id)}" aria-label="Remove disconnected player ${escapeAttr(player.name)}" title="Remove disconnected player">×</button>`
                : `<div class="score-adjusters">
                    <button type="button" data-action="adjust-score" data-player-id="${escapeAttr(player.id)}" data-delta="-200" aria-label="Deduct $200 from ${escapeAttr(player.name)}">−</button>
                    <button type="button" data-action="adjust-score" data-player-id="${escapeAttr(player.id)}" data-delta="200" aria-label="Add $200 to ${escapeAttr(player.name)}">+</button>
                  </div>`
              : ''}
          </article>
        `).join('') || '<div class="score-empty">Waiting for players…</div>'}
      </div>
    </section>`;
}

function renderBoardGrid() {
  const game = roomState.game;
  const renderTile = (category, categoryIndex, clueIndex) => {
    const clue = category.clues[clueIndex];
    const unavailable = clue.answered || Boolean(roomState.currentClue) || !roomState.canChooseClue;
    return `<button
      class="clue-tile ${clue.answered ? 'answered' : ''}"
      type="button"
      data-action="open-clue"
      data-category-index="${categoryIndex}"
      data-clue-index="${clueIndex}"
      ${unavailable ? 'disabled' : ''}
      aria-label="${escapeAttr(category.name)}, ${formatMoney(clue.value)}${clue.answered ? ', answered' : ''}"
    ><span>${clue.answered ? '' : formatMoney(clue.value)}</span></button>`;
  };
  return `
    <div class="board-wrap">
      <div class="board-grid" style="--board-columns: ${game.categories.length}">
        ${game.categories.map((category) => `<div class="category-tile">${escapeHtml(category.name)}</div>`).join('')}
        ${[0, 1, 2, 3, 4].flatMap((clueIndex) => game.categories.map((category, categoryIndex) => renderTile(category, categoryIndex, clueIndex))).join('')}
      </div>
    </div>
    <div class="mobile-board" aria-label="Game board">
      ${game.categories.map((category, categoryIndex) => `
        <section class="board-category-group">
          <h3>${escapeHtml(category.name)}</h3>
          <div class="mobile-clue-row">${category.clues.map((clue, clueIndex) => renderTile(category, categoryIndex, clueIndex)).join('')}</div>
        </section>`).join('')}
    </div>`;
}

function renderHostBoardControls() {
  const hasFinalist = roomState.players.some((player) => player.score > 0);
  const finalDisabledReason = roomState.currentClue
    ? 'Finish the active clue first'
    : !hasFinalist
      ? 'A player needs a positive score'
      : '';
  return `
    <div class="host-toolbar">
      <button class="button button-secondary" type="button" data-action="return-lobby">Boards</button>
      <button class="button button-secondary" type="button" data-action="reset-game">Reset</button>
      <button class="button button-gold" type="button" data-action="start-final" ${finalDisabledReason ? `disabled title="${escapeAttr(finalDisabledReason)}"` : ''}>Final →</button>
    </div>`;
}

function renderBuzzQueue(clue) {
  if (clue.dailyDouble) {
    const player = playerById(clue.dailyPlayerId);
    return player ? `<div class="daily-player-callout"><span>Daily Double belongs to</span><strong>${escapeHtml(player.name)}</strong></div>` : '';
  }
  if (clue.buzzes.length === 0) {
    return `<div class="buzz-queue empty"><span class="queue-light"></span>${clue.buzzOpen ? 'Buzzers are open' : 'Buzzers are locked'}</div>`;
  }
  return `<ol class="buzz-queue" aria-label="Buzz order">
    ${clue.buzzes.map((buzz) => `<li class="${buzz.position === 1 ? 'first-buzz' : ''}"><span>${buzz.position}</span>${escapeHtml(buzz.name)}</li>`).join('')}
  </ol>`;
}

function renderDailyWager(clue) {
  const everyonePlays = roomState.players.some((player) => player.isHost);
  const availablePlayers = roomState.players.filter((player) => player.connected && (!everyonePlays || player.id === roomState.controlPlayerId));
  if (!availablePlayers.length) {
    return `
      <div class="clue-overlay" role="dialog" aria-modal="true" aria-label="Daily Double">
        <div class="clue-stage daily-stage" tabindex="-1">
          <p class="daily-banner">Daily Double</p>
          <h2>A player needs to join before this clue can be wagered.</h2>
          <button class="button button-secondary" type="button" data-action="cancel-clue">Back to board</button>
        </div>
      </div>`;
  }
  if (!availablePlayers.some((player) => player.id === drafts.dailyPlayerId)) {
    drafts.dailyPlayerId = availablePlayers[0].id;
    drafts.dailyWager = String(clue.boardValue);
  }
  const selectedPlayer = playerById(drafts.dailyPlayerId);
  const maxWager = Math.max(selectedPlayer?.score || 0, 1000);
  return `
    <div class="clue-overlay" role="dialog" aria-modal="true" aria-labelledby="daily-title">
      <form class="clue-stage daily-stage" id="daily-wager-form" tabindex="-1">
        <p class="daily-banner">Daily Double</p>
        <h2 id="daily-title">${everyonePlays ? `${escapeHtml(selectedPlayer.name)}'s Daily Double` : 'Choose the player and wager'}</h2>
        ${everyonePlays && selectedPlayer.id !== roomState.you?.id ? `<p class="waiting-copy">Ask ${escapeHtml(selectedPlayer.name)} for their wager, then enter it below.</p>` : ''}
        <p class="clue-category">${escapeHtml(clue.category)} · ${formatMoney(clue.boardValue)} clue</p>
        <div class="daily-form-grid">
          <label><span>Player</span>
            <select id="daily-player" name="playerId">
              ${availablePlayers.map((player) => `<option value="${escapeAttr(player.id)}" ${player.id === drafts.dailyPlayerId ? 'selected' : ''}>${escapeHtml(player.name)} — ${formatMoney(player.score)}</option>`).join('')}
            </select>
          </label>
          <label><span>Wager (max ${formatMoney(maxWager)})</span>
            <input id="daily-wager" name="wager" type="number" min="0" max="${maxWager}" step="1" value="${escapeAttr(drafts.dailyWager)}" required>
          </label>
        </div>
        <div class="dialog-actions">
          <button class="button button-primary button-large" type="submit">Show clue</button>
          <button class="button button-secondary" type="button" data-action="cancel-clue">Back to board</button>
        </div>
      </form>
    </div>`;
}

function renderHostTurnStatus(clue) {
  const responder = playerById(clue.responderPlayerId);
  const connectedPlayers = roomState.players.filter((player) => player.connected).length;
  if (clue.revealed) {
    return `
      <section class="host-turn-status is-revealed" role="status">
        <span>Answer sent</span>
        <strong>Shown on contestant screens</strong>
        <p>The host display stays answer-free. Close the clue when the room is ready.</p>
      </section>`;
  }
  if (responder) {
    const checking = clue.selfJudgePlayerId === responder.id;
    return `
      <section class="host-turn-status ${checking ? 'is-checking' : 'is-answering'}" role="status">
        <span>${checking ? 'Self-check in progress' : clue.dailyDouble ? 'Daily Double' : 'First buzz'}</span>
        <strong>${escapeHtml(responder.name)} ${checking ? 'is checking' : 'is answering'}</strong>
        <p>${checking ? 'The official response is visible only on their screen.' : 'They answer aloud, then check and score themselves on their device.'}</p>
      </section>`;
  }
  return `
    <section class="host-turn-status is-open" role="status">
      <span>${clue.buzzOpen ? 'Buzzers open' : 'Buzzers closed'}</span>
      <strong>${clue.buzzOpen ? 'Waiting for a contestant' : 'Waiting on the room'}</strong>
      <p>${connectedPlayers} connected contestant${connectedPlayers === 1 ? '' : 's'} · the answer never appears on this host display.</p>
    </section>`;
}

function renderHostClue(clue) {
  if (clue.phase === 'daily-wager') return renderDailyWager(clue);
  const responder = playerById(clue.responderPlayerId);
  const hasResponder = Boolean(responder);
  const removeDisconnectedResponder = responder && !responder.connected && !responder.isHost
    ? `<button class="button button-secondary" type="button" data-action="remove-player" data-player-id="${escapeAttr(responder.id)}">Remove disconnected ${escapeHtml(responder.name)}</button>`
    : '';
  return `
    <div class="clue-overlay" role="dialog" aria-modal="true" aria-labelledby="clue-question">
      <div class="clue-stage host-clue-stage" tabindex="-1">
        <div class="clue-topline">
          <span>${clue.dailyDouble ? 'Daily Double · ' : ''}${escapeHtml(clue.category)}</span>
          <strong>${formatMoney(clue.value)}</strong>
        </div>
        <h2 class="clue-question" id="clue-question">${escapeHtml(clue.question)}</h2>
        <div class="host-clue-workspace">
          ${renderHostTurnStatus(clue)}
          ${renderBuzzQueue(clue)}
        </div>
        <div class="dialog-actions host-clue-actions">
          ${!clue.revealed && !hasResponder ? '<button class="button button-gold" type="button" data-action="reveal-answer">Show answer to players</button>' : ''}
          ${!clue.dailyDouble && !clue.revealed ? `<button class="button button-secondary" type="button" data-action="reset-buzzers" ${clue.selfJudgePlayerId ? 'disabled title="A contestant is checking their response"' : ''}>Reset buzzers</button>` : ''}
          ${removeDisconnectedResponder}
          <button class="button button-secondary" type="button" data-action="skip-clue">${clue.revealed ? 'Close clue' : 'End clue'}</button>
        </div>
      </div>
    </div>`;
}

function renderPlayerTurnState(clue, you, yourBuzz, ineligible) {
  const responder = playerById(clue.responderPlayerId);
  const isActive = responder?.id === you?.id;
  if (clue.revealed) {
    return `
      <section class="self-judge-panel is-public" role="status">
        <span>Official response</span>
        <strong class="private-answer">${escapeHtml(clue.answer)}</strong>
        <p>No contestant claimed it. The host will close the clue.</p>
      </section>`;
  }
  if (isActive && clue.privateAnswer) {
    return `
      <section class="self-judge-panel is-open" aria-labelledby="private-answer-label">
        <span id="private-answer-label">Official response · only on your screen</span>
        <strong class="private-answer">${escapeHtml(clue.privateAnswer)}</strong>
        <div class="self-judge-actions">
          <button class="judge-correct" type="button" data-action="self-score-clue" data-correct="true">I was correct</button>
          <button class="judge-wrong" type="button" data-action="self-score-clue" data-correct="false">I was incorrect</button>
        </div>
      </section>`;
  }
  if (isActive) {
    return `
      <section class="self-judge-panel is-ready">
        <span>${clue.dailyDouble ? 'This one is yours' : 'Your turn'}</span>
        <strong>Say your response out loud</strong>
        <button class="button button-gold button-large" type="button" data-action="open-player-answer" ${clue.canOpenAnswer ? '' : 'disabled'}>Check my response</button>
      </section>`;
  }
  if (!connected || !roomState.hostConnected) {
    return `<div class="player-turn-state is-paused" role="status"><strong>${connected ? 'Host disconnected' : 'Reconnecting'}</strong><span>Play resumes when the connection returns.</span></div>`;
  }
  if (ineligible) {
    return `<div class="player-turn-state is-locked" role="status"><strong>You’ve answered this clue</strong><span>${responder ? `${escapeHtml(responder.name)} is ${clue.selfJudgePlayerId ? 'checking their response' : 'answering'} now.` : 'Waiting for this clue to finish.'}</span></div>`;
  }
  if (yourBuzz) {
    return `<div class="player-turn-state is-queued" role="status"><strong>${yourBuzz.position === 2 ? 'You’re next' : `You’re #${yourBuzz.position} in the buzz order`}</strong><span>${escapeHtml(responder?.name || 'The first contestant')} is answering.</span></div>`;
  }
  if (clue.dailyDouble) {
    const dailyPlayer = playerById(clue.dailyPlayerId);
    return `<div class="player-turn-state" role="status"><strong>${escapeHtml(dailyPlayer?.name || 'Another player')}’s Daily Double</strong><span>${clue.selfJudgePlayerId ? 'They’re checking their response.' : 'Only they can answer this clue.'}</span></div>`;
  }
  if (responder) {
    return `<div class="player-turn-state" role="status"><strong>${escapeHtml(responder.name)} is ${clue.selfJudgePlayerId ? 'checking' : 'answering'}</strong><span>${clue.buzzOpen ? 'Buzz to join the queue.' : 'Wait for the next turn.'}</span></div>`;
  }
  if (!clue.buzzOpen) {
    return '<div class="player-turn-state is-paused" role="status"><strong>Buzzers paused</strong><span>Wait for the room creator to reopen them.</span></div>';
  }
  return '<div class="player-turn-state is-open" role="status"><strong>Buzzers open</strong><span>First buzz answers.</span></div>';
}

function renderPlayerClue(clue) {
  if (clue.phase === 'daily-wager') {
    if (roomState.role === 'host') return renderDailyWager(clue);
    const choosingPlayer = playerById(roomState.controlPlayerId);
    return `
      <div class="clue-overlay player-overlay" role="dialog" aria-modal="true" aria-labelledby="player-daily-title">
        <div class="clue-stage player-clue-stage daily-stage" tabindex="-1">
          <p class="daily-banner">Daily Double</p>
          <h2 id="player-daily-title">${choosingPlayer?.id === roomState.you?.id ? 'This Daily Double is yours.' : choosingPlayer ? `${escapeHtml(choosingPlayer.name)} is wagering.` : 'The host is setting the wager.'}</h2>
          <p class="waiting-copy">${choosingPlayer?.id === roomState.you?.id ? `Say your wager aloud, up to ${formatMoney(Math.max(roomState.you.score, 1000))}. The room creator will enter it.` : 'The clue appears when the wager is locked.'}</p>
        </div>
      </div>`;
  }
  const you = roomState.you;
  const yourBuzz = clue.buzzes.find((buzz) => buzz.playerId === you?.id);
  const ineligible = clue.ineligiblePlayerIds.includes(you?.id);
  const canBuzz = connected && roomState.hostConnected && !clue.dailyDouble && clue.buzzOpen && !clue.revealed && !yourBuzz && !ineligible;

  return `
    <div class="clue-overlay player-overlay" role="dialog" aria-modal="true" aria-labelledby="player-clue-question">
      <div class="clue-stage player-clue-stage player-clue-card" tabindex="-1">
        <div class="clue-topline">
          <span>${clue.dailyDouble ? 'Daily Double · ' : ''}${escapeHtml(clue.category)}</span>
          <strong>${formatMoney(clue.value)}</strong>
        </div>
        <h2 class="clue-question" id="player-clue-question">${escapeHtml(clue.question)}</h2>
        <div class="player-clue-controls">
          <div class="player-clue-action ${canBuzz ? 'has-buzzer' : ''}">
            ${canBuzz ? `<button class="buzzer" type="button" data-action="buzz" aria-label="Buzz in" aria-keyshortcuts="Space">
              <span class="buzzer-face">BUZZ</span>
              <small><kbd>SPACE</kbd> / tap</small>
            </button>` : ''}
            ${renderPlayerTurnState(clue, you, yourBuzz, ineligible)}
          </div>
          ${clue.dailyDouble || !clue.buzzes.length ? '' : renderBuzzQueue(clue)}
          <div class="player-clue-footer">
            ${roomState.role === 'host' ? renderCreatorClueControls(clue) : ''}
            ${clue.canSkipClue ? `
              <details class="player-skip-controls">
                <summary id="player-skip-toggle">Skip clue</summary>
                <div class="player-skip-confirm">
                  <p>End this clue for everyone? Current scores stay as they are.</p>
                  <div class="player-skip-actions">
                    <button class="button button-secondary" type="button" data-action="cancel-player-skip">Cancel</button>
                    <button class="button player-skip-button" type="button" data-action="player-skip-clue" data-clue-key="${escapeAttr(clue.clueKey)}" ${connected ? '' : 'disabled'}>Skip for everyone</button>
                  </div>
                </div>
              </details>` : ''}
          </div>
        </div>
      </div>
    </div>`;
}

function renderCreatorClueControls(clue) {
  const responder = playerById(clue.responderPlayerId);
  return `
    <details class="creator-controls">
      <summary>Room controls</summary>
      <div class="dialog-actions host-clue-actions">
        ${!clue.revealed && !responder ? '<button class="button button-secondary" type="button" data-action="reveal-answer">Reveal unclaimed answer</button>' : ''}
        ${!clue.dailyDouble && !clue.revealed ? `<button class="button button-secondary" type="button" data-action="reset-buzzers" ${clue.selfJudgePlayerId ? 'disabled title="A player is checking their response"' : ''}>Reset buzzers</button>` : ''}
        ${responder && !responder.connected && !responder.isHost ? `<button class="button button-secondary" type="button" data-action="remove-player" data-player-id="${escapeAttr(responder.id)}">Remove disconnected ${escapeHtml(responder.name)}</button>` : ''}
        <button class="button button-secondary" type="button" data-action="skip-clue">${clue.revealed ? 'Close clue' : 'End clue'}</button>
      </div>
    </details>`;
}

function renderBoard() {
  const allClues = roomState.game.categories.flatMap((category) => category.clues);
  const answeredCount = allClues.filter((clue) => clue.answered).length;
  const choosingPlayer = playerById(roomState.controlPlayerId);
  const everyonePlays = roomState.players.some((player) => player.isHost);
  const finished = answeredCount === allClues.length;
  return `
    <div class="game-shell">
      <div class="game-main">
        <header class="game-titlebar">
          <div><p class="panel-label">Board · ${answeredCount}/${allClues.length} played</p><h2 tabindex="-1">${escapeHtml(roomState.game.title)}</h2></div>
          ${roomState.role === 'host' ? renderHostBoardControls() : `<div class="player-score-chip"><span>Your score</span><strong>${formatMoney(roomState.you?.score)}</strong></div>`}
        </header>
        ${finished ? `<section class="board-finished"><h3>That's the board.</h3><p>${roomState.role === 'host' ? 'Head to Final Jeopardy, or choose another game.' : 'The room creator can start Final Jeopardy or choose another game.'}</p></section>` : `
          <div class="board-turn-strip ${roomState.canChooseClue ? 'is-your-turn' : ''}">
            <strong>${roomState.canChooseClue ? 'Your pick' : choosingPlayer ? `${escapeHtml(choosingPlayer.name)} picks next` : everyonePlays ? 'Waiting for a player' : 'Host picks the next clue'}</strong>
            <span>${everyonePlays ? 'Answer correctly to choose the next clue.' : 'Pick a category and value. Everyone gets a buzzer.'}</span>
          </div>`}
        ${renderBoardGrid()}
      </div>
      ${renderScoreboard()}
    </div>
    ${roomState.currentClue ? (roomState.you ? renderPlayerClue(roomState.currentClue) : renderHostClue(roomState.currentClue)) : ''}`;
}

function submissionStatus(submission, type) {
  const complete = type === 'wager' ? submission.wagerSubmitted : submission.responseSubmitted;
  const isYou = submission.playerId === roomState.you?.id;
  return `<li class="${isYou ? 'is-you' : ''}"><span class="presence-dot ${complete ? '' : 'waiting'}"></span><strong>${escapeHtml(submission.name)}${isYou ? ' <i>You</i>' : ''}</strong><em>${complete ? 'Ready' : 'Waiting'}</em></li>`;
}

function renderFinalHost(final) {
  if (final.phase === 'wager') {
    const pending = final.submissions.filter((submission) => !submission.wagerSubmitted).length;
    return `
      <div class="final-panel">
        <p class="final-wordmark">FINAL JEOPARDY</p>
        <span class="final-category">${escapeHtml(final.category)}</span>
        <h2>Players are placing their wagers.</h2>
        <ul class="submission-list">${final.submissions.map((submission) => submissionStatus(submission, 'wager')).join('')}</ul>
        <button class="button button-gold button-large" type="button" data-action="advance-final">Lock wagers & reveal clue${pending ? ` · ${pending} waiting` : ''}</button>
      </div>`;
  }
  if (final.phase === 'clue') {
    const pending = final.submissions.filter((submission) => !submission.responseSubmitted).length;
    return `
      <div class="final-panel final-clue-panel">
        <p class="final-wordmark">FINAL JEOPARDY</p>
        <span class="final-category">${escapeHtml(final.category)}</span>
        <h2>${escapeHtml(final.clue)}</h2>
        <ul class="submission-list">${final.submissions.map((submission) => submissionStatus(submission, 'response')).join('')}</ul>
        <button class="button button-gold button-large" type="button" data-action="advance-final">Send answer to contestants${pending ? ` · ${pending} waiting` : ''}</button>
      </div>`;
  }
  if (final.phase === 'answer') {
    const pending = final.submissions.filter((submission) => !submission.scored).length;
    return `
      <div class="final-panel final-judge-panel">
        <p class="final-wordmark">FINAL JEOPARDY</p>
        <span class="final-category">${escapeHtml(final.category)}</span>
        <h2>${escapeHtml(final.clue)}</h2>
        <div class="host-turn-status ${pending ? 'is-checking' : 'is-revealed'}" role="status">
          <span>Private self-check</span>
          <strong>${pending ? `${pending} contestant${pending === 1 ? '' : 's'} still checking` : 'Every response is scored'}</strong>
          <p>The official response and submitted answers stay on contestant screens. The host sees status only.</p>
        </div>
        <div class="final-response-grid">
          ${final.submissions.map((submission) => `
            <article class="final-response-card ${submission.scored ? 'scored' : ''}">
              <div><span>${escapeHtml(submission.name)}</span><strong>${submission.scored ? 'Scored' : 'Checking'}</strong></div>
              <p class="result-stamp ${submission.scored ? (submission.correct ? 'correct' : 'incorrect') : ''}">${submission.scored ? (submission.correct ? 'Self-marked correct' : 'Self-marked incorrect') : 'Waiting on contestant'}</p>
            </article>
          `).join('')}
        </div>
        <button class="button button-gold button-large" type="button" data-action="finish-final">${pending ? 'Finish with pending marked incorrect' : 'Show final standings'}</button>
      </div>`;
  }
  return renderFinalStandings();
}

function renderFinalStandings() {
  const ranked = [...roomState.players].sort((first, second) => second.score - first.score);
  return `
    <div class="final-panel standings-panel">
      <p class="final-wordmark">FINAL SCORES</p>
      <div class="podium-list">
        ${ranked.map((player) => {
          const place = ranked.findIndex((candidate) => candidate.score === player.score) + 1;
          return `<article class="podium-row place-${place}">
            <span>${place}</span><strong>${escapeHtml(player.name)}</strong><em>${formatMoney(player.score)}</em>
          </article>`;
        }).join('')}
      </div>
      ${roomState.role === 'host' ? '<button class="button button-gold button-large" type="button" data-action="return-lobby">Choose another game</button>' : '<p class="waiting-copy">The host can start another game from here.</p>'}
    </div>`;
}

function renderFinalPlayer(final) {
  const you = roomState.you;
  const maxWager = final.yourMaxWager ?? you?.score ?? 0;
  if (!final.eligible && final.phase !== 'complete') {
    return `
      <div class="final-panel player-final-panel">
        <p class="final-wordmark">FINAL JEOPARDY</p>
        <span class="final-category">${escapeHtml(final.category)}</span>
        <div class="submission-confirmed">
          <span>Watching this round</span>
          <strong>Score required</strong>
          <p>Players need a positive score to wager in Final Jeopardy. You will still see the clue and final standings.</p>
        </div>
        ${final.clue ? `<h2>${escapeHtml(final.clue)}</h2>` : ''}
        ${final.answer ? `<div class="final-answer"><span>Correct response</span><strong>${escapeHtml(final.answer)}</strong></div>` : ''}
      </div>`;
  }
  if (final.phase === 'wager') {
    return `
      <div class="final-panel player-final-panel">
        <p class="final-wordmark">FINAL JEOPARDY</p>
        <span class="final-category">${escapeHtml(final.category)}</span>
        ${final.yourWagerSubmitted
          ? `<div class="submission-confirmed"><span>Wager locked</span><strong>${formatMoney(final.yourWager)}</strong><p>Waiting for the host to reveal the clue.</p></div>`
          : `<form id="final-wager-form" class="final-entry-form">
              <label><span>Your wager · max ${formatMoney(maxWager)}</span><input id="final-wager" type="number" name="wager" min="0" max="${maxWager}" step="1" value="${escapeAttr(drafts.finalWager)}" required autofocus></label>
              <button class="button button-gold button-large" type="submit">Lock wager</button>
            </form>`}
      </div>`;
  }
  if (final.phase === 'clue') {
    return `
      <div class="final-panel player-final-panel final-clue-panel">
        <p class="final-wordmark">FINAL JEOPARDY</p>
        <span class="final-category">${escapeHtml(final.category)}</span>
        <h2>${escapeHtml(final.clue)}</h2>
        ${final.yourResponseSubmitted
          ? '<div class="submission-confirmed"><span>Response locked</span><p>Waiting for the reveal.</p></div>'
          : `<form id="final-response-form" class="final-entry-form">
              <label><span>Your response</span><input id="final-response" type="text" name="response" maxlength="200" value="${escapeAttr(drafts.finalResponse)}" placeholder="What is…?" required autocomplete="off" autofocus></label>
              <button class="button button-gold button-large" type="submit">Lock response</button>
            </form>`}
      </div>`;
  }
  if (final.phase === 'answer') {
    return `
      <div class="final-panel player-final-panel">
        <p class="final-wordmark">FINAL JEOPARDY</p>
        <span class="final-category">${escapeHtml(final.category)}</span>
        <h2>${escapeHtml(final.clue)}</h2>
        <div class="final-answer"><span>Correct response</span><strong>${escapeHtml(final.answer)}</strong></div>
        <section class="final-self-judge">
          <span>Your locked response · ${formatMoney(final.yourWager)}</span>
          <blockquote>${escapeHtml(final.yourResponse || '(No response submitted)')}</blockquote>
          ${final.canSelfScore
            ? `<p>Compare the two, then score your own response.</p>
              <div class="self-judge-actions">
                <button class="judge-correct" type="button" data-action="self-score-final" data-correct="true">I was correct</button>
                <button class="judge-wrong" type="button" data-action="self-score-final" data-correct="false">I was incorrect</button>
              </div>`
            : `<div class="submission-confirmed"><span>Result locked</span><strong>${final.yourResult ? 'Correct' : 'Incorrect'}</strong></div>`}
        </section>
      </div>`;
  }
  return renderFinalStandings();
}

function renderFinal() {
  const final = roomState.final;
  return `
    <div class="final-stage">
      <div class="final-main">
        ${roomState.you ? renderFinalPlayer(final) : renderFinalHost(final)}
        ${roomState.role === 'host' && roomState.you && final.phase !== 'complete' ? renderCreatorFinalControls(final) : ''}
      </div>
      <aside class="final-score-strip">${renderScoreboard()}</aside>
    </div>`;
}

function renderCreatorFinalControls(final) {
  const statusType = final.phase === 'wager' ? 'wager' : 'response';
  const pending = final.submissions.filter((submission) => final.phase === 'wager'
    ? !submission.wagerSubmitted
    : final.phase === 'clue' ? !submission.responseSubmitted : !submission.scored).length;
  const yourEntryPending = final.eligible && (final.phase === 'wager'
    ? !final.yourWagerSubmitted
    : final.phase === 'clue' ? !final.yourResponseSubmitted : final.canSelfScore);
  const action = final.phase === 'answer' ? 'finish-final' : 'advance-final';
  const actionLabel = final.phase === 'wager' ? 'Reveal Final clue' : final.phase === 'clue' ? 'Reveal answer' : 'Show final standings';
  return `
    <section class="final-room-controls">
      <p class="panel-label">Room progress · ${pending ? `${pending} waiting` : 'Everyone is ready'}</p>
      ${final.phase === 'answer'
        ? `<ul class="submission-list">${final.submissions.map((submission) => `<li><span class="presence-dot ${submission.scored ? '' : 'waiting'}"></span><strong>${escapeHtml(submission.name)}</strong><em>${submission.scored ? 'Scored' : 'Checking'}</em></li>`).join('')}</ul>`
        : `<ul class="submission-list">${final.submissions.map((submission) => submissionStatus(submission, statusType)).join('')}</ul>`}
      <button class="button button-secondary" type="button" data-action="${action}" ${yourEntryPending ? 'disabled' : ''}>${actionLabel}</button>
      ${yourEntryPending ? '<p class="waiting-copy">Complete your own turn first.</p>' : ''}
    </section>`;
}

function renderRoom() {
  const previousDialogKey = activeDialogKey;
  const clueKey = roomState.currentClue?.clueKey || '';
  const creatorControlsOpen = clueKey && clueKey === renderedClueKey
    && elements.roomContent.querySelector('details.creator-controls')?.open;
  const skipControlsOpen = clueKey && clueKey === renderedClueKey
    && elements.roomContent.querySelector('details.player-skip-controls')?.open;
  const activeElement = document.activeElement;
  const focusSelector = focusSelectorFor(activeElement);
  const inputSelection = focusSelector && activeElement?.matches?.('input, textarea')
    && typeof activeElement.selectionStart === 'number'
    && typeof activeElement.selectionEnd === 'number'
    ? {
        start: activeElement.selectionStart,
        end: activeElement.selectionEnd,
      }
    : null;
  elements.roomCodeButton.textContent = roomState.code;
  const creatorPlaying = roomState.role === 'host' && Boolean(roomState.you);
  elements.roleChip.textContent = creatorPlaying ? 'Playing · Room creator' : roomState.role === 'host' ? 'Room creator' : 'Player';
  elements.roleChip.classList.toggle('player-role', roomState.role === 'player');
  elements.roleChip.classList.toggle('dual-role', creatorPlaying);
  elements.roomHeader.classList.toggle('dual-role-header', creatorPlaying);
  elements.leaveRoomButton.textContent = roomState.role === 'host' ? 'End room' : 'Leave';

  const hostOfflineNotice = roomState.role === 'player' && !roomState.hostConnected
    ? '<div class="host-offline-banner" role="status"><strong>Host disconnected.</strong> Buzzing is paused while their screen reconnects.</div>'
    : '';

  if (roomState.phase === 'lobby') {
    elements.roomContent.innerHTML = hostOfflineNotice + (roomState.role === 'host' ? renderHostLobby() : renderPlayerLobby());
  } else if (roomState.phase === 'board') {
    elements.roomContent.innerHTML = hostOfflineNotice + renderBoard();
  } else if (roomState.phase === 'final') {
    elements.roomContent.innerHTML = hostOfflineNotice + renderFinal();
  }
  const hostGameList = elements.roomContent.querySelector('.host-game-list');
  if (hostGameList) hostGameList.scrollTop = hostGameListScroll;
  const creatorControls = elements.roomContent.querySelector('details.creator-controls');
  if (creatorControls) creatorControls.open = Boolean(creatorControlsOpen);
  const skipControls = elements.roomContent.querySelector('details.player-skip-controls');
  if (skipControls) skipControls.open = Boolean(skipControlsOpen);
  renderedClueKey = clueKey;
  manageDialogFocus(previousDialogKey, focusSelector);
  if (inputSelection) {
    const input = elements.roomContent.querySelector(focusSelector);
    const valueLength = input?.value.length || 0;
    input?.focus();
    input?.setSelectionRange?.(
      Math.min(inputSelection.start, valueLength),
      Math.min(inputSelection.end, valueLength),
    );
  }
}

function render() {
  const inRoom = Boolean(roomState);
  const screenKey = inRoom ? `${roomState.code}:${roomState.phase}` : 'landing';
  elements.landingScreen.classList.toggle('hidden', inRoom);
  elements.roomScreen.classList.toggle('hidden', !inRoom);
  if (inRoom) renderRoom();
  else {
    elements.roomHeader.inert = false;
    activeDialogKey = '';
    renderPublicLobby();
  }
  setConnectionState(connected);
  if (screenKey !== renderedScreenKey) window.scrollTo(0, 0);
  renderedScreenKey = screenKey;
}

async function createRoom(gameId = null, { buildCustom = false } = {}) {
  const response = await runAction(() => request('room:create'));
  if (!response) return;
  roomState = response.state;
  preferredGameId = gameId || '';
  saveSession(response.session);
  shouldResumeOnConnect = true;
  resetDrafts();
  customBuilderOpen = buildCustom;
  customBuilderSection = 0;
  if (gameId) {
    gameFilter = '';
    hostGameListScroll = 0;
  }
  render();
  if (!gameId) {
    showToast('Room created. Share the code when you are ready.', 'success');
  }
}

async function joinRoom(form) {
  if (mutationPending) return;
  const code = form.code.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  const name = form.name.value.trim();
  clearJoinError();
  joining = true;
  elements.joinRoomButton.textContent = 'Joining…';
  elements.joinRoomForm.ariaBusy = 'true';
  setConnectionState(connected);
  const response = await runAction(() => request('room:join', { code, name }), {
    quiet: true,
    onError(error) {
      elements.joinError.textContent = error.message;
      elements.joinError.hidden = false;
      const input = error.code === 'ROOM_NOT_FOUND' ? elements.joinCode
        : ['INVALID_NAME', 'NAME_TAKEN'].includes(error.code) ? elements.joinName : null;
      if (input) {
        input.ariaInvalid = 'true';
        input.focus();
      }
    },
  });
  joining = false;
  elements.joinRoomButton.textContent = 'Join room';
  elements.joinRoomForm.ariaBusy = 'false';
  setConnectionState(connected);
  if (!response) return;
  roomState = response.state;
  preferredGameId = '';
  saveSession(response.session);
  shouldResumeOnConnect = true;
  localStorage.setItem(NAME_KEY, name);
  resetDrafts();
  render();
  showToast(`Joined room ${response.session.code}.`, 'success');
}

function clearJoinError() {
  elements.joinError.hidden = true;
  elements.joinError.textContent = '';
  elements.joinCode.ariaInvalid = 'false';
  elements.joinName.ariaInvalid = 'false';
}

async function leaveRoom() {
  const isHost = roomState?.role === 'host';
  if (isHost && !window.confirm('End this room for everyone?')) return;
  try {
    await request(isHost ? 'room:close' : 'room:leave');
  } catch (error) {
    showToast(error.message, 'error');
    return;
  }
  clearSession();
  shouldResumeOnConnect = false;
  roomState = null;
  resetDrafts();
  render();
}

elements.createRoomButton.addEventListener('click', () => void createRoom());
elements.createCustomRoomButton.addEventListener('click', () => void createRoom(null, { buildCustom: true }));
elements.publicGameList.addEventListener('click', (event) => {
  if (event.target.closest('[data-catalog-retry]')) {
    void loadCatalog();
    return;
  }
  const row = event.target.closest('[data-public-game-id]');
  if (!row || row.disabled) return;
  void createRoom(row.dataset.publicGameId);
});
elements.landingGameFilter.addEventListener('input', () => {
  landingGameFilter = elements.landingGameFilter.value;
  renderPublicLobby();
  elements.landingGameFilter.focus();
  elements.landingGameFilter.setSelectionRange(landingGameFilter.length, landingGameFilter.length);
});
elements.landingYearFilter.addEventListener('change', () => {
  landingYearFilter = elements.landingYearFilter.value;
  renderPublicLobby();
});
elements.joinRoomForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void joinRoom(event.currentTarget.elements);
});
elements.joinCode.addEventListener('input', () => {
  clearJoinError();
  elements.joinCode.value = elements.joinCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
});
elements.joinName.addEventListener('input', clearJoinError);
elements.roomCodeButton.addEventListener('click', () => void copyInvite());
elements.leaveRoomButton.addEventListener('click', () => void leaveRoom());

function canBuzzWithKeyboard(event) {
  const target = event.target;
  if (target?.matches?.('input, textarea, select, button, summary, [contenteditable="true"]')) return false;
  if (!connected || event.repeat || roomState?.phase !== 'board' || !roomState.currentClue || !roomState.you) return false;
  const clue = roomState.currentClue;
  if (clue.dailyDouble || !clue.buzzOpen || clue.revealed) return false;
  if (roomState.role === 'player' && !roomState.hostConnected) return false;
  if (clue.ineligiblePlayerIds.includes(roomState.you.id)) return false;
  return !clue.buzzes.some((buzz) => buzz.playerId === roomState.you.id);
}

document.addEventListener('keydown', (event) => {
  if (event.code !== 'Space' || !canBuzzWithKeyboard(event)) return;
  event.preventDefault();
  void runAction(() => request('player:buzz'));
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab') return;
  const overlay = elements.roomContent.querySelector('.clue-overlay, .custom-builder-overlay');
  if (!overlay) return;
  const focusable = [...overlay.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex]:not([tabindex="-1"])')]
    .filter((element) => !element.hidden && element.getClientRects().length > 0);
  if (focusable.length === 0) {
    event.preventDefault();
    overlay.querySelector('.clue-stage, .custom-builder-dialog')?.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const activeIndex = focusable.indexOf(document.activeElement);
  if (event.shiftKey && activeIndex <= 0) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (activeIndex === -1 || activeIndex === focusable.length - 1)) {
    event.preventDefault();
    first.focus();
  }
});

elements.roomContent.addEventListener('input', (event) => {
  const customField = event.target.dataset?.customField;
  if (customField) {
    const categoryIndex = Number(event.target.dataset.categoryIndex);
    const clueIndex = Number(event.target.dataset.clueIndex);
    if (customField === 'title') customBoardDraft.title = event.target.value;
    else if (customField === 'description') customBoardDraft.description = event.target.value;
    else if (customField === 'category-name') customBoardDraft.categories[categoryIndex].name = event.target.value;
    else if (customField === 'clue') customBoardDraft.categories[categoryIndex].clues[clueIndex].clue = event.target.value;
    else if (customField === 'answer') customBoardDraft.categories[categoryIndex].clues[clueIndex].answer = event.target.value;
    else if (customField === 'final-category') customBoardDraft.finalJeopardy.category = event.target.value;
    else if (customField === 'final-clue') customBoardDraft.finalJeopardy.clue = event.target.value;
    else if (customField === 'final-answer') customBoardDraft.finalJeopardy.answer = event.target.value;
    else if (customField === 'daily-double') customBoardDraft.dailyDouble = event.target.value;
  } else if (event.target.id === 'game-filter') {
    gameFilter = event.target.value;
    hostGameListScroll = 0;
    renderRoom();
    const input = document.querySelector('#game-filter');
    input?.focus();
    input?.setSelectionRange(gameFilter.length, gameFilter.length);
  } else if (event.target.id === 'daily-wager') {
    drafts.dailyWager = event.target.value;
  } else if (event.target.id === 'host-contestant-name') {
    drafts.hostName = event.target.value;
  } else if (event.target.id === 'final-wager') {
    drafts.finalWager = event.target.value;
  } else if (event.target.id === 'final-response') {
    drafts.finalResponse = event.target.value;
  }
});

elements.roomContent.addEventListener('scroll', (event) => {
  if (event.target.classList?.contains('host-game-list')) hostGameListScroll = event.target.scrollTop;
}, true);

elements.roomContent.addEventListener('change', (event) => {
  if (event.target.id === 'game-year-filter') {
    gameYearFilter = event.target.value;
    hostGameListScroll = 0;
    renderRoom();
  } else if (event.target.dataset?.customField === 'daily-double') {
    customBoardDraft.dailyDouble = event.target.value;
  } else if (event.target.id === 'daily-player') {
    drafts.dailyPlayerId = event.target.value;
    const selected = playerById(drafts.dailyPlayerId);
    const max = Math.max(selected?.score || 0, 1000);
    const wager = Number(drafts.dailyWager);
    if (!Number.isFinite(wager) || wager > max) drafts.dailyWager = String(max);
    renderRoom();
  }
});

elements.roomContent.addEventListener('submit', (event) => {
  event.preventDefault();
  if (event.target.id === 'host-contestant-form') {
    const name = event.target.elements.name.value.trim();
    void runAction(async () => {
      await request('host:join-contestants', { name });
      localStorage.setItem(NAME_KEY, name);
      drafts.hostName = name;
      showToast('You joined the players. Your answers stay private.', 'success');
    });
  } else if (event.target.id === 'custom-game-form') {
    void runAction(async () => {
      const problem = customDraftProblem();
      if (problem) {
        customBuilderSection = problem.section;
        renderRoom();
        showToast(problem.message, 'error');
        return;
      }
      const response = await request('host:create-custom-game', { game: customGamePayload() });
      setPreferredGame(response.result?.gameId || '');
      gameFilter = '';
      gameYearFilter = 'all';
      customBuilderOpen = false;
      customBuilderSection = 0;
      customBoardDraft = emptyCustomBoardDraft();
      renderRoom();
      showToast('Custom board saved and selected.', 'success');
    });
  } else if (event.target.id === 'daily-wager-form') {
    void runAction(() => request('host:set-daily-double', {
      playerId: event.target.elements.playerId.value,
      wager: Number(event.target.elements.wager.value),
    }));
  } else if (event.target.id === 'final-wager-form') {
    void runAction(async () => {
      await request('player:final-wager', { wager: Number(event.target.elements.wager.value) });
      drafts.finalWager = '';
      renderRoom();
    });
  } else if (event.target.id === 'final-response-form') {
    void runAction(async () => {
      await request('player:final-response', { response: event.target.elements.response.value });
      drafts.finalResponse = '';
      renderRoom();
    });
  }
});

elements.roomContent.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target || target.disabled) return;
  const action = target.dataset.action;
  const playerId = target.dataset.playerId;

  if (action === 'cancel-player-skip') {
    const controls = target.closest('details.player-skip-controls');
    if (controls) {
      controls.open = false;
      controls.querySelector('summary')?.focus();
    }
    return;
  }

  if (action === 'open-custom-builder') {
    customBuilderOpen = true;
    customBuilderSection = 0;
    renderRoom();
    return;
  }
  if (action === 'close-custom-builder') {
    customBuilderOpen = false;
    renderRoom();
    return;
  }
  if (action === 'custom-section') {
    customBuilderSection = Number(target.dataset.section);
    renderRoom();
    return;
  }
  if (action === 'previous-custom-section') {
    customBuilderSection = Math.max(0, customBuilderSection - 1);
    renderRoom();
    return;
  }
  if (action === 'next-custom-section') {
    customBuilderSection = Math.min(6, customBuilderSection + 1);
    renderRoom();
    return;
  }
  if (action === 'reset-custom-builder') {
    if (window.confirm('Clear every field in this custom board?')) {
      customBoardDraft = emptyCustomBoardDraft();
      customBuilderSection = 0;
      renderRoom();
    }
    return;
  }

  if (action === 'select-game') {
    setPreferredGame(target.dataset.gameId);
    hostGameListScroll = 0;
    renderRoom();
    return;
  }

  const actions = {
    'copy-invite': () => copyInvite(),
    'leave-contestants': () => request('host:leave-contestants'),
    'start-game': () => request('host:start-game', { gameId: target.dataset.gameId }),
    'remove-player': async () => {
      const player = playerById(playerId);
      if (player && window.confirm(`Remove ${player.name} from the room?`)) {
        await request('host:remove-player', { playerId });
      }
    },
    'open-clue': () => request(roomState.role === 'host' ? 'host:open-clue' : 'player:open-clue', {
      categoryIndex: Number(target.dataset.categoryIndex),
      clueIndex: Number(target.dataset.clueIndex),
    }),
    'reveal-answer': () => request('host:reveal-answer'),
    'reset-buzzers': () => request('host:reset-buzzers'),
    'skip-clue': () => request('host:skip-clue'),
    'player-skip-clue': () => request('player:skip-clue', { clueKey: target.dataset.clueKey }),
    'cancel-clue': () => request('host:cancel-clue'),
    'open-player-answer': () => request('player:open-answer', { clueKey: roomState.currentClue?.clueKey }),
    'self-score-clue': () => request('player:self-score-clue', { clueKey: roomState.currentClue?.clueKey, correct: target.dataset.correct === 'true' }),
    'adjust-score': () => request('host:adjust-score', { playerId, delta: Number(target.dataset.delta) }),
    'buzz': () => request('player:buzz'),
    'reset-game': async () => {
      if (window.confirm('Reset the board and every score?')) await request('host:reset-game');
    },
    'return-lobby': async () => {
      let returned = false;
      if (roomState.phase === 'final' && roomState.final?.phase === 'complete') {
        await request('host:return-lobby');
        returned = true;
      } else if (window.confirm('Return to the game library? Current scores and board progress will be cleared.')) {
        await request('host:return-lobby');
        returned = true;
      }
      if (returned) {
        setPreferredGame('');
        gameFilter = '';
        gameYearFilter = 'all';
        hostGameListScroll = 0;
        customBuilderOpen = false;
        renderRoom();
      }
    },
    'start-final': () => request('host:start-final'),
    'advance-final': async () => {
      const final = roomState.final;
      if (!final) return;
      const awaitingWagers = final.phase === 'wager';
      const pending = final.submissions.filter((submission) => (
        awaitingWagers ? !submission.wagerSubmitted : !submission.responseSubmitted
      )).length;
      if (pending) {
        const consequence = awaitingWagers
          ? `Continue without ${pending} wager${pending === 1 ? '' : 's'}? Missing wagers will be set to $0.`
          : `Reveal the answer without ${pending} response${pending === 1 ? '' : 's'}? Missing responses will be marked incorrect and their wagers deducted.`;
        if (!window.confirm(consequence)) return;
      }
      await request('host:advance-final', { phase: final.phase, force: pending > 0 });
    },
    'self-score-final': () => request('player:self-score-final', { correct: target.dataset.correct === 'true' }),
    'finish-final': async () => {
      const pending = roomState.final?.submissions.filter((submission) => !submission.scored).length || 0;
      if (!pending || window.confirm(`Finish Final Jeopardy and mark ${pending} pending response${pending === 1 ? '' : 's'} incorrect?`)) {
        await request('host:finish-final');
      }
    },
  };

  if (actions[action]) void runAction(actions[action]);
});

socket.on('connect', () => {
  setConnectionState(true);
  if (shouldResumeOnConnect && savedSession()) void resumeSavedSession();
  else render();
});

socket.on('disconnect', () => {
  setConnectionState(false);
});

socket.on('room:state', (state) => {
  const priorClue = roomState?.currentClue;
  const priorPhase = roomState?.phase;
  const priorGameId = roomState?.game?.id;
  roomState = state;
  if (!state.currentClue || state.currentClue.category !== priorClue?.category || state.currentClue.boardValue !== priorClue?.boardValue) {
    drafts.dailyPlayerId = '';
    drafts.dailyWager = '';
  }
  if (priorGameId !== state.game?.id || (priorPhase !== 'final' && state.phase === 'final') || (priorPhase === 'final' && state.phase !== 'final')) {
    drafts.finalWager = '';
    drafts.finalResponse = '';
  }
  render();
});

socket.on('room:error', ({ message }) => showToast(message, 'error'));
socket.on('room:closed', ({ message }) => {
  clearSession();
  shouldResumeOnConnect = false;
  roomState = null;
  resetDrafts();
  render();
  showToast(message, 'info');
});
socket.on('room:removed', ({ message }) => {
  clearSession();
  shouldResumeOnConnect = false;
  roomState = null;
  resetDrafts();
  render();
  showToast(message, 'error');
});

socket.on('room:replaced', ({ message }) => {
  roomState = null;
  resetDrafts();
  render();
  showToast(`${message} Reload this page if you want to take control here again.`, 'info');
});

async function boot() {
  const roomCode = new URLSearchParams(window.location.search).get('room');
  const inviteCode = roomCode?.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5) || '';
  if (inviteCode) elements.joinCode.value = inviteCode;
  elements.joinName.value = localStorage.getItem(NAME_KEY) || '';
  const session = savedSession();
  if (inviteCode && session?.code && inviteCode !== session.code) {
    shouldResumeOnConnect = false;
    showToast(`Invite ${inviteCode} opened. Your saved ${session.code} session was left untouched.`, 'info');
  }
  render();
  socket.connect();
  void loadCatalog();
  try {
    const response = await fetch('/api/network', { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return;
    const network = await response.json();
    if (Array.isArray(network.urls) && network.urls.length) networkUrls = network.urls;
    render();
  } catch {
    // Invites still work with the current origin when network discovery fails.
  }
}

void boot();
