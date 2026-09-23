import { describe, it, expect } from 'vitest';
import { replaceSensitiveValues } from '../src/dom/opc.ts';

describe('replaceSensitiveValues', () => {
  it('applies longer values first so a variant never leaves part of the full name behind', () => {
    const pairs = [
      { value: 'Kowalski', replacement: '[PERSON_1_LAST]' },
      { value: 'Jan Kowalski', replacement: '[PERSON_1]' },
    ];
    expect(replaceSensitiveValues('Sprawa: Jan Kowalski / Kowalski', pairs, false)).toBe(
      'Sprawa: [PERSON_1] / [PERSON_1_LAST]',
    );
  });

  it('matches the percent-encoded form of a value inside URLs', () => {
    const pairs = [
      { value: 'Kowalski', replacement: '[PERSON_1_LAST]' },
      { value: 'Jan Kowalski', replacement: '[PERSON_1]' },
    ];
    expect(replaceSensitiveValues('https://crm.example/Jan%20Kowalski?u=kowalski', pairs, true)).toBe(
      'https://crm.example/%5BPERSON_1%5D?u=%5BPERSON_1_LAST%5D',
    );
  });

  it('keeps regex metacharacters and $ sequences inert', () => {
    const pairs = [{ value: 'a.b (c) $1', replacement: '$&x' }];
    expect(replaceSensitiveValues('see a.b (c) $1 and axb', pairs, false)).toBe('see $&x and axb');
  });

  it('skips empty values', () => {
    expect(replaceSensitiveValues('unchanged', [{ value: '', replacement: 'X' }], false)).toBe('unchanged');
  });
});
