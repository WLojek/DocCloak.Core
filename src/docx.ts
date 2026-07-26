/**
 * Pure, DOM-free part of the docx module. The full docx read/write logic
 * (DOMParser/XMLSerializer-dependent) lives in src/dom/docx.ts behind the
 * '@doccloak/core/dom' export (T011); it imports and re-exports the helpers
 * below so the main entry stays free of DOM references. doc.ts also imports
 * normalizeReplacements from this path. Bodies copied verbatim from
 * DocCloak/src/core/docx.ts.
 */

/**
 * A pairing of an original sensitive value with its replacement placeholder,
 * used to scrub places offset-based replacement cannot reach (relationship
 * targets, field instruction attributes).
 */
export interface ValueReplacement {
  value: string;
  replacement: string;
}

/**
 * Sort replacements and clamp overlapping ranges so each character is covered
 * by at most one replacement. Overlaps would otherwise double-apply and corrupt
 * the output around the overlap.
 */
export function normalizeReplacements(
  replacements: Array<{ start: number; end: number; replacement: string }>
): Array<{ start: number; end: number; replacement: string }> {
  const sorted = [...replacements].sort((a, b) => a.start - b.start || a.end - b.end);
  const result: Array<{ start: number; end: number; replacement: string }> = [];
  let lastEnd = -1;
  for (const repl of sorted) {
    const start = Math.max(repl.start, lastEnd);
    if (start >= repl.end) continue; // fully covered by the previous replacement
    result.push(start === repl.start ? repl : { ...repl, start });
    lastEnd = repl.end;
  }
  return result;
}
