/**
 * Test-only helpers for the email tests. Nothing here imports db.ts, so it is safe to import before
 * startTestServer() (which sets DATA_DIR).
 */
import type { EmailOutboxRow } from '../../db.js';
import { localMoment } from './format.js';

/** A placeholder API token: tests use the memory transport, so nothing is sent anywhere. */
export const TEST_TOKEN = 'cf-test-token-7Q3xZ9pLm2';

/** Email on, through the memory transport, with fixed links and time zone. Call before the app is imported. */
export function useMemoryEmail(timeZone = 'America/Chicago'): void {
  process.env.EMAIL_TRANSPORT = 'memory';
  process.env.CLOUDFLARE_API_TOKEN = TEST_TOKEN;
  process.env.TIME_ZONE = timeZone;
  process.env.APP_URL = 'https://excel.school.test';
  delete process.env.EMAIL_FROM_NAME;
  delete process.env.EMAIL_FROM_ADDRESS;
}

export type OutboxRow = EmailOutboxRow;

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

/** The instant when the wall clock in `timeZone` shows `date` (YYYY-MM-DD) at `time` (HH:MM). */
export function zonedInstant(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const wanted = Date.UTC(y, m - 1, d, hh, mm);
  let guess = wanted;
  for (let i = 0; i < 3; i++) {
    const local = localMoment(new Date(guess), timeZone);
    const [ly, lm, ld] = local.date.split('-').map(Number);
    const [lh, lmin] = local.time.split(':').map(Number);
    guess -= Date.UTC(ly, lm - 1, ld, lh, lmin) - wanted;
  }
  return new Date(guess);
}

/** The local date (YYYY-MM-DD) `days` days from now in `timeZone`. */
export function localDateIn(days: number, timeZone: string): string {
  return localMoment(new Date(Date.now() + days * DAY_MS), timeZone).date;
}

/** Collects everything written through console.* while `fn` runs (and still prints nothing). */
export async function captureConsole<T>(fn: () => Promise<T> | T): Promise<{ result: T; output: string }> {
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const saved = methods.map((m) => console[m]);
  const lines: string[] = [];
  for (const m of methods) {
    console[m] = (...args: unknown[]) => {
      lines.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a))).join(' '));
    };
  }
  try {
    const result = await fn();
    return { result, output: lines.join('\n') };
  } finally {
    methods.forEach((m, i) => (console[m] = saved[i]));
  }
}
