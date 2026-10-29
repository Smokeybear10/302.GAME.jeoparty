'use strict';

const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { Server } = require('socket.io');
const { catalogGames, loadPreferredGames } = require('./lib/game-store');
const { RoomError, RoomManager } = require('./lib/room-manager');
const { configuredRoomStore } = require('./lib/room-store');
const { clientAddress, tokenBucket } = require('./lib/request-limits');

const ROOT = __dirname;

function createJeopardyServer({ games = loadPreferredGames(), logger = console, roomStore = null, limits = {}, now = Date.now, trustProxy = Boolean(process.env.RENDER) } = {}) {
  const app = express();
  const httpServer = http.createServer(app);
  const io = new Server(httpServer, {
    serveClient: true,
    maxHttpBufferSize: 128 * 1024,
    transports: ['websocket', 'polling'],
    allowRequest: admitTransport,
  });
  const gameCatalog = catalogGames(games);
  const rooms = new RoomManager({ games, now });
  const settings = { maxRooms: 100, maxConnections: 400, connectionsPerAddress: 64, maxPending: 128, actionBurst: 200, actionRate: 20, createBurst: 12, createRate: 1 / 60, ...limits };
  const connectionLimits = tokenBucket({ capacity: 80, refillPerSecond: 2, now });
  const createLimits = tokenBucket({ capacity: settings.createBurst, refillPerSecond: settings.createRate, now });
  const actionLimits = tokenBucket({ capacity: settings.actionBurst, refillPerSecond: settings.actionRate, now });
  const addressActions = tokenBucket({ capacity: 500, refillPerSecond: 100, now });
  const resultReads = tokenBucket({ capacity: 30, refillPerSecond: 1, now });
  const connections = new Map();
  const transportAdmissions = new WeakMap();
  const pendingAdmissions = new Set();
  let connectionCount = 0;
  let pendingMutations = 0;
  let mutationQueue = Promise.resolve();
  let stopping = false;
  let storageFailure = null;

  function admitTransport(request, callback) {
    const address = clientAddress(request, trustProxy);
    if (stopping || connectionCount >= settings.maxConnections || (connections.get(address) || 0) >= settings.connectionsPerAddress || !connectionLimits.take(address)) {
      return callback('The game server is busy. Try connecting again in a moment.', false);
    }
    connectionCount += 1;
    connections.set(address, (connections.get(address) || 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      request.socket.off('close', release);
      pendingAdmissions.delete(release);
      connectionCount -= 1;
      const remaining = (connections.get(address) || 1) - 1;
      if (remaining) connections.set(address, remaining);
      else connections.delete(address);
    };
    const timer = setTimeout(release, 10000);
    timer.unref();
    request.socket.once('close', release);
    pendingAdmissions.add(release);
    transportAdmissions.set(request, { release, timer, isReleased: () => released });
    callback(null, true);
  }

  io.engine.on('connection_error', ({ req }) => transportAdmissions.get(req)?.release());
  io.engine.on('connection', (transport) => {
    const admission = transportAdmissions.get(transport.request);
    if (!admission || admission.isReleased()) return transport.close(true);
    clearTimeout(admission.timer);
    transport.request.socket.off('close', admission.release);
    pendingAdmissions.delete(admission.release);
    transport.once('close', admission.release);
  });

  function mutateAndSave(mutate, { rollback = true, afterSave, onFailure, system = false } = {}) {
    if (stopping) return Promise.reject(new RoomError('SERVER_RESTARTING', 'The server is restarting. Reconnect in a moment.'));
    if (!system && pendingMutations >= settings.maxPending) return Promise.reject(new RoomError('SERVER_BUSY', 'The server is catching up. Try again in a moment.'));
    pendingMutations += 1;
    const operation = mutationQueue.then(async () => {
      if (storageFailure) throw storageFailure;
      const before = roomStore ? rooms.exportSnapshot() : null;
      let result;
      try {
        result = mutate();
        if (roomStore) await roomStore.save(rooms.exportSnapshot());
      } catch (error) {
        if (before && rollback) rooms.restoreSnapshot(before, { restoreConnections: true, expire: false });
        if (error.code === 'STORE_CONFLICT' || error.code === 'STORE_UNCERTAIN') {
          storageFailure = new RoomError('SERVER_RESTARTING', 'Saved games need to be reloaded. Reconnect after the server restarts.');
        }
        if (onFailure) await onFailure(error);
        throw error;
      }
      if (afterSave) await afterSave(result);
      return result;
    });
    const settled = operation.finally(() => { pendingMutations -= 1; });
    mutationQueue = settled.catch(() => {});
    return settled;
  }

  app.disable('x-powered-by');
  app.use((_request, response, next) => {
    response.set('Referrer-Policy', 'no-referrer');
    next();
  });
  app.post('/api/results', (request, response, next) => {
    response.set('Cache-Control', 'no-store');
    if (!resultReads.take(clientAddress(request, trustProxy))) {
      response.set('Retry-After', '5');
      return response.status(429).json({ error: 'Too many requests. Try again in a moment.' });
    }
    next();
  }, express.json({ limit: '1kb' }), async (request, response) => {
    const token = request.body?.token;
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return response.status(400).json({ error: 'This results link is invalid.' });
    if (!roomStore?.readResult) return response.status(503).json({ error: 'Saved results are unavailable. Try again later.' });
    try {
      const result = await roomStore.readResult(token);
      if (!result) return response.status(404).json({ error: 'This saved game could not be found.' });
      response.json({ result });
    } catch {
      response.status(503).json({ error: 'Saved results are unavailable. Try again in a moment.' });
    }
  });
  app.get('/health', (_request, response) => {
    response.status(storageFailure ? 503 : 200).json({ ok: !storageFailure, games: games.length, rooms: rooms.rooms.size });
  });
  app.get('/api/network', (request, response) => {
    response.json({ urls: localNetworkUrls(request.socket.localPort) });
  });
  app.get('/api/games', (_request, response) => response.json(gameCatalog));
  app.get(['/party', '/party/', '/party.html'], (_request, response) => response.redirect(302, '/'));
  app.get(['/practice', '/practice/'], (_request, response) => response.sendFile(path.join(ROOT, 'practice.html')));
  for (const asset of ['practice.css', 'practice-data.js', 'practice-state.js', 'practice.js']) {
    app.get(`/${asset}`, (_request, response) => response.sendFile(path.join(ROOT, asset)));
  }
  app.get(['/', '/index.html'], (_request, response) => response.sendFile(path.join(ROOT, 'index.html')));
  app.get('/app.js', (_request, response) => response.sendFile(path.join(ROOT, 'app.js')));
  app.get('/result-view.js', (_request, response) => response.sendFile(path.join(ROOT, 'result-view.js')));
  app.get('/results.css', (_request, response) => response.sendFile(path.join(ROOT, 'results.css')));
  app.get('/room-sessions.js', (_request, response) => response.sendFile(path.join(ROOT, 'room-sessions.js')));
  app.get('/style.css', (_request, response) => response.sendFile(path.join(ROOT, 'style.css')));
  app.get('/ui.css', (_request, response) => response.sendFile(path.join(ROOT, 'ui.css')));
  app.get('/site-header.css', (_request, response) => response.sendFile(path.join(ROOT, 'site-header.css')));
  app.get('/favicon.ico', (_request, response) => response.status(204).end());
  app.use((_request, response) => response.status(404).json({ error: 'Not found' }));

  function sendError(socket, error, acknowledge) {
    const roomError = error instanceof RoomError
      ? error
      : new RoomError('SERVER_ERROR', 'The server could not complete that action.');
    if (!(error instanceof RoomError)) logger.error(error);
    if (typeof acknowledge === 'function') {
      acknowledge({ ok: false, error: { code: roomError.code, message: roomError.message } });
    } else {
      socket.emit('room:error', { code: roomError.code, message: roomError.message });
    }
  }

  function stateForSocket(socket) {
    return rooms.stateFor(socket.id, gameCatalog);
  }

  async function broadcastRoom(code) {
    if (!code || !rooms.rooms.has(code)) return;
    const sockets = await io.in(code).fetchSockets();
    for (const socket of sockets) {
      if (rooms.roomCodeForSocket(socket.id) !== code) continue;
      socket.emit('room:state', stateForSocket(socket));
    }
  }

  function registerMutation(socket, eventName, mutate) {
    socket.on(eventName, async (payload = {}, acknowledge) => {
      try {
        await mutateAndSave(() => mutate(payload), { afterSave: async (result) => {
          const code = typeof result === 'string' ? result : result?.code;
          await broadcastRoom(code);
          if (typeof acknowledge === 'function') acknowledge({ ok: true, result });
        } });
      } catch (error) {
        sendError(socket, error, acknowledge);
      }
    });
  }

  io.on('connection', (socket) => {
    socket.data.address = clientAddress(socket.request, trustProxy);
    socket.use((packet, next) => {
      const acknowledge = typeof packet.at(-1) === 'function' ? packet.at(-1) : undefined;
      if (pendingMutations >= settings.maxPending) return sendError(socket, new RoomError('SERVER_BUSY', 'The server is catching up. Try again in a moment.'), acknowledge);
      if (!actionLimits.take(socket.id) || !addressActions.take(socket.data.address)) {
        return sendError(socket, new RoomError('RATE_LIMITED', 'Too many actions. Wait a moment and try again.'), acknowledge);
      }
      next();
    });
    socket.on('room:create', async (_payload = {}, acknowledge) => {
      try {
        await mutateAndSave(() => {
          if (!rooms.roomCodeForSocket(socket.id)) {
            if (rooms.rooms.size >= settings.maxRooms) throw new RoomError('ROOM_LIMIT', 'All game rooms are in use. Join an existing room or try again later.');
            if (!createLimits.take(socket.data.address)) throw new RoomError('RATE_LIMITED', 'Too many rooms created. Wait a minute before creating another.');
          }
          return rooms.createRoom(socket.id);
        }, { afterSave: async (session) => {
          await socket.join(session.code);
          const state = stateForSocket(socket);
          acknowledge?.({ ok: true, session, state });
        } });
      } catch (error) {
        sendError(socket, error, acknowledge);
      }
    });

    socket.on('room:join', async (payload = {}, acknowledge) => {
      try {
        await mutateAndSave(() => rooms.joinRoom(socket.id, payload), { afterSave: async (session) => {
          await socket.join(session.code);
          const state = stateForSocket(socket);
          acknowledge?.({ ok: true, session, state });
          await broadcastRoom(session.code);
        } });
      } catch (error) {
        sendError(socket, error, acknowledge);
      }
    });

    socket.on('room:resume', async (payload = {}, acknowledge) => {
      try {
        await mutateAndSave(() => rooms.resumeRoom(socket.id, payload), { afterSave: async (resumedSession) => {
          const { replacedSocketId, ...session } = resumedSession;
          if (replacedSocketId && replacedSocketId !== socket.id) {
            const replacedSocket = io.sockets.sockets.get(replacedSocketId);
            replacedSocket?.emit('room:replaced', { message: 'This room was resumed in another tab or device.' });
            await replacedSocket?.leave(session.code);
            replacedSocket?.disconnect(true);
          }
          await socket.join(session.code);
          const state = stateForSocket(socket);
          acknowledge?.({ ok: true, session, state });
          await broadcastRoom(session.code);
        } });
      } catch (error) {
        sendError(socket, error, acknowledge);
      }
    });

    socket.on('room:leave', async (_payload = {}, acknowledge) => {
      try {
        await mutateAndSave(() => rooms.leaveRoom(socket.id), { afterSave: async (result) => {
          if (result.closed) {
            io.to(result.code).emit('room:closed', { message: 'The host ended this room.' });
            io.in(result.code).socketsLeave(result.code);
          } else {
            await socket.leave(result.code);
            await broadcastRoom(result.code);
          }
          acknowledge?.({ ok: true });
        } });
      } catch (error) {
        sendError(socket, error, acknowledge);
      }
    });

    socket.on('room:close', async (_payload = {}, acknowledge) => {
      try {
        await mutateAndSave(() => rooms.closeRoom(socket.id), { afterSave: async (result) => {
          io.to(result.code).emit('room:closed', { message: 'The host ended this room.' });
          io.in(result.code).socketsLeave(result.code);
          acknowledge?.({ ok: true });
        } });
      } catch (error) {
        sendError(socket, error, acknowledge);
      }
    });

    registerMutation(socket, 'host:join-contestants', (payload) => rooms.joinHostAsPlayer(socket.id, payload));
    registerMutation(socket, 'host:leave-contestants', () => rooms.leaveHostAsPlayer(socket.id));
    registerMutation(socket, 'host:start-game', ({ gameId, mode }) => rooms.startGame(socket.id, gameId, { mode }));
    registerMutation(socket, 'host:create-custom-game', ({ game }) => rooms.createCustomGame(socket.id, game));
    registerMutation(socket, 'host:open-clue', (payload) => rooms.openClue(socket.id, payload));
    registerMutation(socket, 'host:set-daily-double', (payload) => rooms.setDailyDouble(socket.id, payload));
    registerMutation(socket, 'host:reset-buzzers', () => rooms.resetBuzzers(socket.id));
    registerMutation(socket, 'host:reveal-answer', () => rooms.revealAnswer(socket.id));
    registerMutation(socket, 'host:skip-clue', () => rooms.skipClue(socket.id));
    registerMutation(socket, 'host:cancel-clue', () => rooms.cancelClue(socket.id));
    registerMutation(socket, 'host:adjust-score', (payload) => rooms.adjustScore(socket.id, payload));
    registerMutation(socket, 'host:undo-score', (payload) => rooms.undoScore(socket.id, payload));
    registerMutation(socket, 'host:reset-game', () => rooms.resetGame(socket.id));
    registerMutation(socket, 'host:return-lobby', () => rooms.returnToLobby(socket.id));
    registerMutation(socket, 'host:start-final', () => rooms.startFinal(socket.id));
    registerMutation(socket, 'host:next-round', (payload) => rooms.advanceRound(socket.id, payload));
    registerMutation(socket, 'host:advance-final', ({ phase, expectedPhase, force }) => rooms.advanceFinal(socket.id, {
      expectedPhase: expectedPhase ?? phase,
      force,
    }));
    registerMutation(socket, 'host:finish-final', () => rooms.finishFinal(socket.id));
    registerMutation(socket, 'player:buzz', () => rooms.buzz(socket.id));
    registerMutation(socket, 'player:open-clue', (payload) => rooms.openClue(socket.id, payload));
    registerMutation(socket, 'player:open-answer', (payload) => rooms.openPlayerAnswer(socket.id, payload));
    registerMutation(socket, 'player:self-score-clue', (payload) => rooms.selfScoreClue(socket.id, payload));
    registerMutation(socket, 'player:skip-clue', (payload) => rooms.skipPlayerClue(socket.id, payload));
    registerMutation(socket, 'player:final-wager', ({ wager }) => rooms.submitFinalWager(socket.id, wager));
    registerMutation(socket, 'player:final-response', ({ response }) => rooms.submitFinalResponse(socket.id, response));
    registerMutation(socket, 'player:self-score-final', (payload) => rooms.selfScoreFinal(socket.id, payload));

    async function handoffHost(payload, acknowledge, reclaim = false) {
      try {
        await mutateAndSave(() => reclaim ? rooms.claimHost(socket.id) : rooms.transferHost(socket.id, payload), { afterSave: async (result) => {
          const formerHost = io.sockets.sockets.get(result.formerHostSocketId);
          const nextHost = io.sockets.sockets.get(result.newHostSocketId);
          if (!result.formerHostSession) await formerHost?.leave(result.code);
          formerHost?.emit('room:session', {
            session: result.formerHostSession,
            state: result.formerHostSession ? stateForSocket(formerHost) : null,
            message: result.formerHostSession ? 'Hosting passed. You are still playing.' : 'Hosting passed. The game is continuing with its new host.',
          });
          if (nextHost) nextHost.emit('room:session', {
            session: result.newHostSession,
            state: stateForSocket(nextHost),
            message: 'You are now hosting. Your score and place in the game are unchanged.',
          });
          await broadcastRoom(result.code);
          if (typeof acknowledge === 'function') acknowledge({ ok: true });
        } });
      } catch (error) {
        sendError(socket, error, acknowledge);
      }
 }
    socket.on('host:transfer-host', (payload = {}, acknowledge) => handoffHost(payload, acknowledge));
    socket.on('player:claim-host', (_payload = {}, acknowledge) => handoffHost({}, acknowledge, true));

    socket.on('host:remove-player', async (payload = {}, acknowledge) => {
      try {
        await mutateAndSave(() => rooms.removePlayer(socket.id, payload?.playerId), { afterSave: async (result) => {
          if (result.removedSocketId) {
            const removedSocket = io.sockets.sockets.get(result.removedSocketId);
            removedSocket?.emit('room:removed', { message: 'The host removed you from the room.' });
            await removedSocket?.leave(result.code);
          }
          await broadcastRoom(result.code);
          acknowledge?.({ ok: true });
        } });
      } catch (error) {
        sendError(socket, error, acknowledge);
      }
    });

    socket.on('disconnect', () => {
      actionLimits.forget(socket.id);
      if (stopping) return;
      let disconnectedCode;
      void mutateAndSave(() => {
        disconnectedCode = rooms.disconnect(socket.id);
        return disconnectedCode;
      }, {
        rollback: false,
        system: true,
        afterSave: (code) => code && broadcastRoom(code),
        onFailure: () => disconnectedCode && broadcastRoom(disconnectedCode),
      }).catch((error) => logger.error(error));
    });
  });

  const cleanupTimer = setInterval(() => {
    void mutateAndSave(() => rooms.cleanup(), { system: true, afterSave: async (removedCodes) => {
      for (const code of removedCodes) {
        io.to(code).emit('room:closed', { message: 'This room expired after a long period of inactivity.' });
        io.in(code).socketsLeave(code);
      }
    } }).catch((error) => logger.error(error));
  }, 30 * 60 * 1000);
  cleanupTimer.unref();

  return {
    app,
    gameCatalog,
    games,
    httpServer,
    io,
    rooms,
    async start(port = 3000, host = '0.0.0.0') {
      if (roomStore) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const snapshot = await roomStore.load();
          if (snapshot !== null) rooms.restoreSnapshot(snapshot);
          try {
            await roomStore.save(rooms.exportSnapshot());
            break;
          } catch (error) {
            if (error.code !== 'STORE_CONFLICT' || attempt === 2) throw error;
          }
        }
      }
      await new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, host, () => {
          httpServer.off('error', reject);
          resolve();
        });
      });
      return httpServer.address();
    },
    async stop() {
      stopping = true;
      clearInterval(cleanupTimer);
      for (const release of pendingAdmissions) release();
      await mutationQueue;
      await new Promise((resolve) => io.close(resolve));
      if (httpServer.listening) await new Promise((resolve) => httpServer.close(resolve));
      if (roomStore) await roomStore.close();
    },
  };
}

function localNetworkUrls(port) {
  const urls = [`http://localhost:${port}`];
  const seen = new Set();
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family !== 'IPv4' || address.internal || seen.has(address.address)) continue;
      seen.add(address.address);
      urls.push(`http://${address.address}:${port}`);
    }
  }
  return urls;
}

if (require.main === module) {
  const port = Number.parseInt(process.env.PORT || '3000', 10);
  const host = process.env.HOST || '0.0.0.0';
  const jeopardy = createJeopardyServer({ roomStore: configuredRoomStore() });
  jeopardy.start(port, host).then((address) => {
    const actualPort = typeof address === 'object' ? address.port : port;
    console.log('\nJeoparty! multiplayer is live.');
    console.log('Open one of these addresses:');
    localNetworkUrls(actualPort).forEach((url) => console.log(`  ${url}`));
    console.log('\nPlayers on the same Wi-Fi should use the local-network address.\n');
  }).catch((error) => {
    console.error('Could not start Jeoparty!:', error.message);
    process.exitCode = 1;
    void jeopardy.stop();
  });

  const shutdown = async () => {
    await jeopardy.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = {
  createJeopardyServer,
  localNetworkUrls,
};
