/**
 * T098 fuzzy restore hardening: LLM replies mangle placeholder tokens
 * (case changes, separator swaps, markdown wrapping, dropped brackets,
 * stray punctuation). The mangling corpus below is built from realistic
 * LLM output shapes; every variant must restore to the exact original.
 * The ambiguity suite proves the safety rule: a token that could match
 * more than one mapping entry, or no entry, is NEVER guessed - the text
 * stays untouched (a wrong restore silently corrupts the document; a
 * missed restore is visible and recoverable). The regression suite pins
 * the exact-match fast path.
 */
import { describe, it, expect } from 'vitest';
import {
  AnonymizationSession,
  buildTolerantTokenIndex,
  canonicalPlaceholderForm,
  canonicalTypePrefix,
  resolveMangledToken,
} from '../src/session.ts';

/** Fixed mapping (deserialize gives exact control over the tokens). */
function makeSession(): AnonymizationSession {
  return AnonymizationSession.deserialize(
    JSON.stringify([
      { original: 'John Smith', replacement: '[PERSON_1]', entity_type: 'PERSON' },
      { original: 'Anna Lind', replacement: '[PERSON_11]', entity_type: 'PERSON' },
      { original: 'jane@acme.com', replacement: '[EMAIL_1]', entity_type: 'EMAIL' },
      { original: '4111 1111 1111 1111', replacement: '[CREDIT_CARD_1]', entity_type: 'CREDIT_CARD' },
      { original: 'Old Value', replacement: '<<REDACTED_1>>', entity_type: 'OTHER' },
    ]),
  );
}

// ── The mangling corpus ────────────────────────────────────
// Each entry: [description, mangled fragment as an LLM wrote it, the
// fragment it must restore to]. Markdown characters OUTSIDE the token
// stay in the text (they are the site's rendering concern); characters
// consumed as part of the token (brackets, inner emphasis, inner
// punctuation) are replaced with it. Fragments are embedded in prose by
// the test so boundaries behave like real replies.

const CORPUS: Array<[string, string, string]> = [
  // Exact forms (the corpus includes the unmangled baseline on purpose).
  ['exact typed token', '[PERSON_1]', 'John Smith'],
  ['exact underscore-bearing type', '[CREDIT_CARD_1]', '4111 1111 1111 1111'],
  ['exact legacy token', '<<REDACTED_1>>', 'Old Value'],
  // Case changes.
  ['lowercased', '[person_1]', 'John Smith'],
  ['title-cased', '[Person_1]', 'John Smith'],
  ['mixed case', '[pErSoN_1]', 'John Smith'],
  ['lowercased email token', '[email_1]', 'jane@acme.com'],
  // Separator swaps (space / hyphen for underscore).
  ['space separator', '[PERSON 1]', 'John Smith'],
  ['space separator lowercased', '[person 1]', 'John Smith'],
  ['hyphen separator', '[PERSON-1]', 'John Smith'],
  ['double space', '[PERSON  1]', 'John Smith'],
  ['multi-word type with spaces', '[CREDIT CARD 1]', '4111 1111 1111 1111'],
  ['multi-word type hyphenated', '[CREDIT-CARD-1]', '4111 1111 1111 1111'],
  ['multi-word type title-cased', '[Credit Card 1]', '4111 1111 1111 1111'],
  // Whitespace padding inside the brackets.
  ['leading inner space', '[ PERSON_1]', 'John Smith'],
  ['trailing inner space', '[PERSON_1 ]', 'John Smith'],
  ['both inner spaces', '[ PERSON_1 ]', 'John Smith'],
  // Markdown wrapping.
  ['bold outside', '**[PERSON_1]**', '**John Smith**'],
  ['italic outside', '*[PERSON_1]*', '*John Smith*'],
  ['code outside', '`[PERSON_1]`', '`John Smith`'],
  ['underscore italics outside', '__[PERSON_1]__', '__John Smith__'],
  ['code inside brackets', '[`PERSON_1`]', 'John Smith'],
  ['bold inside brackets', '[**PERSON_1**]', 'John Smith'],
  ['bold bare token', '**PERSON_1**', '**John Smith**'],
  ['code bare token', '`PERSON_1`', '`John Smith`'],
  // Dropped brackets (strictly uppercase only).
  ['bare token', 'PERSON_1', 'John Smith'],
  ['bare underscore-bearing type', 'CREDIT_CARD_1', '4111 1111 1111 1111'],
  ['bare email token', 'EMAIL_1', 'jane@acme.com'],
  ['bare two-digit counter', 'PERSON_11', 'Anna Lind'],
  // Punctuation shifts.
  ['trailing period inside', '[PERSON_1.]', 'John Smith'],
  ['trailing comma inside', '[PERSON_1,]', 'John Smith'],
  ['trailing bang inside', '[PERSON_1!]', 'John Smith'],
  // Combined manglings.
  ['bold + lowercase + space', '**[person 1]**', '**John Smith**'],
  ['case + hyphen + padding', '[ Person-1 ]', 'John Smith'],
  ['legacy token re-bracketed', '[REDACTED_1]', 'Old Value'],
];

describe('deanonymize survives LLM-mangled tokens (T098 corpus)', () => {
  it.each(CORPUS)('%s: %s', (_name, mangled, value) => {
    const session = makeSession();
    const restored = session.deanonymize(`Please contact ${mangled} about the invoice.`);
    expect(restored).toBe(`Please contact ${value} about the invoice.`);
  });

  it(`corpus covers ${CORPUS.length} variants`, () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(30);
  });

  it('restores several mangled tokens in one reply', () => {
    const session = makeSession();
    const reply =
      'Dear [person_1], your card **CREDIT_CARD_1** was billed; ' +
      'a receipt went to `EMAIL_1` and a copy to [PERSON 11].';
    expect(session.deanonymize(reply)).toBe(
      'Dear John Smith, your card **4111 1111 1111 1111** was billed; ' +
        'a receipt went to `jane@acme.com` and a copy to Anna Lind.',
    );
  });

  it('does not confuse [person 1] with [person 11] (counter integrity)', () => {
    const session = makeSession();
    expect(session.deanonymize('[person 11] then [person 1]')).toBe(
      'Anna Lind then John Smith',
    );
    expect(session.deanonymize('PERSON_11 and PERSON_1 met')).toBe(
      'Anna Lind and John Smith met',
    );
  });

  it('keeps dollar sequences in originals inert through the tolerant pass', () => {
    const session = AnonymizationSession.deserialize(
      JSON.stringify([
        { original: "$&$'$100", replacement: '[CURRENCY_1]', entity_type: 'CURRENCY' },
      ]),
    );
    expect(session.deanonymize('Pay [currency 1] now')).toBe("Pay $&$'$100 now");
  });
});

// ── Ambiguity: never guess ─────────────────────────────────

describe('ambiguous or unknown tokens are never restored (T098 no-guess)', () => {
  it('a mangled form claimed by two keys stays untouched; exact forms still restore', () => {
    // A renamed label can canonically collide with a generated token.
    const session = AnonymizationSession.deserialize(
      JSON.stringify([
        { original: 'John Smith', replacement: '[PERSON_1]', entity_type: 'PERSON' },
        { original: 'Jane Roe', replacement: '[Person 1]', entity_type: 'PERSON' },
      ]),
    );
    // The mangled form could be either mapping: leave it exactly as written.
    expect(session.deanonymize('saw [person 1] there')).toBe('saw [person 1] there');
    expect(session.deanonymize('saw PERSON_1 there')).toBe('saw PERSON_1 there');
    // Exact literal keys keep restoring both mappings.
    expect(session.deanonymize('[PERSON_1] met [Person 1]')).toBe('John Smith met Jane Roe');
  });

  it('unknown counters and unknown types stay untouched', () => {
    const session = makeSession();
    const reply = 'see [PERSON_99], [person 99], PERSON_99, [UNKNOWN_9] and [citation_1]';
    expect(session.deanonymize(reply)).toBe(reply);
  });

  it('partial and embedded tokens stay untouched', () => {
    const session = makeSession();
    // Dangling bracket (a token split mid-stream), embedded identifier,
    // glued prefix/suffix: none of these may restore.
    const reply = 'x [PERSON_1 y SOME_PERSON_1 z XPERSON_1 w PERSON_1X v PERSON_1_SUFFIX';
    expect(session.deanonymize(reply)).toBe(reply);
  });

  it('lowercase bare forms are prose, not tokens', () => {
    const session = makeSession();
    const reply = 'person 1 met person_1 and Person_1';
    expect(session.deanonymize(reply)).toBe(reply);
  });

  it('pluralized or letter-extended tokens stay untouched', () => {
    const session = makeSession();
    expect(session.deanonymize('both [PERSON_1s] agreed')).toBe('both [PERSON_1s] agreed');
    // Exact token + trailing prose plural marker still restores the token.
    expect(session.deanonymize("[PERSON_1]'s file")).toBe("John Smith's file");
  });

  it('surrogate keys are matched exactly only (no case/spacing tolerance)', () => {
    const session = new AnonymizationSession({ mode: 'surrogate', salt: 'test-salt' });
    const surrogate = session.anonymize('Jan Kowalski', 'PERSON');
    expect(session.deanonymize(`Dear ${surrogate},`)).toBe('Dear Jan Kowalski,');
    // A case-mangled surrogate is natural-language text - never guessed.
    const mangled = `Dear ${surrogate.toLowerCase()},`;
    expect(session.deanonymize(mangled)).toBe(mangled);
  });

  it('blanked sessions have no tolerant map at all', () => {
    const session = new AnonymizationSession({ mode: 'blanked' });
    session.anonymize('John Smith', 'PERSON');
    const reply = 'saw [person 1] and PERSON_1 and ________';
    expect(session.deanonymize(reply)).toBe(reply);
  });
});

// ── Exact-match fast path regression ───────────────────────

describe('exact-match path regression (T098)', () => {
  it('adjacent exact tokens restore as before', () => {
    const session = makeSession();
    expect(session.deanonymize('[PERSON_1][EMAIL_1]')).toBe('John Smithjane@acme.com');
  });

  it('exact tokens inside markdown and punctuation restore as before', () => {
    const session = makeSession();
    expect(session.deanonymize('(**[PERSON_1]**, see [EMAIL_1]).')).toBe(
      '(**John Smith**, see jane@acme.com).',
    );
  });

  it('text without any token shape passes through unchanged', () => {
    const session = makeSession();
    const prose = 'No tokens here, just an ordinary reply about invoices.';
    expect(session.deanonymize(prose)).toBe(prose);
  });
});

// ── Tolerant matcher unit surface ──────────────────────────

describe('canonicalPlaceholderForm / buildTolerantTokenIndex', () => {
  it('canonicalizes bracket, case, separator, markdown and punctuation variants alike', () => {
    for (const v of ['[PERSON_1]', '[person 1]', '[PERSON-1]', '**PERSON_1**', '[ `person_1`. ]']) {
      expect(canonicalPlaceholderForm(v)).toBe('person_1');
    }
    expect(canonicalPlaceholderForm('[CREDIT CARD 2]')).toBe('credit_card_2');
    expect(canonicalPlaceholderForm('***')).toBeNull();
    expect(canonicalPlaceholderForm('')).toBeNull();
  });

  it('extracts type prefixes from typed canonicals only', () => {
    expect(canonicalTypePrefix('person_1')).toBe('person');
    expect(canonicalTypePrefix('credit_card_2')).toBe('credit_card');
    expect(canonicalTypePrefix('ceo')).toBeNull();
  });

  it('drops colliding canonicals from the index entirely', () => {
    const index = buildTolerantTokenIndex(['[PERSON_1]', '[Person 1]', '[EMAIL_1]']);
    expect(index.byCanonical.has('person_1')).toBe(false);
    expect(index.byCanonical.get('email_1')).toBe('[EMAIL_1]');
    expect(index.typePrefixes.has('person')).toBe(true);
    expect(resolveMangledToken('[person 1]', index)).toBeNull();
    expect(resolveMangledToken('[email 1]', index)).toBe('[EMAIL_1]');
  });

  it('ignores literal surrogate keys (exact-path only)', () => {
    const index = buildTolerantTokenIndex(['Adam Nowak', '[PERSON_1]']);
    expect(index.byCanonical.size).toBe(1);
    expect(resolveMangledToken('adam nowak', index)).toBeNull();
  });
});
