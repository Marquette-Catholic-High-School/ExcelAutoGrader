/**
 * Cell value comparison rules used by the autograder (docs/API.md, "Autograder rules").
 *
 * Values are SheetJS primitives read with cellDates=false, so dates arrive as serial numbers and compare
 * numerically. Error cells carry their display text ("#DIV/0!") with `isError` set.
 */
import type { CellFailReason, CellPrimitive, GradingConfig } from '../../../shared/types.js';
import { displayFormula, maskStringLiterals, volatileFunctions } from './formula.js';

/** How a number is displayed, when that changes what the numeric tolerance means. */
export type NumberUnit = 'percent' | 'time';

export interface ComparableCell {
  value: CellPrimitive;
  /** True when `value` is an error text such as "#DIV/0!". */
  isError?: boolean;
  /** Formula without the leading "=", when the cell has one. */
  formula?: string;
  /** Set for numbers formatted as a percentage or a time of day / duration. */
  unit?: NumberUnit;
}

export type CompareOptions = Pick<
  GradingConfig,
  'numericTolerance' | 'caseSensitive' | 'ignoreWhitespace' | 'requireFormulas'
>;

export interface CellVerdict {
  correct: boolean;
  reason?: CellFailReason;
}

/**
 * Relative slack that absorbs floating-point noise such as 0.1 + 0.2 !== 0.3 or the rounding of a long SUM, while
 * still telling apart real differences in large numbers (5551234567 vs 5551234570) when the tolerance is 0.
 */
const RELATIVE_EPSILON = 1e-12;

const SECONDS_PER_DAY = 86_400;

/** null, undefined, '' and whitespace-only strings are blank. */
export function isBlank(value: CellPrimitive | undefined): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

/**
 * Grades one cell. `key` is never blank in practice (only gradable cells are compared), except for
 * key formulas that evaluate to "" — those match an empty student cell.
 */
export function compareCell(key: ComparableCell, student: ComparableCell | undefined, opts: CompareOptions): CellVerdict {
  const studentEmpty = !student || (student.formula === undefined && !student.isError && isBlank(student.value));
  const keyBlank = !key.isError && isBlank(key.value);
  if (studentEmpty && !keyBlank) return { correct: false, reason: 'empty' };

  const volatile = key.formula === undefined ? [] : volatileFunctions(key.formula);
  if (volatile.length > 0) return compareVolatile(volatile, studentEmpty ? undefined : student);

  if (!valuesEqual(key, student ?? { value: null }, opts)) return { correct: false, reason: 'value_mismatch' };

  const formulaRequired = opts.requireFormulas && key.formula !== undefined && !isHardCodedFormula(key.formula);
  if (formulaRequired && (student?.formula === undefined || isHardCodedFormula(student.formula))) {
    return { correct: false, reason: studentEmpty ? 'empty' : 'formula_required' };
  }
  return { correct: true };
}

/**
 * True for a formula that only combines constants, such as "=2693.25" or "=3200+520": nothing that could be a
 * cell or range reference, defined name, sheet reference, structured reference or function call is left once
 * string literals, numbers and TRUE/FALSE are removed.
 */
export function isHardCodedFormula(formula: string): boolean {
  const rest = maskStringLiterals(displayFormula(formula))
    .replace(/\d*\.?\d+(E[+-]?\d+)?/gi, '')
    .replace(/\b(TRUE|FALSE)\b/gi, '');
  return !/[A-Za-z$!\[#]/.test(rest);
}

/**
 * Key cells calling TODAY(), NOW(), RAND()... are not compared by value: their saved result depends on when (or
 * by chance) the file was calculated. The student's cell must be a formula calling the same volatile functions.
 */
function compareVolatile(volatile: string[], student: ComparableCell | undefined): CellVerdict {
  if (!student) return { correct: false, reason: 'empty' };
  if (student.formula === undefined) return { correct: false, reason: 'formula_required' };
  const used = volatileFunctions(student.formula);
  return volatile.every((name) => used.includes(name)) ? { correct: true } : { correct: false, reason: 'value_mismatch' };
}

/**
 * The numeric tolerance in the key cell's display units: percentage points for percentages (0.01 → 0.0001 as a
 * fraction) and at most one second for times; plain numbers, currency and whole-day dates use it as is.
 */
export function effectiveTolerance(tolerance: number, unit: NumberUnit | undefined): number {
  if (unit === 'percent') return tolerance / 100;
  if (unit === 'time') return Math.min(tolerance, 1 / SECONDS_PER_DAY);
  return tolerance;
}

/**
 * True when `actual` shows the same value as `expected` under the given text/number options. The numeric tolerance
 * follows the units `expected` is displayed in (see effectiveTolerance).
 */
export function valuesEqual(
  expected: ComparableCell,
  actual: ComparableCell,
  opts: Pick<CompareOptions, 'numericTolerance' | 'caseSensitive' | 'ignoreWhitespace'>,
): boolean {
  const ev = expected.value;
  const av = actual.value;
  const expectedBlank = !expected.isError && isBlank(ev);
  const actualBlank = !actual.isError && isBlank(av);
  if (expectedBlank || actualBlank) return expectedBlank && actualBlank;

  if (expected.isError || actual.isError) {
    return typeof ev === 'string' && typeof av === 'string' && errorKey(ev) === errorKey(av);
  }

  const tolerance = effectiveTolerance(opts.numericTolerance, expected.unit);
  if (typeof ev === 'number') {
    const n = typeof av === 'number' ? av : typeof av === 'string' ? parseNumericText(av) : null;
    return n !== null && numbersEqual(ev, n, tolerance);
  }
  if (typeof ev === 'boolean') {
    const b = typeof av === 'boolean' ? av : typeof av === 'string' ? parseBooleanText(av) : null;
    return b === ev;
  }
  if (typeof ev === 'string') {
    if (typeof av === 'string') return normalizeText(ev, opts) === normalizeText(av, opts);
    if (typeof av === 'number') {
      const n = parseNumericText(ev);
      return n !== null && numbersEqual(n, av, tolerance);
    }
    if (typeof av === 'boolean') return parseBooleanText(ev) === av;
  }
  return false;
}

/** Absolute tolerance plus a tiny relative slack for floating-point noise; the tolerance bound is inclusive. */
export function numbersEqual(a: number, b: number, tolerance: number): boolean {
  if (a === b) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const diff = Math.abs(a - b);
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return diff <= tolerance + RELATIVE_EPSILON * scale;
}

export function normalizeText(
  text: string,
  opts: Pick<CompareOptions, 'caseSensitive' | 'ignoreWhitespace'>,
): string {
  let out = text.normalize('NFC');
  if (opts.ignoreWhitespace) out = out.replace(/\s+/g, ' ').trim();
  if (!opts.caseSensitive) out = out.toLowerCase();
  return out;
}

/**
 * Reads numbers typed as text the way Excel displays them: " 42 ", "1,234.50", "$12", "-$5", "€3",
 * "25%", "(1,200)" (accounting negative), "1.5e3". Returns null for anything else.
 */
export function parseNumericText(text: string): number | null {
  let t = text.replace(/\s+/g, ' ').trim();
  if (!t) return null;

  let negative = false;
  const parenthesized = /^\((.*)\)$/.exec(t);
  if (parenthesized) {
    negative = true;
    t = parenthesized[1].trim();
  }
  let percent = false;
  if (t.endsWith('%')) {
    percent = true;
    t = t.slice(0, -1).trim();
  }

  const parts = /^([+\-−]?)\s*([$€£¥]?)\s*([+\-−]?)\s*([\d.,]+(?:[eE][+-]?\d+)?)\s*([$€£¥]?)$/.exec(t);
  if (!parts) return null;
  const [, signBefore, currencyBefore, signAfter, body, currencyAfter] = parts;
  const sign = signBefore + signAfter;
  if (sign.length > 1 || (currencyBefore && currencyAfter) || (parenthesized && sign)) return null;
  if (sign === '-' || sign === '−') negative = !negative;

  const number = /^(\d{1,3}(?:,\d{3})+|\d*)(\.\d*)?([eE][+-]?\d+)?$/.exec(body);
  if (!number || !/\d/.test(number[1] + (number[2] ?? ''))) return null;
  const n = Number(number[1].replace(/,/g, '') + (number[2] ?? '') + (number[3] ?? ''));
  if (!Number.isFinite(n)) return null;

  const signed = negative ? -n : n;
  return percent ? signed / 100 : signed;
}

/** "TRUE"/"FALSE" in any case (trimmed) → boolean; anything else → null. */
export function parseBooleanText(text: string): boolean | null {
  const t = text.trim().toUpperCase();
  if (t === 'TRUE') return true;
  if (t === 'FALSE') return false;
  return null;
}

function errorKey(text: string): string {
  return text.trim().toUpperCase();
}
