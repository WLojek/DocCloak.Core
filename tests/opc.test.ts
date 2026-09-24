// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import {
  replaceSensitiveValues,
  scrubPackageValues,
  scrubExternalRelTargets,
  scrubMailtoTarget,
  MAILTO_REDACTED_TARGET,
  layerZeroValueReplacements,
  elementsByLocalName,
  OOXML_NS,
  scrubDocPropsParts,
  normalizeZipEntries,
  NORMALISED_DATE,
  ZIP_ENTRY_DATE,
} from '../src/dom/opc.ts';

describe('replaceSensitiveValues', () => {
  it('applies longer values first so a variant never leaves part of the full name behind', () => {
    const pairs = [
      { value: 'Kowalski', replacement: '[PERSON_1_LAST]' },
      { value: 'Jan Kowalski', replacement: '[PERSON_1]' },
    ];
    expect(replaceSensitiveValues('Sprawa: Jan Kowalski / Kowalski', pairs, false)).toBe(
      'Sprawa: [PERSON_1] / [PERSON_1_LAST]',
    );
  });

  it('matches the percent-encoded form of a value inside URLs', () => {
    const pairs = [
      { value: 'Kowalski', replacement: '[PERSON_1_LAST]' },
      { value: 'Jan Kowalski', replacement: '[PERSON_1]' },
    ];
    expect(replaceSensitiveValues('https://crm.example/Jan%20Kowalski?u=kowalski', pairs, true)).toBe(
      'https://crm.example/%5BPERSON_1%5D?u=%5BPERSON_1_LAST%5D',
    );
  });

  it('keeps regex metacharacters and $ sequences inert', () => {
    const pairs = [{ value: 'a.b (c) $1', replacement: '$&x' }];
    expect(replaceSensitiveValues('see a.b (c) $1 and axb', pairs, false)).toBe('see $&x and axb');
  });

  it('skips empty values', () => {
    expect(replaceSensitiveValues('unchanged', [{ value: '', replacement: 'X' }], false)).toBe('unchanged');
  });

  it('honours word boundaries when asked (T172 attribute safety rule)', () => {
    const pairs = [{ value: '123456789', replacement: '[ID]' }];
    expect(replaceSensitiveValues('a 123456789 b 1234567890 c', pairs, false, { wordBoundary: true })).toBe(
      'a [ID] b 1234567890 c',
    );
    expect(replaceSensitiveValues('a 123456789 b 1234567890 c', pairs, false)).toBe(
      'a [ID] b [ID]0 c',
    );
  });
});

describe('mailto relationship targets are always scrubbed (T174, M1)', () => {
  const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

  it('scrubMailtoTarget replaces the whole mailto: target and leaves other schemes alone', () => {
    expect(scrubMailtoTarget('mailto:jan.kowalski@acme.com?subject=Case%20Kowalski')).toBe(MAILTO_REDACTED_TARGET);
    expect(scrubMailtoTarget('MAILTO:x@y.example')).toBe(MAILTO_REDACTED_TARGET);
    expect(scrubMailtoTarget('https://acme.com/jan')).toBe('https://acme.com/jan');
    expect(scrubMailtoTarget('media/image1.png')).toBe('media/image1.png');
  });

  it('scrubExternalRelTargets applies the mailto rule without any value list, and the value scrub to the rest', async () => {
    const zip = new JSZip();
    zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL}">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="mailto:only.here@leak.example" TargetMode="External"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://crm.example/Jan%20Kowalski" TargetMode="External"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/mailto.png"/>
</Relationships>`);
    await scrubExternalRelTargets(zip, /\.rels$/, [{ value: 'Jan Kowalski', replacement: '[PERSON_1]' }]);
    const rels = await zip.file('word/_rels/document.xml.rels')!.async('string');
    expect(rels).not.toContain('only.here@leak.example');
    expect(rels).toContain(`Target="${MAILTO_REDACTED_TARGET}" TargetMode="External"`);
    expect(rels).toContain('https://crm.example/%5BPERSON_1%5D');
    expect(rels).toContain('Target="media/mailto.png"'); // internal target untouched

    // No value list at all: the mailto rule still fires
    const bare = new JSZip();
    bare.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="mailto:a@b.example" TargetMode="External"/></Relationships>`);
    await scrubExternalRelTargets(bare, /\.rels$/, []);
    expect(await bare.file('_rels/.rels')!.async('string')).not.toContain('a@b.example');
  });

  it('the layer-zero walker applies the mailto rule to rels it visits', async () => {
    const zip = new JSZip();
    zip.file('word/_rels/header1.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="mailto:hdr@leak.example" TargetMode="External"/></Relationships>`);
    await scrubPackageValues(zip, [{ value: 'unrelated', replacement: '[X]' }]);
    const rels = await zip.file('word/_rels/header1.xml.rels')!.async('string');
    expect(rels).not.toContain('hdr@leak.example');
    expect(rels).toContain(MAILTO_REDACTED_TARGET);
  });
});

describe('elementsByLocalName and namespace sets (T172)', () => {
  it('finds elements in both the transitional and the strict namespace, in document order', () => {
    const doc = new DOMParser().parseFromString(
      `<root xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:s="http://purl.oclc.org/ooxml/wordprocessingml/main" xmlns:x="urn:other">
        <w:p>1</w:p><s:p>2</s:p><x:p>3</x:p><w:t>t</w:t>
      </root>`,
      'application/xml',
    );
    const found = elementsByLocalName(doc, OOXML_NS.w, 'p');
    expect(found.map((el) => el.textContent)).toEqual(['1', '2']);
  });
});

describe('layerZeroValueReplacements (T172)', () => {
  it('keeps every entry and adds PERSON tokens of at least four letters', () => {
    const pairs = layerZeroValueReplacements([
      { original: 'Jan Kowalski-Nowak', replacement: '[PERSON_1]', entityType: 'PERSON' },
      { original: 'Acme Legal LLP', replacement: '[ORG_1]', entityType: 'ORG' },
      { original: 'Li Wu', replacement: '[PERSON_2]', entityType: 'PERSON' },
      { original: '', replacement: '[EMPTY]', entityType: 'OTHER' },
    ]);
    const values = pairs.map((p) => p.value);
    expect(values).toContain('Jan Kowalski-Nowak');
    expect(values).toContain('Kowalski-Nowak');
    expect(values).toContain('Acme Legal LLP');
    expect(values).toContain('Li Wu');
    expect(values).not.toContain('Jan'); // three letters: too short for a bare token
    expect(values).not.toContain('Legal'); // ORG tokens are not expanded
    expect(values).not.toContain('');
    expect(pairs.find((p) => p.value === 'Kowalski-Nowak')!.replacement).toBe('[PERSON_1]');
  });

  it('does not add a token that already exists as its own entry', () => {
    const pairs = layerZeroValueReplacements([
      { original: 'Jan Kowalski', replacement: '[PERSON_1]', entityType: 'PERSON' },
      { original: 'Kowalski', replacement: '[PERSON_1_LAST]', entityType: 'PERSON' },
    ]);
    expect(pairs.filter((p) => p.value.toLowerCase() === 'kowalski')).toHaveLength(1);
    expect(pairs.find((p) => p.value === 'Kowalski')!.replacement).toBe('[PERSON_1_LAST]');
  });
});

describe('scrubPackageValues: generic package walker (T172 layer zero)', () => {
  const SS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const NAME = 'Zbigniew Przykladowy';

  function buildZip(): JSZip {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/${NAME}.xml" ContentType="application/xml"/></Types>`);
    zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL}">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://crm.example/${encodeURIComponent(NAME)}" TargetMode="External"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${NAME}.png"/>
</Relationships>`);
    zip.file('xl/pivotCache/pivotCacheRecords1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<pivotCacheRecords xmlns="${SS}" count="1"><r><s v="${NAME}"/><n v="90010112345"/><x v="0"/></r></pivotCacheRecords>`);
    zip.file('xl/pivotCache/pivotCacheDefinition1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<pivotCacheDefinition xmlns="${SS}"><cacheFields><cacheField name="Owner"><sharedItems><s v="${NAME}"/></sharedItems></cacheField></cacheFields></pivotCacheDefinition>`);
    zip.file('xl/drawings/vmlDrawing1.vml', `<xml xmlns:v="urn:schemas-microsoft-com:vml"><v:shape id="_x0000_s1025"><v:textbox><div><![CDATA[Note by ${NAME}]]></div></v:textbox></v:shape></xml>`);
    zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="${SS}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${NAME}</t></is></c></row></sheetData></worksheet>`);
    zip.file('xl/broken.xml', '<oops><never closed>');
    zip.file('xl/media/image1.png', new Uint8Array([1, 2, 3]));
    return zip;
  }

  async function partsOf(zip: JSZip): Promise<Map<string, string>> {
    const contents = new Map<string, string>();
    for (const path of Object.keys(zip.files)) {
      const f = zip.file(path);
      if (f && !path.endsWith('/') && !path.endsWith('.png')) contents.set(path, await f.async('string'));
    }
    return contents;
  }

  it('scrubs text nodes, CDATA, attribute values and external rel targets in every XML, rels and vml part', async () => {
    const zip = buildZip();
    const pairs = [
      { value: NAME, replacement: '[PERSON_1]' },
      { value: '90010112345', replacement: '[PESEL_1]' },
    ];
    const { warnings } = await scrubPackageValues(zip, pairs, { skip: new Set(['xl/worksheets/sheet1.xml']) });
    const out = await partsOf(zip);

    expect(out.get('xl/pivotCache/pivotCacheRecords1.xml')!).not.toContain(NAME);
    expect(out.get('xl/pivotCache/pivotCacheRecords1.xml')!).toContain('v="[PERSON_1]"');
    expect(out.get('xl/pivotCache/pivotCacheRecords1.xml')!).toContain('v="[PESEL_1]"');
    expect(out.get('xl/pivotCache/pivotCacheDefinition1.xml')!).not.toContain(NAME);
    expect(out.get('xl/drawings/vmlDrawing1.vml')!).not.toContain(NAME);
    expect(out.get('xl/drawings/vmlDrawing1.vml')!).toContain('Note by [PERSON_1]');

    // External relationship target: scrubbed in its percent-encoded form
    const rels = out.get('_rels/.rels')!;
    expect(rels).not.toContain(encodeURIComponent(NAME));
    expect(rels).toContain('https://crm.example/%5BPERSON_1%5D');
    // Internal targets, Ids and Types are structural and never touched
    expect(rels).toContain(`Target="media/${NAME}.png"`);
    expect(rels).toContain('Target="xl/workbook.xml"');
    expect(rels).toContain('relationships/officeDocument');

    // Skipped: content types and the explicitly excluded content part
    expect(out.get('[Content_Types].xml')!).toContain(`/xl/${NAME}.xml`);
    expect(out.get('xl/worksheets/sheet1.xml')!).toContain(NAME);

    // Unparsable part: untouched and reported
    expect(out.get('xl/broken.xml')).toBe('<oops><never closed>');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('xl/broken.xml');
  });

  it('is a no-op with an empty value list', async () => {
    const zip = buildZip();
    const before = await partsOf(zip);
    const { warnings } = await scrubPackageValues(zip, [], {});
    expect(warnings).toEqual([]);
    expect(await partsOf(zip)).toEqual(before);
  });
});

// readXlsx fail-closed reading lives here rather than in xlsx.test.ts because
// T172 owns only opc/docx test files; T176 (xlsx tranche) may move it.
import { readXlsx, writeAnonymizedXlsxWithReport } from '../src/dom/xlsx.ts';
import { UnsupportedDocumentError } from '../src/dom/errors.ts';

describe('readXlsx namespaces and fail-closed reading (T172, H1)', () => {
  const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const SS_STRICT = 'http://purl.oclc.org/ooxml/spreadsheetml/main';

  function xlsxZip(sheetXml: string, sharedStringsNs: string): JSZip {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>`);
    zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
    zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="${sharedStringsNs}"><sheets><sheet name="Sheet1" sheetId="1"/></sheets></workbook>`);
    zip.file('xl/sharedStrings.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="${sharedStringsNs}" count="1" uniqueCount="1"><si><t>Owner: strict@acme.com</t></si></sst>`);
    zip.file('xl/worksheets/sheet1.xml', sheetXml);
    return zip;
  }

  async function zipToFile(zip: JSZip): Promise<File> {
    const ab = await zip.generateAsync({ type: 'arraybuffer' });
    const file = new File([ab], 'test.xlsx');
    if (typeof file.arrayBuffer !== 'function') {
      Object.defineProperty(file, 'arrayBuffer', { value: async () => ab });
    }
    return file;
  }

  it('extracts a Strict OOXML workbook', async () => {
    const zip = xlsxZip(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="${SS_STRICT}"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>`, SS_STRICT);
    const extraction = await readXlsx(await zipToFile(zip));
    expect(extraction.plainText).toContain('strict@acme.com');
    expect(extraction.empty).toBe(false);
    expect(extraction.unredactable).toEqual([]);
  });

  it('refuses worksheets whose sheetData lives in an unrecognized namespace', async () => {
    const zip = xlsxZip(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="urn:vendor:future-spreadsheet"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>hidden@acme.com</t></is></c></row></sheetData></worksheet>`,
      'http://schemas.openxmlformats.org/spreadsheetml/2006/main');
    let caught: unknown;
    try {
      await readXlsx(await zipToFile(zip));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnsupportedDocumentError);
    expect((caught as UnsupportedDocumentError).code).toBe('unrecognized-namespace');
  });

  it('flags a workbook without any text as empty and still writes it with layer zero', async () => {
    const SS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
    const zip = xlsxZip(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="${SS}"><sheetData/></worksheet>`, SS);
    zip.file('xl/sharedStrings.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="${SS}" count="0" uniqueCount="0"/>`);
    zip.file('xl/pivotCache/pivotCacheRecords1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<pivotCacheRecords xmlns="${SS}" count="1"><r><s v="Zbigniew Przykladowy"/></r></pivotCacheRecords>`);
    const extraction = await readXlsx(await zipToFile(zip));
    expect(extraction.empty).toBe(true);
    const result = await writeAnonymizedXlsxWithReport(extraction, [], [
      { value: 'Zbigniew Przykladowy', replacement: '[PERSON_1]' },
    ]);
    expect(result.warnings).toEqual([]);
    const bytes: ArrayBuffer = typeof result.blob.arrayBuffer === 'function'
      ? await result.blob.arrayBuffer()
      : await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as ArrayBuffer);
          reader.onerror = () => reject(reader.error);
          reader.readAsArrayBuffer(result.blob);
        });
    const out = await JSZip.loadAsync(bytes);
    const records = await out.file('xl/pivotCache/pivotCacheRecords1.xml')!.async('string');
    expect(records).not.toContain('Zbigniew');
    expect(records).toContain('v="[PERSON_1]"');
  });
});

describe('scrubDocPropsParts: extended metadata scrub (T179, M6)', () => {
  const CP = 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties';
  const DC = 'http://purl.org/dc/elements/1.1/';
  const DCTERMS = 'http://purl.org/dc/terms/';
  const XSI = 'http://www.w3.org/2001/XMLSchema-instance';
  const EP = 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties';
  const VT = 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes';

  function coreXml(): string {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="${CP}" xmlns:dc="${DC}" xmlns:dcterms="${DCTERMS}" xmlns:xsi="${XSI}">
  <dc:title>Acme vs Smith</dc:title>
  <dc:creator>Real Author</dc:creator>
  <cp:lastModifiedBy>Another Person</cp:lastModifiedBy>
  <cp:contentStatus>Draft for Smith</cp:contentStatus>
  <dc:identifier>ACME-2024-0042</dc:identifier>
  <cp:revision>17</cp:revision>
  <cp:version>3.1.4</cp:version>
  <cp:lastPrinted>2024-03-04T05:06:07Z</cp:lastPrinted>
  <dcterms:created xsi:type="dcterms:W3CDTF">2024-01-02T03:04:05Z</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">2024-05-06T07:08:09Z</dcterms:modified>
</cp:coreProperties>`;
  }

  function appXml(): string {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="${EP}" xmlns:vt="${VT}">
  <Application>Microsoft Office Word</Application>
  <Template>Normal.dotm</Template>
  <TotalTime>1234</TotalTime>
  <Pages>12</Pages>
  <Words>3456</Words>
  <Characters>19876</Characters>
  <CharactersWithSpaces>23210</CharactersWithSpaces>
  <Lines>165</Lines>
  <Paragraphs>46</Paragraphs>
  <Company>Acme Legal LLP</Company>
  <HeadingPairs>
    <vt:vector size="4" baseType="variant">
      <vt:variant><vt:lpstr>Title</vt:lpstr></vt:variant>
      <vt:variant><vt:i4>1</vt:i4></vt:variant>
      <vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant>
      <vt:variant><vt:i4>2</vt:i4></vt:variant>
    </vt:vector>
  </HeadingPairs>
  <TitlesOfParts>
    <vt:vector size="3" baseType="lpstr">
      <vt:lpstr>Settlement Smith vs Acme</vt:lpstr>
      <vt:lpstr>Clients Kowalski</vt:lpstr>
      <vt:lpstr>Payroll 2024</vt:lpstr>
    </vt:vector>
  </TitlesOfParts>
  <AppVersion>16.0000</AppVersion>
</Properties>`;
  }

  async function scrubbed(): Promise<{ core: Document; app: Document; coreStr: string; appStr: string }> {
    const zip = new JSZip();
    zip.file('docProps/core.xml', coreXml());
    zip.file('docProps/app.xml', appXml());
    await scrubDocPropsParts(zip);
    const coreStr = await zip.file('docProps/core.xml')!.async('string');
    const appStr = await zip.file('docProps/app.xml')!.async('string');
    const parser = new DOMParser();
    const core = parser.parseFromString(coreStr, 'application/xml');
    const app = parser.parseFromString(appStr, 'application/xml');
    expect(core.getElementsByTagName('parsererror').length).toBe(0);
    expect(app.getElementsByTagName('parsererror').length).toBe(0);
    return { core, app, coreStr, appStr };
  }

  function textOf(doc: Document, ns: string, local: string): string[] {
    const els = doc.getElementsByTagNameNS(ns, local);
    const out: string[] = [];
    for (let i = 0; i < els.length; i++) out.push(els[i].textContent ?? '');
    return out;
  }

  it('blanks cp:contentStatus and dc:identifier next to the historical identity fields', async () => {
    const { core, coreStr } = await scrubbed();
    expect(textOf(core, CP, 'contentStatus')).toEqual(['']);
    expect(textOf(core, DC, 'identifier')).toEqual(['']);
    expect(textOf(core, DC, 'creator')).toEqual(['']);
    expect(textOf(core, CP, 'lastModifiedBy')).toEqual(['']);
    expect(textOf(core, DC, 'title')).toEqual(['']);
    for (const leak of ['Draft for Smith', 'ACME-2024-0042', 'Real Author', 'Another Person', 'Acme vs Smith']) {
      expect(coreStr).not.toContain(leak);
    }
  });

  it('sets dcterms:created, dcterms:modified and cp:lastPrinted to the fixed date and keeps xsi:type', async () => {
    const { core, coreStr } = await scrubbed();
    expect(NORMALISED_DATE).toBe('2000-01-01T00:00:00Z');
    expect(textOf(core, DCTERMS, 'created')).toEqual([NORMALISED_DATE]);
    expect(textOf(core, DCTERMS, 'modified')).toEqual([NORMALISED_DATE]);
    expect(textOf(core, CP, 'lastPrinted')).toEqual([NORMALISED_DATE]);
    const created = core.getElementsByTagNameNS(DCTERMS, 'created')[0];
    expect(created.getAttributeNS(XSI, 'type')).toBe('dcterms:W3CDTF');
    expect(coreStr).not.toContain('2024-');
  });

  it('removes cp:revision and cp:version', async () => {
    const { core, coreStr } = await scrubbed();
    expect(core.getElementsByTagNameNS(CP, 'revision').length).toBe(0);
    expect(core.getElementsByTagNameNS(CP, 'version').length).toBe(0);
    expect(coreStr).not.toContain('>17<');
    expect(coreStr).not.toContain('3.1.4');
  });

  it('zeroes the app.xml statistics and keeps the application name and version', async () => {
    const { app } = await scrubbed();
    for (const stat of ['Pages', 'Words', 'Characters', 'CharactersWithSpaces', 'Lines', 'Paragraphs', 'TotalTime']) {
      expect(textOf(app, EP, stat), stat).toEqual(['0']);
    }
    expect(textOf(app, EP, 'Application')).toEqual(['Microsoft Office Word']);
    expect(textOf(app, EP, 'AppVersion')).toEqual(['16.0000']);
    expect(textOf(app, EP, 'Company')).toEqual(['']);
    expect(textOf(app, EP, 'Template')).toEqual(['']);
  });

  it('blanks every vt:lpstr in TitlesOfParts and HeadingPairs while keeping vector size, element count and the counts', async () => {
    const { app, appStr } = await scrubbed();
    for (const leak of ['Settlement Smith vs Acme', 'Clients Kowalski', 'Payroll 2024', 'Worksheets', '>Title<']) {
      expect(appStr).not.toContain(leak);
    }
    const titles = app.getElementsByTagNameNS(EP, 'TitlesOfParts')[0];
    const titlesVector = titles.getElementsByTagNameNS(VT, 'vector')[0];
    expect(titlesVector.getAttribute('size')).toBe('3');
    expect(titlesVector.getAttribute('baseType')).toBe('lpstr');
    const titleEntries = titles.getElementsByTagNameNS(VT, 'lpstr');
    expect(titleEntries.length).toBe(3);
    for (let i = 0; i < titleEntries.length; i++) expect(titleEntries[i].textContent).toBe('');

    const pairs = app.getElementsByTagNameNS(EP, 'HeadingPairs')[0];
    const pairsVector = pairs.getElementsByTagNameNS(VT, 'vector')[0];
    expect(pairsVector.getAttribute('size')).toBe('4');
    expect(pairs.getElementsByTagNameNS(VT, 'variant').length).toBe(4);
    expect(pairs.getElementsByTagNameNS(VT, 'lpstr').length).toBe(2);
    const counts = pairs.getElementsByTagNameNS(VT, 'i4');
    expect([counts[0].textContent, counts[1].textContent]).toEqual(['1', '2']);
  });

  it('leaves a package without docProps untouched', async () => {
    const zip = new JSZip();
    zip.file('word/document.xml', '<w:document/>');
    await scrubDocPropsParts(zip);
    expect(Object.keys(zip.files)).toEqual(['word/', 'word/document.xml']);
  });
});

describe('normalizeZipEntries: deterministic container metadata (T179, L1)', () => {
  it('dates every entry (directories included) 1980-01-01 UTC and clears entry and archive comments', async () => {
    const source = new JSZip();
    // Even seconds: DOS timestamps in a zip have two-second resolution.
    source.file('a/one.xml', '<one/>', { date: new Date('2024-05-06T07:08:08Z'), comment: 'entry note one' });
    source.file('b/two.xml', '<two/>', { date: new Date('2019-12-31T23:59:58Z'), comment: 'entry note two' });
    source.folder('empty');
    const bytes = await source.generateAsync({ type: 'uint8array', comment: 'archive note' });

    // The loaded archive carries the source fingerprints, as a redacted
    // package would before normalisation.
    const zip = await JSZip.loadAsync(bytes);
    expect((zip as unknown as { comment: string }).comment).toBe('archive note');
    expect(zip.file('a/one.xml')!.comment).toBe('entry note one');
    expect(zip.file('a/one.xml')!.date.toISOString()).toBe('2024-05-06T07:08:08.000Z');
    expect(Object.keys(zip.files).some((name) => name.endsWith('/'))).toBe(true);

    normalizeZipEntries(zip);
    const out = await JSZip.loadAsync(await zip.generateAsync({ type: 'uint8array', comment: '' }));

    expect(ZIP_ENTRY_DATE.toISOString()).toBe('1980-01-01T00:00:00.000Z');
    expect((out as unknown as { comment: string | null }).comment || '').toBe('');
    const names = Object.keys(out.files);
    expect(names.length).toBeGreaterThanOrEqual(3);
    for (const name of names) {
      const entry = out.files[name];
      expect(entry.date.getTime(), name).toBe(Date.UTC(1980, 0, 1));
      expect(entry.comment || '', name).toBe('');
    }
    expect(await out.file('a/one.xml')!.async('string')).toBe('<one/>');
    expect(await out.file('b/two.xml')!.async('string')).toBe('<two/>');
  });

  it('does not let JSZip fall back to the loaded archive comment when the option is empty', async () => {
    const source = new JSZip();
    source.file('x.xml', '<x/>');
    const zip = await JSZip.loadAsync(await source.generateAsync({ type: 'uint8array', comment: 'kept by JSZip' }));
    // Without normalisation, { comment: '' } is falsy and JSZip re-emits the
    // archive comment: the documented reason the helper clears the instance.
    const naive = await JSZip.loadAsync(await zip.generateAsync({ type: 'uint8array', comment: '' }));
    expect((naive as unknown as { comment: string }).comment).toBe('kept by JSZip');
    normalizeZipEntries(zip);
    const clean = await JSZip.loadAsync(await zip.generateAsync({ type: 'uint8array', comment: '' }));
    expect((clean as unknown as { comment: string | null }).comment || '').toBe('');
  });
});
