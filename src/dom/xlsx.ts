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
 * Outside this mapped text the same parts repeat cell values in attributes
 * and formulas (data validation lists and prompts, AutoFilter criteria,
 * conditional format formulas, alt text of shapes): the writer scrubs known
 * values there by value, and never in the mapped text itself, where the
 * positional replacements alone decide.
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
  scrubUnmappedValues,
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
  /**
   * What the reader did with the number cells (T265), so a host can say it:
   * cells shown as dates were read as dates, long integers as identifiers,
   * and the other numbers (amounts, counts) are not part of the text.
   */
  stats: XlsxCellStats;
  /** The first XLSX_UNCHECKED_LISTED number cells that were not checked (T269): sheet, cell, value. */
  uncheckedCells: XlsxUncheckedCell[];
  /**
   * Date cells whose <v> holds the date as text while the extraction lives
   * (serial numbers say nothing to a detector). The writer puts the serial
   * back into every cell that was not replaced. Internal.
   */
  dateCells: Map<Element, { serial: string; text: string }>;
}

/**
 * A number cell the reader left out of the text (an amount, a count, a short
 * code): where it is and what it shows, so a host can name what stays
 * readable in the exported workbook.
 */
export interface XlsxUncheckedCell {
  /** Sheet name as the workbook shows it (the part's file name when the workbook does not name it). */
  sheet: string;
  /** Cell reference, e.g. "F2"; empty when the cell carries none. */
  cell: string;
  /** The stored value (a formula's cached result for formula cells). */
  value: string;
}

/** How many unchecked cells are listed; the count in `stats` is always complete. */
export const XLSX_UNCHECKED_LISTED = 200;

/** Counts of number cells by what the reader did with them (T265). */
export interface XlsxCellStats {
  /** Cells shown as a date (number format or t="d"): in the text as YYYY-MM-DD. */
  dateCells: number;
  /** Integers of seven or more digits: in the text as written. */
  identifierCells: number;
  /** Every other number: not in the text, never replaced. */
  otherNumberCells: number;
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

// ── Date cells (T176 step 2, T265) ─────────────────────────
//
// Excel stores a date as a day count and shows it through the cell's number
// format. A column of birth dates is therefore a column of numbers such as
// 31118, which no detector reads as a date. The reader resolves each cell's
// style to its format, and a cell formatted as a date enters the text as
// YYYY-MM-DD.

/** Built-in number formats that show a date (ECMA-376 18.8.30 and the locale-reserved ids). */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

/** True when a custom format code shows a year or a day (quoted text, [sections] and escapes aside). */
function isDateFormatCode(code: string): boolean {
  const bare = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '').replace(/_./g, '').replace(/\*./g, '');
  return /[yd]/i.test(bare) || /mmm/i.test(bare);
}

/** Style indexes (cell @s) whose number format is a date, from xl/styles.xml. */
function dateStyleIndexes(styles: Document | null): Set<number> {
  const result = new Set<number>();
  if (!styles) return result;
  const custom = new Map<number, string>();
  for (const fmt of elementsByLocalName(styles, OOXML_NS.ss, 'numFmt')) {
    const id = Number(fmt.getAttribute('numFmtId'));
    if (Number.isInteger(id)) custom.set(id, fmt.getAttribute('formatCode') ?? '');
  }
  const cellXfs = elementsByLocalName(styles, OOXML_NS.ss, 'cellXfs')[0];
  if (!cellXfs) return result;
  let index = 0;
  for (let c = 0; c < cellXfs.children.length; c++) {
    const xf = cellXfs.children[c];
    if (!isSpreadsheetEl(xf, 'xf')) continue;
    const id = Number(xf.getAttribute('numFmtId') ?? '0');
    const code = custom.get(id);
    if (code !== undefined ? isDateFormatCode(code) : BUILTIN_DATE_FORMATS.has(id)) result.add(index);
    index++;
  }
  return result;
}

/** Largest serial Excel shows as a date (9999-12-31 in the 1900 system). */
const MAX_DATE_SERIAL = 2958465;

/**
 * The calendar date of a serial number as YYYY-MM-DD, or null when the
 * number is not a date Excel can show. 1900 system: serial 1 is 1900-01-01
 * and serial 60 is the 29 February 1900 that never existed (the Lotus 1-2-3
 * bug Excel keeps), so real dates from March 1900 on are one day closer to
 * the epoch. 1904 system: serial 0 is 1904-01-01. The time of day (the
 * fraction) is not part of the text.
 */
export function excelSerialToIsoDate(serial: number, date1904: boolean): string | null {
  if (!Number.isFinite(serial)) return null;
  const days = Math.floor(serial);
  if (days > MAX_DATE_SERIAL) return null;
  let utc: number;
  if (date1904) {
    if (days < 0) return null;
    utc = Date.UTC(1904, 0, 1) + days * 86_400_000;
  } else {
    if (days < 1 || days === 60) return null;
    utc = Date.UTC(1899, 11, days < 60 ? 31 : 30) + days * 86_400_000;
  }
  const d = new Date(utc);
  const year = d.getUTCFullYear();
  if (year < 1900 || year > 9999) return null;
  const two = (n: number) => String(n).padStart(2, '0');
  return `${year}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`;
}

/** What an ISO 8601 date cell (t="d") holds. */
const ISO_DATE_VALUE = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?$/;

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
    if (type !== null && type !== 'n' && type !== 'd') continue;
    let v: Element | null = null;
    let f: Element | null = null;
    for (let c = 0; c < cell.children.length; c++) {
      const child = cell.children[c];
      if (isSpreadsheetEl(child, 'v')) v = child;
      else if (isSpreadsheetEl(child, 'f')) f = child;
    }
    if (!v) continue;
    const text = v.textContent ?? '';
    if (text.length === 0 || (type === 'd' ? ISO_DATE_VALUE : NUMERIC_VALUE).test(text)) continue;
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

/** What the worksheet reader needs to tell dates from other numbers, and where it records what it did. */
interface NumberCellContext {
  dateStyles: Set<number>;
  date1904: boolean;
  dateCells: Map<Element, { serial: string; text: string }>;
  stats: XlsxCellStats;
  /** The first XLSX_UNCHECKED_LISTED number cells left out of the text. */
  unchecked: XlsxUncheckedCell[];
}

const HEADER_FOOTER_NAMES = new Set([
  'oddHeader', 'oddFooter', 'evenHeader', 'evenFooter', 'firstHeader', 'firstFooter',
]);

/**
 * String units in a worksheet: inline-string cells, cached string formula
 * results and header/footer definitions, in document order.
 */
function worksheetUnits(xmlDoc: Document, numbers?: NumberCellContext, sheet = ''): StringUnit[] {
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
        // A cell shown as a date (T265) enters the text as its date: the
        // <v> of the parsed copy holds YYYY-MM-DD until the writer puts the
        // serial back (or turns a replaced cell into an inline string).
        for (let c = 0; c < el.children.length; c++) {
          const child = el.children[c];
          if (!isSpreadsheetEl(child, 'v')) continue;
          const raw = child.textContent ?? '';
          if (raw.length === 0) continue;
          const style = Number(el.getAttribute('s') ?? '-1');
          const date = numbers && numbers.dateStyles.has(style) && NUMERIC_VALUE.test(raw)
            ? excelSerialToIsoDate(Number(raw), numbers.date1904)
            : null;
          if (date !== null && numbers) {
            numbers.dateCells.set(child, { serial: raw, text: date });
            child.textContent = date;
            numbers.stats.dateCells++;
            units.push([child]);
          } else if (NUMERIC_IDENTIFIER.test(raw)) {
            if (numbers) numbers.stats.identifierCells++;
            units.push([child]);
          } else if (numbers) {
            numbers.stats.otherNumberCells++;
            if (numbers.unchecked.length < XLSX_UNCHECKED_LISTED) {
              numbers.unchecked.push({ sheet, cell: el.getAttribute('r') ?? '', value: raw });
            }
          }
        }
      } else if (type === 'd') {
        // ISO 8601 date cell: text already, a replaced one becomes an inline string on write.
        for (let c = 0; c < el.children.length; c++) {
          const child = el.children[c];
          if (isSpreadsheetEl(child, 'v') && (child.textContent ?? '').length > 0) {
            if (numbers) numbers.stats.dateCells++;
            units.push([child]);
          }
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
      // Excel writes xl/commentsN.xml; other writers put the part in a folder (openpyxl:
      // xl/comments/commentN.xml). Both are the same legacy comments part.
      /^xl\/comments\d*\.xml$/.test(relativePath) ||
      /^xl\/comments\/[^/]+\.xml$/.test(relativePath) ||
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

  // Dates (T265): which styles show a date, and which calendar the workbook counts in.
  const workbookDoc = await readXmlPart(zip, 'xl/workbook.xml');
  const workbookPr = workbookDoc ? elementsByLocalName(workbookDoc, OOXML_NS.ss, 'workbookPr')[0] : undefined;
  const date1904 = /^(1|true)$/i.test(workbookPr?.getAttribute('date1904') ?? '');
  const numbers: NumberCellContext = {
    dateStyles: dateStyleIndexes(await readXmlPart(zip, 'xl/styles.xml')),
    date1904,
    dateCells: new Map(),
    stats: { dateCells: 0, identifierCells: 0, otherNumberCells: 0 },
    unchecked: [],
  };
  const sheetNames = await sheetNamesByPath(zip, workbookDoc);

  const partPlans: Array<{ path: string; unitsOf: (doc: Document) => StringUnit[]; worksheet?: boolean }> = [
    { path: 'xl/sharedStrings.xml', unitsOf: sharedStringUnits },
    ...worksheetPaths.map((path) => ({
      path,
      worksheet: true,
      unitsOf: (doc: Document): StringUnit[] => worksheetUnits(doc, numbers, sheetNames.get(path) ?? path.replace(/^.*\//, '').replace(/\.xml$/i, '')),
    })),
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
    if (plan.worksheet) {
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
    stats: numbers.stats,
    uncheckedCells: numbers.unchecked,
    dateCells: numbers.dateCells,
  };
}

/**
 * Worksheet part path -> sheet name, read from the workbook's sheet list and
 * its relationships. A sheet the workbook does not name is left out.
 */
async function sheetNamesByPath(zip: JSZip, workbookDoc: Document | null): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (!workbookDoc) return names;
  const relsDoc = await readXmlPart(zip, 'xl/_rels/workbook.xml.rels');
  if (!relsDoc) return names;
  const targets = new Map<string, string>();
  const rels = relsDoc.getElementsByTagName('*');
  for (let i = 0; i < rels.length; i++) {
    const rel = rels[i];
    if (rel.localName !== 'Relationship') continue;
    const id = rel.getAttribute('Id');
    const target = rel.getAttribute('Target');
    if (!id || !target) continue;
    targets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`);
  }
  for (const sheet of elementsByLocalName(workbookDoc, OOXML_NS.ss, 'sheet')) {
    let id: string | null = null;
    for (let a = 0; a < sheet.attributes.length; a++) {
      const attribute = sheet.attributes[a];
      if (attribute.localName === 'id' && attribute.name !== 'id') id = attribute.value;
    }
    const path = id ? targets.get(id) : undefined;
    const name = sheet.getAttribute('name');
    if (path && name) names.set(path, name);
  }
  return names;
}

/**
 * Elements whose text is a formula: a cell formula (f), a conditional
 * format formula (formula), the formulas of a data validation (formula1,
 * formula2), their Excel 2010 extension twins (xm:f) and chart ranges (c:f).
 */
const FORMULA_ELEMENTS = new Set(['f', 'formula', 'formula1', 'formula2']);

/**
 * What a formula is made of, as far as the scrub needs to tell: a string
 * literal ("..." with "" for a quote), a quoted sheet name ('...' with ''
 * for an apostrophe), the name of a function (a name followed by an
 * opening parenthesis), a cell reference (A1, $AB$12) and a column range
 * (A:C). Everything between them is plain formula code.
 */
const FORMULA_TOKEN = new RegExp(
  [
    '"(?:[^"]|"")*"?',
    "'(?:[^']|'')*'?",
    '(?<![\\p{L}\\p{N}_.])[\\p{L}_][\\p{L}\\p{N}_.]*\\s*\\(',
    '(?<![\\p{L}\\p{N}_.])\\$?[A-Za-z]{1,3}\\$?\\d{1,7}(?![\\p{L}\\p{N}_.(])',
    '(?<![\\p{L}\\p{N}_.])\\$?[A-Za-z]{1,3}:\\$?[A-Za-z]{1,3}(?![\\p{L}\\p{N}_.(])',
  ].join('|'),
  'gu',
);

/** A number of the formula itself: not a row of a reference (A12, $A$12, 1:12), not the fraction of a number. */
const numberInFormula = (digits: string): RegExp =>
  new RegExp(`(?<![\\p{L}\\p{N}_.$:!])${digits}(?![\\p{L}\\p{N}_.:!(])`, 'gu');

/**
 * Scrub the known values from one formula. A formula is code, so a plain
 * replacement over the whole string is not safe:
 * - inside a string literal every value is replaced, as in text: the items
 *   of a validation list ("Anna Nowak,Jan Kowalski") and compared strings
 *   ($A2="Jan Kowalski") become labels inside the same quotes;
 * - the name of a function is never rewritten: a person called Vera would
 *   turn AVERAGE into A[PERSON_1]GE, which is not a formula any more.
 *   Neither is a cell reference (a value "IT" and the column IT);
 * - a known number outside a literal becomes a string literal holding the
 *   label (A1=90010112345 gives A1="[SSN_1]"): a bare label would read as a
 *   structured reference. Row numbers of references are not numbers of the
 *   formula and stay;
 * - anything else outside a literal (a defined name, a table column that
 *   holds a value) is replaced as written.
 */
export function scrubFormulaValues(formula: string, valueReplacements: ValueReplacement[]): string {
  const active = valueReplacements.filter((pair) => pair.value.length > 0);
  if (active.length === 0) return formula;
  const numbers = active.filter((pair) => /^\d+$/.test(pair.value)).sort((a, b) => b.value.length - a.value.length);
  const others = active.filter((pair) => !/^\d+$/.test(pair.value));

  const scrubCode = (code: string): string => {
    let result = others.length > 0 ? replaceSensitiveValues(code, others, false) : code;
    for (const { value, replacement } of numbers) {
      result = result.replace(numberInFormula(value), () => `"${replacement.replace(/"/g, '""')}"`);
    }
    return result;
  };
  const scrubLiteral = (literal: string): string => {
    const closed = literal.length > 1 && literal.endsWith('"');
    const inner = literal.slice(1, closed ? -1 : undefined).replace(/""/g, '"');
    const scrubbed = replaceSensitiveValues(inner, active, false);
    return `"${scrubbed.replace(/"/g, '""')}${closed ? '"' : ''}`;
  };

  let out = '';
  let last = 0;
  for (const match of formula.matchAll(FORMULA_TOKEN)) {
    const token = match[0];
    out += scrubCode(formula.slice(last, match.index));
    if (token.startsWith('"')) out += scrubLiteral(token);
    // A quoted sheet name is scrubbed as written; a function name and a reference are kept.
    else out += token.startsWith("'") ? scrubCode(token) : token;
    last = match.index + token.length;
  }
  return out + scrubCode(formula.slice(last));
}

/**
 * Scrub identity-bearing attributes inside a worksheet or comments part:
 * hyperlink display/tooltip strings, legacy comment author registry, and
 * the formulas (cell formulas, data validation lists, conditional format
 * formulas, chart ranges), which offset replacement cannot reach because
 * formulas are not part of the flat text. Returns the formula elements, so
 * the caller's scrub of the unmapped text leaves them as they are now.
 */
function sanitizeXlsxPart(xmlDoc: Document, valueReplacements: ValueReplacement[]): Element[] {
  const formulas: Element[] = [];
  const all = xmlDoc.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (el.localName === 'hyperlink') {
      for (const attr of ['display', 'tooltip', 'location']) {
        const value = el.getAttribute(attr);
        if (value) el.setAttribute(attr, replaceSensitiveValues(value, valueReplacements, false));
      }
    } else if (FORMULA_ELEMENTS.has(el.localName) && el.childElementCount === 0) {
      formulas.push(el);
      const formula = el.textContent ?? '';
      const scrubbed = scrubFormulaValues(formula, valueReplacements);
      if (scrubbed !== formula) el.textContent = scrubbed;
    } else if (el.localName === 'author' && el.parentElement?.localName === 'authors') {
      // Legacy comments author registry (indexes must stay stable)
      el.textContent = 'Redacted';
    }
  }
  return formulas;
}

/** Attributes that address cells: where a rule applies, what a view shows. */
const CELL_REFERENCE_ATTRS = new Set(['ref', 'sqref', 'activeCell', 'topLeftCell']);

/** A cell, a range, or several separated by spaces: A1, $B$2:$D$9, "A1:A5 C1:C5". */
const CELL_REFERENCES = /^(?:\$?[A-Za-z]{1,3}\$?\d{1,7}(?::\$?[A-Za-z]{1,3}\$?\d{1,7})?(?: |$))+$/;

/**
 * True for an attribute that holds cell references. They are addresses,
 * never user text, and a short value that is also a column (AB, IT) must
 * not rewrite sqref="AB2:AB9".
 */
function isCellReference(_el: Element, attr: Attr): boolean {
  return CELL_REFERENCE_ATTRS.has(attr.localName) && CELL_REFERENCES.test(attr.value);
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

// ── Sheet names (T265) ─────────────────────────────────────
//
// A sheet is often named after the person or client it is about. Replacing
// the value in the name the way text is replaced gives "[PERSON_1]", and
// Excel refuses a sheet name with brackets (and reads '[PERSON_1]'!A1 as a
// reference to another workbook): the file opens only after a repair that
// drops the formulas. So a sheet whose name holds a value is renamed to a
// valid name, and every reference to it follows.

const MAX_SHEET_NAME_LENGTH = 31;

/**
 * A name Excel accepts for a sheet, made from `name`: no [ ] (a bracketed
 * placeholder keeps its token, like a renamed bookmark: PERSON_1), the other
 * forbidden characters : \ / ? * as underscores, no apostrophe at either
 * end, at most 31 characters, and not one of `taken` (lower-cased names
 * already in the workbook; the result is added to it).
 */
export function safeSheetName(name: string, taken: Set<string>): string {
  let safe = name.replace(/[[\]]/g, '').replace(/[:\\/?*]/g, '_').replace(/^'+|'+$/g, '').trim();
  if (safe.length === 0) safe = 'Sheet';
  safe = safe.slice(0, MAX_SHEET_NAME_LENGTH).trim();
  let candidate = safe;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) {
    const suffix = `_${n}`;
    candidate = safe.slice(0, MAX_SHEET_NAME_LENGTH - suffix.length).trim() + suffix;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

interface SheetRename { from: string; to: string }

/** A sheet name that formulas may write without quotes. */
const UNQUOTED_SHEET_NAME = /^[\p{L}_][\p{L}\p{N}_.]*$/u;

/** Rewrite references to renamed sheets in one string: 'Old name'!A1, Old!A1. */
function rewriteSheetRefsIn(value: string, renames: SheetRename[]): string {
  let out = value;
  for (const { from, to } of renames) {
    const target = `'${to.replace(/'/g, "''")}'!`;
    const quoted = `'${from.replace(/'/g, "''")}'!`;
    if (out.includes(quoted)) out = out.split(quoted).join(target);
    if (UNQUOTED_SHEET_NAME.test(from) && out.includes(`${from}!`)) {
      const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}_.'!\\]])${escaped}!`, 'gu'), () => target);
    }
  }
  return out;
}

/**
 * Rewrite every reference to a renamed sheet in a part: formulas, defined
 * names, data validation and conditional formatting formulas, chart ranges,
 * hyperlink locations (all of the form 'Sheet'!ref) and attributes that
 * name the sheet outright (pivot cache worksheetSource@sheet).
 */
function rewriteSheetRefs(doc: Document, renames: SheetRename[]): boolean {
  let changed = false;
  const byName = new Map(renames.map((r) => [r.from, r.to]));
  const visit = (node: Node) => {
    if (node.nodeType === 3 || node.nodeType === 4) {
      const value = node.nodeValue ?? '';
      if (!value.includes('!')) return;
      const next = rewriteSheetRefsIn(value, renames);
      if (next !== value) { node.nodeValue = next; changed = true; }
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    for (let a = 0; a < el.attributes.length; a++) {
      const attr = el.attributes[a];
      const exact = attr.localName === 'sheet' ? byName.get(attr.value) : undefined;
      const next = exact ?? (attr.value.includes('!') ? rewriteSheetRefsIn(attr.value, renames) : attr.value);
      if (next !== attr.value) { attr.value = next; changed = true; }
    }
    for (let child = el.firstChild; child; child = child.nextSibling) visit(child);
  };
  for (let child = doc.firstChild; child; child = child.nextSibling) visit(child);
  return changed;
}

/**
 * Rename the sheets whose name holds a sensitive value and point every
 * reference at the new name. Runs before the value scrub, while references
 * still carry the original (unambiguous) names. Returns the new names.
 */
async function renameSensitiveSheets(extraction: XlsxExtraction, valueReplacements: ValueReplacement[]): Promise<string[]> {
  if (valueReplacements.length === 0) return [];
  const zip = extraction.zip;
  const workbook = await readXmlPart(zip, 'xl/workbook.xml');
  if (!workbook) return [];
  const sheets = elementsByLocalName(workbook, OOXML_NS.ss, 'sheet');
  const names = sheets.map((sheet) => sheet.getAttribute('name') ?? '');
  const scrubbed = names.map((name) => replaceSensitiveValues(name, valueReplacements, false));
  if (names.every((name, i) => name === scrubbed[i])) return [];

  const taken = new Set(names.filter((name, i) => name === scrubbed[i]).map((name) => name.toLowerCase()));
  const renames: SheetRename[] = [];
  sheets.forEach((sheet, i) => {
    if (names[i] === scrubbed[i]) return;
    const to = safeSheetName(scrubbed[i], taken);
    sheet.setAttribute('name', to);
    renames.push({ from: names[i], to });
  });
  // Longest first: a name that is the tail of another never pre-empts it.
  renames.sort((a, b) => b.from.length - a.from.length);

  rewriteSheetRefs(workbook, renames);
  writeXmlPart(zip, 'xl/workbook.xml', workbook);
  const inMemory = new Set<string>(['xl/workbook.xml']);
  for (const part of extraction.contentParts) {
    rewriteSheetRefs(part.xmlDoc, renames);
    inMemory.add(part.path);
  }
  const others: string[] = [];
  zip.forEach((relativePath, entry) => {
    if (!entry.dir && /^xl\/.+\.(?:xml|vml)$/i.test(relativePath) && !inMemory.has(relativePath)) others.push(relativePath);
  });
  for (const path of others.sort()) {
    const doc = await readXmlPart(zip, path);
    if (doc && rewriteSheetRefs(doc, renames)) writeXmlPart(zip, path, doc);
  }
  return renames.map((r) => r.to);
}

/** Result of writeAnonymizedXlsxWithReport (T172). */
export interface XlsxWriteResult {
  /** The redacted .xlsx */
  blob: Blob;
  /**
   * New names of the sheets that were renamed because their name held a
   * replaced value (T265). References to them were updated.
   */
  renamedSheets: string[];
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
 * Same as writeAnonymizedXlsx, with the write report. The positional
 * replacements go into the mapped text (cells, comments, text boxes); the
 * rest of each content part (attributes, data validation and conditional
 * format formulas) is scrubbed by value. After the content parts and
 * metadata, layer zero (T172) scrubs every known value from every other
 * XML/rels/vml part: pivot cache records, tables, defined names in the
 * workbook, docProps.
 */
export async function writeAnonymizedXlsxWithReport(
  extraction: XlsxExtraction,
  replacements: Array<{ start: number; end: number; replacement: string }>,
  valueReplacements: ValueReplacement[] = [],
  options: XlsxWriteOptions = {}
): Promise<XlsxWriteResult> {
  assertUnredactableAllowed(extraction.unredactable, options.allowUnredactable);

  applyTextReplacements(extraction.textNodes, replacements);

  // Date cells that were not replaced get their serial number back (T265);
  // the replaced ones no longer hold a number and become inline strings below.
  for (const [v, { serial, text }] of extraction.dateCells ?? []) {
    if (v.textContent === text) v.textContent = serial;
  }

  // Sheets named after a replaced value get a valid new name, and the
  // references to them follow, before any reference is touched by value.
  const renamedSheets = await renameSensitiveSheets(extraction, valueReplacements);

  const contentPaths = new Set<string>();
  for (const part of extraction.contentParts) {
    const formulas = sanitizeXlsxPart(part.xmlDoc, valueReplacements);
    // Outside the mapped text a content part holds copies of cell values the
    // user never sees as places: data validation lists and prompts, filter
    // criteria, conditional format formulas, alt text of shapes. They are
    // scrubbed by value. The mapped text is not: the replacements above say
    // which places the user chose, and a place kept visible stays visible.
    scrubUnmappedValues(
      part.xmlDoc,
      valueReplacements,
      [...part.textNodes, ...formulas.map((element) => ({ element }))],
      { keepAttribute: isCellReference },
    );
    if (/^xl\/worksheets\//.test(part.path)) normalizeReplacedNumericCells(part.xmlDoc);
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
  return { blob, renamedSheets, warnings: [...scrub.warnings, ...unredactableWarnings(extraction.unredactable)] };
}

/**
 * Check if a file is a supported Excel workbook (.xlsx only; the legacy
 * binary .xls format is not supported in phase 1).
 */
export function isExcelFile(filename: string): boolean {
  return getFileExtension(filename) === 'xlsx';
}
