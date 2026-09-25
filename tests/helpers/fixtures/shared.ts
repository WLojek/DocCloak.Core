// Shared building blocks for the synthetic Office fixtures.
//
// Every generator is a pure function: same input, same bytes. Generators
// return Uint8Array (CFB) or Promise<Uint8Array> (JSZip is async) so other
// tests can feed them straight into readDocx / writeAnonymizedXlsx / ...

import JSZip from 'jszip';

/** One piece of seeded PII: what was planted, and where. */
export interface Seed {
  /** Exact byte-level string that must be found in the raw fixture (ASCII). */
  needle: string;
  /** Part (zip entry or CFB stream) that carries it. */
  part: string;
  /** Where inside the part, for humans reading a failure. */
  where: string;
}

export interface FixtureSpec {
  /** Stable id, also used as the output file name stem. */
  name: string;
  /** File extension of the produced package. */
  ext: 'docx' | 'xlsx' | 'doc' | 'pdf';
  /** The finding(s) from SECURITY_REPORT-2026-09 the fixture reproduces. */
  findings: string[];
  build: () => Promise<Uint8Array> | Uint8Array;
  seeds: readonly Seed[];
  /**
   * False for inputs no office suite can open by design (a .doc with the
   * encryption flag set): the reader must refuse them, and the office-open
   * CI job must not be asked to render them.
   */
  openable?: boolean;
}

export const NS = {
  W: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  W_STRICT: 'http://purl.oclc.org/ooxml/wordprocessingml/main',
  SS: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  SS_STRICT: 'http://purl.oclc.org/ooxml/spreadsheetml/main',
  REL: 'http://schemas.openxmlformats.org/package/2006/relationships',
  R: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  R_STRICT: 'http://purl.oclc.org/ooxml/officeDocument/relationships',
  M: 'http://schemas.openxmlformats.org/officeDocument/2006/math',
  MC: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
  V: 'urn:schemas-microsoft-com:vml',
  WPS: 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape',
  WP: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  A: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  C: 'http://schemas.openxmlformats.org/drawingml/2006/chart',
  DGM: 'http://schemas.openxmlformats.org/drawingml/2006/diagram',
  XDR: 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing',
  CT: 'http://schemas.openxmlformats.org/package/2006/content-types',
  RD: 'http://schemas.microsoft.com/office/spreadsheetml/2017/richdata',
} as const;

export const REL_TYPE = {
  officeDocument: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  hyperlink: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',
  chart: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart',
  diagramData: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramData',
  customXml: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml',
  aFChunk: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk',
  package: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/package',
  vbaProject: 'http://schemas.microsoft.com/office/2006/relationships/vbaProject',
  settings: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings',
  numbering: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering',
  worksheet: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet',
  sharedStrings: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings',
  pivotCacheDefinition: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotCacheDefinition',
  pivotCacheRecords: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotCacheRecords',
  connections: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/connections',
  externalLink: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLink',
  drawing: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing',
  vmlDrawing: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing',
  richValue: 'http://schemas.microsoft.com/office/2017/06/relationships/rdRichValue',
} as const;

export const CONTENT_TYPE = {
  rels: 'application/vnd.openxmlformats-package.relationships+xml',
  xml: 'application/xml',
  docMain: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  docMacroMain: 'application/vnd.ms-word.document.macroEnabled.main+xml',
  settings: 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml',
  numbering: 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml',
  chart: 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml',
  diagramData: 'application/vnd.openxmlformats-officedocument.drawingml.diagramData+xml',
  mht: 'message/rfc822',
  xlsxEmbed: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  vba: 'application/vnd.ms-office.vbaProject',
  wbMain: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  worksheet: 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
  sharedStrings: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml',
  pivotCacheDefinition: 'application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheDefinition+xml',
  pivotCacheRecords: 'application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheRecords+xml',
  connections: 'application/vnd.openxmlformats-officedocument.spreadsheetml.connections+xml',
  externalLink: 'application/vnd.openxmlformats-officedocument.spreadsheetml.externalLink+xml',
  drawing: 'application/vnd.openxmlformats-officedocument.drawing+xml',
  vml: 'application/vnd.openxmlformats-officedocument.vmlDrawing',
  richValue: 'application/vnd.ms-excel.rdrichvalue+xml',
} as const;

export const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

export interface Relationship {
  id: string;
  type: string;
  target: string;
  external?: boolean;
}

export function relationshipsXml(rels: Relationship[]): string {
  const body = rels
    .map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${r.target}"${r.external ? ' TargetMode="External"' : ''}/>`)
    .join('');
  return `${XML_DECL}<Relationships xmlns="${NS.REL}">${body}</Relationships>`;
}

export interface ContentTypes {
  defaults: Record<string, string>;
  overrides: Record<string, string>;
}

export function contentTypesXml(ct: ContentTypes): string {
  const defaults = Object.entries(ct.defaults)
    .map(([ext, type]) => `<Default Extension="${ext}" ContentType="${type}"/>`)
    .join('');
  const overrides = Object.entries(ct.overrides)
    .map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`)
    .join('');
  return `${XML_DECL}<Types xmlns="${NS.CT}">${defaults}${overrides}</Types>`;
}

export type PackageEntries = Record<string, string | Uint8Array>;

/**
 * Deterministic zip: fixed mtime, STORE for binaries, DEFLATE for text, and
 * no implicit folder entries (JSZip stamps those with the current time, so two
 * builds straddling a 2-second DOS-time boundary differed; OOXML needs none).
 */
export async function zipPackage(entries: PackageEntries): Promise<Uint8Array> {
  const zip = new JSZip();
  const date = new Date(Date.UTC(2020, 0, 1, 0, 0, 0));
  for (const [path, content] of Object.entries(entries)) {
    zip.file(path, content, {
      date,
      createFolders: false,
      compression: typeof content === 'string' ? 'DEFLATE' : 'STORE',
    });
  }
  return zip.generateAsync({ type: 'uint8array', platform: 'UNIX' });
}

export function latin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

export function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
