'use strict';

const RoomSessions = (() => {
  const STORAGE_KEY = 'jeoparty_saved_rooms_v1';
  const MAX_SESSIONS = 12;
  const EXPIRES_AFTER = 12 * 60 * 60 * 1000;
  const validCode = (code) => typeof code === 'string' && /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/.test(code);
  const validToken = (token) => typeof token === 'string' && /^[A-Za-z0-9_-]{24}$/.test(token);
  const identity = (session) => `${session.code}:${session.token}`;
  const label = (value, length) => typeof value === 'string' ? value.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, length).trim() : '';

  function normalize(value, now) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !validCode(value.code) || !validToken(value.token) || !['host', 'player'].includes(value.role)
      || !Number.isSafeInteger(value.savedAt) || value.savedAt < 0 || value.savedAt > now
      || now - value.savedAt >= EXPIRES_AFTER
      || (value.playerId !== undefined && (typeof value.playerId !== 'string' || !/^p_[a-f0-9]{12}$/.test(value.playerId)))) return null;
    const session = { code: value.code, token: value.token, role: value.role, savedAt: value.savedAt };
    if (value.playerId) session.playerId = value.playerId;
    for (const [key, length] of [['name', 24], ['title', 200], ['preferredGameId', 200]]) {
      const text = label(value[key], length);
      if (text) session[key] = text;
    }
    if (['full', 'quick'].includes(value.preferredGameMode)) session.preferredGameMode = value.preferredGameMode;
    return session;
  }

  function merge(lists, now) {
    const sessions = new Map();
    for (const value of lists.flat()) {
      const session = normalize(value, now);
      if (!session) continue;
      const previous = sessions.get(identity(session));
      if (!previous || session.savedAt >= previous.savedAt) sessions.set(identity(session), session);
    }
    return [...sessions.values()]
      .sort((first, second) => second.savedAt - first.savedAt || identity(first).localeCompare(identity(second)))
      .slice(0, MAX_SESSIONS);
  }

  function parse(raw) {
    try {
      const value = JSON.parse(raw);
      return value?.version === 1 && Array.isArray(value.sessions) ? value.sessions : [];
    } catch {
      return [];
    }
  }

  function createStore(storage, now = Date.now) {
    let memory = [];
    let persistent = true;
    const pending = new Map();
    const forgotten = new Set();
    const forgottenRooms = new Set();

    function read() {
      let stored;
      try {
        stored = parse(storage.getItem(STORAGE_KEY));
      } catch {
        persistent = false;
        stored = memory;
      }
      const retained = merge([stored], now()).filter((session) => !forgotten.has(identity(session)) && !forgottenRooms.has(session.code));
      memory = merge([retained, [...pending.values()]], now());
      return memory.map((session) => ({ ...session }));
    }

    function write(sessions) {
      memory = merge([sessions], now());
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, sessions: memory }));
        persistent = true;
        pending.clear();
        forgotten.clear();
        forgottenRooms.clear();
      } catch {
        persistent = false;
      }
    }

    read();
    return {
      list: read,
      get persistent() { return persistent; },
      save(value) {
        const session = normalize({ ...value, savedAt: now() }, now());
        if (!session) return null;
        const current = read();
        pending.set(identity(session), session);
        forgotten.delete(identity(session));
        write(merge([current, [session]], now()));
        return { ...session };
      },
      forget(session) {
        if (!validCode(session?.code) || !validToken(session?.token)) return;
        const current = read();
        const key = identity(session);
        pending.delete(key);
        forgotten.add(key);
        write(current.filter((candidate) => identity(candidate) !== key));
      },
      forgetRoom(code) {
        if (!validCode(code)) return;
        const current = read();
        for (const [key, session] of pending) {
          if (session.code === code) pending.delete(key);
        }
        forgottenRooms.add(code);
        write(current.filter((session) => session.code !== code));
      },
    };
  }

  return { createStore };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = RoomSessions;
