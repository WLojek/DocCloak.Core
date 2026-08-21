/**
 * PUPA (PAPILLON benchmark) evaluation (T113).
 *
 * Dataset: Columbia-NLP/PUPA on Hugging Face (MIT license), the dataset of
 * the PAPILLON paper (arXiv:2410.17127). Two configs:
 *   pupa_tnb (237 rows, from the "Trust No Bot" study) and
 *   pupa_new (664 rows, newly collected WildChat conversations).
 * Each row is a real user query to an LLM plus "pii_units": the PII strings
 * a human decided should not reach an untrusted model, separated by "||".
 *
 * ── What PUPA can and cannot measure ──
 *
 * PUPA has NO span offsets and NO entity categories - just lowercase PII
 * strings. So:
 *  - per-entity-category recall is NOT computable on PUPA (only overall
 *    PII-unit recall); per-category numbers come from TAB instead.
 *  - gold units are located in the query by case-insensitive substring
 *    search. Units that do not occur verbatim in user_query (annotators
 *    sometimes wrote normalized/partial units, or the unit came from the
 *    model response) are counted and excluded from the recall denominator.
 *  - pupa_new queries were pre-scrubbed by WildChat's Presidio pass:
 *    literal "<PRESIDIO_ANONYMIZED_*>" placeholders appear in the text and
 *    as pii_units. These are artifacts of the source pipeline, not real
 *    PII strings; units containing "presidio_anonymized" are excluded and
 *    counted.
 *
 * ── Scoring ──
 *
 * Unit recall (primary, strict): a gold unit counts as recalled only if
 * EVERY occurrence of it in the query is fully character-covered by
 * predicted spans - one unmasked occurrence leaks the value. Lenient: at
 * least one occurrence overlaps at least one prediction.
 *
 * Precision: a predicted span is a true positive if it overlaps any
 * occurrence of any gold unit. PUPA's pii_units are intended to be
 * exhaustive for the query, so non-overlapping predictions are counted as
 * false positives - with the caveat (see results doc) that annotators
 * marked units at their own granularity, so this is an approximation.
 */

import { readFileSync } from 'node:fs';
import type { DetectedEntity } from '../src/types.ts';
import { CategoryTally, Tally, coverage, overlaps, f1 } from './metrics.mts';

/** Minimal RFC-4180 CSV parser (quotes, escaped quotes, newlines in fields). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''));
}

export interface PupaDoc {
  id: string;
  query: string;
  units: string[];
}

export function loadPupa(path: string, limit?: number): PupaDoc[] {
  const rows = parseCsv(readFileSync(path, 'utf8'));
  const header = rows[0];
  const qi = header.indexOf('user_query');
  const pi = header.indexOf('pii_units');
  const hi = header.indexOf('conversation_hash');
  if (qi < 0 || pi < 0) throw new Error(`Unexpected PUPA header: ${header.join(',')}`);
  const docs: PupaDoc[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r[qi]) continue;
    const units = [...new Set(
      (r[pi] ?? '').split('||').map((u) => u.trim().toLowerCase()).filter((u) => u.length > 0),
    )];
    docs.push({ id: r[hi] ?? `row${i}`, query: r[qi], units });
  }
  return limit ? docs.slice(0, limit) : docs;
}

function findOccurrences(haystackLower: string, needleLower: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let from = 0;
  while (from < haystackLower.length) {
    const idx = haystackLower.indexOf(needleLower, from);
    if (idx < 0) break;
    out.push({ start: idx, end: idx + needleLower.length });
    from = idx + 1;
  }
  return out;
}

export interface PupaResult {
  dataset: string;
  documents: number;
  goldUnits: number;
  excludedPresidioArtifacts: number;
  unlocatableUnits: number;
  evaluatedUnits: number;
  predictions: number;
  recall: {
    /** primary: every occurrence of the unit fully covered */
    unitStrict: number;
    unitStrictHits: number;
    /** at least one occurrence overlapped */
    unitLenient: number;
  };
  precision: {
    overall: number;
    hits: number;
    total: number;
    byPredictedType: Record<string, { hits: number; total: number; ratio: number }>;
  };
  f1Strict: number;
}

export function evaluatePupa(
  docs: PupaDoc[],
  predictionsByDoc: Map<string, DetectedEntity[]>,
  datasetName: string,
): PupaResult {
  const unitStrict = new Tally();
  const unitLenient = new Tally();
  const precisionOverall = new Tally();
  const precisionByType = new CategoryTally();
  let goldUnits = 0;
  let presidioArtifacts = 0;
  let unlocatable = 0;
  let totalPredictions = 0;

  for (const doc of docs) {
    const preds = predictionsByDoc.get(doc.id) ?? [];
    totalPredictions += preds.length;
    const queryLower = doc.query.toLowerCase();
    const allGoldOccurrences: Array<{ start: number; end: number }> = [];

    for (const unit of doc.units) {
      goldUnits++;
      if (unit.includes('presidio_anonymized')) { presidioArtifacts++; continue; }
      const occurrences = findOccurrences(queryLower, unit);
      if (occurrences.length === 0) { unlocatable++; continue; }
      allGoldOccurrences.push(...occurrences);
      const everyOccurrenceCovered = occurrences.every(
        (occ) => coverage(occ, preds.filter((p) => overlaps(occ, p))) >= 0.9999,
      );
      const anyOverlap = occurrences.some((occ) => preds.some((p) => overlaps(occ, p)));
      unitStrict.add(everyOccurrenceCovered);
      unitLenient.add(anyOverlap);
    }

    for (const p of preds) {
      const hit = allGoldOccurrences.some((g) => overlaps(g, p));
      precisionOverall.add(hit);
      precisionByType.add(p.type, hit);
    }
  }

  const p = precisionOverall.ratio;
  const r = unitStrict.ratio;
  return {
    dataset: datasetName,
    documents: docs.length,
    goldUnits,
    excludedPresidioArtifacts: presidioArtifacts,
    unlocatableUnits: unlocatable,
    evaluatedUnits: unitStrict.total,
    predictions: totalPredictions,
    recall: {
      unitStrict: r,
      unitStrictHits: unitStrict.hits,
      unitLenient: unitLenient.ratio,
    },
    precision: {
      overall: p,
      hits: precisionOverall.hits,
      total: precisionOverall.total,
      byPredictedType: precisionByType.toJSON(),
    },
    f1Strict: f1(p, r),
  };
}
