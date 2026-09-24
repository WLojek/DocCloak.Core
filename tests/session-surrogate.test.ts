/**
 * T043: AnonymizationSession surrogate-mode integration - default mode,
 * round trips, collision safety against session originals, mid-session
 * mode switching and serialization (mode + salt persistence, backward
 * compatible with the plain-array placeholder schema).
 */
import { describe, it, expect } from 'vitest';
import { AnonymizationSession } from '../src/session.ts';
import { FAKE_EMAIL_DOMAINS, generateSurrogate } from '../src/surrogates.ts';
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

// ── T183: document values (audit finding R3) ───────────────

/** PERSON entities for every listed value (first occurrence), reading order. */
function personEntities(text: string, values: string[]): DetectedEntity[] {
  return values.map((value) => entityAt(text, value, 'PERSON'));
}

/** Lowercased tokens of a list of names ("Jan Kowalski" -> jan, kowalski). */
function nameTokens(names: string[]): string[] {
  return names.flatMap((n) => n.toLowerCase().split(/\s+/));
}

describe('surrogates never carry a document value (R3)', () => {
  it('audit PoC: a person mapped later can no longer become an earlier surrogate', () => {
    // The surrogate "Jan Kowalski" would get on its own for this salt is
    // written into the document as a SECOND, later person. Before T183
    // isTaken only saw already-mapped values, so Jan became that person
    // and restore then wrote "Jan Kowalski" twice.
    const probe = new AnonymizationSession({ mode: 'surrogate', salt: SALT });
    const wouldBe = probe.anonymize('Jan Kowalski', 'PERSON');
    const text = `Jan Kowalski pozywa ${wouldBe} o zapłatę.`;
    const session = new AnonymizationSession({ mode: 'surrogate', salt: SALT });
    const out = session.anonymizeText(text, personEntities(text, ['Jan Kowalski', wouldBe]));
    const jan = session.getForward('Jan Kowalski')!;
    expect(jan).not.toBe(wouldBe);
    for (const token of nameTokens([wouldBe])) {
      expect(jan.toLowerCase().split(' ')).not.toContain(token);
    }
    expect(out.toLowerCase()).not.toContain(wouldBe.toLowerCase());
    expect(session.deanonymize(out)).toBe(text);
  });

  it('audit PoC quantified: 10 pool names, 500 salts, 0 document names in the output', () => {
    const names = [
      'Piotr Nowak', 'Anna Kowalska', 'Tomasz Wiśniewski', 'Maria Wójcik', 'Krzysztof Kowalczyk',
      'Katarzyna Kamińska', 'Andrzej Lewandowski', 'Agnieszka Zielińska', 'Marek Szymański', 'Barbara Woźniak',
    ];
    const text = `${names.join(' pozywa, ')} pozywa.`;
    const tokens = nameTokens(names);
    let leaks = 0;
    for (let i = 0; i < 500; i++) {
      const session = new AnonymizationSession({ mode: 'surrogate', salt: `r3-salt-${i}` });
      const out = session.anonymizeText(text, personEntities(text, names)).toLowerCase();
      for (const name of names) if (out.includes(name.toLowerCase())) leaks++;
      // Tokens too: "Adam Nowak" for "Piotr Nowak" is still a leak.
      for (const token of tokens) if (new RegExp(`(?<![\\p{L}])${token}(?![\\p{L}])`, 'u').test(out)) leaks++;
    }
    expect(leaks).toBe(0);
  });

  it('a person surrogate never contains a document name of 3+ letters', () => {
    // "Johnson" for a document naming "John", "Marianna" for "Anna": the
    // containment rule refuses them (whole-word exclusion alone would not).
    for (let i = 0; i < 40; i++) {
      const session = new AnonymizationSession({ mode: 'surrogate', salt: `contain-${i}` });
      session.registerDocumentValues(['Anna', 'John', 'Nowak']);
      for (const value of ['Katarzyna Zielińska', 'Mary Williams', 'Tomasz Kowal']) {
        const surrogate = session.anonymize(value, 'PERSON').toLowerCase();
        expect(surrogate, `${value} -> ${surrogate} (salt ${i})`).not.toMatch(/anna|john|nowak/);
      }
    }
  });

  it('registerDocumentValues protects hosts that anonymize value by value', () => {
    const probe = new AnonymizationSession({ mode: 'surrogate', salt: SALT });
    const wouldBe = probe.anonymize('Jan Kowalski', 'PERSON');
    const session = new AnonymizationSession({ mode: 'surrogate', salt: SALT });
    // Both accepted shapes: plain strings and { value } objects.
    session.registerDocumentValues([wouldBe]);
    session.registerDocumentValues([{ value: 'Nobody Else' }]);
    const jan = session.anonymize('Jan Kowalski', 'PERSON');
    expect(jan).not.toBe(wouldBe);
    expect(session.anonymize('Nobody Else', 'PERSON')).not.toBe(jan);
  });

  it('is cumulative across documents of one session and reset by clear()', () => {
    const probe = new AnonymizationSession({ mode: 'surrogate', salt: SALT });
    const wouldBe = probe.anonymize('Zofia Mazur', 'PERSON');
    const session = new AnonymizationSession({ mode: 'surrogate', salt: SALT });
    const doc1 = `Umowa z ${wouldBe}.`;
    session.anonymizeText(doc1, personEntities(doc1, [wouldBe]));
    // Second document of the same matter: the first document's names are still off limits.
    const doc2 = 'Pismo od Zofia Mazur.';
    session.anonymizeText(doc2, personEntities(doc2, ['Zofia Mazur']));
    expect(session.getForward('Zofia Mazur')).not.toBe(wouldBe);
    session.clear();
    expect(session.anonymize('Zofia Mazur', 'PERSON')).toBe(wouldBe);
  });

  it('keeps non-person surrogates shaped: only the exact value is refused, never its tokens', () => {
    const session = new AnonymizationSession({ mode: 'surrogate', salt: SALT });
    session.registerDocumentValues(['+48 601 234 567', 'ul. Polna 5', 'Nowak Sp. z o.o.', '15.03.2024']);
    const phone = session.anonymize('+48 601 234 567', 'PHONE');
    expect(phone).toMatch(/^\+48 /);
    expect(phone).not.toBe('+48 601 234 567');
    const address = session.anonymize('ul. Polna 5', 'ADDRESS');
    expect(address).toMatch(/^ul\. /);
    expect(address).not.toBe('ul. Polna 5');
    const company = session.anonymize('Nowak Sp. z o.o.', 'COMPANY');
    expect(company).not.toBe('Nowak Sp. z o.o.');
    expect(session.anonymize('15.03.2024', 'DATE')).toMatch(/^\d{2}\.\d{2}\.\d{4}$/);
    // None of them was re-derived: each is the very first draw for this salt.
    for (const e of session.getEntries()) {
      expect(e.replacement).toBe(generateSurrogate(e.original, e.entityType, { salt: SALT }, 0));
    }
  });

  it('falls back to a numeric suffix (exact checks only) when every attempt hits a document name', () => {
    const session = new AnonymizationSession({ mode: 'surrogate', salt: SALT });
    const ctx = { salt: SALT };
    const attempts = Array.from({ length: 24 }, (_, i) => generateSurrogate('Jan Kowalski', 'PERSON', ctx, i));
    session.registerDocumentValues(attempts);
    const surrogate = session.anonymize('Jan Kowalski', 'PERSON');
    // The loop terminates (a token rule can never be satisfied by a suffix)
    // and the result is still not an exact document value.
    expect(surrogate).toBe(`${attempts[23]}2`);
    expect(attempts).not.toContain(surrogate);
    expect(session.deanonymize(surrogate)).toBe('Jan Kowalski');
  });

  it('imported originals count as document values', () => {
    const probe = new AnonymizationSession({ mode: 'surrogate', salt: SALT });
    const wouldBe = probe.anonymize('Jan Kowalski', 'PERSON');
    const session = new AnonymizationSession({ mode: 'surrogate', salt: SALT });
    session.importEntries([{ original: wouldBe, replacement: 'Somebody Mapped', entityType: 'PERSON' }]);
    expect(session.anonymize('Jan Kowalski', 'PERSON')).not.toBe(wouldBe);
  });
});

describe('pool health under the document-value rule (R3)', () => {
  it('200 unique surnames in one document: at least 90% of PERSON surrogates without a numeric suffix', () => {
    const stems = [
      'Brzęczy', 'Grzmoto', 'Kłopoto', 'Skrzypo', 'Wrzosko', 'Trzcin', 'Chrząszczo', 'Dzwono', 'Świerszczo', 'Żmijo',
      'Pszczoło', 'Krzemie', 'Strzało', 'Gwiazdo', 'Błyskawi', 'Piorun', 'Śnieżyn', 'Deszczo', 'Wichro', 'Mgliste',
      'Grudzie', 'Tęczo', 'Jaskół', 'Bocian', 'Sokoło',
    ];
    const endings = ['wicz', 'wski', 'wiak', 'wczyk', 'wiec', 'wiński', 'wnik', 'wiuk'];
    const firsts = ['Piotr', 'Tomasz', 'Marek', 'Krzysztof', 'Andrzej', 'Anna', 'Maria', 'Katarzyna', 'Agnieszka', 'Barbara'];
    const people: string[] = [];
    for (const stem of stems) {
      for (const ending of endings) people.push(`${firsts[people.length % firsts.length]} ${stem}${ending}`);
    }
    expect(new Set(people.map((p) => p.split(' ')[1])).size).toBe(200);
    const text = `${people.join(', ')}.`;
    const session = new AnonymizationSession({ mode: 'surrogate', salt: 'pool-health' });
    const out = session.anonymizeText(text, personEntities(text, people));
    const persons = session.getEntries().filter((e) => e.entityType === 'PERSON');
    expect(persons).toHaveLength(200);
    const unsuffixed = persons.filter((e) => !/\d$/.test(e.replacement)).length;
    expect(unsuffixed).toBeGreaterThanOrEqual(180);
    // Every surrogate is distinct and none is a document name.
    expect(new Set(persons.map((e) => e.replacement)).size).toBe(200);
    const lower = out.toLowerCase();
    for (const person of people) expect(lower).not.toContain(person.toLowerCase());
    expect(session.deanonymize(out)).toBe(text);
  });
});
