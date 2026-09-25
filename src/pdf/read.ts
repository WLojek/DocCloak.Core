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
import type { GlyphRun, PdfAssetPaths, PdfPageInfo, PdfReadOptions, RemovedPart } from './types.ts';
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

export async function readPdf(input: PdfInput, options: PdfReadOptions = {}): Promise<PdfExtraction> {
  const bytes = await toPdfBytes(input);
  // Size cap before anything parses the file (pdf.js would otherwise read all of it first).
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (bytes.length > maxBytes) {
    throw new UnsupportedDocumentError('too-large', `PDF is ${bytes.length} bytes; the limit is ${maxBytes}`, [String(bytes.length)]);
  }
  const oracle = await openWithOracle(bytes, options.assets, options.password);
  try {
    const res = await extractPdf(bytes, {
      maxBytes: options.maxBytes,
      maxPages: options.maxPages,
      maxGlyphs: options.maxGlyphs,
      password: options.password,
      oracle,
    });
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
    };
  } finally {
    await oracle.close();
  }
}

/** True for names ending in .pdf (case-insensitive). */
export function isPdfFile(filename: string): boolean {
  return /\.pdf$/i.test(filename.trim());
}
