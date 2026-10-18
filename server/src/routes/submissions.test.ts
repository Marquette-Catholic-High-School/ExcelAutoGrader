import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type {
  AssignmentDetail,
  AssignmentSubmissionsResponse,
  GradebookResponse,
  GradeReport,
  SubmissionDetail,
  WorkbookData,
} from '../../../shared/types.js';
import {
  GARBAGE,
  apiError,
  HALF,
  PERFECT,
  createAssignment,
  createAssignmentRequest,
  expectOk,
  inDays,
  setupClass,
  submit,
  submitRequest,
  updateAssignment,
  type ClassFixture,
} from '../services/test-fixtures.js';
import { startTestServer, type TestServer } from '../test-utils.js';

let srv: TestServer;
let fx: ClassFixture;
let db: typeof import('../db.js');

before(async () => {
  srv = await startTestServer();
  db = await import('../db.js'); // same module instance as the server under test
  fx = await setupClass(srv, ['Ana Lopez', 'Ben Carter']);
});

after(() => srv.close());

const ana = () => fx.students[0];
const ben = () => fx.students[1];
const get = <T>(token: string, url: string) => srv.request<T>('GET', url, { token });
const grade = (submissionId: number, body: unknown, token = fx.teacher.token) =>
  srv.request<SubmissionDetail>('PATCH', `/api/submissions/${submissionId}/grade`, { token, json: body });

describe('uploading', () => {
  test('a student submission is autograded immediately', async () => {
    const a = await createAssignment(srv, fx, { title: 'Instant grade' });
    const sub = await submit(srv, ana().token, a.id, PERFECT);
    assert.equal(sub.attempt, 1);
    assert.equal(sub.studentId, ana().id);
    assert.equal(sub.studentName, 'Ana Lopez');
    assert.equal(sub.submittedByName, 'Ana Lopez');
    assert.equal(sub.file.name, 'work.xlsx');
    assert.equal(sub.autoStatus, 'graded');
    assert.equal(sub.autoScore, 100);
    assert.equal(sub.finalScore, 100);
    assert.equal(sub.pointsPossible, 100);
    assert.equal(sub.late, false);
    assert.equal(sub.lateBySeconds, 0);
    assert.equal(sub.overrideScore, null);
    assert.equal(sub.autoError, null);
    assert.equal(sub.report?.total, 2);
  });

  test('every upload is a new attempt and the latest one counts', async () => {
    const a = await createAssignment(srv, fx, { title: 'Attempts' });
    const first = await submit(srv, ana().token, a.id, PERFECT);
    const second = await submit(srv, ana().token, a.id, HALF);
    assert.equal(first.attempt, 1);
    assert.equal(second.attempt, 2);
    assert.equal(second.autoScore, 50);

    const mineRes = await get<SubmissionDetail[]>(ana().token, `/api/assignments/${a.id}/my-submissions`);
    const mine = expectOk(mineRes, 'mine');
    assert.deepEqual(
      mine.map((s) => s.attempt),
      [2, 1],
    );

    const list = expectOk(
      await get<AssignmentSubmissionsResponse>(fx.teacher.token, `/api/assignments/${a.id}/submissions`),
      'teacher list',
    );
    assert.equal(list.assignment.id, a.id);
    assert.deepEqual(
      list.rows.map((r) => [r.student.name, r.status, r.attemptCount, r.latest?.attempt ?? null]),
      [
        ['Ana Lopez', 'autograded', 2, 2],
        ['Ben Carter', 'missing', 0, null],
      ],
    );
    assert.equal(list.rows[0].latest?.finalScore, 50);

    const attempts = expectOk(
      await get<SubmissionDetail[]>(fx.teacher.token, `/api/assignments/${a.id}/students/${ana().id}/submissions`),
      'attempts',
    );
    assert.deepEqual(
      attempts.map((s) => s.id),
      [second.id, first.id],
    );
    const studentView = expectOk(await get<AssignmentDetail>(ana().token, `/api/assignments/${a.id}`), 'detail');
    assert.equal(studentView.mine?.attemptCount, 2);
    assert.equal(studentView.mine?.latestSubmissionId, second.id);
    assert.equal(studentView.mine?.finalScore, 50);
  });

  test('late uploads are accepted and flagged; moving the due date updates the flag', async () => {
    const a = await createAssignment(srv, fx, { title: 'Past due', dueAt: inDays(-1) });
    const sub = await submit(srv, ana().token, a.id, PERFECT);
    assert.equal(sub.late, true);
    assert.ok(sub.lateBySeconds >= 86_000, `lateBySeconds = ${sub.lateBySeconds}`);
    assert.equal(sub.autoScore, 100, 'late work is still graded');

    const detail = expectOk(await get<AssignmentDetail>(fx.teacher.token, `/api/assignments/${a.id}`), 'detail');
    assert.equal(detail.counts?.late, 1);
    const studentDetail = expectOk(await get<AssignmentDetail>(ana().token, `/api/assignments/${a.id}`), 'mine');
    assert.equal(studentDetail.mine?.late, true);

    expectOk(await updateAssignment(srv, fx.teacher.token, a.id, { dueAt: inDays(2) }), 'extend');
    const after = expectOk(await get<SubmissionDetail>(fx.teacher.token, `/api/submissions/${sub.id}`), 'after');
    assert.equal(after.late, false);
    assert.equal(after.lateBySeconds, 0);
    const counts = expectOk(await get<AssignmentDetail>(fx.teacher.token, `/api/assignments/${a.id}`), 'counts');
    assert.equal(counts.counts?.late, 0);

    expectOk(await updateAssignment(srv, fx.teacher.token, a.id, { dueAt: inDays(-3) }), 'move earlier');
    const lateAgain = expectOk(await get<SubmissionDetail>(ana().token, `/api/submissions/${sub.id}`), 'late again');
    assert.equal(lateAgain.late, true);
  });

  test('teachers can upload on behalf of an enrolled student', async () => {
    const a = await createAssignment(srv, fx, { title: 'On behalf' });
    const sub = expectOk(
      await submitRequest(srv, fx.teacher.token, a.id, HALF, { studentId: ben().id }),
      'on behalf',
    );
    assert.equal(sub.studentId, ben().id);
    assert.equal(sub.studentName, 'Ben Carter');
    assert.equal(sub.submittedByName, 'Ms. Rivera');
    assert.equal(sub.autoScore, 50);

    const noStudent = await submitRequest(srv, fx.teacher.token, a.id, HALF);
    assert.equal(noStudent.status, 400);
    assert.ok(apiError(noStudent).fields.studentId);

    const outsider = await srv.registerUser('student', 'Outsider');
    const notEnrolled = await submitRequest(srv, fx.teacher.token, a.id, HALF, { studentId: outsider.user.id });
    assert.equal(notEnrolled.status, 400);
    assert.ok(apiError(notEnrolled).fields.studentId);
  });

  test('rejects missing, unreadable and non-spreadsheet files', async () => {
    const a = await createAssignment(srv, fx, { title: 'Bad files' });
    const empty = await srv.request('POST', `/api/assignments/${a.id}/submissions`, {
      token: ana().token,
      form: new FormData(),
    });
    assert.equal(empty.status, 400);
    const garbage = await submitRequest(srv, ana().token, a.id, GARBAGE);
    assert.equal(garbage.status, 400);
    assert.ok(apiError(garbage).fields.file);
    const text = await submitRequest(srv, ana().token, a.id, PERFECT, { fileName: 'notes.txt' });
    assert.equal(text.status, 400);
    assert.equal(db.get('SELECT 1 FROM submissions WHERE assignment_id = ?', a.id), undefined);
  });

  test('a grading failure is stored as an error and the submission is kept', async () => {
    const a = await createAssignment(srv, fx, { title: 'Broken key' });
    const key = db.get<{ stored_name: string }>(
      'SELECT f.stored_name FROM assignments a JOIN files f ON f.id = a.key_file_id WHERE a.id = ?',
      a.id,
    )!;
    fs.rmSync(path.join(srv.dataDir, 'uploads', key.stored_name));

    const res = await submitRequest(srv, ana().token, a.id, PERFECT);
    assert.equal(res.status, 200);
    assert.equal(res.body.autoStatus, 'error');
    assert.equal(res.body.autoScore, null);
    assert.ok(res.body.autoError);

    const teacherView = expectOk(await get<SubmissionDetail>(fx.teacher.token, `/api/submissions/${res.body.id}`), 't');
    assert.match(teacherView.autoError ?? '', /answer key/i);
    const list = expectOk(
      await get<AssignmentSubmissionsResponse>(fx.teacher.token, `/api/assignments/${a.id}/submissions`),
      'list',
    );
    assert.equal(list.rows[0].status, 'needs_grading');
    const studentDetail = expectOk(await get<AssignmentDetail>(ana().token, `/api/assignments/${a.id}`), 'student');
    assert.equal(studentDetail.mine?.status, 'submitted');

    const regrade = await srv.request('POST', `/api/assignments/${a.id}/regrade`, { token: fx.teacher.token });
    assert.deepEqual(expectOk(regrade, 'regrade'), { regraded: 1, errors: 1 });
  });
});

describe('privacy', () => {
  test('students cannot submit for, or see, other students', async () => {
    const a = await createAssignment(srv, fx, { title: 'Private work' });
    const anaSub = await submit(srv, ana().token, a.id, PERFECT);

    const forBen = await submitRequest(srv, ana().token, a.id, HALF, { studentId: ben().id });
    assert.equal(forBen.status, 403);
    const forSelf = await submitRequest(srv, ana().token, a.id, HALF, { studentId: ana().id });
    assert.equal(forSelf.status, 200);

    for (const url of [
      `/api/submissions/${anaSub.id}`,
      `/api/submissions/${anaSub.id}/download`,
      `/api/submissions/${anaSub.id}/workbook`,
      `/api/assignments/${a.id}/submissions`,
      `/api/assignments/${a.id}/students/${ana().id}/submissions`,
      `/api/assignments/${a.id}/key/download`,
      `/api/assignments/${a.id}/key/workbook`,
    ]) {
      assert.equal((await get(ben().token, url)).status, 403, url);
    }
    const bensRes = await get<SubmissionDetail[]>(ben().token, `/api/assignments/${a.id}/my-submissions`);
    const bensOwn = expectOk(bensRes, 'ben');
    assert.deepEqual(bensOwn, []);
    assert.equal((await grade(anaSub.id, { score: 100, feedback: '' }, ana().token)).status, 403);
    assert.equal((await get(fx.teacher.token, `/api/assignments/${a.id}/my-submissions`)).status, 403);
  });

  test('students never see expected values unless allowed, nor the report when details are hidden', async () => {
    const a = await createAssignment(srv, fx, { title: 'Report visibility' });
    const sub = await submit(srv, ana().token, a.id, HALF);
    const cells = (s: SubmissionDetail) => s.report!.sheets.flatMap((sheet) => sheet.cells);

    const teacherView = expectOk(await get<SubmissionDetail>(fx.teacher.token, `/api/submissions/${sub.id}`), 't');
    assert.ok(cells(teacherView).some((c) => 'expected' in c));
    assert.ok(cells(sub).length > 0);
    for (const cell of cells(sub)) {
      assert.equal('expected' in cell, false);
      assert.equal('expectedFormula' in cell, false);
    }
    const mine = expectOk(await get<SubmissionDetail[]>(ana().token, `/api/assignments/${a.id}/my-submissions`), 'm');
    assert.ok(cells(mine[0]).every((c) => !('expected' in c)));

    const show = { scope: 'formulas', showExpectedToStudents: true } as const;
    expectOk(await updateAssignment(srv, fx.teacher.token, a.id, { gradingConfig: show }), 'show expected');
    const withExpected = expectOk(await get<SubmissionDetail>(ana().token, `/api/submissions/${sub.id}`), 'shown');
    assert.ok(cells(withExpected).some((c) => 'expected' in c));

    const hide = { scope: 'formulas', showDetailsToStudents: false } as const;
    expectOk(await updateAssignment(srv, fx.teacher.token, a.id, { gradingConfig: hide }), 'hide details');
    const hidden = expectOk(await get<SubmissionDetail>(ana().token, `/api/submissions/${sub.id}`), 'hidden');
    assert.equal(hidden.report, null);
    assert.equal(hidden.autoScore, 50, 'the score itself stays visible');
    const stillThere = expectOk(await get<SubmissionDetail>(fx.teacher.token, `/api/submissions/${sub.id}`), 'still');
    assert.ok(stillThere.report);
  });

  test('display texts of expected values are hidden with the expected values', async () => {
    const a = await createAssignment(srv, fx, { title: 'Display texts' });
    const sub = await submit(srv, ana().token, a.id, HALF);
    // A stored report with display texts, as the grader writes them for formatted numbers.
    const report: GradeReport = {
      correct: 0,
      total: 1,
      fraction: 0,
      warnings: [],
      sheets: [
        {
          keySheet: 'Sheet1',
          studentSheet: 'Sheet1',
          correct: 0,
          total: 1,
          cells: [
            {
              sheet: 'Sheet1',
              address: 'D2',
              correct: false,
              reason: 'value_mismatch',
              expected: 0.318,
              expectedFormula: 'B2/C2',
              expectedText: '31.8%',
              actual: 0.29,
              actualFormula: 'B2/C3',
              actualText: '29.0%',
            },
          ],
        },
      ],
    };
    db.run('UPDATE submissions SET auto_report = ? WHERE id = ?', JSON.stringify(report), sub.id);
    const mineCells = async () => {
      const mine = expectOk(await get<SubmissionDetail[]>(ana().token, `/api/assignments/${a.id}/my-submissions`), 'm');
      return mine[0].report!.sheets[0].cells;
    };

    const [hidden] = await mineCells();
    for (const key of ['expected', 'expectedFormula', 'expectedText']) assert.equal(key in hidden, false, key);
    assert.equal(hidden.actualText, '29.0%');
    assert.equal(hidden.actualFormula, 'B2/C3');
    const single = expectOk(await get<SubmissionDetail>(ana().token, `/api/submissions/${sub.id}`), 'single');
    assert.equal('expectedText' in single.report!.sheets[0].cells[0], false);

    const show = { scope: 'formulas', showExpectedToStudents: true } as const;
    expectOk(await updateAssignment(srv, fx.teacher.token, a.id, { gradingConfig: show }), 'show expected');
    // The update re-grades, so store the report again.
    db.run('UPDATE submissions SET auto_report = ? WHERE id = ?', JSON.stringify(report), sub.id);
    const [shown] = await mineCells();
    assert.equal(shown.expected, 0.318);
    assert.equal(shown.expectedFormula, 'B2/C2');
    assert.equal(shown.expectedText, '31.8%');
    assert.equal(shown.actualText, '29.0%');
  });

  test('owners can download and view their workbook', async () => {
    const a = await createAssignment(srv, fx, { title: 'Viewer' });
    const sub = await submit(srv, ana().token, a.id, PERFECT);
    const download = await get<string>(ana().token, `/api/submissions/${sub.id}/download`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition') ?? '', /attachment.*work\.xlsx/);
    const book = expectOk(await get<WorkbookData>(fx.teacher.token, `/api/submissions/${sub.id}/workbook`), 'book');
    assert.equal(book.fileName, 'work.xlsx');
    assert.equal(book.sheets[0].name, 'Sheet1');
  });
});

describe('grading', () => {
  test('teacher override wins over the autograde score and can be cleared', async () => {
    const a = await createAssignment(srv, fx, { title: 'Override' });
    const sub = await submit(srv, ana().token, a.id, HALF);

    const graded = expectOk(await grade(sub.id, { score: 87.456, feedback: 'Check D3 again.' }), 'grade');
    assert.equal(graded.overrideScore, 87.46);
    assert.equal(graded.finalScore, 87.46);
    assert.equal(graded.autoScore, 50);
    assert.equal(graded.feedback, 'Check D3 again.');
    assert.equal(graded.gradedByName, 'Ms. Rivera');
    assert.ok(graded.gradedAt);
    const list = expectOk(
      await get<AssignmentSubmissionsResponse>(fx.teacher.token, `/api/assignments/${a.id}/submissions`),
      'list',
    );
    assert.equal(list.rows[0].status, 'graded');
    const studentView = expectOk(await get<SubmissionDetail>(ana().token, `/api/submissions/${sub.id}`), 'student');
    assert.equal(studentView.finalScore, 87.46);
    assert.equal(studentView.feedback, 'Check D3 again.');

    const cleared = expectOk(await grade(sub.id, { score: null, feedback: '' }), 'clear');
    assert.equal(cleared.overrideScore, null);
    assert.equal(cleared.finalScore, 50);
    assert.equal(cleared.gradedAt, null);
    assert.equal(cleared.gradedByName, null);
    const relisted = expectOk(
      await get<AssignmentSubmissionsResponse>(fx.teacher.token, `/api/assignments/${a.id}/submissions`),
      'relist',
    );
    assert.equal(relisted.rows[0].status, 'autograded');

    const extraCredit = expectOk(await grade(sub.id, { score: 200, feedback: '' }), 'extra credit');
    assert.equal(extraCredit.finalScore, 200);
  });

  test('validates scores and feedback', async () => {
    const a = await createAssignment(srv, fx, { title: 'Validation', points: 10 });
    const sub = await submit(srv, ana().token, a.id, HALF);
    for (const score of [20.01, -1, 'abc']) {
      const res = await grade(sub.id, { score, feedback: '' });
      assert.equal(res.status, 400, `score ${score}`);
      assert.ok(apiError(res).fields.score);
    }
    const long = await grade(sub.id, { score: 5, feedback: 'x'.repeat(10_001) });
    assert.equal(long.status, 400);
    assert.ok(apiError(long).fields.feedback);
    assert.equal(expectOk(await grade(sub.id, { score: '7.5', feedback: '' }), 'string score').finalScore, 7.5);
  });

  test('manual assignments wait for the teacher', async () => {
    const res = await createAssignmentRequest(srv, fx, { gradingMode: 'manual', title: 'Hand graded' });
    const a = expectOk(res, 'manual');
    const sub = await submit(srv, ana().token, a.id, PERFECT);
    assert.equal(sub.autoStatus, 'not_applicable');
    assert.equal(sub.report, null);
    assert.equal(sub.finalScore, null);

    let detail = expectOk(await get<AssignmentDetail>(ana().token, `/api/assignments/${a.id}`), 'student');
    assert.equal(detail.mine?.status, 'submitted');
    let teacher = expectOk(await get<AssignmentDetail>(fx.teacher.token, `/api/assignments/${a.id}`), 'teacher');
    assert.equal(teacher.counts?.needsGrading, 1);

    expectOk(await grade(sub.id, { score: 80, feedback: 'Good work' }), 'grade');
    detail = expectOk(await get<AssignmentDetail>(ana().token, `/api/assignments/${a.id}`), 'student after');
    assert.equal(detail.mine?.status, 'graded');
    assert.equal(detail.mine?.finalScore, 80);
    teacher = expectOk(await get<AssignmentDetail>(fx.teacher.token, `/api/assignments/${a.id}`), 'teacher after');
    assert.equal(teacher.counts?.needsGrading, 0);
  });
});

describe('gradebook', () => {
  test('JSON has every student × assignment cell', async () => {
    const book = await setupClass(srv, ['Zoe Young', 'Adam Ng'], 'Gradebook JSON');
    const [zoe, adam] = book.students;
    const first = await createAssignment(srv, book, { title: 'First', dueAt: inDays(-1) });
    const second = await createAssignment(srv, book, { title: 'Second', dueAt: inDays(5), points: 20 });
    const zoeSub = await submit(srv, zoe.token, first.id, HALF);
    await submit(srv, adam.token, second.id, PERFECT);

    const gb = expectOk(
      await srv.request<GradebookResponse>('GET', `/api/classes/${book.classId}/gradebook`, {
        token: book.teacher.token,
      }),
      'gradebook',
    );
    assert.deepEqual(
      gb.assignments.map((a) => a.title),
      ['First', 'Second'],
    );
    assert.ok(gb.assignments.every((a) => a.counts));
    assert.deepEqual(
      gb.students.map((s) => s.name),
      ['Adam Ng', 'Zoe Young'],
    );
    assert.deepEqual(gb.cells[zoe.id][first.id], {
      submissionId: zoeSub.id,
      status: 'autograded',
      finalScore: 50,
      late: true,
      submittedAt: zoeSub.submittedAt,
    });
    assert.equal(gb.cells[zoe.id][second.id].status, 'missing');
    assert.equal(gb.cells[zoe.id][second.id].submissionId, null);
    assert.equal(gb.cells[adam.id][second.id].finalScore, 20);
    assert.equal(gb.cells[adam.id][first.id].status, 'missing');

    assert.equal(
      (await srv.request('GET', `/api/classes/${book.classId}/gradebook`, { token: zoe.token })).status,
      403,
    );
  });

  test('CSV escapes values, flags late work and totals final scores', async () => {
    const names = ['Lopez, Maria "MJ"', '=HYPERLINK("x")', 'Quiet Student'];
    const book = await setupClass(srv, names, 'Period 3: Algebra/II');
    const [maria, sneaky] = book.students;
    const first = await createAssignment(srv, book, { title: 'Budget, "Q1"', dueAt: inDays(-1) });
    const second = await createAssignment(srv, book, { title: 'Totals', dueAt: inDays(3), points: 12.5 });
    const manualRes = await createAssignmentRequest(srv, book, {
      title: 'Reflection',
      dueAt: inDays(4),
      gradingMode: 'manual',
    });
    const manual = expectOk(manualRes, 'manual');
    await submit(srv, maria.token, first.id, HALF);
    await submit(srv, maria.token, second.id, PERFECT);
    await submit(srv, maria.token, manual.id, PERFECT);
    await submit(srv, sneaky.token, second.id, HALF);

    const res = await srv.request<string>('GET', `/api/classes/${book.classId}/gradebook.csv`, {
      token: book.teacher.token,
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/csv/);
    const disposition = res.headers.get('content-disposition') ?? '';
    assert.match(disposition, /^attachment;/);
    assert.match(disposition, /filename="Period 3 Algebra II gradebook\.csv"/);

    const lines = res.body.replace(/^﻿/, '').trimEnd().split('\r\n');
    assert.equal(lines[0], 'Student,Email,"Budget, ""Q1"" (100)",Totals (12.5),Reflection (100),Total');
    const byName = (prefix: string) => lines.find((l) => l.startsWith(prefix))!;
    assert.equal(byName('"Lopez'), `"Lopez, Maria ""MJ""",${maria.email},50 LATE,12.5,Ungraded,62.5`);
    assert.equal(byName(`"'=HYPERLINK`), `"'=HYPERLINK(""x"")",${sneaky.email},,6.25,,6.25`);
    assert.match(byName('Quiet Student'), /^Quiet Student,[^,]+,,,,0$/);
    assert.equal(lines.length, 4);
  });
});
