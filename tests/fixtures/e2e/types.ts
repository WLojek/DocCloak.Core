/**
 * T183 end-to-end corpus: realistic documents plus "LLM reply" templates.
 *
 * A document is plain text with PII the way it appears in real mail,
 * contracts, CVs and meeting notes. `persons` is what the ML detector
 * would return for it (the stub ML list): every surface form, including
 * inflected Polish forms and bare surnames, so the pipeline stub emits
 * one PERSON entity per occurrence. `pii` lists the values that must be
 * gone from the anonymised text on top of every detected entity value.
 */
export type E2eLang = 'pl' | 'en' | 'de';
export type E2eKind = 'email' | 'contract' | 'cv' | 'note';

export interface E2eDocument {
  id: string;
  lang: E2eLang;
  kind: E2eKind;
  text: string;
  /** Stub ML output: PERSON surface forms present in the text. */
  persons: string[];
  /** Values that must not survive anonymisation (case-insensitive substring). */
  pii: string[];
}
