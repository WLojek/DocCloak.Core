/**
 * @doccloak/core/pdf - placeholder fitting (T213).
 *
 * A placeholder such as "[PERSON_1]" rarely has the width of the text it
 * replaces ("Li" is two glyphs, a Polish surname ten). The policy, agreed
 * with the founder on 2026-09-24: keep the original font size when the
 * placeholder fits the gap; otherwise shrink the size down to a floor, then
 * condense horizontally (Tz) down to a floor, and only then let the rest of
 * the line move right by the remaining overflow. A placeholder never gets
 * bigger than the original text, and the visible change to the layout is
 * the smallest that keeps the placeholder legible.
 */

import type { PlaceholderFit } from './types.ts';

export interface FitInput {
  /** Width of the gap in unscaled text space (the space `advances` are measured in). */
  gap: number;
  /** Original font size (Tfs) of the run. */
  fontSize: number;
  /** Original horizontal scaling (Tz / 100). */
  hscale: number;
  /** Placeholder width in 1/1000 em at size 1 (font units summed). */
  widthPerEm: number;
}

export interface FitResult {
  fontSize: number;
  hscale: number;
  /** Placeholder width in unscaled text space after fitting. */
  width: number;
  /** How much the rest of the line must move right (unscaled text space); 0 when it fits. */
  overflow: number;
  /** Which stage produced the result, for reports and tests. */
  stage: 'fits' | 'shrunk' | 'condensed' | 'overflow';
}

export const DEFAULT_FIT: Required<PlaceholderFit> = {
  // T225: 75 % (was 65 %); the planner moves the rest of the line before it shrinks at all.
  minSizeRatio: 0.75,
  minHorizontalScale: 0.8,
  allowOverflow: false,
};

export function fitPlaceholder(input: FitInput, policy: PlaceholderFit = {}): FitResult {
  const p = { ...DEFAULT_FIT, ...policy };
  // A policy can only shrink: ratios above 1 (or non-numbers) fall back to the defaults, 0 to a hair.
  p.minSizeRatio = clampRatio(p.minSizeRatio, DEFAULT_FIT.minSizeRatio);
  p.minHorizontalScale = clampRatio(p.minHorizontalScale, DEFAULT_FIT.minHorizontalScale);
  const { gap, fontSize, hscale, widthPerEm } = input;
  const widthAt = (size: number, h: number): number => (widthPerEm / 1000) * size * h;

  if (![gap, fontSize, hscale, widthPerEm].every(Number.isFinite) || widthPerEm <= 0 || fontSize <= 0 || hscale <= 0) {
    return { fontSize, hscale, width: 0, overflow: 0, stage: 'fits' };
  }
  const natural = widthAt(fontSize, hscale);
  if (natural <= gap + 1e-6) {
    return { fontSize, hscale, width: natural, overflow: 0, stage: 'fits' };
  }

  // Stage 1: shrink the font size down to the floor.
  const minSize = fontSize * p.minSizeRatio;
  const sizeNeeded = gap / ((widthPerEm / 1000) * hscale);
  if (sizeNeeded >= minSize) {
    const size = round(sizeNeeded);
    return { fontSize: size, hscale, width: widthAt(size, hscale), overflow: 0, stage: 'shrunk' };
  }

  // Stage 2: condense horizontally down to the floor.
  const size = round(minSize);
  const minH = hscale * p.minHorizontalScale;
  const hNeeded = gap / ((widthPerEm / 1000) * size);
  if (hNeeded >= minH) {
    const h = Math.floor(hNeeded * 1000) / 1000;
    return { fontSize: size, hscale: h, width: widthAt(size, h), overflow: 0, stage: 'condensed' };
  }

  // Stage 3: overflow; the caller shifts the rest of the line (or lets it overlap when allowOverflow).
  const h = Math.floor(minH * 1000) / 1000;
  const width = widthAt(size, h);
  return { fontSize: size, hscale: h, width, overflow: p.allowOverflow ? 0 : width - gap, stage: 'overflow' };
}

function round(v: number): number {
  return Math.floor(v * 100) / 100;
}

function clampRatio(v: number, fallback: number): number {
  if (!Number.isFinite(v) || v > 1) return fallback;
  return Math.max(0.05, v);
}
