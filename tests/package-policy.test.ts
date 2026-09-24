// @vitest-environment jsdom
//
// T177: package part policy. Every part of a docx / xlsx is text,
// structural, unredactable or unknown; unredactable and unknown parts are
// reported to the host and the writer refuses to export them until the host
// passes allowUnredactable (informed-consent export, founder decision
// 2026-09-24). Also the unpacked-size guard (L4).
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import {
  classifyPart,
  describeUnredactablePart,
  collectUnredactableParts,
  embeddedObjectLabel,
  readContentTypes,
  contentTypeOf,
  resolvePartPath,
  relationshipsOf,
  unpackedSize,
  assertUnpackedSize,
  MAX_UNPACKED_BYTES,
  DOCX_TEXT_PARTS,
  DOCX_STRUCTURAL_PARTS,
  DOCX_UNREDACTABLE_PARTS,
  XLSX_TEXT_PARTS,
  XLSX_STRUCTURAL_PARTS,
  XLSX_UNREDACTABLE_PARTS,
} from '../src/dom/package-policy.ts';
import type { PackageKind, PartClass } from '../src/dom/package-policy.ts';
import { readDocx, writeAnonymizedDocx, writeAnonymizedDocxWithReport } from '../src/dom/docx.ts';
import { readXlsx, writeAnonymizedXlsx, writeAnonymizedXlsxWithReport } from '../src/dom/xlsx.ts';
import { UnsupportedDocumentError } from '../src/dom/errors.ts';
import { assertNoTrace, findTraces, toBytes } from './helpers/package-scan.ts';
import {
  buildDocxFixture,
  buildDocxEmbedding,
  buildDocxVba,
  buildDocxAltChunk,
  buildDocxEverything,
  buildXlsxFixture,
  DOCX_SEED,
  XLSX_SEED,
  NS,
  REL_TYPE,
  CONTENT_TYPE,
  XML_DECL,
  relationshipsXml,
  contentTypesXml,
  zipPackage,
} from './helpers/fixtures/index.ts';

// ---------------------------------------------------------------------------
// Calibration inventory: part names seen in real files. Sources: Word 365
// (Windows and Mac, including .docm, charts, SmartArt, building blocks,
// embedded fonts, add-ins, ink, editor data), LibreOffice Writer export,
// Google Docs export, Apple Pages export, Excel 365 (.xlsx and .xlsm,
// charts, pivots, Power Query, Power Pivot, slicers, threaded comments,
// rich data) and LibreOffice Calc export. Every name must classify as
// text, structural or unredactable; 'unknown' means the tables drifted.
// ---------------------------------------------------------------------------

type Expected = Exclude<PartClass, 'unknown'>;

const DOCX_INVENTORY: ReadonlyArray<[string, Expected]> = [
  // OPC skeleton (every generator)
  ['[Content_Types].xml', 'structural'],
  ['_rels/.rels', 'structural'],
  ['docProps/app.xml', 'structural'],
  ['docProps/core.xml', 'structural'],
  ['docProps/custom.xml', 'structural'],
  ['docProps/thumbnail.jpeg', 'structural'],
  ['docProps/thumbnail.emf', 'structural'],
  // Main document and its companions (Word 365, LibreOffice, Google Docs, Pages)
  ['word/document.xml', 'text'],
  ['word/_rels/document.xml.rels', 'structural'],
  ['word/styles.xml', 'structural'],
  ['word/stylesWithEffects.xml', 'structural'],
  ['word/settings.xml', 'structural'],
  ['word/_rels/settings.xml.rels', 'structural'],
  ['word/webSettings.xml', 'text'],
  ['word/fontTable.xml', 'structural'],
  ['word/_rels/fontTable.xml.rels', 'structural'],
  ['word/numbering.xml', 'text'],
  ['word/theme/theme1.xml', 'structural'],
  ['word/theme/themeOverride1.xml', 'structural'],
  // Headers, footers, notes, comments
  ['word/header1.xml', 'text'],
  ['word/header2.xml', 'text'],
  ['word/header3.xml', 'text'],
  ['word/footer1.xml', 'text'],
  ['word/_rels/header1.xml.rels', 'structural'],
  ['word/footnotes.xml', 'text'],
  ['word/_rels/footnotes.xml.rels', 'structural'],
  ['word/endnotes.xml', 'text'],
  ['word/comments.xml', 'text'],
  ['word/_rels/comments.xml.rels', 'structural'],
  ['word/commentsExtended.xml', 'structural'],
  ['word/commentsIds.xml', 'structural'],
  ['word/commentsExtensible.xml', 'structural'],
  ['word/people.xml', 'structural'],
  // Media (known limit: no OCR)
  ['word/media/image1.png', 'structural'],
  ['word/media/image2.jpeg', 'structural'],
  ['word/media/image3.jpg', 'structural'],
  ['word/media/image4.emf', 'structural'],
  ['word/media/image5.wmf', 'structural'],
  ['word/media/image6.gif', 'structural'],
  ['word/media/image7.svg', 'structural'],
  ['word/media/image8.tiff', 'structural'],
  ['word/media/hdphoto1.wdp', 'structural'],
  ['word/media/media1.mp4', 'structural'],
  // Embedded fonts (Word .odttf, LibreOffice .ttf, Google Docs .fntdata)
  ['word/fonts/font1.odttf', 'structural'],
  ['word/fonts/font1.ttf', 'structural'],
  ['word/fonts/font1.fntdata', 'structural'],
  // Charts (Word 365, Pages) and chart user shapes
  ['word/charts/chart1.xml', 'text'],
  ['word/charts/chart12.xml', 'text'],
  ['word/charts/chartEx1.xml', 'text'],
  ['word/charts/style1.xml', 'structural'],
  ['word/charts/colors1.xml', 'structural'],
  ['word/charts/_rels/chart1.xml.rels', 'structural'],
  ['word/drawings/drawing1.xml', 'text'],
  // SmartArt
  ['word/diagrams/data1.xml', 'text'],
  ['word/diagrams/drawing1.xml', 'text'],
  ['word/diagrams/layout1.xml', 'structural'],
  ['word/diagrams/quickStyle1.xml', 'structural'],
  ['word/diagrams/colors1.xml', 'structural'],
  ['word/diagrams/_rels/data1.xml.rels', 'structural'],
  // Building blocks (glossary subdocument)
  ['word/glossary/document.xml', 'text'],
  ['word/glossary/_rels/document.xml.rels', 'structural'],
  ['word/glossary/styles.xml', 'structural'],
  ['word/glossary/settings.xml', 'structural'],
  ['word/glossary/fontTable.xml', 'structural'],
  ['word/glossary/webSettings.xml', 'text'],
  ['word/glossary/numbering.xml', 'text'],
  ['word/glossary/footnotes.xml', 'text'],
  ['word/glossary/header1.xml', 'text'],
  ['word/glossary/media/image1.png', 'structural'],
  // Custom XML data stores (cover page, bibliography, SharePoint)
  ['customXml/item1.xml', 'text'],
  ['customXml/item2.xml', 'text'],
  ['customXml/itemProps1.xml', 'structural'],
  ['customXml/_rels/item1.xml.rels', 'structural'],
  // Embedded objects (chart workbooks, OLE)
  ['word/embeddings/Microsoft_Excel_Worksheet.xlsx', 'unredactable'],
  ['word/embeddings/Microsoft_Excel_Worksheet1.xlsx', 'unredactable'],
  ['word/embeddings/Microsoft_Excel_Macro-Enabled_Worksheet1.xlsm', 'unredactable'],
  ['word/embeddings/Microsoft_Word_Document.docx', 'unredactable'],
  ['word/embeddings/Microsoft_PowerPoint_Presentation.pptx', 'unredactable'],
  ['word/embeddings/Microsoft_Visio_Drawing.vsdx', 'unredactable'],
  ['word/embeddings/oleObject1.bin', 'unredactable'],
  ['word/embeddings/Object 1.xlsx', 'unredactable'],
  // Macros (.docm)
  ['word/vbaProject.bin', 'unredactable'],
  ['word/vbaData.xml', 'unredactable'],
  ['word/vbaProjectSignature.bin', 'unredactable'],
  ['word/_rels/vbaProject.bin.rels', 'structural'],
  // HTML chunks, printer settings, ActiveX, editor data
  ['word/afchunk.mht', 'unredactable'],
  ['word/afchunk1.htm', 'unredactable'],
  ['word/printerSettings/printerSettings1.bin', 'unredactable'],
  ['word/activeX/activeX1.xml', 'unredactable'],
  ['word/activeX/activeX1.bin', 'unredactable'],
  ['word/activeX/_rels/activeX1.xml.rels', 'structural'],
  ['word/intelligence.xml', 'unredactable'],
  ['word/intelligence2.xml', 'unredactable'],
  // Add-ins, ink, legacy VML parts
  ['word/webextensions/taskpanes.xml', 'structural'],
  ['word/webextensions/webextension1.xml', 'structural'],
  ['word/webextensions/_rels/taskpanes.xml.rels', 'structural'],
  ['word/ink/ink1.xml', 'structural'],
  ['word/vmlDrawing1.vml', 'structural'],
];

const XLSX_INVENTORY: ReadonlyArray<[string, Expected]> = [
  ['[Content_Types].xml', 'structural'],
  ['_rels/.rels', 'structural'],
  ['docProps/app.xml', 'structural'],
  ['docProps/core.xml', 'structural'],
  ['docProps/custom.xml', 'structural'],
  ['docProps/thumbnail.jpeg', 'structural'],
  // Workbook skeleton (Excel 365, LibreOffice Calc)
  ['xl/workbook.xml', 'structural'],
  ['xl/_rels/workbook.xml.rels', 'structural'],
  ['xl/styles.xml', 'structural'],
  ['xl/sharedStrings.xml', 'text'],
  ['xl/theme/theme1.xml', 'structural'],
  ['xl/calcChain.xml', 'structural'],
  ['xl/metadata.xml', 'structural'],
  // Sheets
  ['xl/worksheets/sheet1.xml', 'text'],
  ['xl/worksheets/sheet2.xml', 'text'],
  ['xl/worksheets/_rels/sheet1.xml.rels', 'structural'],
  ['xl/chartsheets/sheet1.xml', 'structural'],
  ['xl/chartsheets/_rels/sheet1.xml.rels', 'structural'],
  ['xl/dialogsheets/sheet1.xml', 'structural'],
  // Comments
  ['xl/comments1.xml', 'text'],
  ['xl/threadedComments/threadedComment1.xml', 'text'],
  ['xl/persons/person.xml', 'structural'],
  // Drawings and charts
  ['xl/drawings/drawing1.xml', 'text'],
  ['xl/drawings/vmlDrawing1.vml', 'structural'],
  ['xl/drawings/_rels/drawing1.xml.rels', 'structural'],
  ['xl/drawings/_rels/vmlDrawing1.vml.rels', 'structural'],
  ['xl/charts/chart1.xml', 'text'],
  ['xl/charts/chartEx1.xml', 'text'],
  ['xl/charts/style1.xml', 'structural'],
  ['xl/charts/colors1.xml', 'structural'],
  ['xl/charts/_rels/chart1.xml.rels', 'structural'],
  ['xl/media/image1.png', 'structural'],
  ['xl/media/image2.emf', 'structural'],
  // Tables, pivots, slicers, timelines, sheet views
  ['xl/tables/table1.xml', 'structural'],
  ['xl/pivotTables/pivotTable1.xml', 'structural'],
  ['xl/pivotTables/_rels/pivotTable1.xml.rels', 'structural'],
  ['xl/pivotCache/pivotCacheDefinition1.xml', 'structural'],
  ['xl/pivotCache/pivotCacheRecords1.xml', 'structural'],
  ['xl/pivotCache/_rels/pivotCacheDefinition1.xml.rels', 'structural'],
  ['xl/slicers/slicer1.xml', 'structural'],
  ['xl/slicerCaches/slicerCache1.xml', 'structural'],
  ['xl/timelines/timeline1.xml', 'structural'],
  ['xl/timelineCaches/timelineCache1.xml', 'structural'],
  ['xl/namedSheetViews/namedSheetView1.xml', 'structural'],
  // Rich data (data types, images in cells), add-ins, Power Query
  ['xl/richData/rdrichvalue.xml', 'structural'],
  ['xl/richData/rdrichvaluestructure.xml', 'structural'],
  ['xl/richData/rdRichValueTypes.xml', 'structural'],
  ['xl/richData/richValueRel.xml', 'structural'],
  ['xl/richData/_rels/richValueRel.xml.rels', 'structural'],
  ['xl/webextensions/taskpanes.xml', 'structural'],
  ['customXml/item1.xml', 'structural'],
  ['customXml/itemProps1.xml', 'structural'],
  ['customXml/_rels/item1.xml.rels', 'structural'],
  // Controls, printer settings
  ['xl/ctrlProps/ctrlProp1.xml', 'structural'],
  ['xl/printerSettings/printerSettings1.bin', 'unredactable'],
  // External data, links, data model
  ['xl/connections.xml', 'unredactable'],
  ['xl/queryTables/queryTable1.xml', 'unredactable'],
  ['xl/externalLinks/externalLink1.xml', 'unredactable'],
  ['xl/externalLinks/_rels/externalLink1.xml.rels', 'structural'],
  ['xl/model/item.data', 'unredactable'],
  // Embedded objects, ActiveX, macros (.xlsm)
  ['xl/embeddings/oleObject1.bin', 'unredactable'],
  ['xl/embeddings/Microsoft_Word_Document.docx', 'unredactable'],
  ['xl/activeX/activeX1.xml', 'unredactable'],
  ['xl/activeX/activeX1.bin', 'unredactable'],
  ['xl/vbaProject.bin', 'unredactable'],
  ['xl/vbaProjectSignature.bin', 'unredactable'],
  ['xl/macrosheets/sheet1.xml', 'unredactable'],
];

describe('classifyPart calibration inventory (T177)', () => {
  it('holds at least 60 real-world names per format', () => {
    expect(DOCX_INVENTORY.length).toBeGreaterThanOrEqual(60);
    expect(XLSX_INVENTORY.length).toBeGreaterThanOrEqual(60);
  });

  for (const [path, expected] of DOCX_INVENTORY) {
    it(`docx: ${path} is ${expected}`, () => {
      expect(classifyPart(path, 'docx')).toBe(expected);
    });
  }

  for (const [path, expected] of XLSX_INVENTORY) {
    it(`xlsx: ${path} is ${expected}`, () => {
      expect(classifyPart(path, 'xlsx')).toBe(expected);
    });
  }

  it('classifies every name of the T196 corpus inventory (tests/corpus/part-inventory.json) as known', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const file = join(here, 'corpus', 'part-inventory.json');
    if (!existsSync(file)) return;
    const inventory = JSON.parse(readFileSync(file, 'utf8')) as Partial<Record<PackageKind, string[]>>;
    for (const kind of ['docx', 'xlsx'] as const) {
      for (const folded of inventory[kind] ?? []) {
        const path = folded.replace(/#/g, '1');
        expect(classifyPart(path, kind), `${kind}: ${path}`).not.toBe('unknown');
      }
    }
  });

  it('exports the tables so hosts can inspect the policy', () => {
    expect(DOCX_TEXT_PARTS.length).toBeGreaterThan(0);
    expect(DOCX_STRUCTURAL_PARTS.length).toBeGreaterThan(0);
    expect(DOCX_UNREDACTABLE_PARTS.length).toBeGreaterThan(0);
    expect(XLSX_TEXT_PARTS.length).toBeGreaterThan(0);
    expect(XLSX_STRUCTURAL_PARTS.length).toBeGreaterThan(0);
    expect(XLSX_UNREDACTABLE_PARTS.length).toBeGreaterThan(0);
  });

  it('reports anything else as unknown with a labelled record', () => {
    expect(classifyPart('word/mystery.xml', 'docx')).toBe('unknown');
    expect(classifyPart('xl/customProperty1.bin', 'xlsx')).toBe('unknown');
    expect(classifyPart('word/document.xml', 'xlsx')).toBe('unknown');
    expect(describeUnredactablePart('word/mystery.xml', 'docx')).toEqual({
      part: 'word/mystery.xml', kind: 'unknown', label: 'unrecognised part word/mystery.xml',
    });
    expect(describeUnredactablePart('word/document.xml', 'docx')).toBeNull();
    expect(describeUnredactablePart('word/styles.xml', 'docx')).toBeNull();
  });

  it('derives kinds and labels from the tables', () => {
    expect(describeUnredactablePart('word/vbaProject.bin', 'docx')).toEqual({ part: 'word/vbaProject.bin', kind: 'macros', label: 'macros' });
    expect(describeUnredactablePart('word/afchunk.mht', 'docx')).toEqual({ part: 'word/afchunk.mht', kind: 'html-chunk', label: 'HTML chunk' });
    expect(describeUnredactablePart('word/printerSettings/printerSettings1.bin', 'docx')?.kind).toBe('printer-settings');
    expect(describeUnredactablePart('word/intelligence2.xml', 'docx')).toEqual({ part: 'word/intelligence2.xml', kind: 'unknown', label: 'editor analysis data' });
    expect(describeUnredactablePart('word/activeX/activeX1.bin', 'docx')).toEqual({ part: 'word/activeX/activeX1.bin', kind: 'embedded-object', label: 'ActiveX control' });
    expect(describeUnredactablePart('xl/connections.xml', 'xlsx')).toEqual({ part: 'xl/connections.xml', kind: 'external-data', label: 'external data connection' });
    expect(describeUnredactablePart('xl/queryTables/queryTable1.xml', 'xlsx')?.kind).toBe('external-data');
    expect(describeUnredactablePart('xl/externalLinks/externalLink1.xml', 'xlsx')?.kind).toBe('external-data');
  });

  it('labels embedded objects from the content type, with the extension as fallback', () => {
    expect(embeddedObjectLabel('word/embeddings/oleObject1.bin', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('embedded Excel sheet');
    expect(embeddedObjectLabel('word/embeddings/oleObject1.bin', 'application/vnd.ms-excel')).toBe('embedded Excel sheet');
    expect(embeddedObjectLabel('word/embeddings/oleObject1.bin', 'application/x-excel')).toBe('embedded Excel sheet');
    expect(embeddedObjectLabel('word/embeddings/x.bin', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('embedded document');
    expect(embeddedObjectLabel('word/embeddings/x.bin', 'application/vnd.openxmlformats-officedocument.oleObject')).toBe('embedded object');
    expect(embeddedObjectLabel('word/embeddings/x.bin', null)).toBe('embedded object');
    expect(embeddedObjectLabel('word/embeddings/Book1.xlsx', null)).toBe('embedded Excel sheet');
    expect(embeddedObjectLabel('word/embeddings/Doc1.docx', null)).toBe('embedded document');
  });
});

// ---------------------------------------------------------------------------
// Fixtures through the readers
// ---------------------------------------------------------------------------

async function bytesToFile(bytes: Uint8Array, name: string): Promise<File> {
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const file = new File([ab], name);
  if (typeof file.arrayBuffer !== 'function') {
    Object.defineProperty(file, 'arrayBuffer', { value: async () => ab });
  }
  return file;
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

async function expectCode(run: () => Promise<unknown>, code: string): Promise<UnsupportedDocumentError> {
  let caught: unknown;
  try {
    await run();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(UnsupportedDocumentError);
  expect((caught as UnsupportedDocumentError).code).toBe(code);
  return caught as UnsupportedDocumentError;
}

describe('readDocx reports unredactable parts (T177)', () => {
  it('embedded workbook and OLE object: kind and content-type label', async () => {
    const extraction = await readDocx(await bytesToFile(await buildDocxEmbedding(), 'embedding.docx'));
    expect(extraction.unredactable).toEqual([
      { part: 'word/embeddings/Microsoft_Excel_Worksheet1.xlsx', kind: 'embedded-object', label: 'embedded Excel sheet' },
      { part: 'word/embeddings/oleObject1.bin', kind: 'embedded-object', label: 'embedded object' },
    ]);
    expect(extraction.plainText).toContain(DOCX_SEED.body);
  });

  it('vbaProject.bin: macros', async () => {
    const extraction = await readDocx(await bytesToFile(await buildDocxVba(), 'macros.docm'));
    expect(extraction.unredactable).toEqual([{ part: 'word/vbaProject.bin', kind: 'macros', label: 'macros' }]);
  });

  it('afchunk.mht: html-chunk', async () => {
    const extraction = await readDocx(await bytesToFile(await buildDocxAltChunk(), 'chunk.docx'));
    expect(extraction.unredactable).toEqual([{ part: 'word/afchunk.mht', kind: 'html-chunk', label: 'HTML chunk' }]);
  });

  it('a part referenced by w:altChunk under any name is an html-chunk', async () => {
    const bytes = await zipPackage({
      '[Content_Types].xml': contentTypesXml({
        defaults: { rels: CONTENT_TYPE.rels, xml: CONTENT_TYPE.xml, htm: 'text/html' },
        overrides: { '/word/document.xml': CONTENT_TYPE.docMain },
      }),
      '_rels/.rels': relationshipsXml([{ id: 'rId1', type: REL_TYPE.officeDocument, target: 'word/document.xml' }]),
      'word/document.xml': `${XML_DECL}<w:document xmlns:w="${NS.W}" xmlns:r="${NS.R}"><w:body><w:p><w:r><w:t>hello</w:t></w:r></w:p><w:altChunk r:id="rIdChunk"/></w:body></w:document>`,
      'word/_rels/document.xml.rels': relationshipsXml([{ id: 'rIdChunk', type: REL_TYPE.aFChunk, target: 'chunks/pasted1.htm' }]),
      'word/chunks/pasted1.htm': '<html><body>pasted@leak.example</body></html>',
    });
    const extraction = await readDocx(await bytesToFile(bytes, 'chunk.docx'));
    expect(extraction.unredactable).toEqual([{ part: 'word/chunks/pasted1.htm', kind: 'html-chunk', label: 'HTML chunk' }]);
  });

  it('an unrecognised part is reported as unknown, a clean document reports nothing', async () => {
    const clean = await readDocx(await bytesToFile(await buildDocxFixture({ chart: true, diagram: true, customXml: true, numbering: true }), 'clean.docx'));
    expect(clean.unredactable).toEqual([]);

    const bytes = await zipPackage({
      '[Content_Types].xml': contentTypesXml({ defaults: { rels: CONTENT_TYPE.rels, xml: CONTENT_TYPE.xml }, overrides: { '/word/document.xml': CONTENT_TYPE.docMain } }),
      '_rels/.rels': relationshipsXml([{ id: 'rId1', type: REL_TYPE.officeDocument, target: 'word/document.xml' }]),
      'word/document.xml': `${XML_DECL}<w:document xmlns:w="${NS.W}"><w:body><w:p><w:r><w:t>hello</w:t></w:r></w:p></w:body></w:document>`,
      'word/mystery.xml': `${XML_DECL}<mystery>who knows</mystery>`,
    });
    const extraction = await readDocx(await bytesToFile(bytes, 'mystery.docx'));
    expect(extraction.unredactable).toEqual([{ part: 'word/mystery.xml', kind: 'unknown', label: 'unrecognised part word/mystery.xml' }]);
  });
});

describe('writeAnonymizedDocx gate: allowUnredactable (T177)', () => {
  it('throws unredactable-parts with the part names before touching the extraction', async () => {
    const extraction = await readDocx(await bytesToFile(await buildDocxEmbedding(), 'embedding.docx'));
    const plainBefore = extraction.plainText;
    const nodesBefore = extraction.textNodes.map((n) => [n.flatStart, n.flatEnd]);
    const err = await expectCode(() => writeAnonymizedDocx(extraction, [], []), 'unredactable-parts');
    expect(err.details).toEqual(['word/embeddings/Microsoft_Excel_Worksheet1.xlsx', 'word/embeddings/oleObject1.bin']);
    expect(err.message).toContain('embedded Excel sheet');
    // The same extraction can be written after the user consented.
    expect(extraction.plainText).toBe(plainBefore);
    expect(extraction.textNodes.map((n) => [n.flatStart, n.flatEnd])).toEqual(nodesBefore);
    const result = await writeAnonymizedDocxWithReport(extraction, [], [], { allowUnredactable: true });
    expect(result.blob).toBeInstanceOf(Blob);
  });

  it('with allowUnredactable: exports, names the parts in warnings, layer zero and units still scrub every XML-borne seed', async () => {
    const extraction = await readDocx(await bytesToFile(await buildDocxEverything(), 'everything.docx'));
    expect(extraction.unredactable.map((p) => p.part)).toEqual([
      'word/afchunk.mht',
      'word/embeddings/Microsoft_Excel_Worksheet1.xlsx',
      'word/embeddings/oleObject1.bin',
      'word/vbaProject.bin',
    ]);

    const binarySeeds = [DOCX_SEED.altChunk, DOCX_SEED.embeddedXlsx, DOCX_SEED.embeddedOle, DOCX_SEED.vba];
    const xmlSeeds = Object.values(DOCX_SEED).filter((seed) => !binarySeeds.includes(seed as typeof binarySeeds[number]));
    const valueReplacements = xmlSeeds.map((value, i) => ({ value, replacement: `[SEED_${i + 1}]` }));
    const replacements: Array<{ start: number; end: number; replacement: string }> = [];
    for (const pair of valueReplacements) {
      for (const range of findAll(extraction.plainText, pair.value)) replacements.push({ ...range, replacement: pair.replacement });
    }

    const result = await writeAnonymizedDocxWithReport(extraction, replacements, valueReplacements, { allowUnredactable: true });
    for (const part of ['word/afchunk.mht', 'word/embeddings/Microsoft_Excel_Worksheet1.xlsx', 'word/embeddings/oleObject1.bin', 'word/vbaProject.bin']) {
      expect(result.warnings.some((w) => w.startsWith(`${part}:`) && w.includes('copied verbatim')), part).toBe(true);
    }
    await assertNoTrace(result.blob, xmlSeeds);

    // By design (informed consent): the binary payloads leave untouched. The
    // list of surviving parts is exactly the reported unredactable list.
    const traces = await findTraces(result.blob, binarySeeds);
    // '<archive>' is the raw outer zip (stored entries repeat their bytes there).
    const survivingParts = new Set(traces.map((t) => t.part.split('!')[0]).filter((p) => p !== '<archive>'));
    expect([...survivingParts].sort()).toEqual([
      'word/afchunk.mht',
      'word/embeddings/Microsoft_Excel_Worksheet1.xlsx',
      'word/embeddings/oleObject1.bin',
      'word/vbaProject.bin',
    ]);
    for (const seed of binarySeeds) expect(traces.some((t) => t.needle === seed), seed).toBe(true);
  });
});

describe('readXlsx and writeAnonymizedXlsx gate (T177)', () => {
  it('connections.xml and externalLinks are reported as external-data', async () => {
    const extraction = await readXlsx(await bytesToFile(await buildXlsxFixture({ connections: true, externalLinks: true }), 'ext.xlsx'));
    expect(extraction.unredactable).toEqual([
      { part: 'xl/connections.xml', kind: 'external-data', label: 'external data connection' },
      { part: 'xl/externalLinks/externalLink1.xml', kind: 'external-data', label: 'external workbook link' },
    ]);
    expect(extraction.plainText).toContain(XLSX_SEED.shared);
  });

  it('a workbook with drawings, pivots and rich data only reports nothing', async () => {
    const extraction = await readXlsx(await bytesToFile(await buildXlsxFixture({ drawing: true, pivot: true, richData: true, vml: true }), 'ok.xlsx'));
    expect(extraction.unredactable).toEqual([]);
  });

  it('throws unredactable-parts without the option and exports with it, naming the parts', async () => {
    const build = async () => readXlsx(await bytesToFile(await buildXlsxFixture({ connections: true }), 'conn.xlsx'));
    const err = await expectCode(async () => writeAnonymizedXlsx(await build(), [], []), 'unredactable-parts');
    expect(err.details).toEqual(['xl/connections.xml']);
    await expectCode(async () => writeAnonymizedXlsxWithReport(await build(), [], [], { allowUnredactable: false }), 'unredactable-parts');

    const extraction = await build();
    const replacements = findAll(extraction.plainText, XLSX_SEED.shared).map((r) => ({ ...r, replacement: '[EMAIL_1]' }));
    const result = await writeAnonymizedXlsxWithReport(extraction, replacements, [{ value: XLSX_SEED.shared, replacement: '[EMAIL_1]' }], { allowUnredactable: true });
    expect(result.warnings).toEqual(['xl/connections.xml: external data connection, copied verbatim (not redacted)']);
    await assertNoTrace(result.blob, [XLSX_SEED.shared]);
    const out = await JSZip.loadAsync(await toBytes(result.blob));
    expect(out.file('xl/connections.xml')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Content types, relationships, size guard
// ---------------------------------------------------------------------------

describe('content types and relationships helpers (T177)', () => {
  it('reads Override and Default entries and resolves relationship targets', async () => {
    const zip = await JSZip.loadAsync(await buildDocxEmbedding());
    const index = await readContentTypes(zip);
    expect(contentTypeOf(index, 'word/embeddings/oleObject1.bin')).toBe('application/vnd.openxmlformats-officedocument.oleObject');
    expect(contentTypeOf(index, 'word/embeddings/Microsoft_Excel_Worksheet1.xlsx')).toBe(CONTENT_TYPE.xlsxEmbed);
    expect(contentTypeOf(index, 'word/nothing.zzz')).toBeNull();

    const rels = await relationshipsOf(zip, 'word/document.xml');
    expect(rels.get('rIdEmbedXlsx')?.path).toBe('word/embeddings/Microsoft_Excel_Worksheet1.xlsx');
    expect(rels.get('rIdEmbedXlsx')?.external).toBe(false);
    expect(await relationshipsOf(zip, 'word/none.xml')).toEqual(new Map());
  });

  it('resolvePartPath handles relative, parent and absolute targets', () => {
    expect(resolvePartPath('word/document.xml', 'charts/chart1.xml')).toBe('word/charts/chart1.xml');
    expect(resolvePartPath('word/document.xml', '../customXml/item1.xml')).toBe('customXml/item1.xml');
    expect(resolvePartPath('word/charts/chart1.xml', '../embeddings/book.xlsx')).toBe('word/embeddings/book.xlsx');
    expect(resolvePartPath('word/document.xml', '/word/afchunk.mht')).toBe('word/afchunk.mht');
    expect(resolvePartPath('word/document.xml', './media/image1.png')).toBe('word/media/image1.png');
  });

  it('collectUnredactableParts never throws and sorts by part name', async () => {
    const zip = new JSZip();
    zip.file('word/document.xml', '<w/>');
    zip.file('word/zeta.bin', new Uint8Array([1]));
    zip.file('word/alpha.bin', new Uint8Array([1]));
    const parts = await collectUnredactableParts(zip, 'docx');
    expect(parts.map((p) => p.part)).toEqual(['word/alpha.bin', 'word/zeta.bin']);
    expect(parts.every((p) => p.kind === 'unknown')).toBe(true);
  });
});

describe('unpacked-size guard (T177, L4)', () => {
  it('sums the declared uncompressed sizes of a loaded package', async () => {
    const bytes = await buildDocxFixture();
    const zip = await JSZip.loadAsync(bytes);
    const total = unpackedSize(zip);
    let expected = 0;
    for (const path of Object.keys(zip.files)) {
      const f = zip.file(path);
      if (f) expected += (await f.async('uint8array')).length;
    }
    expect(total).toBe(expected);
    expect(total).toBeGreaterThan(0);
    expect(() => assertUnpackedSize(zip)).not.toThrow();
    expect(MAX_UNPACKED_BYTES).toBe(200 * 1024 * 1024);
  });

  it('readDocx and readXlsx refuse a package above the limit with too-large before parsing', async () => {
    const docx = await bytesToFile(await buildDocxFixture(), 'big.docx');
    const err = await expectCode(() => readDocx(docx, { maxUnpackedBytes: 64 }), 'too-large');
    expect(err.details).toHaveLength(2);
    expect(Number(err.details[0])).toBeGreaterThan(64);
    expect(err.details[1]).toBe('64');
    await expect(readDocx(docx)).resolves.toBeTruthy();

    const xlsx = await bytesToFile(await buildXlsxFixture(), 'big.xlsx');
    await expectCode(() => readXlsx(xlsx, { maxUnpackedBytes: 64 }), 'too-large');
    await expect(readXlsx(xlsx)).resolves.toBeTruthy();
  });

  it('assertUnpackedSize trusts the directory sizes, not the compressed bytes', async () => {
    // 1 MB of zeros deflates to a few hundred bytes; the guard must see 1 MB.
    const zip = new JSZip();
    zip.file('word/document.xml', new Uint8Array(1024 * 1024), { compression: 'DEFLATE' });
    const reloaded = await JSZip.loadAsync(await zip.generateAsync({ type: 'uint8array' }));
    expect(unpackedSize(reloaded)).toBe(1024 * 1024);
    expect(() => assertUnpackedSize(reloaded, 1024 * 1024 - 1)).toThrow(UnsupportedDocumentError);
    expect(() => assertUnpackedSize(reloaded, 1024 * 1024)).not.toThrow();
  });
});
