/**
 * @doccloak/core/pdf - hand edits (WLojek/DocCloak.Core#6).
 *
 * What no detector finds (a signature, a handwritten name, a stamp, a page
 * the OCR could not read) the user takes out by hand: whole pages are left
 * out, rectangles are hidden. Edits are applied to the extraction AS READ
 * (the base): the edited text is the base text without the text of the
 * removed pages and of the glyphs a rectangle touches, so the same bytes and
 * the same edits always give the same text. The writer re-extracts the
 * bytes, applies the edits the extraction carries the same way and refuses
 * the export when the text differs (the stale check).
 *
 * A glyph a rectangle touches leaves the text AND is painted over whole by
 * the writer, with the rectangle: a letter half under a rectangle would
 * otherwise stay readable in the picture while no detector could see it.
 */

import { aggregatePageParts } from './extract.ts';
import type { PdfExtraction } from './read.ts';
import type { Glyph, GlyphRun, PdfEdits, PdfPageInfo, PdfRegion, Rect } from './types.ts';
import type { UnredactablePart } from '../dom/errors.ts';

/** A stretch of text two versions of an extraction share: `length` characters at `from` in the one, at `to` in the other. */
export interface KeptStretch {
  from: number;
  to: number;
  length: number;
}

export interface PdfEditResult {
  /** The extraction with the edits applied; it carries them (`edits`) and the extraction as read (`unedited`). */
  extraction: PdfExtraction;
  /**
   * How the new text maps onto the text of the extraction passed in: the stretches both hold, in
   * order (`from` is an offset in the old text, `to` in the new one). See `mapKeptRange`.
   */
  kept: KeptStretch[];
  /**
   * True when the new text holds text the old one did not (a page brought back, a hidden area
   * taken away): the host must run detection again. False: every detection the host has is
   * either still there (map it with `kept`) or gone with its text.
   */
  addedText: boolean;
  /**
   * Where letters are painted over along with the rectangles: the boxes of the glyphs a rectangle
   * touches (a letter is never left half covered), one per stretch of such glyphs, about as the
   * writer paints them. For a host that shows what will be black.
   */
  covered: PdfRegion[];
}

/** A hidden area is at least this wide and high (points): a thinner one is widened around its middle. */
const MIN_REGION_SIDE = 2;
/**
 * The box of a glyph a rectangle is tested against, in em of its font size from the baseline:
 * about where its ink is. Tight on purpose: a rectangle drawn around one line must not take the
 * lines above and below with it.
 */
const TOUCH_BELOW = 0.25;
const TOUCH_ABOVE = 0.8;
/** The box of a covered glyph as a host is told (`covered`): what the writer blacks out at least. */
const COVER_BELOW = 0.3;
const COVER_ABOVE = 0.9;

/** Edits in their canonical form: pages sorted and unique, rectangles with x0 < x1 and y0 < y1. */
export interface NormalizedPdfEdits {
  removedPages: number[];
  regions: PdfRegion[];
}

/**
 * Check and tidy a set of edits for a file of `pageCount` pages. Throws RangeError for a page
 * that does not exist, a rectangle that is not made of numbers, and when no page would be left.
 */
export function normalizePdfEdits(edits: PdfEdits, pageCount: number): NormalizedPdfEdits {
  const checkPage = (p: number): void => {
    if (!Number.isInteger(p) || p < 0 || p >= pageCount) throw new RangeError(`page index ${p} out of range (0..${pageCount - 1})`);
  };
  const removed = new Set<number>();
  for (const p of edits.removedPages ?? []) {
    checkPage(p);
    removed.add(p);
  }
  if (pageCount > 0 && removed.size >= pageCount) throw new RangeError('every page is removed; at least one page must stay');
  const regions: PdfRegion[] = [];
  for (const region of edits.regions ?? []) {
    checkPage(region.page);
    const r = region.rect;
    if (!r || ![r.x0, r.y0, r.x1, r.y1].every((v) => typeof v === 'number' && Number.isFinite(v))) {
      throw new RangeError('a hidden area must be a rectangle of finite numbers');
    }
    let x0 = Math.min(r.x0, r.x1);
    let x1 = Math.max(r.x0, r.x1);
    let y0 = Math.min(r.y0, r.y1);
    let y1 = Math.max(r.y0, r.y1);
    // A click without a drag is not a rectangle.
    if (x1 === x0 || y1 === y0) continue;
    if (x1 - x0 < MIN_REGION_SIDE) { const m = (x0 + x1) / 2; x0 = m - MIN_REGION_SIDE / 2; x1 = m + MIN_REGION_SIDE / 2; }
    if (y1 - y0 < MIN_REGION_SIDE) { const m = (y0 + y1) / 2; y0 = m - MIN_REGION_SIDE / 2; y1 = m + MIN_REGION_SIDE / 2; }
    regions.push({ page: region.page, rect: { x0, y0, x1, y1 } });
  }
  return { removedPages: [...removed].sort((a, b) => a - b), regions };
}

/** True when the edits change nothing. */
export function isEmptyEdits(edits: PdfEdits | undefined): boolean {
  return !edits || ((edits.removedPages?.length ?? 0) === 0 && (edits.regions?.length ?? 0) === 0);
}

/* ------------------------------------------------------------------ */
/* Geometry: glyph boxes against rectangles                             */
/* ------------------------------------------------------------------ */

type Point = [number, number];

/** Baseline frame of a run: unit vectors along and across the baseline, user units per text-space unit. */
function frameOf(run: GlyphRun): { ux: number; uy: number; vx: number; vy: number; k: number } {
  const exLen = Math.hypot(run.emX[0], run.emX[1]) || 1;
  const eyLen = Math.hypot(run.emY[0], run.emY[1]) || 1;
  return {
    ux: run.emX[0] / exLen,
    uy: run.emX[1] / exLen,
    vx: run.emY[0] / eyLen,
    vy: run.emY[1] / eyLen,
    k: exLen / (run.local.fontSize * run.local.hscale || 1),
  };
}

/**
 * Corners of the box of glyphs `from`..`to - 1` of a run: from the first glyph's start to the
 * last one's end along the baseline (the gaps between them included), `below` to `above` em
 * across it.
 */
function spanQuad(run: GlyphRun, from: number, to: number, below: number, above: number): Point[] {
  const { ux, uy, vx, vy, k } = frameOf(run);
  const g0 = run.glyphs[from];
  let lo = Infinity;
  let hi = -Infinity;
  let size = 0;
  for (let i = from; i < to; i++) {
    const g = run.glyphs[i];
    const along = (g.x - g0.x) * ux + (g.y - g0.y) * uy;
    const end = along + g.advance * k;
    lo = Math.min(lo, along, end);
    hi = Math.max(hi, along, end);
    size = Math.max(size, g.fontSize);
  }
  // A glyph without width (a combining mark) still is somewhere.
  if (hi - lo < 0.02 * size) hi = lo + 0.02 * size;
  const at = (along: number, up: number): Point => [g0.x + ux * along + vx * up, g0.y + uy * along + vy * up];
  return [at(lo, -below * size), at(hi, -below * size), at(hi, above * size), at(lo, above * size)];
}

/** A vertical pdf.js item is only known as a whole: its rectangle, both ways along each axis (as the raster covers it). */
function verticalItemBox(run: GlyphRun): Rect {
  const g = run.glyphs[0];
  const { ux, uy, vx, vy } = frameOf(run);
  const w = g.advance;
  const h = run.glyphs.length * g.advance;
  const xs = [g.x - vx * w - ux * h, g.x + vx * w + ux * h];
  const ys = [g.y - vy * w - uy * h, g.y + vy * w + uy * h];
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** True when the parallelogram `quad` and `rect` share an area (touching edges do not count). */
function quadHitsRect(quad: Point[], rect: Rect): boolean {
  const EPS = 1e-6;
  const corners: Point[] = [[rect.x0, rect.y0], [rect.x1, rect.y0], [rect.x1, rect.y1], [rect.x0, rect.y1]];
  // Separating axes: the rectangle's two, and the normals of the quad's two edge directions.
  const axes: Point[] = [[1, 0], [0, 1]];
  for (const [p, q] of [[quad[0], quad[1]], [quad[1], quad[2]]]) {
    const dx = q[0] - p[0];
    const dy = q[1] - p[1];
    const len = Math.hypot(dx, dy);
    if (len > 0) axes.push([-dy / len, dx / len]);
  }
  for (const [ax, ay] of axes) {
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const [x, y] of quad) { const t = x * ax + y * ay; a0 = Math.min(a0, t); a1 = Math.max(a1, t); }
    for (const [x, y] of corners) { const t = x * ax + y * ay; b0 = Math.min(b0, t); b1 = Math.max(b1, t); }
    if (Math.min(a1, b1) - Math.max(a0, b0) <= EPS) return false;
  }
  return true;
}

function boundsOf(quad: Point[]): Rect {
  const xs = quad.map((p) => p[0]);
  const ys = quad.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/**
 * True when the box of glyphs `from`..`to - 1` of `run` (the gaps between them included) shares an
 * area with one of `rects`. The reader uses it per glyph to decide what a hidden area takes out
 * of the text, the writer per stretch so that no show of the text layer it writes runs across a
 * hidden area, and the verifier on the output.
 */
export function glyphsHitRects(run: GlyphRun, from: number, to: number, rects: Rect[]): boolean {
  if (to <= from || rects.length === 0) return false;
  const quad = spanQuad(run, from, to, TOUCH_BELOW, TOUCH_ABOVE);
  return rects.some((r) => quadHitsRect(quad, r));
}

/**
 * The same for a stretch of a baseline: from `from` to `to` user units along the unit vector `u`
 * from point `p`, at text size `size` (`v` is the unit vector up).
 */
export function baselineBoxHitsRects(p: Point, u: Point, v: Point, from: number, to: number, size: number, rects: Rect[]): boolean {
  if (rects.length === 0) return false;
  const at = (along: number, up: number): Point => [p[0] + u[0] * along + v[0] * up, p[1] + u[1] * along + v[1] * up];
  const quad = [at(from, -TOUCH_BELOW * size), at(to, -TOUCH_BELOW * size), at(to, TOUCH_ABOVE * size), at(from, TOUCH_ABOVE * size)];
  return rects.some((r) => quadHitsRect(quad, r));
}

/* ------------------------------------------------------------------ */
/* Edits applied to a base extraction                                   */
/* ------------------------------------------------------------------ */

/** What the reader and the writer need of an extraction as read. */
export interface EditBase {
  plainText: string;
  runs: GlyphRun[];
  pages: PdfPageInfo[];
}

/** A stretch of glyphs of one run that a hidden area takes out. */
export interface DroppedStretch {
  run: GlyphRun;
  from: number;
  to: number;
}

/** Edits worked out against a base extraction. */
export interface ResolvedEdits {
  edits: NormalizedPdfEdits;
  /** The edited text. */
  plainText: string;
  /** The stretches of the base text that stay, in order: `from` in the base text, `to` in the edited one. */
  kept: KeptStretch[];
  /** Removed pages. */
  removed: Set<number>;
  /** Hidden areas by page, without those on removed pages. */
  regions: Map<number, Rect[]>;
  /** The glyphs the hidden areas take out of the text, and the same as stretches of their runs. */
  dropped: Set<Glyph>;
  stretches: DroppedStretch[];
}

/**
 * Work out `edits` against the extraction as read: which glyphs the hidden areas touch, and the
 * text without them and without the removed pages. A pure function of its arguments.
 *
 * What a hidden area takes: every glyph whose box it touches; of an OCR layer the whole word
 * (the layer knows where a word is, not its letters); of text only pdf.js could read one glyph
 * more on each side (its letter widths are estimates) and a vertical item whole. Text inside a
 * tiling pattern or a soft mask has no place on the page (`GlyphRun.space`) and is never taken.
 * Where taking text out would join two words ("Anna [Maria] Nowak"), one space stays.
 */
export function resolvePdfEdits(base: EditBase, edits: PdfEdits): ResolvedEdits {
  const normal = normalizePdfEdits(edits, base.pages.length);
  const removed = new Set(normal.removedPages);
  const regions = new Map<number, Rect[]>();
  for (const r of normal.regions) {
    if (removed.has(r.page)) continue;
    const list = regions.get(r.page) ?? [];
    list.push(r.rect);
    regions.set(r.page, list);
  }
  const text = base.plainText;
  const drop = new Uint8Array(text.length);

  // Removed pages: the page's text and the break after it (up to where the next page starts).
  base.pages.forEach((page, p) => {
    if (!removed.has(p)) return;
    const end = p + 1 < base.pages.length ? base.pages[p + 1].textStart : text.length;
    drop.fill(1, Math.max(0, page.textStart), Math.min(text.length, end));
  });

  const dropped = new Set<Glyph>();
  const stretches: DroppedStretch[] = [];
  if (regions.size > 0) {
    for (const run of base.runs) {
      const rects = regions.get(run.page);
      if (!rects || run.space || run.glyphs.length === 0) continue;
      const n = run.glyphs.length;
      const hit = new Uint8Array(n);
      let any = false;
      if (run.oracle && run.vertical) {
        const box = verticalItemBox(run);
        if (rects.some((r) => Math.min(box.x1, r.x1) > Math.max(box.x0, r.x0) && Math.min(box.y1, r.y1) > Math.max(box.y0, r.y0))) {
          hit.fill(1);
          any = true;
        }
      } else {
        for (let i = 0; i < n; i++) {
          if (glyphsHitRects(run, i, i + 1, rects)) { hit[i] = 1; any = true; }
        }
        if (any && run.ocr) {
          // The whole word of every letter touched.
          for (let i = 0; i < n; i++) {
            if (!hit[i] || run.glyphs[i].unicode.trim() === '') continue;
            for (let j = i - 1; j >= 0 && run.glyphs[j].unicode.trim() !== ''; j--) hit[j] = 1;
            for (let j = i + 1; j < n && run.glyphs[j].unicode.trim() !== ''; j++) hit[j] = 1;
          }
        } else if (any && run.oracle) {
          const grown = hit.slice();
          for (let i = 0; i < n; i++) {
            if (!hit[i]) continue;
            if (i > 0) grown[i - 1] = 1;
            if (i + 1 < n) grown[i + 1] = 1;
          }
          hit.set(grown);
        }
      }
      if (!any) continue;
      let from = -1;
      for (let i = 0; i <= n; i++) {
        const on = i < n && hit[i] === 1;
        if (on) {
          const g = run.glyphs[i];
          dropped.add(g);
          const at = run.textOffsets[i];
          if (at !== undefined && at >= 0 && g.unicode.length > 0) drop.fill(1, at, Math.min(text.length, at + g.unicode.length));
          if (from < 0) from = i;
        } else if (from >= 0) {
          stretches.push({ run, from, to: i });
          from = -1;
        }
      }
    }
  }

  // The text that stays, stretch by stretch.
  const parts: string[] = [];
  const kept: KeptStretch[] = [];
  let length = 0;
  let lastChar = '';
  for (let i = 0; i < text.length;) {
    if (drop[i]) { i++; continue; }
    let j = i + 1;
    while (j < text.length && !drop[j]) j++;
    // One space where the text taken out stood between two words.
    if (i > 0 && lastChar !== '' && !/\s/.test(lastChar) && !/\s/.test(text[i])) {
      parts.push(' ');
      length += 1;
    }
    parts.push(text.slice(i, j));
    kept.push({ from: i, to: length, length: j - i });
    length += j - i;
    lastChar = text[j - 1];
    i = j;
  }
  return { edits: normal, plainText: parts.join(''), kept, removed, regions, dropped, stretches };
}

/** Index of the last stretch whose `key` is at most `value`, or -1. */
function lastAtMost(kept: KeptStretch[], key: 'from' | 'to', value: number): number {
  let lo = 0;
  let hi = kept.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (kept[mid][key] <= value) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

/**
 * Where a range of the old text is in the new one: the new range when all of it is still there
 * in one piece (it lies inside one kept stretch), else null (part of it is gone: the detection
 * it came from no longer holds).
 */
export function mapKeptRange(kept: KeptStretch[], start: number, end: number): { start: number; end: number } | null {
  if (!(end >= start)) return null;
  const i = lastAtMost(kept, 'from', start);
  if (i < 0) return null;
  const s = kept[i];
  if (end > s.from + s.length) return null;
  return { start: s.to + (start - s.from), end: s.to + (end - s.from) };
}

/**
 * The pieces of the base text a range of the edited text stands for, in order (a range that
 * runs over a place where text was taken out comes back in two pieces).
 */
export function editedRangeToBase(kept: KeptStretch[], start: number, end: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = Math.max(0, lastAtMost(kept, 'to', start)); i < kept.length && kept[i].to < end; i++) {
    const s = kept[i];
    const a = Math.max(start, s.to);
    const b = Math.min(end, s.to + s.length);
    if (b > a) out.push([s.from + (a - s.to), s.from + (b - s.to)]);
  }
  return out;
}

/** Edited offset of the kept text at or after base offset `o` (the text's end when nothing follows). */
function startAt(r: ResolvedEdits, o: number): number {
  const i = lastAtMost(r.kept, 'from', o);
  if (i >= 0 && o < r.kept[i].from + r.kept[i].length) return r.kept[i].to + (o - r.kept[i].from);
  return i + 1 < r.kept.length ? r.kept[i + 1].to : r.plainText.length;
}

/** Edited offset where the kept text before base offset `o` ends. */
function endAt(r: ResolvedEdits, o: number): number {
  const i = lastAtMost(r.kept, 'from', o - 1);
  if (i < 0) return 0;
  return r.kept[i].to + Math.min(o - r.kept[i].from, r.kept[i].length);
}

/** Extractions made by applyPdfEdits and what their edits resolved to (so the next edit need not work it out again). */
const resolvedOf = new WeakMap<PdfExtraction, ResolvedEdits>();

/**
 * Apply the full set of hand edits to an extraction and return the new one. `edits` replaces
 * whatever edits the extraction carries: `applyPdfEdits(x, {})` gives back the extraction as
 * read. Nothing is read again (no pdf.js, no OCR): the extraction keeps what was read
 * (`unedited`), and the edits are worked out against that.
 */
export function applyPdfEdits(extraction: PdfExtraction, edits: PdfEdits): PdfEditResult {
  if (extraction.edits && !extraction.unedited) {
    throw new Error('the extraction carries edits but not the extraction as read (unedited)');
  }
  const base = extraction.unedited ?? extraction;
  const whole: KeptStretch[] = base.plainText.length > 0 ? [{ from: 0, to: 0, length: base.plainText.length }] : [];
  const before = extraction.unedited && extraction.edits
    ? resolvedOf.get(extraction) ?? resolvePdfEdits(base, extraction.edits)
    : null;
  if (before && before.plainText !== extraction.plainText) {
    throw new Error('the extraction does not hold the text its edits give; apply edits to an extraction as applyPdfEdits or readPdf returned it');
  }
  const normal = normalizePdfEdits(edits, base.pages.length);
  const after = isEmptyEdits(normal) ? null : resolvePdfEdits(base, normal);

  // Old text to new text: the stretches of the base text that both keep.
  const oldKept = before ? before.kept : whole;
  const newKept = after ? after.kept : whole;
  const kept: KeptStretch[] = [];
  let shared = 0;
  for (let i = 0, j = 0; i < oldKept.length && j < newKept.length;) {
    const a = oldKept[i];
    const b = newKept[j];
    const s = Math.max(a.from, b.from);
    const e = Math.min(a.from + a.length, b.from + b.length);
    if (e > s) {
      const piece = { from: a.to + (s - a.from), to: b.to + (s - b.from), length: e - s };
      const last = kept[kept.length - 1];
      if (last && last.from + last.length === piece.from && last.to + last.length === piece.to) last.length += piece.length;
      else kept.push(piece);
      shared += e - s;
    }
    if (a.from + a.length <= b.from + b.length) i++;
    else j++;
  }
  const newLength = newKept.reduce((n, s) => n + s.length, 0);

  let out: PdfExtraction;
  if (!after) {
    out = base;
  } else {
    out = editedExtraction(base, after);
    resolvedOf.set(out, after);
  }
  return { extraction: out, kept, addedText: newLength > shared, covered: after ? coveredBoxes(after) : [] };
}

/** The extraction a host works with: text, pages, runs and notes of the base without what the edits take out. */
function editedExtraction(base: PdfExtraction, r: ResolvedEdits): PdfExtraction {
  const runs: GlyphRun[] = [];
  for (const run of base.runs) {
    if (r.removed.has(run.page)) continue;
    const touched = r.regions.has(run.page) && run.glyphs.some((g) => r.dropped.has(g));
    const glyphs: Glyph[] = touched ? [] : run.glyphs;
    const textOffsets: number[] = [];
    const advances: number[] = touched ? [] : run.local.advances;
    let textStart = Infinity;
    let textEnd = -Infinity;
    run.glyphs.forEach((g, i) => {
      if (touched && r.dropped.has(g)) return;
      const at = startAt(r, run.textOffsets[i]);
      if (touched) {
        glyphs.push(g);
        advances.push(run.local.advances[i]);
      }
      textOffsets.push(at);
      textStart = Math.min(textStart, at);
      textEnd = Math.max(textEnd, at + g.unicode.length);
    });
    // A run whose every glyph is hidden is not on the page any more.
    if (touched && glyphs.length === 0) continue;
    if (!Number.isFinite(textStart)) { textStart = startAt(r, run.textStart); textEnd = textStart; }
    runs.push({ ...run, glyphs, textOffsets, textStart, textEnd, local: touched ? { ...run.local, advances } : run.local });
  }
  const pages: PdfPageInfo[] = base.pages.map((page, p) => {
    if (r.removed.has(p)) {
      const at = endAt(r, page.textStart);
      return { ...page, removed: true, textStart: at, textEnd: at };
    }
    const textStart = startAt(r, page.textStart);
    return { ...page, textStart, textEnd: Math.max(textStart, endAt(r, page.textEnd)) };
  });

  const pagesOf = (u: UnredactablePart): number[] => {
    const m = /^pages? (\d+)(?:-(\d+))?$/.exec(u.part);
    if (!m) return [];
    const out: number[] = [];
    for (let p = Number(m[1]) - 1; p <= Number(m[2] ?? m[1]) - 1; p++) out.push(p);
    return out;
  };
  // A part is kept while one of its pages is; with the list per page, the ranges are built again.
  const stays = (u: UnredactablePart): boolean => {
    const on = pagesOf(u);
    return on.length === 0 || on.some((p) => !r.removed.has(p));
  };
  const unredactable = (base.unredactablePages ?? base.unredactable).filter(stays).map((u) => ({ ...u }));
  if (base.unredactablePages) aggregatePageParts(unredactable);

  const warnings = base.warnings.filter((w) => {
    const m = /^page (\d+):/.exec(w);
    return !(m && r.removed.has(Number(m[1]) - 1));
  });
  for (const p of [...r.regions.keys()].sort((a, b) => a - b)) {
    if (base.runs.some((run) => run.page === p && run.space)) {
      warnings.push(`page ${p + 1}: text inside a pattern or a soft mask has no place on the page; a hidden area does not take it out of the text`);
    }
  }

  const { unredactablePages: _perPage, ...rest } = base;
  void _perPage;
  return {
    ...rest,
    plainText: r.plainText,
    pages,
    runs,
    unredactable,
    warnings,
    empty: runs.every((run) => run.glyphs.every((g) => g.unicode.trim() === '')),
    rasterOnlyPages: base.rasterOnlyPages.filter((p) => !r.removed.has(p)),
    edits: { removedPages: [...r.edits.removedPages], regions: r.edits.regions.map((x) => ({ page: x.page, rect: { ...x.rect } })) },
    unedited: base,
  };
}

/** The box of every stretch of glyphs the hidden areas take out, as a host is told. */
function coveredBoxes(r: ResolvedEdits): PdfRegion[] {
  return r.stretches.map(({ run, from, to }) => ({
    page: run.page,
    rect: run.oracle && run.vertical ? verticalItemBox(run) : boundsOf(spanQuad(run, from, to, COVER_BELOW, COVER_ABOVE)),
  }));
}
