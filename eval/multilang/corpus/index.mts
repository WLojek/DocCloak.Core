/**
 * T125 multilingual corpus registry.
 *
 * Language files (`<lang>.mts`, each exporting `docs: CorpusDoc[]`) are
 * authored independently (T124) and may not all exist yet, so they are
 * imported dynamically with a per-language try/catch: a missing file is
 * a console.warn and a skip, never a crash. Any other import error (a
 * half-written file with a syntax error, a bad gold tuple) is rethrown -
 * silently dropping a broken language would corrupt the benchmark.
 */

import type { CorpusDoc, Lang } from '../schema.mts';

export const ALL_LANGS: Lang[] = [
  'en', 'pl', 'de', 'fr', 'es', 'pt', 'sv', 'no',
  'it', 'nl', 'cs', 'ro', 'el', 'uk',
];

/** Load all docs of the requested languages (default: every available one). */
export async function loadCorpus(langs?: string[]): Promise<CorpusDoc[]> {
  const wanted = langs && langs.length > 0 ? langs : ALL_LANGS;
  const all: CorpusDoc[] = [];
  for (const lang of wanted) {
    try {
      const mod = await import(new URL('./' + lang + '.mts', import.meta.url).href) as { docs: CorpusDoc[] };
      all.push(...mod.docs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
        console.warn(`[corpus] missing language file: corpus/${lang}.mts (skipped)`);
      } else {
        throw new Error(`[corpus] failed to load corpus/${lang}.mts: ${(err as Error).message}`);
      }
    }
  }
  return all;
}
