// @vitest-environment jsdom
//
// T176 (minimal): identifiers stored as numbers. A PESEL or phone typed into
// a cell is a numeric <v>; the reader now extracts numbers of seven or more
// digits, and the writer turns a replaced numeric cell into an inline string
// so Excel opens the workbook without repair.

import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { readXlsx, writeAnonymizedXlsxWithReport } from '../src/dom/xlsx.ts';
import { layerZeroValueReplacements } from '../src/dom/opc.ts';
import { buildXlsxNumericAndDateCells, XLSX_SEED } from './helpers/fixtures/xlsx.ts';
import { assertNoTrace, toBytes } from './helpers/package-scan.ts';

function toFile(bytes: Uint8Array, name: string): File {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  const file = new File([ab], name);
  Object.defineProperty(file, 'arrayBuffer', { value: async () => ab.slice(0) });
  return file;
}

describe('xlsx numeric identifier cells (T176)', () => {
  it('extracts numbers of seven or more digits and leaves short numbers and dates alone', async () => {
    const extraction = await readXlsx(toFile(await buildXlsxNumericAndDateCells(), 'n.xlsx'));
    expect(extraction.plainText).toContain(XLSX_SEED.pesel);
    expect(extraction.plainText).toContain(XLSX_SEED.phone);
    // t="d" ISO dates are not numeric cells and are not identifiers.
    expect(extraction.plainText).not.toContain(XLSX_SEED.date);
  });

  it('writes a replaced numeric cell as an inline string without a formula', async () => {
    const extraction = await readXlsx(toFile(await buildXlsxNumericAndDateCells(), 'n.xlsx'));
    const occurrences: Array<{ start: number; end: number; replacement: string }> = [];
    const values = [] as Array<{ original: string; replacement: string; entityType: 'SSN' | 'PHONE' }>;
    for (const [needle, replacement, entityType] of [[XLSX_SEED.pesel, '[SSN_1]', 'SSN'], [XLSX_SEED.phone, '[PHONE_1]', 'PHONE']] as const) {
      const start = extraction.plainText.indexOf(needle);
      expect(start).toBeGreaterThanOrEqual(0);
      occurrences.push({ start, end: start + needle.length, replacement });
      values.push({ original: needle, replacement, entityType });
    }
    const result = await writeAnonymizedXlsxWithReport(extraction, occurrences, layerZeroValueReplacements(values), { allowUnredactable: true });
    const out = await toBytes(result.blob);
    await assertNoTrace(out, [XLSX_SEED.pesel, XLSX_SEED.phone]);

    const sheet = await (await JSZip.loadAsync(out)).file('xl/worksheets/sheet1.xml')!.async('string');
    expect(sheet).toMatch(/<c r="A2"[^>]*t="inlineStr"[^>]*><is><t[^>]*>\[SSN_1\]<\/t><\/is><\/c>/);
    expect(sheet).toMatch(/<c r="B2"[^>]*t="inlineStr"[^>]*><is><t[^>]*>\[PHONE_1\]<\/t><\/is><\/c>/);
    expect(sheet).not.toMatch(/<c r="A2"[^>]*><v>/);
    // The untouched date cell keeps its type and value.
    expect(sheet).toContain(`<c r="C2" t="d"><v>${XLSX_SEED.date}</v></c>`);

    const reread = await readXlsx(toFile(out, 'n2.xlsx'));
    expect(reread.plainText).toContain('[SSN_1]');
    expect(reread.plainText).toContain('[PHONE_1]');
  });
});
