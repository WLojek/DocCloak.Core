/**
 * Engine assembly tests (T009).
 *
 * createEngine with an in-memory env: settings persistence through env.kv
 * under the legacy localStorage keys, legacy-profile readback, per-provider
 * threshold defaults, the mobile/low-memory auto-pick heuristic, provider
 * lifecycle (preload/switch/release) and the detect pipeline composition.
 * Providers are injected fakes; no network, no wasm.
 */
import { describe, it, expect } from 'vitest';
import {
  createEngine,
  pickDefaultProvider,
  defaultThresholdFor,
  clampThreshold,
  ENGINE_SETTINGS_KEYS,
  PROVIDERS,
} from '../src/engine.ts';
import type { EngineOptions } from '../src/engine.ts';
import { memoryKV, memoryBlobCache } from '../src/env.ts';
import type { CoreEnv, KVStore } from '../src/env.ts';
import type { DetectedEntity, DetectionProvider, ProgressCallback } from '../src/types.ts';

// ── Fakes ──────────────────────────────────────────────────

class FakeProvider implements DetectionProvider {
  readonly name = 'Fake NER';
  loaded = false;
  releaseCount = 0;
  loadCount = 0;
  failLoad = false;
  entities: DetectedEntity[] = [];
  private threshold: number;
  private progressCallback: ProgressCallback | null = null;

  constructor(defaultThreshold = 0.35) {
    this.threshold = defaultThreshold;
  }

  async load(): Promise<void> {
    this.loadCount++;
    if (this.failLoad) throw new Error('load failed');
    this.progressCallback?.(50, 100);
    this.loaded = true;
  }

  isLoaded(): boolean { return this.loaded; }
  isLoading(): boolean { return false; }
  onProgress(callback: ProgressCallback): void { this.progressCallback = callback; }

  async detect(_text: string, onProgress?: (progress: number) => void): Promise<DetectedEntity[]> {
    if (!this.loaded) await this.load();
    onProgress?.(1);
    return this.entities.filter((e) => e.confidence >= this.threshold);
  }

  setThreshold(value: number): void {
    this.threshold = Math.max(0.05, Math.min(0.95, value));
  }

  getThreshold(): number { return this.threshold; }

  release(): void {
    this.releaseCount++;
    this.loaded = false;
  }
}

class FakeLabelProvider extends FakeProvider {
  labels: string[] = [];
  setCustomLabels(labels: string[]): void { this.labels = [...labels]; }
  getCustomLabels(): string[] { return [...this.labels]; }
}

interface Fakes {
  gliner: FakeLabelProvider;
  glinerBase: FakeLabelProvider;
  bardsai: FakeProvider;
  options: EngineOptions;
}

function makeFakes(): Fakes {
  const gliner = new FakeLabelProvider(0.35);
  const glinerBase = new FakeLabelProvider(0.35);
  const bardsai = new FakeProvider(0.5);
  return {
    gliner,
    glinerBase,
    bardsai,
    options: { providers: { gliner: () => gliner, 'gliner-base': () => glinerBase, bardsai: () => bardsai } },
  };
}

function makeEnv(overrides: Partial<CoreEnv> = {}): CoreEnv {
  return {
    kv: memoryKV(),
    modelCache: memoryBlobCache(),
    fetch: (() => { throw new Error('network disabled in tests'); }) as unknown as typeof fetch,
    wasm: { paths: '/base/' },
    loadTokenizer: async () => { throw new Error('tokenizer disabled in tests'); },
    ...overrides,
  };
}

async function seededKV(entries: Record<string, string>): Promise<KVStore> {
  const kv = memoryKV();
  for (const [key, value] of Object.entries(entries)) {
    await kv.set(key, value);
  }
  return kv;
}

// ── Heuristic ──────────────────────────────────────────────

describe('pickDefaultProvider', () => {
  it('defaults to bardsai without hardware hints (T127)', () => {
    expect(pickDefaultProvider()).toBe('bardsai');
    expect(pickDefaultProvider({})).toBe('bardsai');
  });

  it('picks gliner on mobile devices', () => {
    expect(pickDefaultProvider({ isMobile: true })).toBe('gliner');
  });

  it('picks gliner on low-memory devices (<= 4 GB)', () => {
    expect(pickDefaultProvider({ deviceMemoryGB: 4 })).toBe('gliner');
    expect(pickDefaultProvider({ deviceMemoryGB: 2 })).toBe('gliner');
  });

  it('picks bardsai on desktop-class hardware (T127 benchmark decision)', () => {
    expect(pickDefaultProvider({ isMobile: false, deviceMemoryGB: 16 })).toBe('bardsai');
  });
});

describe('threshold helpers', () => {
  it('has the per-provider defaults', () => {
    expect(defaultThresholdFor('gliner')).toBe(0.35);
    expect(defaultThresholdFor('gliner-base')).toBe(0.35);
    expect(defaultThresholdFor('bardsai')).toBe(0.5);
  });

  it('clamps to 0.05-0.95', () => {
    expect(clampThreshold(-1)).toBe(0.05);
    expect(clampThreshold(0.4)).toBe(0.4);
    expect(clampThreshold(2)).toBe(0.95);
  });
});

// ── Settings load / defaults ───────────────────────────────

describe('createEngine settings', () => {
  it('starts with defaults on an empty KV (bardsai, 0.5, regex off, region all)', async () => {
    const engine = createEngine(makeEnv(), undefined, makeFakes().options);
    await engine.ready;
    expect(engine.getSettings()).toEqual({
      providerId: 'bardsai',
      threshold: 0.5,
      regexEnabled: false,
      regexRegion: 'all',
      customLabels: [],
    });
  });

  it('uses env.hardware for the default provider (mobile -> gliner, 0.35)', async () => {
    const engine = createEngine(makeEnv({ hardware: { isMobile: true } }), undefined, makeFakes().options);
    await engine.ready;
    const s = engine.getSettings();
    expect(s.providerId).toBe('gliner');
    expect(s.threshold).toBe(0.35);
  });

  it('reads a legacy pre-refactor profile back from the exact localStorage keys', async () => {
    const kv = await seededKV({
      'doccloak-active-provider': 'gliner',
      'doccloak-custom-labels': '["project falcon","internal codename"]',
      'doccloak-regex-enabled': 'true',
      'doccloak-regex-region': 'pl',
    });
    const engine = createEngine(makeEnv({ kv }), undefined, makeFakes().options);
    await engine.ready;
    expect(engine.getSettings()).toEqual({
      providerId: 'gliner',
      threshold: 0.35,
      regexEnabled: true,
      regexRegion: 'pl',
      customLabels: ['project falcon', 'internal codename'],
    });
  });

  it('ignores corrupt or unknown persisted values', async () => {
    const kv = await seededKV({
      [ENGINE_SETTINGS_KEYS.provider]: 'no-such-provider',
      [ENGINE_SETTINGS_KEYS.customLabels]: '{not json',
      [ENGINE_SETTINGS_KEYS.regexEnabled]: 'nope',
      [ENGINE_SETTINGS_KEYS.regexRegion]: 'atlantis',
    });
    const engine = createEngine(makeEnv({ kv }), undefined, makeFakes().options);
    await engine.ready;
    expect(engine.getSettings()).toEqual({
      providerId: 'bardsai',
      threshold: 0.5,
      regexEnabled: false,
      regexRegion: 'all',
      customLabels: [],
    });
  });

  it('keeps a saved bardsai choice valid (legacy provider, T122)', async () => {
    const kv = await seededKV({ [ENGINE_SETTINGS_KEYS.provider]: 'bardsai' });
    const engine = createEngine(makeEnv({ kv }), undefined, makeFakes().options);
    await engine.ready;
    const s = engine.getSettings();
    expect(s.providerId).toBe('bardsai');
    expect(s.threshold).toBe(0.5);
  });

  it('lets explicit initial settings win over persisted values', async () => {
    const kv = await seededKV({
      [ENGINE_SETTINGS_KEYS.provider]: 'bardsai',
      [ENGINE_SETTINGS_KEYS.regexRegion]: 'de',
    });
    const engine = createEngine(
      makeEnv({ kv }),
      { providerId: 'gliner', regexRegion: 'fr' },
      makeFakes().options,
    );
    await engine.ready;
    const s = engine.getSettings();
    expect(s.providerId).toBe('gliner');
    expect(s.threshold).toBe(0.35);
    expect(s.regexRegion).toBe('fr');
  });
});

// ── Persistence ────────────────────────────────────────────

describe('updateSettings persistence', () => {
  it('persists every setting under the legacy keys (threshold intentionally not persisted)', async () => {
    const kv = memoryKV();
    const engine = createEngine(makeEnv({ kv }), undefined, makeFakes().options);
    await engine.updateSettings({
      providerId: 'gliner',
      threshold: 0.6,
      regexEnabled: true,
      regexRegion: 'gb',
      customLabels: ['badge id', '  ', 'employee number'],
    });

    expect(await kv.get('doccloak-active-provider')).toBe('gliner');
    expect(await kv.get('doccloak-regex-enabled')).toBe('true');
    expect(await kv.get('doccloak-regex-region')).toBe('gb');
    expect(await kv.get('doccloak-custom-labels')).toBe('["badge id","employee number"]');

    const s = engine.getSettings();
    expect(s.threshold).toBe(0.6);
    expect(s.customLabels).toEqual(['badge id', 'employee number']);

    // A second engine over the same KV reads the settings back
    // (threshold resets to the provider default, as before the refactor).
    const engine2 = createEngine(makeEnv({ kv }), undefined, makeFakes().options);
    await engine2.ready;
    expect(engine2.getSettings()).toEqual({
      providerId: 'gliner',
      threshold: 0.35,
      regexEnabled: true,
      regexRegion: 'gb',
      customLabels: ['badge id', 'employee number'],
    });
  });

  it('clamps the threshold and forwards it to a live provider', async () => {
    const fakes = makeFakes();
    const engine = createEngine(makeEnv(), { providerId: 'gliner' }, fakes.options);
    await engine.preload();
    await engine.updateSettings({ threshold: 7 });
    expect(engine.getSettings().threshold).toBe(0.95);
    expect(fakes.gliner.getThreshold()).toBe(0.95);
  });

  it('rejects an unknown provider id', async () => {
    const engine = createEngine(makeEnv(), undefined, makeFakes().options);
    await expect(
      engine.updateSettings({ providerId: 'nope' as never }),
    ).rejects.toThrow('Unknown provider: nope');
  });
});

// ── Provider lifecycle ─────────────────────────────────────

describe('provider lifecycle', () => {
  it('preload loads the active provider, applies custom labels and syncs the threshold', async () => {
    const fakes = makeFakes();
    const engine = createEngine(
      makeEnv(),
      { providerId: 'gliner', customLabels: ['secret project'] },
      fakes.options,
    );

    const events: Array<{ loaded: number; total: number }> = [];
    engine.onDownloadProgress((p) => events.push(p));

    await engine.preload();
    expect(fakes.gliner.loaded).toBe(true);
    expect(fakes.gliner.labels).toEqual(['secret project']);
    expect(engine.getSettings().threshold).toBe(0.35);
    expect(events).toEqual([{ loaded: 50, total: 100 }]);
  });

  it('switchProvider releases the old session, persists the id and resets the threshold', async () => {
    const fakes = makeFakes();
    const kv = memoryKV();
    const engine = createEngine(makeEnv({ kv }), { providerId: 'gliner' }, fakes.options);
    await engine.preload();
    await engine.updateSettings({ threshold: 0.8 });

    await engine.switchProvider('bardsai');
    expect(fakes.gliner.releaseCount).toBeGreaterThan(0);
    expect(fakes.gliner.loaded).toBe(false);
    expect(fakes.bardsai.loaded).toBe(true);
    expect(await kv.get(ENGINE_SETTINGS_KEYS.provider)).toBe('bardsai');
    expect(engine.getSettings().providerId).toBe('bardsai');
    expect(engine.getSettings().threshold).toBe(0.5);
  });

  it('switchProvider to the already-loaded provider is a no-op', async () => {
    const fakes = makeFakes();
    const engine = createEngine(makeEnv(), { providerId: 'gliner' }, fakes.options);
    await engine.preload();
    const loadsBefore = fakes.gliner.loadCount;
    await engine.switchProvider('gliner');
    expect(fakes.gliner.loadCount).toBe(loadsBefore);
  });

  it('propagates load failures and can retry after the failure is fixed', async () => {
    const fakes = makeFakes();
    fakes.gliner.failLoad = true;
    const engine = createEngine(makeEnv(), { providerId: 'gliner' }, fakes.options);
    await expect(engine.preload()).rejects.toThrow('load failed');

    fakes.gliner.failLoad = false;
    await engine.preload();
    expect(fakes.gliner.loaded).toBe(true);
  });

  it('release frees the session; the next detect reloads', async () => {
    const fakes = makeFakes();
    const engine = createEngine(makeEnv(), { providerId: 'gliner' }, fakes.options);
    await engine.preload();
    await engine.release();
    expect(fakes.gliner.loaded).toBe(false);

    fakes.gliner.entities = [
      { type: 'PERSON', value: 'Jan', start: 0, end: 3, confidence: 0.9, detector: 'gliner:person name' },
    ];
    const result = await engine.detect('Jan called.');
    expect(result).toHaveLength(1);
    expect(fakes.gliner.loaded).toBe(true);
  });
});

// ── Detection pipeline ─────────────────────────────────────

describe('detect', () => {
  const text = 'Contact Jan Kowalski at jan@example.com today.';

  it('returns [] for blank text without touching the provider', async () => {
    const fakes = makeFakes();
    const engine = createEngine(makeEnv(), { providerId: 'gliner' }, fakes.options);
    expect(await engine.detect('   \n ')).toEqual([]);
    expect(fakes.gliner.loadCount).toBe(0);
  });

  it('merges ML results with regex results when regex is enabled', async () => {
    const fakes = makeFakes();
    fakes.gliner.entities = [
      { type: 'PERSON', value: 'Jan Kowalski', start: 8, end: 20, confidence: 0.9, detector: 'gliner:person name' },
    ];
    const engine = createEngine(
      makeEnv(),
      { providerId: 'gliner', regexEnabled: true, regexRegion: 'all' },
      fakes.options,
    );
    const entities = await engine.detect(text);
    expect(entities.some((e) => e.detector === 'gliner:person name')).toBe(true);
    const email = entities.find((e) => e.detector === 'regex:universal:email');
    expect(email).toBeDefined();
    expect(email!.value).toBe('jan@example.com');
  });

  it('skips regex results when regex is disabled', async () => {
    const fakes = makeFakes();
    const engine = createEngine(makeEnv(), { providerId: 'gliner' }, fakes.options);
    const entities = await engine.detect(text);
    expect(entities.every((e) => !e.detector.startsWith('regex:'))).toBe(true);
  });

  it('fans detection progress out to the per-call callback and listeners', async () => {
    const fakes = makeFakes();
    const engine = createEngine(makeEnv(), { providerId: 'gliner' }, fakes.options);
    const perCall: number[] = [];
    const listener: number[] = [];
    engine.onDetectionProgress((p) => listener.push(p));
    await engine.detect(text, undefined, (p) => perCall.push(p));
    expect(perCall).toEqual([1]);
    expect(listener).toEqual([1]);
  });

  it('rejects when the abort signal is already aborted', async () => {
    const engine = createEngine(makeEnv(), { providerId: 'gliner' }, makeFakes().options);
    const controller = new AbortController();
    controller.abort();
    await expect(engine.detect(text, controller.signal)).rejects.toThrow('Detection aborted');
  });
});

// ── Registry catalog ───────────────────────────────────────

describe('PROVIDERS catalog', () => {
  it('lists the built-in providers with stable ids', () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual(['gliner', 'gliner-base', 'bardsai']);
  });

  it('describes bardsai as the multilingual default and gliner-base as the English/dates alternative (T127)', () => {
    const bardsai = PROVIDERS.find((p) => p.id === 'bardsai')!;
    expect(bardsai.label).toBe('BardS.ai EU PII');
    expect(bardsai.description.toLowerCase()).toContain('multilingual');
    const base = PROVIDERS.find((p) => p.id === 'gliner-base')!;
    expect(base.label).toBe('GLiNER PII Base');
    expect(base.description).toContain('English');
    expect(base.description).toContain('197 MB');
  });
});
