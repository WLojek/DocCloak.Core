/**
 * @doccloak/core/pdf - extraction with glyph geometry (T210).
 *
 * Walks every page's content (the /Contents streams joined into one operator
 * list, plus form XObjects recursively) with the state machine, decodes every
 * text-showing operator through the font model and records one GlyphRun per
 * operator: codes, Unicode, advances and user-space origins. The flat text
 * is built from the runs in content order with deterministic separators, so
 * detection offsets map back to (stream, operator, glyph).
 *
 * Everything the writer needs later (parsed document, operator lists, fonts,
 * per-page safety issues) is kept in the returned model; the input bytes are
 * never modified.
 */

import { PDFDocument } from '@cantoo/pdf-lib';
import type { PDFContext, PDFObject } from './objects.ts';
import {
  PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream,
  StreamDecodeError, decodeStream, getArray, getDict, getName, getNumber, getStream, inheritedPageValue, itemsOf, numbersOf,
  pageContentStreams, pageResources, refKey, resolve, stringText,
} from './objects.ts';
import { lexContent, TEXT_SHOW_OPS } from './lexer.ts';
import type { ContentOp, Operand } from './lexer.ts';
import { StateMachine, adjustmentAdvance, apply, glyphAdvance, initialState, mul, matrixFromOperands } from './textstate.ts';
import { loadFont } from './fonts.ts';
import type { LoadedFont } from './fonts.ts';
import type { Glyph, GlyphRun, PdfPageInfo, RemovedPart, RunLocalState } from './types.ts';
import { UnsupportedDocumentError } from '../dom/errors.ts';
import type { UnredactablePart } from '../dom/errors.ts';
import { normalizeForCompare } from './oracle.ts';
import type { OracleDocument, OracleTextItem } from './oracle.ts';

/** One content stream we may rewrite: page contents (joined) or a form XObject. */
export interface StreamRecord {
  key: string;
  kind: 'page' | 'xobject';
  page: number;
  /** For xobjects: the stream object (its dict is edited in place); for pages: null (Contents is replaced). */
  ref: PDFRef | null;
  stream: PDFStream | null;
  source: Uint8Array;
  ops: ContentOp[];
  resources: PDFDict | undefined;
  /** False when a form XObject has no /Resources of its own and inherits the parent's (deprecated but common). */
  ownResources: boolean;
  /** Resource names of fonts used by text-showing operators in this stream. */
  fontsUsed: Set<string>;
  /** Pages this stream is drawn on (xobjects shared across pages). */
  pages: Set<number>;
}

export interface PageRecord {
  index: number;
  dict: PDFDict;
  ref: PDFRef | null;
  info: PdfPageInfo;
  /** Stream keys drawn on this page, in draw order (page stream first). */
  streams: string[];
  /** Reasons the page cannot be edited safely (empty = editable). */
  issues: string[];
  /** Per-page text hidden/visible flags for the UI. */
  hiddenGlyphs: number;
  /** True when the page text comes from the oracle (our decoder disagreed): edits rasterize the page. */
  oracleText: boolean;
  /** True when the page content is hostile to a viewer (exponential XObject graph, oversized content): pdf.js is never asked about it. */
  hostile?: boolean;
  /** Our decoder's runs and text of a raster-only page (kept for blacking out with our geometry too). */
  ownRuns?: GlyphRun[];
  ownText?: string;
}

export interface PdfModel {
  bytes: Uint8Array;
  doc: PDFDocument;
  ctx: PDFContext;
  pages: PageRecord[];
  streams: Map<string, StreamRecord>;
  fonts: Map<string, LoadedFont>;
}

export interface ExtractionResult {
  plainText: string;
  runs: GlyphRun[];
  pages: PdfPageInfo[];
  unredactable: UnredactablePart[];
  removed: RemovedPart[];
  warnings: string[];
  empty: boolean;
  model: PdfModel;
}

export interface ExtractOptions {
  maxBytes?: number;
  maxPages?: number;
  /** Cap on glyphs in the whole document (default 1.5 million). */
  maxGlyphs?: number;
  password?: string;
  /**
   * Independent extractor. When given, every page's text is compared with
   * it; a page whose text differs is marked raster-only and its text is
   * taken from the oracle (so detection still sees what a viewer shows).
   */
  oracle?: OracleDocument;
}

export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
export const DEFAULT_MAX_PAGES = 500;
const MAX_XOBJECT_DEPTH = 8;
const MAX_OPS_PER_PAGE = 2_000_000;
/** Decoded content bytes walked per page (page streams, form XObjects, patterns): a Flate bomb stops here. */
const MAX_CONTENT_BYTES_PER_PAGE = 32 * 1024 * 1024;
/** Form XObject draws per page: an exponential chain of forms stops here. */
const MAX_XOBJECT_DRAWS_PER_PAGE = 20_000;
/** Glyphs per document (each glyph is a JavaScript object with its geometry): beyond this the file is too large for a browser tab. */
export const DEFAULT_MAX_GLYPHS = 1_500_000;

/** Parse the file and extract text with geometry. Throws UnsupportedDocumentError for refusals. */
export async function extractPdf(bytes: Uint8Array, options: ExtractOptions = {}): Promise<ExtractionResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (bytes.length > maxBytes) {
    throw new UnsupportedDocumentError('too-large', `PDF is ${bytes.length} bytes; the limit is ${maxBytes}`, [String(bytes.length)]);
  }
  if (!looksLikePdf(bytes)) {
    throw new UnsupportedDocumentError('invalid-package', 'not a PDF file (missing %PDF header)');
  }

  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      updateMetadata: false,
      throwOnInvalidObject: false,
      capNumbers: true,
      // An empty user password opens files that only carry an owner password (print/copy
      // restrictions), the common case; pdf.js opens those without asking too.
      password: options.password ?? '',
    } as Parameters<typeof PDFDocument.load>[1]);
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    if (/password|encrypt|decrypt/i.test(message)) {
      throw new UnsupportedDocumentError('encrypted', 'PDF is encrypted; supply the password to redact it', [message]);
    }
    throw new UnsupportedDocumentError('invalid-package', `PDF could not be parsed: ${message}`);
  }
  if (doc.isEncrypted) {
    throw new UnsupportedDocumentError('encrypted', 'PDF is encrypted; supply the password to redact it');
  }
  const ctx = doc.context;
  let pdfPages: ReturnType<PDFDocument['getPages']>;
  try {
    pdfPages = doc.getPages();
  } catch (err) {
    // A page tree that is not one (cycles, a leaf as root, an invalid object) is a broken file.
    throw new UnsupportedDocumentError('invalid-package', `PDF page tree cannot be read: ${(err as Error).message ?? String(err)}`);
  }
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  if (pdfPages.length > maxPages) {
    throw new UnsupportedDocumentError('too-large', `PDF has ${pdfPages.length} pages; the limit is ${maxPages}`, [String(pdfPages.length)]);
  }

  const model: PdfModel = { bytes, doc, ctx, pages: [], streams: new Map(), fonts: new Map() };
  const warnings: string[] = [];
  const unredactable: UnredactablePart[] = [];
  const runs: GlyphRun[] = [];
  const pageInfos: PdfPageInfo[] = [];
  const text = new TextBuilder();

  for (let p = 0; p < pdfPages.length; p++) {
    const page = pdfPages[p];
    const pageDict = page.node;
    const pageRef = page.ref;
    const mediaBox = numbersOf(ctx, asArray(inheritedPageValue(ctx, pageDict, 'MediaBox')));
    const width = mediaBox.length === 4 ? Math.abs(mediaBox[2] - mediaBox[0]) : 612;
    const height = mediaBox.length === 4 ? Math.abs(mediaBox[3] - mediaBox[1]) : 792;
    const rotateObj = inheritedPageValue(ctx, pageDict, 'Rotate');
    const rotate = rotateObj instanceof PDFNumber ? ((rotateObj.asNumber() % 360) + 360) % 360 : 0;

    const record: PageRecord = {
      index: p,
      dict: pageDict,
      ref: pageRef,
      info: { index: p, width, height, rotate, hasImages: false, imageOnly: false, textStart: text.length, textEnd: text.length },
      streams: [],
      issues: [],
      hiddenGlyphs: 0,
      oracleText: false,
    };
    model.pages.push(record);
    const pageTextStart = text.length;
    const pageRunStart = runs.length;
    text.startPage(runs, runs.length);
    const cropBox = numbersOf(ctx, asArray(inheritedPageValue(ctx, pageDict, 'CropBox')));
    const box = pageBox(mediaBox, cropBox);

    // Join the page's content streams into one operator list (an operator may span streams).
    const parts = pageContentStreams(ctx, pageDict);
    const chunks: Uint8Array[] = [];
    for (const part of parts) {
      try {
        chunks.push(decodeStream(ctx, part.stream));
      } catch (err) {
        record.issues.push(`content stream unreadable: ${(err as Error).message}`);
      }
    }
    const source = joinWithNewlines(chunks);
    if (source.length > MAX_CONTENT_BYTES_PER_PAGE) {
      throw new UnsupportedDocumentError('too-large', `page ${p + 1} holds ${source.length} bytes of content; the limit is ${MAX_CONTENT_BYTES_PER_PAGE}`, [String(source.length)]);
    }
    const ops = lexContent(source);
    if (ops.length > MAX_OPS_PER_PAGE) record.issues.push('content stream too large');
    const key = `p${p}`;
    const stream: StreamRecord = {
      key, kind: 'page', page: p, ref: null, stream: null, source, ops,
      resources: pageResources(ctx, pageDict), ownResources: true, fontsUsed: new Set(), pages: new Set([p]),
    };
    model.streams.set(key, stream);
    record.streams.push(key);

    const walker = new Walker(model, record, runs, text, box);
    walker.walk(stream, initialState(), 0, new Set());
    if (walker.hostile) {
      record.hostile = true;
      record.issues.push('page content is hostile to a viewer (rasterization refused)');
    }
    const maxGlyphs = options.maxGlyphs ?? DEFAULT_MAX_GLYPHS;
    // Every run costs about as much as a few glyphs (its own objects and arrays).
    let glyphCount = 0;
    for (const r of runs) glyphCount += r.glyphs.length + 3;
    if (glyphCount > maxGlyphs) {
      throw new UnsupportedDocumentError('too-large', `PDF holds more than ${maxGlyphs} glyphs; the limit protects the host's memory`, [String(glyphCount)]);
    }

    record.info.hasImages = walker.sawImage;
    record.info.imageOnly = walker.sawImage && walker.visibleGlyphs === 0;

    let oracleGarbage = false;
    if (options.oracle && !record.hostile) {
      let items: OracleTextItem[] | null = null;
      let theirs = '';
      try {
        items = await options.oracle.pageItems(p);
        theirs = normalizeForCompare(items.map((it) => it.str + (it.hasEOL ? '\n' : '')).join(''));
      } catch (err) {
        // pdf.js could not read the page: keep our text (so detection still runs) and mark the page
        // unsafe; an edit on it will rasterize, and if pdf.js cannot render it either the write refuses.
        record.issues.push(`reference extractor failed: ${(err as Error).message}`);
        warnings.push(`page ${p + 1}: the reference extractor could not read it; edits on this page are rasterized`);
      }
      let ours = normalizeForCompare(text.compareText());
      if (items?.some((it) => it.dir === 'rtl')) {
        // pdf.js hands right-to-left items back in visual order; compare the characters as a
        // bag so a decoding difference still shows while the ordering does not.
        ours = [...ours].sort().join('');
        theirs = [...theirs].sort().join('');
      }
      if (items !== null && ours !== theirs) {
        record.issues.push('text decoding differs from the reference extractor');
        oracleGarbage = hasGarbage(theirs);
        const { oursOnly, theirsOnly } = bagDifference(ours, theirs);
        if ((oracleGarbage && walker.undecodableGlyphs === 0) || (oursOnly.length > 0 && theirsOnly.length === 0)) {
          // pdf.js read less than we did (a font it rejects, glyphs it drops) or misread a font we
          // decoded completely: our text stays for detection; the page is still unsafe to edit in
          // place and is rasterized when redacted (with our geometry for the black boxes).
          warnings.push(`page ${p + 1}: the reference extractor read less than our decoder; the page is rasterized when redacted`);
        } else {
          record.oracleText = true;
          // Replace our page text and runs with the oracle's items; ours are kept for the raster.
          record.ownRuns = runs.slice(pageRunStart);
          record.ownText = text.slice(pageTextStart);
          text.truncate(pageTextStart);
          runs.length = pageRunStart;
          appendOracleRuns(p, items, runs, text);
          if (items.some((it) => it.str.trim() !== '')) record.info.imageOnly = false;
        }
      }
    }
    record.info.textEnd = text.length;
    if (record.info.imageOnly) {
      unredactable.push({
        part: `page ${p + 1}`,
        kind: 'scanned-page',
        label: record.hiddenGlyphs > 0
          ? `page ${p + 1} is a scanned image with a hidden OCR text layer: the text layer is redacted, the picture keeps the original`
          : `page ${p + 1} is an image without a text layer (scanned page); its content cannot be redacted`,
      });
    } else if (walker.sawImage) {
      warnings.push(`page ${p + 1}: contains images; text inside images is not scanned`);
    }
    // Glyphs our decoder cannot read make the page unredactable, unless the reference extractor
    // read the page (its text drives detection and the page is rasterized when edited). pdf.js's
    // reading does not count when it holds garbage characters or comes from a composite font
    // without a usable CMap (glyph ids shown as characters): no detector could find a value there.
    if (walker.undecodableGlyphs > 0 && (!record.oracleText || oracleGarbage || walker.unreadableCompositeFont)) {
      unredactable.push({
        part: `page ${p + 1}`,
        kind: 'undecodable-text',
        label: `page ${p + 1}: ${walker.undecodableGlyphs} glyphs use a font whose characters cannot be read`,
      });
    }
    pageInfos.push(record.info);
    text.pageBreak();
  }

  const removed = scanDocumentLevelParts(ctx, doc, model, warnings);
  const plainText = text.toString();
  aggregatePageParts(unredactable);
  // Reading-order insertion can put a later operator's text before an earlier one's: keep the
  // runs in flat-text order (the writer's segment mapping relies on it).
  runs.sort((a, b) => a.textStart - b.textStart || a.textEnd - b.textEnd);
  return {
    plainText,
    runs,
    pages: pageInfos,
    unredactable,
    removed,
    warnings,
    empty: runs.every((r) => r.glyphs.every((g) => g.unicode.trim() === '')),
    model,
  };
}

interface Box { x0: number; y0: number; x1: number; y1: number }

/** pdf.js `view`: the CropBox clipped to the MediaBox (defaults to US Letter when absent). */
function pageBox(mediaBox: number[], cropBox: number[]): Box {
  const m = mediaBox.length === 4 ? mediaBox : [0, 0, 612, 792];
  let box: Box = { x0: Math.min(m[0], m[2]), y0: Math.min(m[1], m[3]), x1: Math.max(m[0], m[2]), y1: Math.max(m[1], m[3]) };
  if (cropBox.length === 4) {
    const c = { x0: Math.min(cropBox[0], cropBox[2]), y0: Math.min(cropBox[1], cropBox[3]), x1: Math.max(cropBox[0], cropBox[2]), y1: Math.max(cropBox[1], cropBox[3]) };
    const inter = { x0: Math.max(box.x0, c.x0), y0: Math.max(box.y0, c.y0), x1: Math.min(box.x1, c.x1), y1: Math.min(box.y1, c.y1) };
    if (inter.x1 > inter.x0 && inter.y1 > inter.y0) box = inter;
  }
  return box;
}

function insideBox(b: Box, x: number, y: number): boolean {
  const eps = 0.01;
  return x >= b.x0 - eps && x <= b.x1 + eps && y >= b.y0 - eps && y <= b.y1 + eps;
}

function looksLikePdf(bytes: Uint8Array): boolean {
  const head = Math.min(bytes.length, 1024);
  for (let i = 0; i + 4 <= head; i++) {
    if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 && bytes[i + 3] === 0x46) return true;
  }
  return false;
}

function asArray(obj: PDFObject | undefined): PDFArray | undefined {
  return obj instanceof PDFArray ? obj : undefined;
}

function joinWithNewlines(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length + 1;
  const out = new Uint8Array(Math.max(0, total));
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
    out[p++] = 0x0a;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Flat text builder                                                   */
/* ------------------------------------------------------------------ */

/** One glyph placed on the current line: where its text sits and where it is on the baseline. */
interface LineSlot {
  /** Offset of the glyph text in the flat text (a synthetic space, when `lead` is 1, sits right before it). */
  offset: number;
  len: number;
  lead: number;
  /** Baseline position of the glyph origin and end in the line frame (user units). */
  along: number;
  endAlong: number;
  isSpace: boolean;
  /** The run's textOffsets array and the glyph's index in it (patched when text is inserted before it). */
  offsets: number[];
  index: number;
}

/**
 * Builds the plain text from glyphs. Separators are decided from geometry: a
 * baseline jump starts a new line, a gap along the baseline inserts a space.
 * Within a line the glyphs are kept in READING order along the baseline: a
 * glyph placed left of earlier ones (right-aligned cells drawn from the
 * right, words or glyphs deliberately shown back to front) is inserted where
 * it belongs, so detection sees "Jan Kowalski" whatever the content order was.
 * Every inserted character is recorded so the writer knows which offsets
 * belong to glyphs and which are synthetic.
 */
class TextBuilder {
  private parts: string[] = [];
  private len = 0;
  /** Text of the glyphs pdf.js would report (origin inside the page box), for the oracle comparison. */
  private compare: string[] = [];
  private lastGlyph: { x: number; y: number; ex: number; ey: number; size: number; endX: number; endY: number; page: number } | null = null;
  /** Glyphs of the current line in text order, with the line frame (origin and baseline direction of its first glyph). */
  private line: { slots: LineSlot[]; x: number; y: number; ex: number; ey: number; page: number } | null = null;
  /** Runs of the current page (their textStart/textEnd move when text is inserted before them). */
  private runsRef: GlyphRun[] | null = null;
  private pageRunStart = 0;

  get length(): number {
    return this.len;
  }

  /** Start a page: separators reset, and the runs the page produces (from index `from` of `runs`) are tracked. */
  startPage(runs: GlyphRun[], from: number): void {
    this.runsRef = runs;
    this.pageRunStart = from;
    this.line = null;
    this.lastGlyph = null;
    this.compare = [];
  }

  /**
   * Place a glyph: decide the separator and where its text goes. Returns the offset where the
   * glyph text starts; the text itself is appended or inserted here.
   */
  placeGlyph(page: number, x: number, y: number, endX: number, endY: number, emX: readonly [number, number], size: number, unicode: string, offsets: number[], index: number): number {
    const last = this.lastGlyph;
    const sizeRef = Math.max(last?.size ?? 0, size, 1);
    let newLine = !last || last.page !== page || !this.line;
    let across = 0;
    if (last && last.page === page) {
      const dx = x - last.endX;
      const dy = y - last.endY;
      const exLen = Math.hypot(last.ex, last.ey) || 1;
      across = (dx * -last.ey + dy * last.ex) / exLen;
      if (Math.abs(across) > 0.45 * sizeRef) newLine = true;
    }
    if (unicode === '') {
      // Nothing to show: no separator, no line change; a slot keeps the offset patched.
      const offset = this.len;
      if (!newLine && this.line) {
        const along = this.alongOnLine(this.line, x, y);
        this.line.slots.push({ offset, len: 0, lead: 0, along, endAlong: this.alongOnLine(this.line, endX, endY), isSpace: false, offsets, index });
      }
      return offset;
    }
    const isSpace = /^\s+$/.test(unicode);
    if (newLine) {
      if (last && last.page === page) {
        const gapLines = Math.abs(across) / (sizeRef * 1.15);
        this.append(gapLines > 1.8 ? '\n\n' : '\n');
      }
      this.line = { slots: [], x, y, ex: emX[0], ey: emX[1], page };
      const offset = this.len;
      this.append(unicode);
      this.line.slots.push({ offset, len: unicode.length, lead: 0, along: 0, endAlong: this.alongOnLine(this.line, endX, endY), isSpace, offsets, index });
      this.lastGlyph = { x, y, ex: emX[0], ey: emX[1], size, endX, endY, page };
      return offset;
    }

    const line = this.line!;
    const along = this.alongOnLine(line, x, y);
    const endAlong = this.alongOnLine(line, endX, endY);
    // Position in reading order: before the first slot that sits clearly further right. Glyphs
    // that physically overlap their neighbours (overprinting, an overflowing placeholder) keep
    // content order instead of being interleaved.
    const shown = (from: number, step: number): LineSlot | undefined => {
      for (let k = from; k >= 0 && k < line.slots.length; k += step) if (line.slots[k].len > 0) return line.slots[k];
      return undefined;
    };
    const overlaps = (sl: LineSlot | undefined): boolean => {
      if (!sl) return false;
      const common = Math.min(endAlong, sl.endAlong) - Math.max(along, sl.along);
      return common > 0.3 * Math.max(0.01, Math.min(endAlong - along, sl.endAlong - sl.along));
    };
    // Fast path: text almost always continues to the right of everything placed so far.
    const lastSlot = line.slots[line.slots.length - 1];
    // Order by glyph centre, so a narrow glyph (i, l, a space) placed just left of a wide one is
    // not filed after it.
    const centre = (along + endAlong) / 2;
    const slotCentre = (sl: LineSlot): number => (sl.along + sl.endAlong) / 2;
    let at = !lastSlot || centre >= slotCentre(lastSlot) ? line.slots.length : line.slots.findIndex((sl) => slotCentre(sl) > centre);
    if (at < 0) at = line.slots.length;
    let left = shown(at - 1, -1);
    let right = at < line.slots.length ? shown(at, 1) : undefined;
    if (at < line.slots.length && (overlaps(left) || overlaps(right))) {
      at = line.slots.length;
      left = shown(at - 1, -1);
      right = undefined;
    }
    const gap = (from: LineSlot | undefined, toAlong: number): boolean => !!from && toAlong - from.endAlong > 0.12 * sizeRef;
    // A glyph that starts clearly left of its predecessor's end but stays in content order (overprint,
    // a run drawn over another) is a separate word too.
    const backwards = !!left && along < left.endAlong - 0.5 * sizeRef;
    const lead = (gap(left, along) || backwards) && !left!.isSpace && !isSpace ? 1 : 0;
    const piece = (lead ? ' ' : '') + unicode;
    const insertAt = right ? right.offset - right.lead : at < line.slots.length ? line.slots[at].offset : this.len;
    const inserted = insertAt < this.len; // else appended: nothing after it to move
    this.splice(insertAt, 0, piece);
    if (inserted) for (const sl of line.slots) if (sl.offset >= insertAt) { sl.offset += piece.length; sl.offsets[sl.index] += piece.length; }
    const slot: LineSlot = { offset: insertAt + lead, len: unicode.length, lead, along, endAlong, isSpace, offsets, index };
    line.slots.splice(at, 0, slot);
    if (right) {
      // The right neighbour's separator is decided again against its new left neighbour.
      const wantLead = endAlong < right.along && right.along - endAlong > 0.12 * sizeRef && !isSpace && !right.isSpace ? 1 : 0;
      if (wantLead !== right.lead) {
        const sepAt = right.offset - right.lead;
        if (wantLead) this.splice(sepAt, 0, ' ');
        else this.splice(sepAt, 1, '');
        const delta = wantLead - right.lead;
        for (const sl of line.slots) if (sl.offset > sepAt || (sl === right)) { sl.offset += delta; sl.offsets[sl.index] += delta; }
        right.lead = wantLead;
      }
    }
    this.lastGlyph = { x, y, ex: emX[0], ey: emX[1], size, endX, endY, page };
    return slot.offset;
  }

  private alongOnLine(line: { x: number; y: number; ex: number; ey: number }, x: number, y: number): number {
    const len = Math.hypot(line.ex, line.ey) || 1;
    return ((x - line.x) * line.ex + (y - line.y) * line.ey) / len;
  }

  append(s: string): void {
    if (!s) return;
    this.parts.push(s);
    this.len += s.length;
  }

  /**
   * Replace `del` characters at `at` by `ins` (always inside the current line, the tail of the
   * text) and move the text ranges of the page's finished runs after it. Glyph offsets of the
   * current line are patched by the caller through the slots.
   */
  private splice(at: number, del: number, ins: string): void {
    if (!del && !ins) return;
    if (at === this.len && !del) { this.append(ins); return; }
    const all = this.toString();
    this.parts = [all.slice(0, at) + ins + all.slice(at + del)];
    this.len += ins.length - del;
    const delta = ins.length - del;
    if (!this.runsRef) return;
    for (let i = this.pageRunStart; i < this.runsRef.length; i++) {
      const run = this.runsRef[i];
      if (run.textStart >= at + del) run.textStart += delta;
      else if (run.textStart > at) run.textStart = at;
      if (run.textEnd > at) run.textEnd = Math.max(at, run.textEnd + delta);
    }
  }

  /** Record a glyph's text for the oracle comparison (off-page glyphs are skipped, as pdf.js drops them). */
  appendCompare(s: string): void {
    if (s) this.compare.push(s);
  }

  compareText(): string {
    return this.compare.join('');
  }

  pageBreak(): void {
    if (this.len > 0 && !this.endsWith('\n\n')) this.append(this.endsWith('\n') ? '\n' : '\n\n');
    this.lastGlyph = null;
    this.line = null;
  }

  slice(from: number): string {
    return this.toString().slice(from);
  }

  truncate(len: number): void {
    const s = this.toString().slice(0, len);
    this.parts = [s];
    this.len = s.length;
    this.lastGlyph = null;
    this.line = null;
  }

  private endsWith(suffix: string): boolean {
    let tail = '';
    for (let i = this.parts.length - 1; i >= 0 && tail.length < suffix.length; i--) tail = this.parts[i] + tail;
    return tail.endsWith(suffix);
  }

  toString(): string {
    if (this.parts.length > 1) this.parts = [this.parts.join('')];
    return this.parts[0] ?? '';
  }
}

/**
 * Synthesize runs from pdf.js text items for a raster-only page: one glyph
 * per character with proportional widths, geometry from the item transform.
 * These runs carry `oracle: true` and are never edited, only rasterized.
 */
function appendOracleRuns(page: number, items: OracleTextItem[], runs: GlyphRun[], text: TextBuilder): void {
  items.forEach((item, idx) => {
    const chars = [...item.str];
    const [a, b, c, d, e, f] = item.transform;
    const vertical = item.dir === 'ttb';
    const fontSize = Math.hypot(c, d) || Math.hypot(a, b) || 1;
    // Horizontal items advance along (a, b) over item.width; vertical ones downwards along -(c, d)
    // over item.height (the raster covers a vertical item whole, both directions).
    const len = vertical ? Math.hypot(c, d) || 1 : Math.hypot(a, b) || 1;
    const ux = vertical ? -c / len : a / len;
    const uy = vertical ? -d / len : b / len;
    const per = chars.length > 0 ? (vertical ? item.height : item.width) / chars.length : 0;
    const glyphs: Glyph[] = [];
    const textOffsets: number[] = [];
    const advances: number[] = [];
    const start = text.length;
    chars.forEach((ch, i) => {
      textOffsets.push(text.length);
      text.append(ch);
      glyphs.push({
        code: -1, codeLength: 0, unicode: ch, width: fontSize > 0 ? (per / fontSize) * 1000 : 0, advance: per,
        x: e + ux * per * i, y: f + uy * per * i, fontSize, item: 0, byteOffset: 0,
      });
      advances.push(per * i);
    });
    if (item.hasEOL) text.append('\n');
    runs.push({
      page,
      streamKey: `oracle:p${page}`,
      opIndex: idx,
      fontName: item.fontName,
      fontKey: '',
      glyphs,
      renderMode: 0,
      hidden: false,
      textOffsets,
      textStart: start,
      textEnd: text.length,
      emX: vertical ? [-c, -d] : [a, b],
      emY: vertical ? [a, b] : [c, d],
      local: { ctm: [1, 0, 0, 1, 0, 0], tm: [1, 0, 0, 1, 0, 0], tlm: [1, 0, 0, 1, 0, 0], fontSize: len, charSpacing: 0, wordSpacing: 0, hscale: 1, leading: 0, rise: 0, advances },
      oracle: true,
      ...(vertical ? { vertical: true } : {}),
    });
  });
}

/* ------------------------------------------------------------------ */
/* Content walker                                                      */
/* ------------------------------------------------------------------ */

class Walker {
  sawImage = false;
  visibleGlyphs = 0;
  undecodableGlyphs = 0;
  /** A composite font without a usable CMap/ToUnicode showed text: pdf.js's reading of it is a guess (glyph ids), never trusted. */
  unreadableCompositeFont = false;
  private space: string | undefined;
  private readonly walkedAux = new Set<string>();
  private draws = 0;
  private contentBytes = 0;
  /** Set when a cap fired: pdf.js would walk the same content without our caps. */
  hostile = false;
  private readonly model: PdfModel;
  private readonly page: PageRecord;
  private readonly runs: GlyphRun[];
  private readonly text: TextBuilder;
  private readonly box: Box;

  constructor(model: PdfModel, page: PageRecord, runs: GlyphRun[], text: TextBuilder, box: Box) {
    this.model = model;
    this.page = page;
    this.runs = runs;
    this.text = text;
    this.box = box;
  }

  walk(stream: StreamRecord, base: ReturnType<typeof initialState>, depth: number, active: Set<string>): void {
    const { ctx } = this.model;
    const fontsDict = getDict(ctx, stream.resources, 'Font');
    const resolveFont = (name: string): LoadedFont | undefined => loadFont(ctx, fontsDict, name, this.model.fonts);
    const sm = new StateMachine(base);
    // Text can also live in tiling pattern cells and soft-mask groups of this stream's resources.
    this.walkAuxiliary(stream, base, depth, active);
    const ops = stream.ops;
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (op.op === '') {
        this.page.issues.push(`${stream.key}: unparsable content at operator ${i}`);
        continue;
      }
      if (TEXT_SHOW_OPS.has(op.op)) {
        // ' and " move to the next line (and set spacing) before showing.
        if (op.op === "'" || op.op === '"') sm.update(op, resolveFont);
        this.show(stream, i, op, sm, resolveFont);
        continue;
      }
      if (op.op === 'Do') {
        sm.update(op, resolveFont);
        this.doXObject(stream, op, sm, depth, active);
        continue;
      }
      if (op.op === 'BI') {
        this.sawImage = true;
        continue;
      }
      if (op.op === 'd0' || op.op === 'd1') {
        this.page.issues.push(`${stream.key}: Type3 glyph procedure operators in page content`);
      }
      if (op.op === 'sh') {
        // Shading is drawing, not text; nothing to do.
      }
      sm.update(op, resolveFont);
    }
  }

  /**
   * Tiling patterns (PatternType 1) and ExtGState soft masks (/SMask /G) are content streams a
   * viewer paints, with their own resources: walk them once per page so their text reaches
   * detection and can be edited in place. Their glyphs are tagged with a `space` (pattern space
   * is tiled over the fill area, a mask group sits at the `gs` transform), so they never share a
   * line with page text and are never blacked out by a raster.
   */
  private walkAuxiliary(stream: StreamRecord, base: ReturnType<typeof initialState>, depth: number, active: Set<string>): void {
    const { ctx } = this.model;
    const patterns = getDict(ctx, stream.resources, 'Pattern');
    if (patterns) {
      for (const [k, v] of patterns.entries()) {
        const obj = resolve(ctx, v);
        if (!(obj instanceof PDFStream)) continue; // shading patterns are dictionaries without content
        if (getNumber(ctx, obj.dict, 'PatternType') !== 1) continue;
        this.walkAuxStream(stream, obj, v, `pattern ${k.decodeText()}`, base, depth, active);
      }
    }
    const states = getDict(ctx, stream.resources, 'ExtGState');
    if (states) {
      for (const [k, v] of states.entries()) {
        const d = resolve(ctx, v);
        if (!(d instanceof PDFDict)) continue;
        const mask = getDict(ctx, d, 'SMask');
        if (!mask) continue;
        const raw = mask.get(PDFName.of('G'));
        const group = resolve(ctx, raw);
        if (!(group instanceof PDFStream)) continue;
        this.walkAuxStream(stream, group, raw, `soft mask ${k.decodeText()}`, base, depth, active);
      }
    }
  }

  private walkAuxStream(parent: StreamRecord, xobj: PDFStream, raw: PDFObject | undefined, label: string, base: ReturnType<typeof initialState>, depth: number, active: Set<string>): void {
    const { ctx } = this.model;
    const ref = raw instanceof PDFRef ? raw : null;
    const key = ref ? `x${refKey(ref)}` : `${parent.key}/${label}`;
    if (this.walkedAux.has(key) || active.has(key)) return;
    if (depth >= MAX_XOBJECT_DEPTH) {
      this.page.issues.push(`${parent.key}: ${label} nested deeper than ${MAX_XOBJECT_DEPTH}`);
      return;
    }
    this.walkedAux.add(key);
    let record = this.model.streams.get(key);
    if (!record) {
      let source: Uint8Array;
      try {
        source = decodeStream(ctx, xobj);
      } catch (err) {
        this.page.issues.push(`${label} unreadable: ${err instanceof StreamDecodeError ? err.message : String(err)}`);
        return;
      }
      if (!this.accountBytes(source.length, key)) return;
      const ownResources = getDict(ctx, xobj.dict, 'Resources');
      record = {
        key, kind: 'xobject', page: this.page.index, ref, stream: xobj, source, ops: lexContent(source),
        resources: ownResources ?? parent.resources, ownResources: !!ownResources, fontsUsed: new Set(), pages: new Set(),
      };
      this.model.streams.set(key, record);
    }
    record.pages.add(this.page.index);
    if (!this.page.streams.includes(key)) this.page.streams.push(key);
    const matrix = matrixFromOperands(toOperands(numbersOf(ctx, getArray(ctx, xobj.dict, 'Matrix')))) ?? [1, 0, 0, 1, 0, 0];
    const inner = initialState(mul(matrix, base.ctm));
    const prevSpace = this.space;
    this.space = key;
    active.add(key);
    this.walk(record, inner, depth + 1, active);
    active.delete(key);
    this.space = prevSpace;
  }

  /** Decoded content walked for this page; a page past the cap is unsafe (issue) and its remaining streams are skipped. */
  private accountBytes(n: number, key: string): boolean {
    this.contentBytes += n;
    if (this.contentBytes <= MAX_CONTENT_BYTES_PER_PAGE) return true;
    this.page.issues.push(`${key}: page content exceeds ${MAX_CONTENT_BYTES_PER_PAGE} decoded bytes`);
    this.hostile = true;
    return false;
  }

  private doXObject(stream: StreamRecord, op: ContentOp, sm: StateMachine, depth: number, active: Set<string>): void {
    const { ctx } = this.model;
    const nameOp = op.operands[0];
    if (!nameOp || nameOp.kind !== 'name') return;
    const xobjects = getDict(ctx, stream.resources, 'XObject');
    if (!xobjects) return;
    const raw = xobjects.get(PDFName.of(nameOp.value));
    const xobj = resolve(ctx, raw);
    if (!(xobj instanceof PDFStream)) return;
    const subtype = getName(ctx, xobj.dict, 'Subtype');
    if (subtype === 'Image') {
      this.sawImage = true;
      return;
    }
    if (subtype !== 'Form') return;
    if (depth >= MAX_XOBJECT_DEPTH) {
      this.page.issues.push(`${stream.key}: form XObject nesting deeper than ${MAX_XOBJECT_DEPTH}`);
      return;
    }
    if (++this.draws > MAX_XOBJECT_DRAWS_PER_PAGE) {
      if (this.draws === MAX_XOBJECT_DRAWS_PER_PAGE + 1) this.page.issues.push(`more than ${MAX_XOBJECT_DRAWS_PER_PAGE} form XObject draws on one page`);
      this.hostile = true;
      return;
    }
    const ref = raw instanceof PDFRef ? raw : null;
    const key = ref ? `x${refKey(ref)}` : `${stream.key}/${nameOp.value}`;
    if (active.has(key)) {
      this.page.issues.push(`${stream.key}: recursive form XObject ${key}`);
      return;
    }
    let record = this.model.streams.get(key);
    if (!record) {
      let source: Uint8Array;
      try {
        source = decodeStream(ctx, xobj);
      } catch (err) {
        this.page.issues.push(`form XObject ${key} unreadable: ${err instanceof StreamDecodeError ? err.message : String(err)}`);
        return;
      }
      if (!this.accountBytes(source.length, key)) return;
      const ownResources = getDict(ctx, xobj.dict, 'Resources');
      record = {
        key, kind: 'xobject', page: this.page.index, ref, stream: xobj, source, ops: lexContent(source),
        resources: ownResources ?? stream.resources, ownResources: !!ownResources, fontsUsed: new Set(), pages: new Set(),
      };
      this.model.streams.set(key, record);
    }
    record.pages.add(this.page.index);
    if (!this.page.streams.includes(key)) this.page.streams.push(key);

    // Form space: CTM' = Matrix × CTM; the walk runs in a saved state.
    const matrix = matrixFromOperands(toOperands(numbersOf(ctx, getArray(ctx, xobj.dict, 'Matrix')))) ?? [1, 0, 0, 1, 0, 0];
    const inner = initialState(mul(matrix, sm.state.ctm));
    inner.text = { ...sm.state.text };
    inner.fillLuminance = sm.state.fillLuminance;
    inner.strokeLuminance = sm.state.strokeLuminance;
    active.add(key);
    this.walk(record, inner, depth + 1, active);
    active.delete(key);
  }

  private show(stream: StreamRecord, opIndex: number, op: ContentOp, sm: StateMachine, resolveFont: (n: string) => LoadedFont | undefined): void {
    const t = sm.state.text;
    const font = t.font ?? (t.fontName ? resolveFont(t.fontName) : undefined) ?? null;
    if (!sm.inText) this.page.issues.push(`${stream.key}: text shown outside BT/ET at operator ${opIndex}`);
    if (!font) {
      this.page.issues.push(`${stream.key}: text shown with unknown font /${t.fontName || '?'} at operator ${opIndex}`);
      // Still advance nothing; we cannot decode. Mark as undecodable text.
      this.undecodableGlyphs += 1;
      return;
    }
    if (font.problems.length > 0) {
      for (const pr of font.problems) this.page.issues.push(`${stream.key}: font /${t.fontName} (${font.baseFont}): ${pr.message}`);
      if (font.composite && font.problems.some((pr) => pr.code !== 'vertical')) this.unreadableCompositeFont = true;
    }
    stream.fontsUsed.add(t.fontName);

    // Collect items: strings and adjustments in order.
    const items: Array<{ bytes: Uint8Array; item: number } | { adj: number }> = [];
    if (op.op === 'TJ') {
      const arr = op.operands[0];
      if (!arr || arr.kind !== 'array') {
        this.page.issues.push(`${stream.key}: TJ without an array at operator ${opIndex}`);
        return;
      }
      arr.items.forEach((it, idx) => {
        if (it.kind === 'string') items.push({ bytes: it.bytes, item: idx });
        else if (it.kind === 'number') items.push({ adj: it.value });
      });
    } else {
      const strOp = op.op === '"' ? op.operands[2] : op.operands[0];
      if (!strOp || strOp.kind !== 'string') {
        this.page.issues.push(`${stream.key}: ${op.op} without a string at operator ${opIndex}`);
        return;
      }
      items.push({ bytes: strOp.bytes, item: 0 });
    }

    const local: RunLocalState = {
      ctm: sm.state.ctm,
      tm: sm.tm,
      tlm: sm.tlm,
      fontSize: t.fontSize,
      charSpacing: t.charSpacing,
      wordSpacing: t.wordSpacing,
      hscale: t.hscale,
      leading: t.leading,
      rise: t.rise,
      advances: [],
    };
    const trm0 = sm.trm();
    const emX: [number, number] = [trm0[0], trm0[1]];
    const emY: [number, number] = [trm0[2], trm0[3]];
    const hiddenByMode = t.renderMode === 3 || t.renderMode === 7;
    const hiddenByColor = t.renderMode === 0 && sm.state.fillLuminance !== null && sm.state.fillLuminance > 0.97;
    const sizeUser = Math.hypot(trm0[2], trm0[3]);
    const tiny = sizeUser < 0.5;
    const hidden = hiddenByMode || hiddenByColor || tiny;

    const glyphs: Glyph[] = [];
    const textOffsets: number[] = [];
    let advanceSoFar = 0; // unscaled text-space x from the run start
    const positionIfEmpty = this.text.length;

    for (const item of items) {
      if ('adj' in item) {
        const d = adjustmentAdvance(t, item.adj);
        advanceSoFar += d;
        sm.advanceText(d);
        continue;
      }
      const decoded = font.decode(item.bytes);
      for (const g of decoded) {
        font.usedCodes.add(g.code);
        const trm = sm.trm();
        const [x, y] = apply(trm, 0, 0);
        const adv = glyphAdvance(t, g.width, g.isSpaceCode);
        const fontSize = Math.hypot(trm[2], trm[3]);
        const unicode = g.unicode;
        // A glyph whose Unicode is nothing, a control, U+FFFD or a private-use character cannot be
        // read by a detector: the page is unredactable unless the reference extractor reads it.
        if (unreadable(unicode) && g.width !== 0 && !g.notdef) this.undecodableGlyphs++;
        if (!hidden && unicode.trim() !== '') this.visibleGlyphs++;
        if (hidden) this.page.hiddenGlyphs++;

        // Origin after the advance: trm's x basis is one unit of (Tfs * Th)-scaled text space.
        const basis = (t.fontSize || 1) * (t.hscale || 1);
        const [endX, endY] = apply(sm.trm(), adv / basis, 0);
        const offset = this.text.placeGlyph(this.page.index, x, y, endX, endY, emX, fontSize, unicode, textOffsets, glyphs.length);
        if (unicode && !this.space && insideBox(this.box, x, y)) this.text.appendCompare(unicode);

        glyphs.push({
          code: g.code,
          codeLength: g.length,
          unicode,
          width: g.width,
          advance: adv,
          x, y, fontSize,
          item: item.item,
          byteOffset: g.offset,
        });
        textOffsets.push(offset);
        local.advances.push(advanceSoFar);
        advanceSoFar += adv;
        sm.advanceText(adv);
      }
    }

    // Text range of the run: reading-order insertion may have placed its glyphs before earlier text.
    let textStart = Number.POSITIVE_INFINITY;
    let textEnd = 0;
    glyphs.forEach((g, i) => {
      textStart = Math.min(textStart, textOffsets[i]);
      textEnd = Math.max(textEnd, textOffsets[i] + g.unicode.length);
    });
    if (!Number.isFinite(textStart)) { textStart = positionIfEmpty; textEnd = positionIfEmpty; }
    const run: GlyphRun = {
      page: this.page.index,
      streamKey: stream.key,
      opIndex,
      fontName: t.fontName,
      fontKey: font.key,
      glyphs,
      renderMode: t.renderMode,
      hidden,
      textOffsets,
      textStart,
      textEnd,
      emX,
      emY,
      local,
      ...(this.space ? { space: this.space } : {}),
    };
    this.runs.push(run);
  }
}

/**
 * Consecutive pages with the same kind of problem collapse into one part ("pages 2-22"), so a
 * document whose body font is unreadable shows one line to consent to, not one per page.
 */
function aggregatePageParts(parts: UnredactablePart[]): void {
  const pageOf = (p: UnredactablePart): number | null => {
    const m = /^page (\d+)$/.exec(p.part);
    return m ? Number(m[1]) : null;
  };
  const out: UnredactablePart[] = [];
  let i = 0;
  while (i < parts.length) {
    const first = parts[i];
    const start = pageOf(first);
    if (start === null) { out.push(first); i++; continue; }
    let j = i;
    let end = start;
    while (j + 1 < parts.length && parts[j + 1].kind === first.kind && pageOf(parts[j + 1]) === end + 1) { j++; end++; }
    if (j === i) { out.push(first); i++; continue; }
    const count = j - i + 1;
    const label = first.kind === 'undecodable-text'
      ? `pages ${start}-${end}: text uses fonts whose characters cannot be read (${count} pages)`
      : first.kind === 'scanned-page'
        ? `pages ${start}-${end}: ${first.label.replace(/^page \d+ /, '')} (${count} pages)`
        : `pages ${start}-${end} (${count} pages): ${first.label}`;
    out.push({ part: `pages ${start}-${end}`, kind: first.kind, label });
    i = j + 1;
  }
  parts.length = 0;
  for (const p of out) parts.push(p);
}

/** Characters no detector can read: controls (except tab/newline), U+FFFD, private use, non-characters. */
const GARBAGE_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFD\uE000-\uF8FF\uFFFE\uFFFF]/u;
const ALL_GARBAGE_RE = /^[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFD\uE000-\uF8FF\uFFFE\uFFFF]+$/u;

/** Characters of `a` not in `b` and of `b` not in `a`, as multisets. */
function bagDifference(a: string, b: string): { oursOnly: string; theirsOnly: string } {
  const count = new Map<string, number>();
  for (const ch of a) count.set(ch, (count.get(ch) ?? 0) + 1);
  let theirsOnly = '';
  for (const ch of b) {
    const c = count.get(ch) ?? 0;
    if (c > 0) count.set(ch, c - 1);
    else theirsOnly += ch;
  }
  let oursOnly = '';
  for (const [ch, c] of count) if (c > 0) oursOnly += ch.repeat(c);
  return { oursOnly, theirsOnly };
}

function unreadable(unicode: string): boolean {
  return unicode === '' || ALL_GARBAGE_RE.test(unicode);
}

export function hasGarbage(text: string): boolean {
  return GARBAGE_CHAR_RE.test(text);
}

function toOperands(nums: number[]): Operand[] {
  return nums.map((n) => ({ kind: 'number', value: n }));
}

/* ------------------------------------------------------------------ */
/* Document-level side channels                                        */
/* ------------------------------------------------------------------ */

/**
 * Inventory of everything outside page content that the writer drops
 * (never copied to the fresh output document). Reported so the user knows.
 */
export function scanDocumentLevelParts(ctx: PDFContext, doc: PDFDocument, model: PdfModel, warnings: string[]): RemovedPart[] {
  const removed: RemovedPart[] = [];
  const catalog = doc.catalog;

  const acro = getDict(ctx, catalog, 'AcroForm');
  if (acro) {
    const fields = getArray(ctx, acro, 'Fields');
    const count = fields ? fields.size() : 0;
    const xfa = acro.get(PDFName.of('XFA')) !== undefined;
    removed.push({ kind: 'form-fields', label: xfa ? `interactive form (${count} fields, XFA)` : `interactive form (${count} fields)`, count });
    const sigFlags = getNumber(ctx, acro, 'SigFlags') ?? 0;
    if (sigFlags & 1) removed.push({ kind: 'signatures', label: 'digital signatures (invalidated by redaction)' });
  }
  if (getDict(ctx, catalog, 'Outlines')) removed.push({ kind: 'outlines', label: 'bookmarks (outline)' });
  const names = getDict(ctx, catalog, 'Names');
  if (names) {
    if (getDict(ctx, names, 'EmbeddedFiles')) removed.push({ kind: 'attachments', label: 'embedded files (attachments)' });
    if (getDict(ctx, names, 'JavaScript')) removed.push({ kind: 'javascript', label: 'document JavaScript' });
    if (getDict(ctx, names, 'Dests')) removed.push({ kind: 'named-destinations', label: 'named destinations' });
  }
  if (getDict(ctx, catalog, 'Dests')) removed.push({ kind: 'named-destinations', label: 'named destinations' });
  if (catalog.get(PDFName.of('OpenAction')) || catalog.get(PDFName.of('AA'))) {
    removed.push({ kind: 'javascript', label: 'open action / additional actions' });
  }
  if (getStream(ctx, catalog, 'Metadata') || infoDict(ctx)) {
    removed.push({ kind: 'metadata', label: 'document properties and XMP metadata (replaced by blanks)' });
  }
  if (getDict(ctx, catalog, 'StructTreeRoot')) removed.push({ kind: 'structure-tree', label: 'tagged-PDF structure (accessibility tree)' });
  if (getDict(ctx, catalog, 'PageLabels')) removed.push({ kind: 'page-labels', label: 'page labels' });
  if (getDict(ctx, catalog, 'OCProperties')) removed.push({ kind: 'optional-content', label: 'optional content (layers) configuration' });

  let annots = 0;
  for (const page of model.pages) {
    const arr = getArray(ctx, page.dict, 'Annots');
    if (arr) annots += arr.size();
    if (getStream(ctx, page.dict, 'Metadata')) warnings.push(`page ${page.index + 1}: page-level XMP metadata removed`);
    // Page-level actions and thumbnails are dropped as well (no separate report).
  }
  if (annots > 0) removed.push({ kind: 'annotations', label: `${annots} annotations (comments, links, form widgets)`, count: annots });

  // Marked content ActualText / Alt inside content streams is scrubbed by the writer.
  return removed;
}

/** The trailer /Info dictionary, if any. */
export function infoDict(ctx: PDFContext): PDFDict | undefined {
  const ref = ctx.trailerInfo.Info;
  const v = ref ? resolve(ctx, ref) : undefined;
  return v instanceof PDFDict ? v : undefined;
}

/** Text stored in document-level side channels (Info, XMP, annotations, outlines, fields), for the verifier. */
export function collectSideChannelText(ctx: PDFContext, doc: PDFDocument): string[] {
  const out: string[] = [];
  const info = infoDict(ctx);
  if (info) for (const [, v] of info.entries()) { const s = stringText(resolve(ctx, v)); if (s) out.push(s); }
  for (const page of doc.getPages()) {
    for (const a of itemsOf(ctx, getArray(ctx, page.node, 'Annots'))) {
      if (a instanceof PDFDict) {
        for (const key of ['Contents', 'T', 'Subj', 'RC', 'V', 'DV', 'TU']) {
          const s = stringText(resolve(ctx, a.get(PDFName.of(key))));
          if (s) out.push(s);
        }
      }
    }
  }
  return out;
}
