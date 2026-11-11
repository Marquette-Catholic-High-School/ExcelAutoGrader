import { Router, type Response } from 'express';
import type {
  ClassNotificationSettings,
  EmailLogEntry,
  EmailStatus,
  MyNotificationSettings,
  TestEmailResponse,
} from '../../../shared/types.js';
import { teacherClass } from '../access.js';
import { currentUser, requireAuth, requireRole } from '../auth.js';
import type { UserRow } from '../db.js';
import { badRequest, HttpError, intParam } from '../http.js';
import { jsonBody } from '../services/classes.js';
import { emailConfig, emailConfigured, emailStatus } from '../services/email/config.js';
import {
  EmailNotConfiguredError,
  EmailSendError,
  friendlySendError,
  type MailContent,
} from '../services/email/mailer.js';
import {
  classEmailLog,
  classNotificationSettings,
  dailyReportContent,
  myNotificationSettings,
  updateClassNotificationSettings,
  updateMyNotificationSettings,
} from '../services/email/notifications.js';
import { EmailLimitError, recentSendCount, sendAndRecord } from '../services/email/outbox.js';
import { addressForToken, unsubscribe } from '../services/email/recipients.js';
import { testEmail } from '../services/email/templates.js';
import { confirmPage, donePage, invalidPage } from '../services/email/unsubscribe-page.js';

const router = Router();

const classIdOf = (params: Record<string, unknown>) => intParam(params.classId, 'class id');

router.get('/api/email/status', requireAuth, (_req, res) => {
  const body: EmailStatus = emailStatus();
  res.json(body);
});

/* ------------------------------------------------------------------ */
/* Class settings and log                                             */
/* ------------------------------------------------------------------ */

router.get('/api/classes/:classId/notifications', requireAuth, (req, res) => {
  const cls = teacherClass(classIdOf(req.params), currentUser(req));
  const body: ClassNotificationSettings = classNotificationSettings(cls);
  res.json(body);
});

router.put('/api/classes/:classId/notifications', requireAuth, (req, res) => {
  const cls = teacherClass(classIdOf(req.params), currentUser(req));
  const body: ClassNotificationSettings = updateClassNotificationSettings(cls, jsonBody(req));
  res.json(body);
});

const DEFAULT_LOG_LIMIT = 100;
const MAX_LOG_LIMIT = 500;

function logLimit(raw: unknown): number {
  if (raw === undefined || raw === '') return DEFAULT_LOG_LIMIT;
  const n = typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isInteger(n)) throw badRequest('limit must be a whole number.', { limit: 'Enter a whole number.' });
  return Math.min(Math.max(n, 1), MAX_LOG_LIMIT);
}

router.get('/api/classes/:classId/emails', requireAuth, (req, res) => {
  const cls = teacherClass(classIdOf(req.params), currentUser(req));
  const body: EmailLogEntry[] = classEmailLog(cls.id, logLimit(req.query.limit));
  res.json(body);
});

/* ------------------------------------------------------------------ */
/* Personal settings                                                  */
/* ------------------------------------------------------------------ */

router.get('/api/me/notifications', requireAuth, (req, res) => {
  const body: MyNotificationSettings = myNotificationSettings(currentUser(req));
  res.json(body);
});

router.put('/api/me/notifications', requireAuth, (req, res) => {
  const body: MyNotificationSettings = updateMyNotificationSettings(currentUser(req), jsonBody(req));
  res.json(body);
});

/* ------------------------------------------------------------------ */
/* Send now                                                           */
/* ------------------------------------------------------------------ */

/** At most this many on-demand emails (test emails and reports) per teacher in 10 minutes. */
const MAX_ON_DEMAND = 5;
const ON_DEMAND_WINDOW_MS = 10 * 60_000;
/** Most on-demand sends in progress at once, over all teachers. */
const MAX_SENDING = 3;
const TOO_MANY = 'Too many emails in a short time. Please wait a few minutes and try again.';

/**
 * Teachers with an on-demand send in progress. A send is only logged once the mail server answers, so without this
 * a burst of parallel requests would all pass the count below.
 */
const sending = new Set<number>();

/** Sends to the teacher's own address right away; 503 without a token, 502 with the server's reply on failure. */
async function sendToTeacher(
  teacher: UserRow,
  kind: 'test' | 'daily_report',
  build: () => MailContent,
): Promise<TestEmailResponse> {
  if (!emailConfigured()) throw new HttpError(503, new EmailNotConfiguredError().message);
  if (sending.has(teacher.id) || sending.size >= MAX_SENDING) throw new HttpError(429, TOO_MANY);
  if (recentSendCount(teacher.id, ['test', 'daily_report'], ON_DEMAND_WINDOW_MS) >= MAX_ON_DEMAND) {
    throw new HttpError(429, TOO_MANY);
  }
  sending.add(teacher.id);
  try {
    await sendAndRecord({ kind, to: { name: teacher.name, address: teacher.email }, ...build(), userId: teacher.id });
  } catch (err) {
    if (err instanceof EmailLimitError) throw new HttpError(429, err.message);
    if (err instanceof EmailSendError) throw new HttpError(502, friendlySendError(err, emailConfig()));
    throw err;
  } finally {
    sending.delete(teacher.id);
  }
  return { ok: true, to: teacher.email };
}

router.post('/api/me/test-email', requireAuth, requireRole('teacher'), async (req, res) => {
  const teacher = currentUser(req);
  res.json(await sendToTeacher(teacher, 'test', () => testEmail(teacher.name, teacher.email)));
});

router.post('/api/me/daily-report', requireAuth, requireRole('teacher'), async (req, res) => {
  const teacher = currentUser(req);
  res.json(await sendToTeacher(teacher, 'daily_report', () => dailyReportContent(teacher).content));
});

/* ------------------------------------------------------------------ */
/* Unsubscribe (the link in every email; no sign-in)                  */
/* ------------------------------------------------------------------ */

function sendPage(res: Response, status: number, html: string): void {
  res.status(status).set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer').type('html').send(html);
}

router.get('/api/email/unsubscribe/:token', (req, res) => {
  const found = addressForToken(String(req.params.token));
  if (!found) return sendPage(res, 404, invalidPage());
  sendPage(res, 200, found.unsubscribed ? donePage(found.address) : confirmPage(found.address));
});

// The confirmation button, and mail apps' one-click "Unsubscribe" (RFC 8058: POST with List-Unsubscribe=One-Click).
router.post('/api/email/unsubscribe/:token', (req, res) => {
  const token = String(req.params.token);
  const found = addressForToken(token);
  if (!found || !unsubscribe(token)) return sendPage(res, 404, invalidPage());
  sendPage(res, 200, donePage(found.address));
});

export default router;
