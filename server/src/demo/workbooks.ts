/**
 * Demo workbooks for the seed (besides the Monthly Budget sample in grader/fixtures.ts). Every file stores its
 * formula results, the way Excel saves them.
 */
import { buildWorkbook, type CellSpec, type SheetSpec } from '../grader/fixtures.js';

const MONEY = '"$"#,##0.00';
const WHOLE_MONEY = '"$"#,##0';
const PERCENT = '0.0%';

/** Sparse { A1: spec } map → the row arrays buildWorkbook takes. */
function rowsOf(cells: Record<string, CellSpec | undefined>): (CellSpec | undefined)[][] {
  const rows: (CellSpec | undefined)[][] = [];
  for (const [address, spec] of Object.entries(cells)) {
    if (spec === undefined || spec === null) continue;
    const match = /^([A-Z]+)(\d+)$/.exec(address);
    if (!match) throw new Error(`Bad demo cell address ${address}`);
    const c = [...match[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
    const r = Number(match[2]) - 1;
    (rows[r] ??= [])[c] = spec;
  }
  for (let r = 0; r < rows.length; r += 1) rows[r] ??= [];
  return rows;
}

function save(sheets: (Omit<SheetSpec, 'rows'> & { cells: Record<string, CellSpec | undefined> })[]): Buffer {
  return buildWorkbook(
    sheets.map(({ cells, ...sheet }) => ({ ...sheet, rows: rowsOf(cells) })),
    'xlsx',
    { calculate: true },
  );
}

/* ------------------------------------------------------------------ */
/* Quarterly Sales Report (manual grading: there is no answer key)    */
/* ------------------------------------------------------------------ */

const REGIONS: [string, number, number, number][] = [
  ['North', 48200, 51350, 49875],
  ['South', 39100, 42780, 45210],
  ['East', 55640, 53120, 58930],
  ['West', 31480, 29950, 34720],
];

export const SALES_REPORT = {
  title: 'Quarterly Sales Report',
  description:
    'Build a Q3 sales report from the regional numbers: monthly and quarter totals for every region, each ' +
    "region's share of sales, the best month and the top region. Format it so it is ready to share with " +
    'the sales team, and add a short written summary on a second sheet.',
};

export type SalesReportVariant = 'polished' | 'unformatted';

/**
 * 'polished': everything asked for. 'unformatted': correct totals, but the share column is not formatted as
 * percentages and the top region and summary sentence about it are missing.
 */
export function salesReportWorkbook(variant: SalesReportVariant, author: string): Buffer {
  const polished = variant === 'polished';
  const first = 5;
  const last = first + REGIONS.length - 1;
  const total = last + 1;
  const money = (f: string): CellSpec => ({ f, z: WHOLE_MONEY });
  const cells: Record<string, CellSpec | undefined> = {
    A1: 'Quarterly Sales Report: Q3 2026',
    A2: `Prepared by ${author}`,
    A4: 'Region',
    B4: 'July',
    C4: 'August',
    D4: 'September',
    E4: 'Q3 Total',
    F4: 'Share of Sales',
    [`A${total}`]: 'Total',
  };
  REGIONS.forEach(([region, ...months], i) => {
    const r = first + i;
    cells[`A${r}`] = region;
    months.forEach((value, m) => (cells[`${'BCD'[m]}${r}`] = { v: value, z: WHOLE_MONEY }));
    cells[`E${r}`] = money(`SUM(B${r}:D${r})`);
    cells[`F${r}`] = polished ? { f: `E${r}/$E$${total}`, z: PERCENT } : { f: `E${r}/$E$${total}` };
  });
  for (const col of 'BCDE') cells[`${col}${total}`] = money(`SUM(${col}${first}:${col}${last})`);
  cells[`F${total}`] = polished ? { f: `SUM(F${first}:F${last})`, z: PERCENT } : { f: `SUM(F${first}:F${last})` };
  cells[`A${total + 2}`] = 'Best month';
  cells[`B${total + 2}`] = { f: `INDEX(B4:D4,1,MATCH(MAX(B${total}:D${total}),B${total}:D${total},0))` };
  if (polished) {
    cells[`A${total + 3}`] = 'Top region';
    cells[`B${total + 3}`] = { f: `INDEX(A${first}:A${last},MATCH(MAX(E${first}:E${last}),E${first}:E${last},0))` };
  }

  const summary = polished
    ? 'Q3 sales reached $540,355. September was the strongest month, and the East region led every month, ' +
      'bringing in just over 30% of the quarter. West is the smallest region and dipped in August.'
    : 'Q3 sales reached $540,355 and September was the best month. Most regions grew over the quarter.';
  return save([
    {
      name: 'Q3 Sales',
      cells,
      merges: ['A1:F1', 'A2:F2'],
      colWidths: [16, 12, 12, 12, 14, 15],
    },
    { name: 'Summary', cells: { A1: 'Summary', A3: summary }, colWidths: [110] },
  ]);
}

/* ------------------------------------------------------------------ */
/* Grade Calculator (autograded, no submissions in the demo)          */
/* ------------------------------------------------------------------ */

export const GRADE_CALCULATOR = {
  title: 'Grade Calculator',
  description:
    "Use the category weights to calculate each student's final percentage, rounded to one decimal place, " +
    'and their letter grade (A from 90, B from 80, C from 70, D from 60, otherwise F). Then fill in the class ' +
    'summary. Use formulas everywhere; refer to the weights with absolute references.',
};

const GRADE_STUDENTS: [string, number, number, number][] = [
  ['Jordan Lee', 92, 88, 85],
  ['Priya Shah', 98, 95, 93],
  ['Marcus Bell', 75, 68, 72],
  ['Sofia Garcia', 90, 90, 90],
  ['Liam Chen', 60, 55, 58],
  ['Nora Kim', 84, 79, 81],
];

const GRADE_FIRST_ROW = 9;
const GRADE_LAST_ROW = GRADE_FIRST_ROW + GRADE_STUDENTS.length - 1;

function gradeCalculatorBase(): Record<string, CellSpec | undefined> {
  const cells: Record<string, CellSpec | undefined> = {
    A1: 'Grade Calculator',
    A3: 'Category',
    B3: 'Weight',
    A4: 'Homework',
    B4: { v: 0.25, z: '0%' },
    A5: 'Quizzes',
    B5: { v: 0.25, z: '0%' },
    A6: 'Exams',
    B6: { v: 0.5, z: '0%' },
    A8: 'Student',
    B8: 'Homework',
    C8: 'Quizzes',
    D8: 'Exams',
    E8: 'Final %',
    F8: 'Letter',
    [`A${GRADE_LAST_ROW + 2}`]: 'Class average',
    [`A${GRADE_LAST_ROW + 3}`]: 'Highest final %',
    [`A${GRADE_LAST_ROW + 4}`]: 'Students passing (60+)',
  };
  GRADE_STUDENTS.forEach(([name, ...scores], i) => {
    const r = GRADE_FIRST_ROW + i;
    cells[`A${r}`] = name;
    scores.forEach((score, s) => (cells[`${'BCD'[s]}${r}`] = score));
  });
  return cells;
}

function letterFormula(r: number, cutoff: '>=' | '>'): string {
  return `IF(E${r}${cutoff}90,"A",IF(E${r}${cutoff}80,"B",IF(E${r}${cutoff}70,"C",IF(E${r}${cutoff}60,"D","F"))))`;
}

function gradeCalculatorAnswers(): Record<string, CellSpec> {
  const cells: Record<string, CellSpec> = {};
  for (let r = GRADE_FIRST_ROW; r <= GRADE_LAST_ROW; r += 1) {
    cells[`E${r}`] = { f: `ROUND(B${r}*$B$4+C${r}*$B$5+D${r}*$B$6,1)` };
    cells[`F${r}`] = { f: letterFormula(r, '>=') };
  }
  const range = `E${GRADE_FIRST_ROW}:E${GRADE_LAST_ROW}`;
  cells[`E${GRADE_LAST_ROW + 2}`] = { f: `AVERAGE(${range})`, z: '0.0' };
  cells[`E${GRADE_LAST_ROW + 3}`] = { f: `MAX(${range})` };
  cells[`E${GRADE_LAST_ROW + 4}`] = { f: `COUNTIF(${range},">=60")` };
  return cells;
}

function gradeCalculator(cells: Record<string, CellSpec | undefined>): Buffer {
  return save([{ name: 'Grades', cells, merges: ['A1:F1'], colWidths: [24, 11, 11, 11, 10, 8] }]);
}

/** Cells the autograder checks with the starter attached (all formula cells). */
export const GRADE_CALCULATOR_GRADED_CELLS = GRADE_STUDENTS.length * 2 + 3;

export function gradeCalculatorKey(): Buffer {
  return gradeCalculator({ ...gradeCalculatorBase(), ...gradeCalculatorAnswers() });
}

export function gradeCalculatorTemplate(): Buffer {
  return gradeCalculator(gradeCalculatorBase());
}

/** Two mistakes: letter cut-offs use > instead of >= (Sofia's 90.0 becomes a B), and the average is typed in. */
export function gradeCalculatorSubmission(): Buffer {
  const cells: Record<string, CellSpec | undefined> = { ...gradeCalculatorBase(), ...gradeCalculatorAnswers() };
  for (let r = GRADE_FIRST_ROW; r <= GRADE_LAST_ROW; r += 1) cells[`F${r}`] = { f: letterFormula(r, '>') };
  cells[`E${GRADE_LAST_ROW + 2}`] = { v: 80.53, z: '0.0' };
  return gradeCalculator(cells);
}

/* ------------------------------------------------------------------ */
/* Cell References Warm-up (second class)                             */
/* ------------------------------------------------------------------ */

export const PRICE_LIST = {
  title: 'Cell References Warm-up',
  description:
    'Finish the school-supplies price list: Subtotal = Price × Qty, Tax = Subtotal × the tax rate, ' +
    'Total = Subtotal + Tax, plus the order totals. Refer to the tax rate in B2 with an absolute reference so ' +
    'your formulas can be filled down.',
};

const ITEMS: [string, number, number][] = [
  ['Notebook', 3.49, 4],
  ['Pencils (12-pack)', 5.99, 2],
  ['Backpack', 34.95, 1],
  ['Calculator', 18.75, 1],
  ['Highlighters', 4.25, 3],
];

const ITEM_FIRST_ROW = 5;
const ITEM_LAST_ROW = ITEM_FIRST_ROW + ITEMS.length - 1;

function priceListBase(): Record<string, CellSpec | undefined> {
  const cells: Record<string, CellSpec | undefined> = {
    A1: 'Price List with Sales Tax',
    A2: 'Sales tax rate',
    B2: { v: 0.0825, z: '0.00%' },
    A4: 'Item',
    B4: 'Price',
    C4: 'Qty',
    D4: 'Subtotal',
    E4: 'Tax',
    F4: 'Total',
    [`A${ITEM_LAST_ROW + 1}`]: 'Order total',
  };
  ITEMS.forEach(([item, price, qty], i) => {
    const r = ITEM_FIRST_ROW + i;
    cells[`A${r}`] = item;
    cells[`B${r}`] = { v: price, z: MONEY };
    cells[`C${r}`] = qty;
  });
  return cells;
}

/** `taxRef` is how the tax rate is referenced: the key uses $B$2, a student might use B$2. */
function priceListAnswers(taxRef = '$B$2'): Record<string, CellSpec> {
  const cells: Record<string, CellSpec> = {};
  const money = (f: string): CellSpec => ({ f, z: MONEY });
  for (let r = ITEM_FIRST_ROW; r <= ITEM_LAST_ROW; r += 1) {
    cells[`D${r}`] = money(`B${r}*C${r}`);
    cells[`E${r}`] = money(`D${r}*${taxRef}`);
    cells[`F${r}`] = money(`D${r}+E${r}`);
  }
  const totalRow = ITEM_LAST_ROW + 1;
  for (const col of 'DEF') cells[`${col}${totalRow}`] = money(`SUM(${col}${ITEM_FIRST_ROW}:${col}${ITEM_LAST_ROW})`);
  return cells;
}

function priceList(cells: Record<string, CellSpec | undefined>): Buffer {
  return save([{ name: 'Price List', cells, merges: ['A1:F1'], colWidths: [20, 10, 6, 11, 9, 11] }]);
}

export function priceListKey(): Buffer {
  return priceList({ ...priceListBase(), ...priceListAnswers() });
}

export function priceListTemplate(): Buffer {
  return priceList(priceListBase());
}

/** Every answer right, with a mixed reference (B$2) for the tax rate. */
export function priceListSubmission(): Buffer {
  return priceList({ ...priceListBase(), ...priceListAnswers('B$2') });
}
