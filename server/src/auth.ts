import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { RequestHandler } from 'express';
import type { Role, User } from '../../shared/types.js';
import { get, run, nowIso, type UserRow } from './db.js';
import { HttpError } from './http.js';

const SESSION_DAYS = 30;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by requireAuth. */
      user?: UserRow;
    }
  }
}

/* Stored password format: "scrypt:<salt hex>:<hash hex>". */
const SALT_BYTES = 16;
const HASH_BYTES = 64;

const scryptAsync = promisify(crypto.scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

const formatHash = (salt: Buffer, hash: Buffer) => `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(SALT_BYTES);
  return formatHash(salt, crypto.scryptSync(password, salt, HASH_BYTES));
}

/**
 * Same result as hashPassword(), but runs on the libuv thread pool: hashing hundreds of temporary passwords
 * synchronously (bulk "Add students") would block the server for seconds.
 */
export async function hashPasswordAsync(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_BYTES);
  return formatHash(salt, await scryptAsync(password, salt, HASH_BYTES));
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split(':');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

/** Human-friendly temporary password, e.g. "maple-river-4821". */
export function generateTempPassword(): string {
  const words = [
    'maple', 'river', 'cedar', 'falcon', 'harbor', 'meadow', 'summit', 'canyon', 'willow', 'ember',
    'coral', 'glacier', 'orchid', 'pepper', 'quartz', 'raven', 'sierra', 'tundra', 'violet', 'zephyr',
  ];
  const pick = () => words[crypto.randomInt(words.length)];
  return `${pick()}-${pick()}-${crypto.randomInt(1000, 10000)}`;
}

export function createSession(userId: number): string {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000).toISOString();
  run('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', token, userId, nowIso(), expires);
  return token;
}

export function deleteSession(token: string): void {
  run('DELETE FROM sessions WHERE token = ?', token);
}

export function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}

export function toUser(row: UserRow): User {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    mustChangePassword: !!row.must_change_password,
    createdAt: row.created_at,
  };
}

/** Rejects with 401 unless a valid `Authorization: Bearer <token>` header is present; sets req.user. */
export const requireAuth: RequestHandler = (req, _res, next) => {
  const token = bearerToken(req.headers.authorization);
  if (!token) throw new HttpError(401, 'Please sign in.');
  const row = get<UserRow & { expires_at: string }>(
    `SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
    token,
  );
  // Unknown tokens include signed-out ones (logout deletes the session row).
  if (!row) throw new HttpError(401, 'Please sign in again.');
  if (row.expires_at < nowIso()) {
    deleteSession(token);
    throw new HttpError(401, 'Your session has expired. Please sign in again.');
  }
  const { expires_at: _expires, ...user } = row;
  req.user = user;
  next();
};

/** Use after requireAuth. */
export function requireRole(role: Role): RequestHandler {
  return (req, _res, next) => {
    if (req.user?.role !== role) throw new HttpError(403, `Only ${role}s can do that.`);
    next();
  };
}

/** The authenticated user (call only in handlers behind requireAuth). */
export function currentUser(req: { user?: UserRow }): UserRow {
  if (!req.user) throw new HttpError(401, 'Please sign in.');
  return req.user;
}
