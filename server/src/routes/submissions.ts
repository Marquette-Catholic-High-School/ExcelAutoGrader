import { Router, type RequestHandler } from 'express';
import type { AssignmentSubmissionsResponse, SubmissionDetail, SubmissionRow as Row } from '../../../shared/types.js';
import { assignmentAccess, isEnrolled, submissionAccess, teacherAssignment } from '../access.js';
import { currentUser, requireAuth, requireRole } from '../auth.js';
import { get, nowIso, run, transaction, type AssignmentRow, type UserRow } from '../db.js';
import { badRequest, forbidden, intParam, notFound } from '../http.js';
import { getFile, saveFileRecord, sendFile, upload } from '../uploads.js';
import { assignmentWithClass, classRoster, toAssignmentDetail } from '../services/assignments.js';
import { round2 } from '../services/common.js';
import { readConfig } from '../services/config.js';
import { autoGrade } from '../services/grading.js';
import {
  attemptRows,
  latestDetailRows,
  submissionDetailRow,
  teacherRowStatus,
  toSubmissionDetail,
  type Viewer,
} from '../services/submissions.js';
import { withUploads } from '../services/upload-tracker.js';
import { unreadableReason, viewerWorkbook } from '../services/workbooks.js';

const router = Router();

const MAX_FEEDBACK = 10_000;

const assignmentIdOf = (params: Record<string, unknown>) => intParam(params.assignmentId, 'assignment id');
const submissionIdOf = (params: Record<string, unknown>) => intParam(params.submissionId, 'submission id');

function detailFor(submissionId: number, assignment: AssignmentRow, viewer: Viewer): SubmissionDetail {
  const row = submissionDetailRow(submissionId);
  if (!row) throw notFound('Submission not found.');
  return toSubmissionDetail(row, assignment, viewer);
}

/* ------------------------------------------------------------------ */
/* Lists                                                              */
/* ------------------------------------------------------------------ */

router.get('/api/assignments/:assignmentId/submissions', requireAuth, requireRole('teacher'), (req, res) => {
  const user = currentUser(req);
  const { assignment } = teacherAssignment(assignmentIdOf(req.params), user);
  const config = readConfig(assignment);
  const latest = new Map(latestDetailRows(assignment.id).map((row) => [row.student_id, row]));
  const rows: Row[] = classRoster(assignment.class_id).map((student) => {
    const row = latest.get(student.id);
    return {
      student,
      status: teacherRowStatus(row),
      attemptCount: row?.attempt_count ?? 0,
      latest: row ? toSubmissionDetail(row, assignment, 'teacher', config) : null,
    };
  });
  const body: AssignmentSubmissionsResponse = {
    assignment: toAssignmentDetail(assignmentWithClass(assignment.id)!, user, true),
    rows,
  };
  res.json(body);
});

router.get(
  '/api/assignments/:assignmentId/students/:studentId/submissions',
  requireAuth,
  requireRole('teacher'),
  (req, res) => {
    const { assignment } = teacherAssignment(assignmentIdOf(req.params), currentUser(req));
    const studentId = intParam(req.params.studentId, 'student id');
    const student = get<Pick<UserRow, 'id'>>("SELECT id FROM users WHERE id = ? AND role = 'student'", studentId);
    if (!student) throw notFound('Student not found.');
    const config = readConfig(assignment);
    const attempts = attemptRows(assignment.id, studentId);
    res.json(attempts.map((row) => toSubmissionDetail(row, assignment, 'teacher', config)));
  },
);

router.get('/api/assignments/:assignmentId/my-submissions', requireAuth, requireRole('student'), (req, res) => {
  const user = currentUser(req);
  const { assignment } = assignmentAccess(assignmentIdOf(req.params), user);
  const config = readConfig(assignment);
  res.json(attemptRows(assignment.id, user.id).map((row) => toSubmissionDetail(row, assignment, 'student', config)));
});

/* ------------------------------------------------------------------ */
/* Upload                                                             */
/* ------------------------------------------------------------------ */

/**
 * Checks access before multer stores anything, and records when the request arrived: a large upload that
 * starts before the deadline is not late just because the transfer took a while.
 */
const canSubmit: RequestHandler = (req, res, next) => {
  res.locals.receivedAt = nowIso();
  assignmentAccess(assignmentIdOf(req.params), currentUser(req));
  next();
};

/** Who the submission is for: the student themself, or (teacher uploads) the enrolled student named in the form. */
function resolveStudentId(body: unknown, user: UserRow, isTeacher: boolean, classId: number): number {
  const raw = (body as Record<string, unknown> | undefined)?.studentId;
  const given = raw === undefined || raw === null || raw === '' ? null : Number(raw);
  if (!isTeacher) {
    if (given !== null && given !== user.id) throw forbidden('You can only submit your own work.');
    return user.id;
  }
  const message = 'Choose the student you are uploading this file for.';
  if (given === null) throw badRequest(message, { studentId: message });
  if (!Number.isInteger(given) || given <= 0 || !isEnrolled(classId, given)) {
    const notEnrolled = 'That student is not enrolled in this class.';
    throw badRequest(notEnrolled, { studentId: notEnrolled });
  }
  return given;
}

router.post(
  '/api/assignments/:assignmentId/submissions',
  requireAuth,
  canSubmit,
  upload.single('file'),
  withUploads((req, res, uploads) => {
    const user = currentUser(req);
    const { assignment, isTeacher } = assignmentAccess(assignmentIdOf(req.params), user);
    const studentId = resolveStudentId(req.body, user, isTeacher, assignment.class_id);
    const file = uploads.file('file');
    if (!file) {
      const message = 'Choose an Excel file to upload.';
      throw badRequest(message, { file: message });
    }
    const unreadable = unreadableReason(file);
    if (unreadable) throw badRequest(unreadable, { file: unreadable });

    // Grading never throws: failures are stored as auto_status = 'error' and the teacher grades by hand.
    const result = autoGrade(assignment, file.path);
    const submittedAt = typeof res.locals.receivedAt === 'string' ? res.locals.receivedAt : nowIso();
    const submissionId = transaction(() => {
      const stored = saveFileRecord(file, user.id);
      const { next } = get<{ next: number }>(
        'SELECT COALESCE(MAX(attempt), 0) + 1 AS next FROM submissions WHERE assignment_id = ? AND student_id = ?',
        assignment.id,
        studentId,
      )!;
      return run(
        `INSERT INTO submissions (assignment_id, student_id, file_id, attempt, submitted_at, submitted_by,
           auto_status, auto_score, auto_report, auto_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        assignment.id,
        studentId,
        stored.id,
        next,
        submittedAt,
        user.id,
        result.auto_status,
        result.auto_score,
        result.auto_report,
        result.auto_error,
      ).lastInsertRowid;
    });
    uploads.keep(file);
    res.json(detailFor(submissionId, assignment, isTeacher ? 'teacher' : 'student'));
  }),
);

/* ------------------------------------------------------------------ */
/* Single submission                                                  */
/* ------------------------------------------------------------------ */

router.get('/api/submissions/:submissionId', requireAuth, (req, res) => {
  const { submission, assignment, isTeacher } = submissionAccess(submissionIdOf(req.params), currentUser(req));
  res.json(detailFor(submission.id, assignment, isTeacher ? 'teacher' : 'student'));
});

function parseScore(raw: unknown, points: number): number | null {
  if (raw === null || raw === '') return null;
  const score = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
  const max = round2(points * 2);
  if (!Number.isFinite(score)) throw badRequest('Enter a score as a number.', { score: 'Enter a score as a number.' });
  if (score < 0 || score > max) {
    const message = `The score must be between 0 and ${max} (up to double the ${points} points for extra credit).`;
    throw badRequest(message, { score: message });
  }
  return round2(score);
}

function parseFeedback(raw: unknown): string {
  if (typeof raw !== 'string') throw badRequest('Feedback must be text.', { feedback: 'Feedback must be text.' });
  const feedback = raw.trim();
  if (feedback.length > MAX_FEEDBACK) {
    const message = 'Feedback can be at most 10,000 characters.';
    throw badRequest(message, { feedback: message });
  }
  return feedback;
}

router.patch('/api/submissions/:submissionId/grade', requireAuth, requireRole('teacher'), (req, res) => {
  const user = currentUser(req);
  const { submission, assignment, isTeacher } = submissionAccess(submissionIdOf(req.params), user);
  if (!isTeacher) throw forbidden('Only the class teacher can grade submissions.');
  const body = (req.body ?? {}) as Record<string, unknown>;
  // Both fields are optional so a client can update just one; GradeSubmissionRequest sends both.
  const score = 'score' in body ? parseScore(body.score, assignment.points) : submission.override_score;
  const feedback = 'feedback' in body && body.feedback !== null ? parseFeedback(body.feedback) : submission.feedback;
  // Clearing both the override and the feedback returns the submission to its ungraded/autograded state.
  const touched = score !== null || feedback !== '';
  run(
    'UPDATE submissions SET override_score = ?, feedback = ?, graded_by = ?, graded_at = ? WHERE id = ?',
    score,
    feedback,
    touched ? user.id : null,
    touched ? nowIso() : null,
    submission.id,
  );
  res.json(detailFor(submission.id, assignment, 'teacher'));
});

/* ------------------------------------------------------------------ */
/* Files                                                              */
/* ------------------------------------------------------------------ */

router.get('/api/submissions/:submissionId/download', requireAuth, (req, res) => {
  const { submission } = submissionAccess(submissionIdOf(req.params), currentUser(req));
  sendFile(res, getFile(submission.file_id));
});

router.get('/api/submissions/:submissionId/workbook', requireAuth, (req, res) => {
  const { submission } = submissionAccess(submissionIdOf(req.params), currentUser(req));
  res.json(viewerWorkbook(getFile(submission.file_id)));
});

export default router;
