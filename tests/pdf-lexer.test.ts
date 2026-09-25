import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';
import { lexContent, parsePdfNumber, latin1 } from '../src/pdf/lexer.ts';
import type { ContentOp, Operand } from '../src/pdf/lexer.ts';
import { serializeOps, serializeOp, formatNumber } from '../src/pdf/serializer.ts';
import { decodeStream, pageContentStreams } from '../src/pdf/objects.ts';

const FIXTURES = join(__dirname, 'fixtures', 'pdf');

function bytes(text: string): Uint8Array {
  return Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);
}

function plain(op: ContentOp): unknown {
  return { op: op.op, operands: op.operands.map(plainOperand), raw: op.raw ? latin1(op.raw) : undefined };
}
function plainOperand(o: Operand): unknown {
  switch (o.kind) {
    case 'number': return { n: Math.round(o.value * 1e5) / 1e5 };
    case 'name': return { name: o.value };
    case 'string': return { s: latin1(o.bytes) };
    case 'array': return { a: o.items.map(plainOperand) };
    case 'dict': return { d: Object.fromEntries([...o.entries].map(([k, v]) => [k, plainOperand(v)])) };
    case 'bool': return { b: o.value };
    case 'null': return null;
  }
}

describe('pdf content lexer', () => {
  it('parses numbers, names, strings, arrays and dicts into operators', () => {
    const src = bytes('BT /F1 12 Tf 1 0 0 1 72 700 Tm (Hello \\(World\\)\\n) Tj [<0048> -20.5 (i)] TJ /Span <</ActualText (Jan)>> BDC ET');
    const ops = lexContent(src);
    expect(ops.map((o) => o.op)).toEqual(['BT', 'Tf', 'Tm', 'Tj', 'TJ', 'BDC', 'ET']);
    expect(plain(ops[1])).toEqual({ op: 'Tf', operands: [{ name: 'F1' }, { n: 12 }], raw: undefined });
    expect(plain(ops[3])).toEqual({ op: 'Tj', operands: [{ s: 'Hello (World)\n' }], raw: undefined });
    expect(plain(ops[4])).toEqual({ op: 'TJ', operands: [{ a: [{ s: '\x00H' }, { n: -20.5 }, { s: 'i' }] }], raw: undefined });
    expect(plain(ops[5])).toEqual({ op: 'BDC', operands: [{ name: 'Span' }, { d: { ActualText: { s: 'Jan' } } }], raw: undefined });
    // Source ranges cover the operands and the operator
    expect(latin1(src.subarray(ops[3].start!, ops[3].end!))).toBe('(Hello \\(World\\)\\n) Tj');
  });

  it('handles escapes, octal, nested parentheses, hex whitespace and #-names', () => {
    const ops = lexContent(bytes('(a\\101\\12(b)c) Tj <41 4 2> Tj /A#20B gs'));
    expect(plain(ops[0])).toEqual({ op: 'Tj', operands: [{ s: 'aA\n(b)c' }], raw: undefined });
    expect(plain(ops[1])).toEqual({ op: 'Tj', operands: [{ s: 'AB' }], raw: undefined });
    expect(plain(ops[2])).toEqual({ op: 'gs', operands: [{ name: 'A B' }], raw: undefined });
  });

  it('keeps inline images as one opaque operator (unfiltered length computed, EI inside data tolerated)', () => {
    const data = '\x00EI \xff\x80\x7f'; // 2x2 gray 8bpc = 4 bytes... make it 8 bytes for W=4,H=2
    const src = bytes(`q 10 0 0 10 0 0 cm BI /W 4 /H 2 /CS /G /BPC 8 ID ${data} EI Q BT (x) Tj ET`);
    const ops = lexContent(src);
    expect(ops.map((o) => o.op)).toEqual(['q', 'cm', 'BI', 'Q', 'BT', 'Tj', 'ET']);
    expect(latin1(ops[2].raw!)).toBe(`BI /W 4 /H 2 /CS /G /BPC 8 ID ${data} EI`);
  });

  it('keeps filtered inline images by searching the EI delimiter', () => {
    const src = bytes('BI /W 2 /H 2 /F /AHx ID 00ff80EI> EI Q');
    const ops = lexContent(src);
    expect(ops.map((o) => o.op)).toEqual(['BI', 'Q']);
  });

  it('marks unparsable bytes as an empty operator instead of dropping them', () => {
    const ops = lexContent(bytes('BT (open Tj ET'));
    // The literal string never closes: everything after '(' is one string operand with no operator.
    expect(ops[0].op).toBe('BT');
    expect(ops[1].op).toBe('');
    expect(ops[1].raw).toBeDefined();
    const ops2 = lexContent(bytes('1 2 ] Tj'));
    expect(ops2[0].op).toBe('');
  });

  it('parses PDF numbers the way viewers do', () => {
    expect(parsePdfNumber('-.5')).toBe(-0.5);
    expect(parsePdfNumber('5.')).toBe(5);
    expect(parsePdfNumber('--5')).toBe(-5); // pdf.js and Acrobat: any '-' negates
    expect(parsePdfNumber('3.4.5')).toBe(3.45);
    expect(parsePdfNumber('abc')).toBeNull();
    expect(formatNumber(0.1 + 0.2)).toBe('0.3');
    expect(formatNumber(-0.00001)).toBe('-0.00001');
    expect(formatNumber(1e-7)).toBe('0');
    expect(formatNumber(299.11719)).toBe('299.11719');
    expect(formatNumber(12)).toBe('12');
  });

  it('serializes synthesized operators with hex strings and re-lexes to the same operands', () => {
    const src = bytes('[(A) -12 (B)] TJ /F1 9.5 Tf');
    const ops = lexContent(src);
    const text = ops.map(serializeOp).join('\n');
    expect(text).toBe('[<41> -12 <42>] TJ\n/F1 9.5 Tf');
    expect(lexContent(bytes(text)).map(plain)).toEqual(ops.map(plain));
  });

  it('copies untouched operators verbatim from the source', () => {
    const src = bytes('q\n1 0 0 1 10 10 cm\n(x)Tj\nQ');
    const ops = lexContent(src);
    const out = latin1(serializeOps(ops, src));
    expect(out).toBe('q\n1 0 0 1 10 10 cm\n(x)Tj\nQ\n');
  });
});

describe('pdf content lexer on fixture files', () => {
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.pdf'));
  for (const file of files) {
    it(`round-trips every content stream of ${file}`, async () => {
      const doc = await PDFDocument.load(readFileSync(join(FIXTURES, file)), { updateMetadata: false, ignoreEncryption: true });
      let streams = 0;
      for (const page of doc.getPages()) {
        for (const { stream } of pageContentStreams(doc.context, page.node)) {
          const src = decodeStream(doc.context, stream);
          const ops = lexContent(src);
          expect(ops.some((o) => o.op === '')).toBe(false);
          // verbatim copy re-lexes identically
          const copied = lexContent(serializeOps(ops, src));
          expect(copied.map(plain)).toEqual(ops.map(plain));
          // full re-serialization re-lexes identically
          const rewritten = lexContent(serializeOps(ops));
          expect(rewritten.map(plain)).toEqual(ops.map(plain));
          streams++;
        }
      }
      expect(streams).toBeGreaterThan(0);
    });
  }
});
