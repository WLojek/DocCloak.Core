// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import {
  readDocx,
  writeAnonymizedDocx,
  writeAnonymizedDocxWithReport,
  normalizeReplacements,
  fieldInstructionArguments,
  bookmarkIdentifier,
} from '../src/dom/docx.ts';
import { MAILTO_REDACTED_TARGET } from '../src/dom/opc.ts';
import { UnsupportedDocumentError } from '../src/dom/errors.ts';
import { assertNoTrace, writeOutput } from './helpers/package-scan.ts';
import { buildDocxFixture, DOCX_SEED } from './helpers/fixtures/index.ts';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const V = 'urn:schemas-microsoft-com:vml';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

function documentXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}" xmlns:v="${V}">
  <w:body>
    <w:p><w:r><w:t>Contact John Smith at jane@acme.com today.</w:t></w:r></w:p>
    <w:p>
      <w:r><w:t>Deleted below stays in the file:</w:t></w:r>
      <w:del w:id="1" w:author="Alice Reviewer" w:date="2024-01-01T00:00:00Z">
        <w:r><w:delText>secret SSN 123-45-6789</w:delText></w:r>
      </w:del>
      <w:ins w:id="2" w:author="Alice Reviewer" w:date="2024-01-01T00:00:00Z">
        <w:r><w:t>inserted text</w:t></w:r>
      </w:ins>
    </w:p>
    <w:p>
      <w:r><w:fldChar w:fldCharType="begin"/></w:r>
      <w:r><w:instrText> HYPERLINK "mailto:jane@acme.com" </w:instrText></w:r>
      <w:r><w:fldChar w:fldCharType="end"/></w:r>
      <w:r><w:t>write to us</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>Outer OUTERNAME text</w:t></w:r>
      <w:r><w:pict><v:shape><v:textbox><w:txbxContent>
        <w:p><w:r><w:t>Box BOXNAME inside</w:t></w:r></w:p>
      </w:txbxContent></v:textbox></v:shape></w:pict></w:r>
    </w:p>
  </w:body>
</w:document>`;
}

function footnotesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes xmlns:w="${W}">
  <w:footnote w:id="1">
    <w:p><w:r><w:t>Case handled by Maria Kowalska.</w:t></w:r></w:p>
  </w:footnote>
</w:footnotes>`;
}

function commentsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments xmlns:w="${W}">
  <w:comment w:id="1" w:author="Bob Commenter" w:initials="BC">
    <w:p><w:r><w:t>Check with Maria Kowalska first.</w:t></w:r></w:p>
  </w:comment>
</w:comments>`;
}

function buildDocx(): JSZip {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="jpeg" ContentType="image/jpeg"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/docProps/thumbnail.jpeg" ContentType="image/jpeg"/>
</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL}">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail" Target="docProps/thumbnail.jpeg"/>
</Relationships>`);
  zip.file('word/document.xml', documentXml());
  zip.file('word/footnotes.xml', footnotesXml());
  zip.file('word/comments.xml', commentsXml());
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL}">
  <Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="mailto:jane@acme.com" TargetMode="External"/>
  <Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://crm.example/Jan%20Kowalski" TargetMode="External"/>
  <Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="file:///C:/Users/realuser/Templates/secret.dotm" TargetMode="External"/>
</Relationships>`);
  zip.file('word/settings.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="${W}">
  <w:zoom w:percent="100"/>
  <w:mailMerge><w:dataSource w:name="C:\\clients\\list.xlsx"/></w:mailMerge>
  <w:rsids><w:rsid w:val="00AB12CD"/></w:rsids>
</w:settings>`);
  zip.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:title>Acme vs Smith settlement</dc:title>
  <dc:creator>Real Author</dc:creator>
  <cp:lastModifiedBy>Another Person</cp:lastModifiedBy>
</cp:coreProperties>`);
  zip.file('docProps/app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
  <Company>Acme Legal LLP</Company>
  <Application>MSWord</Application>
</Properties>`);
  zip.file('docProps/thumbnail.jpeg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
  return zip;
}

async function zipToFile(zip: JSZip): Promise<File> {
  const ab = await zip.generateAsync({ type: 'arraybuffer' });
  const file = new File([ab], 'test.docx');
  // jsdom's File lacks arrayBuffer(); polyfill it for the code under test
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

describe('readDocx', () => {
  it('extracts text from footnotes, comments, tracked deletions and field instructions', async () => {
    const extraction = await readDocx(await zipToFile(buildDocx()));
    expect(extraction.plainText).toContain('John Smith');
    expect(extraction.plainText).toContain('secret SSN 123-45-6789'); // w:delText
    expect(extraction.plainText).toContain('mailto:jane@acme.com'); // w:instrText
    expect(extraction.plainText).toContain('Case handled by Maria Kowalska.'); // footnote
    expect(extraction.plainText).toContain('Check with Maria Kowalska first.'); // comment
  });

  it('maps text inside text boxes exactly once', async () => {
    const extraction = await readDocx(await zipToFile(buildDocx()));
    expect(findAll(extraction.plainText, 'BOXNAME')).toHaveLength(1);
    const covering = extraction.textNodes.filter((n) => {
      const { start } = findAll(extraction.plainText, 'BOXNAME')[0];
      return n.flatStart <= start && n.flatEnd > start;
    });
    expect(covering).toHaveLength(1);
  });

  it('produces identical extractions across repeated reads', async () => {
    const file = await zipToFile(buildDocx());
    const a = await readDocx(file);
    const b = await readDocx(file);
    expect(a.plainText).toBe(b.plainText);
  });
});

describe('writeAnonymizedDocx', () => {
  async function redactAll(testName: string): Promise<Map<string, string>> {
    const extraction = await readDocx(await zipToFile(buildDocx()));
    const targets = ['John Smith', 'jane@acme.com', '123-45-6789', 'Maria Kowalska', 'BOXNAME'];
    const replacements: Array<{ start: number; end: number; replacement: string }> = [];
    const valueReplacements: Array<{ value: string; replacement: string }> = [];
    targets.forEach((value, i) => {
      const placeholder = `<<REDACTED_${i + 1}>>`;
      valueReplacements.push({ value, replacement: placeholder });
      for (const range of findAll(extraction.plainText, value)) {
        replacements.push({ ...range, replacement: placeholder });
      }
    });
    const blob = await writeAnonymizedDocx(extraction, replacements, valueReplacements);
    await assertNoTrace(blob, targets);
    await writeOutput(`${testName}.docx`, blob);
    const outZip = await JSZip.loadAsync(await blobToArrayBuffer(blob));
    const contents = new Map<string, string>();
    for (const path of Object.keys(outZip.files)) {
      const f = outZip.file(path);
      if (f && !path.endsWith('/')) {
        contents.set(path, await f.async('string'));
      }
    }
    return contents;
  }

  it('redacts body text, tracked deletions, footnotes and comments', async () => {
    const out = await redactAll('docx-redacts-body-deletions-footnotes-comments');
    const doc = out.get('word/document.xml')!;
    expect(doc).not.toContain('John Smith');
    expect(doc).not.toContain('123-45-6789');
    expect(doc).not.toContain('jane@acme.com');
    expect(out.get('word/footnotes.xml')!).not.toContain('Maria Kowalska');
    expect(out.get('word/comments.xml')!).not.toContain('Maria Kowalska');
    expect(doc).toContain('&lt;&lt;REDACTED_1&gt;&gt;');
  });

  it('does not corrupt text-box content via double replacement', async () => {
    const out = await redactAll('docx-textbox-no-double-replacement');
    const doc = out.get('word/document.xml')!;
    expect(doc).not.toContain('BOXNAME');
    expect(findAll(doc, 'REDACTED_5')).toHaveLength(1);
    expect(doc).toContain('Outer OUTERNAME text');
  });

  it('scrubs revision and comment author identities', async () => {
    const out = await redactAll('docx-scrubs-author-identities');
    expect(out.get('word/document.xml')!).not.toContain('Alice Reviewer');
    expect(out.get('word/comments.xml')!).not.toContain('Bob Commenter');
    expect(out.get('word/comments.xml')!).not.toContain('"BC"');
  });

  it('scrubs document properties', async () => {
    const out = await redactAll('docx-scrubs-document-properties');
    const core = out.get('docProps/core.xml')!;
    expect(core).not.toContain('Real Author');
    expect(core).not.toContain('Another Person');
    expect(core).not.toContain('Acme vs Smith');
    const app = out.get('docProps/app.xml')!;
    expect(app).not.toContain('Acme Legal LLP');
    expect(app).toContain('MSWord'); // application name is kept
  });

  it('scrubs hyperlink targets and removes the attached template relationship', async () => {
    const out = await redactAll('docx-scrubs-hyperlink-targets');
    const rels = out.get('word/_rels/document.xml.rels')!;
    expect(rels).not.toContain('jane@acme.com');
    expect(rels).toContain(`Target="${MAILTO_REDACTED_TARGET}"`); // always-scrub (T174)
    expect(rels).not.toContain('attachedTemplate');
    expect(rels).not.toContain('realuser');
  });

  it('scrubs a full name from an encoded hyperlink target even when its variant is listed first', async () => {
    const extraction = await readDocx(await zipToFile(buildDocx()));
    // Mirrors the web app: value pairs arrive in detection order, so the
    // shorter variant can precede the full name it is part of.
    const valueReplacements = [
      { value: 'Kowalski', replacement: '[PERSON_1_LAST]' },
      { value: 'Jan Kowalski', replacement: '[PERSON_1]' },
    ];
    const blob = await writeAnonymizedDocx(extraction, [], valueReplacements);
    await assertNoTrace(blob, ['Jan Kowalski', 'Jan%20Kowalski', 'Kowalski']);
    await writeOutput('docx-encoded-hyperlink-target.docx', blob);
    const outZip = await JSZip.loadAsync(await blobToArrayBuffer(blob));
    const rels = await outZip.file('word/_rels/document.xml.rels')!.async('string');
    expect(rels).not.toContain('Jan');
    expect(rels).not.toMatch(/Kowalski/i);
    expect(rels).toContain('https://crm.example/%5BPERSON_1%5D');
  });

  it('removes mail merge sources, rsids and the thumbnail', async () => {
    const out = await redactAll('docx-removes-mailmerge-rsids-thumbnail');
    const settings = out.get('word/settings.xml')!;
    expect(settings).not.toContain('mailMerge');
    expect(settings).not.toContain('rsid');
    expect(out.has('docProps/thumbnail.jpeg')).toBe(false);
    expect(out.get('_rels/.rels')!).not.toContain('thumbnail');
    expect(out.get('[Content_Types].xml')!).not.toContain('thumbnail');
  });
});

describe('normalizeReplacements', () => {
  it('clamps overlapping ranges so they never double-apply', () => {
    const result = normalizeReplacements([
      { start: 10, end: 20, replacement: 'B' },
      { start: 5, end: 15, replacement: 'A' },
    ]);
    expect(result).toEqual([
      { start: 5, end: 15, replacement: 'A' },
      { start: 15, end: 20, replacement: 'B' },
    ]);
  });

  it('drops ranges fully covered by an earlier one', () => {
    const result = normalizeReplacements([
      { start: 0, end: 30, replacement: 'A' },
      { start: 5, end: 15, replacement: 'B' },
    ]);
    expect(result).toEqual([{ start: 0, end: 30, replacement: 'A' }]);
  });
});

// ---------------------------------------------------------------------------
// T172: namespaces, fail-closed reading, new text elements, separators,
// text boxes and the package-wide value scrub (layer zero).
// ---------------------------------------------------------------------------

const W_STRICT = 'http://purl.oclc.org/ooxml/wordprocessingml/main';
const M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const WPS = 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape';
const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL}">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

/** Minimal package: content types, root rels and the given main document. */
function minimalDocx(documentXmlStr: string, extraParts: Record<string, string> = {}): JSZip {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file('_rels/.rels', ROOT_RELS);
  zip.file('word/document.xml', documentXmlStr);
  for (const [path, content] of Object.entries(extraParts)) zip.file(path, content);
  return zip;
}

/**
 * Redact `targets` (offset replacements found in the flat text, placeholder
 * from valueReplacements) and read every part back. The output is checked
 * with assertNoTrace for `originals` (defaults to the targets; pass an
 * explicit list when a value is intentionally left in place) and written for
 * the LibreOffice job under `testName`.
 */
async function writeAndReadBack(
  testName: string,
  zip: JSZip,
  valueReplacements: Array<{ value: string; replacement: string }>,
  targets: string[] = [],
  originals: string[] = targets,
): Promise<Map<string, string>> {
  const extraction = await readDocx(await zipToFile(zip));
  const replacements: Array<{ start: number; end: number; replacement: string }> = [];
  for (const value of targets) {
    const pair = valueReplacements.find((v) => v.value === value);
    const placeholder = pair ? pair.replacement : `<<${value}>>`;
    for (const range of findAll(extraction.plainText, value)) {
      replacements.push({ ...range, replacement: placeholder });
    }
  }
  const blob = await writeAnonymizedDocx(extraction, replacements, valueReplacements);
  await assertNoTrace(blob, originals);
  await writeOutput(`${testName}.docx`, blob);
  const outZip = await JSZip.loadAsync(await blobToArrayBuffer(blob));
  const contents = new Map<string, string>();
  for (const path of Object.keys(outZip.files)) {
    const f = outZip.file(path);
    if (f && !path.endsWith('/')) contents.set(path, await f.async('string'));
  }
  return contents;
}

function assertWellFormed(contents: Map<string, string>): void {
  const parser = new DOMParser();
  for (const [path, content] of contents) {
    if (!/\.(xml|rels|vml)$/i.test(path)) continue;
    const parsed = parser.parseFromString(content, 'application/xml');
    expect(parsed.getElementsByTagName('parsererror').length, `malformed: ${path}`).toBe(0);
  }
}

describe('readDocx namespaces and fail-closed reading (T172, H1)', () => {
  it('extracts and redacts a Strict OOXML document (purl.oclc.org namespace)', async () => {
    const zip = minimalDocx(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W_STRICT}">
  <w:body>
    <w:p><w:r><w:t>Strict mode contact: strict@acme.com</w:t></w:r></w:p>
  </w:body>
</w:document>`);
    const extraction = await readDocx(await zipToFile(zip));
    expect(extraction.plainText).toContain('strict@acme.com');
    expect(extraction.empty).toBe(false);

    const out = await writeAndReadBack(
      'docx-strict-namespace',
      minimalDocx(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W_STRICT}">
  <w:body>
    <w:p><w:r><w:t>Strict mode contact: strict@acme.com</w:t></w:r></w:p>
  </w:body>
</w:document>`),
      [{ value: 'strict@acme.com', replacement: '[EMAIL_1]' }],
      ['strict@acme.com'],
    );
    expect(out.get('word/document.xml')!).not.toContain('strict@acme.com');
    expect(out.get('word/document.xml')!).toContain('[EMAIL_1]');
  });

  it('refuses a main part whose body lives in an unrecognized namespace instead of copying it', async () => {
    const zip = minimalDocx(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<x:document xmlns:x="urn:vendor:future-wordprocessing">
  <x:body>
    <x:p><x:r><x:t>Unknown dialect contact: hidden@acme.com</x:t></x:r></x:p>
  </x:body>
</x:document>`);
    let caught: unknown;
    try {
      await readDocx(await zipToFile(zip));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnsupportedDocumentError);
    expect((caught as UnsupportedDocumentError).code).toBe('unrecognized-namespace');
    expect((caught as UnsupportedDocumentError).details.join(' ')).toContain('urn:vendor:future-wordprocessing');
  });

  it('refuses a known body whose paragraphs are all in a foreign namespace', async () => {
    const zip = minimalDocx(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}" xmlns:x="urn:vendor:paragraphs">
  <w:body>
    <x:p><x:r><x:t>hidden@acme.com</x:t></x:r></x:p>
  </w:body>
</w:document>`);
    await expect(readDocx(await zipToFile(zip))).rejects.toMatchObject({ code: 'unrecognized-namespace' });
  });

  it('flags a document with no paragraphs as empty instead of refusing it', async () => {
    const zip = minimalDocx(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}"><w:body><w:sectPr/></w:body></w:document>`);
    const extraction = await readDocx(await zipToFile(zip));
    expect(extraction.empty).toBe(true);
    expect(extraction.plainText).toBe('');
    expect(extraction.unredactable).toEqual([]);
  });
});

describe('readDocx text elements and separators (T172, M2, M3)', () => {
  it('extracts w:delInstrText and OMML m:t so they can be redacted', async () => {
    const zip = minimalDocx(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}" xmlns:m="${M}">
  <w:body>
    <w:p>
      <w:del w:id="1" w:author="X" w:date="2024-01-01T00:00:00Z">
        <w:r><w:delInstrText> HYPERLINK "mailto:deleted@acme.com" </w:delInstrText></w:r>
      </w:del>
    </w:p>
    <w:p><m:oMath><m:r><m:t>Formula by Maria Kowalska</m:t></m:r></m:oMath></w:p>
  </w:body>
</w:document>`);
    const extraction = await readDocx(await zipToFile(zip));
    expect(extraction.plainText).toContain('deleted@acme.com');
    expect(extraction.plainText).toContain('Maria Kowalska');

    const out = await writeAndReadBack(
      'docx-delinstrtext-omml',
      minimalDocx(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}" xmlns:m="${M}">
  <w:body>
    <w:p>
      <w:del w:id="1" w:author="X" w:date="2024-01-01T00:00:00Z">
        <w:r><w:delInstrText> HYPERLINK "mailto:deleted@acme.com" </w:delInstrText></w:r>
      </w:del>
    </w:p>
    <w:p><m:oMath><m:r><m:t>Formula by Maria Kowalska</m:t></m:r></m:oMath></w:p>
  </w:body>
</w:document>`),
      [
        { value: 'deleted@acme.com', replacement: '[EMAIL_1]' },
        { value: 'Maria Kowalska', replacement: '[PERSON_1]' },
      ],
      ['deleted@acme.com', 'Maria Kowalska'],
    );
    const doc = out.get('word/document.xml')!;
    expect(doc).not.toContain('deleted@acme.com');
    expect(doc).not.toContain('Maria Kowalska');
    expect(doc).toContain('Formula by [PERSON_1]</m:t>');
  });

  it('emits tab, break and hyphen separators as characters and redacts across them', async () => {
    const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}">
  <w:body>
    <w:p>
      <w:r><w:t>Phone:</w:t><w:tab/><w:t>555</w:t><w:noBreakHyphen/><w:t>0199</w:t></w:r>
      <w:r><w:br/><w:t>Line two</w:t><w:cr/><w:t>Line three</w:t><w:softHyphen/><w:t>end</w:t></w:r>
    </w:p>
  </w:body>
</w:document>`;
    const extraction = await readDocx(await zipToFile(minimalDocx(docXml)));
    expect(extraction.plainText).toBe('Phone:\t555-0199\nLine two\nLine three­end');
    // Separators are zero-width: they occupy a flat character but map to no element.
    const tabIdx = extraction.plainText.indexOf('\t');
    expect(extraction.textNodes.some((n) => n.flatStart <= tabIdx && n.flatEnd > tabIdx)).toBe(false);

    const out = await writeAndReadBack(
      'docx-separators',
      minimalDocx(docXml),
      [{ value: '555-0199', replacement: '[PHONE_1]' }],
      ['555-0199'],
      ['555-0199', '555', '0199'],
    );
    const doc = out.get('word/document.xml')!;
    expect(doc).not.toContain('555');
    expect(doc).not.toContain('0199');
    expect(doc).toContain('[PHONE_1]');
    expect(doc).toContain('Line two');
    expect(doc).toContain('Line three');
    assertWellFormed(out);
  });

  it('never lets a replacement cross a paragraph break (entity containing a newline is split)', async () => {
    const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}">
  <w:body>
    <w:p><w:r><w:t>Dear John</w:t></w:r></w:p>
    <w:p><w:r><w:t>Smith, regards</w:t></w:r></w:p>
  </w:body>
</w:document>`;
    const extraction = await readDocx(await zipToFile(minimalDocx(docXml)));
    const start = extraction.plainText.indexOf('John');
    const end = extraction.plainText.indexOf('Smith') + 'Smith'.length;
    expect(extraction.plainText.slice(start, end)).toBe('John\nSmith');
    const blob = await writeAnonymizedDocx(extraction, [{ start, end, replacement: '[PERSON_1]' }]);
    await assertNoTrace(blob, ['John', 'Smith']);
    await writeOutput('docx-no-cross-paragraph.docx', blob);
    const outZip = await JSZip.loadAsync(await blobToArrayBuffer(blob));
    const doc = await outZip.file('word/document.xml')!.async('string');
    expect(doc).toContain('>Dear [PERSON_1]</w:t>'); // first paragraph: placeholder only
    expect(doc).not.toContain('Smith');
    expect(doc).toContain('>, regards</w:t>'); // second paragraph keeps its own tail, nothing moved
    // Paragraph structure intact: two paragraphs, text not moved between them
    expect(findAll(doc, '<w:p>')).toHaveLength(2);
  });
});

describe('readDocx text boxes (T172, M3)', () => {
  const textboxDoc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}" xmlns:mc="${MC}" xmlns:wp="${WP}" xmlns:a="${A}" xmlns:wps="${WPS}" xmlns:v="${V}">
  <w:body>
    <w:p>
      <w:r><w:t>Dear John</w:t></w:r>
      <w:r><mc:AlternateContent>
        <mc:Choice Requires="wps"><w:drawing><wp:inline><a:graphic><a:graphicData><wps:wsp><wps:txbx>
          <w:txbxContent><w:p><w:r><w:t>Smith, ref alpha@secret.example</w:t></w:r></w:p></w:txbxContent>
        </wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:inline></w:drawing></mc:Choice>
        <mc:Fallback><w:pict><v:shape><v:textbox>
          <w:txbxContent><w:p><w:r><w:t>Smith, ref alpha@secret.example</w:t></w:r></w:p></w:txbxContent>
        </v:textbox></v:shape></w:pict></mc:Fallback>
      </mc:AlternateContent></w:r>
      <w:r><w:t>regards</w:t></w:r>
    </w:p>
  </w:body>
</w:document>`;

  it('separates text box content from the surrounding paragraph with newlines', async () => {
    const extraction = await readDocx(await zipToFile(minimalDocx(textboxDoc)));
    expect(extraction.plainText).not.toContain('JohnSmith');
    expect(extraction.plainText).not.toContain('exampleSmith');
    expect(extraction.plainText).not.toContain('exampleregards');
    expect(extraction.plainText).toMatch(/Dear John\nSmith, ref alpha@secret\.example\n/);
    // Both mc:Choice and mc:Fallback copies are extracted
    expect(findAll(extraction.plainText, 'alpha@secret.example')).toHaveLength(2);
  });

  it('redacts both the Choice and the Fallback copy and leaves body text in place', async () => {
    const out = await writeAndReadBack(
      'docx-textbox-choice-fallback',
      minimalDocx(textboxDoc),
      [{ value: 'alpha@secret.example', replacement: '[EMAIL_1]' }],
      ['alpha@secret.example'],
    );
    const doc = out.get('word/document.xml')!;
    expect(doc).not.toContain('alpha@secret.example');
    expect(findAll(doc, '[EMAIL_1]')).toHaveLength(2);
    expect(doc).toContain('<w:t>Dear John</w:t>');
    expect(doc).toContain('<w:t>regards</w:t>');
    assertWellFormed(out);
  });
});

describe('layer zero: package-wide value scrub (T172, H3)', () => {
  const NAME = 'Zbigniew Przykladowy';
  const EMAIL = 'zp@acme.com';

  function leakyDocx(): JSZip {
    return minimalDocx(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>Report for ${NAME}</w:t></w:r></w:p></w:body></w:document>`, {
      'word/charts/chart1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="${C}" xmlns:a="${A}"><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>Sales of ${NAME}</a:t></a:r></a:p></c:rich></c:tx></c:title>
<c:plotArea><c:barChart><c:ser><c:cat><c:strRef><c:f>Sheet1!$A$2</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${EMAIL}</c:v></c:pt></c:strCache></c:strRef></c:cat></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>`,
      'customXml/item1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<CoverPageProperties xmlns="http://schemas.microsoft.com/office/2006/coverPageProps"><Abstract>Prepared by ${NAME}</Abstract><CompanyEmail>${EMAIL}</CompanyEmail></CoverPageProperties>`,
      'word/settings.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="${W}"><w:zoom w:percent="100"/><w:docVars><w:docVar w:name="Owner" w:val="${NAME}"/></w:docVars></w:settings>`,
      'word/numbering.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="${NAME} %1."/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum></w:numbering>`,
      'word/vmlDrawing1.vml': `<xml xmlns:v="${V}" xmlns:o="urn:schemas-microsoft-com:office:office"><v:shape id="_x0000_s1025" alt="Photo of ${NAME}" style="width:100pt;height:50pt"><v:textbox><div>${EMAIL}</div></v:textbox></v:shape></xml>`,
      'word/webSettings.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:webSettings xmlns:w="${W}"><w:frameset><w:frame><w:name w:val="${NAME}"/><w:sourceFileName r:id="rId9" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></w:frame></w:frameset></w:webSettings>`,
      'word/_rels/document.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL}">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="charts/chart1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="mailto:${EMAIL}" TargetMode="External"/>
</Relationships>`,
    });
  }

  it('scrubs known values from chart caches, customXml, docVars, lvlText, vml and webSettings', async () => {
    const out = await writeAndReadBack(
      'docx-layer-zero',
      leakyDocx(),
      [
        { value: NAME, replacement: '[PERSON_1]' },
        { value: EMAIL, replacement: '[EMAIL_1]' },
      ],
      [NAME],
      [NAME, EMAIL],
    );
    for (const path of [
      'word/charts/chart1.xml', 'customXml/item1.xml', 'word/settings.xml',
      'word/numbering.xml', 'word/vmlDrawing1.vml', 'word/webSettings.xml',
      'word/_rels/document.xml.rels', 'word/document.xml',
    ]) {
      const content = out.get(path)!;
      expect(content, path).not.toContain(NAME);
      expect(content, path).not.toContain(EMAIL);
    }
    expect(out.get('word/charts/chart1.xml')!).toContain('<c:v>[EMAIL_1]</c:v>');
    // docVars are removed as a whole since T174 (always-scrub), not placeholdered
    expect(out.get('word/settings.xml')!).not.toContain('docVars');
    expect(out.get('word/settings.xml')!).toContain('<w:zoom');
    expect(out.get('word/numbering.xml')!).toContain('w:val="[PERSON_1] %1."');
    assertWellFormed(out);
  });

  it('negative: an entity value equal to "document" leaves the package structure intact', async () => {
    const out = await writeAndReadBack('docx-negative-document', leakyDocx(), [{ value: 'document', replacement: '[X]' }], [], []);
    expect(out.has('word/document.xml')).toBe(true);
    expect(out.get('[Content_Types].xml')!).toContain('wordprocessingml.document.main+xml');
    expect(out.get('[Content_Types].xml')!).toContain('/word/document.xml');
    const rootRels = out.get('_rels/.rels')!;
    expect(rootRels).toContain('Target="word/document.xml"');
    expect(rootRels).toContain('relationships/officeDocument');
    expect(out.get('word/document.xml')!).toContain('<w:document');
    expect(out.get('word/document.xml')!).toContain('</w:document>');
    assertWellFormed(out);
  });

  it('safety rule: short numeric values never touch attributes, long ones only at word boundaries', async () => {
    const zip = minimalDocx(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>Year 2024, EMU 5943600, id 123456789.</w:t></w:r></w:p></w:body></w:document>`, {
      'word/theme/themeOverride1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<root xmlns:wp="${WP}" xmlns:a="${A}" xmlns:w="${W}" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">
  <wp:extent cx="5943600" cy="2024"/>
  <a:off x="2024" y="5943600"/>
  <w:tblW w:w="5943600" w:type="dxa"/>
  <w:p w14:paraId="123456789" w:rsidR="123456789"/>
  <w:tag w:val="ref 123456789 end"/>
  <w:tag w:val="ref 1234567890 end"/>
  <w:docVar w:name="Year" w:val="2024"/>
  <text>2024 and 5943600 and 123456789</text>
</root>`,
    });
    // Layout attributes keep the numbers on purpose, so no assertNoTrace needles here.
    const out = await writeAndReadBack('docx-attribute-safety-rule', zip, [
      { value: '2024', replacement: '[DATE_1]' },
      { value: '5943600', replacement: '[NUM_1]' },
      { value: '123456789', replacement: '[ID_1]' },
    ], [], []);
    const part = out.get('word/theme/themeOverride1.xml')!;
    expect(part).toContain('cx="5943600" cy="2024"');
    expect(part).toContain('x="2024" y="5943600"');
    expect(part).toContain('w:w="5943600"');
    expect(part).toContain('w14:paraId="123456789"');
    expect(part).toContain('w:rsidR="123456789"');
    expect(part).toContain('w:val="2024"');
    expect(part).toContain('w:val="ref [ID_1] end"');
    expect(part).toContain('w:val="ref 1234567890 end"');
    // Text nodes get every value
    expect(part).toContain('<text>[DATE_1] and [NUM_1] and [ID_1]</text>');
    assertWellFormed(out);
  });

  it('reports parts it could not parse in warnings and leaves them untouched', async () => {
    const zip = minimalDocx(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>hi</w:t></w:r></w:p></w:body></w:document>`, {
      'customXml/item2.xml': '<broken><unclosed>',
    });
    const extraction = await readDocx(await zipToFile(zip));
    const result = await writeAnonymizedDocxWithReport(extraction, [], [{ value: 'hi', replacement: '[X]' }]);
    expect(result.blob).toBeInstanceOf(Blob);
    await writeOutput('docx-unparsable-part-warning.docx', result.blob);
    expect(result.warnings.some((w) => w.includes('customXml/item2.xml'))).toBe(true);
    const outZip = await JSZip.loadAsync(await blobToArrayBuffer(result.blob));
    expect(await outZip.file('customXml/item2.xml')!.async('string')).toBe('<broken><unclosed>');
  });
});

// ---------------------------------------------------------------------------
// T174 (M1): attribute text units reach the detector, bookmarks are renamed
// with their references, and the always-scrub group needs no detection.
// ---------------------------------------------------------------------------

async function bytesToFile(bytes: Uint8Array, name: string): Promise<File> {
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const file = new File([ab], name);
  if (typeof file.arrayBuffer !== 'function') {
    Object.defineProperty(file, 'arrayBuffer', { value: async () => ab });
  }
  return file;
}

async function partsOf(blob: Blob): Promise<Map<string, string>> {
  const outZip = await JSZip.loadAsync(await blobToArrayBuffer(blob));
  const contents = new Map<string, string>();
  for (const path of Object.keys(outZip.files)) {
    const f = outZip.file(path);
    if (f && !path.endsWith('/')) contents.set(path, await f.async('string'));
  }
  return contents;
}

/** Offset replacements for every occurrence of each value in the flat text. */
function offsetsFor(
  plainText: string,
  pairs: Array<{ value: string; replacement: string }>,
): Array<{ start: number; end: number; replacement: string }> {
  const replacements: Array<{ start: number; end: number; replacement: string }> = [];
  for (const pair of pairs) {
    for (const range of findAll(plainText, pair.value)) replacements.push({ ...range, replacement: pair.replacement });
  }
  return replacements;
}

describe('fieldInstructionArguments (T174)', () => {
  it('yields quoted and bare arguments with offsets, never the keyword or a switch', () => {
    const instr = ' HYPERLINK "mailto:a@b.example" \\o "Mail us" \\l Anchor1 ';
    const args = fieldInstructionArguments(instr);
    expect(args.map((a) => a.text)).toEqual(['mailto:a@b.example', 'Mail us', 'Anchor1']);
    for (const arg of args) expect(instr.slice(arg.offset, arg.offset + arg.text.length)).toBe(arg.text);
    expect(fieldInstructionArguments(' REF Bookmark1 \\h ').map((a) => a.text)).toEqual(['Bookmark1']);
    expect(fieldInstructionArguments(' PAGE \\* MERGEFORMAT ').map((a) => a.text)).toEqual(['MERGEFORMAT']);
    expect(fieldInstructionArguments('HYPERLINK').map((a) => a.text)).toEqual([]);
    expect(fieldInstructionArguments('').map((a) => a.text)).toEqual([]);
  });

  it('keeps an escaped quote inside a quoted argument', () => {
    const args = fieldInstructionArguments(' QUOTE "say \\"hi\\" now" ');
    expect(args.map((a) => a.text)).toEqual(['say \\"hi\\" now']);
  });
});

describe('bookmarkIdentifier (T174)', () => {
  it('strips placeholder brackets, prefixes non-letter starts and avoids collisions', () => {
    expect(bookmarkIdentifier('[PERSON_1]')).toBe('PERSON_1');
    expect(bookmarkIdentifier('1234')).toBe('bm_1234');
    expect(bookmarkIdentifier('_hidden')).toBe('bm__hidden');
    expect(bookmarkIdentifier('Anna Nowak-Kowalska')).toBe('AnnaNowakKowalska');
    expect(bookmarkIdentifier('***')).toBe('bm');
    const used = new Set(['PERSON_1']);
    expect(bookmarkIdentifier('[PERSON_1]', used)).toBe('PERSON_1_2');
    expect(bookmarkIdentifier('[PERSON_1]', used)).toBe('PERSON_1_3');
    expect(bookmarkIdentifier('x'.repeat(60)).length).toBe(40);
  });
});

describe('attribute text units (T174, M1)', () => {
  const DETECTED = [
    { value: DOCX_SEED.body, replacement: '[EMAIL_1]' },
    { value: DOCX_SEED.fldSimpleInstr, replacement: '[EMAIL_2]' },
    { value: DOCX_SEED.sdtAlias, replacement: '[ORG_1]' },
    { value: DOCX_SEED.docPrDescr, replacement: '[EMAIL_3]' },
    { value: DOCX_SEED.bookmarkName, replacement: '[PERSON_1]' },
    { value: DOCX_SEED.numbering, replacement: '[EMAIL_4]' },
  ];
  const ALWAYS_SCRUBBED = [
    DOCX_SEED.hyperlinkTooltip,
    DOCX_SEED.hyperlinkTarget,
    DOCX_SEED.sdtTag,
    DOCX_SEED.docVar,
  ];

  async function attributesFixture(): Promise<File> {
    return bytesToFile(await buildDocxFixture({ attributes: true, numbering: true, docVars: true }), 'attributes.docx');
  }

  it('appends one unit per attribute value after the body text, each on its own line', async () => {
    const extraction = await readDocx(await attributesFixture());
    const lines = extraction.plainText.split('\n');
    expect(lines[0]).toBe(`Mail ${DOCX_SEED.body} now.`);
    // Detection units: field argument (not the keyword), alias, bookmark, alt text, level text
    expect(lines).toContain(`mailto:${DOCX_SEED.fldSimpleInstr}`);
    expect(lines).toContain(DOCX_SEED.sdtAlias);
    expect(lines).toContain(DOCX_SEED.bookmarkName);
    expect(lines).toContain(DOCX_SEED.docPrDescr);
    expect(lines).toContain(`${DOCX_SEED.numbering} %1.`);
    expect(extraction.plainText).not.toContain('HYPERLINK');
    // Always-scrub values are not detection units
    expect(extraction.plainText).not.toContain(DOCX_SEED.hyperlinkTooltip);
    expect(extraction.plainText).not.toContain(DOCX_SEED.sdtTag);
    expect(extraction.plainText).not.toContain(DOCX_SEED.docVar);
    // Every unit is mapped to an attribute, with the mapped slice equal to the unit text
    const attrUnits = extraction.textNodes.filter((n) => n.attr);
    expect(attrUnits.length).toBe(5);
    for (const unit of attrUnits) {
      const flat = extraction.plainText.slice(unit.flatStart, unit.flatEnd);
      const offset = unit.attrOffset ?? 0;
      expect(unit.attr!.value.slice(offset, offset + flat.length)).toBe(flat);
    }
    // numbering.xml is a content part now
    expect(extraction.contentParts.map((p) => p.path)).toContain('word/numbering.xml');
  });

  it('records every unmapped newline as a paragraph break (T172 rule)', async () => {
    const extraction = await readDocx(await attributesFixture());
    const breaks = new Set(extraction.paragraphBreaks.map((pb) => pb.flatIndex));
    for (let i = 0; i < extraction.plainText.length; i++) {
      if (extraction.plainText[i] !== '\n') continue;
      const mapped = extraction.textNodes.some((n) => n.flatStart <= i && n.flatEnd > i);
      if (!mapped) expect(breaks.has(i), `newline at ${i} is not a paragraph break`).toBe(true);
    }
    for (const b of breaks) expect(extraction.plainText[b]).toBe('\n');
    expect(breaks.size).toBeGreaterThanOrEqual(5);
  });

  it('is deterministic: two reads give identical plainText and paragraphBreaks', async () => {
    const file = await attributesFixture();
    const a = await readDocx(file);
    const b = await readDocx(file);
    expect(a.plainText).toBe(b.plainText);
    expect(a.paragraphBreaks).toEqual(b.paragraphBreaks);
    expect(a.textNodes.map((n) => [n.flatStart, n.flatEnd, n.attrOffset ?? -1]))
      .toEqual(b.textNodes.map((n) => [n.flatStart, n.flatEnd, n.attrOffset ?? -1]));
  });

  it('redacts detected attribute values and always-scrubs the rest: no seed survives', async () => {
    const extraction = await readDocx(await attributesFixture());
    const replacements = offsetsFor(extraction.plainText, DETECTED);
    expect(replacements.length).toBe(DETECTED.length);
    const blob = await writeAnonymizedDocx(extraction, replacements, DETECTED);
    await assertNoTrace(blob, [...DETECTED.map((d) => d.value), ...ALWAYS_SCRUBBED]);
    await writeOutput('docx-attributes-detected.docx', blob);

    const out = await partsOf(blob);
    const doc = out.get('word/document.xml')!;
    expect(doc).toContain('w:instr=" HYPERLINK &quot;mailto:[EMAIL_2]&quot; "'); // keyword intact
    expect(doc).toContain('w:alias w:val="[ORG_1]"');
    expect(doc).toContain('w:bookmarkStart w:id="1" w:name="PERSON_1"'); // valid identifier
    expect(doc).toContain('w:bookmarkEnd w:id="1"');
    expect(doc).not.toContain('w:tooltip');
    expect(doc).not.toContain('<w:tag');
    expect(out.get('word/numbering.xml')!).toContain('w:lvlText w:val="[EMAIL_4] %1."');
    expect(out.get('word/settings.xml')!).not.toContain('docVars');
    expect(out.get('word/_rels/document.xml.rels')!).toContain(`Target="${MAILTO_REDACTED_TARGET}"`);
    assertWellFormed(out);
  });

  it('always-scrub needs no entities: tooltip, mailto target, tag and docVars vanish on an empty replacement list', async () => {
    const extraction = await readDocx(await attributesFixture());
    const blob = await writeAnonymizedDocx(extraction, [], []);
    await assertNoTrace(blob, ALWAYS_SCRUBBED);
    await writeOutput('docx-attributes-always-scrub.docx', blob);
    const out = await partsOf(blob);
    const doc = out.get('word/document.xml')!;
    expect(doc).not.toContain('w:tooltip');
    expect(doc).not.toContain('<w:tag');
    expect(doc).toContain('<w:hyperlink r:id="rIdHyper">'); // hyperlink itself stays
    expect(doc).toContain(`w:alias w:val="${DOCX_SEED.sdtAlias}"`); // not detected, kept
    expect(doc).toContain(`w:name="${DOCX_SEED.bookmarkName}"`); // not detected, kept
    expect(out.get('word/_rels/document.xml.rels')!).toContain(`Target="${MAILTO_REDACTED_TARGET}"`);
    expect(out.get('word/_rels/document.xml.rels')!).toContain('TargetMode="External"');
    expect(out.get('word/settings.xml')!).not.toContain('docVar');
    assertWellFormed(out);
  });

  it('keeps a content control tag that has a data binding', async () => {
    const zip = minimalDocx(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}">
  <w:body>
    <w:p><w:sdt><w:sdtPr><w:alias w:val="Bound"/><w:tag w:val="BOUND_TAG"/><w:dataBinding w:xpath="/root/name" w:storeItemID="{1}"/></w:sdtPr><w:sdtContent><w:r><w:t>bound</w:t></w:r></w:sdtContent></w:sdt></w:p>
    <w:p><w:sdt><w:sdtPr><w:tag w:val="LOOSE_TAG"/></w:sdtPr><w:sdtContent><w:r><w:t>loose</w:t></w:r></w:sdtContent></w:sdt></w:p>
  </w:body>
</w:document>`);
    const out = await writeAndReadBack('docx-tag-databinding', zip, [], [], ['LOOSE_TAG']);
    const doc = out.get('word/document.xml')!;
    expect(doc).toContain('w:tag w:val="BOUND_TAG"');
    expect(doc).toContain('w:dataBinding');
    expect(doc).not.toContain('LOOSE_TAG');
    assertWellFormed(out);
  });

  it('never rewrites a field keyword, even when it is a known value', async () => {
    const zip = minimalDocx(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}">
  <w:body>
    <w:p><w:fldSimple w:instr=" HYPERLINK &quot;https://x.example/HYPERLINK&quot; "><w:r><w:t>go</w:t></w:r></w:fldSimple></w:p>
  </w:body>
</w:document>`);
    const out = await writeAndReadBack('docx-keyword-untouched', zip, [{ value: 'HYPERLINK', replacement: '[X]' }], [], []);
    expect(out.get('word/document.xml')!).toContain('w:instr=" HYPERLINK &quot;https://x.example/[X]&quot; "');
  });
});

describe('bookmark rename with reference update (T174)', () => {
  const NAME = 'LEAK_BOOKMARK_NAME';

  function bookmarkDocx(): JSZip {
    const zip = minimalDocx(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}">
  <w:body>
    <w:p><w:bookmarkStart w:id="7" w:name="${NAME}"/><w:r><w:t>target text</w:t></w:r><w:bookmarkEnd w:id="7"/></w:p>
    <w:p><w:bookmarkStart w:id="8" w:name="Untouched_Mark"/><w:r><w:t>other</w:t></w:r><w:bookmarkEnd w:id="8"/></w:p>
    <w:p><w:fldSimple w:instr=" REF ${NAME} \\h "><w:r><w:t>target text</w:t></w:r></w:fldSimple></w:p>
    <w:p>
      <w:r><w:fldChar w:fldCharType="begin"/></w:r>
      <w:r><w:instrText xml:space="preserve"> PAGEREF </w:instrText></w:r>
      <w:r><w:instrText xml:space="preserve">${NAME} \\h </w:instrText></w:r>
      <w:r><w:fldChar w:fldCharType="separate"/></w:r>
      <w:r><w:t>1</w:t></w:r>
      <w:r><w:fldChar w:fldCharType="end"/></w:r>
    </w:p>
    <w:p>
      <w:r><w:fldChar w:fldCharType="begin"/></w:r>
      <w:r><w:instrText xml:space="preserve"> HYPERLINK \\l "${NAME}" </w:instrText></w:r>
      <w:r><w:fldChar w:fldCharType="separate"/></w:r>
      <w:r><w:t>jump</w:t></w:r>
      <w:r><w:fldChar w:fldCharType="end"/></w:r>
    </w:p>
    <w:p><w:hyperlink w:anchor="${NAME}"><w:r><w:t>link</w:t></w:r></w:hyperlink></w:p>
    <w:p><w:hyperlink w:anchor="Untouched_Mark"><w:r><w:t>link2</w:t></w:r></w:hyperlink></w:p>
    <w:p><w:fldSimple w:instr=" REF Untouched_Mark \\h "><w:r><w:t>other</w:t></w:r></w:fldSimple></w:p>
  </w:body>
</w:document>`, {
      'word/header1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="${W}"><w:p><w:hyperlink w:anchor="${NAME}"><w:r><w:t>header link</w:t></w:r></w:hyperlink></w:p></w:hdr>`,
    });
    return zip;
  }

  it('renames a detected bookmark to a valid identifier and repoints every reference', async () => {
    const extraction = await readDocx(await zipToFile(bookmarkDocx()));
    expect(findAll(extraction.plainText, NAME).length).toBe(4); // bookmark, REF arg, PAGEREF text, HYPERLINK text
    const pairs = [{ value: NAME, replacement: '[PERSON_1]' }];
    const blob = await writeAnonymizedDocx(extraction, offsetsFor(extraction.plainText, pairs), pairs);
    await assertNoTrace(blob, [NAME, '[PERSON_1]']);
    await writeOutput('docx-bookmark-rename.docx', blob);

    const out = await partsOf(blob);
    const doc = out.get('word/document.xml')!;
    expect(doc).toContain('<w:bookmarkStart w:id="7" w:name="PERSON_1"/>');
    expect(doc).toContain('<w:bookmarkEnd w:id="7"/>'); // ids unchanged
    expect(doc).toContain('w:instr=" REF PERSON_1 \\h "');
    expect(doc).toContain('PAGEREF PERSON_1 \\h');
    expect(doc).toContain('HYPERLINK \\l "PERSON_1"'); // text node: quotes are literal
    expect(findAll(doc, 'w:anchor="PERSON_1"')).toHaveLength(1);
    expect(out.get('word/header1.xml')!).toContain('w:anchor="PERSON_1"');
    // Untouched bookmark and its references are left alone
    expect(doc).toContain('w:name="Untouched_Mark"');
    expect(findAll(doc, 'Untouched_Mark')).toHaveLength(3);
    assertWellFormed(out);
  });

  it('prefixes a replacement that starts with a digit and keeps the name unique', async () => {
    const zip = minimalDocx(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}">
  <w:body>
    <w:p><w:bookmarkStart w:id="1" w:name="${NAME}"/><w:r><w:t>a</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>
    <w:p><w:bookmarkStart w:id="2" w:name="bm_42"/><w:r><w:t>b</w:t></w:r><w:bookmarkEnd w:id="2"/></w:p>
    <w:p><w:hyperlink w:anchor="${NAME}"><w:r><w:t>link</w:t></w:r></w:hyperlink></w:p>
  </w:body>
</w:document>`);
    const out = await writeAndReadBack('docx-bookmark-digit-prefix', zip, [{ value: NAME, replacement: '42' }], [NAME]);
    const doc = out.get('word/document.xml')!;
    expect(doc).toContain('w:name="bm_42_2"'); // 'bm_42' already exists
    expect(doc).toContain('w:anchor="bm_42_2"');
    expect(doc).toContain('w:name="bm_42"');
  });

  it('renames a bookmark whose name holds a known value even without an offset replacement', async () => {
    const zip = minimalDocx(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}">
  <w:body>
    <w:p><w:bookmarkStart w:id="1" w:name="Kowalski_ref"/><w:r><w:t>a</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>
    <w:p><w:fldSimple w:instr=" REF Kowalski_ref "><w:r><w:t>a</w:t></w:r></w:fldSimple></w:p>
  </w:body>
</w:document>`);
    const out = await writeAndReadBack('docx-bookmark-value-rename', zip, [{ value: 'Kowalski', replacement: '[PERSON_1]' }], [], ['Kowalski']);
    const doc = out.get('word/document.xml')!;
    expect(doc).toContain('w:name="PERSON_1_ref"');
    expect(doc).toContain('w:instr=" REF PERSON_1_ref "');
  });
});

// ---------------------------------------------------------------------------
// T175 (H3): charts, SmartArt, custom XML, glossary subparts and the
// webSettings frameset are content parts; entities that appear only there
// are detected through plainText and redacted by offset, without relying on
// the layer-zero value scrub.
// ---------------------------------------------------------------------------

describe('drawing, custom XML and glossary content parts (T175, H3)', () => {
  const GLOSSARY_FOOTNOTE = 'glossaryfootnote@leak.example';
  const FRAME_NAME = 'framename@leak.example';
  const FRAME_TITLE = 'Frame of Zbigniew Przykladowy';

  /** Offsets only, empty value list: proves the units, not layer zero. */
  async function redactByOffsets(
    testName: string,
    file: File,
    targets: string[],
  ): Promise<{ parts: Map<string, string>; plainText: string }> {
    const extraction = await readDocx(file);
    for (const target of targets) expect(extraction.plainText, `${target} must be in plainText`).toContain(target);
    const replacements = targets.flatMap((value, i) =>
      findAll(extraction.plainText, value).map((range) => ({ ...range, replacement: `[UNIT_${i + 1}]` })));
    const blob = await writeAnonymizedDocx(extraction, replacements, []);
    await assertNoTrace(blob, targets);
    await writeOutput(`${testName}.docx`, blob);
    return { parts: await partsOf(blob), plainText: extraction.plainText };
  }

  it('chart title and category cache are units and are redacted by offset alone', async () => {
    const file = await bytesToFile(await buildDocxFixture({ chart: true }), 'chart.docx');
    const { parts, plainText } = await redactByOffsets('docx-t175-chart', file, [DOCX_SEED.chartTitle, DOCX_SEED.chartCategory]);
    // Each unit is its own line, never glued to the body or to each other.
    const lines = plainText.split('\n');
    expect(lines).toContain(DOCX_SEED.chartTitle);
    expect(lines).toContain(DOCX_SEED.chartCategory);
    const chart = parts.get('word/charts/chart1.xml')!;
    // Rewritten units carry xml:space="preserve" (setUnitText).
    expect(chart).toMatch(/<a:t[^>]*>\[UNIT_1\]<\/a:t>/);
    expect(chart).toMatch(/<c:v[^>]*>\[UNIT_2\]<\/c:v>/);
    // The numeric cache is untouched.
    expect(chart).toContain('<c:numCache><c:ptCount val="1"/><c:pt idx="0"><c:v>1</c:v></c:pt></c:numCache>');
    assertWellFormed(parts);
  });

  it('SmartArt node text is a unit', async () => {
    const file = await bytesToFile(await buildDocxFixture({ diagram: true }), 'diagram.docx');
    const { parts } = await redactByOffsets('docx-t175-diagram', file, [DOCX_SEED.diagram]);
    expect(parts.get('word/diagrams/data1.xml')!).toMatch(/<a:t[^>]*>\[UNIT_1\]<\/a:t>/);
    assertWellFormed(parts);
  });

  it('cover-page custom XML leaf text is a unit; itemProps stays untouched', async () => {
    const file = await bytesToFile(await buildDocxFixture({ customXml: true }), 'customxml.docx');
    const { parts } = await redactByOffsets('docx-t175-customxml', file, [DOCX_SEED.customXml]);
    expect(parts.get('customXml/item1.xml')!).toMatch(/<CompanyEmail[^>]*>\[UNIT_1\]<\/CompanyEmail>/);
    expect(parts.get('customXml/itemProps1.xml')!).toContain('ds:itemID="{11111111-2222-3333-4444-555555555555}"');
    assertWellFormed(parts);
  });

  it('glossary footnotes, headers and the frameset of webSettings are content parts', async () => {
    const zip = minimalDocx(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>Body only.</w:t></w:r></w:p></w:body></w:document>`, {
      'word/glossary/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:glossaryDocument xmlns:w="${W}"><w:docParts><w:docPart><w:docPartBody><w:p><w:r><w:t>Building block body</w:t></w:r></w:p></w:docPartBody></w:docPart></w:docParts></w:glossaryDocument>`,
      'word/glossary/footnotes.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes xmlns:w="${W}"><w:footnote w:id="1"><w:p><w:r><w:t>Note by ${GLOSSARY_FOOTNOTE}</w:t></w:r></w:p></w:footnote></w:footnotes>`,
      'word/glossary/header1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="${W}"><w:p><w:r><w:t>Glossary header text</w:t></w:r></w:p></w:hdr>`,
      'word/webSettings.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:webSettings xmlns:w="${W}"><w:frameset><w:sz w:val="100"/><w:title w:val="${FRAME_TITLE}"/><w:frame><w:sz w:val="50"/><w:name w:val="${FRAME_NAME}"/><w:title w:val="Left"/></w:frame></w:frameset><w:optimizeForBrowser/></w:webSettings>`,
    });
    const file = await zipToFile(zip);
    const { parts, plainText } = await redactByOffsets('docx-t175-glossary-frameset', file, [GLOSSARY_FOOTNOTE, FRAME_NAME, FRAME_TITLE]);
    expect(plainText).toContain('Building block body');
    expect(plainText).toContain('Glossary header text');
    expect(plainText.split('\n')).toContain('Left');
    expect(parts.get('word/glossary/footnotes.xml')!).toContain('Note by [UNIT_1]');
    const web = parts.get('word/webSettings.xml')!;
    expect(web).toContain('<w:name w:val="[UNIT_2]"/>');
    expect(web).toContain('<w:title w:val="[UNIT_3]"/>');
    expect(web).toContain('<w:optimizeForBrowser/>');
    assertWellFormed(parts);
  });

  it('an entity that lives only in a chart cache is found in plainText and gone after export', async () => {
    const ONLY_IN_CHART = 'Cache Only Person';
    const zip = minimalDocx(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>Nothing sensitive here.</w:t></w:r></w:p></w:body></w:document>`, {
      'word/charts/chart1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="${C}" xmlns:a="${A}"><c:chart><c:plotArea><c:barChart><c:ser>
<c:cat><c:strRef><c:f>Sheet1!$A$2</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${ONLY_IN_CHART}</c:v></c:pt></c:strCache></c:strRef></c:cat>
</c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>`,
    });
    const file = await zipToFile(zip);
    const { parts } = await redactByOffsets('docx-t175-chart-only-entity', file, [ONLY_IN_CHART]);
    expect(parts.get('word/charts/chart1.xml')!).toMatch(/<c:v[^>]*>\[UNIT_1\]<\/c:v>/);
  });

  it('is deterministic across reads and keeps every part separator as a break', async () => {
    const bytes = await buildDocxFixture({ chart: true, diagram: true, customXml: true, numbering: true, attributes: true });
    const a = await readDocx(await bytesToFile(bytes, 'a.docx'));
    const b = await readDocx(await bytesToFile(bytes, 'b.docx'));
    expect(a.plainText).toBe(b.plainText);
    expect(a.paragraphBreaks).toEqual(b.paragraphBreaks);
    expect(a.contentParts.map((p) => p.path)).toEqual([
      'word/document.xml', 'customXml/item1.xml', 'word/charts/chart1.xml', 'word/diagrams/data1.xml', 'word/numbering.xml',
    ]);
    for (const part of a.contentParts.slice(1)) {
      expect(a.plainText[part.flatTextStart - 1]).toBe('\n');
      expect(a.paragraphBreaks.some((pb) => pb.flatIndex === part.flatTextStart - 1)).toBe(true);
    }
    for (const node of a.textNodes) {
      expect(a.plainText.slice(node.flatStart, node.flatEnd)).not.toContain('\n');
    }
  });

  it('strips c:externalData from a chart and reports the embedded workbook as unredactable', async () => {
    const CT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
    const zip = minimalDocx(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>Report</w:t></w:r></w:p></w:body></w:document>`, {
      '[Content_Types].xml': CT,
      'word/charts/chart1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="${C}" xmlns:a="${A}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>Sales of Zbigniew Przykladowy</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea/></c:chart>
<c:externalData r:id="rId1"><c:autoUpdate val="0"/></c:externalData></c:chartSpace>`,
      'word/charts/_rels/chart1.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/package" Target="../embeddings/Microsoft_Excel_Worksheet.xlsx"/></Relationships>`,
      'word/embeddings/Microsoft_Excel_Worksheet.xlsx': 'PK-not-really-a-zip',
    });
    const extraction = await readDocx(await zipToFile(zip));
    expect(extraction.unredactable).toEqual([
      { part: 'word/embeddings/Microsoft_Excel_Worksheet.xlsx', kind: 'embedded-object', label: 'embedded Excel sheet' },
    ]);
    expect(extraction.plainText).toContain('Sales of Zbigniew Przykladowy');

    await expect(writeAnonymizedDocx(extraction, [], [])).rejects.toMatchObject({ code: 'unredactable-parts' });

    const replacements = findAll(extraction.plainText, 'Zbigniew Przykladowy').map((r) => ({ ...r, replacement: '[PERSON_1]' }));
    const result = await writeAnonymizedDocxWithReport(extraction, replacements, [], { allowUnredactable: true });
    await writeOutput('docx-t175-external-data.docx', result.blob);
    const parts = await partsOf(result.blob);
    const chart = parts.get('word/charts/chart1.xml')!;
    expect(chart).not.toContain('externalData');
    expect(chart).not.toContain('autoUpdate');
    expect(chart).toMatch(/<a:t[^>]*>Sales of \[PERSON_1\]<\/a:t>/);
    expect(parts.has('word/embeddings/Microsoft_Excel_Worksheet.xlsx')).toBe(true);
    expect(result.warnings).toEqual(['word/embeddings/Microsoft_Excel_Worksheet.xlsx: embedded Excel sheet, copied verbatim (not redacted)']);
    assertWellFormed(parts);
  });
});

describe('attribute unit filter: Word-internal bookmarks and letterless level text (T175 UX fix)', () => {
  function bookmarkDocx(): JSZip {
    return minimalDocx(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}"><w:body>
<w:p><w:bookmarkStart w:id="0" w:name="_GoBack"/><w:bookmarkEnd w:id="0"/><w:r><w:t>Heading</w:t></w:r></w:p>
<w:p><w:bookmarkStart w:id="1" w:name="_Toc123456"/><w:r><w:t>Contents</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>
<w:p><w:bookmarkStart w:id="2" w:name="_Ref_Kowalski"/><w:r><w:t>Ref</w:t></w:r><w:bookmarkEnd w:id="2"/></w:p>
<w:p><w:bookmarkStart w:id="3" w:name="ClientKowalski"/><w:r><w:t>Client</w:t></w:r><w:bookmarkEnd w:id="3"/></w:p>
</w:body></w:document>`, {
      'word/numbering.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0">
<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>
<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="-"/></w:lvl>
<w:lvl w:ilvl="2"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="Chapter %1"/></w:lvl>
<w:lvl w:ilvl="3"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val=""/></w:lvl>
</w:abstractNum></w:numbering>`,
    });
  }

  it('keeps _GoBack, _Toc, _Ref and "%1." / "-" out of the editor text, keeps user bookmarks and lettered level text', async () => {
    const extraction = await readDocx(await zipToFile(bookmarkDocx()));
    const lines = extraction.plainText.split('\n');
    expect(lines).not.toContain('_GoBack');
    expect(lines).not.toContain('_Toc123456');
    expect(lines).not.toContain('_Ref_Kowalski');
    expect(lines).not.toContain('%1.');
    expect(lines).not.toContain('-');
    expect(lines).not.toContain('');
    expect(lines).toContain('ClientKowalski');
    expect(lines).toContain('Chapter %1');
    expect(lines[lines.length - 1]).toBe('Chapter %1');
  });

  it('still renames an internal bookmark that holds a known value (layer-zero coverage)', async () => {
    const extraction = await readDocx(await zipToFile(bookmarkDocx()));
    const replacements = findAll(extraction.plainText, 'ClientKowalski').map((r) => ({ ...r, replacement: '[PERSON_1]' }));
    const blob = await writeAnonymizedDocx(extraction, replacements, [{ value: 'Kowalski', replacement: '[PERSON_1]' }]);
    await assertNoTrace(blob, ['Kowalski']);
    const parts = await partsOf(blob);
    const doc = parts.get('word/document.xml')!;
    expect(doc).toContain('w:name="_GoBack"');
    expect(doc).toContain('w:name="_Toc123456"');
    expect(doc).not.toContain('_Ref_Kowalski');
    expect(doc).toContain('w:name="PERSON_1"');
    expect(parts.get('word/numbering.xml')!).toContain('w:val="%1."');
    assertWellFormed(parts);
  });
});

describe('metadata dates, revision ids and the zip container (T179, M6 / L1)', () => {
  const FIXED = '2000-01-01T00:00:00Z';
  const CP = 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties';
  const DCTERMS = 'http://purl.org/dc/terms/';

  function trackedDocx(): JSZip {
    return minimalDocx(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}">
  <w:body>
    <w:p w:rsidR="00AB12CD" w:rsidRDefault="00AB12CD" w:rsidP="00EF3456" w:rsidRPr="00112233">
      <w:pPr><w:pPrChange w:id="10" w:author="Alice Reviewer" w:date="2024-02-03T04:05:06Z"><w:pPr/></w:pPrChange></w:pPr>
      <w:r w:rsidR="00778899" w:rsidDel="00AABBCC">
        <w:rPr><w:rPrChange w:id="11" w:author="Alice Reviewer" w:date="2024-02-03T04:05:06Z"><w:rPr/></w:rPrChange></w:rPr>
        <w:t>Kept text with John Smith.</w:t>
      </w:r>
      <w:ins w:id="12" w:author="Alice Reviewer" w:date="2024-02-03T04:05:06Z"><w:r><w:t> inserted</w:t></w:r></w:ins>
      <w:del w:id="13" w:author="Alice Reviewer" w:date="2024-02-03T04:05:06Z"><w:r><w:delText>deleted</w:delText></w:r></w:del>
    </w:p>
    <w:tbl>
      <w:tblPr><w:tblPrChange w:id="14" w:author="Alice Reviewer" w:date="2024-02-03T04:05:06Z"><w:tblPr/></w:tblPrChange></w:tblPr>
      <w:tr w:rsidR="00DDEEFF" w:rsidTr="00DDEEFF">
        <w:tc><w:tcPr><w:cellIns w:id="15" w:author="Alice Reviewer" w:date="2024-02-03T04:05:06Z"/></w:tcPr><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
    <w:sectPr w:rsidR="00AB12CD" w:rsidSect="00AB12CD">
      <w:sectPrChange w:id="16" w:author="Alice Reviewer" w:date="2024-02-03T04:05:06Z"><w:sectPr/></w:sectPrChange>
    </w:sectPr>
  </w:body>
</w:document>`, {
      'word/comments.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments xmlns:w="${W}">
  <w:comment w:id="1" w:author="Bob Commenter" w:initials="BC" w:date="2024-06-07T08:09:10Z">
    <w:p w:rsidR="00123456"><w:r><w:t>Comment on John Smith.</w:t></w:r></w:p>
  </w:comment>
</w:comments>`,
      'word/settings.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="${W}"><w:zoom w:percent="100"/><w:rsids><w:rsidRoot w:val="00AB12CD"/><w:rsid w:val="00AB12CD"/><w:rsid w:val="00EF3456"/></w:rsids></w:settings>`,
      'docProps/core.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="${CP}" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="${DCTERMS}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:creator>Real Author</dc:creator>
  <cp:revision>9</cp:revision>
  <dcterms:created xsi:type="dcterms:W3CDTF">2024-01-02T03:04:05Z</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">2024-05-06T07:08:09Z</dcterms:modified>
</cp:coreProperties>`,
    });
  }

  it('sets w:date on comments, insertions, deletions and every *Change record to the fixed date when changes are kept', async () => {
    const out = await writeAndReadBack('docx-t179-dates-kept-changes', trackedDocx(),
      [{ value: 'John Smith', replacement: '[PERSON_1]' }], ['John Smith']);
    const doc = out.get('word/document.xml')!;
    const comments = out.get('word/comments.xml')!;
    expect(doc).not.toContain('2024-');
    expect(comments).not.toContain('2024-');
    expect(out.get('docProps/core.xml')!).not.toContain('2024-');
    // Each dated element survives with the fixed date (tracked changes are kept by default).
    for (const el of ['w:pPrChange', 'w:rPrChange', 'w:ins', 'w:del', 'w:tblPrChange', 'w:cellIns', 'w:sectPrChange']) {
      expect(doc, el).toMatch(new RegExp(`<${el}[^>]*w:date="${FIXED}"`));
    }
    expect(comments).toMatch(new RegExp(`<w:comment[^>]*w:date="${FIXED}"`));
    expect(doc).not.toContain('Alice Reviewer');
    assertWellFormed(out);
  });

  it('removes every w:rsid* attribute from content parts and the w:rsids element from settings', async () => {
    const out = await writeAndReadBack('docx-t179-rsid-removed', trackedDocx(), [], []);
    const doc = out.get('word/document.xml')!;
    expect(doc).not.toMatch(/w:rsid[A-Za-z]*=/);
    expect(out.get('word/comments.xml')!).not.toMatch(/w:rsid[A-Za-z]*=/);
    expect(out.get('word/settings.xml')!).not.toContain('rsid');
    for (const id of ['00AB12CD', '00EF3456', '00112233', '00778899', '00AABBCC', '00DDEEFF', '00123456']) {
      expect(doc).not.toContain(id);
    }
    // The elements that carried the ids are still there.
    expect(doc).toContain('<w:p>');
    expect(doc).toContain('<w:tr>');
    expect(doc).toContain('<w:sectPr>');
    expect(doc).toContain('Kept text with John Smith.');
    expect(out.get('word/settings.xml')!).toContain('w:zoom');
    assertWellFormed(out);
  });

  it('dates every zip entry 1980-01-01 UTC and strips entry and archive comments, structural entries included', async () => {
    const source = trackedDocx();
    // Fingerprints a real source carries: per-entry mtimes and comments, an archive comment.
    for (const [name, entry] of Object.entries(source.files)) {
      entry.date = new Date(name.endsWith('document.xml') ? '2024-05-06T07:08:09Z' : '2021-01-02T03:04:05Z');
      entry.comment = `note for ${name}`;
    }
    const ab = await source.generateAsync({ type: 'arraybuffer', comment: 'archive note' });
    const file = new File([ab], 'test.docx');
    if (typeof file.arrayBuffer !== 'function') {
      Object.defineProperty(file, 'arrayBuffer', { value: async () => ab });
    }
    const extraction = await readDocx(file);
    const blob = await writeAnonymizedDocx(extraction, [], []);
    await writeOutput('docx-t179-zip-normalised.docx', blob);

    const out = await JSZip.loadAsync(await blobToArrayBuffer(blob));
    expect((out as unknown as { comment: string | null }).comment || '').toBe('');
    const names = Object.keys(out.files);
    expect(names).toContain('word/document.xml');
    expect(names).toContain('[Content_Types].xml');
    expect(names).toContain('_rels/.rels');
    for (const name of names) {
      const entry = out.files[name];
      expect(entry.date.getTime(), `${name} date`).toBe(Date.UTC(1980, 0, 1));
      expect(entry.comment || '', `${name} comment`).toBe('');
    }
  });
});
