/**
 * Adding students by email before they have an account (pending accounts), the sign-up that takes such an account
 * over, and roster uploads (POST /api/classes/:classId/students/import-preview).
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import * as XLSX from 'xlsx';
import type {
  AddStudentsResponse,
  ApiError,
  AssignmentSubmissionsResponse,
  AssignmentSummary,
  AuthResponse,
  ClassSummary,
  GradebookResponse,
  RosterPreview,
  StudentInfo,
  SubmissionDetail,
  User,
} from '../../../shared/types.js';
import {
  GARBAGE,
  PERFECT,
  createAssignment,
  eventually,
  expectOk,
  setupClass,
  submitRequest,
  uploadedFileNames,
  type ClassFixture,
} from '../services/test-fixtures.js';
import { fileBlob, startTestServer, type TestServer } from '../test-utils.js';

// db.ts reads DATA_DIR at import time, so app modules are imported only after startTestServer().
let srv: TestServer;
let dbm: typeof import('../db.js');

before(async () => {
  srv = await startTestServer();
  dbm = await import('../db.js');
});

after(() => srv.close());

/** Tests check the status first, so bodies are typed as "success or error" for convenient assertions. */
type Body<T> = T & ApiError & { fields: Record<string, string> };

const NEEDS_SIGNUP =
  "Your teacher added this email, but you haven't created your account yet. Choose “Create an account” and sign " +
  'up with this email.';
const INVITED_AS_STUDENT = 'A teacher added this email as a student. Sign up as a student to join your classes.';

let seq = 0;
const uniqueEmail = (prefix: string) => `${prefix}.${++seq}-${process.pid}@invites.example.test`;

const addStudents = (token: string, classId: number, students: { name: string; email: string }[]) =>
  srv.request<Body<AddStudentsResponse>>('POST', `/api/classes/${classId}/students`, { token, json: { students } });

const roster = async (fx: ClassFixture) =>
  expectOk(
    await srv.request<StudentInfo[]>('GET', `/api/classes/${fx.classId}/students`, { token: fx.teacher.token }),
    'roster',
  );

const register = (
  name: string,
  email: string,
  role: 'student' | 'teacher',
  { password = 'my-password-1', joinCode }: { password?: string; joinCode?: string } = {},
) => srv.request<Body<AuthResponse>>('POST', '/api/auth/register', { json: { name, email, password, role, joinCode } });

const login = (email: string, password: string) =>
  srv.request<Body<AuthResponse>>('POST', '/api/auth/login', { json: { email, password } });

const removeStudent = (fx: ClassFixture, studentId: number) =>
  srv.request('DELETE', `/api/classes/${fx.classId}/students/${studentId}`, { token: fx.teacher.token });

const resetPassword = (fx: ClassFixture, studentId: number) =>
  srv.request<Body<{ tempPassword: string }>>(
    'POST',
    `/api/classes/${fx.classId}/students/${studentId}/reset-password`,
    { token: fx.teacher.token },
  );

/** The class's join code, as its teacher sees it. */
async function joinCode(fx: ClassFixture): Promise<string> {
  const cls = expectOk(
    await srv.request<ClassSummary>('GET', `/api/classes/${fx.classId}`, { token: fx.teacher.token }),
    'class',
  );
  return cls.joinCode!;
}

/** Invites one email into the class and returns the pending student. */
async function invite(fx: ClassFixture, email: string, name = ''): Promise<StudentInfo> {
  const res = await addStudents(fx.teacher.token, fx.classId, [{ name, email }]);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.errors, []);
  return res.body.added[0].student;
}

/** The stored account (a plain object, so it compares with deepEqual), or undefined when it was deleted. */
function userRow(id: number) {
  const row = dbm.get<{ name: string; pending: number; placeholder_name: number; password_hash: string }>(
    'SELECT name, pending, placeholder_name, password_hash FROM users WHERE id = ?',
    id,
  );
  return row && { ...row };
}

describe('inviting students who have no account yet', () => {
  let fx: ClassFixture;
  let grace: StudentInfo;
  let alan: StudentInfo;
  let graceEmail: string;
  let assignmentId: number;
  let code: string;

  before(async () => {
    fx = await setupClass(srv, [], 'Invited Spreadsheets');
    graceEmail = uniqueEmail('grace.hopper');
    const res = await addStudents(fx.teacher.token, fx.classId, [
      { name: '', email: graceEmail },
      { name: 'Alan Turing', email: uniqueEmail('aturing') },
    ]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    [grace, alan] = res.body.added.map((a) => a.student);
    assignmentId = (await createAssignment(srv, fx, { title: 'Budget' })).id;
    code = await joinCode(fx);
  });

  it('adds them as pending students with the teacher’s name or a placeholder made from the email', async () => {
    assert.equal(grace.name, 'Grace Hopper');
    assert.equal(alan.name, 'Alan Turing');
    assert.deepEqual(userRow(grace.id), { name: 'Grace Hopper', pending: 1, placeholder_name: 1, password_hash: '' });
    assert.equal(userRow(alan.id)?.placeholder_name, 0);
    const students = await roster(fx);
    assert.deepEqual(
      students.map((s) => [s.name, s.pending, s.mustChangePassword, s.canResetPassword]),
      [
        ['Alan Turing', true, false, true],
        ['Grace Hopper', true, false, true],
      ],
    );
    const cls = expectOk(
      await srv.request<ClassSummary>('GET', `/api/classes/${fx.classId}`, { token: fx.teacher.token }),
      'class',
    );
    assert.equal(cls.studentCount, 2);
  });

  it('lets the teacher upload work for a pending student, autograded and listed everywhere', async () => {
    const upload = await submitRequest(srv, fx.teacher.token, assignmentId, PERFECT, { studentId: grace.id });
    const sub = expectOk(upload, 'teacher upload');
    assert.equal(sub.studentId, grace.id);
    assert.equal(sub.studentName, 'Grace Hopper');
    assert.equal(sub.submittedByName, 'Ms. Rivera');
    assert.equal(sub.autoStatus, 'graded');
    assert.equal(sub.finalScore, 100);

    const list = expectOk(
      await srv.request<AssignmentSubmissionsResponse>('GET', `/api/assignments/${assignmentId}/submissions`, {
        token: fx.teacher.token,
      }),
      'submissions',
    );
    assert.deepEqual(
      list.rows.map((r) => [r.student.name, r.student.pending, r.status]),
      [
        ['Alan Turing', true, 'missing'],
        ['Grace Hopper', true, 'autograded'],
      ],
    );
    assert.deepEqual(list.assignment.counts, { students: 2, submitted: 1, late: 0, needsGrading: 0, lateUngraded: 0 });

    const book = expectOk(
      await srv.request<GradebookResponse>('GET', `/api/classes/${fx.classId}/gradebook`, { token: fx.teacher.token }),
      'gradebook',
    );
    assert.deepEqual(
      book.students.map((s) => [s.name, s.pending]),
      [
        ['Alan Turing', true],
        ['Grace Hopper', true],
      ],
    );
    assert.equal(book.cells[grace.id][assignmentId].finalScore, 100);
    const csvUrl = `/api/classes/${fx.classId}/gradebook.csv`;
    const csv = await srv.request<string>('GET', csvUrl, { token: fx.teacher.token });
    assert.match(csv.body, /Grace Hopper,grace\.hopper\.[^,]+,100,100/);
    assert.match(csv.body, /Alan Turing,aturing\.[^,]+,,0/);
  });

  it('tells a pending student who tries to sign in to create their account', async () => {
    const res = await login(graceEmail, 'whatever-they-typed');
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: NEEDS_SIGNUP, code: 'needs_signup', fields: { email: NEEDS_SIGNUP } });
  });

  it('refuses a teacher sign-up with the email of a pending student', async () => {
    const res = await register('Grace Hopper', graceEmail, 'teacher');
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { error: INVITED_AS_STUDENT, fields: { email: INVITED_AS_STUDENT } });
    assert.equal(userRow(grace.id)?.pending, 1, 'nothing changed');
  });

  it('matches the student’s sign-up to the account, with their classes and the teacher’s uploads', async () => {
    const res = await register('Grace B. Hopper', `  ${graceEmail.toUpperCase()}  `, 'student', { joinCode: code });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.user.id, grace.id);
    assert.equal(res.body.user.name, 'Grace B. Hopper', 'the placeholder name is replaced');
    assert.equal(res.body.user.email, graceEmail);
    assert.equal(res.body.user.role, 'student');
    assert.equal(res.body.user.mustChangePassword, false);
    assert.deepEqual(res.body.claimedClasses, ['Invited Spreadsheets']);
    assert.deepEqual(userRow(grace.id)?.pending, 0);
    assert.deepEqual(userRow(grace.id)?.placeholder_name, 0);

    const token = res.body.token;
    const me = expectOk(await srv.request<{ user: User }>('GET', '/api/auth/me', { token }), 'me');
    assert.equal(me.user.id, grace.id);
    const classes = expectOk(await srv.request<ClassSummary[]>('GET', '/api/classes', { token }), 'classes');
    assert.deepEqual(
      classes.map((c) => c.id),
      [fx.classId],
    );
    const mine = expectOk(
      await srv.request<SubmissionDetail[]>('GET', `/api/assignments/${assignmentId}/my-submissions`, { token }),
      'my submissions',
    );
    assert.deepEqual(
      mine.map((s) => [s.submittedByName, s.finalScore]),
      [['Ms. Rivera', 100]],
    );
    const [summary] = expectOk(await srv.request<AssignmentSummary[]>('GET', '/api/me/assignments', { token }), 'me');
    assert.equal(summary.mine?.status, 'graded');

    assert.equal((await login(graceEmail, 'my-password-1')).status, 200);
    const students = await roster(fx);
    assert.equal(students.find((s) => s.id === grace.id)?.pending, false);
  });

  it('keeps a name the teacher typed when the student signs up', async () => {
    const email = dbm.get<{ email: string }>('SELECT email FROM users WHERE id = ?', alan.id)!.email;
    const res = await register('Al T', email, 'student', { joinCode: code });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.user.name, 'Alan Turing');
    assert.deepEqual(res.body.claimedClasses, ['Invited Spreadsheets']);
  });

  it('treats a second sign-up with the same email as a duplicate', async () => {
    const res = await register('Impostor', graceEmail, 'student', { joinCode: code });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'An account with this email already exists. Try signing in instead.');
    assert.equal(res.body.claimedClasses, undefined);
    assert.equal((await login(graceEmail, 'my-password-1')).status, 200);
  });

  it('leaves claimedClasses out of a normal sign-up', async () => {
    const res = await register('Fresh Student', uniqueEmail('fresh'), 'student');
    assert.equal(res.status, 201);
    assert.equal('claimedClasses' in res.body, false);
  });
});

describe('the class code an invited student signs up with', () => {
  const CODE_REQUIRED = 'Enter the class code your teacher gave you.';
  const CODE_MISMATCH = "That code doesn't match your classes. Check it with your teacher.";
  const refusal = (error: string) => ({ error, code: 'join_code_required', fields: { joinCode: error } });
  let fx: ClassFixture;
  let code: string;

  before(async () => {
    fx = await setupClass(srv, [], 'Coded class');
    code = await joinCode(fx);
  });

  /** A refused sign-up changes nothing: the account is still pending, without a password. */
  function assertStillPending(id: number) {
    assert.deepEqual([userRow(id)?.pending, userRow(id)?.password_hash], [1, '']);
  }

  it('claims the account with its class’s code, in any case and with spaces or dashes', async () => {
    const email = uniqueEmail('coded');
    const student = await invite(fx, email);
    const typed = ` ${code.slice(0, 3).toLowerCase()}-${code.slice(3)} `;
    const res = await register('Coded Student', email, 'student', { joinCode: typed });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.user.id, student.id);
    assert.deepEqual(res.body.claimedClasses, ['Coded class']);
    assert.equal(userRow(student.id)?.pending, 0);
  });

  it('refuses a sign-up without the code', async () => {
    const email = uniqueEmail('nocode');
    const student = await invite(fx, email);
    for (const missing of [undefined, '', ' - ']) {
      const res = await register('No Code', email, 'student', { joinCode: missing });
      assert.equal(res.status, 400);
      assert.deepEqual(res.body, refusal(CODE_REQUIRED));
    }
    assertStillPending(student.id);
    assert.equal((await login(email, 'my-password-1')).body.code, 'needs_signup');
  });

  it('refuses a wrong code and the code of a class the student is not in', async () => {
    const email = uniqueEmail('wrongcode');
    const student = await invite(fx, email);
    const notTheirs = await joinCode(await setupClass(srv, [], 'Not their class'));
    for (const wrong of ['000000', notTheirs]) {
      const res = await register('Wrong Code', email, 'student', { joinCode: wrong });
      assert.equal(res.status, 400);
      assert.deepEqual(res.body, refusal(CODE_MISMATCH));
    }
    assertStillPending(student.id);
    const res = await register('Wrong Code', email, 'student', { joinCode: code });
    assert.equal(res.status, 201, 'the right code still works afterwards');
  });

  it('accepts the code of any of the student’s classes and brings all of them', async () => {
    const other = await setupClass(srv, [], 'Second teacher class');
    const email = uniqueEmail('twocodes');
    const student = await invite(fx, email);
    await invite(other, email);
    const res = await register('Two Classes', email, 'student', { joinCode: await joinCode(other) });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.user.id, student.id);
    assert.deepEqual(res.body.claimedClasses, ['Coded class', 'Second teacher class']);
  });

  it('needs no code for an account that is in no class', async () => {
    const assignment = await createAssignment(srv, fx, { title: 'Kept for later' });
    const email = uniqueEmail('noclass');
    const student = await invite(fx, email);
    expectOk(await submitRequest(srv, fx.teacher.token, assignment.id, PERFECT, { studentId: student.id }), 'upload');
    assert.equal((await removeStudent(fx, student.id)).status, 200);
    assert.equal(userRow(student.id)?.pending, 1, 'kept for its submission');

    const res = await register('No Class', email, 'student');
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.user.id, student.id);
    assert.deepEqual(res.body.claimedClasses, []);
  });

  it('ignores a code in a sign-up that matches no invited account', async () => {
    const res = await register('Not Invited', uniqueEmail('notinvited'), 'student', { joinCode: code });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal('claimedClasses' in res.body, false);
    const classes = await srv.request<ClassSummary[]>('GET', '/api/classes', { token: res.body.token });
    assert.deepEqual(classes.body, [], 'the code does not join the class');
  });

  it('REQUIRE_CODE_FOR_INVITES=0 (or false, no, off) lets the email alone claim the account', async (t) => {
    const saved = process.env.REQUIRE_CODE_FOR_INVITES;
    t.after(() => {
      if (saved === undefined) delete process.env.REQUIRE_CODE_FOR_INVITES;
      else process.env.REQUIRE_CODE_FOR_INVITES = saved;
    });

    for (const on of ['1', 'yes', '']) {
      process.env.REQUIRE_CODE_FOR_INVITES = on;
      const email = uniqueEmail('switchon');
      const student = await invite(fx, email);
      assert.equal((await register('Switch On', email, 'student')).status, 400, `"${on}" keeps the check`);
      assertStillPending(student.id);
    }
    for (const off of ['0', 'false', ' No ', 'OFF']) {
      process.env.REQUIRE_CODE_FOR_INVITES = off;
      const email = uniqueEmail('switchoff');
      const student = await invite(fx, email);
      const res = await register('Switch Off', email, 'student', { joinCode: off === '0' ? '000000' : undefined });
      assert.equal(res.status, 201, `"${off}": ${JSON.stringify(res.body)}`);
      assert.equal(res.body.user.id, student.id);
      assert.deepEqual(res.body.claimedClasses, ['Coded class']);
    }
  });
});

describe('temporary passwords and removal for pending students', () => {
  let fx: ClassFixture;

  before(async () => {
    fx = await setupClass(srv, [], 'Pending admin');
  });

  it('creating a temporary password ends pending; the student signs in with it', async () => {
    const email = uniqueEmail('temp');
    const student = await invite(fx, email);
    const res = await resetPassword(fx, student.id);
    assert.equal(res.status, 200);
    const stored = userRow(student.id);
    assert.deepEqual([stored?.name, stored?.pending, stored?.placeholder_name], ['Temp', 0, 0]);
    assert.notEqual(stored?.password_hash, '');
    assert.equal((await roster(fx)).find((s) => s.id === student.id)?.pending, false);

    const signedIn = await login(email, res.body.tempPassword);
    assert.equal(signedIn.status, 200);
    assert.equal(signedIn.body.user.mustChangePassword, true);
    assert.equal((await register('Someone', email, 'student')).status, 409, 'no longer claimable by sign-up');
  });

  it('deletes a removed pending student with no submissions, so the email starts fresh', async () => {
    const email = uniqueEmail('gone');
    const student = await invite(fx, email, 'Gone Student');
    const res = await removeStudent(fx, student.id);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
    assert.equal(userRow(student.id), undefined);
    assert.ok(!(await roster(fx)).some((s) => s.id === student.id));

    const signup = await register('New Person', email, 'student');
    assert.equal(signup.status, 201);
    assert.notEqual(signup.body.user.id, student.id);
    assert.equal(signup.body.user.name, 'New Person');
    assert.equal('claimedClasses' in signup.body, false);
    const classes = await srv.request<ClassSummary[]>('GET', '/api/classes', { token: signup.body.token });
    assert.deepEqual(classes.body, []);
  });

  it('keeps a removed pending student who has submissions (or another class)', async () => {
    const assignment = await createAssignment(srv, fx, { title: 'Kept work' });
    const withWork = await invite(fx, uniqueEmail('kept'));
    expectOk(await submitRequest(srv, fx.teacher.token, assignment.id, PERFECT, { studentId: withWork.id }), 'upload');
    assert.equal((await removeStudent(fx, withWork.id)).status, 200);
    assert.equal(userRow(withWork.id)?.pending, 1);
    assert.ok(dbm.get('SELECT 1 FROM submissions WHERE student_id = ?', withWork.id));

    const other = await setupClass(srv, [], 'Other class');
    const email = uniqueEmail('twoclasses');
    const inTwo = await invite(fx, email);
    await invite(other, email);
    assert.equal((await removeStudent(fx, inTwo.id)).status, 200);
    assert.equal(userRow(inTwo.id)?.pending, 1);
    assert.equal((await roster(other)).find((s) => s.id === inTwo.id)?.pending, true);
  });

  it('does not delete students who signed up when they are removed', async () => {
    const email = uniqueEmail('signedup');
    const student = await invite(fx, email);
    assert.equal((await register('Signed Up', email, 'student', { joinCode: await joinCode(fx) })).status, 201);
    assert.equal((await removeStudent(fx, student.id)).status, 200);
    assert.equal(userRow(student.id)?.pending, 0);
    assert.equal((await login(email, 'my-password-1')).status, 200);
  });
});

describe('who controls an invited account after the student signs up', () => {
  it('the inviter can no longer reset the password once the student is in another teacher’s class', async () => {
    const inviter = await setupClass(srv, [], 'Inviter class');
    const realTeacher = await setupClass(srv, [], 'Real class');
    const email = uniqueEmail('victim');
    const pending = await invite(inviter, email);
    const creatorOf = (id: number) =>
      dbm.get<{ c: number | null }>('SELECT created_by_teacher_id AS c FROM users WHERE id = ?', id)?.c;
    assert.equal(creatorOf(pending.id), inviter.teacher.id);

    const signup = await register('Victim', email, 'student', {
      password: 'victim-secret-1',
      joinCode: await joinCode(inviter),
    });
    assert.equal(signup.status, 201, JSON.stringify(signup.body));
    assert.equal(signup.body.user.id, pending.id);
    assert.equal(creatorOf(pending.id), null, 'the claim clears the creator');
    const token = signup.body.token;
    expectOk(
      await srv.request('POST', '/api/classes/join', { token, json: { joinCode: await joinCode(realTeacher) } }),
      'join',
    );

    // Removing and re-adding the student does not give the inviter control back.
    assert.equal((await removeStudent(inviter, pending.id)).status, 200);
    assert.equal(userRow(pending.id)?.pending, 0, 'a signed-up account is kept');
    const readded = await invite(inviter, email);
    assert.equal(readded.canResetPassword, false);
    assert.equal((await roster(inviter)).find((s) => s.id === pending.id)?.canResetPassword, false);

    const reset = await resetPassword(inviter, pending.id);
    assert.equal(reset.status, 403);
    assert.match(reset.body.error, /another teacher's class/);
    assert.equal((await login(email, 'victim-secret-1')).status, 200, 'the student’s password still works');
    assert.equal((await srv.request('GET', '/api/auth/me', { token })).status, 200, 'and their session too');
  });

  it('the inviting teacher can still help a student who is only in their classes', async () => {
    const fx = await setupClass(srv, [], 'Only mine');
    const email = uniqueEmail('onlymine');
    const pending = await invite(fx, email);
    assert.equal((await register('Only Mine', email, 'student', { joinCode: await joinCode(fx) })).status, 201);
    assert.equal((await roster(fx)).find((s) => s.id === pending.id)?.canResetPassword, true);
    assert.equal((await resetPassword(fx, pending.id)).status, 200);
  });

  it('a temporary password from the teacher keeps the teacher as creator', async () => {
    const fx = await setupClass(srv, [], 'Temp creator');
    const other = await setupClass(srv, [], 'Temp other');
    const email = uniqueEmail('tempcreator');
    const pending = await invite(fx, email);
    const reset = await resetPassword(fx, pending.id);
    assert.equal(reset.status, 200);
    const signedIn = await login(email, reset.body.tempPassword);
    expectOk(
      await srv.request('POST', '/api/classes/join', {
        token: signedIn.body.token,
        json: { joinCode: await joinCode(other) },
      }),
      'join',
    );
    assert.equal((await resetPassword(fx, pending.id)).status, 200, 'the teacher created this password');
  });
});

describe('names of invited accounts', () => {
  it('only the teacher who invited a student can fill in their placeholder name', async () => {
    const owner = await setupClass(srv, [], 'Owner class');
    const other = await setupClass(srv, [], 'Other teacher class');
    const email = uniqueEmail('kim');
    const pending = await invite(owner, email);
    assert.equal(pending.name, 'Kim');

    const elsewhere = await invite(other, email, '=HYPERLINK("http://x","Bad")');
    assert.equal(elsewhere.id, pending.id);
    assert.equal(elsewhere.name, 'Kim', 'another teacher does not rename the account');
    assert.deepEqual([userRow(pending.id)?.name, userRow(pending.id)?.placeholder_name], ['Kim', 1]);

    const signup = await register('Kim Real Name', email, 'student', { joinCode: await joinCode(other) });
    assert.equal(signup.status, 201);
    assert.equal(signup.body.user.name, 'Kim Real Name', 'the student’s own name replaces the placeholder');
  });

  it('the inviting teacher can fill in the name later', async () => {
    const fx = await setupClass(srv, [], 'Fill in');
    const email = uniqueEmail('lee');
    const pending = await invite(fx, email);
    assert.equal((await invite(fx, email, 'Lee Chang')).name, 'Lee Chang');
    assert.deepEqual([userRow(pending.id)?.name, userRow(pending.id)?.placeholder_name], ['Lee Chang', 0]);
    const signup = await register('Somebody', email, 'student', { joinCode: await joinCode(fx) });
    assert.equal(signup.body.user.name, 'Lee Chang');
  });
});

describe('emails copied with invisible or look-alike characters', () => {
  it('invites and sign-ups normalize them to the same address', async () => {
    const fx = await setupClass(srv, [], 'Copied emails');
    const code = await joinCode(fx);
    const at = `${++seq}@copied.example.test`;
    const cases = [
      { invited: `zw\u200bkid${at}`, typed: `zwkid${at}` },
      { invited: `\uff46\uff57kid${at}`, typed: `fwkid${at}` },
      { invited: `jose\u0301${at}`, typed: `jos\u00e9${at}` },
      { invited: `\ufeffsoft\u00adhyphen${at}`, typed: `softhyphen${at}` },
    ];
    for (const { invited, typed } of cases) {
      const student = await invite(fx, invited);
      assert.equal(student.email, typed.normalize('NFC'));
      const res = await register('Copied', typed, 'student', { joinCode: code });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.user.id, student.id, `${JSON.stringify(invited)} matched ${typed}`);
      assert.deepEqual(res.body.claimedClasses, ['Copied emails']);
    }
    assert.equal((await roster(fx)).filter((s) => s.pending).length, 0, 'no ghost rows');
  });
});

describe('deleting a class with pending students', () => {
  const deleteClass = (fx: ClassFixture) =>
    srv.request('DELETE', `/api/classes/${fx.classId}`, { token: fx.teacher.token });

  it('deletes pending accounts that were only in that class, so the email can sign up as a teacher', async () => {
    const fx = await setupClass(srv, [], 'Temp class');
    const assignment = await createAssignment(srv, fx, { title: 'Work' });
    const orphanEmail = uniqueEmail('orphan');
    const orphan = await invite(fx, orphanEmail);
    const withWork = await invite(fx, uniqueEmail('withwork'));
    expectOk(await submitRequest(srv, fx.teacher.token, assignment.id, PERFECT, { studentId: withWork.id }), 'upload');
    const other = await setupClass(srv, [], 'Keeps one');
    const twoClassesEmail = uniqueEmail('twoclasses.del');
    const inTwo = await invite(fx, twoClassesEmail);
    await invite(other, twoClassesEmail);
    const signedUpEmail = uniqueEmail('signedup.del');
    const signedUp = await invite(fx, signedUpEmail);
    assert.equal((await register('Signed Up', signedUpEmail, 'student', { joinCode: await joinCode(fx) })).status, 201);

    assert.equal((await deleteClass(fx)).status, 200);
    assert.equal(userRow(orphan.id), undefined);
    assert.equal(userRow(withWork.id), undefined, 'its submissions went with the class');
    assert.equal(userRow(inTwo.id)?.pending, 1, 'still in another class');
    assert.equal(userRow(signedUp.id)?.pending, 0, 'accounts that signed up are kept');

    const login401 = await login(orphanEmail, 'whatever-123');
    assert.equal(login401.status, 401);
    assert.equal(login401.body.code, undefined, 'a plain wrong-login answer, not "your teacher added you"');
    const teacher = await register('Colleague', orphanEmail, 'teacher');
    assert.equal(teacher.status, 201, JSON.stringify(teacher.body));
  });

  it('keeps a pending student’s work from other classes', async () => {
    const fx = await setupClass(srv, [], 'Deleted later');
    const keep = await setupClass(srv, [], 'Kept class');
    const assignment = await createAssignment(srv, keep, { title: 'Kept work' });
    const email = uniqueEmail('workelsewhere');
    const student = await invite(keep, email);
    await invite(fx, email);
    expectOk(await submitRequest(srv, keep.teacher.token, assignment.id, PERFECT, { studentId: student.id }), 'up');
    assert.equal((await removeStudent(keep, student.id)).status, 200);
    assert.equal((await deleteClass(fx)).status, 200);
    assert.equal(userRow(student.id)?.pending, 1, 'kept because of the submission in another class');
  });
});

describe('POST /api/classes/:classId/students/import-preview', () => {
  let fx: ClassFixture;
  const url = () => `/api/classes/${fx.classId}/students/import-preview`;

  before(async () => {
    fx = await setupClass(srv, [], 'Roster uploads');
  });

  async function previewRequest(contents: string | Buffer, fileName: string, token = fx.teacher.token) {
    const form = new FormData();
    form.append('file', fileBlob(typeof contents === 'string' ? Buffer.from(contents, 'utf8') : contents), fileName);
    return srv.request<Body<RosterPreview>>('POST', url(), { token, form });
  }

  /** Previews a file and checks that its temp upload is gone afterwards. */
  async function preview(contents: string | Buffer, fileName = 'roster.csv'): Promise<RosterPreview> {
    const before = uploadedFileNames(srv);
    const res = await previewRequest(contents, fileName);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await eventually(() => assert.deepEqual(uploadedFileNames(srv), before));
    assert.equal(res.body.fileName, fileName);
    return res.body;
  }

  const brief = (body: RosterPreview) => body.rows.map((r) => [r.line, r.name, r.email, r.status]);

  it('reads a CSV with "First Name, Last Name, Email Address" headers', async () => {
    const body = await preview(
      'First Name,Last Name,Email Address\nAda,Lovelace,Ada@Example.test\n Alan , Turing ,alan@example.test\n',
    );
    assert.deepEqual(body.columns, { email: 'Email Address', name: 'First Name + Last Name' });
    assert.deepEqual(brief(body), [
      [2, 'Ada Lovelace', 'ada@example.test', 'invite'],
      [3, 'Alan Turing', 'alan@example.test', 'invite'],
    ]);
    assert.deepEqual(body.warnings, []);
  });

  it('reads a Google Classroom grade export (extra rows and columns)', async () => {
    const csv = [
      'Last Name,First Name,Email Address,Budget Quiz,Formulas Essay',
      ',,,"Oct 3, 2026","Oct 10, 2026"',
      ',,,10,100',
      'Lovelace,Ada,ada.gc@example.test,9,95',
      'Turing,Alan,alan.gc@example.test,,88',
      'Class average,,,9,91.5',
    ].join('\r\n');
    const body = await preview(csv, 'Spreadsheets - Grades.csv');
    assert.deepEqual(body.columns, { email: 'Email Address', name: 'First Name + Last Name' });
    assert.deepEqual(brief(body), [
      [4, 'Ada Lovelace', 'ada.gc@example.test', 'invite'],
      [5, 'Alan Turing', 'alan.gc@example.test', 'invite'],
      [6, 'Class average', '', 'error'],
    ]);
    assert.equal(body.rows[2].error, 'Email is required.');
    assert.deepEqual(body.warnings, ['Skipped 2 rows without a name or email address.']);
  });

  it('reads a file without a header row when one column holds emails', async () => {
    const body = await preview('Ada Lovelace,ada.nh@example.test,P3\nAlan Turing,alan.nh@example.test,P3\n');
    assert.deepEqual(body.columns, { email: 'Column B', name: 'Column A' });
    assert.deepEqual(brief(body), [
      [1, 'Ada Lovelace', 'ada.nh@example.test', 'invite'],
      [2, 'Alan Turing', 'alan.nh@example.test', 'invite'],
    ]);
  });

  it('turns a single "Last, First" column into "First Last"', async () => {
    const body = await preview(
      'Student,E-mail\n"Lovelace, Ada",ada.lf@example.test\n"Turing,Alan M.",alan.lf@example.test\n',
    );
    assert.deepEqual(body.columns, { email: 'E-mail', name: 'Student' });
    assert.deepEqual(
      body.rows.map((r) => r.name),
      ['Ada Lovelace', 'Alan M. Turing'],
    );
    const headerless = await preview('"Hopper, Grace",grace.lf@example.test\n');
    assert.deepEqual(brief(headerless), [[1, 'Grace Hopper', 'grace.lf@example.test', 'invite']]);
  });

  it('reads UTF-8 with a byte order mark', async () => {
    const body = await preview('﻿Name,Email\nJosé Núñez,jose@example.test\nZoë Brontë,zoe@example.test\n');
    assert.deepEqual(body.columns, { email: 'Email', name: 'Name' });
    assert.deepEqual(
      body.rows.map((r) => r.name),
      ['José Núñez', 'Zoë Brontë'],
    );
  });

  it('reads semicolon-delimited CSV (European Excel)', async () => {
    const body = await preview(
      'Name;Email;Score\nLovelace, Ada;ada.sc@example.test;9,5\nAlan Turing;alan.sc@example.test;8\n',
    );
    assert.deepEqual(body.columns, { email: 'Email', name: 'Name' });
    assert.deepEqual(brief(body), [
      [2, 'Ada Lovelace', 'ada.sc@example.test', 'invite'],
      [3, 'Alan Turing', 'alan.sc@example.test', 'invite'],
    ]);
  });

  it('reads an .xlsx roster with a title row, preferring the student’s email over a parent’s', async () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ['Period 3 roster'],
      [],
      ['Student Name', 'Parent Email', 'Student Email', 'Grade'],
      ['Ada Lovelace', 'parent1@example.test', 'ada.x@example.test', 10],
      ['Alan Turing', 'parent2@example.test', 'alan.x@example.test', 11],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'Roster');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['ignored@example.test']]), 'Notes');
    const body = await preview(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer, 'Period 3.xlsx');
    assert.deepEqual(body.columns, { email: 'Student Email', name: 'Student Name' });
    assert.deepEqual(brief(body), [
      [4, 'Ada Lovelace', 'ada.x@example.test', 'invite'],
      [5, 'Alan Turing', 'alan.x@example.test', 'invite'],
    ]);
    assert.deepEqual(body.warnings, []);
  });

  it('merges repeated emails into their first row, with a warning', async () => {
    const body = await preview('Email,Name\nDup@Example.test,\nother@example.test,Other\ndup@example.test,Dee Upton\n');
    assert.deepEqual(brief(body), [
      [2, 'Dee Upton', 'dup@example.test', 'invite'],
      [3, 'Other', 'other@example.test', 'invite'],
    ]);
    assert.deepEqual(body.warnings, [
      'Repeated emails were merged into their first row: dup@example.test (rows 2, 4).',
    ]);
  });

  it('marks invalid emails, teacher emails and missing emails as errors', async () => {
    const otherTeacher = await srv.registerUser('teacher');
    const body = await preview(
      [
        'Name,Email',
        'Bad Email,not-an-email',
        `Myself,${fx.teacher.email}`,
        `Other Teacher,${otherTeacher.user.email.toUpperCase()}`,
        'No Email,',
        `${'x'.repeat(101)},long@example.test`,
      ].join('\n'),
    );
    assert.deepEqual(
      body.rows.map((r) => [r.email, r.status, r.error]),
      [
        ['not-an-email', 'error', 'Not a valid email address.'],
        [fx.teacher.email, 'error', 'This email belongs to a teacher account.'],
        [otherTeacher.user.email, 'error', 'This email belongs to a teacher account.'],
        ['', 'error', 'Email is required.'],
        ['long@example.test', 'error', 'Name must be at most 100 characters.'],
      ],
    );
  });

  it('marks students already in the class and existing accounts, and the rows add as previewed', async () => {
    const enrolled = await srv.registerUser('student', 'Already Here');
    expectOk(await addStudents(fx.teacher.token, fx.classId, [{ name: '', email: enrolled.user.email }]), 'enroll');
    const existing = await srv.registerUser('student', 'Has Account');
    const elsewhere = await setupClass(srv, [], 'Elsewhere');
    const pendingElsewhere = uniqueEmail('pending.elsewhere');
    await invite(elsewhere, pendingElsewhere);
    const newEmail = uniqueEmail('brand.new');

    const body = await preview(
      [
        'Name,Email',
        `Already Here,${enrolled.user.email}`,
        `Has Account,${existing.user.email}`,
        `Pending Elsewhere,${pendingElsewhere}`,
        `Brand New,${newEmail}`,
      ].join('\n'),
    );
    assert.deepEqual(
      body.rows.map((r) => r.status),
      ['already', 'add', 'invite', 'invite'],
      'a student another teacher invited has not signed up, so the preview says invited (as Add students reports)',
    );
    assert.equal((await roster(fx)).length, 1, 'the preview saves nothing');

    const res = await addStudents(
      fx.teacher.token,
      fx.classId,
      body.rows.map(({ name, email }) => ({ name, email })),
    );
    assert.deepEqual(res.body.errors, []);
    assert.deepEqual(
      res.body.added.map((a) => [a.created, a.alreadyEnrolled, a.pending]),
      [
        [false, true, false],
        [false, false, false],
        [false, false, true],
        [true, false, true],
      ],
    );
  });

  it('reads PowerSchool’s "LastFirst" name column', async () => {
    const body = await preview(
      'Student_Number,LastFirst,Grade_Level,Email_Addr\n1001,"Doe, Jane",9,jane.ps@example.test\n',
    );
    assert.deepEqual(body.columns, { email: 'Email_Addr', name: 'LastFirst' });
    assert.deepEqual(brief(body), [[2, 'Jane Doe', 'jane.ps@example.test', 'invite']]);
    const lower = await preview('student_number,lastfirst,student_email\n1002,"Roe, Rich",rich.ps@example.test\n');
    assert.deepEqual(brief(lower), [[2, 'Rich Roe', 'rich.ps@example.test', 'invite']]);
  });

  it('reads "Name <address>" email cells, taking the name when there is no name column', async () => {
    const body = await preview(
      'Name,Email\nJane Doe,Jane Doe <Jane.NA@example.test>\n,"""Roe, Rich"" <rich.na@example.test>"\n',
    );
    assert.deepEqual(brief(body), [
      [2, 'Jane Doe', 'jane.na@example.test', 'invite'],
      [3, 'Rich Roe', 'rich.na@example.test', 'invite'],
    ]);
    const emailOnly = await preview('Email\nGrace Hopper <grace.na@example.test>\n');
    assert.deepEqual(brief(emailOnly), [[2, 'Grace Hopper', 'grace.na@example.test', 'invite']]);
  });

  it('never invites parents: a parent-only email column is refused', async () => {
    const before = uploadedFileNames(srv);
    const csv = [
      'Student Name,Grade,Parent Email',
      '"Kim, Hana",9,kim.family@example.test',
      '"Kim, Joon",11,kim.family@example.test',
    ].join('\n');
    const res = await previewRequest(csv, 'roster.csv');
    assert.equal(res.status, 400);
    assert.match(res.body.fields.file, /“Parent Email”, looks like parents’/);
    assert.equal(res.body.error, res.body.fields.file);
    const unheaded = await previewRequest('Student,Guardian\nAda Lovelace,mom@example.test\n', 'roster.csv');
    assert.equal(unheaded.status, 400);
    assert.match(unheaded.body.fields.file, /“Guardian”/);
    await eventually(() => assert.deepEqual(uploadedFileNames(srv), before));
  });

  it('normalizes addresses copied with invisible characters', async () => {
    const body = await preview('Email\n\u200bzw.csv@example.test\n\uff46\uff57.csv@example.test\n');
    assert.deepEqual(
      body.rows.map((r) => [r.email, r.status]),
      [
        ['zw.csv@example.test', 'invite'],
        ['fw.csv@example.test', 'invite'],
      ],
    );
  });

  it('reads Windows-1252 and Mac Roman CSVs (Excel’s plain "CSV") without control characters', async () => {
    const bytes = (...parts: (string | number[])[]) =>
      Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))));
    const windows = await preview(
      bytes('Name,Email\nConor O', [0x92], 'Brien,conor.cp@example.test\n', [0x8a], 'ap Ren', [0xe9], ',sap@x.test\n'),
    );
    assert.deepEqual(
      windows.rows.map((r) => r.name),
      ['Conor O’Brien', 'Šap René'],
    );
    const mac = await preview(bytes('Name,Email\nJos', [0x8e], ' Mu', [0x96], 'oz,jose.mac@example.test\n'));
    assert.deepEqual(
      mac.rows.map((r) => r.name),
      ['José Muñoz'],
    );
  });

  it('reads a UTF-16 roster without breaking later spreadsheet uploads', async () => {
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('Name\tEmail\r\nJosé Ramírez\tjose.u16@example.test\r\n', 'utf16le'),
    ]);
    const body = await preview(utf16);
    assert.deepEqual(brief(body), [[2, 'José Ramírez', 'jose.u16@example.test', 'invite']]);

    const assignment = await createAssignment(srv, fx, { title: 'After UTF-16' });
    const student = await invite(fx, uniqueEmail('after.utf16'));
    const sub = expectOk(
      await submitRequest(srv, fx.teacher.token, assignment.id, PERFECT, { studentId: student.id }),
      'xlsx upload after a UTF-16 roster',
    );
    assert.equal(sub.autoStatus, 'graded');
    const again = await preview('Name,Email\nAda Lovelace,ada.u16@example.test\n');
    assert.equal(again.rows.length, 1);
  });

  it('reads at most 1000 students, with a warning', async () => {
    const lines = ['Email'];
    for (let i = 0; i < 1005; i++) lines.push(`bulk${i}@roster.example.test`);
    const body = await preview(lines.join('\n'));
    assert.equal(body.rows.length, 1000);
    assert.equal(body.rows[999].email, 'bulk999@roster.example.test');
    assert.deepEqual(body.columns, { email: 'Email', name: null });
    assert.deepEqual(body.warnings, [
      'This file lists 1,005 students. Only the first 1,000 were read; add the rest from a second file.',
    ]);
  });

  it('rejects files without an email column, unreadable files and other file types', async () => {
    const before = uploadedFileNames(srv);
    const noEmail = await previewRequest('Name,Phone\nAda Lovelace,555-0100\n', 'roster.csv');
    assert.equal(noEmail.status, 400);
    assert.match(noEmail.body.fields.file, /email/i);
    assert.equal(noEmail.body.error, noEmail.body.fields.file);

    const garbage = await previewRequest(GARBAGE, 'roster.xlsx');
    assert.equal(garbage.status, 400);
    assert.ok(garbage.body.fields.file);

    const binary = await previewRequest(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00, 0xff]), 'roster.csv');
    assert.equal(binary.status, 400);
    assert.ok(binary.body.fields.file);

    const pdf = await previewRequest('%PDF-1.7 not a roster', 'roster.pdf');
    assert.equal(pdf.status, 400);
    assert.match(pdf.body.fields.file, /not a spreadsheet/);

    const noFile = { token: fx.teacher.token, form: new FormData() };
    const missing = await srv.request<Body<RosterPreview>>('POST', url(), noFile);
    assert.equal(missing.status, 400);
    assert.ok(missing.body.fields.file);

    await eventually(() => assert.deepEqual(uploadedFileNames(srv), before));
  });

  it('is only for the class’s teacher', async () => {
    const before = uploadedFileNames(srv);
    const csv = 'Email\nada@example.test\n';
    const student = await srv.registerUser('student');
    assert.equal((await previewRequest(csv, 'roster.csv', student.token)).status, 403);
    const otherTeacher = await srv.registerUser('teacher');
    assert.equal((await previewRequest(csv, 'roster.csv', otherTeacher.token)).status, 403);
    const anonymous = new FormData();
    anonymous.append('file', fileBlob(Buffer.from(csv)), 'roster.csv');
    assert.equal((await srv.request('POST', url(), { form: anonymous })).status, 401);
    await eventually(() => assert.deepEqual(uploadedFileNames(srv), before));
  });
});
