/**
 * @doccloak/core/pdf - content stream serializer (T206).
 *
 * Writes operators back to bytes. Operators that still carry their source
 * range are copied verbatim from the original stream (so nothing we did not
 * touch changes by even a byte); synthesized or edited operators are emitted
 * from their operands. New strings are always written as hex strings, which
 * is binary-safe for every font encoding.
 */

import type { ContentOp, Operand } from './lexer.ts';

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (Number.isInteger(value)) return Math.abs(value) < 1e21 ? String(value) : BigInt(value).toString();
  // Shortest round-trip form keeps the source precision; PDF has no exponent syntax.
  let s = String(value);
  if (/e/i.test(s) || (s.split('.')[1]?.length ?? 0) > 5) s = value.toFixed(5);
  s = s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  if (s === '-0' || s === '') s = '0';
  return s;
}

function escapeName(value: string): string {
  let out = '/';
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    const ch = value[i];
    if (c < 0x21 || c > 0x7e || '()<>[]{}/%#'.includes(ch)) {
      out += '#' + c.toString(16).padStart(2, '0').toUpperCase();
    } else {
      out += ch;
    }
  }
  return out;
}

export function hexOf(bytes: Uint8Array): string {
  let s = '<';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0').toUpperCase();
  return s + '>';
}

export function serializeOperand(operand: Operand): string {
  switch (operand.kind) {
    case 'number': return formatNumber(operand.value);
    case 'name': return escapeName(operand.value);
    case 'string': return hexOf(operand.bytes);
    case 'bool': return operand.value ? 'true' : 'false';
    case 'null': return 'null';
    case 'array': return '[' + operand.items.map(serializeOperand).join(' ') + ']';
    case 'dict': {
      const parts: string[] = [];
      for (const [k, v] of operand.entries) parts.push(escapeName(k) + ' ' + serializeOperand(v));
      return '<<' + parts.join(' ') + '>>';
    }
  }
}

/** Serialize one operator from its operands (ignores the source range). */
export function serializeOp(op: ContentOp): string {
  if (op.op === 'BI' || op.op === '') {
    return op.raw ? latin1Of(op.raw) : '';
  }
  const parts = op.operands.map(serializeOperand);
  parts.push(op.op);
  return parts.join(' ');
}

function latin1Of(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/**
 * Serialize a whole operator list. `source` is the original stream: an op
 * whose [start, end) range is present is copied from it byte-for-byte.
 */
export function serializeOps(ops: readonly ContentOp[], source?: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const push = (u: Uint8Array): void => { chunks.push(u); total += u.length; };
  const NL = Uint8Array.of(0x0a);
  for (const op of ops) {
    if (source && op.start !== undefined && op.end !== undefined) {
      push(source.subarray(op.start, op.end));
    } else {
      push(latin1Bytes(serializeOp(op)));
    }
    push(NL);
  }
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

export function latin1Bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}
