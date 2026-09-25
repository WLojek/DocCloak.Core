/**
 * OCR support: extract text (with word-level bounding boxes) from images
 * so it can flow through the regular PII detection pipeline, and render a
 * redacted copy of the image with detected entities blacked out.
 *
 * Uses tesseract.js, which runs Tesseract compiled to WebAssembly inside its
 * own Web Worker - the image never leaves the browser. Language data is
 * downloaded once and cached by tesseract.js in IndexedDB.
 *
 * Lives under the @doccloak/core/dom submodule: it needs a canvas. Canvas
 * creation and image decoding are feature-detected so the module also runs in
 * DOM-less contexts (workers, MV3 offscreen/service contexts) that provide
 * OffscreenCanvas and createImageBitmap. Tesseract worker/core/lang asset
 * paths are host-provided via TesseractAssetPaths (core never derives them
 * from import.meta or its own location).
 */

import * as Tesseract from 'tesseract.js';

/** Canvas type used throughout OCR: a DOM canvas or an OffscreenCanvas. */
export type OcrCanvas = HTMLCanvasElement | OffscreenCanvas;

export interface OcrWord {
  text: string;
  /** Character offsets into the reconstructed OCR text */
  start: number;
  end: number;
  /** Pixel bounding box in the OCR'd image's coordinate space */
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

export interface OcrExtraction {
  text: string;
  words: OcrWord[];
}

/**
 * Locations of the self-hosted tesseract.js runtime assets, supplied by the
 * host (web app: `${BASE_URL}tesseract/...` copied by scripts/copy-assets.mjs;
 * extension: bundled copies). langPath must be an absolute URL - relative
 * paths are treated as cache keys by the tesseract.js worker, not fetched.
 */
export interface TesseractAssetPaths {
  workerPath: string;
  corePath: string;
  langPath: string;
}

/** Images above this dimension are downscaled before OCR to bound memory use on mobile */
const MAX_IMAGE_DIMENSION = 2560;

const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|bmp|gif)$/i;

/** Map DocCloak UI languages to Tesseract traineddata codes */
const UI_LANG_TO_TESSERACT: Record<string, string> = {
  en: 'eng',
  pl: 'pol',
  de: 'deu',
  fr: 'fra',
  es: 'spa',
  pt: 'por',
  sv: 'swe',
  no: 'nor',
};

export function isImageFile(fileName: string): boolean {
  return IMAGE_EXTENSIONS.test(fileName);
}

function buildLangList(uiLanguage: string): string[] {
  const mapped = UI_LANG_TO_TESSERACT[uiLanguage];
  if (mapped && mapped !== 'eng') return [mapped, 'eng'];
  return ['eng'];
}

/**
 * Create a 2D-drawable canvas in whatever context we run in:
 * a DOM canvas when `document` exists, an OffscreenCanvas otherwise
 * (workers, MV3 offscreen/service contexts).
 */
function createCompatibleCanvas(width: number, height: number): OcrCanvas {
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width, height);
  }
  throw new Error('No canvas implementation available (need document or OffscreenCanvas)');
}

function get2dContext(canvas: OcrCanvas): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  const ctx = (canvas as HTMLCanvasElement).getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  return ctx as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
}

/**
 * Decode an image file into a canvas, downscaling if it exceeds
 * MAX_IMAGE_DIMENSION. All OCR bounding boxes are relative to the returned
 * canvas, so redaction is drawn on the same coordinate space.
 *
 * Decoding is feature-detected: createImageBitmap where available (all
 * workers, modern DOM), an HTMLImageElement as the DOM-only fallback.
 */
export async function loadImageToCanvas(file: Blob): Promise<OcrCanvas> {
  let width: number;
  let height: number;
  let source: CanvasImageSource;

  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file);
    width = bitmap.width;
    height = bitmap.height;
    source = bitmap;
  } else {
    source = await decodeViaImageElement(file);
    width = (source as HTMLImageElement).naturalWidth;
    height = (source as HTMLImageElement).naturalHeight;
  }

  const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(width, height));
  const canvas = createCompatibleCanvas(
    Math.max(1, Math.round(width * scale)),
    Math.max(1, Math.round(height * scale)),
  );

  const ctx = get2dContext(canvas);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);

  if (typeof (source as ImageBitmap).close === 'function') {
    (source as ImageBitmap).close();
  }
  return canvas;
}

function decodeViaImageElement(file: Blob): Promise<HTMLImageElement> {
  if (typeof Image === 'undefined') {
    return Promise.reject(new Error('No image decoder available (need createImageBitmap or Image)'));
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to decode image'));
    };
    img.src = url;
  });
}

/**
 * Run OCR on a canvas. Returns the extracted text plus per-word character
 * offsets and pixel bounding boxes. `assets` locates the self-hosted
 * tesseract.js worker/core/language files (host-provided; see
 * TesseractAssetPaths). onProgress receives 0..1 during the recognition phase.
 */
export async function recognizeCanvas(
  canvas: OcrCanvas,
  uiLanguage: string,
  assets: TesseractAssetPaths,
  onProgress?: (progress: number) => void,
): Promise<OcrExtraction> {
  onProgress?.(0);
  const worker = await Tesseract.createWorker(
    buildLangList(uiLanguage),
    1, // OEM.LSTM_ONLY
    {
      workerPath: assets.workerPath,
      corePath: assets.corePath,
      langPath: assets.langPath,
      logger: (m) => {
        if (m.status === 'recognizing text' && typeof m.progress === 'number') {
          onProgress?.(m.progress);
        }
      },
    },
  );

  try {
    const { data } = await worker.recognize(canvas, {}, { blocks: true, text: true });
    onProgress?.(1);
    return buildTextFromBlocks(data.blocks ?? []);
  } finally {
    await worker.terminate();
  }
}

interface BlockLike {
  paragraphs: {
    lines: {
      words: { text: string; bbox: { x0: number; y0: number; x1: number; y1: number } }[];
    }[];
  }[];
}

/**
 * Reconstruct plain text from Tesseract's block hierarchy while recording
 * each word's character range. The reconstruction (not Tesseract's own
 * `data.text`) is used as the detection input, so entity offsets always map
 * back to word bounding boxes exactly.
 *
 * Exported for tests.
 */
export function buildTextFromBlocks(blocks: BlockLike[]): OcrExtraction {
  const words: OcrWord[] = [];
  let text = '';

  for (const block of blocks) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        let lineHasWords = false;
        for (const word of line.words ?? []) {
          const value = word.text?.trim();
          if (!value) continue;
          if (lineHasWords) text += ' ';
          const start = text.length;
          text += value;
          words.push({ text: value, start, end: text.length, bbox: word.bbox });
          lineHasWords = true;
        }
        if (lineHasWords) text += '\n';
      }
    }
    if (text.length > 0 && !text.endsWith('\n\n')) text += '\n';
  }

  return { text: text.trimEnd(), words };
}

type PixelBox = { x0: number; y0: number; x1: number; y1: number };

/** Share of the smaller box height two boxes must overlap to sit on one line. */
const SAME_LINE_OVERLAP = 0.5;

/**
 * A gap at most this share of the line's typical word gap is not a space:
 * OCR split one token there and the lost glyph went into a neighbour's box.
 */
const TIGHT_GAP_SHARE = 0.3;

/** Typical word gap as a share of the line's box height, for lines too short to measure. */
const FALLBACK_GAP_SHARE = 0.4;

/** Lines with fewer measured gaps than this use the height-based fallback. */
const MIN_GAPS_FOR_MEDIAN = 3;

/**
 * Boxes taller than this multiple of the line's median height are OCR noise
 * (a stray mark or a punctuation box spanning lines); they never join, so a
 * split-token fix does not paint a bar across the neighbouring lines.
 */
const MAX_JOIN_HEIGHT_RATIO = 1.6;

/** Whether `right` continues `left` on the same OCR line (adjacent in the text, overlapping vertically). */
function continuesLine(left: OcrWord, right: OcrWord): boolean {
  if (right.start !== left.end + 1) return false;
  const a = left.bbox;
  const b = right.bbox;
  const minHeight = Math.min(a.y1 - a.y0, b.y1 - b.y0);
  if (minHeight <= 0) return false;
  const overlap = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return overlap >= minHeight * SAME_LINE_OVERLAP && b.x1 > a.x1;
}

function median(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * For each pair of consecutive OCR words, whether they are really one token
 * that OCR split by dropping a character. Tesseract reads the dot in
 * "t.zielinski@firma.pl" as a space and returns "t" + "zielinski@firma.pl",
 * with the dot's pixels inside the second box; the e-mail rule then matches
 * only the second word, and without this the "t" would stay visible. Such a
 * split leaves a sliver between the boxes, far narrower than a real space: a
 * pair on the same line is one token when its gap is at most
 * TIGHT_GAP_SHARE of the line's typical word gap (boxes that touch or
 * overlap included). Boxes much taller than the line (MAX_JOIN_HEIGHT_RATIO)
 * are OCR noise and never join, so the fix cannot paint a bar across
 * neighbouring lines.
 *
 * Not covered: a lost glyph that stays in a normal-width gap (seen only on
 * low-resolution images, around 120 dpi). Telling it from a glyph edge that
 * Tesseract cut off its own box needs pixels and misfired on real scans
 * ("w terminie", "nr wpisu"), so gap width alone decides.
 *
 * Returns an array of length words.length - 1: entry i joins words i and i+1.
 * Exported for tests.
 */
export function findSplitTokens(words: OcrWord[]): boolean[] {
  const joined = new Array<boolean>(Math.max(0, words.length - 1)).fill(false);
  const height = (w: OcrWord) => w.bbox.y1 - w.bbox.y0;
  let i = 0;
  while (i < words.length - 1) {
    if (!continuesLine(words[i], words[i + 1])) { i++; continue; }
    let end = i + 1; // the line runs from word i to word end
    while (end < words.length - 1 && continuesLine(words[end], words[end + 1])) end++;
    const gaps: number[] = [];
    for (let k = i; k < end; k++) gaps.push(words[k + 1].bbox.x0 - words[k].bbox.x1);
    const lineHeight = median(words.slice(i, end + 1).map(height));
    const typicalGap = gaps.length >= MIN_GAPS_FOR_MEDIAN ? median(gaps) : lineHeight * FALLBACK_GAP_SHARE;
    const tightGap = Math.max(1, typicalGap * TIGHT_GAP_SHARE);
    const maxHeight = lineHeight * MAX_JOIN_HEIGHT_RATIO;
    for (let k = i; k < end; k++) {
      joined[k] = gaps[k - i] <= tightGap
        && height(words[k]) <= maxHeight
        && height(words[k + 1]) <= maxHeight;
    }
    i = end;
  }
  return joined;
}

/**
 * Pick the bounding boxes of every OCR word that overlaps one of the given
 * character ranges. A word partially covered by a range is fully redacted
 * (over-redaction is safer than leaking half an identifier). A selected
 * word also pulls in the same-line neighbours OCR split off by dropping a
 * character (findSplitTokens), so "t" + "zielinski@firma.pl" is redacted
 * as one token.
 *
 * Exported for tests.
 */
export function selectRedactionBoxes(
  words: OcrWord[],
  ranges: { start: number; end: number }[],
): PixelBox[] {
  const selected = words.map((w) => ranges.some((r) => w.start < r.end && w.end > r.start));
  if (selected.some(Boolean)) {
    const joined = findSplitTokens(words);
    // Spread each selection across its split pieces, left to right then back.
    for (let i = 0; i < joined.length; i++) if (joined[i] && selected[i]) selected[i + 1] = true;
    for (let i = joined.length - 1; i >= 0; i--) if (joined[i] && selected[i + 1]) selected[i] = true;
  }
  return words.filter((_, i) => selected[i]).map((w) => w.bbox);
}

/** Encode a canvas as a PNG blob, whichever canvas flavor it is. */
function canvasToPngBlob(canvas: OcrCanvas): Promise<Blob> {
  if ('convertToBlob' in canvas) {
    return canvas.convertToBlob({ type: 'image/png' });
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Failed to encode redacted image'));
    }, 'image/png');
  });
}

/**
 * Draw black boxes over the given character ranges and return the redacted
 * image as a PNG blob.
 */
export function renderRedactedImage(
  sourceCanvas: OcrCanvas,
  words: OcrWord[],
  ranges: { start: number; end: number }[],
): Promise<Blob> {
  let canvas: OcrCanvas;
  let ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  try {
    canvas = createCompatibleCanvas(sourceCanvas.width, sourceCanvas.height);
    ctx = get2dContext(canvas);
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }

  ctx.drawImage(sourceCanvas, 0, 0);
  ctx.fillStyle = '#111111';

  const padding = 2;
  for (const box of selectRedactionBoxes(words, ranges)) {
    ctx.fillRect(
      box.x0 - padding,
      box.y0 - padding,
      (box.x1 - box.x0) + padding * 2,
      (box.y1 - box.y0) + padding * 2,
    );
  }

  return canvasToPngBlob(canvas);
}
