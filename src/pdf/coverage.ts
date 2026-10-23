/**
 * @doccloak/core/pdf - text in a scan that its OCR layer does not have (T238).
 *
 * A scan page is redacted through its OCR text layer: what the layer does not
 * hold (a table the OCR could not read, a stamp, a margin note) cannot be
 * found, so it stays in the picture. This module finds such places so the
 * reader can say so. It works on the rendered page: ink is grouped into
 * letter-sized shapes, shapes that no OCR glyph box covers are grouped into
 * lines, and a line of several such shapes is text the layer does not have.
 * Rules, frames, signatures and pictures are larger than letters and never
 * count; single marks (a page number, a tick) are too short to form a line.
 */

import type { GlyphRun } from './types.ts';

/** Pixel box, top-left origin, inclusive start and exclusive end. */
export interface PxBox { x0: number; y0: number; x1: number; y1: number }

/** A line of text-like ink no OCR glyph covers. */
export interface MissingLine extends PxBox {
  /** Letter-sized shapes on the line. */
  shapes: number;
}

/** A pixel is ink when its luminance is below this fraction of the paper's. */
const INK_LUMINANCE = 0.6;
/** Letter-sized: height within these multiples of the page's OCR text size (em, in pixels). */
const SHAPE_MIN_HEIGHT = 0.25;
const SHAPE_MAX_HEIGHT = 1.6;
const SHAPE_MAX_WIDTH = 2.5;
/** A shape counts as covered when this share of its box lies under an OCR glyph box. */
const COVERED_SHARE = 0.3;
/** Shapes join a line when their centres are this close vertically and the gap between them this small (em). */
const LINE_SAME_ROW = 0.45;
const LINE_MAX_GAP = 1.2;
/** A line needs this many shapes and this width (em): a short word, never a lone mark or the tip of a covered word. */
const LINE_MIN_SHAPES = 5;
const LINE_MIN_WIDTH = 2;

/**
 * Lines of text-like ink in `rgba` (width x height, RGBA) that none of
 * `ocrBoxes` covers. `emPx` is the page's typical OCR text size in pixels.
 */
export function findTextWithoutOcr(rgba: Uint8ClampedArray, width: number, height: number, ocrBoxes: PxBox[], emPx: number): MissingLine[] {
  if (!(emPx >= 4) || width <= 0 || height <= 0) return [];
  const n = width * height;
  const paper = paperLuminance(rgba, n);
  const ink = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const lum = 0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2];
    if (lum < paper * INK_LUMINANCE) ink[i] = 1;
  }
  // Coverage: every OCR glyph box, grown by a third of an em (layers sit a little off the print).
  const covered = new Uint8Array(n);
  const grow = Math.round(emPx / 3);
  for (const b of ocrBoxes) {
    const x0 = Math.max(0, Math.floor(b.x0) - grow);
    const x1 = Math.min(width, Math.ceil(b.x1) + grow);
    const y0 = Math.max(0, Math.floor(b.y0) - grow);
    const y1 = Math.min(height, Math.ceil(b.y1) + grow);
    for (let y = y0; y < y1; y++) covered.fill(1, y * width + x0, y * width + x1);
  }
  const shapes = letterShapes(ink, covered, width, height, emPx);
  return groupLines(shapes, emPx);
}

/** Median luminance of a sample of pixels: the paper, on any page that is mostly paper. */
function paperLuminance(rgba: Uint8ClampedArray, n: number): number {
  const sample: number[] = [];
  const step = Math.max(1, Math.floor(n / 20000));
  for (let i = 0; i < n; i += step) sample.push(0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2]);
  sample.sort((a, b) => a - b);
  return sample[sample.length >> 1] || 255;
}

interface Shape extends PxBox { cx: number; cy: number }

/** Connected ink components (4-neighbour) that are letter-sized and not covered by the OCR layer. */
function letterShapes(ink: Uint8Array, covered: Uint8Array, width: number, height: number, emPx: number): Shape[] {
  const label = new Int32Array(width * height);
  const out: Shape[] = [];
  const stack: number[] = [];
  let next = 0;
  for (let start = 0; start < ink.length; start++) {
    if (!ink[start] || label[start]) continue;
    next++;
    label[start] = next;
    stack.push(start);
    let x0 = width, y0 = height, x1 = 0, y1 = 0, count = 0, under = 0;
    while (stack.length > 0) {
      const p = stack.pop()!;
      const x = p % width;
      const y = (p - x) / width;
      count++;
      if (covered[p]) under++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0 && ink[p - 1] && !label[p - 1]) { label[p - 1] = next; stack.push(p - 1); }
      if (x < width - 1 && ink[p + 1] && !label[p + 1]) { label[p + 1] = next; stack.push(p + 1); }
      if (y > 0 && ink[p - width] && !label[p - width]) { label[p - width] = next; stack.push(p - width); }
      if (y < height - 1 && ink[p + width] && !label[p + width]) { label[p + width] = next; stack.push(p + width); }
    }
    const h = y1 - y0 + 1;
    const w = x1 - x0 + 1;
    if (h < SHAPE_MIN_HEIGHT * emPx || h > SHAPE_MAX_HEIGHT * emPx || w > SHAPE_MAX_WIDTH * emPx) continue;
    if (count < 3 || under / count >= COVERED_SHARE) continue;
    out.push({ x0, y0, x1: x1 + 1, y1: y1 + 1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 });
  }
  return out;
}

/** Shapes on one row, each close to the next, as lines; only lines of LINE_MIN_SHAPES or more. */
function groupLines(shapes: Shape[], emPx: number): MissingLine[] {
  const sorted = [...shapes].sort((a, b) => a.cy - b.cy || a.x0 - b.x0);
  const rows: Shape[][] = [];
  for (const s of sorted) {
    const row = rows.find((r) => Math.abs(r[0].cy - s.cy) <= LINE_SAME_ROW * emPx);
    if (row) row.push(s);
    else rows.push([s]);
  }
  const lines: MissingLine[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.x0 - b.x0);
    let run: Shape[] = [];
    const flush = (): void => {
      const x0 = Math.min(...run.map((s) => s.x0));
      const x1 = Math.max(...run.map((s) => s.x1));
      if (run.length >= LINE_MIN_SHAPES && x1 - x0 >= LINE_MIN_WIDTH * emPx) {
        lines.push({ x0, y0: Math.min(...run.map((s) => s.y0)), x1, y1: Math.max(...run.map((s) => s.y1)), shapes: run.length });
      }
      run = [];
    };
    for (const s of row) {
      if (run.length > 0 && s.x0 - run[run.length - 1].x1 > LINE_MAX_GAP * emPx) flush();
      run.push(s);
    }
    flush();
  }
  return lines;
}

/**
 * Pixel boxes of every OCR glyph on `page` (runs marked `ocr`; with `allText`, every glyph of the
 * page's text layer), from 0.3 em below the baseline to 0.9 em above it, through the render
 * transform [a b c d e f]; and the median glyph size in pixels (the page's text size, the scale
 * every rule above is measured in).
 */
export function ocrGlyphBoxes(runs: GlyphRun[], page: number, transform: number[], allText = false): { boxes: PxBox[]; chars: string[]; emPx: number } {
  const [a, b, c, d, e, f] = transform;
  const scale = Math.hypot(a, b) || 1;
  const boxes: PxBox[] = [];
  const chars: string[] = [];
  const sizes: number[] = [];
  for (const run of runs) {
    if (run.page !== page || run.space || (!allText && !run.ocr)) continue;
    const exLen = Math.hypot(run.emX[0], run.emX[1]) || 1;
    const eyLen = Math.hypot(run.emY[0], run.emY[1]) || 1;
    const ux = run.emX[0] / exLen;
    const uy = run.emX[1] / exLen;
    const vx = run.emY[0] / eyLen;
    const vy = run.emY[1] / eyLen;
    const k = exLen / (run.local.fontSize * run.local.hscale || 1);
    for (const g of run.glyphs) {
      if (g.unicode.trim() === '') continue;
      const w = g.advance * k;
      const xs: number[] = [];
      const ys: number[] = [];
      for (const [along, up] of [[0, -0.3], [w, -0.3], [w, 0.9], [0, 0.9]]) {
        const x = g.x + ux * along + vx * up * g.fontSize;
        const y = g.y + uy * along + vy * up * g.fontSize;
        xs.push(a * x + c * y + e);
        ys.push(b * x + d * y + f);
      }
      boxes.push({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) });
      chars.push(g.unicode);
      sizes.push(g.fontSize * scale);
    }
  }
  sizes.sort((p, q) => p - q);
  return { boxes, chars, emPx: sizes[sizes.length >> 1] ?? 0 };
}
