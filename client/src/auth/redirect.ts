/** Where to send a user after signing in (or after replacing a temporary password). Used by the route guards. */
import type { Role, User } from '@shared/types';

export function homeFor(role: Role): string {
  return role === 'teacher' ? '/teacher' : '/student';
}

/**
 * Only follow in-app paths the route guard stored, never other auth pages, and never the other role's area
 * (after signing out, the guard remembers the previous user's page).
 */
export function safeFrom(state: unknown, user: User): string | null {
  const from = (state as { from?: unknown } | null)?.from;
  if (typeof from !== 'string' || !from.startsWith('/') || from.startsWith('//')) return null;
  if (from === '/' || from.startsWith('/login') || from.startsWith('/register')) return null;
  const otherArea = user.role === 'teacher' ? '/student' : '/teacher';
  if (from === otherArea || from.startsWith(`${otherArea}/`)) return null;
  return from;
}

/**
 * The page the user was trying to open, else /account for a temporary password, else their dashboard.
 * A temporary-password user who had a page in mind is sent there and the guard bounces them to /account,
 * which remembers that page for after the password change.
 */
export function postSignInPath(state: unknown, user: User): string {
  return safeFrom(state, user) ?? (user.mustChangePassword ? '/account' : homeFor(user.role));
}
