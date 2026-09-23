// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { readXlsx, writeAnonymizedXlsx, isExcelFile } from '../src/dom/xlsx.ts';

const SS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function buildXlsx(): JSZip {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="jpeg" ContentType="image/jpeg"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
  <Override PartName="/xl/comments1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/>
  <Override PartName="/docProps/thumbnail.jpeg" ContentType="image/jpeg"/>
</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL}">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail" Target="docProps/thumbnail.jpeg"/>
</Relationships>`);
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="${SS}" xmlns:r="${R}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:x15ac="http://schemas.microsoft.com/office/spreadsheetml/2010/11/ac">
  <fileSharing userName="Real Reserver"/>
  <mc:AlternateContent><mc:Choice Requires="x15ac"><x15ac:absPath url="C:\\Users\\realuser\\Documents\\clients\\"/></mc:Choice></mc:AlternateContent>
  <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL}">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`);
  zip.file('xl/sharedStrings.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="${SS}" count="3" uniqueCount="3">
  <si><t>Client: John Smith</t></si>
  <si><r><rPr><b/></rPr><t>Contact </t></r><r><t>jane@acme.com</t></r></si>
  <si><t>Plain data</t></si>
</sst>`);
  zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="${SS}" xmlns:r="${R}">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="B1" t="s"><v>1</v></c>
      <c r="C1" t="s"><v>2</v></c>
    </row>
    <row r="2">
      <c r="A2" t="inlineStr"><is><t>Inline PESEL 90010112345</t></is></c>
      <c r="B2" t="str"><f>CONCATENATE("SSN ","123-45-6789")</f><v>SSN 123-45-6789</v></c>
      <c r="C2"><v>42</v></c>
    </row>
  </sheetData>
  <hyperlinks>
    <hyperlink ref="B1" r:id="rIdH" display="mail jane@acme.com" tooltip="write to jane@acme.com"/>
  </hyperlinks>
  <headerFooter><oddHeader>&amp;LPrepared by John Smith</oddHeader></headerFooter>
</worksheet>`);
  zip.file('xl/worksheets/_rels/sheet1.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL}">
  <Relationship Id="rIdH" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="mailto:jane@acme.com" TargetMode="External"/>
</Relationships>`);
  zip.file('xl/comments1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<comments xmlns="${SS}">
  <authors><author>Bob Commenter</author></authors>
  <commentList>
    <comment ref="A1" authorId="0"><text><r><t>Verify with Maria Kowalska</t></r></text></comment>
  </commentList>
</comments>`);
  zip.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:title>Acme client ledger</dc:title>
  <dc:creator>Real Author</dc:creator>
  <cp:lastModifiedBy>Another Person</cp:lastModifiedBy>
</cp:coreProperties>`);
  zip.file('docProps/app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
  <Company>Acme Legal LLP</Company>
  <Application>Excel</Application>
</Properties>`);
  zip.file('docProps/thumbnail.jpeg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
  return zip;
}

async function zipToFile(zip: JSZip, name = 'test.xlsx'): Promise<File> {
  const ab = await zip.generateAsync({ type: 'arraybuffer' });
  const file = new File([ab], name);
  if (typeof file.arrayBuffer !== 'function') {
    Object.defineProperty(file, 'arrayBuffer', { value: async () => ab });
  }
  return file;
}

function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

function findAll(haystack: string, needle: string): Array<{ start: number; end: number }> {
  const result: Array<{ start: number; end: number }> = [];
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    result.push({ start: idx, end: idx + needle.length });
    idx = haystack.indexOf(needle, idx + 1);
  }
  return result;
}

async function redactAll(): Promise<Map<string, string | Uint8Array>> {
  const extraction = await readXlsx(await zipToFile(buildXlsx()));
  const targets = ['John Smith', 'jane@acme.com', '90010112345', '123-45-6789', 'Maria Kowalska'];
  const replacements: Array<{ start: number; end: number; replacement: string }> = [];
  const valueReplacements: Array<{ value: string; replacement: string }> = [];
  targets.forEach((value, i) => {
    const placeholder = `[REDACTED_${i + 1}]`;
    valueReplacements.push({ value, replacement: placeholder });
    for (const range of findAll(extraction.plainText, value)) {
      replacements.push({ ...range, replacement: placeholder });
    }
  });
  const blob = await writeAnonymizedXlsx(extraction, replacements, valueReplacements);
  const outZip = await JSZip.loadAsync(await blobToArrayBuffer(blob));
  const contents = new Map<string, string | Uint8Array>();
  for (const path of Object.keys(outZip.files)) {
    const f = outZip.file(path);
    if (f && !path.endsWith('/')) {
      contents.set(path, path.endsWith('.xml') || path.endsWith('.rels')
        ? await f.async('string')
        : await f.async('uint8array'));
    }
  }
  return contents;
}

describe('readXlsx', () => {
  it('extracts shared strings, inline strings, formula results, headers and comments', async () => {
    const extraction = await readXlsx(await zipToFile(buildXlsx()));
    expect(extraction.plainText).toContain('Client: John Smith');
    expect(extraction.plainText).toContain('Contact jane@acme.com'); // rich runs concatenated
    expect(extraction.plainText).toContain('Inline PESEL 90010112345');
    expect(extraction.plainText).toContain('SSN 123-45-6789'); // cached formula result
    expect(extraction.plainText).toContain('Prepared by John Smith'); // header
    expect(extraction.plainText).toContain('Verify with Maria Kowalska'); // comment
  });

  it('separates string units with newlines so cell values never concatenate', async () => {
    const extraction = await readXlsx(await zipToFile(buildXlsx()));
    const lines = extraction.plainText.split('\n');
    expect(lines).toContain('Client: John Smith');
    expect(lines).toContain('Plain data');
    expect(lines).toContain('Inline PESEL 90010112345');
  });

  it('produces identical extractions across repeated reads', async () => {
    const file = await zipToFile(buildXlsx());
    const a = await readXlsx(file);
    const b = await readXlsx(file);
    expect(a.plainText).toBe(b.plainText);
  });

  it('rejects files without a workbook', async () => {
    const zip = new JSZip();
    zip.file('hello.txt', 'not a workbook');
    await expect(readXlsx(await zipToFile(zip))).rejects.toThrow(/workbook/);
  });
});

describe('writeAnonymizedXlsx', () => {
  it('redacts shared strings, inline strings, formula caches, headers and comments', async () => {
    const out = await redactAll();
    const shared = out.get('xl/sharedStrings.xml') as string;
    expect(shared).not.toContain('John Smith');
    expect(shared).not.toContain('jane@acme.com');
    expect(shared).toContain('[REDACTED_1]');
    const sheet = out.get('xl/worksheets/sheet1.xml') as string;
    expect(sheet).not.toContain('90010112345');
    expect(sheet).not.toContain('123-45-6789');
    expect(sheet).not.toContain('John Smith'); // header
    const comments = out.get('xl/comments1.xml') as string;
    expect(comments).not.toContain('Maria Kowalska');
  });

  it('keeps rich-text formatting and cell structure intact', async () => {
    const out = await redactAll();
    const shared = out.get('xl/sharedStrings.xml') as string;
    expect(shared).toContain('<rPr>'); // bold run formatting survives
    expect(shared).toContain('Plain data'); // untouched entry survives
    const sheet = out.get('xl/worksheets/sheet1.xml') as string;
    expect(sheet).toContain('r="A1" t="s"');
    expect(sheet).toContain('<v>42</v>'); // numeric cell untouched
  });

  it('scrubs formula literals and hyperlink attributes by value', async () => {
    const out = await redactAll();
    const sheet = out.get('xl/worksheets/sheet1.xml') as string;
    expect(sheet).not.toContain('123-45-6789'); // includes the <f> literal
    expect(sheet).not.toContain('jane@acme.com'); // display + tooltip attrs
  });

  it('scrubs external hyperlink relationship targets', async () => {
    const out = await redactAll();
    const rels = out.get('xl/worksheets/_rels/sheet1.xml.rels') as string;
    expect(rels).not.toContain('jane@acme.com');
  });

  it('scrubs comment authors and document properties', async () => {
    const out = await redactAll();
    expect(out.get('xl/comments1.xml') as string).not.toContain('Bob Commenter');
    const core = out.get('docProps/core.xml') as string;
    expect(core).not.toContain('Real Author');
    expect(core).not.toContain('Another Person');
    expect(core).not.toContain('Acme client ledger');
    const app = out.get('docProps/app.xml') as string;
    expect(app).not.toContain('Acme Legal LLP');
    expect(app).toContain('Excel');
  });

  it('removes the absolute path, file sharing identity and thumbnail', async () => {
    const out = await redactAll();
    const workbook = out.get('xl/workbook.xml') as string;
    expect(workbook).not.toContain('realuser');
    expect(workbook).not.toContain('absPath');
    expect(workbook).not.toContain('Real Reserver');
    expect(out.has('docProps/thumbnail.jpeg')).toBe(false);
    expect(out.get('_rels/.rels') as string).not.toContain('thumbnail');
    expect(out.get('[Content_Types].xml') as string).not.toContain('thumbnail');
  });

  it('produces well-formed XML in every part', async () => {
    const out = await redactAll();
    const parser = new DOMParser();
    for (const [path, content] of out) {
      if (typeof content !== 'string') continue;
      const doc = parser.parseFromString(content, 'application/xml');
      expect(doc.getElementsByTagName('parsererror').length, `malformed: ${path}`).toBe(0);
    }
  });
});

describe('isExcelFile', () => {
  it('accepts .xlsx and rejects everything else', () => {
    expect(isExcelFile('budget.xlsx')).toBe(true);
    expect(isExcelFile('BUDGET.XLSX')).toBe(true);
    expect(isExcelFile('legacy.xls')).toBe(false);
    expect(isExcelFile('report.docx')).toBe(false);
    expect(isExcelFile('scan.pdf')).toBe(false);
  });
});
