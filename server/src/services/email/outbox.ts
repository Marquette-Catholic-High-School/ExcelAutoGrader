/**
 * The email outbox: requests never wait for a mail server. They write a row to email_outbox and a background worker
 * sends queued rows a few at a time (about one per second at most), retrying temporary failures with backoff. The rows
 * stay afterwards as the email log and as the record the scheduler counts reminders and reports with.
 */
import type { EmailKind } from '../../../../shared/types.js';
import { all, get, run, type EmailOutboxRow } from '../../db.js';
import { dailyEmailLimit, emailConfigured } from './config.js';
import { closeMailer, EmailSendError, sendNow, toSendError, type OutgoingEmail } from './mailer.js';
import { isUnsubscribed, recipientKey, unsubscribeUrl } from './recipients.js';
import { storedClassSettings, teacherSettings } from './settings.js';

export interface NewEmail extends OutgoingEmail {
  kind: EmailKind;
  /** The recipient's account. */
  userId?: number | null;
  /** The recipient is an invited student who hasn't signed up (an address nobody has confirmed). */
  toPending?: boolean;
  classId?: number | null;
  assignmentId?: number | null;
  submissionId?: number | null;
}

/** A message is tried at most this many times. */
export const MAX_ATTEMPTS = 5;
/** Wait after the 1st, 2nd, 3rd and 4th failed attempt. */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000];
/** A send that never finished (the server stopped mid-send) is tried again after this long. */
const CLAIM_MS = 15 * 60_000;
/*
 * Daily limits (rolling 24 hours). The app can't verify addresses and anyone who can open it can sign up as a
 * teacher, so these keep one account (or many) from using the school's sender to flood people.
 */
/** Most emails one mailbox gets (address variants such as ana+1@ count as the same mailbox). */
export const MAX_PER_RECIPIENT_PER_DAY = 50;
/** Most receipts and reminders about one teacher's classes. */
export const MAX_PER_TEACHER_PER_DAY = 1000;
/** Of those, most to invited students who haven't signed up. */
export const MAX_PENDING_PER_TEACHER_PER_DAY = 300;

const iso = (date: Date) => date.toISOString();

/** The teacher whose class an email is about (receipts and reminders), else null. */
function classTeacher(email: NewEmail): number | null {
  if (email.classId === undefined || email.classId === null) return null;
  return get<{ teacher_id: number }>('SELECT teacher_id FROM classes WHERE id = ?', email.classId)?.teacher_id ?? null;
}

function insertEmail(email: NewEmail, now: Date, state: EmailOutboxRow['state'], fields: Partial<EmailOutboxRow> = {}) {
  run(
    'INSERT INTO email_quota (created_at, recipient_key, teacher_id, pending) VALUES (?, ?, ?, ?)',
    iso(now),
    recipientKey(email.to.address),
    classTeacher(email),
    email.toPending ? 1 : 0,
  );
  return run(
    `INSERT INTO email_outbox (kind, to_address, to_name, subject, html, text, user_id, class_id, assignment_id,
       submission_id, state, attempts, next_attempt_at, last_error, created_at, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    email.kind,
    email.to.address,
    email.to.name,
    email.subject,
    email.html,
    email.text,
    email.userId ?? null,
    email.classId ?? null,
    email.assignmentId ?? null,
    email.submissionId ?? null,
    state,
    fields.attempts ?? 0,
    iso(now),
    fields.last_error ?? null,
    iso(now),
    fields.sent_at ?? null,
  ).lastInsertRowid;
}

const quota = (where: string, ...params: (string | number)[]) =>
  get<{ n: number }>(`SELECT COUNT(*) AS n FROM email_quota WHERE created_at > ? ${where}`, ...params)!.n;

/** Why this email may not go out now (a daily limit is reached), or null. */
export function limitReason(email: NewEmail, now: Date): string | null {
  const since = iso(new Date(now.getTime() - 86_400_000));
  if (quota('AND recipient_key = ?', since, recipientKey(email.to.address)) >= MAX_PER_RECIPIENT_PER_DAY) {
    return `${email.to.address} already got ${MAX_PER_RECIPIENT_PER_DAY} emails in the last 24 hours.`;
  }
  const limit = dailyEmailLimit();
  if (quota('', since) >= limit) {
    return `this server already sent ${limit} emails in the last 24 hours (EMAIL_DAILY_LIMIT in config.env).`;
  }
  const teacherId = classTeacher(email);
  if (teacherId === null) return null;
  if (quota('AND teacher_id = ?', since, teacherId) >= MAX_PER_TEACHER_PER_DAY) {
    return `the classes of teacher ${teacherId} already sent ${MAX_PER_TEACHER_PER_DAY} emails in the last 24 hours.`;
  }
  const pendingSent = () => quota('AND teacher_id = ? AND pending = 1', since, teacherId);
  if (email.toPending && pendingSent() >= MAX_PENDING_PER_TEACHER_PER_DAY) {
    return (
      `the classes of teacher ${teacherId} already emailed ${MAX_PENDING_PER_TEACHER_PER_DAY} invited students ` +
      'in the last 24 hours.'
    );
  }
  return null;
}

/** Quota rows only matter for 24 hours. */
export function pruneQuota(now: Date): void {
  run('DELETE FROM email_quota WHERE created_at < ?', iso(new Date(now.getTime() - 2 * 86_400_000)));
}

const lastWarnings = new Map<string, number>();

/** Logs a refused email, at most once an hour per kind of refusal (a flood would flood the log too). */
function warnRefused(reason: string, now: Date): void {
  const kind = reason.replace(/^\S+@\S+/, 'address').replace(/\d+/g, '#');
  const last = lastWarnings.get(kind);
  if (last !== undefined && now.getTime() - last < 3600_000) return;
  lastWarnings.set(kind, now.getTime());
  console.warn(`Email not queued: ${reason}`);
}

/**
 * Queues an email for the worker and returns its id. Does nothing (null) while email isn't configured, when the
 * address unsubscribed (test emails excepted), or when a daily limit is reached. Safe inside a transaction.
 */
export function enqueue(email: NewEmail, now = new Date()): number | null {
  if (!emailConfigured()) return null;
  if (email.kind !== 'test' && isUnsubscribed(email.to.address)) return null;
  const reason = limitReason(email, now);
  if (reason) {
    warnRefused(reason, now);
    return null;
  }
  return insertEmail(email, now, 'queued');
}

/** An on-demand email was refused by a daily limit (the route answers 429). */
export class EmailLimitError extends Error {}

/**
 * Sends right away and records the result in the log (test email, report on demand). Throws EmailLimitError when a
 * daily limit is reached, and what sendNow throws.
 */
export async function sendAndRecord(email: NewEmail, now = () => new Date()): Promise<void> {
  const reason = limitReason(email, now());
  if (reason) throw new EmailLimitError(`Not sent: ${reason} Try again tomorrow.`);
  try {
    await sendNow(email.kind === 'test' ? email : { ...email, unsubscribeUrl: unsubscribeUrl(email.to.address) });
  } catch (err) {
    if (err instanceof EmailSendError) insertEmail(email, now(), 'failed', { attempts: 1, last_error: err.message });
    throw err;
  }
  const at = now();
  insertEmail(email, at, 'sent', { attempts: 1, sent_at: iso(at) });
}

/** How many emails of these kinds were logged for the user in the last `sinceMs` (rate limit for on-demand sends). */
export function recentSendCount(userId: number, kinds: EmailKind[], sinceMs: number, now = new Date()): number {
  const { n } = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM email_outbox
     WHERE user_id = ? AND kind IN (SELECT value FROM json_each(?)) AND created_at > ?`,
    userId,
    JSON.stringify(kinds),
    iso(new Date(now.getTime() - sinceMs)),
  )!;
  return n;
}

/* ------------------------------------------------------------------ */
/* Worker                                                             */
/* ------------------------------------------------------------------ */

interface RecipientState {
  pending: number;
  email_opt_out: number;
  enrolled: number;
  notification_settings: string | null;
}

/**
 * A message that waited in the queue (e.g. during retries) is dropped when it no longer applies: the address
 * unsubscribed; a student opted out, left the class or was removed (an invited student's account is deleted then),
 * or the class turned that email (or emails to invited students) off; for a reminder, the student submitted or the
 * assignment is no longer past due; a teacher turned the daily report off.
 */
function stillWanted(row: EmailOutboxRow, now: Date): boolean {
  if (row.kind === 'test') return true;
  if (isUnsubscribed(row.to_address)) return false;
  if (row.kind === 'daily_report') {
    if (row.user_id === null) return false;
    const teacher = get<{ notification_settings: string | null }>(
      "SELECT notification_settings FROM users WHERE id = ? AND role = 'teacher'",
      row.user_id,
    );
    return !!teacher && teacherSettings(teacher).dailyReport;
  }
  if (row.user_id === null || row.class_id === null) return false;
  const student = get<RecipientState>(
    `SELECT u.pending, u.email_opt_out, c.notification_settings,
       EXISTS (SELECT 1 FROM enrollments e WHERE e.class_id = c.id AND e.student_id = u.id) AS enrolled
     FROM users u, classes c WHERE u.id = ? AND c.id = ?`,
    row.user_id,
    row.class_id,
  );
  if (!student || student.email_opt_out || !student.enrolled) return false;
  const settings = storedClassSettings(student);
  if (student.pending && !settings.includePendingStudents) return false;
  if (row.kind === 'receipt') return settings.submissionReceipts;
  if (!settings.overdueReminders || row.assignment_id === null) return false;
  return !!get(
    `SELECT 1 FROM assignments a
     WHERE a.id = ? AND a.due_at < ?
       AND NOT EXISTS (SELECT 1 FROM submissions s WHERE s.assignment_id = a.id AND s.student_id = ?)`,
    row.assignment_id,
    iso(now),
    row.user_id,
  );
}

/** Takes the row for this attempt, so a second worker (or an overlapping tick) can't send it too. */
function claim(id: number, now: Date): EmailOutboxRow | undefined {
  const { changes } = run(
    `UPDATE email_outbox SET attempts = attempts + 1, next_attempt_at = ?
     WHERE id = ? AND state = 'queued' AND next_attempt_at <= ?`,
    iso(new Date(now.getTime() + CLAIM_MS)),
    id,
    iso(now),
  );
  return changes > 0 ? get<EmailOutboxRow>('SELECT * FROM email_outbox WHERE id = ?', id) : undefined;
}

function recordFailure(row: EmailOutboxRow, err: EmailSendError, now: Date): 'retry' | 'failed' {
  if (err.temporary && row.attempts < MAX_ATTEMPTS) {
    const waitMs = RETRY_DELAYS_MS[Math.min(row.attempts, RETRY_DELAYS_MS.length) - 1];
    const retryAt = new Date(now.getTime() + waitMs);
    run('UPDATE email_outbox SET next_attempt_at = ?, last_error = ? WHERE id = ?', iso(retryAt), err.message, row.id);
    const retry = `attempt ${row.attempts}, retrying at ${iso(retryAt)}`;
    console.warn(`Email ${row.id} to ${row.to_address}: ${err.message} (${retry})`);
    return 'retry';
  }
  run("UPDATE email_outbox SET state = 'failed', last_error = ? WHERE id = ?", err.message, row.id);
  console.warn(`Email ${row.id} to ${row.to_address} failed: ${err.message}`);
  return 'failed';
}

export interface WorkerOptions {
  /** Clock (tests move it forward). */
  now?: () => Date;
  /** Most messages per run. */
  limit?: number;
  /** Pause between two sends, in ms. */
  gapMs?: number;
  /** Checked between sends: stop early (server shutting down). */
  shouldStop?: () => boolean;
  /** How to wait between sends (tests skip it). */
  pause?: (ms: number) => Promise<void>;
}

export interface WorkerResult {
  sent: number;
  retried: number;
  failed: number;
  dropped: number;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Sends what is due now: up to `limit` queued messages, oldest first. */
export async function processOutboxOnce(options: WorkerOptions = {}): Promise<WorkerResult> {
  const { now = () => new Date(), limit = 5, gapMs = 1000, shouldStop = () => false, pause = delay } = options;
  const result: WorkerResult = { sent: 0, retried: 0, failed: 0, dropped: 0 };
  if (!emailConfigured()) {
    // Left over from a run that had a token: don't send them days later if email is turned on again.
    run(
      "UPDATE email_outbox SET state = 'failed', last_error = ? WHERE state = 'queued'",
      'Not sent: email was turned off (no Cloudflare API token).',
    );
    return result;
  }
  const due = all<{ id: number }>(
    "SELECT id FROM email_outbox WHERE state = 'queued' AND next_attempt_at <= ? ORDER BY next_attempt_at, id LIMIT ?",
    iso(now()),
    limit,
  );
  for (const [index, { id }] of due.entries()) {
    if (shouldStop()) break;
    if (index > 0 && gapMs > 0) await pause(gapMs);
    const at = now();
    const row = claim(id, at);
    if (!row) continue;
    if (!stillWanted(row, at)) {
      run('DELETE FROM email_outbox WHERE id = ?', row.id);
      result.dropped++;
      continue;
    }
    try {
      const { to_name: name, to_address: address, subject, html, text } = row;
      await sendNow({ to: { name, address }, subject, html, text, unsubscribeUrl: unsubscribeUrl(address) });
      run("UPDATE email_outbox SET state = 'sent', sent_at = ?, last_error = NULL WHERE id = ?", iso(now()), row.id);
      result.sent++;
    } catch (err) {
      const outcome = recordFailure(row, toSendError(err, ''), now());
      if (outcome === 'retry') result.retried++;
      else result.failed++;
    }
  }
  return result;
}

let workerTimer: NodeJS.Timeout | null = null;
let workerRun: Promise<unknown> | null = null;
let workerStopping = false;
let wakePause: (() => void) | null = null;

/** A pause that stopWorker can cut short. */
function stoppablePause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      wakePause = null;
      resolve();
    }
    wakePause = done;
  });
}

/** Runs the worker every `intervalMs` (first run after `firstDelayMs`) until stopWorker. */
export function startWorker(intervalMs = 10_000, firstDelayMs = 2_000): void {
  if (workerTimer || workerRun) return;
  workerStopping = false;
  const tick = async () => {
    workerTimer = null;
    workerRun = processOutboxOnce({ shouldStop: () => workerStopping, pause: stoppablePause }).catch((err) => {
      console.error('Email worker failed:', err);
    });
    await workerRun;
    workerRun = null;
    if (!workerStopping) schedule(intervalMs);
  };
  const schedule = (ms: number) => {
    workerTimer = setTimeout(() => void tick(), ms);
    workerTimer.unref();
  };
  schedule(firstDelayMs);
}

/** Stops the worker; resolves when a send in progress has finished. Closes the SMTP connection. */
export async function stopWorker(): Promise<void> {
  workerStopping = true;
  if (workerTimer) clearTimeout(workerTimer);
  workerTimer = null;
  wakePause?.();
  await workerRun;
  closeMailer();
}
