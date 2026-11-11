import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import type { AddStudentsResponse, AuthResponse } from '../../../../shared/types.js';
import {
  createAssignment,
  expectOk,
  HALF,
  PERFECT,
  setupClass,
  submit,
  submitRequest,
  type ClassFixture,
} from '../test-fixtures.js';
import { startTestServer, type TestServer } from '../../test-utils.js';
import {
  DAY_MS,
  HOUR_MS,
  localDateIn,
  TEST_TOKEN,
  useMemoryEmail,
  zonedInstant,
  type OutboxRow,
} from './testing.js';

const ZONE = 'America/Chicago';
useMemoryEmail(ZONE);

let srv: TestServer;
let db: typeof import('../../db.js');
let notifications: typeof import('./notifications.js');
let outbox: typeof import('./outbox.js');
let mailer: typeof import('./mailer.js');

before(async () => {
  srv = await startTestServer();
  db = await import('../../db.js');
  notifications = await import('./notifications.js');
  outbox = await import('./outbox.js');
  mailer = await import('./mailer.js');
});

after(() => srv.close());

afterEach(() => {
  db.run('DELETE FROM email_outbox');
  db.run('DELETE FROM email_quota');
  db.run('DELETE FROM app_state');
  mailer.memoryMailbox.reset();
  process.env.CLOUDFLARE_API_TOKEN = TEST_TOKEN;
  process.env.TIME_ZONE = ZONE;
});

const MINUTE = 60_000;
const later = (from: Date, ms: number) => new Date(from.getTime() + ms);
const runAt = (now: Date) => notifications.runSchedulerOnce(now);

const outboxRows = (where: string, id: number) =>
  db.all<OutboxRow>(`SELECT * FROM email_outbox WHERE ${where} ORDER BY id`, id);
const reminders = (assignmentId: number) => outboxRows("kind = 'overdue' AND assignment_id = ?", assignmentId);
const reports = (teacherId: number) => outboxRows("kind = 'daily_report' AND user_id = ?", teacherId);

function putMySettings(token: string, json: unknown) {
  return srv.request('PUT', '/api/me/notifications', { token, json });
}

function putClassSettings(fx: ClassFixture, json: unknown) {
  return srv.request('PUT', `/api/classes/${fx.classId}/notifications`, { token: fx.teacher.token, json });
}

async function invite(fx: ClassFixture, email: string) {
  const res = await srv.request<AddStudentsResponse>('POST', `/api/classes/${fx.classId}/students`, {
    token: fx.teacher.token,
    json: { students: [{ name: '', email }] },
  });
  return expectOk(res, 'invite').added[0].student;
}

/** An autograded assignment due an hour from now (after the class was created, so reminders apply). */
async function dueSoon(fx: ClassFixture, title: string) {
  const dueAt = new Date(Date.now() + HOUR_MS);
  const assignment = await createAssignment(srv, fx, { title, dueAt: dueAt.toISOString() });
  return { assignment, dueAt };
}

/* ------------------------------------------------------------------ */
/* Overdue reminders                                                  */
/* ------------------------------------------------------------------ */

describe('overdue reminders', () => {
  test('after the first delay, every interval, up to the maximum, to students who have not submitted', async () => {
    const fx = await setupClass(srv, ['Ana Lopez', 'Ben Carter', 'Cy Young'], 'Business Computing 101');
    const [ana, ben, cy] = fx.students;
    const pat = await invite(fx, 'pat.jones@school.test');
    const { assignment: a, dueAt } = await dueSoon(fx, 'Loan Calculator');
    await submit(srv, cy.token, a.id, PERFECT);
    expectOk(await putMySettings(ben.token, { emailOptOut: true }), 'opt out');

    runAt(later(dueAt, 12 * HOUR_MS - MINUTE));
    assert.equal(reminders(a.id).length, 0, 'not before firstReminderAfterHours (12)');

    const first = later(dueAt, 12 * HOUR_MS);
    runAt(first);
    const round1 = reminders(a.id);
    assert.deepEqual(
      round1.map((r) => r.to_address).sort(),
      [ana.email, 'pat.jones@school.test'].sort(),
      'not Cy (submitted) or Ben (opted out)',
    );
    assert.ok(round1.every((r) => r.class_id === fx.classId && r.state === 'queued'));

    const anaReminder = round1.find((r) => r.user_id === ana.id)!;
    assert.equal(anaReminder.subject, 'Reminder: Loan Calculator is overdue — Business Computing 101');
    assert.match(anaReminder.text, /was due .* \(12 hours ago\), and nothing has been turned in yet/);
    assert.match(anaReminder.text, /Late work is still accepted/);
    assert.match(anaReminder.text, /reminder 1 of at most 3/);
    assert.ok(anaReminder.text.includes(`https://excel.school.test/student/assignments/${a.id}`));
    assert.match(anaReminder.text, /turn these emails off on your Account page/);

    const patReminder = round1.find((r) => r.user_id === pat.id)!;
    assert.match(patReminder.text, /sign up with this email address: pat\.jones@school\.test/);
    const code = db.get<{ join_code: string }>('SELECT join_code FROM classes WHERE id = ?', fx.classId)!.join_code;
    assert.ok(patReminder.text.includes(code), 'class code for the pending student');

    runAt(first);
    runAt(later(first, 5 * MINUTE));
    assert.equal(reminders(a.id).length, 2, 'no duplicates from repeated runs');

    runAt(later(first, 2 * DAY_MS - MINUTE));
    assert.equal(reminders(a.id).length, 2, 'not before reminderIntervalDays (2)');
    runAt(later(first, 2 * DAY_MS));
    assert.equal(reminders(a.id).length, 4, 'second round');
    assert.match(reminders(a.id).at(-1)!.text, /reminder 2 of at most 3/);
    runAt(later(first, 4 * DAY_MS));
    assert.equal(reminders(a.id).length, 6, 'third round');
    runAt(later(first, 6 * DAY_MS));
    runAt(later(first, 30 * DAY_MS));
    assert.equal(reminders(a.id).length, 6, 'never more than maxReminders (3)');
  });

  test('stop as soon as the student submits, also for a reminder still in the queue', async () => {
    const fx = await setupClass(srv, ['Dana Wu'], 'Accounting');
    const { assignment: a, dueAt } = await dueSoon(fx, 'Ledger');
    const first = later(dueAt, 12 * HOUR_MS);
    runAt(first);
    assert.equal(reminders(a.id).length, 1);

    await submit(srv, fx.students[0].token, a.id, HALF);
    const result = await outbox.processOutboxOnce({ now: () => later(first, MINUTE), gapMs: 0 });
    assert.equal(result.dropped, 1, 'the queued reminder is dropped, not sent');
    const toDana = mailer.memoryMailbox.messages.filter((m) => m.to.address === fx.students[0].email);
    assert.deepEqual(
      toDana.map((m) => m.subject),
      ['Received: Ledger — Accounting'],
      'only the receipt',
    );

    runAt(later(first, 2 * DAY_MS));
    runAt(later(first, 4 * DAY_MS));
    assert.equal(reminders(a.id).length, 0);
  });

  test('class settings: first delay, maximum, pending students, remindersSince, late joiners, off', async () => {
    const fx = await setupClass(srv, ['Eve Stone', 'Finn Hale'], 'Settings 101');
    const [eve, finn] = fx.students;
    await invite(fx, 'gus.invited@school.test');
    expectOk(
      await putClassSettings(fx, { firstReminderAfterHours: 0, maxReminders: 1, includePendingStudents: false }),
      'settings',
    );

    const yesterday = new Date(Date.now() - DAY_MS).toISOString();
    const old = await createAssignment(srv, fx, { title: 'Before the class', dueAt: yesterday });
    const { assignment: a, dueAt } = await dueSoon(fx, 'Budget');
    // Finn joined after this assignment was due: no reminders about it.
    db.run(
      'UPDATE enrollments SET joined_at = ? WHERE class_id = ? AND student_id = ?',
      later(dueAt, MINUTE).toISOString(),
      fx.classId,
      finn.id,
    );

    runAt(later(dueAt, MINUTE));
    assert.deepEqual(
      reminders(a.id).map((r) => r.user_id),
      [eve.id],
      'right after the due date; not the pending student or the late joiner',
    );
    assert.equal(reminders(old.id).length, 0, 'due before remindersSince');
    runAt(later(dueAt, 10 * DAY_MS));
    assert.equal(reminders(a.id).length, 1, 'maxReminders = 1');

    const { assignment: b, dueAt: bDue } = await dueSoon(fx, 'Payroll');
    db.run('UPDATE classes SET reminders_since = ? WHERE id = ?', later(bDue, MINUTE).toISOString(), fx.classId);
    runAt(later(bDue, HOUR_MS));
    assert.equal(reminders(b.id).length, 0, 'due before remindersSince');

    const { assignment: c, dueAt: cDue } = await dueSoon(fx, 'Inventory');
    db.run('UPDATE classes SET reminders_since = NULL WHERE id = ?', fx.classId);
    expectOk(await putClassSettings(fx, { overdueReminders: false }), 'off');
    runAt(later(cDue, HOUR_MS));
    assert.equal(reminders(c.id).length, 0, 'reminders off');
  });

  test('turning email on weeks later does not remind students about work due while it was off', async () => {
    const fx = await setupClass(srv, ['Lee Park'], 'Turned on later');
    const { assignment: old, dueAt } = await dueSoon(fx, 'While email was off');
    delete process.env.CLOUDFLARE_API_TOKEN;
    runAt(later(dueAt, DAY_MS));
    process.env.CLOUDFLARE_API_TOKEN = TEST_TOKEN;
    const on = later(dueAt, 21 * DAY_MS);
    runAt(on);
    runAt(later(on, 3 * DAY_MS));
    assert.equal(reminders(old.id).length, 0, 'due before email was turned on');

    const fresh = await createAssignment(srv, fx, { title: 'After', dueAt: later(on, HOUR_MS).toISOString() });
    runAt(later(on, 13 * HOUR_MS));
    assert.equal(reminders(fresh.id).length, 1, 'work due after that is reminded about as usual');
  });

  test('a queued reminder is dropped when the invited student is removed or reminders are turned off', async () => {
    const fx = await setupClass(srv, ['Mo Reyes'], 'Dropped');
    const kit = await invite(fx, 'kit.invited@school.test');
    const { assignment: a, dueAt } = await dueSoon(fx, 'Budget');
    const first = later(dueAt, 12 * HOUR_MS);
    runAt(first);
    assert.equal(reminders(a.id).length, 2);

    const removed = await srv.request('DELETE', `/api/classes/${fx.classId}/students/${kit.id}`, {
      token: fx.teacher.token,
    });
    assert.ok(removed.status < 300, `remove: ${removed.status}`);
    await outbox.processOutboxOnce({ now: () => later(first, MINUTE), gapMs: 0, limit: 100 });
    assert.deepEqual(
      reminders(a.id).map((r) => [r.to_address, r.state]),
      [[fx.students[0].email, 'sent']],
      'Mo gets his; the removed invitee gets nothing',
    );
    assert.ok(!mailer.memoryMailbox.messages.some((m) => m.to.address === 'kit.invited@school.test'));

    const second = later(first, 2 * DAY_MS);
    runAt(second);
    assert.equal(reminders(a.id).filter((r) => r.state === 'queued').length, 1);
    expectOk(await putClassSettings(fx, { overdueReminders: false }), 'off');
    await outbox.processOutboxOnce({ now: () => later(second, MINUTE), gapMs: 0, limit: 100 });
    assert.deepEqual(
      reminders(a.id).map((r) => r.state),
      ['sent'],
      'reminders off: the queued one is dropped, not sent',
    );
  });

  test('nothing happens while email is not configured', async () => {
    const fx = await setupClass(srv, ['Hal Ito'], 'No email');
    const { assignment: a, dueAt } = await dueSoon(fx, 'Quiet');
    delete process.env.CLOUDFLARE_API_TOKEN;
    assert.deepEqual(runAt(later(dueAt, DAY_MS)), { reminders: 0, reports: 0 });
    assert.equal(reminders(a.id).length, 0);
  });
});

/* ------------------------------------------------------------------ */
/* Daily report                                                       */
/* ------------------------------------------------------------------ */

const lastReport = (teacherId: number) =>
  db.get<{ daily_report_last_date: string | null; daily_report_last_at: string | null }>(
    'SELECT daily_report_last_date, daily_report_last_at FROM users WHERE id = ?',
    teacherId,
  )!;

function setSubmittedAt(submissionId: number, at: Date) {
  db.run('UPDATE submissions SET submitted_at = ? WHERE id = ?', at.toISOString(), submissionId);
}

describe('daily report', () => {
  test('once per local day at the teacher time, catching up once when the server was off', async () => {
    const fx = await setupClass(srv, ['Ana Lopez', 'Ben Carter'], 'Business Computing 101');
    const [ana, ben] = fx.students;
    const day1 = localDateIn(2, ZONE);
    const day2 = localDateIn(3, ZONE);
    const { assignment: budget } = await dueSoon(fx, 'Monthly Budget');
    const loan = await createAssignment(srv, fx, {
      title: 'Loan Calculator',
      dueAt: zonedInstant(localDateIn(4, ZONE), '23:59', ZONE).toISOString(),
    });
    const sub = await submit(srv, ana.token, budget.id, PERFECT);
    setSubmittedAt(sub.id, zonedInstant(day1, '06:00', ZONE));

    runAt(zonedInstant(day1, '06:59', ZONE));
    assert.equal(reports(fx.teacher.id).length, 0, 'not before 07:00');

    const seven = zonedInstant(day1, '07:00', ZONE);
    assert.equal(runAt(seven).reports >= 1, true);
    const [report] = reports(fx.teacher.id);
    assert.equal(report.to_address, fx.teacher.email);
    assert.equal(report.class_id, null);
    assert.match(report.subject, /^Daily report: 1 new submission — \w{3}, \w{3} \d+$/);
    assert.match(report.text, /Business Computing 101/);
    assert.match(report.text, /Ana Lopez · Monthly Budget · .*6:00 AM C[SD]T · 100 \/ 100 \(100%\) · LATE/);
    assert.match(report.text, /Due in the next 7 days\n\n- Loan Calculator \(.*\) — due .* — 0 of 2 submitted/);
    assert.match(report.text, /Overdue, still missing\n\n- Monthly Budget \(.*\) — due .* — missing \(1\): Ben/);
    assert.ok(report.html.includes(`href="https://excel.school.test/teacher/assignments/${loan.id}"`));
    assert.deepEqual(
      { ...lastReport(fx.teacher.id) },
      { daily_report_last_date: day1, daily_report_last_at: seven.toISOString() },
    );

    runAt(later(seven, 5 * MINUTE));
    runAt(zonedInstant(day1, '23:59', ZONE));
    assert.equal(reports(fx.teacher.id).length, 1, 'once that day');

    const next = await submit(srv, ben.token, budget.id, HALF);
    setSubmittedAt(next.id, zonedInstant(day2, '05:00', ZONE));
    runAt(zonedInstant(day2, '06:00', ZONE));
    assert.equal(reports(fx.teacher.id).length, 1, 'not before 07:00 on day 2');
    runAt(zonedInstant(day2, '10:00', ZONE));
    runAt(zonedInstant(day2, '11:00', ZONE));
    const second = reports(fx.teacher.id);
    assert.equal(second.length, 2, 'caught up once at 10:00 (server was off at 07:00), not again');
    assert.match(second[1].text, /Ben Carter · Monthly Budget/);
    assert.doesNotMatch(second[1].text, /Ana Lopez · Monthly Budget/, 'only what came after the last report');
    assert.match(second[1].text, /1 new submission since .*7:00 AM/);
  });

  test('skipEmptyReports skips days without new submissions; dailyReport off sends nothing', async () => {
    const quiet = await setupClass(srv, ['Ivy Lane'], 'Quiet class');
    const off = await setupClass(srv, ['Jon Park'], 'Off class');
    expectOk(await putMySettings(quiet.teacher.token, { skipEmptyReports: true }), 'skip empty');
    expectOk(await putMySettings(off.teacher.token, { dailyReport: false }), 'off');
    const day1 = localDateIn(2, ZONE);
    const day2 = localDateIn(3, ZONE);

    const skippedAt = zonedInstant(day1, '07:30', ZONE);
    runAt(skippedAt);
    assert.equal(reports(quiet.teacher.id).length, 0, 'nothing new: skipped');
    assert.deepEqual(
      { ...lastReport(quiet.teacher.id) },
      { daily_report_last_date: day1, daily_report_last_at: skippedAt.toISOString() },
      'the day still counts as done, and the next report starts there',
    );
    assert.equal(reports(off.teacher.id).length, 0);

    const a = await createAssignment(srv, quiet, { title: 'Late night' });
    const sub = await submit(srv, quiet.students[0].token, a.id, PERFECT);
    setSubmittedAt(sub.id, zonedInstant(day1, '20:00', ZONE));
    runAt(zonedInstant(day1, '21:00', ZONE));
    assert.equal(reports(quiet.teacher.id).length, 0, 'not later the same day');
    runAt(zonedInstant(day2, '07:00', ZONE));
    assert.equal(reports(quiet.teacher.id).length, 1, 'the next day there is something to report');
    assert.match(reports(quiet.teacher.id)[0].text, /Ivy Lane · Late night/);
    assert.equal(reports(off.teacher.id).length, 0);
  });

  test('a skipped first report leaves no gap: work right after it is in the next one', async () => {
    const fx = await setupClass(srv, ['Pia Lund'], 'No gap');
    expectOk(await putMySettings(fx.teacher.token, { skipEmptyReports: true }), 'skip empty');
    const day1 = localDateIn(2, ZONE);
    const day2 = localDateIn(3, ZONE);
    runAt(zonedInstant(day1, '07:00', ZONE));
    const a = await createAssignment(srv, fx, { title: 'Just after' });
    const sub = await submit(srv, fx.students[0].token, a.id, PERFECT);
    setSubmittedAt(sub.id, zonedInstant(day1, '07:02', ZONE));
    runAt(zonedInstant(day2, '07:04', ZONE));
    assert.match(reports(fx.teacher.id)[0]?.text ?? '', /Pia Lund · Just after/);
  });

  test('an upload still arriving when a report is made is in the next report', async () => {
    const fx = await setupClass(srv, ['Rex Hall'], 'Slow upload');
    const day1 = localDateIn(2, ZONE);
    const day2 = localDateIn(3, ZONE);
    runAt(zonedInstant(day1, '07:00', ZONE));
    assert.doesNotMatch(reports(fx.teacher.id)[0].text, /Rex Hall/);
    // submitted_at is when the upload started (06:59), but the row was saved after the 07:00 report.
    const a = await createAssignment(srv, fx, { title: 'Big file' });
    const sub = await submit(srv, fx.students[0].token, a.id, PERFECT);
    setSubmittedAt(sub.id, zonedInstant(day1, '06:59', ZONE));
    runAt(zonedInstant(day2, '07:00', ZONE));
    const second = reports(fx.teacher.id)[1];
    assert.match(second.text, /Rex Hall · Big file/);
    assert.match(second.text, /1 new submission since/);
  });

  test('the time is local to TIME_ZONE', async () => {
    process.env.TIME_ZONE = 'Asia/Tokyo';
    const fx = await setupClass(srv, [], 'Tokyo class');
    expectOk(await putMySettings(fx.teacher.token, { dailyReportTime: '06:15' }), 'time');
    const day = localDateIn(2, 'Asia/Tokyo');
    runAt(zonedInstant(day, '06:14', 'Asia/Tokyo'));
    assert.equal(reports(fx.teacher.id).length, 0);
    runAt(zonedInstant(day, '06:15', 'Asia/Tokyo'));
    assert.equal(reports(fx.teacher.id).length, 1);
    assert.equal(lastReport(fx.teacher.id).daily_report_last_date, day);
    assert.match(reports(fx.teacher.id)[0].text, /No new submissions/);
  });

  test('a teacher who signed up today gets the first report tomorrow', async () => {
    const fx = await setupClass(srv, [], 'Brand new');
    expectOk(await putMySettings(fx.teacher.token, { dailyReportTime: '00:00' }), 'time');
    const { created_at: createdAt } = db.get<{ created_at: string }>(
      'SELECT created_at FROM users WHERE id = ?',
      fx.teacher.id,
    )!;
    runAt(new Date(createdAt));
    assert.equal(reports(fx.teacher.id).length, 0);
    assert.equal(lastReport(fx.teacher.id).daily_report_last_at, createdAt, 'the first report covers everything since');
  });

  test('teachers without classes get no report', async () => {
    const lonely: AuthResponse = await srv.registerUser('teacher', 'Ms. Nobody');
    runAt(zonedInstant(localDateIn(2, ZONE), '08:00', ZONE));
    assert.equal(reports(lonely.user.id).length, 0);
  });

  test('message bodies of old sent emails are cleared, the log rows stay', async () => {
    const now = zonedInstant(localDateIn(20, ZONE), '12:00', ZONE);
    const old = later(now, -40 * DAY_MS).toISOString();
    const insert = (state: string) =>
      db.run(
        `INSERT INTO email_outbox (kind, to_address, to_name, subject, html, text, state, attempts, next_attempt_at,
           created_at) VALUES ('receipt', 'old@school.test', 'Old', 'Old', '<p>old</p>', 'old', ?, 1, ?, ?)`,
        state,
        old,
        old,
      ).lastInsertRowid;
    const sent = insert('sent');
    const queued = insert('queued');
    runAt(now);
    const row = (id: number) => db.get<OutboxRow>('SELECT * FROM email_outbox WHERE id = ?', id)!;
    assert.deepEqual([row(sent).html, row(sent).text, row(sent).subject], ['', '', 'Old']);
    assert.equal(row(queued).html, '<p>old</p>', 'queued messages keep their body');
  });
});

/** Teacher uploads count as submissions in the report too. */
test('teacher uploads appear in the daily report', async () => {
  const fx = await setupClass(srv, ['Kai Moon'], 'Uploads class');
  const a = await createAssignment(srv, fx, { title: 'Scanned', gradingMode: 'manual', key: undefined });
  const upload = await submitRequest(srv, fx.teacher.token, a.id, PERFECT, { studentId: fx.students[0].id });
  const sub = expectOk(upload, 'upload');
  const day = localDateIn(2, ZONE);
  setSubmittedAt(sub.id, zonedInstant(day, '06:30', ZONE));
  runAt(zonedInstant(day, '07:00', ZONE));
  const [report] = reports(fx.teacher.id);
  assert.match(report.text, /Kai Moon · Scanned · .* · Needs grading/);
  assert.match(report.text, /Needs grading\n\n- Scanned \(.*\): 1 submission/);
});
