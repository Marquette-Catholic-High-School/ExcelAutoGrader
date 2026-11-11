/** Stored email settings (classes.notification_settings, users.notification_settings) read with their defaults. */
import {
  DEFAULT_CLASS_NOTIFICATION_SETTINGS,
  type ClassNotificationSettings,
  type MyNotificationSettings,
} from '../../../../shared/types.js';
import type { ClassRow, UserRow } from '../../db.js';

export type StoredClassSettings = Omit<ClassNotificationSettings, 'remindersSince'>;

export const CLASS_LIMITS = {
  firstReminderAfterHours: { min: 0, max: 168, unit: 'hours' },
  reminderIntervalDays: { min: 1, max: 14, unit: 'days' },
  maxReminders: { min: 1, max: 10, unit: 'reminders' },
} as const;

export const CLASS_FLAGS = ['submissionReceipts', 'overdueReminders', 'includePendingStudents'] as const;

type LimitKey = keyof typeof CLASS_LIMITS;
export type Limit = (typeof CLASS_LIMITS)[LimitKey];

export const limitEntries = () => Object.entries(CLASS_LIMITS) as [LimitKey, Limit][];

export function inRange(value: unknown, { min, max }: Limit): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

export function parseJsonObject(text: string | null): Record<string, unknown> {
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Stored values over the defaults; anything stored that is no longer valid falls back to its default. */
export function storedClassSettings(cls: Pick<ClassRow, 'notification_settings'>): StoredClassSettings {
  const stored = parseJsonObject(cls.notification_settings);
  const settings: StoredClassSettings = { ...DEFAULT_CLASS_NOTIFICATION_SETTINGS };
  for (const key of CLASS_FLAGS) if (typeof stored[key] === 'boolean') settings[key] = stored[key];
  for (const [key, limit] of limitEntries()) if (inRange(stored[key], limit)) settings[key] = stored[key];
  return settings;
}

export type TeacherSettings = Pick<MyNotificationSettings, 'dailyReport' | 'dailyReportTime' | 'skipEmptyReports'>;

export const DEFAULT_TEACHER_SETTINGS: TeacherSettings = {
  dailyReport: true,
  dailyReportTime: '07:00',
  skipEmptyReports: false,
};

/** "7:05" or "07:05" → "07:05"; null when not a 24-hour time. */
export function parseTime(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  return match ? `${match[1].padStart(2, '0')}:${match[2]}` : null;
}

export function teacherSettings(user: Pick<UserRow, 'notification_settings'>): TeacherSettings {
  const stored = parseJsonObject(user.notification_settings);
  const flag = (key: 'dailyReport' | 'skipEmptyReports') =>
    typeof stored[key] === 'boolean' ? stored[key] : DEFAULT_TEACHER_SETTINGS[key];
  return {
    dailyReport: flag('dailyReport'),
    dailyReportTime: parseTime(stored.dailyReportTime) ?? DEFAULT_TEACHER_SETTINGS.dailyReportTime,
    skipEmptyReports: flag('skipEmptyReports'),
  };
}
