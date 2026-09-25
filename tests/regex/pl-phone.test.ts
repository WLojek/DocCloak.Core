/**
 * T227: `regex:pl:phone` accepts Polish landlines written without the
 * country code in the 2-3-2-2 grouping ("22 555 01 02", "(22) 555-01-02"),
 * besides the 3-3-3 mobile grouping. Before, those fell through to
 * `universal:long_number` and came out as [SSN_n].
 */
import { describe, it, expect } from 'vitest';
import { ALL_REGEX_RULES } from '../../src/regex/index.ts';
import { detectWithRegex, detectEntities } from '../../src/pipeline.ts';
import type { DetectedEntity } from '../../src/types.ts';

const rule = ALL_REGEX_RULES.find((r) => r.detector === 'regex:pl:phone')!;

function matches(text: string): string[] {
  return detectWithRegex(text, 'pl')
    .filter((e) => e.detector === 'regex:pl:phone')
    .map((e) => e.value);
}

function resolved(text: string, region: string): DetectedEntity[] {
  return detectEntities(text, [], detectWithRegex(text, region));
}

describe('regex:pl:phone rule shape (T227)', () => {
  it('exists with the expected metadata', () => {
    expect(rule).toBeDefined();
    expect(rule.type).toBe('PHONE');
    expect(rule.confidence).toBe(0.8);
    expect(rule.pattern.flags).toBe('g');
  });
});

describe('regex:pl:phone landline 2-3-2-2 grouping (T227)', () => {
  it.each([
    ['tel. 22 555 01 02', '22 555 01 02'],
    ['tel. (22) 555-01-02', '(22) 555-01-02'],
    ['71 777 88 99', '71 777 88 99'],
    ['12 345 67 89', '12 345 67 89'],
    ['+48 22 555 01 02', '+48 22 555 01 02'],
    ['48 22 555 01 02', '48 22 555 01 02'],
    ['22 5550102', '22 5550102'],
    ['faks 22-555-01-02', '22-555-01-02'],
    ['(22)555-01-02', '(22)555-01-02'],
    ['tel.: +48 (22) 555 01 02', '+48 (22) 555 01 02'],
  ])('%s -> %s', (text, expected) => {
    expect(matches(text)).toEqual([expected]);
  });

  it('never starts the value with a stray closing bracket', () => {
    for (const text of ['tel. (22) 555-01-02', 'tel.(22) 555 01 02', '(22)555-01-02']) {
      for (const value of matches(text)) {
        expect(value.startsWith(')'), `${text} -> ${value}`).toBe(false);
      }
    }
  });
});

describe('regex:pl:phone mobile 3-3-3 grouping still works (T227)', () => {
  it.each([
    ['+48 600 123 456', '+48 600 123 456'],
    ['600-123-456', '600-123-456'],
    ['48 600123456', '48 600123456'],
    ['tel. 600123456.', '600123456'],
    ['05/2026 Maria Łęcka 604 111 222 przegląd nr 1', '604 111 222'],
  ])('%s -> %s', (text, expected) => {
    expect(matches(text)).toEqual([expected]);
  });
});

describe('regex:pl:phone negatives (T227)', () => {
  it.each([
    'PESEL 89052310002',
    'PESEL 48052312349',
    '2 lutego 2025',
    'NIP 123-456-78-19',
    'kwota 1234567890',
    'ISBN 12 345 67 890',
    '22 555 01 021',
    'konto 12 1234 5678 9012 3456 7890 1234',
  ])('does not match %s', (text) => {
    expect(matches(text)).toEqual([]);
  });
});

describe('regex:pl:phone in detectEntities (T227)', () => {
  it.each(['pl', 'all'])('landline forms come out as PHONE under region %s', (region) => {
    for (const [text, value] of [
      ['tel. 22 555 01 02', '22 555 01 02'],
      ['tel. (22) 555-01-02', '(22) 555-01-02'],
      ['71 777 88 99', '71 777 88 99'],
      ['+48 22 555 01 02', '+48 22 555 01 02'],
    ] as const) {
      const out = resolved(text, region);
      expect(out.map((e) => [e.type, e.value]), `${region}: ${text}`).toEqual([['PHONE', value]]);
    }
  });

  it('PHONE wins over universal:long_number on the same span', () => {
    const text = 'tel. 22 555 01 02';
    const raw = detectWithRegex(text, 'pl');
    expect(raw.some((e) => e.detector === 'regex:universal:long_number')).toBe(true);
    const out = resolved(text, 'pl');
    expect(out).toHaveLength(1);
    expect(out[0].detector).toBe('regex:pl:phone');
    expect(out[0].type).toBe('PHONE');
  });

  it('a checksum-valid NIP stays NIP, not PHONE', () => {
    for (const region of ['pl', 'all']) {
      const out = resolved('NIP 123-456-78-19', region);
      expect(out.map((e) => [e.type, e.detector, e.value]), region).toEqual([
        ['SSN', 'regex:pl:nip', '123-456-78-19'],
      ]);
    }
  });

  it('a PESEL stays PESEL under region pl', () => {
    const out = resolved('PESEL 89052310002', 'pl');
    expect(out.map((e) => [e.type, e.detector])).toEqual([['SSN', 'regex:pl:pesel']]);
  });

  it('spans are exact after resolution (value === text.slice(start, end))', () => {
    const text = 'Kontakt: tel. (22) 555-01-02, kom. 600 123 456, faks 71 777 88 99.';
    const out = resolved(text, 'pl');
    expect(out.map((e) => e.value)).toEqual(['(22) 555-01-02', '600 123 456', '71 777 88 99']);
    for (const e of out) expect(text.slice(e.start, e.end)).toBe(e.value);
  });
});
