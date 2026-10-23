/**
 * @doccloak/core/pdf - shared types (T206).
 *
 * PDF redaction that keeps the text layer: the redacted glyphs are cut out of
 * the content streams, a placeholder is written back as real text (in the
 * document's own font when it can show the placeholder, else in a matched
 * fallback face), everything else on the page stays live text. Pages that
 * cannot be edited safely are rasterized and reported, never shipped with a
 * box drawn over live text.
 */

import type { CanvasFactory } from './oracle.ts';
import type { UnredactablePart } from '../dom/errors.ts';

/**
 * Runtime assets the host serves. Everything is optional: in Node tests the
 * fallback fonts are injected through `loadFont` and pdf.js runs without a
 * worker; browsers pass same-origin URLs (no CDN, see the hosting CSP).
 */
export interface PdfAssetPaths {
  /** URL of the pdf.js worker module (pdf.worker.mjs). Omit to run pdf.js on the calling thread. */
  pdfjsWorkerUrl?: string;
  /** Base URL of the pdf.js binary CMaps (bcmap files), trailing slash. */
  cMapUrl?: string;
  /** Base URL of the pdf.js standard font files, trailing slash. */
  standardFontDataUrl?: string;
  /** Base URL of the pdf.js wasm decoders (openjpeg.wasm, jbig2.wasm, qcms_bg.wasm), trailing slash; needed to rasterize pages with JPX/JBIG2 images. */
  wasmUrl?: string;
  /** Base URL of the Liberation TTFs (`${fontsUrl}LiberationSans-Regular.ttf`), trailing slash. */
  fontsUrl?: string;
  /** Alternative to fontsUrl: load a fallback font file by its file name. */
  loadFont?: (fileName: string) => Promise<Uint8Array>;
}

/** Broad family class used to pick a fallback face. */
export type FontFamilyClass = 'sans' | 'serif' | 'mono';

/** Style facts derived from a font dictionary, enough to pick a fallback face. */
export interface FontStyle {
  family: FontFamilyClass;
  bold: boolean;
  italic: boolean;
}

/** Axis-aligned rectangle in PDF user space (points, origin bottom-left). */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 2D affine matrix [a b c d e f] as in the PDF `cm` / `Tm` operators. */
export type Matrix = readonly [number, number, number, number, number, number];

/** One shown glyph with its geometry in user space. */
export interface Glyph {
  /** Character code as encoded in the string operand. */
  code: number;
  /** Number of bytes the code occupies in the operand (1..4). */
  codeLength: number;
  /** Unicode text of the glyph ('' when the font maps it to nothing). May be several code units (ligatures). */
  unicode: string;
  /** Glyph-space width from the font metrics, in 1/1000 text space units (Type3: already scaled by FontMatrix * 1000). */
  width: number;
  /** Horizontal displacement applied after this glyph, in unscaled text space units (font size, Tc, Tw, Tz, TJ adjustment included). */
  advance: number;
  /** Origin of the glyph in user space. */
  x: number;
  y: number;
  /** Effective font size in user space (Tfs scaled by Tm and CTM), for fitting placeholders. */
  fontSize: number;
  /** Index of the operand item (for TJ arrays) this glyph came from; 0 for Tj / ' / ". */
  item: number;
  /** Byte offset of the code inside its string item. */
  byteOffset: number;
}

/** One text-showing operator (Tj, TJ, ', ") and every glyph it painted. */
export interface GlyphRun {
  /** 0-based page index. */
  page: number;
  /** Identifies the content stream: 'p<page>:c<index>' for page contents, 'x<objnum>' for a form XObject. */
  streamKey: string;
  /** Operator index within that stream (as returned by the lexer). */
  opIndex: number;
  /** Resource name of the font (as used with Tf) and its loaded model key. */
  fontName: string;
  fontKey: string;
  glyphs: Glyph[];
  /** Text render mode at the time of showing (3 and 7 paint nothing: invisible OCR layers). */
  renderMode: number;
  /** True when the run is not visible (render mode 3/7, white, fully transparent, tiny, or painted under an opaque image). */
  hidden: boolean;
  /**
   * Hidden text over an image: an OCR layer, the reading of what a scanned picture shows. A
   * redaction that touches it is painted into the picture (the page is exported as an image).
   */
  ocr?: boolean;
  /** Flat-text offset of each glyph's first character (parallel to glyphs). */
  textOffsets: number[];
  /** User-space vector of one em (1000 glyph units) along the baseline, at this run's transform. */
  emX: readonly [number, number];
  /** User-space vector of one em upwards. */
  emY: readonly [number, number];
  /**
   * Stream-local text state at the operator, for content-stream surgery
   * (independent of the CTM at which a shared form XObject was drawn).
   */
  local: RunLocalState;
  /** True for runs that came from the pdf.js oracle on a raster-only page (no stream to edit). */
  oracle?: boolean;
  /**
   * Set for text that lives in a tiling pattern cell or an ExtGState soft-mask group: its
   * user-space geometry is that of the cell/group, not of the page, so it never shares a line
   * with page text and cannot be blacked out by a raster (a pattern is tiled over its fill area).
   */
  space?: string;
  /** Oracle run of a vertical (top-to-bottom) pdf.js item: glyphs advance along emX = (c, d), the item width lies along emY. */
  vertical?: boolean;
  /** Flat-text range covered by the run (inserted separators excluded from glyph coverage but inside the range). */
  textStart: number;
  textEnd: number;
}

/** Text state captured at a text-showing operator, in the coordinates of its own stream. */
export interface RunLocalState {
  /** CTM inside the stream (identity for a page stream at top level, the form's accumulated cm inside a form). */
  ctm: Matrix;
  /** Text matrix before the first glyph and the line matrix. */
  tm: Matrix;
  tlm: Matrix;
  fontSize: number;
  charSpacing: number;
  wordSpacing: number;
  /** Tz / 100 */
  hscale: number;
  leading: number;
  rise: number;
  /** Accumulated advance (unscaled text-space x, already including Tc/Tw/Tz) before each glyph. */
  advances: number[];
}

export interface PdfPageInfo {
  index: number;
  /** MediaBox-derived size in points, after /Rotate is ignored (rotation is reported separately). */
  width: number;
  height: number;
  rotate: number;
  hasImages: boolean;
  /** True when the page shows images but no glyph at all (scanned page). */
  imageOnly: boolean;
  /**
   * True when hidden text lies over an image on the page (a scan with an OCR text layer).
   * Redacted values in it are painted over in the picture, and the page is exported as an image.
   */
  ocrText: boolean;
  /**
   * Lines of text the page shows that its text layer does not have: on a scan, text its OCR layer
   * missed (a table, a stamp); on a text page, text inside an image. Without the host's OCR they
   * cannot be found or redacted. Absent when the page was not checked (no canvas in the host) or
   * nothing is missing.
   */
  ocrMissingLines?: number;
  /**
   * Words DocCloak read itself (the host's `recognizeText`) where the page's text layer had none
   * (`ocrMissingLines`). They are detected like the layer's own words, and their values are painted
   * over in the picture (a text page with such a value is exported as an image).
   */
  ocrReadWords?: number;
  /**
   * On a page without any text layer (a picture only): the words DocCloak read on the whole page
   * with the host's OCR. Above 0 the page is handled as a scan with an OCR layer (`ocrText`); 0: read,
   * no text found (the page stays as it is). Absent when the page was not read.
   */
  ocrWholePage?: number;
  /** Flat-text range of the page. */
  textStart: number;
  textEnd: number;
}

/** A document part the writer drops instead of redacting (reported to the user). */
export interface RemovedPart {
  kind:
    | 'annotations'
    | 'form-fields'
    | 'outlines'
    | 'attachments'
    | 'javascript'
    | 'metadata'
    | 'structure-tree'
    | 'page-labels'
    | 'named-destinations'
    | 'optional-content'
    | 'signatures';
  label: string;
  count?: number;
}

/** Kinds of unredactable parts specific to PDF, in addition to the shared ones. */
export type PdfUnredactableKind = UnredactablePart['kind'];

export interface PdfReadOptions {
  assets?: PdfAssetPaths;
  /** Byte cap for the input; default 50 MB (browser heap). */
  maxBytes?: number;
  /** Page cap; default 500. */
  maxPages?: number;
  /** Cap on glyphs in the whole document (default 1.5 million; each glyph costs memory in the host). */
  maxGlyphs?: number;
  /** User password for encrypted files. Without it an encrypted file is refused. */
  password?: string;
  /**
   * Look for text a page shows that its text layer does not have: on a scan with an OCR layer, text
   * the OCR missed; on a text page with images, text inside the images (renders those pages at
   * 100 dpi). Default true.
   */
  checkOcrCoverage?: boolean;
  /**
   * Read the pages without any text layer (pictures only) with `recognizeText`, so their text joins
   * the document and their values are painted over like a scan's. Default true.
   */
  ocrImagePages?: boolean;
  /** Progress of the host OCR: pages read so far of the pages to read (called before the first and after each). */
  onOcrProgress?: (done: number, total: number) => void;
  /** Node hosts and tests: canvas factory for that check. Browsers use OffscreenCanvas. */
  canvasFactory?: CanvasFactory;
  /**
   * OCR for text a scan page's OCR layer does not have: read `region` (pixels) of `canvas` (the page
   * rendered at `dpi`, 300) and return its lines, relative to the region. Without it such text is only
   * reported (`ocrMissingLines`).
   */
  recognizeText?: RecognizeRegion;
}

/** A line a host OCR read: baseline and words with their letter boxes, in the pixels of the canvas given. */
export interface RecognizedLine {
  baseline: { x0: number; y0: number; x1: number; y1: number };
  words: Array<{
    text: string;
    bbox: { x0: number; y0: number; x1: number; y1: number };
    /** The OCR's confidence in the word, 0..100, when it gives one. */
    confidence?: number;
    symbols?: Array<{ text: string; bbox: { x0: number; y0: number; x1: number; y1: number } }>;
  }>;
}

export type RecognizeRegion = (canvas: unknown, region: { x0: number; y0: number; x1: number; y1: number }, dpi: number) => Promise<RecognizedLine[]>;

/** One glyph DocCloak read with its own OCR, in user space (origin on the baseline). */
export interface ExtraOcrGlyph { unicode: string; x: number; y: number; advance: number }

/** A word DocCloak read with its own OCR: its glyphs, the text size and the baseline / up directions (unit vectors). */
export interface ExtraOcrWord { glyphs: ExtraOcrGlyph[]; size: number; dir: [number, number]; up: [number, number] }

/**
 * Text DocCloak read on a page where the text layer had none, by line. The writer re-creates the
 * same runs from it. `whole`: the page had no text layer at all and was read entirely.
 */
export interface ExtraOcrPage { page: number; lines: ExtraOcrWord[][]; whole?: boolean }

export interface PlaceholderFit {
  /** Lowest font-size ratio (placeholder size / original size) before condensing kicks in. Default 0.65. */
  minSizeRatio?: number;
  /** Lowest horizontal scaling (Tz / 100) before the rest of the line is shifted. Default 0.8. */
  minHorizontalScale?: number;
  /** Let the placeholder overflow into the following text instead of shifting the line. Default false. */
  allowOverflow?: boolean;
}

export interface PdfWriteOptions {
  assets?: PdfAssetPaths;
  /** Export even though the file holds parts DocCloak cannot redact (images with text). Default false. */
  allowUnredactable?: boolean;
  /** Placeholder fitting policy. */
  fit?: PlaceholderFit;
  /** Rasterize pages whose text cannot be edited safely instead of refusing the file. Default true. Scan pages are always rendered. */
  rasterizeUnsafePages?: boolean;
  /** DPI for rasterized pages. Default 150; scan pages use the scan's own resolution (at least this, at most 300). */
  rasterDpi?: number;
  /** Skip the post-write verification (tests only; never in hosts). */
  skipVerify?: boolean;
}

export interface PdfWriteResult {
  blob: Blob;
  /** Writer notes the host must show, one line each. */
  warnings: string[];
  /** Parts dropped from the output (annotations, forms, ...). */
  removed: RemovedPart[];
  /** 0-based indexes of pages that were rasterized because their text could not be edited safely (black boxes). */
  rasterizedPages: number[];
  /**
   * 0-based indexes of scan pages with an OCR text layer whose values were painted over in the
   * picture (placeholder labels at the values' places); each is exported as an image.
   */
  scanPages: number[];
  /** Placeholders whose fit needed a line shift (informational). */
  shiftedLines: number;
}
