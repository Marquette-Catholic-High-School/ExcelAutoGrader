/** Text helpers for emails: HTML escaping, header-safe text, and dates/durations in the server's time zone. */
import { formatScore } from '../common.js';

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

/**
 * Text that is safe in a header (subject, display name): control characters (CR/LF included) become spaces, runs of
 * whitespace collapse, and the result is cut to `max` characters.
 */
export function cleanHeaderText(value: string, max = 200): string {
  const clean = value
    .replace(/[\p{Cc}\u2028\u2029]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/** "2 days 3 hours", "45 minutes", "less than a minute": the two largest units, rounded down. */
export function formatDuration(seconds: number): string {
  const units: [string, number][] = [
    ['day', 86_400],
    ['hour', 3600],
    ['minute', 60],
  ];
  const parts: string[] = [];
  let rest = Math.max(0, Math.floor(seconds));
  for (const [name, size] of units) {
    const n = Math.floor(rest / size);
    rest -= n * size;
    if (n > 0) parts.push(`${n} ${name}${n === 1 ? '' : 's'}`);
    else if (parts.length > 0) break;
    if (parts.length === 2) break;
  }
  return parts.length > 0 ? parts.join(' ') : 'less than a minute';
}

/** Some ICU versions put narrow no-break spaces before AM/PM; plain spaces read the same in every mail app. */
const plainSpaces = (text: string) => text.replace(/[\u00a0\u202f]/g, ' ');

/** "Tue, Nov 10, 3:05 PM CST" in the given IANA time zone. */
export function formatDateTime(iso: string | Date, timeZone: string): string {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  return plainSpaces(format.format(new Date(iso)));
}

/** "Tue, Nov 10" in the given time zone. */
export function formatDate(iso: string | Date, timeZone: string): string {
  const format = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' });
  return plainSpaces(format.format(new Date(iso)));
}

export interface LocalMoment {
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM, 24-hour */
  time: string;
}

/** The calendar date and wall-clock time of `at` in the given time zone. */
export function localMoment(at: Date, timeZone: string): LocalMoment {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '00';
  return { date: `${part('year')}-${part('month')}-${part('day')}`, time: `${part('hour')}:${part('minute')}` };
}

/** "18 / 20 (90%)" */
export function formatScoreOf(score: number, points: number): string {
  const percent = points > 0 ? Math.round((score / points) * 100) : 0;
  return `${formatScore(score)} / ${formatScore(points)} (${percent}%)`;
}
