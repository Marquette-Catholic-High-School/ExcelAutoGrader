/** GET /api/reports/assignments/:assignmentId.pdf — one assignment across the whole class. */
import type { Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces.js';
import type { CellFailReason, SubmissionDetail } from '../../../../shared/types.js';
import { formatScore } from '../common.js';
import type { AssignmentReport, AssignmentReportRow } from './data.js';
import type { ScoreStats } from './stats.js';
import { dateFormats, formatDuration, formatPercent, percentOf, plural, type DateFormats } from './format.js';
import {
  block,
  COLORS,
  contentWidth,
  countCard,
  dash,
  dataTable,
  distributionChart,
  emptyNote,
  lateMark,
  reportDocument,
  statCards,
  studentNameCell,
  th,
  titleBlock,
  type ReportContext,
  type StatCard,
} from './pdf.js';

const REASON_LABEL: Record<CellFailReason, string> = {
  value_mismatch: 'Wrong value',
  empty: 'Left empty',
  formula_required: 'Hard-coded (needs a formula)',
  missing_sheet: 'Sheet missing',
};

function statusCell(row: AssignmentReportRow, pastDue: boolean): TableCell {
  switch (row.status) {
    case 'missing':
      return { text: pastDue ? 'Missing' : 'Not submitted', style: 'missing' };
    case 'needs_grading':
      return row.latest?.autoStatus === 'error'
        ? { stack: [{ text: 'Needs grading', style: 'warn' }, { text: "Couldn't autograde", style: 'small' }] }
        : { text: 'Needs grading', style: 'warn' };
    case 'autograded':
      return { text: 'Autograded' };
    case 'graded':
      return { text: 'Graded' };
  }
}

function lateCell(latest: SubmissionDetail | null): TableCell {
  if (!latest) return { text: '' };
  return latest.late ? lateMark(formatDuration(latest.lateBySeconds)) : { text: 'On time', color: COLORS.muted };
}

function studentRow(row: AssignmentReportRow, report: AssignmentReport, dates: DateFormats): TableCell[] {
  const { latest } = row;
  const score = latest?.finalScore ?? null;
  const percent = score === null ? null : percentOf(score, report.assignment.points);
  return [
    studentNameCell(row.student.name, row.student.pending),
    statusCell(row, report.pastDue),
    { text: latest ? dates.shortDateTime(latest.submittedAt) : '' },
    lateCell(latest),
    { text: latest ? String(row.attempts) : '', alignment: 'center' },
    score === null ? dash() : { text: formatScore(score), alignment: 'right', bold: true },
    percent === null ? dash() : { text: formatPercent(percent), alignment: 'right' },
  ];
}

function scoreCards(stats: ScoreStats | null, points: number): StatCard[] {
  const card = (label: string, value: number | undefined): StatCard => {
    if (value === undefined) return { label, value: '—', detail: 'No scores yet' };
    const detail = `of ${formatScore(points)} · ${formatPercent(percentOf(value, points))}`;
    return { label, value: formatScore(value), detail };
  };
  return [
    card('Average', stats?.average),
    card('Median', stats?.median),
    card('High', stats?.high),
    card('Low', stats?.low),
  ];
}

function summary(report: AssignmentReport): Content {
  const { counts } = report;
  const countCards: StatCard[] = [
    countCard('Enrolled', counts.enrolled),
    countCard('Submitted', counts.submitted),
    countCard('On time', counts.onTime),
    countCard('Late', counts.late, COLORS.late),
    report.pastDue
      ? countCard('Missing', counts.notSubmitted, COLORS.missing)
      : countCard('Not submitted', counts.notSubmitted, undefined, 'Not due yet'),
    countCard('Needs grading', counts.needsGrading, COLORS.warn),
  ];
  return block('Summary', [statCards(countCards), statCards(scoreCards(report.stats, report.assignment.points))]);
}

function distribution(report: AssignmentReport): Content {
  const scored = report.stats?.count ?? 0;
  if (!scored) return block('Score distribution', emptyNote('No scores yet.'));
  const note = `${plural(scored, 'scored submission')}, by percent of the points`;
  return block('Score distribution', distributionChart(report.distribution, contentWidth()), note);
}

function studentTable(report: AssignmentReport, dates: DateFormats): Content {
  if (report.rows.length === 0) return block('Students', emptyNote('No students are enrolled in this class yet.'));
  const header = [
    th('Student'),
    th('Status'),
    th('Submitted'),
    th('Late by'),
    th('Attempts', 'center'),
    th(`Score / ${formatScore(report.assignment.points)}`, 'right'),
    th('%', 'right'),
  ];
  return dataTable(
    header,
    report.rows.map((row) => studentRow(row, report, dates)),
    { title: 'Students', widths: ['*', 66, 74, 76, 38, 46, 34] },
  );
}

function missedCells(report: AssignmentReport): Content {
  const cells = report.missedCells;
  if (!cells) return [];
  const graded = report.rows.filter((r) => r.latest?.autoStatus === 'graded').length;
  const title = 'Most-missed cells';
  if (graded === 0) return block(title, emptyNote('No autograded submissions yet.'));
  const note = `From each student's latest autograded submission (${plural(graded, 'submission')}).`;
  if (cells.length === 0) return block(title, emptyNote('Every checked cell was right in every submission.'), note);
  const header = [th('#', 'right'), th('Cell'), th('Wrong in'), th('Most common problem'), th('Answer key')];
  const body = cells.map((cell, i): TableCell[] => [
    { text: String(i + 1), alignment: 'right', color: COLORS.muted },
    { text: cell.ref, bold: true },
    {
      text: [
        { text: formatPercent(cell.percentWrong), bold: true },
        { text: `  ${cell.wrong} of ${cell.checked}`, style: 'small' },
      ],
    },
    { text: cell.reason ? REASON_LABEL[cell.reason] : '' },
    { text: cell.expected ?? '', color: cell.expected ? COLORS.text : COLORS.faint },
  ]);
  return dataTable(header, body, { title, note, widths: [14, 80, 66, 110, '*'] });
}

export function assignmentReportPdf(report: AssignmentReport, ctx: ReportContext): TDocumentDefinitions {
  const dates = dateFormats();
  const { assignment } = report;
  const mode = assignment.grading_mode === 'auto' ? 'Autograded' : 'Graded by the teacher';
  const content: Content = [
    titleBlock(assignment.title, [
      `${ctx.className} · Teacher: ${ctx.teacherName}`,
      `Due ${dates.dateTime(assignment.due_at)} · ${plural(assignment.points, 'point')} · ${mode}`,
      `Generated ${dates.generated(ctx.generatedAt)}`,
    ]),
    summary(report),
    distribution(report),
    studentTable(report, dates),
    missedCells(report),
  ];
  return reportDocument({
    title: `${assignment.title} - ${ctx.className}`,
    bandTitle: 'Assignment report',
    footerNote: `${assignment.title} · ${ctx.className} · Generated ${dates.generated(ctx.generatedAt)}`,
    content,
    ctx,
  });
}
