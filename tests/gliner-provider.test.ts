/**
 * GLiNER provider env-plumbing tests (T007).
 *
 * Inference itself needs the real ONNX model and is covered by the web app's
 * manual real-model gate. Here we verify the CoreEnv seams: custom-label
 * persistence through env.kv (legacy key preserved), wasm config from
 * env.wasm, model bytes from the injected blob cache and the tokenizer from
 * env.loadTokenizer. onnxruntime-web is mocked; no network, no wasm.
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

import { GlinerProvider, GLINER_MODEL_URL, GLINER_MODEL_REVISION, GLINER_MODEL_SHA256 } from '../src/providers/gliner.ts';
import { verificationMarkerKey } from '../src/model-loader.ts';
import { memoryKV, memoryBlobCache } from '../src/env.ts';
import type { BlobCache, CoreEnv } from '../src/env.ts';

// T116: the provider must fetch from the pinned immutable revision
const MODEL_URL = GLINER_MODEL_URL;
const LEGACY_KEY = 'doccloak-custom-labels';

/**
 * Seed the cache like a previously verified download (T116): blob plus the
 * verification marker for the pinned hash. Without the marker the loader
 * would hash the fake bytes, detect the mismatch and hit the network.
 */
async function seedVerifiedModel(cache: BlobCache, blob: Blob): Promise<void> {
  await cache.put(MODEL_URL, blob);
  await cache.put(verificationMarkerKey(MODEL_URL, GLINER_MODEL_SHA256), new Blob(['1']));
}

function makeEnv(overrides: Partial<CoreEnv> = {}): CoreEnv {
  return {
    kv: memoryKV(),
    modelCache: memoryBlobCache(),
    fetch: vi.fn(async () => { throw new TypeError('network disabled in tests'); }) as unknown as typeof fetch,
    wasm: { paths: '/base/' },
    loadTokenizer: vi.fn(async () => ({ encode: (_: string) => [0, 1, 2] })),
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
    const env = makeEnv({ modelCache, wasm: { paths: '/app/', numThreads: 3 } });
    const provider = new GlinerProvider(env);

    await provider.load();

    expect(provider.isLoaded()).toBe(true);
    expect(env.fetch).not.toHaveBeenCalled();
    expect(env.loadTokenizer).toHaveBeenCalledWith('knowledgator/gliner-pii-small-v1.0');
    expect(ortMock.env.wasm.wasmPaths).toBe('/app/');
    expect(ortMock.env.wasm.numThreads).toBe(3);
    expect(ortMock.InferenceSession.create).toHaveBeenCalledWith('blob:test', {
      executionProviders: ['wasm'],
    });
  });

  it('reports the pinned-hash verification after a cache-served load (T116)', async () => {
    const modelCache = memoryBlobCache();
    await seedVerifiedModel(modelCache, new Blob([new Uint8Array([1, 2, 3])]));
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
    const provider = new GlinerProvider(makeEnv({ modelCache }));

    await provider.load();

    expect(ortMock.env.wasm.numThreads).toBe(1);
  });
});
