'use strict';

const PARTY_STORAGE_KEY = 'jeoparty_party_v1';
const partyElements = Object.fromEntries([
  'party-setup', 'party-game', 'party-setup-form', 'resume-panel', 'resume-title', 'resume-detail',
  'resume-game', 'board-select', 'random-board', 'board-preview', 'share-setup', 'player-fields',
  'add-player', 'start-party', 'setup-error', 'game-title', 'game-progress', 'share-game',
  'restart-game', 'change-board', 'party-scoreboard', 'party-results', 'results-title',
  'results-detail', 'play-again', 'choose-next', 'party-board', 'party-save-note', 'party-status',
  'clue-dialog', 'clue-title', 'clue-prompt', 'clue-answer', 'clue-answer-text', 'reveal-answer',
  'score-actions', 'close-clue', 'skip-clue',
].map((id) => [id, document.getElementById(id)]));

let partyState = null;
let partySelectedBoard = null;
let partyCatalog = [];
let partyNames = ['Player 1', 'Player 2'];
let partyLoading = false;
let partyRequest = 0;
let partyShowingSetup = true;
let partyStorageAvailable = true;

function escapeParty(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function partyMoney(value) {
  return `${value < 0 ? '−' : ''}$${Math.abs(value).toLocaleString()}`;
}

function partyStatus(message) {
  partyElements['party-status'].textContent = message;
}

function updateSaveNote() {
  partyElements['party-save-note'].textContent = partyStorageAvailable
    ? 'Your game saves in this browser.'
    : 'Browser storage is unavailable. This game will last only for this visit.';
  partyElements['party-save-note'].classList.toggle('is-warning', !partyStorageAvailable);
}

function loadParty() {
  let raw;
  try {
    raw = localStorage.getItem(PARTY_STORAGE_KEY);
  } catch {
    partyStorageAvailable = false;
    return null;
  }
  if (!raw) return null;
  try {
    return PartyState.normalizeState(JSON.parse(raw));
  } catch {
    return null;
  }
}

function saveParty() {
  if (!partyState) return;
  try {
    localStorage.setItem(PARTY_STORAGE_KEY, JSON.stringify(partyState));
    partyStorageAvailable = true;
  } catch {
    partyStorageAvailable = false;
  }
  updateSaveNote();
}

function boardLocation(board) {
  const url = new URL('/party', window.location.origin);
  if (board.seed) {
    url.searchParams.set('seed', board.seed);
    if (board.poolVersion) url.searchParams.set('version', board.poolVersion);
  } else {
    url.searchParams.set('board', board.id);
    if (board.boardVersion) url.searchParams.set('version', board.boardVersion);
  }
  return url;
}

function syncBoardLocation() {
  const url = boardLocation(partyState.board);
  window.history.replaceState(null, '', url.pathname + url.search);
}

async function sharePartyBoard(board) {
  if (!board) return;
  const url = boardLocation(board).href;
  try {
    await navigator.clipboard.writeText(url);
    partyStatus('Board link copied. Your scores and players stay on this device.');
  } catch {
    window.prompt('Copy this board link. It shares the board, not your scores.', url);
  }
}

function renderPlayerFields() {
  partyElements['player-fields'].innerHTML = partyNames.map((name, index) => `
    <div class="player-field">
      <label for="player-${index}"><span>Player ${index + 1}</span><input id="player-${index}" data-player-index="${index}" value="${escapeParty(name)}" maxlength="32" autocomplete="off" required></label>
      ${partyNames.length > 2 ? `<button class="text-button" type="button" data-remove-player="${index}" aria-label="Remove player ${index + 1}">Remove</button>` : ''}
    </div>`).join('');
  partyElements['add-player'].hidden = partyNames.length >= 6;
}

function renderBoardPicker() {
  const selectedId = partySelectedBoard?.id ?? '';
  const options = partyCatalog.map((board) =>
    `<option value="${escapeParty(board.id)}">${escapeParty(board.title)}</option>`);
  if (partySelectedBoard && !partyCatalog.some((board) => board.id === selectedId)) {
    options.unshift(`<option value="${escapeParty(selectedId)}">${escapeParty(partySelectedBoard.title)}</option>`);
  }
  partyElements['board-select'].innerHTML = options.length ? options.join('') : '<option value="">No boards loaded</option>';
  partyElements['board-select'].value = selectedId;
  partyElements['board-select'].disabled = partyLoading || partyCatalog.length === 0;
  partyElements['random-board'].disabled = partyLoading;
  partyElements['random-board'].textContent = partyLoading ? 'Loading…' : 'Random board';
  partyElements['start-party'].disabled = partyLoading || !partySelectedBoard;
  partyElements['share-setup'].disabled = partyLoading || !partySelectedBoard;
  if (!partySelectedBoard) {
    partyElements['board-preview'].innerHTML = partyLoading ? '<p>Loading your board…</p>'
      : '<p>No board loaded.</p><button class="button" type="button" id="retry-boards">Try again</button>';
    return;
  }
  const board = partySelectedBoard;
  partyElements['board-preview'].innerHTML = `
    <h3>${escapeParty(board.title)}</h3>
    <p>${board.categories.length} categories · ${PartyState.allClueKeys(board).length} clues${board.seed ? ' · A fresh mix' : ''}</p>
    <ul>${board.categories.map((category) => `<li>${escapeParty(category.name)}</li>`).join('')}</ul>`;
}

function renderResume() {
  partyElements['resume-panel'].hidden = !partyState;
  if (!partyState) return;
  partyElements['resume-title'].textContent = partyState.board.title;
  partyElements['resume-detail'].textContent = `${partyState.players.length} players · ${partyState.used.length} of ${PartyState.allClueKeys(partyState.board).length} clues played. Starting a new game replaces this save.`;
  partyElements['resume-game'].textContent = PartyState.isComplete(partyState) ? 'View results' : 'Resume game';
}

function showPartySetup() {
  partyShowingSetup = true;
  partyElements['party-setup'].hidden = false;
  partyElements['party-game'].hidden = true;
  partyElements['clue-dialog'].close();
  if (partyState) partyNames = partyState.players.map((player) => player.name);
  renderPlayerFields();
  renderResume();
  renderBoardPicker();
  partyElements['board-select'].focus();
}

function renderPartyScoreboard() {
  const leadingScore = Math.max(...partyState.players.map((player) => player.score));
  const hasScores = partyState.players.some((player) => player.score !== 0);
  partyElements['party-scoreboard'].style.setProperty('--players', partyState.players.length);
  partyElements['party-scoreboard'].innerHTML = partyState.players.map((player) => `
    <div class="party-player${hasScores && player.score === leadingScore ? ' is-leading' : ''}">
      <input value="${escapeParty(player.name)}" maxlength="32" data-rename-player="${escapeParty(player.id)}" aria-label="Rename ${escapeParty(player.name)}" title="Edit player name">
      <strong${player.score < 0 ? ' class="negative-score"' : ''}>${partyMoney(player.score)}</strong>
    </div>`).join('');
}

function renderPartyBoard() {
  const board = partyState.board;
  const used = new Set(partyState.used);
  const maxRows = Math.max(...board.categories.map((category) => category.clues.length));
  const tiles = board.categories.map((category) => `<div class="party-category">${escapeParty(category.name)}</div>`);
  for (let row = 0; row < maxRows; row += 1) {
    board.categories.forEach((category, categoryIndex) => {
      const clue = category.clues[row];
      if (!clue) { tiles.push('<div aria-hidden="true"></div>'); return; }
      const key = PartyState.clueKey(categoryIndex, row);
      const played = used.has(key);
      tiles.push(`<button class="party-tile" type="button" data-clue="${key}" aria-label="${escapeParty(category.name)}, ${partyMoney(clue.value)}${played ? ', played' : ''}"${played ? ' disabled' : ''}>${played ? '—' : partyMoney(clue.value)}</button>`);
    });
  }
  partyElements['party-board'].style.setProperty('--columns', board.categories.length);
  partyElements['party-board'].innerHTML = tiles.join('');
}

function renderPartyResults() {
  const complete = PartyState.isComplete(partyState);
  partyElements['party-results'].hidden = !complete;
  if (!complete) return;
  const score = Math.max(...partyState.players.map((player) => player.score));
  const winners = partyState.players.filter((player) => player.score === score);
  partyElements['results-title'].textContent = winners.length === 1 ? `${winners[0].name} wins` : `A ${winners.length}-way tie`;
  partyElements['results-detail'].textContent = `${winners.map((player) => player.name).join(', ')} · ${partyMoney(score)}`;
}

function renderPartyDialog() {
  const dialog = partyElements['clue-dialog'];
  const key = partyState.activeClue;
  if (!key) { if (dialog.open) dialog.close(); return; }
  const clue = PartyState.clueAt(partyState.board, key);
  const categoryIndex = Number(key.split(':')[0]);
  partyElements['clue-title'].textContent = `${partyState.board.categories[categoryIndex].name} · ${partyMoney(clue.value)}`;
  partyElements['clue-prompt'].textContent = clue.prompt;
  partyElements['clue-answer-text'].textContent = partyState.answerVisible ? clue.answer : '';
  partyElements['clue-answer'].hidden = !partyState.answerVisible;
  partyElements['reveal-answer'].hidden = partyState.answerVisible;
  partyElements['score-actions'].innerHTML = partyState.players.map((player, index) => `
    <div class="score-action-row">
      <div class="score-action-name"><kbd>${index + 1}</kbd><span>${escapeParty(player.name)}</span></div>
      <button class="button score-correct" data-score-player="${escapeParty(player.id)}" data-correct="true" data-score-key="${key}" type="button" aria-label="${escapeParty(player.name)} correct, add ${partyMoney(clue.value)}">+${partyMoney(clue.value)}</button>
      <button class="button score-incorrect" data-score-player="${escapeParty(player.id)}" data-correct="false" data-score-key="${key}" type="button" aria-label="${escapeParty(player.name)} incorrect, deduct ${partyMoney(clue.value)}">−${partyMoney(clue.value)}</button>
    </div>`).join('');
  if (!dialog.open) {
    dialog.showModal();
    partyElements['reveal-answer'].hidden ? partyElements['close-clue'].focus() : partyElements['reveal-answer'].focus();
  }
}

function renderPartyGame() {
  partyShowingSetup = false;
  partyElements['party-setup'].hidden = true;
  partyElements['party-game'].hidden = false;
  partyElements['game-title'].textContent = partyState.board.title;
  partyElements['game-progress'].textContent = `${partyState.used.length} / ${PartyState.allClueKeys(partyState.board).length} clues played`;
  renderPartyScoreboard();
  renderPartyBoard();
  renderPartyResults();
  renderPartyDialog();
}

function actOnParty(action) {
  const previous = partyState;
  partyState = PartyState.reduce(partyState, action);
  if (partyState === previous) return;
  saveParty();
  renderPartyGame();
  if (action.type === 'reveal') partyElements['score-actions'].querySelector('button')?.focus();
  if (previous.activeClue && !partyState.activeClue) {
    if (PartyState.isComplete(partyState)) partyElements['results-title'].focus();
    else (partyElements['party-board'].querySelector(`[data-clue="${previous.activeClue}"]:not(:disabled)`)
      ?? partyElements['party-board'].querySelector('button:not(:disabled)'))?.focus();
  }
  if (action.type === 'score') {
    const player = partyState.players.find((entry) => entry.id === action.playerId);
    partyStatus(`${player.name}: ${partyMoney(player.score)}. Clue complete.`);
  } else if (action.type === 'skip') partyStatus('Clue skipped. Scores unchanged.');
}

async function fetchPartyJson(path) {
  const response = await fetch(path);
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error || 'The board could not be loaded. Please try again.');
  }
  return response.json();
}

async function choosePartyBoard(path) {
  const request = ++partyRequest;
  partyLoading = true;
  partyElements['setup-error'].hidden = true;
  renderBoardPicker();
  try {
    const board = PartyState.normalizeBoard(await fetchPartyJson(path));
    if (!board) throw new Error('This board is not supported. Choose another board.');
    if (request !== partyRequest) return;
    partySelectedBoard = board;
    partyStatus(`${board.title} is ready.`);
  } catch (error) {
    if (request !== partyRequest) return;
    partyElements['setup-error'].textContent = error.message;
    partyElements['setup-error'].hidden = false;
    partyStatus('Could not load that board. Your saved game is unchanged.');
  } finally {
    if (request === partyRequest) { partyLoading = false; renderBoardPicker(); }
  }
}

async function loadPartyCatalog() {
  try {
    const data = await fetchPartyJson('/api/party/games');
    if (!Array.isArray(data)) throw new Error('The board library could not be loaded.');
    partyCatalog = data.filter((board) => board && typeof board.id === 'string'
      && /^[A-Za-z0-9_-]{1,64}$/.test(board.id) && typeof board.title === 'string');
    if (!partyCatalog.length) throw new Error('The board library is empty.');
    renderBoardPicker();
    return true;
  } catch (error) {
    partyElements['setup-error'].textContent = error.message;
    partyElements['setup-error'].hidden = false;
    renderBoardPicker();
    return false;
  }
}

function restartParty() {
  if (!PartyState.isComplete(partyState) && !window.confirm('Restart this board and reset all scores?')) return;
  actOnParty({ type: 'restart' });
  partyStatus('Board and scores reset.');
  partyElements['game-title'].focus();
}

partyElements['player-fields'].addEventListener('input', (event) => {
  const index = event.target.dataset.playerIndex;
  if (index !== undefined) partyNames[Number(index)] = event.target.value;
});
partyElements['player-fields'].addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove-player]');
  if (!button || partyNames.length <= 2) return;
  partyNames.splice(Number(button.dataset.removePlayer), 1);
  renderPlayerFields();
});
partyElements['add-player'].addEventListener('click', () => {
  if (partyNames.length >= 6) return;
  partyNames.push(`Player ${partyNames.length + 1}`);
  renderPlayerFields();
  partyElements['player-fields'].querySelector(`#player-${partyNames.length - 1}`)?.focus();
});
partyElements['party-setup-form'].addEventListener('submit', (event) => {
  event.preventDefault();
  if (partyLoading) return;
  const next = PartyState.createState(partySelectedBoard, partyNames);
  if (!next) {
    partyElements['setup-error'].textContent = 'Choose a board and enter a name for each player.';
    partyElements['setup-error'].hidden = false;
    return;
  }
  if (partyState && !PartyState.isComplete(partyState)
    && !window.confirm('Replace your saved game? Its scores and played clues will be reset.')) return;
  partyState = next;
  saveParty();
  syncBoardLocation();
  renderPartyGame();
  partyElements['game-title'].focus();
  partyStatus('Game started. Choose a clue.');
});
partyElements['board-select'].addEventListener('change', (event) => {
  if (partyCatalog.some((board) => board.id === event.target.value)) {
    choosePartyBoard(`/api/party/games/${encodeURIComponent(event.target.value)}`);
  }
});
partyElements['random-board'].addEventListener('click', () => choosePartyBoard('/api/party/random'));
partyElements['board-preview'].addEventListener('click', async (event) => {
  if (event.target.id !== 'retry-boards') return;
  if (await loadPartyCatalog()) choosePartyBoard(`/api/party/games/${encodeURIComponent(partyCatalog[0].id)}`);
});
partyElements['share-setup'].addEventListener('click', () => sharePartyBoard(partySelectedBoard));
partyElements['share-game'].addEventListener('click', () => sharePartyBoard(partyState?.board));
partyElements['resume-game'].addEventListener('click', () => {
  if (!partyState) return;
  partySelectedBoard = partyState.board;
  syncBoardLocation();
  renderPartyGame();
  partyElements['game-title'].focus();
});
for (const id of ['change-board', 'choose-next']) partyElements[id].addEventListener('click', showPartySetup);
for (const id of ['restart-game', 'play-again']) partyElements[id].addEventListener('click', restartParty);
partyElements['party-board'].addEventListener('click', (event) => {
  const button = event.target.closest('[data-clue]');
  if (button && !button.disabled) actOnParty({ type: 'open', key: button.dataset.clue });
});
partyElements['party-scoreboard'].addEventListener('change', (event) => {
  const playerId = event.target.dataset.renamePlayer;
  if (!playerId) return;
  if (!event.target.value.trim()) {
    event.target.value = partyState.players.find((player) => player.id === playerId).name;
    return;
  }
  actOnParty({ type: 'rename', playerId, name: event.target.value });
});
partyElements['score-actions'].addEventListener('click', (event) => {
  const button = event.target.closest('[data-score-player]');
  if (button) actOnParty({ type: 'score', key: button.dataset.scoreKey, playerId: button.dataset.scorePlayer, correct: button.dataset.correct === 'true' });
});
partyElements['reveal-answer'].addEventListener('click', () => actOnParty({ type: 'reveal', key: partyState?.activeClue }));
partyElements['skip-clue'].addEventListener('click', () => actOnParty({ type: 'skip', key: partyState?.activeClue }));
partyElements['close-clue'].addEventListener('click', () => actOnParty({ type: 'close' }));
partyElements['clue-dialog'].addEventListener('cancel', (event) => { event.preventDefault(); actOnParty({ type: 'close' }); });
document.addEventListener('keydown', (event) => {
  if (!partyElements['clue-dialog'].open || !partyState?.activeClue || event.repeat || event.ctrlKey || event.metaKey || event.altKey
    || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return;
  const key = partyState.activeClue;
  if (event.key.toLowerCase() === 'r') { event.preventDefault(); actOnParty({ type: 'reveal', key }); return; }
  if (event.code === 'Digit0' || event.code === 'Numpad0') { event.preventDefault(); actOnParty({ type: 'skip', key }); return; }
  const match = /^(?:Digit|Numpad)([1-6])$/.exec(event.code);
  const player = match ? partyState.players[Number(match[1]) - 1] : null;
  if (player) { event.preventDefault(); actOnParty({ type: 'score', key, playerId: player.id, correct: !event.shiftKey }); }
});

async function initializeParty() {
  partyState = loadParty();
  updateSaveNote();
  if (partyState) {
    partySelectedBoard = partyState.board;
    partyNames = partyState.players.map((player) => player.name);
  }
  renderPlayerFields();
  renderResume();
  const params = new URL(window.location.href).searchParams;
  const seed = params.get('seed');
  const boardId = params.get('board');
  const version = params.get('version');
  const hasSharedBoard = Boolean(seed || boardId);
  const sameSavedBoard = partyState && (seed
    ? partyState.board.seed === seed && (!version || partyState.board.poolVersion === version)
    : partyState.board.id === boardId && (!version || partyState.board.boardVersion === version));
  if (partyState && (!hasSharedBoard || sameSavedBoard)) renderPartyGame();
  const catalogLoaded = await loadPartyCatalog();
  if (hasSharedBoard && !sameSavedBoard) {
    partySelectedBoard = null;
    const path = seed ? `/api/party/random?seed=${encodeURIComponent(seed)}${version ? `&version=${encodeURIComponent(version)}` : ''}`
      : `/api/party/games/${encodeURIComponent(boardId)}${version ? `?version=${encodeURIComponent(version)}` : ''}`;
    await choosePartyBoard(path);
  } else if (!partySelectedBoard && catalogLoaded) {
    await choosePartyBoard(`/api/party/games/${encodeURIComponent(partyCatalog[0].id)}`);
  }
  if (partyShowingSetup) renderBoardPicker();
}

initializeParty();
