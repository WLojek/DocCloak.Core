/**
 * T043: AnonymizationSession surrogate-mode integration - default mode,
 * round trips, collision safety against session originals, mid-session
 * mode switching and serialization (mode + salt persistence, backward
 * compatible with the plain-array placeholder schema).
 */
import { describe, it, expect } from 'vitest';
import { AnonymizationSession } from '../src/session.ts';
import { FAKE_EMAIL_DOMAINS } from '../src/surrogates.ts';
import type { DetectedEntity } from '../src/types.ts';

const SALT = 'session-test-salt';

function entityAt(
  text: string,
  value: string,
  type: DetectedEntity['type'],
): DetectedEntity {
  const start = text.indexOf(value);
  if (start === -1) throw new Error(`"${value}" not in text`);
  return { type, value, start, end: start + value.length, confidence: 0.9, detector: 'test' };
}

function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L');
}

describe('mode default and construction', () => {
  it('defaults to labeled placeholders', () => {
    const session = new AnonymizationSession();
    expect(session.getMode()).toBe('labeled');
    expect(session.anonymize('John', 'PERSON')).toBe('[PERSON_1]');
  });

  it('accepts mode and salt via constructor options', () => {
    const session = new AnonymizationSession({ mode: 'surrogate', salt: SALT });
    expect(session.getMode()).toBe('surrogate');
    expect(session.getSalt()).toBe(SALT);
  });

  it('generates a fresh salt per session by default', () => {
    const a = new AnonymizationSession();
    const b = new AnonymizationSession();
    expect(a.getSalt()).not.toBe(b.getSalt());
  });
});

describe('surrogate replacements', () => {
  it('replaces with a non-bracket surrogate, stable per value', () => {
    const session = new AnonymizationSession({ mode: 'surrogate', salt: SALT });
    const s1 = session.anonymize('John Smith', 'PERSON');
    expect(s1).not.toMatch(/[[\]<>]/);
    expect(s1).not.toBe('John Smith');
    expect(session.anonymize('John Smith', 'PERSON')).toBe(s1);
  });

  it('deanonymize restores surrogates via exact-literal lookup (panel restore path)', () => {
    const session = new AnonymizationSession({ mode: 'surrogate', salt: SALT });
    const person = session.anonymize('Jan Kowalski', 'PERSON');
    const phone = session.anonymize('+48 601 234 567', 'PHONE');
    const reply = `Please call ${person} at ${phone}. ${person} confirmed.`;
    expect(session.deanonymize(reply)).toBe(
      'Please call Jan Kowalski at +48 601 234 567. Jan Kowalski confirmed.',
    );
  });

  it('anonymizeText round-trips byte-identically in surrogate mode', () => {
    const session = new AnonymizationSession({ mode: 'surrogate', salt: SALT });
    const text =
      'Jan Kowalski (jan.kowalski@firma.pl, +48 601 234 567) signed on 15.03.2024. ' +
      'IBAN: PL61 1090 1014 0000 0712 1981 2874.';
    const entities = [
      entityAt(text, 'Jan Kowalski', 'PERSON'),
      entityAt(text, 'jan.kowalski@firma.pl', 'EMAIL'),
      entityAt(text, '+48 601 234 567', 'PHONE'),
      entityAt(text, '15.03.2024', 'DATE'),
      entityAt(text, 'PL61 1090 1014 0000 0712 1981 2874', 'IBAN'),
    ];
    const redacted = session.anonymizeText(text, entities);
    expect(redacted).not.toContain('Jan Kowalski');
    expect(redacted).not.toContain('jan.kowalski@firma.pl');
    expect(redacted).not.toMatch(/\[[A-Z_]+_\d+\]/);
    expect(session.deanonymize(redacted)).toBe(text);
  });

  it('derives the email from the person surrogate even when the email precedes the person', () => {
    const session = new AnonymizationSession({ mode: 'surrogate', salt: SALT });
    const text = 'Write to jan.kowalski@firma.pl or ask Jan Kowalski directly.';
    const entities = [
      entityAt(text, 'jan.kowalski@firma.pl', 'EMAIL'),
      entityAt(text, 'Jan Kowalski', 'PERSON'),
    ];
    const redacted = session.anonymizeText(text, entities);
    const personSurrogate = session.getForward('Jan Kowalski')!;
    const emailSurrogate = session.getForward('jan.kowalski@firma.pl')!;
    const expectedLocal = fold(personSurrogate).toLowerCase().replace(/\s+/g, '.');
    expect(emailSurrogate.startsWith(`${expectedLocal}@`)).toBe(true);
    expect(FAKE_EMAIL_DOMAINS).toContain(emailSurrogate.split('@')[1]);
    expect(session.deanonymize(redacted)).toBe(text);
  });

  it('never issues a surrogate equal to another original value in the session', () => {
    // Learn what surrogate "John Smith" would get for this salt, then make
    // that exact string an ORIGINAL in a fresh same-salt session: the
    // colliding candidate must be re-derived.
    const probe = new AnonymizationSession({ mode: 'surrogate', salt: SALT });
    const wouldBe = probe.anonymize('John Smith', 'PERSON');

    const session = new AnonymizationSession({ mode: 'surrogate', salt: SALT });
    session.anonymize(wouldBe, 'PERSON'); // the surrogate string is now an original
    const actual = session.anonymize('John Smith', 'PERSON');
    expect(actual).not.toBe(wouldBe);
    expect(session.deanonymize(actual)).not.toBe(actual);
  });

  it('never issues the same surrogate twice', () => {
    const session = new AnonymizationSession({ mode: 'surrogate', salt: SALT });
    const seen = new Set<string>();
    for (const value of ['2024-03-15', '2024-04-02', '2024-05-20', '15.03.2024']) {
      const s = session.anonymize(value, 'DATE');
      expect(seen.has(s)).toBe(false);
      seen.add(s);
    }
  });
});

describe('mid-session mode switch', () => {
  it('takes effect on the next redaction and never corrupts the active map', () => {
    const session = new AnonymizationSession();
    const p1 = session.anonymize('Alice Green', 'PERSON');
    expect(p1).toBe('[PERSON_1]');

    session.setMode('surrogate');
    const s1 = session.anonymize('Bob Young', 'PERSON');
    expect(s1).not.toMatch(/^\[/);

    // Both old and new entries restore.
    expect(session.deanonymize(`${p1} met ${s1}`)).toBe('Alice Green met Bob Young');
    // The pre-switch mapping is untouched.
    expect(session.getForward('Alice Green')).toBe('[PERSON_1]');

    session.setMode('labeled');
    expect(session.anonymize('Carol King', 'PERSON')).toBe('[PERSON_2]');
    expect(session.deanonymize(`${p1}, ${s1}, [PERSON_2]`)).toBe(
      'Alice Green, Bob Young, Carol King',
    );
  });
});

describe('serialization', () => {
  it('placeholder-mode serialize keeps the plain-array Python schema', () => {
    const session = new AnonymizationSession({ salt: SALT });
    session.anonymize('John Smith', 'PERSON');
    const parsed = JSON.parse(session.serialize());
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toEqual([
      { original: 'John Smith', replacement: '[PERSON_1]', entity_type: 'PERSON' },
    ]);
  });

  it('surrogate-mode serialize wraps entries with mode and salt', () => {
    const session = new AnonymizationSession({ mode: 'surrogate', salt: SALT });
    const s = session.anonymize('John Smith', 'PERSON');
    const parsed = JSON.parse(session.serialize()) as {
      mode: string;
      salt: string;
      entries: Array<{ original: string; replacement: string; entity_type: string }>;
    };
    expect(parsed.mode).toBe('surrogate');
    expect(parsed.salt).toBe(SALT);
    expect(parsed.entries).toEqual([
      { original: 'John Smith', replacement: s, entity_type: 'PERSON' },
    ]);
  });

  it('deserialize restores mode, salt, mappings and restore behavior', () => {
    const session = new AnonymizationSession({ mode: 'surrogate', salt: SALT });
    const person = session.anonymize('Jan Kowalski', 'PERSON');
    const email = session.anonymize('jan.kowalski@firma.pl', 'EMAIL');

    const restored = AnonymizationSession.deserialize(session.serialize());
    expect(restored.getMode()).toBe('surrogate');
    expect(restored.getSalt()).toBe(SALT);
    expect(restored.getForward('Jan Kowalski')).toBe(person);
    expect(restored.deanonymize(`${person} <${email}>`)).toBe(
      'Jan Kowalski <jan.kowalski@firma.pl>',
    );
  });

  it('reproduces surrogates for new values after a restore (same salt)', () => {
    const session = new AnonymizationSession({ mode: 'surrogate', salt: SALT });
    session.anonymize('Jan Kowalski', 'PERSON');
    const restored = AnonymizationSession.deserialize(session.serialize());
    // The same new value derives the same surrogate on both sides.
    expect(restored.anonymize('+48 601 234 567', 'PHONE')).toBe(
      session.anonymize('+48 601 234 567', 'PHONE'),
    );
  });

  it('tolerates a wrapper without a salt (fresh salt, mappings intact)', () => {
    const json = JSON.stringify({
      mode: 'surrogate',
      entries: [{ original: 'John', replacement: 'Kevin', entity_type: 'PERSON' }],
    });
    const restored = AnonymizationSession.deserialize(json);
    expect(restored.getMode()).toBe('surrogate');
    expect(restored.getSalt()).toMatch(/^[0-9a-f]{32}$/);
    expect(restored.deanonymize('Kevin called')).toBe('John called');
  });

  it('still rejects an object that is neither array nor surrogate wrapper', () => {
    expect(() => AnonymizationSession.deserialize('{"mode":"other","entries":[]}')).toThrow(
      /top-level array/,
    );
  });

  it('counter derivation still works for a mixed placeholder/surrogate map', () => {
    const session = new AnonymizationSession({ salt: SALT });
    session.anonymize('Alice Green', 'PERSON'); // [PERSON_1]
    session.setMode('surrogate');
    session.anonymize('Bob Young', 'PERSON'); // surrogate

    const restored = AnonymizationSession.deserialize(session.serialize());
    expect(restored.getMode()).toBe('surrogate');
    restored.setMode('labeled');
    expect(restored.anonymize('Carol King', 'PERSON')).toBe('[PERSON_2]');
  });
});
