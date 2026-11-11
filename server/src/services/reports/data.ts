/**
 * The numbers behind the PDF reports. Statuses, lateness and scores come from the submission and gradebook
 * services, so a report always agrees with what the app shows; this module only adds them up.
 */
import type {
  GradebookResponse,
  StudentInfo,
  SubmissionDetail,
  TeacherRowStatus,
} from '../../../../shared/types.js';
import { all, type AssignmentRow } from '../../db.js';
import { classRoster } from '../assignments.js';
import { idList, isPastDue } from '../common.js';
import { readConfig } from '../config.js';
import { buildGradebook } from '../gradebook.js';
import { latestDetailRows, teacherRowStatus, toSubmissionDetail } from '../submissions.js';
import {
  mostMissedCells,
  scoreDistribution,
  scoreStats,
  studentSummary,
  type MissedCell,
  type ScoreStats,
  type StudentSummary,
  type SummaryRow,
} from './stats.js';

/* ------------------------------------------------------------------ */
/* Assignment report                                                  */
/* ------------------------------------------------------------------ */

export interface AssignmentReportRow {
  student: StudentInfo;
  status: TeacherRowStatus;
  /** The latest attempt, or null when the student hasn't submitted. */
  latest: SubmissionDetail | null;
  attempts: number;
}

export interface AssignmentReport {
  assignment: AssignmentRow;
  pastDue: boolean;
  rows: AssignmentReportRow[];
  counts: {
    enrolled: number;
    submitted: number;
    onTime: number;
    late: number;
    /** Enrolled students with no submission (whether or not the assignment is past due). */
    notSubmitted: number;
    needsGrading: number;
  };
  /** Final scores (points) of the latest submissions that have one. */
  stats: ScoreStats | null;
  distribution: number[];
  /** Most-missed cells for autograded assignments (see mostMissedCells), null for manual ones. */
  missedCells: MissedCell[] | null;
}

export function assignmentReport(assignment: AssignmentRow, now = Date.now()): AssignmentReport {
  const config = readConfig(assignment);
  const latest = new Map(latestDetailRows(assignment.id).map((row) => [row.student_id, row]));
  const rows: AssignmentReportRow[] = classRoster(assignment.class_id).map((student) => {
    const row = latest.get(student.id);
    return {
      student,
      status: teacherRowStatus(row),
      latest: row ? toSubmissionDetail(row, assignment, 'teacher', config) : null,
      attempts: row?.attempt_count ?? 0,
    };
  });

  const submitted = rows.flatMap((r) => (r.latest ? [r.latest] : []));
  const scores = submitted.flatMap((s) => (s.finalScore === null ? [] : [s.finalScore]));
  const late = submitted.filter((s) => s.late).length;
  return {
    assignment,
    pastDue: isPastDue(assignment.due_at, now),
    rows,
    counts: {
      enrolled: rows.length,
      submitted: submitted.length,
      onTime: submitted.length - late,
      late,
      notSubmitted: rows.length - submitted.length,
      needsGrading: rows.filter((r) => r.status === 'needs_grading').length,
    },
    stats: scoreStats(scores),
    distribution: scoreDistribution(scores, assignment.points),
    missedCells: assignment.grading_mode === 'auto' ? mostMissedCells(submitted) : null,
  };
}

/* ------------------------------------------------------------------ */
/* Student reports                                                    */
/* ------------------------------------------------------------------ */

export interface StudentReportRow extends SummaryRow {
  /** Teacher feedback on the latest submission ('' when none). */
  feedback: string;
}

export interface StudentReport {
  student: StudentInfo;
  /** Every assignment of the class in due-date order. */
  rows: StudentReportRow[];
  summary: StudentSummary;
}

function feedbackBySubmission(submissionIds: readonly number[]): Map<number, string> {
  if (submissionIds.length === 0) return new Map();
  const rows = all<{ id: number; feedback: string }>(
    `SELECT id, feedback FROM submissions WHERE id IN (SELECT value FROM json_each(?)) AND feedback <> ''`,
    idList(submissionIds),
  );
  return new Map(rows.map((r) => [r.id, r.feedback]));
}

/**
 * Reports for the given enrolled students (default: the whole roster, sorted by name), from one gradebook.
 * Ids that aren't enrolled are skipped.
 */
export function studentReports(classId: number, studentIds?: readonly number[], now = Date.now()): StudentReport[] {
  const book = buildGradebook(classId);
  const wanted = studentIds ? new Set(studentIds) : null;
  const students = wanted ? book.students.filter((s) => wanted.has(s.id)) : book.students;
  const submissionIds = students.flatMap((s) =>
    Object.values(book.cells[s.id] ?? {}).flatMap((c) => (c.submissionId === null ? [] : [c.submissionId])),
  );
  const feedback = feedbackBySubmission(submissionIds);
  return students.map((student) => {
    const rows = book.assignments.map((assignment) => {
      const cell = book.cells[student.id][assignment.id];
      return {
        assignment,
        cell,
        pastDue: isPastDue(assignment.dueAt, now),
        feedback: (cell.submissionId !== null && feedback.get(cell.submissionId)) || '',
      };
    });
    return { student, rows, summary: studentSummary(rows) };
  });
}

/* ------------------------------------------------------------------ */
/* Gradebook                                                          */
/* ------------------------------------------------------------------ */

export interface GradebookReport {
  book: GradebookResponse;
  /** Past-due flags by assignment id. */
  pastDue: Map<number, boolean>;
  /** By student id. */
  students: Map<number, StudentSummary>;
  /** Final scores of each assignment's scored submissions. */
  assignmentStats: Map<number, ScoreStats | null>;
}

export function gradebookReport(classId: number, now = Date.now()): GradebookReport {
  const book = buildGradebook(classId);
  const pastDue = new Map(book.assignments.map((a) => [a.id, isPastDue(a.dueAt, now)]));
  const students = new Map(
    book.students.map((s) => {
      const cells = book.cells[s.id];
      const rows = book.assignments.map((a) => ({ assignment: a, cell: cells[a.id], pastDue: pastDue.get(a.id)! }));
      return [s.id, studentSummary(rows)];
    }),
  );
  const scores = (id: number) => book.students.flatMap((s) => book.cells[s.id][id].finalScore ?? []);
  const assignmentStats = new Map(book.assignments.map((a) => [a.id, scoreStats(scores(a.id))]));
  return { book, pastDue, students, assignmentStats };
}
