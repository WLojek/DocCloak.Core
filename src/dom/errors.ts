/**
 * @doccloak/core/dom - typed refusal errors (T172, security remediation 2026-09).
 *
 * Fail-closed principle: a document the reader cannot interpret is refused
 * with a stable machine-readable `code` instead of being copied through as a
 * "redacted" file. Hosts map `code` to their own localized messages; `details`
 * carries the specifics (offending namespaces, part names) for diagnostics.
 */

/**
 * Stable refusal codes. T172 raises 'unrecognized-namespace' and
 * 'invalid-package'; the remaining codes are reserved for T177 (package
 * policy, size limit) and the legacy .doc reader so hosts can switch on one
 * union from day one.
 */
export type UnsupportedDocumentCode =
  | 'unrecognized-namespace'
  | 'invalid-package'
  | 'unredactable-parts'
  | 'too-large'
  | 'fast-saved'
  | 'encrypted';

export class UnsupportedDocumentError extends Error {
  readonly code: UnsupportedDocumentCode;
  /** Free-form specifics: namespaces seen, part names, sizes. */
  readonly details: string[];

  constructor(code: UnsupportedDocumentCode, message?: string, details: string[] = []) {
    super(message ?? `Unsupported document (${code})`);
    this.name = 'UnsupportedDocumentError';
    this.code = code;
    this.details = details;
    // Keep instanceof working when the package is compiled to ES5-style
    // classes by a downstream bundler.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** True when `err` is an UnsupportedDocumentError (also across realms). */
export function isUnsupportedDocumentError(err: unknown): err is UnsupportedDocumentError {
  return err instanceof UnsupportedDocumentError
    || (typeof err === 'object' && err !== null && (err as { name?: string }).name === 'UnsupportedDocumentError');
}

/**
 * A package part the writer cannot redact (embedded workbook, macros, HTML
 * chunk). T172 only declares the shape and always reports an empty list;
 * T177 fills it from classifyPart and gates the writer on allowUnredactable.
 */
export interface UnredactablePart {
  /** Zip path of the part, e.g. 'word/embeddings/oleObject1.bin' */
  part: string;
  kind: 'embedded-object' | 'macros' | 'html-chunk' | 'external-data' | 'printer-settings' | 'unknown';
  /** Human-readable label for host UIs, e.g. 'embedded Excel sheet' */
  label: string;
}
