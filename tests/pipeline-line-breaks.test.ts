/**
 * T260: a model span never runs across a line break. A word-level provider
 * merges neighbouring words of one type, and the end of a paragraph or table
 * cell gets glued to the start of the next one. Each line's part becomes its
 * own value; a part too short to be one joins the span it touches on its
 * line, or goes.
 */
import { describe, it, expect } from 'vitest';
import { splitAtLineBreaks, detectEntities, detectWithRegex } from '../src/pipeline.ts';
import { AnonymizationSession } from '../src/session.ts';
import type { DetectedEntity, EntityType } from '../src/types.ts';

function ml(text: string, value: string, type: EntityType, from = 0): DetectedEntity {
  const start = text.indexOf(value, from);
  if (start < 0) throw new Error(`"${value}" is not in the text`);
  return { type, value, start, end: start + value.length, confidence: 0.9, detector: 'bardsai:TEST' };
}

/** Type, value and start of each span, in text order (the function keeps input order). */
const shape = (entities: DetectedEntity[]) => [...entities].sort((a, b) => a.start - b.start).map((e) => [e.type, e.value, e.start]);

describe('splitAtLineBreaks', () => {
  it('returns the same array when no span holds a line break', () => {
    const text = 'Anna Nowak, Budimex S.A.';
    const entities = [ml(text, 'Anna Nowak', 'PERSON'), ml(text, 'Budimex S.A.', 'COMPANY')];
    expect(splitAtLineBreaks(text, entities)).toBe(entities);
  });

  it('a two-line address becomes two values, each on its line', () => {
    const text = 'Adres:\nul. Słoneczna 7\n30-001 Kraków\nTelefon: 601 234 567';
    const out = splitAtLineBreaks(text, [ml(text, 'ul. Słoneczna 7\n30-001 Kraków', 'ADDRESS')]);
    expect(shape(out)).toEqual([
      ['ADDRESS', 'ul. Słoneczna 7', text.indexOf('ul.')],
      ['ADDRESS', '30-001 Kraków', text.indexOf('30-001')],
    ]);
    for (const e of out) expect(text.slice(e.start, e.end)).toBe(e.value);
  });

  it('the house number glued to the company above joins the address on its own line', () => {
    const text = 'Banque Phocéenne de Crédit\n40 La Canebière, 13001 Marseille\n';
    const out = splitAtLineBreaks(text, [
      ml(text, 'Banque Phocéenne de Crédit\n40', 'COMPANY'),
      ml(text, 'La Canebière, 13001 Marseille', 'ADDRESS'),
    ]);
    expect(shape(out)).toEqual([
      ['COMPANY', 'Banque Phocéenne de Crédit', 0],
      ['ADDRESS', '40 La Canebière, 13001 Marseille', text.indexOf('40')],
    ]);
  });

  it('a short tail joins the span before it on the same line', () => {
    const text = 'Kwota: 18 000,00 zł\nBank';
    const out = splitAtLineBreaks(text, [ml(text, '18 000,00', 'OTHER'), ml(text, 'zł\nBank', 'OTHER')]);
    expect(shape(out)).toEqual([
      ['OTHER', '18 000,00 zł', text.indexOf('18')],
      ['OTHER', 'Bank', text.indexOf('Bank')],
    ]);
  });

  it('a stray letter of the next cell is not a value and takes nothing with it', () => {
    const text = '18 000,00\nBanque Phocéenne';
    const out = splitAtLineBreaks(text, [ml(text, '18 000,00\nB', 'OTHER')]);
    expect(shape(out)).toEqual([['OTHER', '18 000,00', 0]]);
  });

  it('handles CRLF, blank lines and spaces around the break', () => {
    const text = 'Jan Kowalski  \r\n\r\n  Maria Lis';
    const out = splitAtLineBreaks(text, [ml(text, text, 'PERSON')]);
    expect(shape(out)).toEqual([['PERSON', 'Jan Kowalski', 0], ['PERSON', 'Maria Lis', text.indexOf('Maria')]]);
  });

  it('a short part does not jump over a line break or over other text to find a neighbour', () => {
    const text = 'Acme Ltd\n40\nMain Street 5, London; ref 40 x Main Street';
    const out = splitAtLineBreaks(text, [ml(text, 'Acme Ltd\n40', 'COMPANY'), ml(text, 'Main Street 5, London', 'ADDRESS')]);
    expect(shape(out)).toEqual([
      ['COMPANY', 'Acme Ltd', 0],
      ['ADDRESS', 'Main Street 5, London', text.indexOf('Main')],
    ]);
  });

  it('a two-letter name part stays a person, as the filter allows', () => {
    const text = 'Li\nWei signed.';
    const out = splitAtLineBreaks(text, [ml(text, 'Li\nWei', 'PERSON')]);
    expect(shape(out)).toEqual([['PERSON', 'Li', 0], ['PERSON', 'Wei', 3]]);
  });
});

describe('detectEntities with spans across line breaks', () => {
  it('no value of the result holds a line break, and the text keeps its lines', () => {
    const text = 'Créancier\nBanque Phocéenne de Crédit\n40 La Canebière, 13001 Marseille\nMontant\n18 000,00\nBanque Phocéenne de Crédit\n';
    const entities = detectEntities(text, [
      ml(text, 'Banque Phocéenne de Crédit\n40', 'COMPANY'),
      ml(text, 'La Canebière, 13001 Marseille', 'ADDRESS'),
      ml(text, '18 000,00\nB', 'OTHER'),
    ], detectWithRegex(text, 'fr'));
    expect(entities.every((e) => !/[\r\n]/.test(e.value))).toBe(true);
    for (const e of entities) expect(text.slice(e.start, e.end)).toBe(e.value);

    const session = new AnonymizationSession();
    const redacted = session.anonymizeText(text, entities);
    // Same number of lines: no placeholder swallowed a line break, no line lost its first word.
    expect(redacted.split('\n')).toHaveLength(text.split('\n').length);
    expect(redacted).not.toContain('Banque Phocéenne de Crédit');
    expect(redacted).not.toContain('La Canebière');
    expect(redacted).not.toMatch(/\]anque/);
    // The company named twice is one value, and everything comes back exactly.
    expect(session.deanonymize(redacted)).toBe(text);
  });
});
