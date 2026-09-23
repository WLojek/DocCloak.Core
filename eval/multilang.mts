/**
 * T125 multilingual 3-model benchmark: raw model quality across 14 languages.
 *
 * Usage (from DocCloak.Core/):
 *   npm run bench:multilang
 *   node --experimental-strip-types eval/multilang.mts --provider gliner --lang pl,de --limit 5
 *
 * Providers: all | gliner | gliner-base | bardsai
 * Langs:     all | comma,list (subset of the 14 corpus languages)
 * Limit:     max docs per language (after the lang filter)
 *
 * Unlike eval/run.mts (which measures the shipped product pipeline), this
 * harness scores each provider's RAW detect() output at the product default
 * threshold - no regex tier, no detectEntities overlap resolution. It
 * isolates MODEL quality on the hand-built multilingual gold corpus
 * (eval/multilang/corpus/), so the three models can be compared per
 * language on equal footing.
 *
 * Providers are loaded SERIALLY (load, run all pending docs, release, then
 * the next) to bound memory: the models are 83-279 MB each. Raw predictions
 * are cached resume-safe in eval/data/cache/multilang-raw-<provider>.jsonl,
 * one {id, ms, preds} line per doc; delete a cache file to force
 * re-inference for that provider.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DetectedEntity, DetectionProvider } from '../src/types.ts';
import type { CoreEnv } from '../src/env.ts';
import { createNodeEvalEnv, installNodeBlobUrlShim } from './node-env.mts';
import { overlaps, coverage, Tally, CategoryTally, f1, pct } from './metrics.mts';
import { validateDoc, type CorpusDoc, type GoldSpan } from './multilang/schema.mts';
import { loadCorpus, ALL_LANGS } from './multilang/corpus/index.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, 'data', 'cache');
const RESULTS = join(HERE, 'results');

type ProviderId = 'gliner' | 'gliner-base' | 'bardsai';
const ALL_PROVIDERS: ProviderId[] = ['gliner', 'gliner-base', 'bardsai'];

/** One cached inference: raw preds + wall-clock detect() milliseconds. */
interface RawResult {
  ms: number;
  preds: DetectedEntity[];
}

// ── CLI args ────────────────────────────────────────────────

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

// ── Providers (loaded serially, one at a time) ──────────────

async function createProvider(id: ProviderId, env: CoreEnv): Promise<DetectionProvider> {
  if (id === 'gliner') {
    const { GlinerProvider } = await import('../src/providers/gliner.ts');
    return new GlinerProvider(env);
  }
  if (id === 'gliner-base') {
    const { GlinerBaseProvider } = await import('../src/providers/gliner-base.ts');
    return new GlinerBaseProvider(env);
  }
  const { BardsaiProvider } = await import('../src/providers/bardsai.ts');
  return new BardsaiProvider(env);
}

function watchProgress(id: ProviderId, p: DetectionProvider): void {
  let lastPct = -1;
  p.onProgress((d: number, t: number) => {
    if (t > 0) {
      const percent = Math.floor((100 * d) / t);
      if (percent !== lastPct && percent % 10 === 0) {
        lastPct = percent;
        console.log(`  [${id}] model download ${percent}% of ${(t / 1e6).toFixed(0)} MB`);
      }
    }
  });
}

// ── Raw prediction cache (resume-safe) ──────────────────────

function loadRawCache(file: string): Map<string, RawResult> {
  const map = new Map<string, RawResult>();
  if (!existsSync(file)) return map;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const { id, ms, preds } = JSON.parse(line) as { id: string; ms: number; preds: DetectedEntity[] };
    map.set(id, { ms, preds });
  }
  return map;
}

/**
 * Raw detect() output for every doc, from cache where possible. The
 * provider is only instantiated/loaded when there are uncached docs, and
 * is released before this returns (serial loading bounds peak memory).
 */
async function rawPredictions(
  providerId: ProviderId,
  docs: CorpusDoc[],
  env: CoreEnv,
): Promise<{ raw: Map<string, RawResult>; modelName: string; threshold: number }> {
  mkdirSync(CACHE, { recursive: true });
  const cacheFile = join(CACHE, `multilang-raw-${providerId}.jsonl`);
  const cached = loadRawCache(cacheFile);
  const pending = docs.filter((d) => !cached.has(d.id));

  const provider = await createProvider(providerId, env);
  const modelName = provider.name;
  const threshold = provider.getThreshold();

  if (pending.length > 0) {
    console.log(`  ${providerId}: ${pending.length}/${docs.length} docs to run (${cached.size} cached)`);
    watchProgress(providerId, provider);
    console.log(`  [${providerId}] loading model (product default threshold ${threshold})...`);
    await provider.load();
    const t0 = Date.now();
    let done = 0;
    for (const doc of pending) {
      const s = Date.now();
      const preds = await provider.detect(doc.text);
      const ms = Date.now() - s;
      cached.set(doc.id, { ms, preds });
      appendFileSync(cacheFile, JSON.stringify({ id: doc.id, ms, preds }) + '\n');
      done++;
      if (done % 25 === 0 || done === pending.length) {
        const rate = (Date.now() - t0) / done;
        const etaMin = ((pending.length - done) * rate) / 60000;
        console.log(`  ${providerId}: ${done}/${pending.length} (eta ${etaMin.toFixed(1)} min)`);
      }
    }
    provider.release();
  } else {
    console.log(`  ${providerId}: all ${docs.length} docs cached`);
  }
  return { raw: cached, modelName, threshold };
}

// ── Scoring ─────────────────────────────────────────────────

const STRICT_COVERAGE = 0.999;

interface Miss {
  docId: string;
  text: string;
  type: string;
  coverage: number;
}

interface FalsePositive {
  docId: string;
  text: string;
  predType: string;
  confidence: number;
}

interface LangScore {
  docs: number;
  goldSpans: number;
  predictions: number;
  recallStrict: number;
  recallLenient: number;
  typeAwareStrict: number;
  precision: number;
  f1: number;
  byType: Record<string, { hits: number; total: number; ratio: number }>;
  latency: { meanMs: number; p95Ms: number };
  samples: { misses: Miss[]; falsePositives: FalsePositive[] };
}

/** True when the pred's type is the gold type or one of its accepted alts. */
function typeMatches(gold: GoldSpan, pred: DetectedEntity): boolean {
  return pred.type === gold.type || (gold.alt?.includes(pred.type) ?? false);
}

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
}

const MAX_SAMPLES = 5;

/** Score one group of docs (one language, or the whole corpus) for a provider. */
export function scoreDocs(docs: CorpusDoc[], raw: Map<string, RawResult>): LangScore {
  const lenient = new Tally();
  const strict = new Tally();
  const typeAware = new Tally();
  const precision = new Tally();
  const byType = new CategoryTally();
  const latencies: number[] = [];
  const misses: Miss[] = [];
  const falsePositives: FalsePositive[] = [];
  let predictions = 0;

  for (const doc of docs) {
    const entry = raw.get(doc.id);
    if (!entry) throw new Error(`missing raw predictions for ${doc.id}`);
    const preds = entry.preds;
    predictions += preds.length;
    latencies.push(entry.ms);

    for (const g of doc.gold) {
      const overlapping = preds.filter((p) => overlaps(g, p));
      const cov = coverage(g, preds);
      const isLenient = overlapping.length > 0;
      const isStrict = cov >= STRICT_COVERAGE;
      const isTypeAware = isStrict && overlapping.some((p) => typeMatches(g, p));
      lenient.add(isLenient);
      strict.add(isStrict);
      typeAware.add(isTypeAware);
      byType.add(g.type, isStrict);
      if (!isStrict && misses.length < MAX_SAMPLES) {
        misses.push({ docId: doc.id, text: g.text, type: g.type, coverage: Number(cov.toFixed(3)) });
      }
    }

    for (const p of preds) {
      const hit = doc.gold.some((g) => overlaps(g, p));
      precision.add(hit);
      if (!hit && falsePositives.length < MAX_SAMPLES) {
        falsePositives.push({ docId: doc.id, text: p.value, predType: p.type, confidence: Number(p.confidence.toFixed(3)) });
      }
    }
  }

  const meanMs = latencies.length === 0 ? 0 : latencies.reduce((a, b) => a + b, 0) / latencies.length;
  return {
    docs: docs.length,
    goldSpans: strict.total,
    predictions,
    recallStrict: strict.ratio,
    recallLenient: lenient.ratio,
    typeAwareStrict: typeAware.ratio,
    precision: precision.ratio,
    f1: f1(precision.ratio, strict.ratio),
    byType: byType.toJSON(),
    latency: { meanMs: Math.round(meanMs), p95Ms: Math.round(p95(latencies)) },
    samples: { misses, falsePositives },
  };
}

// ── Reporting ───────────────────────────────────────────────

function printProviderTable(providerId: ProviderId, langs: string[], perLang: Record<string, LangScore>, overall: LangScore): void {
  const header = ['lang', 'gold', 'strict', 'lenient', 'type', 'prec', 'f1', 'mean ms'];
  console.log(`\n  -- ${providerId} --`);
  console.log('  ' + header.map((h, i) => (i === 0 ? h.padEnd(6) : h.padStart(8))).join(''));
  const row = (name: string, s: LangScore) =>
    console.log('  ' + name.padEnd(6)
      + String(s.goldSpans).padStart(8)
      + pct(s.recallStrict).padStart(8)
      + pct(s.recallLenient).padStart(8)
      + pct(s.typeAwareStrict).padStart(8)
      + pct(s.precision).padStart(8)
      + pct(s.f1).padStart(8)
      + String(s.latency.meanMs).padStart(8));
  for (const lang of langs) row(lang, perLang[lang]);
  row('ALL', overall);
}

// ── Main ────────────────────────────────────────────────────

async function main(): Promise<void> {
  const providerArg = argValue('provider') ?? 'all';
  const langArg = argValue('lang') ?? 'all';
  const limitArg = argValue('limit');
  const limit = limitArg ? parseInt(limitArg, 10) : undefined;

  const providers: ProviderId[] = providerArg === 'all' ? ALL_PROVIDERS : [providerArg as ProviderId];
  for (const p of providers) if (!ALL_PROVIDERS.includes(p)) throw new Error(`Unknown provider: ${p}`);
  const langs = langArg === 'all' ? undefined : langArg.split(',').map((l) => l.trim()).filter(Boolean);
  if (langs) for (const l of langs) if (!(ALL_LANGS as string[]).includes(l)) throw new Error(`Unknown lang: ${l}`);

  let docs = await loadCorpus(langs);
  if (docs.length === 0) throw new Error('No corpus docs available for the requested languages');
  if (limit !== undefined) {
    const perLangCount = new Map<string, number>();
    docs = docs.filter((d) => {
      const n = (perLangCount.get(d.lang) ?? 0) + 1;
      perLangCount.set(d.lang, n);
      return n <= limit;
    });
  }

  // Gold invariants must hold before any inference is cached against them.
  const validationErrors = docs.flatMap(validateDoc);
  if (validationErrors.length > 0) {
    console.error('Corpus validation failed:');
    for (const e of validationErrors) console.error('  ' + e);
    process.exit(1);
  }

  const presentLangs = [...new Set(docs.map((d) => d.lang))];
  console.log(`Corpus: ${docs.length} docs across ${presentLangs.length} languages (${presentLangs.join(', ')})`);

  installNodeBlobUrlShim();
  const env = createNodeEvalEnv();
  mkdirSync(RESULTS, { recursive: true });
  const runStamp = new Date().toISOString().slice(0, 10);

  const summary: Record<string, { overall: object; languages: Record<string, object> }> = {};

  for (const providerId of providers) {
    console.log(`\n== Provider: ${providerId} ==`);
    const { raw, modelName, threshold } = await rawPredictions(providerId, docs, env);

    const perLang: Record<string, LangScore> = {};
    for (const lang of presentLangs) {
      perLang[lang] = scoreDocs(docs.filter((d) => d.lang === lang), raw);
    }
    const overall = scoreDocs(docs, raw);

    const outFile = join(RESULTS, `multilang-${providerId}.json`);
    writeFileSync(outFile, JSON.stringify({
      provider: providerId,
      meta: { model: modelName, threshold, generated: runStamp, limit: limit ?? null, langs: presentLangs },
      overall,
      languages: perLang,
    }, null, 2) + '\n');

    printProviderTable(providerId, presentLangs, perLang, overall);
    console.log(`  results written to ${outFile}`);

    const summarize = (s: LangScore) => ({
      goldSpans: s.goldSpans,
      recallStrict: s.recallStrict,
      recallLenient: s.recallLenient,
      typeAwareStrict: s.typeAwareStrict,
      precision: s.precision,
      f1: s.f1,
      meanMs: s.latency.meanMs,
    });
    summary[providerId] = {
      overall: summarize(overall),
      languages: Object.fromEntries(presentLangs.map((l) => [l, summarize(perLang[l])])),
    };
  }

  const summaryFile = join(RESULTS, 'multilang-summary.json');
  writeFileSync(summaryFile, JSON.stringify({ generated: runStamp, limit: limit ?? null, providers: summary }, null, 2) + '\n');
  console.log(`\nSummary written to ${summaryFile}`);

  // Release is done per provider; exit explicitly (ONNX keeps the loop alive).
  process.exit(0);
}

// Gate the run behind a direct-invocation check so importing this module
// (e.g. for a syntax/type check) is side-effect free.
if (process.argv[1] && process.argv[1].endsWith('multilang.mts')) {
  await main();
}
