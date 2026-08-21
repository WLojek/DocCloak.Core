/**
 * T106 importEntries tests: the matter-persistence seeding interface.
 * A session seeded with pairs saved from an earlier session must reuse
 * the stored replacement for a known value, continue placeholder
 * numbering past every imported number, restore old placeholders via
 * deanonymize, honor person-variant unification against imported
 * values, and keep blanked entries irreversible.
 */
import { describe, it, expect } from 'vitest';
import { AnonymizationSession } from '../src/session.ts';
import type { ReplacementEntry } from '../src/types.ts';

describe('AnonymizationSession.importEntries (T106)', () => {
  it('reuses the imported replacement for a known value instead of issuing a new one', () => {
    const session = new AnonymizationSession();
    session.importEntries([
      { original: 'Sarah Connor', replacement: '[PERSON_7]', entityType: 'PERSON' },
    ]);
    expect(session.anonymize('Sarah Connor', 'PERSON')).toBe('[PERSON_7]');
    // No duplicate entry was created.
    expect(session.getEntries()).toEqual([
      { original: 'Sarah Connor', replacement: '[PERSON_7]', entityType: 'PERSON' },
    ]);
  });

  it('continues numbering past the highest imported number, never reusing lower gaps', () => {
    const session = new AnonymizationSession();
    session.importEntries([
      { original: 'Sarah Connor', replacement: '[PERSON_7]', entityType: 'PERSON' },
      { original: 'kyle@resist.org', replacement: '[EMAIL_2]', entityType: 'EMAIL' },
    ]);
    expect(session.anonymize('Kyle Reese', 'PERSON')).toBe('[PERSON_8]');
    expect(session.anonymize('sarah@resist.org', 'EMAIL')).toBe('[EMAIL_3]');
  });

  it('restores placeholders issued in an earlier session via deanonymize', () => {
    const earlier = new AnonymizationSession();
    earlier.anonymize('Sarah Connor', 'PERSON');
    earlier.anonymize('sarah@law.com', 'EMAIL');
    const saved: ReplacementEntry[] = earlier.getEntries();

    const later = new AnonymizationSession();
    later.importEntries(saved);
    expect(later.deanonymize('Contact [PERSON_1] at [EMAIL_1].')).toBe(
      'Contact Sarah Connor at sarah@law.com.',
    );
  });

  it('unifies person variants against imported values (T057 semantics preserved)', () => {
    const session = new AnonymizationSession();
    session.importEntries([
      { original: 'John Smith', replacement: '[PERSON_1]', entityType: 'PERSON' },
    ]);
    expect(session.anonymize('John', 'PERSON')).toBe('[PERSON_1]');
    // The longest variant stays canonical for restore.
    expect(session.deanonymize('Dear [PERSON_1],')).toBe('Dear John Smith,');
  });

  it('keeps the longest original canonical regardless of entry order', () => {
    const session = new AnonymizationSession();
    session.importEntries([
      { original: 'John', replacement: '[PERSON_1]', entityType: 'PERSON' },
      { original: 'John Smith', replacement: '[PERSON_1]', entityType: 'PERSON' },
    ]);
    expect(session.deanonymize('[PERSON_1]')).toBe('John Smith');
  });

  it('keeps imported blanked entries irreversible', () => {
    const session = new AnonymizationSession();
    session.importEntries([
      { original: 'secret value', replacement: '________', entityType: 'OTHER' },
    ]);
    // Forward reuse still works; restore never resurrects the value.
    expect(session.anonymize('secret value', 'OTHER')).toBe('________');
    expect(session.deanonymize('the ________ stays')).toBe('the ________ stays');
  });

  it('keeps legacy angle placeholders restorable without touching counters', () => {
    const session = new AnonymizationSession();
    session.importEntries([
      { original: 'Old Client', replacement: '<<REDACTED_1>>', entityType: 'PERSON' },
    ]);
    expect(session.deanonymize('Hi <<REDACTED_1>>')).toBe('Hi Old Client');
    // A fresh person still starts at [PERSON_1]: the legacy token holds no counter.
    expect(session.anonymize('New Client', 'PERSON')).toBe('[PERSON_1]');
  });

  it('with a shared salt, surrogate sessions seeded from saved pairs stay consistent', () => {
    const salt = 'fixed-test-salt';
    const first = new AnonymizationSession({ mode: 'surrogate', salt });
    const surrogate = first.anonymize('Sarah Connor', 'PERSON');
    const saved = first.getEntries();

    const second = new AnonymizationSession({ mode: 'surrogate', salt });
    second.importEntries(saved);
    // The stored pair wins directly, and restore maps it back.
    expect(second.anonymize('Sarah Connor', 'PERSON')).toBe(surrogate);
    expect(second.deanonymize(`Reply for ${surrogate}.`)).toBe('Reply for Sarah Connor.');
  });
});
