import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { AddStudentsResponse, AssignmentDetail, ClassSummary, SubmissionDetail } from '../../../shared/types.js';
import { pdfFontNames, pdfPages, pdfText } from '../services/reports/pdf-text.js';
import {
  HALF,
  PERFECT,
  createAssignment,
  expectOk,
  inDays,
  setupClass,
  submit,
  submitRequest,
  type Actor,
  type ClassFixture,
} from '../services/test-fixtures.js';
import { startTestServer, type TestServer } from '../test-utils.js';

let srv: TestServer;
let fx: ClassFixture;
let db: typeof import('../db.js');
let budget: AssignmentDetail;
let reflection: AssignmentDetail;
let notStarted: AssignmentDetail;
let pendingId: number;

const CLASS = 'Business Computing 101';
const NAMES = ['José Álvarez', 'Nguyễn Thị Hương', 'Zoë Müller', 'Łukasz Kowalski'];
const FEEDBACK = 'Great job, José! Keep using absolute references.';

const jose = () => fx.students[0];
const huong = () => fx.students[1];
const zoe = () => fx.students[2];
const lukasz = () => fx.students[3];

const grade = (submissionId: number, json: unknown) =>
  srv.request<SubmissionDetail>('PATCH', `/api/submissions/${submissionId}/grade`, { token: fx.teacher.token, json });

before(async () => {
  srv = await startTestServer();
  db = await import('../db.js');
  fx = await setupClass(srv, NAMES, CLASS);
  const invited = await srv.request<AddStudentsResponse>('POST', `/api/classes/${fx.classId}/students`, {
    token: fx.teacher.token,
    json: { students: [{ name: 'Grace Lee', email: 'grace.lee@example.test' }] },
  });
  pendingId = expectOk(invited, 'invite').added[0].student.id;

  // Monthly Budget (autograded, 20 points, due yesterday): José 100% with feedback, Hương and Grace (uploaded by the
  // teacher) 50%, all backdated to before the due date; Zoë's 50% is late (just now) and Łukasz is missing.
  budget = await createAssignment(srv, fx, { title: 'Monthly Budget', dueAt: inDays(-1), points: 20 });
  const onTime = [
    await submit(srv, jose().token, budget.id, PERFECT),
    await submit(srv, huong().token, budget.id, HALF),
    expectOk(await submitRequest(srv, fx.teacher.token, budget.id, HALF, { studentId: pendingId }), 'upload for Grace'),
  ];
  for (const work of onTime) db.run('UPDATE submissions SET submitted_at = ? WHERE id = ?', inDays(-2), work.id);
  await submit(srv, zoe().token, budget.id, HALF);
  expectOk(await grade(onTime[0].id, { score: null, feedback: FEEDBACK }), 'feedback');

  // Reflection (graded by hand, not due yet): only Hương has turned it in.
  reflection = await createAssignment(srv, fx, {
    title: 'Reflection',
    gradingMode: 'manual',
    key: undefined,
    dueAt: inDays(5),
    points: 10,
  });
  await submit(srv, huong().token, reflection.id, HALF);
  notStarted = await createAssignment(srv, fx, { title: 'Not Started Yet', dueAt: inDays(9) });
});

after(() => srv.close());

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

interface PdfResponse {
  status: number;
  body: Buffer;
  headers: Headers;
}

async function fetchRaw(url: string, token?: string): Promise<PdfResponse> {
  const res = await fetch(srv.baseUrl + url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()), headers: res.headers };
}

/** GETs a report as the class teacher and checks that it is a complete PDF download. */
async function getPdf(url: string, token = fx.teacher.token): Promise<PdfResponse> {
  const res = await fetchRaw(url, token);
  assert.equal(res.status, 200, `${url}: HTTP ${res.status} ${res.body.toString('utf8').slice(0, 200)}`);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.body.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.match(res.body.subarray(-16).toString('latin1'), /%%EOF\s*$/);
  return res;
}

/** The UTF-8 filename (filename*) and the ASCII fallback (filename) of the download. */
function fileNames(res: PdfResponse): { utf8: string; ascii: string } {
  const header = res.headers.get('content-disposition') ?? '';
  assert.match(header, /^attachment;/);
  const utf8 = /filename\*=UTF-8''([^;]+)/.exec(header)?.[1];
  const ascii = /filename="([^"]*)"/.exec(header)?.[1];
  assert.ok(utf8 && ascii !== undefined, header);
  return { utf8: decodeURIComponent(utf8), ascii };
}

const assignmentUrl = (id: number) => `/api/reports/assignments/${id}.pdf`;
const studentUrl = (classId: number, studentId: number) => `/api/reports/classes/${classId}/students/${studentId}.pdf`;
const allStudentsUrl = (classId: number) => `/api/reports/classes/${classId}/students.pdf`;
const gradebookUrl = (classId: number) => `/api/reports/classes/${classId}/gradebook.pdf`;

function includesAll(text: string, parts: readonly string[]): void {
  for (const part of parts) assert.ok(text.includes(part), `expected the PDF to contain "${part}"\n---\n${text}`);
}

async function otherTeacher(): Promise<Actor & { classId: number }> {
  const other = await setupClass(srv, ['Outsider Student'], 'Other Class');
  return { ...other.teacher, classId: other.classId };
}

/* ------------------------------------------------------------------ */
/* Access                                                             */
/* ------------------------------------------------------------------ */

describe('access', () => {
  const urls = () => [
    assignmentUrl(budget.id),
    studentUrl(fx.classId, jose().id),
    allStudentsUrl(fx.classId),
    gradebookUrl(fx.classId),
  ];

  test('only the class teacher gets the reports', async () => {
    const other = await otherTeacher();
    for (const url of urls()) {
      assert.equal((await fetchRaw(url)).status, 401, `${url} without signing in`);
      assert.equal((await fetchRaw(url, jose().token)).status, 403, `${url} as a student`);
      assert.equal((await fetchRaw(url, other.token)).status, 403, `${url} as another teacher`);
      assert.equal((await fetchRaw(url, fx.teacher.token)).status, 200, `${url} as the class teacher`);
    }
  });

  test('unknown ids are 404, malformed ids 400', async () => {
    const token = fx.teacher.token;
    for (const url of [
      assignmentUrl(999_999),
      studentUrl(999_999, jose().id),
      allStudentsUrl(999_999),
      gradebookUrl(999_999),
      studentUrl(fx.classId, 999_999),
    ]) {
      const res = await fetchRaw(url, token);
      assert.equal(res.status, 404, url);
      assert.match(res.headers.get('content-type') ?? '', /json/);
    }
    assert.equal((await fetchRaw('/api/reports/assignments/abc.pdf', token)).status, 400);
    assert.equal((await fetchRaw('/api/reports/classes/1/students/0.pdf', token)).status, 400);
  });

  test("a student who isn't in the class is 404, also for a teacher's own student from another class", async () => {
    const other = await setupClass(srv, ['Somebody Else'], 'Second Period');
    const res = await fetchRaw(studentUrl(fx.classId, other.students[0].id), fx.teacher.token);
    assert.equal(res.status, 404);
    // The other teacher asks about one of this class's students through their own class.
    assert.equal((await fetchRaw(studentUrl(other.classId, jose().id), other.teacher.token)).status, 404);
  });
});

/* ------------------------------------------------------------------ */
/* Assignment report                                                  */
/* ------------------------------------------------------------------ */

describe('assignment report', () => {
  test('summary, scores, LATE and missing markers, invited students and the most-missed cells', async () => {
    const res = await getPdf(assignmentUrl(budget.id));
    assert.deepEqual(fileNames(res), {
      utf8: `Monthly Budget - ${CLASS}.pdf`,
      ascii: `Monthly Budget - ${CLASS}.pdf`,
    });
    const text = pdfText(res.body);
    includesAll(text, [
      'Assignment report',
      "Podner's Excel",
      'Monthly Budget',
      `${CLASS} · Teacher: Ms. Rivera`,
      '20 points · Autograded',
      'Generated ',
      'ENROLLED 5',
      'SUBMITTED 4',
      'ON TIME 3',
      'LATE 1',
      'MISSING 1',
      'NEEDS GRADING 0',
      'AVERAGE 12.5 of 20 · 62.5%',
      'HIGH 20 of 20 · 100%',
      'LOW 10 of 20 · 50%',
      'Score distribution',
      '4 scored submissions',
      '90–100%',
      ...NAMES,
      'Grace Lee',
      "Invited · hasn't signed up yet",
      'Autograded',
      'LATE',
      'Missing',
      'On time',
      '100%',
      '50%',
      'Most-missed cells',
      'Sheet1!D3',
      '75% 3 of 4',
      'Wrong value',
      '(=B3*C3)',
      'Page 1 of',
    ]);
    // José got every cell right, so D2 isn't listed.
    assert.ok(!text.includes('Sheet1!D2'));
    assert.deepEqual(
      pdfFontNames(res.body).filter((name) => !name.startsWith('Roboto')),
      [],
      'only the embedded Roboto fonts',
    );
  });

  test('a hand-graded assignment has no cell analysis, and work not yet due is not missing', async () => {
    const text = pdfText((await getPdf(assignmentUrl(reflection.id))).body);
    includesAll(text, ['Reflection', 'Graded by the teacher', 'Needs grading', 'Not submitted', 'NOT SUBMITTED 4']);
    assert.ok(!text.includes('Most-missed cells'));
    assert.ok(!text.includes('Missing'));
  });

  test('an assignment nobody has submitted yet', async () => {
    const text = pdfText((await getPdf(assignmentUrl(notStarted.id))).body);
    includesAll(text, ['Not Started Yet', 'SUBMITTED 0', 'No scores yet.', 'No autograded submissions yet.']);
    assert.equal(text.split('Not submitted').length - 1, 5, 'every student is listed as not submitted');
  });
});

/* ------------------------------------------------------------------ */
/* Student reports                                                    */
/* ------------------------------------------------------------------ */

describe('student report', () => {
  test('every assignment with status, score, LATE flag, and the teacher feedback', async () => {
    const res = await getPdf(studentUrl(fx.classId, jose().id));
    assert.deepEqual(fileNames(res), {
      utf8: `José Álvarez - ${CLASS}.pdf`,
      ascii: `Jose Alvarez - ${CLASS}.pdf`,
    });
    const text = pdfText(res.body);
    includesAll(text, [
      'Student report',
      'José Álvarez',
      jose().email,
      `${CLASS} · Teacher: Ms. Rivera`,
      'OVERALL 100%',
      'COMPLETED 1 of 3',
      'LATE 0',
      'MISSING 0',
      'AUTOGRADED WORK 100%',
      'Monthly Budget',
      '20 / 20',
      'Reflection',
      'Not due yet',
      'Teacher feedback',
      FEEDBACK,
    ]);
    // Assignments are in due-date order.
    assert.ok(text.indexOf('Monthly Budget') < text.indexOf('Reflection'));
    assert.ok(text.indexOf('Reflection') < text.indexOf('Not Started Yet'));
  });

  test('late and missing work', async () => {
    const late = pdfText((await getPdf(studentUrl(fx.classId, zoe().id))).body);
    includesAll(late, ['Zoë Müller', 'LATE 1', 'LATE', '10 / 20', '50%', 'No written feedback yet.']);
    const missing = pdfText((await getPdf(studentUrl(fx.classId, lukasz().id))).body);
    includesAll(missing, ['Łukasz Kowalski', 'MISSING 1', 'Missing', 'OVERALL —', 'Nothing graded yet']);
  });

  test('Vietnamese names render and keep their UTF-8 filename', async () => {
    const res = await getPdf(studentUrl(fx.classId, huong().id));
    assert.deepEqual(fileNames(res), {
      utf8: `Nguyễn Thị Hương - ${CLASS}.pdf`,
      ascii: `Nguyen Thi Huong - ${CLASS}.pdf`,
    });
    includesAll(pdfText(res.body), ['Nguyễn Thị Hương', 'Needs grading', 'COMPLETED 2 of 3']);
  });

  test('students who were invited but have not signed up are marked', async () => {
    const text = pdfText((await getPdf(studentUrl(fx.classId, pendingId))).body);
    includesAll(text, ['Grace Lee', "INVITED · HASN'T SIGNED UP YET", 'grace.lee@example.test']);
  });

  test('long feedback flows onto the next page without losing any of it', async () => {
    const sentences = Array.from({ length: 200 }, (_, i) => `Sentence ${i + 1} of 200 about your formulas.`);
    const feedback = sentences.join(' ');
    assert.ok(feedback.length <= 10_000);
    const mine = `/api/assignments/${budget.id}/my-submissions`;
    const [latest] = expectOk(await srv.request<SubmissionDetail[]>('GET', mine, { token: zoe().token }), 'mine');
    expectOk(await grade(latest.id, { score: null, feedback }), 'long feedback');
    try {
      const res = await getPdf(studentUrl(fx.classId, zoe().id));
      const pages = pdfPages(res.body);
      assert.ok(pages.length >= 2, `expected the feedback to need a second page, got ${pages.length}`);
      const text = pdfText(res.body);
      for (const n of [1, 100, 199, 200]) assert.ok(text.includes(`Sentence ${n} of 200`), `sentence ${n}`);
    } finally {
      expectOk(await grade(latest.id, { score: null, feedback: '' }), 'clear feedback');
    }
  });
});

describe('all students', () => {
  test('one report per enrolled student, each starting on a new page', async () => {
    const res = await getPdf(allStudentsUrl(fx.classId));
    assert.deepEqual(fileNames(res).utf8, `All students - ${CLASS}.pdf`);
    const pages = pdfPages(res.body);
    const roster = expectOk(
      await srv.request<{ name: string }[]>('GET', `/api/classes/${fx.classId}/students`, { token: fx.teacher.token }),
      'roster',
    ).map((s) => s.name);
    assert.equal(roster.length, 5);
    assert.ok(pages.length >= roster.length);
    // Each report's first page starts with the student's name (and the invited badge), in roster order; every page's
    // footer names the student.
    const startsWith = (page: string, name: string) => [name, `${name} INVITED`].some((s) => page.startsWith(s));
    const firstPages = roster.map((name) => pages.findIndex((page) => startsWith(page, name)));
    assert.ok(firstPages.every((i) => i >= 0), `every student starts a page: ${firstPages}`);
    assert.deepEqual([...firstPages].sort((a, b) => a - b), firstPages);
    roster.forEach((name, i) => {
      const end = i + 1 < roster.length ? firstPages[i + 1] : pages.length;
      for (let page = firstPages[i]; page < end; page++) {
        assert.ok(pages[page].includes(`${name} · ${CLASS}`), `page ${page + 1} footer names ${name}`);
      }
    });
    assert.ok(pages.at(-1)!.includes(`Page ${pages.length} of ${pages.length}`));
  });
});

/* ------------------------------------------------------------------ */
/* Gradebook                                                          */
/* ------------------------------------------------------------------ */

describe('gradebook', () => {
  test('students × assignments on landscape pages with totals and class averages', async () => {
    const res = await getPdf(gradebookUrl(fx.classId));
    assert.equal(fileNames(res).utf8, `Gradebook - ${CLASS}.pdf`);
    assert.match(res.body.toString('latin1'), /\/MediaBox \[0 0 792 612\]/, 'landscape letter');
    const text = pdfText(res.body);
    includesAll(text, [
      `${CLASS} — Gradebook`,
      '5 students · 3 assignments',
      ...NAMES,
      'Grace Lee',
      'Monthly Budget',
      'Reflection',
      'Not Started Yet',
      'LATE',
      'missing',
      'ungraded',
      'Total',
      '20 / 20',
      'Class average',
      'Submitted',
      '4/5',
      '1 late',
    ]);
    assert.ok(!text.includes('Points (graded work)'), 'a small class keeps the totals in the same table');
  });
});

describe('empty classes', () => {
  test('a class with no students or assignments', async () => {
    const cls = expectOk(
      await srv.request<ClassSummary>('POST', '/api/classes', { token: fx.teacher.token, json: { name: 'Brand New' } }),
      'class',
    );
    const all = pdfText((await getPdf(allStudentsUrl(cls.id))).body);
    includesAll(all, ['Brand New', 'No students are enrolled in this class yet.']);
    const book = pdfText((await getPdf(gradebookUrl(cls.id))).body);
    includesAll(book, ['Brand New — Gradebook', '0 students · 0 assignments', 'No students are enrolled']);
  });

  test('a class with students but no assignments', async () => {
    const other = await setupClass(srv, ['Only Student'], 'No Work Yet');
    const text = pdfText((await getPdf(studentUrl(other.classId, other.students[0].id), other.teacher.token)).body);
    includesAll(text, ['Only Student', 'COMPLETED 0 of 0', 'This class has no assignments yet.']);
    const book = pdfText((await getPdf(gradebookUrl(other.classId), other.teacher.token)).body);
    includesAll(book, ['This class has no assignments yet.']);
  });
});

/* ------------------------------------------------------------------ */
/* A large class                                                      */
/* ------------------------------------------------------------------ */

/** 40 students × 30 autograded assignments, written straight to the database (uploading 1,200 files is slow). */
function seedLargeClass(teacherId: number): { classId: number; studentNames: string[] } {
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  return db.transaction(() => {
    const classId = db.run(
      `INSERT INTO classes (teacher_id, name, description, join_code, created_at)
       VALUES (?, 'Large Class', '', 'LRG234', ?)`,
      teacherId,
      iso(now),
    ).lastInsertRowid;
    const fileId = db.run(
      "INSERT INTO files (original_name, stored_name, size, created_at) VALUES ('work.xlsx', 'large-class-file', 1, ?)",
      iso(now),
    ).lastInsertRowid;
    const studentNames = Array.from({ length: 40 }, (_, i) => `${NAMES[i % NAMES.length]} ${i + 10}`);
    const students = studentNames.map((name, i) => {
      const id = db.run(
        "INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, ?, '', 'student', ?)",
        `large-${i}-${process.pid}@example.test`,
        name,
        iso(now),
      ).lastInsertRowid;
      db.run('INSERT INTO enrollments (class_id, student_id, joined_at) VALUES (?, ?, ?)', classId, id, iso(now));
      return id;
    });
    for (let a = 0; a < 30; a++) {
      const due = now + (a - 20) * 86_400_000;
      const assignmentId = db.run(
        `INSERT INTO assignments
           (class_id, title, description, due_at, points, grading_mode, grading_config, created_at)
         VALUES (?, ?, '', ?, 100, 'auto', '{}', ?)`,
        classId,
        `Workbook ${a + 1}`,
        iso(due),
        iso(now),
      ).lastInsertRowid;
      students.forEach((studentId, s) => {
        if ((s + a) % 7 === 0) return; // missing (or not submitted yet)
        const cells = Array.from({ length: 40 }, (_, c) => ({
          sheet: 'Budget',
          address: `C${c + 2}`,
          correct: (s + c + a) % 5 !== 0,
          reason: (s + c + a) % 5 === 0 ? 'value_mismatch' : undefined,
          expected: c * 10,
          expectedFormula: `SUM(B${c + 2}:B${c + 4})`,
          actual: c,
        }));
        const correct = cells.filter((c) => c.correct).length;
        const report = {
          correct,
          total: cells.length,
          fraction: correct / cells.length,
          warnings: [],
          sheets: [{ keySheet: 'Budget', studentSheet: 'Budget', correct, total: cells.length, cells }],
        };
        db.run(
          `INSERT INTO submissions (assignment_id, student_id, file_id, attempt, submitted_at, auto_status, auto_score,
             auto_report, feedback)
           VALUES (?, ?, ?, 1, ?, 'graded', ?, ?, ?)`,
          assignmentId,
          studentId,
          fileId,
          iso(due + ((s + a) % 9 === 0 ? 3_600_000 : -3_600_000)),
          (correct / cells.length) * 100,
          JSON.stringify(report),
          s % 4 === 0 ? `Feedback for workbook ${a + 1}: check the totals row.` : '',
        );
      });
    }
    return { classId, studentNames };
  });
}

describe('a 40-student × 30-assignment class', () => {
  test('renders the gradebook and every student report in well under 5 seconds each', async () => {
    const { classId, studentNames } = seedLargeClass(fx.teacher.id);

    let started = Date.now();
    const book = await getPdf(gradebookUrl(classId));
    const bookMs = Date.now() - started;
    started = Date.now();
    const all = await getPdf(allStudentsUrl(classId));
    const allMs = Date.now() - started;
    started = Date.now();
    await getPdf(assignmentUrl(db.get<{ id: number }>('SELECT id FROM assignments WHERE class_id = ?', classId)!.id));
    const assignmentMs = Date.now() - started;

    assert.ok(bookMs < 5000, `gradebook took ${bookMs} ms`);
    assert.ok(allMs < 5000, `all students took ${allMs} ms`);
    assert.ok(assignmentMs < 5000, `assignment report took ${assignmentMs} ms`);

    const bookText = pdfText(book.body);
    includesAll(bookText, ['Assignments 1–10 of 30', 'Assignments 21–30 of 30', 'Points (graded work)']);
    includesAll(bookText, studentNames);
    const pages = pdfPages(all.body);
    assert.ok(pages.length >= 40, `${pages.length} pages`);
    for (const name of studentNames) assert.ok(pages.some((page) => page.split('\n')[0] === name), name);
  });
});
