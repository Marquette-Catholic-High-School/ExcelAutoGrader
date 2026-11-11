import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import type {
  AddStudentsResponse,
  ClassNotificationSettings,
  EmailLogEntry,
  EmailStatus,
  MyNotificationSettings,
} from '../../../shared/types.js';
import { captureConsole, TEST_TOKEN, useMemoryEmail, type OutboxRow } from '../services/email/testing.js';
import {
  apiError,
  createAssignment,
  expectOk,
  HALF,
  inDays,
  PERFECT,
  setupClass,
  submit,
  submitRequest,
  type ClassFixture,
} from '../services/test-fixtures.js';
import { startTestServer, type TestServer } from '../test-utils.js';

useMemoryEmail('America/Chicago');

let srv: TestServer;
let fx: ClassFixture;
let db: typeof import('../db.js');
let mailer: typeof import('../services/email/mailer.js');
let outbox: typeof import('../services/email/outbox.js');

before(async () => {
  srv = await startTestServer();
  db = await import('../db.js');
  mailer = await import('../services/email/mailer.js');
  outbox = await import('../services/email/outbox.js');
  fx = await setupClass(srv, ['Ana Lopez', 'Ben Carter'], 'Business Computing 101');
});

after(() => srv.close());

afterEach(() => {
  process.env.CLOUDFLARE_API_TOKEN = TEST_TOKEN;
  delete process.env.REQUIRE_CODE_FOR_INVITES;
  mailer.memoryMailbox.reset();
});

const ana = () => fx.students[0];
const ben = () => fx.students[1];

const rows = (where = '1 = 1', ...params: (string | number)[]) =>
  db.all<OutboxRow>(`SELECT * FROM email_outbox WHERE ${where} ORDER BY id`, ...params);
const receiptsFor = (submissionId: number) => rows("kind = 'receipt' AND submission_id = ?", submissionId);
const classSettingsUrl = (classId: number) => `/api/classes/${classId}/notifications`;

function putClassSettings(body: unknown, classId = fx.classId, token = fx.teacher.token) {
  return srv.request<ClassNotificationSettings>('PUT', classSettingsUrl(classId), { token, json: body });
}

async function inviteStudent(email: string, name = '') {
  const res = await srv.request<AddStudentsResponse>('POST', `/api/classes/${fx.classId}/students`, {
    token: fx.teacher.token,
    json: { students: [{ name, email }] },
  });
  return expectOk(res, 'invite').added[0].student;
}

function joinCode(classId = fx.classId): string {
  return db.get<{ join_code: string }>('SELECT join_code FROM classes WHERE id = ?', classId)!.join_code;
}

/* ------------------------------------------------------------------ */
/* Receipts                                                           */
/* ------------------------------------------------------------------ */

describe('submission receipts', () => {
  test('a student upload queues a receipt with the attempt, time, score and a link', async () => {
    const a = await createAssignment(srv, fx, { title: 'Monthly Budget', points: 20 });
    await submit(srv, ana().token, a.id, HALF);
    const sub = await submit(srv, ana().token, a.id, PERFECT);
    const [receipt] = receiptsFor(sub.id);
    assert.ok(receipt, 'queued');
    assert.equal(receipt.state, 'queued');
    assert.equal(receipt.to_address, ana().email);
    assert.equal(receipt.to_name, 'Ana Lopez');
    assert.equal(receipt.user_id, ana().id);
    assert.equal(receipt.class_id, fx.classId);
    assert.equal(receipt.assignment_id, a.id);
    assert.equal(receipt.subject, 'Received: Monthly Budget — Business Computing 101');
    assert.match(receipt.text, /Attempt: #2/);
    assert.match(receipt.text, /Uploaded by: You/);
    assert.match(receipt.text, /because you turned in work in Business Computing 101/);
    assert.match(receipt.text, /On time\?: Yes/);
    assert.match(receipt.text, /Autograde score: 20 \/ 20 \(100%\)/);
    assert.match(receipt.text, /Submitted: \w{3}, \w{3} \d+, \d+:\d\d [AP]M C[SD]T/);
    assert.match(receipt.text, /File: work\.xlsx/);
    assert.ok(receipt.text.includes(`https://excel.school.test/student/assignments/${a.id}`));
    assert.ok(receipt.html.includes(`href="https://excel.school.test/student/assignments/${a.id}"`));
    assert.match(receipt.text, /turn these emails off on your Account page \(https:\/\/excel\.school\.test\/account\)/);
    assert.doesNotMatch(receipt.text, /sign up/i, 'no sign-up steps for a signed-up student');

    await outbox.processOutboxOnce({ gapMs: 0 });
    const sent = mailer.memoryMailbox.messages.find((m) => m.subject === receipt.subject);
    assert.ok(sent, 'delivered by the worker');
    assert.equal(sent.from, `"Podner's Excel" <noreply@mchstech.org>`);
    assert.match(sent.raw, /Content-Type: text\/plain/);
    assert.match(sent.raw, /Content-Type: text\/html/);
  });

  test('a teacher upload on behalf of a student says who uploaded it; late work says how late', async () => {
    const a = await createAssignment(srv, fx, { title: 'Past due', dueAt: inDays(-2) });
    const sub = expectOk(await submitRequest(srv, fx.teacher.token, a.id, PERFECT, { studentId: ben().id }), 'upload');
    const [receipt] = receiptsFor(sub.id);
    assert.equal(receipt.to_address, ben().email);
    assert.equal(receipt.subject, 'Received (late): Past due — Business Computing 101');
    assert.match(receipt.text, /your teacher Ms\. Rivera uploaded a file for Past due/);
    assert.match(receipt.text, /Uploaded by: Ms\. Rivera \(teacher\)/);
    assert.match(receipt.text, /because work was turned in for you in Business Computing 101/);
    assert.match(receipt.text, /LATE: submitted 2 days after the due date\./);
    assert.match(receipt.text, /On time\?: LATE \(2 days late\)/);
  });

  test('manual grading or an autograde error: the teacher will grade it', async () => {
    const a = await createAssignment(srv, fx, { title: 'Essay', gradingMode: 'manual', key: undefined });
    const sub = await submit(srv, ana().token, a.id, PERFECT);
    const [receipt] = receiptsFor(sub.id);
    assert.match(receipt.text, /Score: Your teacher will grade this file\./);
    assert.doesNotMatch(receipt.text, /Autograde score/);
  });

  test('user content is escaped in the HTML part', async () => {
    const a = await createAssignment(srv, fx, { title: 'Totals <script>alert("x")</script> & more' });
    const sub = await submit(srv, ana().token, a.id, PERFECT);
    const [receipt] = receiptsFor(sub.id);
    assert.ok(!receipt.html.includes('<script>'), 'no raw tag');
    assert.ok(receipt.html.includes('Totals &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; more'));
    assert.ok(receipt.text.includes('Totals <script>alert("x")</script> & more'), 'text part is plain');
  });

  test('an invited student who has not signed up gets sign-up steps with the class code', async () => {
    const pat = await inviteStudent('pat.jones@school.test');
    const a = await createAssignment(srv, fx, { title: 'For Pat' });
    const sub = expectOk(await submitRequest(srv, fx.teacher.token, a.id, PERFECT, { studentId: pat.id }), 'upload');
    const [receipt] = receiptsFor(sub.id);
    assert.equal(receipt.to_address, 'pat.jones@school.test');
    assert.match(receipt.text, /Hi Pat,/);
    assert.ok(receipt.text.includes('Go to https://excel.school.test/register?role=student'));
    assert.match(receipt.text, /sign up with this email address: pat\.jones@school\.test/);
    assert.ok(receipt.text.includes(`enter ${joinCode()}.`), 'class code');
    const unsubscribe = /Didn't expect this email\? Unsubscribe \(https:\/\/excel\.school\.test\/api\/email\/unsubscribe\//;
    assert.match(receipt.text, unsubscribe);
    assert.match(receipt.text, /After you sign up, you can also turn them off on your Account page/);
    assert.doesNotMatch(receipt.text, /Open the assignment/);

    process.env.REQUIRE_CODE_FOR_INVITES = 'off';
    const again = expectOk(await submitRequest(srv, fx.teacher.token, a.id, HALF, { studentId: pat.id }), 'again');
    const [second] = receiptsFor(again.id);
    assert.match(second.text, /sign up with this email address/);
    assert.ok(!second.text.includes(joinCode()), 'no code when REQUIRE_CODE_FOR_INVITES is off');
  });

  test('no receipt when the student opted out, receipts are off, or pending students are left out', async () => {
    const a = await createAssignment(srv, fx, { title: 'Quiet' });
    expectOk(
      await srv.request('PUT', '/api/me/notifications', { token: ben().token, json: { emailOptOut: true } }),
      'opt out',
    );
    const optedOut = await submit(srv, ben().token, a.id, PERFECT);
    assert.equal(receiptsFor(optedOut.id).length, 0, 'opted out');
    expectOk(
      await srv.request('PUT', '/api/me/notifications', { token: ben().token, json: { emailOptOut: false } }),
      'opt in',
    );

    const pending = await inviteStudent('quinn@school.test', 'Quinn Park');
    expectOk(await putClassSettings({ includePendingStudents: false }), 'exclude pending');
    const forPending = expectOk(
      await submitRequest(srv, fx.teacher.token, a.id, PERFECT, { studentId: pending.id }),
      'pending upload',
    );
    assert.equal(receiptsFor(forPending.id).length, 0, 'pending excluded');

    expectOk(await putClassSettings({ submissionReceipts: false, includePendingStudents: true }), 'receipts off');
    const off = await submit(srv, ana().token, a.id, PERFECT);
    assert.equal(receiptsFor(off.id).length, 0, 'class setting off');
    expectOk(await putClassSettings({ submissionReceipts: true }), 'receipts on');
    const on = await submit(srv, ana().token, a.id, PERFECT);
    assert.equal(receiptsFor(on.id).length, 1, 'back on');
  });

  test('without an API token nothing is queued and uploads still work', async () => {
    delete process.env.CLOUDFLARE_API_TOKEN;
    const a = await createAssignment(srv, fx, { title: 'No email' });
    const before = rows().length;
    const sub = await submit(srv, ana().token, a.id, PERFECT);
    assert.equal(sub.attempt, 1);
    assert.equal(rows().length, before);
  });
});

/* ------------------------------------------------------------------ */
/* Endpoints                                                          */
/* ------------------------------------------------------------------ */

describe('GET /api/email/status', () => {
  test('reports the sender, time zone and links but never the token', async () => {
    const res = await srv.request<EmailStatus>('GET', '/api/email/status', { token: ana().token });
    assert.deepEqual(expectOk(res, 'status'), {
      configured: true,
      fromName: "Podner's Excel",
      fromAddress: 'noreply@mchstech.org',
      timeZone: 'America/Chicago',
      appUrl: 'https://excel.school.test',
    });
    assert.ok(!JSON.stringify(res.body).includes(TEST_TOKEN));

    delete process.env.CLOUDFLARE_API_TOKEN;
    const off = await srv.request<EmailStatus>('GET', '/api/email/status', { token: fx.teacher.token });
    assert.equal(expectOk(off, 'off').configured, false);
    assert.equal((await srv.request('GET', '/api/email/status')).status, 401);
  });

  test('an unknown TIME_ZONE falls back to the computer zone; a missing APP_URL is null', async () => {
    const saved = { zone: process.env.TIME_ZONE, url: process.env.APP_URL };
    process.env.TIME_ZONE = 'Mars/Olympus_Mons';
    delete process.env.APP_URL;
    try {
      const { result } = await captureConsole(() =>
        srv.request<EmailStatus>('GET', '/api/email/status', { token: fx.teacher.token }),
      );
      const status = expectOk(result, 'status');
      assert.equal(status.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
      assert.equal(status.appUrl, null);
    } finally {
      process.env.TIME_ZONE = saved.zone;
      process.env.APP_URL = saved.url;
    }
  });
});

describe('class notification settings', () => {
  test('defaults, partial updates and validation', async () => {
    const own = await setupClass(srv, ['Cara Diaz'], 'Settings class');
    const url = classSettingsUrl(own.classId);
    const created = db.get<{ created_at: string }>('SELECT created_at FROM classes WHERE id = ?', own.classId)!;
    const read = async (label: string) =>
      expectOk(await srv.request<ClassNotificationSettings>('GET', url, { token: own.teacher.token }), label);
    const initial = await read('get');
    assert.deepEqual(initial, {
      submissionReceipts: true,
      overdueReminders: true,
      firstReminderAfterHours: 12,
      reminderIntervalDays: 2,
      maxReminders: 3,
      includePendingStudents: true,
      remindersSince: created.created_at,
    });

    const updated = expectOk(
      await putClassSettings(
        { maxReminders: 5, firstReminderAfterHours: 0, remindersSince: '2000-01-01T00:00:00.000Z' },
        own.classId,
        own.teacher.token,
      ),
      'put',
    );
    assert.equal(updated.maxReminders, 5);
    assert.equal(updated.firstReminderAfterHours, 0);
    assert.equal(updated.reminderIntervalDays, 2, 'untouched');
    assert.equal(updated.remindersSince, created.created_at, 'remindersSince is read-only');
    assert.deepEqual(await read('reread'), updated);

    const bad = await putClassSettings(
      { firstReminderAfterHours: 169, reminderIntervalDays: 0, maxReminders: 2.5, submissionReceipts: 'yes' },
      own.classId,
      own.teacher.token,
    );
    assert.equal(bad.status, 400);
    assert.deepEqual(Object.keys(apiError(bad).fields).sort(), [
      'firstReminderAfterHours',
      'maxReminders',
      'reminderIntervalDays',
      'submissionReceipts',
    ]);
    assert.match(apiError(bad).fields.firstReminderAfterHours, /0 to 168/);
    assert.deepEqual(await read('after 400'), updated, 'nothing saved on a 400');
  });

  test('turning reminders back on starts a new reminder period', async () => {
    const own = await setupClass(srv, [], 'Toggle class');
    const before = expectOk(await putClassSettings({ overdueReminders: false }, own.classId, own.teacher.token), 'off');
    const on = expectOk(await putClassSettings({ overdueReminders: true }, own.classId, own.teacher.token), 'on');
    assert.ok(on.remindersSince > before.remindersSince, `${on.remindersSince} > ${before.remindersSince}`);
    const again = expectOk(await putClassSettings({ maxReminders: 4 }, own.classId, own.teacher.token), 'other change');
    assert.equal(again.remindersSince, on.remindersSince);
  });

  test('only the class teacher may read or change them', async () => {
    const other = await setupClass(srv, [], 'Other class');
    const url = classSettingsUrl(fx.classId);
    const json = { maxReminders: 1 };
    assert.equal((await srv.request('GET', url, { token: other.teacher.token })).status, 403);
    assert.equal((await srv.request('PUT', url, { token: other.teacher.token, json })).status, 403);
    assert.equal((await srv.request('GET', url, { token: ana().token })).status, 403);
    assert.equal((await srv.request('PUT', url, { token: ana().token, json })).status, 403);
    assert.equal((await srv.request('GET', url)).status, 401);
    assert.equal((await srv.request('GET', classSettingsUrl(999_999), { token: fx.teacher.token })).status, 404);
  });
});

describe('class email log', () => {
  test('lists the class emails newest first with the assignment title, and checks the limit', async () => {
    const own = await setupClass(srv, ['Dee Moss'], 'Log class');
    const a = await createAssignment(srv, own, { title: 'Logged work' });
    await submit(srv, own.students[0].token, a.id, PERFECT);
    await submit(srv, own.students[0].token, a.id, HALF);
    const url = `/api/classes/${own.classId}/emails`;
    const log = expectOk(await srv.request<EmailLogEntry[]>('GET', url, { token: own.teacher.token }), 'log');
    assert.equal(log.length, 2);
    assert.ok(log[0].id > log[1].id, 'newest first');
    assert.deepEqual(
      { ...log[0], id: 0, createdAt: '' },
      {
        id: 0,
        kind: 'receipt',
        toName: 'Dee Moss',
        toAddress: own.students[0].email,
        subject: 'Received: Logged work — Log class',
        state: 'queued',
        attempts: 0,
        error: null,
        assignmentId: a.id,
        assignmentTitle: 'Logged work',
        createdAt: '',
        sentAt: null,
      },
    );
    const withLimit = async (limit: string) =>
      expectOk(await srv.request<EmailLogEntry[]>('GET', `${url}?limit=${limit}`, { token: own.teacher.token }), limit);
    assert.deepEqual(
      (await withLimit('1')).map((e) => e.id),
      [log[0].id],
    );
    assert.equal((await withLimit('9999')).length, 2, 'clamped to 500');
    assert.equal((await srv.request('GET', `${url}?limit=abc`, { token: own.teacher.token })).status, 400);
    assert.equal((await srv.request('GET', url, { token: fx.teacher.token })).status, 403);
    assert.equal((await srv.request('GET', url, { token: own.students[0].token })).status, 403);
  });
});

describe('personal settings', () => {
  const DEFAULTS = { emailOptOut: false, dailyReport: true, dailyReportTime: '07:00', skipEmptyReports: false };

  test('students turn emails off and on; teacher-only fields keep their defaults', async () => {
    const { token } = await srv.registerUser('student', 'Eli Fox');
    const get = await srv.request<MyNotificationSettings>('GET', '/api/me/notifications', { token });
    assert.deepEqual(expectOk(get, 'get'), DEFAULTS);
    const off = expectOk(
      await srv.request<MyNotificationSettings>('PUT', '/api/me/notifications', {
        token,
        json: { emailOptOut: true, dailyReport: false },
      }),
      'put',
    );
    assert.equal(off.emailOptOut, true);
    assert.equal(off.dailyReport, true, 'teachers only');
  });

  test('teachers set the daily report; times must be HH:MM', async () => {
    const { token } = await srv.registerUser('teacher', 'Mr. Grant');
    const put = (json: unknown) => srv.request<MyNotificationSettings>('PUT', '/api/me/notifications', { token, json });
    const saved = expectOk(await put({ dailyReport: false, dailyReportTime: '6:30', skipEmptyReports: true }), 'put');
    assert.deepEqual(saved, { ...DEFAULTS, dailyReport: false, dailyReportTime: '06:30', skipEmptyReports: true });
    assert.deepEqual(expectOk(await put({ emailOptOut: true }), 'ignored'), saved, 'ignored for teachers');

    const bad = await put({ dailyReportTime: '25:00', skipEmptyReports: 'yes' });
    assert.equal(bad.status, 400);
    assert.deepEqual(Object.keys(apiError(bad).fields).sort(), ['dailyReportTime', 'skipEmptyReports']);
    assert.equal((await put({ dailyReportTime: '7am' })).status, 400);
    assert.deepEqual(
      expectOk(await srv.request<MyNotificationSettings>('GET', '/api/me/notifications', { token }), 'get'),
      saved,
    );
    assert.equal((await srv.request('GET', '/api/me/notifications')).status, 401);
  });
});

describe('sending now', () => {
  test('POST /api/me/test-email sends to the teacher right away and logs it', async () => {
    const teacher = await srv.registerUser('teacher', 'Ms. Test');
    const res = await srv.request('POST', '/api/me/test-email', { token: teacher.token });
    assert.deepEqual(expectOk(res, 'test email'), { ok: true, to: teacher.user.email });
    const [message] = mailer.memoryMailbox.messages;
    assert.equal(message.to.address, teacher.user.email);
    assert.equal(message.subject, "Test email from Podner's Excel");
    assert.equal(message.from, `"Podner's Excel" <noreply@mchstech.org>`);
    const [logged] = rows("kind = 'test' AND user_id = ?", teacher.user.id);
    assert.equal(logged.state, 'sent');
    assert.equal(logged.class_id, null);
    assert.ok(logged.sent_at);

    assert.equal((await srv.request('POST', '/api/me/test-email', { token: ana().token })).status, 403);
  });

  test('503 when email is not configured, 502 with a helpful message when the mail server refuses', async () => {
    const teacher = await srv.registerUser('teacher', 'Ms. Fail');
    delete process.env.CLOUDFLARE_API_TOKEN;
    const off = await srv.request('POST', '/api/me/test-email', { token: teacher.token });
    assert.equal(off.status, 503);
    assert.match(apiError(off).error, /Cloudflare API token/);
    process.env.CLOUDFLARE_API_TOKEN = TEST_TOKEN;

    mailer.memoryMailbox.failNext({
      code: 'EAUTH',
      responseCode: 535,
      response: `535 5.7.8 Authentication failed (${TEST_TOKEN})`,
      command: 'AUTH PLAIN',
    });
    const { result: auth, output } = await captureConsole(() =>
      srv.request('POST', '/api/me/test-email', { token: teacher.token }),
    );
    assert.equal(auth.status, 502);
    assert.match(apiError(auth).error, /^Cloudflare rejected the API token \(check it has Email Sending: Edit\)\./);
    assert.match(apiError(auth).error, /535 5\.7\.8 Authentication failed/);
    assert.ok(!JSON.stringify(auth.body).includes(TEST_TOKEN), 'token not in the response');
    assert.ok(!output.includes(TEST_TOKEN), 'token not in the log');
    const [failed] = rows("kind = 'test' AND user_id = ? AND state = 'failed'", teacher.user.id);
    assert.ok(failed && !failed.last_error?.includes(TEST_TOKEN));

    mailer.memoryMailbox.failNext({ responseCode: 550, response: '550 5.7.1 Not onboarded', command: 'MAIL FROM' });
    const sender = await srv.request('POST', '/api/me/test-email', { token: teacher.token });
    assert.equal(sender.status, 502);
    assert.match(apiError(sender).error, /Cloudflare refused the sender address — is mchstech\.org onboarded/);
  });

  test('parallel requests cannot get past the limit (one on-demand send at a time per teacher)', async () => {
    const teacher = await srv.registerUser('teacher', 'Ms. Burst');
    const before = mailer.memoryMailbox.messages.length;
    const results = await Promise.all(
      Array.from({ length: 12 }, () => srv.request('POST', '/api/me/test-email', { token: teacher.token })),
    );
    const ok = results.filter((r) => r.status === 200).length;
    assert.ok(ok >= 1 && ok <= 5, `${ok} sent`);
    assert.ok(results.every((r) => r.status === 200 || r.status === 429));
    assert.equal(mailer.memoryMailbox.messages.length - before, ok, 'only the accepted ones were sent');
  });

  test('on-demand sends are limited to 5 in 10 minutes', async () => {
    const teacher = await srv.registerUser('teacher', 'Ms. Busy');
    const send = () => srv.request('POST', '/api/me/test-email', { token: teacher.token });
    for (let i = 0; i < 5; i++) expectOk(await send(), `send ${i}`);
    assert.equal((await send()).status, 429);
    assert.equal((await srv.request('POST', '/api/me/daily-report', { token: teacher.token })).status, 429);
  });

  test('POST /api/me/daily-report sends the report now and leaves the scheduled one alone', async () => {
    const a = await createAssignment(srv, fx, { title: 'Reported work', dueAt: inDays(3) });
    await submit(srv, ana().token, a.id, PERFECT);
    const res = await srv.request('POST', '/api/me/daily-report', { token: fx.teacher.token });
    assert.deepEqual(expectOk(res, 'report'), { ok: true, to: fx.teacher.email });
    const message = mailer.memoryMailbox.messages.at(-1)!;
    assert.match(message.subject, /^Daily report: \d+ new submissions? — /);
    assert.match(message.text, /Business Computing 101/);
    assert.match(message.text, /Ana Lopez · Reported work · .* · 100 \/ 100 \(100%\)/);
    assert.match(message.text, /Due in the next 7 days/);
    const teacher = db.get<{ daily_report_last_date: string | null }>(
      'SELECT daily_report_last_date FROM users WHERE id = ?',
      fx.teacher.id,
    )!;
    assert.equal(teacher.daily_report_last_date, null);
    const [logged] = rows("kind = 'daily_report' AND user_id = ?", fx.teacher.id);
    assert.equal(logged.state, 'sent');
    assert.equal(logged.class_id, null);

    assert.equal((await srv.request('POST', '/api/me/daily-report', { token: ana().token })).status, 403);
  });
});

/* ------------------------------------------------------------------ */
/* Unsubscribe                                                        */
/* ------------------------------------------------------------------ */

describe('unsubscribe link', () => {
  const linkIn = (text: string) => /https:\/\/excel\.school\.test(\/api\/email\/unsubscribe\/[\w-]+)/.exec(text)![1];

  async function sendQueued() {
    await captureConsole(() => outbox.processOutboxOnce({ gapMs: 0, limit: 50 }));
  }

  test('every receipt has one; opening it only asks, the button (or one-click POST) unsubscribes', async () => {
    const cy = await srv.registerUser('student', 'Cy Young');
    const joined = await srv.request('POST', '/api/classes/join', { token: cy.token, json: { joinCode: joinCode() } });
    expectOk(joined, 'join');
    const a = await createAssignment(srv, fx, { title: 'Unsubscribe me' });
    const first = await submit(srv, cy.token, a.id, PERFECT);
    const [receipt] = receiptsFor(first.id);
    assert.match(receipt.text, /turn these emails off on your Account page \(.*\), or unsubscribe \(https:/);
    const path = linkIn(receipt.text);
    assert.ok(receipt.html.includes(`href="https://excel.school.test${path}"`));

    await sendQueued();
    const sent = mailer.memoryMailbox.messages.find((m) => m.to.address === cy.user.email)!;
    assert.match(sent.raw, new RegExp(`^List-Unsubscribe:\\s+<https://excel\\.school\\.test${path}>\\r?\\n\\S`, 'm'));
    assert.match(sent.raw, /^List-Unsubscribe-Post: List-Unsubscribe=One-Click/m);

    const page = await srv.request('GET', path);
    assert.equal(page.status, 200);
    assert.match(page.body, /Stop these emails\?/);
    assert.ok(page.body.includes(`${cy.user.email[0]}***@example.test`), 'the address is masked');
    assert.ok(!page.body.includes(cy.user.email), 'not shown in full');
    assert.match(page.body, /<form method="post">/);
    const second = await submit(srv, cy.token, a.id, HALF);
    assert.equal(receiptsFor(second.id).length, 1, 'opening the link (e.g. a mail scanner) unsubscribes nobody');

    const done = await srv.request('POST', path);
    assert.equal(done.status, 200);
    assert.match(done.body, /You&#39;re unsubscribed/);
    await sendQueued();
    assert.equal(rows('id = ?', receiptsFor(second.id)[0]?.id ?? 0).length, 0, 'the queued receipt was dropped');
    const third = await submit(srv, cy.token, a.id, PERFECT);
    assert.equal(receiptsFor(third.id).length, 0, 'no more receipts');
    const mine = await srv.request<MyNotificationSettings>('GET', '/api/me/notifications', { token: cy.token });
    assert.equal(expectOk(mine, 'settings').emailOptOut, true, 'the Account page shows emails off');
    assert.match((await srv.request('GET', path)).body, /You&#39;re unsubscribed/);

    const on = await srv.request('PUT', '/api/me/notifications', { token: cy.token, json: { emailOptOut: false } });
    expectOk(on, 'emails back on');
    const fourth = await submit(srv, cy.token, a.id, HALF);
    assert.equal(receiptsFor(fourth.id).length, 1, 'turning emails back on works again');
  });

  test('an invited student who unsubscribed stays unsubscribed after being removed and invited again', async () => {
    const dee = await inviteStudent('dee.invited@school.test');
    const a = await createAssignment(srv, fx, { title: 'Invite flood' });
    const sub = expectOk(await submitRequest(srv, fx.teacher.token, a.id, PERFECT, { studentId: dee.id }), 'upload');
    const path = linkIn(receiptsFor(sub.id)[0].text);
    assert.equal((await srv.request('POST', path)).status, 200);

    const removed = await srv.request('DELETE', `/api/classes/${fx.classId}/students/${dee.id}`, {
      token: fx.teacher.token,
    });
    assert.ok(removed.status < 300, `remove: ${removed.status}`);
    const again = await inviteStudent('Dee.Invited+2@school.test');
    const next = expectOk(await submitRequest(srv, fx.teacher.token, a.id, HALF, { studentId: again.id }), 'again');
    assert.equal(receiptsFor(next.id).length, 0);
  });

  test('a made-up token shows an error page', async () => {
    const res = await srv.request('POST', '/api/email/unsubscribe/not-a-real-token-123');
    assert.equal(res.status, 404);
    assert.match(res.body, /This link is not valid/);
  });
});
