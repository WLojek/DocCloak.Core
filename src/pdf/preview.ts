/**
 * @doccloak/core/pdf - page pictures for a host's page view (WLojek/DocCloak.Core#6).
 *
 * To leave a page out or hide an area by hand, the user has to see the pages.
 * `openPdfPreview` opens the file with pdf.js once and renders a page when
 * asked (a thumbnail, a larger view to draw on): a 200-page file costs
 * nothing until a page is shown. The pages are rendered as the file has
 * them, whatever edits the extraction carries; the host draws its own marks
 * over them (hidden areas, removed pages dimmed).
 *
 * The user draws in the pixels of a rendered page; edits are kept in the
 * page's user space. `pixelRectToUserRect` and `userRectToPixelRect` convert
 * between the two through `RenderedPage.transform`, which holds the scale,
 * the y flip, the crop box and /Rotate.
 */

import { openWithOracle } from './oracle.ts';
import type { CanvasFactory, RenderedPage } from './oracle.ts';
import type { PdfExtraction } from './read.ts';
import type { PdfAssetPaths, Rect } from './types.ts';

export interface PdfPreviewOptions {
  /** pdf.js assets; default: those the extraction was read with. */
  assets?: PdfAssetPaths;
  /** Node hosts and tests: canvas factory for every render. Browsers use OffscreenCanvas. */
  canvasFactory?: CanvasFactory;
}

export interface PdfPreview {
  /** Pages of the file as read (removed pages included). */
  pageCount: number;
  /**
   * Size of a page as it is shown, in points (the crop box with /Rotate applied), and its /Rotate:
   * enough to lay out a page view before any page is rendered. Does not render.
   */
  pageSize(index: number): Promise<{ width: number; height: number; rotate: number }>;
  /**
   * Render page `index` (0-based) at `scale` (1 = 72 dpi, one pixel per point; a thumbnail is
   * about 0.2, a view to draw on 1.5 to 2 times the device pixel ratio). The canvas of the result
   * is the caller's to show or to copy from.
   */
  render(index: number, scale: number, canvasFactory?: CanvasFactory): Promise<RenderedPage>;
  /** Release pdf.js. Renders in flight fail. */
  close(): Promise<void>;
}

/** Open the file of an extraction for page pictures. Close it when the page view goes away. */
export async function openPdfPreview(
  extraction: Pick<PdfExtraction, 'bytes' | 'assets' | 'password'>,
  options: PdfPreviewOptions = {},
): Promise<PdfPreview> {
  const oracle = await openWithOracle(extraction.bytes, options.assets ?? extraction.assets, extraction.password);
  return {
    pageCount: oracle.pageCount,
    async pageSize(index) {
      const { width, height, rotate } = await oracle.pageSize(index);
      const turned = rotate === 90 || rotate === 270;
      return { width: turned ? height : width, height: turned ? width : height, rotate };
    },
    render: (index, scale, canvasFactory) => oracle.render(index, scale, canvasFactory ?? options.canvasFactory),
    close: () => oracle.close(),
  };
}

/** A rectangle in the pixels of a rendered page: origin top-left, y downwards. */
export interface PixelRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * A rectangle drawn on a rendered page, in the page's user space (what `PdfEdits.regions`
 * holds). `transform` is `RenderedPage.transform` of that render; the pixels are those of its
 * canvas (a host that shows the canvas at another size scales its pointer positions first). On a
 * page with /Rotate the corners swap; the result is the same area, with x0 < x1 and y0 < y1.
 */
export function pixelRectToUserRect(transform: number[], rect: PixelRect): Rect {
  const [a, b, c, d, e, f] = transform;
  const det = a * d - b * c;
  if (!(Math.abs(det) > 0)) throw new RangeError('the render transform cannot be inverted');
  const toUser = (px: number, py: number): [number, number] => [(d * (px - e) - c * (py - f)) / det, (a * (py - f) - b * (px - e)) / det];
  return boundsOfPoints([toUser(rect.x0, rect.y0), toUser(rect.x1, rect.y0), toUser(rect.x0, rect.y1), toUser(rect.x1, rect.y1)]);
}

/** A user-space rectangle (a hidden area, a glyph box) in the pixels of a render with `transform`, to draw it over the page. */
export function userRectToPixelRect(transform: number[], rect: Rect): PixelRect {
  const [a, b, c, d, e, f] = transform;
  const toPx = (x: number, y: number): [number, number] => [a * x + c * y + e, b * x + d * y + f];
  return boundsOfPoints([toPx(rect.x0, rect.y0), toPx(rect.x1, rect.y0), toPx(rect.x0, rect.y1), toPx(rect.x1, rect.y1)]);
}

function boundsOfPoints(points: Array<[number, number]>): { x0: number; y0: number; x1: number; y1: number } {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}
