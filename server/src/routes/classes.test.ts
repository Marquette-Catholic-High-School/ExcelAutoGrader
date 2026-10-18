import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type {
  AddStudentsResponse,
  AuthResponse,
  ClassSummary,
  StudentInfo,
  User,
} from '../../../shared/types.js';
import { startTestServer, type TestServer } from '../test-utils.js';

// db.ts reads DATA_DIR at import time, so app modules are imported only after startTestServer().
let srv: TestServer;
let dbm: typeof import('../db.js');
let service: typeof import('../services/classes.js');

before(async () => {
  srv = await startTestServer();
  dbm = await import('../db.js');
  service = await import('../services/classes.js');
});

after(async () => {
  await srv.close();
});

/** Tests check the status first, so bodies are typed as "success or error" for convenient assertions. */
type Body<T> = T & { error: string; fields: Record<string, string> };

const JOIN_CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
let seq = 0;
const uniqueEmail = (prefix = 'student') => `${prefix}.${++seq}-${process.pid}@classes.example.test`;

async function createClass(token: string, name = 'Algebra I', description?: string): Promise<ClassSummary> {
  const res = await srv.request<ClassSummary>('POST', '/api/classes', { token, json: { name, description } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

async function join(token: string, joinCode: string) {
  return srv.request<Body<ClassSummary>>('POST', '/api/classes/join', { token, json: { joinCode } });
}

async function addStudents(token: string, classId: number, students: unknown[]) {
  return srv.request<Body<AddStudentsResponse>>('POST', `/api/classes/${classId}/students`, {
    token,
    json: { students },
  });
}

function login(email: string, password: string) {
  return srv.request<AuthResponse>('POST', '/api/auth/login', { json: { email, password } });
}

/* Direct DB fixtures for assignments/submissions/files (owned by other routers). */

function insertFile(name: string): { id: number; diskPath: string } {
  const stored = `${crypto.randomUUID()}.xlsx`;
  const diskPath = path.join(dbm.UPLOAD_DIR, stored);
  fs.writeFileSync(diskPath, 'test');
  const { lastInsertRowid } = dbm.run(
    'INSERT INTO files (original_name, stored_name, size, uploaded_by, created_at) VALUES (?, ?, 4, NULL, ?)',
    name,
    stored,
    dbm.nowIso(),
  );
  return { id: lastInsertRowid, diskPath };
}

function insertAssignment(classId: number, keyFileId: number | null, templateFileId: number | null): number {
  return dbm.run(
    `INSERT INTO assignments (class_id, title, description, due_at, points, grading_mode, grading_config,
       key_file_id, template_file_id, created_at)
     VALUES (?, 'Budget', '', ?, 10, ?, '{}', ?, ?, ?)`,
    classId,
    dbm.nowIso(),
    keyFileId ? 'auto' : 'manual',
    keyFileId,
    templateFileId,
    dbm.nowIso(),
  ).lastInsertRowid;
}

function insertSubmission(assignmentId: number, studentId: number, fileId: number): number {
  return dbm.run(
    `INSERT INTO submissions (assignment_id, student_id, file_id, attempt, submitted_at, submitted_by)
     VALUES (?, ?, ?, 1, ?, ?)`,
    assignmentId,
    studentId,
    fileId,
    dbm.nowIso(),
    studentId,
  ).lastInsertRowid;
}

async function waitUntilGone(file: string): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    if (!fs.existsSync(file)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

describe('class CRUD', () => {
  let teacher: AuthResponse;
  let otherTeacher: AuthResponse;
  let student: AuthResponse;

  before(async () => {
    teacher = await srv.registerUser('teacher', 'Ms. Frizzle');
    otherTeacher = await srv.registerUser('teacher');
    student = await srv.registerUser('student');
  });

  it('creates a class with a join code and zero counts', async () => {
    const cls = await createClass(teacher.token, '  Spreadsheets 101 ', '  Intro to formulas  ');
    assert.equal(cls.name, 'Spreadsheets 101');
    assert.equal(cls.description, 'Intro to formulas');
    assert.equal(cls.teacherId, teacher.user.id);
    assert.equal(cls.teacherName, 'Ms. Frizzle');
    assert.match(cls.joinCode ?? '', JOIN_CODE);
    assert.equal(cls.studentCount, 0);
    assert.equal(cls.assignmentCount, 0);
    assert.ok(!Number.isNaN(Date.parse(cls.createdAt)));
  });

  it('validates the class name and description', async () => {
    const missing = await srv.request('POST', '/api/classes', { token: teacher.token, json: { name: '   ' } });
    assert.equal(missing.status, 400);
    assert.ok(missing.body.fields.name);

    const tooLong = await srv.request('POST', '/api/classes', {
      token: teacher.token,
      json: { name: 'x'.repeat(101), description: 'y'.repeat(2001) },
    });
    assert.equal(tooLong.status, 400);
    assert.deepEqual(Object.keys(tooLong.body.fields).sort(), ['description', 'name']);
  });

  it('does not let students create classes', async () => {
    const res = await srv.request('POST', '/api/classes', { token: student.token, json: { name: 'Mine' } });
    assert.equal(res.status, 403);
  });

  it('lists only the teacher’s own classes, newest first', async () => {
    const t = await srv.registerUser('teacher');
    const first = await createClass(t.token, 'First');
    const second = await createClass(t.token, 'Second');
    await createClass(otherTeacher.token, 'Not yours');

    const res = await srv.request<ClassSummary[]>('GET', '/api/classes', { token: t.token });
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.map((c) => c.id),
      [second.id, first.id],
    );
    assert.ok(res.body.every((c) => JOIN_CODE.test(c.joinCode ?? '')));
  });

  it('keeps other teachers out of a class', async () => {
    const cls = await createClass(teacher.token, 'Private');
    const opts = { token: otherTeacher.token };
    assert.equal((await srv.request('GET', `/api/classes/${cls.id}`, opts)).status, 403);
    const patch = await srv.request('PATCH', `/api/classes/${cls.id}`, { ...opts, json: { name: 'Hacked' } });
    assert.equal(patch.status, 403);
    assert.equal((await srv.request('DELETE', `/api/classes/${cls.id}`, opts)).status, 403);
    assert.equal((await srv.request('POST', `/api/classes/${cls.id}/regenerate-code`, opts)).status, 403);
    assert.equal((await srv.request('GET', `/api/classes/${cls.id}/students`, opts)).status, 403);
    assert.equal((await addStudents(otherTeacher.token, cls.id, [{ name: 'X', email: uniqueEmail() }])).status, 403);

    const still = await srv.request<ClassSummary>('GET', `/api/classes/${cls.id}`, { token: teacher.token });
    assert.equal(still.body.name, 'Private');
  });

  it('returns 404 for unknown classes, 400 for bad ids and 401 without a token', async () => {
    assert.equal((await srv.request('GET', '/api/classes/999999', { token: teacher.token })).status, 404);
    assert.equal((await srv.request('GET', '/api/classes/abc', { token: teacher.token })).status, 400);
    assert.equal((await srv.request('GET', '/api/classes')).status, 401);
  });

  it('updates the name and description', async () => {
    const cls = await createClass(teacher.token, 'Old name', 'Old description');
    const renamed = await srv.request<ClassSummary>('PATCH', `/api/classes/${cls.id}`, {
      token: teacher.token,
      json: { name: 'New name' },
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.name, 'New name');
    assert.equal(renamed.body.description, 'Old description');
    assert.equal(renamed.body.joinCode, cls.joinCode);

    const cleared = await srv.request<ClassSummary>('PATCH', `/api/classes/${cls.id}`, {
      token: teacher.token,
      json: { description: '' },
    });
    assert.equal(cleared.body.name, 'New name');
    assert.equal(cleared.body.description, '');

    const invalid = await srv.request('PATCH', `/api/classes/${cls.id}`, { token: teacher.token, json: { name: '' } });
    assert.equal(invalid.status, 400);
    assert.ok(invalid.body.fields.name);
  });

  it('counts assignments', async () => {
    const cls = await createClass(teacher.token, 'Counted');
    insertAssignment(cls.id, null, null);
    insertAssignment(cls.id, null, null);
    const res = await srv.request<ClassSummary>('GET', `/api/classes/${cls.id}`, { token: teacher.token });
    assert.equal(res.body.assignmentCount, 2);
  });
});

describe('join codes', () => {
  let teacher: AuthResponse;
  let cls: ClassSummary;

  before(async () => {
    teacher = await srv.registerUser('teacher', 'Mr. Keating');
    cls = await createClass(teacher.token, 'Poetry & Pivot Tables');
  });

  it('lets a student join case-insensitively, hides the code from them, and is idempotent', async () => {
    const student = await srv.registerUser('student');
    const code = cls.joinCode!;
    const typed = ` ${code.slice(0, 3).toLowerCase()}-${code.slice(3).toLowerCase()} `;
    const first = await join(student.token, typed);
    assert.equal(first.status, 200);
    assert.equal(first.body.id, cls.id);
    assert.equal(first.body.teacherName, 'Mr. Keating');
    assert.equal(first.body.studentCount, 1);
    assert.equal('joinCode' in first.body, false);

    const again = await join(student.token, code);
    assert.equal(again.status, 200);
    assert.equal(again.body.studentCount, 1);

    const list = await srv.request<ClassSummary[]>('GET', '/api/classes', { token: student.token });
    assert.deepEqual(
      list.body.map((c) => c.id),
      [cls.id],
    );
    assert.equal('joinCode' in list.body[0], false);

    const detail = await srv.request<ClassSummary>('GET', `/api/classes/${cls.id}`, { token: student.token });
    assert.equal(detail.status, 200);
    assert.equal('joinCode' in detail.body, false);
  });

  it('rejects unknown and empty codes, and teachers', async () => {
    const student = await srv.registerUser('student');
    // O and 0 are not in the join code alphabet, so no class can have this code.
    const unknown = await join(student.token, 'OOO000');
    assert.equal(unknown.status, 404);
    assert.ok(unknown.body.fields.joinCode);

    const empty = await join(student.token, '   ');
    assert.equal(empty.status, 400);
    assert.ok(empty.body.fields.joinCode);

    assert.equal((await join(teacher.token, cls.joinCode!)).status, 403);
  });

  it('keeps non-enrolled students out', async () => {
    const outsider = await srv.registerUser('student');
    const opts = { token: outsider.token };
    assert.equal((await srv.request('GET', `/api/classes/${cls.id}`, opts)).status, 403);
    assert.equal((await srv.request('GET', `/api/classes/${cls.id}/students`, opts)).status, 403);
  });

  it('does not let enrolled students manage the class', async () => {
    const student = await srv.registerUser('student');
    await join(student.token, cls.joinCode!);
    const opts = { token: student.token };
    const patch = await srv.request('PATCH', `/api/classes/${cls.id}`, { ...opts, json: { name: 'Mine' } });
    assert.equal(patch.status, 403);
    assert.equal((await srv.request('DELETE', `/api/classes/${cls.id}`, opts)).status, 403);
    assert.equal((await srv.request('POST', `/api/classes/${cls.id}/regenerate-code`, opts)).status, 403);
    assert.equal((await srv.request('GET', `/api/classes/${cls.id}/students`, opts)).status, 403);
    assert.equal((await addStudents(student.token, cls.id, [{ name: 'Friend', email: uniqueEmail() }])).status, 403);
    assert.equal((await srv.request('DELETE', `/api/classes/${cls.id}/students/${student.user.id}`, opts)).status, 403);
    const reset = await srv.request('POST', `/api/classes/${cls.id}/students/${student.user.id}/reset-password`, opts);
    assert.equal(reset.status, 403);
  });

  it('regenerates the code so the old one stops working', async () => {
    const own = await createClass(teacher.token, 'Rotating');
    const res = await srv.request<ClassSummary>('POST', `/api/classes/${own.id}/regenerate-code`, {
      token: teacher.token,
    });
    assert.equal(res.status, 200);
    assert.match(res.body.joinCode ?? '', JOIN_CODE);
    assert.notEqual(res.body.joinCode, own.joinCode);

    const student = await srv.registerUser('student');
    assert.equal((await join(student.token, own.joinCode!)).status, 404);
    assert.equal((await join(student.token, res.body.joinCode!)).status, 200);
  });

  it('retries when a generated code is already taken', () => {
    const generated = [cls.joinCode!, cls.joinCode!, 'ZZZZZZ'];
    assert.equal(
      service.uniqueJoinCode(() => generated.shift()!),
      'ZZZZZZ',
    );
    assert.match(service.randomJoinCode(), JOIN_CODE);
  });
});

describe('roster', () => {
  let teacher: AuthResponse;
  let cls: ClassSummary;

  before(async () => {
    teacher = await srv.registerUser('teacher');
    cls = await createClass(teacher.token, 'Roster class');
  });

  const listStudents = async (classId = cls.id) =>
    (await srv.request<StudentInfo[]>('GET', `/api/classes/${classId}/students`, { token: teacher.token })).body;

  it('creates new accounts with a temporary password the student must change', async () => {
    const email = uniqueEmail('ada');
    const res = await addStudents(teacher.token, cls.id, [
      { name: ' Ada Lovelace ', email: `  ${email.toUpperCase()} ` },
    ]);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.errors, []);
    assert.equal(res.body.added.length, 1);
    const [result] = res.body.added;
    assert.equal(result.created, true);
    assert.equal(result.alreadyEnrolled, false);
    assert.equal(result.student.name, 'Ada Lovelace');
    assert.equal(result.student.email, email);
    assert.equal(result.student.mustChangePassword, true);
    assert.equal(result.student.canResetPassword, true);
    assert.ok(!Number.isNaN(Date.parse(result.student.joinedAt)));
    const stored = dbm.get<{ created_by_teacher_id: number | null }>(
      'SELECT created_by_teacher_id FROM users WHERE id = ?',
      result.student.id,
    );
    assert.equal(stored?.created_by_teacher_id, teacher.user.id, 'the creating teacher is recorded');
    const tempPassword = result.tempPassword!;
    assert.equal(typeof tempPassword, 'string');
    assert.ok(tempPassword.length >= 8);

    const signedIn = await login(email, tempPassword);
    assert.equal(signedIn.status, 200);
    assert.equal(signedIn.body.user.role, 'student');
    assert.equal(signedIn.body.user.mustChangePassword, true);

    const classes = await srv.request<ClassSummary[]>('GET', '/api/classes', { token: signedIn.body.token });
    assert.deepEqual(
      classes.body.map((c) => c.id),
      [cls.id],
    );

    const changed = await srv.request<{ user: User }>('POST', '/api/auth/change-password', {
      token: signedIn.body.token,
      json: { currentPassword: tempPassword, newPassword: 'my-own-password' },
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.user.mustChangePassword, false);

    const me = await srv.request<{ user: User }>('GET', '/api/auth/me', { token: signedIn.body.token });
    assert.equal(me.body.user.mustChangePassword, false);
    assert.equal((await login(email, tempPassword)).status, 401);
    const roster = await listStudents();
    assert.equal(roster.find((s) => s.email === email)?.mustChangePassword, false);
  });

  it('enrolls existing student accounts and reports when they were already enrolled', async () => {
    const existing = await srv.registerUser('student', 'Existing Student');
    const first = await addStudents(teacher.token, cls.id, [{ name: 'Ignored Name', email: existing.user.email }]);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.errors, []);
    assert.equal(first.body.added[0].created, false);
    assert.equal(first.body.added[0].alreadyEnrolled, false);
    assert.equal(first.body.added[0].tempPassword, undefined);
    assert.equal(first.body.added[0].student.name, 'Existing Student');
    assert.equal(first.body.added[0].student.id, existing.user.id);
    assert.equal(first.body.added[0].student.canResetPassword, true, 'in no other teacher’s class');
    const stored = dbm.get<{ created_by_teacher_id: number | null }>(
      'SELECT created_by_teacher_id FROM users WHERE id = ?',
      existing.user.id,
    );
    assert.equal(stored?.created_by_teacher_id, null, 'enrolling an existing account does not claim it');

    const second = await addStudents(teacher.token, cls.id, [{ name: '', email: existing.user.email.toUpperCase() }]);
    assert.equal(second.body.added[0].alreadyEnrolled, true);
    assert.equal(second.body.added[0].created, false);

    // The student keeps their own password.
    assert.equal((await login(existing.user.email, 'password123')).status, 200);
  });

  it('reports invalid rows and teacher emails, dedupes rows and skips blank ones', async () => {
    const otherTeacher = await srv.registerUser('teacher');
    const dupEmail = uniqueEmail('dup');
    const res = await addStudents(teacher.token, cls.id, [
      { name: 'Bad Email', email: 'not-an-email' },
      { name: '', email: dupEmail },
      { name: 'Teacher Person', email: otherTeacher.user.email },
      { name: '', email: '' },
      { name: 'Dup Second', email: dupEmail.toUpperCase() },
      { name: 'No Email', email: '' },
      { name: '', email: uniqueEmail('nameless') },
      { name: 'Myself', email: teacher.user.email },
      'garbage',
      { name: 'x'.repeat(101), email: uniqueEmail('long') },
    ]);
    assert.equal(res.status, 200);

    assert.equal(res.body.added.length, 1);
    assert.equal(res.body.added[0].student.email, dupEmail);
    assert.equal(res.body.added[0].student.name, 'Dup Second');
    assert.equal(res.body.added[0].created, true);

    assert.deepEqual(
      res.body.errors.map((e) => e.name || e.email),
      ['Bad Email', 'Teacher Person', 'No Email', res.body.errors[3].email, 'Myself', 'x'.repeat(101)],
    );
    assert.match(res.body.errors[3].email, /^nameless\./);
    assert.ok(res.body.errors.every((e) => e.error.length > 0));

    const roster = await listStudents();
    assert.equal(roster.filter((s) => s.email === dupEmail).length, 1);
    assert.ok(!roster.some((s) => s.email === otherTeacher.user.email));
  });

  it('rejects empty, oversized and malformed requests', async () => {
    const empty = await addStudents(teacher.token, cls.id, []);
    assert.equal(empty.status, 400);
    assert.ok(empty.body.fields.students);

    const blank = await addStudents(teacher.token, cls.id, [{ name: ' ', email: ' ' }]);
    assert.equal(blank.status, 400);

    const tooMany = Array.from({ length: 501 }, (_, i) => ({ name: `S${i}`, email: `s${i}@bulk.example.test` }));
    const big = await addStudents(teacher.token, cls.id, tooMany);
    assert.equal(big.status, 400);
    assert.ok(big.body.fields.students);

    const notArray = await srv.request('POST', `/api/classes/${cls.id}/students`, {
      token: teacher.token,
      json: { students: 'ada@example.test' },
    });
    assert.equal(notArray.status, 400);
  });

  it('adds 500 students in one request', async () => {
    const bulkClass = await createClass(teacher.token, 'Lecture hall');
    const rows = Array.from({ length: 500 }, (_, i) => ({ name: `Student ${i}`, email: uniqueEmail('bulk') }));
    const res = await addStudents(teacher.token, bulkClass.id, rows);
    assert.equal(res.status, 200);
    assert.equal(res.body.added.length, 500);
    assert.deepEqual(res.body.errors, []);
    assert.ok(res.body.added.every((a) => a.created && a.tempPassword));
    assert.equal(new Set(res.body.added.map((a) => a.tempPassword)).size > 1, true);

    const sample = res.body.added[123];
    assert.equal((await login(sample.student.email, sample.tempPassword!)).status, 200);
    const summary = await srv.request<ClassSummary>('GET', `/api/classes/${bulkClass.id}`, { token: teacher.token });
    assert.equal(summary.body.studentCount, 500);
  });

  it('lists students sorted by name', async () => {
    const sortedClass = await createClass(teacher.token, 'Sorted');
    await addStudents(teacher.token, sortedClass.id, [
      { name: 'charlie Brown', email: uniqueEmail() },
      { name: 'Alice Smith', email: uniqueEmail() },
      { name: 'bob Jones', email: uniqueEmail() },
    ]);
    const roster = await listStudents(sortedClass.id);
    assert.deepEqual(
      roster.map((s) => s.name),
      ['Alice Smith', 'bob Jones', 'charlie Brown'],
    );
    assert.deepEqual(Object.keys(roster[0]).sort(), [
      'canResetPassword',
      'email',
      'id',
      'joinedAt',
      'mustChangePassword',
      'name',
    ]);
  });

  it('removes a student without deleting their submissions', async () => {
    const student = await srv.registerUser('student');
    await join(student.token, cls.joinCode!);
    const file = insertFile('work.xlsx');
    const submissionId = insertSubmission(insertAssignment(cls.id, null, null), student.user.id, file.id);

    const res = await srv.request('DELETE', `/api/classes/${cls.id}/students/${student.user.id}`, {
      token: teacher.token,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
    assert.ok(!(await listStudents()).some((s) => s.id === student.user.id));
    assert.equal((await srv.request('GET', `/api/classes/${cls.id}`, { token: student.token })).status, 403);
    assert.ok(dbm.get('SELECT 1 FROM submissions WHERE id = ?', submissionId));
    assert.ok(fs.existsSync(file.diskPath));

    const again = await srv.request('DELETE', `/api/classes/${cls.id}/students/${student.user.id}`, {
      token: teacher.token,
    });
    assert.equal(again.status, 404);
  });

  it('resets an enrolled student’s password and signs them out', async () => {
    const student = await srv.registerUser('student');
    await join(student.token, cls.joinCode!);

    const res = await srv.request<{ tempPassword: string }>(
      'POST',
      `/api/classes/${cls.id}/students/${student.user.id}/reset-password`,
      { token: teacher.token },
    );
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.tempPassword, 'string');

    assert.equal((await srv.request('GET', '/api/auth/me', { token: student.token })).status, 401);
    assert.equal((await login(student.user.email, 'password123')).status, 401);
    const signedIn = await login(student.user.email, res.body.tempPassword);
    assert.equal(signedIn.status, 200);
    assert.equal(signedIn.body.user.mustChangePassword, true);
    const roster = await listStudents();
    assert.equal(roster.find((s) => s.id === student.user.id)?.mustChangePassword, true);
  });

  it('lets a teacher reset a self-registered student who is only in their own classes', async () => {
    const student = await srv.registerUser('student');
    const second = await createClass(teacher.token, 'Second period');
    await join(student.token, cls.joinCode!);
    await join(student.token, second.joinCode!);

    const row = (await listStudents()).find((s) => s.id === student.user.id);
    assert.equal(row?.canResetPassword, true);
    const res = await srv.request<{ tempPassword: string }>(
      'POST',
      `/api/classes/${second.id}/students/${student.user.id}/reset-password`,
      { token: teacher.token },
    );
    assert.equal(res.status, 200);
    assert.equal((await login(student.user.email, res.body.tempPassword)).status, 200);
  });

  it('only resets passwords of students in the teacher’s class', async () => {
    const outsider = await srv.registerUser('student');
    const res = await srv.request('POST', `/api/classes/${cls.id}/students/${outsider.user.id}/reset-password`, {
      token: teacher.token,
    });
    assert.equal(res.status, 404);
    assert.equal((await login(outsider.user.email, 'password123')).status, 200);
  });
});

describe('password resets across teachers', () => {
  const SHARED_MESSAGE =
    "This student is also enrolled in another teacher's class, so their password can't be reset here. " +
    'Ask the student to change it on their Account page.';

  let teacherA: AuthResponse;
  let classA: ClassSummary;

  before(async () => {
    teacherA = await srv.registerUser('teacher', 'Teacher A');
    classA = await createClass(teacherA.token, 'A’s class');
  });

  const roster = async (token: string, classId: number) =>
    (await srv.request<StudentInfo[]>('GET', `/api/classes/${classId}/students`, { token })).body;
  const reset = (token: string, classId: number, studentId: number) =>
    srv.request<Body<{ tempPassword: string }>>('POST', `/api/classes/${classId}/students/${studentId}/reset-password`, {
      token,
    });

  /** A freshly self-registered teacher who enrolls `email` into a class of their own. */
  async function otherTeacherEnrolls(email: string) {
    const teacherB = await srv.registerUser('teacher', 'Teacher B');
    const classB = await createClass(teacherB.token, 'B’s class');
    const res = await addStudents(teacherB.token, classB.id, [{ name: 'Whoever', email }]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.errors, []);
    return { teacherB, classB, added: res.body.added[0] };
  }

  it('does not let another teacher take over a student by enrolling them', async () => {
    const victim = await srv.registerUser('student', 'Victim Student');
    await join(victim.token, classA.joinCode!);

    const { teacherB, classB, added } = await otherTeacherEnrolls(victim.user.email);
    assert.equal(added.created, false);
    assert.equal(added.tempPassword, undefined);
    assert.equal(added.student.id, victim.user.id);
    assert.equal(added.student.canResetPassword, false);
    assert.equal((await roster(teacherB.token, classB.id)).find((s) => s.id === victim.user.id)?.canResetPassword, false);

    const res = await reset(teacherB.token, classB.id, victim.user.id);
    assert.equal(res.status, 403);
    assert.equal(res.body.error, SHARED_MESSAGE);
    assert.equal(res.body.tempPassword, undefined);

    // Nothing changed: the old password works, the session survives, no forced password change.
    const signedIn = await login(victim.user.email, 'password123');
    assert.equal(signedIn.status, 200);
    assert.equal(signedIn.body.user.mustChangePassword, false);
    assert.equal((await srv.request('GET', '/api/auth/me', { token: victim.token })).status, 200);

    // Teacher A did not create the account either, and the student is now in B's class too.
    assert.equal((await roster(teacherA.token, classA.id)).find((s) => s.id === victim.user.id)?.canResetPassword, false);
    const byA = await reset(teacherA.token, classA.id, victim.user.id);
    assert.equal(byA.status, 403);
    assert.equal(byA.body.error, SHARED_MESSAGE);
  });

  it('still lets the creating teacher reset a student another teacher enrolled', async () => {
    const created = await addStudents(teacherA.token, classA.id, [{ name: 'Made By A', email: uniqueEmail('made') }]);
    const [student] = created.body.added;
    assert.equal(student.created, true);

    const { teacherB, classB, added } = await otherTeacherEnrolls(student.student.email);
    assert.equal(added.created, false);
    assert.equal(added.student.canResetPassword, false);
    assert.equal((await reset(teacherB.token, classB.id, student.student.id)).status, 403);
    assert.equal((await login(student.student.email, student.tempPassword!)).status, 200);

    assert.equal((await roster(teacherA.token, classA.id)).find((s) => s.id === student.student.id)?.canResetPassword, true);
    const res = await reset(teacherA.token, classA.id, student.student.id);
    assert.equal(res.status, 200);
    assert.equal((await login(student.student.email, student.tempPassword!)).status, 401);
    assert.equal((await login(student.student.email, res.body.tempPassword)).status, 200);
  });

  it('lets a teacher reset once the other teacher removed the student', async () => {
    const student = await srv.registerUser('student');
    await join(student.token, classA.joinCode!);
    const { teacherB, classB } = await otherTeacherEnrolls(student.user.email);
    assert.equal((await reset(teacherA.token, classA.id, student.user.id)).status, 403);

    const removed = await srv.request('DELETE', `/api/classes/${classB.id}/students/${student.user.id}`, {
      token: teacherB.token,
    });
    assert.equal(removed.status, 200);
    assert.equal((await roster(teacherA.token, classA.id)).find((s) => s.id === student.user.id)?.canResetPassword, true);
    assert.equal((await reset(teacherA.token, classA.id, student.user.id)).status, 200);
  });

  it('checks enrollment before the account rule', async () => {
    const elsewhere = await srv.registerUser('student');
    await otherTeacherEnrolls(elsewhere.user.email);
    assert.equal((await reset(teacherA.token, classA.id, elsewhere.user.id)).status, 404);
  });
});

describe('DELETE /api/classes/:classId', () => {
  it('deletes the class, its rows and its stored files, but not other classes’ files', async () => {
    const teacher = await srv.registerUser('teacher');
    const student = await srv.registerUser('student');
    const doomed = await createClass(teacher.token, 'Doomed');
    const kept = await createClass(teacher.token, 'Kept');
    await join(student.token, doomed.joinCode!);
    await join(student.token, kept.joinCode!);

    const key = insertFile('key.xlsx');
    const template = insertFile('template.xlsx');
    const submission = insertFile('submission.xlsx');
    const assignmentId = insertAssignment(doomed.id, key.id, template.id);
    insertSubmission(assignmentId, student.user.id, submission.id);
    insertAssignment(doomed.id, null, null);

    const keptFile = insertFile('kept.xlsx');
    insertSubmission(insertAssignment(kept.id, null, null), student.user.id, keptFile.id);

    const res = await srv.request('DELETE', `/api/classes/${doomed.id}`, { token: teacher.token });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });

    assert.equal((await srv.request('GET', `/api/classes/${doomed.id}`, { token: teacher.token })).status, 404);
    assert.equal(dbm.get('SELECT 1 FROM assignments WHERE class_id = ?', doomed.id), undefined);
    assert.equal(dbm.get('SELECT 1 FROM enrollments WHERE class_id = ?', doomed.id), undefined);
    assert.equal(dbm.get('SELECT 1 FROM submissions WHERE assignment_id = ?', assignmentId), undefined);
    for (const file of [key, template, submission]) {
      assert.equal(dbm.get('SELECT 1 FROM files WHERE id = ?', file.id), undefined);
      assert.ok(await waitUntilGone(file.diskPath), `${file.diskPath} should be deleted`);
    }

    assert.ok(dbm.get('SELECT 1 FROM files WHERE id = ?', keptFile.id));
    assert.ok(fs.existsSync(keptFile.diskPath));
    const studentClasses = await srv.request<ClassSummary[]>('GET', '/api/classes', { token: student.token });
    assert.deepEqual(
      studentClasses.body.map((c) => c.id),
      [kept.id],
    );
    assert.equal((await login(student.user.email, 'password123')).status, 200);

    const again = await srv.request('DELETE', `/api/classes/${doomed.id}`, { token: teacher.token });
    assert.equal(again.status, 404);
  });
});
