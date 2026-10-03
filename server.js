'use strict';

const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { Server } = require('socket.io');
const { catalogGames, loadPreferredGames } = require('./lib/game-store');
const { RoomError, RoomManager } = require('./lib/room-manager');

const ROOT = __dirname;

function createJeopardyServer({ games = loadPreferredGames(), logger = console } = {}) {
  const app = express();
  const httpServer = http.createServer(app);
  const io = new Server(httpServer, {
    serveClient: true,
    transports: ['websocket', 'polling'],
  });
  const gameCatalog = catalogGames(games);
  const rooms = new RoomManager({ games });

  app.disable('x-powered-by');
  app.get('/health', (_request, response) => {
    response.json({ ok: true, games: games.length, rooms: rooms.rooms.size });
  });
  app.get('/api/network', (request, response) => {
    response.json({ urls: localNetworkUrls(request.socket.localPort) });
  });
  app.get('/api/games', (_request, response) => response.json(gameCatalog));
  app.get(['/', '/index.html'], (_request, response) => response.sendFile(path.join(ROOT, 'index.html')));
  app.get('/app.js', (_request, response) => response.sendFile(path.join(ROOT, 'app.js')));
  app.get('/style.css', (_request, response) => response.sendFile(path.join(ROOT, 'style.css')));
  app.get('/ui.css', (_request, response) => response.sendFile(path.join(ROOT, 'ui.css')));
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
        const result = mutate(payload);
        const code = typeof result === 'string' ? result : result?.code;
        await broadcastRoom(code);
        if (typeof acknowledge === 'function') acknowledge({ ok: true, result });
      } catch (error) {
        sendError(socket, error, acknowledge);
      }
    });
  }

  io.on('connection', (socket) => {
    socket.on('room:create', async (_payload = {}, acknowledge) => {
      try {
        const session = rooms.createRoom(socket.id);
        await socket.join(session.code);
        const state = stateForSocket(socket);
        acknowledge?.({ ok: true, session, state });
      } catch (error) {
        sendError(socket, error, acknowledge);
      }
    });

    socket.on('room:join', async (payload = {}, acknowledge) => {
      try {
        const session = rooms.joinRoom(socket.id, payload);
        await socket.join(session.code);
        const state = stateForSocket(socket);
        acknowledge?.({ ok: true, session, state });
        await broadcastRoom(session.code);
      } catch (error) {
        sendError(socket, error, acknowledge);
      }
    });

    socket.on('room:resume', async (payload = {}, acknowledge) => {
      try {
        const resumedSession = rooms.resumeRoom(socket.id, payload);
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
      } catch (error) {
        sendError(socket, error, acknowledge);
      }
    });

    socket.on('room:leave', async (_payload = {}, acknowledge) => {
      try {
        const result = rooms.leaveRoom(socket.id);
        if (result.closed) {
          io.to(result.code).emit('room:closed', { message: 'The host ended this room.' });
          io.in(result.code).socketsLeave(result.code);
        } else {
          await socket.leave(result.code);
          await broadcastRoom(result.code);
        }
        acknowledge?.({ ok: true });
      } catch (error) {
        sendError(socket, error, acknowledge);
      }
    });

    socket.on('room:close', async (_payload = {}, acknowledge) => {
      try {
        const result = rooms.closeRoom(socket.id);
        io.to(result.code).emit('room:closed', { message: 'The host ended this room.' });
        io.in(result.code).socketsLeave(result.code);
        acknowledge?.({ ok: true });
      } catch (error) {
        sendError(socket, error, acknowledge);
      }
    });

    registerMutation(socket, 'host:join-contestants', (payload) => rooms.joinHostAsPlayer(socket.id, payload));
    registerMutation(socket, 'host:leave-contestants', () => rooms.leaveHostAsPlayer(socket.id));
    registerMutation(socket, 'host:start-game', ({ gameId }) => rooms.startGame(socket.id, gameId));
    registerMutation(socket, 'host:create-custom-game', ({ game }) => rooms.createCustomGame(socket.id, game));
    registerMutation(socket, 'host:open-clue', (payload) => rooms.openClue(socket.id, payload));
    registerMutation(socket, 'host:set-daily-double', (payload) => rooms.setDailyDouble(socket.id, payload));
    registerMutation(socket, 'host:reset-buzzers', () => rooms.resetBuzzers(socket.id));
    registerMutation(socket, 'host:reveal-answer', () => rooms.revealAnswer(socket.id));
    registerMutation(socket, 'host:skip-clue', () => rooms.skipClue(socket.id));
    registerMutation(socket, 'host:cancel-clue', () => rooms.cancelClue(socket.id));
    registerMutation(socket, 'host:adjust-score', (payload) => rooms.adjustScore(socket.id, payload));
    registerMutation(socket, 'host:reset-game', () => rooms.resetGame(socket.id));
    registerMutation(socket, 'host:return-lobby', () => rooms.returnToLobby(socket.id));
    registerMutation(socket, 'host:start-final', () => rooms.startFinal(socket.id));
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

    socket.on('host:remove-player', async ({ playerId } = {}, acknowledge) => {
      try {
        const result = rooms.removePlayer(socket.id, playerId);
        if (result.removedSocketId) {
          const removedSocket = io.sockets.sockets.get(result.removedSocketId);
          removedSocket?.emit('room:removed', { message: 'The host removed you from the room.' });
          await removedSocket?.leave(result.code);
        }
        await broadcastRoom(result.code);
        acknowledge?.({ ok: true });
      } catch (error) {
        sendError(socket, error, acknowledge);
      }
    });

    socket.on('disconnect', () => {
      const code = rooms.disconnect(socket.id);
      if (code) void broadcastRoom(code);
    });
  });

  const cleanupTimer = setInterval(() => {
    const removedCodes = rooms.cleanup();
    for (const code of removedCodes) {
      io.to(code).emit('room:closed', { message: 'This room expired after a long period of inactivity.' });
      io.in(code).socketsLeave(code);
    }
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
      clearInterval(cleanupTimer);
      await new Promise((resolve) => io.close(resolve));
      if (httpServer.listening) await new Promise((resolve) => httpServer.close(resolve));
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
  const jeopardy = createJeopardyServer();
  jeopardy.start(port, host).then((address) => {
    const actualPort = typeof address === 'object' ? address.port : port;
    console.log('\nJeopardy multiplayer is live.');
    console.log('Open one of these addresses:');
    localNetworkUrls(actualPort).forEach((url) => console.log(`  ${url}`));
    console.log('\nPlayers on the same Wi-Fi should use the local-network address.\n');
  }).catch((error) => {
    console.error('Could not start Jeopardy:', error.message);
    process.exitCode = 1;
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
