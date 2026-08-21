/**
 * T113: download the public benchmark datasets into eval/data/.
 *
 * Datasets and licenses:
 *
 * - TAB (Text Anonymization Benchmark), echr_test.json
 *   https://github.com/NorskRegnesentral/text-anonymization-benchmark
 *   License: MIT. 127 annotated ECHR court judgments (test split).
 *   Reference: Pilan et al., "The Text Anonymization Benchmark (TAB): A
 *   Dedicated Corpus and Evaluation Framework for Text Anonymization",
 *   Computational Linguistics 48(4), 2022.
 *
 * - PUPA (PAPILLON benchmark), PUPA_TNB.csv + PUPA_New.csv
 *   https://huggingface.co/datasets/Columbia-NLP/PUPA
 *   License: MIT. Real user-LLM queries with human-marked PII units.
 *   Reference: Li et al., "PAPILLON: Privacy Preservation from
 *   Internet-based and Local Language Model Ensembles" (arXiv:2410.17127).
 *
 * The files are NOT committed to the repo (13 MB+); this script fetches
 * them reproducibly. Idempotent: existing files are kept.
 */
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA = join(dirname(fileURLToPath(import.meta.url)), 'data');
mkdirSync(DATA, { recursive: true });

const FILES = [
  {
    name: 'tab_echr_test.json',
    url: 'https://raw.githubusercontent.com/NorskRegnesentral/text-anonymization-benchmark/master/echr_test.json',
  },
  {
    name: 'pupa_tnb.csv',
    url: 'https://huggingface.co/datasets/Columbia-NLP/PUPA/resolve/main/PUPA_TNB.csv',
  },
  {
    name: 'pupa_new.csv',
    url: 'https://huggingface.co/datasets/Columbia-NLP/PUPA/resolve/main/PUPA_New.csv',
  },
];

for (const { name, url } of FILES) {
  const dest = join(DATA, name);
  if (existsSync(dest)) {
    console.log(`kept     ${name} (already downloaded)`);
    continue;
  }
  console.log(`fetching ${name} from ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  console.log(`saved    ${name}`);
}
console.log('done');
