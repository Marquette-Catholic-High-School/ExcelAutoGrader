/**
 * Submission queries and mappers (row → SubmissionDetail), plus the status rules from docs/API.md.
 * Everything a student receives goes through toSubmissionDetail(..., 'student'), which applies the
 * assignment's visibility settings.
 */
import type {
  AutoStatus,
  CellResult,
  GradeReport,
  GradingConfig,
  StudentAssignmentStatus,
  SubmissionDetail,
  TeacherRowStatus,
} from '../../../shared/types.js';
import { all, get, type AssignmentRow, type SubmissionRow } from '../db.js';
import { idList, isPastDue, lateness } from './common.js';
import { readConfig } from './config.js';

export type Viewer = 'teacher' | 'student';

/** Submission joined with the names and file info SubmissionDetail needs. */
export type SubmissionDetailRow = SubmissionRow & {
  student_name: string;
  submitted_by_name: string | null;
  graded_by_name: string | null;
  file_name: string;
  file_size: number;
};

/** Just what status/score/late computations need (no report JSON), for lists and the gradebook. */
export interface LatestBriefRow {
  id: number;
  assignment_id: number;
  student_id: number;
  submitted_at: string;
  auto_status: AutoStatus;
  auto_score: number | null;
  override_score: number | null;
  attempt_count: number;
}

const DETAIL_COLUMNS = `s.*, st.name AS student_name, sb.name AS submitted_by_name, gb.name AS graded_by_name,
  f.original_name AS file_name, f.size AS file_size`;

const DETAIL_JOINS = `JOIN users st ON st.id = s.student_id
  JOIN files f ON f.id = s.file_id
  LEFT JOIN users sb ON sb.id = s.submitted_by
  LEFT JOIN users gb ON gb.id = s.graded_by`;

/**
 * Latest attempt per (assignment, student) for currently enrolled students, with the attempt count.
 * Binds: assignment ids (json), student id or null.
 */
const LATEST_CTE = `WITH latest AS (
  SELECT s.assignment_id, s.student_id, MAX(s.attempt) AS max_attempt, COUNT(*) AS attempt_count
  FROM submissions s
  JOIN assignments a ON a.id = s.assignment_id
  JOIN enrollments e ON e.class_id = a.class_id AND e.student_id = s.student_id
  WHERE s.assignment_id IN (SELECT value FROM json_each(?)) AND (? IS NULL OR s.student_id = ?)
  GROUP BY s.assignment_id, s.student_id
)`;

const LATEST_JOIN = `JOIN submissions s
  ON s.assignment_id = l.assignment_id AND s.student_id = l.student_id AND s.attempt = l.max_attempt`;

/** One query for any number of assignments; optionally only one student's rows. */
export function latestBriefRows(assignmentIds: readonly number[], studentId: number | null = null): LatestBriefRow[] {
  if (assignmentIds.length === 0) return [];
  return all<LatestBriefRow>(
    `${LATEST_CTE}
     SELECT s.id, s.assignment_id, s.student_id, s.submitted_at, s.auto_status, s.auto_score, s.override_score,
            l.attempt_count
     FROM latest l ${LATEST_JOIN}`,
    idList(assignmentIds),
    studentId,
    studentId,
  );
}

/** Latest attempt of every enrolled student for one assignment, with full detail. */
export function latestDetailRows(assignmentId: number): (SubmissionDetailRow & { attempt_count: number })[] {
  return all(
    `${LATEST_CTE}
     SELECT ${DETAIL_COLUMNS}, l.attempt_count
     FROM latest l ${LATEST_JOIN} ${DETAIL_JOINS}`,
    idList([assignmentId]),
    null,
    null,
  );
}

export function submissionDetailRow(submissionId: number): SubmissionDetailRow | undefined {
  return get<SubmissionDetailRow>(
    `SELECT ${DETAIL_COLUMNS} FROM submissions s ${DETAIL_JOINS} WHERE s.id = ?`,
    submissionId,
  );
}

/** All attempts of one student for one assignment, newest first. */
export function attemptRows(assignmentId: number, studentId: number): SubmissionDetailRow[] {
  return all<SubmissionDetailRow>(
    `SELECT ${DETAIL_COLUMNS} FROM submissions s ${DETAIL_JOINS}
     WHERE s.assignment_id = ? AND s.student_id = ? ORDER BY s.attempt DESC`,
    assignmentId,
    studentId,
  );
}

type ScoreFields = Pick<SubmissionRow, 'auto_status' | 'auto_score' | 'override_score'>;

/** overrideScore ?? autoScore (an autograde score only counts when autograding succeeded). */
export function finalScore(row: ScoreFields): number | null {
  if (row.override_score !== null) return row.override_score;
  return row.auto_status === 'graded' ? row.auto_score : null;
}

export function teacherRowStatus(row: ScoreFields | undefined): TeacherRowStatus {
  if (!row) return 'missing';
  if (row.override_score !== null) return 'graded';
  if (row.auto_status === 'graded') return 'autograded';
  return 'needs_grading';
}

export function studentStatus(row: ScoreFields | undefined, dueAt: string): StudentAssignmentStatus {
  if (!row) return isPastDue(dueAt) ? 'missing' : 'not_submitted';
  return finalScore(row) !== null ? 'graded' : 'submitted';
}

function parseReport(json: string | null): GradeReport | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as GradeReport;
  } catch {
    return null;
  }
}

/** The cell without anything that reveals the answer (actualText, the student's own value, stays). */
function withoutExpected({ expected: _e, expectedFormula: _f, expectedText: _t, ...cell }: CellResult): CellResult {
  return cell;
}

/** Applies showDetailsToStudents / showExpectedToStudents. */
export function studentReport(report: GradeReport | null, config: GradingConfig): GradeReport | null {
  if (!report || !config.showDetailsToStudents) return null;
  if (config.showExpectedToStudents) return report;
  return { ...report, sheets: report.sheets.map((sheet) => ({ ...sheet, cells: sheet.cells.map(withoutExpected) })) };
}

const STUDENT_AUTO_ERROR = "This file couldn't be graded automatically, so your teacher will grade it.";

export function toSubmissionDetail(
  row: SubmissionDetailRow,
  assignment: AssignmentRow,
  viewer: Viewer,
  config: GradingConfig = readConfig(assignment),
): SubmissionDetail {
  const { late, lateBySeconds } = lateness(row.submitted_at, assignment.due_at);
  const report = parseReport(row.auto_report);
  const isTeacher = viewer === 'teacher';
  return {
    id: row.id,
    assignmentId: row.assignment_id,
    studentId: row.student_id,
    studentName: row.student_name,
    attempt: row.attempt,
    file: { name: row.file_name, size: row.file_size },
    submittedAt: row.submitted_at,
    submittedByName: row.submitted_by_name ?? 'Unknown user',
    late,
    lateBySeconds,
    pointsPossible: assignment.points,
    autoStatus: row.auto_status,
    autoScore: row.auto_status === 'graded' ? row.auto_score : null,
    autoError: row.auto_error && !isTeacher ? STUDENT_AUTO_ERROR : row.auto_error,
    report: isTeacher ? report : studentReport(report, config),
    overrideScore: row.override_score,
    finalScore: finalScore(row),
    feedback: row.feedback,
    gradedAt: row.graded_at,
    gradedByName: row.graded_by_name,
  };
}
