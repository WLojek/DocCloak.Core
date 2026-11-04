// T248: recognizeCanvasLines reads with up to `workers` Tesseract workers at the same time, one
// region per worker, and releaseOcrWorker ends them all. Tesseract is replaced by a stand-in that
// records which worker reads when.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { recognizeCanvasLines, releaseOcrWorker } from '../src/dom/ocr.ts';

const state = vi.hoisted(() => ({
  created: 0,
  failNext: 0,
  delay: 20,
  busy: new Set<number>(),
  most: 0,
  shared: false,
  terminated: [] as number[],
}));

vi.mock('tesseract.js', () => ({
  PSM: { AUTO: '3', SINGLE_COLUMN: '4', SINGLE_BLOCK: '6' },
  createWorker: async () => {
    const id = ++state.created;
    await new Promise((r) => setTimeout(r, 5));
    if (state.failNext > 0) {
      state.failNext--;
      throw new Error('worker failed to start');
    }
    return {
      setParameters: async () => {},
      recognize: async () => {
        if (state.busy.has(id)) state.shared = true;
        state.busy.add(id);
        state.most = Math.max(state.most, state.busy.size);
        await new Promise((r) => setTimeout(r, state.delay));
        state.busy.delete(id);
        return { data: { blocks: [] } };
      },
      terminate: async () => {
        state.terminated.push(id);
      },
    };
  },
}));

const ASSETS = { workerPath: '/w.js', corePath: '/core', langPath: 'https://x/lang' };
const canvas = {} as HTMLCanvasElement;
const read = (workers?: number) => recognizeCanvasLines(canvas, 'pl', ASSETS, 300, { wholePage: false, ...(workers !== undefined ? { workers } : {}) });

beforeEach(() => {
  Object.assign(state, { created: 0, failNext: 0, delay: 20, most: 0, shared: false, terminated: [] });
  state.busy.clear();
});

afterEach(async () => {
  await releaseOcrWorker();
});

describe('Tesseract workers for the pages of a document (T248)', () => {
  it('reads as many regions at once as there are workers, never two on one worker', async () => {
    await Promise.all(Array.from({ length: 7 }, () => read(3)));
    expect(state.created).toBe(3);
    expect(state.most).toBe(3);
    expect(state.shared).toBe(false);
  });

  it('starts only the workers the regions need', async () => {
    await read(4);
    await read(4);
    expect(state.created).toBe(1);
  });

  it('one worker by default (or for a count that is not a number): the regions are read one after another', async () => {
    await Promise.all([read(), read(), read()]);
    expect(state.created).toBe(1);
    expect(state.most).toBe(1);
    await releaseOcrWorker();
    await Promise.all([read(Number.NaN), read(0), read(-2)]);
    expect(state.created).toBe(2);
    expect(state.most).toBe(1);
  });

  it('keeps the workers between calls and ends them all when released', async () => {
    await Promise.all([read(2), read(2)]);
    await read(2);
    expect(state.created).toBe(2);
    await releaseOcrWorker();
    expect(state.terminated.sort()).toEqual([1, 2]);
    await read(2);
    expect(state.created).toBe(3);
  });

  it('a worker that fails to start is not kept: a call waiting for it starts another', async () => {
    state.failNext = 1;
    const results = await Promise.allSettled([read(1), read(1)]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled']);
    expect(state.created).toBe(2);
  });

  it('released while calls wait for a worker: those calls fail instead of waiting for ever', async () => {
    state.delay = 50;
    const first = read(1);
    const waiting = read(1);
    await new Promise((r) => setTimeout(r, 15));
    await releaseOcrWorker();
    await expect(waiting).rejects.toThrow(/released/);
    await first;
  });
});
