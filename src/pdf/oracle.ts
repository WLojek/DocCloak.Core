/**
 * @doccloak/core/pdf - pdf.js oracle (T212).
 *
 * pdf.js is the INDEPENDENT second extractor. It never edits anything; it is
 * used (1) before a page is touched, to confirm that our own decoder read the
 * same text pdf.js reads, (2) after writing, to verify that no redacted value
 * is extractable from the output, and (3) to render pages for the rasterize
 * fallback (see raster.ts).
 *
 * Runtime configuration:
 * - The legacy build (`pdfjs-dist/legacy/build/pdf.mjs`) is imported lazily in
 *   every environment: it carries the Node factories (fs-backed asset fetch,
 *   `@napi-rs/canvas` canvas factory) as well as the browser ones and is the
 *   build the package's typings describe. It is loaded on first use so hosts
 *   that never open a PDF never pay for it.
 * - Node: no worker; pdf.js runs its "fake worker" on the calling thread.
 *   `cMapUrl` / `standardFontDataUrl` are file-system paths (or file: URLs).
 * - Browsers: the host serves the worker file and passes its URL through
 *   `PdfAssetPaths.pdfjsWorkerUrl`; it is applied to
 *   `GlobalWorkerOptions.workerSrc` once. Without it pdf.js throws
 *   'No "GlobalWorkerOptions.workerSrc" specified.' in a browser.
 * - Fonts are never taken from the system (`useSystemFonts: false`). pdf.js 6
 *   no longer has an eval-based PostScript compiler (`isEvalSupported` is gone).
 * - `disableFontFace` is true wherever there is no `document` (Node, Web
 *   Workers): glyphs are then drawn as paths, which also makes rendering
 *   deterministic across hosts.
 */

import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { UnsupportedDocumentError } from '../dom/errors.ts';
import type { PdfAssetPaths } from './types.ts';

type PdfJsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

/** A 2D context as far as the raster code and pdf.js need it. */
export type Canvas2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** A canvas created by a {@link CanvasFactory}: pdf.js draws on `context`, the raster code reads the result back. */
export interface CanvasHandle {
  /** The canvas object itself (HTMLCanvasElement, OffscreenCanvas, @napi-rs/canvas Canvas, or a test double). pdf.js calls `getContext('2d')` on it. */
  canvas: unknown;
  /** The 2D context of `canvas`. */
  context: Canvas2D;
  /** Encode the current pixels as PNG. */
  toPng(): Promise<Uint8Array>;
  /** RGBA pixels of the whole canvas, row-major, 4 bytes per pixel. */
  getImageData(): Uint8ClampedArray;
}

/**
 * Creates canvases for pdf.js. The default implementation uses OffscreenCanvas
 * (browsers, main thread or worker) and falls back to a DOM canvas; Node
 * hosts and tests inject their own (e.g. one built on `@napi-rs/canvas`).
 * pdf.js also asks the factory for temporary canvases (patterns, transparency
 * groups, smoothed images), so `create` may be called several times per page.
 */
export interface CanvasFactory {
  create(width: number, height: number): CanvasHandle;
}

/** Result of {@link OracleDocument.render}. */
export interface RenderedPage {
  /** Canvas pixel size (the viewport size rounded up). */
  widthPx: number;
  heightPx: number;
  /** Page size in points as displayed, i.e. the CropBox with /Rotate applied (swapped for 90/270). */
  widthPt: number;
  heightPt: number;
  /** pdf.js `viewport.transform` [a b c d e f]: maps PDF user space to canvas pixels (includes the y flip, scale and /Rotate). */
  transform: number[];
  /** The canvas pdf.js drew on; still open for further drawing (the raster fallback paints its black boxes here). */
  canvas: CanvasHandle;
}

/** One pdf.js text item with its geometry (see pdf.js TextItem). */
export interface OracleTextItem {
  str: string;
  /** pdf.js bidi direction of the item ('ltr', 'rtl' or 'ttb'); `str` of an 'rtl' item is in visual order. */
  dir?: string;
  /** [a b c d e f]: text-space to user-space; (e, f) is the item origin, hypot(c, d) the font size. */
  transform: number[];
  /** Width and height in user-space units. */
  width: number;
  height: number;
  hasEOL: boolean;
  fontName: string;
}

export interface OracleDocument {
  pageCount: number;
  /** Raw pdf.js text items of the page joined in order, with '\n' appended after items flagged `hasEOL`. No normalisation: compare through {@link normalizeForCompare}. */
  pageText(index: number): Promise<string>;
  /** The pdf.js text items of the page with geometry (for raster-only pages). */
  pageItems(index: number): Promise<OracleTextItem[]>;
  /** Unrotated page box in points (pdf.js `view`, i.e. the CropBox clipped to the MediaBox) and the normalised /Rotate (0, 90, 180, 270). */
  pageSize(index: number): Promise<{ width: number; height: number; rotate: number }>;
  /** Render the page at `scale` (1 = 72 dpi) with /Rotate applied, annotations excluded. */
  render(index: number, scale: number, canvasFactory?: CanvasFactory): Promise<RenderedPage>;
  close(): Promise<void>;
}

/** Deadline for one pdf.js page operation (text, render). */
export const ORACLE_DEADLINE_MS = 60_000;

let pdfjsPromise: Promise<PdfJsModule> | undefined;

function loadPdfJs(): Promise<PdfJsModule> {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

function errorName(err: unknown): string {
  return typeof err === 'object' && err !== null ? String((err as { name?: unknown }).name ?? '') : '';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Shape pdf.js expects from the `CanvasFactory` option (see BaseCanvasFactory in pdf.js). */
interface PdfJsCanvasAndContext {
  canvas: { width: number; height: number } | null;
  context: unknown;
}

/**
 * pdf.js takes the canvas factory as a class at getDocument() time, while we
 * receive it per render() call. This bridge is handed to pdf.js and forwards
 * to whichever factory the current render uses.
 */
class FactorySlot {
  current: CanvasFactory | undefined;

  bridgeClass(): new (options: unknown) => object {
    const slot = this;
    return class OracleCanvasFactory {
      constructor(_options: unknown) {}
      create(width: number, height: number): PdfJsCanvasAndContext {
        if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
        const factory = slot.current ?? defaultCanvasFactory();
        const handle = factory.create(Math.ceil(width), Math.ceil(height));
        return { canvas: handle.canvas as PdfJsCanvasAndContext['canvas'], context: handle.context };
      }
      reset(pair: PdfJsCanvasAndContext, width: number, height: number): void {
        if (!pair.canvas) throw new Error('Canvas is not specified');
        if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
        pair.canvas.width = Math.ceil(width);
        pair.canvas.height = Math.ceil(height);
      }
      destroy(pair: PdfJsCanvasAndContext): void {
        if (!pair.canvas) throw new Error('Canvas is not specified');
        pair.canvas.width = 0;
        pair.canvas.height = 0;
        pair.canvas = null;
        pair.context = null;
      }
    };
  }
}

/**
 * Browser default: OffscreenCanvas when available (works in Web Workers and
 * on the main thread), else an HTMLCanvasElement. Node has neither: inject a
 * factory (tests use a recording double; hosts can wrap `@napi-rs/canvas`).
 */
export function defaultCanvasFactory(): CanvasFactory {
  const g = globalThis as { OffscreenCanvas?: typeof OffscreenCanvas; document?: Document };
  if (typeof g.OffscreenCanvas === 'function') {
    const Offscreen = g.OffscreenCanvas;
    return {
      create(width, height) {
        const canvas = new Offscreen(width, height);
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('OffscreenCanvas 2D context unavailable');
        return {
          canvas,
          context,
          async toPng() {
            const blob = await canvas.convertToBlob({ type: 'image/png' });
            return new Uint8Array(await blob.arrayBuffer());
          },
          getImageData() {
            return context.getImageData(0, 0, canvas.width, canvas.height).data;
          },
        };
      },
    };
  }
  if (g.document && typeof g.document.createElement === 'function') {
    const document = g.document;
    return {
      create(width, height) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('Canvas 2D context unavailable');
        return {
          canvas,
          context,
          toPng() {
            return new Promise<Uint8Array>((resolve, reject) => {
              canvas.toBlob((blob) => {
                if (!blob) {
                  reject(new Error('canvas.toBlob returned null'));
                  return;
                }
                blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject);
              }, 'image/png');
            });
          },
          getImageData() {
            return context.getImageData(0, 0, canvas.width, canvas.height).data;
          },
        };
      },
    };
  }
  throw new Error('No canvas implementation available in this runtime: pass a canvasFactory');
}

/**
 * Open `bytes` with pdf.js. The buffer is copied because pdf.js transfers
 * (and thereby neuters) the ArrayBuffer it is given. Password-protected files
 * without the right password raise UnsupportedDocumentError('encrypted');
 * files pdf.js cannot parse at all raise 'invalid-package'.
 */
export async function openWithOracle(bytes: Uint8Array, assets?: PdfAssetPaths, password?: string): Promise<OracleDocument> {
  const pdfjs = await loadPdfJs();
  if (assets?.pdfjsWorkerUrl && pdfjs.GlobalWorkerOptions.workerSrc !== assets.pdfjsWorkerUrl) {
    pdfjs.GlobalWorkerOptions.workerSrc = assets.pdfjsWorkerUrl;
  }

  const slot = new FactorySlot();
  const data = new Uint8Array(bytes.byteLength);
  data.set(bytes);

  const task = pdfjs.getDocument({
    data,
    password,
    cMapUrl: assets?.cMapUrl,
    cMapPacked: true,
    standardFontDataUrl: assets?.standardFontDataUrl,
    wasmUrl: assets?.wasmUrl,
    useSystemFonts: false,
    // Never register the document's fonts with the browser's FontFace API: text extraction does
    // not need it and every registration is a worker round trip per font (a 100-font file took
    // ten times longer in a browser than in Node); the raster renders glyph outlines itself.
    disableFontFace: true,
    stopAtErrors: false,
    verbosity: 0,
    useWorkerFetch: false,
    CanvasFactory: slot.bridgeClass(),
  });

  let doc: PDFDocumentProxy;
  try {
    doc = await task.promise;
  } catch (err) {
    await task.destroy().catch(() => undefined);
    const name = errorName(err);
    if (name === 'PasswordException') {
      throw new UnsupportedDocumentError('encrypted', 'PDF is encrypted; a valid user password is required', [errorMessage(err)]);
    }
    if (name === 'InvalidPDFException') {
      throw new UnsupportedDocumentError('invalid-package', 'pdf.js cannot parse this PDF', [errorMessage(err)]);
    }
    // Anything else pdf.js raises while opening (unsupported encryption, broken xref, a worker
    // error) is a document we cannot handle, never an internal failure.
    const message = errorMessage(err);
    if (/encrypt|password/i.test(message)) throw new UnsupportedDocumentError('encrypted', 'PDF uses an encryption pdf.js cannot open', [message]);
    throw new UnsupportedDocumentError('invalid-package', `pdf.js cannot open this PDF: ${message}`, [message]);
  }

  /**
   * pdf.js can be made to work forever by a hostile content stream (a hundred thousand nested
   * `q`, an exponential chain of form XObjects): every page operation gets a deadline, after which
   * the worker is torn down and the caller sees an error (a page issue, or a refusal).
   */
  const deadline = <T>(what: string, work: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        void task.destroy().catch(() => undefined);
        reject(new Error(`pdf.js did not finish ${what} within ${ORACLE_DEADLINE_MS / 1000} s`));
      }, ORACLE_DEADLINE_MS);
    });
    return Promise.race([work, timeout]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
  };

  const getPage = async (index: number): Promise<PDFPageProxy> => {
    if (!Number.isInteger(index) || index < 0 || index >= doc.numPages) {
      throw new RangeError(`page index ${index} out of range (0..${doc.numPages - 1})`);
    }
    return doc.getPage(index + 1);
  };

  return {
    pageCount: doc.numPages,

    async pageText(index) {
      const page = await deadline(`loading page ${index + 1}`, getPage(index));
      const content = await deadline(`reading page ${index + 1}`, page.getTextContent({ includeMarkedContent: false, disableNormalization: true }));
      let out = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        out += item.str;
        if (item.hasEOL) out += '\n';
      }
      return out;
    },

    async pageItems(index) {
      const page = await deadline(`loading page ${index + 1}`, getPage(index));
      const content = await deadline(`reading page ${index + 1}`, page.getTextContent({ includeMarkedContent: false, disableNormalization: true }));
      const out: OracleTextItem[] = [];
      for (const item of content.items) {
        if (!('str' in item)) continue;
        out.push({ str: item.str, transform: item.transform, width: item.width, height: item.height, hasEOL: item.hasEOL, fontName: item.fontName, dir: item.dir });
      }
      return out;
    },

    async pageSize(index) {
      const page = await getPage(index);
      const [x0, y0, x1, y1] = page.view;
      return { width: Math.abs(x1 - x0), height: Math.abs(y1 - y0), rotate: page.rotate };
    },

    async render(index, scale, canvasFactory) {
      if (!(scale > 0) || !Number.isFinite(scale)) throw new RangeError(`invalid render scale ${scale}`);
      const page = await deadline(`loading page ${index + 1}`, getPage(index));
      const viewport = page.getViewport({ scale });
      const widthPx = Math.ceil(viewport.width);
      const heightPx = Math.ceil(viewport.height);
      const factory = canvasFactory ?? defaultCanvasFactory();
      slot.current = factory;
      try {
        const handle = factory.create(widthPx, heightPx);
        const renderTask = page.render({
          canvas: (handle.canvas ?? null) as HTMLCanvasElement | null,
          canvasContext: handle.context as CanvasRenderingContext2D,
          viewport,
          intent: 'print',
          annotationMode: pdfjs.AnnotationMode.DISABLE,
          background: 'rgb(255,255,255)',
        });
        await deadline(`rendering page ${index + 1}`, renderTask.promise);
        return {
          widthPx,
          heightPx,
          widthPt: viewport.width / scale,
          heightPt: viewport.height / scale,
          transform: Array.from(viewport.transform),
          canvas: handle,
        };
      } finally {
        slot.current = undefined;
      }
    },

    async close() {
      await task.destroy();
    },
  };
}

/** Text of every page, in page order (see {@link OracleDocument.pageText}). */
export async function oracleText(doc: OracleDocument): Promise<string[]> {
  const pages: string[] = [];
  for (let i = 0; i < doc.pageCount; i++) pages.push(await doc.pageText(i));
  return pages;
}

const LIGATURES: Record<string, string> = {
  'ﬀ': 'ff',
  'ﬁ': 'fi',
  'ﬂ': 'fl',
  'ﬃ': 'ffi',
  'ﬄ': 'ffl',
  'ﬅ': 'st',
  'ﬆ': 'st',
};

/**
 * Whitespace (JS `\s` is Unicode White_Space minus U+0085), the soft hyphen,
 * zero-width characters and bidi controls, all of which one extractor may emit
 * and another drop.
 */
const DROP_RE = /[\s\u0085­᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/gu;

/**
 * Bring two extractors' output onto common ground: NFC, typographic
 * ligatures spelled out, and every whitespace / soft-hyphen / zero-width
 * character removed. Case and punctuation are kept.
 */
export function normalizeForCompare(text: string): string {
  return foldGlyphText(text.normalize('NFC')).replace(DROP_RE, '');
}

/**
 * Kangxi radicals, CJK radicals supplement and CJK compatibility ideographs: some ToUnicode
 * maps (Chrome with Hiragino) spell ordinary ideographs with these look-alikes; NFKC turns them
 * into the unified ideograph a detector and a user type.
 */
const COMPAT_CJK_RE = /[\u2E80-\u2EF3\u2F00-\u2FD5\uF900-\uFAFF]/u;

/**
 * The text of a glyph as a detector should see it: typographic ligatures spelled out
 * (ﬁ -> fi) and CJK compatibility forms unified. Applied when glyphs are decoded, so plainText,
 * the oracle comparison and the layer-zero search all agree.
 */
export function foldGlyphText(text: string): string {
  let out = text.replace(/[ﬀ-ﬆ]/g, (m) => LIGATURES[m] ?? m);
  if (COMPAT_CJK_RE.test(out)) out = [...out].map((ch) => (COMPAT_CJK_RE.test(ch) ? ch.normalize('NFKC') : ch)).join('');
  return out;
}

/**
 * The same folding as {@link normalizeForCompare} plus a length-preserving
 * lower-casing, with an offset map back into the input, so a search in the
 * folded text can be turned into a replacement range of the original. Used
 * by the writer's layer zero so that it covers exactly what the verifier
 * would flag (a value wrapped over a line end, spaced differently, or
 * written with a typographic ligature).
 */
export function foldForSearch(text: string): { folded: string; offsets: number[] } {
  let folded = '';
  const offsets: number[] = [];
  const dropRe = new RegExp(DROP_RE.source, 'u');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (dropRe.test(c)) continue;
    // Hyphens are dropped on both sides, so a value broken at a line end ("Kowal-" / "ski") and a
    // value written with or without hyphens ("600-100-200") are found either way.
    if (c === '-' || c === '\u2010' || c === '\u2011') continue;
    const expanded = foldGlyphText(c);
    for (const ch of expanded) {
      const lower = ch.toLowerCase();
      folded += lower.length === 1 ? lower : ch;
      offsets.push(i);
    }
  }
  return { folded, offsets };
}

const WORD_CHAR_RE = /[\p{L}\p{N}]/u;

/**
 * Every occurrence of `value` in `text` as [start, end) ranges of the original text, found in
 * the search fold (whitespace, hyphens and zero-width characters dropped, ligatures spelled
 * out, case folded). A value that begins or ends with a letter or digit must begin or end at a
 * token boundary of the original text ("Nowak" is not found inside "Nowakowski", but is found
 * in "Nowak," and across a line end); a value like "(c)" needs no boundary.
 */
export interface SearchIndex { text: string; folded: string; offsets: number[] }

/** The search fold of a text, reusable across many values (folding a long text once). */
export function searchIndex(text: string): SearchIndex {
  const { folded, offsets } = foldForSearch(text);
  return { text, folded, offsets };
}

export function findOccurrences(source: string | SearchIndex, value: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const needle = foldForSearch(value).folded;
  if (needle.length < 2) return out;
  const index = typeof source === 'string' ? searchIndex(source) : source;
  const { text, folded, offsets } = index;
  const boundStart = WORD_CHAR_RE.test(value.trim().charAt(0));
  const boundEnd = WORD_CHAR_RE.test(value.trim().slice(-1));
  for (let i = folded.indexOf(needle); i >= 0; i = folded.indexOf(needle, i + 1)) {
    const start = offsets[i];
    const end = offsets[i + needle.length - 1] + 1;
    if (boundStart && start > 0 && WORD_CHAR_RE.test(text.charAt(start - 1))) continue;
    if (boundEnd && end < text.length && WORD_CHAR_RE.test(text.charAt(end))) continue;
    out.push([start, end]);
    i += needle.length - 1;
  }
  return out;
}
