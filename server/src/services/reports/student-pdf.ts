/**
 * GET /api/reports/classes/:classId/students/:studentId.pdf — one student's work in a class — and
 * GET /api/reports/classes/:classId/students.pdf — the same report for every student, each on new pages.
 */
import type {
  Content,
  ContentSection,
  CustomTableLayout,
  TableCell,
  TDocumentDefinitions,
} from 'pdfmake/interfaces.js';
import type { StudentReport, StudentReportRow } from './data.js';
import { dateFormats, formatPercent, percentOf, scoreOutOf, type DateFormats } from './format.js';
import {
  bandHeader,
  block,
  COLORS,
  countCard,
  dash,
  dataTable,
  emptyNote,
  lateMark,
  pageFooter,
  reportDocument,
  statCards,
  th,
  titleBlock,
  titleCell,
  type ReportContext,
  type StatCard,
} from './pdf.js';

const BAND_TITLE = 'Student report';

function statusCell(row: StudentReportRow): TableCell {
  switch (row.cell.status) {
    case 'missing':
      return row.pastDue ? { text: 'Missing', style: 'missing' } : { text: 'Not due yet', color: COLORS.muted };
    case 'needs_grading':
      return { text: 'Needs grading', style: 'warn' };
    case 'autograded':
      return { text: 'Autograded' };
    case 'graded':
      return { text: 'Graded' };
  }
}

function assignmentRow(row: StudentReportRow, dates: DateFormats): TableCell[] {
  const { assignment, cell } = row;
  const score = cell.finalScore;
  const percent = score === null ? null : percentOf(score, assignment.points);
  return [
    { text: assignment.title, bold: true },
    { text: dates.shortDate(assignment.dueAt) },
    { text: cell.submittedAt ? dates.shortDateTime(cell.submittedAt) : '' },
    statusCell(row),
    cell.late ? lateMark() : { text: '' },
    score === null ? dash() : { text: scoreOutOf(score, assignment.points), alignment: 'right' },
    percent === null ? dash() : { text: formatPercent(percent), alignment: 'right', bold: true },
  ];
}

function summaryCards({ summary }: StudentReport): StatCard[] {
  const { overall, autograded } = summary;
  return [
    overall.percent === null
      ? { label: 'Overall', value: '—', detail: 'Nothing graded yet' }
      : {
          label: 'Overall',
          value: formatPercent(overall.percent),
          detail: `${scoreOutOf(overall.earned, overall.possible)} points graded`,
          color: COLORS.brandDark,
        },
    {
      label: 'Completed',
      value: `${summary.completed} of ${summary.assignments}`,
      detail: summary.assignments === 1 ? 'assignment submitted' : 'assignments submitted',
    },
    countCard('Late', summary.late, COLORS.late, 'after the due date'),
    countCard('Missing', summary.missing, COLORS.missing, 'past due, not turned in'),
    autograded.percent === null
      ? { label: 'Autograded work', value: '—', detail: 'No autograded scores yet' }
      : {
          label: 'Autograded work',
          value: formatPercent(autograded.percent),
          detail: `average of ${autograded.scored} graded`,
        },
  ];
}

function assignmentsTable(report: StudentReport, dates: DateFormats): Content {
  if (report.rows.length === 0) return block('Assignments', emptyNote('This class has no assignments yet.'));
  const header = [
    th('Assignment'),
    th('Due'),
    th('Submitted'),
    th('Status'),
    th('Late'),
    th('Score', 'right'),
    th('%', 'right'),
  ];
  return dataTable(
    header,
    report.rows.map((row) => assignmentRow(row, dates)),
    { title: 'Assignments', widths: ['*', 40, 72, 62, 26, 58, 36] },
  );
}

/** Short enough that the first feedback surely fits on one page together with the title (see feedbackSection). */
const KEEP_WITH_TITLE_MAX_CHARS = 1500;

const FEEDBACK_LAYOUT: CustomTableLayout = {
  hLineWidth: () => 0,
  vLineWidth: () => 0,
  paddingLeft: () => 0,
  paddingRight: () => 0,
  paddingTop: () => 0,
  paddingBottom: (row) => (row === 0 ? 0 : 9),
};

const ACCENT_LAYOUT: CustomTableLayout = {
  hLineWidth: () => 0,
  vLineWidth: (i) => (i === 0 ? 2 : 0),
  vLineColor: () => COLORS.brand,
  paddingLeft: () => 8,
  paddingRight: () => 0,
  paddingTop: () => 1,
  paddingBottom: () => 1,
};

function feedbackRow(row: StudentReportRow): TableCell[] {
  const score = row.cell.finalScore;
  return [
    {
      stack: [
        {
          text: [
            { text: row.assignment.title, bold: true },
            score === null ? '' : { text: `   ${scoreOutOf(score, row.assignment.points)}`, style: 'small' },
          ],
          margin: [0, 0, 0, 2],
        },
        { table: { widths: ['*'], body: [[{ text: row.feedback.trim() }]] }, layout: ACCENT_LAYOUT },
      ],
    },
  ];
}

/**
 * One table row per assignment with feedback, under a title row that repeats on every page. Feedback can be up to
 * 10,000 characters, so rows may break across pages; the title is only tied to the first row when that row surely
 * fits on a page (pdfmake drops whatever doesn't fit in a block it may not break).
 */
function feedbackSection(report: StudentReport): Content {
  const title = 'Teacher feedback';
  const withFeedback = report.rows.filter((r) => r.feedback.trim());
  if (withFeedback.length === 0) return block(title, emptyNote('No written feedback yet.'));
  return {
    table: {
      headerRows: 1,
      keepWithHeaderRows: withFeedback[0].feedback.length <= KEEP_WITH_TITLE_MAX_CHARS ? 1 : 0,
      widths: ['*'],
      body: [[titleCell(title, undefined, 0)], ...withFeedback.map(feedbackRow)],
    },
    layout: FEEDBACK_LAYOUT,
  };
}

/** The body of one student's report (shared by the single and the all-students PDF). */
function studentContent(report: StudentReport, ctx: ReportContext, dates: DateFormats): Content {
  const { student } = report;
  return [
    titleBlock(
      student.name,
      [
        student.email,
        `${ctx.className} · Teacher: ${ctx.teacherName}`,
        `Generated ${dates.generated(ctx.generatedAt)}`,
      ],
      student.pending ? "INVITED · HASN'T SIGNED UP YET" : undefined,
    ),
    block('Summary', statCards(summaryCards(report))),
    assignmentsTable(report, dates),
    feedbackSection(report),
  ];
}

const footerNote = (report: StudentReport, ctx: ReportContext) => `${report.student.name} · ${ctx.className}`;

export function studentReportPdf(report: StudentReport, ctx: ReportContext): TDocumentDefinitions {
  const dates = dateFormats();
  return reportDocument({
    title: `${report.student.name} - ${ctx.className}`,
    bandTitle: BAND_TITLE,
    footerNote: footerNote(report, ctx),
    content: studentContent(report, ctx, dates),
    ctx,
  });
}

/** Every student's report, each in its own section (new page, footer naming the student). */
export function allStudentsPdf(reports: readonly StudentReport[], ctx: ReportContext): TDocumentDefinitions {
  const dates = dateFormats();
  const content: Content =
    reports.length === 0
      ? [
          titleBlock(ctx.className, [`Teacher: ${ctx.teacherName}`, `Generated ${dates.generated(ctx.generatedAt)}`]),
          emptyNote('No students are enrolled in this class yet.'),
        ]
      : reports.map(
          (report): ContentSection => ({
            section: studentContent(report, ctx, dates),
            header: bandHeader(BAND_TITLE),
            footer: pageFooter(footerNote(report, ctx)),
          }),
        );
  return reportDocument({
    title: `All students - ${ctx.className}`,
    bandTitle: BAND_TITLE,
    footerNote: ctx.className,
    content,
    ctx,
  });
}
