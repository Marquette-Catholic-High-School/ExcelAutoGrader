/**
 * GET /api/reports/classes/:classId/gradebook.pdf — students × assignments on landscape pages.
 *
 * Up to INLINE_TOTALS_MAX assignments fit in one table with the totals at the end of each row. Wider classes are
 * split into tables of GRADEBOOK_COLUMNS_PER_TABLE assignments (each repeating the student names), followed by a
 * per-student totals table.
 */
import type { Content, Size, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces.js';
import type { AssignmentSummary, GradebookCell } from '../../../../shared/types.js';
import { formatScore } from '../common.js';
import type { GradebookReport } from './data.js';
import { classAverage, type StudentSummary } from './stats.js';
import { dateFormats, formatPercent, percentOf, plural, scoreOutOf, truncate, type DateFormats } from './format.js';
import {
  COLORS,
  countCard,
  dash,
  dataTable,
  emptyNote,
  reportDocument,
  statCards,
  studentNameCell,
  th,
  titleBlock,
  type ReportContext,
} from './pdf.js';

export const GRADEBOOK_COLUMNS_PER_TABLE = 10;
export const INLINE_TOTALS_MAX = 8;
const TITLE_MAX_CHARS = 40;
const NAME_WIDTH = 128;
const SMALL = 6.5;

function scoreCell(cell: GradebookCell, pastDue: boolean): TableCell {
  if (cell.status === 'missing') {
    return pastDue ? { text: 'missing', style: 'missing', fontSize: 7, alignment: 'center' } : dash('center');
  }
  const score: Content =
    cell.finalScore === null
      ? { text: 'ungraded', style: 'warn', fontSize: 7 }
      : { text: formatScore(cell.finalScore), bold: true };
  if (!cell.late) return { stack: [score], alignment: 'center' };
  return { stack: [score, { text: 'LATE', style: 'late', fontSize: SMALL }], alignment: 'center' };
}

function assignmentHeader(a: AssignmentSummary, dates: DateFormats): TableCell {
  return {
    alignment: 'center',
    stack: [
      { text: truncate(a.title, TITLE_MAX_CHARS), bold: true, fontSize: 7 },
      { text: `${dates.shortDate(a.dueAt)} · ${formatScore(a.points)} pts`, fontSize: 6, color: COLORS.muted },
    ],
  };
}

function totalCells(summary: StudentSummary): TableCell[] {
  const { overall } = summary;
  if (overall.percent === null) return [dash(), dash()];
  return [
    { text: scoreOutOf(overall.earned, overall.possible), alignment: 'right', fontSize: 7.5 },
    { text: formatPercent(overall.percent), alignment: 'right', bold: true },
  ];
}

/*
 * The class summary is ONE footer row (two rows could be split across pages): the label cell and every assignment
 * cell are stacks of the same line sizes, so "Class average" lines up with the averages and "Submitted" with the
 * counts.
 */
const SECOND_LINE_GAP = 4;

function summaryLabel(): TableCell {
  return {
    stack: [
      { text: 'Class average', bold: true },
      { text: ' ', fontSize: SMALL },
      { text: 'Submitted', bold: true, margin: [0, SECOND_LINE_GAP, 0, 0] },
    ],
  };
}

function summaryCell(report: GradebookReport, a: AssignmentSummary): TableCell {
  const stats = report.assignmentStats.get(a.id);
  const counts = a.counts!;
  return {
    alignment: 'center',
    stack: [
      stats ? { text: formatScore(stats.average), bold: true } : { text: '—', color: COLORS.faint },
      { text: stats ? formatPercent(percentOf(stats.average, a.points)) : ' ', fontSize: SMALL, color: COLORS.muted },
      { text: `${counts.submitted}/${counts.students}`, bold: true, margin: [0, SECOND_LINE_GAP, 0, 0] },
      ...(counts.late ? [{ text: `${counts.late} late`, fontSize: SMALL, color: COLORS.late }] : []),
    ],
  };
}

function classAverageCell(report: GradebookReport): TableCell {
  const average = classAverage(report.students.values());
  return average === null ? dash() : { text: formatPercent(average), bold: true, alignment: 'right' };
}

/** Students × the assignments of `group`, which starts at index `first`; `withTotals` adds Total and %. */
function scoresTable(
  report: GradebookReport,
  group: AssignmentSummary[],
  first: number,
  withTotals: boolean,
  dates: DateFormats,
): Content {
  const { book } = report;
  const header: TableCell[] = [
    th('Student'),
    ...group.map((a) => assignmentHeader(a, dates)),
    ...(withTotals ? [th('Total', 'right'), th('%', 'right')] : []),
  ];
  const body = book.students.map((student): TableCell[] => [
    studentNameCell(student.name, student.pending),
    ...group.map((a) => scoreCell(book.cells[student.id][a.id], report.pastDue.get(a.id)!)),
    ...(withTotals ? totalCells(report.students.get(student.id)!) : []),
  ]);
  const footer: TableCell[][] = [
    [
      summaryLabel(),
      ...group.map((a) => summaryCell(report, a)),
      ...(withTotals ? [{ text: '' }, classAverageCell(report)] : []),
    ],
  ];
  const split = group.length < book.assignments.length;
  const title = split ? `Assignments ${first + 1}–${first + group.length} of ${book.assignments.length}` : undefined;
  const widths: Size[] = [NAME_WIDTH, ...group.map((): Size => '*'), ...(withTotals ? [62, 34] : [])];
  return { ...dataTable(header, body, { title, widths, footer }), fontSize: 8 };
}

function countCell(count: number, color: string): TableCell {
  if (!count) return { text: '0', alignment: 'center', color: COLORS.faint };
  return { text: String(count), alignment: 'center', bold: true, color };
}

/** One row per student: submitted, late, missing, ungraded, points and %. */
function totalsTable(report: GradebookReport): Content {
  const { book } = report;
  const header = [
    th('Student'),
    th('Submitted', 'center'),
    th('Late', 'center'),
    th('Missing', 'center'),
    th('Needs grading', 'center'),
    th('Points (graded work)', 'right'),
    th('%', 'right'),
  ];
  const body = book.students.map((student): TableCell[] => {
    const summary = report.students.get(student.id)!;
    return [
      studentNameCell(student.name, student.pending),
      { text: `${summary.completed} of ${summary.assignments}`, alignment: 'center' },
      countCell(summary.late, COLORS.late),
      countCell(summary.missing, COLORS.missing),
      countCell(summary.needsGrading, COLORS.warn),
      ...totalCells(summary),
    ];
  });
  const footer: TableCell[][] = [
    [{ text: 'Class average', bold: true, colSpan: 6 }, {}, {}, {}, {}, {}, classAverageCell(report)],
  ];
  return dataTable(header, body, { title: 'Totals', widths: ['*', 70, 50, 50, 70, 110, 50], footer });
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

function tables(report: GradebookReport, dates: DateFormats): Content {
  const { book } = report;
  if (book.students.length === 0) return emptyNote('No students are enrolled in this class yet.');
  if (book.assignments.length === 0) return emptyNote('This class has no assignments yet.');
  if (book.assignments.length <= INLINE_TOTALS_MAX) return scoresTable(report, book.assignments, 0, true, dates);
  const groups = chunks(book.assignments, GRADEBOOK_COLUMNS_PER_TABLE);
  return [
    ...groups.map((group, i) => scoresTable(report, group, i * GRADEBOOK_COLUMNS_PER_TABLE, false, dates)),
    totalsTable(report),
  ];
}

function summaryCards(report: GradebookReport): Content {
  const summaries = [...report.students.values()];
  const sum = (key: 'missing' | 'late' | 'needsGrading') => summaries.reduce((n, s) => n + s[key], 0);
  const [missing, late, ungraded] = [sum('missing'), sum('late'), sum('needsGrading')];
  const average = classAverage(summaries);
  return statCards([
    { label: 'Class average', value: average === null ? '—' : formatPercent(average), detail: 'of graded work' },
    countCard('Missing', missing, COLORS.missing, 'past due, not turned in'),
    countCard('Late', late, COLORS.late, 'turned in after the due date'),
    countCard('Needs grading', ungraded, COLORS.warn, 'submitted, no score yet'),
  ]);
}

function legend(): Content {
  return {
    margin: [0, 0, 0, 8],
    style: 'small',
    text: [
      'Each cell is the score of the latest submission.   ',
      { text: 'LATE', style: 'late' },
      ' turned in after the due date   ',
      { text: 'missing', style: 'missing' },
      ' past due, nothing turned in   ',
      { text: '—', color: COLORS.faint },
      ' not due yet   ',
      { text: 'ungraded', style: 'warn' },
      ' waiting for a score.   Totals and % count graded work only.',
    ],
  };
}

export function gradebookPdf(report: GradebookReport, ctx: ReportContext): TDocumentDefinitions {
  const dates = dateFormats();
  const { book } = report;
  const content: Content = [
    titleBlock(`${ctx.className} — Gradebook`, [
      [
        `Teacher: ${ctx.teacherName}`,
        plural(book.students.length, 'student'),
        plural(book.assignments.length, 'assignment'),
      ].join(' · '),
      `Generated ${dates.generated(ctx.generatedAt)}`,
    ]),
    summaryCards(report),
    legend(),
    tables(report, dates),
  ];
  return reportDocument({
    title: `Gradebook - ${ctx.className}`,
    bandTitle: 'Gradebook',
    footerNote: `${ctx.className} · Generated ${dates.generated(ctx.generatedAt)}`,
    content,
    ctx,
    landscape: true,
  });
}
