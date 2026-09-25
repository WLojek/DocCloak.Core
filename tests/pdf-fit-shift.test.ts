/**
 * T225: the planner moves the rest of the line before it shrinks a placeholder.
 * A short word on a left-aligned line with room to the page's text edge gets
 * a full-size placeholder and the text after it moves right; a line that
 * already reaches the text edge (right-aligned) still shrinks and its end
 * stays put; a single-line page has no edge to speak of and shrinks as before.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { readPdf, writeAnonymizedPdfWithReport } from '../src/pdf/index.ts';
import type { PdfExtraction, PdfAssetPaths } from '../src/pdf/index.ts';

const FONTS = join(__dirname, '..', 'fonts', 'liberation');
const ASSETS: PdfAssetPaths = { loadFont: async (file) => new Uint8Array(readFileSync(join(FONTS, file))) };

async function redact(bytes: Uint8Array, value: string, replacement: string) {
  const extraction = await readPdf(bytes, { assets: ASSETS });
  const i = extraction.plainText.indexOf(value);
  expect(i).toBeGreaterThanOrEqual(0);
  const result = await writeAnonymizedPdfWithReport(extraction, [{ start: i, end: i + value.length, replacement }], [{ value, replacement }], { assets: ASSETS });
  const out = new Uint8Array(await result.blob.arrayBuffer());
  const after = await readPdf(out, { assets: ASSETS });
  return { extraction, after, result };
}

/** First glyph of the run containing `text`: x and effective font size; plus the run's end x. */
function where(ex: PdfExtraction, text: string): { x: number; size: number; endX: number } {
  const run = ex.runs.find((r) => ex.plainText.slice(r.textStart, r.textEnd).includes(text));
  if (!run) throw new Error(`run with "${text}" not found`);
  const i = run.textOffsets.findIndex((o) => ex.plainText.startsWith(text, o));
  const g = run.glyphs[i];
  const last = run.glyphs[run.glyphs.length - 1];
  return { x: g.x, size: g.fontSize, endX: last.x + last.advance * (run.emX[0] / 1000) };
}

async function page(lines: Array<{ text: string; x: number; y: number }>): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([600, 300]);
  for (const l of lines) p.drawText(l.text, { x: l.x, y: l.y, size: 12, font });
  return doc.save({ useObjectStreams: false });
}

const LONG = 'Wezwanie do zaplaty w sprawie umowy pozyczki z dnia drugiego lutego roku biezacego numer 12';

describe('placeholder fit: move before shrink (T225)', () => {
  it('a short word on a left-aligned line with room: full-size placeholder, the rest of the line moves right', async () => {
    const bytes = await page([{ text: LONG, x: 40, y: 200 }, { text: 'NIP 676-123-45-67 tel. 12 345', x: 40, y: 150 }]);
    const { extraction, after, result } = await redact(bytes, 'NIP', '[COMPANY_1]');
    const before = where(extraction, '676-123');
    const ph = where(after, '[COMPANY_1]');
    const moved = where(after, '676-123');
    expect(ph.size).toBeCloseTo(12, 1);
    // "[COMPANY_1]" in Liberation Sans is about 3.4 times wider than "NIP": the tail moved by that much.
    expect(moved.x).toBeGreaterThan(before.x + 30);
    expect(result.shiftedLines).toBeGreaterThanOrEqual(1);
    expect(result.rasterizedPages).toEqual([]);
    expect(after.plainText).not.toContain('NIP');
  });

  it('a line that already reaches the text edge (right-aligned): the placeholder shrinks and the line end stays', async () => {
    // The long line ends at some x; the date line is placed so that it ends at the same x.
    const doc = await PDFDocument.create({ updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p = doc.addPage([600, 300]);
    const date = 'Krakow, 14 marca 2026 r.';
    const edge = 40 + font.widthOfTextAtSize(LONG, 12);
    p.drawText(LONG, { x: 40, y: 200, size: 12, font });
    p.drawText(date, { x: edge - font.widthOfTextAtSize(date, 12), y: 250, size: 12, font });
    const bytes = await doc.save({ useObjectStreams: false });
    const { extraction, after } = await redact(bytes, 'Krakow', '[ADDRESS_1]');
    const before = where(extraction, '14 marca');
    const ph = where(after, '[ADDRESS_1]');
    const tail = where(after, '14 marca');
    // No room and the text edge is a hard limit (content boxes are clipped): the placeholder gives
    // up its floors (never below 4 pt) and the line end stays where it was.
    expect(ph.size).toBeLessThan(9);
    expect(ph.size).toBeGreaterThanOrEqual(4);
    expect(tail.endX).toBeLessThanOrEqual(before.endX + 0.5);
  });

  it('a value wrapped over two lines: the wider part carries the placeholder, the short part is excised', async () => {
    // Line 1 ends with "ul." (the first three glyphs of "ul. Portowa 8"), line 2 starts with the rest.
    const doc = await PDFDocument.create({ updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p = doc.addPage([600, 300]);
    p.drawText(LONG, { x: 40, y: 250, size: 12, font });
    const l1 = 'spolki Alfa z siedziba w Gdansku, ul.';
    p.drawText(l1, { x: 40 + font.widthOfTextAtSize(LONG, 12) - font.widthOfTextAtSize(l1, 12), y: 200, size: 12, font });
    p.drawText('Portowa 8, KRS 0000123456.', { x: 40, y: 150, size: 12, font });
    const bytes = await doc.save({ useObjectStreams: false });
    const extraction = await readPdf(bytes, { assets: ASSETS });
    const t = extraction.plainText;
    const i = t.indexOf('ul.');
    const j = t.indexOf('Portowa 8') + 'Portowa 8'.length;
    const result = await writeAnonymizedPdfWithReport(extraction, [{ start: i, end: j, replacement: '[ADDRESS_1]' }], [{ value: t.slice(i, j), replacement: '[ADDRESS_1]' }], { assets: ASSETS });
    const after = await readPdf(new Uint8Array(await result.blob.arrayBuffer()), { assets: ASSETS });
    const ph = where(after, '[ADDRESS_1]');
    const krs = where(after, 'KRS');
    expect(ph.size).toBeCloseTo(12, 1);
    // On the second line (y = 150), at its start, with "KRS" after it.
    expect(Math.abs(after.runs.find((r) => after.plainText.slice(r.textStart, r.textEnd).includes('[ADDRESS_1]'))!.glyphs[0].y - 150)).toBeLessThan(1);
    expect(krs.x).toBeGreaterThan(ph.endX);
    expect(after.plainText).not.toContain('Portowa');
    expect(after.plainText).not.toMatch(/ul\./);
    // Line 1 did not grow past the text edge.
    const edge = 40 + font.widthOfTextAtSize(LONG, 12);
    const l1End = Math.max(...after.runs.filter((r) => Math.abs(r.glyphs[0].y - 200) < 1).map((r) => { const g = r.glyphs[r.glyphs.length - 1]; return g.x + g.advance * (r.emX[0] / 1000); }));
    expect(l1End).toBeLessThanOrEqual(edge + 0.5);
  });

  it('a single-line page has no text edge of its own: the page edge is the limit, the line moves at full size', async () => {
    const bytes = await page([{ text: 'NIP 676-123-45-67', x: 40, y: 150 }]);
    const { extraction, after, result } = await redact(bytes, 'NIP', '[COMPANY_1]');
    const before = where(extraction, '676-123');
    const ph = where(after, '[COMPANY_1]');
    const tail = where(after, '676-123');
    expect(ph.size).toBeCloseTo(12, 1);
    // "[COMPANY_1]" is about 50 pt wider than "NIP": the tail moves by that much, well inside the page.
    expect(tail.x - before.x).toBeGreaterThan(40);
    expect(tail.x - before.x).toBeLessThan(70);
    expect(tail.endX).toBeLessThan(600);
    expect(ph.endX).toBeLessThanOrEqual(tail.x + 0.5);
    expect(result.shiftedLines).toBe(1);
  });

  it('a following column caps the move: the placeholder uses the room, then shrinks for the rest', async () => {
    // "NIP" then a tab-sized gap (40 pt) then a second column that must not be overrun.
    const doc = await PDFDocument.create({ updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p = doc.addPage([600, 300]);
    p.drawText(LONG, { x: 40, y: 200, size: 12, font });
    p.drawText('NIP', { x: 40, y: 150, size: 12, font });
    const col = 40 + font.widthOfTextAtSize('NIP', 12) + 40;
    p.drawText('Telefon 12 345', { x: col, y: 150, size: 12, font });
    const bytes = await doc.save({ useObjectStreams: false });
    const { extraction, after } = await redact(bytes, 'NIP', '[COMPANY_1]');
    const colBefore = where(extraction, 'Telefon');
    const colAfter = where(after, 'Telefon');
    const ph = where(after, '[COMPANY_1]');
    // The second column never moves (a tab-sized gap is not part of the line's chain) ...
    expect(Math.abs(colAfter.x - colBefore.x)).toBeLessThan(0.5);
    // ... and the placeholder ends before it, using the gap's room at a reduced but readable size.
    expect(ph.endX).toBeLessThanOrEqual(colBefore.x + 0.5);
    expect(ph.size).toBeGreaterThanOrEqual(4);
  });

  it('two values on one full-width line: the second placeholder counts the first one\'s shift and never leaves the page', async () => {
    // One Tj per line (as Chrome and Word emit): the first placeholder pushes the tail right, the
    // second sits at the line end. Its room must be measured after that push.
    const doc = await PDFDocument.create({ updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p = doc.addPage([400, 300]);
    const line = 'Spolka z siedziba w Gda, ul. Kr 8, tel 1';
    const w = font.widthOfTextAtSize(line, 12);
    p.drawText(line, { x: 400 - 20 - w, y: 200, size: 12, font }); // ends 20 pt before the page edge
    p.drawText('Krotsza linia', { x: 40, y: 150, size: 12, font });
    const bytes = await doc.save({ useObjectStreams: false });
    const extraction = await readPdf(bytes, { assets: ASSETS });
    const t = extraction.plainText;
    const reps = [
      { start: t.indexOf('Gda'), end: t.indexOf('Gda') + 3, replacement: '[ADDRESS_1]' },
      { start: t.indexOf('ul. Kr 8'), end: t.indexOf('ul. Kr 8') + 8, replacement: '[ADDRESS_2]' },
    ];
    const result = await writeAnonymizedPdfWithReport(extraction, reps, [{ value: 'Gda', replacement: '[ADDRESS_1]' }, { value: 'ul. Kr 8', replacement: '[ADDRESS_2]' }], { assets: ASSETS });
    const after = await readPdf(new Uint8Array(await result.blob.arrayBuffer()), { assets: ASSETS });
    const tail = where(after, 'tel 1');
    expect(tail.endX).toBeLessThanOrEqual(400 - 1);
    expect(after.plainText).toContain('[ADDRESS_2]');
    expect(after.plainText).not.toContain('Kr 8');
  });
});
