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
async function tryCachePut(cache: BlobCache, url: string, blob: Blob): Promise<void> {
  try {
    const stored = await cache.put(url, blob);
    if (!stored) {
      console.warn('[DocCloak] Model cache put refused (model still loaded in memory)');
    }
  } catch (err) {
    console.warn('[DocCloak] Model cache put failed (model still loaded in memory):', err);
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
  const cache = env.cache;

  const cachedBlob = await readFromCache(cache, url);
  if (cachedBlob) {
    onProgress?.(cachedBlob.size, cachedBlob.size);
    return cachedBlob;
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

  await tryCachePut(cache, url, blob);
  // Prefer the cached (disk-backed) copy so the in-memory chunks can be
  // collected before ONNX Runtime allocates its own copy of the model.
  const diskBlob = await readFromCache(cache, url);
  if (diskBlob && diskBlob.size === blob.size) blob = diskBlob;

  return blob;
}

/**
 * Remove a single model from the cache (e.g. when its URL changes).
 */
export async function evictModelFromCache(env: ModelLoaderEnv, url: string): Promise<void> {
  try {
    await env.cache.delete(url);
  } catch { /* ignore */ }
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
