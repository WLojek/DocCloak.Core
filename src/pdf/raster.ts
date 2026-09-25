/**
 * @doccloak/core/pdf - page rasterization fallback (T212).
 *
 * A page whose text cannot be edited safely is rendered to pixels by pdf.js
 * and the redacted rectangles are painted black IN THE PIXELS, on the same
 * canvas, after the render: the PNG never contains what was under a box.
 * The caller (writer) replaces the page contents with this image and
 * reports the page in `rasterizedPages`.
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
