/**
 * Embeds the canonical rules/*.json packs into src/regex/rules.data.ts.
 *
 * The JSON files under rules/ are the single source of truth for the shared
 * rule format (arch doc section 6). The TS build must stay self-contained
 * (dist/ ships compiled JS only, and the extension compiles src/ live via a
 * file: link), so the JSON is embedded as a generated TS module at authoring
 * time instead of being imported at runtime.
 *
 * Usage:
 *   node scripts/generate-rules-module.mjs           # (re)generate
 *   node scripts/generate-rules-module.mjs --check   # exit 1 if out of sync
 *
 * A vitest test also verifies rules.data.ts is in sync with rules/*.json,
 * so CI catches a forgotten regeneration either way.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = join(ROOT, 'src', 'regex', 'rules.data.ts');

/**
 * Pack concatenation order. This defines the order of ALL_REGEX_RULES and is
 * observable by hosts (overlap resolution, UI listings), so treat changes as
 * behavioral. Kept identical to the pre-T018 src/regex/index.ts import order.
 */
export const PACK_ORDER = [
  'universal', 'gb', 'pl', 'de', 'fr', 'es', 'pt', 'se', 'no',
  'it', 'nl', 'be', 'at', 'ch', 'ie', 'dk', 'fi', 'us', 'jp', 'cn',
];

export function render() {
  const packs = PACK_ORDER.map((region) => {
    const raw = readFileSync(join(ROOT, 'rules', `${region}.json`), 'utf8');
    const pack = JSON.parse(raw);
    if (pack.region !== region) {
      throw new Error(`rules/${region}.json declares region "${pack.region}"`);
    }
    return pack;
  });

  return `// AUTO-GENERATED FILE - DO NOT EDIT BY HAND.
// Generated from rules/*.json by scripts/generate-rules-module.mjs.
// The JSON files are the canonical rule source (arch doc section 6);
// after editing any of them run: npm run rules:gen
import type { RegionRulesJson } from './loader.ts';

export const RULES_DATA: readonly RegionRulesJson[] = ${JSON.stringify(packs, null, 2)};
`;
}

// Only act when executed directly (the module is also importable by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const content = render();

  if (process.argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(OUT_FILE, 'utf8');
    } catch {
      // missing file counts as out of sync
    }
    if (current !== content) {
      console.error('src/regex/rules.data.ts is out of sync with rules/*.json.');
      console.error('Run: npm run rules:gen');
      process.exit(1);
    }
    console.log('rules.data.ts is in sync with rules/*.json');
  } else {
    writeFileSync(OUT_FILE, content);
    console.log(`Wrote ${OUT_FILE}`);
  }
}
