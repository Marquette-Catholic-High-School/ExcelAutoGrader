import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildWorkbook, monthlyBudgetKey, monthlyBudgetTemplate, type SheetSpec } from './fixtures.js';
import { previewKey } from './index.js';
import { config, writeTemp } from './testing.js';

const keyPath = writeTemp('budget-key.xlsx', monthlyBudgetKey());
const templatePath = writeTemp('budget-template.xlsx', monthlyBudgetTemplate());
const xlsx = (name: string, sheets: SheetSpec[]) => writeTemp(`${name}.xlsx`, buildWorkbook(sheets, 'xlsx', { calculate: true }));

describe('previewKey', () => {
  test('with the starter template only the formula cells are graded', () => {
    assert.deepEqual(previewKey({ keyPath, templatePath, config: config() }), {
      totalCells: 23,
      formulaCells: 23,
      sheets: [{ name: 'Budget', gradedCells: 23, sampleAddresses: ['D5', 'D6', 'B7', 'C7', 'D7', 'D10', 'E10', 'D11'] }],
      warnings: [],
    });
  });

  test('without a template every filled-in cell counts', () => {
    const preview = previewKey({ keyPath, templatePath: null, config: config() });
    assert.equal(preview.totalCells, 61);
    assert.equal(preview.formulaCells, 23);
    assert.deepEqual(preview.sheets[0].sampleAddresses, ['A1', 'A2', 'A4', 'B4', 'C4', 'D4', 'A5', 'B5']);
  });

  test('lists every key sheet, including ones with nothing graded', () => {
    const key = xlsx('multi', [
      { name: 'Work', rows: [[1, { f: 'A1+1' }]] },
      { name: 'Notes', rows: [['Read me']] },
    ]);
    const preview = previewKey({ keyPath: key, config: config({ scope: 'formulas' }) });
    assert.deepEqual(preview.sheets, [
      { name: 'Work', gradedCells: 1, sampleAddresses: ['B1'] },
      { name: 'Notes', gradedCells: 0, sampleAddresses: [] },
    ]);
  });

  test('warns about ranges on unknown sheets', () => {
    const preview = previewKey({ keyPath, config: config({ scope: 'ranges', ranges: ['E10:E16', 'Summary!A1'] }) });
    assert.equal(preview.totalCells, 7);
    assert.deepEqual(preview.warnings, [
      'The range "Summary!A1" refers to a sheet named "Summary", which isn\'t in the answer key.',
    ]);
  });

  test('explains why nothing would be graded', () => {
    const noFormulas = xlsx('values-only', [{ name: 'S', rows: [[1, 2]] }]);
    assert.deepEqual(previewKey({ keyPath: noFormulas, config: config({ scope: 'formulas' }) }).warnings, [
      'The answer key has no gradable cells for this configuration.',
      'The answer key has no formulas. Grade all filled-in cells instead, or add formulas to the key.',
    ]);

    const sameAsTemplate = previewKey({ keyPath: templatePath, templatePath, config: config() });
    assert.equal(sameAsTemplate.totalCells, 0);
    assert.match(sameAsTemplate.warnings[1], /identical to the template/);

    const empty = xlsx('empty', [{ name: 'S', rows: [] }]);
    assert.deepEqual(previewKey({ keyPath: empty, config: config() }).warnings, [
      'The answer key has no gradable cells for this configuration.',
      'The answer key is empty.',
    ]);
  });

  test('warns when template sheets do not line up', () => {
    const template = xlsx('other-template', [{ name: 'Starter', rows: [['Monthly Budget']] }]);
    const preview = previewKey({ keyPath, templatePath: template, config: config() });
    assert.deepEqual(preview.warnings, ['The template has no sheet named "Budget"; compared it with "Starter" instead.']);
    assert.equal(preview.totalCells, 60);
  });

  test('warns about key cells whose saved result depends on when they were calculated', () => {
    const key = xlsx('volatile', [
      { name: 'Dates', rows: [[46300, { f: 'TODAY()-A1', v: 10 }, { f: 'NOW()', v: 46310.5 }, { f: 'A1+1' }]] },
      {
        name: 'Dice Rolls',
        rows: [[{ f: 'RANDBETWEEN(1,6)', v: 4 }, { f: 'RAND()', v: 0.5 }, { f: '_xlfn.RANDARRAY()', v: 0.2 }, { f: 'RAND()*2', v: 1 }]],
      },
    ]);
    const preview = previewKey({ keyPath: key, config: config() });
    assert.deepEqual(preview.warnings, [
      "6 cells in the answer key use TODAY(), NOW() or RAND() (Dates!B1, Dates!C1, 'Dice Rolls'!A1, 'Dice Rolls'!B1, " +
        "'Dice Rolls'!C1 and 1 more). Their saved results change over time, so they count as correct when the " +
        "student's formula uses the same function.",
    ]);
    // Only graded cells are listed.
    const ranges = previewKey({ keyPath: key, config: config({ scope: 'ranges', ranges: ['Dates!B1'] }) });
    assert.match(ranges.warnings[0], /^1 cell in the answer key uses TODAY\(\), NOW\(\) or RAND\(\) \(Dates!B1\)\. Its saved/);
  });

  test('large sheets are limited to the top-left 1000 x 100 cells', () => {
    const rows: SheetSpec['rows'] = [];
    rows[0] = [1, { f: 'A1*2' }];
    rows[24_999] = [];
    rows[24_999][9] = 'far away';
    const key = xlsx('large', [{ name: 'Big', rows }]);
    const preview = previewKey({ keyPath: key, config: config() });
    assert.equal(preview.totalCells, 2);
    assert.deepEqual(preview.warnings, [
      'Sheet "Big" in the answer key is very large, so only its first 1,000 rows and 100 columns (A1:CV1000) are checked.',
    ]);
  });
});
