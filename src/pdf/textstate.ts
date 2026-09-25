/**
 * @doccloak/core/pdf - graphics/text state machine (T210).
 *
 * Tracks the subset of the graphics state that positions glyphs (ISO 32000-1
 * 8.4, 9.3, 9.4): CTM, text state parameters, text matrix and line matrix,
 * fill colour (to spot white-on-white text), and the q/Q stack. The same
 * class is used by the extractor (to compute glyph origins) and by the
 * surgery (to know the state at any operator).
 */

import type { ContentOp, Operand } from './lexer.ts';
import type { Matrix } from './types.ts';
import type { LoadedFont } from './fonts.ts';

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** a × b in PDF row-vector convention: apply a first, then b. */
export function mul(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

export function translate(tx: number, ty: number): Matrix {
  return [1, 0, 0, 1, tx, ty];
}

export function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function invert(m: Matrix): Matrix | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  const e = -(m[4] * a + m[5] * c);
  const f = -(m[4] * b + m[5] * d);
  return [a, b, c, d, e, f];
}

export function matrixFromOperands(ops: Operand[]): Matrix | null {
  if (ops.length < 6) return null;
  const n: number[] = [];
  for (let i = ops.length - 6; i < ops.length; i++) {
    const o = ops[i];
    if (o.kind !== 'number' || !Number.isFinite(o.value)) return null;
    n.push(o.value);
  }
  return [n[0], n[1], n[2], n[3], n[4], n[5]];
}

export interface TextState {
  font: LoadedFont | null;
  fontName: string;
  fontSize: number;
  charSpacing: number;
  wordSpacing: number;
  /** Tz / 100 */
  hscale: number;
  leading: number;
  rise: number;
  renderMode: number;
}

export interface GraphicsState {
  ctm: Matrix;
  text: TextState;
  /** Approximate fill luminance 0..1, or null when unknown (patterns, ICC spaces). */
  fillLuminance: number | null;
  /** Stroke luminance, for render modes that only stroke. */
  strokeLuminance: number | null;
}

function cloneState(s: GraphicsState): GraphicsState {
  return { ctm: s.ctm, text: { ...s.text }, fillLuminance: s.fillLuminance, strokeLuminance: s.strokeLuminance };
}

export function initialState(ctm: Matrix = IDENTITY): GraphicsState {
  return {
    ctm,
    text: { font: null, fontName: '', fontSize: 0, charSpacing: 0, wordSpacing: 0, hscale: 1, leading: 0, rise: 0, renderMode: 0 },
    fillLuminance: 0,
    strokeLuminance: 0,
  };
}

function num(o: Operand | undefined, fallback = 0): number {
  return o && o.kind === 'number' && Number.isFinite(o.value) ? o.value : fallback;
}

function luminanceOf(values: number[], space: 'gray' | 'rgb' | 'cmyk'): number | null {
  if (space === 'gray' && values.length >= 1) return clamp01(values[0]);
  if (space === 'rgb' && values.length >= 3) return clamp01(0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2]);
  if (space === 'cmyk' && values.length >= 4) {
    const k = values[3];
    const r = (1 - values[0]) * (1 - k);
    const g = (1 - values[1]) * (1 - k);
    const b = (1 - values[2]) * (1 - k);
    return clamp01(0.2126 * r + 0.7152 * g + 0.0722 * b);
  }
  return null;
}
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Walks operators and keeps the state current. Text-showing operators are
 * NOT advanced here (the caller computes glyph advances, since they depend
 * on the font); call `advanceText(tx)` after showing.
 */
export class StateMachine {
  state: GraphicsState;
  private stack: GraphicsState[] = [];
  /** Text matrix and line matrix; only meaningful inside BT..ET. */
  tm: Matrix = IDENTITY;
  tlm: Matrix = IDENTITY;
  inText = false;
  /** Fill colour space family for sc/scn interpretation. */
  private fillSpace: 'gray' | 'rgb' | 'cmyk' | null = 'gray';
  private strokeSpace: 'gray' | 'rgb' | 'cmyk' | null = 'gray';
  /** Nesting depth of q without Q (for diagnostics). */
  get depth(): number {
    return this.stack.length;
  }

  constructor(initial: GraphicsState) {
    this.state = initial;
  }

  /**
   * Apply one operator's effect on the state. `resolveFont` maps a resource
   * name to a LoadedFont (undefined when unknown). Returns false when the
   * operator is a text-showing operator (caller handles it).
   */
  update(op: ContentOp, resolveFont: (name: string) => LoadedFont | undefined): void {
    const s = this.state;
    const o = op.operands;
    switch (op.op) {
      case 'q':
        this.stack.push(cloneState(s));
        if (this.stack.length > 256) this.stack.shift();
        break;
      case 'Q': {
        const prev = this.stack.pop();
        if (prev) this.state = prev;
        break;
      }
      case 'cm': {
        const m = matrixFromOperands(o);
        if (m) s.ctm = mul(m, s.ctm);
        break;
      }
      case 'BT':
        this.tm = IDENTITY;
        this.tlm = IDENTITY;
        this.inText = true;
        break;
      case 'ET':
        this.inText = false;
        break;
      case 'Tc': s.text.charSpacing = num(o[0]); break;
      case 'Tw': s.text.wordSpacing = num(o[0]); break;
      case 'Tz': s.text.hscale = num(o[0], 100) / 100; break;
      case 'TL': s.text.leading = num(o[0]); break;
      case 'Ts': s.text.rise = num(o[0]); break;
      case 'Tr': s.text.renderMode = Math.trunc(num(o[0])); break;
      case 'Tf': {
        const nameOp = o[0];
        s.text.fontName = nameOp && nameOp.kind === 'name' ? nameOp.value : '';
        s.text.fontSize = num(o[1]);
        s.text.font = s.text.fontName ? resolveFont(s.text.fontName) ?? null : null;
        break;
      }
      case 'Td': {
        this.tlm = mul(translate(num(o[0]), num(o[1])), this.tlm);
        this.tm = this.tlm;
        break;
      }
      case 'TD': {
        s.text.leading = -num(o[1]);
        this.tlm = mul(translate(num(o[0]), num(o[1])), this.tlm);
        this.tm = this.tlm;
        break;
      }
      case 'Tm': {
        const m = matrixFromOperands(o);
        if (m) {
          this.tlm = m;
          this.tm = m;
        }
        break;
      }
      case 'T*':
        this.nextLine();
        break;
      case "'":
        this.nextLine();
        break;
      case '"':
        s.text.wordSpacing = num(o[0]);
        s.text.charSpacing = num(o[1]);
        this.nextLine();
        break;
      case 'g': s.fillLuminance = luminanceOf([num(o[0])], 'gray'); this.fillSpace = 'gray'; break;
      case 'G': s.strokeLuminance = luminanceOf([num(o[0])], 'gray'); this.strokeSpace = 'gray'; break;
      case 'rg': s.fillLuminance = luminanceOf(o.map((x) => num(x)), 'rgb'); this.fillSpace = 'rgb'; break;
      case 'RG': s.strokeLuminance = luminanceOf(o.map((x) => num(x)), 'rgb'); this.strokeSpace = 'rgb'; break;
      case 'k': s.fillLuminance = luminanceOf(o.map((x) => num(x)), 'cmyk'); this.fillSpace = 'cmyk'; break;
      case 'K': s.strokeLuminance = luminanceOf(o.map((x) => num(x)), 'cmyk'); this.strokeSpace = 'cmyk'; break;
      case 'cs': this.fillSpace = spaceFamily(o[0]); s.fillLuminance = this.fillSpace ? 0 : null; break;
      case 'CS': this.strokeSpace = spaceFamily(o[0]); s.strokeLuminance = this.strokeSpace ? 0 : null; break;
      case 'sc': case 'scn': {
        const nums = o.filter((x) => x.kind === 'number').map((x) => num(x));
        s.fillLuminance = this.fillSpace && nums.length === o.length ? luminanceOf(nums, this.fillSpace) : null;
        break;
      }
      case 'SC': case 'SCN': {
        const nums = o.filter((x) => x.kind === 'number').map((x) => num(x));
        s.strokeLuminance = this.strokeSpace && nums.length === o.length ? luminanceOf(nums, this.strokeSpace) : null;
        break;
      }
      default:
        break;
    }
  }

  nextLine(): void {
    this.tlm = mul(translate(0, -this.state.text.leading), this.tlm);
    this.tm = this.tlm;
  }

  /** Move the text matrix by an unscaled text-space advance (already includes Tfs, Tc, Tw, Th). */
  advanceText(tx: number): void {
    this.tm = mul(translate(tx, 0), this.tm);
  }

  /** Text rendering matrix for the current glyph: [Tfs*Th 0 0 Tfs 0 Ts] × Tm × CTM. */
  trm(): Matrix {
    const t = this.state.text;
    return mul(mul([t.fontSize * t.hscale, 0, 0, t.fontSize, 0, t.rise], this.tm), this.state.ctm);
  }
}

function spaceFamily(o: Operand | undefined): 'gray' | 'rgb' | 'cmyk' | null {
  if (!o || o.kind !== 'name') return null;
  switch (o.value) {
    case 'DeviceGray': case 'CalGray': case 'G': return 'gray';
    case 'DeviceRGB': case 'CalRGB': case 'RGB': return 'rgb';
    case 'DeviceCMYK': case 'CMYK': return 'cmyk';
    default: return null; // ICCBased / Indexed / Separation / Pattern: unknown luminance
  }
}

/**
 * Advance of one glyph in unscaled text space (9.4.4): ((w0 - adj/1000) * Tfs + Tc + Tw?) * Th.
 * `w0` in 1/1000 units; `adj` is the TJ number preceding the glyph (already applied by caller).
 */
export function glyphAdvance(t: TextState, w0: number, isSpaceCode: boolean): number {
  return ((w0 / 1000) * t.fontSize + t.charSpacing + (isSpaceCode ? t.wordSpacing : 0)) * t.hscale;
}

/** Displacement of a TJ adjustment number in unscaled text space: -adj/1000 * Tfs * Th. */
export function adjustmentAdvance(t: TextState, adj: number): number {
  return (-adj / 1000) * t.fontSize * t.hscale;
}
