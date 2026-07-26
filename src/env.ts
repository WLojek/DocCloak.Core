/**
 * @doccloak/core - environment abstraction.
 *
 * Every host (web app, MV3 extension, tests) supplies a CoreEnv describing how
 * the engine talks to the outside world. Core code never touches localStorage,
 * chrome.storage, caches, navigator or import.meta directly.
 *
 * Interfaces match architecture doc section 4.2 verbatim.
 */

/** Async key-value store for settings. Web: localStorage wrapper. Extension: chrome.storage.local. */
export interface KVStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Blob cache for model files. Web + extension: Cache Storage. Tests: in-memory. */
export interface BlobCache {
  match(url: string): Promise<Blob | undefined>;
  put(url: string, blob: Blob): Promise<boolean>;   // best-effort; false = quota refused
  delete(url: string): Promise<void>;
}

export interface HardwareHints {
  deviceMemoryGB?: number;   // replaces navigator.deviceMemory sniffing in engine.ts
  isMobile?: boolean;        // replaces userAgent sniffing (used for default model choice)
}

export interface CoreEnv {
  kv: KVStore;
  modelCache: BlobCache;
  fetch: typeof fetch;                 // injectable for tests/proxies
  wasm: { paths: string; numThreads?: number };   // replaces import.meta.env.BASE_URL; default numThreads 1
  loadTokenizer(hfModelId: string): Promise<unknown /* PreTrainedTokenizer */>;
  hardware?: HardwareHints;
  persistStorage?: () => Promise<boolean>;        // navigator.storage.persist(), optional
}

/** In-memory KVStore for tests. */
export function memoryKV(): KVStore {
  const store = new Map<string, string>();
  return {
    async get(key: string): Promise<string | null> {
      return store.has(key) ? (store.get(key) as string) : null;
    },
    async set(key: string, value: string): Promise<void> {
      store.set(key, value);
    },
    async remove(key: string): Promise<void> {
      store.delete(key);
    },
  };
}

export interface MemoryBlobCacheOptions {
  /**
   * Simulated storage quota in bytes. A put whose blob would push the total
   * stored size above this limit is refused (resolves false), mirroring the
   * best-effort Cache Storage behavior on quota pressure. Unlimited if omitted.
   */
  maxBytes?: number;
}

/** In-memory BlobCache for tests, with an optional simulated quota. */
export function memoryBlobCache(options: MemoryBlobCacheOptions = {}): BlobCache {
  const { maxBytes } = options;
  const store = new Map<string, Blob>();

  function usedBytes(): number {
    let total = 0;
    for (const blob of store.values()) total += blob.size;
    return total;
  }

  return {
    async match(url: string): Promise<Blob | undefined> {
      return store.get(url);
    },
    async put(url: string, blob: Blob): Promise<boolean> {
      if (maxBytes !== undefined) {
        const existing = store.get(url);
        const sizeAfter = usedBytes() - (existing?.size ?? 0) + blob.size;
        if (sizeAfter > maxBytes) return false;
      }
      store.set(url, blob);
      return true;
    },
    async delete(url: string): Promise<void> {
      store.delete(url);
    },
  };
}
