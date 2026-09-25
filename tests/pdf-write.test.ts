import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, PDFName, PDFDict, StandardFonts, PDFRawStream } from '@cantoo/pdf-lib';
import { readPdf, writeAnonymizedPdfWithReport, verifyPdf, extractPdf } from '../src/pdf/index.ts';
import type { PdfExtraction, PdfAssetPaths } from '../src/pdf/index.ts';
import { writeOutput } from './helpers/package-scan.ts';

const FIXTURES = join(__dirname, 'fixtures', 'pdf');
const FONTS = join(__dirname, '..', 'fonts', 'liberation');

export const TEST_ASSETS: PdfAssetPaths = {
  loadFont: async (file) => new Uint8Array(readFileSync(join(FONTS, file))),
};

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)));
}

function spans(text: string, value: string, replacement: string): Array<{ start: number; end: number; replacement: string }> {
  const out: Array<{ start: number; end: number; replacement: string }> = [];
  let from = 0;
  for (;;) {
    const i = text.indexOf(value, from);
    if (i < 0) break;
    out.push({ start: i, end: i + value.length, replacement });
    from = i + value.length;
  }
  expect(out.length, `"${value}" not found in text`).toBeGreaterThan(0);
  return out;
}

async function redact(name: string, values: Array<[string, string]>): Promise<{ extraction: PdfExtraction; out: Uint8Array; result: Awaited<ReturnType<typeof writeAnonymizedPdfWithReport>> }> {
  const extraction = await readPdf(fixture(name), { assets: TEST_ASSETS });
  const replacements = values.flatMap(([v, r]) => spans(extraction.plainText, v, r));
  const result = await writeAnonymizedPdfWithReport(extraction, replacements, values.map(([value, replacement]) => ({ value, replacement })), { assets: TEST_ASSETS });
  const out = new Uint8Array(await result.blob.arrayBuffer());
  // 'pdf-' prefix: these tests redact only some values on purpose, so the CI poppler step opens
  // the output without grepping it for the corpus needles (a kept phone number is expected here).
  writeOutput(`pdf-desktop-${name.replace(/\.pdf$/, '')}-redacted.pdf`, out);
  return { extraction, out, result };
}

async function fontNames(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const names: string[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFDict && obj.get(PDFName.of('Type'))?.toString() === '/Font') {
      names.push(obj.get(PDFName.of('BaseFont'))?.toString() ?? '?');
    }
  }
  return names;
}

describe('pdf writer (standard-14 fixtures from the desktop suite)', () => {
  it('replaces a name and an email in Helvetica text, keeping the other lines in place', async () => {
    const { extraction, out, result } = await redact('baseline_text.pdf', [
      ['Jan Kowalski', '[PERSON_1]'],
      ['jan.kowalski@example.com', '[EMAIL_1]'],
    ]);
    expect(result.rasterizedPages).toEqual([]);
    const after = await readPdf(out, { assets: TEST_ASSETS });
    expect(after.plainText).toContain('Nabywca: [PERSON_1]');
    expect(after.plainText).toContain('Email: [EMAIL_1]');
    expect(after.plainText).toContain('Faktura VAT 2026/08/113');
    expect(after.plainText).toContain('Telefon: +48 601 234 567');
    expect(after.plainText).not.toContain('Kowalski');
    // Untouched glyphs keep their origins.
    const before = extraction.runs.find((r) => r.glyphs.map((g) => g.unicode).join('').startsWith('Faktura'))!;
    const afterRun = after.runs.find((r) => r.glyphs.map((g) => g.unicode).join('').startsWith('Faktura'))!;
    expect(afterRun.glyphs[0].x).toBeCloseTo(before.glyphs[0].x, 3);
    expect(afterRun.glyphs[0].y).toBeCloseTo(before.glyphs[0].y, 3);
    // The text after the placeholder on the same line (none here) and later lines keep their positions.
    const tel = after.runs.find((r) => r.glyphs.map((g) => g.unicode).join('').startsWith('Telefon'))!;
    const telBefore = extraction.runs.find((r) => r.glyphs.map((g) => g.unicode).join('').startsWith('Telefon'))!;
    expect(tel.glyphs[0].y).toBeCloseTo(telBefore.glyphs[0].y, 3);
    // Placeholder written in Helvetica itself (non-embedded standard font can show '[', ']', '_').
    const fonts = await fontNames(out);
    expect(fonts.some((f) => /Liberation/.test(f))).toBe(false);
    // Verification passes on the output for the removed values.
    const findings = await verifyPdf({ bytes: out, needles: ['Jan Kowalski', 'jan.kowalski@example.com'] });
    expect(findings).toEqual([]);
  });

  it('cuts glyphs out of a TJ array with kerning and out of a name split across two shows', async () => {
    for (const name of ['tj_kerning.pdf', 'split_show_runs.pdf']) {
      const { out } = await redact(name, [['Jan Kowalski', '[PERSON_1]']]);
      const after = await readPdf(out, { assets: TEST_ASSETS });
      expect(after.plainText).toContain('Klient: [PERSON_1]');
      expect(after.plainText).not.toMatch(/Kowalski|Jan /);
      expect(await verifyPdf({ bytes: out, needles: ['Jan Kowalski'] })).toEqual([]);
    }
  });

  it('drops annotations, attachments and metadata from the fresh output', async () => {
    const { out: a } = await redact('annotation_pii.pdf', [['Notatka', '[X]']]);
    const docA = await PDFDocument.load(a, { updateMetadata: false });
    expect(docA.getPage(0).node.get(PDFName.of('Annots'))).toBeUndefined();
    const { out: b } = await redact('attachment.pdf', [['Pismo', '[X]']]);
    const docB = await PDFDocument.load(b, { updateMetadata: false });
    expect(docB.catalog.get(PDFName.of('Names'))).toBeUndefined();
    const { out: c } = await redact('xmp_metadata.pdf', [['Raport', '[X]']]);
    const docC = await PDFDocument.load(c, { updateMetadata: false });
    expect(docC.catalog.get(PDFName.of('Metadata'))).toBeUndefined();
    expect(docC.getProducer()).toBe('DocCloak');
    expect(docC.getCreationDate()?.toISOString()).toBe('2000-01-01T00:00:00.000Z');
  });

  it('leaves no trace of the previous revision of an incrementally updated file', async () => {
    const before = fixture('incremental_update.pdf');
    expect(Buffer.from(before).toString('latin1')).toContain('Maria Wozniak');
    const { out } = await redact('incremental_update.pdf', [['Pracownik', '[ROLE_1]']]);
    expect(await verifyPdf({ bytes: out, needles: ['Maria Wozniak', '1112223344'] })).toEqual([]);
  });
});

describe('pdf writer (Chrome / Skia, Type0 Identity-H subset fonts)', () => {
  it('redacts names and an email without rasterizing, placeholders in a matched fallback face', async () => {
    const { extraction, out, result } = await redact('chrome-skia-type0.pdf', [
      ['Jan Kowalski', '[PERSON_1]'],
      ['John Smith', '[PERSON_2]'],
      ['jan.kowalski@example.com', '[EMAIL_1]'],
      ['90010112345', '[ID_1]'],
    ]);
    expect(result.rasterizedPages).toEqual([]);
    expect(extraction.rasterOnlyPages).toEqual([]);
    const after = await readPdf(out, { assets: TEST_ASSETS });
    expect(after.plainText).toContain('[PERSON_1], PESEL [ID_1], zamieszkały ul. Długa 5');
    expect(after.plainText).toContain('[EMAIL_1], tel. +48 600 100 200.');
    expect(after.plainText).toContain('Zażółć gęślą jaźń — [PERSON_2], 123 Main St');
    expect(after.plainText).toContain('Umowa najmu');
    const fonts = await fontNames(out);
    expect(fonts.some((f) => /LiberationSans-Regular/.test(f))).toBe(true);
    expect(fonts.some((f) => /LiberationSerif-Regular/.test(f))).toBe(true);
    expect(await verifyPdf({ bytes: out, needles: ['Jan Kowalski', 'John Smith', 'jan.kowalski@example.com', '90010112345'] })).toEqual([]);
    // "[ID_1]" is narrower than "90010112345": the rest of the line closes the slack (moves left), same baseline.
    const beforeRun = extraction.runs.find((r) => r.glyphs.map((g) => g.unicode).join('').includes('zamieszka'))!;
    const zBefore = beforeRun.glyphs[beforeRun.textOffsets.findIndex((o) => extraction.plainText.startsWith('zamieszka', o))];
    const afterText = after.plainText;
    const afterRun = after.runs.find((r) => afterText.slice(r.textStart, r.textEnd).includes('zamieszka'))!;
    const zAfter = afterRun.glyphs[afterRun.textOffsets.findIndex((o) => afterText.startsWith('zamieszka', o))];
    expect(zAfter.y).toBeCloseTo(zBefore.y, 2);
    expect(zAfter.x).toBeLessThan(zBefore.x);
    expect(zBefore.x - zAfter.x).toBeGreaterThan(20);
    // Glyphs on other lines do not move at all.
    const title = after.runs.find((r) => afterText.slice(r.textStart, r.textEnd).startsWith('Umowa'))!;
    const titleBefore = extraction.runs.find((r) => extraction.plainText.slice(r.textStart, r.textEnd).startsWith('Umowa'))!;
    expect(title.glyphs[0].x).toBeCloseTo(titleBefore.glyphs[0].x, 4);
    expect(title.glyphs[0].y).toBeCloseTo(titleBefore.glyphs[0].y, 4);
    // The comma directly follows the placeholder: no hole in the extracted text.
    expect(afterText).not.toContain('[ID_1] ,');
  });

  it('refuses to ship when verification finds a trace (negative control)', async () => {
    const out = fixture('baseline_text.pdf');
    const findings = await verifyPdf({ bytes: out, needles: ['Jan Kowalski'] });
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.map((f) => f.pass)).toContain('own-extractor');
  });

  it('re-extraction of the input is deterministic', async () => {
    const a = await extractPdf(fixture('chrome-skia-type0.pdf'));
    const b = await extractPdf(fixture('chrome-skia-type0.pdf'));
    expect(a.plainText).toBe(b.plainText);
  });
});

describe('pdf writer: values the detector did not mark', () => {
  async function twoLinePdf(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([400, 300]);
    page.drawText('Umowa zawarta z panem Jan', { x: 40, y: 250, size: 12, font });
    page.drawText('Kowalski, zam. Warszawa.', { x: 40, y: 232, size: 12, font });
    page.drawText('Podpis: Jan Kowalski', { x: 40, y: 200, size: 12, font });
    return doc.save({ useObjectStreams: false });
  }

  it('layer zero also covers a name wrapped over a line end, and the next line closes up', async () => {
    const bytes = await twoLinePdf();
    const extraction = await readPdf(bytes, { assets: TEST_ASSETS });
    expect(extraction.plainText).toContain('panem Jan\nKowalski,');
    const i = extraction.plainText.indexOf('Jan Kowalski');
    // Only the unwrapped occurrence is marked (as a detector would); the wrapped one must still go.
    const result = await writeAnonymizedPdfWithReport(
      extraction,
      [{ start: i, end: i + 'Jan Kowalski'.length, replacement: '[PERSON_1]' }],
      [{ value: 'Jan Kowalski', replacement: '[PERSON_1]' }],
      { assets: TEST_ASSETS },
    );
    const out = new Uint8Array(await result.blob.arrayBuffer());
    const after = await readPdf(out, { assets: TEST_ASSETS });
    // T225: the wider part of the wrapped name ("Kowalski" on line 2) carries the placeholder;
    // "Jan" at the end of line 1 is excised.
    expect(after.plainText).toContain('panem \n[PERSON_1], zam. Warszawa.');
    expect(after.plainText).toContain('Podpis: [PERSON_1]');
    expect(await verifyPdf({ bytes: out, needles: ['Jan Kowalski', 'Kowalski'] })).toEqual([]);
    // The placeholder starts where "Kowalski" started, on the same line.
    const before = extraction.runs.find((r) => extraction.plainText.slice(r.textStart, r.textEnd).trimStart().startsWith('Kowalski'))!;
    const afterRun = after.runs.find((r) => after.plainText.slice(r.textStart, r.textEnd).includes('[PERSON_1]') && r.glyphs[0].y < 240)!;
    expect(afterRun.glyphs[0].x).toBeCloseTo(before.glyphs[0].x, 1);
    expect(afterRun.glyphs[0].y).toBeCloseTo(before.glyphs[0].y, 3);
  });
});

describe('pdf writer: form XObjects', () => {
  /** A page whose text lives in a form XObject WITHOUT /Resources of its own (it inherits the page's, deprecated but common). */
  async function inheritedResourcesPdf(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([400, 200]);
    page.setFont(font); // puts the font into the page resources under a name
    const fontName = [...page.node.normalizedEntries().Font.entries()][0][0].decodeText();
    const content = `BT /${fontName} 14 Tf 20 100 Td (Klient: Jan Kowalski, tel. 600100200) Tj ET`;
    const form = doc.context.stream(content, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 400, 200] });
    const formRef = doc.context.register(form);
    page.node.normalizedEntries().XObject.set(PDFName.of('Fx1'), formRef);
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream('q 1 0 0 1 0 0 cm /Fx1 Do Q')));
    return doc.save({ useObjectStreams: false });
  }

  it('adds the fallback font to the page resources when the form has none of its own', async () => {
    const bytes = await inheritedResourcesPdf();
    const extraction = await readPdf(bytes, { assets: TEST_ASSETS });
    expect(extraction.plainText).toContain('Klient: Jan Kowalski, tel. 600100200');
    expect(extraction.rasterOnlyPages).toEqual([]);
    const values: Array<[string, string]> = [['Jan Kowalski', 'Ω1'], ['600100200', '[PHONE_1]']]; // Ω is not in WinAnsi: fallback face
    const replacements = values.flatMap(([v, r]) => spans(extraction.plainText, v, r));
    const result = await writeAnonymizedPdfWithReport(extraction, replacements, values.map(([value, replacement]) => ({ value, replacement })), { assets: TEST_ASSETS });
    expect(result.rasterizedPages).toEqual([]);
    const out = new Uint8Array(await result.blob.arrayBuffer());
    const after = await readPdf(out, { assets: TEST_ASSETS });
    expect(after.rasterOnlyPages).toEqual([]); // pdf.js resolved the fallback font through the page resources too
    expect(after.plainText).toContain('Klient: Ω1, tel. [PHONE_1]');
    // The fallback font sits in the page resources, and the form still has no /Resources.
    const outDoc = await PDFDocument.load(out, { updateMetadata: false });
    const pageFonts = [...outDoc.getPage(0).node.normalizedEntries().Font.entries()].map(([k]) => k.decodeText());
    expect(pageFonts.some((n) => n.startsWith('DCFb'))).toBe(true);
    const xobjs = outDoc.getPage(0).node.normalizedEntries().XObject;
    const form = outDoc.context.lookup(xobjs.get(PDFName.of('Fx1')));
    expect(form).toBeInstanceOf(PDFRawStream);
    expect((form as PDFRawStream).dict.get(PDFName.of('Resources'))).toBeUndefined();
  });
});
