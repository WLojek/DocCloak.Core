/**
 * T260: a model span never runs across a line break. A word-level provider
 * merges neighbouring words of one type, and the end of a paragraph or table
 * cell gets glued to the start of the next one. Each line's part becomes its
 * own value; a part too short to be one joins the span it touches on its
 * line, or goes.
 */
import { describe, it, expect } from 'vitest';
import { splitAtLineBreaks, joinHyphenatedWords, detectEntities, detectWithRegex } from '../src/pipeline.ts';
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

// T288: the French judgment of WLojek/DocCloak.Core#1 could not be exported at all: the halves of
// words broken at a line end ("MO-" / "NETA", "Pa-" / "ris") were values of their own, and the
// post-write check of the PDF found "ris" inside another word and "MO-" in a PDF name.
describe('joinHyphenatedWords', () => {
  it('returns the same array when no word is broken at a line end', () => {
    const text = 'ALTAMIR et MONETA,\nParis - Lyon';
    const entities = [ml(text, 'ALTAMIR', 'COMPANY'), ml(text, 'MONETA', 'COMPANY')];
    expect(joinHyphenatedWords(text, entities)).toBe(entities);
  });

  it('two halves found become one value over the whole word', () => {
    const text = 'la société ALTA-\nMIR a conclu';
    const out = joinHyphenatedWords(text, [ml(text, 'ALTA-', 'COMPANY'), ml(text, 'MIR', 'COMPANY')]);
    expect(shape(out)).toEqual([['COMPANY', 'ALTA-\nMIR', text.indexOf('ALTA-')]]);
    expect(out[0].end).toBe(text.indexOf('MIR') + 3);
  });

  it('takes the type the unbroken word has elsewhere when the halves disagree', () => {
    const text = 'MONETA ASSET MANAGEMENT a assigné. Selon MO-\nNETA, la demande';
    const out = joinHyphenatedWords(text, [
      ml(text, 'MONETA ASSET MANAGEMENT', 'COMPANY'),
      { ...ml(text, 'MONETA', 'COMPANY'), start: 0, end: 6 },
      ml(text, 'MO-', 'COMPANY'),
      { ...ml(text, 'NETA', 'PERSON', text.indexOf('\n')), confidence: 0.99 },
    ]);
    const shapes = shape(out);
    expect(shapes[shapes.length - 1]).toEqual(['COMPANY', 'MO-\nNETA', text.indexOf('MO-')]);
    expect(out.map((e) => e.value)).not.toContain('MO-');
    expect(out.map((e) => e.value)).not.toContain('NETA');
  });

  it('without the word elsewhere, the half the detector was surer of gives the type', () => {
    const text = 'siège à Pa-\nris, France';
    const out = joinHyphenatedWords(text, [
      { ...ml(text, 'Pa-', 'COMPANY'), confidence: 0.6 },
      { ...ml(text, 'ris', 'ADDRESS'), confidence: 0.97 },
    ]);
    expect(shape(out)).toEqual([['ADDRESS', 'Pa-\nris', text.indexOf('Pa-')]]);
    expect(out[0].confidence).toBe(0.97);
  });

  it('one half found: the value grows over the rest of the word, never over the next word', () => {
    const first = 'M. TCHE-\nNIO soutient';
    expect(shape(joinHyphenatedWords(first, [ml(first, 'M. TCHE-', 'PERSON')]))).toEqual([['PERSON', 'M. TCHE-\nNIO', 0]]);
    const second = 'la société MONE-\nTA demande';
    expect(shape(joinHyphenatedWords(second, [ml(second, 'TA', 'PERSON')]))).toEqual([['PERSON', 'MONE-\nTA', second.indexOf('MONE-')]]);
  });

  it('a second half of several words keeps all of them', () => {
    const text = 'contre MO-\nNETA ASSET MANAGEMENT, société';
    const out = joinHyphenatedWords(text, [ml(text, 'MO-', 'COMPANY'), ml(text, 'NETA ASSET MANAGEMENT', 'COMPANY')]);
    expect(shape(out)).toEqual([['COMPANY', 'MO-\nNETA ASSET MANAGEMENT', text.indexOf('MO-')]]);
  });

  it('a break over a page end (blank lines) is still one word', () => {
    const text = 'Maurice TCHE-\n\n\n\nNIO. Il';
    const out = joinHyphenatedWords(text, [ml(text, 'Maurice TCHE-', 'PERSON'), ml(text, 'NIO', 'COMPANY')]);
    expect(out).toHaveLength(1);
    expect(out[0].value).toBe('Maurice TCHE-\n\n\n\nNIO');
    expect(out[0].type).toBe('PERSON');
  });

  it('a dash that is not inside a word joins nothing', () => {
    const spaced = 'Paris -\nLyon';
    const a = [ml(spaced, 'Paris', 'ADDRESS'), ml(spaced, 'Lyon', 'ADDRESS')];
    expect(joinHyphenatedWords(spaced, a)).toBe(a);
    const years = 'exercices 2024-\n2025 de Lyon';
    const b = [ml(years, '2024', 'DATE'), ml(years, '2025', 'DATE'), ml(years, 'Lyon', 'ADDRESS')];
    expect(shape(joinHyphenatedWords(years, b))).toEqual(shape(b));
    const untouched = 'un rapport dé-\ntaillé de Lyon';
    const c = [ml(untouched, 'Lyon', 'ADDRESS')];
    expect(joinHyphenatedWords(untouched, c)).toBe(c);
  });

  it('through the whole pipeline: no half is a value, one label stands for the broken word, the next line keeps its words', () => {
    const text = 'La société ALTAMIR est gérée par ALTA-\nMIR GERANCE. Le tribunal de Pa-\nris a jugé.';
    const out = detectEntities(text, [
      ml(text, 'ALTAMIR', 'COMPANY'),
      ml(text, 'ALTA-\nMIR GERANCE', 'COMPANY'),
      ml(text, 'Pa-', 'ADDRESS'),
      { ...ml(text, 'ris', 'ADDRESS', text.indexOf('Pa-')), confidence: 0.97 },
    ], []);
    const values = out.map((e) => e.value);
    expect(values).toContain('ALTA-\nMIR GERANCE');
    expect(values).toContain('Pa-\nris');
    for (const half of ['ALTA-', 'MIR', 'MIR GERANCE', 'Pa-', 'ris']) expect(values, half).not.toContain(half);
    // No value of three characters or fewer is left: nothing that also stands inside other words.
    expect(values.filter((v) => v.replace(/\s/g, '').length <= 3)).toEqual([]);
    const result = new AnonymizationSession().anonymizeText(text, out);
    expect(result).not.toMatch(/ALTA|MIR|Pa-|ris\b/);
    expect(result).toMatch(/est gérée par \[COMPANY_\d+\]\. Le tribunal de \[ADDRESS_\d+\] a jugé\./);
  });
});
