import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTime);

/** "Oct 16, 2026, 4:30 PM" in the viewer's local time zone. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** "in 3 days" / "2 hours ago". */
export function fromNow(iso: string): string {
  return dayjs(iso).fromNow();
}

export function isPast(iso: string): boolean {
  return new Date(iso).getTime() < Date.now();
}

/** 93784 → "1 day 2 hours", 300 → "5 minutes", 20 → "less than a minute". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return 'less than a minute';
  const units: [number, string][] = [
    [86400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
  ];
  const parts: string[] = [];
  let rest = s;
  for (const [size, label] of units) {
    const n = Math.floor(rest / size);
    if (n > 0) {
      parts.push(`${n} ${label}${n === 1 ? '' : 's'}`);
      rest -= n * size;
    }
    if (parts.length === 2) break;
  }
  return parts.join(' ');
}

/** 12.5 → "12.5", 12 → "12", null → "—". */
export function formatScore(score: number | null | undefined): string {
  if (score === null || score === undefined) return '—';
  return Number.isInteger(score) ? String(score) : score.toFixed(2).replace(/0$/, '');
}

/** "8.5 / 10" */
export function formatScoreOf(score: number | null | undefined, points: number): string {
  return `${formatScore(score)} / ${formatScore(points)}`;
}

export function percent(score: number | null | undefined, points: number): number | null {
  if (score === null || score === undefined || points <= 0) return null;
  return Math.round((score / points) * 1000) / 10;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Mantine color for a percentage grade (fills: badges, progress bars, rings). */
export function scoreColor(pct: number | null): string {
  if (pct === null) return 'gray';
  if (pct >= 90) return 'teal';
  if (pct >= 70) return 'lime';
  if (pct >= 50) return 'yellow';
  return 'red';
}

/**
 * Text color for a percentage grade, same bands as scoreColor. The --score-text-* variables (global.css) keep at
 * least 4.5:1 contrast on cards, the page and the red late-row tint in both color schemes, which the light
 * Mantine shades (lime/yellow) don't.
 */
export function scoreTextColor(pct: number | null): string {
  if (pct === null) return 'var(--mantine-color-dimmed)';
  if (pct >= 90) return 'var(--score-text-high)';
  if (pct >= 70) return 'var(--score-text-good)';
  if (pct >= 50) return 'var(--score-text-fair)';
  return 'var(--score-text-low)';
}
