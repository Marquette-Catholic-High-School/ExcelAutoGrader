/**
 * Assignment queries and mappers (row → AssignmentSummary / AssignmentDetail) shared by the assignment,
 * submission and gradebook routers. Lists are built with a constant number of queries regardless of how
 * many assignments or students there are.
 */
import type {
  AssignmentDetail,
  AssignmentSummary,
  MySubmissionSummary,
  StudentInfo,
} from '../../../shared/types.js';
import { all, get, type AssignmentRow, type UserRow } from '../db.js';
import { getFile, toFileInfo } from '../uploads.js';
import { idList, lateness } from './common.js';
import { readConfig } from './config.js';
import { finalScore, latestBriefRows, studentStatus, type LatestBriefRow } from './submissions.js';

export type AssignmentWithClass = AssignmentRow & { class_name: string };

const SELECT_WITH_CLASS = 'SELECT a.*, c.name AS class_name FROM assignments a JOIN classes c ON c.id = a.class_id';
const ORDER = 'ORDER BY a.due_at ASC, a.id ASC';

export function assignmentWithClass(assignmentId: number): AssignmentWithClass | undefined {
  return get<AssignmentWithClass>(`${SELECT_WITH_CLASS} WHERE a.id = ?`, assignmentId);
}

export function classAssignments(classId: number): AssignmentWithClass[] {
  return all<AssignmentWithClass>(`${SELECT_WITH_CLASS} WHERE a.class_id = ? ${ORDER}`, classId);
}

/** Teachers: assignments of every class they own. Students: of every class they are enrolled in. */
export function userAssignments(user: UserRow): AssignmentWithClass[] {
  if (user.role === 'teacher') {
    return all<AssignmentWithClass>(`${SELECT_WITH_CLASS} WHERE c.teacher_id = ? ${ORDER}`, user.id);
  }
  return all<AssignmentWithClass>(
    `${SELECT_WITH_CLASS} JOIN enrollments e ON e.class_id = a.class_id WHERE e.student_id = ? ${ORDER}`,
    user.id,
  );
}

type RosterUserRow = Pick<UserRow, 'id' | 'name' | 'email' | 'must_change_password' | 'pending'> & {
  joined_at: string;
};

/** Enrolled students of a class (pending, not yet signed-up ones included), sorted by name. */
export function classRoster(classId: number): StudentInfo[] {
  const rows = all<RosterUserRow>(
    `SELECT u.id, u.name, u.email, u.must_change_password, u.pending, e.joined_at
     FROM enrollments e JOIN users u ON u.id = e.student_id
     WHERE e.class_id = ? ORDER BY u.name COLLATE NOCASE ASC, u.id ASC`,
    classId,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    joinedAt: r.joined_at,
    mustChangePassword: !!r.must_change_password,
    pending: !!r.pending,
  }));
}

function baseSummary(row: AssignmentWithClass): AssignmentSummary {
  return {
    id: row.id,
    classId: row.class_id,
    className: row.class_name,
    title: row.title,
    dueAt: row.due_at,
    points: row.points,
    gradingMode: row.grading_mode,
    createdAt: row.created_at,
  };
}

function groupByAssignment(rows: readonly LatestBriefRow[]): Map<number, LatestBriefRow[]> {
  const map = new Map<number, LatestBriefRow[]>();
  for (const row of rows) {
    const list = map.get(row.assignment_id);
    if (list) list.push(row);
    else map.set(row.assignment_id, [row]);
  }
  return map;
}

function enrolledCounts(classIds: readonly number[]): Map<number, number> {
  const rows = all<{ class_id: number; n: number }>(
    `SELECT class_id, COUNT(*) AS n FROM enrollments
     WHERE class_id IN (SELECT value FROM json_each(?)) GROUP BY class_id`,
    idList([...new Set(classIds)]),
  );
  return new Map(rows.map((r) => [r.class_id, r.n]));
}

/**
 * Summaries with teacher counts. Pass `latest` (latestBriefRows of these assignments) when the caller
 * already loaded it, to avoid running the query twice.
 */
export function teacherSummaries(
  rows: readonly AssignmentWithClass[],
  latest: readonly LatestBriefRow[] = latestBriefRows(rows.map((r) => r.id)),
): AssignmentSummary[] {
  const enrolled = enrolledCounts(rows.map((r) => r.class_id));
  const byAssignment = groupByAssignment(latest);
  return rows.map((row) => {
    const subs = byAssignment.get(row.id) ?? [];
    const late = subs.filter((s) => lateness(s.submitted_at, row.due_at).late);
    return {
      ...baseSummary(row),
      counts: {
        students: enrolled.get(row.class_id) ?? 0,
        submitted: subs.length,
        late: late.length,
        needsGrading: subs.filter((s) => finalScore(s) === null).length,
        lateUngraded: late.filter((s) => finalScore(s) === null).length,
      },
    };
  });
}

export function mySubmissionSummary(row: AssignmentRow, latest: LatestBriefRow | undefined): MySubmissionSummary {
  return {
    status: studentStatus(latest, row.due_at),
    latestSubmissionId: latest?.id ?? null,
    submittedAt: latest?.submitted_at ?? null,
    late: latest ? lateness(latest.submitted_at, row.due_at).late : false,
    attemptCount: latest?.attempt_count ?? 0,
    finalScore: latest ? finalScore(latest) : null,
  };
}

/** Summaries with the student's own status (`mine`). */
export function studentSummaries(rows: readonly AssignmentWithClass[], studentId: number): AssignmentSummary[] {
  const latest = latestBriefRows(
    rows.map((r) => r.id),
    studentId,
  );
  const byAssignment = new Map(latest.map((l) => [l.assignment_id, l]));
  return rows.map((row) => ({ ...baseSummary(row), mine: mySubmissionSummary(row, byAssignment.get(row.id)) }));
}

export function summariesFor(rows: readonly AssignmentWithClass[], user: UserRow, isTeacher: boolean) {
  return isTeacher ? teacherSummaries(rows) : studentSummaries(rows, user.id);
}

/** Teachers get the key and full grading config; students only the template and visibility flags. */
export function toAssignmentDetail(row: AssignmentWithClass, user: UserRow, isTeacher: boolean): AssignmentDetail {
  const config = readConfig(row);
  const [summary] = summariesFor([row], user, isTeacher);
  const common = { ...summary, description: row.description, template: toFileInfo(getFile(row.template_file_id)) };
  if (isTeacher) return { ...common, key: toFileInfo(getFile(row.key_file_id)), gradingConfig: config };
  return {
    ...common,
    studentVisibility: {
      showDetailsToStudents: config.showDetailsToStudents,
      showExpectedToStudents: config.showExpectedToStudents,
    },
  };
}
