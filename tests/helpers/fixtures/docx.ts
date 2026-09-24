// Synthetic .docx fixtures reproducing SECURITY_REPORT-2026-09 findings
// H1 (strict OOXML), H3 (parts outside the allow-list), M1 (attributes),
// M2 (delInstrText), M3 (text boxes, tab / noBreakHyphen inside an entity).
//
// Every generator is pure and returns Promise<Uint8Array>. The DOCX_SEED map
// documents the exact needle each option plants and in which part. The
// *_SEEDS arrays next to each generator are what tests/helpers/fixtures.test.ts
// verifies against the raw bytes.

import CFB from 'cfb';
import {
  NS,
  REL_TYPE,
  CONTENT_TYPE,
  XML_DECL,
  relationshipsXml,
  contentTypesXml,
  zipPackage,
  latin1,
  escapeXml,
  type Relationship,
  type Seed,
  type FixtureSpec,
  type PackageEntries,
} from './shared.ts';

/** Every needle a docx fixture can plant. Keys mirror DocxFixtureOptions. */
export const DOCX_SEED = {
  body: 'bodytext@leak.example',
  chartCategory: 'chartcategory@leak.example',
  chartTitle: 'charttitle@leak.example',
  diagram: 'smartart@leak.example',
  customXml: 'coverpage@leak.example',
  docVar: 'docvar@leak.example',
  altChunk: 'altchunk@leak.example',
  embeddedXlsx: 'embeddedcell@leak.example',
  embeddedOle: 'LEAK_OLE_NATIVE_BYTES',
  vba: 'LEAK_VBA_MODULE_SOURCE',
  omml: 'mathperson@leak.example',
  delInstrText: 'delinstr@leak.example',
  textboxTwin: 'txbxtwin@leak.example',
  textboxBefore: 'LEAK_TXBX_BEFORE',
  textboxAfter: 'LEAK_TXBX_AFTER',
  tabLeft: 'tabfirst@leak',
  tabRight: 'tabsecond.example',
  hyphenLeft: 'Call 555',
  hyphenRight: '0199 now',
  fldSimpleInstr: 'fldsimple@leak.example',
  hyperlinkTooltip: 'tooltip@leak.example',
  hyperlinkTarget: 'mailto:linktarget@leak.example',
  bookmarkName: 'LEAK_BOOKMARK_NAME',
  sdtTag: 'LEAK_SDT_TAG',
  sdtAlias: 'LEAK_SDT_ALIAS',
  docPrDescr: 'docprdescr@leak.example',
  numbering: 'numbering@leak.example',
} as const;

export interface DocxFixtureOptions {
  /** Use the Strict OOXML namespaces (purl.oclc.org) instead of transitional. H1. */
  strict?: boolean;
  /** word/charts/chart1.xml with c:strCache values and a rich-text title. H3. */
  chart?: boolean;
  /** word/diagrams/data1.xml (SmartArt) with dgm:t text. H3. */
  diagram?: boolean;
  /** customXml/item1.xml (cover page properties). H3. */
  customXml?: boolean;
  /** word/settings.xml w:docVars/w:docVar@w:val. H3. */
  docVars?: boolean;
  /** w:altChunk pointing at word/afchunk.mht. H3. */
  altChunk?: boolean;
  /** word/embeddings/Microsoft_Excel_Worksheet1.xlsx (nested zip) and oleObject1.bin (CFB). H3. */
  embedding?: boolean;
  /** word/vbaProject.bin as a CFB with a VBA/Module1 stream. H3. */
  vba?: boolean;
  /** OMML m:t inside document.xml. H3. */
  omml?: boolean;
  /** w:delInstrText inside a w:del. M2. */
  delInstrText?: boolean;
  /** wps text box in mc:Choice with an identical v:textbox twin in mc:Fallback, surrounded by body runs. M3. */
  textbox?: boolean;
  /** w:tab and w:noBreakHyphen splitting an entity across runs. M3. */
  tabHyphen?: boolean;
  /** PII only in attributes: fldSimple instr, hyperlink tooltip + rel target, bookmark name, sdt tag/alias, docPr descr. M1. */
  attributes?: boolean;
  /** word/numbering.xml w:lvlText@w:val. H3. */
  numbering?: boolean;
}

function run(text: string): string {
  return `<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

function para(inner: string): string {
  return `<w:p>${inner}</w:p>`;
}

function bodyXml(o: DocxFixtureOptions): string {
  const parts: string[] = [];
  parts.push(para(run(`Mail ${DOCX_SEED.body} now.`)));

  if (o.omml) {
    parts.push(para(`<m:oMathPara><m:oMath><m:r><m:t>${DOCX_SEED.omml}</m:t></m:r></m:oMath></m:oMathPara>`));
  }
  if (o.delInstrText) {
    parts.push(para(
      `<w:del w:id="9" w:author="Rev" w:date="2024-01-01T00:00:00Z">` +
      `<w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
      `<w:r><w:delInstrText xml:space="preserve"> HYPERLINK "mailto:${DOCX_SEED.delInstrText}" </w:delInstrText></w:r>` +
      `<w:r><w:fldChar w:fldCharType="end"/></w:r></w:del>`,
    ));
  }
  if (o.textbox) {
    const txbx = `<w:txbxContent>${para(run(DOCX_SEED.textboxTwin))}</w:txbxContent>`;
    parts.push(para(
      run(`Dear ${DOCX_SEED.textboxBefore}`) +
      `<w:r><mc:AlternateContent>` +
      `<mc:Choice Requires="wps"><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="1" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">` +
      `<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV>` +
      `<wp:extent cx="1800000" cy="360000"/><wp:wrapNone/><wp:docPr id="11" name="Text Box 1"/>` +
      `<a:graphic><a:graphicData uri="${NS.WPS}"><wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1800000" cy="360000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></wps:spPr>` +
      `<wps:txbx>${txbx}</wps:txbx><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice>` +
      `<mc:Fallback><w:pict><v:shape id="Text Box 1" type="#_x0000_t202" style="position:absolute;width:140pt;height:28pt"><v:textbox>${txbx}</v:textbox></v:shape></w:pict></mc:Fallback>` +
      `</mc:AlternateContent></w:r>` +
      run(`${DOCX_SEED.textboxAfter} regards`),
    ));
  }
  if (o.tabHyphen) {
    parts.push(para(`<w:r><w:t>${DOCX_SEED.tabLeft}</w:t><w:tab/><w:t>${DOCX_SEED.tabRight}</w:t></w:r>`));
    parts.push(para(`<w:r><w:t xml:space="preserve">${DOCX_SEED.hyphenLeft}</w:t><w:noBreakHyphen/><w:t xml:space="preserve">${DOCX_SEED.hyphenRight}.</w:t></w:r>`));
  }
  if (o.attributes) {
    parts.push(para(`<w:fldSimple w:instr=' HYPERLINK "mailto:${DOCX_SEED.fldSimpleInstr}" '>${run('click here')}</w:fldSimple>`));
    parts.push(para(`<w:hyperlink r:id="rIdHyper" w:tooltip="${DOCX_SEED.hyperlinkTooltip}">${run('our site')}</w:hyperlink>`));
    parts.push(para(`<w:bookmarkStart w:id="1" w:name="${DOCX_SEED.bookmarkName}"/>${run('bookmarked')}<w:bookmarkEnd w:id="1"/>`));
    parts.push(para(
      `<w:sdt><w:sdtPr><w:alias w:val="${DOCX_SEED.sdtAlias}"/><w:tag w:val="${DOCX_SEED.sdtTag}"/></w:sdtPr>` +
      `<w:sdtContent>${run('content control')}</w:sdtContent></w:sdt>`,
    ));
    parts.push(para(
      `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="914400" cy="914400"/>` +
      `<wp:docPr id="21" name="Shape 21" descr="${DOCX_SEED.docPrDescr}"/>` +
      `<a:graphic><a:graphicData uri="${NS.WPS}"><wps:wsp><wps:cNvSpPr/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></wps:spPr><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic>` +
      `</wp:inline></w:drawing></w:r>`,
    ));
  }
  if (o.numbering) {
    parts.push(para(`<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${run('numbered item')}`));
  }
  if (o.chart) {
    parts.push(para(
      `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="3600000" cy="2400000"/><wp:docPr id="31" name="Chart 1"/>` +
      `<a:graphic><a:graphicData uri="${NS.C}"><c:chart xmlns:c="${NS.C}" r:id="rIdChart"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`,
    ));
  }
  if (o.diagram) {
    parts.push(para(
      `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="3600000" cy="2400000"/><wp:docPr id="41" name="Diagram 1"/>` +
      `<a:graphic><a:graphicData uri="${NS.DGM}"><dgm:relIds xmlns:dgm="${NS.DGM}" r:dm="rIdDgmData" r:lo="" r:qs="" r:cs=""/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`,
    ));
  }
  if (o.embedding) {
    parts.push(para(
      `<w:r><w:object><v:shape id="_x0000_i1025" type="#_x0000_t75" style="width:100pt;height:50pt"/>` +
      `<o:OLEObject xmlns:o="urn:schemas-microsoft-com:office:office" Type="Embed" ProgID="Excel.Sheet.12" ShapeID="_x0000_i1025" DrawAspect="Content" ObjectID="_1" r:id="rIdEmbedXlsx"/></w:object></w:r>`,
    ));
  }
  if (o.altChunk) {
    parts.push(`<w:altChunk r:id="rIdChunk"/>`);
  }
  parts.push(`<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>`);
  return parts.join('\n');
}

function documentXml(o: DocxFixtureOptions): string {
  const w = o.strict ? NS.W_STRICT : NS.W;
  const r = o.strict ? NS.R_STRICT : NS.R;
  return `${XML_DECL}
<w:document xmlns:w="${w}" xmlns:r="${r}" xmlns:m="${NS.M}" xmlns:mc="${NS.MC}" xmlns:v="${NS.V}" xmlns:wps="${NS.WPS}" xmlns:wp="${NS.WP}" xmlns:a="${NS.A}">
<w:body>
${bodyXml(o)}
</w:body>
</w:document>`;
}

function cfbBytes(streams: Record<string, Uint8Array>): Uint8Array {
  const container = CFB.utils.cfb_new();
  for (const [name, content] of Object.entries(streams)) {
    CFB.utils.cfb_add(container, name, content);
  }
  return new Uint8Array(CFB.write(container, { type: 'array' }) as number[]);
}

/** A tiny but valid xlsx used as the embedded workbook. */
async function embeddedWorkbook(): Promise<Uint8Array> {
  return zipPackage({
    '[Content_Types].xml': contentTypesXml({
      defaults: { rels: CONTENT_TYPE.rels, xml: CONTENT_TYPE.xml },
      overrides: {
        '/xl/workbook.xml': CONTENT_TYPE.wbMain,
        '/xl/worksheets/sheet1.xml': CONTENT_TYPE.worksheet,
        '/xl/sharedStrings.xml': CONTENT_TYPE.sharedStrings,
      },
    }),
    '_rels/.rels': relationshipsXml([{ id: 'rId1', type: REL_TYPE.officeDocument, target: 'xl/workbook.xml' }]),
    'xl/workbook.xml': `${XML_DECL}<workbook xmlns="${NS.SS}" xmlns:r="${NS.R}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': relationshipsXml([
      { id: 'rId1', type: REL_TYPE.worksheet, target: 'worksheets/sheet1.xml' },
      { id: 'rId2', type: REL_TYPE.sharedStrings, target: 'sharedStrings.xml' },
    ]),
    'xl/sharedStrings.xml': `${XML_DECL}<sst xmlns="${NS.SS}" count="1" uniqueCount="1"><si><t>${DOCX_SEED.embeddedXlsx}</t></si></sst>`,
    'xl/worksheets/sheet1.xml': `${XML_DECL}<worksheet xmlns="${NS.SS}"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>`,
  });
}

/** Build a docx with any combination of the leak scenarios enabled. */
export async function buildDocxFixture(o: DocxFixtureOptions = {}): Promise<Uint8Array> {
  const w = o.strict ? NS.W_STRICT : NS.W;
  const relType = (t: string): string => (o.strict ? t.replace('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships') : t);

  const entries: PackageEntries = {};
  const overrides: Record<string, string> = { '/word/document.xml': CONTENT_TYPE.docMain };
  const defaults: Record<string, string> = { rels: CONTENT_TYPE.rels, xml: CONTENT_TYPE.xml };
  const docRels: Relationship[] = [];

  entries['_rels/.rels'] = relationshipsXml([{ id: 'rId1', type: relType(REL_TYPE.officeDocument), target: 'word/document.xml' }]);
  entries['word/document.xml'] = documentXml(o);

  if (o.chart) {
    docRels.push({ id: 'rIdChart', type: relType(REL_TYPE.chart), target: 'charts/chart1.xml' });
    overrides['/word/charts/chart1.xml'] = CONTENT_TYPE.chart;
    entries['word/charts/chart1.xml'] = `${XML_DECL}<c:chartSpace xmlns:c="${NS.C}" xmlns:a="${NS.A}" xmlns:r="${NS.R}"><c:chart>` +
      `<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${DOCX_SEED.chartTitle}</a:t></a:r></a:p></c:rich></c:tx></c:title>` +
      `<c:plotArea><c:barChart><c:barDir val="col"/><c:ser><c:idx val="0"/><c:order val="0"/>` +
      `<c:cat><c:strRef><c:f>Sheet1!$A$2</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${DOCX_SEED.chartCategory}</c:v></c:pt></c:strCache></c:strRef></c:cat>` +
      `<c:val><c:numRef><c:f>Sheet1!$B$2</c:f><c:numCache><c:ptCount val="1"/><c:pt idx="0"><c:v>1</c:v></c:pt></c:numCache></c:numRef></c:val>` +
      `</c:ser><c:axId val="1"/><c:axId val="2"/></c:barChart>` +
      `<c:catAx><c:axId val="1"/><c:scaling/><c:axPos val="b"/><c:crossAx val="2"/></c:catAx><c:valAx><c:axId val="2"/><c:scaling/><c:axPos val="l"/><c:crossAx val="1"/></c:valAx>` +
      `</c:plotArea></c:chart></c:chartSpace>`;
  }
  if (o.diagram) {
    docRels.push({ id: 'rIdDgmData', type: relType(REL_TYPE.diagramData), target: 'diagrams/data1.xml' });
    overrides['/word/diagrams/data1.xml'] = CONTENT_TYPE.diagramData;
    entries['word/diagrams/data1.xml'] = `${XML_DECL}<dgm:dataModel xmlns:dgm="${NS.DGM}" xmlns:a="${NS.A}"><dgm:ptLst>` +
      `<dgm:pt modelId="1"><dgm:prSet/><dgm:spPr/><dgm:t><a:bodyPr/><a:p><a:r><a:t>${DOCX_SEED.diagram}</a:t></a:r></a:p></dgm:t></dgm:pt>` +
      `</dgm:ptLst><dgm:cxnLst/></dgm:dataModel>`;
  }
  if (o.customXml) {
    docRels.push({ id: 'rIdCustomXml', type: relType(REL_TYPE.customXml), target: '../customXml/item1.xml' });
    entries['customXml/item1.xml'] = `${XML_DECL}<CoverPageProperties xmlns="http://schemas.microsoft.com/office/2006/coverPageProps"><PublishDate/><Abstract/><CompanyAddress/><CompanyPhone/><CompanyFax/><CompanyEmail>${DOCX_SEED.customXml}</CompanyEmail></CoverPageProperties>`;
    entries['customXml/itemProps1.xml'] = `${XML_DECL}<ds:datastoreItem ds:itemID="{11111111-2222-3333-4444-555555555555}" xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml"><ds:schemaRefs><ds:schemaRef ds:uri="http://schemas.microsoft.com/office/2006/coverPageProps"/></ds:schemaRefs></ds:datastoreItem>`;
    entries['customXml/_rels/item1.xml.rels'] = relationshipsXml([{ id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXmlProps', target: 'itemProps1.xml' }]);
  }
  if (o.docVars) {
    docRels.push({ id: 'rIdSettings', type: relType(REL_TYPE.settings), target: 'settings.xml' });
    overrides['/word/settings.xml'] = CONTENT_TYPE.settings;
    entries['word/settings.xml'] = `${XML_DECL}<w:settings xmlns:w="${w}"><w:zoom w:percent="100"/><w:docVars><w:docVar w:name="Recipient" w:val="${DOCX_SEED.docVar}"/></w:docVars></w:settings>`;
  }
  if (o.altChunk) {
    docRels.push({ id: 'rIdChunk', type: relType(REL_TYPE.aFChunk), target: 'afchunk.mht' });
    defaults['mht'] = CONTENT_TYPE.mht;
    entries['word/afchunk.mht'] = `MIME-Version: 1.0\r\nContent-Type: text/html; charset="utf-8"\r\n\r\n<html><body><p>Chunk ${DOCX_SEED.altChunk}</p></body></html>\r\n`;
  }
  if (o.embedding) {
    docRels.push({ id: 'rIdEmbedXlsx', type: relType(REL_TYPE.package), target: 'embeddings/Microsoft_Excel_Worksheet1.xlsx' });
    docRels.push({ id: 'rIdEmbedOle', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject', target: 'embeddings/oleObject1.bin' });
    defaults['xlsx'] = CONTENT_TYPE.xlsxEmbed;
    overrides['/word/embeddings/oleObject1.bin'] = 'application/vnd.openxmlformats-officedocument.oleObject';
    entries['word/embeddings/Microsoft_Excel_Worksheet1.xlsx'] = await embeddedWorkbook();
    entries['word/embeddings/oleObject1.bin'] = cfbBytes({ '/\u0001Ole10Native': latin1(`\u0000\u0000${DOCX_SEED.embeddedOle}\u0000`) });
  }
  if (o.vba) {
    docRels.push({ id: 'rIdVba', type: REL_TYPE.vbaProject, target: 'vbaProject.bin' });
    overrides['/word/vbaProject.bin'] = CONTENT_TYPE.vba;
    entries['word/vbaProject.bin'] = cfbBytes({
      '/PROJECT': latin1('ID="{00000000-0000-0000-0000-000000000000}"\r\nModule=Module1\r\n'),
      '/VBA/Module1': latin1(`Attribute VB_Name = "Module1"\r\nSub Main()\r\n MsgBox "${DOCX_SEED.vba}"\r\nEnd Sub\r\n`),
    });
  }
  if (o.attributes) {
    docRels.push({ id: 'rIdHyper', type: relType(REL_TYPE.hyperlink), target: DOCX_SEED.hyperlinkTarget, external: true });
  }
  if (o.numbering) {
    docRels.push({ id: 'rIdNumbering', type: relType(REL_TYPE.numbering), target: 'numbering.xml' });
    overrides['/word/numbering.xml'] = CONTENT_TYPE.numbering;
    entries['word/numbering.xml'] = `${XML_DECL}<w:numbering xmlns:w="${w}">` +
      `<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="${DOCX_SEED.numbering} %1."/><w:lvlJc w:val="left"/></w:lvl></w:abstractNum>` +
      `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
  }

  entries['[Content_Types].xml'] = contentTypesXml({ defaults, overrides });
  if (docRels.length > 0) entries['word/_rels/document.xml.rels'] = relationshipsXml(docRels);
  return zipPackage(entries);
}

const D = 'word/document.xml';

export const DOCX_BASE_SEEDS: readonly Seed[] = [
  { needle: DOCX_SEED.body, part: D, where: 'w:body/w:p/w:r/w:t' },
];

/** H1: Strict OOXML namespaces. Body text sits in purl.oclc.org w:t. */
export const buildStrictDocx = (): Promise<Uint8Array> => buildDocxFixture({ strict: true });
export const STRICT_DOCX_SEEDS: readonly Seed[] = [
  { needle: DOCX_SEED.body, part: D, where: 'w:t under xmlns:w=http://purl.oclc.org/ooxml/wordprocessingml/main' },
  { needle: NS.W_STRICT, part: D, where: 'root element namespace declaration' },
];

/** H3: chart category cache (c:strCache/c:pt/c:v) and title (c:title a:t). */
export const buildDocxChart = (): Promise<Uint8Array> => buildDocxFixture({ chart: true });
export const DOCX_CHART_SEEDS: readonly Seed[] = [
  ...DOCX_BASE_SEEDS,
  { needle: DOCX_SEED.chartCategory, part: 'word/charts/chart1.xml', where: 'c:cat/c:strRef/c:strCache/c:pt/c:v' },
  { needle: DOCX_SEED.chartTitle, part: 'word/charts/chart1.xml', where: 'c:title/c:tx/c:rich/a:p/a:r/a:t' },
];

/** H3: SmartArt data model (dgm:pt/dgm:t/a:t). */
export const buildDocxDiagram = (): Promise<Uint8Array> => buildDocxFixture({ diagram: true });
export const DOCX_DIAGRAM_SEEDS: readonly Seed[] = [
  ...DOCX_BASE_SEEDS,
  { needle: DOCX_SEED.diagram, part: 'word/diagrams/data1.xml', where: 'dgm:ptLst/dgm:pt/dgm:t/a:p/a:r/a:t' },
];

/** H3: customXml item (cover page properties). */
export const buildDocxCustomXml = (): Promise<Uint8Array> => buildDocxFixture({ customXml: true });
export const DOCX_CUSTOMXML_SEEDS: readonly Seed[] = [
  ...DOCX_BASE_SEEDS,
  { needle: DOCX_SEED.customXml, part: 'customXml/item1.xml', where: 'CoverPageProperties/CompanyEmail text' },
];

/** H3: settings.xml document variables. */
export const buildDocxDocVars = (): Promise<Uint8Array> => buildDocxFixture({ docVars: true });
export const DOCX_DOCVARS_SEEDS: readonly Seed[] = [
  ...DOCX_BASE_SEEDS,
  { needle: DOCX_SEED.docVar, part: 'word/settings.xml', where: 'w:docVars/w:docVar@w:val' },
];

/** H3: w:altChunk with an MHT payload. */
export const buildDocxAltChunk = (): Promise<Uint8Array> => buildDocxFixture({ altChunk: true });
export const DOCX_ALTCHUNK_SEEDS: readonly Seed[] = [
  ...DOCX_BASE_SEEDS,
  { needle: DOCX_SEED.altChunk, part: 'word/afchunk.mht', where: 'HTML body inside the MHT' },
];

/** H3: embedded workbook (nested zip) and native OLE blob (CFB). */
export const buildDocxEmbedding = (): Promise<Uint8Array> => buildDocxFixture({ embedding: true });
export const DOCX_EMBEDDING_SEEDS: readonly Seed[] = [
  ...DOCX_BASE_SEEDS,
  { needle: DOCX_SEED.embeddedXlsx, part: 'word/embeddings/Microsoft_Excel_Worksheet1.xlsx!xl/sharedStrings.xml', where: 'sst/si/t of the nested workbook' },
  { needle: DOCX_SEED.embeddedOle, part: 'word/embeddings/oleObject1.bin!Root Entry/\u0001Ole10Native', where: 'raw latin1 bytes of the Ole10Native stream' },
];

/** H3: vbaProject.bin with a module source stream. */
export const buildDocxVba = (): Promise<Uint8Array> => buildDocxFixture({ vba: true });
export const DOCX_VBA_SEEDS: readonly Seed[] = [
  ...DOCX_BASE_SEEDS,
  { needle: DOCX_SEED.vba, part: 'word/vbaProject.bin!Root Entry/VBA/Module1', where: 'raw latin1 bytes of the module source' },
];

/** H3: OMML math run text (m:t) in the main part. */
export const buildDocxOmml = (): Promise<Uint8Array> => buildDocxFixture({ omml: true });
export const DOCX_OMML_SEEDS: readonly Seed[] = [
  ...DOCX_BASE_SEEDS,
  { needle: DOCX_SEED.omml, part: D, where: 'm:oMathPara/m:oMath/m:r/m:t' },
];

/** M2: w:delInstrText inside a tracked deletion. */
export const buildDocxDelInstrText = (): Promise<Uint8Array> => buildDocxFixture({ delInstrText: true });
export const DOCX_DELINSTRTEXT_SEEDS: readonly Seed[] = [
  ...DOCX_BASE_SEEDS,
  { needle: DOCX_SEED.delInstrText, part: D, where: 'w:del/w:r/w:delInstrText' },
];

/** M3: wps text box (mc:Choice) with identical VML twin (mc:Fallback), between two body runs. */
export const buildDocxTextboxChoiceFallback = (): Promise<Uint8Array> => buildDocxFixture({ textbox: true });
export const DOCX_TEXTBOX_SEEDS: readonly Seed[] = [
  ...DOCX_BASE_SEEDS,
  { needle: DOCX_SEED.textboxTwin, part: D, where: 'mc:Choice/wps:txbx/w:txbxContent and mc:Fallback/v:textbox/w:txbxContent (same text twice)' },
  { needle: DOCX_SEED.textboxBefore, part: D, where: 'body run before the AlternateContent, same paragraph' },
  { needle: DOCX_SEED.textboxAfter, part: D, where: 'body run after the AlternateContent, same paragraph' },
];

/** M3: w:tab and w:noBreakHyphen splitting entities across w:t siblings. */
export const buildDocxTabAndNoBreakHyphen = (): Promise<Uint8Array> => buildDocxFixture({ tabHyphen: true });
export const DOCX_TABHYPHEN_SEEDS: readonly Seed[] = [
  ...DOCX_BASE_SEEDS,
  { needle: DOCX_SEED.tabLeft, part: D, where: 'w:t immediately before w:tab' },
  { needle: DOCX_SEED.tabRight, part: D, where: 'w:t immediately after w:tab' },
  { needle: DOCX_SEED.hyphenLeft, part: D, where: 'w:t immediately before w:noBreakHyphen' },
  { needle: DOCX_SEED.hyphenRight, part: D, where: 'w:t immediately after w:noBreakHyphen' },
];

/** M1: PII that lives only in attributes. */
export const buildDocxAttributes = (): Promise<Uint8Array> => buildDocxFixture({ attributes: true });
export const DOCX_ATTRIBUTES_SEEDS: readonly Seed[] = [
  ...DOCX_BASE_SEEDS,
  { needle: DOCX_SEED.fldSimpleInstr, part: D, where: 'w:fldSimple@w:instr' },
  { needle: DOCX_SEED.hyperlinkTooltip, part: D, where: 'w:hyperlink@w:tooltip' },
  { needle: DOCX_SEED.hyperlinkTarget, part: 'word/_rels/document.xml.rels', where: 'Relationship@Target (external)' },
  { needle: DOCX_SEED.bookmarkName, part: D, where: 'w:bookmarkStart@w:name' },
  { needle: DOCX_SEED.sdtTag, part: D, where: 'w:sdtPr/w:tag@w:val' },
  { needle: DOCX_SEED.sdtAlias, part: D, where: 'w:sdtPr/w:alias@w:val' },
  { needle: DOCX_SEED.docPrDescr, part: D, where: 'wp:docPr@descr' },
];

/** H3: numbering level text. */
export const buildDocxNumbering = (): Promise<Uint8Array> => buildDocxFixture({ numbering: true });
export const DOCX_NUMBERING_SEEDS: readonly Seed[] = [
  ...DOCX_BASE_SEEDS,
  { needle: DOCX_SEED.numbering, part: 'word/numbering.xml', where: 'w:abstractNum/w:lvl/w:lvlText@w:val' },
];

/** Everything at once (transitional namespace). Handy for one-shot smoke tests. */
export const buildDocxEverything = (): Promise<Uint8Array> => buildDocxFixture({
  chart: true, diagram: true, customXml: true, docVars: true, altChunk: true, embedding: true, vba: true,
  omml: true, delInstrText: true, textbox: true, tabHyphen: true, attributes: true, numbering: true,
});
export const DOCX_EVERYTHING_SEEDS: readonly Seed[] = [
  ...DOCX_BASE_SEEDS,
  ...DOCX_CHART_SEEDS.slice(1), ...DOCX_DIAGRAM_SEEDS.slice(1), ...DOCX_CUSTOMXML_SEEDS.slice(1),
  ...DOCX_DOCVARS_SEEDS.slice(1), ...DOCX_ALTCHUNK_SEEDS.slice(1), ...DOCX_EMBEDDING_SEEDS.slice(1),
  ...DOCX_VBA_SEEDS.slice(1), ...DOCX_OMML_SEEDS.slice(1), ...DOCX_DELINSTRTEXT_SEEDS.slice(1),
  ...DOCX_TEXTBOX_SEEDS.slice(1), ...DOCX_TABHYPHEN_SEEDS.slice(1), ...DOCX_ATTRIBUTES_SEEDS.slice(1),
  ...DOCX_NUMBERING_SEEDS.slice(1),
];

export const DOCX_FIXTURES: readonly FixtureSpec[] = [
  { name: 'docx-strict', ext: 'docx', findings: ['H1'], build: buildStrictDocx, seeds: STRICT_DOCX_SEEDS },
  { name: 'docx-chart', ext: 'docx', findings: ['H3'], build: buildDocxChart, seeds: DOCX_CHART_SEEDS },
  { name: 'docx-diagram', ext: 'docx', findings: ['H3'], build: buildDocxDiagram, seeds: DOCX_DIAGRAM_SEEDS },
  { name: 'docx-customxml', ext: 'docx', findings: ['H3'], build: buildDocxCustomXml, seeds: DOCX_CUSTOMXML_SEEDS },
  { name: 'docx-docvars', ext: 'docx', findings: ['H3'], build: buildDocxDocVars, seeds: DOCX_DOCVARS_SEEDS },
  { name: 'docx-altchunk', ext: 'docx', findings: ['H3'], build: buildDocxAltChunk, seeds: DOCX_ALTCHUNK_SEEDS },
  { name: 'docx-embedding', ext: 'docx', findings: ['H3'], build: buildDocxEmbedding, seeds: DOCX_EMBEDDING_SEEDS },
  { name: 'docx-vba', ext: 'docx', findings: ['H3'], build: buildDocxVba, seeds: DOCX_VBA_SEEDS },
  { name: 'docx-omml', ext: 'docx', findings: ['H3'], build: buildDocxOmml, seeds: DOCX_OMML_SEEDS },
  { name: 'docx-delinstrtext', ext: 'docx', findings: ['M2'], build: buildDocxDelInstrText, seeds: DOCX_DELINSTRTEXT_SEEDS },
  { name: 'docx-textbox', ext: 'docx', findings: ['M3'], build: buildDocxTextboxChoiceFallback, seeds: DOCX_TEXTBOX_SEEDS },
  { name: 'docx-tab-hyphen', ext: 'docx', findings: ['M3'], build: buildDocxTabAndNoBreakHyphen, seeds: DOCX_TABHYPHEN_SEEDS },
  { name: 'docx-attributes', ext: 'docx', findings: ['M1'], build: buildDocxAttributes, seeds: DOCX_ATTRIBUTES_SEEDS },
  { name: 'docx-numbering', ext: 'docx', findings: ['H3'], build: buildDocxNumbering, seeds: DOCX_NUMBERING_SEEDS },
  { name: 'docx-everything', ext: 'docx', findings: ['H3', 'M1', 'M2', 'M3'], build: buildDocxEverything, seeds: DOCX_EVERYTHING_SEEDS },
];
