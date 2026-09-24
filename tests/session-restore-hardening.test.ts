/**
 * T182 restore hardening (security audit 2026-09, findings R4, R6, R9,
 * R11, R14 and the pool half of R3).
 *
 * R4: deanonymize is ONE pass over the reply with one longest-first
 *     alternation of every key. Restored text is never rescanned (a key
 *     equal to another entry's original cannot rewrite it) and natural
 *     keys carry script-aware boundaries so prose that merely contains a
 *     key ("Bob" for "Bo", "Nowaka" for "Nowak") is left alone, while CJK
 *     keys, written without separators, still restore inside 王伟说.
 * R6: renameLabel refuses a blank label and a label another value owns.
 * R9: literal "[PERSON_1]" in user text reserves that number.
 * R11: deserialize/importEntries validate shape and size.
 * R14: personTokens is linear on a hostile 100 KB span.
 */
import { describe, expect, it } from 'vitest';
import { AnonymizationSession } from '../src/session.ts';
import type { DetectedEntity, ReplacementEntry } from '../src/types.ts';

function surrogateSession(entries: Array<[string, string]>): AnonymizationSession {
  return AnonymizationSession.deserialize(
    JSON.stringify({
      mode: 'surrogate',
      salt: 'fixed',
      entries: entries.map(([original, replacement]) => ({
        original,
        replacement,
        entity_type: 'PERSON',
      })),
    }),
  );
}

function entityAt(text: string, value: string, type: DetectedEntity['type'] = 'PERSON'): DetectedEntity {
  const start = text.indexOf(value);
  if (start === -1) throw new Error(`"${value}" not in text`);
  return { type, value, start, end: start + value.length, confidence: 1, detector: 'test' };
}

// ── R4: single pass, never rescan restored text ────────────

describe('deanonymize is a single pass (R4)', () => {
  it('Anna -> Maria chain: a key equal to another original never rewrites restored text', () => {
    // Audit PoC (a): "Maria" got the surrogate "Anna" while "Anna Kowalska"
    // is a different person. Sequential replaceAll turned the restored
    // "Anna Kowalska" into "Maria Kowalska"; one pass keeps her intact.
    const s = surrogateSession([
      ['Maria Wiśniewska', 'Zofia Dąbrowska'],
      ['Maria', 'Anna'],
      ['Anna Kowalska', 'Ewa Zielińska'],
    ]);
    expect(s.deanonymize('Zofia Dąbrowska and Ewa Zielińska met; Anna signed.')).toBe(
      'Maria Wiśniewska and Anna Kowalska met; Maria signed.',
    );
  });

  it('labeled chain: a restored value equal to a surrogate key is not restored twice', () => {
    const s = AnonymizationSession.deserialize(
      JSON.stringify({
        mode: 'surrogate',
        salt: 'fixed',
        entries: [
          { original: 'Adam Nowak', replacement: '[PERSON_1]', entity_type: 'PERSON' },
          { original: 'Jan Kowalski', replacement: 'Adam Nowak', entity_type: 'PERSON' },
        ],
      }),
    );
    expect(s.deanonymize('[PERSON_1] and Adam Nowak')).toBe('Adam Nowak and Jan Kowalski');
  });

  it('"martin paper" style prose is untouched: keys are case-sensitive whole words', () => {
    // Audit PoC (b). A Title-case surrogate key never fires on the
    // lowercase dictionary word, nor inside a longer name; the exact key
    // itself still restores.
    const s = surrogateSession([
      ['John Smith', 'Adam Martin'],
      ['Smith', 'Martin'],
    ]);
    const reply = 'see the martin paper by Martinez; Adam Martin and St. Martin agree';
    expect(s.deanonymize(reply)).toBe(
      'see the martin paper by Martinez; John Smith and St. Smith agree',
    );
  });

  it('"Bob went to Boston": a short key never fires inside a longer word', () => {
    // Audit PoC (c): Sven -> Bo turned "Bob" into "Svenb".
    const s = surrogateSession([['Sven', 'Bo']]);
    expect(s.deanonymize('Bob went to Boston with Bo.')).toBe('Bob went to Boston with Sven.');
    expect(s.deanonymize('Bo, Bo! (Bo)')).toBe('Sven, Sven! (Sven)');
  });

  it('inflected forms of a natural key stay untouched (no guessed restore)', () => {
    const s = surrogateSession([['Jan Kowalski', 'Adam Nowak']]);
    expect(s.deanonymize('Adam Nowak, Adam Nowaka, xAdam Nowak, Adam Nowak2')).toBe(
      'Jan Kowalski, Adam Nowaka, xAdam Nowak, Adam Nowak2',
    );
  });

  it('Cyrillic keys are bounded like Latin ones', () => {
    const s = surrogateSession([['Петро', 'Іван']]);
    expect(s.deanonymize('Іван і Івана та Іване')).toBe('Петро і Івана та Іване');
  });

  it('王伟说 restores in surrogate mode: CJK keys carry no boundaries', () => {
    const s = new AnonymizationSession({ mode: 'surrogate', salt: 'fixed' });
    const surrogate = s.anonymize('王伟', 'PERSON');
    expect(surrogate).toMatch(/^[一-鿿]{2}$/u);
    expect(s.deanonymize(`${surrogate}说`)).toBe('王伟说');
    expect(s.deanonymize(`${surrogate}先生和${surrogate}`)).toBe('王伟先生和王伟');
  });

  it('王伟说 round-trips in labeled mode too', () => {
    const s = new AnonymizationSession();
    const text = '王伟说：好。';
    const redacted = s.anonymizeText(text, [entityAt(text, '王伟')]);
    expect(redacted).toBe('[PERSON_1]说：好。');
    expect(s.deanonymize(redacted)).toBe(text);
  });

  it('keys whose edges are not letters or digits need no boundary on that side', () => {
    const s = AnonymizationSession.deserialize(
      JSON.stringify({
        mode: 'surrogate',
        salt: 'fixed',
        entries: [
          { original: '+48 601 234 567', replacement: '+48 555 010 203', entity_type: 'PHONE' },
          { original: 'jan@firma.pl', replacement: 'adam.nowak@example.com', entity_type: 'EMAIL' },
          { original: '$1,234.56', replacement: '$9,876.10', entity_type: 'CURRENCY' },
        ],
      }),
    );
    expect(s.deanonymize('tel.+48 555 010 203, <adam.nowak@example.com>, cost:$9,876.10.')).toBe(
      'tel.+48 601 234 567, <jan@firma.pl>, cost:$1,234.56.',
    );
    // A digit glued to a digit-edged key is a different number.
    expect(s.deanonymize('+48 555 010 2034 and $9,876.100')).toBe('+48 555 010 2034 and $9,876.100');
  });

  it('token-shaped keys match anywhere, including glued and possessive forms', () => {
    const s = new AnonymizationSession();
    s.anonymize('John Smith', 'PERSON');
    s.anonymize('jane@acme.com', 'EMAIL');
    s.renameLabel('jane@acme.com', '<<MAIL>>');
    expect(s.deanonymize("[PERSON_1]'s<<MAIL>>x[PERSON_1]")).toBe("John Smith'sjane@acme.comxJohn Smith");
  });

  it('longest key wins at a position, whatever the insertion order', () => {
    const s = surrogateSession([
      ['John', 'Adam'],
      ['John Smith', 'Adam Nowak'],
      ['John Smith Jr', 'Adam Nowak Jr'],
    ]);
    expect(s.deanonymize('Adam Nowak Jr, Adam Nowak, Adam')).toBe('John Smith Jr, John Smith, John');
  });

  it('regex metacharacters in keys are literal and $ in originals stays inert', () => {
    const s = AnonymizationSession.deserialize(
      JSON.stringify([
        { original: "$&$'$100", replacement: '[CURRENCY_1]', entity_type: 'CURRENCY' },
        { original: 'John', replacement: 'C++ (dev).*', entity_type: 'PERSON' },
      ]),
    );
    expect(s.deanonymize('Pay [CURRENCY_1] to C++ (dev).* now')).toBe("Pay $&$'$100 to John now");
    expect(s.deanonymize('C++ (dev)x* and Cxx (dev).*')).toBe('C++ (dev)x* and Cxx (dev).*');
  });

  it('the compiled alternation is refreshed after every map mutation', () => {
    const s = new AnonymizationSession();
    s.anonymize('John', 'PERSON');
    expect(s.deanonymize('[PERSON_1] [PERSON_2]')).toBe('John [PERSON_2]');
    s.anonymize('Jane', 'PERSON');
    expect(s.deanonymize('[PERSON_1] [PERSON_2]')).toBe('John Jane');
    s.renameLabel('Jane', '[CLIENT]');
    expect(s.deanonymize('[PERSON_2] [CLIENT]')).toBe('[PERSON_2] Jane');
    s.importEntries([{ original: 'Bob', replacement: '[PERSON_7]', entityType: 'PERSON' }]);
    expect(s.deanonymize('[PERSON_7]')).toBe('Bob');
    s.clear();
    expect(s.deanonymize('[PERSON_1] [CLIENT] [PERSON_7]')).toBe('[PERSON_1] [CLIENT] [PERSON_7]');
  });

  it('the tolerant pass still runs after the exact pass', () => {
    const s = new AnonymizationSession();
    s.anonymize('John Smith', 'PERSON');
    s.anonymize('Smith', 'PERSON');
    expect(s.deanonymize('[PERSON_1] met **[person_1_last]**')).toBe('John Smith met **Smith**');
  });
});

// ── R6: renameLabel guards ─────────────────────────────────

describe('renameLabel refuses unusable labels (R6)', () => {
  it('empty or whitespace label: no pairs, no mutation, restore unchanged', () => {
    const s = new AnonymizationSession();
    s.anonymize('John Smith', 'PERSON');
    for (const label of ['', ' ', '\t\n']) {
      expect(s.renameLabel('John Smith', label)).toEqual([]);
      expect(s.getForward('John Smith')).toBe('[PERSON_1]');
    }
    expect(s.deanonymize('Hi there, [PERSON_1]')).toBe('Hi there, John Smith');
  });

  it('label collision: a label another value restores to is refused', () => {
    const s = new AnonymizationSession();
    s.anonymize('John Smith', 'PERSON');
    s.anonymize('Jane Roe', 'PERSON');
    s.anonymize('Smith', 'PERSON');
    expect(s.renameLabel('Jane Roe', '[PERSON_1]')).toEqual([]);
    expect(s.renameLabel('Jane Roe', '[PERSON_1_LAST]')).toEqual([]);
    expect(s.getForward('Jane Roe')).toBe('[PERSON_2]');
    expect(s.deanonymize('[PERSON_1], [PERSON_2], [PERSON_1_LAST]')).toBe('John Smith, Jane Roe, Smith');
    // A free label still works.
    expect(s.renameLabel('Jane Roe', '[PERSON_9]')).toEqual([['[PERSON_2]', '[PERSON_9]']]);
  });

  it('collision with a surrogate key is refused as well', () => {
    const s = new AnonymizationSession({ mode: 'surrogate', salt: 'fixed' });
    const a = s.anonymize('John Smith', 'PERSON');
    s.anonymize('Jane Roe', 'PERSON');
    expect(s.renameLabel('Jane Roe', a)).toEqual([]);
    expect(s.deanonymize(a)).toBe('John Smith');
  });
});

// ── R9: literal placeholders in user text ──────────────────

describe('literal placeholders in the input reserve their number (R9)', () => {
  it('[PERSON_1] in a template never collides with a generated placeholder', () => {
    const s = new AnonymizationSession();
    const text = 'Template: [PERSON_1] is a placeholder. Real: Jane Roe.';
    const redacted = s.anonymizeText(text, [entityAt(text, 'Jane Roe')]);
    expect(redacted).toBe('Template: [PERSON_1] is a placeholder. Real: [PERSON_2].');
    expect(s.deanonymize(redacted)).toBe(text);
  });

  it('the highest literal number per type wins; other types are independent', () => {
    const s = new AnonymizationSession();
    const text = 'See [CREDIT_CARD_7], [CREDIT_CARD_3] and [PERSON_2]; card 4111 1111 1111 1111 of Ann Lee.';
    const redacted = s.anonymizeText(text, [
      entityAt(text, '4111 1111 1111 1111', 'CREDIT_CARD'),
      entityAt(text, 'Ann Lee'),
    ]);
    expect(redacted).toBe('See [CREDIT_CARD_7], [CREDIT_CARD_3] and [PERSON_2]; card [CREDIT_CARD_8] of [PERSON_3].');
    expect(s.anonymize('x@y.z', 'EMAIL')).toBe('[EMAIL_1]');
    expect(s.deanonymize(redacted)).toBe(text);
  });

  it('absurd literal counters are ignored rather than breaking numbering', () => {
    const s = new AnonymizationSession();
    const text = '[PERSON_99999999999999999999] and Jane Roe';
    expect(s.anonymizeText(text, [entityAt(text, 'Jane Roe')])).toBe(
      '[PERSON_99999999999999999999] and [PERSON_1]',
    );
  });
});

// ── R11: import validation ─────────────────────────────────

describe('deserialize / importEntries validation (R11)', () => {
  const entry = (i: number): ReplacementEntry => ({
    original: `Person ${i}`,
    replacement: `[PERSON_${i}]`,
    entityType: 'PERSON',
  });
  const wire = (i: number) => ({ original: `Person ${i}`, replacement: `[PERSON_${i}]`, entity_type: 'PERSON' });

  it('accepts exactly 10 000 entries and rejects 10 001', () => {
    const ok = new AnonymizationSession();
    ok.importEntries(Array.from({ length: 10_000 }, (_, i) => entry(i + 1)));
    expect(ok.getEntries()).toHaveLength(10_000);
    expect(ok.deanonymize('[PERSON_10000] and [PERSON_1]')).toBe('Person 10000 and Person 1');

    const tooMany = Array.from({ length: 10_001 }, (_, i) => entry(i + 1));
    expect(() => new AnonymizationSession().importEntries(tooMany)).toThrow(/too many entries/);
    expect(() =>
      AnonymizationSession.deserialize(JSON.stringify(Array.from({ length: 10_001 }, (_, i) => wire(i + 1)))),
    ).toThrow(/too many entries/);
    expect(() =>
      AnonymizationSession.deserialize(
        JSON.stringify({ mode: 'surrogate', salt: 'x', entries: Array.from({ length: 10_001 }, (_, i) => wire(i + 1)) }),
      ),
    ).toThrow(/too many entries/);
  });

  it('rejects malformed entries with a descriptive error', () => {
    const bad: Array<[string, RegExp]> = [
      ['[null]', /entry #0: expected an object/],
      ['[["a","b"]]', /entry #0: expected an object/],
      ['[{"original":1,"replacement":"[X_1]","entity_type":"OTHER"}]', /"original" must be a non-empty string/],
      ['[{"original":"","replacement":"[X_1]","entity_type":"OTHER"}]', /"original" must be a non-empty string/],
      ['[{"original":"v","replacement":"","entity_type":"OTHER"}]', /"replacement" must be a non-blank string/],
      ['[{"original":"v","replacement":"  ","entity_type":"OTHER"}]', /"replacement" must be a non-blank string/],
      ['[{"original":"v","replacement":null,"entity_type":"OTHER"}]', /"replacement" must be a non-blank string/],
      ['[{"original":"v","replacement":"[X_1]"}]', /"entityType" must be a non-empty string/],
      ['[{"original":"ok","replacement":"[X_1]","entity_type":"OTHER"},{"original":"v","replacement":""}]', /entry #1/],
    ];
    for (const [json, message] of bad) {
      expect(() => AnonymizationSession.deserialize(json), json).toThrow(message);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => new AnonymizationSession().importEntries('nope' as any)).toThrow(/expected an array/);
  });

  it('a rejected import leaves the session untouched', () => {
    const s = new AnonymizationSession();
    s.anonymize('John', 'PERSON');
    expect(() =>
      s.importEntries([
        entry(5),
        { original: 'v', replacement: '', entityType: 'OTHER' },
      ]),
    ).toThrow(/entry #1/);
    expect(s.getEntries()).toEqual([{ original: 'John', replacement: '[PERSON_1]', entityType: 'PERSON' }]);
    expect(s.deanonymize('[PERSON_5]')).toBe('[PERSON_5]');
  });

  it('still accepts legacy many-to-one maps (T171)', () => {
    const s = AnonymizationSession.deserialize(
      JSON.stringify([
        { original: 'John Smith', replacement: '[PERSON_1]', entity_type: 'PERSON' },
        { original: 'John', replacement: '[PERSON_1]', entity_type: 'PERSON' },
      ]),
    );
    expect(s.deanonymize('[PERSON_1]')).toBe('John Smith');
  });
});

// ── R14: personTokens bound ────────────────────────────────

describe('personTokens is linear on hostile spans (R14)', () => {
  // Guards linearity (the quadratic strip took seconds here), not hardware:
  // shared CI runners are 3 to 5 times slower than a laptop.
  it('two 100 KB punctuation-heavy PERSON spans map in under 2 s', () => {
    const s = new AnonymizationSession();
    const a = 'a' + '.'.repeat(100_000) + 'b';
    const b = 'x' + ','.repeat(100_000) + 'y';
    const t0 = performance.now();
    s.anonymize(a, 'PERSON');
    // The second value runs the variant test against the first (both
    // tokenized again), which is where the quadratic strip used to bite.
    s.anonymize(b, 'PERSON');
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(s.getEntries()).toHaveLength(2);
  });

  it('still strips ordinary edge punctuation', () => {
    const s = new AnonymizationSession();
    expect(s.anonymize('John Smith', 'PERSON')).toBe('[PERSON_1]');
    expect(s.anonymize('"Smith",', 'PERSON')).toBe('[PERSON_1_LAST]');
  });
});
