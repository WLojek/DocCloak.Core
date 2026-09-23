/**
 * T057 person-variant unification + T171 variant-faithful restore:
 * repeated mentions of the same person ("John Smith", "John", "Smith")
 * share one identity (one number / one surrogate family), but every
 * distinct variant gets its own token so restore writes back exactly what
 * was there. Different people stay distinct; renaming a base label
 * re-derives its variants; serialization round trips re-link groups.
 */
import { describe, expect, it } from 'vitest';
import { AnonymizationSession } from '../src/session.ts';

describe('person-variant unification (T057) with exact restore (T171)', () => {
  it('keeps one number per person and a positional suffix per variant', () => {
    const s = new AnonymizationSession();
    expect(s.anonymize('John Smith', 'PERSON')).toBe('[PERSON_1]');
    expect(s.anonymize('John', 'PERSON')).toBe('[PERSON_1_FIRST]');
    expect(s.anonymize('Smith', 'PERSON')).toBe('[PERSON_1_LAST]');
    expect(s.deanonymize('Hello [PERSON_1], [PERSON_1_FIRST] and [PERSON_1_LAST]'))
      .toBe('Hello John Smith, John and Smith');
  });

  it('restores the founder case exactly: John Smith / Smith / smith', () => {
    const s = new AnonymizationSession();
    const text = 'John Smith went to the store. Later Smith called. Then smith left.';
    const out = s.anonymizeText(text, [
      { type: 'PERSON', value: 'John Smith', start: 0, end: 10, confidence: 1, detector: 't' },
      { type: 'PERSON', value: 'Smith', start: 36, end: 41, confidence: 1, detector: 't' },
      { type: 'PERSON', value: 'smith', start: 55, end: 60, confidence: 1, detector: 't' },
    ]);
    expect(out).toBe('[PERSON_1] went to the store. Later [PERSON_1_LAST] called. Then [PERSON_1_LAST_2] left.');
    expect(s.deanonymize(out)).toBe(text);
    // Tolerant pass (T098) still resolves mangled variant tokens.
    expect(s.deanonymize('**[person_1_last]** and PERSON_1 and [PERSON 1 LAST 2]'))
      .toBe('**Smith** and John Smith and smith');
  });

  it('marks middle names, shortened forms and fuller forms', () => {
    const s = new AnonymizationSession();
    expect(s.anonymize('Anna Maria Nowak', 'PERSON')).toBe('[PERSON_1]');
    expect(s.anonymize('Maria', 'PERSON')).toBe('[PERSON_1_MIDDLE]');
    expect(s.anonymize('Anna Nowak', 'PERSON')).toBe('[PERSON_1_SHORT]');
    expect(s.anonymize('Anna Maria Nowak-Kowalska', 'PERSON')).toBe('[PERSON_1_FULL]');
    expect(s.deanonymize('[PERSON_1_SHORT] / [PERSON_1_FULL]')).toBe('Anna Nowak / Anna Maria Nowak-Kowalska');
  });

  it('does not upgrade the base when the fuller form arrives later; each restores itself', () => {
    const s = new AnonymizationSession();
    expect(s.anonymize('John', 'PERSON')).toBe('[PERSON_1]');
    expect(s.anonymize('John Smith', 'PERSON')).toBe('[PERSON_1_FULL]');
    expect(s.anonymize('Smith', 'PERSON')).toBe('[PERSON_1_LAST]');
    expect(s.deanonymize('[PERSON_1] [PERSON_1_FULL] [PERSON_1_LAST]')).toBe('John John Smith Smith');
  });

  it('keeps different people distinct and stays conservative on honorifics', () => {
    const s = new AnonymizationSession();
    expect(s.anonymize('John Smith', 'PERSON')).toBe('[PERSON_1]');
    expect(s.anonymize('Anna Nowak', 'PERSON')).toBe('[PERSON_2]');
    // 'mr' has no counterpart token in "John Smith": no guessing.
    expect(s.anonymize('Mr. Smith', 'PERSON')).toBe('[PERSON_3]');
    // A bare first name matches the person sharing it (first mapped).
    expect(s.anonymize('Anna', 'PERSON')).toBe('[PERSON_2_FIRST]');
  });

  it('ambiguous bare names pick the variant with the most shared tokens', () => {
    const s = new AnonymizationSession();
    s.anonymize('John Smith', 'PERSON');
    s.anonymize('John Paul Jones', 'PERSON');
    // "John Paul" shares two tokens with PERSON_2, one with PERSON_1.
    expect(s.anonymize('John Paul', 'PERSON')).toBe('[PERSON_2_SHORT]');
  });

  it('never unifies on initials or digits alone, and never crosses types', () => {
    const s = new AnonymizationSession();
    expect(s.anonymize('Person 1', 'PERSON')).toBe('[PERSON_1]');
    expect(s.anonymize('Person 11', 'PERSON')).toBe('[PERSON_2]');
    s.anonymize('Acme John', 'COMPANY');
    // A PERSON "John" must not glue onto a COMPANY containing 'john'.
    expect(s.anonymize('John', 'PERSON')).toBe('[PERSON_3]');
  });

  it('anonymize is idempotent per variant', () => {
    const s = new AnonymizationSession();
    s.anonymize('John Smith', 'PERSON');
    expect(s.anonymize('Smith', 'PERSON')).toBe('[PERSON_1_LAST]');
    expect(s.anonymize('Smith', 'PERSON')).toBe('[PERSON_1_LAST]');
    expect(s.getEntries()).toHaveLength(2);
  });

  it('surrogate mode maps a variant to the matching part of the surrogate', () => {
    const s = new AnonymizationSession({ mode: 'surrogate', salt: 'fixed' });
    const full = s.anonymize('John Smith', 'PERSON');
    const [first, last] = full.split(' ');
    expect(full.split(' ')).toHaveLength(2);
    expect(s.anonymize('Smith', 'PERSON')).toBe(last);
    expect(s.anonymize('John', 'PERSON')).toBe(first);
    expect(s.anonymize('smith', 'PERSON')).toBe(last.toLowerCase());
    expect(s.deanonymize(`${full}, ${last}, ${first}, ${last.toLowerCase()}`)).toBe('John Smith, Smith, John, smith');
  });

  it('surrogate mode falls back to the group surrogate for fuller forms', () => {
    const s = new AnonymizationSession({ mode: 'surrogate', salt: 'fixed' });
    const short = s.anonymize('John', 'PERSON');
    expect(s.anonymize('John Smith', 'PERSON')).toBe(short);
    // Longest original stays canonical for the shared surrogate (T057).
    expect(s.deanonymize(short)).toBe('John Smith');
  });

  it('blanked mode keeps every variant irreversible', () => {
    const s = new AnonymizationSession({ mode: 'blanked' });
    expect(s.anonymize('John Smith', 'PERSON')).toBe('________');
    expect(s.anonymize('Smith', 'PERSON')).toBe('________');
    expect(s.deanonymize('________')).toBe('________');
  });

  it('anonymizeText gives every variant occurrence its own token', () => {
    const s = new AnonymizationSession();
    const text = 'John Smith called. Later John called again.';
    const out = s.anonymizeText(text, [
      { type: 'PERSON', value: 'John Smith', start: 0, end: 10, confidence: 1, detector: 't' },
      { type: 'PERSON', value: 'John', start: 25, end: 29, confidence: 1, detector: 't' },
    ]);
    expect(out).toBe('[PERSON_1] called. Later [PERSON_1_FIRST] called again.');
    expect(s.deanonymize(out)).toBe(text);
  });

  it('renameLabel on the base re-derives the variants and reports every pair', () => {
    const s = new AnonymizationSession();
    s.anonymize('John Smith', 'PERSON');
    s.anonymize('John', 'PERSON');
    const pairs = s.renameLabel('John Smith', '[CLIENT]');
    expect(pairs).toEqual([['[PERSON_1]', '[CLIENT]'], ['[PERSON_1_FIRST]', '[CLIENT_FIRST]']]);
    expect(s.getForward('John Smith')).toBe('[CLIENT]');
    expect(s.getForward('John')).toBe('[CLIENT_FIRST]');
    expect(s.deanonymize('[CLIENT] / [CLIENT_FIRST]')).toBe('John Smith / John');
    // A later variant joins the renamed group.
    expect(s.anonymize('Smith', 'PERSON')).toBe('[CLIENT_LAST]');
  });

  it('renameLabel on a variant renames only that token and detaches it', () => {
    const s = new AnonymizationSession();
    s.anonymize('John Smith', 'PERSON');
    s.anonymize('Smith', 'PERSON');
    expect(s.renameLabel('Smith', '[SURNAME]')).toEqual([['[PERSON_1_LAST]', '[SURNAME]']]);
    expect(s.getForward('John Smith')).toBe('[PERSON_1]');
    s.renameLabel('John Smith', '[CLIENT]');
    expect(s.getForward('Smith')).toBe('[SURNAME]');
    expect(s.deanonymize('[CLIENT] [SURNAME]')).toBe('John Smith Smith');
  });

  it('renameLabel returns nothing for unknown values or a no-op rename', () => {
    const s = new AnonymizationSession();
    s.anonymize('John Smith', 'PERSON');
    expect(s.renameLabel('Nobody', '[X]')).toEqual([]);
    expect(s.renameLabel('John Smith', '[PERSON_1]')).toEqual([]);
  });

  it('serialization round-trips variant tokens and re-links the group', () => {
    const s = new AnonymizationSession();
    s.anonymize('John Smith', 'PERSON');
    s.anonymize('Smith', 'PERSON');
    const restored = AnonymizationSession.deserialize(s.serialize());
    expect(restored.deanonymize('[PERSON_1] [PERSON_1_LAST]')).toBe('John Smith Smith');
    expect(restored.anonymize('John', 'PERSON')).toBe('[PERSON_1_FIRST]');
    expect(restored.anonymize('Anna Nowak', 'PERSON')).toBe('[PERSON_2]');
    expect(restored.renameLabel('John Smith', '[CLIENT]')).toEqual([
      ['[PERSON_1]', '[CLIENT]'],
      ['[PERSON_1_LAST]', '[CLIENT_LAST]'],
      ['[PERSON_1_FIRST]', '[CLIENT_FIRST]'],
    ]);
  });

  it('deserialize keeps legacy many-to-one maps restoring the longest variant', () => {
    const json = JSON.stringify([
      { original: 'John Smith', replacement: '[PERSON_1]', entity_type: 'PERSON' },
      { original: 'John', replacement: '[PERSON_1]', entity_type: 'PERSON' },
    ]);
    const s = AnonymizationSession.deserialize(json);
    expect(s.deanonymize('[PERSON_1]')).toBe('John Smith');
    // New variants after the restore join the group with their own token.
    expect(s.anonymize('Smith', 'PERSON')).toBe('[PERSON_1_LAST]');
  });
});
