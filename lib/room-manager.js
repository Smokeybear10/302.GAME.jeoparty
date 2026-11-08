'use strict';

const crypto = require('node:crypto');
const { CLUE_VALUES, catalogGames, validateGame } = require('./game-store');

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_PLAYERS = 8;
const MAX_CUSTOM_GAMES = 12;
const MAX_COMPLETED_GAMES = 25;
const SNAPSHOT_VERSION = 1;
const ROOM_IDLE_MS = 12 * 60 * 60 * 1000;

class RoomError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RoomError';
    this.code = code;
  }
}

function cleanRoomCode(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
}

function cleanName(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, 24);
}

function cleanResponse(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, 200);
}

function cleanCustomField(value, maxLength) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function normalizeCustomGame(input, id) {
  const categories = Array.from({ length: 6 }, (_, categoryIndex) => {
    const category = Array.isArray(input?.categories) ? input.categories[categoryIndex] : null;
    return {
      name: cleanCustomField(category?.name, 60),
      clues: Array.from({ length: 5 }, (_, clueIndex) => {
        const clue = Array.isArray(category?.clues) ? category.clues[clueIndex] : null;
        return {
          value: CLUE_VALUES[clueIndex],
          clue: cleanCustomField(clue?.clue, 500),
          answer: cleanCustomField(clue?.answer, 240),
          dailyDouble: clue?.dailyDouble === true,
        };
      }),
    };
  });

  return {
    id,
    title: cleanCustomField(input?.title, 80),
    description: cleanCustomField(input?.description, 180) || 'Custom board',
    difficulty: 'Custom',
    source: 'custom',
    year: null,
    categories,
    finalJeopardy: {
      category: cleanCustomField(input?.finalJeopardy?.category, 80),
      clue: cleanCustomField(input?.finalJeopardy?.clue, 500),
      answer: cleanCustomField(input?.finalJeopardy?.answer, 240),
    },
  };
}

function randomToken() {
  return crypto.randomBytes(18).toString('base64url');
}

function tokensMatch(first, second) {
  const firstBuffer = Buffer.from(String(first ?? ''));
  const secondBuffer = Buffer.from(String(second ?? ''));
  return firstBuffer.length === secondBuffer.length && crypto.timingSafeEqual(firstBuffer, secondBuffer);
}

function clueKey(categoryIndex, clueIndex, round = 'jeopardy') {
  return `${round === 'double' ? 'double:' : ''}${categoryIndex}:${clueIndex}`;
}

function boardCategories(room, game) {
  return room.round === 'double' ? game.doubleJeopardy.categories : game.categories;
}

function boardComplete(room, game) {
  return !room.currentClue && room.answered.size === boardCategories(room, game).reduce((total, category) => total + category.clues.length, 0);
}

function snapshotAssert(condition, field) {
  if (!condition) throw new Error(`Invalid room snapshot: ${field}`);
}

function recordCompletedGame(room, completedAt) {
  if (room.completedGames.some((game) => game.id === room.gameRunId)) return;
  room.completedGames = [{
    id: room.gameRunId,
    gameId: room.selectedGame.id,
    title: room.selectedGame.title,
    custom: room.selectedGame.source === 'custom',
    completedAt,
    revision: 1,
    players: room.players.map(({ id, name, score }) => ({ id, name, score })),
  }, ...room.completedGames].slice(0, MAX_COMPLETED_GAMES);
}

function validateSavedRoom(room) {
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const timestamp = (value) => Number.isSafeInteger(value) && value >= 0;
  const token = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{24}$/.test(value);
  const connection = (value) => object(value) && typeof value.connected === 'boolean'
    && (value.connected ? typeof value.socketId === 'string' && value.socketId.length > 0 : value.socketId === null);
  snapshotAssert(object(room), 'room');
  snapshotAssert(typeof room.code === 'string' && /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/.test(room.code), 'room code');
  snapshotAssert(timestamp(room.createdAt) && timestamp(room.updatedAt) && room.updatedAt >= room.createdAt, 'room timestamps');
  snapshotAssert(connection(room.host) && token(room.host.token), 'host credentials');
  snapshotAssert(Array.isArray(room.players) && room.players.length <= MAX_PLAYERS, 'players');
  const playerIds = new Set();
  const playerNames = new Set();
  const tokens = new Set([room.host.token]);
  for (const player of room.players) {
    snapshotAssert(connection(player), 'player connection');
    snapshotAssert(typeof player.id === 'string' && /^p_[a-f0-9]{12}$/.test(player.id) && !playerIds.has(player.id), 'player id');
    snapshotAssert(typeof player.name === 'string' && player.name.length > 0 && player.name === cleanName(player.name)
      && !playerNames.has(player.name.toLowerCase()), 'player name');
    snapshotAssert(Number.isSafeInteger(player.score) && timestamp(player.joinedAt), 'player score or timestamp');
    if (player.id === room.host.playerId) {
      snapshotAssert(player.token === null && player.socketId === room.host.socketId && player.connected === room.host.connected, 'host contestant');
    } else {
      snapshotAssert(token(player.token) && !tokens.has(player.token), 'player credentials');
      tokens.add(player.token);
    }
    playerIds.add(player.id);
    playerNames.add(player.name.toLowerCase());
  }
  const playerReference = (value) => value === null || playerIds.has(value);
  snapshotAssert(playerReference(room.host.playerId), 'host contestant id');
  snapshotAssert(playerReference(room.controlPlayerId) && playerReference(room.disconnectedControlPlayerId), 'board control');
  snapshotAssert(['lobby', 'board', 'final'].includes(room.phase) && ['jeopardy', 'double'].includes(room.round), 'round or phase');
  snapshotAssert(Array.isArray(room.customGames) && room.customGames.length <= MAX_CUSTOM_GAMES, 'custom games');
  const gameIds = new Set();
  for (const game of room.customGames) {
    snapshotAssert(validateGame(game).length === 0 && !gameIds.has(game.id), 'custom game data');
    gameIds.add(game.id);
  }
  snapshotAssert(Array.isArray(room.answered) && new Set(room.answered).size === room.answered.length, 'answered clues');
  snapshotAssert(Array.isArray(room.completedGames) && room.completedGames.length <= MAX_COMPLETED_GAMES, 'completed games');
  const completedIds = new Set();
  for (const result of room.completedGames) {
    snapshotAssert(object(result) && typeof result.id === 'string' && /^g_[a-f0-9]{12}$/.test(result.id)
      && !completedIds.has(result.id), 'completed game id');
    completedIds.add(result.id);
    snapshotAssert(typeof result.gameId === 'string' && result.gameId.trim().length > 0 && result.gameId.length <= 64
      && typeof result.title === 'string' && result.title.trim().length > 0 && result.title.length <= 80
      && typeof result.custom === 'boolean', 'completed game description');
    snapshotAssert(timestamp(result.completedAt) && result.completedAt >= room.createdAt && result.completedAt <= room.updatedAt
      && Number.isSafeInteger(result.revision) && result.revision >= 1, 'completed game timestamp or revision');
    snapshotAssert(Array.isArray(result.players) && result.players.length <= MAX_PLAYERS, 'completed game players');
    const resultPlayerIds = new Set();
    for (const player of result.players) {
      snapshotAssert(object(player) && typeof player.id === 'string' && /^p_[a-f0-9]{12}$/.test(player.id)
        && !resultPlayerIds.has(player.id), 'completed game player id');
      snapshotAssert(typeof player.name === 'string' && player.name.length > 0 && player.name === cleanName(player.name)
        && Number.isSafeInteger(player.score), 'completed game player score or name');
      resultPlayerIds.add(player.id);
    }
  }
  if (room.phase === 'lobby') {
    snapshotAssert(room.gameId === null && room.selectedGame === null && room.round === 'jeopardy'
      && room.answered.length === 0 && room.currentClue === null && room.final === null
      && room.gameRunId === null && room.gameStartedAt === null, 'lobby state');
    return;
  }
  snapshotAssert(typeof room.gameRunId === 'string' && /^g_[a-f0-9]{12}$/.test(room.gameRunId)
    && timestamp(room.gameStartedAt) && room.gameStartedAt >= room.createdAt && room.gameStartedAt <= room.updatedAt, 'game run');
  const game = room.selectedGame;
  snapshotAssert(validateGame(game).length === 0 && room.gameId === game.id, 'selected game');
  snapshotAssert(room.round !== 'double' || Boolean(game.doubleJeopardy), 'Double Jeopardy board');
  const categories = boardCategories(room, game);
  const keys = new Set(categories.flatMap((category, categoryIndex) => category.clues.map((_, clueIndex) => clueKey(categoryIndex, clueIndex, room.round))));
  snapshotAssert(room.answered.every((key) => keys.has(key)), 'answered clue references');
  if (room.currentClue !== null) {
    const current = room.currentClue;
    snapshotAssert(room.phase === 'board' && object(current), 'active clue phase');
    snapshotAssert(Number.isInteger(current.categoryIndex) && Number.isInteger(current.clueIndex), 'active clue coordinates');
    const clue = categories[current.categoryIndex]?.clues[current.clueIndex];
    snapshotAssert(clue && current.key === clueKey(current.categoryIndex, current.clueIndex, room.round)
      && !room.answered.includes(current.key), 'active clue reference');
    snapshotAssert(current.value === clue.value && current.dailyDouble === (clue.dailyDouble === true), 'active clue value');
    snapshotAssert(['question', 'daily-wager'].includes(current.phase)
      && typeof current.revealed === 'boolean' && typeof current.buzzOpen === 'boolean', 'active clue status');
    snapshotAssert(Array.isArray(current.buzzes) && current.buzzes.every((buzz) => object(buzz)
      && playerIds.has(buzz.playerId) && timestamp(buzz.at))
      && new Set(current.buzzes.map((buzz) => buzz.playerId)).size === current.buzzes.length, 'buzz queue');
    snapshotAssert(Array.isArray(current.ineligiblePlayerIds)
      && current.ineligiblePlayerIds.every((id) => playerIds.has(id))
      && new Set(current.ineligiblePlayerIds).size === current.ineligiblePlayerIds.length
      && !current.buzzes.some((buzz) => current.ineligiblePlayerIds.includes(buzz.playerId)), 'clue eligibility');
    snapshotAssert(playerReference(current.dailyPlayerId) && playerReference(current.selfJudgePlayerId), 'clue player references');
    if (current.dailyDouble) {
      snapshotAssert(current.buzzes.length === 0 && !current.buzzOpen, 'Daily Double buzzers');
      snapshotAssert(current.phase === 'daily-wager'
        ? current.dailyPlayerId === null && current.wager === null && !current.revealed && current.selfJudgePlayerId === null
        : current.dailyPlayerId !== null && Number.isSafeInteger(current.wager) && current.wager >= 0, 'Daily Double wager');
    } else {
      snapshotAssert(current.phase === 'question' && current.dailyPlayerId === null && current.wager === null, 'regular clue');
    }
    const responder = current.dailyDouble ? current.dailyPlayerId : current.buzzes[0]?.playerId;
    snapshotAssert(current.selfJudgePlayerId === null || (current.selfJudgePlayerId === responder && !current.revealed && !current.buzzOpen), 'private answer owner');
    snapshotAssert(!current.revealed || !current.buzzOpen, 'revealed clue buzzers');
  }
  if (room.phase !== 'final') {
    snapshotAssert(room.final === null, 'unexpected Final Jeopardy');
    return;
  }
  snapshotAssert(room.currentClue === null && object(room.final)
    && ['wager', 'clue', 'answer', 'complete'].includes(room.final.phase) && object(room.final.entries), 'Final Jeopardy');
  snapshotAssert(!game.doubleJeopardy || (room.round === 'double' && room.answered.length === keys.size), 'unfinished rounds before Final Jeopardy');
  for (const [playerId, entry] of Object.entries(room.final.entries)) {
    snapshotAssert(playerIds.has(playerId) && object(entry), 'finalist');
    snapshotAssert(Number.isSafeInteger(entry.maxWager) && entry.maxWager > 0
      && (entry.wager === null || (Number.isSafeInteger(entry.wager) && entry.wager >= 0 && entry.wager <= entry.maxWager)), 'final wager');
    snapshotAssert(typeof entry.wagerSubmitted === 'boolean' && typeof entry.responseSubmitted === 'boolean'
      && typeof entry.scored === 'boolean' && typeof entry.response === 'string' && entry.response.length <= 200, 'final submission');
    snapshotAssert(!entry.responseSubmitted || entry.response.trim().length > 0, 'final response');
    snapshotAssert(entry.scored ? typeof entry.correct === 'boolean' : entry.correct === null, 'final judgment');
    snapshotAssert((room.final.phase === 'wager' && !entry.wagerSubmitted) || entry.wager !== null, 'locked final wager');
    snapshotAssert(!['wager', 'clue'].includes(room.final.phase) || (!entry.scored && entry.correct === null), 'premature final result');
    snapshotAssert(room.final.phase !== 'complete' || entry.scored, 'unfinished final result');
  }
}

class RoomManager {
  constructor({ games, now = () => Date.now() } = {}) {
    if (!Array.isArray(games) || games.length === 0) throw new Error('RoomManager requires at least one game');
    this.games = games;
    this.gamesById = new Map(games.map((game) => [game.id, game]));
    this.rooms = new Map();
    this.sessions = new Map();
    this.now = now;
  }

  exportSnapshot() {
    return structuredClone({
      version: SNAPSHOT_VERSION,
      savedAt: this.now(),
      rooms: [...this.rooms.values()].map((room) => ({
        ...room,
        selectedGame: room.gameId ? this.#gameForRoom(room, room.gameId) : null,
        answered: [...room.answered],
        currentClue: room.currentClue ? {
          ...room.currentClue,
          ineligiblePlayerIds: [...room.currentClue.ineligiblePlayerIds],
        } : null,
      })),
    });
  }

  restoreSnapshot(snapshot, { restoreConnections = false, expire = true } = {}) {
    snapshotAssert(snapshot?.version === SNAPSHOT_VERSION && Number.isSafeInteger(snapshot.savedAt)
      && snapshot.savedAt >= 0 && Array.isArray(snapshot.rooms), 'format or version');
    const saved = structuredClone(snapshot);
    const rooms = new Map();
    const sessions = new Map();
    const codes = new Set();
    for (const room of saved.rooms) {
      const legacy = room && typeof room === 'object' && !Array.isArray(room)
        && !Object.hasOwn(room, 'completedGames') && !Object.hasOwn(room, 'gameRunId') && !Object.hasOwn(room, 'gameStartedAt');
      if (legacy) {
        room.completedGames = [];
        room.gameRunId = room.phase === 'lobby' ? null : `g_${crypto.randomBytes(6).toString('hex')}`;
        room.gameStartedAt = room.phase === 'lobby' ? null : room.createdAt;
      }
      validateSavedRoom(room);
      if (legacy && room.final?.phase === 'complete') recordCompletedGame(room, room.updatedAt);
      snapshotAssert(!codes.has(room.code), 'duplicate room code');
      codes.add(room.code);
      const wasConnected = room.host.connected || room.players.some((player) => player.connected);
      const lastActive = wasConnected ? Math.max(saved.savedAt, room.updatedAt) : room.updatedAt;
      if (expire && lastActive < this.now() - ROOM_IDLE_MS) continue;
      room.answered = new Set(room.answered);
      if (room.currentClue) room.currentClue.ineligiblePlayerIds = new Set(room.currentClue.ineligiblePlayerIds);
      if (restoreConnections) {
        const addSession = (socketId, session) => {
          if (!socketId) return;
          snapshotAssert(!sessions.has(socketId), 'duplicate connection');
          sessions.set(socketId, session);
        };
        addSession(room.host.socketId, { code: room.code, role: 'host' });
        for (const player of room.players) {
          if (player.id !== room.host.playerId) addSession(player.socketId, { code: room.code, role: 'player', playerId: player.id });
        }
      } else {
        room.updatedAt = lastActive;
        room.host.socketId = null;
        room.host.connected = false;
        for (const player of room.players) {
          player.socketId = null;
          player.connected = false;
        }
      }
      rooms.set(room.code, room);
    }
    this.rooms = rooms;
    this.sessions = sessions;
  }

  createRoom(socketId) {
    const session = this.sessions.get(socketId);
    if (session?.role === 'host') {
      const room = this.rooms.get(session.code);
      if (room?.host.socketId === socketId) {
        return { code: room.code, token: room.host.token, role: 'host' };
      }
    }
    this.#assertFreshSocket(socketId);
    const code = this.#newRoomCode();
    const hostToken = randomToken();
    const timestamp = this.now();
    const room = {
      code,
      createdAt: timestamp,
      updatedAt: timestamp,
      host: { socketId, token: hostToken, connected: true, playerId: null },
      players: [],
      customGames: [],
      phase: 'lobby',
      gameId: null,
      gameRunId: null,
      gameStartedAt: null,
      completedGames: [],
      round: 'jeopardy',
      answered: new Set(),
      currentClue: null,
      controlPlayerId: null,
      disconnectedControlPlayerId: null,
      final: null,
    };
    this.rooms.set(code, room);
    this.sessions.set(socketId, { code, role: 'host' });
    return { code, token: hostToken, role: 'host' };
  }

  joinRoom(socketId, { code, name }) {
    const session = this.sessions.get(socketId);
    if (session?.role === 'player') {
      const room = this.rooms.get(session.code);
      const player = room?.players.find((candidate) => candidate.id === session.playerId && candidate.socketId === socketId);
      if (player && room.code === cleanRoomCode(code) && player.name === cleanName(name)) {
        return { code: room.code, token: player.token, role: 'player', playerId: player.id };
      }
    }
    this.#assertFreshSocket(socketId);
    const room = this.#requireRoom(code);
    if (room.phase === 'final') {
      throw new RoomError('GAME_IN_FINAL', 'This room is in Final Jeopardy and is not accepting new players.');
    }
    const playerName = cleanName(name);
    if (!playerName) throw new RoomError('INVALID_NAME', 'Enter a name to join the room.');
    if (room.players.length >= MAX_PLAYERS) throw new RoomError('ROOM_FULL', 'This room already has eight players.');
    if (room.players.some((player) => player.name.toLowerCase() === playerName.toLowerCase())) {
      throw new RoomError('NAME_TAKEN', 'That name is already in this room.');
    }

    const player = {
      id: `p_${crypto.randomBytes(6).toString('hex')}`,
      token: randomToken(),
      socketId,
      name: playerName,
      score: 0,
      connected: true,
      joinedAt: this.now(),
    };
    room.players.push(player);
    this.sessions.set(socketId, { code: room.code, role: 'player', playerId: player.id });
    this.#ensureConnectedController(room);
    this.#touch(room);
    return { code: room.code, token: player.token, role: 'player', playerId: player.id };
  }

  joinHostAsPlayer(socketId, { name }) {
    const { room } = this.#requireHost(socketId);
    if (room.phase !== 'lobby') {
      throw new RoomError('LOBBY_ONLY', 'The host can join the contestant roster only from the lobby.');
    }
    const playerName = cleanName(name);
    if (!playerName) throw new RoomError('INVALID_NAME', 'Enter a name to join the contestant roster.');

    const existingPlayer = this.#hostPlayer(room);
    if (room.players.some((player) => player.id !== existingPlayer?.id && player.name.toLowerCase() === playerName.toLowerCase())) {
      throw new RoomError('NAME_TAKEN', 'That name is already in this room.');
    }

    if (existingPlayer) {
      existingPlayer.name = playerName;
      existingPlayer.socketId = room.host.socketId;
      existingPlayer.connected = room.host.connected;
    } else {
      if (room.players.length >= MAX_PLAYERS) throw new RoomError('ROOM_FULL', 'This room already has eight players.');
      const player = {
        id: `p_${crypto.randomBytes(6).toString('hex')}`,
        token: null,
        socketId: room.host.socketId,
        name: playerName,
        score: 0,
        connected: room.host.connected,
        joinedAt: this.now(),
      };
      room.players.push(player);
      room.host.playerId = player.id;
    }
    this.#touch(room);
    return room.code;
  }

  leaveHostAsPlayer(socketId) {
    const { room } = this.#requireHost(socketId);
    if (room.phase !== 'lobby') {
      throw new RoomError('LOBBY_ONLY', 'The host can leave the contestant roster only from the lobby.');
    }
    const player = this.#hostPlayer(room);
    if (!player) throw new RoomError('NOT_CONTESTANT', 'The host is not in the contestant roster.');
    this.#removePlayerFromRoom(room, player.id);
    this.#touch(room);
    return room.code;
  }

  createCustomGame(socketId, input) {
    const { room } = this.#requireHost(socketId);
    if (room.phase !== 'lobby') {
      throw new RoomError('LOBBY_ONLY', 'Return to the game library before creating a board.');
    }
    if (room.customGames.length >= MAX_CUSTOM_GAMES) {
      throw new RoomError('CUSTOM_GAME_LIMIT', `A room can hold up to ${MAX_CUSTOM_GAMES} custom boards.`);
    }

    const gameId = `custom-${room.code.toLowerCase()}-${crypto.randomBytes(5).toString('hex')}`;
    const game = normalizeCustomGame(input, gameId);
    const errors = validateGame(game, 'custom board');
    if (errors.length > 0) {
      throw new RoomError('INVALID_CUSTOM_GAME', `Check the custom board: ${errors[0]}.`);
    }

    room.customGames.unshift(game);
    this.#touch(room);
    return { code: room.code, gameId };
  }

  resumeRoom(socketId, { code, token }) {
    this.#assertFreshSocket(socketId);
    const room = this.#requireRoom(code);
    const suppliedToken = String(token ?? '');

    if (suppliedToken && tokensMatch(suppliedToken, room.host.token)) {
      const replacedSocketId = room.host.socketId;
      if (replacedSocketId) this.sessions.delete(replacedSocketId);
      room.host.socketId = socketId;
      room.host.connected = true;
      const hostPlayer = this.#hostPlayer(room);
      if (hostPlayer) {
        hostPlayer.socketId = socketId;
        hostPlayer.connected = true;
      }
      this.sessions.set(socketId, { code: room.code, role: 'host' });
      this.#ensureConnectedController(room);
      this.#touch(room);
      return { code: room.code, token: room.host.token, role: 'host', replacedSocketId };
    }

    const player = room.players.find((candidate) => suppliedToken && tokensMatch(candidate.token, suppliedToken));
    if (!player) throw new RoomError('SESSION_EXPIRED', 'That saved room session is no longer available.');
    const replacedSocketId = player.socketId;
    if (replacedSocketId) this.sessions.delete(replacedSocketId);
    player.socketId = socketId;
    player.connected = true;
    this.sessions.set(socketId, { code: room.code, role: 'player', playerId: player.id });
    this.#ensureConnectedController(room);
    this.#touch(room);
    return { code: room.code, token: player.token, role: 'player', playerId: player.id, replacedSocketId };
  }

  disconnect(socketId) {
    const session = this.sessions.get(socketId);
    if (!session) return null;
    const room = this.rooms.get(session.code);
    this.sessions.delete(socketId);
    if (!room) return session.code;

    if (session.role === 'host' && room.host.socketId === socketId) {
      room.host.socketId = null;
      room.host.connected = false;
      const hostPlayer = this.#hostPlayer(room);
      if (hostPlayer) {
        hostPlayer.socketId = null;
        hostPlayer.connected = false;
      }
    } else if (session.role === 'player') {
      const player = room.players.find((candidate) => candidate.id === session.playerId);
      if (player && player.socketId === socketId) {
        player.socketId = null;
        player.connected = false;
      }
    }
    this.#ensureConnectedController(room);
    this.#touch(room);
    return room.code;
  }

  leaveRoom(socketId) {
    const { room, session } = this.#roomForSocket(socketId);
    if (session.role === 'host') {
      return this.closeRoom(socketId);
    }
    this.#removePlayerFromRoom(room, session.playerId);
    this.sessions.delete(socketId);
    this.#touch(room);
    return { code: room.code, closed: false };
  }

  closeRoom(socketId) {
    const { room } = this.#requireHost(socketId);
    for (const [candidateSocketId, session] of this.sessions) {
      if (session.code === room.code) this.sessions.delete(candidateSocketId);
    }
    this.rooms.delete(room.code);
    return { code: room.code, closed: true };
  }

  startGame(socketId, gameId) {
    const { room } = this.#requireHost(socketId);
    const game = this.#gameForRoom(room, gameId);
    if (!game) throw new RoomError('GAME_NOT_FOUND', 'Choose a game from the library.');
    room.gameId = game.id;
    room.selectedGame = structuredClone(game);
    room.gameRunId = `g_${crypto.randomBytes(6).toString('hex')}`;
    room.gameStartedAt = this.now();
    room.phase = 'board';
    room.round = 'jeopardy';
    room.answered = new Set();
    room.currentClue = null;
    room.controlPlayerId = room.host.playerId;
    room.disconnectedControlPlayerId = null;
    room.final = null;
    room.players.forEach((player) => { player.score = 0; });
    this.#touch(room);
    return room.code;
  }

  openClue(socketId, { categoryIndex, clueIndex, round }) {
    const { room, game } = this.#requireClueSelector(socketId);
    if (round !== undefined && round !== room.round) {
      throw new RoomError('STALE_ROUND', 'The game has moved to another round.');
    }
    const category = boardCategories(room, game)[Number(categoryIndex)];
    const clue = category?.clues?.[Number(clueIndex)];
    if (!clue) throw new RoomError('CLUE_NOT_FOUND', 'That clue does not exist.');
    const key = clueKey(Number(categoryIndex), Number(clueIndex), room.round);
    if (room.answered.has(key)) throw new RoomError('CLUE_ALREADY_USED', 'That clue has already been played.');
    if (room.currentClue) throw new RoomError('CLUE_ACTIVE', 'Finish the current clue first.');

    room.disconnectedControlPlayerId = null;
    room.currentClue = {
      key,
      categoryIndex: Number(categoryIndex),
      clueIndex: Number(clueIndex),
      value: clue.value,
      dailyDouble: clue.dailyDouble === true,
      phase: clue.dailyDouble === true ? 'daily-wager' : 'question',
      revealed: false,
      buzzOpen: clue.dailyDouble !== true,
      buzzes: [],
      ineligiblePlayerIds: new Set(),
      dailyPlayerId: null,
      wager: null,
      selfJudgePlayerId: null,
    };
    this.#touch(room);
    return room.code;
  }

  setDailyDouble(socketId, { playerId, wager }) {
    const { room } = this.#requireBoardHost(socketId);
    const current = room.currentClue;
    if (!current?.dailyDouble || current.phase !== 'daily-wager') {
      throw new RoomError('NOT_DAILY_DOUBLE', 'There is no Daily Double waiting for a wager.');
    }
    const player = room.players.find((candidate) => candidate.id === playerId);
    if (!player) throw new RoomError('PLAYER_NOT_FOUND', 'Choose a player for the Daily Double.');
    if (room.host.playerId && player.id !== room.controlPlayerId) {
      throw new RoomError('NOT_YOUR_DAILY_DOUBLE', 'The contestant choosing this clue plays the Daily Double.');
    }
    if (!player.connected) throw new RoomError('PLAYER_OFFLINE', 'Choose a connected contestant for the Daily Double.');
    const parsedWager = Number(wager);
    const maxWager = Math.max(player.score, room.round === 'double' ? 2000 : 1000);
    if (!Number.isInteger(parsedWager) || parsedWager < 0 || parsedWager > maxWager) {
      throw new RoomError('INVALID_WAGER', `Enter a whole-dollar wager from $0 to $${maxWager}.`);
    }
    current.dailyPlayerId = player.id;
    current.wager = parsedWager;
    current.phase = 'question';
    current.buzzOpen = false;
    this.#touch(room);
    return room.code;
  }

  buzz(socketId) {
    const { room, player } = this.#requireContestant(socketId);
    if (!room.host.connected) {
      throw new RoomError('HOST_OFFLINE', 'Buzzing is paused while the host reconnects.');
    }
    const current = room.currentClue;
    if (room.phase !== 'board' || !current || current.phase !== 'question' || current.revealed) {
      throw new RoomError('BUZZ_CLOSED', 'Buzzing is not open right now.');
    }
    if (!current.buzzOpen || current.dailyDouble) throw new RoomError('BUZZ_CLOSED', 'Buzzing is not open for this clue.');
    if (current.ineligiblePlayerIds.has(player.id)) throw new RoomError('ALREADY_RULED', 'You have already answered this clue.');
    if (current.buzzes.some((buzz) => buzz.playerId === player.id)) {
      throw new RoomError('ALREADY_BUZZED', 'Your buzz is already in.');
    }
    current.buzzes.push({ playerId: player.id, at: this.now() });
    this.#touch(room);
    return room.code;
  }

  resetBuzzers(socketId) {
    const { room } = this.#requireBoardHost(socketId);
    if (!room.currentClue || room.currentClue.revealed) throw new RoomError('NO_ACTIVE_CLUE', 'There is no active buzzer to reset.');
    if (room.currentClue.dailyDouble) throw new RoomError('BUZZ_CLOSED', 'Daily Doubles do not use the buzzer.');
    if (room.currentClue.selfJudgePlayerId) {
      throw new RoomError('RESPONSE_IN_REVIEW', 'The active contestant is checking their response.');
    }
    room.currentClue.buzzes = [];
    room.currentClue.buzzOpen = true;
    this.#touch(room);
    return room.code;
  }

  revealAnswer(socketId) {
    const { room } = this.#requireBoardHost(socketId);
    if (!room.currentClue || room.currentClue.phase !== 'question') {
      throw new RoomError('NO_ACTIVE_CLUE', 'There is no active clue to reveal.');
    }
    if (this.#activeResponderId(room.currentClue)) {
      throw new RoomError('RESPONDER_ACTIVE', 'Wait for the active contestant to judge their response.');
    }
    room.currentClue.revealed = true;
    room.currentClue.buzzOpen = false;
    this.#touch(room);
    return room.code;
  }

  openPlayerAnswer(socketId, { clueKey: expectedClueKey } = {}) {
    const { room, player } = this.#requireContestant(socketId);
    const current = room.currentClue;
    if (!current || current.phase !== 'question') {
      throw new RoomError('NO_ACTIVE_CLUE', 'There is no active clue to check.');
    }
    if (expectedClueKey !== current.key) throw new RoomError('STALE_CLUE', 'That clue is no longer active.');
    if (current.revealed) {
      throw new RoomError('ANSWER_ALREADY_REVEALED', 'The response has already been shown to the players.');
    }
    const responderId = this.#activeResponderId(current);
    if (!responderId) throw new RoomError('NO_RESPONDER', 'Buzz in before checking the response.');
    if (responderId !== player.id) throw new RoomError('NOT_RESPONDER', 'Only the active contestant can check this response.');
    if (current.selfJudgePlayerId && current.selfJudgePlayerId !== player.id) {
      throw new RoomError('RESPONSE_IN_REVIEW', 'Another contestant is checking their response.');
    }
    current.selfJudgePlayerId = player.id;
    current.buzzOpen = false;
    this.#touch(room);
    return room.code;
  }

  selfScoreClue(socketId, { clueKey: expectedClueKey, correct } = {}) {
    const { room, player } = this.#requireContestant(socketId);
    const current = room.currentClue;
    if (!current || current.phase !== 'question') throw new RoomError('NO_ACTIVE_CLUE', 'There is no active clue to score.');
    if (expectedClueKey !== current.key) throw new RoomError('STALE_CLUE', 'That clue is no longer active.');
    if (typeof correct !== 'boolean') throw new RoomError('INVALID_JUDGMENT', 'Choose correct or incorrect.');
    if (this.#activeResponderId(current) !== player.id) {
      throw new RoomError('NOT_RESPONDER', 'Only the active contestant can judge this response.');
    }
    if (current.selfJudgePlayerId !== player.id) {
      throw new RoomError('ANSWER_NOT_OPEN', 'Check the official response before judging yourself.');
    }
    const isCorrect = correct;
    const points = current.dailyDouble ? current.wager : current.value;
    if (!Number.isInteger(points)) throw new RoomError('INVALID_WAGER', 'Set the Daily Double wager before scoring.');

    player.score += isCorrect ? points : -points;

    if (isCorrect || current.dailyDouble) {
      if (isCorrect && room.host.playerId) {
        room.controlPlayerId = player.id;
        room.disconnectedControlPlayerId = null;
      }
      room.answered.add(current.key);
      room.currentClue = null;
    } else {
      current.ineligiblePlayerIds.add(player.id);
      current.buzzes = current.buzzes.filter((buzz) => buzz.playerId !== player.id);
      current.selfJudgePlayerId = null;
      current.buzzOpen = current.buzzes.length === 0;
    }
    this.#touch(room);
    return room.code;
  }

  skipClue(socketId) {
    const { room } = this.#requireBoardHost(socketId);
    if (!room.currentClue) throw new RoomError('NO_ACTIVE_CLUE', 'There is no active clue to close.');
    room.answered.add(room.currentClue.key);
    room.currentClue = null;
    this.#touch(room);
    return room.code;
  }

  skipPlayerClue(socketId, payload = {}) {
    const { room } = this.#requireContestant(socketId);
    const current = room.currentClue;
    if (room.phase !== 'board' || current?.phase !== 'question') {
      throw new RoomError('NO_ACTIVE_CLUE', 'There is no active question to skip.');
    }
    if (payload?.clueKey !== current.key) {
      throw new RoomError('STALE_CLUE', 'That clue is no longer active.');
    }
    room.answered.add(current.key);
    room.currentClue = null;
    this.#touch(room);
    return room.code;
  }

  cancelClue(socketId) {
    const { room } = this.#requireBoardHost(socketId);
    const current = room.currentClue;
    if (!current?.dailyDouble || current.phase !== 'daily-wager') {
      throw new RoomError('CANCEL_NOT_ALLOWED', 'Only a Daily Double awaiting a wager can return to the board.');
    }
    room.currentClue = null;
    this.#touch(room);
    return room.code;
  }

  adjustScore(socketId, { playerId, delta }) {
    const { room } = this.#requireHost(socketId);
    const player = room.players.find((candidate) => candidate.id === playerId);
    const parsedDelta = Number(delta);
    if (!player) throw new RoomError('PLAYER_NOT_FOUND', 'That player is no longer in the room.');
    if (!Number.isInteger(parsedDelta) || Math.abs(parsedDelta) > 100000) {
      throw new RoomError('INVALID_SCORE', 'Score adjustments must be whole dollars.');
    }
    player.score += parsedDelta;
    if (room.final?.phase === 'complete') {
      const result = room.completedGames.find((game) => game.id === room.gameRunId);
      const resultPlayer = result?.players.find((candidate) => candidate.id === player.id);
      if (resultPlayer && resultPlayer.score !== player.score) {
        resultPlayer.score = player.score;
        result.revision += 1;
      }
    }
    this.#touch(room);
    return room.code;
  }

  removePlayer(socketId, playerId) {
    const { room } = this.#requireHost(socketId);
    const player = room.players.find((candidate) => candidate.id === playerId);
    if (!player) throw new RoomError('PLAYER_NOT_FOUND', 'That player is no longer in the room.');
    if (room.host.playerId === player.id) {
      throw new RoomError('CANNOT_REMOVE_HOST', 'Use the host contestant control to leave the roster.');
    }
    if (player.socketId) this.sessions.delete(player.socketId);
    this.#removePlayerFromRoom(room, playerId);
    this.#touch(room);
    return { code: room.code, removedSocketId: player.socketId };
  }

  resetGame(socketId) {
    const { room } = this.#requireHost(socketId);
    if (!room.gameId) throw new RoomError('NO_GAME', 'Start a game before resetting it.');
    room.gameRunId = `g_${crypto.randomBytes(6).toString('hex')}`;
    room.gameStartedAt = this.now();
    room.phase = 'board';
    room.round = 'jeopardy';
    room.answered = new Set();
    room.currentClue = null;
    room.controlPlayerId = room.host.playerId;
    room.disconnectedControlPlayerId = null;
    room.final = null;
    room.players.forEach((player) => { player.score = 0; });
    this.#touch(room);
    return room.code;
  }

  returnToLobby(socketId) {
    const { room } = this.#requireHost(socketId);
    room.phase = 'lobby';
    room.gameId = null;
    room.selectedGame = null;
    room.gameRunId = null;
    room.gameStartedAt = null;
    room.round = 'jeopardy';
    room.answered = new Set();
    room.currentClue = null;
    room.controlPlayerId = null;
    room.disconnectedControlPlayerId = null;
    room.final = null;
    room.players.forEach((player) => { player.score = 0; });
    this.#touch(room);
    return room.code;
  }

  advanceRound(socketId, { expectedRound } = {}) {
    const { room, game } = this.#requireBoardHost(socketId);
    if (expectedRound !== undefined && expectedRound !== room.round) {
      throw new RoomError('STALE_ROUND', 'The game has already moved to another round.');
    }
    if (room.currentClue) throw new RoomError('CLUE_ACTIVE', 'Finish the current clue before moving on.');
    if (game.doubleJeopardy && !boardComplete(room, game)) {
      throw new RoomError('ROUND_INCOMPLETE', 'Finish the remaining clues before moving on.');
    }
    if (!game.doubleJeopardy || room.round === 'double') return this.startFinal(socketId);

    room.round = 'double';
    room.answered = new Set();
    room.currentClue = null;
    const firstPlayer = room.players.filter((player) => player.connected)
      .reduce((lowest, player) => !lowest || player.score < lowest.score ? player : lowest, null);
    room.controlPlayerId = room.host.playerId ? firstPlayer?.id ?? null : null;
    room.disconnectedControlPlayerId = null;
    this.#touch(room);
    return room.code;
  }

  startFinal(socketId) {
    const { room, game } = this.#requireBoardHost(socketId);
    if (game.doubleJeopardy && room.round !== 'double') {
      throw new RoomError('DOUBLE_JEOPARDY_PENDING', 'Play Double Jeopardy before Final Jeopardy.');
    }
    if (game.doubleJeopardy && !boardComplete(room, game)) {
      throw new RoomError('ROUND_INCOMPLETE', 'Finish the remaining clues before Final Jeopardy.');
    }
    if (room.currentClue) throw new RoomError('CLUE_ACTIVE', 'Finish the current clue before Final Jeopardy.');
    const eligiblePlayers = room.players.filter((player) => player.score > 0);
    if (eligiblePlayers.length === 0 && !game.doubleJeopardy) {
      throw new RoomError('NO_ELIGIBLE_PLAYERS', 'At least one player needs a positive score for Final Jeopardy.');
    }
    if (!game.finalJeopardy) throw new RoomError('NO_FINAL', 'This game does not include Final Jeopardy.');
    room.phase = 'final';
    room.disconnectedControlPlayerId = null;
    room.final = {
      phase: eligiblePlayers.length > 0 ? 'wager' : 'complete',
      entries: Object.fromEntries(eligiblePlayers.map((player) => [player.id, {
        maxWager: player.score,
        wager: null,
        wagerSubmitted: false,
        response: '',
        responseSubmitted: false,
        correct: null,
        scored: false,
      }])),
    };
    if (room.final.phase === 'complete') recordCompletedGame(room, this.now());
    this.#touch(room);
    return room.code;
  }

  submitFinalWager(socketId, wager) {
    const { room, player } = this.#requireContestant(socketId);
    if (room.phase !== 'final' || room.final?.phase !== 'wager') {
      throw new RoomError('WAGER_CLOSED', 'Final Jeopardy wagers are closed.');
    }
    const entry = room.final.entries[player.id];
    if (!entry) throw new RoomError('NOT_ELIGIBLE', 'A positive score is required to play Final Jeopardy.');
    if (entry.wagerSubmitted) throw new RoomError('ALREADY_SUBMITTED', 'Your Final Jeopardy wager is already locked.');
    const parsedWager = Number(wager);
    const maxWager = entry.maxWager;
    if (!Number.isInteger(parsedWager) || parsedWager < 0 || parsedWager > maxWager) {
      throw new RoomError('INVALID_WAGER', `Enter a whole-dollar wager from $0 to $${maxWager}.`);
    }
    entry.wager = parsedWager;
    entry.wagerSubmitted = true;
    this.#touch(room);
    return room.code;
  }

  submitFinalResponse(socketId, response) {
    const { room, player } = this.#requireContestant(socketId);
    if (room.phase !== 'final' || room.final?.phase !== 'clue') {
      throw new RoomError('RESPONSE_CLOSED', 'Final Jeopardy responses are closed.');
    }
    const entry = room.final.entries[player.id];
    if (!entry) throw new RoomError('NOT_ELIGIBLE', 'A positive score is required to play Final Jeopardy.');
    if (entry.responseSubmitted) throw new RoomError('ALREADY_SUBMITTED', 'Your Final Jeopardy response is already locked.');
    const cleaned = cleanResponse(response);
    if (!cleaned) throw new RoomError('INVALID_RESPONSE', 'Enter a response before submitting.');
    entry.response = cleaned;
    entry.responseSubmitted = true;
    this.#touch(room);
    return room.code;
  }

  advanceFinal(socketId, options = {}) {
    const { room } = this.#requireHost(socketId);
    const normalizedOptions = typeof options === 'string' ? { expectedPhase: options } : options || {};
    const { expectedPhase } = normalizedOptions;
    const force = normalizedOptions.force === true;
    if (room.phase !== 'final' || !room.final) throw new RoomError('NO_FINAL', 'Final Jeopardy is not active.');
    if (expectedPhase && room.final.phase !== expectedPhase) {
      throw new RoomError('STALE_ACTION', 'Final Jeopardy has already moved to the next step.');
    }
    if (room.final.phase === 'wager') {
      const hasPendingWagers = Object.values(room.final.entries).some((entry) => !entry.wagerSubmitted);
      if (hasPendingWagers && !force) {
        throw new RoomError('FINAL_SUBMISSIONS_PENDING', 'Wait for every eligible contestant to submit a wager, or force Final Jeopardy forward.');
      }
      Object.values(room.final.entries).forEach((entry) => {
        if (!entry.wagerSubmitted) entry.wager = 0;
      });
      room.final.phase = 'clue';
    } else if (room.final.phase === 'clue') {
      const hasPendingResponses = Object.values(room.final.entries).some((entry) => !entry.responseSubmitted);
      if (hasPendingResponses && !force) {
        throw new RoomError('FINAL_SUBMISSIONS_PENDING', 'Wait for every eligible contestant to submit a response, or force Final Jeopardy forward.');
      }
      for (const [playerId, entry] of Object.entries(room.final.entries)) {
        if (entry.responseSubmitted) continue;
        const player = room.players.find((candidate) => candidate.id === playerId);
        if (player) player.score -= entry.wager ?? 0;
        entry.correct = false;
        entry.scored = true;
      }
      room.final.phase = 'answer';
    } else {
      throw new RoomError('FINAL_LOCKED', 'Score each response before finishing Final Jeopardy.');
    }
    this.#touch(room);
    return room.code;
  }

  selfScoreFinal(socketId, { correct } = {}) {
    const { room, player } = this.#requireContestant(socketId);
    if (room.phase !== 'final' || room.final?.phase !== 'answer') {
      throw new RoomError('FINAL_NOT_READY', 'The Final Jeopardy response is not ready to check.');
    }
    const entry = room.final.entries[player.id];
    if (!entry) throw new RoomError('NOT_ELIGIBLE', 'A positive score is required to play Final Jeopardy.');
    if (!entry.responseSubmitted) throw new RoomError('NO_RESPONSE', 'No Final Jeopardy response was submitted.');
    if (entry.scored) throw new RoomError('ALREADY_SCORED', 'Your Final Jeopardy response has already been scored.');
    if (typeof correct !== 'boolean') throw new RoomError('INVALID_JUDGMENT', 'Choose correct or incorrect.');
    const isCorrect = correct;
    player.score += isCorrect ? entry.wager : -entry.wager;
    entry.correct = isCorrect;
    entry.scored = true;
    this.#touch(room);
    return room.code;
  }

  finishFinal(socketId) {
    const { room } = this.#requireHost(socketId);
    if (room.phase !== 'final' || room.final?.phase !== 'answer') {
      throw new RoomError('FINAL_NOT_READY', 'Final Jeopardy is not ready to finish.');
    }
    for (const [playerId, entry] of Object.entries(room.final.entries)) {
      if (entry.scored) continue;
      const player = room.players.find((candidate) => candidate.id === playerId);
      if (player) player.score -= entry.wager ?? 0;
      entry.correct = false;
      entry.scored = true;
    }
    room.final.phase = 'complete';
    recordCompletedGame(room, this.now());
    this.#touch(room);
    return room.code;
  }

  stateFor(socketId, gameCatalog) {
    const { room, session } = this.#roomForSocket(socketId);
    const game = room.gameId ? this.#gameForRoom(room, room.gameId) : null;
    const state = {
      code: room.code,
      role: session.role,
      phase: room.phase,
      gameRunId: room.gameRunId,
      round: room.round,
      roundName: room.round === 'double' ? 'Double Jeopardy' : 'Jeopardy',
      nextRoundName: room.phase === 'board'
        ? game.doubleJeopardy && room.round === 'jeopardy' ? 'Double Jeopardy' : 'Final Jeopardy'
        : null,
      canStartNextRound: room.phase === 'board' && !room.currentClue
        && (game.doubleJeopardy ? boardComplete(room, game) : room.players.some((player) => player.score > 0)),
      hostConnected: room.host.connected,
      controlPlayerId: room.controlPlayerId,
      canChooseClue: room.phase === 'board' && !room.currentClue
        && (room.host.playerId
          ? this.#contestantId(room, session) === room.controlPlayerId
          : session.role === 'host'),
      players: room.players.map((player) => ({
        id: player.id,
        name: player.name,
        score: player.score,
        connected: player.connected,
        isHost: player.id === room.host.playerId,
      })),
      game: game ? this.#serializeBoard(room, game) : null,
      currentClue: game && room.currentClue ? this.#serializeCurrentClue(room, game, session) : null,
      final: game && room.final ? this.#serializeFinal(room, game, session) : null,
    };
    if (session.role === 'host' && room.phase === 'lobby') {
      state.gameCatalog = [...catalogGames(room.customGames), ...gameCatalog];
    }
    const contestantId = this.#contestantId(room, session);
    state.you = contestantId ? state.players.find((player) => player.id === contestantId) || null : null;
    state.completedGames = room.completedGames.filter((game) => session.role === 'host'
      || game.players.some((player) => player.id === contestantId))
      .map(({ id, gameId, title, custom, completedAt, revision, players }) => ({
        id, gameId, title, custom, completedAt, revision,
        players: players.map((player) => ({ id: player.id, name: player.name, score: player.score })),
      }));
    return state;
  }

  roomCodeForSocket(socketId) {
    return this.sessions.get(socketId)?.code || null;
  }

  cleanup(maxIdleMs = ROOM_IDLE_MS) {
    const cutoff = this.now() - maxIdleMs;
    const removedCodes = [];
    for (const room of this.rooms.values()) {
      const someoneConnected = room.host.connected || room.players.some((player) => player.connected);
      if (!someoneConnected && room.updatedAt < cutoff) {
        for (const [socketId, session] of this.sessions) {
          if (session.code === room.code) this.sessions.delete(socketId);
        }
        this.rooms.delete(room.code);
        removedCodes.push(room.code);
      }
    }
    return removedCodes;
  }

  #serializeBoard(room, game) {
    return {
      id: game.id,
      title: game.title,
      description: game.description,
      difficulty: game.difficulty,
      round: room.round,
      roundName: room.round === 'double' ? 'Double Jeopardy' : 'Jeopardy',
      dailyDoubleFloor: room.round === 'double' ? 2000 : 1000,
      hasDoubleJeopardy: Boolean(game.doubleJeopardy),
      remainingClues: boardCategories(room, game).reduce((total, category) => total + category.clues.length, 0) - room.answered.size,
      categories: boardCategories(room, game).map((category, categoryIndex) => ({
        name: category.name,
        clues: category.clues.map((clue, clueIndex) => ({
          value: clue.value,
          answered: room.answered.has(clueKey(categoryIndex, clueIndex, room.round)),
        })),
      })),
      finalCategory: game.finalJeopardy?.category || null,
    };
  }

  #serializeCurrentClue(room, game, session) {
    const current = room.currentClue;
    const category = boardCategories(room, game)[current.categoryIndex];
    const clue = category.clues[current.clueIndex];
    const buzzes = current.buzzes.map((buzz, index) => {
      const player = room.players.find((candidate) => candidate.id === buzz.playerId);
      return { playerId: buzz.playerId, name: player?.name || 'Player', position: index + 1 };
    });
    const payload = {
      clueKey: current.key,
      category: category.name,
      value: current.dailyDouble ? current.wager : current.value,
      boardValue: current.value,
      question: current.phase === 'daily-wager' ? null : clue.clue,
      dailyDouble: current.dailyDouble,
      phase: current.phase,
      revealed: current.revealed,
      buzzOpen: current.buzzOpen,
      buzzes,
      ineligiblePlayerIds: [...current.ineligiblePlayerIds],
      dailyPlayerId: current.dailyPlayerId,
      responderPlayerId: this.#activeResponderId(current),
      selfJudgePlayerId: current.selfJudgePlayerId,
    };
    const contestantId = this.#contestantId(room, session);
    payload.canSkipClue = Boolean(contestantId && room.phase === 'board' && current.phase === 'question');
    if (contestantId) {
      if (current.revealed) payload.answer = clue.answer;
      if (current.selfJudgePlayerId === contestantId) payload.privateAnswer = clue.answer;
      payload.canOpenAnswer = current.phase === 'question'
        && !current.revealed
        && this.#activeResponderId(current) === contestantId
        && !current.selfJudgePlayerId;
      payload.canSelfScore = current.selfJudgePlayerId === contestantId;
    }
    return payload;
  }

  #serializeFinal(room, game, session) {
    const final = room.final;
    const payload = {
      phase: final.phase,
      category: game.finalJeopardy.category,
      clue: ['clue', 'answer', 'complete'].includes(final.phase) ? game.finalJeopardy.clue : null,
      submissions: room.players.filter((player) => final.entries[player.id]).map((player) => ({
        playerId: player.id,
        name: player.name,
        wagerSubmitted: final.entries[player.id]?.wagerSubmitted || false,
        responseSubmitted: final.entries[player.id]?.responseSubmitted || false,
        scored: final.entries[player.id]?.scored || false,
        correct: final.entries[player.id]?.correct ?? null,
      })),
    };
    const contestantId = this.#contestantId(room, session);
    if (contestantId && ['answer', 'complete'].includes(final.phase)) {
      payload.answer = game.finalJeopardy.answer;
    }
    if (contestantId) {
      const entry = final.entries[contestantId];
      payload.eligible = Boolean(entry);
      payload.yourMaxWager = entry?.maxWager ?? 0;
      payload.yourWager = entry?.wager ?? null;
      payload.yourWagerSubmitted = entry?.wagerSubmitted || false;
      payload.yourResponseSubmitted = entry?.responseSubmitted || false;
      payload.yourResponse = entry?.response || '';
      payload.yourResult = entry?.correct ?? null;
      payload.canSelfScore = final.phase === 'answer' && Boolean(entry?.responseSubmitted) && !entry?.scored;
    }
    return payload;
  }

  #newRoomCode() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      let code = '';
      for (let index = 0; index < 5; index += 1) {
        code += ROOM_ALPHABET[crypto.randomInt(ROOM_ALPHABET.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
    throw new RoomError('ROOM_LIMIT', 'Could not create a unique room. Try again.');
  }

  #assertFreshSocket(socketId) {
    if (!socketId) throw new RoomError('INVALID_SOCKET', 'Connection is not ready.');
    if (this.sessions.has(socketId)) throw new RoomError('ALREADY_IN_ROOM', 'Leave the current room before joining another.');
  }

  #requireRoom(code) {
    const cleanedCode = cleanRoomCode(code);
    const room = this.rooms.get(cleanedCode);
    if (!room) throw new RoomError('ROOM_NOT_FOUND', 'Room not found. Check the code and try again.');
    return room;
  }

  #roomForSocket(socketId) {
    const session = this.sessions.get(socketId);
    if (!session) throw new RoomError('NOT_IN_ROOM', 'Join or create a room first.');
    const room = this.rooms.get(session.code);
    if (!room) throw new RoomError('ROOM_NOT_FOUND', 'This room is no longer available.');
    return { room, session };
  }

  #requireHost(socketId) {
    const context = this.#roomForSocket(socketId);
    if (context.session.role !== 'host') throw new RoomError('HOST_ONLY', 'Only the host can do that.');
    return context;
  }

  #requireContestant(socketId) {
    const context = this.#roomForSocket(socketId);
    const contestantId = this.#contestantId(context.room, context.session);
    if (!contestantId) throw new RoomError('CONTESTANT_ONLY', 'Join the contestant roster before doing that.');
    const player = context.room.players.find((candidate) => candidate.id === contestantId);
    if (!player) throw new RoomError('PLAYER_NOT_FOUND', 'Your contestant session is no longer available.');
    return { ...context, player };
  }

  #activeResponderId(current) {
    if (!current || current.phase !== 'question') return null;
    return current.dailyDouble ? current.dailyPlayerId : current.buzzes[0]?.playerId || null;
  }

  #contestantId(room, session) {
    return session.role === 'host' ? room.host.playerId : session.playerId;
  }

  #hostPlayer(room) {
    return room.host.playerId
      ? room.players.find((player) => player.id === room.host.playerId) || null
      : null;
  }

  #requireBoardHost(socketId) {
    const context = this.#requireHost(socketId);
    if (context.room.phase !== 'board' || !context.room.gameId) {
      throw new RoomError('NO_ACTIVE_GAME', 'Start a game before using the board.');
    }
    return { ...context, game: this.#gameForRoom(context.room, context.room.gameId) };
  }

  #requireClueSelector(socketId) {
    const { room, session } = this.#roomForSocket(socketId);
    if (room.phase !== 'board' || !room.gameId) {
      throw new RoomError('NO_ACTIVE_GAME', 'Start a game before using the board.');
    }
    if (!room.host.playerId && session.role !== 'host') {
      throw new RoomError('HOST_ONLY', 'Only the host can choose clues in a hosted game.');
    }
    if (room.host.playerId && this.#contestantId(room, session) !== room.controlPlayerId) {
      throw new RoomError('NOT_YOUR_TURN', 'Wait for your turn to choose the next clue.');
    }
    return { room, session, game: this.#gameForRoom(room, room.gameId) };
  }

  #ensureConnectedController(room) {
    if (!room.host.playerId || room.phase !== 'board') return;
    const returningController = room.players.find((player) => player.id === room.disconnectedControlPlayerId && player.connected);
    if (returningController) {
      room.controlPlayerId = returningController.id;
      room.disconnectedControlPlayerId = null;
    }
    if (room.players.some((player) => player.id === room.controlPlayerId && player.connected)) return;
    if (!room.disconnectedControlPlayerId && room.players.some((player) => player.id === room.controlPlayerId)) {
      room.disconnectedControlPlayerId = room.controlPlayerId;
    }
    room.controlPlayerId = room.players.find((player) => player.connected)?.id ?? null;
  }

  #gameForRoom(room, gameId) {
    if (room.selectedGame?.id === gameId) return room.selectedGame;
    return room.customGames.find((game) => game.id === gameId) || this.gamesById.get(gameId);
  }

  #touch(room) {
    room.updatedAt = this.now();
  }

  #removePlayerFromRoom(room, playerId) {
    room.players = room.players.filter((player) => player.id !== playerId);
    if (room.disconnectedControlPlayerId === playerId) room.disconnectedControlPlayerId = null;
    if (room.host.playerId === playerId) room.host.playerId = null;
    if (room.currentClue) {
      const wasSelfJudge = room.currentClue.selfJudgePlayerId === playerId;
      room.currentClue.buzzes = room.currentClue.buzzes.filter((buzz) => buzz.playerId !== playerId);
      room.currentClue.ineligiblePlayerIds.delete(playerId);
      if (room.currentClue.dailyPlayerId === playerId) {
        if (room.currentClue.revealed || wasSelfJudge) {
          room.answered.add(room.currentClue.key);
          room.currentClue = null;
        } else {
          room.currentClue.phase = 'daily-wager';
          room.currentClue.dailyPlayerId = null;
          room.currentClue.wager = null;
          room.currentClue.buzzOpen = false;
        }
      } else if (!room.currentClue.dailyDouble && !room.currentClue.revealed) {
        if (wasSelfJudge) room.currentClue.selfJudgePlayerId = null;
        if (!room.currentClue.selfJudgePlayerId && room.currentClue.buzzes.length === 0) {
          room.currentClue.buzzOpen = true;
        }
      }
    }
    if (room.final) delete room.final.entries[playerId];
    this.#ensureConnectedController(room);
  }
}

module.exports = {
  MAX_PLAYERS,
  RoomError,
  RoomManager,
  cleanName,
  cleanRoomCode,
};
