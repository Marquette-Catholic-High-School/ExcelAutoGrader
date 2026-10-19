import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type {
  AssignmentSubmissionsResponse,
  AssignmentSummary,
  AuthResponse,
  ClassSummary,
  RosterPreview,
  SubmissionDetail,
} from '../../../shared/types.js';
import { fileBlob, startTestServer, type TestServer } from '../test-utils.js';

let srv: TestServer;
let seed: typeof import('./seed.js');
let finnPassword: string;

async function login(email: string, password = 'password123'): Promise<string> {
  const res = await srv.request<AuthResponse>('POST', '/api/auth/login', { json: { email, password } });
  assert.equal(res.status, 200, `login ${email}: ${JSON.stringify(res.body)}`);
  return res.body.token;
}

async function getJson<T>(token: string, url: string): Promise<T> {
  const res = await srv.request<T>('GET', url, { token });
  assert.equal(res.status, 200, `${url}: ${JSON.stringify(res.body)}`);
  return res.body;
}

before(async () => {
  // Always a fresh folder: the seed empties whatever DATA_DIR points at.
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'excel-autograder-seed-test-'));
  srv = await startTestServer();
  seed = await import('./seed.js');
  const result = await seed.seedDemoData({ quiet: true });
  finnPassword = result.accounts.find((a) => a.email === 'finn@demo.test')!.password;
});

after(() => srv.close());

describe('demo seed', () => {
  test('creates the teacher, both classes and every assignment', async () => {
    const token = await login('teacher@demo.test');
    const classes = await getJson<ClassSummary[]>(token, '/api/classes');
    assert.deepEqual(
      classes.map((c) => [c.name, c.studentCount, c.assignmentCount]),
      [
        ['Business Computing 101', 7, 3],
        ['Spreadsheet Skills', 2, 1],
      ],
    );
    const assignments = await getJson<AssignmentSummary[]>(token, `/api/classes/${classes[0].id}/assignments`);
    assert.deepEqual(
      assignments.map((a) => [a.title, a.gradingMode, a.points]),
      [
        ['Monthly Budget', 'auto', 20],
        ['Quarterly Sales Report', 'manual', 50],
        ['Grade Calculator', 'auto', 10],
      ],
    );
    assert.ok(Date.parse(assignments[0].dueAt) < Date.now(), 'Monthly Budget is past due');
    assert.ok(Date.parse(assignments[1].dueAt) > Date.now(), 'Quarterly Sales Report is not due yet');
  });

  test('Monthly Budget: autograded scores, the late flag and the missing students', async () => {
    const token = await login('teacher@demo.test');
    const [budget] = await getJson<AssignmentSummary[]>(token, '/api/me/assignments');
    // Diego's late work is autograded, so it no longer needs the teacher's attention.
    assert.deepEqual(budget.counts, { students: 7, submitted: 5, late: 1, needsGrading: 0, lateUngraded: 0 });
    const { rows } = await getJson<AssignmentSubmissionsResponse>(token, `/api/assignments/${budget.id}/submissions`);
    const summary = rows.map((r) => {
      const { student, status, attemptCount, latest } = r;
      return [student.name, status, attemptCount, latest?.finalScore ?? null, !!latest?.late];
    });
    assert.deepEqual(summary, [
      ['Ava Thompson', 'autograded', 1, 20, false],
      ['Ben Carter', 'autograded', 1, 13.91, false],
      ['Chloe Nguyen', 'autograded', 1, 12.17, false],
      ['Diego Ramirez', 'autograded', 2, 18.26, true],
      ['Emma Wilson', 'missing', 0, null, false],
      ['Finn Murphy', 'missing', 0, null, false],
      ['Grace Lee', 'autograded', 1, 18.26, false],
    ]);
    assert.deepEqual(
      rows.map((r) => r.student.pending),
      [false, false, false, false, false, false, true],
    );
    assert.equal(rows.find((r) => r.student.name === 'Grace Lee')!.latest!.submittedByName, 'Ms. Rivera');
    const chloe = rows.find((r) => r.student.name === 'Chloe Nguyen')!.latest!;
    const reasons = chloe.report!.sheets.flatMap((s) => s.cells).filter((c) => !c.correct).map((c) => c.reason);
    assert.equal(reasons.length, 9);
    assert.ok(reasons.every((r) => r === 'formula_required'));
    assert.match(rows.find((r) => r.student.name === 'Ben Carter')!.latest!.feedback, /Good start, Ben/);

    const diego = rows.find((r) => r.student.name === 'Diego Ramirez')!;
    const attempts = await getJson<SubmissionDetail[]>(
      token,
      `/api/assignments/${budget.id}/students/${diego.student.id}/submissions`,
    );
    assert.deepEqual(
      attempts.map((a) => [a.attempt, a.late, a.autoScore]),
      [
        [2, true, 18.26],
        [1, false, 9.57],
      ],
    );
    assert.ok(attempts[0].lateBySeconds > 24 * 3600, 'Diego is more than a day late');
  });

  test('Quarterly Sales Report: one submission to grade, one graded by the teacher', async () => {
    const token = await login('teacher@demo.test');
    const sales = (await getJson<AssignmentSummary[]>(token, '/api/me/assignments')).find(
      (a) => a.title === 'Quarterly Sales Report',
    )!;
    assert.deepEqual(sales.counts, { students: 7, submitted: 2, late: 0, needsGrading: 1, lateUngraded: 0 });
    const { rows } = await getJson<AssignmentSubmissionsResponse>(token, `/api/assignments/${sales.id}/submissions`);
    const ava = rows.find((r) => r.student.name === 'Ava Thompson')!;
    const ben = rows.find((r) => r.student.name === 'Ben Carter')!;
    assert.equal(ava.status, 'needs_grading');
    assert.equal(ben.status, 'graded');
    assert.equal(ben.latest!.finalScore, 42);
    assert.ok(ben.latest!.feedback.length > 0);
    const viewer = await getJson<{ sheets: { name: string }[] }>(token, `/api/submissions/${ava.latest!.id}/workbook`);
    assert.deepEqual(
      viewer.sheets.map((s) => s.name),
      ['Q3 Sales', 'Summary'],
    );
  });

  test('students see their own statuses', async () => {
    const statuses = async (email: string) =>
      (await getJson<AssignmentSummary[]>(await login(email), '/api/me/assignments')).map((a) => [
        a.title,
        a.mine!.status,
        a.mine!.late,
      ]);
    assert.deepEqual(await statuses('diego@demo.test'), [
      ['Monthly Budget', 'graded', true],
      ['Quarterly Sales Report', 'not_submitted', false],
      ['Grade Calculator', 'not_submitted', false],
    ]);
    assert.deepEqual(await statuses('emma@demo.test'), [
      ['Monthly Budget', 'missing', false],
      ['Cell References Warm-up', 'graded', false],
      ['Quarterly Sales Report', 'not_submitted', false],
      ['Grade Calculator', 'not_submitted', false],
    ]);
  });

  test('Finn signs in with the temporary password and must change it', async () => {
    const res = await srv.request<AuthResponse>('POST', '/api/auth/login', {
      json: { email: 'finn@demo.test', password: finnPassword },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.mustChangePassword, true);
  });

  test('samples/class-roster.csv previews against Business Computing 101', async () => {
    const file = fs.readFileSync(path.join(seed.SAMPLES_DIR, 'class-roster.csv'));
    assert.equal(file.toString('utf8'), seed.CLASS_ROSTER_CSV, 'the committed file matches what writeSamples() writes');
    const token = await login('teacher@demo.test');
    const [bc101] = await getJson<ClassSummary[]>(token, '/api/classes');
    const form = new FormData();
    form.append('file', fileBlob(file), 'class-roster.csv');
    const res = await srv.request<RosterPreview>('POST', `/api/classes/${bc101.id}/students/import-preview`, {
      token,
      form,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.columns, { email: 'Email', name: 'First Name + Last Name' });
    assert.deepEqual(
      res.body.rows.map((r) => [r.name, r.status]),
      [
        ['Hana Kim', 'invite'],
        ['Isaac Okafor', 'invite'],
        ['Julia Rossi', 'invite'],
        ['', 'invite'],
        ['Ava Thompson', 'already'],
      ],
    );
  });

  test('Grace signs up with her email and finds her class and the work the teacher uploaded', async () => {
    const before = await srv.request('POST', '/api/auth/login', {
      json: { email: 'grace@demo.test', password: 'password123' },
    });
    assert.equal(before.status, 401);
    assert.equal(before.body.code, 'needs_signup');

    const res = await srv.request<AuthResponse>('POST', '/api/auth/register', {
      json: { name: 'Grace Lee', email: 'grace@demo.test', password: 'grace-password', role: 'student' },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(res.body.claimedClasses, ['Business Computing 101']);
    assert.equal(res.body.user.mustChangePassword, false);

    const [budget] = await getJson<AssignmentSummary[]>(res.body.token, '/api/me/assignments');
    assert.equal(budget.title, 'Monthly Budget');
    assert.deepEqual([budget.mine!.status, budget.mine!.late, budget.mine!.finalScore], ['graded', false, 18.26]);
    const [work] = await getJson<SubmissionDetail[]>(res.body.token, `/api/assignments/${budget.id}/my-submissions`);
    assert.equal(work.submittedByName, 'Ms. Rivera');
    assert.equal(work.file.name, 'Monthly Budget - Grace Lee.xlsx');
  });

  test('seeding again starts over without leaving old uploads behind', async () => {
    const uploads = path.join(srv.dataDir, 'uploads');
    const before = fs.readdirSync(uploads).length;
    await seed.seedDemoData({ quiet: true });
    assert.equal(fs.readdirSync(uploads).length, before);
    const token = await login('teacher@demo.test');
    const classes = await getJson<ClassSummary[]>(token, '/api/classes');
    assert.deepEqual(
      classes.map((c) => c.id),
      [1, 2],
    );
  });
});
