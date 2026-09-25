import { describe, it, expect } from 'vitest';
import { ALL_REGEX_RULES } from '../../src/regex/index.ts';
import { detectWithRegex } from '../../src/pipeline.ts';

// T226: the IBAN pattern admitted whitespace in its trailing class and
// stopped at the next word boundary, so "2874 w terminie" matched with the
// space; the replacement then produced "[IBAN_1]w terminie".
describe('regex matches never carry whitespace at either end (T226)', () => {
  it('IBAN followed by a word: spaced form', () => {
    const text = 'rachunek bankowy PL61 1090 1014 0000 0712 1981 2874 w terminie 14 dni';
    const iban = detectWithRegex(text, 'pl').filter((e) => e.type === 'IBAN');
    expect(iban).toHaveLength(1);
    expect(iban[0].value).toBe('PL61 1090 1014 0000 0712 1981 2874');
    expect(text.slice(iban[0].start, iban[0].end)).toBe(iban[0].value);
    expect(text[iban[0].end]).toBe(' ');
  });

  it('IBAN followed by a word: compact form', () => {
    const text = 'Konto PL61109010140000071219812874 zostało zamknięte';
    const iban = detectWithRegex(text, 'pl').filter((e) => e.type === 'IBAN');
    expect(iban).toHaveLength(1);
    expect(iban[0].value).toBe('PL61109010140000071219812874');
  });

  it('IBAN at the end of a sentence and before a comma is unchanged', () => {
    for (const text of ['IBAN: DE89 3704 0044 0532 0130 00.', 'IBAN DE89 3704 0044 0532 0130 00, dalej']) {
      const iban = detectWithRegex(text, 'all').filter((e) => e.type === 'IBAN');
      expect(iban).toHaveLength(1);
      expect(iban[0].value).toBe('DE89 3704 0044 0532 0130 00');
    }
  });

  it('every rule example followed by a word yields a value without surrounding whitespace', () => {
    for (const rule of ALL_REGEX_RULES) {
      for (const example of rule.examples ?? []) {
        const text = `x ${example} y`;
        for (const e of detectWithRegex(text, 'all')) {
          expect(e.value, `${rule.detector}: "${example}"`).toBe(e.value.trim());
          expect(text.slice(e.start, e.end)).toBe(e.value);
        }
      }
    }
  });
});
