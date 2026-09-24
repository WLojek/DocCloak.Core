/**
 * T183: five "LLM reply" templates. Each is a pure function of the
 * anonymised text in which every placeholder has already been swapped for
 * an opaque sentinel (see tests/session-e2e.test.ts), so a template can
 * cut sentences, reorder, quote or decorate prose without ever splitting
 * a placeholder. `reshape` says how this template's model mangles the
 * n-th placeholder occurrence (case, spacing: only within the tolerance of
 * restore-tokens.ts, and only for bracket tokens; surrogate keys are
 * natural text and restore exactly or not at all, so they are never
 * reshaped) and `wrap` how it decorates it (markdown bold).
 */
export type ReplyMode = 'labeled' | 'surrogate';

export interface ReplyTemplate {
  id: 'summary' | 'rewrite' | 'bullets' | 'quoted' | 'markdown';
  render(text: string): string;
  reshape(token: string, index: number, mode: ReplyMode): string;
  wrap(index: number): [string, string];
}

const NO_WRAP: [string, string] = ['', ''];

function paragraphs(text: string): string[] {
  return text.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0);
}

function sentences(paragraph: string): string[] {
  return paragraph
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Function-word swaps of a "translation-like" rewrite (word-bounded, lowercase prose only). */
const REWRITE_DICTIONARY: Array<[RegExp, string]> = [
  [/\band\b/g, 'as well as'],
  [/\bund\b/g, 'sowie'],
  [/\boraz\b/g, 'i także'],
  [/\bplease\b/gi, 'kindly'],
  [/\bbitte\b/gi, 'gerne'],
  [/\bproszę\b/gi, 'uprzejmie proszę'],
];

export const REPLY_TEMPLATES: ReplyTemplate[] = [
  {
    // First sentence of every paragraph, prose intact, placeholders intact.
    id: 'summary',
    render(text) {
      const firsts = paragraphs(text).map((p) => sentences(p)[0]);
      return `Summary:\n${firsts.join(' ')}\n\nThat covers the main points of the document.`;
    },
    reshape: (token) => token,
    wrap: () => NO_WRAP,
  },
  {
    // Sentences reversed within each paragraph, a few function words
    // swapped; every bracket token written in lowercase ("[person_1]").
    id: 'rewrite',
    render(text) {
      const out = paragraphs(text).map((p) => {
        let rewritten = sentences(p).reverse().join(' ');
        for (const [re, to] of REWRITE_DICTIONARY) rewritten = rewritten.replace(re, to);
        return rewritten;
      });
      return `Rewritten version:\n\n${out.join('\n\n')}`;
    },
    reshape: (token, _index, mode) => (mode === 'labeled' ? token.toLowerCase() : token),
    wrap: () => NO_WRAP,
  },
  {
    // One bullet per sentence; every other bracket token has its
    // underscores replaced by spaces ("[PERSON 1]", "[PERSON 1 LAST]").
    id: 'bullets',
    render(text) {
      const lines = paragraphs(text).flatMap((p) => sentences(p)).map((s) => `- ${s}`);
      return `Key points:\n${lines.join('\n')}`;
    },
    reshape: (token, index, mode) =>
      mode === 'labeled' && index % 2 === 1 ? token.replace(/_/g, ' ') : token,
    wrap: () => NO_WRAP,
  },
  {
    // The whole text quoted line by line, followed by a short answer.
    id: 'quoted',
    render(text) {
      const quoted = text.split('\n').map((line) => (line.length > 0 ? `> ${line}` : '>')).join('\n');
      return `${quoted}\n\nThanks, noted. I will get back to you on this.`;
    },
    reshape: (token) => token,
    wrap: () => NO_WRAP,
  },
  {
    // Markdown with a heading; every placeholder in bold, every third one
    // additionally lowercased inside the stars ("**[person_1]**").
    id: 'markdown',
    render(text) {
      const body = paragraphs(text).map((p) => sentences(p).join(' ')).join('\n\n');
      return `## Response\n\n${body}\n\n---\n*Generated reply*`;
    },
    reshape: (token, index, mode) => (mode === 'labeled' && index % 3 === 2 ? token.toLowerCase() : token),
    wrap: () => ['**', '**'],
  },
];
