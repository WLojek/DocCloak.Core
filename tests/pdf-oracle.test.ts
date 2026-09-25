import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';
import { openWithOracle, oracleText, normalizeForCompare } from '../src/pdf/oracle.ts';
import type { CanvasFactory, CanvasHandle, OracleDocument, RenderedPage } from '../src/pdf/oracle.ts';
import { rasterizePage, userRectToPixels, padAndClamp } from '../src/pdf/raster.ts';
import { UnsupportedDocumentError } from '../src/dom/errors.ts';

const FIXTURES = join(__dirname, 'fixtures', 'pdf');
const PDFJS_DIR = join(__dirname, '..', 'node_modules', 'pdfjs-dist');
const ASSETS = {
  cMapUrl: join(PDFJS_DIR, 'cmaps') + '/',
  standardFontDataUrl: join(PDFJS_DIR, 'standard_fonts') + '/',
};

// @napi-rs/canvas is pdfjs-dist's optional dependency: when it is installed the
// last describe block checks real pixels; otherwise the recording factory is
// the only coverage. DOCCLOAK_TEST_NO_NAPI=1 forces the "not installed" path.
const napiSpecifier = '@napi-rs/canvas';
const napi = (await (process.env.DOCCLOAK_TEST_NO_NAPI ? Promise.resolve(undefined) : import(/* @vite-ignore */ napiSpecifier).catch(() => undefined))) as
  | { createCanvas(w: number, h: number): { getContext(t: '2d'): CanvasRenderingContext2D; toBuffer(mime: 'image/png'): Uint8Array; width: number; height: number } }
  | undefined;

// pdf.js draws paths through Path2D / DOMMatrix, which Node lacks. pdf.js
// polyfills both from @napi-rs/canvas when that is installed; give it inert
// stand-ins otherwise so the recording canvas below still works. They must be
// in place before pdf.js is (lazily) imported, and must NOT shadow the real
// ones, or pdf.js skips its polyfill and the real canvas rejects fake paths.
const g = globalThis as Record<string, unknown>;
if (!napi && typeof g.Path2D !== 'function') {
  g.Path2D = class FakePath2D {
    addPath(): void {}
    moveTo(): void {}
    lineTo(): void {}
    bezierCurveTo(): void {}
    quadraticCurveTo(): void {}
    rect(): void {}
    closePath(): void {}
  };
}
if (!napi && typeof g.DOMMatrix !== 'function') {
  g.DOMMatrix = class FakeDOMMatrix {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
    constructor(init?: number[]) {
      if (init && init.length >= 6) [this.a, this.b, this.c, this.d, this.e, this.f] = init;
    }
    invertSelf(): this { return this; }
    inverse(): FakeDOMMatrix { return new FakeDOMMatrix(); }
    multiply(): FakeDOMMatrix { return new FakeDOMMatrix(); }
    scale(): FakeDOMMatrix { return new FakeDOMMatrix(); }
    translate(): FakeDOMMatrix { return new FakeDOMMatrix(); }
    transformPoint(p: { x: number; y: number }): { x: number; y: number } { return p; }
  };
}

const pdfFixtures = readdirSync(FIXTURES).filter((f) => f.endsWith('.pdf')).sort();

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)));
}

interface FillCall { fillStyle: unknown; args: number[]; phase: 'render' | 'after' }

/**
 * A canvas double: the context is a Proxy that records fillRect calls (with
 * the fillStyle in force) and answers every other method pdf.js calls with a
 * no-op, so pdf.js can "render" a real page without a raster backend.
 */
function recordingCanvasFactory(): { factory: CanvasFactory; fills: FillCall[]; created: number[][]; setPhase(p: FillCall['phase']): void } {
  const fills: FillCall[] = [];
  const created: number[][] = [];
  let phase: FillCall['phase'] = 'render';
  const MARKER = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0xaa]);

  const create = (width: number, height: number): CanvasHandle => {
    created.push([width, height]);
    const state: Record<string | symbol, unknown> = {
      fillStyle: '#000000',
      strokeStyle: '#000000',
      globalAlpha: 1,
      globalCompositeOperation: 'source-over',
      lineWidth: 1,
      font: '10px sans-serif',
    };
    const DOMMatrixCtor = g.DOMMatrix as new (init?: number[]) => unknown;
    const methods: Record<string, unknown> = {
      fillRect: (...args: number[]) => { fills.push({ fillStyle: state.fillStyle, args, phase }); },
      measureText: () => ({ width: 0, actualBoundingBoxLeft: 0, actualBoundingBoxRight: 0 }),
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      getTransform: () => new DOMMatrixCtor(),
      createPattern: () => ({ setTransform() {} }),
      createLinearGradient: () => ({ addColorStop() {} }),
      createRadialGradient: () => ({ addColorStop() {} }),
      isPointInPath: () => false,
      getLineDash: () => [],
    };
    const context = new Proxy(state, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (typeof prop === 'symbol') return undefined;
        if (prop === 'then') return undefined;
        if (prop in methods) return methods[prop];
        return () => undefined;
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
    const canvas = { width, height, getContext: () => context };
    state.canvas = canvas;
    return {
      canvas,
      context,
      toPng: async () => MARKER,
      getImageData: () => new Uint8ClampedArray(width * height * 4),
    };
  };
  return { factory: { create }, fills, created, setPhase: (p) => { phase = p; } };
}

describe('pdf.js oracle', () => {
  it('opens every static fixture and extracts page text', async () => {
    expect(pdfFixtures.length).toBeGreaterThan(0);
    for (const name of pdfFixtures) {
      const doc = await openWithOracle(fixture(name), ASSETS);
      try {
        expect(doc.pageCount, name).toBeGreaterThanOrEqual(1);
        const text = await doc.pageText(0);
        expect(typeof text, name).toBe('string');
        const size = await doc.pageSize(0);
        expect(size.width, name).toBeGreaterThan(0);
        expect(size.height, name).toBeGreaterThan(0);
        expect([0, 90, 180, 270], name).toContain(size.rotate);
      } finally {
        await doc.close();
      }
    }
  });

  it('is stable across two extractions of the same file', async () => {
    const a = await openWithOracle(fixture('chrome-skia-type0.pdf'), ASSETS);
    const b = await openWithOracle(fixture('chrome-skia-type0.pdf'), ASSETS);
    try {
      expect(await oracleText(a)).toEqual(await oracleText(b));
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('reads the Type0 (Chrome/Skia) fixture text', async () => {
    const doc = await openWithOracle(fixture('chrome-skia-type0.pdf'), ASSETS);
    try {
      const text = await doc.pageText(0);
      expect(text).toContain('Jan Kowalski');
      expect(text).toContain('PESEL 90010112345');
      // hasEOL items end their line
      expect(text).toContain('\n');
      const pages = await oracleText(doc);
      expect(pages).toHaveLength(doc.pageCount);
      expect(pages[0]).toBe(text);
    } finally {
      await doc.close();
    }
  });

  it('rejects out-of-range page indexes', async () => {
    const doc = await openWithOracle(fixture('baseline_text.pdf'), ASSETS);
    try {
      await expect(doc.pageText(doc.pageCount)).rejects.toThrow(RangeError);
      await expect(doc.pageText(-1)).rejects.toThrow(RangeError);
    } finally {
      await doc.close();
    }
  });

  it('normalizeForCompare strips whitespace, soft hyphens and spells out ligatures', () => {
    expect(normalizeForCompare('Jan  Kow­alski\n ﬁ')).toBe('JanKowalskifi');
    expect(normalizeForCompare('é')).toBe('é'); // NFC
    expect(normalizeForCompare('a​b c⁠d﻿e‪f')).toBe('abcdef');
    expect(normalizeForCompare('ﬀﬂﬃﬄ')).toBe('ffflffiffl');
    expect(normalizeForCompare('')).toBe('');
  });

  it('refuses an encrypted PDF without the password and opens it with the password', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage().drawText('secret');
    pdf.encrypt({ userPassword: 'x', ownerPassword: 'y' });
    const bytes = await pdf.save();

    let caught: unknown;
    try {
      await openWithOracle(bytes, ASSETS);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnsupportedDocumentError);
    expect((caught as UnsupportedDocumentError).code).toBe('encrypted');

    caught = undefined;
    try {
      await openWithOracle(bytes, ASSETS, 'wrong');
    } catch (err) {
      caught = err;
    }
    expect((caught as UnsupportedDocumentError).code).toBe('encrypted');

    const doc = await openWithOracle(bytes, ASSETS, 'x');
    try {
      expect(doc.pageCount).toBe(1);
      expect(await doc.pageText(0)).toContain('secret');
    } finally {
      await doc.close();
    }
  });

  it('reports garbage as invalid-package', async () => {
    let caught: unknown;
    try {
      await openWithOracle(new TextEncoder().encode('this is not a pdf at all'), ASSETS);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnsupportedDocumentError);
    expect((caught as UnsupportedDocumentError).code).toBe('invalid-package');
  });

  it('does not neuter the caller buffer', async () => {
    const bytes = fixture('baseline_text.pdf');
    const before = bytes.byteLength;
    const doc = await openWithOracle(bytes, ASSETS);
    await doc.close();
    expect(bytes.byteLength).toBe(before);
    expect(bytes.buffer.byteLength).toBe(before);
  });
});

describe('rect to pixel mapping', () => {
  it('flips y and scales (scale 2, 612x792 page)', () => {
    const transform = [2, 0, 0, -2, 0, 1584];
    expect(userRectToPixels(transform, { x0: 10, y0: 782, x1: 20, y1: 792 })).toEqual({ x: 20, y: 0, w: 20, h: 20 });
    expect(userRectToPixels(transform, { x0: 0, y0: 0, x1: 612, y1: 792 })).toEqual({ x: 0, y: 0, w: 1224, h: 1584 });
  });

  it('rounds outwards to whole pixels', () => {
    const transform = [1, 0, 0, -1, 0, 100];
    expect(userRectToPixels(transform, { x0: 10.2, y0: 49.5, x1: 20.7, y1: 60.1 })).toEqual({ x: 10, y: 39, w: 11, h: 12 });
  });

  it('handles a 90 degree rotation (axes swap)', () => {
    // pdf.js viewport for a 612x792 page with /Rotate 90 at scale 1:
    // canvas is 792 wide and 612 high, transform [0 1 1 0 0 0].
    const transform = [0, 1, 1, 0, 0, 0];
    expect(userRectToPixels(transform, { x0: 10, y0: 20, x1: 30, y1: 50 })).toEqual({ x: 20, y: 10, w: 30, h: 20 });
    // and the /Rotate 270 counterpart: [0 -1 -1 0 792 612]
    const t270 = [0, -1, -1, 0, 792, 612];
    expect(userRectToPixels(t270, { x0: 10, y0: 20, x1: 30, y1: 50 })).toEqual({ x: 742, y: 582, w: 30, h: 20 });
  });

  it('pads and clamps to the canvas', () => {
    expect(padAndClamp({ x: 20, y: 0, w: 20, h: 20 }, 1, 1224, 1584)).toEqual({ x: 19, y: 0, w: 22, h: 21 });
    expect(padAndClamp({ x: 2000, y: 0, w: 20, h: 20 }, 1, 1224, 1584)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    expect(padAndClamp({ x: 1220, y: 1580, w: 20, h: 20 }, 1, 1224, 1584)).toEqual({ x: 1219, y: 1579, w: 5, h: 5 });
  });
});

describe('rasterizePage', () => {
  it('renders through pdf.js with an injected canvas factory and paints the black box after the render', async () => {
    const doc = await openWithOracle(fixture('chrome-skia-type0.pdf'), ASSETS);
    const rec = recordingCanvasFactory();
    try {
      const originalRender = doc.render;
      const renderSpy = vi.spyOn(doc, 'render');
      renderSpy.mockImplementation(async (...args: Parameters<OracleDocument['render']>) => {
        const page = await originalRender.apply(doc, args);
        rec.setPhase('after');
        return page;
      });

      const result = await rasterizePage(doc, 0, [{ x0: 100, y0: 700, x1: 150, y1: 710 }], { dpi: 144, canvasFactory: rec.factory });

      expect(renderSpy).toHaveBeenCalledWith(0, 2, rec.factory);
      // The page canvas came from our factory at the viewport size (612x792 pt at scale 2).
      expect(rec.created[0]).toEqual([1224, 1584]);
      expect(result.widthPx).toBe(1224);
      expect(result.heightPx).toBe(1584);
      expect(result.widthPt).toBeCloseTo(612, 5);
      expect(result.heightPt).toBeCloseTo(792, 5);
      expect(Array.from(result.png)).toEqual([0x89, 0x50, 0x4e, 0x47, 0xaa]);

      // pdf.js painted something during the render (at least the white background)...
      expect(rec.fills.some((f) => f.phase === 'render')).toBe(true);
      // ...and afterwards exactly one black box, in pixel coordinates, padded by 1 px:
      // user (100..150, 700..710) -> x 200..300, y 1584-1420=164 .. 1584-1400=184.
      const after = rec.fills.filter((f) => f.phase === 'after');
      expect(after).toHaveLength(1);
      expect(after[0].fillStyle).toBe('#000000');
      expect(after[0].args).toEqual([199, 163, 102, 22]);
    } finally {
      await doc.close();
    }
  });

  it('paints every box and skips boxes outside the page (render mocked)', async () => {
    const rec = recordingCanvasFactory();
    const handle = rec.factory.create(200, 100);
    const rendered: RenderedPage = {
      widthPx: 200,
      heightPx: 100,
      widthPt: 200,
      heightPt: 100,
      transform: [1, 0, 0, -1, 0, 100],
      canvas: handle,
    };
    const doc: OracleDocument = {
      pageCount: 1,
      pageText: async () => '',
      pageItems: async () => [],
      pageSize: async () => ({ width: 200, height: 100, rotate: 0 }),
      render: vi.fn(async () => rendered),
      close: async () => {},
    };
    const result = await rasterizePage(doc, 0, [
      { x0: 10, y0: 80, x1: 20, y1: 90 },
      { x0: 150, y0: 0, x1: 210, y1: 10 }, // partly outside: clamped
      { x0: 500, y0: 500, x1: 600, y1: 600 }, // fully outside: skipped
    ], { dpi: 72 });
    expect(doc.render).toHaveBeenCalledWith(0, 1, undefined);
    expect(rec.fills.map((f) => f.args)).toEqual([
      [9, 9, 12, 12],
      [149, 89, 51, 11],
    ]);
    expect(rec.fills.every((f) => f.fillStyle === '#000000')).toBe(true);
    expect(result).toMatchObject({ widthPx: 200, heightPx: 100, widthPt: 200, heightPt: 100 });
    expect(result.png).toBeInstanceOf(Uint8Array);
  });

  it('rejects a non-positive dpi', async () => {
    const doc = await openWithOracle(fixture('baseline_text.pdf'), ASSETS);
    try {
      await expect(rasterizePage(doc, 0, [], { dpi: 0 })).rejects.toThrow(RangeError);
    } finally {
      await doc.close();
    }
  });
});

describe.skipIf(!napi)('rasterizePage with @napi-rs/canvas', () => {
  function napiFactory(): CanvasFactory {
    return {
      create(width, height) {
        const canvas = napi!.createCanvas(width, height);
        const context = canvas.getContext('2d');
        return {
          canvas,
          context,
          toPng: async () => new Uint8Array(canvas.toBuffer('image/png')),
          getImageData: () => context.getImageData(0, 0, canvas.width, canvas.height).data,
        };
      },
    };
  }

  it('produces a PNG whose pixels under the box are black and elsewhere white', async () => {
    const doc = await openWithOracle(fixture('chrome-skia-type0.pdf'), ASSETS);
    const factory = napiFactory();
    let handle: CanvasHandle | undefined;
    const wrapped: CanvasFactory = {
      create(w, h) {
        const created = factory.create(w, h);
        handle ??= created;
        return created;
      },
    };
    try {
      // "Jan Kowalski, PESEL ..." sits at y ~704 (baseline), x from ~34.
      const box = { x0: 30, y0: 700, x1: 300, y1: 716 };
      const result = await rasterizePage(doc, 0, [box], { dpi: 36, canvasFactory: wrapped });
      expect(result.widthPx).toBe(306);
      expect(result.heightPx).toBe(396);
      // PNG signature
      expect(Array.from(result.png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

      const pixels = handle!.getImageData();
      const at = (x: number, y: number) => Array.from(pixels.subarray((y * result.widthPx + x) * 4, (y * result.widthPx + x) * 4 + 3));
      const px = userRectToPixels([0.5, 0, 0, -0.5, 0, 396], box);
      // every pixel inside the box is black
      for (let y = px.y; y < px.y + px.h; y += 2) {
        for (let x = px.x; x < px.x + px.w; x += 7) {
          expect(at(x, y), `pixel ${x},${y}`).toEqual([0, 0, 0]);
        }
      }
      // the page background outside any content is white
      expect(at(5, 5)).toEqual([255, 255, 255]);
      expect(at(result.widthPx - 5, result.heightPx - 5)).toEqual([255, 255, 255]);
      // and something was actually drawn elsewhere (the title line above the box is not all white)
      const titleRow = Math.round(396 - 745 * 0.5);
      let dark = 0;
      for (let x = 15; x < 100; x++) if (at(x, titleRow)[0] < 200) dark++;
      expect(dark).toBeGreaterThan(0);
    } finally {
      await doc.close();
    }
  });
});
