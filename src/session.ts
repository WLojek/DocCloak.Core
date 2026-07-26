import type { EntityType, DetectedEntity, ReplacementEntry } from './types.ts';

export type ReplacementMode = 'labeled' | 'blanked';

export class AnonymizationSession {
  private forwardMap = new Map<string, string>();
  private reverseMap = new Map<string, string>();
  private entityTypeMap = new Map<string, EntityType>();
  private counter = 0;
  private mode: ReplacementMode = 'labeled';

  setMode(mode: ReplacementMode): void {
    this.mode = mode;
  }

  getMode(): ReplacementMode {
    return this.mode;
  }

  anonymize(original: string, entityType: EntityType): string {
    if (this.forwardMap.has(original)) {
      return this.forwardMap.get(original)!;
    }
    this.counter++;
    const placeholder = this.mode === 'blanked'
      ? '________'
      : `<<REDACTED_${this.counter}>>`;
    this.forwardMap.set(original, placeholder);
    // Blanked placeholders all collide on the same string; they are not
    // reversible, so keep them out of the restore map.
    if (this.mode !== 'blanked') {
      this.reverseMap.set(placeholder, original);
    }
    this.entityTypeMap.set(original, entityType);
    return placeholder;
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
    return result;
  }

  anonymizeText(text: string, entities: DetectedEntity[]): string {
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

  renameLabel(original: string, newLabel: string): void {
    const oldLabel = this.forwardMap.get(original);
    if (!oldLabel) return;
    this.forwardMap.set(original, newLabel);
    this.reverseMap.delete(oldLabel);
    this.reverseMap.set(newLabel, original);
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
   *       "replacement": string,   // its placeholder, e.g. "<<REDACTED_1>>" or a renamed label
   *       "entity_type": string    // EntityType value, e.g. "PERSON" (snake_case key, matching Python)
   *     },
   *     ...
   *   ]
   *
   * - Top level is a JSON array; one object per mapping, in insertion order.
   * - The counter is NOT stored as a field. Like Python's load_map, deserialize
   *   derives it from the number of entries.
   * - The mode is NOT stored as a field. Like Python's load_map (which returns
   *   `cls()` with the default mode), deserialize yields a 'labeled' session.
   * - Blanked entries are intentionally OMITTED from the output: blanked
   *   placeholders ('________') are irreversible by design (this class already
   *   keeps them out of the reverse map), so persisting their originals would
   *   defeat that. Only reversible entries are serialized.
   * - Output formatting matches Python's json.dumps(entries, indent=2,
   *   ensure_ascii=False): 2-space indent, non-ASCII characters kept raw.
   */
  serialize(): string {
    const entries = this.getEntries()
      .filter(({ replacement, original }) => this.reverseMap.get(replacement) === original)
      .map(({ original, replacement, entityType }) => ({
        original,
        replacement,
        entity_type: entityType,
      }));
    return JSON.stringify(entries, null, 2);
  }

  /**
   * Rebuild a session from JSON produced by serialize() or by the Python
   * CLI's save_map. Mirrors Python's load_map: forward/reverse/type maps are
   * repopulated per entry and the counter is incremented once per entry.
   * Additionally, the counter is raised to the highest N found among
   * '<<REDACTED_N>>' placeholders (a map serialized with gaps, e.g. after
   * blanked entries were omitted, would otherwise reissue a taken number),
   * so new entities anonymized after restore continue numbering without
   * colliding with restored placeholders. Blanked entries ('________') that a
   * Python-produced map may contain are kept in the forward map but excluded
   * from the reverse map, preserving their irreversibility.
   */
  static deserialize(json: string): AnonymizationSession {
    const data = JSON.parse(json) as Array<{
      original: string;
      replacement: string;
      entity_type: EntityType;
    }>;
    if (!Array.isArray(data)) {
      throw new Error('Invalid session map JSON: expected a top-level array');
    }
    const session = new AnonymizationSession();
    let maxPlaceholderNumber = 0;
    for (const entry of data) {
      session.forwardMap.set(entry.original, entry.replacement);
      if (entry.replacement !== '________') {
        session.reverseMap.set(entry.replacement, entry.original);
      }
      session.entityTypeMap.set(entry.original, entry.entity_type);
      session.counter++;
      const match = /^<<REDACTED_(\d+)>>$/.exec(entry.replacement);
      if (match) {
        maxPlaceholderNumber = Math.max(maxPlaceholderNumber, Number(match[1]));
      }
    }
    session.counter = Math.max(session.counter, maxPlaceholderNumber);
    return session;
  }

  clear(): void {
    this.forwardMap.clear();
    this.reverseMap.clear();
    this.entityTypeMap.clear();
    this.counter = 0;
  }
}
