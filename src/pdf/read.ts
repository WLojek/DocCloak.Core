/**
 * @doccloak/core/pdf - readPdf (T213/T215).
 *
 * Parses a PDF, extracts its text with glyph geometry, cross-checks every
 * page against pdf.js and returns the extraction hosts run detection on.
 * The extraction keeps the input bytes; the writer re-extracts from them so
 * a stale extraction can never be applied to different bytes.
 */

import { DEFAULT_MAX_BYTES, extractPdf } from './extract.ts';
import { UnsupportedDocumentError } from '../dom/errors.ts';
import { openWithOracle } from './oracle.ts';
import { findTextWithoutOcr, ocrGlyphBoxes } from './coverage.ts';
import type { ExtraOcrPage, ExtraOcrWord, GlyphRun, PdfAssetPaths, PdfPageInfo, PdfReadOptions, RemovedPart } from './types.ts';
import type { OracleDocument } from './oracle.ts';
import type { MissingLine } from './coverage.ts';
import type { UnredactablePart } from '../dom/errors.ts';

export interface PdfExtraction {
  /** Flat text detection runs on. */
  plainText: string;
  pageCount: number;
  pages: PdfPageInfo[];
  /** Glyph runs in flat-text order (internal geometry, exposed for hosts that draw previews). */
  runs: GlyphRun[];
  /** Parts that cannot be redacted (scanned pages, undecodable text); gate the export like docx. */
  unredactable: UnredactablePart[];
  /** Parts the writer will drop from the output. */
  removed: RemovedPart[];
  warnings: string[];
  /** True when no readable text was found. */
  empty: boolean;
  /** 0-based pages whose text came from pdf.js because our decoder disagreed (edits rasterize them). */
  rasterOnlyPages: number[];
  /** Input bytes (the writer's source of truth). */
  bytes: Uint8Array;
  /** Text DocCloak read with its own OCR where a scan's OCR layer had none (the writer re-creates its runs). */
  extraOcr?: ExtraOcrPage[];
  assets?: PdfAssetPaths;
  password?: string;
}

export type PdfInput = Blob | ArrayBuffer | Uint8Array;

export async function toPdfBytes(input: PdfInput): Promise<Uint8Array> {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (typeof (input as Blob).arrayBuffer === 'function') return new Uint8Array(await input.arrayBuffer());
  // Older Blob implementations (jsdom): go through FileReader.
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('could not read the file'));
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.readAsArrayBuffer(input);
  });
}

/** Resolution of the missing-OCR check: letters stay several pixels tall, a page stays cheap. */
const COVERAGE_DPI = 100;

export async function readPdf(input: PdfInput, options: PdfReadOptions = {}): Promise<PdfExtraction> {
  const bytes = await toPdfBytes(input);
  // Size cap before anything parses the file (pdf.js would otherwise read all of it first).
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (bytes.length > maxBytes) {
    throw new UnsupportedDocumentError('too-large', `PDF is ${bytes.length} bytes; the limit is ${maxBytes}`, [String(bytes.length)]);
  }
  const oracle = await openWithOracle(bytes, options.assets, options.password);
  try {
    const extractOptions = { maxBytes: options.maxBytes, maxPages: options.maxPages, maxGlyphs: options.maxGlyphs, password: options.password, oracle };
    let res = await extractPdf(bytes, extractOptions);
    const missing = new Map<number, number>();
    const extraOcr: ExtraOcrPage[] = [];
    const ocrImagePages = options.ocrImagePages !== false && !!options.recognizeText;
    const checkCoverage = options.checkOcrCoverage !== false;
    // Each page by what it holds: a picture without any text layer is read whole; a scan with an OCR
    // layer and a text page with images are checked for text their layer does not have, and that is
    // read. Words a layer already has are never added twice.
    const wholePages = res.pages.filter((p) => p.imageOnly && !p.ocrText && ocrImagePages).map((p) => p.index);
    const checked = res.pages.filter((p) => checkCoverage && (p.ocrText || (p.hasImages && !p.imageOnly))).map((p) => p.index);
    const total = wholePages.length + (options.recognizeText ? checked.length : 0);
    let done = 0;
    const progress = (): void => options.onOcrProgress?.(done, total);
    if (total > 0) progress();
    const wholeRead = new Map<number, number>();
    for (const index of wholePages) {
      try {
        const read = await readText(oracle, res.runs, index, null, 0, options);
        const words = read ? read.lines.reduce((n, l) => n + l.length, 0) : 0;
        wholeRead.set(index, words);
        if (read && words > 0) extraOcr.push({ ...read, whole: true });
      } catch {
        // No canvas in this host, or the host OCR failed: the page stays a picture the card lists.
      }
      done++;
      progress();
    }
    for (const index of checked) {
      const page = res.pages[index];
      try {
        const rendered = await oracle.render(index, COVERAGE_DPI / 72, options.canvasFactory);
        // On a scan the OCR layer is the text; on a text page every glyph of its layer is.
        const allText = !page.ocrText;
        const { boxes, emPx } = ocrGlyphBoxes(res.runs, index, rendered.transform, allText);
        const lines = findTextWithoutOcr(rendered.canvas.getImageData(), rendered.widthPx, rendered.heightPx, boxes, emPx);
        if (lines.length > 0) {
          missing.set(index, lines.length);
          if (options.recognizeText) {
            const read = await readText(oracle, res.runs, index, lines, emPx, options, allText);
            if (read && read.lines.length > 0) extraOcr.push(read);
          }
        }
      } catch {
        // No canvas in this host (Node without a factory), or the host OCR failed: the page keeps
        // what its own layer has.
      }
      if (options.recognizeText) {
        done++;
        progress();
      }
    }
    // Read text joins the pages' text: extract again with it, as the writer will.
    if (extraOcr.length > 0) res = await extractPdf(bytes, { ...extractOptions, extraOcr });
    for (const [index, words] of wholeRead) res.pages[index].ocrWholePage = words;
    for (const [index, count] of missing) {
      const page = res.pages[index];
      page.ocrMissingLines = count;
      const where = page.ocrText ? 'the picture shows text its OCR layer does not have' : 'an image on the page shows text its text layer does not have';
      res.warnings.push(page.ocrReadWords
        ? `page ${index + 1}: ${where} (${count} lines, for example a table); DocCloak read it with its own OCR (${page.ocrReadWords} words), check it before sharing`
        : `page ${index + 1}: ${where} (${count} lines, for example a table or a stamp); it cannot be found or redacted, check it before sharing`);
    }
    for (const [index, words] of wholeRead) {
      if (words > 0) res.warnings.push(`page ${index + 1}: no text layer; DocCloak read the page with its own OCR (${words} words), check it before sharing`);
    }
    // With the host's OCR, the images of the text pages checked above were scanned for text.
    if (options.recognizeText) {
      const scanned = new Set(checked);
      res.warnings = res.warnings.filter((w) => {
        const m = w.match(/^page (\d+): contains images; text inside images is not scanned$/);
        return !(m && scanned.has(Number(m[1]) - 1));
      });
    }
    return {
      plainText: res.plainText,
      pageCount: res.pages.length,
      pages: res.pages,
      runs: res.runs,
      unredactable: res.unredactable,
      removed: res.removed,
      warnings: res.warnings,
      empty: res.empty,
      rasterOnlyPages: res.model.pages.filter((p) => p.oracleText).map((p) => p.index),
      bytes,
      assets: options.assets,
      password: options.password,
      ...(extraOcr.length > 0 ? { extraOcr } : {}),
    };
  } finally {
    await oracle.close();
  }
}

/** Resolution DocCloak's own OCR reads missing text at. */
const READ_DPI = 300;
/** Two readings of a word are the same word at this share of common letters (in order). */
const SAME_WORD = 0.6;

/** Letters and digits of `s`, lower-cased, without diacritics. */
function letters(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** Longest common subsequence of `a` and `b` over the longer length (0..1). */
function similarity(a: string, b: string): number {
  if (!a || !b) return a === b ? 1 : 0;
  const row = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j];
      row[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(row[j], row[j - 1]);
      prev = keep;
    }
  }
  return row[b.length] / Math.max(a.length, b.length);
}

/** Words the OCR is less sure of than this (0..100) do not count towards a page read whole being text: on a picture without text they are noise. */
const MIN_WHOLE_PAGE_CONFIDENCE = 30;
/** A page read whole counts as text when it gives at least this many such words of two or more letters or digits. */
const MIN_WHOLE_PAGE_WORDS = 3;

/**
 * Read text a page's layer does not have with the host's OCR: render the page at READ_DPI, hand
 * over the region around the missing `lines` (grown by an em) or, with `lines` null, the whole page
 * (a picture without any text layer); keep the words that do not lie under the layer's own glyphs
 * (its OCR glyphs, or with `allText` every glyph of a text page), and turn them into glyphs in user
 * space (letters at the boxes the OCR gives, origins on the line's baseline).
 */
async function readText(oracle: OracleDocument, runs: GlyphRun[], pageIndex: number, lines: MissingLine[] | null, emPx: number, options: PdfReadOptions, allText = false): Promise<ExtraOcrPage | null> {
  const k = READ_DPI / COVERAGE_DPI;
  const page = await oracle.render(pageIndex, READ_DPI / 72, options.canvasFactory);
  // The region holds the missing lines and, above and below, the rows next to them: a row whose
  // only OCR text is junk looks covered, so it is never reported missing itself.
  const growX = emPx * k;
  const growY = 2.5 * emPx * k;
  const region = lines === null ? { x0: 0, y0: 0, x1: page.widthPx, y1: page.heightPx } : {
    x0: Math.max(0, Math.floor(Math.min(...lines.map((l) => l.x0)) * k - growX)),
    y0: Math.max(0, Math.floor(Math.min(...lines.map((l) => l.y0)) * k - growY)),
    x1: Math.min(page.widthPx, Math.ceil(Math.max(...lines.map((l) => l.x1)) * k + growX)),
    y1: Math.min(page.heightPx, Math.ceil(Math.max(...lines.map((l) => l.y1)) * k + growY)),
  };
  const read = await options.recognizeText!(page.canvas.canvas, region, READ_DPI);
  if (lines === null) {
    // Confidence decides whether the picture holds text; once it does, every word read is kept:
    // Tesseract is least sure of elided words ("d'avril", "d'actions"), and a word left out can be
    // neither found nor covered.
    const sure = read.reduce((n, l) => n + l.words.filter((w) => (w.confidence ?? 100) >= MIN_WHOLE_PAGE_CONFIDENCE && letters(w.text).length >= 2).length, 0);
    if (sure < MIN_WHOLE_PAGE_WORDS) return null;
  }
  const { boxes, chars } = ocrGlyphBoxes(runs, pageIndex, page.transform, allText);
  // A word the layer already has (its glyphs lie under the word and spell about the same) is not
  // added twice; where the layer holds junk over the word ("[miesiąc | opowiezany ema"), the word
  // DocCloak read is added.
  const alreadyThere = (b: { x0: number; y0: number; x1: number; y1: number }, text: string): boolean => {
    const area = Math.max(1, (b.x1 - b.x0) * (b.y1 - b.y0));
    let under = 0;
    const spelled: Array<[number, string]> = [];
    boxes.forEach((o, i) => {
      const w = Math.min(b.x1, o.x1) - Math.max(b.x0, o.x0);
      const h = Math.min(b.y1, o.y1) - Math.max(b.y0, o.y0);
      if (w > 0 && h > 0) {
        under += w * h;
        const cx = (o.x0 + o.x1) / 2;
        if (cx >= b.x0 && cx <= b.x1) spelled.push([o.x0, chars[i]]);
      }
    });
    if (under / area <= 0.5) return false;
    const layer = spelled.sort((p, q) => p[0] - q[0]).map((x) => x[1]).join('');
    return similarity(letters(text), letters(layer)) >= SAME_WORD;
  };
  // Pixels to user space: the inverse of the render transform [a b c d e f].
  const [a, b, c, d, e, f] = page.transform;
  const det = a * d - b * c;
  const toUser = (px: number, py: number): [number, number] => [(d * (px - e) - c * (py - f)) / det, (a * (py - f) - b * (px - e)) / det];
  const unit = (v: [number, number]): [number, number] => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };
  const [ox, oy] = toUser(0, 0);
  const [rx, ry] = toUser(1, 0);
  const [ux, uy] = toUser(0, -1);
  const dir = unit([rx - ox, ry - oy]);
  const up = unit([ux - ox, uy - oy]);
  const userPerPx = Math.hypot(rx - ox, ry - oy);
  const out: ExtraOcrWord[][] = [];
  for (const line of read) {
    const words: ExtraOcrWord[] = [];
    const baselineAt = (px: number): number => {
      const { x0, y0, x1, y1 } = line.baseline;
      return x1 === x0 ? y0 : y0 + ((px - x0) / (x1 - x0)) * (y1 - y0);
    };
    // The line's text size: its tallest letters (capitals and ascenders reach about 0.72 em) over the baseline.
    const tops = line.words.map((w) => baselineAt(w.bbox.x0) - w.bbox.y0).filter((h) => h > 0).sort((p, q) => p - q);
    const sizePx = tops.length > 0 ? tops[tops.length - 1] / 0.72 : 0;
    if (!(sizePx > 0)) continue;
    for (const w of line.words) {
      const box = { x0: w.bbox.x0 + region.x0, y0: w.bbox.y0 + region.y0, x1: w.bbox.x1 + region.x0, y1: w.bbox.y1 + region.y0 };
      if (alreadyThere(box, w.text)) continue;
      const letters = (w.symbols && w.symbols.length > 0 ? w.symbols : [...w.text].map((ch, i, all) => ({
        text: ch,
        bbox: { x0: w.bbox.x0 + ((w.bbox.x1 - w.bbox.x0) * i) / all.length, y0: w.bbox.y0, x1: w.bbox.x0 + ((w.bbox.x1 - w.bbox.x0) * (i + 1)) / all.length, y1: w.bbox.y1 },
      })));
      const glyphs = letters.map((s, i) => {
        const x0 = s.bbox.x0 + region.x0;
        const nextX = i + 1 < letters.length ? letters[i + 1].bbox.x0 + region.x0 : s.bbox.x1 + region.x0;
        const [x, y] = toUser(x0, baselineAt(s.bbox.x0) + region.y0);
        return { unicode: s.text, x, y, advance: Math.max(0, nextX - x0) * userPerPx };
      });
      words.push({ glyphs, size: sizePx * userPerPx, dir, up });
    }
    if (words.length > 0) out.push(words);
  }
  return { page: pageIndex, lines: out };
}

/** True for names ending in .pdf (case-insensitive). */
export function isPdfFile(filename: string): boolean {
  return /\.pdf$/i.test(filename.trim());
}
