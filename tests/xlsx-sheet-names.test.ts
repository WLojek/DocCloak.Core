// @vitest-environment jsdom
/**
 * Sheets named after a replaced value (T265). "[PERSON_1]" is not a name
 * Excel accepts for a sheet and '[PERSON_1]'!A1 reads as a reference to
 * another workbook, so the sheet gets a valid name and every reference to
 * it follows. Also: comment parts as other writers lay them out.
 */
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { readXlsx, writeAnonymizedXlsxWithReport, safeSheetName } from '../src/dom/xlsx.ts';

const SS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OD = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

interface Sheet { name: string; rows: string; extra?: string }

async function workbook(sheets: Sheet[], options: { definedNames?: string; comments?: Record<string, string> } = {}): Promise<File> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0"?><Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${OD}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="${SS}" xmlns:r="${OD}"><sheets>${sheets.map((s, i) => `<sheet name="${s.name.replace(/"/g, '&quot;')}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>${options.definedNames ? `<definedNames>${options.definedNames}</definedNames>` : ''}</workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0"?><Relationships xmlns="${REL}">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${OD}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`);
  sheets.forEach((s, i) => {
    zip.file(`xl/worksheets/sheet${i + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="${SS}"><sheetData>${s.rows}</sheetData>${s.extra ?? ''}</worksheet>`);
  });
  for (const [path, xml] of Object.entries(options.comments ?? {})) zip.file(path, xml);
  const ab = await zip.generateAsync({ type: 'arraybuffer' });
  const file = new File([ab], 'book.xlsx');
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

const cell = (ref: string, text: string) => `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;
const formula = (ref: string, f: string) => `<c r="${ref}"><f>${f}</f><v>0</v></c>`;

/** Redact every occurrence of the given values; returns the written package and the report. */
async function redact(file: File, pairs: Array<[string, string]>) {
  const extraction = await readXlsx(file);
  const text = extraction.plainText;
  const replacements: Array<{ start: number; end: number; replacement: string }> = [];
  for (const [value, replacement] of pairs) {
    for (let i = text.indexOf(value); i >= 0; i = text.indexOf(value, i + value.length)) {
      if (!replacements.some((r) => i < r.end && i + value.length > r.start)) replacements.push({ start: i, end: i + value.length, replacement });
    }
  }
  const result = await writeAnonymizedXlsxWithReport(extraction, replacements, pairs.map(([value, replacement]) => ({ value, replacement })));
  const zip = await JSZip.loadAsync(await blobBuffer(result.blob));
  const read = async (path: string) => zip.file(path)!.async('string');
  const sheetNames = Array.from((await read('xl/workbook.xml')).matchAll(/<sheet [^>]*name="([^"]*)"/g), (m) => m[1]);
  const formulas = async (n: number) => Array.from((await read(`xl/worksheets/sheet${n}.xml`)).matchAll(/<f>([^<]*)<\/f>/g), (m) => m[1].replace(/&quot;/g, '"').replace(/&apos;/g, "'"));
  return { result, zip, read, sheetNames, formulas, extraction };
}

describe('safeSheetName', () => {
  it('keeps the token of a bracketed placeholder and nothing Excel refuses', () => {
    expect(safeSheetName('[PERSON_1]', new Set())).toBe('PERSON_1');
    expect(safeSheetName('Karta [PERSON_1_LAST] 2024', new Set())).toBe('Karta PERSON_1_LAST 2024');
    expect(safeSheetName("'a:b/c\\d?e*f'", new Set())).toBe('a_b_c_d_e_f');
    expect(safeSheetName('[]', new Set())).toBe('Sheet');
  });

  it('stays within 31 characters and never repeats a name, whatever the case', () => {
    const taken = new Set(['person_1']);
    expect(safeSheetName('[PERSON_1]', taken)).toBe('PERSON_1_2');
    expect(safeSheetName('[PERSON_1]', taken)).toBe('PERSON_1_3');
    const long = safeSheetName('x'.repeat(40), taken);
    expect(long).toHaveLength(31);
    const again = safeSheetName('x'.repeat(40), taken);
    expect(again).toHaveLength(31);
    expect(again.endsWith('_2')).toBe(true);
  });
});

describe('sheets named after a replaced value', () => {
  const book = () => workbook([
    { name: 'Dane', rows: `<row r="1">${cell('A1', 'Jan Kowalski')}${cell('B1', 'Budimex S.A.')}</row>` },
    { name: 'Jan Kowalski', rows: `<row r="1">${cell('A1', 'Karta')}${formula('B1', 'Dane!A1')}</row>` },
    { name: 'Kowalski', rows: `<row r="1">${cell('A1', 'Skrót')}</row>` },
    {
      name: 'Podsumowanie',
      rows: `<row r="1">${formula('A1', "'Jan Kowalski'!B1")}${formula('B1', "SUM('Jan Kowalski'!A1:A3)+Kowalski!A1")}${formula('C1', 'IF(Dane!A1="Jan Kowalski","tak","nie")')}${formula('D1', 'COUNTA(Dane!A1:B1)')}</row>`,
      extra: `<dataValidations count="1"><dataValidation type="list" sqref="E1"><formula1>'Jan Kowalski'!$A$1:$A$3</formula1></dataValidation></dataValidations><hyperlinks><hyperlink ref="F1" location="'Jan Kowalski'!A1" display="Jan Kowalski"/></hyperlinks>`,
    },
  ], { definedNames: `<definedName name="Karta">'Jan Kowalski'!$A$1</definedName><definedName name="Skrot">Kowalski!$A$1</definedName>` });

  const PAIRS: Array<[string, string]> = [['Jan Kowalski', '[PERSON_1]'], ['Kowalski', '[PERSON_1_LAST]'], ['Budimex S.A.', '[COMPANY_1]']];

  it('renames them to valid names and reports the new names only', async () => {
    const { sheetNames, result } = await redact(await book(), PAIRS);
    expect(sheetNames).toEqual(['Dane', 'PERSON_1', 'PERSON_1_LAST', 'Podsumowanie']);
    expect(result.renamedSheets.sort()).toEqual(['PERSON_1', 'PERSON_1_LAST']);
    for (const name of sheetNames) {
      expect(name).not.toMatch(/[[\]:\\/?*]/);
      expect(name.length).toBeLessThanOrEqual(31);
    }
  });

  it('every reference follows: quoted, unquoted, ranges, data validation, hyperlinks, defined names', async () => {
    const { formulas, read } = await redact(await book(), PAIRS);
    expect(await formulas(4)).toEqual([
      "'PERSON_1'!B1",
      "SUM('PERSON_1'!A1:A3)+'PERSON_1_LAST'!A1",
      // A text literal is a value like any other; references to untouched sheets are untouched.
      'IF(Dane!A1="[PERSON_1]","tak","nie")',
      'COUNTA(Dane!A1:B1)',
    ]);
    expect(await formulas(2)).toEqual(['Dane!A1']);
    const sheet4 = await read('xl/worksheets/sheet4.xml');
    expect(sheet4).toContain("<formula1>'PERSON_1'!$A$1:$A$3</formula1>");
    expect(sheet4).toMatch(/location="'PERSON_1'!A1"/);
    expect(sheet4).toMatch(/display="\[PERSON_1\]"/);
    const wb = await read('xl/workbook.xml');
    expect(wb).toContain(`<definedName name="Karta">'PERSON_1'!$A$1</definedName>`);
    expect(wb).toContain(`<definedName name="Skrot">'PERSON_1_LAST'!$A$1</definedName>`);
  });

  it('leaves no trace of the names and no bracket in any reference', async () => {
    const { zip } = await redact(await book(), PAIRS);
    for (const path of Object.keys(zip.files)) {
      if (zip.files[path].dir) continue;
      const xml = await zip.file(path)!.async('string');
      expect(xml, path).not.toContain('Kowalski');
      expect(xml, path).not.toMatch(/'\[[A-Z_0-9]+\]'!/);
      expect(xml, path).not.toMatch(/name="\[/);
    }
  });

  it('a workbook without such a sheet is not touched by the rename', async () => {
    const file = await workbook([
      { name: 'Dane', rows: `<row r="1">${cell('A1', 'Jan Kowalski')}</row>` },
      { name: 'Wynik', rows: `<row r="1">${formula('A1', 'Dane!A1')}</row>` },
    ]);
    const { sheetNames, result, formulas } = await redact(file, [['Jan Kowalski', '[PERSON_1]']]);
    expect(sheetNames).toEqual(['Dane', 'Wynik']);
    expect(result.renamedSheets).toEqual([]);
    expect(await formulas(2)).toEqual(['Dane!A1']);
  });

  it('two sheets that would get the same new name stay apart, and so do their references', async () => {
    const file = await workbook([
      { name: 'Jan Kowalski', rows: `<row r="1">${cell('A1', 'Jan Kowalski')}</row>` },
      { name: 'Anna Nowak', rows: `<row r="1">${cell('A1', 'Anna Nowak')}</row>` },
      { name: 'Razem', rows: `<row r="1">${formula('A1', "'Jan Kowalski'!A1")}${formula('B1', "'Anna Nowak'!A1")}</row>` },
    ]);
    // Blanked style: every value becomes the same string.
    const { sheetNames, formulas } = await redact(file, [['Jan Kowalski', '________'], ['Anna Nowak', '________']]);
    expect(sheetNames).toEqual(['________', '_________2', 'Razem']);
    expect(await formulas(3)).toEqual(["'________'!A1", "'_________2'!A1"]);
  });

  it('a sheet name with an apostrophe is matched in its doubled form', async () => {
    const file = await workbook([
      { name: "O'Brien", rows: `<row r="1">${cell('A1', "O'Brien")}</row>` },
      { name: 'Razem', rows: `<row r="1">${formula('A1', "'O''Brien'!A1")}</row>` },
    ]);
    const { sheetNames, formulas } = await redact(file, [["O'Brien", '[PERSON_1]']]);
    expect(sheetNames).toEqual(['PERSON_1', 'Razem']);
    expect(await formulas(2)).toEqual(["'PERSON_1'!A1"]);
  });
});

describe('comment parts as other writers lay them out', () => {
  it('reads and redacts xl/comments/commentN.xml (openpyxl) like xl/commentsN.xml', async () => {
    const comments = `<?xml version="1.0"?><comments xmlns="${SS}"><authors><author>Anna Kadrowa</author></authors><commentList><comment ref="A1" authorId="0"><text><t>Jan Kowalski prosi o kontakt.</t></text></comment></commentList></comments>`;
    const vml = `<xml xmlns:v="urn:schemas-microsoft-com:vml"><v:shape><v:textbox><div>Jan Kowalski</div></v:textbox></v:shape></xml>`;
    const file = await workbook(
      [{ name: 'Dane', rows: `<row r="1">${cell('A1', 'Jan Kowalski')}</row>` }],
      { comments: { 'xl/comments/comment1.xml': comments, 'xl/drawings/commentsDrawing1.vml': vml } },
    );
    const extraction = await readXlsx(file);
    expect(extraction.plainText).toContain('Jan Kowalski prosi o kontakt.');
    // Neither part is "unknown": nothing for the user to decide about.
    expect(extraction.unredactable).toEqual([]);
    const { read } = await redact(file, [['Jan Kowalski', '[PERSON_1]']]);
    const written = await read('xl/comments/comment1.xml');
    expect(written).toContain('[PERSON_1] prosi o kontakt.');
    expect(written).toContain('<author>Redacted</author>');
    expect(await read('xl/drawings/commentsDrawing1.vml')).not.toContain('Kowalski');
  });
});
