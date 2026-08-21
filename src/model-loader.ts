/**
 * Shared model download utility used by all detection providers.
 *
 * Designed for large downloads (65-280 MB) on unreliable connections,
 * especially mobile networks:
 * - Resumes interrupted downloads with HTTP Range requests instead of
 *   restarting from zero.
 * - Retries transient failures (network errors, stalls, 5xx) with
 *   exponential backoff.
 * - Aborts stalled connections via a watchdog so a dead socket surfaces
 *   as a retryable error instead of hanging forever.
 * - Throttles progress callbacks so the UI thread is not flooded with
 *   thousands of postMessage/setState calls during the download.
 * - Serves the model from the injected BlobCache when available and prefers
 *   the cached (typically disk-backed) copy over the in-memory one to reduce
 *   peak RAM, which matters on iOS Safari where large tabs get killed.
 * - Verifies downloads against a pinned SHA-256 when the caller provides one
 *   (supply-chain hardening, T116): mismatches evict the cache entry and
 *   reject with ModelIntegrityError; verified cache entries carry a marker
 *   so they are not re-hashed on every startup.
 *
 * Environment-agnostic: all host capabilities (blob cache, fetch, persistent
 * storage request) are injected via ModelLoaderEnv. This module never touches
 * caches, navigator or global fetch directly.
 */

import type { BlobCache } from './env.ts';

const MAX_ATTEMPTS = 4;
const STALL_TIMEOUT_MS = 30_000;
const PROGRESS_INTERVAL_MS = 150;
const RETRY_BASE_DELAY_MS = 1_000;

export type DownloadProgress = (downloaded: number, total: number) => void;

/**
 * Host capabilities the loader needs. Hosts pass the relevant slice of their
 * CoreEnv (modelCache as cache, fetch, persistStorage).
 */
export interface ModelLoaderEnv {
  /** Blob cache for downloaded models. Web/extension: Cache Storage adapter. Tests: memoryBlobCache. */
  cache: BlobCache;
  /** Network access. Injectable for tests and proxies. */
  fetch: typeof fetch;
  /** Best-effort persistent-storage request (navigator.storage.persist() on the web). */
  persistStorage?: () => Promise<boolean>;
}

class HttpError extends Error {
  status: number;

  constructor(status: number, url: string) {
    super(`Failed to download model: HTTP ${status} (${url})`);
    this.name = 'HttpError';
    this.status = status;
  }
}

/**
 * A downloaded (or cached) model blob did not match the pinned SHA-256.
 * Distinct error type so hosts can show a dedicated "integrity check
 * failed" state instead of a generic download error. The offending cache
 * entry is evicted before this is thrown; the regex/rules tier keeps
 * working (existing degraded-mode behavior).
 */
export class ModelIntegrityError extends Error {
  url: string;
  expectedSha256: string;
  actualSha256: string;

  constructor(url: string, expectedSha256: string, actualSha256: string) {
    super(
      `Model failed SHA-256 integrity check: expected ${expectedSha256.slice(0, 12)}..., ` +
      `got ${actualSha256.slice(0, 12)}... (${url}). The downloaded copy was discarded.`,
    );
    this.name = 'ModelIntegrityError';
    this.url = url;
    this.expectedSha256 = expectedSha256;
    this.actualSha256 = actualSha256;
  }
}

/** Successful SHA-256 verification of a model blob, surfaced to the model-status UI. */
export interface ModelVerification {
  url: string;
  /** The verified SHA-256, lowercase hex - equals the pinned hash. */
  sha256: string;
}

/**
 * Cache key of the tiny "this URL was verified against this hash" marker.
 * Uses a query parameter (not a URL fragment) because Cache Storage strips
 * fragments, which would collide with the model entry itself. Keyed by
 * url AND hash so bumping a pinned hash automatically invalidates markers
 * written for the previous pin.
 */
export function verificationMarkerKey(url: string, sha256: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}doccloak-sha256-verified=${sha256}`;
}

/**
 * SHA-256 of a blob as lowercase hex. WebCrypto has no streaming digest,
 * so the blob is hashed as one contiguous buffer: peak cost is one extra
 * transient copy of the model, released before ONNX Runtime allocates its
 * own copy.
 */
async function sha256Hex(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Best-effort write of the verification marker (a 1-byte blob). */
async function markVerified(cache: BlobCache, url: string, sha256: string): Promise<void> {
  try {
    await cache.put(verificationMarkerKey(url, sha256), new Blob(['1']));
  } catch { /* marker is an optimisation - next startup just re-hashes */ }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) {
    return err.status === 408 || err.status === 429 || err.status >= 500;
  }
  // AbortError comes from our stall watchdog; TypeError is fetch's generic
  // network failure (connection reset, DNS, CORS transport error, ...).
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  if (err instanceof TypeError) return true;
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let persistRequested = false;

/**
 * Best-effort request for persistent storage so the browser does not evict
 * the cached model under storage pressure (common on mobile). Requested at
 * most once per session, matching the previous web-only behavior.
 */
async function requestPersistentStorage(env: ModelLoaderEnv): Promise<void> {
  if (persistRequested || !env.persistStorage) return;
  persistRequested = true;
  try {
    await env.persistStorage();
  } catch { /* not supported or denied - caching still works, just evictable */ }
}

async function readFromCache(cache: BlobCache, url: string): Promise<Blob | null> {
  try {
    const cached = await cache.match(url);
    if (cached) return cached;
  } catch { /* corrupt entry or read failure - fall through to network */ }
  return null;
}

/**
 * Best-effort cache put - large models can exceed per-origin quota, which
 * surfaces either as put() resolving false or as a thrown error depending on
 * the adapter. Caching is an optimisation, not a correctness requirement.
 */
async function tryCachePut(cache: BlobCache, url: string, blob: Blob): Promise<boolean> {
  try {
    const stored = await cache.put(url, blob);
    if (!stored) {
      console.warn('[DocCloak] Model cache put refused (model still loaded in memory)');
    }
    return stored;
  } catch (err) {
    console.warn('[DocCloak] Model cache put failed (model still loaded in memory):', err);
    return false;
  }
}

interface AttemptResult {
  /** Total size reported by the server, 0 if unknown */
  total: number;
  /** True if the server honored our Range request (206) */
  resumed: boolean;
}

/**
 * One download attempt. Streams the body through onChunk. A watchdog aborts
 * the request if no bytes arrive for STALL_TIMEOUT_MS, covering both the
 * initial connection and mid-body stalls. onHeaders fires as soon as the
 * response headers are parsed - before the body streams - so callers can
 * report a correct total alongside per-chunk progress.
 */
async function downloadAttempt(
  fetchFn: typeof fetch,
  url: string,
  offset: number,
  onChunk: (chunk: Uint8Array) => void,
  onHeaders?: (info: AttemptResult) => void,
): Promise<AttemptResult> {
  const controller = new AbortController();
  let watchdog = setTimeout(() => controller.abort(), STALL_TIMEOUT_MS);
  const kickWatchdog = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => controller.abort(), STALL_TIMEOUT_MS);
  };

  try {
    const headers: Record<string, string> = {};
    if (offset > 0) headers['Range'] = `bytes=${offset}-`;

    const response = await fetchFn(url, { headers, signal: controller.signal });
    kickWatchdog();

    if (!response.ok) throw new HttpError(response.status, url);

    const resumed = response.status === 206;
    let total = 0;
    if (resumed) {
      // Content-Range: bytes <start>-<end>/<total>
      const contentRange = response.headers.get('content-range');
      const match = contentRange?.match(/\/(\d+)\s*$/);
      if (match) total = parseInt(match[1], 10);
    } else {
      const contentLength = response.headers.get('content-length');
      if (contentLength) total = parseInt(contentLength, 10);
    }
    onHeaders?.({ total, resumed });

    if (!response.body) {
      // No streaming support - read in one shot (no resume possible, but
      // the retry loop still restarts from scratch on failure).
      const buffer = await response.arrayBuffer();
      onChunk(new Uint8Array(buffer));
      return { total, resumed };
    }

    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      kickWatchdog();
      onChunk(value);
    }
    return { total, resumed };
  } finally {
    clearTimeout(watchdog);
  }
}

export interface FetchModelOptions {
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  /**
   * Pinned SHA-256 (lowercase hex) of the model blob. When set, every
   * network download is hashed before use; a mismatch evicts the cache
   * entry and rejects with ModelIntegrityError. Cached blobs that carry a
   * verification marker for this hash skip re-hashing so startup cost is
   * unchanged; cached blobs without a marker are hashed once and either
   * marked verified or evicted and re-downloaded.
   */
  sha256?: string;
  /** Fired once the served blob is known to match the pinned sha256. */
  onVerified?: (verification: ModelVerification) => void;
}

/**
 * Download a model with progress reporting, resume and retry.
 * Returns a Blob (served from the injected cache when possible).
 */
export async function fetchModelBlob(
  env: ModelLoaderEnv,
  url: string,
  onProgress?: DownloadProgress,
  options?: FetchModelOptions,
): Promise<Blob> {
  const maxAttempts = options?.maxAttempts ?? MAX_ATTEMPTS;
  const retryBaseDelayMs = options?.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS;
  const expectedSha256 = options?.sha256?.toLowerCase();
  const cache = env.cache;

  const cachedBlob = await readFromCache(cache, url);
  if (cachedBlob) {
    if (!expectedSha256) {
      onProgress?.(cachedBlob.size, cachedBlob.size);
      return cachedBlob;
    }
    // Previously verified against this exact pin: skip the re-hash so
    // startup cost is unchanged.
    const marker = await readFromCache(cache, verificationMarkerKey(url, expectedSha256));
    if (marker) {
      onProgress?.(cachedBlob.size, cachedBlob.size);
      options?.onVerified?.({ url, sha256: expectedSha256 });
      return cachedBlob;
    }
    // No marker (cache predates pinning, or the pin changed): hash once.
    const actualSha256 = await sha256Hex(cachedBlob);
    if (actualSha256 === expectedSha256) {
      await markVerified(cache, url, expectedSha256);
      onProgress?.(cachedBlob.size, cachedBlob.size);
      options?.onVerified?.({ url, sha256: expectedSha256 });
      return cachedBlob;
    }
    // Stale or corrupt cached copy - evict and fall through to the network.
    console.warn(`[DocCloak] Cached model failed SHA-256 check (expected ${expectedSha256.slice(0, 12)}..., got ${actualSha256.slice(0, 12)}...), re-downloading`);
    await evictModelFromCache(env, url, expectedSha256);
  }

  await requestPersistentStorage(env);

  let lastProgressAt = 0;
  const reportProgress = (downloaded: number, total: number, force = false) => {
    const now = Date.now();
    if (!force && now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
    lastProgressAt = now;
    onProgress?.(downloaded, total);
  };

  let chunks: Uint8Array[] = [];
  let downloaded = 0;
  let total = 0;

  for (let attempt = 1; ; attempt++) {
    try {
      const requestedOffset = downloaded;
      const result = await downloadAttempt(
        env.fetch,
        url,
        requestedOffset,
        (chunk) => {
          chunks.push(chunk);
          downloaded += chunk.length;
          reportProgress(downloaded, total);
        },
        (info) => {
          if (info.total > 0) total = info.resumed ? info.total : Math.max(total, info.total);
        },
      );

      if (requestedOffset > 0 && !result.resumed) {
        // Server ignored the Range header and sent the file from the start.
        // The freshly received chunks already replace everything, but they
        // were appended after the stale ones - rebuild keeping only bytes
        // from this attempt.
        const freshBytes = downloaded - requestedOffset;
        const fresh: Uint8Array[] = [];
        let need = freshBytes;
        for (let i = chunks.length - 1; i >= 0 && need > 0; i--) {
          fresh.unshift(chunks[i]);
          need -= chunks[i].length;
        }
        chunks = fresh;
        downloaded = freshBytes;
      }

      if (result.total > 0) total = result.resumed ? result.total : Math.max(total, result.total);

      if (total > 0 && downloaded < total) {
        // Connection closed early without an error. Treat as retryable.
        throw new DOMException('Download ended before completion', 'AbortError');
      }
      break;
    } catch (err) {
      if (!isRetryable(err) || attempt >= maxAttempts) {
        throw err instanceof Error ? err : new Error(String(err));
      }
      console.warn(`[DocCloak] Model download interrupted at ${downloaded} bytes (attempt ${attempt}/${maxAttempts}), retrying...`, err);
      await delay(retryBaseDelayMs * 2 ** (attempt - 1));
    }
  }

  reportProgress(downloaded, total || downloaded, true);

  let blob: Blob = new Blob(chunks);
  chunks = [];

  if (expectedSha256) {
    // Verify the final assembled blob (covers both fresh and resumed
    // downloads) BEFORE it is cached or handed to the runtime.
    const actualSha256 = await sha256Hex(blob);
    if (actualSha256 !== expectedSha256) {
      await evictModelFromCache(env, url, expectedSha256);
      throw new ModelIntegrityError(url, expectedSha256, actualSha256);
    }
  }

  const stored = await tryCachePut(cache, url, blob);
  if (expectedSha256 && stored) await markVerified(cache, url, expectedSha256);
  // Prefer the cached (disk-backed) copy so the in-memory chunks can be
  // collected before ONNX Runtime allocates its own copy of the model.
  const diskBlob = await readFromCache(cache, url);
  if (diskBlob && diskBlob.size === blob.size) blob = diskBlob;

  if (expectedSha256) options?.onVerified?.({ url, sha256: expectedSha256 });
  return blob;
}

/**
 * Remove a single model from the cache (e.g. when its URL changes). When a
 * pinned sha256 is given, the matching verification marker is removed too.
 */
export async function evictModelFromCache(env: ModelLoaderEnv, url: string, sha256?: string): Promise<void> {
  try {
    await env.cache.delete(url);
  } catch { /* ignore */ }
  if (sha256) {
    try {
      await env.cache.delete(verificationMarkerKey(url, sha256.toLowerCase()));
    } catch { /* ignore */ }
  }
}

/**
 * Retry an async operation with exponential backoff. Used for the smaller
 * companion downloads (tokenizer files) that go through libraries without
 * their own retry handling - one dropped request on a flaky connection
 * should not abort the whole model load.
 */
export async function retryAsync<T>(
  operation: () => Promise<T>,
  label: string,
  options?: FetchModelOptions,
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? MAX_ATTEMPTS;
  const retryBaseDelayMs = options?.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS;

  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (err) {
      if (attempt >= maxAttempts) throw err;
      console.warn(`[DocCloak] ${label} failed (attempt ${attempt}/${maxAttempts}), retrying...`, err);
      await delay(retryBaseDelayMs * 2 ** (attempt - 1));
    }
  }
}
