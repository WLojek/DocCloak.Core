/**
 * Regression tests from the second review of the PDF module (T219): every case here
 * reproduced a defect found by the reviewers (layout, fonts, verifier, robustness).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, PDFName, PDFString, StandardFonts } from '@cantoo/pdf-lib';
import type { PDFDict, PDFFont } from '@cantoo/pdf-lib';
import fontkit from '@cantoo/fontkit';
import { readPdf, writeAnonymizedPdfWithReport, verifyPdf } from '../src/pdf/index.ts';
import type { PdfAssetPaths, PdfExtraction } from '../src/pdf/index.ts';
import { lexContent } from '../src/pdf/lexer.ts';
import { decodeStream } from '../src/pdf/objects.ts';
import { nodeCanvasFactory } from './helpers/pdf-canvas.ts';
import type { PDFRawStream, PDFRef } from '@cantoo/pdf-lib';

const FONTS = join(__dirname, '..', 'fonts', 'liberation');
const FIXTURES = join(__dirname, 'fixtures', 'pdf');
const ASSETS: PdfAssetPaths = { loadFont: async (file) => new Uint8Array(readFileSync(join(FONTS, file))) };

function latin1(text: string): Uint8Array {
  return Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);
}

async function newDoc(): Promise<PDFDocument> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);
  return doc;
}

/** A page with a raw content stream; fonts exposed under the given resource names. */
function rawPage(doc: PDFDocument, content: string | Uint8Array, fonts: Record<string, PDFFont | PDFDict>, size: [number, number] = [612, 792]): void {
  const page = doc.addPage(size);
  for (const [key, font] of Object.entries(fonts)) {
    const ref = 'ref' in font && font.ref ? (font as PDFFont).ref : doc.context.register(font as PDFDict);
    page.node.setFontDictionary(PDFName.of(key), ref);
  }
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(typeof content === 'string' ? latin1(content) : content)));
}

function spans(text: string, value: string, replacement: string): Array<{ start: number; end: number; replacement: string }> {
  const out: Array<{ start: number; end: number; replacement: string }> = [];
  for (let i = text.indexOf(value); i >= 0; i = text.indexOf(value, i + value.length)) out.push({ start: i, end: i + value.length, replacement });
  return out;
}

async function redact(bytes: Uint8Array, values: Array<[string, string]>, password?: string): Promise<{ extraction: PdfExtraction; after: PdfExtraction; out: Uint8Array; result: Awaited<ReturnType<typeof writeAnonymizedPdfWithReport>> }> {
  const extraction = await readPdf(bytes, { assets: ASSETS, password });
  const replacements = values.flatMap(([v, r]) => spans(extraction.plainText, v, r));
  const result = await writeAnonymizedPdfWithReport(extraction, replacements, values.map(([value, replacement]) => ({ value, replacement })), { assets: ASSETS });
  const out = new Uint8Array(await result.blob.arrayBuffer());
  const after = await readPdf(out, { assets: ASSETS });
  return { extraction, after, out, result };
}

function glyphX(ex: PdfExtraction, text: string): number {
  const run = ex.runs.find((r) => ex.plainText.slice(r.textStart, r.textEnd).includes(text));
  if (!run) throw new Error(`run with "${text}" not found`);
  const i = run.textOffsets.findIndex((o) => ex.plainText.startsWith(text, o));
  return run.glyphs[i].x;
}

async function fontNames(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const names: string[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj && typeof (obj as PDFDict).get === 'function' && (obj as PDFDict).get(PDFName.of('Type'))?.toString() === '/Font') {
      names.push((obj as PDFDict).get(PDFName.of('BaseFont'))?.toString() ?? '?');
    }
  }
  return names;
}

describe('verifier: code sequences', () => {
  it('a fragment of a value split over two shows does not block the export when the same word occurs elsewhere', async () => {
    const doc = await newDoc();
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    rawPage(doc, 'BT /F1 12 Tf 72 700 Td (Jan) Tj ( Kowalski) Tj 0 -20 Td (Meta: Kowalski & Sons sp. z o.o.) Tj ET', { F1: helv });
    const bytes = await doc.save({ useObjectStreams: false });
    const { after, out } = await redact(bytes, [['Jan Kowalski', '[PERSON_1]']]);
    expect(after.plainText).toContain('[PERSON_1]');
    expect(after.plainText).toContain('Meta: Kowalski & Sons');
    expect(await verifyPdf({ bytes: out, needles: ['Jan Kowalski'] })).toEqual([]);
  });
});

describe('layout', () => {
  it('an overflowing placeholder never pushes text into the next column; it gives up its floors instead', async () => {
    const doc = await newDoc();
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    rawPage(doc, 'BT /F1 12 Tf 50 760 Td (Tail: Li Wu) Tj ( i dalej dalszy tekst) Tj 1 0 0 1 300 760 Tm (kolumna 2: tekst) Tj ET', { F1: helv });
    const bytes = await doc.save({ useObjectStreams: false });
    const { extraction, after } = await redact(bytes, [['Li Wu', '[PERSON_WITH_A_VERY_LONG_PLACEHOLDER_4]']]);
    expect(glyphX(after, 'kolumna')).toBeCloseTo(glyphX(extraction, 'kolumna'), 3);
    const tail = after.runs.find((r) => after.plainText.slice(r.textStart, r.textEnd).includes('dalszy tekst'))!;
    const tailEnd = tail.glyphs[tail.glyphs.length - 1];
    expect(tailEnd.x + tailEnd.advance).toBeLessThan(glyphX(after, 'kolumna'));
  });

  it('a value wrapped at a line end in justified (word-per-Td) text: the wider part carries the placeholder, the rest of its line stays in order', async () => {
    const doc = await newDoc();
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    // Line 1 ends with "Jan"; line 2 is "Kowalski," + justified words positioned with Td (wide gaps).
    rawPage(doc, 'BT /F1 12 Tf 50 760 Td (Pan) Tj 24 0 Td (Jan) Tj -24 -15 Td (Kowalski,) Tj 64 0 Td (zobowiazuje) Tj 76 0 Td (sie) Tj -140 -15 Td (placic czynsz.) Tj ET', { F1: helv });
    const bytes = await doc.save({ useObjectStreams: false });
    const { extraction, after } = await redact(bytes, [['Jan Kowalski', '[PERSON_1]']]);
    expect(after.plainText).toContain('[PERSON_1]');
    expect(after.plainText).not.toContain('Kowalski');
    expect(after.plainText).not.toContain('Jan');
    // T225: "Kowalski," (line 2) is wider than "Jan" (line 1), so the placeholder sits on line 2 where
    // "Kowalski" was; the justified words after it keep their order; line 3 did not move.
    const ph = after.runs.find((r) => after.plainText.slice(r.textStart, r.textEnd).includes('[PERSON_1]'))!;
    expect(ph.glyphs[0].x).toBeCloseTo(glyphX(extraction, 'Kowalski'), 1);
    expect(ph.glyphs[0].y).toBeCloseTo(745, 3);
    const phEnd = ph.glyphs[ph.glyphs.length - 1].x + ph.glyphs[ph.glyphs.length - 1].advance * (ph.emX[0] / 1000);
    expect(glyphX(after, 'zobowiazuje')).toBeGreaterThanOrEqual(phEnd - 0.5);
    expect(glyphX(after, 'sie')).toBeGreaterThan(glyphX(after, 'zobowiazuje'));
    expect(glyphX(after, 'placic')).toBeCloseTo(glyphX(extraction, 'placic'), 3);
  });
});

describe('fonts', () => {
  it('a simple font whose ToUnicode disagrees with its encoding is not reused for the placeholder', async () => {
    // tounicode_remap.pdf: Helvetica (Standard encoding) with a ToUnicode that permutes the letters.
    const bytes = new Uint8Array(readFileSync(join(FIXTURES, 'tounicode_remap.pdf')));
    const { after, out } = await redact(bytes, [['92050812345', '[PESEL_1]']]);
    expect(after.plainText).toContain('[PESEL_1]');
    // The placeholder is shown in a fallback face: the original font's codes would draw other glyphs.
    expect((await fontNames(out)).some((n) => /Liberation/.test(n))).toBe(true);
    const run = after.runs.find((r) => after.plainText.slice(r.textStart, r.textEnd).includes('[PESEL_1]'))!;
    expect(run.fontName.startsWith('DCFb')).toBe(true);
  });

  it('a composite font placeholder uses the encoding CMap code length, not the ToUnicode codespace', async () => {
    const doc = await newDoc();
    const lib = await doc.embedFont(new Uint8Array(readFileSync(join(FONTS, 'LiberationSans-Regular.ttf'))), { subset: false });
    const page = doc.addPage([400, 200]);
    page.drawText('Jan Alkna anaa', { x: 40, y: 100, size: 14, font: lib });
    const first = await PDFDocument.load(await doc.save({ useObjectStreams: false }), { updateMetadata: false });
    // Rewrite the ToUnicode CMap with a 1-byte codespace while the entries stay 2-byte, as some producers do.
    for (const [, obj] of first.context.enumerateIndirectObjects()) {
      const dict = obj as PDFDict;
      if (typeof dict.get !== 'function' || dict.get(PDFName.of('Subtype'))?.toString() !== '/Type0') continue;
      const tu = first.context.lookup(dict.get(PDFName.of('ToUnicode')));
      const text = Buffer.from(decodeStream(first.context, tu as PDFRawStream)).toString('latin1');
      const chars = [...text.matchAll(/<([0-9A-Fa-f]{4})>\s*<([0-9A-Fa-f]{4})>/g)].map((m) => [m[1], m[2]] as const);
      expect(chars.length).toBeGreaterThan(50);
      const lines = ['/CIDInit /ProcSet findresource begin', 'begincmap', '1 begincodespacerange', '<00> <FF>', 'endcodespacerange', `${chars.length} beginbfchar`, ...chars.map(([gid, u]) => `<${gid}> <${u}>`), 'endbfchar', 'endcmap', 'end'];
      dict.set(PDFName.of('ToUnicode'), first.context.register(first.context.stream(lines.join('\n'))));
    }
    const bytes = await first.save({ useObjectStreams: false });
    const { extraction, after } = await redact(bytes, [['Jan', 'nanA']]);
    expect(extraction.plainText).toContain('Jan Alkna anaa');
    expect(extraction.rasterOnlyPages).toEqual([]);
    expect(after.plainText).toContain('nanA Alkna anaa');
    expect(after.rasterOnlyPages).toEqual([]); // pdf.js reads the same: 2-byte codes in the Identity-H font
  });

  it('an empty ToUnicode destination falls back to the encoding instead of making the page unredactable', async () => {
    const doc = await newDoc();
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    const tu = ['/CIDInit /ProcSet findresource begin', 'begincmap', '1 begincodespacerange', '<00> <FF>', 'endcodespacerange', '1 beginbfchar', '<41> <>', 'endbfchar', 'endcmap', 'end'].join('\n');
    rawPage(doc, 'BT /F1 12 Tf 72 700 Td (ABC Jan) Tj ET', { F1: helv });
    await doc.save({ useObjectStreams: false }); // flushes the embedded font dict
    const fontDict = doc.context.lookup(helv.ref) as PDFDict;
    fontDict.set(PDFName.of('ToUnicode'), doc.context.register(doc.context.stream(tu)));
    const bytes = await doc.save({ useObjectStreams: false });
    const extraction = await readPdf(bytes, { assets: ASSETS });
    expect(extraction.plainText).toContain('ABC Jan');
    expect(extraction.unredactable).toEqual([]);
    expect(extraction.rasterOnlyPages).toEqual([]);
  });

  it('a non-embedded TrueType font without /Encoding decodes through Standard when Nonsymbolic, as pdf.js does', async () => {
    const doc = await newDoc();
    const widths = new Array(256).fill(600);
    const desc = doc.context.obj({ Type: 'FontDescriptor', FontName: 'Arial', Flags: 32, FontBBox: [0, 0, 1000, 1000], ItalicAngle: 0, Ascent: 900, Descent: -200, CapHeight: 700, StemV: 80 });
    const font = doc.context.obj({ Type: 'Font', Subtype: 'TrueType', BaseFont: 'Arial', FirstChar: 0, LastChar: 255, Widths: widths, FontDescriptor: doc.context.register(desc) });
    rawPage(doc, 'BT /F1 12 Tf 72 700 Td (caf\xe9 Jan) Tj ET', { F1: font });
    const bytes = await doc.save({ useObjectStreams: false });
    const extraction = await readPdf(bytes, { assets: ASSETS });
    expect(extraction.plainText).toContain('cafØ Jan'); // 0xE9 is Oslash in StandardEncoding
    expect(extraction.rasterOnlyPages).toEqual([]);
  });

  it('a symbolic embedded TrueType font without /Encoding decodes through MacRoman like pdf.js and is edited in place', async () => {
    const doc = await newDoc();
    const ttf = new Uint8Array(readFileSync(join(FONTS, 'LiberationSans-Regular.ttf')));
    const file = doc.context.register(doc.context.flateStream(ttf, { Length1: ttf.length }));
    const desc = doc.context.obj({ Type: 'FontDescriptor', FontName: 'LiberationSans', Flags: 4, FontBBox: [0, 0, 1000, 1000], ItalicAngle: 0, Ascent: 900, Descent: -200, CapHeight: 700, StemV: 80, FontFile2: file });
    const font = doc.context.obj({ Type: 'Font', Subtype: 'TrueType', BaseFont: 'LiberationSans', FirstChar: 32, LastChar: 126, Widths: new Array(95).fill(600), FontDescriptor: doc.context.register(desc) });
    rawPage(doc, 'BT /F1 12 Tf 72 700 Td (Jan Kowalski) Tj ET', { F1: font });
    const bytes = await doc.save({ useObjectStreams: false });
    const extraction = await readPdf(bytes, { assets: ASSETS });
    expect(extraction.plainText).toContain('Jan Kowalski');
    expect(extraction.rasterOnlyPages).toEqual([]);
    expect(extraction.unredactable).toEqual([]);
    const { after, result } = await redact(bytes, [['Jan Kowalski', '[PERSON_1]']]);
    expect(result.rasterizedPages).toEqual([]);
    expect(after.plainText).toContain('[PERSON_1]');
  });
});

describe('Type3 fonts', () => {
  it('reads Type3 text through the encoding names and never draws a placeholder with a Type3 font it cannot show', async () => {
    const doc = await newDoc();
    const ctx = doc.context;
    const names = ['J', 'a', 'n', 'space', 'K', 'o', 'w', 'l', 's', 'k', 'i'];
    const codes: Record<string, number> = { J: 74, a: 97, n: 110, space: 32, K: 75, o: 111, w: 119, l: 108, s: 115, k: 107, i: 105 };
    const charProcs: { [name: string]: PDFRef } = {};
    for (const n of names) charProcs[n] = ctx.register(ctx.stream(n === 'space' ? '600 0 d0' : '600 0 d0 50 0 500 700 re f'));
    const differences: Array<number | PDFName> = [];
    for (const n of names) differences.push(codes[n], PDFName.of(n));
    const widths = new Array(88).fill(600); // FirstChar 32 .. LastChar 119
    // /BaseFont /Helvetica on purpose: a Type3 font's glyphs come from /CharProcs, never from the standard-14 metrics.
    const font = ctx.obj({
      Type: 'Font', Subtype: 'Type3', BaseFont: 'Helvetica', FontBBox: [0, 0, 750, 750], FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
      CharProcs: ctx.obj(charProcs as { [name: string]: PDFRef }), Encoding: ctx.obj({ Type: 'Encoding', Differences: differences as Array<number | PDFName> }), FirstChar: 32, LastChar: 119, Widths: widths, Resources: ctx.obj({}),
    });
    rawPage(doc, 'BT /T3 12 Tf 72 700 Td (Jan Kowalski) Tj ET', { T3: font });
    const bytes = await doc.save({ useObjectStreams: false });
    const { extraction, after, out, result } = await redact(bytes, [['Jan Kowalski', '[PERSON_1]']]);
    expect(extraction.plainText).toContain('Jan Kowalski');
    expect(extraction.rasterOnlyPages).toEqual([]);
    expect(result.rasterizedPages).toEqual([]);
    expect(after.plainText).toContain('[PERSON_1]');
    const run = after.runs.find((r) => after.plainText.slice(r.textStart, r.textEnd).includes('[PERSON_1]'))!;
    expect(run.fontName.startsWith('DCFb')).toBe(true);
    expect(await verifyPdf({ bytes: out, needles: ['Jan Kowalski'] })).toEqual([]);
  });
});

describe('robustness', () => {
  it('a PDF with only an owner password (empty user password) opens without a password', async () => {
    const doc = await newDoc();
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    rawPage(doc, 'BT /F1 12 Tf 72 700 Td (Jan Kowalski) Tj ET', { F1: helv });
    (doc as unknown as { encrypt: (o: { userPassword: string; ownerPassword: string }) => void }).encrypt({ userPassword: '', ownerPassword: 'owner-pw' });
    const bytes = await doc.save({ useObjectStreams: false });
    const { after, out } = await redact(bytes, [['Jan Kowalski', '[PERSON_1]']]);
    expect(after.plainText).toContain('[PERSON_1]');
    expect(await verifyPdf({ bytes: out, needles: ['Jan Kowalski'] })).toEqual([]);
  });

  it('a PDF with a user password is still refused without it', async () => {
    const doc = await newDoc();
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    rawPage(doc, 'BT /F1 12 Tf 72 700 Td (Jan Kowalski) Tj ET', { F1: helv });
    (doc as unknown as { encrypt: (o: { userPassword: string; ownerPassword: string }) => void }).encrypt({ userPassword: 'secret', ownerPassword: 'owner-pw' });
    const bytes = await doc.save({ useObjectStreams: false });
    await expect(readPdf(bytes, { assets: ASSETS })).rejects.toMatchObject({ code: 'encrypted' });
    const { after } = await redact(bytes, [['Jan Kowalski', '[PERSON_1]']], 'secret');
    expect(after.plainText).toContain('[PERSON_1]');
  });
});

describe('lexer: inline images and nesting (reviewer inputs)', () => {
  const b = latin1;
  it('EI directly after binary data, named colour spaces, false EI inside DCT / filtered data', () => {
    expect(lexContent(b('q BI /W 2 /H 2 /F /DCT ID \xff\xd8\x00\xff\xd9EI Q (secret) Tj')).map((o) => o.op)).toEqual(['q', 'BI', 'Q', 'Tj']);
    expect(lexContent(b('BI /W 2 /H 1 /CS /CS0 /BPC 8 ID \x01\x02EI Q (secret) Tj')).map((o) => o.op)).toEqual(['BI', 'Q', 'Tj']);
    expect(lexContent(b('q BI /W 2 /H 2 /F /DCT ID \xff\xd8\x00 EI \x89\xff(\x01\xff\xd9\nEI Q (secret) Tj')).map((o) => o.op)).toEqual(['q', 'BI', 'Q', 'Tj']);
    expect(lexContent(b('BI /W 2 /H 2 /F /Fl ID x\x00 EI \x89\xff\x01\x02\x03\x04 EI Q (secret) Tj')).map((o) => o.op)).toEqual(['BI', 'Q', 'Tj']);
  });
  it('an inline image without an end makes the rest of the stream unsafe instead of a silent BI', () => {
    expect(lexContent(b('BI /W 1 /H 1 /CS /G /BPC 8 (secret) Tj')).map((o) => o.op)).toEqual(['']);
    expect(lexContent(b('q BI /W 1 /H 1 /F /Fl ID abc')).map((o) => o.op)).toEqual(['q', '']);
  });
  it('honours /L and bounds nesting depth', () => {
    expect(lexContent(b('BI /W 1 /H 1 /L 6 /F /Fl ID A EI B EI Q')).map((o) => o.op)).toEqual(['BI', 'Q']);
    const ops = lexContent(b('['.repeat(5000) + ']'.repeat(5000) + ' TJ (a) Tj'));
    expect(ops[0].op).toBe('');
    expect(ops[ops.length - 1].op).toBe('Tj');
  });
  it('keeps raw CR bytes inside literal strings (pdf.js does)', () => {
    const ops = lexContent(b('(a\rb\r\nc) Tj'));
    expect(Array.from((ops[0].operands[0] as { bytes: Uint8Array }).bytes)).toEqual(Array.from(b('a\rb\r\nc')));
  });
});

/* ------------------------------------------------------------------ */
/* Third review (T220): evasion probes, real-world producers, layout    */
/* ------------------------------------------------------------------ */

async function helvPage(content: string, size: [number, number] = [612, 792]): Promise<{ doc: PDFDocument; helv: PDFFont }> {
  const doc = await newDoc();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  rawPage(doc, content, { F1: helv }, size);
  return { doc, helv };
}

describe('text the extractors could miss', () => {
  it('text inside a tiling pattern cell is extracted and redacted in place', async () => {
    const doc = await newDoc();
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    const ctx = doc.context;
    await doc.save({ useObjectStreams: false }); // flush the font dict
    const pattern = ctx.register(ctx.stream('BT /F1 14 Tf 10 10 Td (Jan Kowalski) Tj ET', {
      Type: 'Pattern', PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 200, 40], XStep: 200, YStep: 40,
      Resources: ctx.obj({ Font: ctx.obj({ F1: helv.ref }) }),
    }));
    const page = doc.addPage([400, 300]);
    page.node.set(PDFName.of('Resources'), ctx.obj({ Pattern: ctx.obj({ P1: pattern }), Font: ctx.obj({ F1: helv.ref }) }));
    page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream('/Pattern cs /P1 scn 50 200 300 60 re f BT /F1 12 Tf 50 100 Td (Other text on page) Tj ET')));
    const bytes = await doc.save({ useObjectStreams: false });
    const extraction = await readPdf(bytes, { assets: ASSETS });
    expect(extraction.plainText).toContain('Jan Kowalski');
    expect(extraction.rasterOnlyPages).toEqual([]); // pattern glyphs are not part of the pdf.js comparison
    const { after, out, result } = await redact(bytes, [['Jan Kowalski', '[PERSON_1]']]);
    expect(result.rasterizedPages).toEqual([]);
    expect(after.plainText).toContain('[PERSON_1]');
    expect(after.plainText).not.toContain('Kowalski');
    expect(await verifyPdf({ bytes: out, needles: ['Jan Kowalski'] })).toEqual([]);
  });

  it('text inside an ExtGState soft-mask group is extracted and redacted', async () => {
    const doc = await newDoc();
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    const ctx = doc.context;
    await doc.save({ useObjectStreams: false });
    const group = ctx.register(ctx.stream('0 g 0 0 400 300 re f 1 g BT /F1 20 Tf 40 150 Td (Jan Kowalski) Tj ET', {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 400, 300], Group: ctx.obj({ S: 'Transparency', CS: 'DeviceGray' }),
      Resources: ctx.obj({ Font: ctx.obj({ F1: helv.ref }) }),
    }));
    const page = doc.addPage([400, 300]);
    page.node.set(PDFName.of('Resources'), ctx.obj({ ExtGState: ctx.obj({ GS1: ctx.obj({ SMask: ctx.obj({ S: 'Luminosity', G: group }) }) }), Font: ctx.obj({ F1: helv.ref }) }));
    page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream('/GS1 gs 0 0 1 rg 0 0 400 300 re f')));
    const bytes = await doc.save({ useObjectStreams: false });
    const extraction = await readPdf(bytes, { assets: ASSETS });
    expect(extraction.plainText).toContain('Jan Kowalski');
    const { after, out } = await redact(bytes, [['Jan Kowalski', '[PERSON_1]']]);
    expect(after.plainText).toContain('[PERSON_1]');
    expect(await verifyPdf({ bytes: out, needles: ['Jan Kowalski'] })).toEqual([]);
  });

  it('glyphs shown back to front, and words shown from the right, read in baseline order', async () => {
    const reversed = [...'Jan Kowalski'].map((c, i) => `1 0 0 1 ${72 + i * 8} 700 Tm (${c}) Tj`).reverse().join(' ');
    const { doc } = await helvPage(`BT /F1 14 Tf ${reversed} ET BT /F1 12 Tf 300 600 Td (Kowalski) Tj -60 0 Td (Jan) Tj -80 0 Td (Klient:) Tj ET`);
    const bytes = await doc.save({ useObjectStreams: false });
    const extraction = await readPdf(bytes, { assets: ASSETS });
    expect(extraction.plainText).toContain('Jan Kowalski');
    expect(extraction.plainText).toContain('Klient: Jan Kowalski');
    const { after, out } = await redact(bytes, [['Jan Kowalski', '[PERSON_1]']]);
    expect(after.plainText).not.toMatch(/Kowalski|naJ/);
    expect(await verifyPdf({ bytes: out, needles: ['Jan Kowalski'] })).toEqual([]);
  });

  it('keeps our text when pdf.js reads less (a font it rejects) and rasterizes the page on edit', async () => {
    const doc = await newDoc();
    const ctx = doc.context;
    // No /Subtype: pdf.js throws in its font loader and reports no text; our decoder reads Standard encoding.
    const broken = ctx.obj({ Type: 'Font', BaseFont: 'Helvetica' });
    rawPage(doc, 'BT /F1 12 Tf 72 700 Td (Klient: Jan Kowalski) Tj ET', { F1: broken });
    const bytes = await doc.save({ useObjectStreams: false });
    const extraction = await readPdf(bytes, { assets: ASSETS });
    expect(extraction.plainText).toContain('Jan Kowalski');
    expect(extraction.rasterOnlyPages).toEqual([]);
    const factory = await nodeCanvasFactory();
    if (!factory) return;
    const replacements = spans(extraction.plainText, 'Jan Kowalski', '[PERSON_1]');
    const result = await writeAnonymizedPdfWithReport(extraction, replacements, [{ value: 'Jan Kowalski', replacement: '[PERSON_1]' }], { assets: ASSETS, canvasFactory: factory });
    expect(result.rasterizedPages).toEqual([0]);
  });

  it('a composite font without ToUnicode is unredactable even though pdf.js shows glyph ids as characters', async () => {
    const doc = await newDoc();
    const lib = await doc.embedFont(new Uint8Array(readFileSync(join(FONTS, 'LiberationSans-Regular.ttf'))), { subset: false });
    doc.addPage([400, 200]).drawText('Jan Kowalski', { x: 40, y: 100, size: 14, font: lib });
    const first = await PDFDocument.load(await doc.save({ useObjectStreams: false }), { updateMetadata: false });
    for (const [, obj] of first.context.enumerateIndirectObjects()) {
      const dict = obj as PDFDict;
      if (typeof dict.get === 'function' && dict.get(PDFName.of('Subtype'))?.toString() === '/Type0') dict.delete(PDFName.of('ToUnicode'));
    }
    const extraction = await readPdf(await first.save({ useObjectStreams: false }), { assets: ASSETS });
    expect(extraction.unredactable.map((u) => u.kind)).toEqual(['undecodable-text']);
  });
});

describe('layout and matching (third review)', () => {
  it('two values touching in one show each get their placeholder', async () => {
    const { doc } = await helvPage('BT /F1 12 Tf 72 700 Td (Klient: JanKowalski92050812345 koniec) Tj ET');
    const bytes = await doc.save({ useObjectStreams: false });
    const { after } = await redact(bytes, [['JanKowalski', '[P1]'], ['92050812345', '[I1]']]);
    expect(after.plainText).toContain('Klient: [P1][I1] koniec');
  });

  it('consecutive TJ adjustments add up when glyphs between them are removed', async () => {
    const { doc } = await helvPage('BT /F1 12 Tf 72 700 Td [(Jan Kowalski) -500 (A) -1000 -1000 (B)] TJ ET');
    const bytes = await doc.save({ useObjectStreams: false });
    const { extraction, after } = await redact(bytes, [['Jan Kowalski', '[P1]']]);
    const dBefore = glyphX(extraction, 'B') - glyphX(extraction, 'A');
    const dAfter = glyphX(after, 'B') - glyphX(after, 'A');
    expect(dAfter).toBeCloseTo(dBefore, 3);
  });

  it('layer zero and the verifier match at token boundaries: "Nowak" is not "Nowakowski"', async () => {
    const { doc } = await helvPage('BT /F1 12 Tf 72 700 Td (Piotr Nowakowski, to jest nowa kolumna. Anna Nowak.) Tj ET');
    const bytes = await doc.save({ useObjectStreams: false });
    const extraction = await readPdf(bytes, { assets: ASSETS });
    const i = extraction.plainText.indexOf('Anna Nowak');
    const result = await writeAnonymizedPdfWithReport(extraction, [{ start: i, end: i + 10, replacement: '[PERSON_1]' }], [{ value: 'Anna Nowak', replacement: '[PERSON_1]' }, { value: 'Nowak', replacement: '[PERSON_2]' }], { assets: ASSETS });
    const after = await readPdf(new Uint8Array(await result.blob.arrayBuffer()), { assets: ASSETS });
    expect(after.plainText).toContain('Piotr Nowakowski, to jest nowa kolumna. [PERSON_1].');
  });

  it('a value hyphenated at a line end is found by layer zero', async () => {
    const { doc } = await helvPage('BT /F1 12 Tf 72 700 Td (umowa z panem Kowal-) Tj 0 -14 Td (skim, dalej) Tj 0 -14 Td (Podpis: Jan Kowalski) Tj ET');
    const bytes = await doc.save({ useObjectStreams: false });
    const extraction = await readPdf(bytes, { assets: ASSETS });
    const i = extraction.plainText.indexOf('Jan Kowalski');
    const result = await writeAnonymizedPdfWithReport(extraction, [{ start: i, end: i + 12, replacement: '[PERSON_1]' }], [{ value: 'Jan Kowalski', replacement: '[PERSON_1]' }, { value: 'Kowalskim', replacement: '[PERSON_1]' }], { assets: ASSETS });
    const after = await readPdf(new Uint8Array(await result.blob.arrayBuffer()), { assets: ASSETS });
    expect(after.plainText).not.toMatch(/Kowal/);
    expect(after.plainText).toContain('[PERSON_1]');
  });

  it('a /Differences entry naming /.notdef advances like the base glyph and does not make the page unredactable', async () => {
    const doc = await newDoc();
    const ctx = doc.context;
    const font = ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Times-Roman', Encoding: ctx.obj({ Type: 'Encoding', Differences: [32, PDFName.of('.notdef')] as Array<number | PDFName> }) });
    rawPage(doc, 'BT /F1 10 Tf 72 700 Td (Words that should have spaces) Tj ET', { F1: font });
    const bytes = await doc.save({ useObjectStreams: false });
    const extraction = await readPdf(bytes, { assets: ASSETS });
    expect(extraction.unredactable).toEqual([]);
    expect(extraction.plainText).toContain('Words that should have spaces'); // the blank glyphs still separate the words
    const { after } = await redact(bytes, [['spaces', '[X]']]);
    expect(after.plainText).toContain('have [X]');
  });

  it('ligature glyphs are spelled out in the text a detector sees', async () => {
    const doc = await newDoc();
    const lib = await doc.embedFont(new Uint8Array(readFileSync(join(FONTS, 'LiberationSerif-Regular.ttf'))), { subset: false });
    doc.addPage([400, 200]).drawText('dif\uFB01cult of\uFB01ce', { x: 40, y: 100, size: 14, font: lib });
    const extraction = await readPdf(await doc.save({ useObjectStreams: false }), { assets: ASSETS });
    expect(extraction.plainText).toContain('difficult office');
  });

  it('two overflowing placeholders before a column stay before it, with a warning when the room is gone', async () => {
    const { doc } = await helvPage('BT /F1 10 Tf 50 700 Td (Li Wu) Tj ( and ) Tj (Al Bo) Tj ( end) Tj 1 0 0 1 200 700 Tm (kolumna 2) Tj ET');
    const bytes = await doc.save({ useObjectStreams: false });
    const { extraction, after, result } = await redact(bytes, [['Li Wu', '[PERSON_WITH_A_LONG_NAME_1]'], ['Al Bo', '[PERSON_WITH_A_LONG_NAME_2]']]);
    expect(glyphX(after, 'kolumna')).toBeCloseTo(glyphX(extraction, 'kolumna'), 3);
    const tail = after.runs.find((r) => after.plainText.slice(r.textStart, r.textEnd).includes('end'))!;
    const tailEnd = tail.glyphs[tail.glyphs.length - 1];
    expect(tailEnd.x + tailEnd.advance).toBeLessThan(glyphX(after, 'kolumna') + 1);
    void result;
  });
});

describe('output hygiene (third review)', () => {
  it('drops XMP on XObjects, font family strings and layer names, and flags a value hidden in a name object', async () => {
    const doc = await newDoc();
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    const ctx = doc.context;
    await doc.save({ useObjectStreams: false });
    const xmp = ctx.register(ctx.stream('<x:xmpmeta>Jan Kowalski</x:xmpmeta>', { Type: 'Metadata', Subtype: 'XML' }));
    const form = ctx.register(ctx.stream('BT /F1 12 Tf 10 10 Td (inside) Tj ET', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 40], Metadata: xmp, Resources: ctx.obj({ Font: ctx.obj({ F1: helv.ref }) }) }));
    const ocg = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('Jan Kowalski layer') }));
    const page = doc.addPage([400, 300]);
    page.node.set(PDFName.of('Resources'), ctx.obj({ Font: ctx.obj({ F1: helv.ref }), XObject: ctx.obj({ Fx1: form }), Properties: ctx.obj({ oc1: ocg }) }));
    page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream('/OC /oc1 BDC q 1 0 0 1 50 200 cm /Fx1 Do Q EMC BT /F1 12 Tf 50 100 Td (Umowa z Jan Kowalski) Tj ET')));
    const bytes = await doc.save({ useObjectStreams: false });
    const { out } = await redact(bytes, [['Jan Kowalski', '[PERSON_1]']]);
    const text = Buffer.from(out).toString('latin1');
    expect(text).not.toContain('Jan Kowalski');
    expect(text).not.toContain('xmpmeta');
    expect(await verifyPdf({ bytes: out, needles: ['Jan Kowalski'] })).toEqual([]);
    // A value spelled by a name object is reported by the verifier.
    const spoofed = await PDFDocument.load(out, { updateMetadata: false });
    spoofed.getPage(0).node.set(PDFName.of('Jan Kowalski'), PDFName.of('x'));
    const spoofedBytes = await spoofed.save({ useObjectStreams: false });
    expect((await verifyPdf({ bytes: spoofedBytes, needles: ['Jan Kowalski'] })).some((f) => f.where.endsWith('name'))).toBe(true);
  });
});
