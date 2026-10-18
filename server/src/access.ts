/**
 * Authorization helpers shared by every router. Each loader throws 404/403 HttpErrors, so handlers can
 * simply `const { cls } = classAccess(id, user)` and trust the result.
 *
 * Rules:
 * - A teacher can see and change only classes they own (and everything inside them).
 * - A student can see classes they are enrolled in, the assignments of those classes, and only their
 *   own submissions.
 */
import { get, type AssignmentRow, type ClassRow, type SubmissionRow, type UserRow } from './db.js';
import { forbidden, notFound } from './http.js';

export interface ClassAccess {
  cls: ClassRow;
  isTeacher: boolean; // viewer owns the class
}

export function isEnrolled(classId: number, studentId: number): boolean {
  return !!get('SELECT 1 FROM enrollments WHERE class_id = ? AND student_id = ?', classId, studentId);
}

/** Owner teacher or enrolled student. */
export function classAccess(classId: number, user: UserRow): ClassAccess {
  const cls = get<ClassRow>('SELECT * FROM classes WHERE id = ?', classId);
  if (!cls) throw notFound('Class not found.');
  if (user.role === 'teacher') {
    if (cls.teacher_id !== user.id) throw forbidden();
    return { cls, isTeacher: true };
  }
  if (!isEnrolled(classId, user.id)) throw forbidden('You are not enrolled in this class.');
  return { cls, isTeacher: false };
}

/** Owner teacher only. */
export function teacherClass(classId: number, user: UserRow): ClassRow {
  const { cls, isTeacher } = classAccess(classId, user);
  if (!isTeacher) throw forbidden('Only the class teacher can do that.');
  return cls;
}

export interface AssignmentAccess extends ClassAccess {
  assignment: AssignmentRow;
}

export function assignmentAccess(assignmentId: number, user: UserRow): AssignmentAccess {
  const assignment = get<AssignmentRow>('SELECT * FROM assignments WHERE id = ?', assignmentId);
  if (!assignment) throw notFound('Assignment not found.');
  return { assignment, ...classAccess(assignment.class_id, user) };
}

export function teacherAssignment(assignmentId: number, user: UserRow): AssignmentAccess {
  const access = assignmentAccess(assignmentId, user);
  if (!access.isTeacher) throw forbidden('Only the class teacher can do that.');
  return access;
}

export interface SubmissionAccess extends AssignmentAccess {
  submission: SubmissionRow;
}

/** Class teacher, or the student who owns the submission. */
export function submissionAccess(submissionId: number, user: UserRow): SubmissionAccess {
  const submission = get<SubmissionRow>('SELECT * FROM submissions WHERE id = ?', submissionId);
  if (!submission) throw notFound('Submission not found.');
  const access = assignmentAccess(submission.assignment_id, user);
  if (!access.isTeacher && submission.student_id !== user.id) throw forbidden();
  return { ...access, submission };
}
