export type { RegexRule, PiiDomain, RegionCode } from './types.ts';
export type { RegexRuleJson, RegionRulesJson } from './loader.ts';

/**
 * Region choices for the regex detector: 'all' plus every shipped region
 * pack. Order is significant - hosts render region pickers straight from
 * this list (moved verbatim from the web app's engine.ts in T009).
 */
export const REGEX_REGIONS = [
  'all', 'gb', 'us', 'pl', 'de', 'fr', 'es', 'pt', 'se', 'no',
  'it', 'nl', 'be', 'at', 'ch', 'ie', 'dk', 'fi',
] as const;

export type RegexRegionId = typeof REGEX_REGIONS[number];

import type { RegexRule } from './types.ts';
import { loadRegexRules } from './loader.ts';
import { RULES_DATA } from './rules.data.ts';

/**
 * All regex rules, compiled from the canonical rules/*.json packs (T018).
 * The JSON is embedded at authoring time via the generated rules.data.ts;
 * pack order there matches the pre-T018 hand-written concatenation order.
 * An unknown validator name in the data fails right here, at module init.
 */
export const ALL_REGEX_RULES: RegexRule[] = loadRegexRules(RULES_DATA);
