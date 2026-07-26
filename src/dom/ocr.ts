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

/**
 * Pick the bounding boxes of every OCR word that overlaps one of the given
 * character ranges. A word partially covered by a range is fully redacted
 * (over-redaction is safer than leaking half an identifier).
 *
 * Exported for tests.
 */
export function selectRedactionBoxes(
  words: OcrWord[],
  ranges: { start: number; end: number }[],
): { x0: number; y0: number; x1: number; y1: number }[] {
  return words
    .filter((w) => ranges.some((r) => w.start < r.end && w.end > r.start))
    .map((w) => w.bbox);
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
