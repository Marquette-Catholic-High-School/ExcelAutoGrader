import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import * as XLSX from 'xlsx';
import { buildWorkbook } from './fixtures.js';
import { gradeWorkbook, parseWorkbookForViewer, previewKey } from './index.js';
import { parseWorkbookBuffer } from './read.js';
import { needsRecalculation, recalculateMissingValues } from './recalc.js';
import { config, rewriteXlsxPart, writeTemp } from './testing.js';

const MB = 1024 * 1024;

function workbook(sheets: Record<string, XLSX.WorkSheet>, props: XLSX.WorkBook['Workbook'] = undefined): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  for (const [name, ws] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, ws, name);
  if (props) wb.Workbook = props;
  return wb;
}

/** As written by XlsxWriter: every formula result stored as 0, and Excel asked to recalculate everything. */
const FULL_CALC = { CalcPr: { fullCalcOnLoad: '1' } } as unknown as XLSX.WorkBook['Workbook'];

function csvValue(csv: string, address: string): unknown {
  const loaded = parseWorkbookBuffer(Buffer.from(csv), '.csv');
  return loaded.wb.Sheets[loaded.wb.SheetNames[0]][address]?.v;
}

const READ = { type: 'buffer', cellFormula: true, cellDates: false, cellNF: true, cellText: true, sheetStubs: true } as const;

const SHEETS = [
  {
    name: 'Prices',
    rows: [
      ['Item', 'Qty', 'Price', 'Total'],
      ['Pens', 4, { v: 1.25, z: '"$"#,##0.00' }, { f: 'B2*C2', z: '"$"#,##0.00' }],
      ['Code', '007', 2, { f: 'A3&"-"&B3' }],
      [null, null, 'Sum', { f: 'SUM(D2:D2)' }],
    ],
  },
  { name: 'My Totals', rows: [[{ f: "Prices!D4*2" }, { f: "'My Totals'!A1/0" }, { f: 'IF(Prices!B2>3,TRUE,FALSE)' }]] },
];

describe('recalculation of formulas saved without results', () => {
  test('fixtures really write no cached value when v is omitted', () => {
    const wb = XLSX.read(buildWorkbook(SHEETS), READ);
    const cell = wb.Sheets.Prices.D2;
    assert.equal(cell.f, 'B2*C2');
    assert.equal(cell.v, undefined);
    assert.equal(needsRecalculation(wb), true);
  });

  test('fills in values, types and formatted text', () => {
    const wb = XLSX.read(buildWorkbook(SHEETS), READ);
    const result = recalculateMissingValues(wb);
    assert.deepEqual(result, { missing: 6, recalculated: 6, unsupported: 0, failure: null });
    assert.equal(wb.Sheets.Prices.D2.v, 5);
    assert.equal(wb.Sheets.Prices.D2.w, '$5.00');
    // Text stays text: "007" is not turned into the number 7.
    assert.equal(wb.Sheets.Prices.D3.v, 'Code-007');
    assert.equal(wb.Sheets['My Totals'].A1.v, 10);
    assert.equal(wb.Sheets['My Totals'].B1.t, 'e');
    assert.equal(wb.Sheets['My Totals'].B1.w, '#DIV/0!');
    assert.equal(wb.Sheets['My Totals'].C1.v, true);
    assert.equal(needsRecalculation(wb), false);
  });

  test('returns null and touches nothing when every formula has a result', () => {
    const wb = XLSX.read(buildWorkbook(SHEETS, 'xlsx', { calculate: true }), READ);
    assert.equal(recalculateMissingValues(wb), null);
  });

  test('a key without cached results grades like one saved by Excel', () => {
    const keyPath = writeTemp('no-cache-key.xlsx', buildWorkbook(SHEETS));
    const studentPath = writeTemp('cached-student.xlsx', buildWorkbook(SHEETS, 'xlsx', { calculate: true }));
    const report = gradeWorkbook({ keyPath, studentPath, config: config({ scope: 'formulas' }) });
    assert.equal(report.total, 6);
    assert.equal(report.correct, 6);
    assert.deepEqual(report.warnings, []);
    const expected = report.sheets.flatMap((s) => s.cells.map((c) => c.expected));
    assert.deepEqual(expected, [5, 'Code-007', 5, 10, '#DIV/0!', true]);

    // And the other way round: a student file written by a script.
    const reverse = gradeWorkbook({ keyPath: studentPath, studentPath: keyPath, config: config({ scope: 'formulas' }) });
    assert.equal(reverse.correct, 6);
  });

  test('formula cells with an empty <v> (openpyxl and similar) are kept and recalculated', () => {
    const base = buildWorkbook([{ name: 'S', rows: [[1, 2, { f: 'A1+B1', v: 3 }]] }]);
    const openpyxlStyle = rewriteXlsxPart(base, 'xl/worksheets/sheet1.xml', (xml) =>
      xml.replace(/<c r="C1"[^>]*>.*?<\/c>/, '<c r="C1"><f>A1+B1</f><v></v></c>'),
    );
    const viewer = parseWorkbookForViewer(writeTemp('openpyxl.xlsx', openpyxlStyle), 'openpyxl.xlsx');
    assert.deepEqual(viewer.sheets[0].cells.C1, { v: 3, t: 'n', w: '3', f: 'A1+B1' });
  });

  test('CSV "=..." cells are evaluated', () => {
    const csv = writeTemp('formulas.csv', 'a,b,sum\n2,3,=A2+B2\n');
    const viewer = parseWorkbookForViewer(csv, 'formulas.csv');
    assert.deepEqual(viewer.sheets[0].cells.C2, { v: 5, t: 'n', w: '5', f: 'A2+B2' });
  });

  test('defined names are understood', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, { A1: { t: 'n', v: 0.25 }, A2: { t: 'n', f: '100*Rate' }, '!ref': 'A1:A2' }, 'S');
    wb.Workbook = { Names: [{ Name: 'Rate', Ref: 'S!$A$1' }] };
    recalculateMissingValues(wb);
    assert.equal(wb.Sheets.S.A2.v, 25);
  });

  test('unknown functions produce #NAME? and a warning', () => {
    const keyPath = writeTemp('unknown-fn.xlsx', buildWorkbook([{ name: 'S', rows: [[{ f: 'NOTAFUNCTION(1)' }, 5]] }]));
    const report = gradeWorkbook({ keyPath, studentPath: keyPath, config: config() });
    assert.equal(report.sheets[0].cells[0].expected, '#NAME?');
    assert.ok(report.warnings.some((w) => w.startsWith("1 formula in the answer key uses a function the autograder can't")));
  });
});

describe('recalculation work is bounded', () => {
  test('a few far-away cells do not make it allocate the whole used area', () => {
    const ws: XLSX.WorkSheet = { A1: { t: 'n', f: '1+1' } };
    for (let r = 2; r <= 20_001; r += 1) ws[`XFD${r}`] = { t: 'n', v: r };
    ws['!ref'] = 'A1:XFD20001';
    const wb = workbook({ S: ws });
    const before = process.memoryUsage().heapUsed;
    const result = recalculateMissingValues(wb);
    const grown = process.memoryUsage().heapUsed - before;
    assert.deepEqual(result, { missing: 1, recalculated: 0, unsupported: 0, failure: 'too_large' });
    assert.ok(grown < 100 * MB, `heap grew by ${Math.round(grown / MB)} MB`);
  });

  test('huge ranges in a tiny file are cut back to the used area', () => {
    const cases: [string, number][] = [
      ['=SUM(A3:XFD1048576)', 0],
      ['=SUM(A3:Z1048576)', 0],
      ['=SUM(A:A)', 12],
      ['=SUM($A$1:$A$1048576)', 12],
      ['=SUM(2:2)', 7],
    ];
    for (const [formula, expected] of cases) {
      const rss = process.memoryUsage().rss;
      const started = Date.now();
      assert.equal(csvValue(`5,${formula}\n7,x\n`, 'B1'), expected, formula);
      const ms = Date.now() - started;
      const grown = process.memoryUsage().rss - rss;
      assert.ok(ms < 2000, `${formula} took ${ms} ms`);
      assert.ok(grown < 200 * MB, `${formula}: RSS grew by ${Math.round(grown / MB)} MB`);
    }
  });

  test('cutting ranges back keeps the results of aggregates and lookups', () => {
    const csv = [
      '1,=SUM(A1:A1048576),=AVERAGE(A:A),=MAX(A1:A100000),=COUNT(A:A)',
      '2,"=VLOOKUP(2,A:A,1,FALSE)","=MATCH(3,A:A,0)","=SUMIF(A:A,"">1"")","=INDEX(A:A,3)"',
      // Small ranges past the data are evaluated as written, so blanks and rows are counted exactly.
      '3,=COUNTBLANK(A1:A10),=ROWS(A1:A20)',
    ].join('\n');
    const loaded = parseWorkbookBuffer(Buffer.from(csv), '.csv');
    const ws = loaded.wb.Sheets.Sheet1;
    assert.deepEqual(
      ['B1', 'C1', 'D1', 'E1', 'B2', 'C2', 'D2', 'E2', 'B3', 'C3'].map((a) => ws[a].v),
      [6, 2, 3, 3, 2, 3, 5, 3, 7, 20],
    );
    assert.equal(loaded.recalc?.failure, null);
  });

  test('references to other sheets are cut back the same way, keeping same-shaped ranges alike', () => {
    const long: XLSX.WorkSheet = { '!ref': 'A1:A50' };
    for (let r = 1; r <= 50; r += 1) long[`A${r}`] = { t: 'n', v: r };
    const short: XLSX.WorkSheet = {
      A1: { t: 'n', v: 2 },
      A2: { t: 'n', v: 3 },
      B1: { t: 'n', f: 'SUM(Long!A:A)' },
      B2: { t: 'n', f: "COUNT('long'!$A$1:$A$1048576)" },
      B3: { t: 'n', f: 'SUMPRODUCT(A1:A1048576,Long!A1:A1048576)' },
      '!ref': 'A1:B3',
    };
    assert.equal(recalculateMissingValues(workbook({ Short: short, Long: long }))?.failure, null);
    assert.deepEqual([short.B1.v, short.B2.v, short.B3.v], [1275, 50, 2 * 1 + 3 * 2]);
  });

  test('running totals stay within the budget', () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `${i + 1},=SUM($A$1:A${i + 1})`);
    const loaded = parseWorkbookBuffer(Buffer.from(lines.join('\n')), '.csv');
    assert.equal(loaded.recalc?.failure, null);
    assert.equal(loaded.wb.Sheets.Sheet1.B3000.v, (3000 * 3001) / 2);
  });

  test('arrays of literal size that would not fit are not built', () => {
    for (const formula of ['=SUM(SEQUENCE(1048576,16384))', '=SUM(OFFSET(A1,0,0,1048576,16384))', '=SUM(MUNIT(100000))']) {
      const started = Date.now();
      const loaded = parseWorkbookBuffer(Buffer.from(`1,"${formula}"\n`), '.csv');
      assert.equal(loaded.recalc?.failure, 'too_large', formula);
      assert.ok(Date.now() - started < 2000, formula);
    }
    assert.equal(csvValue('1,=SUM(SEQUENCE(4))\n', 'B1'), 10);
  });
});

describe('full recalculation (fullCalcOnLoad, as written by XlsxWriter / pandas)', () => {
  const rows = () => [
    ['Qty', 'Price', 'Total'],
    [2, 3, { f: 'A2*B2', v: 0 }],
    [4, 5, { f: 'A3*B3', v: 0 }],
  ];
  const withFullCalc = (xlsx: Buffer) =>
    rewriteXlsxPart(xlsx, 'xl/workbook.xml', (xml) => xml.replace('</workbook>', '<calcPr fullCalcOnLoad="1"/></workbook>'));

  test('formulas whose saved results are all 0 are recalculated', () => {
    const wb = XLSX.read(withFullCalc(buildWorkbook([{ name: 'S', rows: rows() }])), READ);
    assert.equal(needsRecalculation(wb), true);
    assert.deepEqual(recalculateMissingValues(wb), { missing: 2, recalculated: 2, unsupported: 0, failure: null });
    assert.equal(wb.Sheets.S.C2.v, 6);
    assert.equal(wb.Sheets.S.C3.v, 20);
  });

  test('such a key grades like one saved by Excel', () => {
    const keyPath = writeTemp('xlsxwriter-key.xlsx', withFullCalc(buildWorkbook([{ name: 'S', rows: rows() }])));
    const studentRows = rows().map((row) => row.map((cell) => (typeof cell === 'object' ? { f: cell.f } : cell)));
    const studentPath = writeTemp('student.xlsx', buildWorkbook([{ name: 'S', rows: studentRows }], 'xlsx', { calculate: true }));
    const report = gradeWorkbook({ keyPath, studentPath, config: config({ scope: 'formulas' }) });
    assert.deepEqual(report.sheets[0].cells.map((c) => [c.expected, c.correct]), [
      [6, true],
      [20, true],
    ]);
    assert.deepEqual(report.warnings, []);
    const preview = previewKey({ keyPath, config: config({ scope: 'formulas' }) });
    assert.equal(preview.totalCells, 2);
    assert.deepEqual(preview.warnings, []);
  });

  test('array formulas are recalculated into their whole range', () => {
    const ws: XLSX.WorkSheet = {
      B2: { t: 'n', v: 1 }, B3: { t: 'n', v: 2 }, B4: { t: 'n', v: 3 },
      C2: { t: 'n', v: 4 }, C3: { t: 'n', v: 5 }, C4: { t: 'n', v: 6 },
      D2: { t: 'n', v: 0, f: 'B2:B4*C2:C4', F: 'D2:D4' },
      D3: { t: 'n', v: 0, F: 'D2:D4' },
      D4: { t: 'n', v: 0, F: 'D2:D4' },
      '!ref': 'B2:D4',
    };
    assert.equal(recalculateMissingValues(workbook({ S: ws }, FULL_CALC))?.failure, null);
    assert.deepEqual([ws.D2.v, ws.D3.v, ws.D4.v], [4, 10, 18]);
  });

  test('unknown functions keep their saved result and are reported', () => {
    const ws: XLSX.WorkSheet = {
      A1: { t: 'n', v: 2 },
      B1: { t: 'n', v: 0, f: 'NOTAFUNCTION(A1)' },
      C1: { t: 'n', v: 0, f: 'A1*10' },
      '!ref': 'A1:C1',
    };
    assert.deepEqual(recalculateMissingValues(workbook({ S: ws }, FULL_CALC)), {
      missing: 2,
      recalculated: 2,
      unsupported: 1,
      failure: null,
    });
    assert.deepEqual([ws.B1.t, ws.B1.v, ws.C1.v], ['n', 0, 20]);
  });

  test('files with real saved results are left alone', () => {
    const ws: XLSX.WorkSheet = { A1: { t: 'n', v: 2 }, B1: { t: 'n', v: 0, f: 'A1-2' }, C1: { t: 'n', v: 5, f: 'A1*2' }, '!ref': 'A1:C1' };
    const wb = workbook({ S: ws }, FULL_CALC);
    assert.equal(needsRecalculation(wb), false);
    assert.equal(recalculateMissingValues(wb), null);
    assert.equal(ws.C1.v, 5);
  });
});
