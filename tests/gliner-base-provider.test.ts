/**
 * GLiNER PII Base provider tests (T122).
 *
 * The interesting part of this provider is the markerV0 span decode: span
 * enumeration order (start-major, width-minor, matching the python GLiNER
 * SpanProcessor), the span_mask semantics and the logits -> character-span
 * decode. Those are pure functions tested with synthetic fixtures here.
 * Env plumbing (pinned model URL, pinned tokenizer files via
 * env.buildTokenizer, wasm config) mirrors the gliner/bardsai tests.
 * onnxruntime-web is mocked; no network, no wasm.
 * Real-model inference is covered by the Node WASM verification gate.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ortMock = vi.hoisted(() => {
  return {
    env: { wasm: {} as { wasmPaths?: string; numThreads?: number } },
    InferenceSession: {
      create: vi.fn(async () => ({
        inputNames: ['input_ids', 'attention_mask', 'words_mask', 'text_lengths', 'span_idx', 'span_mask'],
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
  GlinerBaseProvider,
  GLINER_BASE_MODEL_URL,
  GLINER_BASE_MODEL_REVISION,
  GLINER_BASE_MODEL_SHA256,
  GLINER_BASE_TOKENIZER_FILES,
  GLINER_BASE_MAX_WIDTH,
  buildSpanIndices,
  decodeSpanLogits,
} from '../src/providers/gliner-base.ts';
import { splitWords, greedySelect } from '../src/providers/gliner.ts';
import { verificationMarkerKey, verificationMarkerValue } from '../src/model-loader.ts';
import { memoryKV, memoryBlobCache } from '../src/env.ts';
import type { BlobCache, CoreEnv } from '../src/env.ts';

const MODEL_URL = GLINER_BASE_MODEL_URL;
const [TOKENIZER_JSON, TOKENIZER_CONFIG] = GLINER_BASE_TOKENIZER_FILES;
const FAKE_TOKENIZER_JSON = { model: { type: 'Unigram' } };
const FAKE_TOKENIZER_CONFIG = { tokenizer_class: 'DebertaV2Tokenizer' };

async function seedVerified(cache: BlobCache, url: string, sha256: string, blob: Blob): Promise<void> {
  await cache.put(url, blob);
  await cache.put(verificationMarkerKey(url, sha256), new Blob([verificationMarkerValue(sha256, blob.size)]));
}

async function seedVerifiedModel(cache: BlobCache, blob: Blob): Promise<void> {
  await seedVerified(cache, MODEL_URL, GLINER_BASE_MODEL_SHA256, blob);
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
    buildTokenizer: vi.fn((_json: unknown, _config: unknown) => ({ encode: (_: string) => [1, 5, 2] })),
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

// ── Span enumeration (markerV0) ───────────────────────────

describe('buildSpanIndices', () => {
  it('enumerates start-major, width-minor like the python GLiNER SpanProcessor', () => {
    const { spanIdx, spanMask, numSpans } = buildSpanIndices(3, 4);
    expect(numSpans).toBe(12);
    const pairs: Array<[number, number]> = [];
    for (let i = 0; i < numSpans; i++) {
      pairs.push([Number(spanIdx[i * 2]), Number(spanIdx[i * 2 + 1])]);
    }
    // start 0: widths 0..3 -> (0,0)(0,1)(0,2); (0,3) runs past the end and is zeroed
    // start 1: (1,1)(1,2); start 2: (2,2)
    expect(pairs).toEqual([
      [0, 0], [0, 1], [0, 2], [0, 0],
      [1, 1], [1, 2], [0, 0], [0, 0],
      [2, 2], [0, 0], [0, 0], [0, 0],
    ]);
    expect(Array.from(spanMask)).toEqual([
      1, 1, 1, 0,
      1, 1, 0, 0,
      1, 0, 0, 0,
    ]);
  });

  it('uses the model max_width of 12 by default', () => {
    const { numSpans } = buildSpanIndices(5);
    expect(GLINER_BASE_MAX_WIDTH).toBe(12);
    expect(numSpans).toBe(5 * 12);
  });

  it('handles a single-word text', () => {
    const { spanIdx, spanMask, numSpans } = buildSpanIndices(1, 3);
    expect(numSpans).toBe(3);
    expect(Array.from(spanMask)).toEqual([1, 0, 0]);
    expect(Number(spanIdx[0])).toBe(0);
    expect(Number(spanIdx[1])).toBe(0);
  });
});

// ── Decode ─────────────────────────────────────────────────

describe('decodeSpanLogits', () => {
  const text = 'John Smith met Anna';
  // words: John(0-4) Smith(5-10) met(11-14) Anna(15-19)
  const { words, starts, ends } = splitWords(text);
  const labels = ['person name', 'email address'];
  const maxWidth = 3;

  /** logits [1, numWords, maxWidth, numClasses], all strongly negative. */
  function emptyLogits(): Float32Array {
    return new Float32Array(words.length * maxWidth * labels.length).fill(-10);
  }

  function setLogit(logits: Float32Array, start: number, width: number, cls: number, value: number): void {
    logits[(start * maxWidth + width) * labels.length + cls] = value;
  }

  it('maps a thresholded span cell back to exact character offsets', () => {
    const logits = emptyLogits();
    // span (start word 0, width 1) = "John Smith", class 0 = person name
    setLogit(logits, 0, 1, 0, 5); // sigmoid(5) ~ 0.993
    const spans = decodeSpanLogits(
      logits, [1, words.length, maxWidth, labels.length], words.length,
      labels, 0.35, starts, ends, text,
    );
    expect(spans).toHaveLength(1);
    const [value, start, end, label, score] = spans[0];
    expect(value).toBe('John Smith');
    expect(text.slice(start, end)).toBe('John Smith');
    expect(label).toBe('person name');
    expect(score).toBeGreaterThan(0.99);
  });

  it('ignores cells below the threshold and spans past the text end', () => {
    const logits = emptyLogits();
    setLogit(logits, 1, 0, 0, -1);  // sigmoid(-1) ~ 0.27 < 0.35
    setLogit(logits, 3, 2, 0, 10);  // span (3, 5) runs past the last word (index 3)
    const spans = decodeSpanLogits(
      logits, [1, words.length, maxWidth, labels.length], words.length,
      labels, 0.35, starts, ends, text,
    );
    expect(spans).toEqual([]);
  });

  it('decodes multiple classes and works with greedySelect for overlaps', () => {
    const logits = emptyLogits();
    setLogit(logits, 0, 1, 0, 3);   // "John Smith" person, sigmoid(3) ~ 0.95
    setLogit(logits, 0, 0, 0, 1);   // "John" person, sigmoid(1) ~ 0.73 (overlaps, weaker)
    setLogit(logits, 3, 0, 0, 4);   // "Anna" person
    const spans = decodeSpanLogits(
      logits, [1, words.length, maxWidth, labels.length], words.length,
      labels, 0.35, starts, ends, text,
    );
    expect(spans).toHaveLength(3);
    const selected = greedySelect(spans);
    expect(selected.map((s) => s[0])).toEqual(['John Smith', 'Anna']);
  });
});

// ── Env plumbing / pinning ─────────────────────────────────

describe('GlinerBaseProvider load() via CoreEnv', () => {
  it('serves the model from the injected blob cache and builds the base tokenizer from the pinned files', async () => {
    const modelCache = memoryBlobCache();
    await seedVerifiedModel(modelCache, new Blob([new Uint8Array([1, 2, 3])]));
    const env = makeEnv({ modelCache, wasm: { paths: '/app/', numThreads: 2 } });
    const provider = new GlinerBaseProvider(env);

    await provider.load();

    expect(provider.isLoaded()).toBe(true);
    expect(env.fetch).not.toHaveBeenCalled();
    expect(env.buildTokenizer).toHaveBeenCalledWith(FAKE_TOKENIZER_JSON, FAKE_TOKENIZER_CONFIG);
    expect(ortMock.env.wasm.wasmPaths).toBe('/app/');
    expect(ortMock.env.wasm.numThreads).toBe(2);
    expect(ortMock.InferenceSession.create).toHaveBeenCalledWith('blob:test', {
      executionProviders: ['wasm'],
    });
  });

  it('reports the pinned-hash verification after a cache-served load (T116)', async () => {
    const modelCache = memoryBlobCache();
    await seedVerifiedModel(modelCache, new Blob([new Uint8Array([1, 2, 3])]));
    const provider = new GlinerBaseProvider(makeEnv({ modelCache }));

    expect(provider.getVerification()).toBeNull();
    await provider.load();

    expect(provider.getVerification()).toEqual({
      url: MODEL_URL,
      sha256: GLINER_BASE_MODEL_SHA256,
    });
  });

  it('pins the model URL to an immutable revision (no resolve/main)', () => {
    expect(MODEL_URL).toContain(`/resolve/${GLINER_BASE_MODEL_REVISION}/`);
    expect(MODEL_URL).not.toContain('resolve/main');
    expect(GLINER_BASE_MODEL_REVISION).toBe('61726e0ad791dcab3e29339bbec3ad42ded65641');
    expect(GLINER_BASE_MODEL_SHA256).toBe('0514c8fd86d0513ce5351a3267f132b57d5bcd8f99a90d43cde1228092881d19');
  });

  it('pins both tokenizer files to the model commit with a sha256 and size (provenance 2026-09-24)', () => {
    expect(TOKENIZER_JSON.url).toBe(`https://huggingface.co/knowledgator/gliner-pii-base-v1.0/resolve/${GLINER_BASE_MODEL_REVISION}/tokenizer.json`);
    expect(TOKENIZER_JSON.sha256).toBe('ee028763434d18611c1c36356ea1d050e90a9fa94ede57fac48b39f85f818ad1');
    expect(TOKENIZER_JSON.size).toBe(8_649_232);
    expect(TOKENIZER_CONFIG.url).toBe(`https://huggingface.co/knowledgator/gliner-pii-base-v1.0/resolve/${GLINER_BASE_MODEL_REVISION}/tokenizer_config.json`);
    expect(TOKENIZER_CONFIG.sha256).toBe('3ec8a90d8758fbc56d50831990c3a3a65660f020c5b06534adf43b04091ffa9e');
    expect(TOKENIZER_CONFIG.size).toBe(1_691);
  });

  it('cold start requests exactly the three pinned URLs; warm start requests none (T185)', async () => {
    const cold = recordingFetch(() => new Response(null, { status: 404 }));
    await expect(new GlinerBaseProvider(makeEnv({ fetch: cold.fetch })).load()).rejects.toThrow('404');
    await new Promise((r) => setTimeout(r, 0));
    expect(new Set(cold.urls)).toEqual(new Set([MODEL_URL, TOKENIZER_JSON.url, TOKENIZER_CONFIG.url]));
    expect(cold.urls).toHaveLength(3);

    const modelCache = memoryBlobCache();
    await seedVerifiedModel(modelCache, new Blob([new Uint8Array([1, 2, 3])]));
    const warm = recordingFetch(() => new Response(null, { status: 404 }));
    await new GlinerBaseProvider(makeEnv({ modelCache, fetch: warm.fetch })).load();
    expect(warm.urls).toEqual([]);
  });

  it('does not evict the bardsai blob (legacy provider stays cached, T122)', async () => {
    const modelCache = memoryBlobCache();
    const deleteSpy = vi.fn(modelCache.delete);
    modelCache.delete = deleteSpy;
    await seedVerifiedModel(modelCache, new Blob([new Uint8Array([1])]));
    const provider = new GlinerBaseProvider(makeEnv({ modelCache }));

    await provider.load();

    expect(deleteSpy).not.toHaveBeenCalled();
  });
});

describe('GlinerBaseProvider custom labels via env.kv', () => {
  it('persists custom labels under the legacy localStorage key', async () => {
    const env = makeEnv();
    const provider = new GlinerBaseProvider(env);

    await provider.setCustomLabels(['project codename', ' ', 'internal id']);

    expect(provider.getCustomLabels()).toEqual(['project codename', 'internal id']);
    expect(await env.kv.get('doccloak-custom-labels')).toBe(JSON.stringify(['project codename', 'internal id']));
  });

  it('restores custom labels stored under the legacy key', async () => {
    const env = makeEnv();
    await env.kv.set('doccloak-custom-labels', JSON.stringify(['badge id']));
    const provider = new GlinerBaseProvider(env);

    await provider.restoreCustomLabels();

    expect(provider.getCustomLabels()).toEqual(['badge id']);
  });
});
