/**
 * @doccloak/core/dom - xlsx read/write (T110, file redaction phase 1).
 *
 * Minimal zip+XML implementation on the package's existing JSZip + DOMParser
 * machinery (the same stack the docx module uses). SheetJS was considered and
 * rejected at claim time: the community edition is Apache-2.0 but is a heavy
 * dependency distributed outside npm since 0.18.x (vendor CDN), and DocCloak
 * only needs string-cell rewriting, not formula evaluation or format
 * conversion. The zip+XML path keeps the dependency surface unchanged.
 *
 * Text-bearing locations covered:
 * - xl/sharedStrings.xml <si> entries (plain and rich-text runs, phonetic runs)
 * - worksheet inline strings (<c t="inlineStr"><is>...)
 * - worksheet cached formula string results (<c t="str"><v>)
 * - worksheet header/footer definitions
 * - legacy cell comments (xl/comments*.xml) and threaded comments
 *
 * - drawing text boxes and chart titles / string caches (xl/drawings,
 *   xl/charts) through the DrawingML units (T175)
 *
 * Deliberately out of scope (T176): sheet names, defined-name formulas, table
 * column names, pivot caches; layer zero scrubs known values there. Data
 * connections and external links are reported as unredactable (T177).
 * Metadata scrubbing follows the docx module's policy via the shared OPC
 * helpers.
 */

import JSZip from 'jszip';
import type { ValueReplacement } from '../docx.ts';
import { applyTextReplacements, assertUnredactableAllowed, unredactableWarnings } from './docx.ts';
import type { TextNodeMapping } from './docx.ts';
import { drawingUnits } from './drawingml.ts';
import {
  XLSX_DRAWING_TEXT_PARTS,
  MAX_UNPACKED_BYTES,
  assertUnpackedSize,
  collectUnredactableParts,
} from './package-policy.ts';
import {
  OOXML_NS,
  isElementIn,
  elementsByLocalName,
  foreignNamespaces,
  readXmlPart,
  writeXmlPart,
  scrubDocPropsParts,
  normalizeZipEntries,
  removePackageThumbnail,
  scrubExternalRelTargets,
  replaceSensitiveValues,
  scrubPackageValues,
} from './opc.ts';
import { getFileExtension } from './docx.ts';
import { UnsupportedDocumentError } from './errors.ts';
import type { UnredactablePart } from './errors.ts';

interface XlsxContentPart {
  path: string;
  xmlDoc: Document;
  textNodes: TextNodeMapping[];
}

/**
 * Result of extracting text from an xlsx file. Mirrors DocxExtraction: a flat
 * plain text plus a mapping from flat positions back to XML text elements, so
 * detection offsets can be applied surgically without touching formatting.
 */
export interface XlsxExtraction {
  /** Flat plain text: one line per string unit (shared string, cell, comment) */
  plainText: string;
  /** The JSZip instance for re-packaging */
  zip: JSZip;
  /** All text-bearing parts with their per-part node mappings */
  contentParts: XlsxContentPart[];
  /** All text node mappings across parts, in flat-text order */
  textNodes: TextNodeMapping[];
  /** True when no text-bearing content was found (T172). */
  empty: boolean;
  /**
   * Parts the writer cannot redact (embedded objects, macros, data
   * connections, external links, printer settings, unknown parts), from the
   * package policy (T177). The writer refuses to export them unless
   * allowUnredactable is passed.
   */
  unredactable: UnredactablePart[];
  /** Read-time notes (reserved; T172 reports none for xlsx). */
  warnings: string[];
}

/**
 * One string unit: the leaf elements whose concatenated text forms an
 * independent string (a shared-string entry, an inline cell, a cached formula
 * result, a header/footer definition, a comment body). Units are separated by
 * newlines in the flat text so values from adjacent cells never concatenate
 * into false detections.
 */
type StringUnit = Element[];

/** True for a SpreadsheetML element (transitional or strict namespace, T172). */
export function isSpreadsheetEl(el: Element, localName: string): boolean {
  return isElementIn(el, OOXML_NS.ss, localName);
}

function isSpreadsheetNs(el: Element): boolean {
  return el.namespaceURI !== null && OOXML_NS.ss.has(el.namespaceURI);
}

/** Collect descendant <t> elements (spreadsheet namespace) in document order. */
function collectTextLeaves(root: Element): Element[] {
  const result: Element[] = [];
  const all = root.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    if (isSpreadsheetEl(all[i], 't')) result.push(all[i]);
  }
  return result;
}

/** String units in xl/sharedStrings.xml: one per <si>. */
function sharedStringUnits(xmlDoc: Document): StringUnit[] {
  const units: StringUnit[] = [];
  for (const si of elementsByLocalName(xmlDoc, OOXML_NS.ss, 'si')) {
    units.push(collectTextLeaves(si));
  }
  return units;
}

/** A cell number that can be an identifier: an integer of seven or more digits. */
const NUMERIC_IDENTIFIER = /^[+-]?\d{7,}$/;
/** What SpreadsheetML accepts as a numeric <v>. */
const NUMERIC_VALUE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * After replacement, a numeric cell whose <v> no longer holds a number
 * (it now carries a placeholder) would make Excel repair the workbook. Turn
 * it into an inline string cell and drop its formula, which would otherwise
 * recompute the original number (T176).
 */
function normalizeReplacedNumericCells(xmlDoc: Document): void {
  for (const cell of elementsByLocalName(xmlDoc, OOXML_NS.ss, 'c')) {
    const type = cell.getAttribute('t');
    if (type !== null && type !== 'n') continue;
    let v: Element | null = null;
    let f: Element | null = null;
    for (let c = 0; c < cell.children.length; c++) {
      const child = cell.children[c];
      if (isSpreadsheetEl(child, 'v')) v = child;
      else if (isSpreadsheetEl(child, 'f')) f = child;
    }
    if (!v) continue;
    const text = v.textContent ?? '';
    if (text.length === 0 || NUMERIC_VALUE.test(text)) continue;
    cell.setAttribute('t', 'inlineStr');
    if (f) cell.removeChild(f);
    const is = xmlDoc.createElementNS(cell.namespaceURI, 'is');
    const t = xmlDoc.createElementNS(cell.namespaceURI, 't');
    t.setAttribute('xml:space', 'preserve');
    t.textContent = text;
    is.appendChild(t);
    cell.replaceChild(is, v);
  }
}

const HEADER_FOOTER_NAMES = new Set([
  'oddHeader', 'oddFooter', 'evenHeader', 'evenFooter', 'firstHeader', 'firstFooter',
]);

/**
 * String units in a worksheet: inline-string cells, cached string formula
 * results and header/footer definitions, in document order.
 */
function worksheetUnits(xmlDoc: Document): StringUnit[] {
  const units: StringUnit[] = [];
  const all = xmlDoc.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (!isSpreadsheetNs(el)) continue;
    if (el.localName === 'c') {
      const type = el.getAttribute('t');
      if (type === 'inlineStr') {
        const leaves = collectTextLeaves(el);
        if (leaves.length > 0) units.push(leaves);
      } else if (type === 'str') {
        // Cached formula result; the <f> formula itself is scrubbed by value.
        for (let c = 0; c < el.children.length; c++) {
          const child = el.children[c];
          if (isSpreadsheetEl(child, 'v')) units.push([child]);
        }
      } else if (type === null || type === 'n') {
        // Numeric cells (T176): a PESEL, phone or account number typed into
        // a cell is stored as a number. Values of at least seven digits are
        // extracted so the detectors see them; a replaced cell is turned
        // into an inline string on write (normalizeReplacedNumericCells).
        // Shorter numbers (amounts, counts, dates as serials) are not
        // identifiers and stay out of the text.
        for (let c = 0; c < el.children.length; c++) {
          const child = el.children[c];
          if (isSpreadsheetEl(child, 'v') && NUMERIC_IDENTIFIER.test(child.textContent ?? '')) units.push([child]);
        }
      }
    } else if (HEADER_FOOTER_NAMES.has(el.localName)) {
      units.push([el]);
    }
  }
  return units;
}

/**
 * String units in a comments part. Legacy comments keep text in <t> leaves
 * under each <comment><text>; threaded comments keep plain text in a <text>
 * element (Microsoft threadedComments namespace, matched by local name).
 */
function commentUnits(xmlDoc: Document): StringUnit[] {
  const units: StringUnit[] = [];
  const root = xmlDoc.documentElement;
  if (root.localName === 'comments') {
    for (const text of elementsByLocalName(xmlDoc, OOXML_NS.ss, 'text')) {
      const leaves = collectTextLeaves(text);
      if (leaves.length > 0) units.push(leaves);
    }
  } else {
    // threadedComments (or any other vendor comments schema): plain-text
    // <text> leaves, matched leniently by local name.
    const all = xmlDoc.getElementsByTagName('*');
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (el.localName === 'text' && el.childElementCount === 0) {
        units.push([el]);
      }
    }
  }
  return units;
}

/** Options for readXlsx (T177). */
export interface XlsxReadOptions {
  /**
   * Limit on the sum of the declared uncompressed sizes of all zip entries
   * (zip-bomb guard, L4); above it the reader throws
   * UnsupportedDocumentError('too-large'). Defaults to MAX_UNPACKED_BYTES.
   */
  maxUnpackedBytes?: number;
}

/**
 * Read a .xlsx file and extract its text content with position mapping.
 */
export async function readXlsx(file: File, options: XlsxReadOptions = {}): Promise<XlsxExtraction> {
  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);
  assertUnpackedSize(zip, options.maxUnpackedBytes ?? MAX_UNPACKED_BYTES);

  if (!zip.file('xl/workbook.xml')) {
    throw new Error('Invalid .xlsx file: missing xl/workbook.xml');
  }

  // Deterministic part order so load-time and export-time extractions produce
  // identical offsets: sharedStrings, then worksheets, then comment parts,
  // then drawing text boxes and charts (T175: a:p paragraphs, string caches).
  const worksheetPaths: string[] = [];
  const commentPaths: string[] = [];
  const drawingPaths: string[] = [];
  zip.forEach((relativePath) => {
    if (/^xl\/worksheets\/[^/]+\.xml$/.test(relativePath)) {
      worksheetPaths.push(relativePath);
    } else if (
      /^xl\/comments\d*\.xml$/.test(relativePath) ||
      /^xl\/threadedComments\/[^/]+\.xml$/.test(relativePath)
    ) {
      commentPaths.push(relativePath);
    } else if (XLSX_DRAWING_TEXT_PARTS.test(relativePath)) {
      drawingPaths.push(relativePath);
    }
  });
  worksheetPaths.sort();
  commentPaths.sort();
  drawingPaths.sort();

  const partPlans: Array<{ path: string; unitsOf: (doc: Document) => StringUnit[] }> = [
    { path: 'xl/sharedStrings.xml', unitsOf: sharedStringUnits },
    ...worksheetPaths.map((path) => ({ path, unitsOf: worksheetUnits })),
    ...commentPaths.map((path) => ({ path, unitsOf: commentUnits })),
    ...drawingPaths.map((path) => ({ path, unitsOf: drawingUnits })),
  ];

  let flatText = '';
  const contentParts: XlsxContentPart[] = [];
  // Fail closed (H1): worksheets whose sheetData is not SpreadsheetML in a
  // namespace we read (transitional or strict) while foreign elements exist
  // are refused rather than copied through.
  let sheetDataFound = false;
  const foreign = new Set<string>();

  for (const plan of partPlans) {
    const xmlDoc = await readXmlPart(zip, plan.path);
    if (!xmlDoc) continue;
    if (plan.unitsOf === worksheetUnits) {
      if (elementsByLocalName(xmlDoc, OOXML_NS.ss, 'sheetData').length > 0) sheetDataFound = true;
      else for (const ns of foreignNamespaces(xmlDoc)) foreign.add(ns);
    }

    const textNodes: TextNodeMapping[] = [];
    for (const unit of plan.unitsOf(xmlDoc)) {
      const nodes: TextNodeMapping[] = [];
      let unitLength = 0;
      for (const element of unit) {
        const text = element.textContent ?? '';
        if (text.length === 0) continue;
        nodes.push({ element, flatStart: unitLength, flatEnd: unitLength + text.length });
        unitLength += text.length;
      }
      if (unitLength === 0) continue;
      const base = flatText.length === 0 ? 0 : flatText.length + 1;
      if (flatText.length > 0) flatText += '\n';
      for (const node of nodes) {
        node.flatStart += base;
        node.flatEnd += base;
        flatText += node.element.textContent ?? '';
        textNodes.push(node);
      }
    }

    contentParts.push({ path: plan.path, xmlDoc, textNodes });
  }

  if (worksheetPaths.length > 0 && !sheetDataFound && foreign.size > 0) {
    throw new UnsupportedDocumentError(
      'unrecognized-namespace',
      `Unsupported .xlsx: no SpreadsheetML sheetData in any worksheet, found elements in ${[...foreign].join(', ')}`,
      [...foreign],
    );
  }

  // Package policy (T177): parts the writer would copy verbatim are
  // reported; the writer refuses them until the host passes allowUnredactable.
  const unredactable = await collectUnredactableParts(zip, 'xlsx');

  return {
    plainText: flatText,
    zip,
    contentParts,
    textNodes: contentParts.flatMap((part) => part.textNodes),
    empty: flatText.trim().length === 0,
    unredactable,
    warnings: [],
  };
}

/**
 * Scrub identity-bearing attributes inside a worksheet or comments part:
 * hyperlink display/tooltip strings, legacy comment author registry, and
 * literal strings inside formulas (<f>), which offset replacement cannot
 * reach because formulas are not part of the flat text.
 */
function sanitizeXlsxPart(xmlDoc: Document, valueReplacements: ValueReplacement[]): void {
  const all = xmlDoc.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (el.localName === 'hyperlink') {
      for (const attr of ['display', 'tooltip', 'location']) {
        const value = el.getAttribute(attr);
        if (value) el.setAttribute(attr, replaceSensitiveValues(value, valueReplacements, false));
      }
    } else if (isSpreadsheetEl(el, 'f')) {
      const formula = el.textContent ?? '';
      const scrubbed = replaceSensitiveValues(formula, valueReplacements, false);
      if (scrubbed !== formula) el.textContent = scrubbed;
    } else if (el.localName === 'author' && el.parentElement?.localName === 'authors') {
      // Legacy comments author registry (indexes must stay stable)
      el.textContent = 'Redacted';
    }
  }
}

/**
 * Scrub metadata parts that survive text replacement untouched: docProps,
 * the package thumbnail, the workbook's absolute-path fingerprint and
 * file-sharing identity, the threaded-comment person registry, and external
 * relationship targets (hyperlink mailto:/URLs).
 */
async function sanitizeXlsxMetadata(zip: JSZip, valueReplacements: ValueReplacement[]): Promise<void> {
  await scrubDocPropsParts(zip);
  await removePackageThumbnail(zip);

  // Workbook: x15ac:absPath records the full local path the file was saved
  // from (user name, client folders); fileSharing records the reserving user.
  const workbook = await readXmlPart(zip, 'xl/workbook.xml');
  if (workbook) {
    const all = workbook.getElementsByTagName('*');
    const doomed: Element[] = [];
    for (let i = 0; i < all.length; i++) {
      if (all[i].localName === 'absPath' || all[i].localName === 'fileSharing') {
        doomed.push(all[i]);
      }
    }
    for (const el of doomed) el.parentNode?.removeChild(el);
    writeXmlPart(zip, 'xl/workbook.xml', workbook);
  }

  // Threaded-comment person registry: display names and provider user ids
  const personsPaths: string[] = [];
  zip.forEach((relativePath) => {
    if (/^xl\/persons\/[^/]+\.xml$/.test(relativePath)) personsPaths.push(relativePath);
  });
  for (const path of personsPaths.sort()) {
    const persons = await readXmlPart(zip, path);
    if (!persons) continue;
    const all = persons.getElementsByTagName('*');
    for (let i = 0; i < all.length; i++) {
      const attrs = all[i].attributes;
      for (let a = 0; a < attrs.length; a++) {
        if (attrs[a].localName === 'displayName' || attrs[a].localName === 'userId') {
          attrs[a].value = 'Redacted';
        }
      }
    }
    writeXmlPart(zip, path, persons);
  }

  await scrubExternalRelTargets(
    zip,
    /^xl\/(?:[^/]+\/)*_rels\/[^/]+\.rels$/,
    valueReplacements
  );
}

/** Result of writeAnonymizedXlsxWithReport (T172). */
export interface XlsxWriteResult {
  /** The redacted .xlsx */
  blob: Blob;
  /**
   * Parts the layer-zero scrub could not parse and left untouched, plus
   * (with allowUnredactable) every unredactable part copied verbatim.
   */
  warnings: string[];
}

/** Options for writeAnonymizedXlsx (T177). */
export interface XlsxWriteOptions {
  /**
   * Export even though extraction.unredactable is non-empty: the listed
   * parts are copied verbatim and named in result.warnings. Default false:
   * the writer throws UnsupportedDocumentError('unredactable-parts') before
   * touching the extraction. See DocxWriteOptions.allowUnredactable.
   */
  allowUnredactable?: boolean;
}

/**
 * Apply text replacements to the xlsx XML, preserving formatting, then scrub
 * metadata. Returns a new .xlsx file as a Blob; the input file is untouched.
 */
export async function writeAnonymizedXlsx(
  extraction: XlsxExtraction,
  replacements: Array<{ start: number; end: number; replacement: string }>,
  valueReplacements: ValueReplacement[] = [],
  options: XlsxWriteOptions = {}
): Promise<Blob> {
  const result = await writeAnonymizedXlsxWithReport(extraction, replacements, valueReplacements, options);
  return result.blob;
}

/**
 * Same as writeAnonymizedXlsx, with the write report. After the content
 * parts and metadata, layer zero (T172) scrubs every known value from every
 * other XML/rels/vml part: pivot cache records, drawings, charts, tables,
 * defined names in the workbook, docProps.
 */
export async function writeAnonymizedXlsxWithReport(
  extraction: XlsxExtraction,
  replacements: Array<{ start: number; end: number; replacement: string }>,
  valueReplacements: ValueReplacement[] = [],
  options: XlsxWriteOptions = {}
): Promise<XlsxWriteResult> {
  assertUnredactableAllowed(extraction.unredactable, options.allowUnredactable);

  applyTextReplacements(extraction.textNodes, replacements);

  const contentPaths = new Set<string>();
  for (const part of extraction.contentParts) {
    if (/^xl\/worksheets\//.test(part.path)) normalizeReplacedNumericCells(part.xmlDoc);
    sanitizeXlsxPart(part.xmlDoc, valueReplacements);
    writeXmlPart(extraction.zip, part.path, part.xmlDoc);
    contentPaths.add(part.path);
  }

  await sanitizeXlsxMetadata(extraction.zip, valueReplacements);

  const scrub = await scrubPackageValues(extraction.zip, valueReplacements, { skip: contentPaths });

  // Container normalisation (T179): fixed entry dates, no comments.
  normalizeZipEntries(extraction.zip);
  const blob = await extraction.zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    comment: '',
  });
  return { blob, warnings: [...scrub.warnings, ...unredactableWarnings(extraction.unredactable)] };
}

/**
 * Check if a file is a supported Excel workbook (.xlsx only; the legacy
 * binary .xls format is not supported in phase 1).
 */
export function isExcelFile(filename: string): boolean {
  return getFileExtension(filename) === 'xlsx';
}
