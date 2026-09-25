// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  analyzeOfficeFile,
  redactOfficeFile,
  redactedFileName,
  officeFileKind,
  StaleAnalysisError,
  isStaleAnalysisError,
} from '../src/dom/office.ts';
import { readDocx, writeAnonymizedDocx } from '../src/dom/docx.ts';
import { UnsupportedDocumentError } from '../src/dom/errors.ts';
import { AnonymizationSession } from '../src/session.ts';
import type { DetectedEntity, EntityType } from '../src/types.ts';
import { assertNoTrace, writeOutput } from './helpers/package-scan.ts';

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

/** buildDocx plus an OLE object: an unredactable part under the T177 policy. */
function buildDocxWithEmbedding(): JSZip {
  const zip = buildDocx();
  zip.file('word/embeddings/oleObject1.bin', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3]));
  return zip;
}

/** buildXlsxZip plus an OLE object: an unredactable part under the T177 policy. */
function buildXlsxWithEmbedding(): JSZip {
  const zip = buildXlsxZip();
  zip.file('xl/embeddings/oleObject1.bin', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3]));
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
    expect(officeFileKind('scan.pdf')).toBe('pdf'); // T215: PDF-to-PDF with the text layer kept
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
    const file = new File([new ArrayBuffer(4)], 'scan.txt');
    await expect(analyzeOfficeFile(file, DETECT)).rejects.toThrow(/Unsupported/);
  });

  it('refuses a file that only pretends to be a PDF', async () => {
    const file = new File([new ArrayBuffer(4)], 'scan.pdf');
    await expect(analyzeOfficeFile(file, DETECT, { pdf: {} })).rejects.toMatchObject({ name: 'UnsupportedDocumentError', code: 'invalid-package' });
    // Without PDF options the host has no PDF support wired: refused like an unsupported format.
    await expect(analyzeOfficeFile(file, DETECT)).rejects.toThrow(/Unsupported/);
  });

  it('exposes the unredactable part list and reader warnings (T179, T177 passthrough)', async () => {
    const clean = await analyzeOfficeFile(await zipToFile(buildDocx(), 'case.docx'), DETECT);
    expect(clean.unredactable).toEqual([]);
    expect(clean.warnings).toEqual([]);

    const withObject = await analyzeOfficeFile(await zipToFile(buildDocxWithEmbedding(), 'case.docx'), DETECT);
    expect(withObject.unredactable.map((p) => p.part)).toEqual(['word/embeddings/oleObject1.bin']);
    expect(withObject.unredactable[0].kind).toBe('embedded-object');
    expect(withObject.entities.map((e) => e.value).sort()).toEqual(['John Smith', 'jane@acme.com']);

    const xlsx = await analyzeOfficeFile(await zipToFile(buildXlsxWithEmbedding(), 'clients.xlsx'), DETECT);
    expect(xlsx.unredactable.map((p) => p.part)).toEqual(['xl/embeddings/oleObject1.bin']);
    expect(xlsx.warnings).toEqual([]);
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
    await assertNoTrace(result.blob, ['John Smith', 'jane@acme.com', 'Real Author']);
    await writeOutput('office-docx-round-trip.docx', result.blob);

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
    await assertNoTrace(result.blob, ['John Smith', 'jane@acme.com', 'Alice Reviewer', 'Deleted draft sentence']);
    await writeOutput('office-docx-accept-tracked-changes.docx', result.blob);
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
    await assertNoTrace(result.blob, ['John Smith', 'jane@acme.com']);
    await writeOutput('office-docx-keep-tracked-changes.docx', result.blob);
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
    await assertNoTrace(result.blob, ['John Smith', 'jane@acme.com']);
    await writeOutput('office-docx-reuse-entities.docx', result.blob);
    const doc = (await partContents(result.blob)).get('word/document.xml')!;
    expect(doc).not.toContain('John Smith');
  });

  it('refuses stale entities whose offsets do not match the text instead of shipping the value (T179, M4)', async () => {
    const file = await zipToFile(buildDocx(), 'case.docx');
    const session = new AnonymizationSession();
    await expect(redactOfficeFile(file, {
      session,
      entities: [
        { type: 'PERSON', value: 'Nobody Here', start: 0, end: 11, confidence: 1, detector: 'stale' },
      ],
    })).rejects.toBeInstanceOf(StaleAnalysisError);
    // Refused before the session was touched.
    expect(session.getEntries()).toEqual([]);
  });

  it('returns no warnings and lists no unredactable parts on a clean file', async () => {
    const file = await zipToFile(buildDocx(), 'case.docx');
    const result = await redactOfficeFile(file, { session: new AnonymizationSession(), detect: DETECT });
    expect(result.warnings).toEqual([]);
    expect(result.unredactable).toEqual([]);
  });
});

describe('redactOfficeFile onMismatch (T179, M4)', () => {
  const STALE_A: DetectedEntity = { type: 'PERSON', value: 'Nobody Here', start: 0, end: 11, confidence: 1, detector: 'stale' };
  const STALE_B: DetectedEntity = { type: 'EMAIL', value: 'gone@old.example', start: 500, end: 516, confidence: 1, detector: 'stale' };

  it('the error names every mismatched entity, none of the valid ones, and does not repeat the values in its message', async () => {
    const file = await zipToFile(buildDocx(), 'case.docx');
    const analysis = await analyzeOfficeFile(file, DETECT);
    const session = new AnonymizationSession();
    let caught: unknown;
    try {
      await redactOfficeFile(file, { session, entities: [STALE_A, ...analysis.entities, STALE_B] });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StaleAnalysisError);
    expect(isStaleAnalysisError(caught)).toBe(true);
    const err = caught as StaleAnalysisError;
    expect(err.name).toBe('StaleAnalysisError');
    expect(err.entities).toEqual([STALE_A, STALE_B]);
    expect(err.message).toContain('2 of 4');
    expect(err.message).toContain('PERSON@0-11');
    expect(err.message).toContain('EMAIL@500-516');
    expect(err.message).not.toContain('Nobody Here');
    expect(err.message).not.toContain('gone@old.example');
    expect(session.getEntries()).toEqual([]);
  });

  it('a wrong value at otherwise valid offsets is a mismatch too', async () => {
    const file = await zipToFile(buildDocx(), 'case.docx');
    const analysis = await analyzeOfficeFile(file, DETECT);
    const john = analysis.entities.find((e) => e.value === 'John Smith')!;
    const shifted = { ...john, start: john.start + 1, end: john.end + 1 };
    await expect(redactOfficeFile(file, { session: new AnonymizationSession(), entities: [shifted], onMismatch: 'throw' }))
      .rejects.toMatchObject({ name: 'StaleAnalysisError', entities: [shifted] });
  });

  it("onMismatch: 'drop' keeps the historical behaviour: mismatches filtered, valid entities redacted", async () => {
    const file = await zipToFile(buildDocx(), 'case.docx');
    const analysis = await analyzeOfficeFile(file, DETECT);
    const session = new AnonymizationSession();
    const result = await redactOfficeFile(file, {
      session,
      entities: [STALE_A, ...analysis.entities, STALE_B],
      onMismatch: 'drop',
    });
    expect(result.entities.map((e) => e.value).sort()).toEqual(['John Smith', 'jane@acme.com']);
    await assertNoTrace(result.blob, ['John Smith', 'jane@acme.com']);
    await writeOutput('office-docx-drop-stale-entities.docx', result.blob);
    const doc = (await partContents(result.blob)).get('word/document.xml')!;
    expect(doc).toContain('[PERSON_1]');
    expect(session.getForward('Nobody Here')).toBeUndefined();
  });

  it("onMismatch: 'drop' with only stale entities writes an unredacted copy (the host asked for it)", async () => {
    const file = await zipToFile(buildDocx(), 'case.docx');
    const result = await redactOfficeFile(file, { session: new AnonymizationSession(), entities: [STALE_A], onMismatch: 'drop' });
    expect(result.entities).toHaveLength(0);
    await writeOutput('office-docx-stale-entities.docx', result.blob);
    const doc = (await partContents(result.blob)).get('word/document.xml')!;
    expect(doc).toContain('John Smith');
  });

  it('entities from a fresh analysis never trip the default', async () => {
    const file = await zipToFile(buildDocx(), 'case.docx');
    const analysis = await analyzeOfficeFile(file, DETECT);
    const result = await redactOfficeFile(file, { session: new AnonymizationSession(), entities: analysis.entities });
    expect(result.entities).toHaveLength(analysis.entities.length);
  });
});

describe('redactOfficeFile allowUnredactable passthrough (T179, T177)', () => {
  it('docx: refuses by default with the part names, copies verbatim with a warning when allowed', async () => {
    const session = new AnonymizationSession();
    await expect(redactOfficeFile(await zipToFile(buildDocxWithEmbedding(), 'case.docx'), { session, detect: DETECT }))
      .rejects.toMatchObject({ code: 'unredactable-parts', details: ['word/embeddings/oleObject1.bin'] });
    let refused: unknown;
    try {
      await redactOfficeFile(await zipToFile(buildDocxWithEmbedding(), 'case.docx'), { session, detect: DETECT, allowUnredactable: false });
    } catch (err) {
      refused = err;
    }
    expect(refused).toBeInstanceOf(UnsupportedDocumentError);

    const result = await redactOfficeFile(await zipToFile(buildDocxWithEmbedding(), 'case.docx'), {
      session, detect: DETECT, allowUnredactable: true,
    });
    await assertNoTrace(result.blob, ['John Smith', 'jane@acme.com']);
    await writeOutput('office-docx-allow-unredactable.docx', result.blob);
    expect(result.unredactable.map((p) => p.part)).toEqual(['word/embeddings/oleObject1.bin']);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/^word\/embeddings\/oleObject1\.bin: .*copied verbatim \(not redacted\)$/);
    const out = await JSZip.loadAsync(await blobToArrayBuffer(result.blob));
    expect(out.file('word/embeddings/oleObject1.bin')).not.toBeNull();
  });

  it('xlsx: refuses by default, copies verbatim with a warning when allowed', async () => {
    const session = new AnonymizationSession();
    await expect(redactOfficeFile(await zipToFile(buildXlsxWithEmbedding(), 'clients.xlsx'), { session, detect: DETECT }))
      .rejects.toMatchObject({ code: 'unredactable-parts', details: ['xl/embeddings/oleObject1.bin'] });

    const result = await redactOfficeFile(await zipToFile(buildXlsxWithEmbedding(), 'clients.xlsx'), {
      session, detect: DETECT, allowUnredactable: true,
    });
    await assertNoTrace(result.blob, ['John Smith']);
    await writeOutput('office-xlsx-allow-unredactable.xlsx', result.blob);
    expect(result.unredactable.map((p) => p.part)).toEqual(['xl/embeddings/oleObject1.bin']);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/^xl\/embeddings\/oleObject1\.bin: .*copied verbatim \(not redacted\)$/);
    const out = await JSZip.loadAsync(await blobToArrayBuffer(result.blob));
    expect(out.file('xl/embeddings/oleObject1.bin')).not.toBeNull();
  });
});

describe('redactOfficeFile layer zero from the session (T179, T172 follow-up)', () => {
  it('a PERSON name token from the session reaches parts the extractor never reads', async () => {
    const zip = buildDocx();
    // A structural part the docx reader does not extract: only layer zero visits it.
    zip.file('word/theme/theme1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Theme by Smith"><a:custClrLst><a:custClr name="Smith blue"/></a:custClrLst><a:extLst><a:ext uri="x"><note>prepared for Smith, see John Smith</note></a:ext></a:extLst></a:theme>`);
    const session = new AnonymizationSession();
    const result = await redactOfficeFile(await zipToFile(zip, 'case.docx'), { session, detect: DETECT });
    await assertNoTrace(result.blob, ['John Smith', 'Smith', 'jane@acme.com']);
    await writeOutput('office-docx-layer-zero-tokens.docx', result.blob);
    const theme = (await partContents(result.blob)).get('word/theme/theme1.xml')!;
    expect(theme).toContain('prepared for [PERSON_1], see [PERSON_1]');
    expect(theme).toContain('name="Theme by [PERSON_1]"');
  });
});

describe('redactOfficeFile container normalisation (T179, L1)', () => {
  async function fingerprintedFile(zip: JSZip, name: string): Promise<File> {
    for (const [path, entry] of Object.entries(zip.files)) {
      entry.date = new Date('2024-05-06T07:08:09Z');
      entry.comment = `note for ${path}`;
    }
    const ab = await zip.generateAsync({ type: 'arraybuffer', comment: 'archive note' });
    const file = new File([ab], name);
    if (typeof file.arrayBuffer !== 'function') {
      Object.defineProperty(file, 'arrayBuffer', { value: async () => ab });
    }
    return file;
  }

  async function expectNormalised(blob: Blob): Promise<void> {
    const out = await JSZip.loadAsync(await blobToArrayBuffer(blob));
    expect((out as unknown as { comment: string | null }).comment || '').toBe('');
    const names = Object.keys(out.files);
    expect(names.length).toBeGreaterThan(2);
    for (const name of names) {
      expect(out.files[name].date.getTime(), `${name} date`).toBe(Date.UTC(1980, 0, 1));
      expect(out.files[name].comment || '', `${name} comment`).toBe('');
    }
  }

  it('docx: every entry dated 1980-01-01 UTC, no entry or archive comments', async () => {
    const result = await redactOfficeFile(await fingerprintedFile(buildDocx(), 'case.docx'), {
      session: new AnonymizationSession(), detect: DETECT,
    });
    await expectNormalised(result.blob);
  });

  it('xlsx: every entry dated 1980-01-01 UTC, no entry or archive comments', async () => {
    const result = await redactOfficeFile(await fingerprintedFile(buildXlsxZip(), 'clients.xlsx'), {
      session: new AnonymizationSession(), detect: DETECT,
    });
    await expectNormalised(result.blob);
  });
});

describe('redactOfficeFile round trip (xlsx)', () => {
  it('produces a valid redacted xlsx with session placeholders', async () => {
    const file = await zipToFile(buildXlsxZip(), 'clients.xlsx');
    const session = new AnonymizationSession();
    const result = await redactOfficeFile(file, { session, detect: DETECT });

    expect(result.kind).toBe('xlsx');
    expect(result.suggestedName).toBe('clients.redacted.xlsx');
    await assertNoTrace(result.blob, ['John Smith']);
    await writeOutput('office-xlsx-round-trip.xlsx', result.blob);
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
    await assertNoTrace(result.blob, ['John Smith', 'jane@acme.com']);
    await writeOutput('office-docx-session-consistency.docx', result.blob);
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
    await assertNoTrace(a.blob, ['John Smith', 'jane@acme.com']);
    await assertNoTrace(b.blob, ['John Smith', 'jane@acme.com']);
    await writeOutput('office-docx-surrogate-a.docx', a.blob);
    await writeOutput('office-docx-surrogate-b.docx', b.blob);
  });
});

describe('writeAnonymizedDocx options regression', () => {
  it('keeps historical behavior when options are omitted', async () => {
    const file = await zipToFile(buildDocx(), 'case.docx');
    const extraction = await readDocx(file);
    const blob = await writeAnonymizedDocx(extraction, []);
    // No replacements were requested, so there are no originals to scan for.
    await writeOutput('office-docx-options-regression.docx', blob);
    const doc = (await partContents(blob)).get('word/document.xml')!;
    expect(doc).toContain('<w:ins'); // tracked changes untouched by default
    expect(doc).toContain('<w:del');
  });
});


describe('redactOfficeFile: PDF (T215)', () => {
  const FIXTURE = join(__dirname, 'fixtures', 'pdf', 'baseline_text.pdf');
  const FONTS = join(__dirname, '..', 'fonts', 'liberation');
  const pdfOptions = { assets: { loadFont: async (file: string) => new Uint8Array(readFileSync(join(FONTS, file))) } };
  const PDF_DETECT = fakeDetect([
    ['Jan Kowalski', 'PERSON'],
    ['jan.kowalski@example.com', 'EMAIL'],
  ]);

  function pdfFile(): File {
    return new File([readFileSync(FIXTURE)], 'invoice.pdf', { type: 'application/pdf' });
  }

  it('analyzes a PDF through the same entry point as docx', async () => {
    const analysis = await analyzeOfficeFile(pdfFile(), PDF_DETECT, { pdf: pdfOptions });
    expect(analysis.kind).toBe('pdf');
    expect(analysis.plainText).toContain('Nabywca: Jan Kowalski');
    expect(analysis.entities.map((e) => e.value)).toContain('Jan Kowalski');
    expect(analysis.unredactable).toEqual([]);
    expect(analysis.removed).toEqual([]);
  });

  it('redacts a PDF with session placeholders and returns a PDF blob with no trace', async () => {
    const session = new AnonymizationSession();
    const result = await redactOfficeFile(pdfFile(), { session, detect: PDF_DETECT, pdf: pdfOptions });
    expect(result.kind).toBe('pdf');
    expect(result.suggestedName).toBe('invoice.redacted.pdf');
    expect(result.blob.type).toBe('application/pdf');
    expect(result.rasterizedPages).toEqual([]);
    expect(result.redactedText).toContain('[PERSON_1]');
    expect(session.getForward('Jan Kowalski')).toBe('[PERSON_1]');
    const bytes = new Uint8Array(await blobToArrayBuffer(result.blob));
    await assertNoTrace(bytes, ['Jan Kowalski', 'jan.kowalski@example.com']);
    // 'pdf-' prefix: only the name and e-mail are detected here, the phone stays on purpose, so the
    // CI poppler step opens this output without grepping it for the corpus needles.
    writeOutput('pdf-office-invoice-redacted.pdf', bytes);
  });

  it('raises StaleAnalysisError for entities that do not match the PDF text', async () => {
    const session = new AnonymizationSession();
    const stale: DetectedEntity[] = [{ value: 'Nobody Here', type: 'PERSON' as EntityType, start: 0, end: 11, score: 1, source: 'ml' } as unknown as DetectedEntity];
    await expect(redactOfficeFile(pdfFile(), { session, entities: stale, pdf: pdfOptions })).rejects.toBeInstanceOf(StaleAnalysisError);
  });
});
