/**
 * Partial extraction of the web app's docx module (T003). doc.ts imports
 * normalizeReplacements from this path; the function is pure, so it moves
 * ahead of the full DOM-dependent docx move (T011, dom submodule). The body
 * below is copied verbatim from DocCloak/src/core/docx.ts.
 */

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
