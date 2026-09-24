/**
 * BardS.ai provider env-plumbing tests (T185).
 *
 * Inference needs the real model (covered by the manual real-model gate);
 * here we pin the supply chain: model URL at an immutable commit, the two
 * tokenizer files pinned with sha256 + size and built through
 * env.buildTokenizer, exact egress on cold start and none on warm start.
 * onnxruntime-web is mocked; no network, no wasm.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ortMock = vi.hoisted(() => {
  return {
    env: { wasm: {} as { wasmPaths?: string; numThreads?: number } },
    InferenceSession: {
      create: vi.fn(async () => ({
        inputNames: ['input_ids', 'attention_mask'],
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
  BardsaiProvider,
  BARDSAI_MODEL_URL,
  BARDSAI_MODEL_REVISION,
  BARDSAI_MODEL_SHA256,
  BARDSAI_TOKENIZER_FILES,
} from '../src/providers/bardsai.ts';
import { verificationMarkerKey, verificationMarkerValue } from '../src/model-loader.ts';
import { memoryKV, memoryBlobCache } from '../src/env.ts';
import type { BlobCache, CoreEnv } from '../src/env.ts';

const MODEL_URL = BARDSAI_MODEL_URL;
const [TOKENIZER_JSON, TOKENIZER_CONFIG] = BARDSAI_TOKENIZER_FILES;
const FAKE_TOKENIZER_JSON = { model: { type: 'Unigram' } };
const FAKE_TOKENIZER_CONFIG = { tokenizer_class: 'XLMRobertaTokenizer' };

async function seedVerified(cache: BlobCache, url: string, sha256: string, blob: Blob): Promise<void> {
  await cache.put(url, blob);
  await cache.put(verificationMarkerKey(url, sha256), new Blob([verificationMarkerValue(sha256, blob.size)]));
}

async function seedWarmCache(cache: BlobCache): Promise<void> {
  await seedVerified(cache, MODEL_URL, BARDSAI_MODEL_SHA256, new Blob([new Uint8Array([1, 2, 3])]));
  await seedVerified(cache, TOKENIZER_JSON.url, TOKENIZER_JSON.sha256, new Blob([JSON.stringify(FAKE_TOKENIZER_JSON)]));
  await seedVerified(cache, TOKENIZER_CONFIG.url, TOKENIZER_CONFIG.sha256, new Blob([JSON.stringify(FAKE_TOKENIZER_CONFIG)]));
}

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
    buildTokenizer: vi.fn((_json: unknown, _config: unknown) => ({ tokenize: (_: string) => [] })),
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

describe('BardsaiProvider supply-chain pins', () => {
  it('pins the model URL to an immutable revision (no resolve/main)', () => {
    expect(MODEL_URL).toContain(`/resolve/${BARDSAI_MODEL_REVISION}/`);
    expect(MODEL_URL).not.toContain('resolve/main');
    expect(BARDSAI_MODEL_REVISION).toBe('0e72e19f030ed4e661b1673e549af8e0dd176386');
    expect(BARDSAI_MODEL_SHA256).toBe('8c9f555c743ed14eb7e505ff9d9c7785775a1671fd14031af33f424de8bd0e7b');
  });

  it('pins both tokenizer files to the model commit with a sha256 and size (provenance 2026-09-24)', () => {
    expect(TOKENIZER_JSON.url).toBe(`https://huggingface.co/bardsai/eu-pii-anonimization-multilang/resolve/${BARDSAI_MODEL_REVISION}/tokenizer.json`);
    expect(TOKENIZER_JSON.sha256).toBe('2464f9721707cb3d5edcf9a3d73454b13e8a7b3bb8fdba94b3de3d843f30e946');
    expect(TOKENIZER_JSON.size).toBe(16_781_584);
    expect(TOKENIZER_CONFIG.url).toBe(`https://huggingface.co/bardsai/eu-pii-anonimization-multilang/resolve/${BARDSAI_MODEL_REVISION}/tokenizer_config.json`);
    expect(TOKENIZER_CONFIG.sha256).toBe('c019e3e4f7f901adf680dde303c7d964de86675a13e089bcc0f614d3fce75333');
    expect(TOKENIZER_CONFIG.size).toBe(314);
  });
});

describe('BardsaiProvider load() via CoreEnv (T185)', () => {
  it('cold start requests exactly the three pinned URLs', async () => {
    const { fetch, urls } = recordingFetch(() => new Response(null, { status: 404 }));

    await expect(new BardsaiProvider(makeEnv({ fetch })).load()).rejects.toThrow('404');
    await new Promise((r) => setTimeout(r, 0));

    expect(new Set(urls)).toEqual(new Set([MODEL_URL, TOKENIZER_JSON.url, TOKENIZER_CONFIG.url]));
    expect(urls).toHaveLength(3);
  });

  it('warm start requests nothing and builds the tokenizer from the cached, parsed files', async () => {
    const modelCache = memoryBlobCache();
    await seedWarmCache(modelCache);
    const { fetch, urls } = recordingFetch(() => new Response(null, { status: 404 }));
    const env = makeEnv({ modelCache, fetch });
    const provider = new BardsaiProvider(env);

    await provider.load();

    expect(provider.isLoaded()).toBe(true);
    expect(urls).toEqual([]);
    expect(env.buildTokenizer).toHaveBeenCalledWith(FAKE_TOKENIZER_JSON, FAKE_TOKENIZER_CONFIG);
    expect(provider.getVerification()).toEqual({ url: MODEL_URL, sha256: BARDSAI_MODEL_SHA256 });
  });

  it('falls back to the deprecated loadTokenizer(hfModelId) when buildTokenizer is absent', async () => {
    const modelCache = memoryBlobCache();
    await seedWarmCache(modelCache);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loadTokenizer = vi.fn(async () => ({ tokenize: (_: string) => [] }));
    const provider = new BardsaiProvider(makeEnv({ modelCache, buildTokenizer: undefined, loadTokenizer }));

    await provider.load();

    expect(provider.isLoaded()).toBe(true);
    expect(loadTokenizer).toHaveBeenCalledWith('bardsai/eu-pii-anonimization-multilang');
    warn.mockRestore();
  });
});
