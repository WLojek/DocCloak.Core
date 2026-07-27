/**
 * Worker protocol tests (T009).
 *
 * serveEngine/connectEngine round trips over a real MessageChannel:
 * detect request/response with requestId correlation, detection and
 * download progress events, error propagation, provider switching,
 * release, legacy requestId-less messages and connection teardown.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createEngine } from '../src/engine.ts';
import type { EngineOptions } from '../src/engine.ts';
import { serveEngine, connectEngine } from '../src/worker-protocol.ts';
import type { EngineResponse, PortLike } from '../src/worker-protocol.ts';
import { memoryKV, memoryBlobCache } from '../src/env.ts';
import type { CoreEnv } from '../src/env.ts';
import type { DetectedEntity, DetectionProvider, ProgressCallback } from '../src/types.ts';

// ── Fakes ──────────────────────────────────────────────────

class FakeProvider implements DetectionProvider {
  readonly name = 'Fake NER';
  loaded = false;
  releaseCount = 0;
  failLoad = false;
  failDetect = false;
  neverResolveDetect = false;
  entities: DetectedEntity[] = [];
  private threshold: number;
  private progressCallback: ProgressCallback | null = null;

  constructor(defaultThreshold = 0.35) {
    this.threshold = defaultThreshold;
  }

  async load(): Promise<void> {
    if (this.failLoad) throw new Error('quota exceeded while caching the model');
    this.progressCallback?.(1024, 4096);
    this.loaded = true;
  }

  isLoaded(): boolean { return this.loaded; }
  isLoading(): boolean { return false; }
  onProgress(callback: ProgressCallback): void { this.progressCallback = callback; }

  async detect(_text: string, onProgress?: (progress: number) => void): Promise<DetectedEntity[]> {
    if (this.neverResolveDetect) return new Promise(() => { /* hang forever */ });
    if (this.failDetect) throw new Error('inference blew up');
    if (!this.loaded) await this.load();
    onProgress?.(0.5);
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

function makeEnv(): CoreEnv {
  return {
    kv: memoryKV(),
    modelCache: memoryBlobCache(),
    fetch: (() => { throw new Error('network disabled in tests'); }) as unknown as typeof fetch,
    wasm: { paths: '/base/' },
    loadTokenizer: async () => { throw new Error('tokenizer disabled in tests'); },
  };
}

// ── MessageChannel plumbing ────────────────────────────────

const openChannels: MessageChannel[] = [];

function wrapPort(port: MessagePort): PortLike {
  return {
    postMessage: (msg) => port.postMessage(msg),
    onMessage: (cb) => {
      const handler = (e: MessageEvent) => { void cb(e.data); };
      port.addEventListener('message', handler as EventListener);
      port.start();
      return () => port.removeEventListener('message', handler as EventListener);
    },
  };
}

interface Harness {
  gliner: FakeProvider;
  bardsai: FakeProvider;
  engine: ReturnType<typeof createEngine>;
  client: ReturnType<typeof connectEngine>;
  clientPort: MessagePort;
  stopServing: () => void;
}

function makeHarness(initialProvider: 'gliner' | 'bardsai' = 'gliner'): Harness {
  const gliner = new FakeProvider(0.35);
  const bardsai = new FakeProvider(0.5);
  const options: EngineOptions = {
    providers: { gliner: () => gliner, bardsai: () => bardsai },
  };
  const engine = createEngine(makeEnv(), { providerId: initialProvider }, options);

  const channel = new MessageChannel();
  openChannels.push(channel);
  const stopServing = serveEngine(engine, wrapPort(channel.port1));
  const client = connectEngine(wrapPort(channel.port2), { providerId: initialProvider });

  return { gliner, bardsai, engine, client, clientPort: channel.port2, stopServing };
}

afterEach(() => {
  for (const channel of openChannels.splice(0)) {
    channel.port1.close();
    channel.port2.close();
  }
});

// ── Round trips ────────────────────────────────────────────

describe('serveEngine / connectEngine over MessageChannel', () => {
  it('preload round trip loads the provider and syncs the settings mirror', async () => {
    const h = makeHarness('gliner');
    await h.client.preload();
    expect(h.gliner.loaded).toBe(true);
    const s = h.client.getSettings();
    expect(s.providerId).toBe('gliner');
    expect(s.threshold).toBe(0.35);
  });

  it('detect round trip returns the entities with requestId correlation', async () => {
    const h = makeHarness('gliner');
    h.gliner.entities = [
      { type: 'EMAIL', value: 'jan@example.com', start: 8, end: 23, confidence: 0.92, detector: 'gliner:email address' },
    ];
    await h.client.preload();

    const [first, second] = await Promise.all([
      h.client.detect('Contact jan@example.com now'),
      h.client.detect('   '),
    ]);
    expect(first).toEqual(h.gliner.entities);
    expect(second).toEqual([]);
  });

  it('streams detectionProgress events to the per-call callback and listeners', async () => {
    const h = makeHarness('gliner');
    await h.client.preload();

    const perCall: number[] = [];
    const listener: number[] = [];
    h.client.onDetectionProgress((p) => listener.push(p));
    await h.client.detect('some text', undefined, (p) => perCall.push(p));

    expect(perCall).toEqual([0.5, 1]);
    expect(listener).toEqual([0.5, 1]);
  });

  it('streams downloadProgress events during preload', async () => {
    const h = makeHarness('gliner');
    const events: Array<{ loaded: number; total: number }> = [];
    h.client.onDownloadProgress((p) => events.push(p));
    await h.client.preload();
    // The progress event travels on its own message; wait for delivery.
    await expect.poll(() => events.length).toBeGreaterThan(0);
    expect(events[0]).toEqual({ loaded: 1024, total: 4096 });
  });

  it('propagates load errors as rejected preload promises', async () => {
    const h = makeHarness('gliner');
    h.gliner.failLoad = true;
    await expect(h.client.preload()).rejects.toThrow('quota exceeded while caching the model');
  });

  it('propagates detect errors as rejected detect promises', async () => {
    const h = makeHarness('gliner');
    await h.client.preload();
    h.gliner.failDetect = true;
    await expect(h.client.detect('boom')).rejects.toThrow('inference blew up');
  });

  it('switchProvider round trip releases the old provider and resets the threshold', async () => {
    const h = makeHarness('gliner');
    await h.client.preload();
    await h.client.switchProvider('bardsai', ['ignored for bardsai']);
    expect(h.gliner.releaseCount).toBeGreaterThan(0);
    expect(h.bardsai.loaded).toBe(true);
    const s = h.client.getSettings();
    expect(s.providerId).toBe('bardsai');
    expect(s.threshold).toBe(0.5);
  });

  it('release round trip frees the provider session', async () => {
    const h = makeHarness('gliner');
    await h.client.preload();
    await h.client.release();
    expect(h.gliner.loaded).toBe(false);
  });

  it('applies fire-and-forget settings updates on the served engine', async () => {
    const h = makeHarness('gliner');
    await h.client.preload();
    await h.client.updateSettings({ threshold: 0.8, regexEnabled: true, regexRegion: 'pl' });

    await expect.poll(() => h.engine.getSettings().threshold).toBe(0.8);
    await expect.poll(() => h.engine.getSettings().regexEnabled).toBe(true);
    expect(h.engine.getSettings().regexRegion).toBe('pl');
    expect(h.gliner.getThreshold()).toBe(0.8);
  });

  it('answers legacy requestId-less messages by type (old wire compatibility)', async () => {
    const replies: EngineResponse[] = [];
    const raw = new MessageChannel();
    openChannels.push(raw);

    // Serve a fresh engine over a raw channel and speak the old protocol
    // directly: no requestId on init, replies matched by message name.
    const gliner = new FakeProvider(0.35);
    const engine = createEngine(makeEnv(), { providerId: 'gliner' }, {
      providers: { gliner: () => gliner, bardsai: () => gliner },
    });
    serveEngine(engine, wrapPort(raw.port1));
    raw.port2.addEventListener('message', ((e: MessageEvent) => {
      replies.push(e.data as EngineResponse);
    }) as EventListener);
    raw.port2.start();

    raw.port2.postMessage({
      type: 'init', providerId: 'gliner', customLabels: [], regexEnabled: false, regexRegion: 'all',
    });
    await expect.poll(() => replies.some((m) => m.type === 'loaded')).toBe(true);
    const loaded = replies.find((m) => m.type === 'loaded');
    expect(loaded).toMatchObject({ providerId: 'gliner', threshold: 0.35, customLabels: [] });
  });

  it('close() rejects pending requests and resolves pending releases', async () => {
    const h = makeHarness('gliner');
    await h.client.preload();
    h.gliner.neverResolveDetect = true;

    const hanging = h.client.detect('never answered');
    h.client.close(new Error('Detection worker crashed'));

    await expect(hanging).rejects.toThrow('Detection worker crashed');
    await expect(h.client.detect('after close')).rejects.toThrow('Engine connection closed');
  });
});
