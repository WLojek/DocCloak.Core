import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  fetchModelBlob,
  evictModelFromCache,
  verificationMarkerKey,
  ModelIntegrityError,
  type ModelLoaderEnv,
  type ModelVerification,
} from '../src/model-loader.ts';
import { memoryBlobCache } from '../src/env.ts';

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

  it('accepts a matching download, reports verification and writes a marker', async () => {
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
    expect(await env.cache.match(verificationMarkerKey(URL_, GOOD_SHA256))).toBeDefined();
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

describe('evictModelFromCache', () => {
  it('removes the model entry and its verification marker', async () => {
    const { env } = makeEnv();
    await env.cache.put(URL_, new Blob([bytes(1, 2, 3, 4)]));
    await env.cache.put(verificationMarkerKey(URL_, GOOD_SHA256), new Blob(['1']));

    await evictModelFromCache(env, URL_, GOOD_SHA256);

    expect(await env.cache.match(URL_)).toBeUndefined();
    expect(await env.cache.match(verificationMarkerKey(URL_, GOOD_SHA256))).toBeUndefined();
  });
});
