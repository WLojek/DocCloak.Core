/**
 * @doccloak/core/dom - docx read/write (moved verbatim from the web app, T011).
 *
 * Requires DOM XML APIs (DOMParser, XMLSerializer), which is why this module
 * lives under the dom/ submodule: hosts must run it in a DOM-capable context
 * (window, jsdom, or an MV3 offscreen document). The pure normalizeReplacements
 * helper lives in the DOM-free main entry (src/docx.ts) and is re-exported here.
 */

import JSZip from 'jszip';
import { normalizeReplacements } from '../docx.ts';
import type { ValueReplacement } from '../docx.ts';
import {
  OOXML_NS,
  isElementIn,
  elementsByLocalName,
  foreignNamespaces,
  replaceSensitiveValues,
  scrubMailtoTarget,
  scrubPackageValues,
  scrubDocPropsParts,
  normalizeZipEntries,
  NORMALISED_DATE,
} from './opc.ts';
import { UnsupportedDocumentError } from './errors.ts';
import type { UnredactablePart } from './errors.ts';
import { drawingUnits, leafTextUnits, flattenUnits, stripChartExternalData } from './drawingml.ts';
import {
  DOCX_WORD_TEXT_PARTS,
  DOCX_DRAWING_TEXT_PARTS,
  DOCX_CUSTOM_XML_TEXT_PARTS,
  MAX_UNPACKED_BYTES,
  assertUnpackedSize,
  collectUnredactableParts,
  relationshipsOf,
} from './package-policy.ts';

export { normalizeReplacements };
export type { ValueReplacement };

/**
 * Represents one unit of document text with its position in the flat text.
 * Also reused by the xlsx module (T110): the same flat-text replacement
 * machinery applies to any XML part whose text lives in leaf elements.
 *
 * Two variants (T174):
 * - element text: the unit is `element.textContent` (a w:t, w:instrText,
 *   m:t, ...); `attr` is unset.
 * - attribute text: the unit is a slice of `attr.value` on `element`,
 *   starting at `attrOffset` (0 unless the attribute holds several units, as
 *   a field instruction with several arguments does). Values that live only
 *   in attributes (field arguments, alt text, bookmark names, content control
 *   aliases, numbering level text) reach the detector this way instead of
 *   depending on a known-value scrub.
 */
export interface TextNodeMapping {
  /** The element that carries the text (or the attribute) */
  element: Element;
  /** Start index in the flat text */
  flatStart: number;
  /** End index in the flat text */
  flatEnd: number;
  /** When set, the unit is a slice of this attribute's value, not element text */
  attr?: Attr;
  /** Offset of the unit inside attr.value (attribute variant only) */
  attrOffset?: number;
}

/**
 * Position of an unmapped newline in the flat text: a paragraph boundary, a
 * text-box boundary, a w:br / w:cr line break or the separator between two
 * content parts. No TextNodeMapping covers these indices, and a replacement
 * never spans one (T172): an entity that contains a newline is split at it.
 */
export interface ParagraphBreak {
  flatIndex: number;
}

/**
 * Result of extracting text from a docx file.
 */
export interface DocxExtraction {
  /** The flat plain text extracted from the document */
  plainText: string;
  /** The parsed XML document */
  xmlDoc: Document;
  /** Mapping from flat text positions to XML <w:t> elements */
  textNodes: TextNodeMapping[];
  /** Positions of paragraph breaks in the flat text */
  paragraphBreaks: ParagraphBreak[];
  /** The JSZip instance for re-packaging */
  zip: JSZip;
  /** The path of the main document XML within the zip */
  documentXmlPath: string;
  /** All content XML paths (document, headers, footers) and their extractions */
  contentParts: ContentPartExtraction[];
  /**
   * True when no text-bearing content was found (no paragraphs, or only
   * empty ones). Hosts show "nothing to redact" instead of exporting (T172).
   */
  empty: boolean;
  /**
   * Parts the writer cannot redact (embedded objects, macros, HTML chunks,
   * printer settings, unknown parts), from the package policy (T177). The
   * writer refuses to export them unless allowUnredactable is passed.
   */
  unredactable: UnredactablePart[];
  /** Read-time notes: secondary parts skipped because they did not parse. */
  warnings: string[];
}

interface ContentPartExtraction {
  path: string;
  xmlDoc: Document;
  textNodes: TextNodeMapping[];
  paragraphBreaks: ParagraphBreak[];
  flatTextStart: number; // offset in the combined plain text
  flatTextEnd: number;
}

/** True for a WordprocessingML element (transitional or strict namespace). */
export function isWordEl(el: Element, localName: string): boolean {
  return isElementIn(el, OOXML_NS.w, localName);
}

/** True for an Office Math (OMML) element (transitional or strict namespace). */
export function isMathEl(el: Element, localName: string): boolean {
  return isElementIn(el, OOXML_NS.m, localName);
}

/**
 * Element local names (in the w: namespace) that carry document text.
 * - t: regular run text
 * - delText: text inside tracked deletions (w:del); still physically present in the file
 * - instrText: field instructions (e.g. HYPERLINK targets, MERGEFIELD sources)
 * - delInstrText: field instructions inside tracked deletions (M2: leaked
 *   whenever tracked changes were not accepted, the web app's default)
 * OMML m:t (formula text) is handled alongside these by isTextElement.
 */
const TEXT_ELEMENT_NAMES = new Set(['t', 'delText', 'instrText', 'delInstrText']);

/** True for every element whose text content is document text. */
function isTextElement(el: Element): boolean {
  if (el.namespaceURI === null) return false;
  if (OOXML_NS.w.has(el.namespaceURI)) return TEXT_ELEMENT_NAMES.has(el.localName);
  if (OOXML_NS.m.has(el.namespaceURI)) return el.localName === 't';
  return false;
}

/**
 * Empty w: elements that separate text (M3). Each becomes one character in
 * the flat text with no TextNodeMapping (zero-width), so a phone number
 * written as "555<noBreakHyphen/>0199" is seen as "555-0199" and a tab or
 * line break never glues two runs into one token.
 */
const SEPARATOR_CHARS: Record<string, string> = {
  tab: '\t',
  br: '\n',
  cr: '\n',
  noBreakHyphen: '-',
  softHyphen: '\u00AD',
};

/** The w: attribute with the given local name on an element, if present. */
function wordAttr(el: Element, localName: string): Attr | null {
  const attrs = el.attributes;
  for (let i = 0; i < attrs.length; i++) {
    const attr = attrs[i];
    if (attr.localName === localName && attr.namespaceURI !== null && OOXML_NS.w.has(attr.namespaceURI)) {
      return attr;
    }
  }
  return null;
}

/**
 * The redactable arguments of a field instruction (w:fldSimple@w:instr or
 * the joined w:instrText of a complex field): the content of every quoted
 * string and every bare token that is neither the field keyword (the first
 * token) nor a switch (a token starting with a backslash). Offsets refer to
 * the instruction string. ` HYPERLINK "mailto:a@b" \o "Mail" ` yields
 * "mailto:a@b" and "Mail"; ` REF Bookmark1 \h ` yields "Bookmark1". The
 * keyword is never an argument, so a replacement can never turn a HYPERLINK
 * into something Word cannot evaluate (T174).
 */
export function fieldInstructionArguments(instr: string): Array<{ offset: number; text: string }> {
  const args: Array<{ offset: number; text: string }> = [];
  const n = instr.length;
  let i = 0;
  let keywordSeen = false;
  const isSpace = (ch: string) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
  while (i < n) {
    const ch = instr[i];
    if (isSpace(ch)) {
      i++;
      continue;
    }
    if (ch === '"') {
      const start = i + 1;
      let j = start;
      while (j < n && instr[j] !== '"') {
        // A backslash escapes the next character inside a quoted argument.
        if (instr[j] === '\\' && j + 1 < n) j++;
        j++;
      }
      keywordSeen = true;
      if (j > start) args.push({ offset: start, text: instr.slice(start, j) });
      i = j + 1;
      continue;
    }
    const start = i;
    while (i < n && !isSpace(instr[i]) && instr[i] !== '"') i++;
    const token = instr.slice(start, i);
    if (!keywordSeen) {
      keywordSeen = true;
      continue;
    }
    if (token.startsWith('\\')) continue;
    args.push({ offset: start, text: token });
  }
  return args;
}

/** One attribute-borne text unit found in a content part (T174). */
interface AttributeUnit {
  element: Element;
  attr: Attr;
  attrOffset: number;
  text: string;
}

/**
 * Attribute values that carry user text, in document order (T174, M1):
 * - w:fldSimple@w:instr: quoted and bare arguments (never the keyword)
 * - w:alias@w:val: content control title
 * - wp:docPr@descr and @title: drawing alt text
 * - w:lvlText@w:val: numbering level text (word/numbering.xml); values
 *   without a letter ('%1.', '-') are pure format and are skipped (T175)
 * - w:bookmarkStart@w:name: bookmark names (renamed on write, references
 *   updated; see renameBookmarks); Word-internal names start with an
 *   underscore (_Toc, _GoBack, _Ref, _Hlk) and are skipped (T175) so the
 *   editor never shows them. Layer zero and renameBookmarks still cover a
 *   known value inside one.
 * - w:frameset / w:frame: w:name@w:val and w:title@w:val of a frames page
 *   (word/webSettings.xml, T175)
 */
function attributeUnits(xmlDoc: Document): AttributeUnit[] {
  const units: AttributeUnit[] = [];
  const push = (element: Element, attr: Attr | null, attrOffset = 0, text?: string) => {
    if (!attr) return;
    const value = text ?? attr.value;
    if (value.length === 0) return;
    units.push({ element, attr, attrOffset, text: value });
  };
  const all = xmlDoc.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (isWordEl(el, 'fldSimple')) {
      const attr = wordAttr(el, 'instr');
      if (!attr) continue;
      for (const arg of fieldInstructionArguments(attr.value)) push(el, attr, arg.offset, arg.text);
    } else if (isWordEl(el, 'alias')) {
      push(el, wordAttr(el, 'val'));
    } else if (isWordEl(el, 'lvlText')) {
      const attr = wordAttr(el, 'val');
      if (attr && /\p{L}/u.test(attr.value)) push(el, attr);
    } else if (isWordEl(el, 'bookmarkStart')) {
      const attr = wordAttr(el, 'name');
      if (attr && !attr.value.startsWith('_')) push(el, attr);
    } else if ((isWordEl(el, 'name') || isWordEl(el, 'title')) && isFramesetChild(el)) {
      push(el, wordAttr(el, 'val'));
    } else if (isElementIn(el, OOXML_NS.wp, 'docPr')) {
      push(el, el.getAttributeNode('descr'));
      push(el, el.getAttributeNode('title'));
    }
  }
  return units;
}

/** True when the element sits directly under a w:frame or w:frameset. */
function isFramesetChild(el: Element): boolean {
  const parent = el.parentElement;
  return parent !== null && (isWordEl(parent, 'frame') || isWordEl(parent, 'frameset'));
}

/**
 * Extract all text-bearing elements from an XML document, building a flat text
 * and position mapping. Walks the tree in document order (T172), so:
 * - text elements, separators and nested paragraphs interleave correctly;
 * - every text element is mapped exactly once even when paragraphs nest
 *   (text boxes hold w:p inside an outer w:p run);
 * - w:txbxContent is bracketed by newlines, so box text is never glued to
 *   the paragraph that hosts the drawing (M3);
 * - mc:AlternateContent is extracted in full: both mc:Choice and mc:Fallback
 *   hold a copy of a text box, and both copies must be redacted.
 * Every unmapped newline is recorded in paragraphBreaks.
 */
function extractTextFromXml(xmlDoc: Document): {
  plainText: string;
  textNodes: TextNodeMapping[];
  paragraphBreaks: ParagraphBreak[];
  paragraphCount: number;
} {
  const textNodes: TextNodeMapping[] = [];
  const paragraphBreaks: ParagraphBreak[] = [];
  let flatText = '';
  let paragraphCount = 0;
  // A break is emitted lazily, right before the next piece of content, so
  // trailing empty paragraphs add nothing and boundaries never double up.
  let pendingBreak = false;

  const emitBreak = () => {
    paragraphBreaks.push({ flatIndex: flatText.length });
    flatText += '\n';
    pendingBreak = false;
  };
  const flush = () => {
    if (pendingBreak) emitBreak();
  };

  const walk = (parent: Element) => {
    for (let child = parent.firstElementChild; child; child = child.nextElementSibling) {
      if (isWordEl(child, 'p')) {
        paragraphCount++;
        flush();
        walk(child);
        pendingBreak = true;
      } else if (isTextElement(child)) {
        const text = child.textContent ?? '';
        if (text.length === 0) continue;
        flush();
        textNodes.push({
          element: child,
          flatStart: flatText.length,
          flatEnd: flatText.length + text.length,
        });
        flatText += text;
      } else if (child.namespaceURI !== null && OOXML_NS.w.has(child.namespaceURI)
          && Object.prototype.hasOwnProperty.call(SEPARATOR_CHARS, child.localName)) {
        flush();
        const sep = SEPARATOR_CHARS[child.localName];
        if (sep === '\n') {
          emitBreak();
        } else {
          flatText += sep;
        }
      } else if (isWordEl(child, 'txbxContent')) {
        // Newline on entry and on exit: box text is its own block.
        pendingBreak = true;
        flush();
        walk(child);
        pendingBreak = true;
      } else {
        walk(child);
      }
    }
  };

  const body = elementsByLocalName(xmlDoc, OOXML_NS.w, 'body')[0];
  // Headers/footers/footnotes/comments have no body: walk the root element.
  walk(body ?? xmlDoc.documentElement);

  // Attribute units (T174) follow the element text, one per line. Each
  // separating newline is a paragraph break, so a replacement never spans
  // two units or a unit and the body text.
  for (const unit of attributeUnits(xmlDoc)) {
    flush();
    textNodes.push({
      element: unit.element,
      attr: unit.attr,
      attrOffset: unit.attrOffset,
      flatStart: flatText.length,
      flatEnd: flatText.length + unit.text.length,
    });
    flatText += unit.text;
    pendingBreak = true;
  }

  return { plainText: flatText, textNodes, paragraphBreaks, paragraphCount };
}

/** Options for readDocx (T177). */
export interface DocxReadOptions {
  /**
   * Limit on the sum of the declared uncompressed sizes of all zip entries
   * (zip-bomb guard, L4). Above it the reader throws
   * UnsupportedDocumentError('too-large') before parsing any part.
   * Defaults to MAX_UNPACKED_BYTES (200 MB).
   */
  maxUnpackedBytes?: number;
}

/** The shape every part extractor returns (paragraph walk or unit list). */
interface PartExtraction {
  plainText: string;
  textNodes: TextNodeMapping[];
  paragraphBreaks: ParagraphBreak[];
}

/**
 * Which extractor reads a secondary part (T175):
 * - WordprocessingML parts (headers, footers, notes, comments, numbering,
 *   webSettings, the glossary subdocument): the paragraph walk plus
 *   attribute units;
 * - DrawingML parts (charts, chartEx, SmartArt data and drawing, chart user
 *   shapes): drawingUnits;
 * - custom XML data stores: leafTextUnits.
 * Returns null for a part that is not a content part.
 */
function extractorFor(path: string): ((doc: Document) => PartExtraction) | null {
  if (DOCX_WORD_TEXT_PARTS.test(path)) return extractTextFromXml;
  if (DOCX_DRAWING_TEXT_PARTS.test(path)) return (doc) => flattenUnits(drawingUnits(doc));
  if (DOCX_CUSTOM_XML_TEXT_PARTS.test(path)) return (doc) => flattenUnits(leafTextUnits(doc));
  return null;
}

/**
 * Zip paths of every part referenced by a w:altChunk in the given parts.
 * Word imports the chunk's content (HTML, MHT, RTF, another docx) into the
 * document on open, so the chunk is document text the engine cannot redact:
 * the package policy reports each one as 'html-chunk'.
 */
async function altChunkTargets(zip: JSZip, parts: Array<{ path: string; xmlDoc: Document }>): Promise<Set<string>> {
  const targets = new Set<string>();
  for (const part of parts) {
    const chunks = elementsByLocalName(part.xmlDoc, OOXML_NS.w, 'altChunk');
    if (chunks.length === 0) continue;
    const rels = await relationshipsOf(zip, part.path);
    for (const chunk of chunks) {
      const attrs = chunk.attributes;
      for (let i = 0; i < attrs.length; i++) {
        const attr = attrs[i];
        if (attr.localName !== 'id' || attr.namespaceURI === null || !OOXML_NS.r.has(attr.namespaceURI)) continue;
        const rel = rels.get(attr.value);
        if (rel?.path && zip.file(rel.path)) targets.add(rel.path);
      }
    }
  }
  return targets;
}

/**
 * Read a .docx file and extract its text content with position mapping.
 */
export async function readDocx(file: File, options: DocxReadOptions = {}): Promise<DocxExtraction> {
  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);
  assertUnpackedSize(zip, options.maxUnpackedBytes ?? MAX_UNPACKED_BYTES);

  // Find the main document XML path
  const documentXmlPath = 'word/document.xml';
  const docXmlFile = zip.file(documentXmlPath);
  if (!docXmlFile) {
    throw new Error('Invalid .docx file: missing word/document.xml');
  }

  const docXmlStr = await docXmlFile.async('string');
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(docXmlStr, 'application/xml');

  const parseError = xmlDoc.querySelector('parsererror');
  if (parseError) {
    throw new UnsupportedDocumentError('invalid-package', 'Failed to parse document XML', [documentXmlPath]);
  }

  // Fail closed (H1): a main part we cannot interpret is refused, never
  // copied through as a "redacted" file. The body must be WordprocessingML
  // (transitional or strict); if it is, but not one paragraph is, and foreign
  // elements are present, the text lives in a dialect we do not read.
  const rootNs = xmlDoc.documentElement?.namespaceURI ?? '(no namespace)';
  const body = elementsByLocalName(xmlDoc, OOXML_NS.w, 'body')[0];
  if (!body) {
    throw new UnsupportedDocumentError(
      'unrecognized-namespace',
      `Unsupported .docx: no WordprocessingML body in ${documentXmlPath} (root namespace ${rootNs})`,
      [rootNs],
    );
  }

  const { plainText, textNodes, paragraphBreaks, paragraphCount } = extractTextFromXml(xmlDoc);
  if (paragraphCount === 0) {
    const foreign = foreignNamespaces(xmlDoc);
    if (foreign.length > 0) {
      throw new UnsupportedDocumentError(
        'unrecognized-namespace',
        `Unsupported .docx: no WordprocessingML paragraphs in ${documentXmlPath}, found elements in ${foreign.join(', ')}`,
        foreign,
      );
    }
  }

  // Also process headers and footers
  const contentParts: ContentPartExtraction[] = [];
  const warnings: string[] = [];
  let combinedText = plainText;

  // Add main document as first content part
  contentParts.push({
    path: documentXmlPath,
    xmlDoc,
    textNodes,
    paragraphBreaks,
    flatTextStart: 0,
    flatTextEnd: plainText.length,
  });

  // Find all other text-bearing parts: headers, footers, footnotes, endnotes,
  // comments, the glossary (building blocks) subdocument, numbering (level
  // text lives in w:lvlText@w:val, T174), webSettings (frameset names,
  // T175), charts, SmartArt, chart user shapes and custom XML data stores
  // (T175). PII in any of these survives in the exported file if it is not
  // extracted and redacted.
  const secondaryPaths: string[] = [];
  zip.forEach((relativePath, entry) => {
    if (entry.dir || relativePath === documentXmlPath) return;
    if (extractorFor(relativePath)) secondaryPaths.push(relativePath);
  });
  // Deterministic order so load-time and export-time extractions produce identical offsets
  secondaryPaths.sort();

  for (const hfPath of secondaryPaths) {
    const hfFile = zip.file(hfPath);
    if (!hfFile) continue;
    const hfXmlStr = await hfFile.async('string');
    const hfXmlDoc = parser.parseFromString(hfXmlStr, 'application/xml');
    if (hfXmlDoc.querySelector('parsererror')) {
      warnings.push(`${hfPath}: not well-formed XML, skipped by the text extractor`);
      continue;
    }

    const extract = extractorFor(hfPath)!;
    const hfExtraction = extract(hfXmlDoc);
    if (hfExtraction.plainText.length === 0) continue;

    // The separator newline between parts is a break like any other: a
    // replacement must never span two parts.
    const separatorBreak: ParagraphBreak = { flatIndex: combinedText.length };
    const offset = combinedText.length + 1; // +1 for separator newline
    combinedText += '\n' + hfExtraction.plainText;

    // Adjust text node mappings to the combined text offset
    const adjustedNodes = hfExtraction.textNodes.map((node) => ({
      ...node,
      flatStart: node.flatStart + offset,
      flatEnd: node.flatEnd + offset,
    }));

    contentParts.push({
      path: hfPath,
      xmlDoc: hfXmlDoc,
      textNodes: adjustedNodes,
      paragraphBreaks: [
        separatorBreak,
        ...hfExtraction.paragraphBreaks.map((pb) => ({ flatIndex: pb.flatIndex + offset })),
      ],
      flatTextStart: offset,
      flatTextEnd: offset + hfExtraction.plainText.length,
    });
  }

  // Package policy (T177): every part the writer would copy verbatim is
  // reported with a kind and a label; the writer refuses to export them
  // until the host passes allowUnredactable (informed consent).
  const unredactable = await collectUnredactableParts(zip, 'docx', {
    htmlChunkParts: await altChunkTargets(zip, contentParts),
  });

  return {
    plainText: combinedText,
    xmlDoc,
    textNodes: contentParts.flatMap((cp) => cp.textNodes),
    paragraphBreaks: contentParts.flatMap((cp) => cp.paragraphBreaks),
    zip,
    documentXmlPath,
    contentParts,
    empty: combinedText.trim().length === 0,
    unredactable,
    warnings,
  };
}

/**
 * Options for writeAnonymizedDocx (T110). All default to off, preserving the
 * historical output byte-for-byte for existing callers.
 */
export interface DocxWriteOptions {
  /**
   * Accept and remove tracked changes: deletions (w:del and friends) are
   * dropped, insertions (w:ins, w:moveTo) are unwrapped into plain runs, and
   * property-change records (w:rPrChange etc., which carry author and date
   * fingerprints) are removed. Oregon SB 2025-205 flags revision metadata as
   * identifying, so the file-redaction flow turns this on.
   */
  acceptTrackedChanges?: boolean;
  /**
   * Export even though extraction.unredactable is non-empty (T177). The
   * listed parts (embedded workbooks, OLE objects, macros, HTML chunks,
   * printer settings, unknown parts) are copied verbatim and named in
   * result.warnings. Default false: the writer throws
   * UnsupportedDocumentError('unredactable-parts') with the part names in
   * `details` before touching the extraction, so a host can ask the user
   * and call again with the same extraction. Hosts that never ask keep
   * fail-closed behaviour.
   */
  allowUnredactable?: boolean;
}

/**
 * Refuse to export while unredactable parts are present and the host did
 * not opt in. Shared by the docx and xlsx writers; runs before any mutation.
 */
export function assertUnredactableAllowed(
  unredactable: ReadonlyArray<UnredactablePart>,
  allowUnredactable: boolean | undefined
): void {
  if (unredactable.length === 0 || allowUnredactable === true) return;
  const list = unredactable.map((p) => `${p.part} (${p.label})`).join(', ');
  throw new UnsupportedDocumentError(
    'unredactable-parts',
    `The package holds ${unredactable.length} part(s) DocCloak cannot redact: ${list}. Pass allowUnredactable to copy them verbatim.`,
    unredactable.map((p) => p.part),
  );
}

/** Warning line per unredactable part copied verbatim (allowUnredactable). */
export function unredactableWarnings(unredactable: ReadonlyArray<UnredactablePart>): string[] {
  return unredactable.map((p) => `${p.part}: ${p.label}, copied verbatim (not redacted)`);
}

/**
 * Apply a list of flat-text replacements to mapped text nodes, handling
 * replacements that span multiple elements. Ranges are normalized (sorted,
 * overlaps clamped) and applied end-to-start so earlier positions stay valid.
 * Shared by the docx and xlsx writers (T110).
 *
 * `breaks` (T172) lists the flat indices of unmapped newlines (paragraph and
 * text-box boundaries, line breaks, part separators). A replacement never
 * crosses one: a range that contains a break is split at it, the first piece
 * receives the replacement and the following pieces are emptied, so text is
 * never moved from one paragraph (or text box) into another. Restoring the
 * placeholder then yields the original value once, not once per piece.
 */
export function applyTextReplacements(
  textNodes: TextNodeMapping[],
  replacements: Array<{ start: number; end: number; replacement: string }>,
  breaks: ReadonlyArray<number> = []
): void {
  const sorted = normalizeReplacements(replacements);
  const pieces = breaks.length === 0
    ? sorted
    : sorted.flatMap((repl) => splitAtBreaks(repl, breaks));
  for (const repl of [...pieces].reverse()) {
    applyReplacement(textNodes, repl.start, repl.end, repl.replacement);
  }
}

/** Split one replacement range at every break strictly inside it. */
function splitAtBreaks(
  repl: { start: number; end: number; replacement: string },
  breaks: ReadonlyArray<number>
): Array<{ start: number; end: number; replacement: string }> {
  const inside = breaks.filter((b) => b >= repl.start && b < repl.end).sort((a, b) => a - b);
  if (inside.length === 0) return [repl];
  const pieces: Array<{ start: number; end: number; replacement: string }> = [];
  let cursor = repl.start;
  let first = true;
  const push = (start: number, end: number) => {
    if (start >= end) return;
    pieces.push({ start, end, replacement: first ? repl.replacement : '' });
    first = false;
  };
  for (const b of inside) {
    push(cursor, b);
    cursor = b + 1;
  }
  push(cursor, repl.end);
  return pieces;
}

/**
 * Tracked-change elements that are removed outright when accepting changes:
 * deleted content, move sources, and every *PrChange record (each carries a
 * w:author/w:date pair identifying the reviser).
 */
const TRACKED_REMOVE = new Set([
  'del', 'moveFrom', 'delText', 'delInstrText',
  'rPrChange', 'pPrChange', 'sectPrChange', 'tblPrChange', 'tblGridChange',
  'tcPrChange', 'trPrChange', 'numberingChange',
  'cellDel', 'cellIns', 'cellMerge',
  'moveFromRangeStart', 'moveFromRangeEnd', 'moveToRangeStart', 'moveToRangeEnd',
  'customXmlDelRangeStart', 'customXmlDelRangeEnd',
  'customXmlInsRangeStart', 'customXmlInsRangeEnd',
  'customXmlMoveFromRangeStart', 'customXmlMoveFromRangeEnd',
  'customXmlMoveToRangeStart', 'customXmlMoveToRangeEnd',
]);

/** Tracked-change wrappers whose content is kept: the wrapper is unwrapped. */
const TRACKED_UNWRAP = new Set(['ins', 'moveTo']);

/**
 * Accept all tracked changes in one content part: remove deletions and
 * change records, unwrap insertions. Operates on the live DOM after text
 * replacements have been applied, so redaction offsets are unaffected.
 */
function acceptTrackedChangesInPart(xmlDoc: Document): void {
  // Snapshot first: live HTMLCollections reorder while elements are removed.
  const all = xmlDoc.getElementsByTagName('*');
  const snapshot: Element[] = [];
  for (let i = 0; i < all.length; i++) snapshot.push(all[i]);

  for (const el of snapshot) {
    if (el.namespaceURI === null || !OOXML_NS.w.has(el.namespaceURI)) continue;
    if (TRACKED_REMOVE.has(el.localName)) {
      el.parentNode?.removeChild(el);
    } else if (TRACKED_UNWRAP.has(el.localName)) {
      const parent = el.parentNode;
      if (!parent) continue;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
    }
  }
}

/** Result of writeAnonymizedDocxWithReport (T172). */
export interface DocxWriteResult {
  /** The redacted .docx */
  blob: Blob;
  /**
   * Human-readable notes about parts the layer-zero scrub could not parse and
   * therefore left untouched. Empty on a clean run.
   */
  warnings: string[];
}

/**
 * Apply text replacements to the docx XML, preserving all formatting.
 * Takes the original extraction and a list of replacements (sorted by position),
 * and modifies the XML in-place. Also scrubs document metadata and relationship
 * targets that can leak identities (authors, revision names, hyperlink emails).
 *
 * Returns a new .docx file as a Blob. writeAnonymizedDocxWithReport returns
 * the same Blob together with the layer-zero warnings.
 */
export async function writeAnonymizedDocx(
  extraction: DocxExtraction,
  replacements: Array<{ start: number; end: number; replacement: string }>,
  valueReplacements: ValueReplacement[] = [],
  options: DocxWriteOptions = {}
): Promise<Blob> {
  const result = await writeAnonymizedDocxWithReport(extraction, replacements, valueReplacements, options);
  return result.blob;
}

/**
 * Same as writeAnonymizedDocx, with the write report. Pipeline (T172, T174):
 * 1. offset replacements in the mapped text and attribute units (never
 *    across a break);
 * 2. bookmark rename: a bookmark whose name changed gets a valid identifier,
 *    and every reference to it (w:hyperlink@w:anchor, REF / PAGEREF /
 *    NOTEREF / HYPERLINK \l instructions) is updated across all parts;
 * 3. per content part: attribute scrub (authors, field arguments, alt
 *    text), reference update, always-scrub group (tooltips, content control
 *    tags without a data binding), optional tracked-change acceptance,
 *    serialize;
 * 4. metadata scrub (docProps, people, settings incl. docVars, rels incl.
 *    the mailto rule, thumbnail);
 * 5. layer zero: every known value scrubbed from every other XML/rels/vml
 *    part in the package (charts, diagrams, customXml, docVars, glossary,
 *    docProps), so a value the extractors never saw cannot leave in a part
 *    they do not read;
 * 6. container normalisation (T179): every zip entry dated 1980-01-01 with
 *    an empty comment, empty archive comment; then zip generation.
 */
export async function writeAnonymizedDocxWithReport(
  extraction: DocxExtraction,
  replacements: Array<{ start: number; end: number; replacement: string }>,
  valueReplacements: ValueReplacement[] = [],
  options: DocxWriteOptions = {}
): Promise<DocxWriteResult> {
  assertUnredactableAllowed(extraction.unredactable, options.allowUnredactable);

  const bookmarkOriginals = snapshotBookmarkNames(extraction.contentParts);

  // Apply flat-text replacements to the mapped text nodes (spanning runs when
  // needed), from end to start so positions stay valid.
  applyTextReplacements(
    extraction.textNodes,
    replacements,
    extraction.paragraphBreaks.map((pb) => pb.flatIndex),
  );

  const renames = renameBookmarks(extraction.contentParts, bookmarkOriginals, valueReplacements);

  // Serialize all modified XML documents back to the zip
  const serializer = new XMLSerializer();
  const contentPaths = new Set<string>();
  for (const part of extraction.contentParts) {
    sanitizeContentPartAttributes(part.xmlDoc, valueReplacements);
    if (renames.length > 0) updateBookmarkReferences(part.xmlDoc, renames);
    scrubAlwaysContentPart(part.xmlDoc);
    if (options.acceptTrackedChanges) {
      acceptTrackedChangesInPart(part.xmlDoc);
    }
    // Charts built from an embedded workbook: drop the link so Word never
    // opens the (unredacted) workbook to refresh the chart (T175).
    if (CHART_PART.test(part.path)) stripChartExternalData(part.xmlDoc);
    const xmlStr = serializer.serializeToString(part.xmlDoc);
    extraction.zip.file(part.path, xmlStr);
    // Parts the extractor reads only partially (numbering and webSettings:
    // one attribute family; charts, SmartArt, custom XML: the text units)
    // keep their layer-zero pass for everything else in them.
    if (!PARTIAL_EXTRACTION_PART.test(part.path)) contentPaths.add(part.path);
  }

  await sanitizeDocxMetadata(extraction.zip, valueReplacements);

  const scrub = await scrubPackageValues(extraction.zip, valueReplacements, { skip: contentPaths });

  normalizeZipEntries(extraction.zip);
  const blob = await extraction.zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    comment: '',
  });
  return { blob, warnings: [...scrub.warnings, ...unredactableWarnings(extraction.unredactable)] };
}

/**
 * Content parts whose extracted units do not cover every text-bearing
 * location, so the layer-zero value scrub still visits them: numbering and
 * webSettings (attribute units only), charts (numeric caches, formulas),
 * SmartArt, chart user shapes and custom XML (attribute values).
 */
const PARTIAL_EXTRACTION_PART = /(?:^|\/)(?:numbering|webSettings)\.xml$|^word\/(?:glossary\/)?(?:charts|diagrams|drawings)\/|^customXml\//;

/** Chart parts (c:chartSpace), where c:externalData is stripped on write. */
const CHART_PART = /^word\/(?:glossary\/)?charts\/chart\d*\.xml$/;

/** True for a w:rsid, w:rsidR, w:rsidRPr, w:rsidP, w:rsidDel, w:rsidTr, w:rsidSect or w:rsidRDefault attribute. */
function isRsidAttribute(attr: Attr): boolean {
  return attr.localName.startsWith('rsid') && attr.namespaceURI !== null && OOXML_NS.w.has(attr.namespaceURI);
}

/**
 * Scrub identity-bearing attributes inside a content part:
 * - w:author / w:initials on tracked changes (w:ins, w:del) and comments
 * - w:date on comments, insertions, deletions, moves and every *Change
 *   record set to NORMALISED_DATE (T179, M6): the timestamps date the
 *   original's editing history even when the author is gone
 * - every w:rsid* attribute removed (T179): revision-save ids link the
 *   paragraphs and runs to the editing sessions listed in settings.xml,
 *   which the metadata pass drops; the document needs neither
 * - alt text and object names on drawings (docPr, cNvPr); docPr alt text
 *   also went through detection (T174), this removal is the second layer
 * - field instructions held in attributes (w:fldSimple @w:instr): known
 *   values are removed from the arguments only, never from the keyword
 */
function sanitizeContentPartAttributes(xmlDoc: Document, valueReplacements: ValueReplacement[]): void {
  const all = xmlDoc.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const attrs = el.attributes;
    // Back to front: removing an attribute shifts the live NamedNodeMap.
    for (let a = attrs.length - 1; a >= 0; a--) {
      const attr = attrs[a];
      if (attr.localName === 'author') {
        attr.value = 'Redacted';
      } else if (attr.localName === 'initials') {
        attr.value = 'R';
      } else if (attr.localName === 'instr') {
        attr.value = scrubInstructionArguments(attr.value, valueReplacements);
      } else if (attr.localName === 'date' && attr.namespaceURI !== null && OOXML_NS.w.has(attr.namespaceURI)) {
        attr.value = NORMALISED_DATE;
      } else if (isRsidAttribute(attr)) {
        el.removeAttributeNode(attr);
      }
    }
    if (el.localName === 'docPr' || el.localName === 'cNvPr') {
      if (el.hasAttribute('descr')) el.removeAttribute('descr');
      if (el.hasAttribute('title')) el.removeAttribute('title');
      if (el.hasAttribute('name')) el.setAttribute('name', 'Object');
    }
  }
}

/** Known-value scrub restricted to the arguments of a field instruction. */
function scrubInstructionArguments(instr: string, valueReplacements: ValueReplacement[]): string {
  if (valueReplacements.length === 0) return instr;
  let result = instr;
  // Back to front so earlier offsets stay valid after a length change.
  for (const arg of fieldInstructionArguments(instr).reverse()) {
    const scrubbed = replaceSensitiveValues(arg.text, valueReplacements, false);
    if (scrubbed !== arg.text) {
      result = result.slice(0, arg.offset) + scrubbed + result.slice(arg.offset + arg.text.length);
    }
  }
  return result;
}

/**
 * Always-scrub group inside a content part (T174, M1). No detection and no
 * value list: these attributes hold free text the detector cannot be
 * trusted to catch and the document does not need them to open.
 * - w:hyperlink@w:tooltip is removed
 * - w:sdtPr/w:tag is removed unless the same w:sdtPr has a w:dataBinding
 *   (the tag then addresses the bound custom XML node and must survive)
 */
function scrubAlwaysContentPart(xmlDoc: Document): void {
  for (const link of elementsByLocalName(xmlDoc, OOXML_NS.w, 'hyperlink')) {
    const tooltip = wordAttr(link, 'tooltip');
    if (tooltip) link.removeAttributeNode(tooltip);
  }
  for (const tag of elementsByLocalName(xmlDoc, OOXML_NS.w, 'tag')) {
    const parent = tag.parentElement;
    if (parent && isWordEl(parent, 'sdtPr')) {
      let bound = false;
      for (let child = parent.firstElementChild; child; child = child.nextElementSibling) {
        if (isWordEl(child, 'dataBinding')) {
          bound = true;
          break;
        }
      }
      if (bound) continue;
    }
    tag.parentNode?.removeChild(tag);
  }
}

// ---------------------------------------------------------------------------
// Bookmark rename with reference update (T174)
// ---------------------------------------------------------------------------

interface BookmarkRename {
  /** Name before any replacement */
  oldName: string;
  /** Name after the offset and value replacements, before sanitizing */
  rawValue: string;
  /** Name written to the document: a valid Word identifier */
  newName: string;
}

/** Bookmark names before replacements, keyed by the live attribute node. */
function snapshotBookmarkNames(parts: ContentPartExtraction[]): Map<Attr, string> {
  const originals = new Map<Attr, string>();
  for (const part of parts) {
    for (const el of elementsByLocalName(part.xmlDoc, OOXML_NS.w, 'bookmarkStart')) {
      const attr = wordAttr(el, 'name');
      if (attr) originals.set(attr, attr.value);
    }
  }
  return originals;
}

/**
 * Turn a replacement into a valid Word bookmark identifier: ASCII letters,
 * digits and underscores, starting with a letter, at most 40 characters,
 * unique among the names in `used` (which it extends). '[PERSON_1]' becomes
 * 'PERSON_1'; a replacement that starts with a digit or underscore gets the
 * 'bm_' prefix.
 */
export function bookmarkIdentifier(replacement: string, used: Set<string> = new Set()): string {
  let name = replacement.replace(/[^A-Za-z0-9_]/g, '');
  if (name.length === 0) name = 'bm';
  if (!/^[A-Za-z]/.test(name)) name = 'bm_' + name;
  name = name.slice(0, 40);
  let candidate = name;
  for (let n = 2; used.has(candidate); n++) {
    const suffix = `_${n}`;
    candidate = name.slice(0, 40 - suffix.length) + suffix;
  }
  used.add(candidate);
  return candidate;
}

/**
 * Rewrite every bookmark whose name changed (through an offset replacement
 * of its unit, or through a known value inside it) as a valid identifier.
 * Names that did not change are kept verbatim and reserved so a new name
 * never collides with them.
 */
function renameBookmarks(
  parts: ContentPartExtraction[],
  originals: Map<Attr, string>,
  valueReplacements: ValueReplacement[]
): BookmarkRename[] {
  // Same safety rule as the layer-zero attribute scrub: only lettered values
  // may match inside an identifier ('_Toc2024' must not lose its year).
  const lettered = valueReplacements.filter((pair) => /\p{L}/u.test(pair.value));
  const used = new Set<string>();
  const pending: Array<{ attr: Attr; oldName: string; rawValue: string }> = [];
  for (const part of parts) {
    for (const el of elementsByLocalName(part.xmlDoc, OOXML_NS.w, 'bookmarkStart')) {
      const attr = wordAttr(el, 'name');
      if (!attr) continue;
      const oldName = originals.get(attr) ?? attr.value;
      const rawValue = lettered.length > 0 ? replaceSensitiveValues(attr.value, lettered, false) : attr.value;
      if (rawValue === oldName) {
        used.add(oldName);
        continue;
      }
      pending.push({ attr, oldName, rawValue });
    }
  }
  const renames: BookmarkRename[] = [];
  for (const item of pending) {
    const newName = bookmarkIdentifier(item.rawValue, used);
    item.attr.value = newName;
    renames.push({ oldName: item.oldName, rawValue: item.rawValue, newName });
  }
  return renames;
}

/** Field keywords whose first argument is a bookmark name. */
const BOOKMARK_REFERENCE_KEYWORDS = new Set(['REF', 'PAGEREF', 'NOTEREF']);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compiled lookup for the reference update: a token equal to a renamed
 * bookmark's old name, or to the raw placeholder that the replacements put
 * in its place (the same entity in a REF argument gets the same placeholder
 * before the rename pass runs), maps to the new identifier. Exact token
 * equality only: a token is delimited by whitespace, quotes or a switch.
 */
function bookmarkTokenLookup(renames: BookmarkRename[]): { alternatives: string; map: Map<string, string> } {
  const map = new Map<string, string>();
  for (const rename of renames) {
    if (!map.has(rename.oldName)) map.set(rename.oldName, rename.newName);
    if (rename.rawValue.length > 0 && !map.has(rename.rawValue)) map.set(rename.rawValue, rename.newName);
  }
  const alternatives = [...map.keys()]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');
  return { alternatives, map };
}

/**
 * Update the bookmark argument of one field instruction. REF / PAGEREF /
 * NOTEREF: every token after the keyword; HYPERLINK: only the token that
 * follows the \l switch. The keyword itself is never touched. Other fields
 * are returned unchanged.
 */
function updateInstructionReferences(
  instr: string,
  lookup: { alternatives: string; map: Map<string, string> }
): string {
  if (lookup.alternatives.length === 0) return instr;
  const keywordMatch = /^\s*([^\s"]+)/.exec(instr);
  if (!keywordMatch) return instr;
  const keyword = keywordMatch[1].toUpperCase();
  const keywordEnd = keywordMatch[0].length;
  const swap = (token: string) => lookup.map.get(token) ?? token;
  if (BOOKMARK_REFERENCE_KEYWORDS.has(keyword)) {
    const pattern = new RegExp(`(^|[\\s"])(${lookup.alternatives})(?=[\\s"\\\\]|$)`, 'g');
    const rest = instr.slice(keywordEnd).replace(pattern, (_m, lead: string, token: string) => lead + swap(token));
    return instr.slice(0, keywordEnd) + rest;
  }
  if (keyword === 'HYPERLINK') {
    const pattern = new RegExp(`(\\\\l\\s*"?)(${lookup.alternatives})(?=[\\s"\\\\]|$)`, 'g');
    return instr.replace(pattern, (_m, lead: string, token: string) => lead + swap(token));
  }
  return instr;
}

/**
 * Point every reference at the renamed bookmarks in one content part:
 * w:hyperlink@w:anchor (exact equality), w:fldSimple@w:instr and the joined
 * w:instrText / w:delInstrText of every complex field (fldChar begin..end,
 * nested fields tracked with a stack). A changed complex instruction is
 * written into its first instrText node and the following ones are emptied,
 * the same way a spanning text replacement lands in the first run.
 */
function updateBookmarkReferences(xmlDoc: Document, renames: BookmarkRename[]): void {
  const lookup = bookmarkTokenLookup(renames);
  if (lookup.alternatives.length === 0) return;

  for (const link of elementsByLocalName(xmlDoc, OOXML_NS.w, 'hyperlink')) {
    const anchor = wordAttr(link, 'anchor');
    if (!anchor) continue;
    const target = lookup.map.get(anchor.value);
    if (target !== undefined) anchor.value = target;
  }

  for (const field of elementsByLocalName(xmlDoc, OOXML_NS.w, 'fldSimple')) {
    const instr = wordAttr(field, 'instr');
    if (!instr) continue;
    const updated = updateInstructionReferences(instr.value, lookup);
    if (updated !== instr.value) instr.value = updated;
  }

  const fields: Element[][] = [];
  const stack: Element[][] = [];
  const all = xmlDoc.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (isWordEl(el, 'fldChar')) {
      const type = wordAttr(el, 'fldCharType')?.value;
      if (type === 'begin') {
        const nodes: Element[] = [];
        stack.push(nodes);
        fields.push(nodes);
      } else if (type === 'end') {
        stack.pop();
      }
    } else if ((isWordEl(el, 'instrText') || isWordEl(el, 'delInstrText')) && stack.length > 0) {
      stack[stack.length - 1].push(el);
    }
  }
  for (const nodes of fields) {
    if (nodes.length === 0) continue;
    const joined = nodes.map((node) => node.textContent ?? '').join('');
    const updated = updateInstructionReferences(joined, lookup);
    if (updated === joined) continue;
    nodes[0].textContent = updated;
    nodes[0].setAttribute('xml:space', 'preserve');
    for (let i = 1; i < nodes.length; i++) nodes[i].textContent = '';
  }
}

/**
 * Scrub metadata parts of the package that survive text replacement untouched:
 * document properties, comment author registry, revision fingerprints,
 * mail-merge sources, external relationship targets, and the package thumbnail.
 */
async function sanitizeDocxMetadata(zip: JSZip, valueReplacements: ValueReplacement[]): Promise<void> {
  const parser = new DOMParser();
  const serializer = new XMLSerializer();

  const readXml = async (path: string): Promise<Document | null> => {
    const file = zip.file(path);
    if (!file) return null;
    const xmlStr = await file.async('string');
    const doc = parser.parseFromString(xmlStr, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length > 0) return null;
    return doc;
  };
  const writeXml = (path: string, doc: Document) => {
    zip.file(path, serializer.serializeToString(doc));
  };
  // Document properties (core, app, custom): the shared OPC scrub, extended
  // by T179 with content status, identifier, timestamps, revision, statistics
  // and the TitlesOfParts / HeadingPairs vectors.
  await scrubDocPropsParts(zip);

  // Comment author registry (word/people.xml): names and provider user ids
  const people = await readXml('word/people.xml');
  if (people) {
    const all = people.getElementsByTagName('*');
    for (let i = 0; i < all.length; i++) {
      const attrs = all[i].attributes;
      for (let a = 0; a < attrs.length; a++) {
        if (attrs[a].localName === 'author' || attrs[a].localName === 'userId') {
          attrs[a].value = 'Redacted';
        }
      }
    }
    writeXml('word/people.xml', people);
  }

  // Settings: drop mail-merge data sources, revision-save ids, attached
  // template and document variables (free-form name/value pairs written by
  // macros and add-ins; always removed, T174).
  const settings = await readXml('word/settings.xml');
  if (settings) {
    for (const name of ['mailMerge', 'rsids', 'attachedTemplate', 'docVars']) {
      for (const el of elementsByLocalName(settings, OOXML_NS.w, name)) {
        el.parentNode?.removeChild(el);
      }
    }
    writeXml('word/settings.xml', settings);
  }

  // Relationship files: replace every mailto: target (T174), scrub sensitive
  // values from the other external targets (URLs keep the raw value even
  // when display text is redacted) and detach the document template
  // relationship.
  const relsPaths: string[] = [];
  zip.forEach((relativePath) => {
    if (/^word\/(?:glossary\/)?_rels\/[^/]+\.rels$/.test(relativePath)) {
      relsPaths.push(relativePath);
    }
  });
  for (const relsPath of relsPaths.sort()) {
    const rels = await readXml(relsPath);
    if (!rels) continue;
    const relationships = rels.getElementsByTagName('Relationship');
    for (let i = relationships.length - 1; i >= 0; i--) {
      const rel = relationships[i];
      const type = rel.getAttribute('Type') ?? '';
      if (type.endsWith('/attachedTemplate')) {
        rel.parentNode?.removeChild(rel);
        continue;
      }
      if (rel.getAttribute('TargetMode') === 'External') {
        const target = rel.getAttribute('Target') ?? '';
        const scrubbed = replaceSensitiveValues(scrubMailtoTarget(target), valueReplacements, true);
        if (scrubbed !== target) rel.setAttribute('Target', scrubbed);
      }
    }
    writeXml(relsPath, rels);
  }

  // Package thumbnail: a rendered image of page one leaks content wholesale.
  // Remove the part plus its package relationship and content-type override.
  const thumbnailPaths: string[] = [];
  zip.forEach((relativePath) => {
    if (/^docProps\/thumbnail\.[a-z]+$/i.test(relativePath)) {
      thumbnailPaths.push(relativePath);
    }
  });
  if (thumbnailPaths.length > 0) {
    for (const path of thumbnailPaths) zip.remove(path);
    const rootRels = await readXml('_rels/.rels');
    if (rootRels) {
      const relationships = rootRels.getElementsByTagName('Relationship');
      for (let i = relationships.length - 1; i >= 0; i--) {
        const type = relationships[i].getAttribute('Type') ?? '';
        if (type.endsWith('/thumbnail')) {
          relationships[i].parentNode?.removeChild(relationships[i]);
        }
      }
      writeXml('_rels/.rels', rootRels);
    }
    const contentTypes = await readXml('[Content_Types].xml');
    if (contentTypes) {
      const overrides = contentTypes.getElementsByTagName('Override');
      for (let i = overrides.length - 1; i >= 0; i--) {
        const partName = overrides[i].getAttribute('PartName') ?? '';
        if (thumbnailPaths.some((p) => partName === '/' + p)) {
          overrides[i].parentNode?.removeChild(overrides[i]);
        }
      }
      writeXml('[Content_Types].xml', contentTypes);
    }
  }
}

/** Current text of a unit: element text, or the mapped slice of the attribute. */
function unitText(node: TextNodeMapping): string {
  if (node.attr) {
    const offset = node.attrOffset ?? 0;
    return node.attr.value.slice(offset, offset + (node.flatEnd - node.flatStart));
  }
  return node.element.textContent ?? '';
}

/**
 * Write a unit's text back: element text (with xml:space preserved so
 * leading/trailing spaces survive) or the mapped slice of the attribute.
 * Must run before the node's flat positions are updated, since the slice
 * length is derived from them.
 */
function setUnitText(node: TextNodeMapping, text: string): void {
  if (node.attr) {
    const offset = node.attrOffset ?? 0;
    const value = node.attr.value;
    node.attr.value = value.slice(0, offset) + text + value.slice(offset + (node.flatEnd - node.flatStart));
    return;
  }
  node.element.textContent = text;
  node.element.setAttribute('xml:space', 'preserve');
}

/**
 * Apply a single text replacement across potentially multiple units.
 */
function applyReplacement(
  textNodes: TextNodeMapping[],
  replStart: number,
  replEnd: number,
  replacement: string
): void {
  // Find all text nodes that overlap with this replacement range
  const affectedNodes: TextNodeMapping[] = [];
  for (const node of textNodes) {
    if (node.flatEnd > replStart && node.flatStart < replEnd) {
      affectedNodes.push(node);
    }
  }

  if (affectedNodes.length === 0) return;

  if (affectedNodes.length === 1) {
    // Simple case: replacement is within a single unit
    const node = affectedNodes[0];
    const currentText = unitText(node);
    // A range may begin or end inside a zero-width separator gap (T172):
    // clamp to the node's own span.
    const localStart = Math.max(0, replStart - node.flatStart);
    const localEnd = Math.min(currentText.length, replEnd - node.flatStart);
    const newText = currentText.slice(0, localStart) + replacement + currentText.slice(localEnd);
    setUnitText(node, newText);

    // Update flat positions for this node and all subsequent nodes
    const lengthDiff = replacement.length - (replEnd - replStart);
    node.flatEnd += lengthDiff;
    updateSubsequentNodes(textNodes, node, lengthDiff);
  } else {
    // Multi-node case: replacement spans multiple units
    // Put all replacement text in the first affected node, clear the rest
    const firstNode = affectedNodes[0];
    const lastNode = affectedNodes[affectedNodes.length - 1];

    const firstText = unitText(firstNode);
    const lastText = unitText(lastNode);

    const keepBefore = firstText.slice(0, Math.max(0, replStart - firstNode.flatStart));
    const keepAfter = lastText.slice(Math.min(lastText.length, replEnd - lastNode.flatStart));

    // Set first node to: text-before-replacement + replacement + text-after-replacement-in-last-node
    setUnitText(firstNode, keepBefore + replacement + keepAfter);

    // Clear intermediate and last nodes
    for (let i = 1; i < affectedNodes.length; i++) {
      setUnitText(affectedNodes[i], '');
    }

    // Recalculate flat positions
    const newFirstLength = (keepBefore + replacement + keepAfter).length;
    const oldSpanLength = lastNode.flatEnd - firstNode.flatStart;
    const lengthDiff = newFirstLength - oldSpanLength;

    // For cleared intermediate/last nodes, collapse their ranges
    firstNode.flatEnd = firstNode.flatStart + newFirstLength;
    for (let i = 1; i < affectedNodes.length; i++) {
      affectedNodes[i].flatStart = firstNode.flatEnd;
      affectedNodes[i].flatEnd = firstNode.flatEnd;
    }

    updateSubsequentNodes(textNodes, lastNode, lengthDiff);
  }
}

/**
 * Update flat positions for all text nodes after the given node.
 */
function updateSubsequentNodes(
  textNodes: TextNodeMapping[],
  afterNode: TextNodeMapping,
  lengthDiff: number
): void {
  if (lengthDiff === 0) return;
  let found = false;
  for (const node of textNodes) {
    if (found) {
      node.flatStart += lengthDiff;
      node.flatEnd += lengthDiff;
    } else if (node === afterNode) {
      found = true;
    }
  }
}

/**
 * Get the file extension from a filename.
 */
export function getFileExtension(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() ?? '';
}

/**
 * Check if a file is a supported Word document (.doc or .docx).
 */
export function isWordFile(filename: string): boolean {
  const ext = getFileExtension(filename);
  return ext === 'docx' || ext === 'doc';
}

/**
 * Check if a file is a legacy .doc format (not .docx).
 */
export function isLegacyDoc(filename: string): boolean {
  return getFileExtension(filename) === 'doc';
}

/**
 * Check if a file is any supported document format.
 */
export function isSupportedFile(filename: string): boolean {
  return isWordFile(filename);
}
