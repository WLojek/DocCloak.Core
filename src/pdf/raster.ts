/**
 * @doccloak/core/pdf - page rasterization fallback (T212).
 *
 * A page whose text cannot be edited safely is rendered to pixels by pdf.js
 * and the redacted rectangles are painted black IN THE PIXELS, on the same
 * canvas, after the render: the PNG never contains what was under a box.
 * The caller (writer) replaces the page contents with this image and
 * reports the page in `rasterizedPages`.
 *
 * Scan pages with an OCR text layer (T235) are rendered the same way at the
 * scan's resolution, but each redacted value is covered in paper colour and
 * its placeholder label is painted in its place, along the baseline and
 * within the value's width (`rasterizeScanPage`).
 */

import type { CanvasFactory, OracleDocument } from './oracle.ts';
import type { Rect } from './types.ts';

export interface RasterizedPage {
  png: Uint8Array;
  widthPx: number;
  heightPx: number;
  /** Displayed page size in points (CropBox with /Rotate applied), the size of a replacement page that shows the PNG unrotated. */
  widthPt: number;
  heightPt: number;
}

export interface RasterizeOptions {
  dpi: number;
  canvasFactory?: CanvasFactory;
}

/** Integer pixel box, top-left origin. */
export interface PixelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Map a user-space rectangle to canvas pixels through the pdf.js viewport
 * transform [a b c d e f] (x' = a*x + c*y + e, y' = b*x + d*y + f). The four
 * corners are transformed (rotation may swap axes) and their bounding box is
 * returned, expanded outwards to whole pixels. No padding is applied here.
 */
export function userRectToPixels(viewportTransform: number[], rect: Rect): PixelBox {
  const [a, b, c, d, e, f] = viewportTransform;
  const xs = [rect.x0, rect.x1, rect.x0, rect.x1];
  const ys = [rect.y0, rect.y0, rect.y1, rect.y1];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < 4; i++) {
    const px = a * xs[i] + c * ys[i] + e;
    const py = b * xs[i] + d * ys[i] + f;
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  // Round to whole pixels outwards; tolerate float noise (1224.0000001 stays 1224).
  const EPS = 1e-6;
  const x = Math.floor(minX + EPS);
  const y = Math.floor(minY + EPS);
  const x1 = Math.ceil(maxX - EPS);
  const y1 = Math.ceil(maxY - EPS);
  return { x, y, w: Math.max(0, x1 - x), h: Math.max(0, y1 - y) };
}

/** Pad a pixel box by `pad` on every side and clamp it to the canvas. Empty when the box lies outside. */
export function padAndClamp(box: PixelBox, pad: number, widthPx: number, heightPx: number): PixelBox {
  const x0 = Math.max(0, box.x - pad);
  const y0 = Math.max(0, box.y - pad);
  const x1 = Math.min(widthPx, box.x + box.w + pad);
  const y1 = Math.min(heightPx, box.y + box.h + pad);
  if (x1 <= x0 || y1 <= y0) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Pixels of padding around every box (covers anti-aliased glyph edges). */
const BOX_PAD_PX = 1;

/**
 * Render page `index` at `options.dpi` (pdf.js applies /Rotate as a viewer
 * would), paint every `boxes` rectangle black on the rendered pixels, and
 * encode the canvas as PNG.
 */
export async function rasterizePage(
  doc: OracleDocument,
  index: number,
  boxes: Rect[],
  options: RasterizeOptions,
): Promise<RasterizedPage> {
  if (!(options.dpi > 0) || !Number.isFinite(options.dpi)) throw new RangeError(`invalid dpi ${options.dpi}`);
  const scale = options.dpi / 72;
  const page = await doc.render(index, scale, options.canvasFactory);
  const ctx = page.canvas.context;

  // pdf.js leaves its own transform / composite state on the context: draw
  // in plain device pixels with an opaque black brush.
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#000000';
  for (const box of boxes) {
    const px = padAndClamp(userRectToPixels(page.transform, box), BOX_PAD_PX, page.widthPx, page.heightPx);
    if (px.w === 0 || px.h === 0) continue;
    ctx.fillRect(px.x, px.y, px.w, px.h);
  }
  ctx.restore();

  const png = await page.canvas.toPng();
  return {
    png,
    widthPx: page.widthPx,
    heightPx: page.heightPx,
    widthPt: page.widthPt,
    heightPt: page.heightPt,
  };
}

/**
 * A value to paint over on a scan page, in user space: the baseline segment
 * the value occupies and the label to show there.
 */
export interface PaintMark {
  /** Baseline point where the value starts. */
  x: number;
  y: number;
  /** Unit vector along the baseline and unit vector "up" (the text's em direction). */
  ux: number;
  uy: number;
  vx: number;
  vy: number;
  /** Length of the value along the baseline, user units. */
  length: number;
  /** Font size of the value's text, user units. */
  size: number;
  /** Placeholder to show; '' only covers (the rest of a value wrapped onto the next line). */
  label: string;
}

/** A rendered scan page: raw pixels, 1 (gray) or 3 (RGB) bytes each, row-major. */
export interface ScanRaster {
  pixels: Uint8Array;
  channels: 1 | 3;
  widthPx: number;
  heightPx: number;
  widthPt: number;
  heightPt: number;
}

/**
 * Cover extent around a value, in em of its font size: along the baseline, and below and above
 * it when the picture shows no ink to measure. The OCR layer's font size is only a hint (layers
 * often stretch it to the line height), so the cover's height and the label's size come from
 * the ink itself (see inkRows), within INK_REACH_BELOW / INK_REACH_ABOVE of the baseline; the
 * cover always holds the core band COVER_CORE_BELOW..COVER_CORE_ABOVE.
 */
const COVER_PAD_ALONG = 0.12;
const COVER_BELOW = 0.32;
const COVER_ABOVE = 0.92;
const COVER_CORE_BELOW = 0.15;
const COVER_CORE_ABOVE = 0.6;
const INK_REACH_BELOW = 0.45;
const INK_REACH_ABOVE = 1.1;
/**
 * OCR layers place words well but size letters from their own font, so a value's ink can run
 * past the layer's ends, by a share of the value's length (a layer 15 % narrower than the print
 * ends 2 em short of a 13 em e-mail address). A cover grows along the baseline to the end of the
 * ink it touches: the search starts this far inside the value, stops at a blank gap of WORD_GAP
 * (a word space is about 0.28 em, gaps between letters stay under about 0.12 em) and never grows
 * by more than MAX_GROWTH em or MAX_GROWTH_SHARE of the value's length, whichever is more; ink is
 * looked for in the band of the letters' bodies only, so the lines above and below do not count.
 * In em of the value's font size unless said otherwise.
 */
const INK_SEARCH_INSIDE = 0.25;
const WORD_GAP = 0.16;
const MAX_GROWTH = 1;
const MAX_GROWTH_SHARE = 0.35;
const INK_BAND_BELOW = 0.12;
const INK_BAND_ABOVE = 0.68;
/** A pixel is ink when its luminance is below this fraction of the paper's. */
const INK_LUMINANCE = 0.65;
/**
 * Label size: the value's ink height (capitals and ascenders reach about 0.72 em) gives the
 * label's em; without ink the OCR font size does, times LABEL_SIZE. The label is squeezed
 * horizontally down to LABEL_MIN_SQUEEZE to fit the value's width, then shrunk.
 */
const INK_TOP_EM = 0.76;
const LABEL_SIZE = 0.8;
const LABEL_MIN_SQUEEZE = 0.6;
const LABEL_FONT = '"Liberation Sans", Arial, Helvetica, sans-serif';

/** Where one mark is painted, in its own baseline frame (user units): along [start, end], up [bottom, top]. */
interface Cover {
  mark: PaintMark;
  at: (along: number, up: number) => [number, number];
  start: number;
  end: number;
  bottom: number;
  top: number;
  /** Measured ink height above the baseline, or null when no ink was found. */
  inkTop: number | null;
  paper: [number, number, number];
  /** Gray level of the value's ink (the label is painted in it, so it reads like the scan's print), or null. */
  ink: number | null;
}

/**
 * Render page `index` at `options.dpi`, cover every mark in the paper colour
 * around it and paint its label in the value's place: the baseline the OCR
 * layer gives, the value's width (the label is squeezed, then shrunk, to fit;
 * a shorter label leaves the rest of the width blank). Every cover is painted
 * before any label, so a cover on the next line never clips a label above it.
 * Returns the pixels, in gray when the page is gray (a scan usually is), so
 * the writer can embed them losslessly at a size close to the original scan.
 */
export async function rasterizeScanPage(
  doc: OracleDocument,
  index: number,
  marks: PaintMark[],
  options: RasterizeOptions,
): Promise<ScanRaster> {
  if (!(options.dpi > 0) || !Number.isFinite(options.dpi)) throw new RangeError(`invalid dpi ${options.dpi}`);
  const page = await doc.render(index, options.dpi / 72, options.canvasFactory);
  const ctx = page.canvas.context;
  const before = page.canvas.getImageData();
  const [a, b, c, d, e, f] = page.transform;
  const toPx = (x: number, y: number): [number, number] => [a * x + c * y + e, b * x + d * y + f];

  // Measure every cover on the untouched pixels first.
  const covers: Cover[] = marks.map((m) => {
    const at = (along: number, up: number): [number, number] =>
      toPx(m.x + m.ux * along + m.vx * up, m.y + m.uy * along + m.vy * up);
    const pad = COVER_PAD_ALONG * m.size;
    const paper = paperColour(before, page.widthPx, page.heightPx, quadOf(at, -pad, m.length + pad, -COVER_BELOW * m.size, COVER_ABOVE * m.size));
    const inkBelow = luminance(paper) * INK_LUMINANCE;
    const along = inkExtent(before, page.widthPx, page.heightPx, at, m, inkBelow);
    const start = Math.min(0, along.start) - pad;
    const end = Math.max(m.length, along.end) + pad;
    const rows = inkRows(before, page.widthPx, page.heightPx, at, m, start, end, inkBelow);
    const onePx = 1 / (Math.hypot(...sub(at(0, 1), at(0, 0))) || 1);
    const bottom = rows ? Math.min(-COVER_CORE_BELOW * m.size, rows.bottom - 1.5 * onePx) : -COVER_BELOW * m.size;
    const top = rows ? Math.max(COVER_CORE_ABOVE * m.size, rows.top + 1.5 * onePx) : COVER_ABOVE * m.size;
    const ink = rows ? inkColour(before, page.widthPx, page.heightPx, at, start, end, rows.bottom, rows.top, inkBelow) : null;
    return { mark: m, at, start, end, bottom, top, inkTop: rows ? rows.top : null, paper, ink };
  });

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  for (const cv of covers) {
    const quad = quadOf(cv.at, cv.start, cv.end, cv.bottom, cv.top);
    const fill = `rgb(${cv.paper[0]}, ${cv.paper[1]}, ${cv.paper[2]})`;
    ctx.fillStyle = fill;
    ctx.strokeStyle = fill;
    ctx.lineWidth = 2; // the stroke grows the cover by a pixel on every side (anti-aliased glyph edges)
    ctx.beginPath();
    ctx.moveTo(quad[0][0], quad[0][1]);
    for (let i = 1; i < 4; i++) ctx.lineTo(quad[i][0], quad[i][1]);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  for (const cv of covers) {
    const m = cv.mark;
    if (!m.label) continue;
    const pad = COVER_PAD_ALONG * m.size;
    const [x0, y0] = cv.at(cv.start + pad, 0);
    const [x1, y1] = cv.at(cv.start + pad + 1, 0);
    const [xu, yu] = cv.at(cv.start + pad, 1);
    const pxPerUnit = Math.hypot(x1 - x0, y1 - y0);
    const pxPerUnitUp = Math.hypot(xu - x0, yu - y0);
    const available = (cv.end - cv.start - 2 * pad) * pxPerUnit;
    const em = cv.inkTop !== null && cv.inkTop > 0 ? cv.inkTop / INK_TOP_EM : LABEL_SIZE * m.size;
    let fontPx = Math.min(em, 1.2 * m.size) * pxPerUnitUp;
    if (!(fontPx > 0) || !(available > 0)) continue;
    ctx.font = `${fontPx}px ${LABEL_FONT}`;
    const natural = ctx.measureText(m.label).width;
    let squeeze = natural > available ? available / natural : 1;
    if (squeeze < LABEL_MIN_SQUEEZE) {
      fontPx *= squeeze / LABEL_MIN_SQUEEZE;
      squeeze = LABEL_MIN_SQUEEZE;
      ctx.font = `${fontPx}px ${LABEL_FONT}`;
    }
    ctx.save();
    ctx.translate(x0, y0);
    ctx.rotate(Math.atan2(y1 - y0, x1 - x0));
    ctx.scale(squeeze, 1);
    ctx.fillStyle = cv.ink !== null ? `rgb(${cv.ink}, ${cv.ink}, ${cv.ink})` : luminance(cv.paper) > 0.45 ? '#000000' : '#ffffff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(m.label, 0, 0);
    ctx.restore();
  }
  ctx.restore();

  const rgba = page.canvas.getImageData();
  const { pixels, channels } = packPixels(rgba);
  return { pixels, channels, widthPx: page.widthPx, heightPx: page.heightPx, widthPt: page.widthPt, heightPt: page.heightPt };
}

function sub(p: [number, number], q: [number, number]): [number, number] {
  return [p[0] - q[0], p[1] - q[1]];
}

/** Pixel corners of the box [lo, hi] along the baseline by [bottom, top] across it. */
function quadOf(at: (along: number, up: number) => [number, number], lo: number, hi: number, bottom: number, top: number): Array<[number, number]> {
  return [at(lo, bottom), at(hi, bottom), at(hi, top), at(lo, top)];
}

/** Luminance (0..1) of the pixel under a baseline-frame point, or null off canvas. */
function lumAt(rgba: Uint8ClampedArray, width: number, height: number, p: [number, number]): number | null {
  const px = Math.round(p[0]);
  const py = Math.round(p[1]);
  if (px < 0 || py < 0 || px >= width || py >= height) return null;
  const i = (py * width + px) * 4;
  return (0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2]) / 255;
}

/**
 * Vertical extent of the value's ink (user units from the baseline): the block of inked rows
 * across [start, end] that holds the letters' bodies, grown up and down until a blank row (the
 * leading between lines), within INK_REACH_BELOW / INK_REACH_ABOVE. Null when no ink is there.
 */
export function inkRows(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  at: (along: number, up: number) => [number, number],
  m: PaintMark,
  start: number,
  end: number,
  inkBelow: number,
): { bottom: number; top: number } | null {
  const pxAlong = Math.hypot(...sub(at(1, 0), at(0, 0)));
  const pxUp = Math.hypot(...sub(at(0, 1), at(0, 0)));
  if (!(pxAlong > 0) || !(pxUp > 0)) return null;
  const stepAlong = 1 / pxAlong;
  const stepUp = 1 / pxUp;
  const rowHasInk = (up: number): boolean => {
    for (let along = start; along <= end; along += stepAlong) {
      const lum = lumAt(rgba, width, height, at(along, up));
      if (lum !== null && lum < inkBelow) return true;
    }
    return false;
  };
  // Seed in the letters' bodies (every letter has ink between the baseline and the x-height).
  let seed: number | null = null;
  for (let up = 0.1 * m.size; up <= 0.45 * m.size; up += stepUp) {
    if (rowHasInk(up)) { seed = up; break; }
  }
  if (seed === null) return null;
  let top = seed;
  for (let up = seed; up <= INK_REACH_ABOVE * m.size && rowHasInk(up); up += stepUp) top = up;
  let bottom = seed;
  for (let up = seed; up >= -INK_REACH_BELOW * m.size && rowHasInk(up); up -= stepUp) bottom = up;
  return { bottom, top };
}

/**
 * How far the ink of a value really reaches along its baseline (user units from the mark's
 * start; `start` <= 0 and `end` >= length when the ink runs past the OCR layer's ends). Walks
 * outwards pixel by pixel from inside the value and stops at the first blank gap of a word
 * space, or after MAX_GROWTH em / MAX_GROWTH_SHARE of the value's length.
 */
export function inkExtent(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  at: (along: number, up: number) => [number, number],
  m: PaintMark,
  inkBelow: number,
): { start: number; end: number } {
  const [ox, oy] = at(0, 0);
  const [ax, ay] = at(1, 0);
  const pxPerUnit = Math.hypot(ax - ox, ay - oy);
  if (!(pxPerUnit > 0)) return { start: 0, end: m.length };
  const step = 1 / pxPerUnit; // one pixel along the baseline, in user units
  const [bx, by] = at(0, INK_BAND_BELOW * -m.size);
  const [tx, ty] = at(0, INK_BAND_ABOVE * m.size);
  const bandPx = Math.max(1, Math.ceil(Math.hypot(tx - bx, ty - by)));
  const isInk = (along: number): boolean => {
    for (let k = 0; k <= bandPx; k++) {
      const up = -INK_BAND_BELOW * m.size + (k / bandPx) * (INK_BAND_ABOVE + INK_BAND_BELOW) * m.size;
      const lum = lumAt(rgba, width, height, at(along, up));
      if (lum !== null && lum < inkBelow) return true;
    }
    return false;
  };
  const inside = Math.min(INK_SEARCH_INSIDE * m.size, m.length / 2);
  const gap = WORD_GAP * m.size;
  const growth = Math.max(MAX_GROWTH * m.size, MAX_GROWTH_SHARE * m.length);
  const reach = (from: number, dir: 1 | -1, limit: number): number => {
    let last = from;
    for (let along = from; dir > 0 ? along <= limit : along >= limit; along += dir * step) {
      if (isInk(along)) last = along;
      else if (Math.abs(along - last) >= gap) break;
    }
    return last + dir * step;
  };
  return {
    start: Math.min(0, reach(inside, -1, -growth)),
    end: Math.max(m.length, reach(m.length - inside, 1, m.length + growth)),
  };
}

/**
 * Gray level (0..255) of the ink in the box [start, end] x [bottom, top]: the median luminance of
 * its ink pixels, without their hue (a label never repeats the colour a value was printed in).
 * Null without ink.
 */
function inkColour(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  at: (along: number, up: number) => [number, number],
  start: number,
  end: number,
  bottom: number,
  top: number,
  inkBelow: number,
): number | null {
  const stepAlong = 1 / (Math.hypot(...sub(at(1, 0), at(0, 0))) || 1);
  const stepUp = 1 / (Math.hypot(...sub(at(0, 1), at(0, 0))) || 1);
  const levels: number[] = [];
  for (let up = bottom; up <= top; up += stepUp) {
    for (let along = start; along <= end; along += stepAlong) {
      const [x, y] = at(along, up);
      const px = Math.round(x);
      const py = Math.round(y);
      if (px < 0 || py < 0 || px >= width || py >= height) continue;
      const i = (py * width + px) * 4;
      const level = 0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2];
      if (level / 255 < inkBelow) levels.push(level);
    }
  }
  if (levels.length === 0) return null;
  return Math.round(levels.sort((p, q) => p - q)[levels.length >> 1]);
}

/**
 * The paper colour around a cover: per-channel median of the pixels on a ring
 * three pixels outside the quad's bounding box (mostly background, whatever
 * text the ring crosses is a minority). White when the ring is off canvas.
 */
export function paperColour(rgba: Uint8ClampedArray, width: number, height: number, quad: Array<[number, number]>): [number, number, number] {
  const xs = quad.map((p) => p[0]);
  const ys = quad.map((p) => p[1]);
  const left = Math.floor(Math.min(...xs)) - 3;
  const right = Math.ceil(Math.max(...xs)) + 3;
  const top = Math.floor(Math.min(...ys)) - 3;
  const bottom = Math.ceil(Math.max(...ys)) + 3;
  const channels: [number[], number[], number[]] = [[], [], []];
  const take = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    channels[0].push(rgba[i]);
    channels[1].push(rgba[i + 1]);
    channels[2].push(rgba[i + 2]);
  };
  for (let x = left; x <= right; x++) { take(x, top); take(x, bottom); }
  for (let y = top + 1; y < bottom; y++) { take(left, y); take(right, y); }
  if (channels[0].length === 0) return [255, 255, 255];
  const median = (v: number[]): number => v.sort((p, q) => p - q)[v.length >> 1];
  return [median(channels[0]), median(channels[1]), median(channels[2])];
}

function luminance(rgb: [number, number, number]): number {
  return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
}

/** RGBA canvas pixels to gray (every pixel has R = G = B) or RGB bytes; alpha is dropped (pdf.js paints an opaque page). */
export function packPixels(rgba: Uint8ClampedArray): { pixels: Uint8Array; channels: 1 | 3 } {
  const n = rgba.length >> 2;
  let gray = true;
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4];
    if (r !== rgba[i * 4 + 1] || r !== rgba[i * 4 + 2]) { gray = false; break; }
  }
  if (gray) {
    const pixels = new Uint8Array(n);
    for (let i = 0; i < n; i++) pixels[i] = rgba[i * 4];
    return { pixels, channels: 1 };
  }
  const pixels = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    pixels[i * 3] = rgba[i * 4];
    pixels[i * 3 + 1] = rgba[i * 4 + 1];
    pixels[i * 3 + 2] = rgba[i * 4 + 2];
  }
  return { pixels, channels: 3 };
}
