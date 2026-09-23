// ---------------------------------------------------------------------------
// cache.js — a tiny in-process TTL cache.
//
// Nalar runs as a single instance on the mini PC, so there's no need
// for Redis/Memcached — a Map with expiry timestamps does the job and adds
// zero moving parts (and zero new things that can crash on a flaky NVMe).
//
// Usage:
//   const posts = await cached("posts:published", 30_000, () => db.listPublishedPosts());
//   invalidate("posts:");   // drop every key starting with "posts:"
// ---------------------------------------------------------------------------

const store = new Map(); // key -> { value, expiresAt }

/**
 * Get a cached value, or compute + store it if missing/expired.
 * @param {string} key unique cache key
 * @param {number} ttlMs how long the value stays fresh
 * @param {() => Promise<any>} compute how to produce the value on a miss
 */
export async function cached(key, ttlMs, compute) {
  const hit = store.get(key);
  const now = Date.now();
  if (hit && hit.expiresAt > now) return hit.value;

  const value = await compute();
  store.set(key, { value, expiresAt: now + ttlMs });
  return value;
}

/**
 * Drop cache entries. With no argument, clears everything. With a string,
 * clears every key that starts with it — e.g. invalidate("posts:") after any
 * write that could change what a listing/tag-count/RSS query would return.
 */
export function invalidate(prefix) {
  if (!prefix) {
    store.clear();
    return;
  }
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}
