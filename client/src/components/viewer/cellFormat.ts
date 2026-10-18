/** Formatting helpers shared by the spreadsheet viewer and the grade report. */
import type { CellFailReason, CellPrimitive, CellResult, ViewerCell } from '@shared/types';

/** 1250 → "1,250", 0.333333 → "0.3333", 0.00001 → "0.00001" (tiny values keep 4 significant digits). */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n !== 0 && Math.abs(n) < 0.0001) return String(Number(n.toPrecision(4)));
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

/**
 * A grader value as text. Text is quoted so that numbers stored as text ("100" vs 100) and stray spaces are visible.
 * null → "(empty)".
 */
export function formatValue(v: CellPrimitive | undefined): string {
  if (v === null || v === undefined) return '(empty)';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return formatNumber(v);
  return `"${v}"`;
}

/**
 * A graded value as the workbook displays it: the grader's formatted text ("31.8%", "10/16/2026", "9:00") when
 * the report has it, else formatValue of the raw value (older reports, text, booleans, empty cells).
 */
export function formatDisplayValue(value: CellPrimitive | undefined, text: string | undefined): string {
  return text ?? formatValue(value);
}

/** "SUM(B2:B6)" → "=SUM(B2:B6)" (tolerates a leading "=" already present). */
export function formulaText(f: string): string {
  return f.startsWith('=') ? f : `=${f}`;
}

/** Excel's "General" format: up to 10 significant digits, no grouping. */
function generalNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n) && Math.abs(n) < 1e11) return String(n);
  return String(Number(n.toPrecision(10)));
}

function formatDateValue(v: CellPrimitive): string {
  if (typeof v !== 'string') return v === null ? '' : String(v);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  const hasTime = d.getUTCHours() !== 0 || d.getUTCMinutes() !== 0 || d.getUTCSeconds() !== 0;
  // Spreadsheet dates have no time zone; read them as UTC so the wall-clock value is unchanged.
  const options = { timeZone: 'UTC' };
  return hasTime ? d.toLocaleString(undefined, options) : d.toLocaleDateString(undefined, options);
}

/** What the grid shows in a cell: the formula when `showFormulas`, else Excel's formatted text when known. */
export function cellDisplayText(cell: ViewerCell | undefined, showFormulas: boolean): string {
  if (!cell) return '';
  if (showFormulas && cell.f) return formulaText(cell.f);
  if (cell.w !== undefined) return cell.w;
  const { v } = cell;
  if (v === null) return '';
  if (cell.t === 'b' || typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (cell.t === 'd') return formatDateValue(v);
  if (typeof v === 'number') return generalNumber(v);
  return String(v);
}

/** What the formula bar shows: the formula, or the underlying (unformatted) value like Excel does. */
export function cellEditText(cell: ViewerCell | undefined): string {
  if (!cell) return '';
  if (cell.f) return formulaText(cell.f);
  const { v } = cell;
  if (v === null) return cell.w ?? '';
  if (cell.t === 'b' || typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (cell.t === 'd') return cell.w ?? formatDateValue(v);
  if (typeof v === 'number') return String(Number(v.toPrecision(15)));
  return String(v);
}

export type CellAlign = 'left' | 'right' | 'center';

/** Excel's default alignment: numbers/dates right, booleans/errors centered, text left; formulas left when shown. */
export function cellAlign(cell: ViewerCell | undefined, showFormulas: boolean): CellAlign {
  if (!cell) return 'left';
  if (showFormulas && cell.f) return 'left';
  if (cell.t === 'n' || cell.t === 'd') return 'right';
  if (cell.t === 'b' || cell.t === 'e') return 'center';
  return 'left';
}

export const FAIL_REASON_LABEL: Record<CellFailReason, string> = {
  value_mismatch: 'Wrong value',
  empty: 'Empty',
  formula_required: 'Needs a formula',
  missing_sheet: 'Sheet missing',
};

/** "31.8% (=B2/B3)", "=B2/B3" or null when nothing about the expected answer is visible. */
function describeExpected(cell: CellResult): string | null {
  const formula = cell.expectedFormula ? formulaText(cell.expectedFormula) : null;
  if (cell.expected === undefined && cell.expectedText === undefined) return formula;
  const value = formatDisplayValue(cell.expected, cell.expectedText);
  return formula ? `${value} (${formula})` : value;
}

function describeActual(cell: CellResult): string {
  const value = formatDisplayValue(cell.actual, cell.actualText);
  return cell.actualFormula ? `${value} (${formulaText(cell.actualFormula)})` : value;
}

/**
 * One-line explanation of a graded cell, used for tooltips ("Expected 31.8% — got 33.3%"). Omits expected values
 * the viewer may not see.
 */
export function describeCellResult(cell: CellResult): string {
  if (cell.correct) return 'Correct';
  const expected = describeExpected(cell);
  switch (cell.reason) {
    case 'missing_sheet':
      return 'Sheet not found';
    case 'empty':
      return expected ? `Missing — cell is empty. Expected ${expected}` : 'Missing — cell is empty';
    case 'formula_required':
      return cell.expectedFormula
        ? `Hard-coded (typed in, or a formula of constants only) — use a formula like ${formulaText(cell.expectedFormula)}`
        : 'Hard-coded (typed in, or a formula of constants only) — use a formula';
    default:
      return expected ? `Expected ${expected} — got ${describeActual(cell)}` : `Incorrect — got ${describeActual(cell)}`;
  }
}
