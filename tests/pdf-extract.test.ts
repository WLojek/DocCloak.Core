import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { extractPdf } from '../src/pdf/extract.ts';

const FIXTURES = join(__dirname, 'fixtures', 'pdf');

describe('pdf extraction (smoke)', () => {
  for (const file of readdirSync(FIXTURES).filter((f) => f.endsWith('.pdf'))) {
    it(`extracts ${file}`, async () => {
      const res = await extractPdf(new Uint8Array(readFileSync(join(FIXTURES, file))));
      console.log(`--- ${file}\n${JSON.stringify(res.plainText)}\nissues=${JSON.stringify(res.model.pages.map((p) => p.issues))} runs=${res.runs.length} removed=${res.removed.map((r) => r.kind).join(',')} unredactable=${res.unredactable.map((u) => u.kind).join(',')}\nwarnings=${res.warnings.join(' | ')}`);
      expect(res.pages.length).toBeGreaterThan(0);
    });
  }
});

describe('pdf extraction: agreement with pdf.js', () => {
  it('does not mark a page raster-only when a line runs past the page edge (pdf.js drops off-page glyphs)', async () => {
    const { PDFDocument, StandardFonts } = await import('@cantoo/pdf-lib');
    const { readPdf } = await import('../src/pdf/read.ts');
    const doc = await PDFDocument.create({ updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([300, 200]);
    page.drawText('This long line keeps going well past the right edge of the small page.', { x: 20, y: 100, size: 12, font });
    const bytes = await doc.save({ useObjectStreams: false });
    const ex = await readPdf(bytes);
    expect(ex.rasterOnlyPages).toEqual([]);
    expect(ex.plainText).toContain('past the right edge of the small page.');
  });
});
