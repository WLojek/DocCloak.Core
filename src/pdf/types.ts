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
  /** True when the run is not visible (render mode 3/7, or fully outside the page). */
  hidden: boolean;
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
}

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
  /** Rasterize pages whose text cannot be edited safely instead of refusing the file. Default true. */
  rasterizeUnsafePages?: boolean;
  /** DPI for rasterized pages. Default 150. */
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
  /** 0-based indexes of pages that were rasterized. */
  rasterizedPages: number[];
  /** Placeholders whose fit needed a line shift (informational). */
  shiftedLines: number;
}
