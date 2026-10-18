/** Low-level helpers for SheetJS cell objects (sparse sheets read with cellDates=false). */
import type * as XLSX from 'xlsx';
import type { CellPrimitive } from '../../../shared/types.js';
import { encodeAddress } from './ranges.js';

/** Excel's internal error codes as used by SheetJS for cells with t = 'e'. */
export const ERROR_TEXT: Record<number, string> = {
  0x00: '#NULL!',
  0x07: '#DIV/0!',
  0x0f: '#VALUE!',
  0x17: '#REF!',
  0x1d: '#NAME?',
  0x24: '#NUM!',
  0x2a: '#N/A',
  0x2b: '#GETTING_DATA',
};

export const ERROR_CODE: Record<string, number> = Object.fromEntries(
  Object.entries(ERROR_TEXT).map(([code, text]) => [text, Number(code)]),
);

const ADDRESS = /^([A-Z]{1,3})(\d+)$/;

/** "C7" → { r: 6, c: 2 }; null for anything that is not a plain A1 address. */
export function decodeAddress(address: string): { r: number; c: number } | null {
  const match = ADDRESS.exec(address);
  if (!match) return null;
  let c = 0;
  for (let i = 0; i < match[1].length; i += 1) c = c * 26 + (match[1].charCodeAt(i) - 64);
  return { r: Number(match[2]) - 1, c: c - 1 };
}

/**
 * Calls `fn` for every real cell of the sheet. Skips "!" metadata keys and stub cells, except stubs that carry a
 * formula: workbooks are read with sheetStubs so formulas saved without a result (`<f>` with an empty or missing
 * `<v>`, as written by openpyxl and similar tools) are not dropped.
 */
export function forEachCell(
  ws: XLSX.WorkSheet,
  fn: (cell: XLSX.CellObject, r: number, c: number, address: string) => void,
): void {
  for (const key of Object.keys(ws)) {
    if (key.charCodeAt(0) === 33) continue; // "!ref", "!merges", ...
    const cell = ws[key] as XLSX.CellObject | undefined;
    if (!cell || typeof cell !== 'object' || (cell.t === 'z' && !hasFormula(cell))) continue;
    const pos = decodeAddress(key);
    if (pos) fn(cell, pos.r, pos.c, key);
  }
}

export function hasFormula(cell: XLSX.CellObject): boolean {
  return typeof cell.f === 'string' && cell.f.trim() !== '';
}

/**
 * True for formula cells saved without a calculated result: no cached value at all (files written by
 * scripts), or CSV text such as "=SUM(A1:A3)" that SheetJS exposes as both the formula and the value.
 */
export function lacksCachedValue(cell: XLSX.CellObject): boolean {
  if (!hasFormula(cell)) return false;
  // Formula stubs report v = 0, which is not a real result.
  if (cell.t === 'z' || cell.v === undefined || cell.v === null) return true;
  return typeof cell.v === 'string' && cell.v.trim() === `=${cell.f}`.trim();
}

/**
 * For a cell inside the range of an array formula (CSE or a dynamic-array spill), the range's top-left cell, which
 * holds the formula: SheetJS sets `f` only there and gives the other cells of the range just `F` (e.g. "D2:D4").
 * Undefined for other cells.
 */
export function arrayAnchor(ws: XLSX.WorkSheet, cell: XLSX.CellObject): XLSX.CellObject | undefined {
  if (typeof cell.F !== 'string') return undefined;
  const [first, second = first] = cell.F.replace(/\$/g, '').split(':');
  const a = decodeAddress(first.trim().toUpperCase());
  const b = decodeAddress(second.trim().toUpperCase());
  if (!a || !b) return undefined;
  const anchor = ws[encodeAddress(Math.min(a.r, b.r), Math.min(a.c, b.c))] as XLSX.CellObject | undefined;
  return anchor && typeof anchor === 'object' ? anchor : undefined;
}

/** Display text of an error cell, e.g. "#DIV/0!". */
export function errorText(cell: XLSX.CellObject): string {
  if (typeof cell.w === 'string' && cell.w.startsWith('#')) return cell.w;
  if (typeof cell.v === 'number' && ERROR_TEXT[cell.v]) return ERROR_TEXT[cell.v];
  if (typeof cell.v === 'string' && cell.v.startsWith('#')) return cell.v;
  return '#VALUE!';
}

/** Days since 1899-12-30 (Excel's 1900 date system), for the rare Date value. */
function dateToSerial(date: Date): number {
  return (date.getTime() - Date.UTC(1899, 11, 30)) / 86_400_000;
}

/**
 * The cell's value as a JSON primitive. Errors become their display text with `isError`; formula
 * cells without a calculated result get `value: null, missing: true`.
 */
export function cellPrimitive(cell: XLSX.CellObject): { value: CellPrimitive; isError: boolean; missing: boolean } {
  if (lacksCachedValue(cell)) return { value: null, isError: false, missing: true };
  if (cell.t === 'e') return { value: errorText(cell), isError: true, missing: false };
  if (cell.t === 'z') return { value: null, isError: false, missing: false };
  const v = cell.v;
  if (v === undefined || v === null) return { value: null, isError: false, missing: false };
  if (v instanceof Date) return { value: dateToSerial(v), isError: false, missing: false };
  if (typeof v === 'number' && !Number.isFinite(v)) return { value: '#NUM!', isError: true, missing: false };
  return { value: v, isError: false, missing: false };
}
