// Registry of every synthetic fixture generator. Import the generators you
// need from './docx.ts', './xlsx.ts', './doc.ts' or './pdf.ts'; import
// ALL_FIXTURES when you want to sweep the whole Office corpus.

export * from './shared.ts';
export * from './docx.ts';
export * from './xlsx.ts';
export * from './doc.ts';
export * from './pdf.ts';

import { DOCX_FIXTURES } from './docx.ts';
import { XLSX_FIXTURES } from './xlsx.ts';
import { DOC_FIXTURES } from './doc.ts';
import { PDF_FIXTURES } from './pdf.ts';
import type { FixtureSpec } from './shared.ts';

/**
 * The Office (zip / CFB) fixtures. tests/helpers/fixtures.test.ts and
 * tests/corpus/inventory.test.ts sweep this list and expect every entry to be
 * a zip or CFB container, so the PDF fixtures (T214) are listed separately in
 * PDF_FIXTURES and swept by tests/pdf-fixtures.test.ts.
 */
export const ALL_FIXTURES: readonly FixtureSpec[] = [...DOCX_FIXTURES, ...XLSX_FIXTURES, ...DOC_FIXTURES];

/** Every fixture of every format, for callers that only need name / build / seeds. */
export const ALL_FIXTURES_WITH_PDF: readonly FixtureSpec[] = [...ALL_FIXTURES, ...PDF_FIXTURES];
