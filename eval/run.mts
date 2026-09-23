/**
 * T113 benchmark runner: DocCloak detection vs TAB and PUPA.
 *
 * Usage (from DocCloak.Core/):
 *   npm run bench -- --dataset all --tier all
 *   npm run bench -- --dataset tab --tier regex
 *   npm run bench -- --dataset pupa_new --tier gliner --limit 50
 *
 * Datasets: tab | pupa_tnb | pupa_new | all       (see eval/download.mjs)
 * Tiers:    regex | gliner | gliner-base | bardsai | gliner+regex |
 *           gliner-base+regex | bardsai+regex | all
 *
 * Each tier reproduces exactly what the product does: the ML provider's
 * detect() output (product default threshold) and/or detectWithRegex(text,
 * 'all'), combined through detectEntities() - the same overlap resolution,
 * false-positive filter and term propagation the app applies. This harness
 * measures the shipped pipeline; it does not tune it.
 *
 * RAW detector outputs (per provider, before detectEntities) are cached in
 * eval/data/cache/<dataset>-raw-<detector>.jsonl. Tiers are composed from
 * the raw caches at evaluation time, so gliner and gliner+regex share one
 * inference pass, and an interrupted ML run resumes where it stopped.
 * Delete the cache to force re-inference.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DetectedEntity } from '../src/types.ts';
import { detectWithRegex, detectEntities } from '../src/pipeline.ts';
import { createNodeEvalEnv, installNodeBlobUrlShim } from './node-env.mts';
import { loadTab, evaluateTab } from './tab.mts';
import { loadPupa, evaluatePupa } from './pupa.mts';
import { pct } from './metrics.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, 'data');
const CACHE = join(DATA, 'cache');
const RESULTS = join(HERE, 'results');

type Detector = 'regex' | 'gliner' | 'gliner-base' | 'bardsai';
type Tier = 'regex' | 'gliner' | 'gliner-base' | 'bardsai' | 'gliner+regex' | 'gliner-base+regex' | 'bardsai+regex';
const ALL_TIERS: Tier[] = ['regex', 'gliner', 'gliner-base', 'bardsai', 'gliner+regex', 'gliner-base+regex', 'bardsai+regex'];
type DatasetId = 'tab' | 'pupa_tnb' | 'pupa_new';
const ALL_DATASETS: DatasetId[] = ['tab', 'pupa_tnb', 'pupa_new'];

/** ML detector a tier uses (null = rules only) + whether the regex tier is on. */
function tierParts(tier: Tier): { ml: Exclude<Detector, 'regex'> | null; regex: boolean } {
  return {
    ml: tier.startsWith('gliner-base') ? 'gliner-base'
      : tier.startsWith('gliner') ? 'gliner'
      : tier.startsWith('bardsai') ? 'bardsai'
      : null,
    regex: tier === 'regex' || tier.endsWith('+regex'),
  };
}

// ── CLI args ────────────────────────────────────────────────

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const datasetArg = argValue('dataset') ?? 'all';
const tierArg = argValue('tier') ?? 'all';
const limitArg = argValue('limit');
const limit = limitArg ? parseInt(limitArg, 10) : undefined;

const datasets: DatasetId[] = datasetArg === 'all' ? ALL_DATASETS : [datasetArg as DatasetId];
const tiers: Tier[] = tierArg === 'all' ? ALL_TIERS : [tierArg as Tier];
for (const d of datasets) if (!ALL_DATASETS.includes(d)) throw new Error(`Unknown dataset: ${d}`);
for (const t of tiers) if (!ALL_TIERS.includes(t)) throw new Error(`Unknown tier: ${t}`);

// ── Raw detectors ───────────────────────────────────────────

installNodeBlobUrlShim();
const env = createNodeEvalEnv();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const providers: Record<string, any> = {};

async function getProvider(id: 'gliner' | 'gliner-base' | 'bardsai') {
  if (!providers[id]) {
    const Ctor = id === 'gliner'
      ? (await import('../src/providers/gliner.ts')).GlinerProvider
      : id === 'gliner-base'
        ? (await import('../src/providers/gliner-base.ts')).GlinerBaseProvider
        : (await import('../src/providers/bardsai.ts')).BardsaiProvider;
    const p = new Ctor(env);
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
    console.log(`  [${id}] loading model (product default threshold ${p.getThreshold()})...`);
    await p.load();
    providers[id] = p;
  }
  return providers[id];
}

async function detectRaw(detector: Detector, text: string): Promise<DetectedEntity[]> {
  if (detector === 'regex') return detectWithRegex(text, 'all');
  return (await getProvider(detector)).detect(text);
}

// ── Raw prediction cache (resume-safe) ──────────────────────

function loadCache(file: string): Map<string, DetectedEntity[]> {
  const map = new Map<string, DetectedEntity[]>();
  if (!existsSync(file)) return map;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const { id, preds } = JSON.parse(line) as { id: string; preds: DetectedEntity[] };
    map.set(id, preds);
  }
  return map;
}

async function rawPredictions(
  detector: Detector,
  datasetId: DatasetId,
  docs: Array<{ id: string; text: string }>,
): Promise<Map<string, DetectedEntity[]>> {
  mkdirSync(CACHE, { recursive: true });
  const cacheFile = join(CACHE, `${datasetId}-raw-${detector}.jsonl`);
  const cached = loadCache(cacheFile);
  const pending = docs.filter((d) => !cached.has(d.id));
  if (pending.length > 0) {
    console.log(`  ${detector} on ${datasetId}: ${pending.length}/${docs.length} docs to run (${cached.size} cached)`);
    const t0 = Date.now();
    let done = 0;
    for (const doc of pending) {
      const preds = await detectRaw(detector, doc.text);
      cached.set(doc.id, preds);
      appendFileSync(cacheFile, JSON.stringify({ id: doc.id, preds }) + '\n');
      done++;
      if (done % 25 === 0 || done === pending.length) {
        const rate = (Date.now() - t0) / done;
        const etaMin = ((pending.length - done) * rate) / 60000;
        console.log(`  ${detector} on ${datasetId}: ${done}/${pending.length} (eta ${etaMin.toFixed(1)} min)`);
      }
    }
  } else {
    console.log(`  ${detector} on ${datasetId}: all ${docs.length} docs cached`);
  }
  return cached;
}

/** Compose a tier's product-pipeline output from the raw caches. */
function composeTier(
  tier: Tier,
  docs: Array<{ id: string; text: string }>,
  raw: Partial<Record<Detector, Map<string, DetectedEntity[]>>>,
): Map<string, DetectedEntity[]> {
  const { ml, regex } = tierParts(tier);
  const out = new Map<string, DetectedEntity[]>();
  for (const doc of docs) {
    const mlPreds = ml ? raw[ml]?.get(doc.id) ?? [] : [];
    const regexPreds = regex ? raw.regex?.get(doc.id) ?? [] : [];
    out.set(doc.id, detectEntities(doc.text, mlPreds, regexPreds));
  }
  return out;
}

// ── Reporting helpers ───────────────────────────────────────

function printCategoryTable(
  title: string,
  rows: Record<string, { hits: number; total: number; ratio: number }>,
): void {
  console.log(`  ${title}`);
  for (const [cat, t] of Object.entries(rows)) {
    console.log(`    ${cat.padEnd(10)} ${pct(t.ratio).padStart(7)}  (${t.hits}/${t.total})`);
  }
}

// ── Main ────────────────────────────────────────────────────

mkdirSync(RESULTS, { recursive: true });
const runStamp = new Date().toISOString().slice(0, 10);

const neededDetectors = [...new Set(tiers.flatMap((t) => {
  const { ml, regex } = tierParts(t);
  return [...(ml ? [ml] : []), ...(regex ? ['regex' as const] : [])];
}))];

for (const datasetId of datasets) {
  console.log(`\n== Dataset: ${datasetId} ==`);
  const isTab = datasetId === 'tab';
  const file = isTab ? join(DATA, 'tab_echr_test.json') : join(DATA, `${datasetId}.csv`);
  if (!existsSync(file)) throw new Error(`Missing ${file} - run: npm run bench:data`);
  const tabDocs = isTab ? loadTab(file, limit) : [];
  const pupaDocs = isTab ? [] : loadPupa(file, limit);
  const docs = isTab
    ? tabDocs.map((d) => ({ id: d.doc_id, text: d.text }))
    : pupaDocs.map((d) => ({ id: d.id, text: d.query }));

  const raw: Partial<Record<Detector, Map<string, DetectedEntity[]>>> = {};
  for (const detector of neededDetectors) {
    raw[detector] = await rawPredictions(detector, datasetId, docs);
  }

  for (const tier of tiers) {
    const preds = composeTier(tier, docs, raw);
    const outFile = join(RESULTS, `${datasetId}-${tier}.json`);
    if (isTab) {
      const result = evaluateTab(tabDocs, preds);
      writeFileSync(outFile, JSON.stringify({ tier, generated: runStamp, limit: limit ?? null, ...result }, null, 2) + '\n');
      console.log(`\n  -- TAB / ${tier} --   (${result.documents} docs, ${result.goldMentions} gold maskable mentions, ${result.predictions} predictions)`);
      printCategoryTable('Masking recall (strict, full span covered, any predicted type):', result.recall.maskingStrict);
      printCategoryTable('Type-aware recall (strict + mapped type):', result.recall.typeAwareStrict);
      printCategoryTable('Recall by identifier type:', result.recall.byIdentifierType);
      console.log(`    OVERALL masking recall  strict ${pct(result.recall.overallMaskingStrict)}  lenient ${pct(result.recall.overallMaskingLenient)}`);
      console.log(`    Masking precision ${pct(result.precision.masking)}  (over-masking ${pct(result.precision.overMaskingShare)}, spurious ${pct(result.precision.spuriousShare)})`);
      console.log(`    F1 (masking, strict) ${pct(result.f1MaskingStrict)}`);
    } else {
      const result = evaluatePupa(pupaDocs, preds, datasetId);
      writeFileSync(outFile, JSON.stringify({ tier, generated: runStamp, limit: limit ?? null, ...result }, null, 2) + '\n');
      console.log(`\n  -- ${datasetId} / ${tier} --   (${result.documents} queries, ${result.evaluatedUnits} evaluable gold units, ${result.predictions} predictions)`);
      console.log(`    excluded: ${result.excludedPresidioArtifacts} presidio artifacts, ${result.unlocatableUnits} unlocatable units`);
      console.log(`    Unit recall  strict ${pct(result.recall.unitStrict)}  lenient ${pct(result.recall.unitLenient)}`);
      console.log(`    Precision ${pct(result.precision.overall)}  (${result.precision.hits}/${result.precision.total})`);
      printCategoryTable('Precision by predicted type:', result.precision.byPredictedType);
      console.log(`    F1 (strict) ${pct(result.f1Strict)}`);
    }
    console.log(`  results written to ${outFile}`);
  }
}

// Release ONNX sessions so the process exits promptly.
for (const p of Object.values(providers)) p.release();
process.exit(0);
