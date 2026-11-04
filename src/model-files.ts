/**
 * The files each built-in provider downloads into the host's model cache (T250), so a host can
 * show whether a model is already on the device and remove one model to free the space.
 *
 * The URLs are the pinned ones the providers fetch; the cache keys are those URLs plus the
 * verification marker of each (verificationMarkerKey). A model is on the device when every file
 * of one of its file sets is cached: most providers have one set, OpenAI Privacy Filter one per
 * ONNX variant (q4f16 on a GPU with shader-f16, q4 otherwise).
 */

import { PROVIDERS, type ProviderId } from './engine.ts';
import { verificationMarkerKey, type TokenizerFileSpec } from './model-loader.ts';
import { GLINER_MODEL_SHA256, GLINER_MODEL_URL, GLINER_TOKENIZER_FILES } from './providers/gliner.ts';
import { GLINER_BASE_MODEL_SHA256, GLINER_BASE_MODEL_URL, GLINER_BASE_TOKENIZER_FILES } from './providers/gliner-base.ts';
import { BARDSAI_MODEL_SHA256, BARDSAI_MODEL_URL, BARDSAI_TOKENIZER_FILES } from './providers/bardsai.ts';
import { BARDSAI_V2_VARIANTS } from './providers/bardsai-v2.ts';
import { GLINER2_TOKENIZER_FILES, GLINER2_VARIANTS, type Gliner2Variant } from './providers/gliner2.ts';
import { OPENAI_PF_TOKENIZER_FILES, OPENAI_PF_VARIANTS } from './providers/openai-privacy-filter.ts';

/** One downloaded file: its cache key (absolute URL) and pinned SHA-256; size where pinned. */
export interface ModelFile {
  url: string;
  sha256: string;
  size?: number;
}

/**
 * The part of a host's model cache this module needs: whether it holds a key, and removing one.
 * `has` must not read the entry (models are hundreds of MB); on the web, `cache.match(url)` and a
 * check for a response is enough.
 */
export interface ModelCacheIndex {
  has(url: string): Promise<boolean>;
  delete(url: string): Promise<void>;
}

function gliner2Files(variant: Gliner2Variant): Array<TokenizerFileSpec | ModelFile> {
  return [variant.graph, ...(variant.data ? [variant.data] : []), ...GLINER2_TOKENIZER_FILES];
}

/**
 * The file sets of a provider; a model is on the device when one set is cached whole. A path
 * without a scheme (the GLiNER2 graph DocCloak serves itself) is resolved against
 * `assetBaseUrl` (or the page), as the provider does with CoreEnv.assetBaseUrl.
 */
export function providerFileSets(id: ProviderId, assetBaseUrl?: string): ModelFile[][] {
  const sets: Array<Array<TokenizerFileSpec | ModelFile>> = (() => {
    switch (id) {
      case 'gliner': return [[{ url: GLINER_MODEL_URL, sha256: GLINER_MODEL_SHA256 }, ...GLINER_TOKENIZER_FILES]];
      case 'gliner-base': return [[{ url: GLINER_BASE_MODEL_URL, sha256: GLINER_BASE_MODEL_SHA256 }, ...GLINER_BASE_TOKENIZER_FILES]];
      case 'bardsai': return [[{ url: BARDSAI_MODEL_URL, sha256: BARDSAI_MODEL_SHA256 }, ...BARDSAI_TOKENIZER_FILES]];
      case 'bardsai-v2': return [[BARDSAI_V2_VARIANTS.v2.model, ...BARDSAI_V2_VARIANTS.v2.tokenizer]];
      case 'bardsai-v3': return [[BARDSAI_V2_VARIANTS.v3.model, ...BARDSAI_V2_VARIANTS.v3.tokenizer]];
      case 'gliner2-pii': return [gliner2Files(GLINER2_VARIANTS['okasi-q8'])];
      case 'gliner2-pii-yethdev': return [gliner2Files(GLINER2_VARIANTS.yethdev)];
      case 'openai-pf': return Object.values(OPENAI_PF_VARIANTS).map((v) => [v.graph, v.data, ...OPENAI_PF_TOKENIZER_FILES]);
    }
  })();
  return sets.map((set) => set.map((f) => ({ url: absolute(f.url, assetBaseUrl), sha256: f.sha256, ...(f.size !== undefined ? { size: f.size } : {}) })));
}

function absolute(url: string, assetBaseUrl: string | undefined): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  const base = assetBaseUrl ?? (globalThis as { location?: { href: string } }).location?.href;
  if (!base) throw new Error(`No base URL for the DocCloak-served file ${url} (pass assetBaseUrl)`);
  return new URL(url, base).href;
}

/** The file sets, or none where a DocCloak-served file has no base URL: such a model cannot have been downloaded. */
function knownFileSets(id: ProviderId, assetBaseUrl: string | undefined): ModelFile[][] {
  try {
    return providerFileSets(id, assetBaseUrl);
  } catch {
    return [];
  }
}

async function hasAll(cache: ModelCacheIndex, files: ModelFile[]): Promise<boolean> {
  const found = await Promise.all(files.map((f) => cache.has(f.url)));
  return found.every(Boolean);
}

export interface ModelCacheOptions {
  /** Base of the files DocCloak serves itself (CoreEnv.assetBaseUrl); needed for GLiNER2 Privacy Filter. */
  assetBaseUrl?: string;
}

/** True when every file of one of the provider's file sets is in the cache. */
export async function isProviderCached(cache: ModelCacheIndex, id: ProviderId, options: ModelCacheOptions = {}): Promise<boolean> {
  for (const set of knownFileSets(id, options.assetBaseUrl)) {
    if (await hasAll(cache, set)) return true;
  }
  return false;
}

/**
 * Remove a provider's files and their verification markers from the cache, every file set of
 * it, except files another provider that is still cached whole needs (the two GLiNER2 exports
 * share one tokenizer). Resolves to the number of files removed.
 */
export async function removeProviderFromCache(
  cache: ModelCacheIndex,
  id: ProviderId,
  options: ModelCacheOptions & {
    /** Providers whose cached files stay; by default every built-in one. */
    others?: readonly ProviderId[];
  } = {},
): Promise<number> {
  const { assetBaseUrl, others = PROVIDERS.map((p) => p.id) } = options;
  const keep = new Set<string>();
  for (const other of others) {
    if (other === id) continue;
    for (const set of knownFileSets(other, assetBaseUrl)) {
      if (await hasAll(cache, set)) for (const f of set) keep.add(f.url);
    }
  }
  const files = new Map<string, ModelFile>();
  for (const set of providerFileSets(id, assetBaseUrl)) for (const f of set) files.set(f.url, f);
  let removed = 0;
  for (const f of files.values()) {
    if (keep.has(f.url)) continue;
    if (await cache.has(f.url)) removed++;
    await cache.delete(f.url);
    await cache.delete(verificationMarkerKey(f.url, f.sha256.toLowerCase()));
  }
  return removed;
}
