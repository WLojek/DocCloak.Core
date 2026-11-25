// T282 (WLojek/DocCloak.Core#6): hand edits of a PDF. Pages left out and areas hidden by hand are
// carried by the extraction (applyPdfEdits), the writer leaves the pages out and paints the areas
// black in the pixels of a page exported as a picture, and the verifier refuses an output that
// still holds anything of either.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, PDFName, PDFRawStream, StandardFonts, degrees } from '@cantoo/pdf-lib';
import fontkit from '@cantoo/fontkit';
import {
  applyPdfEdits, extractPdf, mapKeptRange, normalizePdfEdits, openPdfPreview, openWithOracle, pixelRectToUserRect, readPdf, userRectToPixelRect,
  verifyPdf, writeAnonymizedPdfWithReport, PdfVerifyError, StalePdfExtractionError,
} from '../src/pdf/index.ts';
import type { KeptStretch, PdfAssetPaths, PdfExtraction, Rect } from '../src/pdf/index.ts';
import { streamFingerprint } from '../src/pdf/carryover.ts';
import { getDict, getName } from '../src/pdf/objects.ts';
import { nodeCanvasFactory } from './helpers/pdf-canvas.ts';
import { buildScanPdf, SCAN_DPI } from './helpers/fixtures/pdf-scan.ts';

const FONTS = join(__dirname, '..', 'fonts', 'liberation');
const PDFJS_DIR = join(__dirname, '..', 'node_modules', 'pdfjs-dist');
// pdf.js gets its own standard fonts and CMaps: the test files show Helvetica without embedding it,
// and the system is never asked for a font (oracle.ts). Without these files the text of a page was
// drawn on a Mac (the canvas found a face of its own) and not on the Linux of the CI, where the
// checks that count the ink of a page then saw none.
const ASSETS: PdfAssetPaths = {
  loadFont: async (file) => new Uint8Array(readFileSync(join(FONTS, file))),
  cMapUrl: join(PDFJS_DIR, 'cmaps') + '/',
  standardFontDataUrl: join(PDFJS_DIR, 'standard_fonts') + '/',
};

/** A text PDF: one page per list of lines, Helvetica 12 pt from (40, 250) downwards. */
async function textPdf(pages: string[][], size: [number, number] = [400, 300]): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = doc.addPage(size);
    lines.forEach((line, i) => page.drawText(line, { x: 40, y: size[1] - 50 - i * 20, size: 12, font }));
  }
  return doc.save({ useObjectStreams: false });
}

const PAGES = [
  ['Umowa najmu lokalu', 'Wynajmujacy: Jan Kowalski, Warszawa', 'Email: jan.kowalski@example.com'],
  ['Aneks poufny do umowy', 'Wspolnik: Maria Wozniak, Gdansk', 'Rachunek 61109010140000071219812874'],
  ['Postanowienia koncowe', 'Najemca: Piotr Zielinski, Krakow', 'Podpis: Anna Nowak'],
];

/** The box of the glyphs that spell `text` (its first occurrence), about where their ink is. */
function boxOf(extraction: PdfExtraction, text: string): { page: number; rect: Rect } {
  const start = extraction.plainText.indexOf(text);
  expect(start, `"${text}" not in the text`).toBeGreaterThanOrEqual(0);
  const end = start + text.length;
  let page = -1;
  const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const run of extraction.runs) {
    const k = Math.hypot(run.emX[0], run.emX[1]) / (run.local.fontSize * run.local.hscale || 1);
    run.glyphs.forEach((g, i) => {
      const at = run.textOffsets[i];
      if (g.unicode.length === 0 || at < start || at >= end) return;
      page = run.page;
      // Unrotated horizontal text in these fixtures.
      box.x0 = Math.min(box.x0, g.x);
      box.x1 = Math.max(box.x1, g.x + g.advance * k);
      box.y0 = Math.min(box.y0, g.y - 0.2 * g.fontSize);
      box.y1 = Math.max(box.y1, g.y + 0.75 * g.fontSize);
    });
  }
  return { page, rect: box };
}

function spans(text: string, value: string, replacement: string): Array<{ start: number; end: number; replacement: string }> {
  const out: Array<{ start: number; end: number; replacement: string }> = [];
  for (let i = text.indexOf(value); i >= 0; i = text.indexOf(value, i + value.length)) out.push({ start: i, end: i + value.length, replacement });
  expect(out.length, `"${value}" not found`).toBeGreaterThan(0);
  return out;
}

/** Every stretch says the truth: the same characters at `from` in the old text and at `to` in the new one. */
function expectKept(kept: KeptStretch[], oldText: string, newText: string): void {
  let lastFrom = 0;
  let lastTo = 0;
  for (const s of kept) {
    expect(s.length).toBeGreaterThan(0);
    expect(s.from).toBeGreaterThanOrEqual(lastFrom);
    expect(s.to).toBeGreaterThanOrEqual(lastTo);
    expect(newText.slice(s.to, s.to + s.length)).toBe(oldText.slice(s.from, s.from + s.length));
    lastFrom = s.from + s.length;
    lastTo = s.to + s.length;
  }
}

async function write(extraction: PdfExtraction, values: Array<[string, string]>, options: Record<string, unknown> = {}) {
  const replacements = values.flatMap(([v, r]) => spans(extraction.plainText, v, r));
  const result = await writeAnonymizedPdfWithReport(extraction, replacements, values.map(([value, replacement]) => ({ value, replacement })), {
    assets: ASSETS, canvasFactory: await nodeCanvasFactory(), ...options,
  });
  return { result, out: new Uint8Array(await result.blob.arrayBuffer()) };
}

/** RGBA pixels of an output page rendered at `scale`, with the render's transform. */
async function render(bytes: Uint8Array, page: number, scale: number) {
  const oracle = await openWithOracle(bytes, ASSETS);
  try {
    const r = await oracle.render(page, scale, await nodeCanvasFactory());
    return { rgba: r.canvas.getImageData(), width: r.widthPx, height: r.heightPx, transform: r.transform };
  } finally {
    await oracle.close();
  }
}

/** Share of the pixels of `rect` (user space, 2 px in from its edges) that are black. */
function blackShare(img: { rgba: Uint8ClampedArray; width: number; transform: number[] }, rect: Rect): number {
  const px = userRectToPixelRect(img.transform, rect);
  let black = 0;
  let all = 0;
  for (let y = Math.ceil(px.y0) + 2; y < Math.floor(px.y1) - 2; y++) {
    for (let x = Math.ceil(px.x0) + 2; x < Math.floor(px.x1) - 2; x++) {
      const i = (y * img.width + x) * 4;
      all++;
      if (img.rgba[i] < 24 && img.rgba[i + 1] < 24 && img.rgba[i + 2] < 24) black++;
    }
  }
  return all > 0 ? black / all : 0;
}

/** Dark pixels (ink) inside `rect`. */
function inkIn(img: { rgba: Uint8ClampedArray; width: number; transform: number[] }, rect: Rect): number {
  const px = userRectToPixelRect(img.transform, rect);
  let n = 0;
  for (let y = Math.floor(px.y0); y < Math.ceil(px.y1); y++) {
    for (let x = Math.floor(px.x0); x < Math.ceil(px.x1); x++) if (img.rgba[(y * img.width + x) * 4] < 128) n++;
  }
  return n;
}

describe('removed pages', () => {
  it('the page leaves the text, stays listed, and the kept stretches map old offsets to new ones', async () => {
    const extraction = await readPdf(await textPdf(PAGES), { assets: ASSETS });
    const { extraction: edited, kept, addedText, covered } = applyPdfEdits(extraction, { removedPages: [1] });

    expect(edited.plainText).not.toMatch(/Aneks|Wozniak|61109010140000071219812874/);
    expect(edited.plainText).toContain('Wynajmujacy: Jan Kowalski, Warszawa');
    expect(edited.plainText).toContain('Podpis: Anna Nowak');
    expect(addedText).toBe(false);
    expect(covered).toEqual([]);
    // Still three pages to list; the middle one is out and holds no text.
    expect(edited.pageCount).toBe(3);
    expect(edited.pages.map((p) => !!p.removed)).toEqual([false, true, false]);
    expect(edited.pages[1].textStart).toBe(edited.pages[1].textEnd);
    expect(edited.plainText.slice(edited.pages[0].textStart, edited.pages[0].textEnd)).toContain('Umowa najmu lokalu');
    expect(edited.plainText.slice(edited.pages[2].textStart, edited.pages[2].textEnd)).toMatch(/^Postanowienia koncowe[\s\S]*Anna Nowak$/);
    expect(edited.runs.some((r) => r.page === 1)).toBe(false);
    for (const run of edited.runs) {
      run.glyphs.forEach((g, i) => expect(edited.plainText.slice(run.textOffsets[i], run.textOffsets[i] + g.unicode.length)).toBe(g.unicode));
    }
    expect(edited.edits).toEqual({ removedPages: [1], regions: [] });
    expect(edited.unedited).toBe(extraction);

    // The mapping: two stretches (page 1, page 3), each the same characters in both texts.
    expectKept(kept, extraction.plainText, edited.plainText);
    expect(kept).toHaveLength(2);
    expect(kept.reduce((n, s) => n + s.length, 0)).toBe(edited.plainText.length);
    const nowak = extraction.plainText.indexOf('Anna Nowak');
    const mapped = mapKeptRange(kept, nowak, nowak + 10)!;
    expect(edited.plainText.slice(mapped.start, mapped.end)).toBe('Anna Nowak');
    const wozniak = extraction.plainText.indexOf('Maria Wozniak');
    expect(mapKeptRange(kept, wozniak, wozniak + 13)).toBeNull();
    // A range that runs from a kept page into the removed one is gone too.
    expect(mapKeptRange(kept, wozniak - 60, wozniak + 5)).toBeNull();
  });

  it('the output has the kept pages only, replacements land on them, nothing of the removed page is left', async () => {
    const bytes = await textPdf(PAGES);
    expect(Buffer.from(bytes).toString('latin1')).not.toContain('Wozniak'); // compressed: the text checks below read it back
    const extraction = await readPdf(bytes, { assets: ASSETS });
    const { extraction: edited } = applyPdfEdits(extraction, { removedPages: [1] });
    const { result, out } = await write(edited, [['Jan Kowalski', '[PERSON_1]'], ['Anna Nowak', '[PERSON_2]']]);

    expect(result.removedPages).toEqual([1]);
    expect(result.regionPages).toEqual([]);
    expect(result.rasterizedPages).toEqual([]);
    expect(result.scanPages).toEqual([]);
    const after = await readPdf(out, { assets: ASSETS });
    expect(after.pageCount).toBe(2);
    expect(after.plainText).toContain('Wynajmujacy: [PERSON_1], Warszawa');
    expect(after.plainText).toContain('Podpis: [PERSON_2]');
    expect(after.plainText).toContain('Najemca: Piotr Zielinski, Krakow');
    expect(after.plainText).not.toMatch(/Aneks|Wozniak|Gdansk|61109010140000071219812874|Kowalski|Nowak/);
    // Still vector text: nothing was rasterized for a removed page.
    expect(after.runs.some((r) => !r.hidden)).toBe(true);
  });

  it('a value the detector marked only on a removed page costs nothing; the same value on a kept page is still replaced', async () => {
    const pages = [['Strona pierwsza', 'Kontakt: Maria Wozniak'], ['Strona druga', 'Wspolnik: Maria Wozniak']];
    const extraction = await readPdf(await textPdf(pages), { assets: ASSETS });
    const { extraction: edited } = applyPdfEdits(extraction, { removedPages: [1] });
    // Layer zero finds the value in the edited text; the session still lists it.
    const result = await writeAnonymizedPdfWithReport(edited, [], [{ value: 'Maria Wozniak', replacement: '[PERSON_1]' }], { assets: ASSETS });
    const after = await extractPdf(new Uint8Array(await result.blob.arrayBuffer()));
    expect(after.pages).toHaveLength(1);
    expect(after.plainText).toContain('Kontakt: [PERSON_1]');
    expect(after.plainText).not.toMatch(/Wozniak|druga/);
  });

  it('refuses bad edits: a page the file does not have, every page removed', async () => {
    const extraction = await readPdf(await textPdf(PAGES), { assets: ASSETS });
    expect(() => applyPdfEdits(extraction, { removedPages: [3] })).toThrow(RangeError);
    expect(() => applyPdfEdits(extraction, { removedPages: [0, 1, 2] })).toThrow(/at least one page/);
    expect(() => applyPdfEdits(extraction, { regions: [{ page: 0, rect: { x0: 0, y0: 0, x1: NaN, y1: 5 } }] })).toThrow(RangeError);
  });

  it('tidies edits: pages sorted and unique, rectangles the right way round, a click dropped, a sliver widened to 2 pt', async () => {
    const extraction = await readPdf(await textPdf(PAGES), { assets: ASSETS });
    const { extraction: edited } = applyPdfEdits(extraction, {
      removedPages: [2, 0, 2],
      regions: [
        { page: 1, rect: { x0: 300, y0: 90, x1: 200, y1: 40 } }, // dragged from the top right
        { page: 1, rect: { x0: 50, y0: 50, x1: 50, y1: 80 } }, // no width: a click
        { page: 1, rect: { x0: 100, y0: 10, x1: 100.5, y1: 30 } },
      ],
    });
    expect(edited.edits).toEqual({
      removedPages: [0, 2],
      regions: [{ page: 1, rect: { x0: 200, y0: 40, x1: 300, y1: 90 } }, { page: 1, rect: { x0: 99.25, y0: 10, x1: 101.25, y1: 30 } }],
    });
    expect(normalizePdfEdits({ regions: [{ page: 0, rect: { x0: 5, y0: 5, x1: 5, y1: 5 } }] }, 3)).toEqual({ removedPages: [], regions: [] });
    // Edits that leave nothing to do give back the extraction as read.
    expect(applyPdfEdits(extraction, { regions: [{ page: 0, rect: { x0: 5, y0: 5, x1: 5, y1: 9 } }] }).extraction).toBe(extraction);
  });
});

describe('removed pages and shared resources', () => {
  const SECRET = 'Strona druga: tajny aneks Marii Wozniak';
  const SECRET_FORM = `BT /F1 12 Tf 40 200 Td (${SECRET}) Tj ET`;

  /**
   * Two pages with ONE resource dictionary: page 1 draws form Fx1, page 2 draws form Fx2 (its
   * text) and image Im2. A plain page copy of page 1 brings Fx2 and Im2 along.
   */
  async function sharedResourcesPdf(): Promise<Uint8Array> {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const form = (content: string) => doc.context.register(doc.context.stream(content, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 400, 300] }));
    const fx1 = form('BT /F1 12 Tf 40 200 Td (Strona pierwsza: umowa najmu lokalu) Tj ET');
    const fx2 = form(SECRET_FORM);
    const pixels = new Uint8Array(16 * 16 * 3).map((_, i) => (i * 37) % 251);
    const image = doc.context.register(doc.context.stream(pixels, { Type: 'XObject', Subtype: 'Image', Width: 16, Height: 16, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 }));
    const shared = doc.context.register(doc.context.obj({ Font: { F1: font.ref }, XObject: { Fx1: fx1, Fx2: fx2, Im2: image } }));
    const contents = ['q /Fx1 Do Q', 'q /Fx2 Do Q q 50 0 0 50 40 40 cm /Im2 Do Q'];
    for (const content of contents) {
      const page = doc.addPage([400, 300]);
      page.node.set(PDFName.of('Resources'), shared);
      page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(content)));
    }
    return doc.save({ useObjectStreams: false });
  }

  it('what only the removed page draws does not ride along in the resources the kept page shares with it', async () => {
    const bytes = await sharedResourcesPdf();
    expect(Buffer.from(bytes).toString('latin1')).toContain(SECRET);
    const extraction = await readPdf(bytes, { assets: ASSETS });
    expect(extraction.plainText).toContain(SECRET);
    const { extraction: edited } = applyPdfEdits(extraction, { removedPages: [1] });
    const { result, out } = await write(edited, [['umowa najmu', '[DOC_1]']]);
    expect(result.removedPages).toEqual([1]);

    expect(Buffer.from(out).toString('latin1')).not.toContain('tajny aneks');
    const doc = await PDFDocument.load(out, { updateMetadata: false });
    expect(doc.getPageCount()).toBe(1);
    const xobjects = getDict(doc.context, doc.getPage(0).node.Resources(), 'XObject')!;
    expect([...xobjects.entries()].map(([k]) => k.decodeText())).toEqual(['Fx1']);
    // No image is left in the file at all.
    const images = [...doc.context.enumerateIndirectObjects()].filter(([, o]) => o instanceof PDFRawStream && getName(doc.context, o.dict, 'Subtype') === 'Image');
    expect(images).toEqual([]);
    expect((await extractPdf(out)).plainText).toContain('Strona pierwsza: [DOC_1] lokalu');
  });

  it('the verifier refuses an output that kept the removed page, its text or a stream only it uses', async () => {
    const bytes = await sharedResourcesPdf();
    const source = await extractPdf(bytes);
    const removedText = source.plainText.slice(source.pages[1].textStart);
    const keptText = source.plainText.slice(0, source.pages[1].textStart);
    const expected = {
      pageCount: 1, removedTexts: [removedText], keptTexts: [keptText],
      foreignStreams: [streamFingerprint(new TextEncoder().encode(SECRET_FORM))], picturePages: [], regions: [],
    };

    // 1. The file itself as "output": both pages, the removed text readable.
    const untouched = await openWithOracle(bytes, ASSETS);
    const whole = await verifyPdf({ bytes, needles: [], oracle: untouched, edits: expected });
    await untouched.close();
    expect(whole.map((f) => f.pass)).toEqual(expect.arrayContaining(['page-count', 'removed-page', 'foreign-stream']));

    // 2. A plain copy of page 1: one page, no removed text a reader sees, but form Fx2 is in the file.
    const src = await PDFDocument.load(bytes, { updateMetadata: false });
    const naive = await PDFDocument.create({ updateMetadata: false });
    naive.addPage((await naive.copyPages(src, [0]))[0]);
    const copied = await naive.save({ useObjectStreams: false });
    expect((await extractPdf(copied)).plainText).not.toContain('tajny');
    const findings = await verifyPdf({ bytes: copied, needles: [], edits: expected });
    expect(findings.map((f) => f.pass)).toEqual(['foreign-stream']);

    // 3. What the writer makes passes the same check.
    const { extraction: edited } = applyPdfEdits(await readPdf(bytes, { assets: ASSETS }), { removedPages: [1] });
    const { out } = await write(edited, []);
    expect(await verifyPdf({ bytes: out, needles: [], edits: expected })).toEqual([]);
  });

  it('one resource dictionary for every page (as FPDF writes): kept pages keep what they draw and look the same', async () => {
    const canvas = await nodeCanvasFactory();
    if (!canvas) return;
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.registerFontkit(fontkit);
    const helvetica = await doc.embedFont(StandardFonts.Helvetica);
    // An embedded font only page 2 uses: its program and ToUnicode map are streams of that page alone.
    const mono = await doc.embedFont(new Uint8Array(readFileSync(join(FONTS, 'LiberationMono-Regular.ttf'))), { subset: false });
    const picture = (seed: number) => doc.context.register(doc.context.flateStream(
      new Uint8Array(24 * 24 * 3).map((_, i) => (i * seed) % 256), { Type: 'XObject', Subtype: 'Image', Width: 24, Height: 24, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 },
    ));
    const shared = doc.context.register(doc.context.obj({
      Font: { F1: helvetica.ref, F2: mono.ref },
      XObject: { I1: picture(7), I2: picture(11), I3: picture(13) },
    }));
    const contents = [
      'BT /F1 12 Tf 40 250 Td (Faktura 1 dla Jan Kowalski) Tj ET q 60 0 0 60 40 100 cm /I1 Do Q',
      `BT /F2 12 Tf 40 250 Td ${mono.encodeText('Faktura 2 dla Maria Wozniak').toString()} Tj ET q 60 0 0 60 40 100 cm /I2 Do Q`,
      'BT /F1 12 Tf 40 250 Td (Faktura 3 dla Anna Nowak) Tj ET q 60 0 0 60 40 100 cm /I3 Do Q',
    ];
    for (const content of contents) {
      const page = doc.addPage([400, 300]);
      page.node.set(PDFName.of('Resources'), shared);
      page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(new TextEncoder().encode(content))));
    }
    const bytes = await doc.save({ useObjectStreams: false });
    expect(Buffer.from(bytes).toString('latin1')).toContain('LiberationMono');
    const extraction = await readPdf(bytes, { assets: ASSETS });
    expect(extraction.plainText).toContain('Faktura 2 dla Maria Wozniak');
    const { extraction: edited } = applyPdfEdits(extraction, { removedPages: [1] });
    const { out } = await write(edited, []);

    const outDoc = await PDFDocument.load(out, { updateMetadata: false });
    expect(outDoc.getPageCount()).toBe(2);
    const streams = [...outDoc.context.enumerateIndirectObjects()].map(([, o]) => o).filter((o): o is PDFRawStream => o instanceof PDFRawStream);
    // Two pictures (I1, I3) and one font: the picture and the font only page 2 used are gone.
    expect(streams.filter((o) => getName(outDoc.context, o.dict, 'Subtype') === 'Image')).toHaveLength(2);
    expect(Buffer.from(out).toString('latin1')).not.toContain('LiberationMono');
    for (const [k, p] of [[0, 0], [1, 2]]) {
      const names = (key: string) => [...getDict(outDoc.context, outDoc.getPage(k).node.Resources(), key)!.entries()].map(([n]) => n.decodeText());
      // Still the one dictionary, now with what the two kept pages draw.
      expect(names('XObject')).toEqual(['I1', 'I3']);
      expect(names('Font')).toEqual(['F1']);
      // The kept page is drawn as before, pixel for pixel.
      const before = await render(bytes, p, 1);
      const after = await render(out, k, 1);
      expect(Buffer.from(after.rgba.buffer).equals(Buffer.from(before.rgba.buffer)), `page ${p + 1}`).toBe(true);
    }
    expect((await extractPdf(out)).plainText).toBe('Faktura 1 dla Jan Kowalski\n\nFaktura 3 dla Anna Nowak\n\n');
  });

  it('text two pages share is not a trace of the removed one', async () => {
    const letterhead = 'Kancelaria Prawna Lex sp. z o.o., ul. Dluga 5, Warszawa';
    const pages = [[letterhead, 'Pismo pierwsze w sprawie najmu'], [letterhead, 'Pismo drugie w sprawie rozwodu']];
    const extraction = await readPdf(await textPdf(pages), { assets: ASSETS });
    const { extraction: edited } = applyPdfEdits(extraction, { removedPages: [1] });
    const { out } = await write(edited, []);
    const text = (await extractPdf(out)).plainText;
    expect(text).toContain(letterhead);
    expect(text).not.toContain('rozwodu');
  });
});

describe('hidden areas on a text page', () => {
  it('glyphs under the rectangle leave the text; a word half under it loses the letters it touches', async () => {
    const extraction = await readPdf(await textPdf(PAGES), { assets: ASSETS });
    const signature = boxOf(extraction, 'Anna Nowak');
    const half = boxOf(extraction, 'Kowal');
    const { extraction: edited, kept, addedText, covered } = applyPdfEdits(extraction, { regions: [signature, half] });

    expect(edited.plainText).not.toMatch(/Anna|Nowak|Kowal/);
    expect(edited.plainText).toContain('Wynajmujacy: Jan ski, Warszawa');
    expect(edited.plainText).toMatch(/Podpis: ?\n*$/);
    // The lines above and below a hidden one are whole.
    expect(edited.plainText).toContain('Najemca: Piotr Zielinski, Krakow');
    expect(edited.plainText).toContain('Email: jan.kowalski@example.com');
    expect(addedText).toBe(false);
    expectKept(kept, extraction.plainText, edited.plainText);
    for (const run of edited.runs) {
      run.glyphs.forEach((g, i) => expect(edited.plainText.slice(run.textOffsets[i], run.textOffsets[i] + g.unicode.length)).toBe(g.unicode));
      expect(run.local.advances).toHaveLength(run.glyphs.length);
    }
    // Where letters are painted over with the rectangles: one box per stretch, around the rectangle that took it.
    expect(covered.map((c) => c.page).sort()).toEqual([0, 2]);
    const box = covered.find((c) => c.page === 2)!.rect;
    expect(box.x0).toBeLessThanOrEqual(signature.rect.x0);
    expect(box.x1).toBeGreaterThanOrEqual(signature.rect.x1);
  });

  it('where hiding a word would join its neighbours, one space stays', async () => {
    // "/" has no space around it: without the word between, "Anna" and "Nowak" would read as one.
    const extraction = await readPdf(await textPdf([['Podpisali: Anna/Maria/Nowak dnia dzisiejszego']]), { assets: ASSETS });
    const { extraction: edited, kept } = applyPdfEdits(extraction, { regions: [boxOf(extraction, '/Maria/')] });
    expect(edited.plainText).toContain('Podpisali: Anna Nowak dnia dzisiejszego');
    expectKept(kept, extraction.plainText, edited.plainText);
  });

  it('the page is exported as a picture: the area black in the pixels, its glyphs gone from the output, the rest searchable', async () => {
    const canvas = await nodeCanvasFactory();
    if (!canvas) return; // no native canvas here
    const extraction = await readPdf(await textPdf(PAGES), { assets: ASSETS });
    const signature = boxOf(extraction, 'Anna Nowak');
    const title = boxOf(extraction, 'Postanowienia koncowe');
    const { extraction: edited } = applyPdfEdits(extraction, { regions: [signature] });
    const { result, out } = await write(edited, [['Piotr Zielinski', '[PERSON_1]'], ['Jan Kowalski', '[PERSON_2]']]);

    expect(result.regionPages).toEqual([2]);
    expect(result.scanPages).toEqual([2]); // written like a scan: values painted over, text kept as a layer
    expect(result.rasterizedPages).toEqual([]);
    expect(result.removedPages).toEqual([]);
    expect(result.warnings.some((w) => /^page 3: 1 area hidden by hand/.test(w))).toBe(true);

    // The page is one image and invisible text; pages 1 and 2 stay vector text.
    const doc = await PDFDocument.load(out, { updateMetadata: false });
    expect(doc.getPageCount()).toBe(3);
    const after = await extractPdf(out);
    expect(after.runs.filter((r) => r.page === 2).every((r) => r.renderMode === 3)).toBe(true);
    expect(after.runs.filter((r) => r.page === 0).every((r) => r.renderMode === 0)).toBe(true);
    expect(after.plainText).toContain('Wynajmujacy: [PERSON_2], Warszawa');
    expect(after.plainText).toContain('Najemca: [PERSON_1], Krakow');
    expect(after.plainText).toContain('Postanowienia koncowe');
    expect(after.plainText).toContain('Podpis:');
    expect(after.plainText).not.toMatch(/Anna|Nowak|Zielinski|Kowalski/);

    const img = await render(out, 2, 2);
    expect(blackShare(img, signature.rect)).toBe(1);
    // The rest of the page is still there to read: the title's ink, and paper between the lines.
    expect(inkIn(img, title.rect)).toBeGreaterThan(100);
    expect(blackShare(img, { x0: 40, y0: 20, x1: 360, y1: 120 })).toBe(0);
  });

  it('a letter the rectangle only touches is painted over whole, not left half readable', async () => {
    const canvas = await nodeCanvasFactory();
    if (!canvas) return;
    const extraction = await readPdf(await textPdf([['Podpis: Anna Nowak']]), { assets: ASSETS });
    const word = boxOf(extraction, 'Nowak');
    // Only the lower part of the letters is under the rectangle.
    const low = { page: 0, rect: { ...word.rect, y1: word.rect.y0 + 4 } };
    const { extraction: edited } = applyPdfEdits(extraction, { regions: [low] });
    expect(edited.plainText).toMatch(/^Podpis: Anna ?\n*$/);
    const { out } = await write(edited, []);
    const before = await render(await textPdf([['Podpis: Anna Nowak']]), 0, 2);
    const img = await render(out, 0, 2);
    // Above the rectangle, where the upper part of "Nowak" was: nothing but black now.
    const upper = { x0: word.rect.x0 + 1, x1: word.rect.x1 - 1, y0: word.rect.y0 + 5, y1: word.rect.y0 + 9 };
    expect(inkIn(before, upper)).toBeGreaterThan(20);
    expect(blackShare(img, upper)).toBe(1);
    // "Anna" next to it is untouched.
    const anna = boxOf(extraction, 'Anna').rect;
    expect(Math.abs(inkIn(img, anna) - inkIn(before, anna))).toBeLessThan(inkIn(before, anna) * 0.1);
  });

  it('a rectangle over blank paper takes no text, and the page is still exported painted', async () => {
    const canvas = await nodeCanvasFactory();
    if (!canvas) return;
    const extraction = await readPdf(await textPdf(PAGES), { assets: ASSETS });
    const blank = { page: 0, rect: { x0: 200, y0: 40, x1: 360, y1: 100 } }; // a handwritten signature would be here
    const { extraction: edited, kept, covered } = applyPdfEdits(extraction, { regions: [blank] });
    expect(edited.plainText).toBe(extraction.plainText);
    expect(kept).toEqual([{ from: 0, to: 0, length: extraction.plainText.length }]);
    expect(covered).toEqual([]);
    const { result, out } = await write(edited, []);
    expect(result.regionPages).toEqual([0]);
    expect(blackShare(await render(out, 0, 2), blank.rect)).toBe(1);
    expect((await extractPdf(out)).plainText).toContain('Wynajmujacy: Jan Kowalski, Warszawa');
  });

  it('a value that runs over a hidden word is replaced on both sides of it', async () => {
    const canvas = await nodeCanvasFactory();
    if (!canvas) return;
    const extraction = await readPdf(await textPdf([['Podpisali: Anna/Maria/Nowak dnia dzisiejszego']]), { assets: ASSETS });
    const { extraction: edited } = applyPdfEdits(extraction, { regions: [boxOf(extraction, '/Maria/')] });
    // The detector sees "Anna Nowak" in the edited text and marks it as one name.
    const { out } = await write(edited, [['Anna Nowak', '[PERSON_1]']]);
    const text = (await extractPdf(out)).plainText;
    expect(text).toContain('Podpisali: [PERSON_1]');
    expect(text).toContain('dnia dzisiejszego');
    expect(text).not.toMatch(/Anna|Maria|Nowak/);
  });

  it('a page whose text cannot be edited safely is rasterized: the area and the values as black boxes, no text layer', async () => {
    const canvas = await nodeCanvasFactory();
    if (!canvas) return;
    // A font dictionary without /Subtype: pdf.js reads no text, our decoder does; an edit rasterizes the page.
    const doc = await PDFDocument.create({ updateMetadata: false });
    const page = doc.addPage([400, 300]);
    page.node.setFontDictionary(PDFName.of('F1'), doc.context.register(doc.context.obj({ Type: 'Font', BaseFont: 'Helvetica' })));
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream('BT /F1 12 Tf 40 250 Td (Klient: Jan Kowalski) Tj 0 -40 Td (Podpis: Anna Nowak) Tj ET')));
    const extraction = await readPdf(await doc.save({ useObjectStreams: false }), { assets: ASSETS });
    const region = boxOf(extraction, 'Anna Nowak');
    const { extraction: edited } = applyPdfEdits(extraction, { regions: [region] });
    expect(edited.plainText).not.toMatch(/Anna|Nowak/);
    const { result, out } = await write(edited, []);
    expect(result.regionPages).toEqual([0]);
    expect(result.rasterizedPages).toEqual([0]);
    expect(result.scanPages).toEqual([]);
    expect(result.warnings.some((w) => /^page 1: 1 area hidden by hand/.test(w))).toBe(true);
    expect((await extractPdf(out)).plainText.trim()).toBe('');
    expect(blackShare(await render(out, 0, 2), region.rect)).toBe(1);
  });

  it('text inside a tiling pattern has no place on the page: it stays in the text, and the reader says so', async () => {
    const canvas = await nodeCanvasFactory();
    if (!canvas) return;
    const doc = await PDFDocument.create({ updateMetadata: false });
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    const ctx = doc.context;
    await doc.save({ useObjectStreams: false }); // flush the font dict (this also adds a blank first page)
    const pattern = ctx.register(ctx.stream('BT /F1 14 Tf 10 10 Td (Jan Kowalski) Tj ET', {
      Type: 'Pattern', PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 200, 40], XStep: 200, YStep: 40,
      Resources: ctx.obj({ Font: ctx.obj({ F1: helv.ref }) }),
    }));
    const page = doc.addPage([400, 300]);
    page.node.set(PDFName.of('Resources'), ctx.obj({ Pattern: ctx.obj({ P1: pattern }), Font: ctx.obj({ F1: helv.ref }) }));
    page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream('/Pattern cs /P1 scn 50 200 300 60 re f BT /F1 12 Tf 50 100 Td (Other text on page) Tj ET')));
    const extraction = await readPdf(await doc.save({ useObjectStreams: false }), { assets: ASSETS });
    // Over the whole filled area and the line below it.
    const { extraction: edited } = applyPdfEdits(extraction, { regions: [{ page: 1, rect: { x0: 40, y0: 90, x1: 360, y1: 270 } }] });
    expect(edited.plainText).toContain('Jan Kowalski');
    expect(edited.plainText).not.toContain('Other text');
    expect(edited.warnings.some((w) => /^page 2: text inside a pattern/.test(w))).toBe(true);
    // The page is exported as a picture with the area black; the pattern's text is in no text layer.
    const { result, out } = await write(edited, []);
    expect(result.regionPages).toEqual([1]);
    expect((await extractPdf(out)).plainText.trim()).toBe('');
    expect(blackShare(await render(out, 1, 2), { x0: 40, y0: 90, x1: 360, y1: 270 })).toBe(1);
    // A value found in the pattern's text cannot be painted over where a raster would show it: refused, as before.
    await expect(write(edited, [['Jan Kowalski', '[PERSON_1]']])).rejects.toThrow(/pattern or soft mask/);
  });

  it('the verifier refuses an output whose hidden area still shows the page', async () => {
    const canvas = await nodeCanvasFactory();
    if (!canvas) return;
    const bytes = await textPdf([['Podpis: Anna Nowak']]);
    const extraction = await readPdf(bytes, { assets: ASSETS });
    const region = boxOf(extraction, 'Anna Nowak');
    const expected = { pageCount: 1, removedTexts: [], keptTexts: [], foreignStreams: [], picturePages: [0], regions: [region], canvasFactory: canvas };

    // The file as it was: live text under where the black should be.
    const oracle = await openWithOracle(bytes, ASSETS);
    const findings = await verifyPdf({ bytes, needles: [], oracle, edits: expected });
    await oracle.close();
    expect(findings.map((f) => f.pass).sort()).toEqual(['region-page', 'region-pixels', 'region-text']);

    // A black box drawn OVER the live text: black to the eye, the text still under it.
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const r = region.rect;
    doc.getPage(0).drawRectangle({ x: r.x0 - 2, y: r.y0 - 2, width: r.x1 - r.x0 + 4, height: r.y1 - r.y0 + 4 });
    const overlaid = await doc.save({ useObjectStreams: false });
    const oracle2 = await openWithOracle(overlaid, ASSETS);
    const overlay = await verifyPdf({ bytes: overlaid, needles: [], oracle: oracle2, edits: expected });
    await oracle2.close();
    expect(overlay.map((f) => f.pass).sort()).toEqual(['region-page', 'region-text']);

    // The writer's own output passes, and a failed check throws PdfVerifyError.
    const { extraction: edited } = applyPdfEdits(extraction, { regions: [region] });
    const { out } = await write(edited, []);
    const oracle3 = await openWithOracle(out, ASSETS);
    expect(await verifyPdf({ bytes: out, needles: [], oracle: oracle3, edits: expected })).toEqual([]);
    // The same output held against an area it does not hide.
    const elsewhere = { ...expected, regions: [boxOf(extraction, 'Podpis')] };
    const missed = await verifyPdf({ bytes: out, needles: [], oracle: oracle3, edits: elsewhere });
    await oracle3.close();
    expect(missed.map((f) => f.pass).sort()).toEqual(['region-pixels', 'region-text']);
    expect(new PdfVerifyError(missed).message).toContain('region-pixels');
  });
});

describe('hidden areas on a scan with an OCR layer', () => {
  const LINES = [
    ['Umowa', 'zawarta', 'z', 'Kowalski', 'Jan,', 'Warszawa.'],
    ['Podpisano', 'przez', 'Nowak', 'Anna', 'dnia', 'dzisiejszego.'],
  ];

  it('the words under the rectangle leave the OCR text and the picture; a value elsewhere is painted over as before', async () => {
    const scan = await buildScanPdf([{ kind: 'scan', lines: LINES, values: ['Kowalski'], layer: 'tr3' }]);
    if (!scan) return;
    const extraction = await readPdf(scan.bytes, { assets: ASSETS });
    expect(extraction.pages[0]).toMatchObject({ imageOnly: true, ocrText: true });
    // The printed "Nowak Anna", from where the fixture painted it (pixels at SCAN_DPI, top-left origin).
    const words = scan.words.filter((w) => w.text === 'Nowak' || w.text === 'Anna');
    const toPt = (px: number): number => (px * 72) / SCAN_DPI;
    const rect = {
      x0: toPt(Math.min(...words.map((w) => w.x0))) - 1, x1: toPt(Math.max(...words.map((w) => w.x1))) + 1,
      y0: 792 - toPt(Math.max(...words.map((w) => w.y1))), y1: 792 - toPt(Math.min(...words.map((w) => w.y0))),
    };
    const { extraction: edited } = applyPdfEdits(extraction, { regions: [{ page: 0, rect }] });
    expect(edited.plainText).not.toMatch(/Nowak|Anna/);
    expect(edited.plainText).toContain('Podpisano przez');
    expect(edited.plainText).toContain('dnia dzisiejszego.');

    const { result, out } = await write(edited, [['Kowalski', '[PERSON_1]']], { allowUnredactable: true });
    expect(result.regionPages).toEqual([0]);
    expect(result.scanPages).toEqual([0]);
    const text = (await extractPdf(out)).plainText;
    expect(text).toContain('Umowa zawarta z [PERSON_1] Jan, Warszawa.');
    expect(text).toContain('Podpisano przez');
    expect(text).not.toMatch(/Nowak|Anna|Kowalski/);
    const img = await render(out, 0, 2);
    expect(blackShare(img, rect)).toBe(1);
    // The value painted red in the scan is covered too; the words that stay still show their ink.
    let red = 0;
    for (let i = 0; i < img.rgba.length; i += 4) if (img.rgba[i] - Math.max(img.rgba[i + 1], img.rgba[i + 2]) > 60) red++;
    expect(red).toBe(0);
    const stays = scan.words.find((w) => w.text === 'Podpisano')!;
    expect(inkIn(img, { x0: toPt(stays.x0), x1: toPt(stays.x1), y0: 792 - toPt(stays.y1), y1: 792 - toPt(stays.y0) })).toBeGreaterThan(100);
  });

  it('a picture without any text: the signature area is painted black, and removing the page lifts the consent it needed', async () => {
    const scan = await buildScanPdf([{ kind: 'text', lines: ['Umowa najmu lokalu'] }, { kind: 'scan', lines: LINES, values: [], layer: 'none' }]);
    if (!scan) return;
    const extraction = await readPdf(scan.bytes, { assets: ASSETS });
    expect(extraction.unredactable.map((u) => u.part)).toEqual(['page 2']);

    // Hide an area of the picture: still a page nobody could scan for text, so still gated.
    const rect = { x0: 60, y0: 600, x1: 400, y1: 720 };
    const hidden = applyPdfEdits(extraction, { regions: [{ page: 1, rect }] }).extraction;
    expect(hidden.unredactable.map((u) => u.part)).toEqual(['page 2']);
    const { result, out } = await write(hidden, [], { allowUnredactable: true });
    expect(result.regionPages).toEqual([1]);
    expect(blackShare(await render(out, 1, 2), rect)).toBe(1);

    // Leave the page out: nothing unredactable is left, no consent needed.
    const without = applyPdfEdits(hidden, { removedPages: [1] });
    expect(without.extraction.unredactable).toEqual([]);
    expect(without.extraction.warnings.some((w) => /^page 2:/.test(w))).toBe(false);
    const { result: second, out: onePage } = await write(without.extraction, []);
    expect(second.removedPages).toEqual([1]);
    expect(second.regionPages).toEqual([]);
    const doc = await PDFDocument.load(onePage, { updateMetadata: false });
    expect(doc.getPageCount()).toBe(1);
    // The scan's picture is not in the file.
    expect([...doc.context.enumerateIndirectObjects()].some(([, o]) => o instanceof PDFRawStream && getName(doc.context, o.dict, 'Subtype') === 'Image')).toBe(false);
  });
});

describe('edits applied again and taken back', () => {
  it('each call replaces the edits before it; addedText says when detection must run again', async () => {
    const extraction = await readPdf(await textPdf(PAGES), { assets: ASSETS });
    const signature = boxOf(extraction, 'Anna Nowak');

    const first = applyPdfEdits(extraction, { regions: [signature] });
    expect(first.addedText).toBe(false);
    expect(first.extraction.plainText).not.toContain('Nowak');

    // More taken out: nothing new to detect.
    const second = applyPdfEdits(first.extraction, { regions: [signature], removedPages: [1] });
    expect(second.addedText).toBe(false);
    expect(second.extraction.plainText).not.toMatch(/Nowak|Wozniak/);
    expectKept(second.kept, first.extraction.plainText, second.extraction.plainText);
    // A detection on page 1 made on the first text is found again in the second.
    const at = first.extraction.plainText.indexOf('Jan Kowalski');
    const mapped = mapKeptRange(second.kept, at, at + 12)!;
    expect(second.extraction.plainText.slice(mapped.start, mapped.end)).toBe('Jan Kowalski');

    // The area taken away while the page stays out: text comes back, detection must run again.
    const third = applyPdfEdits(second.extraction, { removedPages: [1] });
    expect(third.addedText).toBe(true);
    expect(third.extraction.plainText).toContain('Podpis: Anna Nowak');
    expect(third.extraction.plainText).not.toContain('Wozniak');
    expectKept(third.kept, second.extraction.plainText, third.extraction.plainText);

    // Same edits in another order or written differently: the same text.
    const again = applyPdfEdits(extraction, { removedPages: [1, 1], regions: [] });
    expect(again.extraction.plainText).toBe(third.extraction.plainText);

    // Everything taken back: the extraction as read, the very object.
    const back = applyPdfEdits(third.extraction, {});
    expect(back.addedText).toBe(true);
    expect(back.extraction).toBe(extraction);
    expect(back.extraction.edits).toBeUndefined();
    expectKept(back.kept, third.extraction.plainText, extraction.plainText);
    expect(applyPdfEdits(extraction, {}).addedText).toBe(false);
  });

  it('an area on a removed page is kept and comes into force when the page is brought back', async () => {
    const extraction = await readPdf(await textPdf(PAGES), { assets: ASSETS });
    const signature = boxOf(extraction, 'Anna Nowak');
    const out = applyPdfEdits(extraction, { regions: [signature], removedPages: [2] });
    expect(out.extraction.edits).toEqual({ removedPages: [2], regions: [signature] });
    expect(out.covered).toEqual([]);
    const back = applyPdfEdits(out.extraction, { regions: out.extraction.edits!.regions });
    expect(back.addedText).toBe(true);
    expect(back.extraction.plainText).toContain('Najemca: Piotr Zielinski, Krakow');
    expect(back.extraction.plainText).not.toContain('Nowak');
  });

  it('readPdf with edits reads the same text as applyPdfEdits gives', async () => {
    const bytes = await textPdf(PAGES);
    const extraction = await readPdf(bytes, { assets: ASSETS });
    const edits = { removedPages: [0], regions: [boxOf(extraction, 'Anna Nowak')] };
    const applied = applyPdfEdits(extraction, edits).extraction;
    const read = await readPdf(bytes, { assets: ASSETS, edits });
    expect(read.plainText).toBe(applied.plainText);
    expect(read.edits).toEqual(applied.edits);
    expect(read.pages).toEqual(applied.pages);
  });
});

describe('stale check with edits', () => {
  it('the writer applies the edits the extraction carries to a fresh reading and refuses when the text differs', async () => {
    const canvas = await nodeCanvasFactory();
    const extraction = await readPdf(await textPdf(PAGES), { assets: ASSETS });
    const edited = applyPdfEdits(extraction, { removedPages: [1] }).extraction;
    const go = (x: PdfExtraction) => writeAnonymizedPdfWithReport(x, [], [], { assets: ASSETS, canvasFactory: canvas });

    await expect(go(edited)).resolves.toMatchObject({ removedPages: [1] });
    // Other edits than the text was made with.
    await expect(go({ ...edited, edits: { removedPages: [0] } })).rejects.toBeInstanceOf(StalePdfExtractionError);
    // The edits dropped, the edited text kept: nothing says a page is out, so the text is not this file's.
    await expect(go({ ...edited, edits: undefined })).rejects.toBeInstanceOf(StalePdfExtractionError);
    // The text as read with edits attached.
    await expect(go({ ...extraction, edits: { removedPages: [1] } })).rejects.toBeInstanceOf(StalePdfExtractionError);
    // Edits for a page the file does not have.
    await expect(go({ ...edited, edits: { removedPages: [7] } })).rejects.toBeInstanceOf(StalePdfExtractionError);
    // An extraction of other bytes with these edits.
    const other = await readPdf(await textPdf([['Inny plik'], ['Druga strona'], ['Trzecia']]), { assets: ASSETS });
    await expect(go({ ...edited, bytes: other.bytes })).rejects.toBeInstanceOf(StalePdfExtractionError);
  });

  it('offsets of the edited text are the ones the writer takes', async () => {
    const extraction = await readPdf(await textPdf(PAGES), { assets: ASSETS });
    const edited = applyPdfEdits(extraction, { removedPages: [0] }).extraction;
    const at = edited.plainText.indexOf('Piotr Zielinski');
    const result = await writeAnonymizedPdfWithReport(edited, [{ start: at, end: at + 15, replacement: '[PERSON_1]' }], [], { assets: ASSETS });
    const text = (await extractPdf(new Uint8Array(await result.blob.arrayBuffer()))).plainText;
    expect(text).toContain('Najemca: [PERSON_1], Krakow');
    expect(text).toContain('Wspolnik: Maria Wozniak, Gdansk');
    expect(text).not.toContain('Umowa najmu');
    // An offset of the text as read no longer fits the edited one.
    const stale = extraction.plainText.length;
    await expect(writeAnonymizedPdfWithReport(edited, [{ start: stale - 5, end: stale, replacement: 'x' }], [], { assets: ASSETS }))
      .rejects.toBeInstanceOf(StalePdfExtractionError);
  });
});

describe('no edits', () => {
  it('an extraction whose edits were taken back writes the same bytes as one that never had any', async () => {
    const bytes = await textPdf(PAGES);
    const extraction = await readPdf(bytes, { assets: ASSETS });
    const values: Array<[string, string]> = [['Jan Kowalski', '[PERSON_1]'], ['Maria Wozniak', '[PERSON_2]']];
    const plain = await write(extraction, values);
    expect(plain.result.removedPages).toEqual([]);
    expect(plain.result.regionPages).toEqual([]);

    const edited = applyPdfEdits(extraction, { removedPages: [2], regions: [boxOf(extraction, 'Anna Nowak')] }).extraction;
    const back = applyPdfEdits(edited, {}).extraction;
    expect(back).toBe(extraction);
    const again = await write(back, values);
    expect(Buffer.from(again.out).equals(Buffer.from(plain.out))).toBe(true);
    // Empty lists are no edits either.
    const empty = await write({ ...extraction, edits: { removedPages: [], regions: [] } }, values);
    expect(Buffer.from(empty.out).equals(Buffer.from(plain.out))).toBe(true);
  });
});

describe('page pictures and rectangles between pixels and user space', () => {
  it('opens once, tells the size of a page as shown and renders a page when asked', async () => {
    const canvas = await nodeCanvasFactory();
    if (!canvas) return;
    const doc = await PDFDocument.load(await textPdf(PAGES), { updateMetadata: false });
    doc.getPage(1).setRotation(degrees(90));
    const extraction = await readPdf(await doc.save({ useObjectStreams: false }), { assets: ASSETS });
    // The preview shows the file as read, whatever the edits.
    const edited = applyPdfEdits(extraction, { removedPages: [0] }).extraction;
    const preview = await openPdfPreview(edited, { canvasFactory: canvas });
    try {
      expect(preview.pageCount).toBe(3);
      expect(await preview.pageSize(0)).toEqual({ width: 400, height: 300, rotate: 0 });
      expect(await preview.pageSize(1)).toEqual({ width: 300, height: 400, rotate: 90 });
      const thumb = await preview.render(1, 0.25);
      expect([thumb.widthPx, thumb.heightPx]).toEqual([75, 100]);
      const view = await preview.render(0, 2);
      expect([view.widthPx, view.heightPx]).toEqual([800, 600]);
      // The removed page is rendered like any other: "Umowa najmu lokalu" has ink where its glyphs are.
      const title = boxOf(extraction, 'Umowa najmu lokalu').rect;
      expect(inkIn({ rgba: view.canvas.getImageData(), width: view.widthPx, transform: view.transform }, title)).toBeGreaterThan(100);
      await expect(preview.render(3, 1)).rejects.toThrow(RangeError);
    } finally {
      await preview.close();
    }
  });

  it('converts a rectangle both ways on pages of every /Rotate', () => {
    // pdf.js viewport transforms of a 400 x 300 pt page at scale 2 (y flip, scale, rotation).
    const W = 400, H = 300, S = 2;
    const transforms: Record<number, number[]> = {
      0: [S, 0, 0, -S, 0, H * S],
      90: [0, S, S, 0, 0, 0],
      180: [-S, 0, 0, S, W * S, 0],
      270: [0, -S, -S, 0, H * S, W * S],
    };
    const user = { x0: 40, y0: 20, x1: 100, y1: 50 }; // near the bottom-left corner of the unrotated page
    // Where a viewer shows that corner of the page: bottom-left, top-left, top-right, bottom-right.
    const shown: Record<number, { x0: number; y0: number; x1: number; y1: number }> = {
      0: { x0: 80, y0: 500, x1: 200, y1: 560 },
      90: { x0: 40, y0: 80, x1: 100, y1: 200 },
      180: { x0: 600, y0: 40, x1: 720, y1: 100 },
      270: { x0: 500, y0: 600, x1: 560, y1: 720 },
    };
    for (const rotate of [0, 90, 180, 270]) {
      const px = userRectToPixelRect(transforms[rotate], user);
      expect(px, `rotate ${rotate}`).toEqual(shown[rotate]);
      const back = pixelRectToUserRect(transforms[rotate], px);
      for (const k of ['x0', 'y0', 'x1', 'y1'] as const) expect(back[k], `rotate ${rotate} ${k}`).toBeCloseTo(user[k], 9);
      // Drawn from any corner to the opposite one: the same area.
      const dragged = pixelRectToUserRect(transforms[rotate], { x0: px.x1, y0: px.y1, x1: px.x0, y1: px.y0 });
      for (const k of ['x0', 'y0', 'x1', 'y1'] as const) expect(dragged[k]).toBeCloseTo(user[k], 9);
    }
    expect(() => pixelRectToUserRect([0, 0, 0, 0, 0, 0], shown[0])).toThrow(RangeError);
  });

  it('these transforms are the ones pdf.js renders with: a rectangle drawn on a rotated page hides what is under it', async () => {
    const canvas = await nodeCanvasFactory();
    if (!canvas) return;
    const doc = await PDFDocument.load(await textPdf([['Umowa najmu lokalu', 'Podpis: Anna Nowak']]), { updateMetadata: false });
    doc.getPage(0).setRotation(degrees(90));
    const extraction = await readPdf(await doc.save({ useObjectStreams: false }), { assets: ASSETS });
    const preview = await openPdfPreview(extraction, { canvasFactory: canvas });
    const view = await preview.render(0, 2);
    await preview.close();
    expect(view.transform.map((v) => Math.round(v))).toEqual([0, 2, 2, 0, 0, 0]);
    expect([view.widthPx, view.heightPx]).toEqual([600, 800]);

    // The user drags over "Anna Nowak" as the rotated page shows it: the line runs downwards.
    const word = boxOf(extraction, 'Anna Nowak').rect;
    const drawn = userRectToPixelRect(view.transform, word);
    expect(drawn.y1 - drawn.y0).toBeGreaterThan(drawn.x1 - drawn.x0);
    const before = { rgba: view.canvas.getImageData(), width: view.widthPx, transform: [1, 0, 0, 1, 0, 0] };
    const asPixels = { x0: drawn.x0, y0: drawn.y0, x1: drawn.x1, y1: drawn.y1 };
    expect(inkIn(before, asPixels)).toBeGreaterThan(100); // the word is under the drawn rectangle

    const region = { page: 0, rect: pixelRectToUserRect(view.transform, drawn) };
    const { extraction: edited } = applyPdfEdits(extraction, { regions: [region] });
    expect(edited.plainText).not.toMatch(/Anna|Nowak/);
    expect(edited.plainText).toContain('Umowa najmu lokalu');
    const { result, out } = await write(edited, []);
    expect(result.regionPages).toEqual([0]);
    // The output page is the page as shown (300 x 400, no /Rotate): black where the user drew.
    const page = (await PDFDocument.load(out, { updateMetadata: false })).getPage(0);
    expect(page.getRotation().angle).toBe(0);
    expect(page.getSize()).toEqual({ width: 300, height: 400 });
    const img = await render(out, 0, 2);
    expect(blackShare({ ...img, transform: [1, 0, 0, 1, 0, 0] }, asPixels)).toBe(1);
    const text = (await extractPdf(out)).plainText;
    expect(text).toContain('Umowa najmu lokalu');
    expect(text).not.toMatch(/Anna|Nowak/);
  });
});
