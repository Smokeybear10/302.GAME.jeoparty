'use strict';

const { isIP } = require('node:net');

function clientAddress(request, trustProxy = false) {
  const forwarded = request.headers['x-forwarded-for'];
  if (trustProxy && typeof forwarded === 'string') {
    const address = forwarded.split(',').at(-1).trim();
    if (isIP(address)) return address;
  }
  return request.socket.remoteAddress || 'unknown';
}

function tokenBucket({ capacity, refillPerSecond, now = Date.now, maxKeys = 4096 }) {
  const buckets = new Map();
  const lifetime = capacity / refillPerSecond * 1000;
  return {
    take(key) {
      const timestamp = now();
      let bucket = buckets.get(key);
      if (!bucket) {
        if (buckets.size >= maxKeys) {
          for (const [storedKey, stored] of buckets) {
            if (timestamp - stored.updatedAt >= lifetime) buckets.delete(storedKey);
          }
          if (buckets.size >= maxKeys) return false;
        }
        bucket = { tokens: capacity, updatedAt: timestamp };
        buckets.set(key, bucket);
      }
      bucket.tokens = Math.min(capacity, bucket.tokens + Math.max(0, timestamp - bucket.updatedAt) / 1000 * refillPerSecond);
      bucket.updatedAt = timestamp;
      if (bucket.tokens < 1) return false;
      bucket.tokens -= 1;
      return true;
    },
    forget(key) { buckets.delete(key); },
  };
}

module.exports = { clientAddress, tokenBucket };
