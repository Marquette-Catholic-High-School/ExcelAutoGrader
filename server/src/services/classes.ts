/**
 * Classes, join codes, class rosters and the account helpers they share with routes/auth.ts
 * (email normalization and validation, request body parsing).
 */
import crypto from 'node:crypto';
import type { Request } from 'express';
import type { AddedStudentResult, AddStudentsResponse, ClassSummary, StudentInfo } from '../../../shared/types.js';
import { generateTempPassword, hashPassword, hashPasswordAsync } from '../auth.js';
import { all, get, nowIso, run, transaction, type ClassRow, type UserRow } from '../db.js';
import { badRequest, notFound, type HttpError } from '../http.js';
import { deleteFile } from '../uploads.js';

/* ------------------------------------------------------------------ */
/* Input helpers                                                      */
/* ------------------------------------------------------------------ */

export const NAME_MAX_LENGTH = 100;
export const CLASS_DESCRIPTION_MAX_LENGTH = 2000;
export const MAX_STUDENTS_PER_REQUEST = 500;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trimmed, lower-cased email ('' for non-strings). */
export function normalizeEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function isValidEmail(email: string): boolean {
  return email.length <= 254 && EMAIL_PATTERN.test(email);
}

/** The parsed JSON body as a plain object (empty when missing or not an object). */
export function jsonBody(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

/** 400 with field messages; the top-level message is the field's own text when only one field failed. */
export function validationError(fields: Record<string, string>): HttpError {
  const messages = Object.values(fields);
  return badRequest(messages.length === 1 ? messages[0] : 'Please fix the highlighted fields.', fields);
}

export function findUserByEmail(email: string): UserRow | undefined {
  return get<UserRow>('SELECT * FROM users WHERE email = ?', email);
}

/* ------------------------------------------------------------------ */
/* Join codes                                                         */
/* ------------------------------------------------------------------ */

/** No 0/O or 1/I, so codes read unambiguously off a projector. */
export const JOIN_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const JOIN_CODE_LENGTH = 6;

export function randomJoinCode(): string {
  let code = '';
  for (let i = 0; i < JOIN_CODE_LENGTH; i++) {
    code += JOIN_CODE_ALPHABET[crypto.randomInt(JOIN_CODE_ALPHABET.length)];
  }
  return code;
}

/** A code no class uses yet. `generate` is injectable for tests. */
export function uniqueJoinCode(generate: () => string = randomJoinCode): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    const code = generate();
    if (!get('SELECT 1 FROM classes WHERE join_code = ?', code)) return code;
  }
  throw new Error('Could not generate a unique join code.');
}

/** Codes are matched case-insensitively; spaces and dashes students type are ignored. */
export function normalizeJoinCode(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\s-]/g, '').toUpperCase() : '';
}

/* ------------------------------------------------------------------ */
/* Class summaries                                                    */
/* ------------------------------------------------------------------ */

interface ClassSummaryRow extends ClassRow {
  teacher_name: string;
  student_count: number;
  assignment_count: number;
}

const SUMMARY_SQL = `
  SELECT c.*, t.name AS teacher_name,
    (SELECT COUNT(*) FROM enrollments e WHERE e.class_id = c.id) AS student_count,
    (SELECT COUNT(*) FROM assignments a WHERE a.class_id = c.id) AS assignment_count
  FROM classes c
  JOIN users t ON t.id = c.teacher_id`;

function toClassSummary(row: ClassSummaryRow, viewer: UserRow): ClassSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    teacherId: row.teacher_id,
    teacherName: row.teacher_name,
    ...(row.teacher_id === viewer.id ? { joinCode: row.join_code } : {}),
    studentCount: Number(row.student_count),
    assignmentCount: Number(row.assignment_count),
    createdAt: row.created_at,
  };
}

/** Summary as seen by `viewer` (the join code is only included for the owning teacher). */
export function classSummary(classId: number, viewer: UserRow): ClassSummary {
  const row = get<ClassSummaryRow>(`${SUMMARY_SQL} WHERE c.id = ?`, classId);
  if (!row) throw notFound('Class not found.');
  return toClassSummary(row, viewer);
}

/** Teachers: classes they own, newest first. Students: classes they are enrolled in, most recently joined first. */
export function listClassSummaries(viewer: UserRow): ClassSummary[] {
  const rows =
    viewer.role === 'teacher'
      ? all<ClassSummaryRow>(`${SUMMARY_SQL} WHERE c.teacher_id = ? ORDER BY c.created_at DESC, c.id DESC`, viewer.id)
      : all<ClassSummaryRow>(
          `${SUMMARY_SQL}
           JOIN enrollments mine ON mine.class_id = c.id AND mine.student_id = ?
           ORDER BY mine.joined_at DESC, c.id DESC`,
          viewer.id,
        );
  return rows.map((row) => toClassSummary(row, viewer));
}

export function createClass(teacherId: number, name: string, description: string): number {
  return run(
    'INSERT INTO classes (teacher_id, name, description, join_code, created_at) VALUES (?, ?, ?, ?, ?)',
    teacherId,
    name,
    description,
    uniqueJoinCode(),
    nowIso(),
  ).lastInsertRowid;
}

const CLASS_FILE_IDS_SQL = `
  SELECT key_file_id AS id FROM assignments WHERE class_id = ? AND key_file_id IS NOT NULL
  UNION
  SELECT template_file_id FROM assignments WHERE class_id = ? AND template_file_id IS NOT NULL
  UNION
  SELECT s.file_id FROM submissions s JOIN assignments a ON a.id = s.assignment_id WHERE a.class_id = ?`;

/** Deletes the class (rows cascade to enrollments, assignments and submissions), then its stored files. */
export function deleteClassAndFiles(classId: number): void {
  const fileIds = transaction(() => {
    const ids = all<{ id: number }>(CLASS_FILE_IDS_SQL, classId, classId, classId).map((r) => r.id);
    run('DELETE FROM classes WHERE id = ?', classId);
    return ids;
  });
  for (const id of fileIds) {
    try {
      deleteFile(id);
    } catch (err) {
      // The class is already gone; a leftover file must not turn the delete into an error for the teacher.
      console.warn(`Could not delete stored file ${id} of deleted class ${classId}:`, err);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Roster                                                             */
/* ------------------------------------------------------------------ */

/**
 * SQL condition (0/1) for the reset-password rule in docs/API.md: the teacher whose id is the SQL expression
 * `teacherId` may manage the password of student `u` when they created the account through Add students, or
 * when `u` is in no class owned by a different teacher. Anyone can register as a teacher and enroll an
 * existing student by email, so enrollment alone must never be enough to take over an account that another
 * teacher's class depends on.
 */
function managesPasswordSql(teacherId: string): string {
  return `(u.created_by_teacher_id IS ${teacherId} OR NOT EXISTS (
    SELECT 1 FROM enrollments other_e JOIN classes other_c ON other_c.id = other_e.class_id
    WHERE other_e.student_id = u.id AND other_c.teacher_id <> ${teacherId}))`;
}

/** Whether the teacher may reset this student's password (see managesPasswordSql). */
export function canManageStudentPassword(teacherId: number, studentId: number): boolean {
  const row = get<{ allowed: number }>(
    `SELECT ${managesPasswordSql('t.id')} AS allowed FROM users u JOIN users t ON t.id = ? WHERE u.id = ?`,
    teacherId,
    studentId,
  );
  return !!row?.allowed;
}

interface RosterRow {
  id: number;
  name: string;
  email: string;
  must_change_password: number;
  joined_at: string;
  can_reset_password: number;
}

/** Roster rows as the class's own teacher sees them (with canResetPassword), in one query per roster. */
const ROSTER_SQL = `
  SELECT u.id, u.name, u.email, u.must_change_password, e.joined_at,
    ${managesPasswordSql('c.teacher_id')} AS can_reset_password
  FROM enrollments e
  JOIN classes c ON c.id = e.class_id
  JOIN users u ON u.id = e.student_id`;

function toRosterStudent(row: RosterRow): StudentInfo {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    joinedAt: row.joined_at,
    mustChangePassword: !!row.must_change_password,
    canResetPassword: !!row.can_reset_password,
  };
}

/** Enrolled students sorted by name, for the class's teacher. */
export function listStudents(classId: number): StudentInfo[] {
  return all<RosterRow>(`${ROSTER_SQL} WHERE e.class_id = ? ORDER BY u.name COLLATE NOCASE, u.email`, classId).map(
    toRosterStudent,
  );
}

/** The student (as a roster row for the class's teacher) if enrolled in the class, else undefined. */
export function enrolledStudent(classId: number, studentId: number): StudentInfo | undefined {
  const row = get<RosterRow>(`${ROSTER_SQL} WHERE e.class_id = ? AND e.student_id = ?`, classId, studentId);
  return row && toRosterStudent(row);
}

/** Idempotent; returns true if the student was newly enrolled. */
export function enroll(classId: number, studentId: number): boolean {
  const { changes } = run(
    'INSERT OR IGNORE INTO enrollments (class_id, student_id, joined_at) VALUES (?, ?, ?)',
    classId,
    studentId,
    nowIso(),
  );
  return changes > 0;
}

/** Un-enrolls only; the student's account and submissions are kept. Returns false if they were not enrolled. */
export function unenroll(classId: number, studentId: number): boolean {
  return run('DELETE FROM enrollments WHERE class_id = ? AND student_id = ?', classId, studentId).changes > 0;
}

/** New temporary password the student must change at next sign-in; signs them out everywhere. */
export function resetStudentPassword(studentId: number): string {
  const tempPassword = generateTempPassword();
  const hash = hashPassword(tempPassword);
  transaction(() => {
    run('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?', hash, studentId);
    run('DELETE FROM sessions WHERE user_id = ?', studentId);
  });
  return tempPassword;
}

/* Bulk add */

interface Credentials {
  tempPassword: string;
  hash: string;
}

interface RosterEntry {
  name: string;
  email: string;
  /** Set when the row cannot be added no matter what is in the database. */
  problem?: string;
  /** Pre-computed for rows that had no account when the request started. */
  credentials?: Credentials;
}

type RosterError = AddStudentsResponse['errors'][number];

async function newCredentials(): Promise<Credentials> {
  const tempPassword = generateTempPassword();
  return { tempPassword, hash: await hashPasswordAsync(tempPassword) };
}

function syncCredentials(): Credentials {
  const tempPassword = generateTempPassword();
  return { tempPassword, hash: hashPassword(tempPassword) };
}

/** Normalizes rows, drops blank ones, merges duplicate emails into their first row and flags invalid rows. */
function parseRoster(rows: unknown[]): RosterEntry[] {
  const entries: RosterEntry[] = [];
  const byEmail = new Map<string, RosterEntry>();
  for (const raw of rows) {
    const row = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    const email = normalizeEmail(row.email);
    if (!name && !email) continue;

    let problem: string | undefined;
    if (!email) problem = 'Email is required.';
    else if (!isValidEmail(email)) problem = 'Not a valid email address.';
    else if (name.length > NAME_MAX_LENGTH) problem = `Name must be at most ${NAME_MAX_LENGTH} characters.`;
    if (problem) {
      entries.push({ name, email, problem });
      continue;
    }

    const seen = byEmail.get(email);
    if (seen) {
      if (!seen.name) seen.name = name;
      continue;
    }
    const entry: RosterEntry = { name, email };
    byEmail.set(email, entry);
    entries.push(entry);
  }
  return entries;
}

/**
 * Runs inside the transaction. Returns the result, or an error message for the row. New accounts record the
 * class's teacher as their creator, which lets that teacher reset the password later (canManageStudentPassword).
 */
function addEntry(cls: ClassRow, entry: RosterEntry): AddedStudentResult | string {
  let user = findUserByEmail(entry.email);
  if (user?.role === 'teacher') return 'This email belongs to a teacher account.';

  let tempPassword: string | undefined;
  if (!user) {
    if (!entry.name) return 'Enter a name to create a new student account.';
    // credentials are only missing if an account for this email disappeared since the request started.
    const credentials = entry.credentials ?? syncCredentials();
    tempPassword = credentials.tempPassword;
    const { lastInsertRowid } = run(
      `INSERT INTO users (email, name, password_hash, role, must_change_password, created_at, created_by_teacher_id)
       VALUES (?, ?, ?, 'student', 1, ?, ?)`,
      entry.email,
      entry.name,
      credentials.hash,
      nowIso(),
      cls.teacher_id,
    );
    user = get<UserRow>('SELECT * FROM users WHERE id = ?', lastInsertRowid)!;
  }

  const newlyEnrolled = enroll(cls.id, user.id);
  return {
    student: enrolledStudent(cls.id, user.id)!,
    created: tempPassword !== undefined,
    ...(tempPassword !== undefined ? { tempPassword } : {}),
    alreadyEnrolled: !newlyEnrolled,
  };
}

/**
 * Creates accounts for new emails (temporary password, must change it at first sign-in, created by the class's
 * teacher), enrolls existing student accounts, and reports invalid rows and teacher emails in `errors`.
 * All-or-nothing. Both lists keep the order of the request.
 */
export async function addStudents(classId: number, rows: unknown[]): Promise<AddStudentsResponse> {
  const entries = parseRoster(rows);
  if (entries.length === 0) {
    throw badRequest('Add at least one student with an email address.', { students: 'Add at least one student.' });
  }

  // Hash outside the transaction (it has to be synchronous). addEntry re-checks every email inside it.
  await Promise.all(
    entries
      .filter((entry) => !entry.problem && entry.name && !findUserByEmail(entry.email))
      .map(async (entry) => {
        entry.credentials = await newCredentials();
      }),
  );

  return transaction(() => {
    const cls = get<ClassRow>('SELECT * FROM classes WHERE id = ?', classId);
    if (!cls) throw notFound('Class not found.');
    const added: AddedStudentResult[] = [];
    const errors: RosterError[] = [];
    for (const entry of entries) {
      const result = entry.problem ?? addEntry(cls, entry);
      if (typeof result === 'string') errors.push({ email: entry.email, name: entry.name, error: result });
      else added.push(result);
    }
    return { added, errors };
  });
}
