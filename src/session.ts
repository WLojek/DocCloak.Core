import type { EntityType, DetectedEntity, ReplacementEntry } from './types.ts';
import { buildTolerantTokenIndex, resolveMangledToken } from './restore-tokens.ts';
import { generateSessionSalt, generateUniqueSurrogate } from './surrogates.ts';

export * from './restore-tokens.ts';

export type ReplacementMode = 'labeled' | 'blanked' | 'surrogate';

// T099: credentials never get realistic stand-ins - a same-shape fake key
// still looks like a live credential to anyone (or any scanner) reading the
// prompt. Surrogate mode falls back to typed placeholders for these types.
const PLACEHOLDER_ONLY_TYPES: ReadonlySet<EntityType> = new Set(['SECRET', 'API_KEY']);

export interface SessionOptions {
  /** Initial replacement mode; defaults to 'labeled' (typed placeholders). */
  mode?: ReplacementMode;
  /**
   * Per-session surrogate salt; defaults to a fresh random one. Passing an
   * explicit salt makes surrogate generation fully reproducible (tests,
   * deserialization).
   */
  salt?: string;
}

/**
 * Person-variant tokenization (T057): lowercase word tokens with edge
 * punctuation stripped. EVERY token participates in the subset test -
 * dropping short ones would collapse "Person 1" into "Person 11".
 */
function personTokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/^[.,;:!?()"'\u201E\u201C\u201D]+|[.,;:!?()"'\u201E\u201C\u201D]+$/g, ''))
    .filter((t) => t.length > 0);
}

/**
 * Whether two PERSON values plausibly name the same person (T057): the
 * token set of one must be a subset of the other's, and the shared part
 * must contain at least one substantive token (>= 3 chars) so initials,
 * digits or stray marks alone never unify. "John" and "Smith" both match
 * "John Smith"; "Mr. Smith" does NOT (the 'mr' token has no counterpart,
 * and honorific guessing would be overreach); "Person 1" never matches
 * "Person 11" (the '1' token has no counterpart in the other value).
 */
function isPersonVariant(a: string, b: string): boolean {
  const ta = personTokens(a);
  const tb = personTokens(b);
  if (ta.length === 0 || tb.length === 0) return false;
  const [small, big] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  return small.every((t) => big.includes(t)) && small.some((t) => t.length >= 3);
}

/**
 * Variant suffix (T171): where a person variant sits inside the reference
 * name. A single token at the reference's first/last position is a first
 * name / surname; a single token elsewhere is a middle name; several tokens
 * are a shortened form; a variant with MORE tokens than the reference is the
 * fuller form. Suffixes are stable uppercase ASCII so the resulting token
 * ([PERSON_2_LAST]) stays inside the tolerant-restore candidate shape.
 */
function variantSuffix(variant: string, reference: string): string {
  const vt = personTokens(variant);
  const rt = personTokens(reference);
  if (vt.length > rt.length) return 'FULL';
  if (vt.length === rt.length) return 'ALT';
  if (vt.length === 1) {
    const idx = rt.indexOf(vt[0]);
    if (idx === 0) return 'FIRST';
    if (idx === rt.length - 1) return 'LAST';
    return 'MIDDLE';
  }
  return 'SHORT';
}

/** Whether every person token of `a` occurs in `b`. */
function isTokenSubset(a: string, b: string): boolean {
  const tb = personTokens(b);
  const ta = personTokens(a);
  return ta.length > 0 && ta.every((t) => tb.includes(t));
}

/**
 * A variant token derived from its base token: the suffix goes inside the
 * closing bracket ("[PERSON_2]" -> "[PERSON_2_LAST]"); a renamed label
 * without brackets gets a plain underscore suffix.
 */
function withVariantSuffix(base: string, suffix: string): string {
  return base.endsWith(']') ? `${base.slice(0, -1)}_${suffix}]` : `${base}_${suffix}`;
}

/** Variant token shape, for re-linking deserialized maps (T171). */
const VARIANT_TOKEN_RE = /^(\[.+?)_(FIRST|LAST|MIDDLE|SHORT|FULL|ALT)(?:_(\d+))?\]$/;

/**
 * Apply the case pattern of `sample` to `word` (T171 surrogate variants):
 * an all-lowercase "smith" maps to "nowak", an all-uppercase "SMITH" to
 * "NOWAK"; anything else keeps the surrogate's own casing.
 */
function matchCase(word: string, sample: string): string {
  if (sample === sample.toLowerCase() && sample !== sample.toUpperCase()) return word.toLowerCase();
  if (sample === sample.toUpperCase() && sample !== sample.toLowerCase()) return word.toUpperCase();
  return word;
}

/**
 * Typed placeholder token, e.g. "[PERSON_1]" or "[CREDIT_CARD_2]".
 * EntityType ids are stable uppercase ASCII ([A-Z_]), so generated tokens
 * always match the candidate pattern `\[[A-Z_]+_\d+\]`.
 */
const TYPED_PLACEHOLDER_RE = /^\[([A-Z_]+)_(\d+)\]$/;


/**
 * Candidate scan for the tolerant deanonymize pass: bracketed tokens,
 * legacy angle tokens, or strict bare typed tokens. Broad candidates are
 * safe - replacement still requires an unambiguous index hit.
 */
const MANGLED_CANDIDATE_RE =
  /\[[^[\]\n]+\]|<<[^<>\n]+>>|(?<![\p{L}\p{N}_[<])[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_\d+(?![\p{L}\p{N}_])/gu;

export class AnonymizationSession {
  private forwardMap = new Map<string, string>();
  private reverseMap = new Map<string, string>();
  private entityTypeMap = new Map<string, EntityType>();
  private typeCounters = new Map<string, number>();
  /**
   * Variant token -> its group's base token and suffix (T171), so renaming
   * the base re-derives its variants and deserialized maps re-link.
   */
  private variantOf = new Map<string, { base: string; suffix: string }>();
  private mode: ReplacementMode;
  /** Surrogate-mode salt (T043); constant for the session's lifetime. */
  private salt: string;

  constructor(options?: SessionOptions) {
    this.mode = options?.mode ?? 'labeled';
    this.salt = options?.salt ?? generateSessionSalt();
  }

  setMode(mode: ReplacementMode): void {
    this.mode = mode;
  }

  getMode(): ReplacementMode {
    return this.mode;
  }

  getSalt(): string {
    return this.salt;
  }

  /**
   * Issue the next typed placeholder for the given entity type using a
   * per-type counter: [PERSON_1], [PERSON_2], [EMAIL_1], ... Numbers
   * already present in the reverse map (a renamed label or an entry
   * restored via deserialize) are skipped so a fresh placeholder never
   * collides with an existing one.
   */
  private nextPlaceholder(entityType: EntityType): string {
    let n = this.typeCounters.get(entityType) ?? 0;
    let placeholder: string;
    do {
      n++;
      placeholder = `[${entityType}_${n}]`;
    } while (this.reverseMap.has(placeholder));
    this.typeCounters.set(entityType, n);
    return placeholder;
  }

  /**
   * Surrogate-mode replacement (T043): deterministic in (salt, type,
   * original), collision-safe against every original value already in the
   * session and every already-issued replacement. The map API is
   * unchanged: the surrogate simply IS the replacement string, so
   * deanonymize restores it via the same exact-literal lookup.
   */
  private nextSurrogate(original: string, entityType: EntityType): string {
    return generateUniqueSurrogate(
      original,
      entityType,
      { salt: this.salt, entries: this.getEntries() },
      (candidate) => this.forwardMap.has(candidate) || this.reverseMap.has(candidate),
    );
  }

  /**
   * The already-mapped PERSON value that best matches a new variant
   * (T057): most shared tokens wins; ties keep the first-mapped value.
   * Deterministic; returns null when nothing matches.
   */
  private findPersonVariant(value: string): string | null {
    const tokens = personTokens(value);
    if (tokens.length === 0) return null;
    let best: string | null = null;
    let bestShared = 0;
    for (const [original] of this.forwardMap) {
      if (this.entityTypeMap.get(original) !== 'PERSON') continue;
      if (!isPersonVariant(value, original)) continue;
      const shared = personTokens(original).filter((t) => tokens.includes(t)).length;
      if (shared > bestShared) {
        bestShared = shared;
        best = original;
      }
    }
    return best;
  }

  anonymize(original: string, entityType: EntityType): string {
    if (this.forwardMap.has(original)) {
      return this.forwardMap.get(original)!;
    }
    // T057 person-variant unification: "John Smith", "John" and "Smith"
    // in one session are the same person and share one identity. T171
    // makes restore exact: every distinct variant gets its OWN token that
    // keeps the group's number ([PERSON_2] / [PERSON_2_LAST]) or, in
    // surrogate mode, the matching part of the group's surrogate ("Nowak"
    // for "Smith" when "John Smith" became "Adam Nowak"), so the reverse map
    // stays one-to-one and restore writes back exactly what was there.
    if (entityType === 'PERSON') {
      const match = this.findPersonVariant(original);
      if (match) {
        const token = this.mode === 'blanked'
          ? '________'
          : this.mode === 'surrogate'
            ? this.variantSurrogate(original, match)
            : this.variantPlaceholder(original, match);
        this.forwardMap.set(original, token);
        this.entityTypeMap.set(original, entityType);
        if (this.mode !== 'blanked') {
          // Token-mapping can legitimately fall back to reusing the group's
          // surrogate; then the longest original stays canonical (T057).
          const canonical = this.reverseMap.get(token);
          if (canonical === undefined || original.length > canonical.length) {
            this.reverseMap.set(token, original);
          }
        }
        return token;
      }
    }
    const placeholder = this.mode === 'blanked'
      ? '________'
      : this.mode === 'surrogate' && !PLACEHOLDER_ONLY_TYPES.has(entityType)
        ? this.nextSurrogate(original, entityType)
        : this.nextPlaceholder(entityType);
    this.forwardMap.set(original, placeholder);
    // Blanked placeholders all collide on the same string; they are not
    // reversible, so keep them out of the restore map.
    if (this.mode !== 'blanked') {
      this.reverseMap.set(placeholder, original);
    }
    this.entityTypeMap.set(original, entityType);
    return placeholder;
  }

  /**
   * The group a mapped value belongs to (T171): its base token and the
   * canonical original that token restores to.
   */
  private variantGroup(match: string): { base: string; canonical: string } {
    const matchedToken = this.forwardMap.get(match)!;
    const base = this.variantOf.get(matchedToken)?.base ?? matchedToken;
    return { base, canonical: this.reverseMap.get(base) ?? match };
  }

  /**
   * Labeled-mode variant token (T171): the group's base token plus a
   * positional suffix, computed against the group's canonical name when
   * the variant is part of it, else against the value it matched. Distinct
   * originals never share a token: a suffix already in use gets a counter
   * ("Smith" -> [PERSON_2_LAST], "smith" -> [PERSON_2_LAST_2]).
   */
  private variantPlaceholder(original: string, match: string): string {
    const { base, canonical } = this.variantGroup(match);
    const reference = isTokenSubset(original, canonical) ? canonical : match;
    const suffix = variantSuffix(original, reference);
    let token = withVariantSuffix(base, suffix);
    for (let n = 2; this.reverseMap.has(token); n++) {
      token = withVariantSuffix(base, `${suffix}_${n}`);
    }
    this.variantOf.set(token, { base, suffix });
    return token;
  }

  /**
   * Surrogate-mode variant (T171): when the variant is a strict part of the
   * group's canonical name and the surrogate has the same word count, take
   * the surrogate words at the same positions with the variant's casing.
   * Anything else (fuller forms, reshaped surrogates, a collision with an
   * existing value) falls back to the group's surrogate as before.
   */
  private variantSurrogate(original: string, match: string): string {
    const { base, canonical } = this.variantGroup(match);
    const canonicalWords = canonical.split(/\s+/).filter(Boolean);
    const surrogateWords = base.split(/\s+/).filter(Boolean);
    const canonicalTokens = personTokens(canonical);
    const variantWords = original.split(/\s+/).filter(Boolean);
    const variantTokens = personTokens(original);
    const shapesAlign = canonicalWords.length === surrogateWords.length
      && canonicalTokens.length === canonicalWords.length
      && variantTokens.length === variantWords.length
      && variantTokens.length < canonicalTokens.length
      && variantTokens.every((t) => canonicalTokens.includes(t));
    if (!shapesAlign) return base;
    const mapped = variantWords
      .map((word, i) => matchCase(surrogateWords[canonicalTokens.indexOf(variantTokens[i])], word))
      .join(' ');
    const taken = mapped === original
      || this.forwardMap.has(mapped)
      || (this.reverseMap.has(mapped) && this.reverseMap.get(mapped) !== original);
    if (taken) return base;
    this.variantOf.set(mapped, { base, suffix: '' });
    return mapped;
  }

  deanonymize(text: string): string {
    let result = text;
    // Sort by placeholder length (longest first) to avoid partial replacements
    const entries = [...this.reverseMap.entries()].sort(
      (a, b) => b[0].length - a[0].length
    );
    for (const [placeholder, original] of entries) {
      // Replacer function keeps '$' sequences in the original value inert
      result = result.replaceAll(placeholder, () => original);
    }
    // T098: exact-literal replacement above is the unchanged fast path;
    // tokens an LLM mangled (case, spacing, markdown, dropped brackets)
    // survive it untouched and get one tolerant pass.
    return this.deanonymizeMangledTokens(result);
  }

  /**
   * Tolerant pass (T098) over text the exact pass already handled: scan
   * for remaining token-shaped candidates and restore each one that
   * unambiguously identifies a single map key (see
   * buildTolerantTokenIndex). Anything else - unknown tokens, ambiguous
   * canonical forms, partial tokens the candidate regex cannot even see -
   * stays exactly as written: a missed restore is visible and
   * recoverable, a guessed one silently corrupts the document. Runs after
   * the exact pass, so an exact key never reaches this code; originals
   * restored by the exact pass are plain user text and canonicalize to
   * forms no key owns.
   */
  private deanonymizeMangledTokens(text: string): string {
    const index = buildTolerantTokenIndex(this.reverseMap.keys());
    if (index.byCanonical.size === 0) return text;
    MANGLED_CANDIDATE_RE.lastIndex = 0;
    let out = '';
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = MANGLED_CANDIDATE_RE.exec(text)) !== null) {
      const key = resolveMangledToken(match[0], index);
      if (key === null) continue;
      const original = this.reverseMap.get(key);
      if (original === undefined) continue;
      out += text.slice(last, match.index) + original;
      last = match.index + match[0].length;
    }
    if (last === 0) return text;
    return out + text.slice(last);
  }

  anonymizeText(text: string, entities: DetectedEntity[]): string {
    // PERSON pre-pass: map people before anything else so that (T171) each
    // variant group forms around its FULLEST name - "John Smith" is the
    // base and "Smith" / "smith" hang off it, whatever order they appear in
    // - and so that (T043) an email appearing before/after its owner can
    // derive its local part from the person's surrogate (jan.kowalski maps
    // to adam.nowak style). Fullest name first, then reading order.
    // anonymize() is idempotent per value, so the replacement pass below
    // reuses these mappings; other types keep the historical end-to-start
    // issuing order (placeholder numbering).
    if (this.mode !== 'blanked') {
      const people = entities
        .filter((e) => e.type === 'PERSON')
        .sort((a, b) => personTokens(b.value).length - personTokens(a.value).length || a.start - b.start);
      for (const entity of people) this.anonymize(entity.value, entity.type);
    }
    // Sort entities by position (end to start) to preserve indices during replacement
    const sorted = [...entities].sort((a, b) => b.start - a.start);
    let result = text;
    // Clamp overlapping entities (e.g. a manual selection crossing a detected
    // one) so a later replacement never splices into an already-replaced range.
    let minStart = text.length;
    for (const entity of sorted) {
      const effectiveEnd = Math.min(entity.end, minStart);
      if (effectiveEnd <= entity.start) continue;
      const placeholder = this.anonymize(entity.value, entity.type);
      result = result.slice(0, entity.start) + placeholder + result.slice(effectiveEnd);
      minStart = entity.start;
    }
    return result;
  }

  getEntries(): ReplacementEntry[] {
    return [...this.forwardMap.entries()].map(([original, replacement]) => {
      const entityType = this.entityTypeMap.get(original) ?? 'OTHER' as EntityType;
      return { original, replacement, entityType };
    });
  }

  getForward(original: string): string | undefined {
    return this.forwardMap.get(original);
  }

  /**
   * Rename the label of a mapped value. Renaming a group's base token
   * (T171) re-derives every variant token from the new label
   * ([PERSON_1] -> [CLIENT] takes [PERSON_1_LAST] to [CLIENT_LAST]);
   * renaming a variant token renames only that token and detaches it from
   * the group, so a later base rename does not overwrite the user's choice.
   * Returns every [oldLabel, newLabel] pair applied, so hosts can update
   * already-rendered text without re-anonymizing.
   */
  renameLabel(original: string, newLabel: string): Array<[string, string]> {
    const oldLabel = this.forwardMap.get(original);
    if (!oldLabel || oldLabel === newLabel) return [];
    const pairs: Array<[string, string]> = [];
    const rename = (from: string, to: string) => {
      // Every original sharing the label (legacy many-to-one maps) moves
      // with it, and the canonical restore value carries over.
      const canonical = this.reverseMap.get(from);
      for (const [orig, label] of this.forwardMap) {
        if (label === from) this.forwardMap.set(orig, to);
      }
      this.reverseMap.delete(from);
      if (canonical !== undefined) this.reverseMap.set(to, canonical);
      pairs.push([from, to]);
    };
    if (this.variantOf.has(oldLabel)) {
      this.variantOf.delete(oldLabel);
      rename(oldLabel, newLabel);
      return pairs;
    }
    rename(oldLabel, newLabel);
    for (const [token, info] of [...this.variantOf]) {
      if (info.base !== oldLabel) continue;
      let next = withVariantSuffix(newLabel, info.suffix);
      for (let n = 2; this.reverseMap.has(next) || next === newLabel; n++) {
        next = withVariantSuffix(newLabel, `${info.suffix}_${n}`);
      }
      this.variantOf.delete(token);
      this.variantOf.set(next, { base: newLabel, suffix: info.suffix });
      rename(token, next);
    }
    return pairs;
  }

  /**
   * Serialize the session map to JSON.
   *
   * Schema (field-for-field parity with the Python CLI's
   * DocCloak.Cli/doccloak/core/session.py save_map/load_map):
   *
   *   [
   *     {
   *       "original": string,      // the original sensitive value
   *       "replacement": string,   // its placeholder, e.g. "[PERSON_1]" or a renamed label
   *       "entity_type": string    // EntityType value, e.g. "PERSON" (snake_case key, matching Python)
   *     },
   *     ...
   *   ]
   *
   * - Top level is a JSON array; one object per mapping, in insertion order.
   * - Counters are NOT stored as fields. Like Python's load_map, deserialize
   *   derives them from the entries themselves.
   * - The mode is NOT stored as a field. Like Python's load_map (which returns
   *   `cls()` with the default mode), deserialize yields a 'labeled' session.
   * - Blanked entries are intentionally OMITTED from the output: blanked
   *   placeholders ('________') are irreversible by design (this class already
   *   keeps them out of the reverse map), so persisting their originals would
   *   defeat that. Only reversible entries are serialized.
   * - Output formatting matches Python's json.dumps(entries, indent=2,
   *   ensure_ascii=False): 2-space indent, non-ASCII characters kept raw.
   *
   * Surrogate mode (T043) is the one exception to the top-level-array
   * schema: it wraps the same entry objects in
   * `{ "mode": "surrogate", "salt": "...", "entries": [...] }` so
   * deserialize can restore the mode and the salt (new values anonymized
   * after a restore then derive the same surrogates, and the per-session
   * date offset stays stable). Placeholder ('labeled') and blanked
   * sessions keep emitting the plain array byte-identically, so the
   * Python-parity schema is untouched and absent fields mean placeholder
   * mode.
   */
  serialize(): string {
    const entries = this.getEntries()
      .filter(({ replacement, original }) => this.reverseMap.get(replacement) === original)
      .map(({ original, replacement, entityType }) => ({
        original,
        replacement,
        entity_type: entityType,
      }));
    if (this.mode === 'surrogate') {
      return JSON.stringify({ mode: 'surrogate', salt: this.salt, entries }, null, 2);
    }
    return JSON.stringify(entries, null, 2);
  }

  /**
   * Seed the live session with previously issued mappings (T106: the
   * matter-persistence interface). Each entry lands in the forward map
   * (value -> replacement, so anonymizing the same value again reuses
   * the stored replacement instead of issuing a new one), the reverse
   * map (replacement -> value, so deanonymize restores text produced in
   * an earlier session; when several entries share a replacement, e.g.
   * T057 person variants, the LONGEST original stays canonical
   * regardless of entry order) and the type map. Per-type counters are
   * raised to the highest N found among '[TYPE_N]' replacements so new
   * entities anonymized afterwards continue numbering without colliding
   * (nextPlaceholder additionally skips any taken number, which also
   * covers renamed labels shaped like '[TYPE_N]'). Legacy
   * '<<REDACTED_N>>' replacements are kept verbatim in both maps; they
   * never collide with newly issued bracket placeholders and therefore
   * need no counter. Blanked entries ('________') are kept in the
   * forward map but excluded from the reverse map, preserving their
   * irreversibility. Entries merge into whatever the session already
   * holds; call clear() first for a fresh seeded session.
   */
  importEntries(entries: ReplacementEntry[]): void {
    for (const entry of entries) {
      this.forwardMap.set(entry.original, entry.replacement);
      if (entry.replacement !== '________') {
        const canonical = this.reverseMap.get(entry.replacement);
        if (canonical === undefined || entry.original.length > canonical.length) {
          this.reverseMap.set(entry.replacement, entry.original);
        }
      }
      this.entityTypeMap.set(entry.original, entry.entityType);
      // T171 variant tokens ([PERSON_1_LAST], [PERSON_1_LAST_2]) carry no
      // counter of their own; they re-link to their base below.
      if (VARIANT_TOKEN_RE.test(entry.replacement)) continue;
      const match = TYPED_PLACEHOLDER_RE.exec(entry.replacement);
      if (match) {
        const [, type, num] = match;
        const current = this.typeCounters.get(type) ?? 0;
        this.typeCounters.set(type, Math.max(current, Number(num)));
      }
    }
    for (const entry of entries) {
      const variant = VARIANT_TOKEN_RE.exec(entry.replacement);
      if (!variant) continue;
      const base = `${variant[1]}]`;
      if (this.reverseMap.has(base)) {
        this.variantOf.set(entry.replacement, { base, suffix: variant[2] });
      }
    }
  }

  /**
   * Rebuild a session from JSON produced by serialize() or by the Python
   * CLI's save_map. Mirrors Python's load_map: the per-entry map and
   * counter population is importEntries (see its doc for the exact
   * semantics, including legacy and blanked entries).
   */
  static deserialize(json: string): AnonymizationSession {
    interface WireEntry {
      original: string;
      replacement: string;
      entity_type: EntityType;
    }
    const data = JSON.parse(json) as unknown;
    let entries: WireEntry[];
    let session: AnonymizationSession;
    if (Array.isArray(data)) {
      entries = data as WireEntry[];
      session = new AnonymizationSession();
    } else if (
      typeof data === 'object' &&
      data !== null &&
      (data as { mode?: unknown }).mode === 'surrogate' &&
      Array.isArray((data as { entries?: unknown }).entries)
    ) {
      // Surrogate-mode wrapper (T043): restore mode + salt so surrogate
      // derivation stays consistent after the round trip.
      const wrapper = data as { salt?: unknown; entries: WireEntry[] };
      entries = wrapper.entries;
      session = new AnonymizationSession({
        mode: 'surrogate',
        salt: typeof wrapper.salt === 'string' ? wrapper.salt : undefined,
      });
    } else {
      throw new Error('Invalid session map JSON: expected a top-level array');
    }
    session.importEntries(
      entries.map((entry) => ({
        original: entry.original,
        replacement: entry.replacement,
        entityType: entry.entity_type,
      })),
    );
    return session;
  }

  clear(): void {
    this.forwardMap.clear();
    this.reverseMap.clear();
    this.entityTypeMap.clear();
    this.typeCounters.clear();
    this.variantOf.clear();
  }
}
