/**
 * T124 multilingual gold corpus schema + builder.
 *
 * Corpus documents are authored as ordered segments: plain strings and
 * gold-entity tuples. The builder concatenates them and records exact
 * character offsets, so gold spans are correct by construction and never
 * hand-counted. Every corpus file exports `docs: CorpusDoc[]` built with
 * doc(); the harness (eval/multilang.mts) consumes the registry in
 * corpus/index.mts.
 *
 * Gold types reuse the core EntityType vocabulary (what all three
 * providers map their labels onto). `alt` lists additional types accepted
 * as a type-aware match where two mappings are equally fair, e.g. a
 * national ID that a model may reasonably report as SSN or IBAN-adjacent
 * account identifier. Type-agnostic masking metrics ignore types entirely.
 */

import type { EntityType } from '../../src/types.ts';

export type Lang =
  | 'en' | 'pl' | 'de' | 'fr' | 'es' | 'pt' | 'sv' | 'no'
  | 'it' | 'nl' | 'cs' | 'ro' | 'el' | 'uk';

export type Genre =
  | 'email' | 'chat' | 'hr' | 'medical' | 'invoice' | 'legal' | 'casual' | 'form';

export interface GoldSpan {
  start: number;
  end: number;
  text: string;
  type: EntityType;
  /** Additional EntityTypes accepted as a correct type-aware match. */
  alt?: EntityType[];
}

export interface CorpusDoc {
  /** `<lang>-<nn>`, e.g. `pl-03`. Stable: the raw prediction cache keys on it. */
  id: string;
  lang: Lang;
  genre: Genre;
  text: string;
  gold: GoldSpan[];
}

/** A gold segment: [text, type] or [text, type, altTypes]. */
export type GoldSeg = [text: string, type: EntityType, alt?: EntityType[]];
export type Seg = string | GoldSeg;

/** Build a doc from ordered segments; offsets are computed, never typed. */
export function doc(id: string, lang: Lang, genre: Genre, parts: Seg[]): CorpusDoc {
  let text = '';
  const gold: GoldSpan[] = [];
  for (const part of parts) {
    if (typeof part === 'string') {
      text += part;
    } else {
      const [t, type, alt] = part;
      gold.push({ start: text.length, end: text.length + t.length, text: t, type, ...(alt ? { alt } : {}) });
      text += t;
    }
  }
  return { id, lang, genre, text, gold };
}

/** Invariant check used by the harness before any inference run. */
export function validateDoc(d: CorpusDoc): string[] {
  const errors: string[] = [];
  for (const g of d.gold) {
    if (d.text.slice(g.start, g.end) !== g.text) {
      errors.push(`${d.id}: gold span [${g.start},${g.end}) does not slice to ${JSON.stringify(g.text)}`);
    }
    if (g.end <= g.start) errors.push(`${d.id}: empty gold span at ${g.start}`);
  }
  return errors;
}
