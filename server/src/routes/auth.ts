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
import { get, nowIso, run, transaction, type UserRow } from '../db.js';
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

router.post('/api/auth/register', (req, res) => {
  const input = parseRegistration(jsonBody(req));
  if (findUserByEmail(input.email)) throw new HttpError(409, EMAIL_TAKEN, { email: EMAIL_TAKEN });

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
