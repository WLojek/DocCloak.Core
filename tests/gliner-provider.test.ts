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

vi.mock('onnxruntime-web', () => ortMock);

import { GlinerProvider } from '../src/providers/gliner.ts';
import { memoryKV, memoryBlobCache } from '../src/env.ts';
import type { CoreEnv } from '../src/env.ts';

const MODEL_URL = 'https://huggingface.co/knowledgator/gliner-pii-edge-v1.0/resolve/main/onnx/model_quint8.onnx';
const LEGACY_KEY = 'doccloak-custom-labels';

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
    await modelCache.put(MODEL_URL, new Blob([new Uint8Array([1, 2, 3])]));
    const env = makeEnv({ modelCache, wasm: { paths: '/app/', numThreads: 3 } });
    const provider = new GlinerProvider(env);

    await provider.load();

    expect(provider.isLoaded()).toBe(true);
    expect(env.fetch).not.toHaveBeenCalled();
    expect(env.loadTokenizer).toHaveBeenCalledWith('knowledgator/gliner-pii-edge-v1.0');
    expect(ortMock.env.wasm.wasmPaths).toBe('/app/');
    expect(ortMock.env.wasm.numThreads).toBe(3);
    expect(ortMock.InferenceSession.create).toHaveBeenCalledWith('blob:test', {
      executionProviders: ['wasm'],
    });
  });

  it('defaults to single-threaded wasm when env gives no numThreads', async () => {
    const modelCache = memoryBlobCache();
    await modelCache.put(MODEL_URL, new Blob([new Uint8Array([1])]));
    const provider = new GlinerProvider(makeEnv({ modelCache }));

    await provider.load();

    expect(ortMock.env.wasm.numThreads).toBe(1);
  });
});
