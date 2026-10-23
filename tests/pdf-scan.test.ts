// T235: scan pages with an OCR text layer. The values found in the layer are painted over in
// the picture (paper-coloured cover + placeholder label) and the page is exported as an image;
// pages without text stay untouched; text-layer pages are edited in place as before.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, PDFDict, PDFName, PDFRawStream, PDFString, degrees } from '@cantoo/pdf-lib';
import { readPdf, writeAnonymizedPdfWithReport, extractPdf, verifyPdf } from '../src/pdf/index.ts';
import type { PdfAssetPaths } from '../src/pdf/index.ts';
import { decodeStream, getDict, getName, getNumber } from '../src/pdf/objects.ts';
import { StateMachine, initialState } from '../src/pdf/textstate.ts';
import { blankAfter, inkExtent, packPixels } from '../src/pdf/raster.ts';
import { findTextWithoutOcr } from '../src/pdf/coverage.ts';
import type { PaintMark } from '../src/pdf/raster.ts';
import { paintMarksForPage, withTextColumn } from '../src/pdf/write.ts';
import { segmentsFor } from '../src/pdf/surgery.ts';
import { lexContent } from '../src/pdf/lexer.ts';
import { nodeCanvasFactory } from './helpers/pdf-canvas.ts';
import { buildScanPdf, SCAN_DPI } from './helpers/fixtures/pdf-scan.ts';
import type { ScanPageSpec } from './helpers/fixtures/pdf-scan.ts';
import { writeOutput } from './helpers/package-scan.ts';

const FONTS = join(__dirname, '..', 'fonts', 'liberation');
const ASSETS: PdfAssetPaths = { loadFont: async (file) => new Uint8Array(readFileSync(join(FONTS, file))) };

const LINES = [
  ['Umowa', 'zawarta', 'z', 'Kowalski', 'Jan,', 'Warszawa.'],
  ['Telefon', 'kontaktowy', '600123456', 'w', 'godzinach', 'pracy.'],
  ['Podpisano', 'przez', 'Nowak', 'Anna', 'dnia', 'dzisiejszego.'],
  // A long value: with OCR letters narrower than the print, the layer ends well short of its ink.
  ['Kontakt:', 'jan.kowalski@example.com', 'lub', 'biuro.'],
];
const VALUES = ['Kowalski', '600123456', 'Nowak', 'Anna', 'jan.kowalski@example.com'];

function scanPage(layer: ScanPageSpec['layer'], ocrScale?: number): ScanPageSpec {
  return { kind: 'scan', lines: LINES, values: VALUES, layer, ...(ocrScale ? { ocrScale } : {}) };
}

function spans(text: string, value: string, replacement: string): Array<{ start: number; end: number; replacement: string }> {
  const out: Array<{ start: number; end: number; replacement: string }> = [];
  for (let i = text.indexOf(value); i >= 0; i = text.indexOf(value, i + value.length)) out.push({ start: i, end: i + value.length, replacement });
  expect(out.length, `"${value}" not found`).toBeGreaterThan(0);
  return out;
}

const PLACEHOLDERS: Record<string, string> = { Kowalski: '[PERSON_1]', '600123456': '[PHONE_1]', Nowak: '[PERSON_2]', Anna: '[PERSON_3]', 'jan.kowalski@example.com': '[EMAIL_1]' };

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
      for (const w of scan.words.filter((x) => !x.value)) {
        const was = darkPixelsIn(before, w);
        expect(Math.abs(darkPixelsIn(after, w) - was), w.text).toBeLessThanOrEqual(Math.max(3, was * 0.05));
      }
      // Each value's place now holds dark label pixels (its placeholder), not blank paper.
      for (const w of scan.words.filter((x) => x.value && x.text !== 'Anna')) {
        expect(darkPixelsIn(after, w), w.text).toBeGreaterThan(20);
      }
      // The page stays searchable: its text with the placeholders, none of the values.
      const text = await pageText(out);
      expect(text).toContain('Umowa zawarta z [PERSON_1] Jan, Warszawa.');
      expect(text).toContain('[EMAIL_1]');
      expect(text).not.toMatch(/Kowalski|600123456|Nowak|Anna|jan\.kowalski@example\.com/);
    });
  }

  it('Tesseract layout (one word per show, equal letter widths): values with glued punctuation are covered to the last pixel', async () => {
    const lines = [
      ['Telefon:', '+48', '527', '870', '616,', 'e-mail', 'anna.nowak@example.com).'],
      ['Adres:', 'ul.', 'Dluga', '12/4,', '31-147', 'Krakow.'],
      ['PESEL', '(85010212342)', 'i', 'NIP:', '676-123-45-63;', 'koniec.'],
      // A narrow "1" leaves a wide gap before the next digit: the end of "61-117" lies past it.
      ['Kod', '61-117', 'Poznan,', 'rok', '2011', 'koniec.'],
    ];
    const values = ['+48', '527', '870', '616', 'anna.nowak@example.com', 'ul.', 'Dluga', '12/4', '85010212342', '676-123-45-63', '61-117', '2011'];
    const scan = await buildScanPdf([{ kind: 'scan', lines, values, layer: 'tess' }]);
    if (!scan) return;
    const extraction = await readPdf(scan.bytes, { assets: ASSETS });
    expect(extraction.pages[0]).toMatchObject({ imageOnly: true, ocrText: true });
    const spansOf = (v: string) => spans(extraction.plainText, v, '[X_1]');
    const reps = ['+48 527 870 616', 'anna.nowak@example.com', 'ul. Dluga 12/4', '85010212342', '676-123-45-63', '61-117', '2011'].flatMap(spansOf);
    const result = await writeAnonymizedPdfWithReport(extraction, reps, [], { assets: ASSETS, canvasFactory: await nodeCanvasFactory() });
    const out = new Uint8Array(await result.blob.arrayBuffer());
    writeOutput('pdf-scan-tess-glued-redacted.pdf', out);
    expect(redPixels(await pageImage(scan.bytes, 0))).toBeGreaterThan(500);
    expect(redPixels(await pageImage(out, 0))).toBe(0);
    // The searchable layer reads like the redacted text: a placeholder spans its value's words, the
    // punctuation after it follows on the same line.
    const layer = (await pageText(out)).replace(/\s+/g, ' ');
    expect(layer).toContain('Telefon: [X_1], e-mail [X_1]).');
    expect(layer).toContain('PESEL ([X_1]) i NIP: [X_1]; koniec.');
  });

  it('a table rule the OCR read as "|" glued to a word reads as a space for detection; the glyph keeps it', async () => {
    const lines = [['1', '|', 'Jan', 'Kowalski', '|Krakow', '|', 'koniec.']];
    const scan = await buildScanPdf([{ kind: 'scan', lines, values: [], layer: 'tess' }]);
    if (!scan) return;
    const extraction = await readPdf(scan.bytes, { assets: ASSETS });
    expect(extraction.plainText).toContain('Kowalski  Krakow');
    expect(extraction.plainText).not.toContain('|');
    const glyphs = extraction.runs.flatMap((r) => r.glyphs.map((g) => g.unicode)).join('');
    expect(glyphs).toContain('|Krakow');
    // Offsets still map one for one: the value's span in the flat text is the glyphs of "Krakow".
    const at = extraction.plainText.indexOf('Krakow');
    const run = extraction.runs.find((r) => r.textOffsets.includes(at))!;
    expect(run.glyphs[run.textOffsets.indexOf(at)].unicode).toBe('K');
  });

  it('diacritics standing apart above a value (the dot of "Ż", the accents of "ó" "ć") are covered with it', async () => {
    const lines = [
      ['Wykonawca:', 'Krzysztof', 'Żółć.', 'Zamawiający:', 'Źdźbło', 'Ślęża.'],
      ['Kontakt:', 'Żaneta', 'Ćwik', 'i', 'mini', 'zespół.'],
    ];
    const values = ['Krzysztof', 'Żółć', 'Źdźbło', 'Ślęża', 'Żaneta', 'Ćwik', 'mini'];
    for (const layer of ['tess', 'alpha'] as const) {
      const scan = await buildScanPdf([{ kind: 'scan', lines, values, layer }]);
      if (!scan) return;
      const extraction = await readPdf(scan.bytes, { assets: ASSETS });
      // The layer reads the words without their diacritics ("Zolc"); the picture prints them.
      const reps = ['Krzysztof Zolc', 'Zdzblo Sleza', 'Zaneta Cwik', 'mini'].flatMap((v) => spans(extraction.plainText, v, '[X_1]'));
      const result = await writeAnonymizedPdfWithReport(extraction, reps, [], { assets: ASSETS, canvasFactory: await nodeCanvasFactory() });
      const out = new Uint8Array(await result.blob.arrayBuffer());
      writeOutput(`pdf-scan-diacritics-${layer}-redacted.pdf`, out);
      expect(redPixels(await pageImage(scan.bytes, 0))).toBeGreaterThan(500);
      expect(redPixels(await pageImage(out, 0)), layer).toBe(0);
      // The words around the values keep their own accents.
      const after = await pageImage(out, 0);
      const before = await pageImage(scan.bytes, 0);
      for (const w of scan.words.filter((x) => !x.value)) {
        const was = darkPixelsIn(before, { ...w, y0: w.y0 - 12 });
        expect(Math.abs(darkPixelsIn(after, { ...w, y0: w.y0 - 12 }) - was), `${layer} ${w.text}`).toBeLessThanOrEqual(Math.max(3, was * 0.05));
      }
    }
  });

  it('Tesseract layout: a value that is only the start of an OCR word is covered, and the rest of the word stays readable', async () => {
    const lines = [['Sygnatura', '2026/03/017', 'z', 'dnia', '17.03.2025', 'r.']];
    const scan = await buildScanPdf([{ kind: 'scan', lines, values: ['2026', '17.03'], layer: 'tess' }]);
    if (!scan) return;
    const extraction = await readPdf(scan.bytes, { assets: ASSETS });
    const at = extraction.plainText.indexOf('2026/03/017');
    const at2 = extraction.plainText.indexOf('17.03.2025');
    const reps = [{ start: at, end: at + 4, replacement: '[DATE_1]' }, { start: at2, end: at2 + 5, replacement: '[DATE_2]' }];
    const values = [{ value: '2026', replacement: '[DATE_1]' }, { value: '17.03', replacement: '[DATE_2]' }];
    const result = await writeAnonymizedPdfWithReport(extraction, reps, values, { assets: ASSETS, canvasFactory: await nodeCanvasFactory() });
    const out = new Uint8Array(await result.blob.arrayBuffer());
    writeOutput('pdf-scan-tess-in-word-redacted.pdf', out);
    const before = await pageImage(scan.bytes, 0);
    const after = await pageImage(out, 0);
    expect(redPixels(after)).toBe(0);
    // The rest of each word, from one letter after the value on ("3/017", ".2026"), keeps its ink.
    for (const w of scan.words.filter((x) => x.text === '2026/03/017' || x.text === '17.03.2025')) {
      const rest = { x0: w.valueEnd + (w.x1 - w.x0) * 0.12, y0: w.y0, x1: w.x1, y1: w.y1 };
      const was = darkPixelsIn(before, rest);
      expect(darkPixelsIn(after, rest), w.text).toBeGreaterThanOrEqual(was * 0.9);
    }
  });

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

  it('a rotated scan page keeps its searchable layer, over the printed words as the page is shown', async () => {
    const scan = await buildScanPdf([scanPage('alpha')]);
    if (!scan) return;
    const doc = await PDFDocument.load(scan.bytes, { updateMetadata: false });
    doc.getPages()[0].setRotation(degrees(90));
    const { width: W, height: H } = doc.getPages()[0].getSize();
    const { extraction, result, out } = await redactScan(await doc.save({ useObjectStreams: false }), 'rotated');
    expect(result.scanPages).toEqual([0]);
    const page = (await PDFDocument.load(out, { updateMetadata: false })).getPages()[0];
    expect(page.getRotation().angle).toBe(0);
    expect(page.getSize()).toEqual({ width: H, height: W });

    const written = await extractPdf(out);
    expect(written.plainText).toContain('Umowa zawarta z [PERSON_1] Jan, Warszawa.');
    expect(written.plainText).not.toMatch(/Kowalski|600123456|Nowak|Anna|jan\.kowalski@example\.com/);
    // /Rotate 90 shows user-space (x, y) at (y, W - x): each line's first word starts where the picture shows it.
    const start = (runs: typeof extraction.runs, word: string) => {
      for (const run of runs) {
        const text = run.glyphs.map((g) => g.unicode).join('');
        const at = text.indexOf(word);
        if (at >= 0) return run.glyphs[glyphAt(run.glyphs, at)];
      }
      throw new Error(`"${word}" not found`);
    };
    for (const word of ['Umowa', 'Telefon', 'Podpisano', 'Kontakt:']) {
      const was = start(extraction.runs, word);
      const now = start(written.runs, word);
      expect(Math.abs(now.x - was.y), word).toBeLessThan(was.fontSize * 0.3);
      expect(Math.abs(now.y - (W - was.x)), word).toBeLessThan(was.fontSize * 0.3);
    }
  });
});

/** Index of the glyph whose text starts at character `at` of the run's joined text. */
function glyphAt(glyphs: Array<{ unicode: string }>, at: number): number {
  let n = 0;
  for (let i = 0; i < glyphs.length; i++) {
    if (n >= at) return i;
    n += glyphs[i].unicode.length;
  }
  return glyphs.length - 1;
}

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

describe('text a scan\'s OCR layer does not have (T238)', () => {
  // A white RGBA canvas with dark rectangles, 1 px per unit.
  function canvasWith(width: number, height: number, rects: Array<[number, number, number, number]>): Uint8ClampedArray {
    const px = new Uint8ClampedArray(width * height * 4).fill(255);
    for (const [x0, y0, w, h] of rects) for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) px.fill(20, (y * width + x) * 4, (y * width + x) * 4 + 3);
    return px;
  }
  const letters = (x: number, y: number, n: number): Array<[number, number, number, number]> => Array.from({ length: n }, (_, i) => [x + i * 9, y, 6, 10]);

  it('a row of letter-sized shapes no OCR box covers is a missing line; covered text, a rule and a lone mark are not', () => {
    const rects = [...letters(20, 20, 8), ...letters(20, 60, 8), [20, 100, 300, 2] as [number, number, number, number], [300, 20, 6, 10] as [number, number, number, number]];
    const px = canvasWith(400, 140, rects);
    const covered = [{ x0: 18, y0: 58, x1: 95, y1: 72 }];
    const lines = findTextWithoutOcr(px, 400, 140, covered, 12);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ y0: 20, shapes: 8 });
  });

  it('readPdf reports a line printed in the scan but missing from its OCR layer, and nothing on a complete scan', async () => {
    const factory = await nodeCanvasFactory();
    const scan = await buildScanPdf([
      { ...scanPage('alpha'), unreadLines: [['Tabela:', 'Jan', 'Kowalski', '85010212342', 'Warszawa']] },
      scanPage('alpha'),
    ]);
    if (!scan || !factory) return;
    const ex = await readPdf(scan.bytes, { assets: ASSETS, canvasFactory: factory });
    expect(ex.pages.map((p) => p.ocrMissingLines)).toEqual([1, undefined]);
    expect(ex.warnings).toEqual([expect.stringMatching(/^page 1: the picture shows text its OCR layer does not have \(1 lines/)]);
    // Without a canvas the check is skipped, never a failure.
    const unchecked = await readPdf(scan.bytes, { assets: ASSETS });
    expect(unchecked.pages.every((p) => p.ocrMissingLines === undefined)).toBe(true);
  });
});

describe('text the OCR layer does not have, read by the host OCR (T238)', () => {
  it('readPdf adds the words a host OCR reads where the layer has none; the writer paints their values', async () => {
    const factory = await nodeCanvasFactory();
    const scan = await buildScanPdf([{ ...scanPage('alpha'), unreadLines: [['Tabela:', 'Kowalski', 'Zenon', '85010212342', 'Warszawa']], values: [...VALUES, 'Zenon', '85010212342'] }]);
    if (!scan || !factory) return;
    // A stand-in for Tesseract: the unread words where the fixture printed them (150 dpi pixels,
    // the page is rendered at 300 dpi for reading), relative to the region handed over.
    const unread = scan.words.filter((w) => w.unread);
    let regions = 0;
    const recognizeText = async (_canvas: unknown, region: { x0: number; y0: number }) => {
      regions++;
      const k = 2;
      const rel = (x: number, y: number) => [x * k - region.x0, y * k - region.y0];
      const [bx0, by] = rel(unread[0].x0, unread[0].unread!.baseline);
      return [{
        baseline: { x0: bx0, y0: by, x1: bx0 + 1000, y1: by },
        words: unread.map((w) => { const [x0, y0] = rel(w.x0, w.y0); const [x1, y1] = rel(w.x1, w.y1); return { text: w.text, bbox: { x0, y0, x1, y1 } }; }),
      }];
    };
    const ex = await readPdf(scan.bytes, { assets: ASSETS, canvasFactory: factory, recognizeText });
    expect(regions).toBe(1);
    expect(ex.pages[0]).toMatchObject({ ocrMissingLines: 1, ocrReadWords: 5 });
    expect(ex.plainText).toContain('Tabela: Kowalski Zenon 85010212342 Warszawa');
    expect(ex.warnings).toEqual([expect.stringMatching(/DocCloak read it with its own OCR \(5 words\)/)]);
    const reps = ['Kowalski', '600123456', 'Nowak', 'Anna', 'jan.kowalski@example.com', 'Zenon', '85010212342'].flatMap((v) => spans(ex.plainText, v, '[X_1]'));
    const result = await writeAnonymizedPdfWithReport(ex, reps, [], { assets: ASSETS, canvasFactory: factory });
    const out = new Uint8Array(await result.blob.arrayBuffer());
    writeOutput('pdf-scan-host-ocr-redacted.pdf', out);
    expect(result.scanPages).toEqual([0]);
    expect(redPixels(await pageImage(out, 0))).toBe(0);
  });
});

describe('each page by what it holds: pictures without text read whole, text in images read (T239)', () => {
  /** A stand-in for Tesseract: the given words where the fixture printed them (150 dpi pixels; read at 300 dpi), by line, relative to the region. */
  function fakeOcr(words: Array<{ text: string; x0: number; y0: number; x1: number; y1: number; baseline: number; confidence?: number }>, confidence = 90) {
    let calls = 0;
    const recognizeText = async (_canvas: unknown, region: { x0: number; y0: number }) => {
      calls++;
      const k = 2;
      const byLine = new Map<number, typeof words>();
      for (const w of words) byLine.set(Math.round(w.baseline), [...(byLine.get(Math.round(w.baseline)) ?? []), w]);
      return [...byLine.entries()].map(([baseline, ws]) => ({
        baseline: { x0: ws[0].x0 * k - region.x0, y0: baseline * k - region.y0, x1: ws[ws.length - 1].x1 * k - region.x0, y1: baseline * k - region.y0 },
        words: ws.map((w) => ({ text: w.text, confidence: w.confidence ?? confidence, bbox: { x0: w.x0 * k - region.x0, y0: w.y0 * k - region.y0, x1: w.x1 * k - region.x0, y1: w.y1 * k - region.y0 } })),
      }));
    };
    return { recognizeText, calls: () => calls };
  }
  // Scan words: y0 is the baseline less one em, y1 the baseline plus 0.3 em.
  const scanWords = (words: Array<{ page: number; text: string; x0: number; y0: number; x1: number; y1: number }>, page: number) =>
    words.filter((w) => w.page === page).map((w) => ({ ...w, baseline: w.y0 + (w.y1 - w.y0) / 1.3 }));

  it('a page without any text layer is read whole and painted like a scan with an OCR layer', async () => {
    const factory = await nodeCanvasFactory();
    const scan = await buildScanPdf([{ kind: 'scan', lines: LINES, values: VALUES, layer: 'none' }]);
    if (!scan || !factory) return;
    const ocr = fakeOcr(scanWords(scan.words, 0));
    const progress: Array<[number, number]> = [];
    const ex = await readPdf(scan.bytes, { assets: ASSETS, canvasFactory: factory, recognizeText: ocr.recognizeText, onOcrProgress: (d, t) => progress.push([d, t]) });
    expect(ocr.calls()).toBe(1);
    expect(progress).toEqual([[0, 1], [1, 1]]);
    expect(ex.empty).toBe(false);
    expect(ex.unredactable).toEqual([]);
    expect(ex.pages[0]).toMatchObject({ imageOnly: true, ocrText: true, ocrWholePage: 22 });
    expect(ex.plainText).toContain('Umowa zawarta z Kowalski Jan, Warszawa.');
    const result = await writeAnonymizedPdfWithReport(ex, VALUES.flatMap((v) => spans(ex.plainText, v, PLACEHOLDERS[v])), [], { assets: ASSETS, canvasFactory: factory });
    const out = new Uint8Array(await result.blob.arrayBuffer());
    writeOutput('pdf-scan-whole-page-ocr-redacted.pdf', out);
    expect(result.scanPages).toEqual([0]);
    expect(redPixels(await pageImage(scan.bytes, 0))).toBeGreaterThan(500);
    expect(redPixels(await pageImage(out, 0))).toBe(0);
    const layer = await pageText(out);
    expect(layer).toContain('[PERSON_1]');
    expect(layer).not.toMatch(/Kowalski|600123456|Nowak|jan\.kowalski@example\.com/);
  });

  it('a page read whole keeps the words the OCR is unsure of, so their values are covered too', async () => {
    const factory = await nodeCanvasFactory();
    const scan = await buildScanPdf([{ kind: 'scan', lines: LINES, values: VALUES, layer: 'none' }]);
    if (!scan || !factory) return;
    // Tesseract is least sure of elided words ("d'avril"): here of every word of a value.
    const unsure = scanWords(scan.words, 0).map((w) => ({ ...w, confidence: VALUES.some((v) => v.includes(w.text.replace(/[,.]$/, ''))) ? 4 : 90 }));
    expect(unsure.filter((w) => w.confidence === 4).length).toBeGreaterThan(3);
    const ocr = fakeOcr(unsure);
    const ex = await readPdf(scan.bytes, { assets: ASSETS, canvasFactory: factory, recognizeText: ocr.recognizeText });
    expect(ex.pages[0]).toMatchObject({ ocrText: true, ocrWholePage: 22 });
    for (const v of VALUES) expect(ex.plainText).toContain(v);
    const result = await writeAnonymizedPdfWithReport(ex, VALUES.flatMap((v) => spans(ex.plainText, v, PLACEHOLDERS[v])), [], { assets: ASSETS, canvasFactory: factory });
    const out = new Uint8Array(await result.blob.arrayBuffer());
    expect(redPixels(await pageImage(out, 0))).toBe(0);
    expect(await pageText(out)).not.toMatch(/Kowalski|600123456|Nowak|jan\.kowalski@example\.com/);
  });

  it('a picture the OCR finds only noise on stays a page left as it is', async () => {
    const factory = await nodeCanvasFactory();
    const scan = await buildScanPdf([{ kind: 'scan', lines: LINES, values: [], layer: 'none' }]);
    if (!scan || !factory) return;
    const ocr = fakeOcr(scanWords(scan.words, 0).slice(0, 5), 12);
    const ex = await readPdf(scan.bytes, { assets: ASSETS, canvasFactory: factory, recognizeText: ocr.recognizeText });
    expect(ex.pages[0]).toMatchObject({ imageOnly: true, ocrText: false, ocrWholePage: 0 });
    expect(ex.unredactable.map((u) => u.kind)).toEqual(['scanned-page']);
    expect(ex.empty).toBe(true);
  });

  it('a mixed file: the OCR scan is painted, the picture without text is read and painted, the text page is edited in place', async () => {
    const factory = await nodeCanvasFactory();
    const scan = await buildScanPdf([
      scanPage('alpha'),
      { kind: 'scan', lines: LINES, values: VALUES, layer: 'none' },
      { kind: 'text', lines: ['Klient: Kowalski Jan', 'Telefon 600123456'] },
    ]);
    if (!scan || !factory) return;
    const ocr = fakeOcr(scanWords(scan.words, 1));
    const ex = await readPdf(scan.bytes, { assets: ASSETS, canvasFactory: factory, recognizeText: ocr.recognizeText });
    expect(ex.pages.map((p) => [p.imageOnly, p.ocrText, p.ocrWholePage])).toEqual([[true, true, undefined], [true, true, 22], [false, false, undefined]]);
    expect(ex.unredactable).toEqual([]);
    const result = await writeAnonymizedPdfWithReport(ex, VALUES.flatMap((v) => spans(ex.plainText, v, PLACEHOLDERS[v])), [], { assets: ASSETS, canvasFactory: factory });
    const out = new Uint8Array(await result.blob.arrayBuffer());
    writeOutput('pdf-scan-mixed-ocr-all-redacted.pdf', out);
    expect(result.scanPages).toEqual([0, 1]);
    expect(result.rasterizedPages).toEqual([]);
    for (const i of [0, 1]) expect(redPixels(await pageImage(out, i)), `page ${i + 1}`).toBe(0);
    const text = await pageText(out);
    expect(text).toContain('Klient: [PERSON_1] Jan');
    expect(text).not.toMatch(/Kowalski|600123456|Nowak/);
  });

  it('a text page with an image that shows a value: the image text is read, and the page is painted to cover it', async () => {
    const factory = await nodeCanvasFactory();
    const scan = await buildScanPdf([{
      kind: 'text',
      lines: ['Klient: Kowalski Jan', 'Telefon 600123456'],
      image: { lines: [['Pieczatka:', 'Zenon', 'Wierzba', '85010212342', 'Warszawa']], values: ['Zenon', 'Wierzba', '85010212342'] },
    }]);
    if (!scan || !factory) return;
    const inImage = scan.words.filter((w) => w.inImage).map((w) => ({ ...w, baseline: w.inImage!.baseline }));
    const ocr = fakeOcr(inImage);
    const ex = await readPdf(scan.bytes, { assets: ASSETS, canvasFactory: factory, recognizeText: ocr.recognizeText });
    expect(ex.pages[0]).toMatchObject({ imageOnly: false, ocrText: false, ocrMissingLines: 1, ocrReadWords: 5 });
    expect(ex.plainText).toContain('Klient: Kowalski Jan');
    expect(ex.plainText).toContain('Pieczatka: Zenon Wierzba 85010212342 Warszawa');
    const values = ['Kowalski', '600123456', 'Zenon', 'Wierzba', '85010212342'];
    const result = await writeAnonymizedPdfWithReport(ex, values.flatMap((v) => spans(ex.plainText, v, '[X_1]')), [], { assets: ASSETS, canvasFactory: factory });
    const out = new Uint8Array(await result.blob.arrayBuffer());
    writeOutput('pdf-scan-text-page-image-redacted.pdf', out);
    expect(result.scanPages).toEqual([0]);
    expect(redPixels(await pageImage(out, 0))).toBe(0);
    const text = await pageText(out);
    expect(text).toContain('Klient: [X_1] Jan');
    expect(text).not.toMatch(/Kowalski|600123456|Zenon|Wierzba|85010212342/);
  });

  it('a text page whose image holds no value stays vector text: only its text layer is edited', async () => {
    const factory = await nodeCanvasFactory();
    const scan = await buildScanPdf([{
      kind: 'text',
      lines: ['Klient: Kowalski Jan', 'Telefon 600123456'],
      image: { lines: [['Pieczatka', 'kancelarii', 'zgodna', 'z', 'oryginalem']], values: [] },
    }]);
    if (!scan || !factory) return;
    const ocr = fakeOcr(scan.words.filter((w) => w.inImage).map((w) => ({ ...w, baseline: w.inImage!.baseline })));
    const ex = await readPdf(scan.bytes, { assets: ASSETS, canvasFactory: factory, recognizeText: ocr.recognizeText });
    expect(ex.pages[0].ocrReadWords).toBe(5);
    const result = await writeAnonymizedPdfWithReport(ex, ['Kowalski', '600123456'].flatMap((v) => spans(ex.plainText, v, '[X_1]')), [], { assets: ASSETS, canvasFactory: factory });
    const out = new Uint8Array(await result.blob.arrayBuffer());
    expect(result.scanPages).toEqual([]);
    expect(result.rasterizedPages).toEqual([]);
    const text = await pageText(out);
    expect(text).toContain('Klient: [X_1] Jan');
    expect(text).toContain('Telefon [X_1]');
  });

  it('without the host OCR nothing changes: a picture without text stays listed, a text page keeps its warning', async () => {
    const scan = await buildScanPdf([{ kind: 'scan', lines: LINES, values: [], layer: 'none' }]);
    if (!scan) return;
    const ex = await readPdf(scan.bytes, { assets: ASSETS });
    expect(ex.pages[0]).toMatchObject({ imageOnly: true, ocrText: false });
    expect(ex.pages[0].ocrWholePage).toBeUndefined();
    expect(ex.unredactable.map((u) => u.kind)).toEqual(['scanned-page']);
  });
});

describe('junk in the OCR layer over a printed row (T238)', () => {
  it('a word DocCloak reads where the layer holds junk is added; where the layer has the same word, it is not added twice', async () => {
    const factory = await nodeCanvasFactory();
    const scan = await buildScanPdf([{
      ...scanPage('alpha'),
      unreadLines: [['Tabela:', 'Zenon', 'Wierzba', '85010212342']],
      junkLines: [{ words: ['Rola:', 'Ewa', 'Malinowska', 'Gdansk'], junk: '[mi | opow ema Je |' }],
      values: [...VALUES, 'Zenon', 'Wierzba', '85010212342', 'Ewa', 'Malinowska'],
    }]);
    if (!scan || !factory) return;
    const printed = scan.words.filter((w) => w.unread);
    // The stand-in OCR reads both rows and, from the region's edge, a word the layer already has.
    const known = scan.words.find((w) => w.text === 'dzisiejszego.')!;
    const recognizeText = async (_canvas: unknown, region: { x0: number; y0: number }) => {
      const k = 2;
      const box = (w: typeof printed[number]) => ({ x0: w.x0 * k - region.x0, y0: w.y0 * k - region.y0, x1: w.x1 * k - region.x0, y1: w.y1 * k - region.y0 });
      const rows = [...new Set(printed.map((w) => w.unread!.baseline))];
      const lines = rows.map((bl) => ({ baseline: { x0: 0, y0: bl * k - region.y0, x1: 2000, y1: bl * k - region.y0 }, words: printed.filter((w) => w.unread!.baseline === bl).map((w) => ({ text: w.text, bbox: box(w) })) }));
      const kb = (known.y0 + (known.y1 - known.y0)) * k - region.y0;
      return [...lines, { baseline: { x0: 0, y0: kb, x1: 2000, y1: kb }, words: [{ text: known.text, bbox: { x0: known.x0 * k - region.x0, y0: known.y0 * k - region.y0, x1: known.x1 * k - region.x0, y1: known.y1 * k - region.y0 } }] }];
    };
    const ex = await readPdf(scan.bytes, { assets: ASSETS, canvasFactory: factory, recognizeText });
    expect(ex.plainText).toContain('Rola: Ewa Malinowska Gdansk'); // read over the junk
    expect(ex.plainText.split('dzisiejszego.').length - 1).toBe(1); // not added a second time
    const reps = ['Kowalski', '600123456', 'Nowak', 'Anna', 'jan.kowalski@example.com', 'Zenon', 'Wierzba', '85010212342', 'Ewa', 'Malinowska'].flatMap((v) => spans(ex.plainText, v, '[X_1]'));
    const result = await writeAnonymizedPdfWithReport(ex, reps, [], { assets: ASSETS, canvasFactory: factory });
    const out = new Uint8Array(await result.blob.arrayBuffer());
    writeOutput('pdf-scan-junk-redacted.pdf', out);
    expect(redPixels(await pageImage(out, 0))).toBe(0);
  });
});

describe('verifier and image samples', () => {
  it('a value that occurs in an image\'s pixel bytes is not a trace; in the image dictionary or another stream it is', async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const page = doc.addPage([200, 200]);
    // Gray levels 40 51 54 40 (dark anti-aliased edge pixels) spell "(36(" in bytes: the street number "36".
    const pixels = new Uint8Array(64 * 64).fill(255);
    pixels.set([40, 51, 54, 40], 1000);
    const image = doc.context.register(doc.context.flateStream(pixels, { Type: 'XObject', Subtype: 'Image', Width: 64, Height: 64, ColorSpace: 'DeviceGray', BitsPerComponent: 8 }));
    const name = page.node.newXObject('Im', image);
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(new TextEncoder().encode(`q 200 0 0 200 0 0 cm /${name.decodeText()} Do Q`))));
    const clean = await doc.save({ useObjectStreams: false });
    expect(await verifyPdf({ bytes: clean, needles: ['36'] })).toEqual([]);

    const titled = await PDFDocument.load(clean, { updateMetadata: false });
    const img = [...titled.context.enumerateIndirectObjects()].map(([, o]) => o).find((o) => o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype'))?.toString() === '/Image') as PDFRawStream;
    img.dict.set(PDFName.of('Alt'), PDFString.of('ul. Długa 36'));
    titled.context.register(titled.context.flateStream(new TextEncoder().encode('note: 36 left here'), { Type: 'Note' }));
    const findings = await verifyPdf({ bytes: await titled.save({ useObjectStreams: false }), needles: ['36'] });
    expect(findings.map((f) => f.pass).sort()).toEqual(['stream-bytes', 'string-bytes']);
  });

  it('a value that matches a code point in a ToUnicode CMap ("<2019>", the apostrophe) is not a trace; written in the CMap as text it is', async () => {
    const cmap = (extra: string) => `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n${extra}1 beginbfchar\n<004A> <2019>\nendbfchar\nendcmap\nend\nend\n`;
    const build = async (extra: string) => {
      const doc = await PDFDocument.create({ updateMetadata: false });
      doc.addPage([200, 200]);
      doc.context.register(doc.context.flateStream(new TextEncoder().encode(cmap(extra))));
      return doc.save({ useObjectStreams: false });
    };
    // Issue file, run 18: the year "2019" was found in the text layer font's ToUnicode map and the export was refused.
    expect(await verifyPdf({ bytes: await build(''), needles: ['2019', '004A'] })).toEqual([]);
    const hidden = await verifyPdf({ bytes: await build('% Jan Kowalski 2019\n'), needles: ['2019', 'Jan Kowalski'] });
    expect(hidden.map((f) => [f.pass, f.needle])).toEqual([['stream-bytes', '2019'], ['stream-bytes', 'Jan Kowalski']]);
  });
});

describe('scan painting helpers', () => {
  it('packPixels keeps a gray page in one channel and a colour page in three', () => {
    const gray = new Uint8ClampedArray([10, 10, 10, 255, 200, 200, 200, 255]);
    expect(packPixels(gray)).toEqual({ pixels: new Uint8Array([10, 200]), channels: 1 });
    const colour = new Uint8ClampedArray([10, 10, 10, 255, 200, 0, 0, 255]);
    expect(packPixels(colour)).toEqual({ pixels: new Uint8Array([10, 10, 10, 200, 0, 0]), channels: 3 });
  });

  it('blankAfter: the blank paper after a value up to a word space before the next ink, or the picture edge', () => {
    const w = 200, h = 40, baseline = 30;
    const rgba = new Uint8ClampedArray(w * h * 4).fill(255);
    const ink = (x0: number, x1: number, y0: number, y1: number) => {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) rgba.fill(0, (y * w + x) * 4, (y * w + x) * 4 + 3);
    };
    ink(120, 130, 22, 30); // the next word's letters
    const at = (along: number, up: number): [number, number] => [along, baseline - up];
    // em 10: the run ends 3.5 before the ink at 120.
    expect(blankAfter(rgba, w, h, at, 50, 100, 10, 0.65)).toBeCloseTo(66.5, 0);
    expect(blankAfter(rgba, w, h, at, 50, 20, 10, 0.65)).toBe(20); // no more than wanted
    expect(blankAfter(rgba, w, h, at, 140, 100, 10, 0.65)).toBeCloseTo(200 - 140 - 3.5, 0); // the edge
    ink(70, 72, 4, 6); // a mark above the band (the line above) does not count
    expect(blankAfter(rgba, w, h, at, 50, 100, 10, 0.65)).toBeCloseTo(66.5, 0);
    ink(70, 72, 30, 33); // a descender inside the band does
    expect(blankAfter(rgba, w, h, at, 50, 100, 10, 0.65)).toBeCloseTo(16.5, 0);
    expect(blankAfter(rgba, w, h, at, 50, 100, 10, 0)).toBe(0); // no ink threshold: no room
    // Before a value, walking back: up to a word space after the descender at 70-72.
    expect(blankAfter(rgba, w, h, at, 110, 50, 10, 0.65, -1)).toBeCloseTo(110 - 71 - 3.5, 0); // its last pixel column is 71
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

  it('inkExtent inside an OCR word starts the cover before the value\'s first letter when the OCR places it half a letter late', () => {
    // Page 6 of the issue file, columns at 300 dpi: "d" 8-27, "’" 33-36, "A" 41-68, "L" 73-90 (one
    // word "d’ALTAMIR"); Tesseract's box for the "A" starts at 56, in its middle.
    const width = 120;
    const height = 40;
    const rgba = new Uint8ClampedArray(width * height * 4).fill(255);
    const ink = (x0: number, x1: number, y0 = 6) => {
      for (let x = x0; x < x1; x++) for (let y = y0; y < 30; y++) rgba.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
    };
    ink(8, 28);
    ink(33, 37, 6); // the apostrophe, high on the line
    ink(41, 69);
    ink(73, 91);
    const m: PaintMark = { x: 56, y: 30, ux: 1, uy: 0, vx: 0, vy: -1, length: 34, size: 44, label: '[X]', startsInWord: true, endsInWord: true };
    const at = (along: number, up: number): [number, number] => [m.x + along, m.y - up];
    const ext = inkExtent(rgba, width, height, at, m, 0.6);
    expect(m.x + ext.start).toBeLessThanOrEqual(41); // the "A" is covered from its first column
    expect(m.x + ext.start).toBeGreaterThan(28); // the "d" stays
    expect(m.x + ext.end).toBeGreaterThanOrEqual(91); // past the "L", where the estimate ends
  });

  it('paintMarksForPage covers punctuation glued to a value inside its OCR word, and nothing past the word', async () => {
    const { PDFDocument: Doc, StandardFonts } = await import('@cantoo/pdf-lib');
    const doc = await Doc.create({ updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([400, 200]);
    page.node.setFontDictionary(PDFName.of('F1'), font.ref);
    // One show per word, as Tesseract writes its layer: "(tel." "+48" "527" "616," "dalej."
    const words = ['(tel.', '+48', '527', '616,', 'dalej.'];
    const xs: number[] = [];
    let x = 40;
    for (const w of words) { xs.push(x); x += font.widthOfTextAtSize(`${w} `, 12); }
    const content = words.map((w, i) => `BT /F1 12 Tf ${xs[i]} 150 Td (${w.replace(/[()]/g, '\\$&')} ) Tj ET`).join(' ');
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(new TextEncoder().encode(content))));
    const ex = await extractPdf(await doc.save({ useObjectStreams: false }));
    const start = ex.plainText.indexOf('+48');
    const end = ex.plainText.indexOf('616') + 3;
    const reps = [{ start, end, replacement: '[PHONE_1]' }];
    const [mark] = paintMarksForPage(segmentsFor(ex.runs, reps), 0, reps);
    // From "+48" to the end of "616," including its comma, not into "dalej.".
    expect(mark.x).toBeCloseTo(xs[1], 1);
    expect(mark.x + mark.length).toBeCloseTo(xs[3] + font.widthOfTextAtSize('616,', 12), 1);
    expect(mark.x + mark.length).toBeLessThan(xs[4]);
    // The covered comma is painted again with the placeholder, as the redacted text reads.
    expect(mark.label).toBe('[PHONE_1],');
  });

  it('paintMarksForPage paints punctuation glued on both sides of a value back around its placeholder', async () => {
    const { PDFDocument: Doc, StandardFonts } = await import('@cantoo/pdf-lib');
    const doc = await Doc.create({ updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([400, 200]);
    page.node.setFontDictionary(PDFName.of('F1'), font.ref);
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(new TextEncoder().encode(
      'BT /F1 12 Tf 40 150 Td (Tel. ) Tj ET BT /F1 12 Tf 70 150 Td (\\(600123456\\). ) Tj ET BT /F1 12 Tf 160 150 Td (Dalej ) Tj ET',
    ))));
    const ex = await extractPdf(await doc.save({ useObjectStreams: false }));
    const start = ex.plainText.indexOf('600123456');
    const reps = [{ start, end: start + 9, replacement: '[PHONE_1]' }];
    const [mark] = paintMarksForPage(segmentsFor(ex.runs, reps), 0, reps);
    expect(mark.label).toBe('([PHONE_1]).');
    expect(mark.x).toBeCloseTo(70, 1);
    expect(mark.x + mark.length).toBeCloseTo(70 + font.widthOfTextAtSize('(600123456).', 12), 1);
  });

  it('paintMarksForPage on a Tesseract layer: a value covers its whole OCR word, which the show stretches over the printed word', async () => {
    const scan = await buildScanPdf([{ kind: 'scan', lines: [['Adres:', '31-147', 'Krakow.']], values: ['31-147'], layer: 'tess' }]);
    if (!scan) return;
    const ex = await extractPdf(scan.bytes);
    const start = ex.plainText.indexOf('31-147');
    const reps = [{ start, end: start + 6, replacement: '[ADDRESS_1]' }];
    const [mark] = paintMarksForPage(segmentsFor(ex.runs, reps), 0, reps);
    const word = scan.words.find((w) => w.text === '31-147')!;
    const toPt = (px: number) => (px * 72) / SCAN_DPI;
    expect(mark.x).toBeCloseTo(toPt(word.x0), 1);
    // The printed word ends where the show ends (its stretched trailing space included), 1/7 after the
    // last letter's own advance: that is how far the cover takes in ink.
    expect(mark.x + (mark.reach ?? 0)).toBeCloseTo(toPt(word.x1), 1);
    expect(mark.length).toBeCloseTo((mark.reach ?? 0) * 6 / 7, 1);
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

  it('withTextColumn: the column is where most words start and end; a margin note does not widen it', async () => {
    const { PDFDocument: Doc, StandardFonts } = await import('@cantoo/pdf-lib');
    const doc = await Doc.create({ updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([400, 400]);
    page.node.setFontDictionary(PDFName.of('F1'), font.ref);
    const lines = Array.from({ length: 24 }, (_, i) => `BT /F1 10 Tf 60 ${360 - i * 14} Td (Linia ${i} tekstu az do prawego) Tj ET`);
    const content = [...lines, 'BT /F1 6 Tf 5 380 Td (Nota) Tj ET', 'BT /F1 10 Tf 250 50 Td (Krakow, 14 marca) Tj ET'].join(' ');
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(new TextEncoder().encode(content))));
    const ex = await extractPdf(await doc.save({ useObjectStreams: false }));
    const start = ex.plainText.indexOf('Krakow');
    const reps = [{ start, end: start + 6, replacement: '[ADDRESS_1]' }];
    const [mark] = withTextColumn(paintMarksForPage(segmentsFor(ex.runs, reps), 0, reps), ex.runs, 0);
    // The value starts at 250; the column from 60 (not the note at 5) to where the long lines end.
    expect(mark.x).toBeCloseTo(250, 0);
    expect(mark.columnStart).toBeCloseTo(60 - 250, 0);
    const lineEnd = 60 + font.widthOfTextAtSize('Linia 23 tekstu az do prawego', 10);
    expect(Math.abs(mark.columnEnd! + mark.x - lineEnd)).toBeLessThan(5);
  });

  it('paintMarksForPage: on the line a value wraps onto, the punctuation glued after it is painted at its end', async () => {
    const { PDFDocument: Doc, StandardFonts } = await import('@cantoo/pdf-lib');
    const doc = await Doc.create({ updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([400, 200]);
    page.node.setFontDictionary(PDFName.of('F1'), font.ref);
    const content = 'BT /F1 12 Tf 40 150 Td (z siedziba w ) Tj (ul. ) Tj ET BT /F1 12 Tf 40 135 Td (Portowa ) Tj (8, ) Tj (KRS 123.) Tj ET';
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(new TextEncoder().encode(content))));
    const ex = await extractPdf(await doc.save({ useObjectStreams: false }));
    const start = ex.plainText.indexOf('ul.');
    const end = ex.plainText.indexOf('8,') + 1;
    const reps = [{ start, end, replacement: '[ADDRESS_1]' }];
    const marks = paintMarksForPage(segmentsFor(ex.runs, reps), 0, reps);
    expect(marks.map((m) => [m.label, m.labelEnd])).toEqual([['[ADDRESS_1]', undefined], ['', ',']]);
    // The rest's cover runs from "Portowa" to the end of "8," with its comma: Helvetica widths
    // (Tj does not kern) "Portowa " 3946, "8," 834 units.
    expect(marks[1].x).toBeCloseTo(40, 1);
    expect(marks[1].x + marks[1].length).toBeCloseTo(40 + (3.946 + 0.834) * 12, 1);
    void font;
  });
});
