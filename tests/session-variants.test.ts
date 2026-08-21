/**
 * T057 person-variant unification: repeated mentions of the same person
 * ("John Smith", "John", "Smith") share one replacement in every mode;
 * restore always yields the longest known form; different people stay
 * distinct; renameLabel renames the whole group; serialization round
 * trips keep the canonical form regardless of entry order.
 */
import { describe, expect, it } from 'vitest';
import { AnonymizationSession } from '../src/session.ts';

describe('person-variant unification (T057)', () => {
  it('maps full name and its parts to one placeholder', () => {
    const s = new AnonymizationSession();
    expect(s.anonymize('John Smith', 'PERSON')).toBe('[PERSON_1]');
    expect(s.anonymize('John', 'PERSON')).toBe('[PERSON_1]');
    expect(s.anonymize('Smith', 'PERSON')).toBe('[PERSON_1]');
    // Restore uses the longest known variant.
    expect(s.deanonymize('Hello [PERSON_1]')).toBe('Hello John Smith');
  });

  it('upgrades the canonical restore value when the fuller form arrives later', () => {
    const s = new AnonymizationSession();
    expect(s.anonymize('John', 'PERSON')).toBe('[PERSON_1]');
    expect(s.anonymize('John Smith', 'PERSON')).toBe('[PERSON_1]');
    expect(s.deanonymize('[PERSON_1]')).toBe('John Smith');
  });

  it('keeps different people distinct and stays conservative on honorifics', () => {
    const s = new AnonymizationSession();
    expect(s.anonymize('John Smith', 'PERSON')).toBe('[PERSON_1]');
    expect(s.anonymize('Anna Nowak', 'PERSON')).toBe('[PERSON_2]');
    // 'mr' has no counterpart token in "John Smith": no guessing.
    expect(s.anonymize('Mr. Smith', 'PERSON')).toBe('[PERSON_3]');
    // A bare first name matches the person sharing it (first mapped).
    expect(s.anonymize('Anna', 'PERSON')).toBe('[PERSON_2]');
  });

  it('ambiguous bare names pick the variant with the most shared tokens', () => {
    const s = new AnonymizationSession();
    s.anonymize('John Smith', 'PERSON');
    s.anonymize('John Paul Jones', 'PERSON');
    // "John Paul" shares two tokens with PERSON_2, one with PERSON_1.
    expect(s.anonymize('John Paul', 'PERSON')).toBe('[PERSON_2]');
  });

  it('never unifies on initials or digits alone, and never crosses types', () => {
    const s = new AnonymizationSession();
    expect(s.anonymize('Person 1', 'PERSON')).toBe('[PERSON_1]');
    expect(s.anonymize('Person 11', 'PERSON')).toBe('[PERSON_2]');
    s.anonymize('Acme John', 'COMPANY');
    // A PERSON "John" must not glue onto a COMPANY containing 'john'.
    expect(s.anonymize('John', 'PERSON')).toBe('[PERSON_3]');
  });

  it('surrogate mode reuses the same surrogate for variants', () => {
    const s = new AnonymizationSession({ mode: 'surrogate', salt: 'fixed' });
    const full = s.anonymize('John Smith', 'PERSON');
    expect(s.anonymize('John', 'PERSON')).toBe(full);
    expect(s.deanonymize(full)).toBe('John Smith');
  });

  it('anonymizeText replaces every variant occurrence with the shared token', () => {
    const s = new AnonymizationSession();
    const text = 'John Smith called. Later John called again.';
    const out = s.anonymizeText(text, [
      { type: 'PERSON', value: 'John Smith', start: 0, end: 10, confidence: 1, detector: 't' },
      { type: 'PERSON', value: 'John', start: 25, end: 29, confidence: 1, detector: 't' },
    ]);
    expect(out).toBe('[PERSON_1] called. Later [PERSON_1] called again.');
  });

  it('renameLabel renames the whole variant group and keeps the canonical', () => {
    const s = new AnonymizationSession();
    s.anonymize('John Smith', 'PERSON');
    s.anonymize('John', 'PERSON');
    s.renameLabel('John', '[CLIENT]');
    expect(s.getForward('John')).toBe('[CLIENT]');
    expect(s.getForward('John Smith')).toBe('[CLIENT]');
    expect(s.deanonymize('[CLIENT]')).toBe('John Smith');
  });

  it('deserialize keeps the longest variant canonical regardless of entry order', () => {
    const json = JSON.stringify([
      { original: 'John Smith', replacement: '[PERSON_1]', entity_type: 'PERSON' },
      { original: 'John', replacement: '[PERSON_1]', entity_type: 'PERSON' },
    ]);
    const s = AnonymizationSession.deserialize(json);
    expect(s.deanonymize('[PERSON_1]')).toBe('John Smith');
    // New variants after the restore keep joining the group.
    expect(s.anonymize('Smith', 'PERSON')).toBe('[PERSON_1]');
  });
});
