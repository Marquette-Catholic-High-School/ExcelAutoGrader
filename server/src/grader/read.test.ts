import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import * as XLSX from 'xlsx';
import { isSemicolonDelimited, parseDecimalComma } from './csv.js';
import { MESSAGES } from './errors.js';
import { buildWorkbook, type SheetSpec } from './fixtures.js';
import { WorkbookReadError, assertReadableWorkbook, gradeWorkbook, parseWorkbookForViewer } from './index.js';
import { MAX_WORKBOOK_CELLS, assertCellCount } from './limits.js';
import { getModel, parseWorkbookBuffer } from './read.js';
import { config, handBuiltZip, writeTemp } from './testing.js';

const MB = 1024 * 1024;

function isTooLarge(err: unknown): boolean {
  return err instanceof WorkbookReadError && err.message === MESSAGES.tooLarge;
}

function writeBook(name: string, sheets: Record<string, XLSX.WorkSheet>, props?: XLSX.WorkBook['Workbook']): string {
  const wb = XLSX.utils.book_new();
  for (const [sheetName, ws] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, ws, sheetName);
  if (props) wb.Workbook = props;
  return writeTemp(name, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer);
}

const SHEET: SheetSpec = {
  name: 'Budget',
  rows: [
    ['Item', 'Amount', 'Paid'],
    ['Café', 12.5, true],
    ['Rent', 1200, false],
  ],
};

function readError(filePath: string): string {
  try {
    assertReadableWorkbook(filePath);
  } catch (err) {
    assert.ok(err instanceof WorkbookReadError, `expected WorkbookReadError, got ${String(err)}`);
    return err.message;
  }
  assert.fail('expected the file to be rejected');
}

describe('file formats', () => {
  for (const bookType of ['xlsx', 'xls', 'ods', 'csv'] as const) {
    test(`${bookType} round-trip`, () => {
      const file = writeTemp(`book.${bookType}`, buildWorkbook([SHEET], bookType));
      assertReadableWorkbook(file);
      const sheet = parseWorkbookForViewer(file, path.basename(file)).sheets[0];
      assert.equal(sheet.name, bookType === 'csv' ? 'Sheet1' : 'Budget');
      assert.equal(sheet.cells.A2.v, 'Café');
      assert.equal(sheet.cells.B3.v, 1200);
      assert.equal(sheet.cells.C2.v, true);
      assert.equal(sheet.rowCount, 3);
      assert.equal(sheet.colCount, 3);
    });
  }

  test('xls submissions grade against an xlsx key (values; .xls from the writer has no formulas)', () => {
    const key = writeTemp('key.xlsx', buildWorkbook([SHEET]));
    const student = writeTemp('student.xls', buildWorkbook([SHEET], 'xls'));
    assert.equal(gradeWorkbook({ keyPath: key, studentPath: student, config: config() }).correct, 9);
  });

  test('UTF-8 CSV without a BOM keeps accents and symbols', () => {
    const csv = writeTemp('accents.csv', 'Name,Note\nCafé,€5 déjà vu\n');
    const cells = parseWorkbookForViewer(csv, 'accents.csv').sheets[0].cells;
    assert.equal(cells.A2.v, 'Café');
    assert.equal(cells.B2.v, '€5 déjà vu');
  });

  test('CSV numbers, percents and dates are parsed like Excel', () => {
    const csv = writeTemp('values.csv', 'Total,Share,Due\n"$1,234.50",25%,10/16/2026\n');
    const cells = parseWorkbookForViewer(csv, 'values.csv').sheets[0].cells;
    assert.equal(cells.A2.v, 1234.5);
    assert.equal(cells.B2.v, 0.25);
    assert.equal(cells.C2.v, 46311);
    assert.equal(cells.C2.w, '10/16/2026');
  });
});

describe('unreadable files', () => {
  const UNREADABLE = 'This file could not be opened as a spreadsheet. Save it as .xlsx and try again.';

  test('binary junk', () => {
    assert.equal(readError(writeTemp('junk.xlsx', Buffer.from([0x13, 0x37, 0x00, 0xff, 0x10, 0x00]))), UNREADABLE);
    assert.equal(readError(writeTemp('junk.xls', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))), UNREADABLE);
    assert.equal(readError(writeTemp('doc.csv', '%PDF-1.7\n%âãÏÓ\n1 0 obj')), UNREADABLE);
  });

  test('corrupt zip', () => {
    assert.equal(readError(writeTemp('broken.xlsx', Buffer.from('PK\x03\x04 this is not really a zip'))), UNREADABLE);
    const truncated = buildWorkbook([SHEET]).subarray(0, 400);
    assert.equal(readError(writeTemp('truncated.xlsx', truncated)), UNREADABLE);
  });

  test('text renamed to .xlsx', () => {
    assert.match(readError(writeTemp('notes.xlsx', 'Item,Amount\nRent,1200\n')), /^This file is not a valid \.xlsx workbook/);
  });

  test('empty and missing files', () => {
    assert.equal(readError(writeTemp('empty.xlsx', Buffer.alloc(0))), 'This file is empty. Save your workbook as .xlsx and upload it again.');
    assert.equal(readError(path.join(path.dirname(writeTemp('x.txt', 'x')), 'does-not-exist.xlsx')), 'This file is missing from the server. Upload it again.');
  });

  test('viewer and grader reject the same files', () => {
    const junk = writeTemp('junk2.xlsx', Buffer.from([0, 1, 2, 3]));
    assert.throws(() => parseWorkbookForViewer(junk, 'junk2.xlsx'), WorkbookReadError);
  });
});

describe('size limits', () => {
  test('a zip whose directory declares huge sheet XML is rejected without inflating it', () => {
    // The deflated data is tiny; only the declared size is large.
    const zip = handBuiltZip('xl/worksheets/sheet1.xml', Buffer.from('<worksheet/>'), { declaredSize: 200 * MB });
    assert.throws(() => parseWorkbookBuffer(zip, '.xlsx'), isTooLarge);
    const zip64 = handBuiltZip('xl/sharedStrings.xml', Buffer.from('<sst/>'), { declaredSize: 0xffffffff });
    assert.throws(() => parseWorkbookBuffer(zip64, '.xlsx'), isTooLarge);
    const ods = handBuiltZip('content.xml', Buffer.from('<x/>'), { declaredSize: 150 * MB });
    assert.throws(() => parseWorkbookBuffer(ods, '.ods'), isTooLarge);
  });

  test('all parts of a zip together are limited too', () => {
    const zip = handBuiltZip('xl/media/image1.png', Buffer.from('png'), { declaredSize: 300 * MB });
    assert.throws(() => parseWorkbookBuffer(zip, '.xlsx'), isTooLarge);
  });

  test('parts without a size in their local header are measured, with a cap', () => {
    const bomb = handBuiltZip('xl/worksheets/sheet1.xml', Buffer.alloc(101 * MB, 0x20), { streamed: true, declaredSize: 1000 });
    assert.ok(bomb.length < MB);
    assert.throws(() => parseWorkbookBuffer(bomb, '.xlsx'), isTooLarge);
  });

  test('small zips pass the check (this one is no workbook, so it is unreadable)', () => {
    const zip = handBuiltZip('xl/worksheets/sheet1.xml', Buffer.from('<worksheet/>'));
    assert.throws(
      () => parseWorkbookBuffer(zip, '.xlsx'),
      (err: unknown) => err instanceof WorkbookReadError && !isTooLarge(err),
    );
    assert.doesNotThrow(() => parseWorkbookBuffer(buildWorkbook([SHEET]), '.xlsx'));
  });

  test('text files with more than 2,000,000 fields', () => {
    assert.throws(() => parseWorkbookBuffer(Buffer.alloc(MAX_WORKBOOK_CELLS + 1, ','), '.csv'), isTooLarge);
    assert.throws(() => parseWorkbookBuffer(Buffer.alloc(MAX_WORKBOOK_CELLS + 1, '\n'), '.csv'), isTooLarge);
  });

  test('parsed workbooks with more than 2,000,000 cells', () => {
    const ws: XLSX.WorkSheet = { '!ref': 'A1:A700000' };
    const cell: XLSX.CellObject = { t: 'n', v: 1 };
    for (let r = 1; r <= 700_000; r += 1) ws[`A${r}`] = cell;
    assert.doesNotThrow(() => assertCellCount({ SheetNames: ['S1', 'S2'], Sheets: { S1: ws, S2: ws } }));
    assert.throws(() => assertCellCount({ SheetNames: ['S1', 'S2', 'S3'], Sheets: { S1: ws, S2: ws, S3: ws } }), isTooLarge);
  });
});

describe('semicolon-delimited CSV (European Excel)', () => {
  const cells = (csv: string) => parseWorkbookBuffer(Buffer.from(csv), '.csv').wb.Sheets.Sheet1;

  test('commas are decimal separators', () => {
    const ws = cells('Item;Qty;Price\nPens;2;1,50\n');
    assert.deepEqual([ws.A1.v, ws.B2.v, ws.C2.v, ws.C2.w], ['Item', 2, 1.5, '1,50']);
  });

  test('a "sep=;" first line is not a data row', () => {
    const ws = cells('sep=;\r\nItem;Qty;Price\r\nPens;2;1,50\r\n');
    assert.deepEqual([ws.A1.v, ws.C2.v], ['Item', 1.5]);
    assert.deepEqual([cells('sep=;\nPrice\n1,5\n').A2.v], [1.5]);
  });

  test('thousands, percentages, currency, quotes and formulas', () => {
    const ws = cells('Name;Total;Share;Paid;Double\n"Smith, J";1.234,5;12,5%;"1.234,50 €";=B2*2\nX;1 234;-0,25;Yes;\n');
    assert.deepEqual(
      ['A2', 'B2', 'C2', 'D2', 'E2', 'B3', 'C3', 'D3'].map((a) => ws[a].v),
      ['Smith, J', 1234.5, 0.125, 1234.5, 2469, 1234, -0.25, 'Yes'],
    );
    assert.equal(ws.E2.f, 'B2*2');
  });

  test('comma-delimited files are unchanged', () => {
    const ws = cells('Total,Note,Count\n"1,234.50",ok,"1,5"\n');
    assert.deepEqual([ws.A2.v, ws.B2.v, ws.C2.v], [1234.5, 'ok', 15]);
  });

  test('grading a semicolon CSV against a workbook', () => {
    const key = writeTemp('eu-key.xlsx', buildWorkbook([{ name: 'Sheet1', rows: [['Item', 'Price'], ['Pens', 1.5]] }]));
    const csv = writeTemp('eu.csv', 'Item;Price\nPens;1,50\n');
    assert.equal(gradeWorkbook({ keyPath: key, studentPath: csv, config: config() }).correct, 4);
  });

  test('delimiter sniffing and decimal-comma numbers', () => {
    assert.equal(isSemicolonDelimited(Buffer.from('a;b;c\n1,5;2;3')), true);
    assert.equal(isSemicolonDelimited(Buffer.from('\n\n"x;y;z",b\n')), false);
    assert.equal(isSemicolonDelimited(Buffer.from('a;b\tc\n')), false);
    assert.equal(isSemicolonDelimited(Buffer.from('sep=,\na;b;c\n')), false);
    assert.equal(isSemicolonDelimited(Buffer.from('<table><tr><td>a;b</td></tr></table>')), false);
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a;b\n1,5;2\n', 'utf16le')]);
    assert.equal(isSemicolonDelimited(utf16), true);
    assert.equal(parseDecimalComma('1.234.567,89'), 1234567.89);
    assert.equal(parseDecimalComma('+3'), 3);
    assert.equal(parseDecimalComma('1,2,3'), null);
    assert.equal(parseDecimalComma('12.34'), null);
    assert.equal(parseDecimalComma('abc'), null);
  });
});

describe('cells filled by array formulas', () => {
  const values = (): XLSX.WorkSheet => ({
    A1: { t: 's', v: 'Qty' },
    B1: { t: 's', v: 'Price' },
    D1: { t: 's', v: 'Total' },
    B2: { t: 'n', v: 1 },
    B3: { t: 'n', v: 2 },
    B4: { t: 'n', v: 3 },
    C2: { t: 'n', v: 4 },
    C3: { t: 'n', v: 5 },
    C4: { t: 'n', v: 6 },
    '!ref': 'A1:D4',
  });
  /** D2:D4 = B2:B4*C2:C4 as one array formula (CSE, or a dynamic-array spill). */
  const arrayBook = (name: string, dynamic: boolean) => {
    const ws = values();
    ws.D2 = { t: 'n', v: 4, f: 'B2:B4*C2:C4', F: 'D2:D4', ...(dynamic ? { D: true } : {}) };
    ws.D3 = { t: 'n', v: 10, F: 'D2:D4' };
    ws.D4 = { t: 'n', v: 18, F: 'D2:D4' };
    return writeBook(name, { S: ws });
  };
  const cellByCell = () => {
    const ws = values();
    for (const r of [2, 3, 4]) ws[`D${r}`] = { t: 'n', v: [4, 10, 18][r - 2], f: `B${r}*C${r}` };
    return writeBook('cell-by-cell.xlsx', { S: ws });
  };

  for (const dynamic of [false, true]) {
    const kind = dynamic ? 'dynamic array' : 'CSE array';
    test(`a ${kind} formula counts as a formula in every cell of a submission`, () => {
      const report = gradeWorkbook({ keyPath: cellByCell(), studentPath: arrayBook(`${kind}.xlsx`, dynamic), config: config({ scope: 'formulas' }) });
      assert.deepEqual([report.correct, report.total], [3, 3]);
      assert.deepEqual(report.sheets[0].cells.map((c) => c.actualFormula), ['B2:B4*C2:C4', 'B2:B4*C2:C4', 'B2:B4*C2:C4']);
    });

    test(`a ${kind} formula in the key grades every cell of its range`, () => {
      const report = gradeWorkbook({ keyPath: arrayBook(`key-${kind}.xlsx`, dynamic), studentPath: cellByCell(), config: config({ scope: 'formulas' }) });
      assert.deepEqual(report.sheets[0].cells.map((c) => [c.address, c.expected, c.correct]), [
        ['D2', 4, true],
        ['D3', 10, true],
        ['D4', 18, true],
      ]);
    });
  }

  test('their cached values are kept (nothing to recalculate)', () => {
    const loaded = parseWorkbookBuffer(fs.readFileSync(arrayBook('cached-array.xlsx', false)), '.xlsx');
    assert.equal(loaded.recalc, null);
    const cells = getModel(loaded, 'the answer key').sheets[0].cells;
    assert.deepEqual(['D2', 'D3', 'D4'].map((a) => [cells.get(a)?.value, cells.get(a)?.missingValue]), [
      [4, false],
      [10, false],
      [18, false],
    ]);
  });
});

describe('1904 date system', () => {
  const DATE = 'm/d/yyyy';
  const sheet = (date: number): XLSX.WorkSheet => ({
    A1: { t: 's', v: 'Due' },
    B1: { t: 'n', v: date, z: DATE },
    B2: { t: 'n', v: 30 },
    B3: { t: 'n', v: 0.375, z: 'h:mm' },
    '!ref': 'A1:B3',
  });
  const book1900 = writeBook('dates-1900.xlsx', { S: sheet(46311) });
  const book1904 = writeBook('dates-1904.xlsx', { S: sheet(44849) }, { WBProps: { date1904: true } });

  test('the same date matches across date systems; plain numbers and times are not shifted', () => {
    for (const [keyPath, studentPath] of [
      [book1900, book1904],
      [book1904, book1900],
    ]) {
      const report = gradeWorkbook({ keyPath, studentPath, config: config({ numericTolerance: 0 }) });
      assert.deepEqual([report.correct, report.total], [4, 4]);
    }
    const report = gradeWorkbook({ keyPath: book1904, studentPath: book1904, config: config() });
    const b1 = report.sheets[0].cells.find((c) => c.address === 'B1');
    assert.deepEqual([b1?.expected, b1?.expectedText], [46311, '10/16/2026']);
  });

  test('grading models hold 1900-system serials; the display text is kept', () => {
    const cells = getModel(parseWorkbookBuffer(fs.readFileSync(book1904), '.xlsx'), 'the submission').sheets[0].cells;
    assert.deepEqual(['B1', 'B2', 'B3'].map((a) => [cells.get(a)?.value, cells.get(a)?.text]), [
      [46311, '10/16/2026'],
      [30, undefined],
      [0.375, '9:00'],
    ]);
  });
});
