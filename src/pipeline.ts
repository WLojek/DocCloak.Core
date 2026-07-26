/**
 * Pure entity pipeline (T005).
 *
 * Extracted verbatim from the web app's detection.worker.ts: text and
 * entities in, entities out. No worker messaging, no providers, no
 * environment access. The worker (and any other host) composes these
 * functions around its own ML provider call.
 *
 * Function bodies are byte-identical to the originals by design; only the
 * signatures of detectWithRegex (regexRegion becomes a parameter instead of
 * worker module state) and detectEntities (ML results are passed in instead
 * of fetched from a provider) differ.
 */

import type { DetectedEntity } from './types.ts';
import { ALL_REGEX_RULES } from './regex/index.ts';

export function detectWithRegex(text: string, regexRegion: string = 'all'): DetectedEntity[] {
  const entities: DetectedEntity[] = [];
  const rules = regexRegion === 'all'
    ? ALL_REGEX_RULES
    : ALL_REGEX_RULES.filter((r) => r.region === 'universal' || r.region === regexRegion);
  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = rule.pattern.exec(text)) !== null) {
      if (rule.validate && !rule.validate(match[0])) continue;
      entities.push({
        type: rule.type,
        value: match[0],
        start: match.index,
        end: match.index + match[0].length,
        confidence: rule.confidence,
        detector: rule.detector,
      });
    }
  }
  return entities;
}

export function resolveOverlaps(entities: DetectedEntity[]): DetectedEntity[] {
  const sorted = [...entities].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    const aLen = a.end - a.start;
    const bLen = b.end - b.start;
    if (aLen !== bLen) return bLen - aLen;
    return b.confidence - a.confidence;
  });

  const resolved: DetectedEntity[] = [];
  for (const entity of sorted) {
    const overlaps = resolved.some(
      (existing) => entity.start < existing.end && entity.end > existing.start
    );
    if (!overlaps) {
      resolved.push(entity);
    }
  }

  return resolved;
}

export function filterFalsePositives(entities: DetectedEntity[]): DetectedEntity[] {
  return entities.filter((e) => {
    if (e.value.trim().length < 3) return false;
    return true;
  });
}

export function propagateEntities(text: string, entities: DetectedEntity[]): DetectedEntity[] {
  const propagated: DetectedEntity[] = [];
  const seen = new Set<string>();

  for (const e of entities) {
    seen.add(`${e.start}:${e.end}`);
  }

  const terms: { term: string; type: DetectedEntity['type'] }[] = [];
  const addedTerms = new Set<string>();

  for (const e of entities) {
    const val = e.value.trim();
    if (val.length >= 3 && !addedTerms.has(val.toLowerCase())) {
      addedTerms.add(val.toLowerCase());
      terms.push({ term: val, type: e.type });
    }
    if (val.includes(' ')) {
      for (const word of val.split(/\s+/)) {
        const w = word.replace(/[.,;:!?()]+$/, '');
        if (w.length >= 4 && !addedTerms.has(w.toLowerCase())) {
          addedTerms.add(w.toLowerCase());
          terms.push({ term: w, type: e.type });
        }
      }
    }
  }

  for (const { term, type } of terms) {
    let searchFrom = 0;
    const lowerText = text.toLowerCase();
    const lowerTerm = term.toLowerCase();
    while (searchFrom < text.length) {
      const idx = lowerText.indexOf(lowerTerm, searchFrom);
      if (idx === -1) break;
      const end = idx + term.length;
      const key = `${idx}:${end}`;
      if (!seen.has(key)) {
        const charBefore = idx > 0 ? text[idx - 1] : ' ';
        const charAfter = end < text.length ? text[end] : ' ';
        const isBoundaryBefore = /[\s.,;:!?()"'„"\-–—/]/.test(charBefore);
        const isBoundaryAfter = /[\s.,;:!?()"'„"\-–—/]/.test(charAfter);
        if (isBoundaryBefore && isBoundaryAfter) {
          seen.add(key);
          propagated.push({
            type,
            value: text.slice(idx, end),
            start: idx,
            end,
            confidence: 0.95,
            detector: 'propagated',
          });
        }
      }
      searchFrom = idx + 1;
    }
  }

  return propagated;
}

export function detectEntities(
  text: string,
  mlEntities: DetectedEntity[],
  regexEntities: DetectedEntity[],
): DetectedEntity[] {
  if (!text.trim()) return [];

  const mlResults = filterFalsePositives(mlEntities);
  const regexResults = regexEntities;
  const initial = resolveOverlaps([...mlResults, ...regexResults]);
  const propagated = propagateEntities(text, initial);
  return resolveOverlaps([...initial, ...propagated]);
}
