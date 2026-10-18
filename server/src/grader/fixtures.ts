/**
 * Builds workbooks in code, for tests and for the demo seed.
 *
 *   buildWorkbook([{ name: 'Sheet1', rows: [[1, 2, { f: 'A1+B1' }]] }])            // formula saved WITHOUT a result
 *   buildWorkbook([...], 'xlsx', { calculate: true })                             // results stored, like Excel
 *   monthlyBudgetKey() / monthlyBudgetTemplate() / monthlyBudgetSubmission('partial')
 */
import * as XLSX from 'xlsx';
import type { CellPrimitive } from '../../../shared/types.js';
import { ERROR_CODE } from './cells.js';
import { encodeAddress } from './ranges.js';
import { recalculateMissingValues } from './recalc.js';

/**
 * A primitive value, a formula ({ f } — when `v` is omitted NO cached result is written), a formatted value,
 * or an error cell. `z` is an Excel number format such as '"$"#,##0.00' or '0%'.
 */
export type CellSpec =
  | CellPrimitive
  | { f: string; v?: CellPrimitive; z?: string }
  | { v: Exclude<CellPrimitive, null>; z?: string }
  | { error: string };

export interface SheetSpec {
  name: string;
  /** rows[r][c]; null/undefined cells are left empty. */
  rows: (CellSpec | undefined)[][];
  /** Merged ranges such as "A1:C1". */
  merges?: string[];
  /** Column widths in characters (index 0 = column A). */
  colWidths?: (number | null)[];
}

export type FixtureBookType = 'xlsx' | 'csv' | 'xls' | 'ods';

export interface BuildOptions {
  /** Calculate formulas without `v` and store their results, the way Excel saves files. */
  calculate?: boolean;
}

/** Writes the sheets as a file of the given type. CSV keeps only the first sheet; .xls stores values, not formulas. */
export function buildWorkbook(sheets: SheetSpec[], bookType: FixtureBookType = 'xlsx', options: BuildOptions = {}): Buffer {
  const wb = XLSX.utils.book_new();
  for (const spec of sheets) XLSX.utils.book_append_sheet(wb, buildSheet(spec), spec.name);
  if (options.calculate) recalculateMissingValues(wb);
  return XLSX.write(wb, { type: 'buffer', bookType }) as Buffer;
}

function buildSheet(spec: SheetSpec): XLSX.WorkSheet {
  const ws: XLSX.WorkSheet = {};
  let maxR = 0;
  let maxC = 0;
  spec.rows.forEach((row, r) => {
    row.forEach((cellSpec, c) => {
      const cell = toCell(cellSpec);
      if (!cell) return;
      ws[encodeAddress(r, c)] = cell;
      maxR = Math.max(maxR, r);
      maxC = Math.max(maxC, c);
    });
  });
  const merges = (spec.merges ?? []).map((range) => XLSX.utils.decode_range(range));
  for (const merge of merges) {
    maxR = Math.max(maxR, merge.e.r);
    maxC = Math.max(maxC, merge.e.c);
  }
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } });
  if (merges.length) ws['!merges'] = merges;
  if (spec.colWidths) ws['!cols'] = spec.colWidths.map((wch) => (wch === null ? {} : { wch }));
  return ws;
}

function toCell(spec: CellSpec | undefined): XLSX.CellObject | null {
  if (spec === null || spec === undefined) return null;
  if (typeof spec !== 'object') return primitiveCell(spec);
  if ('error' in spec) return { t: 'e', v: ERROR_CODE[spec.error] ?? ERROR_CODE['#VALUE!'], w: spec.error };
  if ('f' in spec) {
    const value = spec.v === undefined || spec.v === null ? null : primitiveCell(spec.v);
    const cell: XLSX.CellObject = value ?? { t: 'n' };
    cell.f = spec.f.replace(/^=/, '');
    if (spec.z) cell.z = spec.z;
    return cell;
  }
  const cell = primitiveCell(spec.v);
  if (spec.z) cell.z = spec.z;
  return cell;
}

function primitiveCell(value: Exclude<CellPrimitive, null>): XLSX.CellObject {
  if (typeof value === 'number') return { t: 'n', v: value };
  if (typeof value === 'boolean') return { t: 'b', v: value };
  return { t: 's', v: value };
}

/* ------------------------------------------------------------------ */
/* Sample assignment: Monthly Budget                                  */
/* ------------------------------------------------------------------ */

const MONEY = '"$"#,##0.00';
const PERCENT = '0.0%';

const INCOME: [string, number, number][] = [
  ['Salary', 3200, 3250],
  ['Freelance', 400, 520],
];

const EXPENSES: [string, number, number][] = [
  ['Rent', 1200, 1200],
  ['Groceries', 450, 487.35],
  ['Utilities', 180, 162.4],
  ['Transportation', 220, 245],
  ['Entertainment', 150, 98.5],
  ['Savings', 500, 500],
];

/** Excel rows (1-based) of the layout. */
const ROW = { incomeHeader: 4, incomeFirst: 5, incomeTotal: 7, expenseHeader: 9, expenseFirst: 10, expenseTotal: 16, net: 18 };

export const MONTHLY_BUDGET = {
  title: 'Monthly Budget',
  sheetName: 'Budget',
  description:
    'Complete the monthly budget. Use formulas for every Difference, Total, % of Income, and Net cell — ' +
    'typed-in numbers will not get credit.',
  keyFileName: 'Monthly Budget - Answer Key.xlsx',
  templateFileName: 'Monthly Budget - Starter.xlsx',
  /** Cells graded with the template attached and default settings (all formula cells). */
  gradedCells: 23,
};

export type MonthlyBudgetVariant = 'perfect' | 'partial' | 'hardcoded' | 'renamed' | 'mostly' | 'incomplete';

export interface MonthlyBudgetVariantInfo {
  description: string;
  correct: number;
  fileName: string;
}

/** Expected results with the template attached and DEFAULT_GRADING_CONFIG. */
export const MONTHLY_BUDGET_VARIANTS: Record<MonthlyBudgetVariant, MonthlyBudgetVariantInfo> = {
  perfect: {
    description: 'Every answer right (a few formulas written differently from the key).',
    correct: 23,
    fileName: 'Monthly Budget - Complete.xlsx',
  },
  partial: {
    description:
      'A sign error, a wrong denominator, a SUM missing a row (which carries into later totals), and a blank Net cell.',
    correct: 16,
    fileName: 'Monthly Budget - Draft.xlsx',
  },
  mostly: {
    description: 'Nearly there: one % of Income cell divides by the wrong total and one difference was typed in.',
    correct: 21,
    fileName: 'Monthly Budget - Final.xlsx',
  },
  incomplete: {
    description: 'Unfinished: the differences are done, but % of Income, the expense totals and the net are blank.',
    correct: 11,
    fileName: 'Monthly Budget - Unfinished.xlsx',
  },
  hardcoded: {
    description: 'Correct numbers, but the totals and net were typed in instead of calculated.',
    correct: 14,
    fileName: 'Monthly Budget - Typed Totals.xlsx',
  },
  renamed: {
    description: 'Perfect work on a sheet renamed to "Sheet1".',
    correct: 23,
    fileName: 'Monthly Budget - Sheet1.xlsx',
  },
};

function keyFormulas(): Record<string, CellSpec> {
  const formulas: Record<string, CellSpec> = {};
  const money = (f: string): CellSpec => ({ f, z: MONEY });
  for (let r = ROW.incomeFirst; r < ROW.incomeTotal; r += 1) formulas[`D${r}`] = money(`C${r}-B${r}`);
  formulas[`B${ROW.incomeTotal}`] = money(`SUM(B${ROW.incomeFirst}:B${ROW.incomeTotal - 1})`);
  formulas[`C${ROW.incomeTotal}`] = money(`SUM(C${ROW.incomeFirst}:C${ROW.incomeTotal - 1})`);
  formulas[`D${ROW.incomeTotal}`] = money(`C${ROW.incomeTotal}-B${ROW.incomeTotal}`);
  for (let r = ROW.expenseFirst; r < ROW.expenseTotal; r += 1) {
    formulas[`D${r}`] = money(`B${r}-C${r}`);
    formulas[`E${r}`] = { f: `C${r}/$C$${ROW.incomeTotal}`, z: PERCENT };
  }
  const total = ROW.expenseTotal;
  formulas[`B${total}`] = money(`SUM(B${ROW.expenseFirst}:B${total - 1})`);
  formulas[`C${total}`] = money(`SUM(C${ROW.expenseFirst}:C${total - 1})`);
  formulas[`D${total}`] = money(`B${total}-C${total}`);
  formulas[`E${total}`] = { f: `C${total}/$C$${ROW.incomeTotal}`, z: PERCENT };
  formulas[`B${ROW.net}`] = money(`B${ROW.incomeTotal}-B${total}`);
  formulas[`C${ROW.net}`] = money(`C${ROW.incomeTotal}-C${total}`);
  return formulas;
}

/** Labels and the given numbers (everything a student starts with). */
function budgetBase(): Record<string, CellSpec> {
  const cells: Record<string, CellSpec> = {
    A1: 'Monthly Budget',
    A2: 'October 2026',
    [`A${ROW.incomeHeader}`]: 'Income',
    [`B${ROW.incomeHeader}`]: 'Budgeted',
    [`C${ROW.incomeHeader}`]: 'Actual',
    [`D${ROW.incomeHeader}`]: 'Difference',
    [`A${ROW.incomeTotal}`]: 'Total Income',
    [`A${ROW.expenseHeader}`]: 'Expenses',
    [`B${ROW.expenseHeader}`]: 'Budgeted',
    [`C${ROW.expenseHeader}`]: 'Actual',
    [`D${ROW.expenseHeader}`]: 'Difference',
    [`E${ROW.expenseHeader}`]: '% of Income',
    [`A${ROW.expenseTotal}`]: 'Total Expenses',
    [`A${ROW.net}`]: 'Net (Income - Expenses)',
  };
  const addRows = (first: number, rows: [string, number, number][]) =>
    rows.forEach(([label, budgeted, actual], i) => {
      cells[`A${first + i}`] = label;
      cells[`B${first + i}`] = { v: budgeted, z: MONEY };
      cells[`C${first + i}`] = { v: actual, z: MONEY };
    });
  addRows(ROW.incomeFirst, INCOME);
  addRows(ROW.expenseFirst, EXPENSES);
  return cells;
}

function budgetWorkbook(cells: Record<string, CellSpec | undefined>, sheetName = MONTHLY_BUDGET.sheetName): Buffer {
  const rows: (CellSpec | undefined)[][] = [];
  for (const [address, spec] of Object.entries(cells)) {
    if (spec === undefined || spec === null) continue;
    const { r, c } = XLSX.utils.decode_cell(address);
    (rows[r] ??= [])[c] = spec;
  }
  for (let r = 0; r < rows.length; r += 1) rows[r] ??= [];
  return buildWorkbook(
    [{ name: sheetName, rows, merges: ['A1:E1', 'A2:E2'], colWidths: [26, 14, 14, 14, 14] }],
    'xlsx',
    { calculate: true },
  );
}

/** The finished workbook (answer key), with formula results stored. */
export function monthlyBudgetKey(): Buffer {
  return budgetWorkbook({ ...budgetBase(), ...keyFormulas() });
}

/** The starter file: same layout and numbers, formula cells left blank. */
export function monthlyBudgetTemplate(): Buffer {
  return budgetWorkbook(budgetBase());
}

/** A student submission; see MONTHLY_BUDGET_VARIANTS for what each variant contains and scores. */
export function monthlyBudgetSubmission(variant: MonthlyBudgetVariant): Buffer {
  const key = { ...budgetBase(), ...keyFormulas() };
  const money = (f: string): CellSpec => ({ f, z: MONEY });
  switch (variant) {
    case 'perfect':
      return budgetWorkbook({
        ...key,
        D5: money('-(B5-C5)'),
        B7: money('B5+B6'),
        E16: { f: 'SUM(E10:E15)', z: PERCENT },
      });
    case 'partial':
      return budgetWorkbook({
        ...key,
        D6: money('B6-C6'),
        E12: { f: 'C12/C16', z: PERCENT },
        C16: money('SUM(C10:C14)'),
        B18: undefined,
      });
    case 'hardcoded':
      return budgetWorkbook({ ...key, ...typedTotals() });
    case 'renamed':
      return budgetWorkbook(key, 'Sheet1');
    case 'mostly':
      return budgetWorkbook({
        ...key,
        D11: { v: -37.35, z: MONEY },
        E12: { f: 'C12/C16', z: PERCENT },
      });
    case 'incomplete': {
      const unfinished: Record<string, CellSpec | undefined> = { ...key };
      for (let r = ROW.expenseFirst; r <= ROW.expenseTotal; r += 1) unfinished[`E${r}`] = undefined;
      for (const address of [`B${ROW.expenseTotal}`, `C${ROW.expenseTotal}`, `D${ROW.expenseTotal}`]) {
        unfinished[address] = undefined;
      }
      unfinished[`B${ROW.net}`] = undefined;
      unfinished[`C${ROW.net}`] = undefined;
      return budgetWorkbook(unfinished);
    }
  }
}

/** Totals and net typed in as numbers (E16 as a student would type the percentage shown: 71.44%). */
function typedTotals(): Record<string, CellSpec> {
  const sum = (rows: [string, number, number][], i: 1 | 2) => rows.reduce((s, row) => s + row[i], 0);
  const income = { budgeted: sum(INCOME, 1), actual: sum(INCOME, 2) };
  const expenses = { budgeted: sum(EXPENSES, 1), actual: sum(EXPENSES, 2) };
  const money = (v: number): CellSpec => ({ v: Math.round(v * 100) / 100, z: MONEY });
  return {
    B7: money(income.budgeted),
    C7: money(income.actual),
    D7: money(income.actual - income.budgeted),
    B16: money(expenses.budgeted),
    C16: money(expenses.actual),
    D16: money(expenses.budgeted - expenses.actual),
    E16: { v: Math.round((expenses.actual / income.actual) * 10000) / 10000, z: PERCENT },
    B18: money(income.budgeted - expenses.budgeted),
    C18: money(income.actual - expenses.actual),
  };
}
