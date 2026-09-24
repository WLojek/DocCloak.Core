// Synthetic .xlsx fixtures reproducing SECURITY_REPORT-2026-09 findings
// H1 (strict OOXML), H2 (numeric and date cells), H4 (parts outside the
// allow-list: pivot cache, definedNames, connections, externalLinks,
// dataValidation, cfRule, formula literals, drawings, VML, richData).
//
// Every generator is pure and returns Promise<Uint8Array>. XLSX_SEED lists
// the needle each option plants; the *_SEEDS arrays say in which part.

import {
  NS,
  REL_TYPE,
  CONTENT_TYPE,
  XML_DECL,
  relationshipsXml,
  contentTypesXml,
  zipPackage,
  type Relationship,
  type Seed,
  type FixtureSpec,
  type PackageEntries,
} from './shared.ts';

export const XLSX_SEED = {
  shared: 'sharedcell@leak.example',
  inline: 'inlinecell@leak.example',
  pesel: '90010112345',
  phone: '48601234567',
  date: '1990-01-01T00:00:00',
  pivotDefinition: 'pivotshared@leak.example',
  pivotRecord: 'pivotrecord@leak.example',
  definedNameName: 'LEAK_DEFINED_NAME',
  definedNameValue: 'definedname@leak.example',
  connectionPassword: 'Password=LEAK_CONN_PASSWORD',
  connectionCommand: 'SELECT * FROM LEAK_SQL_TABLE',
  externalLink: 'externallink@leak.example',
  dvPrompt: 'dvprompt@leak.example',
  dvError: 'dverror@leak.example',
  dvList: 'dvlist@leak.example',
  cfRule: 'condfmt@leak.example',
  formulaLiteral: 'formulaonly@leak.example',
  drawing: 'drawingshape@leak.example',
  vml: 'vmltext@leak.example',
  richData: 'richdata@leak.example',
} as const;

export interface XlsxFixtureOptions {
  /** Strict OOXML namespaces (purl.oclc.org). H1. */
  strict?: boolean;
  /** Numeric cells holding PESEL / phone digits and a t="d" date cell. H2. */
  numericDates?: boolean;
  /** xl/pivotCache/pivotCacheDefinition1.xml sharedItems and pivotCacheRecords1.xml rows. H4. */
  pivot?: boolean;
  /** workbook.xml definedName with a PII name and a string literal value. H4. */
  definedName?: boolean;
  /** xl/connections.xml with a connection string password and SQL command. H4. */
  connections?: boolean;
  /** xl/externalLinks/externalLink1.xml cached cell values. H4. */
  externalLinks?: boolean;
  /** dataValidation@prompt, @error and formula1 list literal. H4. */
  dataValidation?: boolean;
  /** conditionalFormatting/cfRule/formula literal. H4. */
  cfRule?: boolean;
  /** A string literal that only appears in <f>, never in <v>. H4. */
  formulaLiteral?: boolean;
  /** xl/drawings/drawing1.xml shape text (a:t). H4. */
  drawing?: boolean;
  /** xl/drawings/vmlDrawing1.vml text box. H4. */
  vml?: boolean;
  /** xl/richData/rdrichvalue.xml value. H4. */
  richData?: boolean;
}

function sheetXml(o: XlsxFixtureOptions, ns: string, r: string): string {
  const rows: string[] = [];
  rows.push(`<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>${XLSX_SEED.inline}</t></is></c></row>`);
  if (o.numericDates) {
    rows.push(`<row r="2"><c r="A2"><v>${XLSX_SEED.pesel}</v></c><c r="B2" t="n"><v>${XLSX_SEED.phone}</v></c><c r="C2" t="d"><v>${XLSX_SEED.date}</v></c></row>`);
  }
  if (o.formulaLiteral) {
    rows.push(`<row r="3"><c r="A3" t="str"><f>IF(A1="${XLSX_SEED.formulaLiteral}","yes","no")</f><v>no</v></c></row>`);
  }
  const after: string[] = [];
  if (o.cfRule) {
    after.push(`<conditionalFormatting sqref="A1"><cfRule type="expression" dxfId="0" priority="1"><formula>A1="${XLSX_SEED.cfRule}"</formula></cfRule></conditionalFormatting>`);
  }
  if (o.dataValidation) {
    after.push(`<dataValidations count="1"><dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" promptTitle="Who" prompt="${XLSX_SEED.dvPrompt}" errorTitle="Bad" error="${XLSX_SEED.dvError}" sqref="C1"><formula1>"${XLSX_SEED.dvList},other"</formula1></dataValidation></dataValidations>`);
  }
  if (o.drawing) after.push(`<drawing r:id="rIdDrawing"/>`);
  if (o.vml) after.push(`<legacyDrawing r:id="rIdVml"/>`);
  return `${XML_DECL}<worksheet xmlns="${ns}" xmlns:r="${r}"><sheetData>${rows.join('')}</sheetData>${after.join('')}</worksheet>`;
}

/** Build an xlsx with any combination of the leak scenarios enabled. */
export async function buildXlsxFixture(o: XlsxFixtureOptions = {}): Promise<Uint8Array> {
  const ns = o.strict ? NS.SS_STRICT : NS.SS;
  const r = o.strict ? NS.R_STRICT : NS.R;
  const relType = (t: string): string => (o.strict ? t.replace('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships') : t);

  const entries: PackageEntries = {};
  const defaults: Record<string, string> = { rels: CONTENT_TYPE.rels, xml: CONTENT_TYPE.xml };
  const overrides: Record<string, string> = {
    '/xl/workbook.xml': CONTENT_TYPE.wbMain,
    '/xl/worksheets/sheet1.xml': CONTENT_TYPE.worksheet,
    '/xl/sharedStrings.xml': CONTENT_TYPE.sharedStrings,
  };
  const wbRels: Relationship[] = [
    { id: 'rId1', type: relType(REL_TYPE.worksheet), target: 'worksheets/sheet1.xml' },
    { id: 'rId2', type: relType(REL_TYPE.sharedStrings), target: 'sharedStrings.xml' },
  ];
  const sheetRels: Relationship[] = [];
  const wbExtra: string[] = [];

  entries['_rels/.rels'] = relationshipsXml([{ id: 'rId1', type: relType(REL_TYPE.officeDocument), target: 'xl/workbook.xml' }]);
  entries['xl/sharedStrings.xml'] = `${XML_DECL}<sst xmlns="${ns}" count="1" uniqueCount="1"><si><t>${XLSX_SEED.shared}</t></si></sst>`;
  entries['xl/worksheets/sheet1.xml'] = sheetXml(o, ns, r);

  if (o.definedName) {
    wbExtra.push(`<definedNames><definedName name="${XLSX_SEED.definedNameName}">"${XLSX_SEED.definedNameValue}"</definedName></definedNames>`);
  }
  if (o.pivot) {
    wbRels.push({ id: 'rIdPivotDef', type: relType(REL_TYPE.pivotCacheDefinition), target: 'pivotCache/pivotCacheDefinition1.xml' });
    wbExtra.push(`<pivotCaches><pivotCache cacheId="1" r:id="rIdPivotDef"/></pivotCaches>`);
    overrides['/xl/pivotCache/pivotCacheDefinition1.xml'] = CONTENT_TYPE.pivotCacheDefinition;
    overrides['/xl/pivotCache/pivotCacheRecords1.xml'] = CONTENT_TYPE.pivotCacheRecords;
    entries['xl/pivotCache/pivotCacheDefinition1.xml'] = `${XML_DECL}<pivotCacheDefinition xmlns="${ns}" xmlns:r="${r}" r:id="rIdPivotRec" recordCount="1">` +
      `<cacheSource type="worksheet"><worksheetSource ref="A1:A2" sheet="Sheet1"/></cacheSource>` +
      `<cacheFields count="1"><cacheField name="Name" numFmtId="0"><sharedItems count="1"><s v="${XLSX_SEED.pivotDefinition}"/></sharedItems></cacheField></cacheFields>` +
      `</pivotCacheDefinition>`;
    entries['xl/pivotCache/_rels/pivotCacheDefinition1.xml.rels'] = relationshipsXml([{ id: 'rIdPivotRec', type: relType(REL_TYPE.pivotCacheRecords), target: 'pivotCacheRecords1.xml' }]);
    entries['xl/pivotCache/pivotCacheRecords1.xml'] = `${XML_DECL}<pivotCacheRecords xmlns="${ns}" count="1"><r><s v="${XLSX_SEED.pivotRecord}"/></r></pivotCacheRecords>`;
  }
  if (o.connections) {
    wbRels.push({ id: 'rIdConn', type: relType(REL_TYPE.connections), target: 'connections.xml' });
    overrides['/xl/connections.xml'] = CONTENT_TYPE.connections;
    entries['xl/connections.xml'] = `${XML_DECL}<connections xmlns="${ns}"><connection id="1" name="db" type="1" refreshedVersion="6">` +
      `<dbPr connection="Provider=SQLOLEDB;User ID=sa;${XLSX_SEED.connectionPassword}" command="${XLSX_SEED.connectionCommand}"/></connection></connections>`;
  }
  if (o.externalLinks) {
    wbRels.push({ id: 'rIdExt', type: relType(REL_TYPE.externalLink), target: 'externalLinks/externalLink1.xml' });
    wbExtra.push(`<externalReferences><externalReference r:id="rIdExt"/></externalReferences>`);
    overrides['/xl/externalLinks/externalLink1.xml'] = CONTENT_TYPE.externalLink;
    entries['xl/externalLinks/externalLink1.xml'] = `${XML_DECL}<externalLink xmlns="${ns}" xmlns:r="${r}"><externalBook r:id="rId1"><sheetNames><sheetName val="Ext"/></sheetNames>` +
      `<sheetDataSet><sheetData sheetId="0"><row r="1"><cell r="A1" t="str"><v>${XLSX_SEED.externalLink}</v></cell></row></sheetData></sheetDataSet></externalBook></externalLink>`;
    entries['xl/externalLinks/_rels/externalLink1.xml.rels'] = relationshipsXml([{ id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLinkPath', target: 'file:///C:/data/other.xlsx', external: true }]);
  }
  if (o.drawing) {
    sheetRels.push({ id: 'rIdDrawing', type: relType(REL_TYPE.drawing), target: '../drawings/drawing1.xml' });
    overrides['/xl/drawings/drawing1.xml'] = CONTENT_TYPE.drawing;
    entries['xl/drawings/drawing1.xml'] = `${XML_DECL}<xdr:wsDr xmlns:xdr="${NS.XDR}" xmlns:a="${NS.A}">` +
      `<xdr:oneCellAnchor><xdr:from><xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>4</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="1800000" cy="360000"/>` +
      `<xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="2" name="TextBox 1"/><xdr:cNvSpPr txBox="1"/></xdr:nvSpPr>` +
      `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1800000" cy="360000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>` +
      `<xdr:txBody><a:bodyPr/><a:p><a:r><a:t>${XLSX_SEED.drawing}</a:t></a:r></a:p></xdr:txBody></xdr:sp><xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>`;
  }
  if (o.vml) {
    sheetRels.push({ id: 'rIdVml', type: relType(REL_TYPE.vmlDrawing), target: '../drawings/vmlDrawing1.vml' });
    defaults['vml'] = CONTENT_TYPE.vml;
    entries['xl/drawings/vmlDrawing1.vml'] = `<xml xmlns:v="${NS.V}" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">` +
      `<v:shape id="_x0000_s1025" type="#_x0000_t202" style="position:absolute;margin-left:100pt;margin-top:10pt;width:120pt;height:40pt;visibility:visible">` +
      `<v:textbox><div>${XLSX_SEED.vml}</div></v:textbox><x:ClientData ObjectType="Shape"><x:MoveWithCells/><x:SizeWithCells/><x:Anchor>1, 0, 0, 0, 3, 0, 2, 0</x:Anchor></x:ClientData></v:shape></xml>`;
  }
  if (o.richData) {
    wbRels.push({ id: 'rIdRich', type: REL_TYPE.richValue, target: 'richData/rdrichvalue.xml' });
    overrides['/xl/richData/rdrichvalue.xml'] = CONTENT_TYPE.richValue;
    entries['xl/richData/rdrichvalue.xml'] = `${XML_DECL}<rvData xmlns="${NS.RD}" count="1"><rv s="0"><v>${XLSX_SEED.richData}</v></rv></rvData>`;
  }

  entries['xl/workbook.xml'] = `${XML_DECL}<workbook xmlns="${ns}" xmlns:r="${r}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>${wbExtra.join('')}</workbook>`;
  entries['xl/_rels/workbook.xml.rels'] = relationshipsXml(wbRels);
  if (sheetRels.length > 0) entries['xl/worksheets/_rels/sheet1.xml.rels'] = relationshipsXml(sheetRels);
  entries['[Content_Types].xml'] = contentTypesXml({ defaults, overrides });
  return zipPackage(entries);
}

const SHEET = 'xl/worksheets/sheet1.xml';
const WB = 'xl/workbook.xml';

export const XLSX_BASE_SEEDS: readonly Seed[] = [
  { needle: XLSX_SEED.shared, part: 'xl/sharedStrings.xml', where: 'sst/si/t (cell A1)' },
  { needle: XLSX_SEED.inline, part: SHEET, where: 'c[t=inlineStr]/is/t (cell B1)' },
];

/** H1: Strict OOXML namespaces. */
export const buildStrictXlsx = (): Promise<Uint8Array> => buildXlsxFixture({ strict: true });
export const STRICT_XLSX_SEEDS: readonly Seed[] = [
  ...XLSX_BASE_SEEDS,
  { needle: NS.SS_STRICT, part: WB, where: 'root element namespace declaration' },
];

/** H2: digits stored as numbers and a t="d" date cell. */
export const buildXlsxNumericAndDateCells = (): Promise<Uint8Array> => buildXlsxFixture({ numericDates: true });
export const XLSX_NUMERIC_SEEDS: readonly Seed[] = [
  ...XLSX_BASE_SEEDS,
  { needle: XLSX_SEED.pesel, part: SHEET, where: 'c (no t attr) /v (cell A2)' },
  { needle: XLSX_SEED.phone, part: SHEET, where: 'c[t=n]/v (cell B2)' },
  { needle: XLSX_SEED.date, part: SHEET, where: 'c[t=d]/v (cell C2)' },
];

/** H4: pivot cache definition shared items and record rows. */
export const buildXlsxPivotCache = (): Promise<Uint8Array> => buildXlsxFixture({ pivot: true });
export const XLSX_PIVOT_SEEDS: readonly Seed[] = [
  ...XLSX_BASE_SEEDS,
  { needle: XLSX_SEED.pivotDefinition, part: 'xl/pivotCache/pivotCacheDefinition1.xml', where: 'cacheField/sharedItems/s@v' },
  { needle: XLSX_SEED.pivotRecord, part: 'xl/pivotCache/pivotCacheRecords1.xml', where: 'r/s@v' },
];

/** H4: definedName with a PII name and a literal value. */
export const buildXlsxDefinedName = (): Promise<Uint8Array> => buildXlsxFixture({ definedName: true });
export const XLSX_DEFINEDNAME_SEEDS: readonly Seed[] = [
  ...XLSX_BASE_SEEDS,
  { needle: XLSX_SEED.definedNameName, part: WB, where: 'definedName@name' },
  { needle: XLSX_SEED.definedNameValue, part: WB, where: 'definedName text (string literal)' },
];

/** H4: connections.xml with credentials and SQL. */
export const buildXlsxConnections = (): Promise<Uint8Array> => buildXlsxFixture({ connections: true });
export const XLSX_CONNECTIONS_SEEDS: readonly Seed[] = [
  ...XLSX_BASE_SEEDS,
  { needle: XLSX_SEED.connectionPassword, part: 'xl/connections.xml', where: 'connection/dbPr@connection' },
  { needle: XLSX_SEED.connectionCommand, part: 'xl/connections.xml', where: 'connection/dbPr@command' },
];

/** H4: external link cache. */
export const buildXlsxExternalLinks = (): Promise<Uint8Array> => buildXlsxFixture({ externalLinks: true });
export const XLSX_EXTERNALLINKS_SEEDS: readonly Seed[] = [
  ...XLSX_BASE_SEEDS,
  { needle: XLSX_SEED.externalLink, part: 'xl/externalLinks/externalLink1.xml', where: 'externalBook/sheetDataSet/sheetData/row/cell/v' },
];

/** H4: data validation prompt, error and list literal. */
export const buildXlsxDataValidation = (): Promise<Uint8Array> => buildXlsxFixture({ dataValidation: true });
export const XLSX_DATAVALIDATION_SEEDS: readonly Seed[] = [
  ...XLSX_BASE_SEEDS,
  { needle: XLSX_SEED.dvPrompt, part: SHEET, where: 'dataValidation@prompt' },
  { needle: XLSX_SEED.dvError, part: SHEET, where: 'dataValidation@error' },
  { needle: XLSX_SEED.dvList, part: SHEET, where: 'dataValidation/formula1 string literal' },
];

/** H4: conditional formatting rule formula. */
export const buildXlsxCfRule = (): Promise<Uint8Array> => buildXlsxFixture({ cfRule: true });
export const XLSX_CFRULE_SEEDS: readonly Seed[] = [
  ...XLSX_BASE_SEEDS,
  { needle: XLSX_SEED.cfRule, part: SHEET, where: 'conditionalFormatting/cfRule/formula' },
];

/** H4: string literal only inside <f>. */
export const buildXlsxFormulaLiteral = (): Promise<Uint8Array> => buildXlsxFixture({ formulaLiteral: true });
export const XLSX_FORMULALITERAL_SEEDS: readonly Seed[] = [
  ...XLSX_BASE_SEEDS,
  { needle: XLSX_SEED.formulaLiteral, part: SHEET, where: 'c/f (cached v is "no")' },
];

/** H4: DrawingML text box on the sheet. */
export const buildXlsxDrawing = (): Promise<Uint8Array> => buildXlsxFixture({ drawing: true });
export const XLSX_DRAWING_SEEDS: readonly Seed[] = [
  ...XLSX_BASE_SEEDS,
  { needle: XLSX_SEED.drawing, part: 'xl/drawings/drawing1.xml', where: 'xdr:sp/xdr:txBody/a:p/a:r/a:t' },
];

/** H4: legacy VML text box. */
export const buildXlsxVmlTextbox = (): Promise<Uint8Array> => buildXlsxFixture({ vml: true });
export const XLSX_VML_SEEDS: readonly Seed[] = [
  ...XLSX_BASE_SEEDS,
  { needle: XLSX_SEED.vml, part: 'xl/drawings/vmlDrawing1.vml', where: 'v:shape/v:textbox/div' },
];

/** H4: rich data value store. */
export const buildXlsxRichData = (): Promise<Uint8Array> => buildXlsxFixture({ richData: true });
export const XLSX_RICHDATA_SEEDS: readonly Seed[] = [
  ...XLSX_BASE_SEEDS,
  { needle: XLSX_SEED.richData, part: 'xl/richData/rdrichvalue.xml', where: 'rvData/rv/v' },
];

/** Everything at once (transitional namespace). */
export const buildXlsxEverything = (): Promise<Uint8Array> => buildXlsxFixture({
  numericDates: true, pivot: true, definedName: true, connections: true, externalLinks: true,
  dataValidation: true, cfRule: true, formulaLiteral: true, drawing: true, vml: true, richData: true,
});
export const XLSX_EVERYTHING_SEEDS: readonly Seed[] = [
  ...XLSX_BASE_SEEDS,
  ...XLSX_NUMERIC_SEEDS.slice(2), ...XLSX_PIVOT_SEEDS.slice(2), ...XLSX_DEFINEDNAME_SEEDS.slice(2),
  ...XLSX_CONNECTIONS_SEEDS.slice(2), ...XLSX_EXTERNALLINKS_SEEDS.slice(2), ...XLSX_DATAVALIDATION_SEEDS.slice(2),
  ...XLSX_CFRULE_SEEDS.slice(2), ...XLSX_FORMULALITERAL_SEEDS.slice(2), ...XLSX_DRAWING_SEEDS.slice(2),
  ...XLSX_VML_SEEDS.slice(2), ...XLSX_RICHDATA_SEEDS.slice(2),
];

export const XLSX_FIXTURES: readonly FixtureSpec[] = [
  { name: 'xlsx-strict', ext: 'xlsx', findings: ['H1'], build: buildStrictXlsx, seeds: STRICT_XLSX_SEEDS },
  { name: 'xlsx-numeric-date', ext: 'xlsx', findings: ['H2'], build: buildXlsxNumericAndDateCells, seeds: XLSX_NUMERIC_SEEDS },
  { name: 'xlsx-pivot', ext: 'xlsx', findings: ['H4'], build: buildXlsxPivotCache, seeds: XLSX_PIVOT_SEEDS },
  { name: 'xlsx-definedname', ext: 'xlsx', findings: ['H4'], build: buildXlsxDefinedName, seeds: XLSX_DEFINEDNAME_SEEDS },
  { name: 'xlsx-connections', ext: 'xlsx', findings: ['H4'], build: buildXlsxConnections, seeds: XLSX_CONNECTIONS_SEEDS },
  { name: 'xlsx-externallinks', ext: 'xlsx', findings: ['H4'], build: buildXlsxExternalLinks, seeds: XLSX_EXTERNALLINKS_SEEDS },
  { name: 'xlsx-datavalidation', ext: 'xlsx', findings: ['H4'], build: buildXlsxDataValidation, seeds: XLSX_DATAVALIDATION_SEEDS },
  { name: 'xlsx-cfrule', ext: 'xlsx', findings: ['H4'], build: buildXlsxCfRule, seeds: XLSX_CFRULE_SEEDS },
  { name: 'xlsx-formula-literal', ext: 'xlsx', findings: ['H4'], build: buildXlsxFormulaLiteral, seeds: XLSX_FORMULALITERAL_SEEDS },
  { name: 'xlsx-drawing', ext: 'xlsx', findings: ['H4'], build: buildXlsxDrawing, seeds: XLSX_DRAWING_SEEDS },
  { name: 'xlsx-vml', ext: 'xlsx', findings: ['H4'], build: buildXlsxVmlTextbox, seeds: XLSX_VML_SEEDS },
  { name: 'xlsx-richdata', ext: 'xlsx', findings: ['H4'], build: buildXlsxRichData, seeds: XLSX_RICHDATA_SEEDS },
  { name: 'xlsx-everything', ext: 'xlsx', findings: ['H2', 'H4'], build: buildXlsxEverything, seeds: XLSX_EVERYTHING_SEEDS },
];
