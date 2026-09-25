/**
 * T227: `regex:universal:postal_city` no longer matches a date-like prefix
 * ("05/2026 Maria", "2025-03 Foo", "1.2345 Bar") or a number followed by a
 * lowercase word ("111 222 przegląd"); the city must start with an uppercase
 * letter and the code must not be glued to a preceding digit, slash, dot or
 * hyphen. The rule stays lookbehind-free (pattern dialect lint): it consumes
 * the leading whitespace and relies on runRule's whitespace trim (T226).
 */
import { describe, it, expect } from 'vitest';
import { ALL_REGEX_RULES } from '../../src/regex/index.ts';
import { detectWithRegex, detectEntities } from '../../src/pipeline.ts';

const rule = ALL_REGEX_RULES.find((r) => r.detector === 'regex:universal:postal_city')!;

function matches(text: string, region = 'pl'): string[] {
  return detectWithRegex(text, region)
    .filter((e) => e.detector === 'regex:universal:postal_city')
    .map((e) => e.value);
}

describe('regex:universal:postal_city rule shape (T227)', () => {
  it('exists with the expected metadata and no lookbehind', () => {
    expect(rule).toBeDefined();
    expect(rule.type).toBe('ADDRESS');
    expect(rule.confidence).toBe(0.65);
    expect(rule.pattern.flags).toBe('gu');
    expect(rule.pattern.source).not.toMatch(/\(\?<[=!]/);
  });
});

describe('regex:universal:postal_city positives (T227)', () => {
  it.each([
    ['00-950 Warszawa', '00-950 Warszawa'],
    ['75008 Paris', '75008 Paris'],
    ['1010 Wien', '1010 Wien'],
    ['Adres: 1010 Wien', '1010 Wien'],
    ['Kod pocztowy: 00-950 Warszawa jest stolica.', '00-950 Warszawa'],
    ['siedziba\t75008 Paris', '75008 Paris'],
    ['1000-001 Lisboa', '1000-001 Lisboa'],
    ['12345-6789 Springfield', '12345-6789 Springfield'],
  ])('%s -> %s', (text, expected) => {
    expect(matches(text)).toEqual([expected]);
  });

  it('spans are exact and carry no leading whitespace', () => {
    const text = 'Biuro: 75008 Paris oraz 1010 Wien.';
    const found = detectWithRegex(text, 'pl').filter((e) => e.detector === 'regex:universal:postal_city');
    expect(found.map((e) => e.value)).toEqual(['75008 Paris', '1010 Wien']);
    for (const e of found) {
      expect(text.slice(e.start, e.end)).toBe(e.value);
      expect(e.value).toBe(e.value.trim());
    }
  });
});

describe('regex:universal:postal_city negatives (T227)', () => {
  it.each([
    '05/2026 Maria Łęcka',
    '2025-03 Foo',
    '2024-2025 Rok',
    '1.2345 Bar',
    '111 222 przegląd',
    'Case number 987654321 remains open',
    'w 2024 roku',
    '12-345 łódź',
    'SW1A 1AA London',
    '01-234 Warszawa2',
  ])('does not match %s', (text) => {
    expect(matches(text)).toEqual([]);
  });
});

describe('regex:universal:postal_city in detectEntities (T227)', () => {
  it('file-02 harmonogram row under region pl: PHONE only, no ADDRESS', () => {
    const text = '05/2026 Maria Łęcka 604 111 222 przegląd nr 1';
    const out = detectEntities(text, [], detectWithRegex(text, 'pl'));
    expect(out.map((e) => [e.type, e.value])).toEqual([['PHONE', '604 111 222']]);
    expect(out.some((e) => e.type === 'ADDRESS')).toBe(false);
  });

  it('"00-950 Warszawa", "75008 Paris", "1010 Wien" are still ADDRESS under pl and all', () => {
    for (const region of ['pl', 'all']) {
      for (const text of ['00-950 Warszawa', '75008 Paris', '1010 Wien']) {
        const out = detectEntities(text, [], detectWithRegex(text, region));
        expect(out.map((e) => [e.type, e.value]), `${region}: ${text}`).toEqual([['ADDRESS', text]]);
      }
    }
  });

  it('a 9-digit number before a lowercase word is no longer swallowed as ADDRESS', () => {
    const text = 'Case number 987654321 remains open';
    const out = detectEntities(text, [], detectWithRegex(text, 'pl'));
    expect(out.some((e) => e.type === 'ADDRESS')).toBe(false);
    expect(out.map((e) => e.value)).toEqual(['987654321']);
  });
});
