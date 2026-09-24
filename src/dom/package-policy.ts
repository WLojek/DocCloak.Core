/**
 * @doccloak/core/dom - package part policy (T177, security remediation 2026-09).
 *
 * Every part of a .docx / .xlsx package falls into one of four classes:
 * - text: the reader extracts it and the writer applies offset replacements
 *   (document body, headers, footnotes, chart caches, SmartArt, customXml);
 * - structural: styles, fonts, themes, relationships, media and metadata
 *   parts; nothing in them is user text, or the metadata scrub and layer
 *   zero (the package-wide value scrub) cover what is;
 * - unredactable: content the engine cannot reach (embedded workbooks, OLE
 *   blobs, macros, HTML chunks, data connections, printer settings). These
 *   are REPORTED to the host as `UnredactablePart[]` with a plain-language
 *   label; the writer refuses to export them unless the host passes
 *   `allowUnredactable: true`, which the web app does only after the user
 *   confirmed (founder decision 2026-09-24: informed consent, no hard
 *   refusal);
 * - unknown: a part name no table recognises. Treated like unredactable
 *   (reported, gated) so a new Office feature can never slip through as a
 *   silently copied part.
 *
 * The tables are calibrated on the part-name inventory of real files (Word
 * 365 Windows/Mac, LibreOffice, Google Docs export, Pages export, Excel 365)
 * and on the synthetic T173 fixtures; tests/package-policy.test.ts embeds
 * that inventory and fails when any name in it classifies as unknown.
 *
 * Known limits (documented, not policy failures): media/* (images without
 * OCR), ink/* (handwriting strokes), theme/media/* are structural.
 */

import type JSZip from 'jszip';
import { UnsupportedDocumentError } from './errors.ts';
import type { UnredactablePart } from './errors.ts';

export type PackageKind = 'docx' | 'xlsx';
export type PartClass = 'text' | 'structural' | 'unredactable' | 'unknown';
export type UnredactableKind = UnredactablePart['kind'];

/** One row of an unredactable table: what matches, how it is reported. */
export interface UnredactableRule {
  pattern: RegExp;
  kind: UnredactableKind;
  /** A fixed label, or a function of the part name and its content type. */
  label: string | ((path: string, contentType: string | null) => string);
}

// ---------------------------------------------------------------------------
// Shared (OPC) structural parts
// ---------------------------------------------------------------------------

/** Parts every OPC package has: manifest, relationships, document properties. */
export const COMMON_STRUCTURAL_PARTS: readonly RegExp[] = [
  /^\[Content_Types\]\.xml$/,
  /(?:^|\/)_rels\/[^/]*\.rels$/,
  /^docProps\/(?:core|app|custom)\.xml$/,
  /^docProps\/thumbnail\.[A-Za-z0-9]+$/,
];

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------

/**
 * WordprocessingML parts the docx reader walks with the paragraph extractor:
 * the main document, headers, footers, footnotes, endnotes, comments, the
 * numbering definitions (w:lvlText units, T174), the web settings (frameset
 * units, T175) and the same set inside the glossary (building blocks)
 * subdocument.
 */
export const DOCX_WORD_TEXT_PARTS = /^word\/(?:glossary\/)?(?:document|(?:header|footer)\d*|footnotes|endnotes|comments|numbering|webSettings)\.xml$/;

/**
 * DrawingML parts read with drawingUnits (T175): charts (title, axis and
 * data-label rich text, string caches, series names), chartEx (2016+ chart
 * types), SmartArt data models and their pre-rendered drawing, and chart
 * user shapes.
 */
export const DOCX_DRAWING_TEXT_PARTS = /^word\/(?:glossary\/)?(?:charts\/chart(?:Ex)?\d*|diagrams\/(?:data|drawing)\d*|drawings\/drawing\d*)\.xml$/;

/** Custom XML data stores read with leafTextUnits (T175): cover page, bibliography, SharePoint properties. */
export const DOCX_CUSTOM_XML_TEXT_PARTS = /^customXml\/item\d*\.xml$/;

export const DOCX_TEXT_PARTS: readonly RegExp[] = [
  DOCX_WORD_TEXT_PARTS,
  DOCX_DRAWING_TEXT_PARTS,
  DOCX_CUSTOM_XML_TEXT_PARTS,
];

export const DOCX_STRUCTURAL_PARTS: readonly RegExp[] = [
  ...COMMON_STRUCTURAL_PARTS,
  // Styles, fonts, settings (docVars, mailMerge, rsids removed by the
  // metadata scrub), comment side tables (authors scrubbed), people.xml
  // (author registry scrubbed).
  /^word\/(?:glossary\/)?(?:styles|stylesWithEffects|fontTable|settings|people|commentsExtended|commentsIds|commentsExtensible)\.xml$/,
  // Embedded (obfuscated) fonts: Word writes .odttf, LibreOffice .ttf/.otf,
  // Google Docs export .fntdata.
  /^word\/(?:glossary\/)?fonts\/[^/]+\.(?:odttf|ttf|otf|fntdata)$/i,
  /^word\/(?:glossary\/)?theme\/.+$/,
  // Known limit: images and other media are copied as-is (no OCR).
  /^word\/(?:glossary\/)?media\/[^/]+$/,
  // Chart and SmartArt presentation parts (no user text).
  /^word\/(?:glossary\/)?charts\/(?:style|colors)\d*\.xml$/,
  /^word\/(?:glossary\/)?diagrams\/(?:layout|quickStyle|colors)\d*\.xml$/,
  // Data store properties (schema references and ids).
  /^customXml\/itemProps\d*\.xml$/,
  // Legacy VML drawing parts: layer zero scrubs attribute and text values.
  /^word\/(?:glossary\/)?vmlDrawing\d*\.vml$/,
  // Office add-in (web extension) manifests: ids and store references.
  /^word\/(?:glossary\/)?webextensions\/[^/]+\.xml$/,
  // Known limit: InkML pen strokes are coordinates, not text.
  /^word\/(?:glossary\/)?ink\/[^/]+$/,
];

/** Content-type-derived label for an embedded package or OLE object. */
export function embeddedObjectLabel(path: string, contentType: string | null): string {
  const type = (contentType ?? '').toLowerCase();
  const ext = extensionOf(path);
  if (/spreadsheetml|ms-excel|x-excel/.test(type) || /^xls[xmb]?$/.test(ext)) return 'embedded Excel sheet';
  if (/wordprocessingml|msword/.test(type) || /^do[ct][xm]?$/.test(ext)) return 'embedded document';
  if (/presentationml|ms-powerpoint/.test(type) || /^pp[ts][xm]?$/.test(ext)) return 'embedded presentation';
  return 'embedded object';
}

export const DOCX_UNREDACTABLE_PARTS: readonly UnredactableRule[] = [
  { pattern: /^word\/(?:glossary\/)?embeddings\/[^/]+$/, kind: 'embedded-object', label: embeddedObjectLabel },
  // vbaProject.bin, vbaData.xml, vbaProjectSignature*.bin
  { pattern: /^word\/(?:glossary\/)?vba[A-Za-z]*\.(?:bin|xml)$/, kind: 'macros', label: 'macros' },
  // Word names the HTML/MHT payload of w:altChunk afchunk.mht; other
  // generators number them (afchunk1.htm). Any other part referenced by a
  // w:altChunk is reported by the reader through collectUnredactableParts.
  { pattern: /^word\/(?:glossary\/)?afchunk[^/]*$/i, kind: 'html-chunk', label: 'HTML chunk' },
  { pattern: /^word\/(?:glossary\/)?printerSettings\/[^/]+$/, kind: 'printer-settings', label: 'printer settings' },
  { pattern: /^word\/intelligence\d*\.xml$/, kind: 'unknown', label: 'editor analysis data' },
  { pattern: /^word\/(?:glossary\/)?activeX\/[^/]+$/, kind: 'embedded-object', label: 'ActiveX control' },
];

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

/** Parts the xlsx reader extracts: shared strings, worksheets, comments. */
export const XLSX_SHEET_TEXT_PARTS = /^xl\/(?:sharedStrings\.xml|worksheets\/[^/]+\.xml|comments\d*\.xml|threadedComments\/[^/]+\.xml)$/;

/** DrawingML parts read with drawingUnits (T175): drawing text boxes and charts. */
export const XLSX_DRAWING_TEXT_PARTS = /^xl\/(?:drawings\/drawing\d*|charts\/chart(?:Ex)?\d*)\.xml$/;

export const XLSX_TEXT_PARTS: readonly RegExp[] = [
  XLSX_SHEET_TEXT_PARTS,
  XLSX_DRAWING_TEXT_PARTS,
];

export const XLSX_STRUCTURAL_PARTS: readonly RegExp[] = [
  ...COMMON_STRUCTURAL_PARTS,
  // Workbook: sheet names and defined names are scrubbed by value (layer
  // zero); T176 turns them into text units.
  /^xl\/workbook\.xml$/,
  /^xl\/(?:styles|calcChain|metadata)\.xml$/,
  /^xl\/theme\/.+$/,
  /^xl\/ctrlProps\/[^/]+$/,
  // Threaded-comment person registry: display names scrubbed by the writer.
  /^xl\/persons\/[^/]+\.xml$/,
  // Tables, pivot tables and caches: header/cache strings scrubbed by value
  // (layer zero); T176 owns their extraction.
  /^xl\/(?:tables|pivotTables|pivotCache)\/[^/]+\.xml$/,
  /^xl\/drawings\/vmlDrawing\d*\.vml$/,
  /^xl\/charts\/(?:style|colors)\d*\.xml$/,
  /^xl\/(?:chartsheets|dialogsheets)\/[^/]+\.xml$/,
  // Known limit: images are copied as-is (no OCR).
  /^xl\/media\/[^/]+$/,
  // Rich data (data types, images in cells): values scrubbed by layer zero.
  /^xl\/richData\/[^/]+\.xml$/,
  /^xl\/(?:slicers|slicerCaches|timelines|timelineCaches|namedSheetViews|webextensions)\/[^/]+\.xml$/,
  // customXml in a workbook holds Power Query mashups (base64) and data
  // store properties; scrubbed by value, not extracted (T176 note).
  /^customXml\/item(?:Props)?\d*\.xml$/,
];

export const XLSX_UNREDACTABLE_PARTS: readonly UnredactableRule[] = [
  { pattern: /^xl\/embeddings\/[^/]+$/, kind: 'embedded-object', label: embeddedObjectLabel },
  { pattern: /^xl\/vba[A-Za-z]*\.(?:bin|xml)$/, kind: 'macros', label: 'macros' },
  // Excel 4.0 macro sheets
  { pattern: /^xl\/macrosheets\/[^/]+\.xml$/, kind: 'macros', label: 'macro sheet' },
  { pattern: /^xl\/connections\.xml$/, kind: 'external-data', label: 'external data connection' },
  { pattern: /^xl\/queryTables\/[^/]+$/, kind: 'external-data', label: 'external data query' },
  { pattern: /^xl\/externalLinks\/[^/]+$/, kind: 'external-data', label: 'external workbook link' },
  // Power Pivot data model (Analysis Services database with the source rows)
  { pattern: /^xl\/model\/[^/]+$/, kind: 'external-data', label: 'data model' },
  { pattern: /^xl\/printerSettings\/[^/]+$/, kind: 'printer-settings', label: 'printer settings' },
  { pattern: /^xl\/activeX\/[^/]+$/, kind: 'embedded-object', label: 'ActiveX control' },
];

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function tablesFor(kind: PackageKind): {
  text: readonly RegExp[];
  structural: readonly RegExp[];
  unredactable: readonly UnredactableRule[];
} {
  return kind === 'docx'
    ? { text: DOCX_TEXT_PARTS, structural: DOCX_STRUCTURAL_PARTS, unredactable: DOCX_UNREDACTABLE_PARTS }
    : { text: XLSX_TEXT_PARTS, structural: XLSX_STRUCTURAL_PARTS, unredactable: XLSX_UNREDACTABLE_PARTS };
}

/** The unredactable rule that matches the part, if any. */
export function unredactableRuleFor(path: string, kind: PackageKind): UnredactableRule | null {
  for (const rule of tablesFor(kind).unredactable) {
    if (rule.pattern.test(path)) return rule;
  }
  return null;
}

/**
 * Classify one zip entry (relative path, no leading slash) of a docx or xlsx
 * package. Unredactable rules win over the text and structural tables so a
 * misplaced binary can never be declared structural by a broad pattern.
 */
export function classifyPart(path: string, kind: PackageKind): PartClass {
  const tables = tablesFor(kind);
  if (unredactableRuleFor(path, kind)) return 'unredactable';
  if (tables.text.some((re) => re.test(path))) return 'text';
  if (tables.structural.some((re) => re.test(path))) return 'structural';
  return 'unknown';
}

/**
 * The UnredactablePart record for a part that classifies as unredactable
 * or unknown (a text or structural part yields null).
 */
export function describeUnredactablePart(
  path: string,
  kind: PackageKind,
  contentType: string | null = null
): UnredactablePart | null {
  const rule = unredactableRuleFor(path, kind);
  if (rule) {
    const label = typeof rule.label === 'function' ? rule.label(path, contentType) : rule.label;
    return { part: path, kind: rule.kind, label };
  }
  if (classifyPart(path, kind) === 'unknown') {
    return { part: path, kind: 'unknown', label: `unrecognised part ${path}` };
  }
  return null;
}

// ---------------------------------------------------------------------------
// [Content_Types].xml and relationships
// ---------------------------------------------------------------------------

export interface ContentTypeIndex {
  /** Extension (lower case, no dot) to media type */
  defaults: Map<string, string>;
  /** Part name (no leading slash) to media type */
  overrides: Map<string, string>;
}

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot + 1).toLowerCase();
}

/** Parse [Content_Types].xml; an absent or malformed manifest yields empty maps. */
export async function readContentTypes(zip: JSZip): Promise<ContentTypeIndex> {
  const index: ContentTypeIndex = { defaults: new Map(), overrides: new Map() };
  const file = zip.file('[Content_Types].xml');
  if (!file) return index;
  const doc = new DOMParser().parseFromString(await file.async('string'), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) return index;
  const all = doc.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const type = el.getAttribute('ContentType');
    if (!type) continue;
    if (el.localName === 'Default') {
      const ext = el.getAttribute('Extension');
      if (ext) index.defaults.set(ext.toLowerCase(), type);
    } else if (el.localName === 'Override') {
      const name = el.getAttribute('PartName');
      if (name) index.overrides.set(name.replace(/^\//, ''), type);
    }
  }
  return index;
}

/** Media type of a part: its Override, else the Default for its extension. */
export function contentTypeOf(index: ContentTypeIndex, path: string): string | null {
  return index.overrides.get(path) ?? index.defaults.get(extensionOf(path)) ?? null;
}

/** Resolve a relationship target against the part that owns the relationship. */
export function resolvePartPath(ownerPart: string, target: string): string {
  const cleaned = target.replace(/^\.\//, '');
  const base = cleaned.startsWith('/') ? [] : ownerPart.split('/').slice(0, -1);
  const segments = [...base];
  for (const segment of cleaned.replace(/^\//, '').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

export interface PartRelationship {
  /** Relationship type URI */
  type: string;
  /** Raw Target attribute */
  target: string;
  /** True for TargetMode="External" */
  external: boolean;
  /** Zip path of the target for internal relationships, null for external ones */
  path: string | null;
}

/**
 * The relationships of one part (its `_rels/<name>.rels` sibling), keyed by
 * Id, with internal targets resolved to zip paths. Absent or malformed rels
 * yield an empty map.
 */
export async function relationshipsOf(zip: JSZip, partPath: string): Promise<Map<string, PartRelationship>> {
  const result = new Map<string, PartRelationship>();
  const slash = partPath.lastIndexOf('/');
  const dir = slash === -1 ? '' : partPath.slice(0, slash + 1);
  const name = partPath.slice(slash + 1);
  const file = zip.file(`${dir}_rels/${name}.rels`);
  if (!file) return result;
  const doc = new DOMParser().parseFromString(await file.async('string'), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) return result;
  const rels = doc.getElementsByTagName('Relationship');
  for (let i = 0; i < rels.length; i++) {
    const rel = rels[i];
    const id = rel.getAttribute('Id');
    const target = rel.getAttribute('Target');
    if (!id || target === null) continue;
    const external = rel.getAttribute('TargetMode') === 'External';
    result.set(id, {
      type: rel.getAttribute('Type') ?? '',
      target,
      external,
      path: external ? null : resolvePartPath(partPath, target),
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Package walk
// ---------------------------------------------------------------------------

export interface CollectUnredactableOptions {
  /**
   * Parts referenced by w:altChunk (resolved by the docx reader). They are
   * reported as 'html-chunk' whatever their name, since Word imports their
   * content verbatim into the document.
   */
  htmlChunkParts?: Iterable<string>;
}

/**
 * Every part of the package the writer would copy verbatim, with a kind and
 * a human label, sorted by part name. Never throws: the decision what to do
 * with the list belongs to the host (informed-consent export).
 */
export async function collectUnredactableParts(
  zip: JSZip,
  kind: PackageKind,
  options: CollectUnredactableOptions = {}
): Promise<UnredactablePart[]> {
  const index = await readContentTypes(zip);
  const chunks = new Set(options.htmlChunkParts ?? []);
  const parts: UnredactablePart[] = [];
  zip.forEach((path, entry) => {
    if (entry.dir) return;
    if (chunks.has(path)) {
      parts.push({ part: path, kind: 'html-chunk', label: 'HTML chunk' });
      return;
    }
    const described = describeUnredactablePart(path, kind, contentTypeOf(index, path));
    if (described) parts.push(described);
  });
  parts.sort((a, b) => (a.part < b.part ? -1 : a.part > b.part ? 1 : 0));
  return parts;
}

// ---------------------------------------------------------------------------
// Unpacked-size guard (L4, zip bomb)
// ---------------------------------------------------------------------------

/** Default limit on the sum of declared uncompressed entry sizes: 200 MB. */
export const MAX_UNPACKED_BYTES = 200 * 1024 * 1024;

/**
 * Sum of the uncompressed sizes of every entry, from the zip directory (no
 * inflation happens here). JSZip verifies the declared size against the
 * inflated length when a part is read, so a directory that lies is refused
 * later with a corrupted-zip error instead of being inflated past the limit.
 */
export function unpackedSize(zip: JSZip): number {
  let total = 0;
  zip.forEach((_path, entry) => {
    if (entry.dir) return;
    const data = (entry as unknown as { _data?: unknown })._data;
    if (typeof data === 'string') {
      total += data.length;
    } else if (data && typeof data === 'object') {
      const size = (data as { uncompressedSize?: unknown; byteLength?: unknown; length?: unknown });
      if (typeof size.uncompressedSize === 'number') total += size.uncompressedSize;
      else if (typeof size.byteLength === 'number') total += size.byteLength;
      else if (typeof size.length === 'number') total += size.length;
    }
  });
  return total;
}

/** Throw UnsupportedDocumentError('too-large') when the package exceeds the limit. */
export function assertUnpackedSize(zip: JSZip, limit: number = MAX_UNPACKED_BYTES): void {
  const total = unpackedSize(zip);
  if (total > limit) {
    throw new UnsupportedDocumentError(
      'too-large',
      `Package unpacks to ${total} bytes, above the ${limit} byte limit`,
      [String(total), String(limit)],
    );
  }
}
