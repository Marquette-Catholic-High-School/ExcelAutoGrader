import { Router, type Request } from 'express';
import type {
  AddStudentsResponse,
  ClassSummary,
  OkResponse,
  ResetPasswordResponse,
  StudentInfo,
} from '../../../shared/types.js';
import { classAccess, teacherClass } from '../access.js';
import { currentUser, requireAuth, requireRole } from '../auth.js';
import { get, run, type ClassRow } from '../db.js';
import { badRequest, forbidden, HttpError, intParam, notFound } from '../http.js';
import {
  addStudents,
  canManageStudentPassword,
  CLASS_DESCRIPTION_MAX_LENGTH,
  classSummary,
  createClass,
  deleteClassAndFiles,
  enroll,
  enrolledStudent,
  jsonBody,
  listClassSummaries,
  listStudents,
  MAX_STUDENTS_PER_REQUEST,
  NAME_MAX_LENGTH,
  normalizeJoinCode,
  resetStudentPassword,
  unenroll,
  uniqueJoinCode,
  validationError,
} from '../services/classes.js';

const router = Router();

interface ClassInput {
  name?: string;
  description?: string;
}

/** Validates name/description. With `partial`, absent fields are left out instead of required. */
function parseClassInput(body: Record<string, unknown>, partial: boolean): ClassInput {
  const fields: Record<string, string> = {};
  const input: ClassInput = {};

  if (!partial || body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) fields.name = 'Give the class a name.';
    else if (name.length > NAME_MAX_LENGTH) fields.name = `Class name must be at most ${NAME_MAX_LENGTH} characters.`;
    else input.name = name;
  }

  if (body.description !== undefined) {
    const description = body.description === null ? '' : body.description;
    if (typeof description !== 'string') fields.description = 'Description must be text.';
    else if (description.trim().length > CLASS_DESCRIPTION_MAX_LENGTH) {
      fields.description = `Description must be at most ${CLASS_DESCRIPTION_MAX_LENGTH} characters.`;
    } else input.description = description.trim();
  }

  if (Object.keys(fields).length > 0) throw validationError(fields);
  return input;
}

const classIdOf = (req: Request) => intParam(req.params.classId, 'class id');
const studentIdOf = (req: Request) => intParam(req.params.studentId, 'student id');
const notInClass = () => notFound('That student is not enrolled in this class.');
const SHARED_STUDENT_PASSWORD =
  "This student is also enrolled in another teacher's class, so their password can't be reset here. " +
  'Ask the student to change it on their Account page.';
const ok: OkResponse = { ok: true };

/* Classes */

router.get('/api/classes', requireAuth, (req, res) => {
  const body: ClassSummary[] = listClassSummaries(currentUser(req));
  res.json(body);
});

router.post('/api/classes', requireAuth, requireRole('teacher'), (req, res) => {
  const user = currentUser(req);
  const input = parseClassInput(jsonBody(req), false);
  const id = createClass(user.id, input.name!, input.description ?? '');
  const body: ClassSummary = classSummary(id, user);
  res.status(201).json(body);
});

/** Students only. Idempotent: joining a class you are already in just returns it. */
router.post('/api/classes/join', requireAuth, (req, res) => {
  const user = currentUser(req);
  if (user.role !== 'student') {
    throw forbidden('Only students join classes with a code. Teachers can create a class instead.');
  }
  const code = normalizeJoinCode(jsonBody(req).joinCode);
  if (!code) {
    const message = 'Enter the join code your teacher gave you.';
    throw badRequest(message, { joinCode: message });
  }
  const cls = get<ClassRow>('SELECT * FROM classes WHERE join_code = ?', code);
  if (!cls) {
    const message = 'No class uses that join code. Check the code with your teacher and try again.';
    throw new HttpError(404, message, { joinCode: message });
  }
  enroll(cls.id, user.id);
  const body: ClassSummary = classSummary(cls.id, user);
  res.json(body);
});

router.get('/api/classes/:classId', requireAuth, (req, res) => {
  const user = currentUser(req);
  const { cls } = classAccess(classIdOf(req), user);
  const body: ClassSummary = classSummary(cls.id, user);
  res.json(body);
});

router.patch('/api/classes/:classId', requireAuth, (req, res) => {
  const user = currentUser(req);
  const cls = teacherClass(classIdOf(req), user);
  const input = parseClassInput(jsonBody(req), true);
  if (input.name !== undefined || input.description !== undefined) {
    run(
      'UPDATE classes SET name = ?, description = ? WHERE id = ?',
      input.name ?? cls.name,
      input.description ?? cls.description,
      cls.id,
    );
  }
  const body: ClassSummary = classSummary(cls.id, user);
  res.json(body);
});

/** Deletes the class with its assignments, submissions and their stored files. Student accounts are kept. */
router.delete('/api/classes/:classId', requireAuth, (req, res) => {
  const cls = teacherClass(classIdOf(req), currentUser(req));
  deleteClassAndFiles(cls.id);
  res.json(ok);
});

router.post('/api/classes/:classId/regenerate-code', requireAuth, (req, res) => {
  const user = currentUser(req);
  const cls = teacherClass(classIdOf(req), user);
  // uniqueJoinCode() never returns a code in use, so the new code always differs from the current one.
  run('UPDATE classes SET join_code = ? WHERE id = ?', uniqueJoinCode(), cls.id);
  const body: ClassSummary = classSummary(cls.id, user);
  res.json(body);
});

/* Students */

router.get('/api/classes/:classId/students', requireAuth, (req, res) => {
  const cls = teacherClass(classIdOf(req), currentUser(req));
  const body: StudentInfo[] = listStudents(cls.id);
  res.json(body);
});

router.post('/api/classes/:classId/students', requireAuth, async (req, res) => {
  const cls = teacherClass(classIdOf(req), currentUser(req));
  const rows = jsonBody(req).students;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw badRequest('Add at least one student.', { students: 'Add at least one student.' });
  }
  if (rows.length > MAX_STUDENTS_PER_REQUEST) {
    const message = `You can add at most ${MAX_STUDENTS_PER_REQUEST} students at a time.`;
    throw badRequest(message, { students: message });
  }
  const body: AddStudentsResponse = await addStudents(cls.id, rows);
  res.json(body);
});

/** Un-enrolls only: the student's account and submissions are kept (re-adding them restores their work). */
router.delete('/api/classes/:classId/students/:studentId', requireAuth, (req, res) => {
  const cls = teacherClass(classIdOf(req), currentUser(req));
  if (!unenroll(cls.id, studentIdOf(req))) throw notInClass();
  res.json(ok);
});

/**
 * Only for accounts this teacher created, or students in no other teacher's class: otherwise any teacher could
 * enroll a student by email and take over their account (see canManageStudentPassword).
 */
router.post('/api/classes/:classId/students/:studentId/reset-password', requireAuth, (req, res) => {
  const teacher = currentUser(req);
  const cls = teacherClass(classIdOf(req), teacher);
  const student = enrolledStudent(cls.id, studentIdOf(req));
  if (!student) throw notInClass();
  if (!canManageStudentPassword(teacher.id, student.id)) throw forbidden(SHARED_STUDENT_PASSWORD);
  const body: ResetPasswordResponse = { tempPassword: resetStudentPassword(student.id) };
  res.json(body);
});

export default router;
