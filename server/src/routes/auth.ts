import crypto from 'node:crypto';
import { Router } from 'express';
import type { AuthResponse, OkResponse, RegisterRequest, User } from '../../../shared/types.js';
import {
  bearerToken,
  createSession,
  currentUser,
  deleteSession,
  hashPassword,
  requireAuth,
  toUser,
  verifyPassword,
} from '../auth.js';
import { all, get, nowIso, run, transaction, type UserRow } from '../db.js';
import { badRequest, HttpError } from '../http.js';
import {
  findUserByEmail,
  isValidEmail,
  jsonBody,
  NAME_MAX_LENGTH,
  normalizeEmail,
  validationError,
} from '../services/classes.js';

const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 200;
const INVALID_LOGIN = 'Incorrect email or password.';
const EMAIL_TAKEN = 'An account with this email already exists. Try signing in instead.';
const NEEDS_SIGNUP =
  "Your teacher added this email, but you haven't created your account yet. Choose “Create an account” and sign " +
  'up with this email.';
const INVITED_AS_STUDENT = 'A teacher added this email as a student. Sign up as a student to join your classes.';

const router = Router();

const text = (value: unknown) => (typeof value === 'string' ? value : '');

function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (password.length > PASSWORD_MAX_LENGTH) return `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`;
  return null;
}

function parseRegistration(body: Record<string, unknown>): RegisterRequest {
  const name = text(body.name).trim();
  const email = normalizeEmail(body.email);
  const password = text(body.password);
  const role = body.role;
  const fields: Record<string, string> = {};

  if (!name) fields.name = 'Enter your name.';
  else if (name.length > NAME_MAX_LENGTH) fields.name = `Name must be at most ${NAME_MAX_LENGTH} characters.`;
  if (!email) fields.email = 'Enter your email address.';
  else if (!isValidEmail(email)) fields.email = 'Enter a valid email address.';
  const problem = passwordProblem(password);
  if (problem) fields.password = problem;
  if (role !== 'teacher' && role !== 'student') fields.role = 'Choose whether you are a teacher or a student.';

  if (Object.keys(fields).length > 0) throw validationError(fields);
  return { name, email, password, role: role as RegisterRequest['role'] };
}

function loadUser(id: number): UserRow {
  return get<UserRow>('SELECT * FROM users WHERE id = ?', id)!;
}

function authResponse(user: UserRow): AuthResponse {
  return { token: createSession(user.id), user: toUser(user) };
}

/** Hash of a random string, so failed logins for unknown emails cost as much as wrong passwords. */
let timingHash: string | undefined;
function spendHashTime(password: string): void {
  timingHash ??= hashPassword(crypto.randomUUID());
  verifyPassword(password, timingHash);
}

/** Names of the classes the student is enrolled in, in the order they were added. */
function classNames(studentId: number): string[] {
  return all<{ name: string }>(
    `SELECT c.name FROM enrollments e JOIN classes c ON c.id = e.class_id
     WHERE e.student_id = ? ORDER BY e.joined_at, c.id`,
    studentId,
  ).map((row) => row.name);
}

/**
 * The sign-up of a student a teacher added by email: takes over the pending account (with its enrollments and the
 * submissions the teacher uploaded) instead of creating a new one. The teacher's name for the student is kept unless
 * it was made up from the email. The account now has a password only the student knows, so the inviting teacher
 * stops being its creator: from here on the inviter may reset the password only like any other teacher (when the
 * student is in no other teacher's class), never take over an account another teacher's class depends on.
 */
function claimPendingAccount(pendingId: number, input: RegisterRequest): AuthResponse {
  const hash = hashPassword(input.password);
  return transaction(() => {
    // Re-checked here so the account can only be claimed once.
    const { changes } = run(
      `UPDATE users SET password_hash = ?, pending = 0, must_change_password = 0, placeholder_name = 0,
         created_by_teacher_id = NULL, name = CASE WHEN placeholder_name = 1 THEN ? ELSE name END
       WHERE id = ? AND pending = 1 AND role = 'student'`,
      hash,
      input.name,
      pendingId,
    );
    if (changes === 0) throw new HttpError(409, EMAIL_TAKEN, { email: EMAIL_TAKEN });
    return { ...authResponse(loadUser(pendingId)), claimedClasses: classNames(pendingId) };
  });
}

router.post('/api/auth/register', (req, res) => {
  const input = parseRegistration(jsonBody(req));
  const existing = findUserByEmail(input.email);
  if (existing?.pending) {
    if (input.role !== 'student') throw new HttpError(409, INVITED_AS_STUDENT, { email: INVITED_AS_STUDENT });
    const claimed: AuthResponse = claimPendingAccount(existing.id, input);
    res.status(201).json(claimed);
    return;
  }
  if (existing) throw new HttpError(409, EMAIL_TAKEN, { email: EMAIL_TAKEN });

  const { lastInsertRowid } = run(
    `INSERT INTO users (email, name, password_hash, role, must_change_password, created_at)
     VALUES (?, ?, ?, ?, 0, ?)`,
    input.email,
    input.name,
    hashPassword(input.password),
    input.role,
    nowIso(),
  );
  const body: AuthResponse = authResponse(loadUser(lastInsertRowid));
  res.status(201).json(body);
});

router.post('/api/auth/login', (req, res) => {
  const body = jsonBody(req);
  const email = normalizeEmail(body.email);
  const password = text(body.password);
  const fields: Record<string, string> = {};
  if (!email) fields.email = 'Enter your email address.';
  if (!password) fields.password = 'Enter your password.';
  if (Object.keys(fields).length > 0) throw validationError(fields);

  const user = findUserByEmail(email);
  if (!user) {
    spendHashTime(password);
    throw new HttpError(401, INVALID_LOGIN);
  }
  // A pending account has no password to check; the student has to sign up first.
  if (user.pending) throw new HttpError(401, NEEDS_SIGNUP, { email: NEEDS_SIGNUP }, 'needs_signup');
  if (!verifyPassword(password, user.password_hash)) throw new HttpError(401, INVALID_LOGIN);

  run('DELETE FROM sessions WHERE user_id = ? AND expires_at < ?', user.id, nowIso());
  const response: AuthResponse = authResponse(user);
  res.json(response);
});

router.post('/api/auth/logout', requireAuth, (req, res) => {
  const token = bearerToken(req.headers.authorization);
  if (token) deleteSession(token);
  const body: OkResponse = { ok: true };
  res.json(body);
});

router.get('/api/auth/me', requireAuth, (req, res) => {
  const body: { user: User } = { user: toUser(currentUser(req)) };
  res.json(body);
});

/** Also signs the user out of every other session (this one stays signed in). */
router.post('/api/auth/change-password', requireAuth, (req, res) => {
  const user = currentUser(req);
  const body = jsonBody(req);
  const currentPassword = text(body.currentPassword);
  const newPassword = text(body.newPassword);
  const fields: Record<string, string> = {};
  if (!currentPassword) fields.currentPassword = 'Enter your current password.';
  const problem = passwordProblem(newPassword);
  if (problem) fields.newPassword = problem;
  if (Object.keys(fields).length > 0) throw validationError(fields);

  if (!verifyPassword(currentPassword, user.password_hash)) {
    const message = 'Your current password is incorrect.';
    throw badRequest(message, { currentPassword: message });
  }
  if (newPassword === currentPassword) {
    const message = 'Choose a new password that is different from your current one.';
    throw badRequest(message, { newPassword: message });
  }

  const hash = hashPassword(newPassword);
  const token = bearerToken(req.headers.authorization) ?? '';
  transaction(() => {
    run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', hash, user.id);
    run('DELETE FROM sessions WHERE user_id = ? AND token <> ?', user.id, token);
  });
  const response: { user: User } = { user: toUser(loadUser(user.id)) };
  res.json(response);
});

export default router;
