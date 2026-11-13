// @vitest-environment jsdom
/**
 * Values a workbook keeps outside its cells. A worksheet repeats cell values
 * in places no reader maps as text: a data validation list and its prompt,
 * AutoFilter criteria, a conditional format formula, the alt text of a
 * shape. The writer scrubs them by value. The cells themselves are not
 * scrubbed by value: the positional replacements say which places the user
 * chose, and a place kept visible stays visible.
 */
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { readXlsx, writeAnonymizedXlsxWithReport, scrubFormulaValues } from '../src/dom/xlsx.ts';
import { scrubUnmappedValues, scrubXmlValues } from '../src/dom/opc.ts';
import { assertNoTrace, writeOutput } from './helpers/package-scan.ts';
import {
  buildXlsxDataValidation,
  buildXlsxCfRule,
  buildXlsxEverything,
  XLSX_SEED,
} from './helpers/fixtures/xlsx.ts';

const SS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OD = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';

const MARGARET = 'Margaret Harrington';
const OLIVER = 'Oliver Bennett';
const THOMAS = 'Thomas Whitlow';
const PESEL = '90010112345';

const PAIRS: Array<[string, string]> = [
  [MARGARET, '[PERSON_1]'],
  [OLIVER, '[PERSON_2]'],
  [THOMAS, '[PERSON_3]'],
  [PESEL, '[SSN_1]'],
];

const cell = (ref: string, text: string) => `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;

/** What a sheet holds after its cells: the places this file is about. */
const OUTSIDE_CELLS =
  `<autoFilter ref="A1:D4"><filterColumn colId="0"><filters><filter val="${MARGARET}"/><filter val="${OLIVER}"/></filters></filterColumn>`
  + `<filterColumn colId="1"><customFilters><customFilter operator="notEqual" val="${THOMAS}"/></customFilters></filterColumn>`
  + `<filterColumn colId="3"><filters><filter val="${PESEL}"/></filters></filterColumn></autoFilter>`
  + `<conditionalFormatting sqref="A2:A4"><cfRule type="expression" priority="1"><formula>$A2="${OLIVER}"</formula></cfRule>`
  + `<cfRule type="containsText" priority="2" operator="containsText" text="${OLIVER}"><formula>NOT(ISERROR(SEARCH("${OLIVER}",A2)))</formula></cfRule></conditionalFormatting>`
  + `<dataValidations count="2"><dataValidation type="list" allowBlank="1" sqref="B2:B4" errorTitle="Wrong" error="Ask ${THOMAS}" promptTitle="Handler ${THOMAS}" prompt="Pick ${THOMAS} or ${MARGARET}"><formula1>"${THOMAS},${MARGARET}"</formula1></dataValidation>`
  + `<dataValidation type="whole" operator="between" sqref="D2:D4"><formula1>IF(B2="${MARGARET}",1,0)</formula1><formula2>IF(B2="${OLIVER}",5,9)</formula2></dataValidation></dataValidations>`
  + `<drawing r:id="rIdDr1"/>`;

const DRAWING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="${XDR}" xmlns:a="${A}"><xdr:twoCellAnchor><xdr:from><xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>7</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>4</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>`
  + `<xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="2" name="TextBox 1" descr="Note about ${OLIVER}" title="${MARGARET}"/><xdr:cNvSpPr txBox="1"/></xdr:nvSpPr>`
  + `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1800000" cy="360000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>`
  + `<xdr:txBody><a:bodyPr/><a:p><a:r><a:t>Reminder: ${OLIVER} owes fees to ${MARGARET}</a:t></a:r></a:p></xdr:txBody></xdr:sp><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`;

/**
 * The workbook of the review: names in cells, and the same names in every
 * place outside them. `before` and `outside` are what the sheet holds before
 * and after its cells, in the order the schema asks for.
 */
async function workbook(rows: string, outside = OUTSIDE_CELLS, before = ''): Promise<File> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
  <Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>
</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0"?><Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${OD}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="${SS}" xmlns:r="${OD}"><sheets><sheet name="Clients" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0"?><Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${OD}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${OD}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`);
  zip.file('xl/sharedStrings.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="${SS}" count="1" uniqueCount="1"><si><t>Client</t></si></sst>`);
  zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="${SS}" xmlns:r="${OD}">${before}<sheetData>${rows}</sheetData>${outside}</worksheet>`);
  zip.file('xl/worksheets/_rels/sheet1.xml.rels', `<?xml version="1.0"?><Relationships xmlns="${REL}"><Relationship Id="rIdDr1" Type="${OD}/drawing" Target="../drawings/drawing1.xml"/></Relationships>`);
  zip.file('xl/drawings/drawing1.xml', DRAWING);
  return toFile(await zip.generateAsync({ type: 'arraybuffer' }));
}

function toFile(source: ArrayBuffer | Uint8Array): File {
  const ab = source instanceof Uint8Array
    ? (() => { const copy = new Uint8Array(source.length); copy.set(source); return copy.buffer; })()
    : source;
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

const ROWS =
  `<row r="1"><c r="A1" t="s"><v>0</v></c>${cell('B1', 'Handler')}${cell('C1', 'Fee')}${cell('D1', 'Id')}</row>`
  + `<row r="2">${cell('A2', MARGARET)}${cell('B2', THOMAS)}<c r="C2"><v>1200</v></c><c r="D2"><v>${PESEL}</v></c></row>`
  + `<row r="3">${cell('A3', OLIVER)}${cell('B3', THOMAS)}<c r="C3"><v>450.5</v></c></row>`
  + `<row r="4">${cell('A4', 'Northfield Analytics Ltd')}${cell('B4', MARGARET)}<c r="C4"><v>4</v></c></row>`;

/**
 * Write the workbook with the given pairs as the value list. `keep` says
 * which occurrences in the flat text stay as they are (the host's "do not
 * redact this place"); every other occurrence is replaced positionally.
 */
async function redact(
  file: File,
  pairs: Array<[string, string]>,
  keep: (value: string, occurrence: number) => boolean = () => false,
) {
  const extraction = await readXlsx(file);
  const text = extraction.plainText;
  const replacements: Array<{ start: number; end: number; replacement: string }> = [];
  for (const [value, replacement] of pairs) {
    let occurrence = 0;
    for (let i = text.indexOf(value); i >= 0; i = text.indexOf(value, i + value.length)) {
      if (!keep(value, occurrence++)) replacements.push({ start: i, end: i + value.length, replacement });
    }
  }
  const result = await writeAnonymizedXlsxWithReport(extraction, replacements, pairs.map(([value, replacement]) => ({ value, replacement })));
  const zip = await JSZip.loadAsync(await blobBuffer(result.blob));
  const read = (path: string) => zip.file(path)!.async('string');
  return { result, zip, read, sheet: await read('xl/worksheets/sheet1.xml'), drawing: await read('xl/drawings/drawing1.xml') };
}

function wellFormed(xml: string): boolean {
  return new DOMParser().parseFromString(xml, 'application/xml').getElementsByTagName('parsererror').length === 0;
}

describe('a workbook keeps no replaced value outside its cells', () => {
  it('replaces the values in data validation, filters, conditional formats and alt text', async () => {
    const { result, zip, sheet, drawing } = await redact(await workbook(ROWS), PAIRS);

    // Data validation: the list stays one quoted string, the prompts are text.
    expect(sheet).toContain('<formula1>"[PERSON_3],[PERSON_1]"</formula1>');
    expect(sheet).toContain('<formula1>IF(B2="[PERSON_1]",1,0)</formula1>');
    expect(sheet).toContain('<formula2>IF(B2="[PERSON_2]",5,9)</formula2>');
    expect(sheet).toContain('error="Ask [PERSON_3]"');
    expect(sheet).toContain('promptTitle="Handler [PERSON_3]"');
    expect(sheet).toContain('prompt="Pick [PERSON_3] or [PERSON_1]"');
    // AutoFilter criteria, a long number among them.
    expect(sheet).toContain('<filter val="[PERSON_1]"/><filter val="[PERSON_2]"/>');
    expect(sheet).toContain('<customFilter operator="notEqual" val="[PERSON_3]"/>');
    expect(sheet).toContain('<filter val="[SSN_1]"/>');
    // Conditional formats: the formula and the text criterion.
    expect(sheet).toContain('<formula>$A2="[PERSON_2]"</formula>');
    expect(sheet).toContain('text="[PERSON_2]"');
    expect(sheet).toContain('<formula>NOT(ISERROR(SEARCH("[PERSON_2]",A2)))</formula>');
    // Alt text and title of the shape; its text box went the positional way.
    expect(drawing).toContain('descr="Note about [PERSON_2]"');
    expect(drawing).toContain('title="[PERSON_1]"');
    expect(drawing).toContain('Reminder: [PERSON_2] owes fees to [PERSON_1]');

    await assertNoTrace(result.blob, [MARGARET, OLIVER, THOMAS, PESEL, 'Harrington', 'Bennett', 'Whitlow']);
    for (const path of Object.keys(zip.files)) {
      if (/\.(?:xml|rels)$/.test(path)) expect(wellFormed(await zip.file(path)!.async('string')), path).toBe(true);
    }
    await writeOutput('xlsx-outside-cells.xlsx', result.blob);
  });

  it('leaves identifiers, relationship ids, cell references and layout numbers alone', async () => {
    // Values that read like structure: a relationship id, a small number, a number that is a cell value.
    const pairs: Array<[string, string]> = [...PAIRS, ['rIdDr1', '[ID_1]'], ['4', '[N_1]'], ['1200', '[N_2]'], ['0', '[N_3]']];
    const { sheet, drawing, read } = await redact(await workbook(ROWS), pairs, (value) => /^\d+$/.test(value) && value !== PESEL);

    expect(sheet).toContain('<drawing r:id="rIdDr1"/>');
    expect(await read('xl/worksheets/_rels/sheet1.xml.rels')).toContain('Id="rIdDr1"');
    // The shared-string index, the amounts and the count are numbers the reader left out: still numbers.
    expect(sheet).toContain('<c r="A1" t="s"><v>0</v></c>');
    expect(sheet).toContain('<c r="C2"><v>1200</v></c>');
    expect(sheet).toContain('<c r="C3"><v>450.5</v></c>');
    expect(sheet).toContain('<c r="C4"><v>4</v></c>');
    // References and ranges.
    expect(sheet).toContain('<autoFilter ref="A1:D4">');
    expect(sheet).toContain('sqref="A2:A4"');
    expect(sheet).toContain('sqref="B2:B4"');
    expect(sheet).toContain('colId="0"');
    // Drawing anchors and geometry.
    expect(drawing).toContain('<xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row>');
    expect(drawing).toContain('<xdr:col>7</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>4</xdr:row>');
    expect(drawing).toContain('<xdr:cNvPr id="2"');
    expect(drawing).toContain('<a:ext cx="1800000" cy="360000"/>');
    expect(drawing).toContain('prst="rect"');
  });

  it('keeps a place the user kept: the cell stays, the validation list does not', async () => {
    // The same name in two cells (A2 and B4). The user keeps the first place visible.
    const { sheet, drawing } = await redact(await workbook(ROWS), PAIRS, (value, occurrence) => value === MARGARET && occurrence === 0);

    expect(sheet).toContain(`<c r="A2" t="inlineStr"><is><t>${MARGARET}</t></is></c>`);
    expect(sheet).toMatch(/<c r="B4" t="inlineStr"><is><t[^>]*>\[PERSON_1\]<\/t><\/is><\/c>/);
    // Everything outside the cells is out of the user's reach and is scrubbed.
    expect(sheet).toContain('<formula1>"[PERSON_3],[PERSON_1]"</formula1>');
    expect(sheet).toContain('<filter val="[PERSON_1]"/>');
    expect(sheet).toContain('prompt="Pick [PERSON_3] or [PERSON_1]"');
    expect(drawing).toContain('title="[PERSON_1]"');
    // The name occurs once in the package: in the kept cell.
    expect(sheet.split(MARGARET)).toHaveLength(2);
    expect(drawing).not.toContain(MARGARET);
  });

  it('keeps a place the user kept in a text box and in a number cell', async () => {
    const { sheet, drawing } = await redact(
      await workbook(ROWS),
      PAIRS,
      // The text box is the last place of each name in the flat text; the id cell is the only place of the number.
      (value, occurrence) => (value === OLIVER && occurrence === 1) || value === PESEL,
    );
    expect(drawing).toContain(`Reminder: ${OLIVER} owes fees to [PERSON_1]`);
    expect(drawing).toContain('descr="Note about [PERSON_2]"');
    expect(sheet).toContain(`<c r="D2"><v>${PESEL}</v></c>`);
    expect(sheet).toContain('<filter val="[SSN_1]"/>');
  });

  it('scrubs the leak fixtures: validation prompt, error and list, conditional format formula', async () => {
    const cases: Array<[string, () => Promise<Uint8Array>, string[]]> = [
      ['datavalidation', buildXlsxDataValidation, [XLSX_SEED.dvPrompt, XLSX_SEED.dvError, XLSX_SEED.dvList]],
      ['cfrule', buildXlsxCfRule, [XLSX_SEED.cfRule]],
    ];
    for (const [name, build, seeds] of cases) {
      const extraction = await readXlsx(toFile(await build()));
      // None of these values is in a cell: the value list is all the writer has.
      for (const seed of seeds) expect(extraction.plainText).not.toContain(seed);
      const { blob } = await writeAnonymizedXlsxWithReport(extraction, [], seeds.map((value, i) => ({ value, replacement: `[EMAIL_${i + 1}]` })));
      await assertNoTrace(blob, seeds);
      await writeOutput(`xlsx-outside-cells-${name}.xlsx`, blob);
    }
  });

  it('scrubs the everything fixture outside its cells and leaves its numbers numeric', async () => {
    const extraction = await readXlsx(toFile(await buildXlsxEverything()));
    const seeds = [XLSX_SEED.dvPrompt, XLSX_SEED.dvError, XLSX_SEED.dvList, XLSX_SEED.cfRule, XLSX_SEED.formulaLiteral];
    const { blob } = await writeAnonymizedXlsxWithReport(
      extraction, [], seeds.map((value, i) => ({ value, replacement: `[EMAIL_${i + 1}]` })), { allowUnredactable: true },
    );
    await assertNoTrace(blob, seeds);
    const sheet = await (await JSZip.loadAsync(await blobBuffer(blob))).file('xl/worksheets/sheet1.xml')!.async('string');
    // No positional replacement was passed: the number cells are as they were.
    expect(sheet).toContain(`<c r="A2"><v>${XLSX_SEED.pesel}</v></c>`);
    expect(sheet).toContain('<c r="A1" t="s"><v>0</v></c>');
  });
});

describe('a name that reads like a piece of the format', () => {
  // Otto is in bottomLeft, Norma in normal, Vera in AVERAGE, Lowe in LOWER.
  const NAMES: Array<[string, string]> = [
    ['Otto', '[PERSON_1]'], ['Norma', '[PERSON_2]'], ['Vera', '[PERSON_3]'], ['Lowe', '[PERSON_4]'],
  ];
  const rows =
    `<row r="1">${cell('A1', 'Otto')}${cell('B1', 'Norma')}${cell('C1', 'Vera Lowe')}</row>`
    + `<row r="2"><c r="A2"><v>10</v></c><c r="B2"><v>20</v></c><c r="C2"><f>AVERAGE(A2:B2)</f><v>15</v></c>`
    + `<c r="D2" t="str"><f>LOWER(C1)&amp;" for Vera"</f><v>vera lowe for Vera</v></c></row>`;
  const views =
    `<sheetViews><sheetView workbookViewId="0" view="normal"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/></sheetView></sheetViews>`;
  const outside =
    `<conditionalFormatting sqref="A2:B2"><cfRule type="expression" priority="1"><formula>A2&gt;AVERAGE($A$2:$B$2)</formula></cfRule></conditionalFormatting>`
    + `<dataValidations count="1"><dataValidation type="list" sqref="E1"><formula1>"Otto,Norma,Vera Lowe"</formula1></dataValidation></dataValidations><drawing r:id="rIdDr1"/>`;

  it('leaves the keywords and the function names, and still replaces the name where it is text', async () => {
    const { result, sheet } = await redact(await workbook(rows, outside, views), NAMES);
    expect(sheet).toContain('view="normal"');
    expect(sheet).toContain('activePane="bottomLeft" state="frozen"');
    expect(sheet).toContain('<selection pane="bottomLeft"/>');
    expect(sheet).toContain('<f>AVERAGE(A2:B2)</f>');
    expect(sheet).toContain('<formula>A2&gt;AVERAGE($A$2:$B$2)</formula>');
    // The string literal of a formula is text: the name in it is replaced, the function next to it is not.
    expect(sheet).toContain('<f>LOWER(C1)&amp;" for [PERSON_3]"</f>');
    expect(sheet).toContain('<formula1>"[PERSON_1],[PERSON_2],[PERSON_3] [PERSON_4]"</formula1>');
    expect(sheet).toMatch(/<c r="A1" t="inlineStr"><is><t[^>]*>\[PERSON_1\]<\/t>/);
    await writeOutput('xlsx-outside-cells-keywords.xlsx', result.blob);
  });

  it('leaves cell references alone when a value is also a column', async () => {
    // "IT" is a department here and a column of the sheet.
    const sheetRows = `<row r="1">${cell('A1', 'IT')}${cell('B1', 'Otto')}<c r="IT1"><v>5</v></c><c r="IU1"><f>IT1*2+SUM(IT:IT)+LEN("IT")</f><v>16</v></c></row>`;
    const sheetOutside =
      `<conditionalFormatting sqref="IT1:IT9 A1"><cfRule type="expression" priority="1"><formula>$IT1&gt;3</formula></cfRule></conditionalFormatting>`
      + `<dataValidations count="1"><dataValidation type="list" sqref="IT2" prompt="Ask IT"><formula1>$IT$1:$IT$9</formula1></dataValidation></dataValidations><drawing r:id="rIdDr1"/>`;
    const views = `<sheetViews><sheetView workbookViewId="0"><selection activeCell="IT1" sqref="IT1:IT3"/></sheetView></sheetViews>`;
    const { sheet } = await redact(await workbook(sheetRows, sheetOutside, views), [['IT', '[DEPT_1]'], ['Otto', '[PERSON_1]']]);
    expect(sheet).toContain('<selection activeCell="IT1" sqref="IT1:IT3"/>');
    expect(sheet).toContain('<c r="IT1"><v>5</v></c>');
    expect(sheet).toContain('<f>IT1*2+SUM(IT:IT)+LEN("[DEPT_1]")</f>');
    expect(sheet).toContain('<conditionalFormatting sqref="IT1:IT9 A1">');
    expect(sheet).toContain('<formula>$IT1&gt;3</formula>');
    expect(sheet).toContain('sqref="IT2" prompt="Ask [DEPT_1]"');
    expect(sheet).toContain('<formula1>$IT$1:$IT$9</formula1>');
    expect(sheet).toMatch(/<c r="A1" t="inlineStr"><is><t[^>]*>\[DEPT_1\]<\/t>/);
  });
});

describe('scrubFormulaValues', () => {
  const VALUES = [
    { value: 'Jan Kowalski', replacement: '[PERSON_1]' },
    { value: 'Kowalski', replacement: '[PERSON_1_LAST]' },
    { value: 'Vera', replacement: '[PERSON_2]' },
    { value: 'Max', replacement: '[PERSON_3]' },
    { value: '90010112345', replacement: '[SSN_1]' },
    { value: '12', replacement: '[N_1]' },
  ];
  const scrub = (formula: string) => scrubFormulaValues(formula, VALUES);

  it('replaces values inside string literals', () => {
    expect(scrub('"Jan Kowalski,Anna Nowak"')).toBe('"[PERSON_1],Anna Nowak"');
    expect(scrub('IF($A2="Jan Kowalski","tak","nie")')).toBe('IF($A2="[PERSON_1]","tak","nie")');
    expect(scrub('"Dear "&A2&" Kowalski, id 90010112345"')).toBe('"Dear "&A2&" [PERSON_1_LAST], id [SSN_1]"');
    // A doubled quote is a quote of the text, not the end of the literal.
    expect(scrub('"He said ""Vera"" twice"')).toBe('"He said ""[PERSON_2]"" twice"');
  });

  it('never rewrites the name of a function', () => {
    expect(scrub('AVERAGE(A1:A5)+MAX(B1:B5)')).toBe('AVERAGE(A1:A5)+MAX(B1:B5)');
    expect(scrub('_xlfn.MAXIFS(A:A,B:B,"Vera")')).toBe('_xlfn.MAXIFS(A:A,B:B,"[PERSON_2]")');
    expect(scrub('IF(AVERAGE (A1:A5)>3,"Max","x")')).toBe('IF(AVERAGE (A1:A5)>3,"[PERSON_3]","x")');
  });

  it('turns a known number into a string literal and leaves the rows of references', () => {
    expect(scrub('IF(A1=90010112345,1,0)')).toBe('IF(A1="[SSN_1]",1,0)');
    expect(scrub('SUM(A12:$B$12)*12+3.12+Sheet12!C1')).toBe('SUM(A12:$B$12)*"[N_1]"+3.12+Sheet12!C1');
    expect(scrub('SUM(12:12)')).toBe('SUM(12:12)');
  });

  it('never rewrites a cell reference or a column range', () => {
    const pairs = [{ value: 'IT', replacement: '[DEPT_1]' }, { value: 'AB', replacement: '[X_1]' }];
    expect(scrubFormulaValues('IT1+$AB$12*SUM(AB:AB)+IT_Budget+"AB and IT"', pairs)).toBe('IT1+$AB$12*SUM(AB:AB)+[DEPT_1]_Budget+"[X_1] and [DEPT_1]"');
  });

  it('replaces a value in a defined name or a table column as written, as before', () => {
    expect(scrub('Kowalski_Stawka*2')).toBe('[PERSON_1_LAST]_Stawka*2');
    expect(scrub("'Arkusz Kowalski'!A1")).toBe("'Arkusz [PERSON_1_LAST]'!A1");
  });

  it('returns a formula without known values, and any formula against an empty list, unchanged', () => {
    expect(scrub('SUM(A1:A5)&" total"')).toBe('SUM(A1:A5)&" total"');
    expect(scrubFormulaValues('"Jan Kowalski"', [])).toBe('"Jan Kowalski"');
    // A literal that never closes is scrubbed to its end.
    expect(scrub('"Jan Kowalski')).toBe('"[PERSON_1]');
  });
});

describe('scrubUnmappedValues', () => {
  const parse = (xml: string) => new DOMParser().parseFromString(xml, 'application/xml');
  const serialize = (doc: Document) => new XMLSerializer().serializeToString(doc);
  const VALUES = [
    { value: 'Jan Kowalski', replacement: '[PERSON_1]' },
    { value: '90010112345', replacement: '[SSN_1]' },
    { value: '12', replacement: '[N_1]' },
  ];

  it('scrubs unmapped text and attributes, never the text of a mapped element', () => {
    const doc = parse('<root><kept note="Jan Kowalski">Jan Kowalski <b>and Jan Kowalski</b></kept><other>Jan Kowalski</other></root>');
    const kept = doc.getElementsByTagName('kept')[0];
    expect(scrubUnmappedValues(doc, VALUES, [{ element: kept }])).toBe(true);
    expect(serialize(doc)).toBe('<root><kept note="[PERSON_1]">Jan Kowalski <b>and Jan Kowalski</b></kept><other>[PERSON_1]</other></root>');
  });

  it('leaves a mapped attribute and an attribute the caller keeps', () => {
    const doc = parse('<root><a alias="Jan Kowalski" tip="Jan Kowalski" instr="Jan Kowalski"/></root>');
    const a = doc.getElementsByTagName('a')[0];
    scrubUnmappedValues(doc, VALUES, [{ element: a, attr: a.getAttributeNode('alias')! }], {
      keepAttribute: (_el, attr) => attr.localName === 'instr',
    });
    expect(serialize(doc)).toBe('<root><a alias="Jan Kowalski" tip="[PERSON_1]" instr="Jan Kowalski"/></root>');
  });

  it('applies the attribute rule: lettered values and long numbers, never ids or short numbers', () => {
    const doc = parse('<root xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<a id="Jan Kowalski" r:id="Jan Kowalski" val="90010112345" count="12" code="x90010112345" w="12"/></root>');
    scrubUnmappedValues(doc, VALUES, []);
    const out = serialize(doc);
    expect(out).toContain(' id="Jan Kowalski"');
    expect(out).toContain('r:id="Jan Kowalski"');
    expect(out).toContain('val="[SSN_1]"');
    expect(out).toContain('count="12"');
    expect(out).toContain('code="x90010112345"');
  });

  it('treats a text node that is a bare number like an attribute: only a long number, as a whole', () => {
    const doc = parse('<root><v>12</v><v>3125</v><v>12.5</v><v>90010112345</v><f>A12+"Jan Kowalski"</f></root>');
    scrubUnmappedValues(doc, VALUES, []);
    expect(serialize(doc)).toBe('<root><v>12</v><v>3125</v><v>12.5</v><v>[SSN_1]</v><f>A[N_1]+"[PERSON_1]"</f></root>');
  });

  it('replaces a one-word attribute value or text node only as a whole', () => {
    const pairs = [{ value: 'Otto', replacement: '[PERSON_1]' }, { value: 'Page', replacement: '[PERSON_2]' }];
    const doc = parse('<root><a pane="bottomLeft" kind="nextPage" who="Otto" lower="otto" note="for Otto" file="otto_page.png"/>'
      + '<align>bottom</align><code>General</code><name> Otto </name><text>Otto Page</text></root>');
    scrubUnmappedValues(doc, pairs, []);
    expect(serialize(doc)).toBe('<root><a pane="bottomLeft" kind="nextPage" who="[PERSON_1]" lower="[PERSON_1]" note="for [PERSON_1]" file="[PERSON_1]_[PERSON_2].png"/>'
      + '<align>bottom</align><code>General</code><name> [PERSON_1] </name><text>[PERSON_1] [PERSON_2]</text></root>');
  });

  it('never rewrites a schema name (uri), in a content part or anywhere else', () => {
    const pairs = [{ value: 'Microsoft', replacement: '[COMPANY_1]' }];
    const xml = '<root><graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" note="made with Microsoft Word"/></root>';
    const expected = '<root><graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" note="made with [COMPANY_1] Word"/></root>';
    const content = parse(xml);
    scrubUnmappedValues(content, pairs, []);
    expect(serialize(content)).toBe(expected);
    const other = parse(xml);
    scrubXmlValues(other, pairs, false);
    expect(serialize(other)).toBe(expected);
  });

  it('reports whether anything changed and ignores an empty value list', () => {
    const doc = parse('<root><other>Jan Kowalski</other></root>');
    expect(scrubUnmappedValues(doc, [], [])).toBe(false);
    expect(scrubUnmappedValues(doc, [{ value: 'Nobody', replacement: '[PERSON_9]' }], [])).toBe(false);
    expect(serialize(doc)).toBe('<root><other>Jan Kowalski</other></root>');
  });
});
