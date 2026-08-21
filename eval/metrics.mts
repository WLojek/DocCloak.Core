/**
 * Span-matching metrics for the benchmark harness (T113).
 *
 * All matching is character-offset based. Two notions of "detected" are
 * reported everywhere, because they answer different questions:
 *
 * - lenient: at least one predicted span overlaps the gold span by >= 1
 *   character. Answers "did the detector notice something here at all".
 * - strict: the union of predicted spans covers 100% of the gold span's
 *   characters. Answers "would the full string actually be masked", which
 *   is the bar that matters for anonymization (a half-masked name leaks).
 */

export interface Span {
  start: number;
  end: number;
}

export function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && a.end > b.start;
}

/** Fraction of gold's characters covered by the union of the predictions. */
export function coverage(gold: Span, preds: Span[]): number {
  const len = gold.end - gold.start;
  if (len <= 0) return 1;
  const covered = new Array<boolean>(len).fill(false);
  for (const p of preds) {
    const from = Math.max(gold.start, p.start);
    const to = Math.min(gold.end, p.end);
    for (let i = from; i < to; i++) covered[i - gold.start] = true;
  }
  let n = 0;
  for (const c of covered) if (c) n++;
  return n / len;
}

/** Running tally that turns TP/total counts into precision-style ratios. */
export class Tally {
  hits = 0;
  total = 0;
  add(hit: boolean): void {
    this.total++;
    if (hit) this.hits++;
  }
  get ratio(): number {
    return this.total === 0 ? 0 : this.hits / this.total;
  }
}

export function f1(precision: number, recall: number): number {
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

export function pct(x: number): string {
  return (100 * x).toFixed(1) + '%';
}

/** Per-category map of tallies, auto-creating categories on first use. */
export class CategoryTally {
  private map = new Map<string, Tally>();
  add(category: string, hit: boolean): void {
    let t = this.map.get(category);
    if (!t) {
      t = new Tally();
      this.map.set(category, t);
    }
    t.add(hit);
  }
  entries(): Array<[string, Tally]> {
    return [...this.map.entries()].sort((a, b) => b[1].total - a[1].total);
  }
  toJSON(): Record<string, { hits: number; total: number; ratio: number }> {
    const out: Record<string, { hits: number; total: number; ratio: number }> = {};
    for (const [k, t] of this.entries()) out[k] = { hits: t.hits, total: t.total, ratio: t.ratio };
    return out;
  }
}
