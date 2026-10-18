/** Small helpers shared by the assignment, submission and gradebook services. */

/** Rounds to 2 decimals (scores are stored and returned this way). */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Binds a list of ids as ONE SQL parameter, used as `IN (SELECT value FROM json_each(?))`. */
export function idList(ids: readonly number[]): string {
  return JSON.stringify(ids);
}

export interface Lateness {
  late: boolean;
  /** Whole seconds after the due date, rounded up so that any late submission reports at least 1. */
  lateBySeconds: number;
}

/** Computed live against the assignment's current due date, so moving the due date updates the flag. */
export function lateness(submittedAt: string, dueAt: string): Lateness {
  const diffMs = Date.parse(submittedAt) - Date.parse(dueAt);
  if (!(diffMs > 0)) return { late: false, lateBySeconds: 0 };
  return { late: true, lateBySeconds: Math.ceil(diffMs / 1000) };
}

export function isPastDue(dueAt: string, now = Date.now()): boolean {
  return Date.parse(dueAt) < now;
}

/** Formats a score for text output: 85, 85.5, 85.25 (no trailing zeros). */
export function formatScore(n: number): string {
  return String(round2(n));
}
