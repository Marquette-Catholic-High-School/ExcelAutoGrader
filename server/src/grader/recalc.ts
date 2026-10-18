/**
 * Fills in formula results that are missing from a workbook by evaluating it with HyperFormula: files written by
 * scripts or some exporters store formulas without cached values, CSV files store "=..." text, and XlsxWriter
 * (pandas) stores 0 for every formula and asks Excel to recalculate the whole workbook when it is opened.
 *
 * Cells that already have a cached value are loaded as plain values, so results Excel calculated (even with
 * functions HyperFormula does not support) are kept as-is; only formulas lacking a result are evaluated, or every
 * formula for a full recalculation.
 *
 * The work is bounded. HyperFormula materializes every cell of every range a formula touches, so area references
 * are cut back to the used part of the workbook (the cells beyond it are empty) and what remains is budgeted.
 */
// Named import: the default export's typings resolve to the module namespace under NodeNext.
import { DetailedCellError, HyperFormula } from 'hyperformula';
import type { ConfigParams, RawCellContent, SerializedNamedExpression, Sheets } from 'hyperformula';
import * as XLSX from 'xlsx';
import { ERROR_CODE, arrayAnchor, cellPrimitive, forEachCell, hasFormula, lacksCachedValue } from './cells.js';
import { engineFormula, generatedArrayCells, mapAreaReferences, type AreaReference } from './formula.js';
import { sheetKey } from './match.js';
import { MAX_COLS, MAX_ROWS, type CellPosition } from './ranges.js';

/**
 * Above this many cells, recalculation is skipped: the used rows x columns summed over sheets, or the cells of the
 * ranges and generated arrays the evaluated formulas reference.
 */
const MAX_RECALC_CELLS = 2_000_000;

/**
 * References reaching past the used area are cut back to it, except small ones: those are cheap as written and
 * keep exact results for functions that count blank cells or rows (COUNTBLANK, ROWS).
 */
const SMALL_AREA_CELLS = 10_000;

export interface RecalcResult {
  /** Formula cells that were missing a result (every formula cell, for a full recalculation). */
  missing: number;
  /** How many of them now have a value. */
  recalculated: number;
  /** Results that came out as #NAME? (usually a function the engine does not know). */
  unsupported: number;
  /** Set when the engine could not run at all; the cells keep what they were saved with. */
  failure: 'too_large' | 'engine_error' | null;
}

interface PendingCell {
  sheet: string;
  r: number;
  c: number;
  cell: XLSX.CellObject;
}

interface SheetData {
  name: string;
  /** Sparse rows of engine content; the formulas being evaluated are added once rewritten. */
  rows: RawCellContent[][];
  usedRows: number;
  usedCols: number;
}

type IsPending = (cell: XLSX.CellObject) => boolean;

/** True when at least one formula cell has no cached result, or the workbook asks for a full recalculation. */
export function needsRecalculation(wb: XLSX.WorkBook): boolean {
  return fullRecalculationRequested(wb) || hasMissingValues(wb);
}

/**
 * True for workbooks that ask to be fully recalculated when opened (<calcPr fullCalcOnLoad="1"/>) and whose formula
 * results are all 0 or empty, as XlsxWriter (pandas) writes them. Files saved by Excel can carry the flag too, but
 * they store real results, which are kept.
 */
export function fullRecalculationRequested(wb: XLSX.WorkBook): boolean {
  const flag = (wb.Workbook as { CalcPr?: { fullCalcOnLoad?: unknown } } | undefined)?.CalcPr?.fullCalcOnLoad;
  if (flag !== true && flag !== '1' && flag !== 'true') return false;
  let formulas = 0;
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    let realResult = false;
    forEachCell(ws, (cell) => {
      if (realResult || !hasFormula(cell)) return;
      formulas += 1;
      const placeholder = lacksCachedValue(cell) || (cell.t !== 'e' && (cell.v === 0 || cell.v === ''));
      if (!placeholder) realResult = true;
    });
    if (realResult) return false;
  }
  return formulas > 0;
}

/**
 * Evaluates every formula without a cached value (every formula, for a full recalculation) and writes the results
 * into the SheetJS cells (t, v, w). Returns null when nothing needed recalculation. Never throws.
 */
export function recalculateMissingValues(wb: XLSX.WorkBook): RecalcResult | null {
  const full = fullRecalculationRequested(wb);
  if (!full && !hasMissingValues(wb)) return null;
  const isPending: IsPending = full ? hasFormula : lacksCachedValue;

  const pending: PendingCell[] = [];
  // Cells an array formula being evaluated spills into: left empty for the engine (a cached value there would
  // block the spill), then refreshed from its result.
  const spilled: PendingCell[] = [];
  const sheets: SheetData[] = [];
  let totalCells = 0;
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    const rows: RawCellContent[][] = [];
    let maxR = -1;
    let maxC = -1;
    if (ws) {
      forEachCell(ws, (cell, r, c) => {
        if (isPending(cell)) pending.push({ sheet: name, r, c, cell });
        else if (spillsFromPending(ws, cell, isPending)) spilled.push({ sheet: name, r, c, cell });
        else {
          const content = rawContent(cell);
          if (content === null) return;
          (rows[r] ??= [])[c] = content;
        }
        if (r > maxR) maxR = r;
        if (c > maxC) maxC = c;
      });
    }
    // Checked before anything is allocated per cell of the used area (a few far-away cells make it huge).
    totalCells += (maxR + 1) * (maxC + 1);
    if (totalCells > MAX_RECALC_CELLS) return tooLarge(wb, isPending);
    sheets.push({ name, rows, usedRows: maxR + 1, usedCols: maxC + 1 });
  }

  // Ranges are cut back to the workbook's used rows and columns (the largest over its sheets), so ranges of the
  // same shape keep the same shape (SUMIFS and SUMPRODUCT need that), wherever their sheets end.
  const used = {
    rows: Math.max(0, ...sheets.map((sheet) => sheet.usedRows)),
    cols: Math.max(0, ...sheets.map((sheet) => sheet.usedCols)),
  };
  const byName = new Map(sheets.map((sheet) => [sheet.name, sheet]));
  const budget = new ReferenceBudget();
  const toEngine = (formula: string, sheet: string | null): string => {
    const text = mapAreaReferences(engineFormula(formula), (ref) => trimArea(ref, ref.sheet ?? sheet, used, budget));
    budget.cells += generatedArrayCells(text);
    return text;
  };
  for (const item of pending) {
    const sheet = byName.get(item.sheet) as SheetData;
    (sheet.rows[item.r] ??= [])[item.c] = toEngine(item.cell.f ?? '', item.sheet);
    if (budget.cells > MAX_RECALC_CELLS) return tooLarge(wb, isPending);
  }
  const names = namedExpressions(wb, toEngine);
  if (budget.cells > MAX_RECALC_CELLS) return tooLarge(wb, isPending);

  const result: RecalcResult = { missing: pending.length, recalculated: 0, unsupported: 0, failure: null };
  const engineSheets: Sheets = {};
  for (const sheet of sheets) engineSheets[sheet.name] = densify(sheet.rows);
  const hf = buildEngine(wb, engineSheets, names);
  if (!hf) return { ...result, failure: 'engine_error' };
  const date1904 = Boolean(wb.Workbook?.WBProps?.date1904);
  try {
    for (const item of pending) {
      const value = engineValue(hf, item);
      if (value === undefined) continue;
      result.recalculated += 1;
      if (value instanceof DetailedCellError && value.type === 'NAME') {
        result.unsupported += 1;
        // A full recalculation keeps the result the file was saved with instead of replacing it with an error.
        if (full && !lacksCachedValue(item.cell)) continue;
      }
      applyValue(item.cell, value, date1904);
    }
    for (const item of spilled) {
      const value = engineValue(hf, item);
      if (value !== undefined && value !== null) applyValue(item.cell, value, date1904);
    }
  } catch {
    result.failure = 'engine_error';
  } finally {
    hf.destroy();
  }
  return result;
}

function hasMissingValues(wb: XLSX.WorkBook): boolean {
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    for (const key of Object.keys(ws)) {
      if (key.charCodeAt(0) === 33) continue;
      const cell = ws[key] as XLSX.CellObject;
      if (cell && typeof cell === 'object' && lacksCachedValue(cell)) return true;
    }
  }
  return false;
}

function tooLarge(wb: XLSX.WorkBook, isPending: IsPending): RecalcResult {
  let missing = 0;
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    forEachCell(ws, (cell) => {
      if (isPending(cell)) missing += 1;
    });
  }
  return { missing, recalculated: 0, unsupported: 0, failure: 'too_large' };
}

/** A cell of an array formula's range (not its top-left cell) whose formula is about to be evaluated. */
function spillsFromPending(ws: XLSX.WorkSheet, cell: XLSX.CellObject, isPending: IsPending): boolean {
  if (hasFormula(cell)) return false;
  const anchor = arrayAnchor(ws, cell);
  return anchor !== undefined && anchor !== cell && isPending(anchor);
}

/**
 * Cuts an area reference back to the used rows and columns: the cells beyond them are empty, so SUM, COUNT,
 * AVERAGE, MIN, MAX, SUMIF, lookups and the like give the same result. Returns null to keep the reference as written.
 */
function trimArea(
  ref: AreaReference,
  sheet: string | null,
  used: { rows: number; cols: number },
  budget: ReferenceBudget,
): { start: CellPosition; end: CellPosition } | null {
  const end = {
    r: Math.max(ref.start.r, Math.min(ref.end.r, used.rows - 1)),
    c: Math.max(ref.start.c, Math.min(ref.end.c, used.cols - 1)),
  };
  const trim = (end.r !== ref.end.r || end.c !== ref.end.c) && areaCells(ref.start, ref.end) > SMALL_AREA_CELLS;
  budget.add(sheetKey(sheet ?? ''), ref.start, trim ? end : ref.end);
  return trim ? { start: ref.start, end } : null;
}

function areaCells(start: CellPosition, end: CellPosition): number {
  return (end.r - start.r + 1) * (end.c - start.c + 1);
}

/**
 * Estimated number of cells HyperFormula materializes for the referenced areas. Identical areas are shared, and an
 * area one row taller than one already counted (running totals: $B$2:B2, $B$2:B3, ...) only adds that row, the way
 * the engine builds it.
 */
class ReferenceBudget {
  cells = 0;
  private readonly seen = new Set<string>();

  add(sheet: string, start: CellPosition, end: CellPosition): void {
    const key = (lastRow: number) => `${sheet}\u0000${start.r},${start.c},${lastRow},${end.c}`;
    const id = key(end.r);
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.cells += this.seen.has(key(end.r - 1)) ? end.c - start.c + 1 : areaCells(start, end);
  }
}

function buildEngine(wb: XLSX.WorkBook, sheets: Sheets, names: SerializedNamedExpression[]): HyperFormula | null {
  const config: Partial<ConfigParams> = {
    licenseKey: 'gpl-v3',
    evaluateNullToZero: true,
    useArrayArithmetic: true,
    // Keep full double precision like Excel instead of rounding results to ~10 significant digits.
    smartRounding: false,
    maxRows: MAX_ROWS,
    maxColumns: MAX_COLS,
  };
  if (wb.Workbook?.WBProps?.date1904) config.nullDate = { year: 1904, month: 1, day: 1 };
  // A defined name HyperFormula cannot parse makes the whole build fail; retry without names.
  for (const attempt of names.length ? [names, []] : [[]]) {
    try {
      return HyperFormula.buildFromSheets(sheets, config, attempt);
    } catch {
      // try the next attempt
    }
  }
  return null;
}

function engineValue(hf: HyperFormula, item: PendingCell): unknown {
  const sheetId = hf.getSheetId(item.sheet);
  return sheetId === undefined ? undefined : hf.getCellValue({ sheet: sheetId, row: item.r, col: item.c });
}

function namedExpressions(
  wb: XLSX.WorkBook,
  toEngine: (formula: string, sheet: string | null) => string,
): SerializedNamedExpression[] {
  const names = wb.Workbook?.Names ?? [];
  const out: SerializedNamedExpression[] = [];
  for (const name of names) {
    if (!name.Name || !name.Ref || name.Name.startsWith('_xlnm.') || /^#REF!|\[/.test(name.Ref)) continue;
    const scope = typeof name.Sheet === 'number' && name.Sheet < wb.SheetNames.length ? name.Sheet : undefined;
    const entry: SerializedNamedExpression = {
      name: name.Name,
      expression: toEngine(name.Ref, scope === undefined ? null : wb.SheetNames[scope]),
    };
    if (scope !== undefined) entry.scope = scope;
    out.push(entry);
  }
  return out;
}

/** Value to load into the engine for a cell that already has a result (null = leave empty). */
function rawContent(cell: XLSX.CellObject): RawCellContent {
  const { value, isError } = cellPrimitive(cell);
  if (value === null) return null;
  if (isError) return String(value);
  // A leading apostrophe keeps text as text ("001" stays a string, "=x" is not parsed as a formula).
  if (typeof value === 'string') return value === '' ? null : `'${value}`;
  return value;
}

/** HyperFormula wants arrays without holes. */
function densify(rows: RawCellContent[][]): RawCellContent[][] {
  const out: RawCellContent[][] = [];
  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r];
    if (!row) {
      out.push([]);
      continue;
    }
    const dense: RawCellContent[] = new Array(row.length);
    for (let c = 0; c < row.length; c += 1) dense[c] = row[c] ?? null;
    out.push(dense);
  }
  return out;
}

function applyValue(cell: XLSX.CellObject, value: unknown, date1904: boolean): void {
  if (value instanceof DetailedCellError) {
    cell.t = 'e';
    cell.v = ERROR_CODE[value.value] ?? ERROR_CODE['#VALUE!'];
    cell.w = value.value;
  } else if (typeof value === 'number') {
    cell.t = 'n';
    cell.v = value;
    cell.w = formatNumber(value, cell.z, date1904);
  } else if (typeof value === 'boolean') {
    cell.t = 'b';
    cell.v = value;
    cell.w = value ? 'TRUE' : 'FALSE';
  } else if (typeof value === 'string') {
    cell.t = 's';
    cell.v = value;
    cell.w = value;
  } else {
    cell.t = 's';
    cell.v = '';
    cell.w = '';
  }
}

/** Display text; dates in a 1904-system workbook are serials of that system (HyperFormula computes them so). */
function formatNumber(value: number, format: XLSX.NumberFormat | undefined, date1904: boolean): string {
  try {
    return XLSX.SSF.format(format ?? 'General', value, date1904 ? { date1904: true } : undefined);
  } catch {
    return String(value);
  }
}
