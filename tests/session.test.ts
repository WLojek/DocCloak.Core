import { describe, it, expect } from 'vitest';
import { AnonymizationSession } from '../src/session.ts';

describe('AnonymizationSession', () => {
  it('creates consistent placeholders for the same entity', () => {
    const session = new AnonymizationSession();
    const p1 = session.anonymize('John Smith', 'PERSON');
    const p2 = session.anonymize('John Smith', 'PERSON');
    expect(p1).toBe(p2);
    expect(p1).toBe('[PERSON_1]');
  });

  it('creates incrementing placeholders for different entities of one type', () => {
    const session = new AnonymizationSession();
    const p1 = session.anonymize('John', 'PERSON');
    const p2 = session.anonymize('Jane', 'PERSON');
    expect(p1).toBe('[PERSON_1]');
    expect(p2).toBe('[PERSON_2]');
  });

  it('keeps an independent counter per entity type', () => {
    const session = new AnonymizationSession();
    expect(session.anonymize('John', 'PERSON')).toBe('[PERSON_1]');
    expect(session.anonymize('john@acme.com', 'EMAIL')).toBe('[EMAIL_1]');
    expect(session.anonymize('Jane', 'PERSON')).toBe('[PERSON_2]');
    expect(session.anonymize('jane@acme.com', 'EMAIL')).toBe('[EMAIL_2]');
    expect(session.anonymize('2024-01-01', 'DATE')).toBe('[DATE_1]');
  });

  it('emits well-formed tokens for types with underscores', () => {
    const session = new AnonymizationSession();
    expect(session.anonymize('4111 1111 1111 1111', 'CREDIT_CARD')).toBe('[CREDIT_CARD_1]');
    expect(session.anonymize('10.0.0.1', 'IP_ADDRESS')).toBe('[IP_ADDRESS_1]');
    // Every generated token matches the extension's candidate pattern.
    const candidate = /^\[[A-Z_]+_\d+\]$/;
    for (const { replacement } of session.getEntries()) {
      expect(replacement).toMatch(candidate);
    }
  });

  it('deanonymizes text correctly', () => {
    const session = new AnonymizationSession();
    session.anonymize('John Smith', 'PERSON');
    session.anonymize('jane@acme.com', 'EMAIL');

    const anonymized = '[PERSON_1] sent an email from [EMAIL_1].';
    const restored = session.deanonymize(anonymized);
    expect(restored).toBe('John Smith sent an email from jane@acme.com.');
  });

  it('round-trips correctly', () => {
    const session = new AnonymizationSession();
    session.anonymize('Sarah Connor', 'PERSON');
    session.anonymize('sarah@law.com', 'EMAIL');
    session.anonymize('(555) 123-4567', 'PHONE');

    // Simulate AI response with placeholders
    const aiResponse = 'You should contact [PERSON_1] at [EMAIL_1] or call [PHONE_1].';
    const restored = session.deanonymize(aiResponse);
    expect(restored).toBe('You should contact Sarah Connor at sarah@law.com or call (555) 123-4567.');
  });

  it('handles multiple entities of the same type', () => {
    const session = new AnonymizationSession();
    session.anonymize('John', 'PERSON');
    session.anonymize('Jane', 'PERSON');
    session.anonymize('Bob', 'PERSON');

    const text = '[PERSON_1] met [PERSON_2] and [PERSON_3]';
    const restored = session.deanonymize(text);
    expect(restored).toBe('John met Jane and Bob');
  });

  it('does not confuse [PERSON_1] with [PERSON_11] during restore', () => {
    const session = new AnonymizationSession();
    for (let i = 1; i <= 11; i++) {
      session.anonymize(`Person ${i}`, 'PERSON');
    }
    const restored = session.deanonymize('[PERSON_11] then [PERSON_1]');
    expect(restored).toBe('Person 11 then Person 1');
  });

  it('clears all mappings', () => {
    const session = new AnonymizationSession();
    session.anonymize('John', 'PERSON');
    session.clear();
    expect(session.getEntries()).toHaveLength(0);
    const p = session.anonymize('Jane', 'PERSON');
    expect(p).toBe('[PERSON_1]');
  });

  it('anonymizeText replaces entities in correct positions', () => {
    const session = new AnonymizationSession();
    const text = 'Call John at john@test.com';
    const entities = [
      { type: 'PERSON' as const, value: 'John', start: 5, end: 9, confidence: 0.9, detector: 'test' },
      { type: 'EMAIL' as const, value: 'john@test.com', start: 13, end: 26, confidence: 0.95, detector: 'test' },
    ];
    const result = session.anonymizeText(text, entities);
    // anonymizeText sorts end-to-start, but per-type counters make the
    // outcome independent of processing order here.
    expect(result).toBe('Call [PERSON_1] at [EMAIL_1]');
  });

  it('anonymizeText then deanonymize round-trips byte-identically', () => {
    const session = new AnonymizationSession();
    const text =
      'John Smith and Jane Doe met on 2024-05-01. ' +
      'Write to john@acme.com or jane@acme.com before 2024-06-15.';
    const find = (value: string, type: 'PERSON' | 'EMAIL' | 'DATE') => {
      const start = text.indexOf(value);
      return { type, value, start, end: start + value.length, confidence: 0.9, detector: 'test' };
    };
    const entities = [
      find('John Smith', 'PERSON'),
      find('Jane Doe', 'PERSON'),
      find('2024-05-01', 'DATE'),
      find('john@acme.com', 'EMAIL'),
      find('jane@acme.com', 'EMAIL'),
      find('2024-06-15', 'DATE'),
    ];
    const redacted = session.anonymizeText(text, entities);
    expect(redacted).toBe(
      '[PERSON_2] and [PERSON_1] met on [DATE_2]. ' +
        'Write to [EMAIL_2] or [EMAIL_1] before [DATE_1].'
    );
    expect(session.deanonymize(redacted)).toBe(text);
  });

  it('getEntries returns all mappings', () => {
    const session = new AnonymizationSession();
    session.anonymize('John', 'PERSON');
    session.anonymize('test@test.com', 'EMAIL');
    const entries = session.getEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].original).toBe('John');
    expect(entries[0].entityType).toBe('PERSON');
    expect(entries[1].original).toBe('test@test.com');
    expect(entries[1].entityType).toBe('EMAIL');
  });

  it('uses blanked mode when set', () => {
    const session = new AnonymizationSession();
    session.setMode('blanked');
    const p = session.anonymize('John', 'PERSON');
    expect(p).toBe('________');
  });

  it('blanked entries do not consume typed counter numbers', () => {
    const session = new AnonymizationSession();
    session.anonymize('Alice', 'PERSON');
    session.setMode('blanked');
    session.anonymize('Bob', 'PERSON');
    session.setMode('labeled');
    expect(session.anonymize('Carol', 'PERSON')).toBe('[PERSON_2]');
  });

  it('renames labels and updates mappings', () => {
    const session = new AnonymizationSession();
    session.anonymize('John', 'PERSON');
    session.renameLabel('John', '[CLIENT_NAME]');
    expect(session.getForward('John')).toBe('[CLIENT_NAME]');
    const restored = session.deanonymize('Hello [CLIENT_NAME]');
    expect(restored).toBe('Hello John');
  });

  it('never reissues a placeholder taken by a rename', () => {
    const session = new AnonymizationSession();
    session.anonymize('John', 'PERSON');
    // The user renames John's label to the number the counter would
    // issue next; the generator must skip it.
    session.renameLabel('John', '[PERSON_2]');
    expect(session.anonymize('Jane', 'PERSON')).toBe('[PERSON_3]');
    expect(session.deanonymize('[PERSON_2] met [PERSON_3]')).toBe('John met Jane');
  });

  it('restores legacy <<REDACTED_N>> text via a restored old-format map', () => {
    // A map serialized before 0.9.0 still restores old-format AI replies.
    const legacyMap = JSON.stringify([
      { original: 'John Smith', replacement: '<<REDACTED_1>>', entity_type: 'PERSON' },
    ]);
    const session = AnonymizationSession.deserialize(legacyMap);
    expect(session.deanonymize('foo <<REDACTED_1>> bar')).toBe('foo John Smith bar');
    // New placeholders issued afterwards use the typed format and cannot
    // collide with the legacy ones.
    expect(session.anonymize('Jane', 'PERSON')).toBe('[PERSON_1]');
  });
});
