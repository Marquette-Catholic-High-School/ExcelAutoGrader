import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildWorkbook, monthlyBudgetKey, type SheetSpec } from './fixtures.js';
import { parseWorkbookForViewer } from './index.js';
import { writeTemp } from './testing.js';

const view = (sheets: SheetSpec[], name = 'book.xlsx') =>
  parseWorkbookForViewer(writeTemp(name, buildWorkbook(sheets, 'xlsx', { calculate: true })), name);

describe('parseWorkbookForViewer', () => {
  test('Monthly Budget key: formatted text, formulas, merges, widths', () => {
    const data = parseWorkbookForViewer(writeTemp('key.xlsx', monthlyBudgetKey()), 'Monthly Budget - Answer Key.xlsx');
    assert.equal(data.fileName, 'Monthly Budget - Answer Key.xlsx');
    assert.equal(data.sheets.length, 1);
    const sheet = data.sheets[0];
    assert.equal(sheet.name, 'Budget');
    assert.equal(sheet.rowCount, 18);
    assert.equal(sheet.colCount, 5);
    assert.equal(sheet.truncated, false);
    assert.deepEqual(sheet.merges, ['A1:E1', 'A2:E2']);
    assert.deepEqual(sheet.colWidths, [26, 14, 14, 14, 14]);
    assert.deepEqual(sheet.cells.A1, { v: 'Monthly Budget', t: 's' });
    assert.deepEqual(sheet.cells.B5, { v: 3200, t: 'n', w: '$3,200.00' });
    assert.deepEqual(sheet.cells.D5, { v: 50, t: 'n', w: '$50.00', f: 'C5-B5' });
    assert.equal(sheet.cells.E10.w, '31.8%');
    assert.equal(sheet.cells.E10.f, 'C10/$C$7');
    assert.equal(sheet.cells.A3, undefined);
  });

  test('dates stay serial numbers with formatted text; errors and booleans', () => {
    const data = view([
      {
        name: 'Mixed',
        rows: [[{ v: 46311, z: 'm/d/yyyy' }, { f: '1/0' }, true, { v: 0.25, z: '0%' }, '', { f: '_xlfn.CONCAT("a","b")' }]],
      },
    ]);
    const cells = data.sheets[0].cells;
    assert.deepEqual(cells.A1, { v: 46311, t: 'n', w: '10/16/2026' });
    assert.deepEqual(cells.B1, { v: '#DIV/0!', t: 'e', f: '1/0' });
    assert.deepEqual(cells.C1, { v: true, t: 'b', w: 'TRUE' });
    assert.deepEqual(cells.D1, { v: 0.25, t: 'n', w: '25%' });
    assert.equal(cells.E1, undefined);
    assert.equal(cells.F1.f, 'CONCAT("a","b")');
    assert.equal(cells.F1.v, 'ab');
  });

  test('cuts large sheets at 1000 rows x 100 columns', () => {
    const rows: SheetSpec['rows'] = [];
    rows[0] = ['top'];
    rows[1499] = ['bottom'];
    const tall = view([{ name: 'Tall', rows }]).sheets[0];
    assert.equal(tall.truncated, true);
    assert.equal(tall.rowCount, 1000);
    assert.equal(tall.colCount, 1);
    assert.deepEqual(Object.keys(tall.cells), ['A1']);

    const wideRow: SheetSpec['rows'][number] = [];
    wideRow[0] = 'left';
    wideRow[120] = 'right';
    const wide = view([{ name: 'Wide', rows: [wideRow] }]).sheets[0];
    assert.equal(wide.truncated, true);
    assert.equal(wide.colCount, 100);
    assert.deepEqual(Object.keys(wide.cells), ['A1']);
  });

  test('merges extend the rendered range and are clipped to the limit', () => {
    const sheet = view([{ name: 'S', rows: [['Title']], merges: ['A1:D2', 'A999:A1200'] }]).sheets[0];
    assert.deepEqual(sheet.merges, ['A1:D2', 'A999:A1000']);
    assert.equal(sheet.colCount, 4);
    assert.equal(sheet.rowCount, 1000);
    assert.equal(sheet.truncated, true);
  });

  test('empty sheets and missing widths', () => {
    const sheet = view([{ name: 'Empty', rows: [] }]).sheets[0];
    assert.deepEqual(sheet, { name: 'Empty', rowCount: 0, colCount: 0, truncated: false, cells: {}, merges: [] });
  });
});
