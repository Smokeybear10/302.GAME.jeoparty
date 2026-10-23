'use strict';

const RoomSessions = (() => {
  const STORAGE_PREFIX = 'jeoparty_saved_seat_v2:';
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
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function createStore(storage, now = Date.now) {
    let memory = [];
    let persistent = true;
    const pending = new Map();

    function keys() {
      const length = storage.length;
      if (!Number.isInteger(length) || length < 0) throw new Error('Browser storage is unavailable.');
      return Array.from({ length }, (_, index) => storage.key(index))
        .filter((key) => typeof key === 'string' && key.startsWith(STORAGE_PREFIX));
    }

    function read() {
      let stored;
      try {
        stored = keys().flatMap((key) => {
          const session = normalize(parse(storage.getItem(key)), now());
          return session && key === STORAGE_PREFIX + identity(session) ? [session] : [];
        });
      } catch {
        persistent = false;
        stored = memory;
      }
      const retained = stored.filter((session) => !pending.has(identity(session)));
      memory = merge([retained, [...pending.values()].filter(Boolean)], now());
      return memory.map((session) => ({ ...session }));
    }

    function flush() {
      try {
        for (const [key, session] of pending) {
          if (session) storage.setItem(STORAGE_PREFIX + key, JSON.stringify(session));
          else storage.removeItem(STORAGE_PREFIX + key);
          pending.delete(key);
        }
        persistent = true;
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
        memory = merge([current, [session]], now());
        flush();
        return { ...session };
      },
      forget(session) {
        if (!validCode(session?.code) || !validToken(session?.token)) return;
        const current = read();
        const key = identity(session);
        pending.set(key, null);
        memory = current.filter((candidate) => identity(candidate) !== key);
        flush();
      },
      forgetRoom(code) {
        if (!validCode(code)) return;
        const current = read();
        for (const key of pending.keys()) {
          if (key.startsWith(`${code}:`)) pending.set(key, null);
        }
        for (const session of current) {
          if (session.code === code) pending.set(identity(session), null);
        }
        try {
          for (const key of keys()) {
            if (key.startsWith(`${STORAGE_PREFIX}${code}:`)) pending.set(key.slice(STORAGE_PREFIX.length), null);
          }
        } catch {
          persistent = false;
        }
        memory = current.filter((session) => session.code !== code);
        flush();
      },
    };
  }

  return { createStore };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = RoomSessions;
