// Registry of every synthetic fixture generator. Import the generators you
// need from './docx.ts', './xlsx.ts' or './doc.ts'; import ALL_FIXTURES when
// you want to sweep the whole corpus.

export * from './shared.ts';
export * from './docx.ts';
export * from './xlsx.ts';
export * from './doc.ts';

import { DOCX_FIXTURES } from './docx.ts';
import { XLSX_FIXTURES } from './xlsx.ts';
import { DOC_FIXTURES } from './doc.ts';
import type { FixtureSpec } from './shared.ts';

export const ALL_FIXTURES: readonly FixtureSpec[] = [...DOCX_FIXTURES, ...XLSX_FIXTURES, ...DOC_FIXTURES];
