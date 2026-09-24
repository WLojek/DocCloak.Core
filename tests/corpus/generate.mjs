#!/usr/bin/env node
// Real-file corpus generator (T196).
//
// For every seed in tests/corpus/seeds/ (a <seed>.fodt, .fods or .html plus
// a <seed>.json manifest) this runs LibreOffice headless and writes
// tests/corpus/generated/<fmt>/<seed>.<fmt> for each format the manifest
// lists (docx and doc from fodt/html, xlsx from fods). The generated folder
// is gitignored; tests/corpus.test.ts picks the files up automatically.
//
// Without LibreOffice on PATH (or in the usual install locations) the script
// prints a notice and exits 0, so `npm test` still works on a machine
// without an office suite (the corpus suite then skips with a reason).
//
// Usage:
//   node tests/corpus/generate.mjs              # convert what is stale
//   node tests/corpus/generate.mjs --force      # convert everything again
//   node tests/corpus/generate.mjs --only pl-cv # one seed
//   node tests/corpus/generate.mjs --format doc # one output format
//   node tests/corpus/generate.mjs --needles    # print every manifest needle
//                                               # (one per line, no soffice)
//   SOFFICE=/path/to/soffice node tests/corpus/generate.mjs

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORPUS_DIR = dirname(fileURLToPath(import.meta.url));
const SEEDS_DIR = join(CORPUS_DIR, 'seeds');
const GENERATED_DIR = join(CORPUS_DIR, 'generated');

// Explicit export filter names: without them LibreOffice picks the filter
// from the extension, which fails for HTML input (Writer/Web has no docx
// export) unless the input filter is forced too.
const FILTERS = {
  docx: 'docx:MS Word 2007 XML',
  doc: 'doc:MS Word 97',
  xlsx: 'xlsx:Calc MS Excel 2007 XML',
};

const SOURCE_FORMATS = {
  '.fodt': ['docx', 'doc'],
  '.html': ['docx', 'doc'],
  '.fods': ['xlsx'],
};

function parseArgs(argv) {
  const opts = { force: false, only: null, format: null, needles: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--force') opts.force = true;
    else if (arg === '--needles') opts.needles = true;
    else if (arg === '--only') opts.only = argv[++i];
    else if (arg === '--format') opts.format = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: node tests/corpus/generate.mjs [--force] [--only <seed>] [--format docx|doc|xlsx] [--needles]');
      process.exit(0);
    } else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return opts;
}

function loadManifests() {
  if (!existsSync(SEEDS_DIR)) return [];
  return readdirSync(SEEDS_DIR)
    .filter((f) => extname(f) === '.json')
    .sort()
    .map((f) => ({ name: basename(f, '.json'), ...JSON.parse(readFileSync(join(SEEDS_DIR, f), 'utf8')) }));
}

function findSoffice() {
  if (process.env.SOFFICE) return process.env.SOFFICE;
  const candidates = [
    'soffice',
    'libreoffice',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    '/usr/bin/soffice',
    '/usr/lib/libreoffice/program/soffice',
    '/opt/libreoffice/program/soffice',
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
  ];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 60_000 });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

function isStale(target, source) {
  if (!existsSync(target)) return true;
  return statSync(target).mtimeMs < statSync(source).mtimeMs;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const manifests = loadManifests();

  if (opts.needles) {
    const seen = new Set();
    for (const m of manifests) for (const n of m.needles ?? []) seen.add(n);
    for (const n of seen) if (n.length > 0) console.log(n);
    return 0;
  }

  const soffice = findSoffice();
  if (!soffice) {
    console.log('corpus: LibreOffice (soffice) not found; skipping corpus generation.');
    console.log('corpus: install it (macOS: brew install --cask libreoffice; Debian/Ubuntu: apt-get install libreoffice-writer libreoffice-calc)');
    console.log('corpus: or set SOFFICE=/path/to/soffice. The corpus test suite skips when tests/corpus/generated is empty.');
    return 0;
  }
  const version = spawnSync(soffice, ['--version'], { encoding: 'utf8' }).stdout.trim();
  console.log(`corpus: using ${soffice} (${version})`);

  // A private profile keeps this run independent of any running LibreOffice
  // instance (no lock file races, no first-start dialogs).
  const profile = mkdtempSync(join(tmpdir(), 'doccloak-soffice-'));
  const profileUrl = `file://${profile.replace(/\\/g, '/')}`;

  let converted = 0;
  let skipped = 0;
  let failed = 0;
  try {
    for (const manifest of manifests) {
      if (opts.only && manifest.name !== opts.only) continue;
      const source = join(SEEDS_DIR, manifest.source ?? '');
      if (!manifest.source || !existsSync(source)) {
        console.error(`FAIL ${manifest.name}: manifest.source missing (${manifest.source ?? 'undefined'})`);
        failed++;
        continue;
      }
      const sourceExt = extname(source).toLowerCase();
      const allowed = SOURCE_FORMATS[sourceExt] ?? [];
      const formats = (manifest.formats ?? allowed).filter((f) => allowed.includes(f));
      for (const fmt of formats) {
        if (opts.format && fmt !== opts.format) continue;
        const outdir = join(GENERATED_DIR, fmt);
        mkdirSync(outdir, { recursive: true });
        const target = join(outdir, `${manifest.name}.${fmt}`);
        if (!opts.force && !isStale(target, source)) {
          skipped++;
          continue;
        }
        const args = ['--headless', '--norestore', '--nologo', '--nolockcheck', `-env:UserInstallation=${profileUrl}`];
        if (sourceExt === '.html') args.push('--infilter=HTML (StarWriter)');
        args.push('--convert-to', FILTERS[fmt], '--outdir', outdir, source);
        const run = spawnSync(soffice, args, { encoding: 'utf8', timeout: 180_000 });
        const produced = existsSync(target) && statSync(target).size > 0 && !isStale(target, source);
        if (run.error || run.status !== 0 || !produced) {
          failed++;
          console.error(`FAIL ${manifest.name} -> ${fmt} (exit ${run.status ?? run.error?.message})`);
          if (run.stdout) console.error(run.stdout.trim());
          if (run.stderr) console.error(run.stderr.trim());
          continue;
        }
        converted++;
        console.log(`ok   ${manifest.name}.${sourceExt.slice(1)} -> generated/${fmt}/${basename(target)} (${statSync(target).size} B)`);
      }
    }
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }

  console.log(`corpus: ${converted} converted, ${skipped} up to date, ${failed} failed`);
  return failed === 0 ? 0 : 1;
}

process.exit(main());
