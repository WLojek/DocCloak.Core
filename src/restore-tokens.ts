/**
 * Tolerant restore-token matching (T098), extracted to a side-effect-free
 * leaf module so the extension content bundle can import these VALUES
 * without pulling in the session/surrogate machinery (see the T036 alias
 * note in DocCloak.Extension/vite.content.config.ts).
 */

// ── Tolerant restore matching (T098) ───────────────────────
//
// LLM replies mangle placeholders: case changes ("[person_1]"), separator
// swaps ("[PERSON 1]", "[PERSON-1]"), markdown wrapping ("**[PERSON_1]**",
// "[`PERSON_1`]", "`PERSON_1`"), dropped brackets ("PERSON_1") and stray
// edge punctuation ("[PERSON_1.]"). The tolerant matcher reduces mapping
// keys and reply candidates to one canonical form and restores only on an
// UNAMBIGUOUS canonical hit: a canonical form claimed by two different map
// keys is never matched, and a candidate that resolves to nothing is left
// exactly as the model wrote it. A wrong restore silently corrupts the
// user's document; a missed restore is visible and recoverable.

/** A key shaped like one full token ([PERSON_1], <<REDACTED_1>>). */
const TOKEN_SHAPED_KEY_RE = /^(?:\[[^[\]\n]+\]|<<[^<>\n]+>>)$/;

/** Markdown emphasis characters LLMs wrap tokens in (bold/code/strike). */
const MARKDOWN_EMPHASIS_RE = /[*`~]/g;

/**
 * Non-alphanumeric runs at either edge of a candidate: bracket/angle
 * delimiters, stray punctuation and whitespace. Stripping edges (never
 * the middle) keeps "[PERSON_1.]" and "PERSON_1" comparable while inner
 * punctuation still distinguishes genuinely different labels.
 */
const EDGE_JUNK_RE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

/** Separator runs unified to one '_': whitespace, underscores, hyphens. */
const SEPARATOR_RUN_RE = /[\s_-]+/g;

/**
 * Bare typed token as an LLM writes it after dropping the brackets:
 * STRICTLY uppercase segments ending in an underscore-digit run, on
 * non-wordish boundaries (underscore excluded on both sides so an
 * embedded "SOME_PERSON_1" identifier never yields a partial match).
 * Case is deliberately NOT tolerated here: without brackets, only the
 * exact uppercase shape is distinctive enough to touch ("person 1" in
 * lowercase prose must stay prose). An immediately preceding '[' or '<'
 * is also excluded: a dangling "[PERSON_1" (a token split mid-stream,
 * possibly a truncated "[PERSON_11]") must never be partially restored -
 * the complete bracketed form is the bracket scan's job.
 * Global: callers reset lastIndex.
 */
export const BARE_TYPED_TOKEN_RE =
  /(?<![\p{L}\p{N}_[<])[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_\d+(?![\p{L}\p{N}_])/gu;

/**
 * Canonical comparison form of a placeholder candidate or map key:
 * markdown emphasis stripped, edge junk (brackets, punctuation, space)
 * stripped, lowercased, separator runs collapsed to single underscores.
 * "[PERSON_1]", "[person 1]", "**[PERSON-1]**" and "PERSON_1" all yield
 * "person_1". Returns null when nothing substantive remains.
 */
export function canonicalPlaceholderForm(candidate: string): string | null {
  const stripped = candidate
    .replace(MARKDOWN_EMPHASIS_RE, '')
    .replace(EDGE_JUNK_RE, '')
    .toLowerCase();
  if (stripped.length === 0) return null;
  const parts = stripped.split(SEPARATOR_RUN_RE).filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  return parts.join('_');
}

/** Canonical typed-token shape: type prefix + '_' + counter digits. */
const CANONICAL_TYPED_RE = /^([a-z][a-z0-9_]*)_\d+$/;

/**
 * The type-family prefix of a canonical typed token ("person_1" ->
 * "person", "credit_card_2" -> "credit_card"), or null for canonical
 * forms that are not typed-token shaped (renamed labels like "ceo").
 */
export function canonicalTypePrefix(canonical: string): string | null {
  const match = CANONICAL_TYPED_RE.exec(canonical);
  return match ? match[1] : null;
}

export interface TolerantTokenIndex {
  /**
   * Canonical form -> the ONE exact map key it identifies. Forms claimed
   * by two different keys are ambiguous and absent by construction, so a
   * lookup hit is always safe to restore.
   */
  byCanonical: ReadonlyMap<string, string>;
  /**
   * Canonical type prefixes of the typed keys in the map ("person",
   * "redacted"). A candidate of a KNOWN family that resolves to no key is
   * a DocCloak token the model mangled beyond recovery - callers may
   * surface it as could-not-restore. Unknown families (site prose like
   * "[citation_1]") are never DocCloak's to flag.
   */
  typePrefixes: ReadonlySet<string>;
}

/**
 * Build the tolerant lookup for a map's keys. Only token-shaped keys
 * participate: literal surrogate keys are natural-language text whose
 * case/spacing variants collide with genuine prose, so they keep the
 * exact-literal path only. Canonical collisions between two different
 * keys are dropped entirely (never guess between [PERSON_1] and a
 * renamed "[Person 1]"); exact matching still restores both.
 */
export function buildTolerantTokenIndex(keys: Iterable<string>): TolerantTokenIndex {
  const byCanonical = new Map<string, string>();
  const ambiguous = new Set<string>();
  const typePrefixes = new Set<string>();
  for (const key of keys) {
    if (!TOKEN_SHAPED_KEY_RE.test(key)) continue;
    const canonical = canonicalPlaceholderForm(key);
    if (canonical === null) continue;
    const prefix = canonicalTypePrefix(canonical);
    if (prefix !== null) typePrefixes.add(prefix);
    if (ambiguous.has(canonical)) continue;
    const existing = byCanonical.get(canonical);
    if (existing !== undefined && existing !== key) {
      byCanonical.delete(canonical);
      ambiguous.add(canonical);
      continue;
    }
    byCanonical.set(canonical, key);
  }
  return { byCanonical, typePrefixes };
}

/**
 * Resolve one mangled candidate to its exact map key, or null when the
 * candidate identifies no key or more than one (ambiguity never
 * restores). Candidates come from bracketed/legacy token scans or from
 * BARE_TYPED_TOKEN_RE; arbitrary prose canonicalizes to forms no key
 * owns and falls through to null.
 */
export function resolveMangledToken(
  candidate: string,
  index: TolerantTokenIndex,
): string | null {
  const canonical = canonicalPlaceholderForm(candidate);
  if (canonical === null) return null;
  return index.byCanonical.get(canonical) ?? null;
}
