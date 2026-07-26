import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { AnonymizationSession } from '../src/session.ts';

const fixturePath = fileURLToPath(
  new URL('./fixtures/python-session-map.json', import.meta.url)
);

describe('AnonymizationSession serialize/deserialize', () => {
  it('round-trips serialize -> deserialize -> deanonymize', () => {
    const session = new AnonymizationSession();
    session.anonymize('Sarah Connor', 'PERSON');
    session.anonymize('sarah@law.com', 'EMAIL');
    session.anonymize('(555) 123-4567', 'PHONE');

    const restored = AnonymizationSession.deserialize(session.serialize());

    const aiResponse =
      'Contact <<REDACTED_1>> at <<REDACTED_2>> or call <<REDACTED_3>>.';
    expect(restored.deanonymize(aiResponse)).toBe(
      'Contact Sarah Connor at sarah@law.com or call (555) 123-4567.'
    );
  });

  it('emits the Python save_map schema field-for-field', () => {
    const session = new AnonymizationSession();
    session.anonymize('John Smith', 'PERSON');
    session.anonymize('john@acme.com', 'EMAIL');

    const parsed = JSON.parse(session.serialize());
    expect(parsed).toEqual([
      {
        original: 'John Smith',
        replacement: '<<REDACTED_1>>',
        entity_type: 'PERSON',
      },
      {
        original: 'john@acme.com',
        replacement: '<<REDACTED_2>>',
        entity_type: 'EMAIL',
      },
    ]);
  });

  it('formats output like Python json.dumps(indent=2, ensure_ascii=False)', () => {
    const session = new AnonymizationSession();
    session.anonymize('Łukasz Żółć', 'PERSON');
    const json = session.serialize();
    // 2-space indent and raw (non-escaped) non-ASCII characters
    expect(json).toContain('  {\n    "original": "Łukasz Żółć",');
    expect(json).not.toContain('\\u');
  });

  it('preserves renamed labels across a round trip', () => {
    const session = new AnonymizationSession();
    session.anonymize('John', 'PERSON');
    session.renameLabel('John', '<<CLIENT_NAME>>');
    session.anonymize('Jane', 'PERSON');

    const restored = AnonymizationSession.deserialize(session.serialize());

    expect(restored.getForward('John')).toBe('<<CLIENT_NAME>>');
    expect(restored.deanonymize('Hello <<CLIENT_NAME>> and <<REDACTED_2>>')).toBe(
      'Hello John and Jane'
    );
  });

  it('omits blanked entries from the serialized map (irreversibility preserved)', () => {
    const session = new AnonymizationSession();
    session.setMode('blanked');
    session.anonymize('John Smith', 'PERSON');
    session.anonymize('john@acme.com', 'EMAIL');

    const json = session.serialize();
    expect(JSON.parse(json)).toEqual([]);
    expect(json).not.toContain('John Smith');
    expect(json).not.toContain('john@acme.com');

    const restored = AnonymizationSession.deserialize(json);
    expect(restored.getEntries()).toHaveLength(0);
    expect(restored.deanonymize('________ wrote to ________')).toBe(
      '________ wrote to ________'
    );
  });

  it('omits only the blanked entries of a mixed-mode session', () => {
    const session = new AnonymizationSession();
    session.anonymize('Alice', 'PERSON'); // <<REDACTED_1>>
    session.setMode('blanked');
    session.anonymize('Bob', 'PERSON'); // ________
    session.setMode('labeled');
    session.anonymize('Carol', 'PERSON'); // <<REDACTED_3>>

    const parsed = JSON.parse(session.serialize());
    expect(parsed).toEqual([
      { original: 'Alice', replacement: '<<REDACTED_1>>', entity_type: 'PERSON' },
      { original: 'Carol', replacement: '<<REDACTED_3>>', entity_type: 'PERSON' },
    ]);
  });

  it('continues counter numbering after restore without collisions', () => {
    const session = new AnonymizationSession();
    session.anonymize('John', 'PERSON');
    session.anonymize('Jane', 'PERSON');

    const restored = AnonymizationSession.deserialize(session.serialize());
    const next = restored.anonymize('Bob', 'PERSON');
    expect(next).toBe('<<REDACTED_3>>');

    expect(
      restored.deanonymize('<<REDACTED_1>>, <<REDACTED_2>>, <<REDACTED_3>>')
    ).toBe('John, Jane, Bob');
  });

  it('does not reissue placeholder numbers when the map has gaps', () => {
    // A mixed-mode session serializes with a numbering gap where the blanked
    // entry was omitted; the restored counter must clear the highest number.
    const session = new AnonymizationSession();
    session.anonymize('Alice', 'PERSON'); // <<REDACTED_1>>
    session.setMode('blanked');
    session.anonymize('Bob', 'PERSON'); // ________ (omitted on serialize)
    session.setMode('labeled');
    session.anonymize('Carol', 'PERSON'); // <<REDACTED_3>>

    const restored = AnonymizationSession.deserialize(session.serialize());
    const next = restored.anonymize('Dave', 'PERSON');
    expect(next).toBe('<<REDACTED_4>>');
    expect(restored.deanonymize('<<REDACTED_3>> met <<REDACTED_4>>')).toBe(
      'Carol met Dave'
    );
  });

  it('restores entity types', () => {
    const session = new AnonymizationSession();
    session.anonymize('John', 'PERSON');
    session.anonymize('john@acme.com', 'EMAIL');

    const restored = AnonymizationSession.deserialize(session.serialize());
    const entries = restored.getEntries();
    expect(entries).toEqual([
      { original: 'John', replacement: '<<REDACTED_1>>', entityType: 'PERSON' },
      {
        original: 'john@acme.com',
        replacement: '<<REDACTED_2>>',
        entityType: 'EMAIL',
      },
    ]);
  });

  it('restores a default (labeled) session like Python load_map', () => {
    const session = new AnonymizationSession();
    session.setMode('blanked');
    session.anonymize('John', 'PERSON');

    const restored = AnonymizationSession.deserialize(session.serialize());
    expect(restored.getMode()).toBe('labeled');
  });

  it('rejects JSON that is not a top-level array', () => {
    expect(() => AnonymizationSession.deserialize('{"original":"x"}')).toThrow(
      /top-level array/
    );
  });

  it('deserializes a map produced by the Python CLI (save_map fixture)', () => {
    const json = readFileSync(fixturePath, 'utf8');
    const session = AnonymizationSession.deserialize(json);

    const entries = session.getEntries();
    expect(entries).toHaveLength(5);
    expect(entries.map((e) => e.entityType)).toEqual([
      'PERSON',
      'EMAIL',
      'PHONE',
      'IBAN',
      'COMPANY',
    ]);
    expect(session.getForward('Zofia Kowalska-Nowak')).toBe('<<REDACTED_1>>');

    const restored = session.deanonymize(
      'Send <<REDACTED_4>> details to <<REDACTED_1>> (<<REDACTED_2>>, ' +
        '<<REDACTED_3>>) at <<REDACTED_5>>.'
    );
    expect(restored).toBe(
      'Send PL61 1090 1014 0000 0712 1981 2874 details to Zofia Kowalska-Nowak ' +
        '(zofia.kowalska@acme.example, +48 601 234 567) at Acme Sp. z o.o..'
    );

    // Counter continues past the Python-issued placeholders
    expect(session.anonymize('New Person', 'PERSON')).toBe('<<REDACTED_6>>');
  });

  it('round-trips the Python fixture byte-for-byte through serialize', () => {
    const json = readFileSync(fixturePath, 'utf8');
    const session = AnonymizationSession.deserialize(json);
    // Python's json.dumps(..., indent=2, ensure_ascii=False) output matches
    // JSON.stringify(entries, null, 2) exactly for this schema.
    expect(session.serialize()).toBe(json.trimEnd());
  });
});
