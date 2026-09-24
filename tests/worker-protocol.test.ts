/**
 * Worker protocol tests (T009).
 *
 * serveEngine/connectEngine round trips over a real MessageChannel:
 * detect request/response with requestId correlation, detection and
 * download progress events, error propagation, provider switching,
 * release, legacy requestId-less messages and connection teardown.
 * T185 (R12): malformed messages (null, garbage, wrong payload types and
 * unknown types) get an error reply instead of crashing the host, and the
 * client fails its pending requests on a fatal host error.
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

  it('reports a failed fire-and-forget setting as an error message instead of crashing', async () => {
    const h = makeHarness('gliner');
    await h.client.preload();
    const replies: EngineResponse[] = [];
    h.clientPort.addEventListener('message', ((e: MessageEvent) => { replies.push(e.data as EngineResponse); }) as EventListener);
    const original = h.engine.updateSettings;
    h.engine.updateSettings = async (patch) => {
      if (patch.threshold !== undefined) throw new Error('settings store exploded');
      return original(patch);
    };

    await h.client.updateSettings({ threshold: 0.6 });

    await expect.poll(() => replies.some((m) => m.type === 'error')).toBe(true);
    expect(replies.find((m) => m.type === 'error')).toMatchObject({ error: 'settings store exploded' });
    // The host is still serving.
    expect(await h.client.detect('still alive')).toEqual([]);
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

// ── Message validation (T185, R12) ────────────────────────

interface RawHarness {
  gliner: FakeProvider;
  engine: ReturnType<typeof createEngine>;
  send: (msg: unknown) => void;
  replies: EngineResponse[];
}

/** Serve an engine over a raw channel and speak the wire format directly. */
function makeRawHarness(): RawHarness {
  const raw = new MessageChannel();
  openChannels.push(raw);
  const gliner = new FakeProvider(0.35);
  const engine = createEngine(makeEnv(), { providerId: 'gliner' }, {
    providers: { gliner: () => gliner, bardsai: () => gliner },
  });
  serveEngine(engine, wrapPort(raw.port1));
  const replies: EngineResponse[] = [];
  raw.port2.addEventListener('message', ((e: MessageEvent) => {
    replies.push(e.data as EngineResponse);
  }) as EventListener);
  raw.port2.start();
  return { gliner, engine, send: (msg) => raw.port2.postMessage(msg), replies };
}

describe('serveEngine message validation', () => {
  const garbage: Array<[string, unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['number', 42],
    ['string', 'detect'],
    ['array', ['detect']],
    ['empty object', {}],
    ['numeric type', { type: 42 }],
    ['object type', { type: { nested: true } }],
  ];

  for (const [label, msg] of garbage) {
    it(`answers a malformed message (${label}) with an error and keeps serving`, async () => {
      const h = makeRawHarness();
      h.send(msg);
      await expect.poll(() => h.replies.length).toBe(1);
      expect(h.replies[0]).toMatchObject({ type: 'error' });
      expect((h.replies[0] as { error: string }).error).toContain('string type');

      h.send({ type: 'detect', requestId: 7, text: 'still serving' });
      await expect.poll(() => h.replies.some((m) => m.type === 'detected')).toBe(true);
      expect(h.replies.find((m) => m.type === 'detected')).toMatchObject({ requestId: 7, entities: [] });
    });
  }

  it('answers an unknown message type with an error carrying the requestId', async () => {
    const h = makeRawHarness();
    h.send({ type: 'selfDestruct', requestId: 3 });
    await expect.poll(() => h.replies.length).toBe(1);
    expect(h.replies[0]).toEqual({ type: 'error', requestId: 3, error: 'Unknown message type: selfDestruct' });
  });

  it('rejects setCustomLabels with a non-array payload without touching the engine', async () => {
    const h = makeRawHarness();
    await h.engine.updateSettings({ customLabels: ['kept'] });

    h.send({ type: 'setCustomLabels', labels: 'x' });
    await expect.poll(() => h.replies.length).toBe(1);
    expect(h.replies[0]).toMatchObject({ type: 'error', error: expect.stringContaining('labels must be an array of strings') });
    expect(h.engine.getSettings().customLabels).toEqual(['kept']);

    h.send({ type: 'setCustomLabels', labels: ['ok', 5] });
    await expect.poll(() => h.replies.length).toBe(2);
    expect(h.replies[1]).toMatchObject({ type: 'error' });
    expect(h.engine.getSettings().customLabels).toEqual(['kept']);
  });

  it('rejects wrong field types on every settings message', async () => {
    const h = makeRawHarness();
    const bad: unknown[] = [
      { type: 'setThreshold', value: 'high' },
      { type: 'setThreshold', value: NaN },
      { type: 'setRegex', enabled: 'yes' },
      { type: 'setRegex', enabled: true, region: 'atlantis' },
      { type: 'setRegexRegion', region: 42 },
    ];
    for (const msg of bad) h.send(msg);
    await expect.poll(() => h.replies.length).toBe(bad.length);
    expect(h.replies.every((m) => m.type === 'error')).toBe(true);
    const s = h.engine.getSettings();
    expect(s.threshold).toBe(0.35);
    expect(s.regexEnabled).toBe(true);
    expect(s.regexRegion).toBe('all');
  });

  it('rejects a detect with a non-string text as detectError on the same requestId', async () => {
    const h = makeRawHarness();
    h.send({ type: 'detect', requestId: 11, text: 5 });
    await expect.poll(() => h.replies.length).toBe(1);
    expect(h.replies[0]).toEqual({ type: 'detectError', requestId: 11, error: 'Invalid detect message: text must be a string' });
  });

  it('rejects a detect without a numeric requestId as a generic error', async () => {
    const h = makeRawHarness();
    h.send({ type: 'detect', text: 'no id' });
    await expect.poll(() => h.replies.length).toBe(1);
    expect(h.replies[0]).toMatchObject({ type: 'error', error: expect.stringContaining('requestId must be a number') });
  });

  it('rejects init/switchProvider with an unknown provider as loadError without loading anything', async () => {
    const h = makeRawHarness();
    h.send({ type: 'init', requestId: 1, providerId: 'gpt-9' });
    h.send({ type: 'switchProvider', requestId: 2, providerId: null });
    h.send({ type: 'init', requestId: 3, customLabels: 'not-a-list' });
    await expect.poll(() => h.replies.length).toBe(3);
    expect(h.replies.map((m) => m.type)).toEqual(['loadError', 'loadError', 'loadError']);
    expect(h.replies.map((m) => (m as { requestId?: number }).requestId)).toEqual([1, 2, 3]);
    expect(h.gliner.loaded).toBe(false);
  });
});

describe('connectEngine host errors', () => {
  it('rejects every pending request and closes on a fatal host error', async () => {
    const channel = new MessageChannel();
    openChannels.push(channel);
    const hostReceived: unknown[] = [];
    channel.port1.addEventListener('message', ((e: MessageEvent) => { hostReceived.push(e.data); }) as EventListener);
    channel.port1.start();
    const client = connectEngine(wrapPort(channel.port2), { providerId: 'gliner' });

    const pendingDetect = client.detect('never answered');
    const pendingLoad = client.preload();
    await expect.poll(() => hostReceived.length).toBe(2);

    channel.port1.postMessage({ type: 'error', error: 'host worker crashed', fatal: true });

    await expect(pendingDetect).rejects.toThrow('host worker crashed');
    await expect(pendingLoad).rejects.toThrow('host worker crashed');
    await expect(client.detect('after fatal')).rejects.toThrow('Engine connection closed');
  });

  it('rejects only the addressed request on a non-fatal error with a requestId', async () => {
    const channel = new MessageChannel();
    openChannels.push(channel);
    const hostReceived: Array<{ requestId: number }> = [];
    channel.port1.addEventListener('message', ((e: MessageEvent) => { hostReceived.push(e.data as { requestId: number }); }) as EventListener);
    channel.port1.start();
    const client = connectEngine(wrapPort(channel.port2), { providerId: 'gliner' });

    const first = client.detect('one');
    const second = client.detect('two');
    await expect.poll(() => hostReceived.length).toBe(2);

    channel.port1.postMessage({ type: 'error', requestId: hostReceived[0].requestId, error: 'bad request' });
    await expect(first).rejects.toThrow('bad request');

    channel.port1.postMessage({ type: 'detected', requestId: hostReceived[1].requestId, entities: [] });
    expect(await second).toEqual([]);
  });

  it('ignores malformed frames from the host without throwing', async () => {
    const channel = new MessageChannel();
    openChannels.push(channel);
    const hostReceived: Array<{ requestId: number }> = [];
    channel.port1.addEventListener('message', ((e: MessageEvent) => { hostReceived.push(e.data as { requestId: number }); }) as EventListener);
    channel.port1.start();
    const client = connectEngine(wrapPort(channel.port2), { providerId: 'gliner' });

    const pending = client.detect('text');
    await expect.poll(() => hostReceived.length).toBe(1);
    for (const frame of [null, 1, 'x', {}, { type: 9 }]) channel.port1.postMessage(frame);
    channel.port1.postMessage({ type: 'detected', requestId: hostReceived[0].requestId, entities: [] });

    expect(await pending).toEqual([]);
  });
});
