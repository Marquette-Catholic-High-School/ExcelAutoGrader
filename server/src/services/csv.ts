/** Minimal RFC 4180 CSV writer, safe to open in Excel. */

/**
 * Text that Excel would run as a formula when it starts with = + - @ (or a tab/CR). Such cells are
 * prefixed with an apostrophe so a student named "=HYPERLINK(...)" cannot inject a formula into the export.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

export type CsvValue = string | number | null | undefined;

export function csvField(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (typeof value === 'string' && FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** CRLF line endings plus a UTF-8 byte-order mark so Excel shows accented names correctly. */
export function toCsv(rows: readonly (readonly CsvValue[])[]): string {
  return '﻿' + rows.map((row) => row.map(csvField).join(',')).join('\r\n') + '\r\n';
}

/** A safe download filename: no path separators, reserved or control characters. */
export function safeFileName(name: string, fallback = 'export'): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
    .replace(/^\.+/, '')
    .trim();
  return cleaned || fallback;
}
