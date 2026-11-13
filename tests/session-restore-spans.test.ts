/**
 * restoreSpans / unresolvedTokens (WLojek/DocCloak#3): the restores of a
 * session as spans over the text, for writers that apply them to a
 * document's text nodes. deanonymize() is built on the same spans, so the
 * two can never disagree.
 */
import { describe, it, expect } from 'vitest';
import { AnonymizationSession, type RestoreSpan } from '../src/session.ts';

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

function apply(text: string, spans: RestoreSpan[]): string {
  let out = '';
  let last = 0;
  for (const span of spans) {
    out += text.slice(last, span.start) + span.replacement;
    last = span.end;
  }
  return out + text.slice(last);
}

const TEXTS = [
  '',
  'No tokens at all.',
  '[PERSON_1] wrote to [EMAIL_1]; [PERSON_11] paid with [CREDIT_CARD_1].',
  'glued [PERSON_1][EMAIL_1] and possessive [PERSON_1]\'s',
  'mangled [person_1], PERSON_11, [ EMAIL_1 ], **[CREDIT-CARD-1]**, [`PERSON_1`]',
  'mixed [PERSON_1] then person [PERSON 11] then <<REDACTED_1>> and << redacted 1 >>',
  'unknown [PERSON_2] and [ORG_1], prose [see note 4], dangling [PERSON_1',
  'PERSON_1\n[PERSON_1]\n\n[EMAIL_1]',
];

describe('restoreSpans', () => {
  it('gives the spans deanonymize applies', () => {
    const session = makeSession();
    for (const text of TEXTS) {
      expect(apply(text, session.restoreSpans(text))).toBe(session.deanonymize(text));
    }
  });

  it('returns sorted, non-overlapping spans that point at the matched text', () => {
    const session = makeSession();
    for (const text of TEXTS) {
      const spans = session.restoreSpans(text);
      let previousEnd = 0;
      for (const span of spans) {
        expect(span.start).toBeGreaterThanOrEqual(previousEnd);
        expect(span.end).toBeGreaterThan(span.start);
        previousEnd = span.end;
        if (span.exact) expect(text.slice(span.start, span.end)).toBe(span.token);
      }
    }
  });

  it('marks exact and tolerant restores and names the key', () => {
    const session = makeSession();
    const text = '[PERSON_1] and [person 11] and PERSON_1';
    expect(session.restoreSpans(text)).toEqual([
      { start: 0, end: 10, replacement: 'John Smith', token: '[PERSON_1]', exact: true },
      { start: 15, end: 26, replacement: 'Anna Lind', token: '[PERSON_11]', exact: false },
      { start: 31, end: 39, replacement: 'John Smith', token: '[PERSON_1]', exact: false },
    ]);
  });

  it('is empty for an empty session', () => {
    const session = new AnonymizationSession();
    expect(session.restoreSpans('[PERSON_1] stays')).toEqual([]);
    expect(session.deanonymize('[PERSON_1] stays')).toBe('[PERSON_1] stays');
  });

  it('restores surrogate (natural text) keys on word boundaries only', () => {
    const session = AnonymizationSession.deserialize(
      JSON.stringify([{ original: 'Jan Kowalski', replacement: 'Bo Lind', entity_type: 'PERSON' }]),
    );
    const text = 'Bo Lind met Bo Lindgren.';
    expect(session.restoreSpans(text)).toEqual([
      { start: 0, end: 7, replacement: 'Jan Kowalski', token: 'Bo Lind', exact: true },
    ]);
  });
});

describe('unresolvedTokens', () => {
  it('lists tokens of a known family that identify no key', () => {
    const session = makeSession();
    expect(
      session.unresolvedTokens('[PERSON_1] met [PERSON_2] and [person 3], mail [EMAIL_9], again [PERSON_2]'),
    ).toEqual(['[PERSON_2]', '[person 3]', '[EMAIL_9]']);
  });

  it('ignores bracket text of other families and plain prose', () => {
    const session = makeSession();
    expect(session.unresolvedTokens('[Table 1], [see par. 3], [ORG_1], [citation_2], ITEM_7')).toEqual([]);
  });

  it('names a label of a DocCloak type the table has no entry for (it passed in silence under an all-clear)', () => {
    // Companies were kept visible when the text was redacted: the table holds people only.
    const session = AnonymizationSession.deserialize(
      JSON.stringify([{ original: 'John Smith', replacement: '[PERSON_1]', entity_type: 'PERSON' }]),
    );
    const text = '[PERSON_1] of [COMPANY_1] wrote to [EMAIL_2] on [DATE_3]; card [CREDIT_CARD_1], see [Table 1].';
    expect(session.deanonymize(text)).toBe('John Smith of [COMPANY_1] wrote to [EMAIL_2] on [DATE_3]; card [CREDIT_CARD_1], see [Table 1].');
    expect(session.unresolvedTokens(text)).toEqual(['[COMPANY_1]', '[EMAIL_2]', '[DATE_3]', '[CREDIT_CARD_1]']);
  });

  it('names DocCloak labels against an empty table too', () => {
    expect(new AnonymizationSession().unresolvedTokens('[PERSON_1] and [Table 1], PERSON_2')).toEqual(['[PERSON_1]', 'PERSON_2']);
  });

  it('reports variant-shaped tokens of a known family, such as a _FIRST written by analogy', () => {
    const session = AnonymizationSession.deserialize(
      JSON.stringify([
        { original: 'Jan Kowalski', replacement: '[PERSON_1]', entity_type: 'PERSON' },
        { original: 'Kowalski', replacement: '[PERSON_1_LAST]', entity_type: 'PERSON' },
        { original: '4111 1111 1111 1111', replacement: '[CREDIT_CARD_1]', entity_type: 'CREDIT_CARD' },
      ]),
    );
    const text = '[PERSON_1_LAST] and [PERSON_1_FIRST], [PERSON_7_LAST], [CREDIT_CARD_2_LAST], [Section_2_b], [ITEM_3_LAST]';
    expect(session.deanonymize(text)).toBe('Kowalski and [PERSON_1_FIRST], [PERSON_7_LAST], [CREDIT_CARD_2_LAST], [Section_2_b], [ITEM_3_LAST]');
    expect(session.unresolvedTokens(text)).toEqual(['[PERSON_1_FIRST]', '[PERSON_7_LAST]', '[CREDIT_CARD_2_LAST]']);
  });

  it('reports a bare unknown token of a known family', () => {
    const session = makeSession();
    expect(session.unresolvedTokens('ask PERSON_5 about it')).toEqual(['PERSON_5']);
  });

  it('reports a token two keys claim (ambiguous, never guessed)', () => {
    const session = AnonymizationSession.deserialize(
      JSON.stringify([
        { original: 'John Smith', replacement: '[PERSON_1]', entity_type: 'PERSON' },
        { original: 'Mary Major', replacement: '[Person 1]', entity_type: 'PERSON' },
      ]),
    );
    // Exact forms restore, the lowercase one could be either.
    expect(session.deanonymize('[PERSON_1], [Person 1], [person_1]')).toBe('John Smith, Mary Major, [person_1]');
    expect(session.unresolvedTokens('[PERSON_1], [Person 1], [person_1]')).toEqual(['[person_1]']);
  });

  it('is empty when the text holds nothing shaped like a DocCloak label', () => {
    expect(new AnonymizationSession().unresolvedTokens('Plain text, [note 1], [ORG_1].')).toEqual([]);
  });
});
