// T250: the files each provider downloads, whether a provider is in the model cache, and
// removing one provider that keeps the files another cached provider needs.
import { describe, it, expect } from 'vitest';
import {
  PROVIDERS,
  providerFileSets,
  isProviderCached,
  removeProviderFromCache,
  verificationMarkerKey,
  type ModelCacheIndex,
  type ProviderId,
} from '../src/index.ts';

const BASE = 'https://doccloak.example/';

function memoryIndex(): ModelCacheIndex & { keys: Set<string> } {
  const keys = new Set<string>();
  return {
    keys,
    has: async (url) => keys.has(url),
    delete: async (url) => { keys.delete(url); },
  };
}

/** What a finished download leaves: every file of the provider's first set and its marker. */
function download(index: { keys: Set<string> }, id: ProviderId, set = 0): void {
  for (const f of providerFileSets(id, BASE)[set]) {
    index.keys.add(f.url);
    index.keys.add(verificationMarkerKey(f.url, f.sha256));
  }
}

describe('model files per provider (T250)', () => {
  it('every built-in provider has file sets of pinned, absolute URLs', () => {
    for (const p of PROVIDERS) {
      const sets = providerFileSets(p.id, BASE);
      expect(sets.length, p.id).toBeGreaterThanOrEqual(1);
      for (const set of sets) {
        expect(set.length, p.id).toBeGreaterThanOrEqual(3);
        for (const f of set) {
          expect(f.url, p.id).toMatch(/^https:\/\//);
          expect(f.url, p.id).not.toContain('/resolve/main/');
          expect(f.sha256, p.id).toMatch(/^[0-9a-f]{64}$/);
        }
      }
    }
    expect(providerFileSets('openai-pf', BASE)).toHaveLength(2);
    expect(providerFileSets('gliner2-pii', BASE)[0][0].url).toBe(`${BASE}models/gliner2/model_q8_dynlabels.onnx`);
  });

  it('a provider is cached when one file set is there whole', async () => {
    const index = memoryIndex();
    expect(await isProviderCached(index, 'bardsai', { assetBaseUrl: BASE })).toBe(false);
    download(index, 'bardsai');
    expect(await isProviderCached(index, 'bardsai', { assetBaseUrl: BASE })).toBe(true);
    index.keys.delete(providerFileSets('bardsai', BASE)[0][1].url);
    expect(await isProviderCached(index, 'bardsai', { assetBaseUrl: BASE })).toBe(false);
    // OpenAI Privacy Filter: either ONNX variant counts.
    download(index, 'openai-pf', 1);
    expect(await isProviderCached(index, 'openai-pf', { assetBaseUrl: BASE })).toBe(true);
  });

  it('removing a provider drops its files and markers and nothing of the others', async () => {
    const index = memoryIndex();
    download(index, 'bardsai');
    download(index, 'gliner');
    const glinerKeys = [...index.keys].filter((k) => k.includes('knowledgator'));
    expect(await removeProviderFromCache(index, 'bardsai', { assetBaseUrl: BASE })).toBe(3);
    expect([...index.keys].sort()).toEqual(glinerKeys.sort());
    expect(await isProviderCached(index, 'gliner', { assetBaseUrl: BASE })).toBe(true);
  });

  it('keeps a file another cached provider shares: the GLiNER2 tokenizer', async () => {
    const index = memoryIndex();
    download(index, 'gliner2-pii');
    download(index, 'gliner2-pii-yethdev');
    await removeProviderFromCache(index, 'gliner2-pii', { assetBaseUrl: BASE });
    expect(await isProviderCached(index, 'gliner2-pii', { assetBaseUrl: BASE })).toBe(false);
    expect(await isProviderCached(index, 'gliner2-pii-yethdev', { assetBaseUrl: BASE })).toBe(true);
    // Once the second one goes too, the shared tokenizer goes with it.
    await removeProviderFromCache(index, 'gliner2-pii-yethdev', { assetBaseUrl: BASE });
    expect(index.keys.size).toBe(0);
  });

  it('removes both OpenAI variants, and a shared file whose other provider is not whole', async () => {
    const index = memoryIndex();
    download(index, 'openai-pf', 0);
    download(index, 'openai-pf', 1);
    // Half of yethdev: its tokenizer (shared with okasi) without the graph.
    for (const f of providerFileSets('gliner2-pii-yethdev', BASE)[0].slice(1)) index.keys.add(f.url);
    download(index, 'gliner2-pii');
    await removeProviderFromCache(index, 'openai-pf', { assetBaseUrl: BASE });
    expect([...index.keys].some((k) => k.includes('openai'))).toBe(false);
    await removeProviderFromCache(index, 'gliner2-pii', { assetBaseUrl: BASE });
    expect(index.keys.size).toBe(0);
  });

  it('without a base URL the DocCloak-served model counts as not cached and others still go', async () => {
    const index = memoryIndex();
    download(index, 'bardsai');
    expect(await isProviderCached(index, 'gliner2-pii')).toBe(false);
    await removeProviderFromCache(index, 'bardsai');
    expect(index.keys.size).toBe(0);
  });
});
