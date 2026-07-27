// Rewrites relative .ts module specifiers to .js inside the emitted .d.ts
// files. tsc's rewriteRelativeImportExtensions option rewrites the JS output
// but (by design) leaves declaration output untouched, so without this step
// the published types would reference ./module.ts files that do not exist in
// the tarball.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIST = new URL('../dist', import.meta.url).pathname;

/** Matches relative specifiers ending in .ts inside from-clauses and import() types. */
const FROM_RE = /(from\s+)(["'])(\.\.?\/[^"']+)\.ts\2/g;
const IMPORT_RE = /(import\()(["'])(\.\.?\/[^"']+)\.ts\2(\))/g;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

let rewritten = 0;
for (const file of walk(DIST)) {
  const before = readFileSync(file, 'utf8');
  const after = before
    .replace(FROM_RE, (_, from, q, spec) => `${from}${q}${spec}.js${q}`)
    .replace(IMPORT_RE, (_, imp, q, spec, close) => `${imp}${q}${spec}.js${q}${close}`);
  if (after !== before) {
    writeFileSync(file, after);
    rewritten++;
  }
}
console.log(`fix-dts-extensions: rewrote specifiers in ${rewritten} declaration file(s)`);
