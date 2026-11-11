/** Text formatting for the PDF reports: dates in the server's time zone, durations, scores and percentages. */
import { formatScore, round2 } from '../common.js';

function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** TIME_ZONE (an IANA name such as "America/Chicago") when it is valid, else the computer's own time zone. */
export function reportTimeZone(): string {
  const configured = process.env.TIME_ZONE?.trim();
  if (configured && isValidTimeZone(configured)) return configured;
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Formatters for one report, so every date in it uses the same time zone. */
export interface DateFormats {
  /** "Oct 16, 2026" */
  date(iso: string | Date): string;
  /** "Oct 16" */
  shortDate(iso: string | Date): string;
  /** "Oct 16, 2026, 9:00 PM" */
  dateTime(iso: string | Date): string;
  /** "Oct 16, 9:00 PM" (the year is left out; reports cover one school year) */
  shortDateTime(iso: string | Date): string;
  /** "Nov 10, 2026, 10:04 PM CST" */
  generated(at: Date): string;
}

export function dateFormats(timeZone = reportTimeZone()): DateFormats {
  const make = (options: Intl.DateTimeFormatOptions) => {
    const format = new Intl.DateTimeFormat('en-US', { timeZone, ...options });
    return (value: string | Date) => format.format(typeof value === 'string' ? new Date(value) : value);
  };
  const day = { month: 'short', day: 'numeric' } as const;
  const time = { hour: 'numeric', minute: '2-digit' } as const;
  return {
    date: make({ ...day, year: 'numeric' }),
    shortDate: make(day),
    dateTime: make({ ...day, year: 'numeric', ...time }),
    shortDateTime: make({ ...day, ...time }),
    generated: make({ ...day, year: 'numeric', ...time, timeZoneName: 'short' }),
  };
}

/** How late or overdue, rounded to two units: "45 sec", "3 min", "5 h 20 min", "2 d 3 h". */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`;
}

/** score / points as a percentage number rounded to 1 decimal (85.25 of 100 → 85.3). */
export function percentOf(score: number, points: number): number {
  return points > 0 ? Math.round((score / points) * 1000) / 10 : 0;
}

/** "85%", "85.3%" */
export function formatPercent(percent: number): string {
  return `${round2(percent)}%`;
}

/** "42.5 / 50" */
export function scoreOutOf(score: number, points: number): string {
  return `${formatScore(score)} / ${formatScore(points)}`;
}

/** "1 student", "3 students" */
export function plural(count: number, word: string, pluralWord = `${word}s`): string {
  return `${count} ${count === 1 ? word : pluralWord}`;
}

/** Shortens text to `max` characters with an ellipsis (for narrow table headers). */
export function truncate(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}
