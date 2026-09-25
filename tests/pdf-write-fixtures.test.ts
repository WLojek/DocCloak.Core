// Security sweep: every synthetic PDF fixture (T214) is redacted and the
// output must hold no trace of any seed in any object, stream, string or
// raw byte (assertNoTrace), while both extractors read the placeholders.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDF_FIXTURES } from './helpers/fixtures/pdf.ts';
import { assertNoTrace, findTraces, writeOutput } from './helpers/package-scan.ts';
import { nodeCanvasFactory } from './helpers/pdf-canvas.ts';
import { readPdf, writeAnonymizedPdfWithReport, openWithOracle, normalizeForCompare } from '../src/pdf/index.ts';
import type { PdfAssetPaths } from '../src/pdf/index.ts';

const FONTS = join(__dirname, '..', 'fonts', 'liberation');
const ASSETS: PdfAssetPaths = { loadFont: async (file) => new Uint8Array(readFileSync(join(FONTS, file))) };

/** Seeds that name a value (not an operator fragment). */
function valueSeeds(spec: (typeof PDF_FIXTURES)[number]): string[] {
  return [...new Set(spec.seeds.map((s) => s.needle).filter((n) => !/[()<>]/.test(n)))];
}

describe('pdf writer: synthetic fixture sweep', () => {
  for (const spec of PDF_FIXTURES) {
    it(`${spec.name}: no trace of any seed after redaction`, async () => {
      const input = await spec.build();
      const values = valueSeeds(spec);
      // Sanity: the seeds are in the input.
      expect((await findTraces(input, values)).length).toBeGreaterThan(0);

      const extraction = await readPdf(input, { assets: ASSETS });
      const replacements: Array<{ start: number; end: number; replacement: string }> = [];
      const valueReplacements: Array<{ value: string; replacement: string }> = [];
      values.forEach((value, i) => {
        const replacement = `[VALUE_${i + 1}]`;
        valueReplacements.push({ value, replacement });
        let from = 0;
        for (;;) {
          const at = extraction.plainText.indexOf(value, from);
          if (at < 0) break;
          replacements.push({ start: at, end: at + value.length, replacement });
          from = at + value.length;
        }
      });
      const canvasFactory = await nodeCanvasFactory();
      const result = await writeAnonymizedPdfWithReport(extraction, replacements, valueReplacements, {
        assets: ASSETS,
        allowUnredactable: true,
        canvasFactory,
      });
      const out = new Uint8Array(await result.blob.arrayBuffer());
      writeOutput(`${spec.name}-redacted.pdf`, out);

      await assertNoTrace(out, values);

      // Both extractors agree the placeholders are there when the value was in the text layer.
      const after = await readPdf(out, { assets: ASSETS });
      const oracle = await openWithOracle(out, ASSETS);
      let oracleText = '';
      for (let p = 0; p < oracle.pageCount; p++) oracleText += await oracle.pageText(p);
      await oracle.close();
      if (replacements.length > 0 && result.rasterizedPages.length === 0) {
        expect(after.plainText).toMatch(/\[VALUE_\d+\]/);
        expect(normalizeForCompare(oracleText)).toMatch(/\[VALUE_\d+\]/);
      }
      for (const v of values) {
        expect(normalizeForCompare(after.plainText).toLowerCase()).not.toContain(normalizeForCompare(v).toLowerCase());
        expect(normalizeForCompare(oracleText).toLowerCase()).not.toContain(normalizeForCompare(v).toLowerCase());
      }
    });
  }
});
