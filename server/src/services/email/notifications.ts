/**
 * Who gets which email, and when (docs/API.md, "Email"): per-class and per-user settings, submission receipts, and
 * the scheduler that queues overdue reminders and daily reports. Everything here only queues rows in the outbox
 * (outbox.ts); the worker sends them.
 */
import type { ClassNotificationSettings, EmailLogEntry, MyNotificationSettings } from '../../../../shared/types.js';
import { all, get, run, transaction, type ClassRow, type UserRow } from '../../db.js';
import { validationError } from '../classes.js';
import { lateness } from '../common.js';
import { buildGradebook } from '../gradebook.js';
import { finalScore } from '../submissions.js';
import { emailConfigured, inviteCodeRequired, timeZone } from './config.js';
import { localMoment } from './format.js';
import { enqueue, pruneQuota } from './outbox.js';
import { isUnsubscribed, resubscribe, unsubscribeUrl } from './recipients.js';
import {
  CLASS_FLAGS,
  inRange,
  limitEntries,
  parseTime,
  storedClassSettings,
  teacherSettings,
  type StoredClassSettings,
  type TeacherSettings,
} from './settings.js';
import {
  dailyReportEmail,
  newSubmissionCount,
  overdueEmail,
  receiptEmail,
  type ClassReport,
  type DailyReportData,
  type StudentRecipient,
} from './templates.js';
import type { MailContent } from './mailer.js';

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;
const iso = (date: Date) => date.toISOString();

/* ------------------------------------------------------------------ */
/* Class settings                                                     */
/* ------------------------------------------------------------------ */

const remindersSince = (cls: Pick<ClassRow, 'reminders_since' | 'created_at'>) => cls.reminders_since ?? cls.created_at;

export function classNotificationSettings(cls: ClassRow): ClassNotificationSettings {
  return { ...storedClassSettings(cls), remindersSince: remindersSince(cls) };
}

/** PUT /api/classes/:classId/notifications: validates a partial body (remindersSince is ignored). */
export function updateClassNotificationSettings(
  cls: ClassRow,
  body: Record<string, unknown>,
  now = new Date(),
): ClassNotificationSettings {
  const fields: Record<string, string> = {};
  const current = storedClassSettings(cls);
  const next: StoredClassSettings = { ...current };
  for (const key of CLASS_FLAGS) {
    if (body[key] === undefined) continue;
    if (typeof body[key] === 'boolean') next[key] = body[key];
    else fields[key] = 'Choose on or off.';
  }
  for (const [key, limit] of limitEntries()) {
    const value = body[key];
    if (value === undefined) continue;
    if (inRange(value, limit)) next[key] = value;
    else fields[key] = `Enter a whole number of ${limit.unit} from ${limit.min} to ${limit.max}.`;
  }
  if (Object.keys(fields).length > 0) throw validationError(fields);

  // Turning reminders back on starts a new period, so students aren't reminded about work from while they were off.
  const since = !current.overdueReminders && next.overdueReminders ? iso(now) : cls.reminders_since;
  run(
    'UPDATE classes SET notification_settings = ?, reminders_since = ? WHERE id = ?',
    JSON.stringify(next),
    since,
    cls.id,
  );
  return { ...next, remindersSince: since ?? cls.created_at };
}

/* ------------------------------------------------------------------ */
/* Personal settings                                                  */
/* ------------------------------------------------------------------ */

/** An address that used an unsubscribe link reads as opted out (students) or without a daily report (teachers). */
export function myNotificationSettings(user: UserRow): MyNotificationSettings {
  const unsubscribed = isUnsubscribed(user.email);
  const settings = teacherSettings(user);
  return {
    emailOptOut: user.role === 'student' && (!!user.email_opt_out || unsubscribed),
    ...settings,
    dailyReport: settings.dailyReport && !unsubscribed,
  };
}

/**
 * PUT /api/me/notifications. Every field is checked; students only change emailOptOut, teachers only the daily
 * report fields (the others are accepted and ignored, as documented).
 */
export function updateMyNotificationSettings(user: UserRow, body: Record<string, unknown>): MyNotificationSettings {
  const fields: Record<string, string> = {};
  for (const key of ['emailOptOut', 'dailyReport', 'skipEmptyReports'] as const) {
    if (body[key] !== undefined && typeof body[key] !== 'boolean') fields[key] = 'Choose on or off.';
  }
  const time = body.dailyReportTime === undefined ? undefined : parseTime(body.dailyReportTime);
  if (time === null) fields.dailyReportTime = 'Enter a time as HH:MM (24-hour), e.g. 07:00.';
  if (Object.keys(fields).length > 0) throw validationError(fields);

  // Turning emails back on here also takes the address off the unsubscribe list.
  if (user.role === 'student') {
    if (typeof body.emailOptOut === 'boolean') {
      run('UPDATE users SET email_opt_out = ? WHERE id = ?', body.emailOptOut ? 1 : 0, user.id);
      if (!body.emailOptOut) resubscribe(user.email);
    }
  } else {
    const next: TeacherSettings = { ...teacherSettings(user) };
    if (typeof body.dailyReport === 'boolean') next.dailyReport = body.dailyReport;
    if (typeof body.skipEmptyReports === 'boolean') next.skipEmptyReports = body.skipEmptyReports;
    if (time) next.dailyReportTime = time;
    run('UPDATE users SET notification_settings = ? WHERE id = ?', JSON.stringify(next), user.id);
    if (body.dailyReport === true) resubscribe(user.email);
  }
  return myNotificationSettings(get<UserRow>('SELECT * FROM users WHERE id = ?', user.id)!);
}

/* ------------------------------------------------------------------ */
/* Email log                                                          */
/* ------------------------------------------------------------------ */

interface LogRow {
  id: number;
  kind: EmailLogEntry['kind'];
  to_name: string;
  to_address: string;
  subject: string;
  state: EmailLogEntry['state'];
  attempts: number;
  last_error: string | null;
  assignment_id: number | null;
  assignment_title: string | null;
  created_at: string;
  sent_at: string | null;
}

export function classEmailLog(classId: number, limit: number): EmailLogEntry[] {
  const rows = all<LogRow>(
    `SELECT o.id, o.kind, o.to_name, o.to_address, o.subject, o.state, o.attempts, o.last_error, o.assignment_id,
       a.title AS assignment_title, o.created_at, o.sent_at
     FROM email_outbox o LEFT JOIN assignments a ON a.id = o.assignment_id
     WHERE o.class_id = ? ORDER BY o.created_at DESC, o.id DESC LIMIT ?`,
    classId,
    limit,
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    toName: r.to_name,
    toAddress: r.to_address,
    subject: r.subject,
    state: r.state,
    attempts: r.attempts,
    error: r.last_error,
    assignmentId: r.assignment_id,
    assignmentTitle: r.assignment_title,
    createdAt: r.created_at,
    sentAt: r.sent_at,
  }));
}

/* ------------------------------------------------------------------ */
/* Receipts                                                           */
/* ------------------------------------------------------------------ */

interface ReceiptRow {
  id: number;
  attempt: number;
  submitted_at: string;
  student_id: number;
  submitted_by: number | null;
  auto_status: 'not_applicable' | 'graded' | 'error';
  auto_score: number | null;
  assignment_id: number;
  title: string;
  due_at: string;
  points: number;
  class_id: number;
  class_name: string;
  join_code: string;
  class_settings: string | null;
  student_name: string;
  student_email: string;
  pending: number;
  email_opt_out: number;
  uploader_name: string | null;
  file_name: string;
}

function studentRecipient(name: string, email: string, pending: number, joinCode: string): StudentRecipient {
  return {
    name,
    email,
    pending: !!pending,
    joinCode: pending && inviteCodeRequired() ? joinCode : null,
    unsubscribeUrl: unsubscribeUrl(email),
  };
}

function queueReceipt(submissionId: number): number | null {
  const row = get<ReceiptRow>(
    `SELECT s.id, s.attempt, s.submitted_at, s.student_id, s.submitted_by, s.auto_status, s.auto_score,
       a.id AS assignment_id, a.title, a.due_at, a.points, c.id AS class_id, c.name AS class_name, c.join_code,
       c.notification_settings AS class_settings, st.name AS student_name, st.email AS student_email, st.pending,
       st.email_opt_out, up.name AS uploader_name, f.original_name AS file_name
     FROM submissions s
     JOIN assignments a ON a.id = s.assignment_id
     JOIN classes c ON c.id = a.class_id
     JOIN users st ON st.id = s.student_id
     JOIN files f ON f.id = s.file_id
     LEFT JOIN users up ON up.id = s.submitted_by
     WHERE s.id = ?`,
    submissionId,
  );
  if (!row || row.email_opt_out) return null;
  const settings = storedClassSettings({ notification_settings: row.class_settings });
  if (!settings.submissionReceipts) return null;
  if (row.pending && !settings.includePendingStudents) return null;

  const byStudent = row.submitted_by === row.student_id;
  const content = receiptEmail({
    student: studentRecipient(row.student_name, row.student_email, row.pending, row.join_code),
    assignmentId: row.assignment_id,
    assignmentTitle: row.title,
    className: row.class_name,
    attempt: row.attempt,
    submittedAt: row.submitted_at,
    lateBySeconds: lateness(row.submitted_at, row.due_at).lateBySeconds,
    uploadedByTeacher: byStudent ? null : (row.uploader_name ?? 'Your teacher'),
    fileName: row.file_name,
    autoStatus: row.auto_status,
    autoScore: row.auto_score,
    points: row.points,
  });
  return enqueue({
    kind: 'receipt',
    to: { name: row.student_name, address: row.student_email },
    ...content,
    userId: row.student_id,
    toPending: !!row.pending,
    classId: row.class_id,
    assignmentId: row.assignment_id,
    submissionId: row.id,
  });
}

/**
 * Queues the receipt for a new submission when the class sends receipts and the student hasn't opted out. Never
 * throws: the upload already succeeded, so a problem here is only logged. Returns the outbox id, or null.
 */
export function enqueueReceipt(submissionId: number): number | null {
  if (!emailConfigured()) return null;
  try {
    return queueReceipt(submissionId);
  } catch (err) {
    console.error(`Could not queue the receipt for submission ${submissionId}:`, err);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Overdue reminders                                                  */
/* ------------------------------------------------------------------ */

interface ReminderCandidate {
  assignment_id: number;
  title: string;
  due_at: string;
  student_id: number;
  name: string;
  email: string;
  pending: number;
  sent_count: number;
  last_sent_at: string | null;
}

/**
 * Enrolled students without any submission for an assignment of the class that is due after `since` (remindersSince,
 * or when email was turned on if that is later) and after the student joined (so a late joiner isn't flooded about
 * old work), and at least `firstReminderAfterHours` ago, with how many reminders they got for it.
 */
function reminderCandidates(
  cls: ClassRow,
  settings: StoredClassSettings,
  since: string,
  now: Date,
): ReminderCandidate[] {
  return all<ReminderCandidate>(
    `SELECT a.id AS assignment_id, a.title, a.due_at, u.id AS student_id, u.name, u.email, u.pending,
       (SELECT COUNT(*) FROM email_outbox o
         WHERE o.assignment_id = a.id AND o.user_id = u.id AND o.kind = 'overdue') AS sent_count,
       (SELECT MAX(o.created_at) FROM email_outbox o
         WHERE o.assignment_id = a.id AND o.user_id = u.id AND o.kind = 'overdue') AS last_sent_at
     FROM assignments a
     JOIN enrollments e ON e.class_id = a.class_id
     JOIN users u ON u.id = e.student_id
     WHERE a.class_id = ? AND a.due_at > ? AND a.due_at > e.joined_at AND a.due_at <= ?
       AND u.email_opt_out = 0 AND (u.pending = 0 OR ? = 1)
       AND NOT EXISTS (SELECT 1 FROM submissions s WHERE s.assignment_id = a.id AND s.student_id = u.id)
     ORDER BY a.due_at, a.id, u.name COLLATE NOCASE, u.id`,
    cls.id,
    since,
    iso(new Date(now.getTime() - settings.firstReminderAfterHours * HOUR_MS)),
    settings.includePendingStudents ? 1 : 0,
  );
}

/** Queues the reminders a class owes right now; returns how many. Runs in one transaction. */
function queueClassReminders(cls: ClassRow, teacherName: string, emailOnSince: string | null, now: Date): number {
  const settings = storedClassSettings(cls);
  if (!settings.overdueReminders) return 0;
  const classSince = remindersSince(cls);
  const since = emailOnSince && emailOnSince > classSince ? emailOnSince : classSince;
  return transaction(() => {
    let queued = 0;
    const lastAllowed = now.getTime() - settings.reminderIntervalDays * DAY_MS;
    for (const c of reminderCandidates(cls, settings, since, now)) {
      if (c.sent_count >= settings.maxReminders) continue;
      if (c.last_sent_at && Date.parse(c.last_sent_at) > lastAllowed) continue;
      const content = overdueEmail({
        student: studentRecipient(c.name, c.email, c.pending, cls.join_code),
        assignmentId: c.assignment_id,
        assignmentTitle: c.title,
        className: cls.name,
        teacherName,
        dueAt: c.due_at,
        overdueSeconds: (now.getTime() - Date.parse(c.due_at)) / 1000,
        reminderNumber: c.sent_count + 1,
        maxReminders: settings.maxReminders,
      });
      const id = enqueue(
        {
          kind: 'overdue',
          to: { name: c.name, address: c.email },
          ...content,
          userId: c.student_id,
          toPending: !!c.pending,
          classId: cls.id,
          assignmentId: c.assignment_id,
        },
        now,
      );
      if (id !== null) queued++;
    }
    return queued;
  });
}

/* ------------------------------------------------------------------ */
/* Daily report                                                       */
/* ------------------------------------------------------------------ */

/** Most new submissions listed per class (the rest are counted). */
const MAX_LISTED_SUBMISSIONS = 100;
/** Most missing students named per overdue assignment. */
const MAX_MISSING_NAMES = 30;
/** Overdue assignments are listed for this long after their due date. */
const OVERDUE_LISTED_DAYS = 14;

interface WindowSubmission {
  class_id: number;
  assignment_id: number;
  title: string;
  due_at: string;
  points: number;
  student_name: string;
  submitted_at: string;
  attempt: number;
  auto_status: 'not_applicable' | 'graded' | 'error';
  auto_score: number | null;
  override_score: number | null;
}

/**
 * What one report covers: submissions made after `since` or saved after submission `afterId` (an upload still
 * arriving at the last report started before it but was saved after it), up to submission `maxId` and `until`.
 */
export interface ReportWindow {
  since: Date;
  until: Date;
  afterId: number | null;
  maxId: number;
}

function windowSubmissions(teacherId: number, window: ReportWindow): WindowSubmission[] {
  return all<WindowSubmission>(
    `SELECT a.class_id, a.id AS assignment_id, a.title, a.due_at, a.points, u.name AS student_name, s.submitted_at,
       s.attempt, s.auto_status, s.auto_score, s.override_score
     FROM classes c
     JOIN assignments a ON a.class_id = c.id
     JOIN submissions s ON s.assignment_id = a.id
     JOIN enrollments e ON e.class_id = c.id AND e.student_id = s.student_id
     JOIN users u ON u.id = s.student_id
     WHERE c.teacher_id = ? AND (s.submitted_at > ? OR s.id > ?) AND s.id <= ? AND s.submitted_at <= ?
     ORDER BY s.submitted_at, s.id`,
    teacherId,
    iso(window.since),
    window.afterId ?? window.maxId,
    window.maxId,
    iso(window.until),
  );
}

function classReport(cls: Pick<ClassRow, 'id' | 'name'>, submissions: WindowSubmission[], now: Date): ClassReport {
  const book = buildGradebook(cls.id);
  const nowMs = now.getTime();
  const listed = submissions.slice(0, MAX_LISTED_SUBMISSIONS);
  const report: ClassReport = {
    classId: cls.id,
    className: cls.name,
    submissions: listed.map((s) => ({
      studentName: s.student_name,
      assignmentTitle: s.title,
      submittedAt: s.submitted_at,
      attempt: s.attempt,
      score: finalScore(s),
      points: s.points,
      late: lateness(s.submitted_at, s.due_at).late,
      autoError: s.auto_status === 'error',
    })),
    moreSubmissions: submissions.length - listed.length,
    needsGrading: [],
    dueSoon: [],
    overdue: [],
  };
  for (const a of book.assignments) {
    const { needsGrading, submitted, students } = a.counts!;
    const due = Date.parse(a.dueAt);
    if (needsGrading > 0) report.needsGrading.push({ assignmentId: a.id, title: a.title, count: needsGrading });
    if (due > nowMs && due <= nowMs + 7 * DAY_MS) {
      report.dueSoon.push({ assignmentId: a.id, title: a.title, dueAt: a.dueAt, submitted, students });
    }
    if (due <= nowMs && due > nowMs - OVERDUE_LISTED_DAYS * DAY_MS) {
      const missing = book.students.filter((s) => book.cells[s.id]?.[a.id]?.status === 'missing').map((s) => s.name);
      if (missing.length > 0) {
        report.overdue.push({
          assignmentId: a.id,
          title: a.title,
          dueAt: a.dueAt,
          missing: missing.slice(0, MAX_MISSING_NAMES),
          missingCount: missing.length,
        });
      }
    }
  }
  return report;
}

/** The teacher's report for the submissions in `window`: one section per class, newest classes first. */
export function buildDailyReport(
  teacher: Pick<UserRow, 'id' | 'name' | 'email'>,
  window: ReportWindow,
): DailyReportData {
  const classes = all<Pick<ClassRow, 'id' | 'name'>>(
    'SELECT id, name FROM classes WHERE teacher_id = ? ORDER BY created_at DESC, id DESC',
    teacher.id,
  );
  const submissions = windowSubmissions(teacher.id, window);
  return {
    teacherName: teacher.name,
    unsubscribeUrl: unsubscribeUrl(teacher.email),
    since: iso(window.since),
    until: iso(window.until),
    classes: classes.map((cls) => classReport(cls, submissions.filter((s) => s.class_id === cls.id), window.until)),
  };
}

/** Start of the next report's window: the last scheduled report, or 24 hours back. */
export function reportWindowStart(teacher: Pick<UserRow, 'daily_report_last_at'>, now: Date): Date {
  const last = teacher.daily_report_last_at ? Date.parse(teacher.daily_report_last_at) : NaN;
  return new Date(Number.isFinite(last) && last < now.getTime() ? last : now.getTime() - DAY_MS);
}

const maxSubmissionId = () => get<{ n: number }>('SELECT COALESCE(MAX(id), 0) AS n FROM submissions')!.n;

/** The window of the teacher's next report, if it were made at `now`. */
export function reportWindow(
  teacher: Pick<UserRow, 'daily_report_last_at' | 'daily_report_last_submission_id'>,
  now: Date,
): ReportWindow {
  return {
    since: reportWindowStart(teacher, now),
    until: now,
    afterId: teacher.daily_report_last_submission_id,
    maxId: maxSubmissionId(),
  };
}

export interface DailyReport {
  data: DailyReportData;
  content: MailContent;
}

export function dailyReportContent(teacher: UserRow, now = new Date()): DailyReport & { window: ReportWindow } {
  const window = reportWindow(teacher, now);
  const data = buildDailyReport(teacher, window);
  return { data, content: dailyReportEmail(data), window };
}

type ReportOutcome = 'queued' | 'skipped' | 'not_due';

/**
 * Once per local day, at or after the teacher's time: queues the report (or, with skipEmptyReports and no new
 * submissions, records the day as done without one). A server that was off at that time catches up on its first run
 * later that day; the date check inside the transaction makes a second run that day a no-op. A teacher who signed up
 * today starts tomorrow.
 */
function runDailyReport(teacherId: number, now: Date, zone: string): ReportOutcome {
  return transaction(() => {
    const teacher = get<UserRow>("SELECT * FROM users WHERE id = ? AND role = 'teacher'", teacherId);
    if (!teacher) return 'not_due';
    const settings = teacherSettings(teacher);
    const today = localMoment(now, zone);
    if (!settings.dailyReport || today.time < settings.dailyReportTime) return 'not_due';
    if (teacher.daily_report_last_date && teacher.daily_report_last_date >= today.date) return 'not_due';

    const markDone = (lastAt: string, lastSubmissionId: number | null) =>
      run(
        `UPDATE users SET daily_report_last_date = ?, daily_report_last_at = ?, daily_report_last_submission_id = ?
         WHERE id = ?`,
        today.date,
        lastAt,
        lastSubmissionId,
        teacher.id,
      );
    if (!teacher.daily_report_last_date && localMoment(new Date(teacher.created_at), zone).date === today.date) {
      markDone(teacher.created_at, null);
      return 'skipped';
    }
    const { data, content, window } = dailyReportContent(teacher, now);
    // Done up to now either way: a skipped (empty) report had nothing in its window to carry over.
    markDone(iso(now), window.maxId);
    if (settings.skipEmptyReports && newSubmissionCount(data) === 0) return 'skipped';
    const to = { name: teacher.name, address: teacher.email };
    enqueue({ kind: 'daily_report', to, ...content, userId: teacher.id }, now);
    return 'queued';
  });
}

/* ------------------------------------------------------------------ */
/* Scheduler                                                          */
/* ------------------------------------------------------------------ */

/** Message bodies of sent and failed emails are cleared after this long (the log rows stay). */
const KEEP_BODIES_DAYS = 30;
let lastPruneDay = '';

function pruneOldBodies(now: Date): void {
  const day = iso(now).slice(0, 10);
  if (day === lastPruneDay) return;
  lastPruneDay = day;
  pruneQuota(now);
  run(
    `UPDATE email_outbox SET html = '', text = ''
     WHERE state <> 'queued' AND created_at < ? AND (html <> '' OR text <> '')`,
    iso(new Date(now.getTime() - KEEP_BODIES_DAYS * DAY_MS)),
  );
}

export interface SchedulerResult {
  reminders: number;
  reports: number;
}

const EMAIL_OFF_KEY = 'email_off_seen_at';
const EMAIL_ON_KEY = 'email_on_since';

const appState = (key: string) => get<{ value: string }>('SELECT value FROM app_state WHERE key = ?', key)?.value;

/**
 * When email was turned on after running without a token (the token was skipped at the update and added weeks
 * later): the first run that finds a token records that moment, and reminders only cover work due after it, so
 * students aren't reminded about everything that came due while email was off. Null when email was never off.
 */
function emailOnSince(now: Date): string | null {
  if (appState(EMAIL_OFF_KEY) !== undefined) {
    transaction(() => {
      run('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)', EMAIL_ON_KEY, iso(now));
      run('DELETE FROM app_state WHERE key = ?', EMAIL_OFF_KEY);
    });
  }
  return appState(EMAIL_ON_KEY) ?? null;
}

function noteEmailOff(now: Date): void {
  run('INSERT OR IGNORE INTO app_state (key, value) VALUES (?, ?)', EMAIL_OFF_KEY, iso(now));
}

/**
 * One scheduler pass: overdue reminders for every class, then daily reports for every teacher with classes.
 * Synchronous, and every decision is made in a transaction against the outbox rows already written, so repeated or
 * overlapping runs never queue the same email twice.
 */
export function runSchedulerOnce(now = new Date()): SchedulerResult {
  const result: SchedulerResult = { reminders: 0, reports: 0 };
  if (!emailConfigured()) {
    noteEmailOff(now);
    return result;
  }
  const zone = timeZone();
  const onSince = emailOnSince(now);

  const classes = all<ClassRow & { teacher_name: string }>(
    'SELECT c.*, t.name AS teacher_name FROM classes c JOIN users t ON t.id = c.teacher_id ORDER BY c.id',
  );
  for (const cls of classes) {
    try {
      result.reminders += queueClassReminders(cls, cls.teacher_name, onSince, now);
    } catch (err) {
      console.error(`Could not queue overdue reminders for class ${cls.id}:`, err);
    }
  }

  const teachers = all<{ id: number }>(
    "SELECT id FROM users u WHERE role = 'teacher' AND EXISTS (SELECT 1 FROM classes c WHERE c.teacher_id = u.id)",
  );
  for (const { id } of teachers) {
    try {
      if (runDailyReport(id, now, zone) === 'queued') result.reports++;
    } catch (err) {
      console.error(`Could not queue the daily report for teacher ${id}:`, err);
    }
  }

  pruneOldBodies(now);
  return result;
}

let schedulerTimer: NodeJS.Timeout | null = null;

/** Runs the scheduler every `intervalMs` (first after `firstDelayMs`) until stopScheduler. */
export function startScheduler(intervalMs = 5 * 60_000, firstDelayMs = 30_000): void {
  if (schedulerTimer) return;
  const tick = () => {
    try {
      runSchedulerOnce(new Date());
    } catch (err) {
      console.error('Email scheduler failed:', err);
    }
    if (schedulerTimer) schedule(intervalMs);
  };
  const schedule = (ms: number) => {
    schedulerTimer = setTimeout(tick, ms);
    schedulerTimer.unref();
  };
  schedule(firstDelayMs);
}

export function stopScheduler(): void {
  if (schedulerTimer) clearTimeout(schedulerTimer);
  schedulerTimer = null;
}
