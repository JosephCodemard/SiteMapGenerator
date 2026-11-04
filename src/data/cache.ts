/**
 * Small response cache: IndexedDB when available, memory otherwise (tests, private windows).
 * It only avoids re-fetching the same public response; nothing is shipped with the app.
 */
const mem = new Map<string, { t: number; v: unknown }>();
let dbPromise: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  dbPromise ??= new Promise((res) => {
    const rq = indexedDB.open('ukdtm-cache', 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore('kv');
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => res(null);
  });
  return dbPromise;
}

async function read(key: string): Promise<{ t: number; v: unknown } | undefined> {
  const hit = mem.get(key);
  if (hit) return hit;
  const d = await db();
  if (!d) return undefined;
  return new Promise((res) => {
    const rq = d.transaction('kv').objectStore('kv').get(key);
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => res(undefined);
  });
}

async function write(key: string, value: { t: number; v: unknown }) {
  mem.set(key, value);
  const d = await db();
  if (!d) return;
  await new Promise<void>((res) => {
    const tx = d.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    tx.oncomplete = () => res();
    tx.onerror = () => res();
  });
}

/** Return the cached value for `key` if it is younger than `ttlMs`, else compute and store it. */
export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = await read(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v as T;
  const v = await fn();
  await write(key, { t: Date.now(), v });
  return v;
}

export const clearMemoryCache = () => mem.clear();

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** GET JSON with a cache and a clear error. */
export async function getJson<T = unknown>(url: string, ttlMs = DAY, init?: RequestInit): Promise<T> {
  return cached<T>(`GET ${url}`, ttlMs, async () => {
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`);
    return res.json() as Promise<T>;
  });
}
