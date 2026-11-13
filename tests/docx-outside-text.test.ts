// @vitest-environment jsdom
/**
 * Values a document keeps outside its text. The reader maps the text of the
 * body, headers, notes and comments; the same parts also hold values in
 * attributes (the alt text of a legacy shape, the items of a drop-down, a
 * WordArt string) and in text of elements the reader does not know. The
 * writer scrubs those by value and removes legacy alt text like it removes
 * the alt text of a drawing. The mapped text is not scrubbed by value: a
 * place the user kept visible stays visible.
 */
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { readDocx, writeAnonymizedDocxWithReport } from '../src/dom/docx.ts';
import { assertNoTrace, writeOutput } from './helpers/package-scan.ts';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const V = 'urn:schemas-microsoft-com:vml';
const O = 'urn:schemas-microsoft-com:office:office';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const LC = 'http://schemas.openxmlformats.org/drawingml/2006/lockedCanvas';

const MARGARET = 'Margaret Harrington';
const OLIVER = 'Oliver Bennett';

const PAIRS: Array<[string, string]> = [
  [MARGARET, '[PERSON_1]'],
  [OLIVER, '[PERSON_2]'],
  ['Harrington', '[PERSON_1]'],
  ['Bennett', '[PERSON_2]'],
];

function docx(bodyXml: string, headerXml?: string): JSZip {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  ${headerXml ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : ''}
</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL}">${headerXml ? `<Relationship Id="rId7" Type="${R}/header" Target="header1.xml"/>` : ''}</Relationships>`);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:v="${V}" xmlns:o="${O}" xmlns:a="${A}" xmlns:wp="${WP}" xmlns:lc="${LC}"><w:body>${bodyXml}</w:body></w:document>`);
  if (headerXml) {
    zip.file('word/header1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="${W}" xmlns:v="${V}" xmlns:o="${O}">${headerXml}</w:hdr>`);
  }
  return zip;
}

async function toFile(zip: JSZip): Promise<File> {
  const ab = await zip.generateAsync({ type: 'arraybuffer' });
  const file = new File([ab], 'test.docx');
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

/**
 * Write the document with the pairs as the value list. `keep` says which
 * occurrences in the flat text stay as they are; every other occurrence of
 * the two full names is replaced positionally.
 */
async function redact(
  zip: JSZip,
  pairs: Array<[string, string]> = PAIRS,
  keep: (value: string, occurrence: number) => boolean = () => false,
) {
  const extraction = await readDocx(await toFile(zip));
  const text = extraction.plainText;
  const replacements: Array<{ start: number; end: number; replacement: string }> = [];
  for (const [value, replacement] of pairs) {
    let occurrence = 0;
    for (let i = text.indexOf(value); i >= 0; i = text.indexOf(value, i + value.length)) {
      const kept = keep(value, occurrence++);
      const taken = replacements.some((r) => i < r.end && i + value.length > r.start);
      if (!kept && !taken) replacements.push({ start: i, end: i + value.length, replacement });
    }
  }
  const result = await writeAnonymizedDocxWithReport(extraction, replacements, pairs.map(([value, replacement]) => ({ value, replacement })));
  const written = await JSZip.loadAsync(await blobBuffer(result.blob));
  const read = (path: string) => written.file(path)!.async('string');
  return { result, read, document: await read('word/document.xml'), text };
}

const p = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

describe('a document keeps no replaced value outside its text', () => {
  it('removes the alt text and titles of legacy shapes, like those of a drawing', async () => {
    const zip = docx(
      p(`Signed by ${MARGARET}.`)
      + `<w:p><w:r><w:pict><v:shape id="_x0000_s1026" style="width:200pt;height:40pt" alt="Signature of ${MARGARET}" title="${MARGARET}">`
      + `<v:fill o:title="signature ${OLIVER}"/>`
      + `<v:textbox><w:txbxContent>${p(`Box: ${OLIVER}`)}</w:txbxContent></v:textbox></v:shape></w:pict></w:r></w:p>`,
      `<w:p><w:r><w:t>Letterhead</w:t></w:r><w:r><w:pict><v:shape id="_x0000_s2049" style="position:absolute" alt="Stamp of Unknown Person"/></w:pict></w:r></w:p>`,
    );
    const { result, document, read } = await redact(zip);
    expect(document).toContain('<v:shape id="_x0000_s1026" style="width:200pt;height:40pt">');
    expect(document).toContain('<v:fill/>');
    expect(document).toContain('Box: [PERSON_2]');
    // No value list is needed: the alt text is free text no detector read.
    expect(await read('word/header1.xml')).toContain('<v:shape id="_x0000_s2049" style="position:absolute"/>');
    await assertNoTrace(result.blob, [MARGARET, OLIVER, 'Harrington', 'Bennett', 'Unknown Person']);
    await writeOutput('docx-outside-text-vml-alt.docx', result.blob);
  });

  it('replaces a known value in every attribute the reader did not map', async () => {
    const zip = docx(
      p(`Client ${OLIVER}, partner ${MARGARET}.`)
      // A drop-down content control: the items are attribute values.
      + `<w:sdt><w:sdtPr><w:id w:val="77"/><w:dropDownList><w:listItem w:displayText="${MARGARET}" w:value="${MARGARET}"/><w:listItem w:displayText="${OLIVER}" w:value="2"/></w:dropDownList></w:sdtPr><w:sdtContent>${p('Choose')}</w:sdtContent></w:sdt>`
      // WordArt of a legacy watermark: the text is an attribute.
      + `<w:p><w:r><w:pict><v:shape id="_x0000_s1027" style="width:300pt;height:60pt"><v:textpath style="font-family:&quot;Arial&quot;" string="Draft for ${OLIVER}"/></v:shape></w:pict></w:r></w:p>`
      // A picture link with a screen tip.
      + `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="100" cy="100"/><wp:docPr id="5" name="Picture 5"><a:hlinkClick r:id="rId12" tooltip="Call ${MARGARET}"/></wp:docPr></wp:inline></w:drawing></w:r></w:p>`
      // A table with a caption (its alt text).
      + `<w:tbl><w:tblPr><w:tblCaption w:val="Fees of ${OLIVER}"/></w:tblPr><w:tr><w:tc>${p('Fee')}</w:tc></w:tr></w:tbl>`,
      `<w:p><w:r><w:pict><v:shape id="_x0000_s2050" style="width:10pt"><v:textpath string="${MARGARET} confidential"/></v:shape></w:pict></w:r></w:p>`,
    );
    const { result, document, read } = await redact(zip);
    expect(document).toContain('<w:listItem w:displayText="[PERSON_1]" w:value="[PERSON_1]"/>');
    expect(document).toContain('<w:listItem w:displayText="[PERSON_2]" w:value="2"/>');
    expect(document).toContain('string="Draft for [PERSON_2]"');
    expect(document).toContain('tooltip="Call [PERSON_1]"');
    expect(document).toContain('<w:tblCaption w:val="Fees of [PERSON_2]"/>');
    expect(await read('word/header1.xml')).toContain('string="[PERSON_1] confidential"');
    // Identifiers, relationship ids and sizes are as they were.
    expect(document).toContain('<w:id w:val="77"/>');
    expect(document).toContain('r:id="rId12"');
    expect(document).toContain('<wp:extent cx="100" cy="100"/>');
    expect(document).toContain('style="width:300pt;height:60pt"');
    await assertNoTrace(result.blob, [MARGARET, OLIVER, 'Harrington', 'Bennett']);
  });

  it('keeps a place the user kept: the paragraph stays, the attribute copies do not', async () => {
    const zip = docx(
      p(`First mention of ${MARGARET}.`)
      + p(`Second mention of ${MARGARET}.`)
      + `<w:sdt><w:sdtPr><w:alias w:val="${MARGARET}"/><w:dropDownList><w:listItem w:displayText="${MARGARET}" w:value="1"/></w:dropDownList></w:sdtPr><w:sdtContent>${p('Choose')}</w:sdtContent></w:sdt>`,
    );
    // Places of the full name in the flat text: first paragraph, second paragraph, the control's title.
    // The user keeps the first and the title.
    const { document } = await redact(zip, [[MARGARET, '[PERSON_1]']], (_value, occurrence) => occurrence !== 1);
    expect(document).toContain(`First mention of ${MARGARET}.`);
    expect(document).toContain('Second mention of [PERSON_1].');
    // The title of the control is a place of the flat text: kept.
    expect(document).toContain(`<w:alias w:val="${MARGARET}"/>`);
    // The list item is not: scrubbed.
    expect(document).toContain('<w:listItem w:displayText="[PERSON_1]" w:value="1"/>');
  });

  it('leaves the keywords of the format a name is a piece of, and the schema names', async () => {
    // Otto is in bottom, Elin in baseline, Hans in minorHAnsi, Page in nextPage; Microsoft is in the schema of a text box.
    const zip = docx(
      `<w:p><w:pPr><w:textAlignment w:val="baseline"/></w:pPr><w:r><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"/></w:rPr>`
      + `<w:t>Otto Page and Elin of Microsoft met Hans.</w:t></w:r></w:p>`
      + `<w:tbl><w:tr><w:tc><w:tcPr><w:vAlign w:val="bottom"/></w:tcPr>${p('Fee')}</w:tc></w:tr></w:tbl>`
      + `<w:p><w:r><w:drawing><wp:anchor><wp:positionV relativeFrom="page"><wp:align>bottom</wp:align></wp:positionV><wp:extent cx="100" cy="100"/><wp:docPr id="8" name="Text Box 8"/>`
      + `<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"/></a:graphic></wp:anchor></w:drawing></w:r></w:p>`
      + `<w:p><w:pPr><w:sectPr><w:type w:val="nextPage"/></w:sectPr></w:pPr></w:p>`,
    );
    const pairs: Array<[string, string]> = [
      ['Otto Page', '[PERSON_1]'], ['Otto', '[PERSON_1]'], ['Page', '[PERSON_1]'],
      ['Elin', '[PERSON_2]'], ['Hans', '[PERSON_3]'], ['Microsoft', '[COMPANY_1]'],
    ];
    const { document } = await redact(zip, pairs);
    expect(document).toContain('[PERSON_1] and [PERSON_2] of [COMPANY_1] met [PERSON_3].');
    expect(document).toContain('<w:textAlignment w:val="baseline"/>');
    expect(document).toContain('w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"');
    expect(document).toContain('<w:vAlign w:val="bottom"/>');
    expect(document).toContain('<wp:positionV relativeFrom="page"><wp:align>bottom</wp:align></wp:positionV>');
    expect(document).toContain('<w:type w:val="nextPage"/>');
    expect(document).toContain('uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"');
  });

  it('scrubs text of elements the reader does not know, never a field keyword', async () => {
    const zip = docx(
      p(`About ${OLIVER} and Larry Page.`)
      // A shape pasted from a slide: its text is DrawingML, not w:t.
      + `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="100" cy="100"/><wp:docPr id="6" name="Canvas"/><a:graphic><a:graphicData uri="${LC}"><lc:lockedCanvas><a:sp><a:txBody><a:bodyPr/><a:p><a:r><a:t>Pasted note on ${OLIVER}</a:t></a:r></a:p></a:txBody></a:sp></lc:lockedCanvas></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
      + `<w:p><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p>`,
    );
    const pairs: Array<[string, string]> = [[OLIVER, '[PERSON_2]'], ['Larry Page', '[PERSON_3]'], ['Page', '[PERSON_3]']];
    const { result, document, text } = await redact(zip, pairs);
    expect(text).not.toContain('Pasted note');
    expect(document).toContain('<a:t>Pasted note on [PERSON_2]</a:t>');
    expect(document).toContain('About [PERSON_2] and [PERSON_3].');
    expect(document).toContain('w:instr=" PAGE "');
    await assertNoTrace(result.blob, [OLIVER, 'Larry Page']);
  });
});
