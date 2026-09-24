/**
 * GLiNER provider env-plumbing tests (T007, T185).
 *
 * Inference itself needs the real ONNX model and is covered by the web app's
 * manual real-model gate. Here we verify the CoreEnv seams: custom-label
 * persistence through env.kv (legacy key preserved), wasm config from
 * env.wasm, model bytes from the injected blob cache and the tokenizer built
 * by env.buildTokenizer from the two pinned, hashed tokenizer files (T185).
 * onnxruntime-web is mocked; no network, no wasm.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ortMock = vi.hoisted(() => {
  return {
    env: { wasm: {} as { wasmPaths?: string; numThreads?: number } },
    InferenceSession: {
      create: vi.fn(async () => ({
        inputNames: ['input_ids'],
        outputNames: ['logits'],
        run: vi.fn(),
        release: vi.fn(),
      })),
    },
    Tensor: class {},
  };
});

vi.mock('onnxruntime-web/webgpu', () => ortMock);

import {
  GlinerProvider,
  GLINER_MODEL_URL,
  GLINER_MODEL_REVISION,
  GLINER_MODEL_SHA256,
  GLINER_TOKENIZER_FILES,
} from '../src/providers/gliner.ts';
import { ModelIntegrityError, verificationMarkerKey, verificationMarkerValue } from '../src/model-loader.ts';
import { memoryKV, memoryBlobCache } from '../src/env.ts';
import type { BlobCache, CoreEnv } from '../src/env.ts';

// T116: the provider must fetch from the pinned immutable revision
const MODEL_URL = GLINER_MODEL_URL;
const LEGACY_KEY = 'doccloak-custom-labels';
const [TOKENIZER_JSON, TOKENIZER_CONFIG] = GLINER_TOKENIZER_FILES;

const FAKE_TOKENIZER_JSON = { model: { type: 'WordPiece', vocab: { hello: 1 } } };
const FAKE_TOKENIZER_CONFIG = { tokenizer_class: 'PreTrainedTokenizerFast', model_max_length: 512 };

/**
 * Seed the cache like a previously verified download (T116/T185): blob plus
 * the size-bound verification marker for the pinned hash. Without a marker
 * the loader would hash the fake bytes, detect the mismatch and hit the
 * network.
 */
async function seedVerified(cache: BlobCache, url: string, sha256: string, blob: Blob): Promise<void> {
  await cache.put(url, blob);
  await cache.put(verificationMarkerKey(url, sha256), new Blob([verificationMarkerValue(sha256, blob.size)]));
}

async function seedVerifiedModel(cache: BlobCache, blob: Blob): Promise<void> {
  await seedVerified(cache, MODEL_URL, GLINER_MODEL_SHA256, blob);
}

async function seedVerifiedTokenizer(cache: BlobCache): Promise<void> {
  await seedVerified(cache, TOKENIZER_JSON.url, TOKENIZER_JSON.sha256, new Blob([JSON.stringify(FAKE_TOKENIZER_JSON)]));
  await seedVerified(cache, TOKENIZER_CONFIG.url, TOKENIZER_CONFIG.sha256, new Blob([JSON.stringify(FAKE_TOKENIZER_CONFIG)]));
}

/** fetch stub that records every requested URL and answers with `respond`. */
function recordingFetch(respond: (url: string) => Response): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    return respond(url);
  });
  return { fetch: fetchFn as unknown as typeof fetch, urls };
}

function makeEnv(overrides: Partial<CoreEnv> = {}): CoreEnv {
  return {
    kv: memoryKV(),
    modelCache: memoryBlobCache(),
    fetch: vi.fn(async () => { throw new TypeError('network disabled in tests'); }) as unknown as typeof fetch,
    wasm: { paths: '/base/' },
    buildTokenizer: vi.fn((_json: unknown, _config: unknown) => ({ encode: (_: string) => [0, 1, 2] })),
    ...overrides,
  };
}

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:test');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  vi.clearAllMocks();
});

describe('GlinerProvider custom labels via env.kv', () => {
  it('persists custom labels under the legacy localStorage key', async () => {
    const env = makeEnv();
    const provider = new GlinerProvider(env);

    await provider.setCustomLabels(['project codename', ' ', 'internal id']);

    expect(provider.getCustomLabels()).toEqual(['project codename', 'internal id']);
    expect(await env.kv.get(LEGACY_KEY)).toBe(JSON.stringify(['project codename', 'internal id']));
  });

  it('updates the in-memory list synchronously for fire-and-forget callers', () => {
    const provider = new GlinerProvider(makeEnv());

    // The detection worker calls setCustomLabels without awaiting.
    void provider.setCustomLabels(['ticket number']);

    expect(provider.getCustomLabels()).toEqual(['ticket number']);
  });

  it('restores custom labels stored under the legacy key', async () => {
    const env = makeEnv();
    await env.kv.set(LEGACY_KEY, JSON.stringify(['badge id']));
    const provider = new GlinerProvider(env);

    await provider.restoreCustomLabels();

    expect(provider.getCustomLabels()).toEqual(['badge id']);
  });

  it('ignores KV backends that throw (storage-less worker)', async () => {
    const throwingKV = {
      get: async () => { throw new Error('no storage'); },
      set: async () => { throw new Error('no storage'); },
      remove: async () => { throw new Error('no storage'); },
    };
    const provider = new GlinerProvider(makeEnv({ kv: throwingKV }));

    await expect(provider.restoreCustomLabels()).resolves.toBeUndefined();
    await expect(provider.setCustomLabels(['x y'])).resolves.toBeUndefined();
    expect(provider.getCustomLabels()).toEqual(['x y']);
  });
});

describe('GlinerProvider load() via CoreEnv', () => {
  it('serves the model from the injected blob cache and configures wasm from env', async () => {
    const modelCache = memoryBlobCache();
    await seedVerifiedModel(modelCache, new Blob([new Uint8Array([1, 2, 3])]));
    await seedVerifiedTokenizer(modelCache);
    const env = makeEnv({ modelCache, wasm: { paths: '/app/', numThreads: 3 } });
    const provider = new GlinerProvider(env);

    await provider.load();

    expect(provider.isLoaded()).toBe(true);
    expect(env.fetch).not.toHaveBeenCalled();
    expect(env.buildTokenizer).toHaveBeenCalledWith(FAKE_TOKENIZER_JSON, FAKE_TOKENIZER_CONFIG);
    expect(ortMock.env.wasm.wasmPaths).toBe('/app/');
    expect(ortMock.env.wasm.numThreads).toBe(3);
    expect(ortMock.InferenceSession.create).toHaveBeenCalledWith('blob:test', {
      executionProviders: ['wasm'],
    });
  });

  it('reports the pinned-hash verification after a cache-served load (T116)', async () => {
    const modelCache = memoryBlobCache();
    await seedVerifiedModel(modelCache, new Blob([new Uint8Array([1, 2, 3])]));
    await seedVerifiedTokenizer(modelCache);
    const provider = new GlinerProvider(makeEnv({ modelCache }));

    expect(provider.getVerification()).toBeNull();
    await provider.load();

    expect(provider.getVerification()).toEqual({
      url: MODEL_URL,
      sha256: GLINER_MODEL_SHA256,
    });
  });

  it('pins the model URL to an immutable revision (no resolve/main)', () => {
    expect(MODEL_URL).toContain(`/resolve/${GLINER_MODEL_REVISION}/`);
    expect(MODEL_URL).not.toContain('resolve/main');
    expect(GLINER_MODEL_REVISION).toMatch(/^[0-9a-f]{40}$/);
    expect(GLINER_MODEL_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('defaults to single-threaded wasm when env gives no numThreads', async () => {
    const modelCache = memoryBlobCache();
    await seedVerifiedModel(modelCache, new Blob([new Uint8Array([1])]));
    await seedVerifiedTokenizer(modelCache);
    const provider = new GlinerProvider(makeEnv({ modelCache }));

    await provider.load();

    expect(ortMock.env.wasm.numThreads).toBe(1);
  });
});

// ── Pinned tokenizer files (T185, S1/S3) ───────────────────

describe('GlinerProvider tokenizer files (T185)', () => {
  it('pins both tokenizer files to the model commit with a sha256 and size (provenance 2026-09-24)', () => {
    expect(TOKENIZER_JSON.url).toBe(`https://huggingface.co/knowledgator/gliner-pii-small-v1.0/resolve/${GLINER_MODEL_REVISION}/tokenizer.json`);
    expect(TOKENIZER_JSON.sha256).toBe('84b3a9b18f04a0ccd03b72d9f871b7e0bec40fd7021ef50bc30a7c3693c11205');
    expect(TOKENIZER_JSON.size).toBe(3_583_593);
    expect(TOKENIZER_CONFIG.url).toBe(`https://huggingface.co/knowledgator/gliner-pii-small-v1.0/resolve/${GLINER_MODEL_REVISION}/tokenizer_config.json`);
    expect(TOKENIZER_CONFIG.sha256).toBe('3398f6d1ad4b4c4f9874d390d060a75c58cad5e5ce9b22841b3e40643b4ada27');
    expect(TOKENIZER_CONFIG.size).toBe(21_214);
    for (const file of GLINER_TOKENIZER_FILES) expect(file.url).not.toContain('resolve/main');
  });

  it('cold start requests exactly the three pinned URLs (model + tokenizer.json + tokenizer_config.json)', async () => {
    const { fetch, urls } = recordingFetch(() => new Response(null, { status: 404 }));
    const provider = new GlinerProvider(makeEnv({ fetch }));

    await expect(provider.load()).rejects.toThrow('404');
    await new Promise((r) => setTimeout(r, 0));

    expect(new Set(urls)).toEqual(new Set([MODEL_URL, TOKENIZER_JSON.url, TOKENIZER_CONFIG.url]));
    expect(urls).toHaveLength(3);
  });

  it('warm start requests nothing and builds the tokenizer from the cached, parsed files', async () => {
    const modelCache = memoryBlobCache();
    await seedVerifiedModel(modelCache, new Blob([new Uint8Array([1, 2, 3])]));
    await seedVerifiedTokenizer(modelCache);
    const { fetch, urls } = recordingFetch(() => new Response(null, { status: 404 }));
    const env = makeEnv({ modelCache, fetch });

    await new GlinerProvider(env).load();

    expect(urls).toEqual([]);
    expect(env.buildTokenizer).toHaveBeenCalledTimes(1);
    expect(env.buildTokenizer).toHaveBeenCalledWith(FAKE_TOKENIZER_JSON, FAKE_TOKENIZER_CONFIG);
  });

  it('rejects tampered tokenizer files with ModelIntegrityError and caches nothing for them', async () => {
    const modelCache = memoryBlobCache();
    await seedVerifiedModel(modelCache, new Blob([new Uint8Array([1, 2, 3])]));
    // Right sizes, wrong bytes: what a tampered mirror would serve.
    const { fetch, urls } = recordingFetch((url) => {
      const spec = GLINER_TOKENIZER_FILES.find((f) => f.url === url);
      return spec ? new Response(new Uint8Array(spec.size)) : new Response(null, { status: 404 });
    });
    const env = makeEnv({ modelCache, fetch });
    const provider = new GlinerProvider(env);

    await expect(provider.load()).rejects.toBeInstanceOf(ModelIntegrityError);
    await new Promise((r) => setTimeout(r, 0));

    expect(new Set(urls)).toEqual(new Set([TOKENIZER_JSON.url, TOKENIZER_CONFIG.url]));
    expect(env.buildTokenizer).not.toHaveBeenCalled();
    expect(provider.isLoaded()).toBe(false);
    for (const file of GLINER_TOKENIZER_FILES) {
      expect(await modelCache.match(file.url)).toBeUndefined();
      expect(await modelCache.match(verificationMarkerKey(file.url, file.sha256))).toBeUndefined();
    }
  });

  it('falls back to the deprecated loadTokenizer(hfModelId) when buildTokenizer is absent', async () => {
    const modelCache = memoryBlobCache();
    await seedVerifiedModel(modelCache, new Blob([new Uint8Array([1, 2, 3])]));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loadTokenizer = vi.fn(async () => ({ encode: (_: string) => [0, 1, 2] }));
    const env = makeEnv({ modelCache, buildTokenizer: undefined, loadTokenizer });
    const provider = new GlinerProvider(env);

    await provider.load();

    expect(provider.isLoaded()).toBe(true);
    expect(loadTokenizer).toHaveBeenCalledWith('knowledgator/gliner-pii-small-v1.0');
    expect(env.fetch).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('fails clearly when the env implements neither buildTokenizer nor loadTokenizer', async () => {
    const modelCache = memoryBlobCache();
    await seedVerifiedModel(modelCache, new Blob([new Uint8Array([1, 2, 3])]));
    const env = makeEnv({ modelCache, buildTokenizer: undefined });

    await expect(new GlinerProvider(env).load()).rejects.toThrow('CoreEnv must implement buildTokenizer');
  });
});
