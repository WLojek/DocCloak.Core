/**
 * T183 end-to-end: 30 realistic documents (PL/EN/DE; e-mail, contract, CV,
 * meeting note) x 5 "LLM reply" templates x 2 replacement modes.
 *
 * Pipeline per document, exactly as the web worker composes it
 * (pipeline.ts detectEntities): detectWithRegex for the document's region
 * (see REGION) plus a stub ML list of PERSON surface forms from the fixture, then
 * filterFalsePositives / resolveOverlaps / propagateEntities, then
 * session.anonymizeText, a reply template, session.deanonymize.
 *
 * Assertions:
 *  (a) no original PII value survives anonymisation (case-insensitive
 *      substring: every detected entity value and every fixture `pii`);
 *  (b) every placeholder the reply carries, mangled or not, is restored;
 *  (c) the restored reply is byte-identical to the template output with
 *      each placeholder replaced by its original: prose outside the
 *      placeholders is never rewritten (R4), not even in surrogate mode
 *      where the keys are natural text.
 */
import { describe, expect, it } from 'vitest';
import { AnonymizationSession } from '../src/session.ts';
import { detectEntities, detectWithRegex } from '../src/pipeline.ts';
import type { DetectedEntity } from '../src/types.ts';
import {
  E2E_DOCUMENTS,
  REPLY_TEMPLATES,
  type E2eDocument,
  type ReplyMode,
  type ReplyTemplate,
} from './fixtures/e2e/index.ts';

const SALT = 'e2e-fixed-salt';
const MODES: ReplyMode[] = ['labeled', 'surrogate'];

/** Documents whose stub ML list carries a bare name shared by two people (R5). */
const AMBIGUOUS: Record<string, string[]> = {
  'pl-note-02': ['Piotr'],
  'en-note-02': ['Peter'],
  'de-note-02': ['Peter'],
  'de-email-02': ['Wagner'],
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Stub ML detector: one PERSON entity per whole-word occurrence of each listed form. */
function stubMl(text: string, persons: string[]): DetectedEntity[] {
  const out: DetectedEntity[] = [];
  for (const form of persons) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(form)}(?![\\p{L}\\p{N}])`, 'gu');
    let match: RegExpExecArray | null;
    let found = 0;
    while ((match = re.exec(text)) !== null) {
      found++;
      out.push({
        type: 'PERSON',
        value: match[0],
        start: match.index,
        end: match.index + match[0].length,
        confidence: 0.9,
        detector: 'ml-stub',
      });
    }
    if (found === 0) throw new Error(`fixture form "${form}" not found in text`);
  }
  return out;
}

/**
 * Regex region per document language, as a web user selects it. Running
 * every region ('all') is not representative and not restorable: the
 * abbreviation-led PT/ES street rules ("R.", "C.") carry no left boundary
 * and match mid-word ("orde|r. Your appointment is confirmed for 2024"),
 * which glues a surrogate into a word that no boundary can restore.
 */
const REGION: Record<E2eDocument['lang'], string> = { pl: 'pl', en: 'gb', de: 'de' };

function detect(doc: E2eDocument): DetectedEntity[] {
  return detectEntities(doc.text, stubMl(doc.text, doc.persons), detectWithRegex(doc.text, REGION[doc.lang]));
}

const SENTINEL_RE = /(\d+)/g;

interface Rendered {
  reply: string;
  expected: string;
  emitted: string[];
}

/**
 * Apply a template to the anonymised text. Placeholders (the session's
 * replacement strings, longest first) become opaque sentinels before the
 * template runs, so it can only ever move or decorate them. On expansion
 * the reply gets the template's mangled form and `expected` the original,
 * both inside the same wrapper, so the two differ ONLY inside placeholders.
 */
function renderReply(
  session: AnonymizationSession,
  anonymised: string,
  template: ReplyTemplate,
  mode: ReplyMode,
): Rendered {
  const originals = new Map<string, string>();
  for (const { original, replacement } of session.getEntries()) {
    const current = originals.get(replacement);
    // Same rule as the session's reverse map: the longest original is canonical.
    if (current === undefined || original.length > current.length) originals.set(replacement, original);
  }
  const tokens = [...originals.keys()].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  const tokenRe = new RegExp(tokens.map(escapeRegExp).join('|'), 'g');
  const withSentinels = anonymised.replace(tokenRe, (m) => `${tokens.indexOf(m)}`);
  expect(withSentinels, 'document must carry placeholders').toMatch(SENTINEL_RE);

  const rendered = template.render(withSentinels);
  const emitted: string[] = [];
  let n = 0;
  const reply = rendered.replace(SENTINEL_RE, (_, i: string) => {
    const token = tokens[Number(i)];
    const [pre, post] = template.wrap(n);
    const form = `${pre}${template.reshape(token, n, mode)}${post}`;
    emitted.push(form);
    n++;
    return form;
  });
  let m = 0;
  const expected = rendered.replace(SENTINEL_RE, (_, i: string) => {
    const [pre, post] = template.wrap(m++);
    return `${pre}${originals.get(tokens[Number(i)])!}${post}`;
  });
  expect(reply).not.toMatch(SENTINEL_RE);
  return { reply, expected, emitted };
}

describe('e2e corpus shape', () => {
  it('has 30 documents, 10 per language, every kind per language, 5 templates', () => {
    expect(E2E_DOCUMENTS).toHaveLength(30);
    for (const lang of ['pl', 'en', 'de'] as const) {
      const docs = E2E_DOCUMENTS.filter((d) => d.lang === lang);
      expect(docs, lang).toHaveLength(10);
      expect(new Set(docs.map((d) => d.kind)), lang).toEqual(new Set(['email', 'contract', 'cv', 'note']));
    }
    expect(new Set(E2E_DOCUMENTS.map((d) => d.id)).size).toBe(30);
    expect(REPLY_TEMPLATES.map((t) => t.id)).toEqual(['summary', 'rewrite', 'bullets', 'quoted', 'markdown']);
  });

  it('every document yields people, contact data and at least one date', () => {
    for (const doc of E2E_DOCUMENTS) {
      const types = new Set(detect(doc).map((e) => e.type));
      expect(types, doc.id).toContain('PERSON');
      expect(types, doc.id).toContain('EMAIL');
      expect(types, doc.id).toContain('DATE');
    }
  });
});

for (const mode of MODES) {
  describe(`e2e ${mode} mode`, () => {
    for (const doc of E2E_DOCUMENTS) {
      describe(doc.id, () => {
        const entities = detect(doc);
        const session = new AnonymizationSession({ mode, salt: SALT });
        const anonymised = session.anonymizeText(doc.text, entities);

        it('(a) no original PII value survives anonymisation', () => {
          const lower = anonymised.toLowerCase();
          for (const value of doc.pii) {
            expect(lower, `pii "${value}"`).not.toContain(value.toLowerCase());
          }
          for (const entity of entities) {
            expect(lower, `entity ${entity.type} "${entity.value}"`).not.toContain(entity.value.toLowerCase());
          }
        });

        it('restores the untouched anonymised text byte-identically', () => {
          expect(session.deanonymize(anonymised)).toBe(doc.text);
        });

        it('flags exactly the expected ambiguous names (R5)', () => {
          expect(session.getAmbiguousValues()).toEqual(AMBIGUOUS[doc.id] ?? []);
        });

        for (const template of REPLY_TEMPLATES) {
          it(`(b)(c) ${template.id} reply restores every placeholder and nothing else`, () => {
            const { reply, expected, emitted } = renderReply(session, anonymised, template, mode);
            expect(emitted.length).toBeGreaterThan(0);
            const restored = session.deanonymize(reply);
            for (const form of emitted) {
              expect(restored, `placeholder ${form} not restored`).not.toContain(form);
            }
            if (mode === 'labeled') expect(restored).not.toMatch(/\[[A-Za-z_]+[ _]\d+/);
            expect(restored).toBe(expected);
          });
        }
      });
    }
  });
}
