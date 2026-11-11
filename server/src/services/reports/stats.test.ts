import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { AssignmentSummary, CellResult, GradebookCell, SubmissionDetail } from '../../../../shared/types.js';
import { dateFormats, formatDuration, formatPercent, percentOf, reportTimeZone, truncate } from './format.js';
import {
  cellRef,
  classAverage,
  formatCellValue,
  gradeTotals,
  mostMissedCells,
  scoreDistribution,
  scoreStats,
  studentSummary,
  type SummaryRow,
} from './stats.js';

describe('score statistics', () => {
  test('average, median (odd and even counts), high and low', () => {
    assert.deepEqual(scoreStats([10, 30, 20]), { count: 3, average: 20, median: 20, high: 30, low: 10 });
    assert.deepEqual(scoreStats([4, 1, 3, 2]), { count: 4, average: 2.5, median: 2.5, high: 4, low: 1 });
    assert.equal(scoreStats([1, 2, 2])?.average, 5 / 3, 'not rounded: percentages are computed from it');
    // A 3-point assignment graded 1, 1 and 2: 44.4% like the app's gradebook, not 44.3% from a rounded 1.33.
    assert.equal(percentOf(scoreStats([1, 1, 2])!.average, 3), 44.4);
    assert.equal(scoreStats([]), null);
  });

  test('distribution in 10% bands; 100% and extra credit land in the top band', () => {
    const bands = scoreDistribution([0, 9.9, 10, 55, 89.9, 90, 100, 150], 100);
    assert.deepEqual(bands, [2, 1, 0, 0, 0, 1, 0, 0, 1, 3]);
    assert.deepEqual(scoreDistribution([5], 10), [0, 0, 0, 0, 0, 1, 0, 0, 0, 0]);
    assert.deepEqual(scoreDistribution([], 10), new Array(10).fill(0));
  });

  test('totals count scored work only', () => {
    const totals = gradeTotals([
      { finalScore: 8, points: 10 },
      { finalScore: null, points: 50 },
      { finalScore: 42.5, points: 50 },
    ]);
    assert.deepEqual(totals, { earned: 50.5, possible: 60, percent: 84.2, scored: 2 });
    const nothing = gradeTotals([{ finalScore: null, points: 10 }]);
    assert.deepEqual(nothing, { earned: 0, possible: 0, percent: null, scored: 0 });
  });
});

describe('student standing', () => {
  const assignment = (id: number, points: number, gradingMode: 'auto' | 'manual' = 'auto') =>
    ({ id, points, gradingMode, title: `A${id}` }) as AssignmentSummary;
  const cell = (status: GradebookCell['status'], finalScore: number | null, late = false): GradebookCell => ({
    submissionId: status === 'missing' ? null : 1,
    status,
    finalScore,
    late,
    submittedAt: status === 'missing' ? null : '2026-10-01T00:00:00.000Z',
  });

  test('counts completed, late, missing (past due only) and ungraded work', () => {
    const rows: SummaryRow[] = [
      { assignment: assignment(1, 10), cell: cell('autograded', 9, true), pastDue: true },
      { assignment: assignment(2, 20, 'manual'), cell: cell('graded', 10), pastDue: true },
      { assignment: assignment(3, 10), cell: cell('needs_grading', null), pastDue: true },
      { assignment: assignment(4, 10), cell: cell('missing', null), pastDue: true },
      { assignment: assignment(5, 10), cell: cell('missing', null), pastDue: false },
    ];
    const summary = studentSummary(rows);
    assert.equal(summary.completed, 3);
    assert.equal(summary.assignments, 5);
    assert.equal(summary.late, 1);
    assert.equal(summary.missing, 1);
    assert.equal(summary.needsGrading, 1);
    assert.deepEqual(summary.overall, { earned: 19, possible: 30, percent: 63.3, scored: 2 });
    assert.deepEqual(summary.autograded, { earned: 9, possible: 10, percent: 90, scored: 1 });
    assert.equal(classAverage([summary, studentSummary([])]), 63.3);
    assert.equal(classAverage([]), null);
  });
});

describe('most-missed cells', () => {
  const result = (address: string, correct: boolean, extra: Partial<CellResult> = {}): CellResult => ({
    sheet: 'Budget',
    address,
    correct,
    actual: null,
    ...(correct ? {} : { reason: 'value_mismatch' as const }),
    ...extra,
  });
  const submission = (cells: CellResult[], sheet = 'Budget', autoStatus: SubmissionDetail['autoStatus'] = 'graded') =>
    ({
      autoStatus,
      report: {
        correct: 0,
        total: cells.length,
        fraction: 0,
        warnings: [],
        sheets: [{ keySheet: sheet, studentSheet: sheet, correct: 0, total: cells.length, cells }],
      },
    }) as unknown as SubmissionDetail;

  test('ranks by how many got it wrong, with the most common reason and the answer key', () => {
    const key = { expected: 1234.5, expectedText: '$1,234.50', expectedFormula: 'SUM(B2:B6)' };
    const cells = mostMissedCells([
      submission([result('B2', false, key), result('C3', true), result('D4', false, { reason: 'empty' })]),
      submission([result('B2', false, { ...key, reason: 'formula_required' }), result('C3', true), result('D4', true)]),
      submission([result('B2', false, key), result('C3', true), result('D4', true)]),
      submission([result('B2', false, key)], 'Budget', 'error'), // not graded: ignored
    ]);
    assert.deepEqual(
      cells.map((c) => [c.ref, c.wrong, c.checked, c.percentWrong, c.reason]),
      [
        ['Budget!B2', 3, 3, 100, 'value_mismatch'],
        ['Budget!D4', 1, 3, 33.3, 'empty'],
      ],
    );
    assert.equal(cells[0].expected, '$1,234.50 (=SUM(B2:B6))');
    assert.equal(cells[1].expected, null);
  });

  test('keeps the key order for ties and stops at the limit', () => {
    const many = Array.from({ length: 20 }, (_, i) => result(`A${i + 1}`, false));
    const cells = mostMissedCells([submission(many)], 15);
    assert.equal(cells.length, 15);
    assert.deepEqual(cells.slice(0, 3).map((c) => c.ref), ['Budget!A1', 'Budget!A2', 'Budget!A3']);
    assert.deepEqual(mostMissedCells([submission([result('A1', true)])]), []);
  });

  test('sheet names are quoted like Excel when needed; values formatted like the app', () => {
    assert.equal(cellRef('Sheet1', 'C7'), 'Sheet1!C7');
    assert.equal(cellRef('Monthly Budget', 'C7'), "'Monthly Budget'!C7");
    assert.equal(cellRef("Ava's", 'A1'), "'Ava''s'!A1");
    assert.equal(formatCellValue(1250), '1,250');
    assert.equal(formatCellValue(0.333333), '0.3333');
    assert.equal(formatCellValue('Total'), '"Total"');
    assert.equal(formatCellValue(true), 'TRUE');
    assert.equal(formatCellValue(null), '(empty)');
  });
});

describe('formatting', () => {
  test('durations round to two units', () => {
    assert.equal(formatDuration(45), '45 sec');
    assert.equal(formatDuration(3 * 60 + 5), '3 min');
    assert.equal(formatDuration(5 * 3600), '5 h');
    assert.equal(formatDuration(5 * 3600 + 20 * 60), '5 h 20 min');
    assert.equal(formatDuration(2 * 86400 + 3 * 3600 + 59), '2 d 3 h');
    assert.equal(formatDuration(86400), '1 d');
  });

  test('percentages', () => {
    assert.equal(percentOf(85.25, 100), 85.3);
    assert.equal(percentOf(1, 3), 33.3);
    assert.equal(percentOf(5, 0), 0);
    assert.equal(formatPercent(85), '85%');
    assert.equal(formatPercent(85.3), '85.3%');
  });

  test('dates use TIME_ZONE when it is valid', (t) => {
    const saved = process.env.TIME_ZONE;
    t.after(() => {
      if (saved === undefined) delete process.env.TIME_ZONE;
      else process.env.TIME_ZONE = saved;
    });
    process.env.TIME_ZONE = 'America/Chicago';
    assert.equal(reportTimeZone(), 'America/Chicago');
    const dates = dateFormats();
    assert.equal(dates.dateTime('2026-10-17T04:59:00.000Z'), 'Oct 16, 2026, 11:59 PM');
    assert.equal(dates.shortDate('2026-10-17T04:59:00.000Z'), 'Oct 16');
    assert.match(dates.generated(new Date('2026-11-10T16:00:00.000Z')), /^Nov 10, 2026, 10:00 AM CST$/);

    process.env.TIME_ZONE = 'Not/AZone';
    assert.equal(reportTimeZone(), Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  test('truncate keeps short text and shortens long text with an ellipsis', () => {
    assert.equal(truncate('Budget', 10), 'Budget');
    assert.equal(truncate('Quarterly sales report', 10), 'Quarterly…');
  });
});
