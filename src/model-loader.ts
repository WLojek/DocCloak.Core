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
 *   so they are not re-hashed on every startup. The marker records the
 *   verified byte size (T185): a cache hit whose blob size no longer matches
 *   the marker is re-hashed instead of trusted.
 * - Fetches the pinned tokenizer files (tokenizer.json, tokenizer_config.json)
 *   through the same path (loadPinnedTokenizer, T185) so tokenizers get the
 *   same resume, retry, cache and integrity treatment as the model.
 *
 * Environment-agnostic: all host capabilities (blob cache, fetch, persistent
 * storage request) are injected via ModelLoaderEnv. This module never touches
 * caches, navigator or global fetch directly.
 */

import type { BlobCache, CoreEnv } from './env.ts';

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
 * Value stored in a verification marker: `${sha256}:${size}`, binding the
 * marker to the byte size of the blob that was actually hashed (T185, S4).
 * A cache hit is only trusted without re-hashing when the cached blob's
 * size equals the recorded one. Markers written by 0.11.0 hold the single
 * byte '1' (size unknown): they are upgraded by hashing once and rewriting.
 */
export function verificationMarkerValue(sha256: string, size: number): string {
  return `${sha256.toLowerCase()}:${size}`;
}

/**
 * Size recorded in a marker value for the given hash, or null when the
 * marker is the legacy 0.11.0 '1' or otherwise unreadable (size unknown).
 */
export function parseVerificationMarker(value: string, sha256: string): number | null {
  const match = /^([0-9a-f]{64}):(\d{1,15})$/.exec(value.trim());
  if (!match || match[1] !== sha256.toLowerCase()) return null;
  return Number(match[2]);
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

/** Best-effort write of the verification marker (`${sha256}:${size}`). */
async function markVerified(cache: BlobCache, url: string, sha256: string, size: number): Promise<void> {
  try {
    await cache.put(verificationMarkerKey(url, sha256), new Blob([verificationMarkerValue(sha256, size)]));
  } catch { /* marker is an optimisation - next startup just re-hashes */ }
}

/** Size recorded by the marker for this url + hash; null if absent, legacy or unreadable. */
async function readMarkerSize(cache: BlobCache, url: string, sha256: string): Promise<{ present: boolean; size: number | null }> {
  const marker = await readFromCache(cache, verificationMarkerKey(url, sha256));
  if (!marker) return { present: false, size: null };
  try {
    return { present: true, size: parseVerificationMarker(await marker.text(), sha256) };
  } catch {
    return { present: true, size: null };
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
  /**
   * Pinned byte size of the file. With sha256 it is cross-checked against
   * every download (a size mismatch is an integrity failure like a hash
   * mismatch). It also serves as the progress total when the server sends
   * no content-length. Without sha256 it is only a progress hint.
   */
  size?: number;
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
  const pinnedSize = options?.size;
  const cache = env.cache;

  const cachedBlob = await readFromCache(cache, url);
  if (cachedBlob) {
    if (!expectedSha256) {
      onProgress?.(cachedBlob.size, cachedBlob.size);
      return cachedBlob;
    }
    // Previously verified against this exact pin AND the cached blob still
    // has the size recorded at verification time: skip the re-hash so
    // startup cost is unchanged.
    const marker = await readMarkerSize(cache, url, expectedSha256);
    if (marker.present && marker.size === cachedBlob.size) {
      onProgress?.(cachedBlob.size, cachedBlob.size);
      options?.onVerified?.({ url, sha256: expectedSha256 });
      return cachedBlob;
    }
    if (marker.present && marker.size !== null) {
      console.warn(`[DocCloak] Cached model size ${cachedBlob.size} differs from its verification marker (${marker.size}), re-hashing`);
    }
    // No marker (cache predates pinning, or the pin changed), a legacy
    // 0.11.0 marker without a size, or a size mismatch: hash once and
    // (re)write the marker with the verified size.
    const actualSha256 = await sha256Hex(cachedBlob);
    if (actualSha256 === expectedSha256) {
      await markVerified(cache, url, expectedSha256, cachedBlob.size);
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
    // The pinned size stands in for the total when the server sends none.
    onProgress?.(downloaded, total || pinnedSize || 0);
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
    // downloads) BEFORE it is cached or handed to the runtime. A pinned
    // size that disagrees is an integrity failure too.
    const actualSha256 = await sha256Hex(blob);
    if (actualSha256 !== expectedSha256 || (pinnedSize !== undefined && blob.size !== pinnedSize)) {
      await evictModelFromCache(env, url, expectedSha256);
      throw new ModelIntegrityError(url, expectedSha256, actualSha256);
    }
  }

  const stored = await tryCachePut(cache, url, blob);
  if (expectedSha256 && stored) await markVerified(cache, url, expectedSha256, blob.size);
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
 * Retry an async operation with exponential backoff. Kept for the
 * deprecated CoreEnv.loadTokenizer path (a host library without its own
 * retry handling) and for hosts composing their own downloads; the pinned
 * tokenizer files now go through fetchModelBlob via loadPinnedTokenizer.
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

// ── Pinned tokenizer files (T185) ──────────────────────────

/** One pinned companion file: immutable resolve/<commit> URL, SHA-256 and byte size. */
export interface TokenizerFileSpec {
  url: string;
  /** Lowercase hex SHA-256 of the file at the pinned commit. */
  sha256: string;
  /** Byte size of the file at the pinned commit. */
  size: number;
}

/** The two files a provider pins for its tokenizer: tokenizer.json, then tokenizer_config.json. */
export type TokenizerFiles = readonly [tokenizerJson: TokenizerFileSpec, tokenizerConfig: TokenizerFileSpec];

export type PinnedTokenizerOptions = Pick<FetchModelOptions, 'maxAttempts' | 'retryBaseDelayMs' | 'onVerified'>;

/**
 * Download (or serve from cache) one pinned JSON file through fetchModelBlob
 * with its sha256 and size, then parse it. Integrity failures surface as
 * ModelIntegrityError with the entry evicted, like the model itself.
 */
export async function fetchPinnedJson(
  env: ModelLoaderEnv,
  file: TokenizerFileSpec,
  options?: PinnedTokenizerOptions,
): Promise<unknown> {
  const blob = await fetchModelBlob(env, file.url, undefined, {
    ...options,
    sha256: file.sha256,
    size: file.size,
  });
  const text = await blob.text();
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new Error(`Pinned file is not valid JSON (${file.url}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

let warnedDeprecatedLoadTokenizer = false;

/**
 * Resolve a provider's tokenizer through the host env.
 *
 * Preferred path: fetch both pinned files via fetchPinnedJson (resume,
 * retry, blob cache, verification marker, ModelIntegrityError) and hand the
 * parsed objects to CoreEnv.buildTokenizer. No library probes mutable
 * resolve/main, no second cache bucket, and a warm cache works offline.
 *
 * Fallback (deprecated, removed in 0.13.0): hosts that only implement
 * CoreEnv.loadTokenizer(hfModelId) are still served through it with the
 * previous retry wrapper.
 */
export async function loadPinnedTokenizer(
  env: CoreEnv,
  files: TokenizerFiles,
  legacyHfModelId: string,
  options?: PinnedTokenizerOptions,
): Promise<unknown> {
  if (typeof env.buildTokenizer === 'function') {
    const loaderEnv: ModelLoaderEnv = {
      cache: env.modelCache,
      fetch: env.fetch,
      persistStorage: env.persistStorage,
    };
    const [tokenizerJson, tokenizerConfig] = await Promise.all([
      fetchPinnedJson(loaderEnv, files[0], options),
      fetchPinnedJson(loaderEnv, files[1], options),
    ]);
    const tokenizer: unknown = await env.buildTokenizer(tokenizerJson, tokenizerConfig);
    if (tokenizer === null || tokenizer === undefined) {
      throw new Error('CoreEnv.buildTokenizer returned no tokenizer');
    }
    return tokenizer;
  }
  if (typeof env.loadTokenizer === 'function') {
    if (!warnedDeprecatedLoadTokenizer) {
      warnedDeprecatedLoadTokenizer = true;
      console.warn('[DocCloak] CoreEnv.loadTokenizer is deprecated and will be removed in @doccloak/core 0.13.0; implement buildTokenizer(tokenizerJson, tokenizerConfig) instead');
    }
    // Call through env so host implementations keep their receiver.
    return retryAsync(() => env.loadTokenizer!(legacyHfModelId), 'Tokenizer download', options);
  }
  throw new Error('CoreEnv must implement buildTokenizer(tokenizerJson, tokenizerConfig); loadTokenizer(hfModelId) is deprecated');
}
