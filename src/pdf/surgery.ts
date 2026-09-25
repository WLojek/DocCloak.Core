/**
 * @doccloak/core/pdf - content-stream surgery (T213).
 *
 * Turns flat-text replacements into operator-level edits and rewrites the
 * affected content streams:
 *
 * - the glyphs of a redacted span are cut out of their text-showing operator
 *   (string operands are split at code boundaries; kerning numbers between
 *   kept glyphs are preserved, numbers adjacent to removed glyphs are dropped);
 * - the placeholder is written as a new show in the original font when that
 *   font can encode it, else in the matched fallback face, sized by fit.ts;
 * - every show after an edited one in the same positioning scope is
 *   re-anchored with an absolute Tm computed from the ORIGINAL geometry, so
 *   the implicit advance chain cannot shift (and the residual positions of
 *   surviving glyphs cannot encode what was removed);
 * - when the placeholder is wider than the gap even after shrinking, the rest
 *   of the line (in the same stream) moves right by the overflow;
 * - the line matrix is restored before the next relative positioning
 *   operator, so later lines land exactly where they did.
 *
 * Operators that are not touched are copied byte-for-byte.
 */

import type { ContentOp, Operand } from './lexer.ts';
import { TEXT_POSITION_OPS, TEXT_SHOW_OPS, array, hexString, makeOp, name, num } from './lexer.ts';
import { serializeOps } from './serializer.ts';
import { StateMachine, initialState, mul, translate } from './textstate.ts';
import type { GlyphRun, Matrix, PlaceholderFit } from './types.ts';
import type { LoadedFont } from './fonts.ts';
import type { StreamRecord, PdfModel } from './extract.ts';
import { loadFont } from './fonts.ts';
import { getDict } from './objects.ts';
import { fitPlaceholder } from './fit.ts';
import type { FitResult } from './fit.ts';

export interface Replacement {
  start: number;
  end: number;
  replacement: string;
}

/** A placeholder resolved to concrete bytes in a concrete font resource. */
export interface PlaceholderSpec {
  text: string;
  bytes: Uint8Array;
  /** Resource name (in the stream's /Resources /Font) of the font to show it with. */
  resourceName: string;
  /** True when the original font is reused (no resource to add). */
  originalFont: boolean;
  fit: FitResult;
  /** Codes shown in the original font (for ToUnicode scrubbing); empty for fallback fonts. */
  codes: number[];
  /**
   * Negative when the placeholder is narrower than the gap: the text that
   * follows in the same positioning chain moves left by this much (unscaled
   * text space of the run) so no hole is left before the next word. Zero
   * otherwise (overflow is handled line-wide through LineShift).
   */
  slack: number;
}

/** One contiguous glyph range of one run that a replacement covers. */
export interface Segment {
  run: GlyphRun;
  /** Glyph index range [from, to). */
  from: number;
  to: number;
  /** Set on the first segment of a replacement: the placeholder to show there. */
  placeholder?: PlaceholderSpec;
  replacementIndex: number;
  /** True when this segment is the only one of its replacement (its codes are the complete value in one run). */
  whole?: boolean;
  /**
   * Set on the segment where the replacement's gap ends: how far the glyphs
   * after it in the same run move (unscaled text space of the run; negative
   * closes the slack of a narrow placeholder, positive pushes an overflow).
   */
  shiftAfter?: number;
}

/** Key of a run inside a plan: stream key + operator index. */
export function runKey(run: GlyphRun): string {
  return `${run.streamKey}#${run.opIndex}`;
}

/**
 * Adjacent text on the same line as a gap: within this many em of the previous run's end it still
 * moves; a tab stop or table column sits further away and never moves. (A line that STARTS with
 * the tail of a wrapped value is prose, and closes up as a whole: see planEdits.)
 */
const ADJACENCY_EM = 0.75;
/** On a line that starts with the tail of a wrapped value, justified word gaps still chain; a tab or a far column does not. */
const CONTINUATION_ADJACENCY_EM = 3;
/** Kept between a pushed run and the next column to its right (em). */
const COLUMN_MARGIN_EM = 0.25;

/**
 * Resolve a font for a placeholder: returns the encoded bytes with the
 * original font, or asks the host for a fallback (which must already be
 * embedded so its bytes are final).
 */
export interface PlaceholderResolver {
  (font: LoadedFont, text: string, streamKey: string): Promise<{
    bytes: Uint8Array;
    widthPerEm: number;
    resourceName: string;
    originalFont: boolean;
    codes: number[];
  }>;
}

/* ------------------------------------------------------------------ */
/* 1. Replacements -> segments                                          */
/* ------------------------------------------------------------------ */

/** Glyph text range in the flat text: [offset, offset + unicode.length). */
function glyphRange(run: GlyphRun, i: number): [number, number] {
  const off = run.textOffsets[i];
  return [off, off + run.glyphs[i].unicode.length];
}

/**
 * Map flat-text replacements to per-run glyph segments. Runs must be in
 * flat-text order (as the extractor produced them). Oracle runs (raster-only
 * pages) are returned as segments too; the caller routes them to the
 * rasterizer.
 */
export function segmentsFor(runs: GlyphRun[], replacements: Replacement[]): Segment[] {
  const out: Segment[] = [];
  const sorted = [...replacements].sort((a, b) => a.start - b.start || a.end - b.end);
  let runIdx = 0;
  sorted.forEach((r, ri) => {
    // Runs are ordered by textStart; skip runs that end before this replacement.
    while (runIdx < runs.length && runs[runIdx].textEnd <= r.start) runIdx++;
    for (let k = runIdx; k < runs.length && runs[k].textStart < r.end; k++) {
      const run = runs[k];
      let from = -1;
      let to = -1;
      for (let i = 0; i < run.glyphs.length; i++) {
        const [a, b] = glyphRange(run, i);
        const covered = b > a ? a < r.end && b > r.start : (from >= 0 && a >= r.start && a < r.end);
        if (covered) {
          if (from < 0) from = i;
          to = i + 1;
        } else if (from >= 0 && b > a && a >= r.end) {
          break;
        }
      }
      if (from >= 0) out.push({ run, from, to, replacementIndex: ri });
    }
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* 2. Geometry helpers                                                  */
/* ------------------------------------------------------------------ */

/** User units per unscaled text-space unit along the baseline of a run. */
export function unitScale(run: GlyphRun): number {
  const em = Math.hypot(run.emX[0], run.emX[1]);
  const denom = run.local.fontSize * run.local.hscale;
  return denom !== 0 ? em / denom : 1;
}

/** Position of a glyph origin along/across the baseline of a reference run, in user units. */
/** Origin-independent projection of (x, y) on the baseline direction of `ref`, in user units. */
function alongAbs(ref: GlyphRun, x: number, y: number): number {
  const ex = ref.emX[0];
  const ey = ref.emX[1];
  const len = Math.hypot(ex, ey) || 1;
  return (x * ex + y * ey) / len;
}

/**
 * T225: the farthest text end on the page along the baseline direction of `ref` (absolute
 * projection): a proxy for the right margin. Text after a placeholder may move up to here, so a
 * left-aligned line with room keeps the placeholder at full size while a line that already
 * reaches the margin (right-aligned, justified) still shrinks. Cached per direction.
 */
function pageTextEdge(page: PageRuns, ref: GlyphRun): number {
  const refLen = Math.hypot(ref.emX[0], ref.emX[1]) || 1;
  const key = `${Math.round((ref.emX[0] / refLen) * 1000)},${Math.round((ref.emX[1] / refLen) * 1000)}`;
  const cached = page.edges.get(key);
  if (cached !== undefined) return cached;
  let edge = -Infinity;
  let minAcross = Infinity;
  let maxAcross = -Infinity;
  for (const r of page.all) {
    const len = Math.hypot(r.emX[0], r.emX[1]) || 1;
    const cos = (r.emX[0] * ref.emX[0] + r.emX[1] * ref.emX[1]) / (len * refLen);
    if (cos < 0.996) continue;
    const [ex, ey] = glyphEnd(r, r.glyphs.length - 1);
    edge = Math.max(edge, alongAbs(ref, ex, ey));
    const g = r.glyphs[0];
    const across = (g.x * -ref.emX[1] + g.y * ref.emX[0]) / refLen;
    minAcross = Math.min(minAcross, across);
    maxAcross = Math.max(maxAcross, across);
  }
  page.edges.set(key, edge);
  const size = Math.hypot(ref.emY[0], ref.emY[1]) || ref.glyphs[0]?.fontSize || 1;
  page.edges.set(`${key}|lines`, maxAcross - minAcross > 0.45 * Math.max(size, 1) ? 2 : 1);
  return edge;
}

/** True when the page has text on more than one line in the direction of `ref` (see pageTextEdge). */
function hasOtherLines(page: PageRuns, ref: GlyphRun): boolean {
  pageTextEdge(page, ref);
  const refLen = Math.hypot(ref.emX[0], ref.emX[1]) || 1;
  const key = `${Math.round((ref.emX[0] / refLen) * 1000)},${Math.round((ref.emX[1] / refLen) * 1000)}|lines`;
  return (page.edges.get(key) ?? 1) > 1;
}

/**
 * Absolute projection of the end of the line through (refX, refY), every shift already planned
 * on it included: whole-run shifts of its last run and, when that run holds earlier gaps of this
 * plan (one Tj per line, several values on it), the tail shifts recorded on those segments.
 * -Infinity when the line has no run.
 */
function lineEndAbs(page: PageRuns, ref: GlyphRun, refX: number, refY: number, tol: number, shiftedRuns: Map<string, number>, segments: Segment[]): number {
  let lineEnd = -Infinity;
  let last: GlyphRun | null = null;
  for (const r of runsOnLine(page, ref, refX, refY, tol)) {
    if (r.endAlong > lineEnd) { lineEnd = r.endAlong; last = r.run; }
  }
  if (last === null) return -Infinity;
  let shift = shiftedRuns.get(runKey(last)) ?? 0;
  for (const s of segments) if (s.run === last && s.shiftAfter) shift += s.shiftAfter * unitScale(last);
  return alongAbs(ref, refX, refY) + lineEnd + shift;
}

/**
 * T225: user units the text at the end of the line through (refX, refY) can still move right
 * before it passes the page's text edge (the farthest line end on the page).
 */
function roomToEdge(page: PageRuns, ref: GlyphRun, refX: number, refY: number, tol: number, shiftedRuns: Map<string, number>, segments: Segment[]): number {
  const edge = pageTextEdge(page, ref);
  const end = lineEndAbs(page, ref, refX, refY, tol, shiftedRuns, segments);
  if (!Number.isFinite(edge) || !Number.isFinite(end)) return 0;
  const size = Math.hypot(ref.emY[0], ref.emY[1]) || ref.glyphs[0]?.fontSize || 1;
  return edge - end - COLUMN_MARGIN_EM * Math.max(size, 1);
}

/**
 * User units the line can still move right before it leaves the page (horizontal runs in page
 * space only; the MediaBox is taken to start at x = 0). null when unknown (forms, rotated text).
 */
function roomToPageEdge(model: PdfModel, page: PageRuns, ref: GlyphRun, refX: number, refY: number, tol: number, shiftedRuns: Map<string, number>, segments: Segment[]): number | null {
  if (!isHorizontal(ref) || !ref.streamKey.startsWith('p')) return null;
  const width = model.pages[ref.page]?.info.width;
  if (!(width > 0)) return null;
  const end = lineEndAbs(page, ref, refX, refY, tol, shiftedRuns, segments);
  if (!Number.isFinite(end)) return null;
  const size = Math.hypot(ref.emY[0], ref.emY[1]) || ref.glyphs[0]?.fontSize || 1;
  return width - end - COLUMN_MARGIN_EM * Math.max(size, 1);
}

function projectOnto(ref: GlyphRun, refX: number, refY: number, x: number, y: number): { along: number; across: number } {
  const ex = ref.emX[0];
  const ey = ref.emX[1];
  const len = Math.hypot(ex, ey) || 1;
  const dx = x - refX;
  const dy = y - refY;
  return { along: (dx * ex + dy * ey) / len, across: (dx * -ey + dy * ex) / len };
}

function glyphEnd(run: GlyphRun, i: number): [number, number] {
  const g = run.glyphs[i];
  const scale = unitScale(run);
  const ex = run.emX[0];
  const ey = run.emX[1];
  const len = Math.hypot(ex, ey) || 1;
  return [g.x + (ex / len) * g.advance * scale, g.y + (ey / len) * g.advance * scale];
}

interface LineRun { run: GlyphRun; startAlong: number; endAlong: number }

/** Non-oracle runs with glyphs, grouped by page (built once per plan). */
/** Runs of one page (and coordinate space), with horizontal runs bucketed by baseline for fast same-line lookups. */
interface PageRuns {
  all: GlyphRun[];
  /** Horizontal runs keyed by round(y / BUCKET); rotated runs are only in `all`. */
  byBaseline: Map<number, GlyphRun[]>;
  rotated: GlyphRun[];
  /** Farthest text end on the page per baseline direction (absolute projection), see pageTextEdge. */
  edges: Map<string, number>;
}

const BUCKET = 4;

function isHorizontal(run: GlyphRun): boolean {
  return Math.abs(run.emX[1]) <= 1e-6 * Math.max(1, Math.abs(run.emX[0])) && run.emX[0] > 0;
}

function runsByPage(runs: GlyphRun[]): Map<string, PageRuns> {
  const out = new Map<string, PageRuns>();
  for (const r of runs) {
    if (r.oracle || r.glyphs.length === 0) continue;
    const key = spaceKey(r);
    let page = out.get(key);
    if (!page) {
      page = { all: [], byBaseline: new Map(), rotated: [], edges: new Map() };
      out.set(key, page);
    }
    page.all.push(r);
    if (isHorizontal(r)) {
      const b = Math.round(r.glyphs[0].y / BUCKET);
      const list = page.byBaseline.get(b) ?? [];
      list.push(r);
      page.byBaseline.set(b, list);
    } else {
      page.rotated.push(r);
    }
  }
  return out;
}

/** Candidate runs for a line through (refX, refY) with tolerance `tol`: the baseline buckets around refY plus every rotated run. */
function candidatesOnLine(page: PageRuns, ref: GlyphRun, refY: number, tol: number): GlyphRun[] {
  if (!isHorizontal(ref)) return page.all;
  const lo = Math.round((refY - tol) / BUCKET) - 1;
  const hi = Math.round((refY + tol) / BUCKET) + 1;
  const out: GlyphRun[] = [];
  for (let b = lo; b <= hi; b++) {
    const list = page.byBaseline.get(b);
    if (list) for (const r of list) out.push(r);
  }
  for (const r of page.rotated) out.push(r);
  return out;
}

const EMPTY_PAGE: PageRuns = { all: [], byBaseline: new Map(), rotated: [], edges: new Map() };

/** Runs share lines only within one page and one coordinate space (page, pattern cell, mask group). */
function spaceKey(run: GlyphRun): string {
  return `${run.page}|${run.space ?? ''}`;
}

/**
 * Runs that lie on the same line as the reference (same baseline direction, first glyph and run
 * end within the tolerance of the baseline), ordered along it. A rotated line crossing horizontal
 * text picks up nothing: a run merely touching the line at one point is not on it.
 */
function runsOnLine(pageRuns: PageRuns, ref: GlyphRun, refX: number, refY: number, tol: number): LineRun[] {
  const out: LineRun[] = [];
  const refLen = Math.hypot(ref.emX[0], ref.emX[1]) || 1;
  for (const r of candidatesOnLine(pageRuns, ref, refY, tol)) {
    const len = Math.hypot(r.emX[0], r.emX[1]) || 1;
    const cos = (r.emX[0] * ref.emX[0] + r.emX[1] * ref.emX[1]) / (len * refLen);
    if (cos < 0.996) continue; // baselines differ by more than about 5 degrees
    const g = r.glyphs[0];
    const p = projectOnto(ref, refX, refY, g.x, g.y);
    if (Math.abs(p.across) > tol) continue;
    const [ex, ey] = glyphEnd(r, r.glyphs.length - 1);
    const pe = projectOnto(ref, refX, refY, ex, ey);
    if (Math.abs(pe.across) > tol) continue;
    out.push({ run: r, startAlong: p.along, endAlong: pe.along });
  }
  out.sort((a, b) => a.startAlong - b.startAlong);
  return out;
}

/* ------------------------------------------------------------------ */
/* 3. Placeholder planning                                              */
/* ------------------------------------------------------------------ */

export interface Plan {
  /** Segments grouped by stream key; each stream's segments sorted by (opIndex, from). */
  byStream: Map<string, Segment[]>;
  /** Runs that move as a whole (run key -> shift in user units along their baseline). */
  shiftedRuns: Map<string, number>;
  /** Fallback resource names needed per stream key. */
  resourcesNeeded: Map<string, Set<string>>;
  shiftedLines: number;
  warnings: string[];
}

/**
 * The segment that should carry the placeholder: the first segment of the line group whose gap
 * (first covered glyph to the end of the last covered glyph on that line) is the widest. Ties and
 * anything unusual (many segments, raster runs) keep the first segment.
 */
function widestLineLead(segs: Segment[]): Segment {
  // Chrome shows one glyph per Tj, so a wrapped value can easily be a few dozen segments.
  if (segs.length <= 1 || segs.length > 64 || segs.some((s) => s.run.oracle)) return segs[0];
  let best = segs[0];
  let bestWidth = -Infinity;
  for (const lead of segs) {
    const run = lead.run;
    const g0 = run.glyphs[lead.from];
    const tol = 0.45 * Math.max(g0.fontSize, 1);
    let width = 0;
    for (const s of segs) {
      if (s.run.page !== run.page || spaceKey(s.run) !== spaceKey(run)) continue;
      const gs = s.run.glyphs[s.from];
      if (Math.abs(projectOnto(run, g0.x, g0.y, gs.x, gs.y).across) > tol) continue;
      const [ex, ey] = glyphEnd(s.run, s.to - 1);
      const pe = projectOnto(run, g0.x, g0.y, ex, ey);
      if (Math.abs(pe.across) <= tol) width = Math.max(width, pe.along);
    }
    // Strictly wider wins, so equal widths keep flat-text order.
    if (width > bestWidth + 0.5) { best = lead; bestWidth = width; }
  }
  return best;
}

/**
 * Decide, for every replacement, where the placeholder goes and how it is
 * fitted. The first segment (flat-text order) carries the placeholder; other
 * segments are excised. The gap is the width of every segment of the same
 * replacement that sits on the same line as the first, so a name split over
 * two shows on one line gets the whole width.
 */
export async function planEdits(
  model: PdfModel,
  allRuns: GlyphRun[],
  segments: Segment[],
  replacements: Replacement[],
  resolve: PlaceholderResolver,
  fitPolicy: PlaceholderFit = {},
): Promise<Plan> {
  const byReplacement = new Map<number, Segment[]>();
  for (const s of segments) {
    const list = byReplacement.get(s.replacementIndex) ?? [];
    list.push(s);
    byReplacement.set(s.replacementIndex, list);
  }
  const sortedReplacements = [...replacements].sort((a, b) => a.start - b.start || a.end - b.end);
  const byPage = runsByPage(allRuns);
  const shiftedRuns = new Map<string, number>();
  const resourcesNeeded = new Map<string, Set<string>>();
  const warnings: string[] = [];
  let shiftedLines = 0;

  for (const [ri, segs] of byReplacement) {
    // T225: of a value wrapped over several lines, the widest line group carries the placeholder
    // (before: always the first). A value whose first line holds only "ul." would otherwise get
    // the whole placeholder squeezed into three glyphs at a line end, pushed past the margin.
    const first = widestLineLead(segs);
    if (segs.length === 1) first.whole = true;
    if (first.run.oracle) continue; // raster pages: no placeholder in a stream
    const text = sortedReplacements[ri].replacement;
    const run = first.run;
    const font = model.fonts.get(run.fontKey);
    if (!font) {
      warnings.push(`placeholder for a run without a loaded font (${run.streamKey}#${run.opIndex})`);
      continue;
    }

    // Gap: from the first covered glyph to the end of the last covered glyph on the same line.
    const g0 = run.glyphs[first.from];
    const refX = g0.x;
    const refY = g0.y;
    const tol = 0.45 * Math.max(g0.fontSize, 1);
    let endAlong = 0;
    let lastSeg: Segment = first;
    const onFirstLine = new Set<Segment>([first]);
    for (const s of segs) {
      if (s.run.page !== run.page) continue;
      const gs = s.run.glyphs[s.from];
      const p = projectOnto(run, refX, refY, gs.x, gs.y);
      if (Math.abs(p.across) > tol) continue;
      onFirstLine.add(s);
      const [ex, ey] = glyphEnd(s.run, s.to - 1);
      const pe = projectOnto(run, refX, refY, ex, ey);
      if (pe.along >= endAlong) {
        endAlong = pe.along;
        lastSeg = s;
      }
    }
    const scale = unitScale(run);
    const gapText = endAlong / scale; // unscaled text space of the first run

    const resolved = await resolve(font, text, run.streamKey);
    const pageRuns = byPage.get(spaceKey(run)) ?? EMPTY_PAGE;
    let fit = fitPlaceholder(
      { gap: gapText, fontSize: run.local.fontSize, hscale: run.local.hscale, widthPerEm: resolved.widthPerEm },
      fitPolicy,
    );
    // Room before the next column (null = no text after the line's chain). With no column the
    // hard limit is the page's text edge (Chrome and Word clip their content boxes, so text
    // pushed past the margin is cut), or the page edge on a single-line page.
    let column: number | null = null;
    let hard: number | null = null;
    if (fit.stage !== 'fits') {
      // T225: a line with room moves before the placeholder shrinks. The rest of the line may go
      // as far as the next column and the page's text edge allow; only what does not fit in the
      // gap plus that room is shrunk (then condensed), and the line still moves by the rest.
      column = roomOnLine(pageRuns, run, refX, refY, tol, endAlong, lastSeg, shiftedRuns, segments);
      const edge = hasOtherLines(pageRuns, run)
        ? roomToEdge(pageRuns, run, refX, refY, tol, shiftedRuns, segments)
        : (roomToPageEdge(model, pageRuns, run, refX, refY, tol, shiftedRuns, segments) ?? roomToEdge(pageRuns, run, refX, refY, tol, shiftedRuns, segments));
      hard = column ?? edge;
      const room = Math.max(0, Math.min(column ?? Infinity, edge));
      if (room > 0.01) {
        fit = fitPlaceholder(
          { gap: gapText + room / scale, fontSize: run.local.fontSize, hscale: run.local.hscale, widthPerEm: resolved.widthPerEm },
          fitPolicy,
        );
        fit = { ...fit, overflow: Math.max(0, fit.width - gapText) };
      }
    }
    if (fit.overflow > 0) {
      // The rest of the line can only move as far as the next column (text beyond the adjacency
      // chain) or the text edge allows; past that the placeholder gives up its floors rather than
      // overlap the column or be clipped at the margin.
      const room = hard;
      if (room !== null && fit.overflow * scale > room) {
        // Never below 4 pt on the page: a smaller placeholder is unreadable; past that the tail
        // may overlap the column (reported through `shiftedLines` and the warnings).
        const sizeUser = Math.hypot(run.emY[0], run.emY[1]) || run.local.fontSize;
        const minRatio = Math.min(1, Math.max(0.05, 4 / Math.max(sizeUser, 0.01)));
        fit = fitPlaceholder(
          { gap: gapText + Math.max(0, room) / scale, fontSize: run.local.fontSize, hscale: run.local.hscale, widthPerEm: resolved.widthPerEm },
          { ...fitPolicy, minSizeRatio: minRatio, minHorizontalScale: 0.5, allowOverflow: true },
        );
        const overflow = Math.max(0, fit.width - gapText);
        fit = { ...fit, overflow: Math.min(overflow, Math.max(0, room) / scale) };
        if (overflow * scale > Math.max(0, room) + 0.01) warnings.push(`placeholder "${text}" on page ${run.page + 1} is wider than the room before the next column`);
      }
    }
    first.placeholder = {
      text,
      bytes: resolved.bytes,
      resourceName: resolved.resourceName,
      originalFont: resolved.originalFont,
      fit,
      codes: resolved.codes,
      slack: Math.min(0, fit.width - gapText),
    };
    if (!resolved.originalFont) {
      const set = resourcesNeeded.get(run.streamKey) ?? new Set<string>();
      set.add(resolved.resourceName);
      resourcesNeeded.set(run.streamKey, set);
    }

    // Delta of the line: the placeholder is narrower (slack < 0) or wider (overflow > 0) than the gap.
    const deltaText = fit.width > gapText ? fit.overflow : fit.width - gapText;
    if (fit.overflow > 0) shiftedLines++;
    shiftLine(pageRuns, run, refX, refY, tol, endAlong, lastSeg, deltaText * scale, shiftedRuns);

    // Segments of the same replacement on other lines (a value wrapped at a line end, "Jan\nKowalski"):
    // nothing is shown there, so the text after each of them closes up over the removed glyphs.
    const rest = segs.filter((s) => !onFirstLine.has(s));
    while (rest.length > 0) {
      const lead = rest.shift()!;
      const lg = lead.run.glyphs[lead.from];
      const ltol = 0.45 * Math.max(lg.fontSize, 1);
      let lineEnd = 0;
      let lineLast = lead;
      for (let k = rest.length - 1; k >= -1; k--) {
        const s = k >= 0 ? rest[k] : lead;
        if (s.run.page !== lead.run.page) continue;
        const gs = s.run.glyphs[s.from];
        if (Math.abs(projectOnto(lead.run, lg.x, lg.y, gs.x, gs.y).across) > ltol) continue;
        if (k >= 0) rest.splice(k, 1);
        const [ex, ey] = glyphEnd(s.run, s.to - 1);
        const pe = projectOnto(lead.run, lg.x, lg.y, ex, ey);
        if (pe.along >= lineEnd) {
          lineEnd = pe.along;
          lineLast = s;
        }
      }
      // A continuation line that starts with the removed tail is prose: the whole line closes up,
      // justified word gaps included. Elsewhere only adjacent text moves (a table cell stays put).
      const lineRuns = byPage.get(spaceKey(lead.run)) ?? EMPTY_PAGE;
      const startsLine = lead.from === 0 && !runsOnLine(lineRuns, lead.run, lg.x, lg.y, ltol).some((r) => r.startAlong < -0.5 * ltol);
      shiftLine(lineRuns, lead.run, lg.x, lg.y, ltol, lineEnd, lineLast, -lineEnd, shiftedRuns, startsLine ? CONTINUATION_ADJACENCY_EM : ADJACENCY_EM);
    }
  }

  const byStream = new Map<string, Segment[]>();
  for (const s of segments) {
    if (s.run.oracle) continue;
    const list = byStream.get(s.run.streamKey) ?? [];
    list.push(s);
    byStream.set(s.run.streamKey, list);
  }
  for (const list of byStream.values()) list.sort((a, b) => a.run.opIndex - b.run.opIndex || a.from - b.from);
  return { byStream, shiftedRuns, resourcesNeeded, shiftedLines, warnings };
}

/** The runs to the right of a gap that move with it: chained while no tab-sized hole separates them. */
function chainAfterGap(pageRuns: PageRuns, ref: GlyphRun, refX: number, refY: number, tol: number, gapEndAlong: number, lastSeg: Segment, adjacencyEm = ADJACENCY_EM): { chain: LineRun[]; next: LineRun | null; chainEnd: number } {
  const size = Math.hypot(ref.emY[0], ref.emY[1]) || ref.glyphs[0]?.fontSize || 1;
  const adjacency = adjacencyEm * Math.max(size, 1);
  const lineRuns = runsOnLine(pageRuns, ref, refX, refY, tol)
    .filter((r) => r.run !== lastSeg.run && r.startAlong >= gapEndAlong - 0.5 * adjacency);
  // The run holding the gap end keeps its remaining glyphs (shifted through shiftAfter); the chain
  // continues from where THAT run ends, not from the gap end.
  const [lastEndX, lastEndY] = glyphEnd(lastSeg.run, lastSeg.run.glyphs.length - 1);
  let prevEnd = Math.max(gapEndAlong, projectOnto(ref, refX, refY, lastEndX, lastEndY).along);
  const chain: LineRun[] = [];
  let next: LineRun | null = null;
  for (const r of lineRuns) {
    if (r.startAlong - prevEnd > adjacency) { next = r; break; }
    chain.push(r);
    prevEnd = Math.max(prevEnd, r.endAlong);
  }
  return { chain, next, chainEnd: prevEnd };
}

/**
 * Move everything after a gap on one line by `deltaUser` (user units along the baseline): the
 * remaining glyphs of the run where the gap ends (through `shiftAfter`) and the adjacent runs
 * further right, as long as they chain without a tab-sized hole.
 */
function shiftLine(
  pageRuns: PageRuns,
  ref: GlyphRun,
  refX: number,
  refY: number,
  tol: number,
  gapEndAlong: number,
  lastSeg: Segment,
  deltaUser: number,
  shiftedRuns: Map<string, number>,
  adjacencyEm = ADJACENCY_EM,
): void {
  if (Math.abs(deltaUser) < 0.01) return;
  lastSeg.shiftAfter = (lastSeg.shiftAfter ?? 0) + deltaUser / unitScale(lastSeg.run);
  const { chain } = chainAfterGap(pageRuns, ref, refX, refY, tol, gapEndAlong, lastSeg, adjacencyEm);
  for (const r of chain) shiftedRuns.set(runKey(r.run), (shiftedRuns.get(runKey(r.run)) ?? 0) + deltaUser);
}

/**
 * User units the text after a gap can still move right before it reaches the next column; null
 * when nothing is to its right. Shifts already planned on this line (an earlier placeholder's
 * overflow or slack) are taken into account on both sides.
 */
function roomOnLine(pageRuns: PageRuns, ref: GlyphRun, refX: number, refY: number, tol: number, gapEndAlong: number, lastSeg: Segment, shiftedRuns: Map<string, number>, segments: Segment[]): number | null {
  const { chain, next, chainEnd } = chainAfterGap(pageRuns, ref, refX, refY, tol, gapEndAlong, lastSeg);
  if (!next) return null;
  const size = Math.hypot(ref.emY[0], ref.emY[1]) || ref.glyphs[0]?.fontSize || 1;
  // The run adjacent to the column is the last of the chain (or the gap's own run): its planned
  // shift, positive or negative, is what already stands between the chain end and the column.
  const tail = chain.length > 0 ? chain[chain.length - 1].run : lastSeg.run;
  let chainShift = shiftedRuns.get(runKey(tail)) ?? 0;
  // The tail of the gap's own run already carries every shift planned after earlier segments of
  // that run (two values touching in one show): all of them stand between it and the column.
  if (tail === lastSeg.run) for (const s of segments) if (s.run === lastSeg.run && s.shiftAfter) chainShift += s.shiftAfter * unitScale(lastSeg.run);
  const nextShift = shiftedRuns.get(runKey(next.run)) ?? 0;
  return next.startAlong + nextShift - (chainEnd + chainShift) - COLUMN_MARGIN_EM * Math.max(size, 1);
}

/* ------------------------------------------------------------------ */
/* 4. Stream rewriting                                                  */
/* ------------------------------------------------------------------ */

export interface RewriteResult {
  bytes: Uint8Array;
  /** Codes still shown per font key after the rewrite (for ToUnicode scrubbing). */
  usedCodes: Map<string, Set<number>>;
  /** Original code sequences removed (per font key), for the verifier's byte scan. */
  removedSequences: Array<{ fontKey: string; bytes: Uint8Array; codeLength: number }>;
  /** Fonts whose glyphs were removed. */
  editedFonts: Set<string>;
  edits: number;
}

interface Token {
  kind: 'glyph' | 'adj';
  glyph?: number; // glyph index in the run
  adj?: number;
}

/**
 * Rewrite one stream. `runsByOp` gives the GlyphRun of every text-showing
 * operator (first instance for shared XObjects). `segments` are the edits in
 * this stream. Every unaffected operator is copied verbatim.
 */
export function rewriteStream(
  model: PdfModel,
  stream: StreamRecord,
  runsByOp: Map<number, GlyphRun>,
  segments: Segment[],
  shiftedRuns: Map<string, number>,
): RewriteResult {
  const { ctx } = model;
  const fontsDict = getDict(ctx, stream.resources, 'Font');
  const resolveFont = (n: string): LoadedFont | undefined => loadFont(ctx, fontsDict, n, model.fonts);
  const sm = new StateMachine(initialState());
  const out: ContentOp[] = [];
  const usedCodes = new Map<string, Set<number>>();
  const removedSequences: RewriteResult['removedSequences'] = [];
  const editedFonts = new Set<string>();
  const segsByOp = new Map<number, Segment[]>();
  for (const s of segments) {
    const list = segsByOp.get(s.run.opIndex) ?? [];
    list.push(s);
    segsByOp.set(s.run.opIndex, list);
  }
  let pendingReanchor = false;
  let edits = 0;

  const markUsed = (fontKey: string, codes: Iterable<number>): void => {
    let set = usedCodes.get(fontKey);
    if (!set) {
      set = new Set();
      usedCodes.set(fontKey, set);
    }
    for (const c of codes) set.add(c);
  };

  for (let i = 0; i < stream.ops.length; i++) {
    const op = stream.ops[i];
    if (TEXT_SHOW_OPS.has(op.op)) {
      const run = runsByOp.get(i);
      const segs = segsByOp.get(i) ?? [];
      const shift = run ? (shiftedRuns.get(runKey(run)) ?? 0) / unitScale(run) : 0;
      if (!run || (segs.length === 0 && !pendingReanchor && shift === 0)) {
        // Verbatim; still track state and used codes.
        if (run) markUsed(run.fontKey, run.glyphs.map((g) => g.code));
        if (op.op === "'" || op.op === '"') sm.update(op, resolveFont);
        out.push(op);
        if (run) sm.advanceText(totalAdvance(run));
        continue;
      }
      // Re-emit this run (edited, re-anchored or shifted).
      const emitted = reemitRun(op, run, segs, shift, sm, model, resolveFont);
      for (const e of emitted.ops) out.push(e);
      for (const [k, codes] of emitted.used) markUsed(k, codes);
      for (const rs of emitted.removed) removedSequences.push(rs);
      if (segs.length > 0) editedFonts.add(run.fontKey);
      edits += segs.length;
      sm.advanceText(totalAdvance(run));
      pendingReanchor = true;
      continue;
    }
    if (TEXT_POSITION_OPS.has(op.op) || op.op === 'ET') {
      if (pendingReanchor && op.op !== 'Tm' && op.op !== 'ET') {
        // Restore the line matrix the original stream had here, then apply the op.
        out.push(makeOp('Tm', ...sm.tlm.map((v) => num(v))));
      }
      pendingReanchor = false;
    }
    if (op.op === 'BDC') {
      const scrubbed = scrubMarkedContent(op);
      out.push(scrubbed);
    } else {
      out.push(op);
    }
    sm.update(op, resolveFont);
  }

  return { bytes: serializeOps(out, stream.source), usedCodes, removedSequences, editedFonts, edits };
}

function totalAdvance(run: GlyphRun): number {
  const n = run.glyphs.length;
  if (n === 0) return 0;
  return run.local.advances[n - 1] + run.glyphs[n - 1].advance;
}

/** Remove ActualText / Alt / E from an inline marked-content property dict. */
function scrubMarkedContent(op: ContentOp): ContentOp {
  const props = op.operands[1];
  if (!props || props.kind !== 'dict') return op;
  const keys = ['ActualText', 'Alt', 'E'];
  if (!keys.some((k) => props.entries.has(k))) return op;
  const entries = new Map(props.entries);
  for (const k of keys) entries.delete(k);
  return makeOp('BDC', op.operands[0], { kind: 'dict', entries });
}

interface Emitted {
  ops: ContentOp[];
  used: Map<string, number[]>;
  removed: Array<{ fontKey: string; bytes: Uint8Array; codeLength: number }>;
}

/**
 * Re-emit one text-showing operator as absolute-positioned pieces. `shift`
 * is the line shift (unscaled text space) applying to the whole run (a run
 * to the right of an overflowing placeholder); segment overflow additionally
 * shifts the glyphs after each placeholder inside the run.
 */
function reemitRun(
  op: ContentOp,
  run: GlyphRun,
  segs: Segment[],
  shift: number,
  sm: StateMachine,
  model: PdfModel,
  resolveFont: (n: string) => LoadedFont | undefined,
): Emitted {
  const ops: ContentOp[] = [];
  const used = new Map<string, number[]>();
  const removed: Emitted['removed'] = [];
  const font = model.fonts.get(run.fontKey);
  const t = run.local;

  // Side effects of ' and " first (line advance, spacing), so Tlm is right.
  if (op.op === "'") {
    ops.push(makeOp('T*'));
  } else if (op.op === '"') {
    ops.push(makeOp('Tw', op.operands[0] ?? num(0)));
    ops.push(makeOp('Tc', op.operands[1] ?? num(0)));
    ops.push(makeOp('T*'));
  }
  if (op.op === "'" || op.op === '"') sm.update(op, resolveFont);

  // Tokens of the original operand in order: glyphs and kerning numbers.
  const tokens = tokensOf(op, run);
  const removedSet = new Set<number>();
  for (const s of segs) for (let g = s.from; g < s.to; g++) removedSet.add(g);
  const segAt = new Map<number, Segment>(); // glyph index (segment start) -> segment
  for (const s of segs) segAt.set(s.from, s);

  // Walk tokens, grouping kept glyph runs; emit absolute Tm before each kept group and each placeholder.
  // A shift planned after a segment applies to what lies to the RIGHT of that segment's gap (by
  // advance position), not to what comes later in the array: a TJ may jump back with a positive
  // adjustment and draw earlier text to the left of the gap. A kept glyph is on the right when it
  // starts past the middle of the gap: kerning pulls the next glyph a little into the gap
  // (LibreOffice writes "Müller" 40 ", wohnhaft"), and comparing with the gap end left that comma
  // at its old position, inside the text that moved left to close a narrow placeholder's slack.
  const gapShifts: Array<{ middle: number; shift: number }> = [];
  for (const s of segs) {
    if (!s.shiftAfter) continue;
    const last = run.glyphs[s.to - 1];
    const start = t.advances[s.from];
    const end = t.advances[s.to - 1] + last.advance;
    gapShifts.push({ middle: (start + end) / 2, shift: s.shiftAfter });
  }
  const shiftAt = (glyphIndex: number): number => {
    let total = shift;
    const at = t.advances[glyphIndex];
    for (const g of gapShifts) if (at + 1e-6 >= g.middle) total += g.shift;
    return total;
  };
  let i = 0;
  const tmAt = (glyphIndex: number, offset: number): Matrix => mul(translate(t.advances[glyphIndex] + offset, 0), t.tm);
  const emitTm = (m: Matrix): void => { ops.push(makeOp('Tm', ...m.map((v) => num(v)))); };

  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.kind === 'adj') { i++; continue; } // adjustments outside kept groups are dropped
    const gi = tok.glyph!;
    if (removedSet.has(gi)) {
      // Removed group, one segment at a time (two values can touch without a kept glyph between
      // them): record the original code sequence, emit the placeholder the segment carries.
      const seg = segAt.get(gi);
      let j = i;
      const codes: number[] = [];
      const bytes: number[] = [];
      let glyphCount = 0;
      while (j < tokens.length) {
        const tk = tokens[j];
        if (tk.kind === 'glyph') {
          if (!removedSet.has(tk.glyph!)) break;
          if (tk.glyph !== gi && segAt.has(tk.glyph!)) break; // next segment starts here
          const g = run.glyphs[tk.glyph!];
          codes.push(g.code);
          for (let k = g.codeLength - 1; k >= 0; k--) bytes.push((g.code >> (8 * k)) & 0xff);
          glyphCount++;
        }
        j++;
      }
      // Only the complete code sequence of a whole value is reported for the verifier's byte scan:
      // a fragment of a value split over two shows (" Kowalski") legitimately occurs elsewhere.
      if (font && bytes.length > 0 && seg?.whole && glyphCount === seg.to - seg.from) removed.push({ fontKey: run.fontKey, bytes: Uint8Array.from(bytes), codeLength: run.glyphs[gi].codeLength });
      if (seg?.placeholder) {
        const ph = seg.placeholder;
        emitTm(tmAt(gi, shiftAt(gi)));
        emitPlaceholder(ops, ph, run, font);
        if (ph.originalFont) {
          const arr = used.get(run.fontKey) ?? [];
          for (const c of ph.codes) arr.push(c);
          used.set(run.fontKey, arr);
        }
      }
      i = j;
      continue;
    }
    // Kept group: glyphs (and adjustments between them) until the next removed glyph.
    const items: Operand[] = [];
    let pending: number[] = [];
    const startGlyph = gi;
    const groupShift = shiftAt(startGlyph);
    let j = i;
    const flush = (): void => {
      if (pending.length) { items.push(hexString(Uint8Array.from(pending))); pending = []; }
    };
    let adjSum = 0; // consecutive adjustment numbers add up
    while (j < tokens.length) {
      const tk = tokens[j];
      if (tk.kind === 'glyph') {
        if (removedSet.has(tk.glyph!)) break;
        // A glyph on the other side of a gap (a TJ jumping back past it) takes a different shift:
        // it starts its own absolutely positioned group.
        if (shiftAt(tk.glyph!) !== groupShift) break;
        if (adjSum !== 0 && pending.length > 0) {
          flush();
          items.push(num(adjSum));
        }
        adjSum = 0;
        const g = run.glyphs[tk.glyph!];
        for (let k = g.codeLength - 1; k >= 0; k--) pending.push((g.code >> (8 * k)) & 0xff);
        const arr = used.get(run.fontKey) ?? [];
        arr.push(g.code);
        used.set(run.fontKey, arr);
      } else {
        // Keep adjustments only when glyphs of this group sit on both sides of them.
        adjSum += tk.adj!;
      }
      j++;
    }
    flush();
    emitTm(tmAt(startGlyph, shiftAt(startGlyph)));
    if (items.length === 1 && items[0].kind === 'string') ops.push(makeOp('Tj', items[0]));
    else if (items.length > 0) ops.push(makeOp('TJ', array(items)));
    i = j;
  }
  return { ops, used, removed };
}

/** Flatten the operand(s) of a show operator into glyph/adjustment tokens aligned with run.glyphs. */
function tokensOf(op: ContentOp, run: GlyphRun): Token[] {
  const tokens: Token[] = [];
  if (op.op !== 'TJ') {
    for (let g = 0; g < run.glyphs.length; g++) tokens.push({ kind: 'glyph', glyph: g });
    return tokens;
  }
  const arr = op.operands[0];
  if (!arr || arr.kind !== 'array') return tokens;
  let g = 0;
  arr.items.forEach((it, idx) => {
    if (it.kind === 'number') tokens.push({ kind: 'adj', adj: it.value });
    else if (it.kind === 'string') {
      while (g < run.glyphs.length && run.glyphs[g].item === idx) {
        tokens.push({ kind: 'glyph', glyph: g });
        g++;
      }
    }
  });
  return tokens;
}

function emitPlaceholder(ops: ContentOp[], ph: PlaceholderSpec, run: GlyphRun, font: LoadedFont | undefined): void {
  const t = run.local;
  const { fit } = ph;
  const sizeChanged = Math.abs(fit.fontSize - t.fontSize) > 1e-9 || !ph.originalFont;
  const hChanged = Math.abs(fit.hscale - t.hscale) > 1e-9;
  if (sizeChanged) ops.push(makeOp('Tf', name(ph.originalFont || !ph.resourceName ? run.fontName : ph.resourceName), num(fit.fontSize)));
  if (hChanged) ops.push(makeOp('Tz', num(fit.hscale * 100)));
  if (t.charSpacing !== 0) ops.push(makeOp('Tc', num(0)));
  if (t.wordSpacing !== 0) ops.push(makeOp('Tw', num(0)));
  ops.push(makeOp('Tj', hexString(ph.bytes)));
  if (t.wordSpacing !== 0) ops.push(makeOp('Tw', num(t.wordSpacing)));
  if (t.charSpacing !== 0) ops.push(makeOp('Tc', num(t.charSpacing)));
  if (hChanged) ops.push(makeOp('Tz', num(t.hscale * 100)));
  if (sizeChanged) ops.push(makeOp('Tf', name(run.fontName), num(t.fontSize)));
  void font;
}
