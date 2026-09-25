import { describe, it, expect } from 'vitest';
import { fitPlaceholder, DEFAULT_FIT } from '../src/pdf/fit.ts';

// "[PERSON_1]" in Liberation Sans: 5891/1000 em.
const PLACEHOLDER = 5891;

describe('placeholder fitting policy', () => {
  it('keeps the size when the placeholder fits the gap', () => {
    const r = fitPlaceholder({ gap: 80, fontSize: 12, hscale: 1, widthPerEm: PLACEHOLDER });
    expect(r.stage).toBe('fits');
    expect(r.fontSize).toBe(12);
    expect(r.hscale).toBe(1);
    expect(r.width).toBeCloseTo(70.692, 3);
    expect(r.overflow).toBe(0);
  });

  it('shrinks the font size first, down to the floor', () => {
    const r = fitPlaceholder({ gap: 60, fontSize: 12, hscale: 1, widthPerEm: PLACEHOLDER });
    expect(r.stage).toBe('shrunk');
    expect(r.fontSize).toBeGreaterThanOrEqual(12 * DEFAULT_FIT.minSizeRatio);
    expect(r.width).toBeLessThanOrEqual(60);
    expect(r.hscale).toBe(1);
  });

  it('then condenses horizontally, down to the floor', () => {
    // At the size floor (9 pt, T225: 75 %) the placeholder is 53.0 pt wide; a 46 pt gap needs Tz.
    const r = fitPlaceholder({ gap: 46, fontSize: 12, hscale: 1, widthPerEm: PLACEHOLDER });
    expect(r.stage).toBe('condensed');
    expect(r.fontSize).toBeCloseTo(9, 2);
    expect(r.hscale).toBeGreaterThanOrEqual(DEFAULT_FIT.minHorizontalScale);
    expect(r.hscale).toBeLessThan(1);
    expect(r.width).toBeLessThanOrEqual(46 + 1e-6);
    expect(r.overflow).toBe(0);
  });

  it('overflows only after both floors: a two-letter name at 10 pt', () => {
    // "Li" in Helvetica at 10 pt = (556 + 222) / 1000 * 10 = 7.78 pt.
    const r = fitPlaceholder({ gap: 7.78, fontSize: 10, hscale: 1, widthPerEm: PLACEHOLDER });
    expect(r.stage).toBe('overflow');
    expect(r.fontSize).toBeCloseTo(7.5, 2);
    expect(r.hscale).toBeCloseTo(0.8, 3);
    expect(r.width).toBeCloseTo((PLACEHOLDER / 1000) * 7.5 * 0.8, 3);
    expect(r.overflow).toBeCloseTo(r.width - 7.78, 6);
  });

  it('respects a custom policy and allowOverflow', () => {
    const r = fitPlaceholder({ gap: 7.78, fontSize: 10, hscale: 1, widthPerEm: PLACEHOLDER }, { minSizeRatio: 1, minHorizontalScale: 1, allowOverflow: true });
    expect(r.stage).toBe('overflow');
    expect(r.fontSize).toBe(10);
    expect(r.hscale).toBe(1);
    expect(r.overflow).toBe(0);
  });

  it('honours an existing horizontal scaling of the run', () => {
    const r = fitPlaceholder({ gap: 60, fontSize: 12, hscale: 0.8, widthPerEm: PLACEHOLDER });
    expect(r.width).toBeLessThanOrEqual(60);
    expect(r.hscale).toBeLessThanOrEqual(0.8);
  });

  it('is a no-op for an empty placeholder', () => {
    const r = fitPlaceholder({ gap: 10, fontSize: 12, hscale: 1, widthPerEm: 0 });
    expect(r.width).toBe(0);
    expect(r.stage).toBe('fits');
  });
});
