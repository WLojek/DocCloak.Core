/**
 * `regex:pl:street` takes in the flat number ("m. 12", "lok. 3"): a scan's OCR text gave the model
 * a slightly different context than the text PDF of the same letter, and it found "ul. Słoneczna 7"
 * without "m. 12", which then stayed in the picture. The rule now covers the whole address itself.
 */
import { describe, it, expect } from 'vitest';
import { detectWithRegex } from '../../src/pipeline.ts';

function streets(text: string): string[] {
  return detectWithRegex(text, 'pl').filter((e) => e.detector === 'regex:pl:street').map((e) => e.value);
}

describe('regex:pl:street with the flat', () => {
  it.each([
    ['Sz. P. Anna Nowak\nul. Słoneczna 7 m. 12\n02-495 Warszawa', 'ul. Słoneczna 7 m. 12'],
    ['ul. Słoneczna 7 m.12, Warszawa', 'ul. Słoneczna 7 m.12'],
    ['ul. Słoneczna 7 m 12', 'ul. Słoneczna 7 m 12'],
    ['al. Jerozolimskie 44 lok. 3B', 'al. Jerozolimskie 44 lok. 3B'],
    ['ul. Floriańska 27/3 m. 4', 'ul. Floriańska 27/3 m. 4'],
  ])('%j -> %j', (text, value) => {
    expect(streets(text)).toEqual([value]);
  });

  it('a following word that is not a flat number stays out', () => {
    expect(streets('ul. Słoneczna 7 mieszka Jan')).toEqual(['ul. Słoneczna 7']);
    expect(streets('ul. Słoneczna 7 m. st. Warszawa')).toEqual(['ul. Słoneczna 7']);
    expect(streets('ul. Portowa 8, KRS 0000123456')).toEqual(['ul. Portowa 8']);
  });
});
