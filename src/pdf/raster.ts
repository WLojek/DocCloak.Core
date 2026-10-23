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
  /**
   * How far along the baseline the value's letters may still reach (an OCR show stretched over its
   * word box): ink between `length` and here is covered even across a gap. Absent: `length`.
   */
  reach?: number;
  /**
   * The value starts or ends inside a word of the OCR layer ("2026" of "2026/03/017"): on that side
   * the cover grows only by IN_WORD_GROWTH, so the rest of the word stays readable.
   */
  startsInWord?: boolean;
  endsInWord?: boolean;
  /** Font size of the value's text, user units. */
  size: number;
  /**
   * Placeholder to show from the cover's start, with any punctuation glued to the value that the
   * cover takes in ("[PHONE_1],"); on the rest of a value wrapped onto the next line only the
   * punctuation glued before it, often '' (the cover alone).
   */
  label: string;
  /** On the rest of a wrapped value: the punctuation glued after it, painted up to the cover's end, where it was printed. */
  labelEnd?: string;
  /**
   * The text column along this mark's baseline (user units from its start): a label growing into
   * blank paper beside a short value stays between the two. Absent: no room is taken.
   */
  columnStart?: number;
  columnEnd?: number;
}

/** A rendered scan page: raw pixels, 1 (gray) or 3 (RGB) bytes each, row-major. */
export interface ScanRaster {
  pixels: Uint8Array;
  channels: 1 | 3;
  widthPx: number;
  heightPx: number;
  widthPt: number;
  heightPt: number;
  /** pdf.js viewport transform of the render: source user space to these pixels. */
  transform: number[];
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
/**
 * On a side where the value continues as the same word (its letters placed by real proportions),
 * the cover ends in the blank valley between two letters nearest the estimate on the side away
 * from the value, searched up to IN_WORD_SEARCH outwards and IN_WORD_INSIDE inwards: OCR letter
 * boxes can sit half a letter off ("d'ALTAMIR" read with the "A" starting in its middle), and a
 * cover that takes one letter too many keeps the value hidden where one letter too few shows it.
 * Without a valley (touching letters) it ends IN_WORD_GROWTH past the estimate.
 */
const IN_WORD_SEARCH = 0.8;
const IN_WORD_INSIDE = 0.05;
const IN_WORD_GROWTH = 0.06;
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
/**
 * Marks standing apart above the letters (the dot of "Ż", the accent of "ó" over a word with no
 * ascender, the dot of an "i"): a shape of ink within DIACRITIC_GAP of the letters' top, no taller
 * than DIACRITIC_HEIGHT and no wider than DIACRITIC_WIDTH, that does not run on past
 * DIACRITIC_WINDOW above that top (the line above's descenders do) or out of the cover's sides,
 * gets a cover of its own. In em of the letters' measured size (their top is INK_TOP_EM of it).
 */
const DIACRITIC_GAP = 0.2;
const DIACRITIC_HEIGHT = 0.3;
const DIACRITIC_WIDTH = 0.6;
const DIACRITIC_WINDOW = 0.5;
const LABEL_SIZE = 0.8;
const LABEL_MIN_SQUEEZE = 0.6;
/**
 * A label longer than its value's width first takes the blank paper after the value (a line end,
 * a wide gap), then before it (a right-aligned line), up to LABEL_ROOM_GAP em before the next ink
 * and inside the text column (PaintMark.columnStart / columnEnd), so a short value's placeholder
 * ("ul.", "557") stays readable; only then is it squeezed and shrunk. The paper must be blank from
 * LABEL_ROOM_BELOW below the baseline to LABEL_ROOM_ABOVE above it (brackets reach that far).
 */
const LABEL_ROOM_GAP = 0.35;
const LABEL_ROOM_BELOW = 0.25;
const LABEL_ROOM_ABOVE = 0.85;
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
  /** Small covers over marks standing apart above the letters (diacritics), in the same frame. */
  marks: Array<{ start: number; end: number; bottom: number; top: number }>;
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
    // Inside a word the cover stops in the valley between two letters: a pixel of margin, not the pad.
    const onePxAlong = 1 / (Math.hypot(...sub(at(1, 0), at(0, 0))) || 1);
    const start = (m.startsInWord ? along.start : Math.min(0, along.start)) - (m.startsInWord ? onePxAlong : pad);
    const end = (m.endsInWord ? along.end : Math.max(m.length, along.end)) + (m.endsInWord ? onePxAlong : pad);
    const rows = inkRows(before, page.widthPx, page.heightPx, at, m, start, end, inkBelow);
    const onePx = 1 / (Math.hypot(...sub(at(0, 1), at(0, 0))) || 1);
    const bottom = rows ? Math.min(-COVER_CORE_BELOW * m.size, rows.bottom - 1.5 * onePx) : -COVER_BELOW * m.size;
    const top = rows ? Math.max(COVER_CORE_ABOVE * m.size, rows.top + 1.5 * onePx) : COVER_ABOVE * m.size;
    const ink = rows ? inkColour(before, page.widthPx, page.heightPx, at, start, end, rows.bottom, rows.top, inkBelow) : null;
    const marksAbove = rows && rows.top > 0 ? diacriticsAbove(before, page.widthPx, page.heightPx, at, start, end, rows.top, rows.top / INK_TOP_EM, inkBelow) : [];
    const marks = marksAbove.map((d) => ({ start: d.start - 1.5 * onePxAlong, end: d.end + 1.5 * onePxAlong, bottom: top - onePx, top: d.top + 1.5 * onePx }));
    return { mark: m, at, start, end, bottom, top, inkTop: rows ? rows.top : null, paper, ink, marks };
  });

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  for (const cv of covers) {
    const fill = `rgb(${cv.paper[0]}, ${cv.paper[1]}, ${cv.paper[2]})`;
    ctx.fillStyle = fill;
    ctx.strokeStyle = fill;
    ctx.lineWidth = 2; // the stroke grows the cover by a pixel on every side (anti-aliased glyph edges)
    for (const box of [cv, ...cv.marks]) {
      const quad = quadOf(cv.at, box.start, box.end, box.bottom, box.top);
      ctx.beginPath();
      ctx.moveTo(quad[0][0], quad[0][1]);
      for (let i = 1; i < 4; i++) ctx.lineTo(quad[i][0], quad[i][1]);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }
  // How far each label may reach past its cover into blank paper: half the gap to the next (and
  // the previous) cover on the same line, so two neighbours never claim the same room.
  const reach = covers.map((a) => {
    let right = Infinity;
    let left = Infinity;
    const am = a.mark;
    for (const b of covers) {
      if (b === a) continue;
      const bm = b.mark;
      const across = (bm.x - am.x) * am.vx + (bm.y - am.y) * am.vy;
      if (Math.abs(across) > 0.5 * Math.max(am.size, bm.size) || am.ux * bm.ux + am.uy * bm.uy < 0.99) continue;
      const along = (t: number): number => (bm.x + bm.ux * t - am.x) * am.ux + (bm.y + bm.uy * t - am.y) * am.uy;
      const bs = along(b.start);
      const be = along(b.end);
      if (bs >= a.end) right = Math.min(right, (bs - a.end) / 2);
      else if (be <= a.start) left = Math.min(left, (a.start - be) / 2);
    }
    return { right, left };
  });
  covers.forEach((cv, k) => {
    const m = cv.mark;
    // The label from the cover's start; the punctuation of a wrapped value's rest up to its end.
    for (const [text, alignEnd] of [[m.label, false], [m.labelEnd ?? '', true]] as const) {
      if (!text) continue;
      const pad = COVER_PAD_ALONG * m.size;
      let from = alignEnd ? cv.end - pad : cv.start + pad;
      const [ox, oy] = cv.at(from, 0);
      const [ax, ay] = cv.at(from + 1, 0);
      const [ux, uy] = cv.at(from, 1);
      const pxPerUnit = Math.hypot(ax - ox, ay - oy);
      const pxPerUnitUp = Math.hypot(ux - ox, uy - oy);
      let available = (cv.end - cv.start - 2 * pad) * pxPerUnit;
      const em = cv.inkTop !== null && cv.inkTop > 0 ? cv.inkTop / INK_TOP_EM : LABEL_SIZE * m.size;
      let fontPx = Math.min(em, 1.2 * m.size) * pxPerUnitUp;
      if (!(fontPx > 0) || !(available > 0)) continue;
      ctx.font = `${fontPx}px ${LABEL_FONT}`;
      const natural = ctx.measureText(text).width;
      if (!alignEnd && natural > available) {
        // Blank paper after the value first, then before it (a right-aligned line, a line start).
        const inkBelow = cv.ink !== null ? luminance(cv.paper) * INK_LUMINANCE : 0;
        // Never past the text column: no room without it.
        const columnRight = Math.max(0, (m.columnEnd ?? -Infinity) - (cv.end - pad));
        const columnLeft = Math.max(0, (cv.start + pad) - (m.columnStart ?? Infinity));
        const after = blankAfter(before, page.widthPx, page.heightPx, cv.at, cv.end - pad, Math.min((natural - available) / pxPerUnit, reach[k].right + pad, columnRight), em, inkBelow);
        available += after * pxPerUnit;
        if (natural > available) {
          const beforeRoom = blankAfter(before, page.widthPx, page.heightPx, cv.at, cv.start + pad, Math.min((natural - available) / pxPerUnit, reach[k].left + pad, columnLeft), em, inkBelow, -1);
          available += beforeRoom * pxPerUnit;
          from -= beforeRoom;
        }
      }
      const [x0, y0] = cv.at(from, 0);
      const [x1, y1] = cv.at(from + 1, 0);
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
      ctx.textAlign = alignEnd ? 'right' : 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(text, 0, 0);
      ctx.restore();
    }
  });
  ctx.restore();

  const rgba = page.canvas.getImageData();
  const { pixels, channels } = packPixels(rgba);
  return { pixels, channels, widthPx: page.widthPx, heightPx: page.heightPx, widthPt: page.widthPt, heightPt: page.heightPt, transform: page.transform };
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
 * Blank paper from `from` along a mark's baseline (user units; `dir` 1 after it, -1 before it), up
 * to `want`: the run of columns with no ink from LABEL_ROOM_BELOW below the baseline to
 * LABEL_ROOM_ABOVE above it (in `em`), ending LABEL_ROOM_GAP em before the next ink. The picture's
 * edge ends it too. 0 without an ink threshold (no ink was measured, so blank cannot be told from print).
 */
export function blankAfter(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  at: (along: number, up: number) => [number, number],
  from: number,
  want: number,
  em: number,
  inkBelow: number,
  dir: 1 | -1 = 1,
): number {
  if (!(want > 0) || !(em > 0) || !(inkBelow > 0)) return 0;
  const pxAlong = Math.hypot(...sub(at(1, 0), at(0, 0)));
  const pxUp = Math.hypot(...sub(at(0, 1), at(0, 0)));
  if (!(pxAlong > 0) || !(pxUp > 0)) return 0;
  const stepAlong = 1 / pxAlong;
  const stepUp = 1 / pxUp;
  const gap = LABEL_ROOM_GAP * em;
  for (let d = 0; d <= want + gap; d += stepAlong) {
    for (let up = -LABEL_ROOM_BELOW * em; up <= LABEL_ROOM_ABOVE * em; up += stepUp) {
      const lum = lumAt(rgba, width, height, at(from + dir * d, up));
      if (lum === null || lum < inkBelow) return Math.max(0, Math.min(want, d - gap));
    }
  }
  return want;
}

/**
 * Marks of ink standing apart above a value's letters, whose `top` is the letters' measured top
 * and `em` their size (see DIACRITIC_*): each as its extent in the mark's frame (user units).
 * The window above the letters is sampled pixel by pixel and split into 8-connected shapes; a
 * shape that reaches the window's top or sides belongs to something else (the line above, the
 * next word) and is left alone.
 */
export function diacriticsAbove(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  at: (along: number, up: number) => [number, number],
  start: number,
  end: number,
  top: number,
  em: number,
  inkBelow: number,
): Array<{ start: number; end: number; top: number }> {
  const pxAlong = Math.hypot(...sub(at(1, 0), at(0, 0)));
  const pxUp = Math.hypot(...sub(at(0, 1), at(0, 0)));
  if (!(pxAlong > 0) || !(pxUp > 0) || !(em > 0) || !(end > start)) return [];
  const stepAlong = 1 / pxAlong;
  const stepUp = 1 / pxUp;
  const cols = Math.min(4000, Math.ceil((end - start) / stepAlong) + 1);
  const rows = Math.min(400, Math.ceil((DIACRITIC_WINDOW * em) / stepUp));
  if (rows < 2 || cols < 2) return [];
  const ink = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const lum = lumAt(rgba, width, height, at(start + i * stepAlong, top + (j + 1) * stepUp));
      if (lum !== null && lum < inkBelow) ink[j * cols + i] = 1;
    }
  }
  const seen = new Uint8Array(cols * rows);
  const out: Array<{ start: number; end: number; top: number }> = [];
  const stack: number[] = [];
  for (let p0 = 0; p0 < ink.length; p0++) {
    if (!ink[p0] || seen[p0]) continue;
    seen[p0] = 1;
    stack.push(p0);
    let i0 = cols, i1 = 0, j0 = rows, j1 = 0;
    while (stack.length > 0) {
      const p = stack.pop()!;
      const i = p % cols;
      const j = (p - i) / cols;
      if (i < i0) i0 = i;
      if (i > i1) i1 = i;
      if (j < j0) j0 = j;
      if (j > j1) j1 = j;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ni = i + di;
          const nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
          const q = nj * cols + ni;
          if (ink[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
        }
      }
    }
    if (j1 === rows - 1 || i0 === 0 || i1 === cols - 1) continue;
    if ((j0 + 1) * stepUp > DIACRITIC_GAP * em) continue;
    if ((j1 - j0 + 1) * stepUp > DIACRITIC_HEIGHT * em || (i1 - i0 + 1) * stepAlong > DIACRITIC_WIDTH * em) continue;
    out.push({ start: start + i0 * stepAlong, end: start + (i1 + 1) * stepAlong, top: top + (j1 + 1) * stepUp });
  }
  return out;
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
  // Ink up to `reach` belongs to the value whatever the gaps: the search for the end starts there.
  let end = m.length;
  if (m.reach !== undefined && m.reach > m.length) {
    for (let along = m.length; along <= m.reach; along += step) if (isInk(along)) end = along + step;
  }
  const reach = (from: number, dir: 1 | -1, limit: number): number => {
    let last = from;
    for (let along = from; dir > 0 ? along <= limit : along >= limit; along += dir * step) {
      if (isInk(along)) last = along;
      else if (Math.abs(along - last) >= gap) break;
    }
    return last + dir * step;
  };
  // The blank column run nearest `at` on the `outward` side (-1 before the value, 1 after it): the
  // valley between two letters.
  const valley = (at: number, outward: 1 | -1): number | null => {
    const lo = outward < 0 ? at - IN_WORD_SEARCH * m.size : at - IN_WORD_INSIDE * m.size;
    const hi = outward < 0 ? at + IN_WORD_INSIDE * m.size : at + IN_WORD_SEARCH * m.size;
    let best: number | null = null;
    let runStart: number | null = null;
    for (let along = lo; along <= hi + step; along += step) {
      if (!isInk(along) && along <= hi) {
        if (runStart === null) runStart = along;
        continue;
      }
      if (runStart !== null) {
        const centre = (runStart + along - step) / 2;
        if (best === null || Math.abs(centre - at) < Math.abs(best - at)) best = centre;
        runStart = null;
      }
    }
    return best;
  };
  const startAt = m.startsInWord ? (valley(0, -1) ?? -IN_WORD_GROWTH * m.size) : Math.min(0, reach(inside, -1, -growth));
  const endAt = m.endsInWord ? (valley(m.length, 1) ?? m.length + IN_WORD_GROWTH * m.size) : Math.max(end, reach(end - inside, 1, end + growth));
  return { start: startAt, end: endAt };
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
