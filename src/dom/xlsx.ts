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
 * Deliberately out of scope in phase 1 (documented for T-later): drawing/chart
 * text parts (xl/drawings, xl/charts), data connection definitions
 * (xl/connections.xml) and defined-name formulas. Metadata scrubbing follows
 * the docx module's policy via the shared OPC helpers.
 */

import JSZip from 'jszip';
import type { ValueReplacement } from '../docx.ts';
import { applyTextReplacements } from './docx.ts';
import type { TextNodeMapping } from './docx.ts';
import {
  readXmlPart,
  writeXmlPart,
  scrubDocPropsParts,
  removePackageThumbnail,
  scrubExternalRelTargets,
  replaceSensitiveValues,
} from './opc.ts';
import { getFileExtension } from './docx.ts';

const SS_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

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
}

/**
 * One string unit: the leaf elements whose concatenated text forms an
 * independent string (a shared-string entry, an inline cell, a cached formula
 * result, a header/footer definition, a comment body). Units are separated by
 * newlines in the flat text so values from adjacent cells never concatenate
 * into false detections.
 */
type StringUnit = Element[];

function isSpreadsheetEl(el: Element, localName: string): boolean {
  return el.namespaceURI === SS_NS && el.localName === localName;
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
  const sis = xmlDoc.getElementsByTagNameNS(SS_NS, 'si');
  for (let i = 0; i < sis.length; i++) {
    units.push(collectTextLeaves(sis[i]));
  }
  return units;
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
    if (el.namespaceURI !== SS_NS) continue;
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
    const texts = xmlDoc.getElementsByTagNameNS(SS_NS, 'text');
    for (let i = 0; i < texts.length; i++) {
      const leaves = collectTextLeaves(texts[i]);
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

/**
 * Read a .xlsx file and extract its text content with position mapping.
 */
export async function readXlsx(file: File): Promise<XlsxExtraction> {
  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);

  if (!zip.file('xl/workbook.xml')) {
    throw new Error('Invalid .xlsx file: missing xl/workbook.xml');
  }

  // Deterministic part order so load-time and export-time extractions produce
  // identical offsets: sharedStrings, then worksheets, then comment parts.
  const worksheetPaths: string[] = [];
  const commentPaths: string[] = [];
  zip.forEach((relativePath) => {
    if (/^xl\/worksheets\/[^/]+\.xml$/.test(relativePath)) {
      worksheetPaths.push(relativePath);
    } else if (
      /^xl\/comments\d*\.xml$/.test(relativePath) ||
      /^xl\/threadedComments\/[^/]+\.xml$/.test(relativePath)
    ) {
      commentPaths.push(relativePath);
    }
  });
  worksheetPaths.sort();
  commentPaths.sort();

  const partPlans: Array<{ path: string; unitsOf: (doc: Document) => StringUnit[] }> = [
    { path: 'xl/sharedStrings.xml', unitsOf: sharedStringUnits },
    ...worksheetPaths.map((path) => ({ path, unitsOf: worksheetUnits })),
    ...commentPaths.map((path) => ({ path, unitsOf: commentUnits })),
  ];

  let flatText = '';
  const contentParts: XlsxContentPart[] = [];

  for (const plan of partPlans) {
    const xmlDoc = await readXmlPart(zip, plan.path);
    if (!xmlDoc) continue;

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

  return {
    plainText: flatText,
    zip,
    contentParts,
    textNodes: contentParts.flatMap((part) => part.textNodes),
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

/**
 * Apply text replacements to the xlsx XML, preserving formatting, then scrub
 * metadata. Returns a new .xlsx file as a Blob; the input file is untouched.
 */
export async function writeAnonymizedXlsx(
  extraction: XlsxExtraction,
  replacements: Array<{ start: number; end: number; replacement: string }>,
  valueReplacements: ValueReplacement[] = []
): Promise<Blob> {
  applyTextReplacements(extraction.textNodes, replacements);

  for (const part of extraction.contentParts) {
    sanitizeXlsxPart(part.xmlDoc, valueReplacements);
    writeXmlPart(extraction.zip, part.path, part.xmlDoc);
  }

  await sanitizeXlsxMetadata(extraction.zip, valueReplacements);

  return extraction.zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

/**
 * Check if a file is a supported Excel workbook (.xlsx only; the legacy
 * binary .xls format is not supported in phase 1).
 */
export function isExcelFile(filename: string): boolean {
  return getFileExtension(filename) === 'xlsx';
}
