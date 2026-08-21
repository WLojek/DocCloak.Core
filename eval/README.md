# DocCloak benchmark harness (T113)

Reproducible evaluation of DocCloak's detection pipeline on two public,
peer-reviewed anonymization benchmarks:

- **TAB** (Text Anonymization Benchmark) - 127 annotated ECHR court
  judgments, test split of
  [NorskRegnesentral/text-anonymization-benchmark](https://github.com/NorskRegnesentral/text-anonymization-benchmark)
  (MIT license). Pilan et al., Computational Linguistics 48(4), 2022.
- **PUPA** (the PAPILLON benchmark) - 901 real user-to-LLM queries with
  human-marked PII units, from
  [Columbia-NLP/PUPA](https://huggingface.co/datasets/Columbia-NLP/PUPA)
  (MIT license). Li et al., arXiv:2410.17127.

The harness runs the **shipped pipeline unchanged**: each provider's
`detect()` at its product-default threshold, optionally combined with the
regex tier via `detectEntities()` (same overlap resolution, false-positive
filter and term propagation the app uses). It measures; it does not tune.

Results and the full methodology/limitations write-up:
`docs/research/2026-08-benchmark-tab-pupa.md` (repo root). The committed
`eval/results/*.json` files are the raw per-run outputs.

## Run it

```bash
cd DocCloak.Core
npm run bench:data                        # download datasets (~17 MB)
npm run bench -- --dataset all --tier all # everything (slow: ML inference)
npm run bench -- --dataset tab --tier regex          # fast smoke run
npm run bench -- --dataset pupa_new --tier gliner --limit 50
```

- `--dataset`: `tab | pupa_tnb | pupa_new | all`
- `--tier`: `regex | gliner | bardsai | gliner+regex | bardsai+regex | all`
- `--limit N`: evaluate only the first N documents (sanity checks)

Requires Node >= 22.6 (the harness runs the TypeScript sources via
`--experimental-strip-types`) and network on first run (datasets, the
GLiNER model ~46 MB, the BardS.ai model ~279 MB, tokenizers). Models are
verified against the pinned SHA-256 hashes from `src/providers/` and
cached in `eval/data/models/`.

The GLiNER tokenizer is loaded from the web app's
`@huggingface/transformers` install (`../DocCloak/node_modules`), because
`@doccloak/core` itself deliberately has no tokenizer dependency. Run
`npm install` in `DocCloak/` first if that folder is missing.

## Layout

| File | Purpose |
| --- | --- |
| `download.mjs` | Fetches the datasets into `eval/data/` (idempotent); licensing notes in the header |
| `node-env.mts` | `CoreEnv` for Node: disk model cache, fetch, tokenizer, blob-URL shim for ONNX Runtime's Node build |
| `metrics.mts` | Character-offset span matching, strict/lenient coverage, tallies |
| `tab.mts` | TAB loader, TAB-to-DocCloak schema mapping (documented in the header), scoring protocol |
| `pupa.mts` | PUPA loader (CSV), unit-level scoring, artifact exclusions (documented in the header) |
| `run.mts` | CLI runner; caches raw predictions in `eval/data/cache/*.jsonl` (resume-safe) |
| `results/` | Committed JSON outputs, one file per dataset x tier |

Interrupted ML runs resume from the prediction cache. Delete
`eval/data/cache/` to force re-inference after a pipeline change.

## Scoring in one paragraph

Everything is character-offset based. "Strict" recall means the full gold
span (TAB) or every occurrence of the gold PII unit (PUPA) is covered by
predicted spans - the bar that matters for anonymization, since a
half-masked name still leaks. "Lenient" means any overlap. TAB recall is
micro-averaged over (document, annotator) pairs and only counts mentions
the annotators said must be masked (DIRECT + QUASI); TAB precision is
measured against the union of all annotators' maskable mentions, with
"over-masking" (hit a real entity judged safe to keep) and "spurious" (hit
nothing annotated) broken out separately. The schema mapping and its
honesty caveats live in `tab.mts` and the results doc.
