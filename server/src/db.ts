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
    placeholder_name INTEGER NOT NULL DEFAULT 0
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
    created_at TEXT NOT NULL
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

  CREATE INDEX IF NOT EXISTS idx_submissions_assignment ON submissions(assignment_id, student_id);
  CREATE INDEX IF NOT EXISTS idx_assignments_class ON assignments(class_id);
  CREATE INDEX IF NOT EXISTS idx_enrollments_student ON enrollments(student_id);
`);

/** Brings databases created by older versions up to date (CREATE TABLE IF NOT EXISTS leaves them as they were). */
function addColumnIfMissing(table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// Existing accounts keep NULL: nobody is recorded as their creator.
addColumnIfMissing('users', 'created_by_teacher_id', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');
addColumnIfMissing('users', 'pending', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('users', 'placeholder_name', 'INTEGER NOT NULL DEFAULT 0');

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
