// Toggles package.json entry points between the in-repo dev shape (TypeScript
// source, consumed by the web app and the extension through their
// file:../DocCloak.Core links) and the publish shape (built ESM + .d.ts in
// dist/). Wired into prepack/postpack so the committed package.json always
// keeps the src paths: only the packed tarball ever carries the dist paths.
//
// Usage: node scripts/package-exports.mjs <src|dist>
import { readFileSync, writeFileSync } from 'node:fs';

const MODE = process.argv[2];
if (MODE !== 'src' && MODE !== 'dist') {
  console.error('usage: node scripts/package-exports.mjs <src|dist>');
  process.exit(1);
}

const SHAPES = {
  src: {
    main: './src/index.ts',
    types: './src/index.ts',
    exports: {
      '.': './src/index.ts',
      './restore-tokens': './src/restore-tokens.ts',
      './dom': './src/dom/index.ts',
      './worker-protocol': './src/worker-protocol.ts',
    },
  },
  dist: {
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: {
      '.': { types: './dist/index.d.ts', default: './dist/index.js' },
      './restore-tokens': { types: './dist/restore-tokens.d.ts', default: './dist/restore-tokens.js' },
      './dom': { types: './dist/dom/index.d.ts', default: './dist/dom/index.js' },
      './worker-protocol': { types: './dist/worker-protocol.d.ts', default: './dist/worker-protocol.js' },
    },
  },
};

const PKG_PATH = new URL('../package.json', import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
const shape = SHAPES[MODE];
pkg.main = shape.main;
pkg.types = shape.types;
pkg.exports = shape.exports;
writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');
console.log(`package-exports: entry points set to ${MODE}`);
