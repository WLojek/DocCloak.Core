import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  fetchModelBlob,
  evictModelFromCache,
  verificationMarkerKey,
  verificationMarkerValue,
  parseVerificationMarker,
  fetchPinnedJson,
  loadPinnedTokenizer,
  ModelIntegrityError,
  type ModelLoaderEnv,
  type ModelVerification,
  type TokenizerFiles,
} from '../src/model-loader.ts';
import { memoryBlobCache, memoryKV } from '../src/env.ts';
import type { CoreEnv } from '../src/env.ts';

/**
 * Build a Response-like object with a streaming body that yields the given
 * chunks and then either completes or errors.
 */
function streamResponse(
  chunks: Uint8Array[],
  opts: { status?: number; total?: number; rangeStart?: number; failAfter?: boolean } = {},
): Response {
  const { status = 200, total, rangeStart, failAfter = false } = opts;
  const headers = new Headers();
  if (total !== undefined) {
    if (status === 206 && rangeStart !== undefined) {
      headers.set('content-range', `bytes ${rangeStart}-${total - 1}/${total}`);
    } else {
      headers.set('content-length', String(total));
    }
  }

  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i++]);
      } else if (failAfter) {
        controller.error(new TypeError('network error'));
      } else {
        controller.close();
      }
    },
  });

  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    body,
  } as unknown as Response;
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

const bytes = (...values: number[]) => new Uint8Array(values);

/** Keep retry backoff near-instant so tests do not wait out real delays */
const FAST_RETRY = { retryBaseDelayMs: 1 };

/** Injected environment: in-memory blob cache + mocked fetch */
function makeEnv(): { env: ModelLoaderEnv; fetchMock: ReturnType<typeof vi.fn> } {
  const fetchMock = vi.fn();
  const env: ModelLoaderEnv = {
    cache: memoryBlobCache(),
    fetch: fetchMock as unknown as typeof fetch,
  };
  return { env, fetchMock };
}

describe('fetchModelBlob', () => {
  it('downloads a model in one attempt and reports final progress', async () => {
    const { env, fetchMock } = makeEnv();
    fetchMock.mockResolvedValueOnce(streamResponse([bytes(1, 2), bytes(3, 4)], { total: 4 }));

    const progress: Array<[number, number]> = [];
    const blob = await fetchModelBlob(env, 'https://example.com/model.onnx', (d, t) => progress.push([d, t]));

    expect(await blobBytes(blob)).toEqual(bytes(1, 2, 3, 4));
    expect(progress[progress.length - 1]).toEqual([4, 4]);
    // The total must be known from the response headers on, not only at the
    // end - the UI progress bar needs it while the body is still streaming.
    expect(progress.every(([, total]) => total === 4)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('serves a cached model without hitting the network', async () => {
    const { env, fetchMock } = makeEnv();
    await env.cache.put('https://example.com/model.onnx', new Blob([bytes(1, 2, 3, 4)]));

    const progress: Array<[number, number]> = [];
    const blob = await fetchModelBlob(env, 'https://example.com/model.onnx', (d, t) => progress.push([d, t]));

    expect(await blobBytes(blob)).toEqual(bytes(1, 2, 3, 4));
    expect(progress).toEqual([[4, 4]]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resumes with a Range request after a mid-download network failure', async () => {
    const { env, fetchMock } = makeEnv();
    // First attempt: 2 of 4 bytes, then the connection dies
    fetchMock.mockResolvedValueOnce(
      streamResponse([bytes(1, 2)], { total: 4, failAfter: true }),
    );
    // Second attempt: server honors Range and sends the remaining 2 bytes
    fetchMock.mockResolvedValueOnce(
      streamResponse([bytes(3, 4)], { status: 206, total: 4, rangeStart: 2 }),
    );

    const blob = await fetchModelBlob(env, 'https://example.com/model.onnx', undefined, FAST_RETRY);

    expect(await blobBytes(blob)).toEqual(bytes(1, 2, 3, 4));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondCallInit = fetchMock.mock.calls[1][1] as RequestInit;
    expect((secondCallInit.headers as Record<string, string>)['Range']).toBe('bytes=2-');
  });

  it('restarts cleanly when the server ignores the Range header', async () => {
    const { env, fetchMock } = makeEnv();
    fetchMock.mockResolvedValueOnce(
      streamResponse([bytes(1, 2)], { total: 4, failAfter: true }),
    );
    // Server replies 200 with the full body despite the Range request
    fetchMock.mockResolvedValueOnce(
      streamResponse([bytes(1, 2), bytes(3, 4)], { status: 200, total: 4 }),
    );

    const blob = await fetchModelBlob(env, 'https://example.com/model.onnx', undefined, FAST_RETRY);

    expect(await blobBytes(blob)).toEqual(bytes(1, 2, 3, 4));
  });

  it('retries when the body ends before content-length is reached', async () => {
    const { env, fetchMock } = makeEnv();
    // Stream closes cleanly after 2 of 4 bytes (truncated by a proxy)
    fetchMock.mockResolvedValueOnce(streamResponse([bytes(1, 2)], { total: 4 }));
    fetchMock.mockResolvedValueOnce(
      streamResponse([bytes(3, 4)], { status: 206, total: 4, rangeStart: 2 }),
    );

    const blob = await fetchModelBlob(env, 'https://example.com/model.onnx', undefined, FAST_RETRY);

    expect(await blobBytes(blob)).toEqual(bytes(1, 2, 3, 4));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails immediately on non-retryable HTTP errors', async () => {
    const { env, fetchMock } = makeEnv();
    fetchMock.mockResolvedValue(streamResponse([], { status: 404 }));

    await expect(fetchModelBlob(env, 'https://example.com/missing.onnx')).rejects.toThrow('404');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after exhausting retries', async () => {
    const { env, fetchMock } = makeEnv();
    fetchMock.mockRejectedValue(new TypeError('network down'));

    await expect(fetchModelBlob(env, 'https://example.com/model.onnx', undefined, FAST_RETRY)).rejects.toThrow('network down');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

// ── SHA-256 integrity verification (T116) ─────────────────

const URL_ = 'https://example.com/model.onnx';
/** SHA-256 of bytes 01 02 03 04 */
const GOOD_SHA256 = '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a';

describe('fetchModelBlob SHA-256 verification', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts a matching download, reports verification and writes a size-bound marker', async () => {
    const { env, fetchMock } = makeEnv();
    fetchMock.mockResolvedValueOnce(streamResponse([bytes(1, 2), bytes(3, 4)], { total: 4 }));

    const verifications: ModelVerification[] = [];
    const blob = await fetchModelBlob(env, URL_, undefined, {
      sha256: GOOD_SHA256,
      onVerified: (v) => verifications.push(v),
    });

    expect(await blobBytes(blob)).toEqual(bytes(1, 2, 3, 4));
    expect(verifications).toEqual([{ url: URL_, sha256: GOOD_SHA256 }]);
    expect(await env.cache.match(URL_)).toBeDefined();
    const marker = await env.cache.match(verificationMarkerKey(URL_, GOOD_SHA256));
    expect(marker).toBeDefined();
    expect(await marker!.text()).toBe(`${GOOD_SHA256}:4`);
  });

  it('rejects a tampered download with ModelIntegrityError and does not cache it', async () => {
    const { env, fetchMock } = makeEnv();
    // Attacker-swapped bytes: same length, different content
    fetchMock.mockResolvedValueOnce(streamResponse([bytes(9, 9), bytes(9, 9)], { total: 4 }));

    const onVerified = vi.fn();
    let caught: unknown;
    try {
      await fetchModelBlob(env, URL_, undefined, { sha256: GOOD_SHA256, onVerified });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ModelIntegrityError);
    const integrityError = caught as ModelIntegrityError;
    expect(integrityError.name).toBe('ModelIntegrityError');
    expect(integrityError.url).toBe(URL_);
    expect(integrityError.expectedSha256).toBe(GOOD_SHA256);
    expect(integrityError.actualSha256).not.toBe(GOOD_SHA256);
    expect(onVerified).not.toHaveBeenCalled();
    // Nothing usable may remain in the cache
    expect(await env.cache.match(URL_)).toBeUndefined();
    expect(await env.cache.match(verificationMarkerKey(URL_, GOOD_SHA256))).toBeUndefined();
    // Integrity failures are not retried
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('evicts a cached blob that fails verification and re-downloads', async () => {
    const { env, fetchMock } = makeEnv();
    // Cache poisoned (or stale revision), no verification marker
    await env.cache.put(URL_, new Blob([bytes(9, 9, 9, 9)]));
    fetchMock.mockResolvedValueOnce(streamResponse([bytes(1, 2, 3, 4)], { total: 4 }));

    const onVerified = vi.fn();
    const blob = await fetchModelBlob(env, URL_, undefined, { sha256: GOOD_SHA256, onVerified });

    expect(await blobBytes(blob)).toEqual(bytes(1, 2, 3, 4));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onVerified).toHaveBeenCalledWith({ url: URL_, sha256: GOOD_SHA256 });
    expect(await blobBytes((await env.cache.match(URL_))!)).toEqual(bytes(1, 2, 3, 4));
  });

  it('verifies a cached blob without a marker once, then skips re-hashing', async () => {
    const { env, fetchMock } = makeEnv();
    // Pre-pinning cache entry with the CORRECT bytes but no marker
    await env.cache.put(URL_, new Blob([bytes(1, 2, 3, 4)]));

    const digestSpy = vi.spyOn(crypto.subtle, 'digest');

    const first = await fetchModelBlob(env, URL_, undefined, { sha256: GOOD_SHA256 });
    expect(await blobBytes(first)).toEqual(bytes(1, 2, 3, 4));
    expect(digestSpy).toHaveBeenCalledTimes(1);
    expect(await env.cache.match(verificationMarkerKey(URL_, GOOD_SHA256))).toBeDefined();

    // Second startup: marker present, no re-hash, still reported verified
    const onVerified = vi.fn();
    const second = await fetchModelBlob(env, URL_, undefined, { sha256: GOOD_SHA256, onVerified });
    expect(await blobBytes(second)).toEqual(bytes(1, 2, 3, 4));
    expect(digestSpy).toHaveBeenCalledTimes(1);
    expect(onVerified).toHaveBeenCalledWith({ url: URL_, sha256: GOOD_SHA256 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('verifies the final assembled blob on the resume path', async () => {
    const { env, fetchMock } = makeEnv();
    // First attempt dies after 2 of 4 bytes; resume delivers the rest
    fetchMock.mockResolvedValueOnce(streamResponse([bytes(1, 2)], { total: 4, failAfter: true }));
    fetchMock.mockResolvedValueOnce(streamResponse([bytes(3, 4)], { status: 206, total: 4, rangeStart: 2 }));

    const onVerified = vi.fn();
    const blob = await fetchModelBlob(env, URL_, undefined, {
      ...FAST_RETRY,
      sha256: GOOD_SHA256,
      onVerified,
    });

    expect(await blobBytes(blob)).toEqual(bytes(1, 2, 3, 4));
    expect(onVerified).toHaveBeenCalledWith({ url: URL_, sha256: GOOD_SHA256 });
  });

  it('rejects a resumed download whose assembled bytes are tampered', async () => {
    const { env, fetchMock } = makeEnv();
    fetchMock.mockResolvedValueOnce(streamResponse([bytes(1, 2)], { total: 4, failAfter: true }));
    // Resume returns wrong bytes for the tail
    fetchMock.mockResolvedValueOnce(streamResponse([bytes(9, 9)], { status: 206, total: 4, rangeStart: 2 }));

    await expect(
      fetchModelBlob(env, URL_, undefined, { ...FAST_RETRY, sha256: GOOD_SHA256 }),
    ).rejects.toBeInstanceOf(ModelIntegrityError);
    expect(await env.cache.match(URL_)).toBeUndefined();
  });

  it('leaves the unverified happy path unchanged when no sha256 is pinned', async () => {
    const { env, fetchMock } = makeEnv();
    fetchMock.mockResolvedValueOnce(streamResponse([bytes(1, 2, 3, 4)], { total: 4 }));

    const digestSpy = vi.spyOn(crypto.subtle, 'digest');
    const blob = await fetchModelBlob(env, URL_);

    expect(await blobBytes(blob)).toEqual(bytes(1, 2, 3, 4));
    expect(digestSpy).not.toHaveBeenCalled();
    expect(await env.cache.match(verificationMarkerKey(URL_, GOOD_SHA256))).toBeUndefined();
  });
});

// ── Verification marker bound to the blob size (T185, S4) ──

describe('verification marker value', () => {
  it('formats and parses `${sha256}:${size}`', () => {
    expect(verificationMarkerValue(GOOD_SHA256.toUpperCase(), 4)).toBe(`${GOOD_SHA256}:4`);
    expect(parseVerificationMarker(`${GOOD_SHA256}:4`, GOOD_SHA256)).toBe(4);
    expect(parseVerificationMarker(`${GOOD_SHA256}:82680500\n`, GOOD_SHA256)).toBe(82680500);
  });

  it('treats the legacy 0.11.0 marker and garbage as unknown size', () => {
    expect(parseVerificationMarker('1', GOOD_SHA256)).toBeNull();
    expect(parseVerificationMarker('', GOOD_SHA256)).toBeNull();
    expect(parseVerificationMarker(`${GOOD_SHA256}:x`, GOOD_SHA256)).toBeNull();
    // A marker for a different hash never vouches for this pin.
    expect(parseVerificationMarker(`${'a'.repeat(64)}:4`, GOOD_SHA256)).toBeNull();
  });
});

describe('fetchModelBlob marker size check', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('upgrades a legacy 0.11.0 marker: hashes once, rewrites the marker with the size, then trusts it', async () => {
    const { env, fetchMock } = makeEnv();
    await env.cache.put(URL_, new Blob([bytes(1, 2, 3, 4)]));
    await env.cache.put(verificationMarkerKey(URL_, GOOD_SHA256), new Blob(['1']));
    const digestSpy = vi.spyOn(crypto.subtle, 'digest');

    const first = await fetchModelBlob(env, URL_, undefined, { sha256: GOOD_SHA256 });
    expect(await blobBytes(first)).toEqual(bytes(1, 2, 3, 4));
    expect(digestSpy).toHaveBeenCalledTimes(1);
    expect(await (await env.cache.match(verificationMarkerKey(URL_, GOOD_SHA256)))!.text()).toBe(`${GOOD_SHA256}:4`);

    const onVerified = vi.fn();
    await fetchModelBlob(env, URL_, undefined, { sha256: GOOD_SHA256, onVerified });
    expect(digestSpy).toHaveBeenCalledTimes(1);
    expect(onVerified).toHaveBeenCalledWith({ url: URL_, sha256: GOOD_SHA256 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('re-hashes a cached blob whose size differs from the marker and rewrites the marker when the bytes are right', async () => {
    const { env, fetchMock } = makeEnv();
    await env.cache.put(URL_, new Blob([bytes(1, 2, 3, 4)]));
    await env.cache.put(verificationMarkerKey(URL_, GOOD_SHA256), new Blob([verificationMarkerValue(GOOD_SHA256, 9)]));
    const digestSpy = vi.spyOn(crypto.subtle, 'digest');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const blob = await fetchModelBlob(env, URL_, undefined, { sha256: GOOD_SHA256 });

    expect(await blobBytes(blob)).toEqual(bytes(1, 2, 3, 4));
    expect(digestSpy).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await (await env.cache.match(verificationMarkerKey(URL_, GOOD_SHA256)))!.text()).toBe(`${GOOD_SHA256}:4`);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('differs from its verification marker'));
  });

  it('evicts and re-downloads a cached blob whose size differs from the marker and whose bytes are wrong', async () => {
    const { env, fetchMock } = makeEnv();
    // Same-origin overwrite: the marker still vouches for 4 bytes, the entry now holds 3.
    await env.cache.put(URL_, new Blob([bytes(9, 9, 9)]));
    await env.cache.put(verificationMarkerKey(URL_, GOOD_SHA256), new Blob([verificationMarkerValue(GOOD_SHA256, 4)]));
    fetchMock.mockResolvedValueOnce(streamResponse([bytes(1, 2, 3, 4)], { total: 4 }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const blob = await fetchModelBlob(env, URL_, undefined, { sha256: GOOD_SHA256 });

    expect(await blobBytes(blob)).toEqual(bytes(1, 2, 3, 4));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await blobBytes((await env.cache.match(URL_))!)).toEqual(bytes(1, 2, 3, 4));
    expect(await (await env.cache.match(verificationMarkerKey(URL_, GOOD_SHA256)))!.text()).toBe(`${GOOD_SHA256}:4`);
  });

  it('trusts a marker whose size matches without re-hashing', async () => {
    const { env, fetchMock } = makeEnv();
    await env.cache.put(URL_, new Blob([bytes(1, 2, 3, 4)]));
    await env.cache.put(verificationMarkerKey(URL_, GOOD_SHA256), new Blob([verificationMarkerValue(GOOD_SHA256, 4)]));
    const digestSpy = vi.spyOn(crypto.subtle, 'digest');

    await fetchModelBlob(env, URL_, undefined, { sha256: GOOD_SHA256 });

    expect(digestSpy).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── Pinned size option ─────────────────────────────────────

describe('fetchModelBlob pinned size', () => {
  it('uses the pinned size as the progress total when the server sends no content-length', async () => {
    const { env, fetchMock } = makeEnv();
    fetchMock.mockResolvedValueOnce(streamResponse([bytes(1, 2), bytes(3, 4)]));

    const progress: Array<[number, number]> = [];
    await fetchModelBlob(env, URL_, (d, t) => progress.push([d, t]), { sha256: GOOD_SHA256, size: 4 });

    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every(([, total]) => total === 4)).toBe(true);
    expect(progress[progress.length - 1]).toEqual([4, 4]);
  });

  it('rejects a download whose size differs from the pin with ModelIntegrityError', async () => {
    const { env, fetchMock } = makeEnv();
    fetchMock.mockResolvedValueOnce(streamResponse([bytes(1, 2, 3, 4)], { total: 4 }));

    await expect(
      fetchModelBlob(env, URL_, undefined, { sha256: GOOD_SHA256, size: 5 }),
    ).rejects.toBeInstanceOf(ModelIntegrityError);
    expect(await env.cache.match(URL_)).toBeUndefined();
  });
});

// ── Pinned tokenizer files (T185, S1/S3) ───────────────────

const TOKENIZER_JSON_TEXT = '{"model":{"type":"WordPiece"}}';
const TOKENIZER_CONFIG_TEXT = '{"tokenizer_class":"PreTrainedTokenizerFast"}';

async function sha256Of(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function tokenizerFiles(): Promise<TokenizerFiles> {
  return [
    {
      url: 'https://example.com/resolve/abc/tokenizer.json',
      sha256: await sha256Of(TOKENIZER_JSON_TEXT),
      size: new TextEncoder().encode(TOKENIZER_JSON_TEXT).length,
    },
    {
      url: 'https://example.com/resolve/abc/tokenizer_config.json',
      sha256: await sha256Of(TOKENIZER_CONFIG_TEXT),
      size: new TextEncoder().encode(TOKENIZER_CONFIG_TEXT).length,
    },
  ];
}

function textResponse(text: string): Response {
  return streamResponse([new TextEncoder().encode(text)]);
}

function makeCoreEnv(loader: ModelLoaderEnv, overrides: Partial<CoreEnv> = {}): CoreEnv {
  return {
    kv: memoryKV(),
    modelCache: loader.cache,
    fetch: loader.fetch,
    wasm: { paths: '/' },
    ...overrides,
  };
}

describe('fetchPinnedJson', () => {
  it('downloads, verifies, caches and parses a pinned JSON file', async () => {
    const { env, fetchMock } = makeEnv();
    const [jsonFile] = await tokenizerFiles();
    fetchMock.mockResolvedValueOnce(textResponse(TOKENIZER_JSON_TEXT));

    const parsed = await fetchPinnedJson(env, jsonFile);

    expect(parsed).toEqual({ model: { type: 'WordPiece' } });
    expect(await env.cache.match(jsonFile.url)).toBeDefined();
    expect(await (await env.cache.match(verificationMarkerKey(jsonFile.url, jsonFile.sha256)))!.text())
      .toBe(`${jsonFile.sha256}:${jsonFile.size}`);
  });

  it('rejects a file with one flipped byte with ModelIntegrityError and evicts it', async () => {
    const { env, fetchMock } = makeEnv();
    const [jsonFile] = await tokenizerFiles();
    const flipped = new TextEncoder().encode(TOKENIZER_JSON_TEXT);
    flipped[10] ^= 0x01;
    fetchMock.mockResolvedValueOnce(streamResponse([flipped]));

    let caught: unknown;
    try {
      await fetchPinnedJson(env, jsonFile);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ModelIntegrityError);
    expect((caught as ModelIntegrityError).url).toBe(jsonFile.url);
    expect(await env.cache.match(jsonFile.url)).toBeUndefined();
    expect(await env.cache.match(verificationMarkerKey(jsonFile.url, jsonFile.sha256))).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports a verified file that is not JSON as a pin error (no eviction)', async () => {
    const { env, fetchMock } = makeEnv();
    const text = 'not json';
    const file = { url: 'https://example.com/resolve/abc/broken.json', sha256: await sha256Of(text), size: text.length };
    fetchMock.mockResolvedValueOnce(textResponse(text));

    await expect(fetchPinnedJson(env, file)).rejects.toThrow('not valid JSON');
    expect(await env.cache.match(file.url)).toBeDefined();
  });
});

describe('loadPinnedTokenizer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches both pinned files and hands the parsed objects to buildTokenizer', async () => {
    const { env, fetchMock } = makeEnv();
    const files = await tokenizerFiles();
    fetchMock.mockImplementation(async (url: string) =>
      url === files[0].url ? textResponse(TOKENIZER_JSON_TEXT) : textResponse(TOKENIZER_CONFIG_TEXT));
    const built = { encode: () => [1] };
    const buildTokenizer = vi.fn(async (_json: unknown, _config: unknown) => built);

    const tokenizer = await loadPinnedTokenizer(makeCoreEnv(env, { buildTokenizer }), files, 'org/model');

    expect(tokenizer).toBe(built);
    expect(buildTokenizer).toHaveBeenCalledWith(
      { model: { type: 'WordPiece' } },
      { tokenizer_class: 'PreTrainedTokenizerFast' },
    );
    expect(new Set(fetchMock.mock.calls.map((c) => c[0]))).toEqual(new Set([files[0].url, files[1].url]));
  });

  it('serves a warm cache without any fetch', async () => {
    const { env, fetchMock } = makeEnv();
    const files = await tokenizerFiles();
    for (const [file, text] of [[files[0], TOKENIZER_JSON_TEXT], [files[1], TOKENIZER_CONFIG_TEXT]] as const) {
      const blob = new Blob([text]);
      await env.cache.put(file.url, blob);
      await env.cache.put(verificationMarkerKey(file.url, file.sha256), new Blob([verificationMarkerValue(file.sha256, blob.size)]));
    }
    const buildTokenizer = vi.fn(() => ({}));

    await loadPinnedTokenizer(makeCoreEnv(env, { buildTokenizer }), files, 'org/model');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(buildTokenizer).toHaveBeenCalledTimes(1);
  });

  it('propagates a tampered tokenizer_config.json as ModelIntegrityError without building', async () => {
    const { env, fetchMock } = makeEnv();
    const files = await tokenizerFiles();
    const flipped = new TextEncoder().encode(TOKENIZER_CONFIG_TEXT);
    flipped[3] ^= 0x20;
    fetchMock.mockImplementation(async (url: string) =>
      url === files[0].url ? textResponse(TOKENIZER_JSON_TEXT) : streamResponse([flipped]));
    const buildTokenizer = vi.fn(() => ({}));

    await expect(loadPinnedTokenizer(makeCoreEnv(env, { buildTokenizer }), files, 'org/model'))
      .rejects.toBeInstanceOf(ModelIntegrityError);
    expect(buildTokenizer).not.toHaveBeenCalled();
    expect(await env.cache.match(files[1].url)).toBeUndefined();
  });

  it('rejects a buildTokenizer that returns nothing', async () => {
    const { env, fetchMock } = makeEnv();
    const files = await tokenizerFiles();
    fetchMock.mockImplementation(async (url: string) =>
      url === files[0].url ? textResponse(TOKENIZER_JSON_TEXT) : textResponse(TOKENIZER_CONFIG_TEXT));

    await expect(loadPinnedTokenizer(makeCoreEnv(env, { buildTokenizer: () => undefined }), files, 'org/model'))
      .rejects.toThrow('returned no tokenizer');
  });

  it('falls back to the deprecated loadTokenizer with a one-time warning and no pinned fetch', async () => {
    const { env, fetchMock } = makeEnv();
    const files = await tokenizerFiles();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const legacy = { encode: () => [2] };
    const loadTokenizer = vi.fn(async (_id: string) => legacy);

    const tokenizer = await loadPinnedTokenizer(makeCoreEnv(env, { loadTokenizer }), files, 'org/model');

    expect(tokenizer).toBe(legacy);
    expect(loadTokenizer).toHaveBeenCalledWith('org/model');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn.mock.calls.some(([msg]) => String(msg).includes('loadTokenizer is deprecated'))).toBe(true);
  });

  it('keeps the host receiver on the deprecated path and retries it', async () => {
    const { env } = makeEnv();
    const files = await tokenizerFiles();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let attempts = 0;
    const host = {
      ...makeCoreEnv(env),
      marker: 'host',
      async loadTokenizer(this: { marker: string }, _id: string) {
        attempts++;
        if (attempts === 1) throw new TypeError('flaky');
        return { from: this.marker };
      },
    };

    const tokenizer = await loadPinnedTokenizer(host, files, 'org/model', { retryBaseDelayMs: 1 });

    expect(tokenizer).toEqual({ from: 'host' });
    expect(attempts).toBe(2);
  });

  it('throws when the env implements neither buildTokenizer nor loadTokenizer', async () => {
    const { env } = makeEnv();
    const files = await tokenizerFiles();

    await expect(loadPinnedTokenizer(makeCoreEnv(env), files, 'org/model'))
      .rejects.toThrow('CoreEnv must implement buildTokenizer');
  });
});

describe('evictModelFromCache', () => {
  it('removes the model entry and its verification marker', async () => {
    const { env } = makeEnv();
    await env.cache.put(URL_, new Blob([bytes(1, 2, 3, 4)]));
    await env.cache.put(verificationMarkerKey(URL_, GOOD_SHA256), new Blob([verificationMarkerValue(GOOD_SHA256, 4)]));

    await evictModelFromCache(env, URL_, GOOD_SHA256);

    expect(await env.cache.match(URL_)).toBeUndefined();
    expect(await env.cache.match(verificationMarkerKey(URL_, GOOD_SHA256))).toBeUndefined();
  });
});
