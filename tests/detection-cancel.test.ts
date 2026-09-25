/**
 * T222: cooperative cancel of a detect call. The AbortSignal reaches the
 * provider, which stops at the next chunk boundary with DetectionAbortedError;
 * the engine passes the signal through; the worker protocol carries a
 * cancelDetect request and answers detectError { aborted: true } so the client
 * rejects with the typed error only once the host has really stopped.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

const ortMock = vi.hoisted(() => ({
  env: { wasm: {} as Record<string, unknown> },
  InferenceSession: { create: vi.fn() },
  Tensor: class {},
}));
vi.mock('onnxruntime-web/webgpu', () => ortMock);
vi.mock('onnxruntime-web', () => ortMock);

import { createEngine } from '../src/engine.ts';
import type { EngineOptions } from '../src/engine.ts';
import { serveEngine, connectEngine } from '../src/worker-protocol.ts';
import type { EngineResponse, PortLike } from '../src/worker-protocol.ts';
import { memoryKV, memoryBlobCache } from '../src/env.ts';
import type { CoreEnv } from '../src/env.ts';
import { DetectionAbortedError, throwIfAborted } from '../src/types.ts';
import type { DetectedEntity, DetectionProvider, ProgressCallback } from '../src/types.ts';
import { GlinerProvider } from '../src/providers/gliner.ts';
import { GlinerBaseProvider } from '../src/providers/gliner-base.ts';
import { BardsaiProvider } from '../src/providers/bardsai.ts';

// ── Fakes ──────────────────────────────────────────────────

/** A provider whose detect runs chunk by chunk, one per macrotask, honouring the signal. */
class ChunkedProvider implements DetectionProvider {
  readonly name = 'Chunked';
  loaded = false;
  chunks = 100;
  chunksRun = 0;
  lastSignal: AbortSignal | undefined;
  private threshold = 0.35;

  async load(): Promise<void> { this.loaded = true; }
  isLoaded(): boolean { return this.loaded; }
  isLoading(): boolean { return false; }
  onProgress(_callback: ProgressCallback): void { /* no download in this fake */ }

  async detect(_text: string, onProgress?: (p: number) => void, signal?: AbortSignal): Promise<DetectedEntity[]> {
    this.lastSignal = signal;
    if (!this.loaded) await this.load();
    for (let i = 0; i < this.chunks; i++) {
      throwIfAborted(signal);
      this.chunksRun++;
      onProgress?.((i + 1) / this.chunks);
      await new Promise((r) => setTimeout(r, 1));
    }
    return [{ type: 'PERSON', value: 'Jan Kowalski', start: 0, end: 12, confidence: 0.9, detector: 'chunked' }];
  }

  setThreshold(value: number): void { this.threshold = value; }
  getThreshold(): number { return this.threshold; }
  release(): void { this.loaded = false; }
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
afterEach(() => {
  for (const ch of openChannels.splice(0)) { ch.port1.close(); ch.port2.close(); }
  vi.restoreAllMocks();
});

function makeHarness() {
  const provider = new ChunkedProvider();
  const options: EngineOptions = { providers: { gliner: () => provider } };
  const engine = createEngine(makeEnv(), { providerId: 'gliner', regexEnabled: false }, options);
  const channel = new MessageChannel();
  openChannels.push(channel);
  const stop = serveEngine(engine, wrapPort(channel.port1));
  const client = connectEngine(wrapPort(channel.port2), { providerId: 'gliner' });
  return { provider, engine, client, stop };
}

async function settle(): Promise<void> { await new Promise((r) => setTimeout(r, 25)); }

// ── Engine ─────────────────────────────────────────────────

describe('engine.detect with an AbortSignal (T222)', () => {
  it('hands the signal to the provider and rejects with DetectionAbortedError when aborted mid-run', async () => {
    const provider = new ChunkedProvider();
    const engine = createEngine(makeEnv(), { providerId: 'gliner', regexEnabled: true }, { providers: { gliner: () => provider } });
    const controller = new AbortController();
    const seen: number[] = [];
    const promise = engine.detect('some text', controller.signal, (p) => {
      seen.push(p);
      if (seen.length === 3) controller.abort();
    });
    await expect(promise).rejects.toBeInstanceOf(DetectionAbortedError);
    expect(provider.lastSignal).toBe(controller.signal);
    // Stopped at the next boundary: the chunk in flight finished, no more.
    expect(provider.chunksRun).toBe(3);
  });

  it('an already aborted signal rejects with the typed error before touching the provider', async () => {
    const provider = new ChunkedProvider();
    const engine = createEngine(makeEnv(), { providerId: 'gliner' }, { providers: { gliner: () => provider } });
    const controller = new AbortController();
    controller.abort();
    const err = await engine.detect('text', controller.signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DetectionAbortedError);
    expect((err as Error).message).toBe('Detection aborted');
    expect(provider.chunksRun).toBe(0);
  });

  it('a signal that is never aborted changes nothing', async () => {
    const provider = new ChunkedProvider();
    provider.chunks = 3;
    const engine = createEngine(makeEnv(), { providerId: 'gliner', regexEnabled: false }, { providers: { gliner: () => provider } });
    const entities = await engine.detect('text', new AbortController().signal);
    expect(entities).toHaveLength(1);
    expect(provider.chunksRun).toBe(3);
  });
});

// ── Worker protocol ────────────────────────────────────────

describe('worker protocol cancelDetect (T222)', () => {
  it('aborting the client signal cancels the host call: typed rejection after the host acknowledged', async () => {
    const h = makeHarness();
    await h.client.preload();
    const controller = new AbortController();
    const seen: number[] = [];
    const promise = h.client.detect('a long document', controller.signal, (p) => {
      seen.push(p);
      if (seen.length === 2) controller.abort();
    });
    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DetectionAbortedError);
    // The host stopped its loop (a couple of chunks may finish while the
    // cancel message travels), far short of the 100 chunks.
    await settle();
    expect(h.provider.chunksRun).toBeLessThan(10);
    // The host is idle again: a fresh detect runs to completion.
    h.provider.chunks = 2;
    await expect(h.client.detect('again')).resolves.toHaveLength(1);
    h.stop();
  });

  it('a signal aborted before the call rejects at once and sends nothing', async () => {
    const h = makeHarness();
    await h.client.preload();
    const controller = new AbortController();
    controller.abort();
    await expect(h.client.detect('text', controller.signal)).rejects.toBeInstanceOf(DetectionAbortedError);
    await settle();
    expect(h.provider.chunksRun).toBe(0);
    h.stop();
  });

  it('cancelDetect for an unknown or finished requestId is ignored', async () => {
    const provider = new ChunkedProvider();
    provider.chunks = 1;
    const engine = createEngine(makeEnv(), { providerId: 'gliner', regexEnabled: false }, { providers: { gliner: () => provider } });
    const replies: EngineResponse[] = [];
    const port: PortLike = {
      postMessage: (msg) => replies.push(msg as EngineResponse),
      onMessage: (cb) => { (port as unknown as { send: typeof cb }).send = cb; return () => {}; },
    };
    serveEngine(engine, port);
    const send = (port as unknown as { send: (m: unknown) => void }).send;
    await engine.preload();
    send({ type: 'cancelDetect', requestId: 999 });
    send({ type: 'detect', requestId: 1, text: 'hello' });
    await expect.poll(() => replies.some((r) => r.type === 'detected')).toBe(true);
    send({ type: 'cancelDetect', requestId: 1 });
    await settle();
    expect(replies.filter((r) => r.type === 'error' || r.type === 'detectError')).toEqual([]);
    // Validation: a cancelDetect without a numeric requestId is a protocol error.
    send({ type: 'cancelDetect' });
    await expect.poll(() => replies.some((r) => r.type === 'error')).toBe(true);
    expect(replies.find((r) => r.type === 'error')).toMatchObject({ error: expect.stringContaining('requestId must be a number') });
  });

  it('the wire reply of a cancelled detect is detectError { aborted: true } on the same requestId', async () => {
    const provider = new ChunkedProvider();
    const engine = createEngine(makeEnv(), { providerId: 'gliner', regexEnabled: false }, { providers: { gliner: () => provider } });
    const replies: EngineResponse[] = [];
    let send: (m: unknown) => void = () => {};
    serveEngine(engine, { postMessage: (msg) => replies.push(msg as EngineResponse), onMessage: (cb) => { send = cb; return () => {}; } });
    await engine.preload();
    send({ type: 'detect', requestId: 7, text: 'hello' });
    await expect.poll(() => replies.filter((r) => r.type === 'detectionProgress').length).toBeGreaterThan(1);
    send({ type: 'cancelDetect', requestId: 7 });
    await expect.poll(() => replies.some((r) => r.type === 'detectError')).toBe(true);
    expect(replies.find((r) => r.type === 'detectError')).toEqual({ type: 'detectError', requestId: 7, error: 'Detection aborted', aborted: true });
    expect(replies.some((r) => r.type === 'detected')).toBe(false);
  });

  it('a plain detect failure is not flagged as aborted', async () => {
    class Failing extends ChunkedProvider {
      override async detect(): Promise<DetectedEntity[]> { throw new Error('inference blew up'); }
    }
    const provider = new Failing();
    const engine = createEngine(makeEnv(), { providerId: 'gliner', regexEnabled: false }, { providers: { gliner: () => provider } });
    const replies: EngineResponse[] = [];
    let send: (m: unknown) => void = () => {};
    serveEngine(engine, { postMessage: (msg) => replies.push(msg as EngineResponse), onMessage: (cb) => { send = cb; return () => {}; } });
    await engine.preload();
    send({ type: 'detect', requestId: 3, text: 'hello' });
    await expect.poll(() => replies.some((r) => r.type === 'detectError')).toBe(true);
    expect(replies.find((r) => r.type === 'detectError')).toEqual({ type: 'detectError', requestId: 3, error: 'inference blew up', aborted: false });
  });
});

// ── Real providers: the check sits between chunks ──────────

type Loose = Record<string, unknown>;

function longText(words: number): string {
  return Array.from({ length: words }, (_, i) => `slowo${i}`).join(' ');
}

describe('providers stop at the next chunk boundary (T222)', () => {
  it('GlinerProvider', async () => {
    const p = new GlinerProvider(makeEnv());
    const loose = p as unknown as Loose;
    loose.session = {};
    loose.tokenizer = { encode: () => [1, 5, 2] };
    const controller = new AbortController();
    let calls = 0;
    vi.spyOn(p as unknown as { inferChunk: () => Promise<unknown[]> }, 'inferChunk').mockImplementation(async () => {
      calls++;
      if (calls === 2) controller.abort();
      return [];
    });
    await expect(p.detect(longText(1000), undefined, controller.signal)).rejects.toBeInstanceOf(DetectionAbortedError);
    expect(calls).toBe(2);
  });

  it('GlinerBaseProvider', async () => {
    const p = new GlinerBaseProvider(makeEnv());
    const loose = p as unknown as Loose;
    loose.session = {};
    loose.tokenizer = { encode: () => [1, 5, 2] };
    const controller = new AbortController();
    let calls = 0;
    vi.spyOn(p as unknown as { inferChunk: () => Promise<unknown[]> }, 'inferChunk').mockImplementation(async () => {
      calls++;
      if (calls === 2) controller.abort();
      return [];
    });
    await expect(p.detect(longText(1000), undefined, controller.signal)).rejects.toBeInstanceOf(DetectionAbortedError);
    expect(calls).toBe(2);
  });

  it('BardsaiProvider', async () => {
    const p = new BardsaiProvider(makeEnv());
    const loose = p as unknown as Loose;
    loose.session = {};
    loose.tokenizer = { tokenize: (s: string) => s.split(' ').map((w) => `▁${w}`) };
    const controller = new AbortController();
    let calls = 0;
    vi.spyOn(p as unknown as { inferChunk: () => Promise<unknown[]> }, 'inferChunk').mockImplementation(async () => {
      calls++;
      if (calls === 2) controller.abort();
      return [];
    });
    await expect(p.detect(longText(3000), undefined, controller.signal)).rejects.toBeInstanceOf(DetectionAbortedError);
    expect(calls).toBe(2);
  });

  it('an already aborted signal never reaches inference', async () => {
    const p = new GlinerProvider(makeEnv());
    const controller = new AbortController();
    controller.abort();
    await expect(p.detect('x', undefined, controller.signal)).rejects.toBeInstanceOf(DetectionAbortedError);
  });
});
