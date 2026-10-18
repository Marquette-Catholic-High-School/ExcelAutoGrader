import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import * as XLSX from 'xlsx';
import type { CellResult, GradeReport } from '../../../shared/types.js';
import {
  MONTHLY_BUDGET,
  MONTHLY_BUDGET_VARIANTS,
  buildWorkbook,
  monthlyBudgetKey,
  monthlyBudgetSubmission,
  monthlyBudgetTemplate,
  type MonthlyBudgetVariant,
  type SheetSpec,
} from './fixtures.js';
import { WorkbookReadError, gradeWorkbook } from './index.js';
import { recalculateMissingValues } from './recalc.js';
import { config, writeTemp } from './testing.js';

const budgetKey = writeTemp('budget-key.xlsx', monthlyBudgetKey());
const budgetTemplate = writeTemp('budget-template.xlsx', monthlyBudgetTemplate());

function xlsx(name: string, sheets: SheetSpec[]): string {
  return writeTemp(`${name}.xlsx`, buildWorkbook(sheets, 'xlsx', { calculate: true }));
}

function cell(report: GradeReport, address: string, sheet?: string): CellResult {
  const found = report.sheets
    .filter((s) => !sheet || s.keySheet === sheet)
    .flatMap((s) => s.cells)
    .find((c) => c.address === address);
  assert.ok(found, `no result for ${address}`);
  return found;
}

describe('Monthly Budget sample', () => {
  for (const variant of Object.keys(MONTHLY_BUDGET_VARIANTS) as MonthlyBudgetVariant[]) {
    test(`${variant} submission scores as documented`, () => {
      const report = gradeWorkbook({
        keyPath: budgetKey,
        templatePath: budgetTemplate,
        studentPath: writeTemp(`${variant}.xlsx`, monthlyBudgetSubmission(variant)),
        config: config(),
      });
      assert.equal(report.total, MONTHLY_BUDGET.gradedCells);
      assert.equal(report.correct, MONTHLY_BUDGET_VARIANTS[variant].correct);
      assert.equal(report.fraction, report.correct / report.total);
      assert.equal(report.sheets.length, 1);
      assert.equal(report.sheets[0].keySheet, 'Budget');
    });
  }

  test('partial: reasons, values and formulas in the report', () => {
    const report = gradeWorkbook({
      keyPath: budgetKey,
      templatePath: budgetTemplate,
      studentPath: writeTemp('partial.xlsx', monthlyBudgetSubmission('partial')),
      config: config(),
    });
    const wrong = report.sheets[0].cells.filter((c) => !c.correct).map((c) => [c.address, c.reason]);
    assert.deepEqual(wrong, [
      ['D6', 'value_mismatch'],
      ['E12', 'value_mismatch'],
      ['C16', 'value_mismatch'],
      ['D16', 'value_mismatch'],
      ['E16', 'value_mismatch'],
      ['B18', 'empty'],
      ['C18', 'value_mismatch'],
    ]);
    assert.deepEqual(cell(report, 'D6'), {
      sheet: 'Budget',
      address: 'D6',
      correct: false,
      reason: 'value_mismatch',
      expected: 120,
      expectedFormula: 'C6-B6',
      expectedText: '$120.00',
      actual: -120,
      actualFormula: 'B6-C6',
      actualText: '-$120.00',
    });
    assert.deepEqual(cell(report, 'B18'), {
      sheet: 'Budget',
      address: 'B18',
      correct: false,
      reason: 'empty',
      expected: 900,
      expectedFormula: 'B7-B16',
      expectedText: '$900.00',
      actual: null,
    });
    const correct = cell(report, 'B7');
    assert.equal(correct.correct, true);
    assert.equal('reason' in correct, false);
  });

  test('hard-coded totals need formulas (unless the teacher allows typed values)', () => {
    const studentPath = writeTemp('typed.xlsx', monthlyBudgetSubmission('hardcoded'));
    const strict = gradeWorkbook({ keyPath: budgetKey, templatePath: budgetTemplate, studentPath, config: config() });
    const e16 = cell(strict, 'E16');
    assert.equal(e16.reason, 'formula_required');
    assert.equal(e16.actual, 0.7144);
    assert.equal(e16.actualText, '71.4%');
    assert.equal('actualFormula' in e16, false);
    assert.equal(strict.sheets[0].cells.filter((c) => c.reason === 'formula_required').length, 9);

    const lenient = gradeWorkbook({
      keyPath: budgetKey,
      templatePath: budgetTemplate,
      studentPath,
      config: config({ requireFormulas: false }),
    });
    assert.equal(lenient.correct, 23);
  });

  test('% of Income divided by the wrong total loses those cells (percentage-point tolerance)', () => {
    const wb = XLSX.read(monthlyBudgetKey(), { type: 'buffer', cellFormula: true, cellNF: true, cellText: true });
    for (let r = 11; r <= 15; r += 1) {
      const e = wb.Sheets.Budget[`E${r}`];
      e.f = `C${r}/$B$7`;
      delete e.v;
    }
    recalculateMissingValues(wb);
    const studentPath = writeTemp('wrong-ref.xlsx', XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer);
    const report = gradeWorkbook({ keyPath: budgetKey, templatePath: budgetTemplate, studentPath, config: config() });
    const wrong = report.sheets[0].cells.filter((c) => !c.correct);
    assert.deepEqual(wrong.map((c) => [c.address, c.reason]), [
      ['E11', 'value_mismatch'],
      ['E12', 'value_mismatch'],
      ['E13', 'value_mismatch'],
      ['E14', 'value_mismatch'],
      ['E15', 'value_mismatch'],
    ]);
    assert.deepEqual([wrong[0].expectedText, wrong[0].actualText], ['12.9%', '13.5%']);
  });

  test('typed-in constant formulas do not count as formulas', () => {
    const wb = XLSX.read(monthlyBudgetKey(), { type: 'buffer', cellFormula: true, cellNF: true, cellText: true });
    wb.Sheets.Budget.C16.f = '2693.25';
    wb.Sheets.Budget.C7.f = '3250+520';
    const studentPath = writeTemp('constant-formulas.xlsx', XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer);
    const report = gradeWorkbook({ keyPath: budgetKey, templatePath: budgetTemplate, studentPath, config: config() });
    assert.deepEqual(report.sheets[0].cells.filter((c) => !c.correct).map((c) => [c.address, c.reason]), [
      ['C7', 'formula_required'],
      ['C16', 'formula_required'],
    ]);
  });

  test('renamed sheet is compared by position with a warning', () => {
    const report = gradeWorkbook({
      keyPath: budgetKey,
      templatePath: budgetTemplate,
      studentPath: writeTemp('renamed.xlsx', monthlyBudgetSubmission('renamed')),
      config: config(),
    });
    assert.equal(report.sheets[0].studentSheet, 'Sheet1');
    assert.deepEqual(report.warnings, ['No sheet named "Budget" in the submission; compared with "Sheet1" instead.']);
  });

  test('without a template every filled-in cell is graded; the template file counts as an attempt', () => {
    const report = gradeWorkbook({ keyPath: budgetKey, studentPath: budgetTemplate, config: config() });
    assert.equal(report.total, 61);
    assert.equal(report.correct, 61 - 23);
    assert.equal(report.sheets[0].cells.filter((c) => c.reason === 'empty').length, 23);
  });

  test('excludeTemplateCells off ignores the template', () => {
    const report = gradeWorkbook({
      keyPath: budgetKey,
      templatePath: budgetTemplate,
      studentPath: budgetKey,
      config: config({ excludeTemplateCells: false }),
    });
    assert.equal(report.total, 61);
    assert.equal(report.correct, 61);
  });

  test('cells are reported row-major', () => {
    const report = gradeWorkbook({ keyPath: budgetKey, studentPath: budgetKey, config: config({ scope: 'formulas' }) });
    assert.deepEqual(
      report.sheets[0].cells.slice(0, 8).map((c) => c.address),
      ['D5', 'D6', 'B7', 'C7', 'D7', 'D10', 'E10', 'D11'],
    );
  });
});

describe('scopes', () => {
  const key = xlsx('scope-key', [
    { name: 'Data', rows: [['Item', 'Qty', 'Price', 'Total'], ['Pens', 2, 1.5, { f: 'B2*C2' }], ['Ink', 3, 4, { f: 'B3*C3' }]] },
    { name: 'Summary', rows: [['Grand total', { f: 'SUM(Data!D2:D3)' }], ['Note', '  ']] },
  ]);

  test("'all' grades every non-empty cell (whitespace-only text is empty)", () => {
    const report = gradeWorkbook({ keyPath: key, studentPath: key, config: config() });
    assert.equal(report.total, 15);
    assert.deepEqual(report.sheets.map((s) => [s.keySheet, s.total]), [
      ['Data', 12],
      ['Summary', 3],
    ]);
  });

  test("'formulas' grades formula cells only", () => {
    const report = gradeWorkbook({ keyPath: key, studentPath: key, config: config({ scope: 'formulas' }) });
    assert.deepEqual(report.sheets.flatMap((s) => s.cells.map((c) => `${c.sheet}!${c.address}`)), [
      'Data!D2',
      'Data!D3',
      'Summary!B1',
    ]);
  });

  test("'ranges': no prefix means the first sheet, names match case-insensitively, unknown sheets warn", () => {
    const report = gradeWorkbook({
      keyPath: key,
      studentPath: key,
      config: config({ scope: 'ranges', ranges: ['D1:D10', 'summary!$B$1', 'Totals!A1:B2', 'D2'] }),
    });
    assert.deepEqual(report.sheets.flatMap((s) => s.cells.map((c) => `${c.sheet}!${c.address}`)), [
      'Data!D1',
      'Data!D2',
      'Data!D3',
      'Summary!B1',
    ]);
    assert.deepEqual(report.warnings, [
      'The range "Totals!A1:B2" refers to a sheet named "Totals", which isn\'t in the answer key.',
    ]);
  });

  test('zero gradable cells → total 0, fraction 0, warning', () => {
    const report = gradeWorkbook({ keyPath: key, studentPath: key, config: config({ scope: 'ranges', ranges: ['Z99'] }) });
    assert.equal(report.total, 0);
    assert.equal(report.fraction, 0);
    assert.deepEqual(report.sheets, []);
    assert.ok(report.warnings.includes('The answer key has no gradable cells for this configuration.'));
  });
});

describe('sheet matching and odd submissions', () => {
  const key = xlsx('two-sheet-key', [
    { name: 'Budget', rows: [[1, { f: 'A1*2' }]] },
    { name: 'Totals', rows: [[{ f: 'Budget!B1+1' }]] },
  ]);

  test('missing sheet fails its cells; the other sheet falls back to position', () => {
    const student = xlsx('one-sheet', [{ name: 'Mine', rows: [[1, { f: 'A1+A1' }]] }]);
    const report = gradeWorkbook({ keyPath: key, studentPath: student, config: config() });
    assert.deepEqual(report.sheets.map((s) => [s.keySheet, s.studentSheet, s.correct, s.total]), [
      ['Budget', 'Mine', 2, 2],
      ['Totals', null, 0, 1],
    ]);
    assert.deepEqual(cell(report, 'A1', 'Totals'), {
      sheet: 'Totals',
      address: 'A1',
      correct: false,
      reason: 'missing_sheet',
      expected: 3,
      expectedFormula: 'Budget!B1+1',
      actual: null,
    });
    assert.deepEqual(report.warnings, [
      'No sheet named "Budget" in the submission; compared with "Mine" instead.',
      'The submission has no sheet named "Totals", so its 1 graded cell was marked incorrect.',
    ]);
  });

  test('sheets are matched by name ignoring case and order', () => {
    const student = xlsx('reordered', [
      { name: 'totals ', rows: [[{ f: 'Budget!B1+1' }]] },
      { name: 'BUDGET', rows: [[1, { f: 'A1*2' }]] },
    ]);
    const report = gradeWorkbook({ keyPath: key, studentPath: student, config: config() });
    assert.equal(report.correct, 3);
    assert.deepEqual(report.sheets.map((s) => s.studentSheet), ['BUDGET', 'totals ']);
    assert.deepEqual(report.warnings, []);
  });

  test('an empty workbook just fails every cell', () => {
    const report = gradeWorkbook({ keyPath: key, studentPath: xlsx('blank', [{ name: 'Sheet1', rows: [] }]), config: config() });
    assert.equal(report.correct, 0);
    assert.equal(report.total, 3);
  });

  test('error values compare by their text', () => {
    const errorKey = xlsx('err-key', [{ name: 'S', rows: [[0, { f: '1/A1' }, { f: 'NA()' }]] }]);
    const same = xlsx('err-same', [{ name: 'S', rows: [[0, { f: '5/A1' }, { f: 'NA()' }]] }]);
    const report = gradeWorkbook({ keyPath: errorKey, studentPath: same, config: config() });
    assert.equal(report.correct, 3);
    assert.equal(cell(report, 'B1').expected, '#DIV/0!');
    assert.equal(cell(report, 'C1').actual, '#N/A');
  });

  test('text, booleans and dates follow the comparison options', () => {
    const k = xlsx('mixed-key', [{ name: 'S', rows: [['Total Income', true, { v: 46311, z: 'm/d/yyyy' }, 0.25]] }]);
    const s = xlsx('mixed-student', [{ name: 'S', rows: [['  total  income ', 'TRUE', 46311, '25%']] }]);
    assert.equal(gradeWorkbook({ keyPath: k, studentPath: s, config: config() }).correct, 4);
    const strict = gradeWorkbook({ keyPath: k, studentPath: s, config: config({ caseSensitive: true }) });
    assert.equal(cell(strict, 'A1').reason, 'value_mismatch');
    assert.equal(cell(strict, 'A1').actual, '  total  income ');
  });

  test('a key sheet with nothing to grade does not take the place of the graded one', () => {
    const key = xlsx('instructions-key', [
      { name: 'Instructions', rows: [['Fill in the totals.']] },
      { name: 'Budget', rows: [[1, { f: 'A1*2' }, { f: 'B1+1' }]] },
    ]);
    const csv = writeTemp('budget.csv', '1,=A1*2,=B1+1\n');
    const fromCsv = gradeWorkbook({ keyPath: key, studentPath: csv, config: config({ scope: 'formulas' }) });
    assert.deepEqual([fromCsv.correct, fromCsv.total], [2, 2]);
    assert.deepEqual(fromCsv.warnings, ['No sheet named "Budget" in the submission; compared with "Sheet1" instead.']);

    const renamed = xlsx('my-budget', [{ name: 'My Budget', rows: [[1, { f: 'A1*2' }, { f: 'B1+1' }]] }]);
    const report = gradeWorkbook({ keyPath: key, studentPath: renamed, config: config({ scope: 'formulas' }) });
    assert.deepEqual([report.correct, report.total, report.sheets[0].studentSheet], [2, 2, 'My Budget']);
  });

  test('numeric tolerance', () => {
    const k = xlsx('tol-key', [{ name: 'S', rows: [[10, 3.14159]] }]);
    const s = xlsx('tol-student', [{ name: 'S', rows: [[10.4, 3.14]] }]);
    assert.equal(gradeWorkbook({ keyPath: k, studentPath: s, config: config() }).correct, 1);
    assert.equal(gradeWorkbook({ keyPath: k, studentPath: s, config: config({ numericTolerance: 0.5 }) }).correct, 2);
    assert.equal(gradeWorkbook({ keyPath: k, studentPath: s, config: config({ numericTolerance: 0 }) }).correct, 0);
  });
});

describe('template exclusion', () => {
  const key = xlsx('tpl-key', [
    {
      name: 'Sheet1',
      rows: [
        ['Given', 100, { f: 'B1*2' }, { f: 'B1+1' }],
        ['Answer', 5, { f: 'B2*2' }, 'typed'],
      ],
    },
  ]);

  test('skips cells the template already has (same value, and same formula when the key has one)', () => {
    const template = xlsx('tpl-template', [
      {
        name: 'Sheet1',
        rows: [
          // B1 same value → skipped; C1 same formula (spacing/$ ignored) → skipped; D1 different formula → graded.
          ['Given', 100, { f: '$B$1 * 2' }, { f: 'B1*1+1' }],
          // A2 differs in case/whitespace but compares equal → skipped; B2 is blank in the template → graded.
          [' answer ', null, null, 'other'],
        ],
      },
    ]);
    const report = gradeWorkbook({ keyPath: key, templatePath: template, studentPath: key, config: config() });
    assert.deepEqual(report.sheets[0].cells.map((c) => c.address), ['D1', 'B2', 'C2', 'D2']);
  });

  test('template values are compared in the key cell\'s display units', () => {
    const percentKey = xlsx('tpl-pct-key', [{ name: 'Sheet1', rows: [[{ v: 0.1293, z: '0.0%' }, { v: 0.5, z: '0%' }]] }]);
    const template = xlsx('tpl-pct', [{ name: 'Sheet1', rows: [[{ v: 0.1354, z: '0.0%' }, 0.50001]] }]);
    const report = gradeWorkbook({ keyPath: percentKey, templatePath: template, studentPath: percentKey, config: config() });
    // 12.9% is not the template's 13.5%, so it is graded; 50% matches 50.001%.
    assert.deepEqual(report.sheets[0].cells.map((c) => c.address), ['A1']);
  });

  test('template sheets are matched like submissions (by position when renamed)', () => {
    const template = xlsx('tpl-renamed', [{ name: 'Starter', rows: [['Given', 100]] }]);
    const report = gradeWorkbook({ keyPath: key, templatePath: template, studentPath: key, config: config() });
    assert.deepEqual(report.sheets[0].cells.map((c) => c.address), ['C1', 'D1', 'A2', 'B2', 'C2', 'D2']);
    // Template pairing problems are a setup concern and do not show up on student reports.
    assert.deepEqual(report.warnings, []);
  });
});

describe('CSV submissions and unreadable files', () => {
  const key = xlsx('csv-key', [{ name: 'Sheet1', rows: [['Qty', 'Total'], [3, { f: 'A2*2' }]] }]);

  test('CSV values are graded; formula cells need a workbook', () => {
    const csv = writeTemp('student.csv', 'Qty,Total\n3,6\n');
    const report = gradeWorkbook({ keyPath: key, studentPath: csv, config: config() });
    assert.equal(report.correct, 3);
    assert.equal(cell(report, 'B2').reason, 'formula_required');
    assert.ok(report.warnings.some((w) => w.startsWith("CSV files can't store formulas")));
    assert.equal(gradeWorkbook({ keyPath: key, studentPath: csv, config: config({ requireFormulas: false }) }).correct, 4);
  });

  test('unreadable submission throws WorkbookReadError with a friendly message', () => {
    const junk = writeTemp('junk.xlsx', Buffer.from([1, 2, 3, 0, 255, 254, 0, 9]));
    assert.throws(
      () => gradeWorkbook({ keyPath: key, studentPath: junk, config: config() }),
      (err: unknown) => err instanceof WorkbookReadError && /could not be opened as a spreadsheet/.test(err.message),
    );
  });

  test('an unreadable key or template names the file at fault', () => {
    const junk = writeTemp('junk-key.xlsx', 'not a workbook');
    assert.throws(
      () => gradeWorkbook({ keyPath: junk, studentPath: key, config: config() }),
      (err: unknown) => err instanceof WorkbookReadError && err.message.startsWith('Problem with the answer key: '),
    );
    assert.throws(
      () => gradeWorkbook({ keyPath: key, templatePath: junk, studentPath: key, config: config() }),
      (err: unknown) => err instanceof WorkbookReadError && err.message.startsWith('Problem with the starter template: '),
    );
  });
});

describe('display text in reports', () => {
  test('numbers carry the text the workbook shows', () => {
    const key = xlsx('text-key', [{ name: 'S', rows: [[{ v: 0.318, z: '0.0%' }, 46311, { v: 46311, z: 'm/d/yyyy' }, 5]] }]);
    const student = xlsx('text-student', [{ name: 'S', rows: [[{ v: 0.333, z: '0.0%' }, 46311, { v: 46311, z: 'm/d/yyyy' }]] }]);
    const report = gradeWorkbook({ keyPath: key, studentPath: student, config: config() });
    const a1 = cell(report, 'A1');
    assert.deepEqual([a1.expectedText, a1.actualText, a1.reason], ['31.8%', '33.3%', 'value_mismatch']);
    // General integers show as themselves: no text.
    assert.equal('expectedText' in cell(report, 'B1'), false);
    assert.equal('actualText' in cell(report, 'B1'), false);
    assert.deepEqual([cell(report, 'C1').expectedText, cell(report, 'C1').actualText], ['10/16/2026', '10/16/2026']);
    // Missing student cells have no text either.
    assert.equal('actualText' in cell(report, 'D1'), false);
  });
});

describe('large sheets', () => {
  const rows = (): SheetSpec['rows'] => {
    const out: SheetSpec['rows'] = [['Qty', 'Total']];
    for (let r = 2; r <= 1500; r += 1) out.push([r, { f: `A${r}*2` }]);
    return out;
  };

  test('a stray far-away cell in a submission does not cut it short', () => {
    const key = xlsx('long-key', [{ name: 'S', rows: rows() }]);
    const studentRows = rows();
    studentRows[1] = [...(studentRows[1] as []), ...new Array(197), 'note'];
    const student = xlsx('long-student', [{ name: 'S', rows: studentRows }]);
    const report = gradeWorkbook({ keyPath: key, studentPath: student, config: config({ scope: 'formulas' }) });
    assert.deepEqual([report.correct, report.total], [1499, 1499]);
    assert.deepEqual(report.warnings, []);
  });

  test('a large answer key is still only checked in its top-left area, with a warning', () => {
    const keyRows: SheetSpec['rows'] = [[1, { f: 'A1*2' }]];
    keyRows[24_999] = [];
    keyRows[24_999][9] = 'far away';
    const key = xlsx('large-key', [{ name: 'Big', rows: keyRows }]);
    const report = gradeWorkbook({ keyPath: key, studentPath: key, config: config() });
    assert.equal(report.total, 2);
    assert.deepEqual(report.warnings, [
      'Sheet "Big" in the answer key is very large, so only its first 1,000 rows and 100 columns (A1:CV1000) are checked.',
    ]);
  });
});

describe('volatile functions in the key', () => {
  const key = xlsx('volatile-key', [{ name: 'Sheet1', rows: [[46300, { f: 'TODAY()-A1', v: 10 }]] }]);

  test('a student formula with the same function is correct whatever its saved result', () => {
    const later = xlsx('volatile-later', [{ name: 'Sheet1', rows: [[46300, { f: 'TODAY()-A1', v: 13 }]] }]);
    const report = gradeWorkbook({ keyPath: key, studentPath: later, config: config() });
    assert.deepEqual([report.correct, report.total], [2, 2]);
    assert.deepEqual(report.warnings, [
      "1 cell in the answer key uses TODAY(), NOW() or RAND() (Sheet1!B1). Its saved result changes over time, so it counts as correct when the student's formula uses the same function.",
    ]);
  });

  test('typed values and other formulas do not get credit', () => {
    const typed = xlsx('volatile-typed', [{ name: 'Sheet1', rows: [[46300, 10]] }]);
    assert.equal(cell(gradeWorkbook({ keyPath: key, studentPath: typed, config: config() }), 'B1').reason, 'formula_required');
    const other = xlsx('volatile-other', [{ name: 'Sheet1', rows: [[46300, { f: 'A1+3', v: 10 }]] }]);
    assert.equal(cell(gradeWorkbook({ keyPath: key, studentPath: other, config: config() }), 'B1').reason, 'value_mismatch');
  });
});
