// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import {
  analyzeOfficeFile,
  redactOfficeFile,
  redactedFileName,
  officeFileKind,
} from '../src/dom/office.ts';
import { readDocx, writeAnonymizedDocx } from '../src/dom/docx.ts';
import { AnonymizationSession } from '../src/session.ts';
import type { DetectedEntity, EntityType } from '../src/types.ts';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const SS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

function buildDocx(): JSZip {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL}">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}">
  <w:body>
    <w:p><w:r><w:t>Case of John Smith, email jane@acme.com.</w:t></w:r></w:p>
    <w:p>
      <w:r><w:t>Kept before. </w:t></w:r>
      <w:del w:id="1" w:author="Alice Reviewer" w:date="2024-01-01T00:00:00Z">
        <w:r><w:delText>Deleted draft sentence.</w:delText></w:r>
      </w:del>
      <w:ins w:id="2" w:author="Alice Reviewer" w:date="2024-01-01T00:00:00Z">
        <w:r><w:t>Inserted final sentence.</w:t></w:r>
      </w:ins>
      <w:r>
        <w:rPr><w:rPrChange w:id="3" w:author="Alice Reviewer" w:date="2024-01-01T00:00:00Z"><w:rPr/></w:rPrChange></w:rPr>
        <w:t> Kept after.</w:t>
      </w:r>
    </w:p>
  </w:body>
</w:document>`);
  zip.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:creator>Real Author</dc:creator>
</cp:coreProperties>`);
  return zip;
}

function buildXlsxZip(): JSZip {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL}">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`);
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="${SS}"><sheets><sheet name="Sheet1" sheetId="1"/></sheets></workbook>`);
  zip.file('xl/sharedStrings.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="${SS}" count="1" uniqueCount="1"><si><t>Owner: John Smith</t></si></sst>`);
  zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="${SS}"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>`);
  return zip;
}

async function zipToFile(zip: JSZip, name: string): Promise<File> {
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

/** Fake detection pipeline: finds literal values with fixed types. */
function fakeDetect(targets: Array<[string, EntityType]>) {
  return async (text: string): Promise<DetectedEntity[]> => {
    const entities: DetectedEntity[] = [];
    for (const [value, type] of targets) {
      let idx = text.indexOf(value);
      while (idx !== -1) {
        entities.push({ type, value, start: idx, end: idx + value.length, confidence: 1, detector: 'test' });
        idx = text.indexOf(value, idx + 1);
      }
    }
    return entities;
  };
}

const DETECT = fakeDetect([
  ['John Smith', 'PERSON'],
  ['jane@acme.com', 'EMAIL'],
]);

async function partContents(blob: Blob): Promise<Map<string, string>> {
  const zip = await JSZip.loadAsync(await blobToArrayBuffer(blob));
  const contents = new Map<string, string>();
  for (const path of Object.keys(zip.files)) {
    const f = zip.file(path);
    if (f && !path.endsWith('/') && (path.endsWith('.xml') || path.endsWith('.rels'))) {
      contents.set(path, await f.async('string'));
    }
  }
  return contents;
}

describe('officeFileKind and redactedFileName', () => {
  it('classifies supported extensions and rejects the rest', () => {
    expect(officeFileKind('report.docx')).toBe('docx');
    expect(officeFileKind('Budget.XLSX')).toBe('xlsx');
    expect(officeFileKind('legacy.doc')).toBeNull();
    expect(officeFileKind('scan.pdf')).toBeNull(); // PDF output is permanently out of scope
    expect(officeFileKind('noext')).toBeNull();
  });

  it('derives the redacted copy name', () => {
    expect(redactedFileName('report.docx')).toBe('report.redacted.docx');
    expect(redactedFileName('my.data.xlsx')).toBe('my.data.redacted.xlsx');
    expect(redactedFileName('noext')).toBe('noext.redacted');
  });
});

describe('analyzeOfficeFile', () => {
  it('returns entities without touching any session', async () => {
    const file = await zipToFile(buildDocx(), 'case.docx');
    const analysis = await analyzeOfficeFile(file, DETECT);
    expect(analysis.kind).toBe('docx');
    expect(analysis.entities.map((e) => e.value).sort()).toEqual(['John Smith', 'jane@acme.com']);
    expect(analysis.plainText).toContain('John Smith');
  });

  it('rejects unsupported files', async () => {
    const file = new File([new ArrayBuffer(4)], 'scan.pdf');
    await expect(analyzeOfficeFile(file, DETECT)).rejects.toThrow(/Unsupported/);
  });
});

describe('redactOfficeFile round trip (docx)', () => {
  it('produces a valid redacted docx and leaves the original untouched', async () => {
    const zip = buildDocx();
    const originalBytes = new Uint8Array(await zip.generateAsync({ type: 'arraybuffer' }));
    const snapshot = originalBytes.slice();
    const file = new File([originalBytes.buffer as ArrayBuffer], 'case.docx');
    if (typeof file.arrayBuffer !== 'function') {
      Object.defineProperty(file, 'arrayBuffer', { value: async () => originalBytes.buffer });
    }

    const session = new AnonymizationSession();
    const result = await redactOfficeFile(file, { session, detect: DETECT });

    expect(result.kind).toBe('docx');
    expect(result.suggestedName).toBe('case.redacted.docx');
    expect(result.entities.length).toBeGreaterThan(0);
    expect(originalBytes).toEqual(snapshot); // input buffer untouched

    const out = await partContents(result.blob);
    const doc = out.get('word/document.xml')!;
    expect(doc).not.toContain('John Smith');
    expect(doc).not.toContain('jane@acme.com');
    expect(doc).toContain('[PERSON_1]');
    expect(doc).toContain('[EMAIL_1]');
    expect(out.get('docProps/core.xml')!).not.toContain('Real Author');

    // Every part stays well-formed XML (Word can open the file)
    const parser = new DOMParser();
    for (const [path, content] of out) {
      const parsed = parser.parseFromString(content, 'application/xml');
      expect(parsed.getElementsByTagName('parsererror').length, `malformed: ${path}`).toBe(0);
    }
  });

  it('accepts tracked changes by default: deletions gone, insertions unwrapped', async () => {
    const file = await zipToFile(buildDocx(), 'case.docx');
    const session = new AnonymizationSession();
    const result = await redactOfficeFile(file, { session, detect: DETECT });
    const doc = (await partContents(result.blob)).get('word/document.xml')!;
    expect(doc).not.toContain('w:del');
    expect(doc).not.toContain('Deleted draft sentence');
    expect(doc).not.toContain('<w:ins');
    expect(doc).toContain('Inserted final sentence.');
    expect(doc).not.toContain('rPrChange');
    expect(doc).not.toContain('Alice Reviewer');
    expect(doc).toContain('Kept before.');
    expect(doc).toContain('Kept after.');
  });

  it('keeps tracked changes when acceptTrackedChanges is false', async () => {
    const file = await zipToFile(buildDocx(), 'case.docx');
    const session = new AnonymizationSession();
    const result = await redactOfficeFile(file, {
      session, detect: DETECT, acceptTrackedChanges: false,
    });
    const doc = (await partContents(result.blob)).get('word/document.xml')!;
    expect(doc).toContain('<w:ins');
    expect(doc).toContain('<w:del');
  });

  it('reuses entities from a prior analysis without re-detecting', async () => {
    const file = await zipToFile(buildDocx(), 'case.docx');
    const analysis = await analyzeOfficeFile(file, DETECT);
    let detectCalls = 0;
    const countingDetect = async (text: string) => { detectCalls++; return DETECT(text); };
    const session = new AnonymizationSession();
    const result = await redactOfficeFile(file, {
      session, entities: analysis.entities, detect: countingDetect,
    });
    expect(detectCalls).toBe(0);
    const doc = (await partContents(result.blob)).get('word/document.xml')!;
    expect(doc).not.toContain('John Smith');
  });

  it('drops stale entities whose offsets do not match the text', async () => {
    const file = await zipToFile(buildDocx(), 'case.docx');
    const session = new AnonymizationSession();
    const result = await redactOfficeFile(file, {
      session,
      entities: [
        { type: 'PERSON', value: 'Nobody Here', start: 0, end: 11, confidence: 1, detector: 'stale' },
      ],
    });
    expect(result.entities).toHaveLength(0);
    const doc = (await partContents(result.blob)).get('word/document.xml')!;
    expect(doc).toContain('John Smith'); // nothing valid to redact
  });
});

describe('redactOfficeFile round trip (xlsx)', () => {
  it('produces a valid redacted xlsx with session placeholders', async () => {
    const file = await zipToFile(buildXlsxZip(), 'clients.xlsx');
    const session = new AnonymizationSession();
    const result = await redactOfficeFile(file, { session, detect: DETECT });

    expect(result.kind).toBe('xlsx');
    expect(result.suggestedName).toBe('clients.redacted.xlsx');
    const out = await partContents(result.blob);
    const shared = out.get('xl/sharedStrings.xml')!;
    expect(shared).not.toContain('John Smith');
    expect(shared).toContain('[PERSON_1]');

    const parser = new DOMParser();
    for (const [path, content] of out) {
      const parsed = parser.parseFromString(content, 'application/xml');
      expect(parsed.getElementsByTagName('parsererror').length, `malformed: ${path}`).toBe(0);
    }
  });
});

describe('session consistency between prompts and files (T110 DoD)', () => {
  it('a value redacted in a prompt reuses its placeholder in the file, and an AI reply about the file restores', async () => {
    const session = new AnonymizationSession();

    // 1. User redacts a prompt mentioning the same person first
    const promptEntities: DetectedEntity[] = [
      { type: 'PERSON', value: 'John Smith', start: 10, end: 20, confidence: 1, detector: 'test' },
    ];
    const redactedPrompt = session.anonymizeText('Summarize John Smith case', promptEntities);
    expect(redactedPrompt).toBe('Summarize [PERSON_1] case');

    // 2. Then uploads the file; the same person gets the SAME placeholder
    const file = await zipToFile(buildDocx(), 'case.docx');
    const result = await redactOfficeFile(file, { session, detect: DETECT });
    const doc = (await partContents(result.blob)).get('word/document.xml')!;
    expect(doc).toContain('[PERSON_1]');
    expect(doc).not.toContain('[PERSON_2]');
    // A NEW entity found only in the file continues numbering in the shared map
    expect(session.getForward('jane@acme.com')).toBe('[EMAIL_1]');

    // 3. An AI reply that references the file's placeholders restores fully
    const reply = 'The document about [PERSON_1] lists [EMAIL_1] as contact.';
    expect(session.deanonymize(reply)).toBe(
      'The document about John Smith lists jane@acme.com as contact.'
    );
  });

  it('surrogate mode maps file persons deterministically with the session salt', async () => {
    const salt = 'fixed-test-salt';
    const sessionA = new AnonymizationSession({ mode: 'surrogate', salt });
    const sessionB = new AnonymizationSession({ mode: 'surrogate', salt });
    const file = await zipToFile(buildDocx(), 'case.docx');
    const a = await redactOfficeFile(file, { session: sessionA, detect: DETECT });
    const b = await redactOfficeFile(await zipToFile(buildDocx(), 'case.docx'), { session: sessionB, detect: DETECT });
    expect(a.redactedText).toBe(b.redactedText);
    expect(a.redactedText).not.toContain('John Smith');
  });
});

describe('writeAnonymizedDocx options regression', () => {
  it('keeps historical behavior when options are omitted', async () => {
    const file = await zipToFile(buildDocx(), 'case.docx');
    const extraction = await readDocx(file);
    const blob = await writeAnonymizedDocx(extraction, []);
    const doc = (await partContents(blob)).get('word/document.xml')!;
    expect(doc).toContain('<w:ins'); // tracked changes untouched by default
    expect(doc).toContain('<w:del');
  });
});
