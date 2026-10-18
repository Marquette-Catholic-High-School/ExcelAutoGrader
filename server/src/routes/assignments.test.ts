import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type {
  AssignmentDetail,
  AssignmentSummary,
  KeyPreview,
  RegradeResponse,
  SubmissionDetail,
  WorkbookData,
} from '../../../shared/types.js';
import {
  FORMULAS_CONFIG,
  apiError,
  GARBAGE,
  HALF,
  KEY,
  NO_FORMULAS,
  PERFECT,
  TEMPLATE,
  createAssignment,
  createAssignmentRequest,
  eventually,
  expectOk,
  inDays,
  setupClass,
  submit,
  updateAssignment,
  uploadedFileNames,
  workbook,
  type ClassFixture,
} from '../services/test-fixtures.js';
import { fileBlob, startTestServer, type TestServer } from '../test-utils.js';

const KEY_REQUIRED = 'Upload the finished workbook (answer key) to autograde, or choose manual grading.';

let srv: TestServer;
let fx: ClassFixture;
let db: typeof import('../db.js');

before(async () => {
  srv = await startTestServer();
  db = await import('../db.js'); // same module instance as the server under test
  fx = await setupClass(srv, ['Ana Lopez', 'Ben Carter']);
});

after(() => srv.close());

const teacherGet = <T>(url: string) => srv.request<T>('GET', url, { token: fx.teacher.token });
const studentGet = <T>(url: string, i = 0) => srv.request<T>('GET', url, { token: fx.students[i].token });

function storedFileExists(fileId: number | null): boolean {
  const row = db.get<{ stored_name: string }>('SELECT stored_name FROM files WHERE id = ?', fileId);
  return !!row && fs.existsSync(path.join(srv.dataDir, 'uploads', row.stored_name));
}

describe('creating assignments', () => {
  test('autograding requires the finished workbook (answer key)', async () => {
    const before = uploadedFileNames(srv);
    const res = await createAssignmentRequest(srv, fx, { template: TEMPLATE });
    assert.equal(res.status, 400);
    assert.equal(apiError(res).error, KEY_REQUIRED);
    assert.equal(apiError(res).fields.keyFile, KEY_REQUIRED);
    await eventually(() => assert.deepEqual(uploadedFileNames(srv), before)); // template temp file discarded
  });

  test('a mode-less assignment defaults to autograding and therefore needs a key', async () => {
    const res = await createAssignmentRequest(srv, fx, { gradingMode: undefined });
    assert.equal(res.status, 400);
    assert.equal(apiError(res).error, KEY_REQUIRED);
  });

  test('manual grading works without a key', async () => {
    const res = await createAssignmentRequest(srv, fx, { gradingMode: 'manual', title: '  Essay reflection  ' });
    const a = expectOk(res, 'create manual');
    assert.equal(a.gradingMode, 'manual');
    assert.equal(a.title, 'Essay reflection');
    assert.equal(a.key, null);
    assert.equal(a.template, null);
    assert.equal(a.className, 'Algebra I');
    assert.deepEqual(a.counts, { students: 2, submitted: 0, late: 0, needsGrading: 0, lateUngraded: 0 });
    assert.equal(a.mine, undefined);
  });

  test('autograded assignment stores the key, template and normalized config', async () => {
    const a = await createAssignment(srv, fx, { template: TEMPLATE, description: 'Fill in the totals.' });
    assert.equal(a.gradingMode, 'auto');
    assert.deepEqual(a.key, { name: 'key.xlsx', size: KEY.length });
    assert.equal(a.template?.name, 'starter.xlsx');
    assert.equal(a.description, 'Fill in the totals.');
    assert.equal(a.gradingConfig?.scope, 'formulas');
    assert.equal(a.gradingConfig?.numericTolerance, 0.01, 'defaults are filled in');
    assert.equal(a.points, 100);
  });

  test('reports every invalid field at once', async () => {
    const res = await createAssignmentRequest(srv, fx, {
      title: '   ',
      dueAt: 'not a date',
      points: '-5',
      gradingMode: 'manual',
    });
    assert.equal(res.status, 400);
    const fields = apiError(res).fields;
    assert.ok(fields.title && fields.dueAt && fields.points, JSON.stringify(fields));
    const tooMany = await createAssignmentRequest(srv, fx, { gradingMode: 'manual', points: '10001' });
    assert.equal(tooMany.status, 400);
    assert.ok(apiError(tooMany).fields.points);
  });

  test('rejects an unreadable answer key and discards the upload', async () => {
    const before = uploadedFileNames(srv);
    const res = await createAssignmentRequest(srv, fx, { key: GARBAGE });
    assert.equal(res.status, 400);
    assert.ok(apiError(res).fields.keyFile);
    await eventually(() => assert.deepEqual(uploadedFileNames(srv), before));
  });

  test('rejects non-spreadsheet uploads', async () => {
    const res = await createAssignmentRequest(srv, fx, { key: KEY, keyName: 'notes.txt' });
    assert.equal(res.status, 400);
  });

  test('rejects a key with nothing to grade for the chosen settings', async () => {
    const res = await createAssignmentRequest(srv, fx, { key: NO_FORMULAS, gradingConfig: { scope: 'formulas' } });
    assert.equal(res.status, 400);
    assert.match(apiError(res).fields.keyFile, /formula/i);
  });

  test('rejects an invalid grading config', async () => {
    const res = await createAssignmentRequest(srv, fx, { gradingConfig: { scope: 'ranges', ranges: ['Sheet1!ZZZ'] } });
    assert.equal(res.status, 400);
    assert.ok(apiError(res).fields.gradingConfig);
    const notJson = await createAssignmentRequest(srv, fx, { gradingConfig: '{oops' });
    assert.equal(notJson.status, 400);
    assert.ok(apiError(notJson).fields.gradingConfig);
  });

  test('students cannot create assignments', async () => {
    const form = new FormData();
    form.append('title', 'Nope');
    const res = await srv.request('POST', `/api/classes/${fx.classId}/assignments`, {
      token: fx.students[0].token,
      form,
    });
    assert.equal(res.status, 403);
  });
});

describe('reading assignments', () => {
  test('teachers see the key and config; students see neither', async () => {
    const a = await createAssignment(srv, fx, {
      title: 'Visibility check',
      gradingConfig: { ...FORMULAS_CONFIG, showExpectedToStudents: true },
    });
    const teacherView = expectOk(await teacherGet<AssignmentDetail>(`/api/assignments/${a.id}`), 'teacher view');
    assert.ok(teacherView.key && teacherView.gradingConfig);
    assert.equal(teacherView.studentVisibility, undefined);

    const studentView = expectOk(await studentGet<AssignmentDetail>(`/api/assignments/${a.id}`), 'student view');
    assert.equal('key' in studentView, false);
    assert.equal('gradingConfig' in studentView, false);
    assert.equal('counts' in studentView, false);
    assert.deepEqual(studentView.studentVisibility, { showDetailsToStudents: true, showExpectedToStudents: true });
    assert.equal(studentView.mine?.status, 'not_submitted');

    assert.equal((await studentGet(`/api/assignments/${a.id}/key/download`)).status, 403);
    assert.equal((await studentGet(`/api/assignments/${a.id}/key/workbook`)).status, 403);

    const download = await teacherGet<string>(`/api/assignments/${a.id}/key/download`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition') ?? '', /attachment.*key\.xlsx/);

    const keyBook = expectOk(await teacherGet<WorkbookData>(`/api/assignments/${a.id}/key/workbook`), 'key workbook');
    assert.equal(keyBook.sheets[0].name, 'Sheet1');
    assert.equal(keyBook.sheets[0].cells.D2.f, 'B2*C2');
  });

  test('outsiders get 403 and unknown ids 404', async () => {
    const a = await createAssignment(srv, fx, { title: 'Private' });
    const outsider = await srv.registerUser('student', 'Not Enrolled');
    const otherTeacher = await srv.registerUser('teacher', 'Other Teacher');
    assert.equal((await srv.request('GET', `/api/assignments/${a.id}`, { token: outsider.token })).status, 403);
    assert.equal((await srv.request('GET', `/api/assignments/${a.id}`, { token: otherTeacher.token })).status, 403);
    assert.equal((await teacherGet('/api/assignments/999999')).status, 404);
    assert.equal((await teacherGet('/api/assignments/abc')).status, 400);
  });

  test('starter template downloads for students; 404 without one', async () => {
    const withTemplate = await createAssignment(srv, fx, { title: 'Has starter', template: TEMPLATE });
    const res = await studentGet<string>(`/api/assignments/${withTemplate.id}/template/download`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition') ?? '', /starter\.xlsx/);

    const without = await createAssignment(srv, fx, { title: 'No starter' });
    assert.equal((await studentGet(`/api/assignments/${without.id}/template/download`)).status, 404);
  });

  test('lists are sorted by due date with counts for teachers and `mine` for students', async () => {
    const other = await setupClass(srv, ['Cara Diaz'], 'Statistics');
    const late = await createAssignment(srv, other, { title: 'Later', dueAt: inDays(10) });
    const past = await createAssignment(srv, other, { title: 'Past due', dueAt: inDays(-1) });
    const soon = await createAssignment(srv, other, { title: 'Soon', dueAt: inDays(1) });
    await submit(srv, other.students[0].token, past.id, HALF);

    const teacherList = expectOk(
      await srv.request<AssignmentSummary[]>('GET', `/api/classes/${other.classId}/assignments`, {
        token: other.teacher.token,
      }),
      'teacher list',
    );
    assert.deepEqual(
      teacherList.map((a) => a.id),
      [past.id, soon.id, late.id],
    );
    assert.deepEqual(teacherList[0].counts, { students: 1, submitted: 1, late: 1, needsGrading: 0, lateUngraded: 0 });
    assert.deepEqual(teacherList[1].counts, { students: 1, submitted: 0, late: 0, needsGrading: 0, lateUngraded: 0 });
    assert.equal(teacherList[0].mine, undefined);

    const studentToken = other.students[0].token;
    const studentList = expectOk(
      await srv.request<AssignmentSummary[]>('GET', `/api/classes/${other.classId}/assignments`, {
        token: studentToken,
      }),
      'student list',
    );
    assert.equal(studentList[0].counts, undefined);
    assert.equal(studentList[0].mine?.status, 'graded');
    assert.equal(studentList[0].mine?.late, true);
    assert.equal(studentList[0].mine?.finalScore, 50);
    assert.equal(studentList[0].mine?.attemptCount, 1);
    assert.equal(studentList[1].mine?.status, 'not_submitted');

    const mine = expectOk(
      await srv.request<AssignmentSummary[]>('GET', '/api/me/assignments', { token: studentToken }),
      'my assignments',
    );
    assert.deepEqual(
      mine.map((a) => a.title),
      ['Past due', 'Soon', 'Later'],
    );
    assert.ok(mine.every((a) => a.className === 'Statistics' && a.mine));

    const teacherMine = expectOk(
      await srv.request<AssignmentSummary[]>('GET', '/api/me/assignments', { token: other.teacher.token }),
      'teacher my assignments',
    );
    assert.equal(teacherMine.length, 3);
    assert.ok(teacherMine.every((a) => a.counts && !a.mine));

    const missing = await createAssignment(srv, other, { title: 'Missed', dueAt: inDays(-2) });
    const detail = expectOk(
      await srv.request<AssignmentDetail>('GET', `/api/assignments/${missing.id}`, { token: studentToken }),
      'missing detail',
    );
    assert.equal(detail.mine?.status, 'missing');
  });

  test('lateUngraded counts late latest submissions that still have no final score', async () => {
    const manual = expectOk(
      await createAssignmentRequest(srv, fx, { title: 'Late manual', gradingMode: 'manual', dueAt: inDays(-1) }),
      'manual',
    );
    const auto = await createAssignment(srv, fx, { title: 'Late auto', dueAt: inDays(-1) });
    const lateManual = await submit(srv, fx.students[0].token, manual.id, PERFECT);
    await submit(srv, fx.students[1].token, auto.id, HALF);
    const counts = async (id: number) =>
      expectOk(await teacherGet<AssignmentDetail>(`/api/assignments/${id}`), 'detail').counts;

    assert.deepEqual(await counts(manual.id), { students: 2, submitted: 1, late: 1, needsGrading: 1, lateUngraded: 1 });
    assert.deepEqual(await counts(auto.id), { students: 2, submitted: 1, late: 1, needsGrading: 0, lateUngraded: 0 });
    const listed = expectOk(await teacherGet<AssignmentSummary[]>('/api/me/assignments'), 'my assignments');
    assert.equal(listed.find((a) => a.id === manual.id)?.counts?.lateUngraded, 1);
    const inClass = expectOk(await teacherGet<AssignmentSummary[]>(`/api/classes/${fx.classId}/assignments`), 'class');
    assert.equal(inClass.find((a) => a.id === manual.id)?.counts?.lateUngraded, 1);

    const graded = await srv.request('PATCH', `/api/submissions/${lateManual.id}/grade`, {
      token: fx.teacher.token,
      json: { score: 80, feedback: '' },
    });
    expectOk(graded, 'grade');
    assert.deepEqual(await counts(manual.id), { students: 2, submitted: 1, late: 1, needsGrading: 0, lateUngraded: 0 });
  });
});

describe('updating assignments', () => {
  test('switching to manual clears autograde results; switching back re-grades', async () => {
    const a = await createAssignment(srv, fx, { title: 'Mode switch' });
    const sub = await submit(srv, fx.students[0].token, a.id, PERFECT);
    assert.equal(sub.autoScore, 100);

    const manual = expectOk(await updateAssignment(srv, fx.teacher.token, a.id, { gradingMode: 'manual' }), 'manual');
    assert.equal(manual.gradingMode, 'manual');
    assert.ok(manual.key, 'the stored key is kept');
    const cleared = expectOk(await teacherGet<SubmissionDetail>(`/api/submissions/${sub.id}`), 'cleared');
    assert.equal(cleared.autoStatus, 'not_applicable');
    assert.equal(cleared.autoScore, null);
    assert.equal(cleared.report, null);
    assert.equal(cleared.finalScore, null);
    assert.equal(manual.counts?.needsGrading, 1);

    const auto = expectOk(await updateAssignment(srv, fx.teacher.token, a.id, { gradingMode: 'auto' }), 'auto');
    assert.equal(auto.counts?.needsGrading, 0);
    const regraded = expectOk(await teacherGet<SubmissionDetail>(`/api/submissions/${sub.id}`), 'regraded');
    assert.equal(regraded.autoStatus, 'graded');
    assert.equal(regraded.autoScore, 100);
  });

  test('switching a manual assignment without a key to auto requires one', async () => {
    const res = await createAssignmentRequest(srv, fx, { gradingMode: 'manual', title: 'Keyless' });
    const a = expectOk(res, 'manual');
    const switched = await updateAssignment(srv, fx.teacher.token, a.id, { gradingMode: 'auto' });
    assert.equal(switched.status, 400);
    assert.equal(apiError(switched).error, KEY_REQUIRED);

    const withKey = await updateAssignment(srv, fx.teacher.token, a.id, { gradingMode: 'auto', key: KEY });
    assert.equal(expectOk(withKey, 'auto with key').gradingMode, 'auto');
  });

  test('replacing the key deletes the old file and re-grades; points changes re-grade', async () => {
    const a = await createAssignment(srv, fx, { title: 'Key swap' });
    const sub = await submit(srv, fx.students[0].token, a.id, HALF);
    assert.equal(sub.autoScore, 50);
    const oldKeyId = db.get<{ key_file_id: number }>('SELECT key_file_id FROM assignments WHERE id = ?', a.id)!
      .key_file_id;
    assert.ok(storedFileExists(oldKeyId));

    // The new key accepts B3+C3 = 9 in D3, so the HALF workbook becomes fully correct.
    const newKey = workbook({
      Sheet1: [
        ['Item', 'Qty', 'Price', 'Total'],
        ['Pens', 2, 3, { f: 'B2*C2', v: 6 }],
        ['Pads', 4, 5, { f: 'B3+C3', v: 9 }],
      ],
    });
    const updated = expectOk(
      await updateAssignment(srv, fx.teacher.token, a.id, { key: newKey, keyName: 'key-v2.xlsx' }),
      'replace key',
    );
    assert.equal(updated.key?.name, 'key-v2.xlsx');
    assert.equal(db.get('SELECT id FROM files WHERE id = ?', oldKeyId), undefined);
    assert.equal(storedFileExists(oldKeyId), false);
    assert.equal(expectOk(await teacherGet<SubmissionDetail>(`/api/submissions/${sub.id}`), 'after').autoScore, 100);

    expectOk(await updateAssignment(srv, fx.teacher.token, a.id, { points: 40 }), 'points');
    const rescored = expectOk(await teacherGet<SubmissionDetail>(`/api/submissions/${sub.id}`), 'rescored');
    assert.equal(rescored.autoScore, 40);
    assert.equal(rescored.pointsPossible, 40);
  });

  test('template can be replaced and removed', async () => {
    const a = await createAssignment(srv, fx, { title: 'Template swap', template: TEMPLATE });
    const firstTemplateId = db.get<{ template_file_id: number }>(
      'SELECT template_file_id FROM assignments WHERE id = ?',
      a.id,
    )!.template_file_id;
    const form = new FormData();
    form.append('removeTemplate', 'true');
    const removed = expectOk(
      await srv.request<AssignmentDetail>('PATCH', `/api/assignments/${a.id}`, { token: fx.teacher.token, form }),
      'remove template',
    );
    assert.equal(removed.template, null);
    assert.equal(storedFileExists(firstTemplateId), false);
  });

  test('validates updated fields and leaves the assignment unchanged on error', async () => {
    const a = await createAssignment(srv, fx, { title: 'Stable' });
    const res = await updateAssignment(srv, fx.teacher.token, a.id, { title: '', points: 0 });
    assert.equal(res.status, 400);
    assert.ok(apiError(res).fields.title && apiError(res).fields.points);
    const after = expectOk(await teacherGet<AssignmentDetail>(`/api/assignments/${a.id}`), 'after');
    assert.equal(after.title, 'Stable');

    const dueAt = inDays(3);
    const moved = expectOk(await updateAssignment(srv, fx.teacher.token, a.id, { dueAt }), 'move due date');
    assert.equal(moved.dueAt, dueAt);
  });

  test('students cannot update or delete assignments', async () => {
    const a = await createAssignment(srv, fx, { title: 'Locked' });
    assert.equal((await updateAssignment(srv, fx.students[0].token, a.id, { title: 'Mine now' })).status, 403);
    assert.equal(
      (await srv.request('DELETE', `/api/assignments/${a.id}`, { token: fx.students[0].token })).status,
      403,
    );
  });
});

describe('regrade, preview and delete', () => {
  test('regrade re-runs every submission', async () => {
    const a = await createAssignment(srv, fx, { title: 'Regrade me' });
    await submit(srv, fx.students[0].token, a.id, HALF);
    await submit(srv, fx.students[0].token, a.id, PERFECT);
    await submit(srv, fx.students[1].token, a.id, PERFECT);
    const res = await srv.request<RegradeResponse>('POST', `/api/assignments/${a.id}/regrade`, {
      token: fx.teacher.token,
    });
    assert.deepEqual(expectOk(res, 'regrade'), { regraded: 3, errors: 0 });

    const manual = expectOk(
      await createAssignmentRequest(srv, fx, { gradingMode: 'manual', title: 'Manual regrade' }),
      'manual',
    );
    const refused = await srv.request('POST', `/api/assignments/${manual.id}/regrade`, { token: fx.teacher.token });
    assert.equal(refused.status, 400);
  });

  test('preview reports gradable cells without storing anything', async () => {
    const before = uploadedFileNames(srv);
    const form = new FormData();
    form.append('keyFile', fileBlob(KEY), 'key.xlsx');
    form.append('gradingConfig', JSON.stringify({ scope: 'formulas' }));
    const preview = expectOk(
      await srv.request<KeyPreview>('POST', '/api/grader/preview', { token: fx.teacher.token, form }),
      'preview',
    );
    assert.equal(preview.totalCells, 2);
    assert.equal(preview.formulaCells, 2);
    await eventually(() => assert.deepEqual(uploadedFileNames(srv), before));

    const a = await createAssignment(srv, fx, { title: 'Stored key preview' });
    const stored = new FormData();
    stored.append('assignmentId', String(a.id));
    stored.append('gradingConfig', JSON.stringify({ scope: 'all' }));
    const fromStored = expectOk(
      await srv.request<KeyPreview>('POST', '/api/grader/preview', { token: fx.teacher.token, form: stored }),
      'stored preview',
    );
    assert.ok(fromStored.totalCells > 2, 'scope all also checks the labels and inputs');

    const empty = new FormData();
    empty.append('gradingConfig', JSON.stringify({}));
    const missing = await srv.request('POST', '/api/grader/preview', { token: fx.teacher.token, form: empty });
    assert.equal(missing.status, 400);
    assert.ok(apiError(missing).fields.keyFile);

    const badConfig = new FormData();
    badConfig.append('keyFile', fileBlob(KEY), 'key.xlsx');
    badConfig.append('gradingConfig', JSON.stringify({ scope: 'ranges', ranges: ['Sheet1!ZZZ'] }));
    const invalid = await srv.request('POST', '/api/grader/preview', { token: fx.teacher.token, form: badConfig });
    assert.equal(invalid.status, 400);
    assert.ok(apiError(invalid).fields.gradingConfig);

    const asStudent = new FormData();
    asStudent.append('keyFile', fileBlob(KEY), 'key.xlsx');
    const studentRes = await srv.request('POST', '/api/grader/preview', {
      token: fx.students[0].token,
      form: asStudent,
    });
    assert.equal(studentRes.status, 403);
  });

  test('deleting an assignment removes its rows and every stored file', async () => {
    const a = await createAssignment(srv, fx, { title: 'Doomed', template: TEMPLATE });
    await submit(srv, fx.students[0].token, a.id, PERFECT);
    await submit(srv, fx.students[1].token, a.id, HALF);
    const fileIds = db
      .all<{ id: number }>(
        `SELECT key_file_id AS id FROM assignments WHERE id = ?
         UNION SELECT template_file_id FROM assignments WHERE id = ?
         UNION SELECT file_id FROM submissions WHERE assignment_id = ?`,
        a.id,
        a.id,
        a.id,
      )
      .map((r) => r.id);
    assert.equal(fileIds.length, 4);
    assert.ok(fileIds.every(storedFileExists));
    const stored = db
      .all<{ stored_name: string }>(
        'SELECT stored_name FROM files WHERE id IN (SELECT value FROM json_each(?))',
        JSON.stringify(fileIds),
      )
      .map((r) => r.stored_name);

    const res = await srv.request('DELETE', `/api/assignments/${a.id}`, { token: fx.teacher.token });
    assert.deepEqual(expectOk(res, 'delete'), { ok: true });
    assert.equal((await teacherGet(`/api/assignments/${a.id}`)).status, 404);
    assert.equal(db.get('SELECT 1 FROM submissions WHERE assignment_id = ?', a.id), undefined);
    assert.equal(
      db.get('SELECT 1 FROM files WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(fileIds)),
      undefined,
    );
    const onDisk = new Set(uploadedFileNames(srv));
    assert.ok(stored.every((name) => !onDisk.has(name)));
  });
});
