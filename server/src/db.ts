import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * server/data — holds the SQLite database and uploaded files. Override with DATA_DIR: a relative path is relative
 * to the repository root (as in config.env), whichever folder the server was started from; ~ is the home folder.
 */
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(here, '../..', process.env.DATA_DIR.replace(/^~(?=$|[\\/])/, os.homedir()))
  : path.resolve(here, '../data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('teacher', 'student')),
    must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    created_by_teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    pending INTEGER NOT NULL DEFAULT 0,
    placeholder_name INTEGER NOT NULL DEFAULT 0,
    email_opt_out INTEGER NOT NULL DEFAULT 0,
    notification_settings TEXT,
    daily_report_last_date TEXT,
    daily_report_last_at TEXT,
    daily_report_last_submission_id INTEGER
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS classes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    join_code TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    notification_settings TEXT,
    reminders_since TEXT
  );

  CREATE TABLE IF NOT EXISTS enrollments (
    class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at TEXT NOT NULL,
    PRIMARY KEY (class_id, student_id)
  );

  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL UNIQUE,
    size INTEGER NOT NULL,
    uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    due_at TEXT NOT NULL,
    points REAL NOT NULL DEFAULT 100,
    grading_mode TEXT NOT NULL CHECK (grading_mode IN ('auto', 'manual')),
    grading_config TEXT NOT NULL,
    key_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
    template_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    file_id INTEGER NOT NULL REFERENCES files(id),
    attempt INTEGER NOT NULL,
    submitted_at TEXT NOT NULL,
    submitted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    auto_status TEXT NOT NULL DEFAULT 'not_applicable' CHECK (auto_status IN ('not_applicable', 'graded', 'error')),
    auto_score REAL,
    auto_report TEXT,
    auto_error TEXT,
    override_score REAL,
    feedback TEXT NOT NULL DEFAULT '',
    graded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    graded_at TEXT,
    UNIQUE (assignment_id, student_id, attempt)
  );

  CREATE TABLE IF NOT EXISTS email_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('receipt', 'overdue', 'daily_report', 'test')),
    to_address TEXT NOT NULL,
    to_name TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL,
    html TEXT NOT NULL,
    text TEXT NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
    assignment_id INTEGER REFERENCES assignments(id) ON DELETE CASCADE,
    submission_id INTEGER REFERENCES submissions(id) ON DELETE SET NULL,
    state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'sent', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    last_error TEXT,
    created_at TEXT NOT NULL,
    sent_at TEXT
  );

  -- One row per email queued or sent, for the daily limits. No foreign keys: deleting a class (whose outbox rows
  -- go with it) must not reset what its teacher already sent. Rows older than two days are pruned.
  CREATE TABLE IF NOT EXISTS email_quota (
    id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL,
    recipient_key TEXT NOT NULL,
    teacher_id INTEGER,
    pending INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS email_recipients (
    address TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    unsubscribed_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS app_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_submissions_assignment ON submissions(assignment_id, student_id);
  CREATE INDEX IF NOT EXISTS idx_assignments_class ON assignments(class_id);
  CREATE INDEX IF NOT EXISTS idx_enrollments_student ON enrollments(student_id);
  CREATE INDEX IF NOT EXISTS idx_outbox_queue ON email_outbox(state, next_attempt_at);
  CREATE INDEX IF NOT EXISTS idx_outbox_reminders ON email_outbox(assignment_id, user_id, kind);
  CREATE INDEX IF NOT EXISTS idx_outbox_class ON email_outbox(class_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_outbox_recipient ON email_outbox(to_address, created_at);
  CREATE INDEX IF NOT EXISTS idx_outbox_user ON email_outbox(user_id);
  CREATE INDEX IF NOT EXISTS idx_outbox_submission ON email_outbox(submission_id);
  CREATE INDEX IF NOT EXISTS idx_quota_created ON email_quota(created_at);
  CREATE INDEX IF NOT EXISTS idx_quota_recipient ON email_quota(recipient_key, created_at);
  CREATE INDEX IF NOT EXISTS idx_quota_teacher ON email_quota(teacher_id, created_at);
`);

/**
 * Brings databases created by older versions up to date (CREATE TABLE IF NOT EXISTS leaves them as they were).
 * Returns true when the column was added.
 */
function addColumnIfMissing(table: string, column: string, definition: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.some((c) => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

// Existing accounts keep NULL: nobody is recorded as their creator.
addColumnIfMissing('users', 'created_by_teacher_id', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');
addColumnIfMissing('users', 'pending', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('users', 'placeholder_name', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('users', 'email_opt_out', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('users', 'notification_settings', 'TEXT');
addColumnIfMissing('users', 'daily_report_last_date', 'TEXT');
addColumnIfMissing('users', 'daily_report_last_at', 'TEXT');
addColumnIfMissing('users', 'daily_report_last_submission_id', 'INTEGER');
addColumnIfMissing('classes', 'notification_settings', 'TEXT');
// Classes that existed before email reminders get them only for assignments due after this update; newer classes
// leave the column NULL, which means "since the class was created".
if (addColumnIfMissing('classes', 'reminders_since', 'TEXT')) {
  db.prepare('UPDATE classes SET reminders_since = ?').run(new Date().toISOString());
}

/* Raw row shapes (snake_case, exactly as stored). Booleans are 0/1, JSON columns are strings. */

export interface UserRow {
  id: number;
  email: string;
  name: string;
  password_hash: string;
  role: 'teacher' | 'student';
  must_change_password: number;
  created_at: string;
  /** The teacher who created this student account through "Add students" (null otherwise). */
  created_by_teacher_id: number | null;
  /**
   * 1 for a student a teacher added by email who has not signed up yet: the password hash is empty (nobody can sign
   * in), and the first sign-up with this email takes the account over.
   */
  pending: number;
  /** 1 while `name` was made up from the email (the teacher left it blank); sign-up then replaces it. */
  placeholder_name: number;
  /** Students: 1 turns off receipts and overdue reminders. */
  email_opt_out: number;
  /** Teachers: JSON of the daily-report settings (dailyReport, dailyReportTime, skipEmptyReports); NULL = defaults. */
  notification_settings: string | null;
  /** Teachers: local date (YYYY-MM-DD in TIME_ZONE) of the last scheduled daily report, sent or skipped. */
  daily_report_last_date: string | null;
  /** Teachers: when the last scheduled daily report was sent (ISO); the next one covers what came after. */
  daily_report_last_at: string | null;
  /**
   * Teachers: the highest submission id when the last scheduled report was made, so an upload that was still
   * arriving then (submitted_at is when it started) is in the next report.
   */
  daily_report_last_submission_id: number | null;
}

export interface SessionRow {
  token: string;
  user_id: number;
  created_at: string;
  expires_at: string;
}

export interface ClassRow {
  id: number;
  teacher_id: number;
  name: string;
  description: string;
  join_code: string;
  created_at: string;
  /** JSON of ClassNotificationSettings without remindersSince; NULL = DEFAULT_CLASS_NOTIFICATION_SETTINGS. */
  notification_settings: string | null;
  /** Overdue reminders only cover assignments due after this (ISO); NULL = since the class was created. */
  reminders_since: string | null;
}

export interface EnrollmentRow {
  class_id: number;
  student_id: number;
  joined_at: string;
}

export interface FileRow {
  id: number;
  original_name: string;
  stored_name: string;
  size: number;
  uploaded_by: number | null;
  created_at: string;
}

export interface AssignmentRow {
  id: number;
  class_id: number;
  title: string;
  description: string;
  due_at: string;
  points: number;
  grading_mode: 'auto' | 'manual';
  grading_config: string;
  key_file_id: number | null;
  template_file_id: number | null;
  created_at: string;
}

export interface SubmissionRow {
  id: number;
  assignment_id: number;
  student_id: number;
  file_id: number;
  attempt: number;
  submitted_at: string;
  submitted_by: number | null;
  auto_status: 'not_applicable' | 'graded' | 'error';
  auto_score: number | null;
  auto_report: string | null;
  auto_error: string | null;
  override_score: number | null;
  feedback: string;
  graded_by: number | null;
  graded_at: string | null;
}

/** One email: queued for the background worker, or a record of one sent right away (test email, report on demand). */
export interface EmailOutboxRow {
  id: number;
  kind: 'receipt' | 'overdue' | 'daily_report' | 'test';
  to_address: string;
  to_name: string;
  subject: string;
  html: string;
  text: string;
  /** The recipient's account (the student, or the teacher for daily reports and test emails). */
  user_id: number | null;
  /** NULL for daily reports and test emails, which are about the teacher rather than one class. */
  class_id: number | null;
  assignment_id: number | null;
  submission_id: number | null;
  state: 'queued' | 'sent' | 'failed';
  attempts: number;
  /** When the worker may (re)try it; while a send is in progress, when a send that never finished is retried. */
  next_attempt_at: string;
  last_error: string | null;
  created_at: string;
  sent_at: string | null;
}

type Param = null | number | bigint | string | NodeJS.ArrayBufferView;

/** Typed convenience wrappers around node:sqlite prepared statements. */
export function get<T>(sql: string, ...params: Param[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function all<T>(sql: string, ...params: Param[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number } {
  const r = db.prepare(sql).run(...params);
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
}

/** Runs fn inside a transaction (commits on success, rolls back on throw). Not re-entrant. */
export function transaction<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export const nowIso = () => new Date().toISOString();
