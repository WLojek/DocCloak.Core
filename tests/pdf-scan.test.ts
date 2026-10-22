// T235: scan pages with an OCR text layer. The values found in the layer are painted over in
// the picture (paper-coloured cover + placeholder label) and the page is exported as an image;
// pages without text stay untouched; text-layer pages are edited in place as before.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, PDFDict, PDFName, PDFRawStream } from '@cantoo/pdf-lib';
import { readPdf, writeAnonymizedPdfWithReport, extractPdf } from '../src/pdf/index.ts';
import type { PdfAssetPaths } from '../src/pdf/index.ts';
import { decodeStream, getDict, getName, getNumber } from '../src/pdf/objects.ts';
import { StateMachine, initialState } from '../src/pdf/textstate.ts';
import { inkExtent, packPixels } from '../src/pdf/raster.ts';
import type { PaintMark } from '../src/pdf/raster.ts';
import { paintMarksForPage } from '../src/pdf/write.ts';
import { segmentsFor } from '../src/pdf/surgery.ts';
import { lexContent } from '../src/pdf/lexer.ts';
import { nodeCanvasFactory } from './helpers/pdf-canvas.ts';
import { buildScanPdf } from './helpers/fixtures/pdf-scan.ts';
import type { ScanPageSpec } from './helpers/fixtures/pdf-scan.ts';
import { writeOutput } from './helpers/package-scan.ts';

const FONTS = join(__dirname, '..', 'fonts', 'liberation');
const ASSETS: PdfAssetPaths = { loadFont: async (file) => new Uint8Array(readFileSync(join(FONTS, file))) };

const LINES = [
  ['Umowa', 'zawarta', 'z', 'Kowalski', 'Jan,', 'Warszawa.'],
  ['Telefon', 'kontaktowy', '600123456', 'w', 'godzinach', 'pracy.'],
  ['Podpisano', 'przez', 'Nowak', 'Anna', 'dnia', 'dzisiejszego.'],
];
const VALUES = ['Kowalski', '600123456', 'Nowak', 'Anna'];

function scanPage(layer: ScanPageSpec['layer'], ocrScale?: number): ScanPageSpec {
  return { kind: 'scan', lines: LINES, values: VALUES, layer, ...(ocrScale ? { ocrScale } : {}) };
}

function spans(text: string, value: string, replacement: string): Array<{ start: number; end: number; replacement: string }> {
  const out: Array<{ start: number; end: number; replacement: string }> = [];
  for (let i = text.indexOf(value); i >= 0; i = text.indexOf(value, i + value.length)) out.push({ start: i, end: i + value.length, replacement });
  expect(out.length, `"${value}" not found`).toBeGreaterThan(0);
  return out;
}

const PLACEHOLDERS: Record<string, string> = { Kowalski: '[PERSON_1]', '600123456': '[PHONE_1]', Nowak: '[PERSON_2]', Anna: '[PERSON_3]' };

async function redactScan(bytes: Uint8Array, name: string) {
  const extraction = await readPdf(bytes, { assets: ASSETS });
  const replacements = VALUES.flatMap((v) => spans(extraction.plainText, v, PLACEHOLDERS[v]));
  const result = await writeAnonymizedPdfWithReport(extraction, replacements, VALUES.map((v) => ({ value: v, replacement: PLACEHOLDERS[v] })), {
    assets: ASSETS, allowUnredactable: true, canvasFactory: await nodeCanvasFactory(),
  });
  const out = new Uint8Array(await result.blob.arrayBuffer());
  writeOutput(`pdf-scan-${name}-redacted.pdf`, out);
  return { extraction, result, out };
}

/** The single image XObject of an output page, decoded: pixels, channels and size. */
async function pageImage(bytes: Uint8Array, index: number): Promise<{ pixels: Uint8Array; channels: number; width: number; height: number; raw: Uint8Array }> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const page = doc.getPages()[index];
  const xobjects = getDict(doc.context, page.node.Resources(), 'XObject');
  const images: PDFRawStream[] = [];
  for (const [, v] of xobjects?.entries() ?? []) {
    const s = doc.context.lookup(v);
    if (s instanceof PDFRawStream && getName(doc.context, s.dict, 'Subtype') === 'Image') images.push(s);
  }
  expect(images).toHaveLength(1);
  const img = images[0];
  const cs = getName(doc.context, img.dict, 'ColorSpace');
  return {
    pixels: decodeStream(doc.context, img),
    channels: cs === 'DeviceGray' ? 1 : 3,
    width: getNumber(doc.context, img.dict, 'Width') ?? 0,
    height: getNumber(doc.context, img.dict, 'Height') ?? 0,
    raw: img.contents,
  };
}

/** Pixels where red clearly dominates: what is left of a value painted red in the scan. */
function redPixels(img: { pixels: Uint8Array; channels: number }): number {
  if (img.channels === 1) return 0;
  let n = 0;
  for (let i = 0; i < img.pixels.length; i += 3) {
    const r = img.pixels[i];
    if (r - Math.max(img.pixels[i + 1], img.pixels[i + 2]) > 60) n++;
  }
  return n;
}

function darkPixelsIn(img: { pixels: Uint8Array; channels: number; width: number }, box: { x0: number; y0: number; x1: number; y1: number }): number {
  let n = 0;
  for (let y = Math.floor(box.y0); y < Math.ceil(box.y1); y++) {
    for (let x = Math.floor(box.x0); x < Math.ceil(box.x1); x++) {
      const i = (y * img.width + x) * img.channels;
      if (img.pixels[i] < 100) n++;
    }
  }
  return n;
}

async function pageText(bytes: Uint8Array): Promise<string> {
  return (await extractPdf(bytes)).plainText;
}

describe('scan pages with an OCR text layer (T235)', () => {
  for (const [layer, scale] of [['alpha', 1], ['tr3', 0.85], ['under', 0.9]] as const) {
    it(`${layer} layer${scale !== 1 ? ` (OCR letters at ${scale} of the picture's)` : ''}: values painted over in the picture, page exported as an image`, async () => {
      const scan = await buildScanPdf([scanPage(layer, scale)]);
      if (!scan) return; // no native canvas here
      const { extraction, result, out } = await redactScan(scan.bytes, layer);
      expect(extraction.pages[0]).toMatchObject({ hasImages: true, imageOnly: true, ocrText: true });
      expect(extraction.unredactable).toEqual([]);
      expect(extraction.runs.every((r) => r.hidden && r.ocr)).toBe(true);
      expect(result.scanPages).toEqual([0]);
      expect(result.rasterizedPages).toEqual([]);

      const before = await pageImage(scan.bytes, 0);
      const after = await pageImage(out, 0);
      expect(redPixels(before)).toBeGreaterThan(500);
      expect(redPixels(after)).toBe(0); // no fragment of any value survives
      // Rendered at the scan's own resolution (pdf.js rounds the canvas up); the words that are not values are untouched.
      expect(after.width - before.width).toBeGreaterThanOrEqual(0);
      expect(after.width - before.width).toBeLessThanOrEqual(1);
      expect(after.height - before.height).toBeLessThanOrEqual(1);
      for (const w of scan.words.filter((x) => !x.value && x.text !== 'z' && x.text !== 'w')) {
        const was = darkPixelsIn(before, w);
        expect(Math.abs(darkPixelsIn(after, w) - was), w.text).toBeLessThanOrEqual(Math.max(3, was * 0.05));
      }
      // Each value's place now holds dark label pixels (its placeholder), not blank paper.
      for (const w of scan.words.filter((x) => x.value && x.text !== 'Anna')) {
        expect(darkPixelsIn(after, w), w.text).toBeGreaterThan(20);
      }
      // The output page carries no text layer at all.
      expect((await pageText(out)).trim()).toBe('');
    });
  }

  it('a mixed file: the OCR page is painted, the picture-only page stays byte-identical, the text page is edited in place', async () => {
    const scan = await buildScanPdf([
      scanPage('alpha'),
      { kind: 'scan', lines: LINES, values: [], layer: 'none' },
      { kind: 'text', lines: ['Klient: Kowalski Jan', 'Telefon 600123456'] },
    ]);
    if (!scan) return;
    const { extraction, result, out } = await redactScan(scan.bytes, 'mixed');
    expect(extraction.pages.map((p) => [p.imageOnly, p.ocrText])).toEqual([[true, true], [true, false], [false, false]]);
    expect(extraction.unredactable).toEqual([{ part: 'page 2', kind: 'scanned-page', label: expect.stringContaining('without a text layer') }]);
    expect(result.scanPages).toEqual([0]);
    expect(result.rasterizedPages).toEqual([]);
    expect((await pageImage(out, 1)).raw).toEqual((await pageImage(scan.bytes, 1)).raw);
    const text = await pageText(out);
    expect(text).toContain('Klient: [PERSON_1] Jan');
    expect(text).toContain('[PHONE_1]');
    expect(text).not.toMatch(/Kowalski|600123456|Nowak/);
  });

  it('a scan without any OCR text is not painted: it stays an unredactable scanned page', async () => {
    const scan = await buildScanPdf([{ kind: 'scan', lines: LINES, values: [], layer: 'none' }]);
    if (!scan) return;
    const extraction = await readPdf(scan.bytes, { assets: ASSETS });
    expect(extraction.empty).toBe(true);
    expect(extraction.pages[0]).toMatchObject({ imageOnly: true, ocrText: false });
    expect(extraction.unredactable.map((u) => u.kind)).toEqual(['scanned-page']);
  });
});

describe('transparent text (ExtGState alpha)', () => {
  async function onePage(content: string, gstate: Record<string, number>): Promise<Uint8Array> {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const { StandardFonts } = await import('@cantoo/pdf-lib');
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([400, 200]);
    page.node.setFontDictionary(PDFName.of('F1'), font.ref);
    page.node.Resources()?.set(PDFName.of('ExtGState'), doc.context.obj({ G0: { Type: 'ExtGState', ...gstate } }));
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(new TextEncoder().encode(content))));
    return doc.save({ useObjectStreams: false });
  }

  it('text under /ca 0 is hidden; with no image under it, it is not OCR text and is edited in place', async () => {
    const bytes = await onePage('BT /F1 12 Tf 40 120 Td (Visible line) Tj ET q /G0 gs BT /F1 12 Tf 40 100 Td (Jan Kowalski) Tj ET Q', { ca: 0 });
    const ex = await readPdf(bytes, { assets: ASSETS });
    const hidden = ex.runs.filter((r) => r.hidden).map((r) => r.glyphs.map((g) => g.unicode).join(''));
    expect(hidden).toEqual(['Jan Kowalski']);
    expect(ex.runs.some((r) => r.ocr)).toBe(false);
    expect(ex.pages[0]).toMatchObject({ hasImages: false, ocrText: false });
    const result = await writeAnonymizedPdfWithReport(ex, spans(ex.plainText, 'Jan Kowalski', '[PERSON_1]'), [], { assets: ASSETS });
    expect(result.scanPages).toEqual([]);
    expect(result.rasterizedPages).toEqual([]);
    expect(await pageText(new Uint8Array(await result.blob.arrayBuffer()))).toContain('[PERSON_1]');
  });

  it('half-transparent text stays visible; Q restores the alpha', async () => {
    const bytes = await onePage('q /G0 gs BT /F1 12 Tf 40 100 Td (Half) Tj ET Q BT /F1 12 Tf 40 80 Td (Full) Tj ET', { ca: 0.5 });
    const ex = await readPdf(bytes);
    expect(ex.runs.map((r) => r.hidden)).toEqual([false, false]);
  });

  it('the state machine reads ca / CA through the resolver and restores them with Q', () => {
    const sm = new StateMachine(initialState());
    const ops = lexContent(new TextEncoder().encode('q /A gs /B gs Q'));
    const resolve = (name: string) => (name === 'A' ? { fillAlpha: 0 } : name === 'B' ? { strokeAlpha: 0.25 } : undefined);
    sm.update(ops[0], () => undefined, resolve);
    sm.update(ops[1], () => undefined, resolve);
    expect(sm.state.fillAlpha).toBe(0);
    sm.update(ops[2], () => undefined, resolve);
    expect([sm.state.fillAlpha, sm.state.strokeAlpha]).toEqual([0, 0.25]);
    sm.update(ops[3], () => undefined, resolve);
    expect([sm.state.fillAlpha, sm.state.strokeAlpha]).toEqual([1, 1]);
  });
});

describe('scan painting helpers', () => {
  it('packPixels keeps a gray page in one channel and a colour page in three', () => {
    const gray = new Uint8ClampedArray([10, 10, 10, 255, 200, 200, 200, 255]);
    expect(packPixels(gray)).toEqual({ pixels: new Uint8Array([10, 200]), channels: 1 });
    const colour = new Uint8ClampedArray([10, 10, 10, 255, 200, 0, 0, 255]);
    expect(packPixels(colour)).toEqual({ pixels: new Uint8Array([10, 10, 10, 200, 0, 0]), channels: 3 });
  });

  it('inkExtent grows a cover to the end of a word whose ink runs past the OCR layer, and stops at the word space', () => {
    // 200 x 40 white canvas, 1 px per user unit, baseline at y = 30 (up is -y). Ink: a word from
    // x 20 to 90 (letters with 2 px gaps), a space, the next word from 110 to 160.
    const width = 200;
    const height = 40;
    const rgba = new Uint8ClampedArray(width * height * 4).fill(255);
    const ink = (x0: number, x1: number) => {
      for (let x = x0; x < x1; x++) {
        if ((x - x0) % 10 >= 8) continue; // 2 px gaps between "letters"
        for (let y = 18; y < 30; y++) rgba.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
      }
    };
    ink(20, 90);
    ink(110, 160);
    const m: PaintMark = { x: 30, y: 30, ux: 1, uy: 0, vx: 0, vy: -1, length: 45, size: 16, label: '[X]' };
    const at = (along: number, up: number): [number, number] => [m.x + along, m.y - up];
    const ext = inkExtent(rgba, width, height, at, m, 0.6);
    expect(ext.start).toBeLessThanOrEqual(-10); // back to the word's first letter at x 20
    expect(ext.start).toBeGreaterThan(-12);
    expect(ext.end).toBeGreaterThanOrEqual(58); // the word's last letter ends at x 88
    expect(ext.end).toBeLessThan(80); // the next word (x 110) is not swallowed
  });

  it('paintMarksForPage joins the pieces of a value on one line and blanks its wrapped part', async () => {
    const { PDFDocument: Doc, StandardFonts } = await import('@cantoo/pdf-lib');
    const doc = await Doc.create({ updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([400, 200]);
    page.node.setFontDictionary(PDFName.of('F1'), font.ref);
    const content = 'BT /F1 12 Tf 40 150 Td (Pan Jan ) Tj (Maria ) Tj (Kowal-) Tj ET BT /F1 12 Tf 40 135 Td (ska mieszka tu.) Tj ET';
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(new TextEncoder().encode(content))));
    const ex = await extractPdf(await doc.save({ useObjectStreams: false }));
    const start = ex.plainText.indexOf('Jan');
    const end = ex.plainText.indexOf('ska') + 3;
    const reps = [{ start, end, replacement: '[PERSON_1]' }];
    const marks = paintMarksForPage(segmentsFor(ex.runs, reps), 0, reps);
    expect(marks.map((m) => m.label)).toEqual(['[PERSON_1]', '']);
    // Helvetica widths (no kerning: Tj does not kern): "Pan " 2057, "Jan Maria Kowal-" 7724, "ska" 1556 units.
    expect(marks[0].x).toBeCloseTo(40 + 2.057 * 12, 2);
    expect(marks[0].length).toBeCloseTo(7.724 * 12, 2);
    expect(marks[1]).toMatchObject({ x: 40, y: 135, label: '' });
    expect(marks[1].length).toBeCloseTo(1.556 * 12, 2);
    void font;
    void PDFDict;
  });
});
