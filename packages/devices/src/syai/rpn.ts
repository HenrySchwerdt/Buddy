/**
 * TypeScript port of SyaiRPNEvaluator.swift and SyaiGlucoseDecoder.swift from SyaiKit (MIT,
 * © 2026 Nightscout Foundation): the vendor's reverse-Polish glucose program over the raw
 * channels V0..V2 and the sensor's 14 calibration coefficients C0..C13.
 */
import { MMOL_TO_MGDL } from './constants';
import { roundHalfAway } from './bytes';

export class RpnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RpnError';
  }
}

type Env = Readonly<Record<string, number>>;

const BINARY: Readonly<Record<string, (a: number, b: number) => number>> = {
  ad: (a, b) => a + b,
  ml: (a, b) => a * b,
  dv: (a, b) => (b === 0 ? 0 : a / b),
  sb: (a, b) => a - b,
  pw: (a, b) => a ** b,
};

function pop(stack: number[], op: string): number {
  const v = stack.pop();
  if (v === undefined) throw new RpnError(`RPN: stack underflow at '${op}'`);
  return v;
}

export function evaluateStatement(statement: string, env: Env): number {
  const tokens = statement.split(' ').filter((t) => t !== '');
  if (tokens.length === 0) throw new RpnError('RPN: empty statement');
  const stack: number[] = [];
  for (const token of tokens) {
    const binary = BINARY[token];
    if (token === 'le' || token === 'gt') {
      // `a b c op` -> (a <op> b) ? c : 0; three operands, not two.
      const c = pop(stack, token);
      const b = pop(stack, token);
      const a = pop(stack, token);
      stack.push((token === 'le' ? a <= b : a > b) ? c : 0);
    } else if (binary) {
      const b = pop(stack, token);
      const a = pop(stack, token);
      stack.push(binary(a, b));
    } else if (token === 'rd') {
      const digits = pop(stack, token);
      const value = pop(stack, token);
      const scale = 10 ** digits;
      stack.push(roundHalfAway(value * scale) / scale);
    } else if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(token)) {
      stack.push(Number(token));
    } else if (env[token] !== undefined) {
      stack.push(env[token]!);
    } else if (/^[RVC]/.test(token)) {
      throw new RpnError(`RPN: reference to unset register '${token}'`);
    } else {
      throw new RpnError(`RPN: unknown token '${token}'`);
    }
  }
  const first = stack[0];
  if (first === undefined) throw new RpnError('RPN: empty statement');
  return first;
}

/** Statements run in order; statement i's result is register R{i}; the last result wins. */
export function evaluateProgram(program: string, environment: Env): number {
  const statements = program.split(';').map((s) => s.trim()).filter((s) => s !== '');
  if (statements.length === 0) throw new RpnError('RPN: empty statement');
  const env: Record<string, number> = { ...environment };
  let last = 0;
  statements.forEach((statement, i) => {
    last = evaluateStatement(statement, env);
    env[`R${i}`] = last;
  });
  return last;
}

export const GLUCOSE_PROGRAM =
  'V1 C0 ad C1 ml C2 ad;' +
  'V0 R0 2 pw dv;' +
  'C3 0 ml C4 R1 2 pw ml ad C5 R1 ml ad C6 ad;' +
  'C7 R2 2 pw ml C8 R2 ml ad C9 ad;' +
  'C10 V2 86400 dv C11 ml sb V2 C12 1 le ml V2 C12 1 gt C13 ml ad;' +
  `R3 R4 ml 1 rd ${MMOL_TO_MGDL} ml 0 rd`;

export const MIN_DISPLAYABLE_MGDL = 36;
export const MAX_DISPLAYABLE_MGDL = 450;
export const COEFFICIENT_COUNT = 14;

export type RangeCondition = 'belowRange' | 'aboveRange';

export interface GlucoseOutput {
  /** Whole mg/dL straight from the program, unclamped. */
  readonly rawGlucoseMgDL: number;
  /** Clamped to 36...450. */
  readonly adjustedGlucoseMgDL: number;
  readonly condition: RangeCondition | null;
}

export class DecodeError extends Error {
  constructor(
    readonly reason: 'nonFinite' | 'wrongCoefficientCount',
    message: string,
  ) {
    super(message);
    this.name = 'DecodeError';
  }
}

export function decodeGlucose(raw: { readonly v0: number; readonly v1: number; readonly v2: number }, coefficients: readonly number[]): GlucoseOutput {
  if (coefficients.length !== COEFFICIENT_COUNT) {
    throw new DecodeError('wrongCoefficientCount', `calibration has ${coefficients.length} coefficients, expected ${COEFFICIENT_COUNT}`);
  }
  const env: Record<string, number> = { V0: raw.v0, V1: raw.v1, V2: raw.v2 };
  coefficients.forEach((c, i) => {
    env[`C${i}`] = c;
  });
  const rawGlucose = evaluateProgram(GLUCOSE_PROGRAM, env);
  // NaN fails both clamps below and would pass as an ordinary in-range reading.
  if (!Number.isFinite(rawGlucose)) throw new DecodeError('nonFinite', 'glucose decode produced a non-finite value');
  if (rawGlucose <= MIN_DISPLAYABLE_MGDL) return { rawGlucoseMgDL: rawGlucose, adjustedGlucoseMgDL: MIN_DISPLAYABLE_MGDL, condition: 'belowRange' };
  if (rawGlucose >= MAX_DISPLAYABLE_MGDL) return { rawGlucoseMgDL: rawGlucose, adjustedGlucoseMgDL: MAX_DISPLAYABLE_MGDL, condition: 'aboveRange' };
  return { rawGlucoseMgDL: rawGlucose, adjustedGlucoseMgDL: rawGlucose, condition: null };
}
