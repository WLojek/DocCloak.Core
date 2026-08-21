/**
 * TAB (Text Anonymization Benchmark) evaluation (T113).
 *
 * Dataset: NorskRegnesentral/text-anonymization-benchmark (MIT license),
 * echr_test.json: 127 ECHR court judgments, span annotations by 1-10
 * annotators per document. Each mention has an entity_type (PERSON, CODE,
 * LOC, ORG, DEM, DATETIME, QUANTITY, MISC) and an identifier_type:
 *   DIRECT - directly identifying, must be masked
 *   QUASI  - quasi-identifier, must be masked (re-identification risk)
 *   NO_MASK - annotator decided this mention does NOT need masking
 *
 * ── Schema mapping: TAB categories -> DocCloak EntityType ──
 *
 * DocCloak's type inventory targets consumer documents (contracts, CVs,
 * letters), not court judgments, so the mapping is partial by design.
 * Every decision below is deliberate and mirrored in the results doc:
 *
 *   PERSON   -> PERSON     clean 1:1
 *   ORG      -> COMPANY    close: TAB ORG includes courts, governments and
 *                          NGOs; DocCloak COMPANY is trained/ruled around
 *                          commercial entities. Counted as a fair match.
 *   DATETIME -> DATE       clean 1:1 in intent; TAB DATETIME includes bare
 *                          years and durations DocCloak does not target.
 *   LOC      -> ADDRESS    PARTIAL: TAB LOC is any location (countries,
 *                          cities, regions, facilities); DocCloak ADDRESS
 *                          targets street addresses/cities/postcodes. A
 *                          country name is gold LOC but out of scope for
 *                          most of DocCloak's ADDRESS detectors.
 *   CODE     -> SSN, OTHER NO DEDICATED TYPE: TAB CODE is case/application
 *                          numbers. DocCloak has no case-number type; its
 *                          national-ID regexes emit SSN and the EU model's
 *                          DOCUMENT_REFERENCE label emits OTHER, so both
 *                          are accepted in type-aware scoring.
 *   DEM      -> OTHER      NOT ATTEMPTED: demographic traits (nationality,
 *                          profession, age group). No DocCloak type claims
 *                          this; the EU model's PERSON_ATTRIBUTE and
 *                          ETHNIC_ORIGIN labels land in OTHER.
 *   QUANTITY -> CURRENCY, OTHER  PARTIAL: only monetary amounts are in
 *                          scope for DocCloak (CURRENCY); TAB QUANTITY is
 *                          mostly ages and counts, which are not attempted.
 *   MISC     -> OTHER      NOT ATTEMPTED as a category.
 *
 * ── Scoring protocol ──
 *
 * Recall: micro-averaged over (document, annotator) pairs, gold = mentions
 * with identifier_type DIRECT or QUASI (NO_MASK mentions are not privacy
 * targets). This follows the TAB paper's convention of treating each
 * annotator's masking decisions as a separate reference.
 *
 * Type-agnostic ("masking") recall is primary: for anonymization it does
 * not matter whether a name was masked because the detector called it
 * PERSON or ADDRESS - it matters that it was masked. Type-aware recall
 * (prediction type must be in the mapped set) is reported as a secondary,
 * stricter view.
 *
 * Precision: per document, against the union of all annotators' mentions
 * (a prediction is correct if at least one annotator marked an overlapping
 * mention DIRECT/QUASI). Predictions overlapping only NO_MASK mentions are
 * reported separately as "over-masking" (they hit a real entity that the
 * annotators judged safe to keep); predictions overlapping no mention at
 * all are "spurious". Both count against masking precision.
 */

import { readFileSync } from 'node:fs';
import type { DetectedEntity, EntityType } from '../src/types.ts';
import { CategoryTally, Tally, coverage, overlaps, f1 } from './metrics.mts';

export type TabEntityType =
  | 'PERSON' | 'CODE' | 'LOC' | 'ORG' | 'DEM' | 'DATETIME' | 'QUANTITY' | 'MISC';

export const TAB_TYPE_MAPPING: Record<TabEntityType, EntityType[]> = {
  PERSON: ['PERSON'],
  ORG: ['COMPANY'],
  DATETIME: ['DATE'],
  LOC: ['ADDRESS'],
  CODE: ['SSN', 'OTHER'],
  DEM: ['OTHER'],
  QUANTITY: ['CURRENCY', 'OTHER'],
  MISC: ['OTHER'],
};

/** TAB categories DocCloak genuinely attempts (rest are reported but flagged). */
export const TAB_ATTEMPTED: TabEntityType[] = ['PERSON', 'ORG', 'DATETIME', 'LOC', 'CODE'];

interface TabMention {
  entity_type: TabEntityType;
  start_offset: number;
  end_offset: number;
  span_text: string;
  identifier_type: 'DIRECT' | 'QUASI' | 'NO_MASK';
}

export interface TabDoc {
  doc_id: string;
  text: string;
  annotations: Record<string, { entity_mentions: TabMention[] }>;
}

export function loadTab(path: string, limit?: number): TabDoc[] {
  const docs = JSON.parse(readFileSync(path, 'utf8')) as TabDoc[];
  return limit ? docs.slice(0, limit) : docs;
}

export interface TabResult {
  dataset: string;
  documents: number;
  annotatorReferences: number;
  goldMentions: number;
  predictions: number;
  recall: {
    /** primary: gold span fully covered by predicted spans of any type */
    maskingStrict: Record<string, { hits: number; total: number; ratio: number }>;
    /** any-overlap variant */
    maskingLenient: Record<string, { hits: number; total: number; ratio: number }>;
    /** full coverage AND predicted type in the mapped set */
    typeAwareStrict: Record<string, { hits: number; total: number; ratio: number }>;
    byIdentifierType: Record<string, { hits: number; total: number; ratio: number }>;
    overallMaskingStrict: number;
    overallMaskingLenient: number;
    overallAttemptedMaskingStrict: number;
  };
  precision: {
    /** prediction overlaps a DIRECT/QUASI mention of any annotator */
    masking: number;
    maskingHits: number;
    total: number;
    /** prediction overlaps only NO_MASK mentions (real entity, judged safe) */
    overMaskingShare: number;
    /** prediction overlaps no annotated mention at all */
    spuriousShare: number;
    byPredictedType: Record<string, { hits: number; total: number; ratio: number }>;
  };
  f1MaskingStrict: number;
}

export function evaluateTab(
  docs: TabDoc[],
  predictionsByDoc: Map<string, DetectedEntity[]>,
): TabResult {
  const maskingStrict = new CategoryTally();
  const maskingLenient = new CategoryTally();
  const typeAwareStrict = new CategoryTally();
  const byIdentifierType = new CategoryTally();
  const overallStrict = new Tally();
  const overallLenient = new Tally();
  const overallAttempted = new Tally();

  const precisionByType = new CategoryTally();
  const precisionOverall = new Tally();
  let overMasking = 0;
  let spurious = 0;

  let annotatorReferences = 0;
  let goldMentions = 0;
  let totalPredictions = 0;

  for (const doc of docs) {
    const preds = predictionsByDoc.get(doc.doc_id) ?? [];
    totalPredictions += preds.length;

    // ── Recall: micro over (doc, annotator) pairs ──
    for (const annotation of Object.values(doc.annotations)) {
      annotatorReferences++;
      for (const m of annotation.entity_mentions) {
        if (m.identifier_type === 'NO_MASK') continue;
        goldMentions++;
        const gold = { start: m.start_offset, end: m.end_offset };
        const overlapping = preds.filter((p) => overlaps(gold, p));
        const cov = coverage(gold, overlapping);
        const strictHit = cov >= 0.9999;
        const lenientHit = overlapping.length > 0;
        const allowedTypes = TAB_TYPE_MAPPING[m.entity_type] ?? [];
        const typeHit = strictHit && overlapping.some((p) => allowedTypes.includes(p.type));

        maskingStrict.add(m.entity_type, strictHit);
        maskingLenient.add(m.entity_type, lenientHit);
        typeAwareStrict.add(m.entity_type, typeHit);
        byIdentifierType.add(m.identifier_type, strictHit);
        overallStrict.add(strictHit);
        overallLenient.add(lenientHit);
        if (TAB_ATTEMPTED.includes(m.entity_type)) overallAttempted.add(strictHit);
      }
    }

    // ── Precision: against the union of all annotators' mentions ──
    const maskable: Array<{ start: number; end: number }> = [];
    const noMask: Array<{ start: number; end: number }> = [];
    for (const annotation of Object.values(doc.annotations)) {
      for (const m of annotation.entity_mentions) {
        const span = { start: m.start_offset, end: m.end_offset };
        if (m.identifier_type === 'NO_MASK') noMask.push(span);
        else maskable.push(span);
      }
    }
    for (const p of preds) {
      const hitMaskable = maskable.some((g) => overlaps(g, p));
      precisionOverall.add(hitMaskable);
      precisionByType.add(p.type, hitMaskable);
      if (!hitMaskable) {
        if (noMask.some((g) => overlaps(g, p))) overMasking++;
        else spurious++;
      }
    }
  }

  const p = precisionOverall.ratio;
  const r = overallStrict.ratio;
  return {
    dataset: 'TAB echr_test',
    documents: docs.length,
    annotatorReferences,
    goldMentions,
    predictions: totalPredictions,
    recall: {
      maskingStrict: maskingStrict.toJSON(),
      maskingLenient: maskingLenient.toJSON(),
      typeAwareStrict: typeAwareStrict.toJSON(),
      byIdentifierType: byIdentifierType.toJSON(),
      overallMaskingStrict: r,
      overallMaskingLenient: overallLenient.ratio,
      overallAttemptedMaskingStrict: overallAttempted.ratio,
    },
    precision: {
      masking: p,
      maskingHits: precisionOverall.hits,
      total: precisionOverall.total,
      overMaskingShare: precisionOverall.total === 0 ? 0 : overMasking / precisionOverall.total,
      spuriousShare: precisionOverall.total === 0 ? 0 : spurious / precisionOverall.total,
      byPredictedType: precisionByType.toJSON(),
    },
    f1MaskingStrict: f1(p, r),
  };
}
