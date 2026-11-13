// @vitest-environment jsdom
/**
 * Date cells (T176 step 2, T265). Excel stores a date as a day count and
 * shows it through the cell's number format, so a column of birth dates is
 * a column of numbers no detector reads. The reader puts a cell that is
 * shown as a date into the text as YYYY-MM-DD; the writer turns a replaced
 * one into an inline string and gives every other one its number back.
 */
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { readXlsx, writeAnonymizedXlsxWithReport, excelSerialToIsoDate } from '../src/dom/xlsx.ts';

const SS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="${SS}">
  <numFmts count="2">
    <numFmt numFmtId="164" formatCode="dd/mm/yyyy"/>
    <numFmt numFmtId="165" formatCode="0.00 &quot;dni&quot;;[Red]-0.00 &quot;dni&quot;"/>
  </numFmts>
  <cellXfs count="5">
    <xf numFmtId="0"/>
    <xf numFmtId="14"/>
    <xf numFmtId="164"/>
    <xf numFmtId="165"/>
    <xf numFmtId="20"/>
  </cellXfs>
</styleSheet>`;

const ROW = `<row r="1">
  <c r="A1" t="s"><v>0</v></c>
  <c r="B1" s="1"><v>31118</v></c>
  <c r="C1" s="2"><v>45000.5</v></c>
  <c r="D1" s="3"><v>12.5</v></c>
  <c r="E1"><v>31118</v></c>
  <c r="F1" s="4"><v>0.5</v></c>
  <c r="G1" s="1"><v>90010112345</v></c>
  <c r="H1" t="d"><v>1990-01-01T00:00:00</v></c>
  <c r="I1" s="1"><f>TODAY()</f><v>45000</v></c>
</row>`;

async function workbook(options: { date1904?: boolean; row?: string } = {}): Promise<File> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="${SS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <workbookPr${options.date1904 ? ' date1904="1"' : ''}/>
  <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL}">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`);
  zip.file('xl/sharedStrings.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="${SS}" count="1" uniqueCount="1"><si><t>Jan Kowalski</t></si></sst>`);
  zip.file('xl/styles.xml', STYLES);
  zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="${SS}"><sheetData>${options.row ?? ROW}</sheetData></worksheet>`);
  const ab = await zip.generateAsync({ type: 'arraybuffer' });
  const file = new File([ab], 'people.xlsx');
  if (typeof file.arrayBuffer !== 'function') Object.defineProperty(file, 'arrayBuffer', { value: async () => ab });
  return file;
}

function blobBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

/** Cells of the written sheet as { ref: [type, value, has formula] }. */
async function cellsOf(blob: Blob): Promise<Record<string, [string | null, string, boolean]>> {
  const zip = await JSZip.loadAsync(await blobBuffer(blob));
  const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
  const out: Record<string, [string | null, string, boolean]> = {};
  for (const c of Array.from(doc.getElementsByTagNameNS(SS, 'c'))) {
    out[c.getAttribute('r')!] = [c.getAttribute('t'), c.textContent ?? '', c.getElementsByTagNameNS(SS, 'f').length > 0];
  }
  return out;
}

describe('excelSerialToIsoDate', () => {
  it('follows the 1900 system, the missing 29 February 1900 included', () => {
    expect(excelSerialToIsoDate(1, false)).toBe('1900-01-01');
    expect(excelSerialToIsoDate(59, false)).toBe('1900-02-28');
    expect(excelSerialToIsoDate(60, false)).toBeNull();
    expect(excelSerialToIsoDate(61, false)).toBe('1900-03-01');
    expect(excelSerialToIsoDate(31118, false)).toBe('1985-03-12');
    expect(excelSerialToIsoDate(45000.75, false)).toBe('2023-03-15');
    expect(excelSerialToIsoDate(2958465, false)).toBe('9999-12-31');
  });

  it('follows the 1904 system', () => {
    expect(excelSerialToIsoDate(0, true)).toBe('1904-01-01');
    expect(excelSerialToIsoDate(29656, true)).toBe('1985-03-12');
  });

  it('refuses what is not a date Excel can show', () => {
    for (const n of [0, -5, 0.5, 2958466, 90010112345, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(excelSerialToIsoDate(n, false), String(n)).toBeNull();
    }
    expect(excelSerialToIsoDate(-1, true)).toBeNull();
  });
});

describe('readXlsx: cells shown as dates', () => {
  it('reads dates as YYYY-MM-DD and tells them from amounts, times, plain numbers and identifiers', async () => {
    const extraction = await readXlsx(await workbook());
    expect(extraction.plainText.split('\n')).toEqual([
      'Jan Kowalski',
      '1985-03-12', // B1: built-in date format 14
      '2023-03-15', // C1: custom dd/mm/yyyy, time of day dropped
      '90010112345', // G1: date format, but no date is that large: an identifier
      '1990-01-01T00:00:00', // H1: t="d"
      '2023-03-15', // I1: formula result shown as a date
    ]);
    // D1 (a quoted "dni" unit, not a date), E1 (no date format), F1 (time only) stay out.
    expect(extraction.plainText).not.toContain('31118');
    expect(extraction.plainText).not.toContain('12.5');
    expect(extraction.stats).toEqual({ dateCells: 4, identifierCells: 1, otherNumberCells: 3 });
    // The cells left out are named (T269): a host can show what stays readable in the export.
    expect(extraction.uncheckedCells.map((cell) => cell.cell)).toEqual(['D1', 'E1', 'F1']);
    for (const cell of extraction.uncheckedCells) {
      expect(cell.sheet, cell.cell).toMatch(/\S/);
      expect(cell.value, cell.cell).toMatch(/^[\d.]+$/);
    }
    expect(new Set(extraction.uncheckedCells.map((cell) => cell.sheet)).size).toBe(1);
  });

  it('uses the 1904 calendar when the workbook says so', async () => {
    const extraction = await readXlsx(await workbook({ date1904: true, row: '<row r="1"><c r="A1" s="1"><v>29656</v></c></row>' }));
    expect(extraction.plainText.split('\n')).toEqual(['Jan Kowalski', '1985-03-12']);
  });

  it('reads the same text twice', async () => {
    const file = await workbook();
    expect((await readXlsx(file)).plainText).toBe((await readXlsx(file)).plainText);
  });
});

describe('writeAnonymizedXlsx: cells shown as dates', () => {
  it('a replaced date becomes an inline string, the others get their numbers back', async () => {
    const extraction = await readXlsx(await workbook());
    const text = extraction.plainText;
    const start = text.indexOf('1985-03-12');
    const iso = text.indexOf('1990-01-01T00:00:00');
    const { blob } = await writeAnonymizedXlsxWithReport(
      extraction,
      [
        { start, end: start + 10, replacement: '[DATE_1]' },
        { start: iso, end: iso + 10, replacement: '[DATE_2]' },
      ],
      [{ value: '1985-03-12', replacement: '[DATE_1]' }, { value: '1990-01-01', replacement: '[DATE_2]' }],
    );
    const cells = await cellsOf(blob);
    expect(cells.B1).toEqual(['inlineStr', '[DATE_1]', false]);
    expect(cells.H1).toEqual(['inlineStr', '[DATE_2]T00:00:00', false]);
    // Not replaced: exactly the numbers the file had, formula kept.
    expect(cells.C1).toEqual([null, '45000.5', false]);
    expect(cells.I1).toEqual([null, 'TODAY()45000', true]);
    expect(cells.D1).toEqual([null, '12.5', false]);
    expect(cells.E1).toEqual([null, '31118', false]);
    expect(cells.G1).toEqual([null, '90010112345', false]);

    const bytes = await blobBuffer(blob);
    const out = new File([bytes], 'out.xlsx');
    if (typeof out.arrayBuffer !== 'function') Object.defineProperty(out, 'arrayBuffer', { value: async () => bytes });
    const again = await readXlsx(out);
    expect(again.plainText).not.toContain('1985-03-12');
    expect(again.plainText).toContain('[DATE_1]');
    expect(again.plainText).toContain('2023-03-15');
  });

  it('with nothing replaced every date cell is written back as its number', async () => {
    const extraction = await readXlsx(await workbook());
    const { blob } = await writeAnonymizedXlsxWithReport(extraction, [], []);
    const cells = await cellsOf(blob);
    expect(cells.B1).toEqual([null, '31118', false]);
    expect(cells.C1).toEqual([null, '45000.5', false]);
    expect(cells.H1).toEqual(['d', '1990-01-01T00:00:00', false]);
    expect(cells.I1).toEqual([null, 'TODAY()45000', true]);
  });

  it('a replaced date computed by a formula loses the formula, which would bring the date back', async () => {
    const extraction = await readXlsx(await workbook());
    const start = extraction.plainText.lastIndexOf('2023-03-15');
    const { blob } = await writeAnonymizedXlsxWithReport(extraction, [{ start, end: start + 10, replacement: '[DATE_3]' }], []);
    const cells = await cellsOf(blob);
    expect(cells.I1).toEqual(['inlineStr', '[DATE_3]', false]);
    expect(cells.C1).toEqual([null, '45000.5', false]);
  });
});
