/**
 * Uploaded class rosters (POST /api/classes/:classId/students/import-preview): reads the first sheet of a CSV, Excel
 * or OpenDocument file, finds the header row and the email and name columns (docs/API.md, "import-preview"), and
 * tells for every row what Add students would do with it. Nothing is saved: the client sends the rows back to
 * POST /api/classes/:classId/students.
 */
import type { RosterPreview, RosterPreviewRow } from '../../../shared/types.js';
import { all } from '../db.js';
import { readFirstSheetText, WorkbookReadError } from '../grader/index.js';
import { badRequest } from '../http.js';
import {
  isValidEmail,
  MAX_STUDENTS_PER_REQUEST,
  normalizeEmail,
  rosterRowProblem,
  TEACHER_EMAIL_PROBLEM,
} from './classes.js';

/** Columns further right are ignored (rosters keep names and emails near the left). */
const MAX_COLUMNS = 100;
/** The header row must be among this many non-empty rows at the top (title rows may come first). */
const HEADER_SEARCH_ROWS = 20;
/** How many repeated emails a warning lists by name. */
const LISTED_DUPLICATES = 5;

const NO_EMAIL_COLUMN =
  "Couldn't find a column of email addresses in this file. Add a column named \"Email\" with each student's " +
  'email address, or a column that holds only email addresses.';
const otherPersonEmails = (heading: string) =>
  `The only email column in this file, “${heading}”, looks like parents’ or other people’s addresses, ` +
  'not the students’ own. Add a column named "Email" with each student\'s email address.';

type Grid = string[][];

interface RosterColumns {
  email: number;
  /** One column with the whole name ("Ada Lovelace" or "Lovelace, Ada"). */
  full?: number;
  first?: number;
  last?: number;
}

/* ------------------------------------------------------------------ */
/* Recognizing headers and values                                     */
/* ------------------------------------------------------------------ */

/** Lower-case words of a header: "Student_First-Name" → "student first name". */
const headerWords = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Columns about someone other than the student (a parent's email, the teacher's name, ...). */
const OTHER_PERSON = /\b(parent|parents|guardian|mother|father|teacher|instructor|contact|emergency)\b/;

/** "Email", "E-mail", "Student_Email", "StudentEmail", "Mail"; not "Mailing Address" or an address itself. */
const isEmailHeader = (text: string) => !text.includes('@') && /e ?mail|\bmail\b/.test(headerWords(text));
const isFirstNameHeader = (words: string) => /\b(first|given|forename|firstname|givenname)\b/.test(words);
const isLastNameHeader = (words: string) =>
  /\b(last|surname|family|lastname|familyname)\b/.test(words) &&
  !/\b(login|modified|updated|seen|activity|access|accessed|date|time|submitted)\b/.test(words);
const isFullNameHeader = (words: string) =>
  /^(students?|learners?|pupils?)$/.test(words) ||
  // One-word "Last First" headings, e.g. PowerSchool's "LastFirst" ("Doe, Jane").
  /\b(lastfirst|firstlast)(name)?\b/.test(words) ||
  (/\b(name|fullname|studentname|displayname)\b/.test(words) &&
    !/\b(user|login|account|class|course|section|school|file|middle|nick|preferred)\b/.test(words));

/** "Jane Doe <jane@school.edu>" (as copied from an email client) → name and address; null for other cells. */
function splitAddress(text: string): { name: string; address: string } | null {
  const match = /^(.*?)\s*<\s*([^<>\s]+@[^<>\s]+?)\s*>$/.exec(text.trim());
  return match ? { name: match[1].replace(/^["']+|["']+$/g, '').trim(), address: match[2] } : null;
}

/**
 * The email address in a cell ("mailto:" links and "Name <address>" included), normalized, or '' when the cell holds
 * none.
 */
function cellEmail(text: string): string {
  const email = normalizeEmail((splitAddress(text)?.address ?? text).replace(/^mailto:/i, ''));
  return isValidEmail(email) ? email : '';
}

const looksLikeName = (text: string) => /\p{L}/u.test(text) && !text.includes('@');

/** "C" for index 2, "AA" for 26. */
function columnLetter(index: number): string {
  let letters = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  }
  return letters;
}

/** Whitespace collapsed; control characters (e.g. from a CSV in an unexpected encoding) removed. */
const cleanName = (text: string) =>
  text
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** "Lovelace, Ada" → "Ada Lovelace" (one comma only), cleaned. */
function displayName(text: string): string {
  const parts = text.split(',');
  return cleanName(parts.length === 2 && parts[0].trim() && parts[1].trim() ? `${parts[1]} ${parts[0]}` : text);
}

/* ------------------------------------------------------------------ */
/* Finding the header row and the columns                             */
/* ------------------------------------------------------------------ */

const isBlankRow = (row: string[] | undefined) => !row || row.every((cell) => !cell);

/**
 * The header row: among the first non-empty rows, and before any row holding an email address (which is data), the
 * first with an email header, or else the first with a name header and at least one other heading. null when the
 * file has no header row.
 */
function findHeaderRow(grid: Grid): number | null {
  const candidates: number[] = [];
  for (let r = 0; r < grid.length && candidates.length < HEADER_SEARCH_ROWS; r++) {
    const row = grid[r];
    if (isBlankRow(row)) continue;
    if (row.some((cell) => cellEmail(cell))) break;
    candidates.push(r);
  }
  const withEmailHeader = candidates.find((r) => grid[r].some(isEmailHeader));
  if (withEmailHeader !== undefined) return withEmailHeader;
  const withNameHeader = candidates.find((r) => {
    const headings = grid[r].filter(Boolean).map(headerWords);
    return headings.length >= 2 && headings.some((h) => isFullNameHeader(h) || isFirstNameHeader(h));
  });
  return withNameHeader ?? null;
}

/** How many data cells of each column hold an email address. */
function emailCounts(grid: Grid, dataStart: number): number[] {
  const counts: number[] = [];
  for (let r = dataStart; r < grid.length; r++) {
    (grid[r] ?? []).forEach((cell, c) => {
      if (cellEmail(cell)) counts[c] = (counts[c] ?? 0) + 1;
    });
  }
  return counts;
}

/** Index of the largest count among `columns` (the leftmost on ties); undefined when every count is 0. */
function mostFilled(columns: number[], counts: number[]): number | undefined {
  let best: number | undefined;
  for (const c of columns) {
    if ((counts[c] ?? 0) > 0 && (best === undefined || (counts[c] ?? 0) > (counts[best] ?? 0))) best = c;
  }
  return best;
}

/**
 * The email column: a column headed like "Email" (the one holding the most addresses when there are several), or
 * else the column holding the most email addresses. Columns headed as someone else's ("Parent Email") are never
 * used: inviting a parent as a student would let them sign up as the student, and siblings sharing a parent's
 * address would be merged. Throws 400 when such columns are the only ones with addresses.
 */
function findEmailColumn(grid: Grid, header: string[] | null, dataStart: number): number {
  const counts = emailCounts(grid, dataStart);
  const otherPerson = new Set(
    (header ?? []).flatMap((text, c) => (text && OTHER_PERSON.test(headerWords(text)) ? [c] : [])),
  );
  if (header) {
    const own = header.flatMap((text, c) => (isEmailHeader(text) && !otherPerson.has(c) ? [c] : []));
    if (own.length > 0) return mostFilled(own, counts) ?? own[0];
  }
  const filled = counts.map((_, c) => c);
  const email = mostFilled(
    filled.filter((c) => !otherPerson.has(c)),
    counts,
  );
  if (email !== undefined) return email;
  const other = mostFilled(filled, counts);
  if (other !== undefined && header) {
    const message = otherPersonEmails(header[other]);
    throw badRequest(message, { file: message });
  }
  throw badRequest(NO_EMAIL_COLUMN, { file: NO_EMAIL_COLUMN });
}

/** Name columns from the header row, skipping columns about other people and the email column. */
function headerNameColumns(header: string[], email: number): Omit<RosterColumns, 'email'> {
  const found: Omit<RosterColumns, 'email'> = {};
  header.forEach((text, c) => {
    const words = headerWords(text);
    if (c === email || !words || OTHER_PERSON.test(words)) return;
    const first = isFirstNameHeader(words);
    const last = isLastNameHeader(words);
    // "Last Name, First Name" in one heading is a single "Last, First" column.
    if (first && last) found.full ??= c;
    else if (first) found.first ??= c;
    else if (last) found.last ??= c;
    else if (isFullNameHeader(words)) found.full ??= c;
  });
  return found.full !== undefined ? { full: found.full } : found;
}

/** Without a header: the column (other than the email column) with the most cells that look like names. */
function guessNameColumn(grid: Grid, email: number, dataStart: number): number | undefined {
  const counts: number[] = [];
  for (let r = dataStart; r < grid.length; r++) {
    (grid[r] ?? []).forEach((cell, c) => {
      if (c !== email && looksLikeName(cell)) counts[c] = (counts[c] ?? 0) + 1;
    });
  }
  return mostFilled(
    counts.map((_, c) => c),
    counts,
  );
}

/** How the columns are shown to the teacher, e.g. "First Name + Last Name" or "Column C" without a header. */
function columnLabels(columns: RosterColumns, header: string[] | null): RosterPreview['columns'] {
  const label = (c: number) => header?.[c] || `Column ${columnLetter(c)}`;
  const nameColumns =
    columns.full !== undefined
      ? [columns.full]
      : [columns.first, columns.last].filter((c): c is number => c !== undefined);
  return { email: label(columns.email), name: nameColumns.length ? nameColumns.map(label).join(' + ') : null };
}

/* ------------------------------------------------------------------ */
/* Rows                                                               */
/* ------------------------------------------------------------------ */

/** The row's name from its name columns, or else the name in a "Jane Doe <jane@school.edu>" email cell. */
function rowName(row: string[], columns: RosterColumns): string {
  if (columns.full !== undefined) {
    const name = displayName(row[columns.full] ?? '');
    if (name) return name;
  } else {
    const parts = [columns.first, columns.last].map((c) => (c === undefined ? '' : (row[c] ?? '')));
    const name = cleanName(parts.join(' '));
    if (name) return name;
  }
  return displayName(splitAddress(row[columns.email] ?? '')?.name ?? '');
}

interface ReadRows {
  rows: RosterPreviewRow[];
  warnings: string[];
}

/** Data rows → preview rows (status still unknown): skips blank rows, merges repeated emails, stops at the limit. */
function readRows(grid: Grid, columns: RosterColumns, dataStart: number): ReadRows {
  const rows: RosterPreviewRow[] = [];
  const firstByEmail = new Map<string, RosterPreviewRow>();
  const repeats = new Map<string, number[]>();
  let skipped = 0;
  let dataRows = 0;

  for (let r = dataStart; r < grid.length; r++) {
    const cells = grid[r] ?? [];
    const rawEmail = cells[columns.email] ?? '';
    const name = rowName(cells, columns);
    if (!rawEmail && !name) {
      skipped += 1;
      continue;
    }
    dataRows += 1;
    if (dataRows > MAX_STUDENTS_PER_REQUEST) continue;

    // Invalid entries are shown as they are in the file (their row gets status "error").
    const email = cellEmail(rawEmail) || rawEmail;
    const first = firstByEmail.get(email);
    if (first && email) {
      if (!first.name) first.name = name;
      repeats.set(email, [...(repeats.get(email) ?? [first.line]), r + 1]);
      continue;
    }
    const row: RosterPreviewRow = { line: r + 1, name, email, status: 'invite' };
    if (isValidEmail(email)) firstByEmail.set(email, row);
    rows.push(row);
  }

  const warnings: string[] = [];
  if (skipped > 0) {
    warnings.push(`Skipped ${skipped} ${skipped === 1 ? 'row' : 'rows'} without a name or email address.`);
  }
  if (repeats.size > 0) {
    const listed = [...repeats]
      .slice(0, LISTED_DUPLICATES)
      .map(([email, lines]) => `${email} (rows ${lines.join(', ')})`);
    const more = repeats.size > LISTED_DUPLICATES ? ` and ${repeats.size - LISTED_DUPLICATES} more` : '';
    warnings.push(`Repeated emails were merged into their first row: ${listed.join(', ')}${more}.`);
  }
  if (dataRows > MAX_STUDENTS_PER_REQUEST) {
    const limit = MAX_STUDENTS_PER_REQUEST.toLocaleString('en-US');
    warnings.push(
      `This file lists ${dataRows.toLocaleString('en-US')} students. Only the first ${limit} were read; ` +
        'add the rest from a second file.',
    );
  }
  return { rows, warnings };
}

interface AccountRow {
  email: string;
  role: 'teacher' | 'student';
  pending: number;
  enrolled: number;
}

/**
 * Sets each row's status from the database: what Add students would do for this class. A pending account (another
 * class's teacher invited the student, who hasn't signed up) is an `invite` like a new email: it is matched when the
 * student signs up, and Add students reports it as pending.
 */
function applyStatuses(classId: number, rows: RosterPreviewRow[]): void {
  const emails = [...new Set(rows.map((row) => row.email).filter(isValidEmail))];
  const accounts = all<AccountRow>(
    `SELECT u.email, u.role, u.pending,
       EXISTS (SELECT 1 FROM enrollments e WHERE e.class_id = ? AND e.student_id = u.id) AS enrolled
     FROM users u WHERE u.email IN (SELECT value FROM json_each(?))`,
    classId,
    JSON.stringify(emails),
  );
  const byEmail = new Map(accounts.map((account) => [account.email.toLowerCase(), account]));
  for (const row of rows) {
    const problem = rosterRowProblem(row.name, row.email);
    const account = byEmail.get(row.email);
    const error = problem ?? (account?.role === 'teacher' ? TEACHER_EMAIL_PROBLEM : undefined);
    if (error) {
      row.status = 'error';
      row.error = error;
    } else if (account?.enrolled) row.status = 'already';
    else row.status = account && !account.pending ? 'add' : 'invite';
  }
}

/* ------------------------------------------------------------------ */
/* Entry point                                                        */
/* ------------------------------------------------------------------ */

/** Reads the uploaded roster at `filePath`. Throws 400 { fields: { file } } for unreadable files or no email column. */
export function previewRoster(classId: number, filePath: string, fileName: string): RosterPreview {
  let grid: Grid;
  try {
    grid = readFirstSheetText(filePath, MAX_COLUMNS);
  } catch (err) {
    if (err instanceof WorkbookReadError) throw badRequest(err.message, { file: err.message });
    throw err;
  }

  const headerRow = findHeaderRow(grid);
  const header = headerRow === null ? null : grid[headerRow];
  const dataStart = headerRow === null ? 0 : headerRow + 1;
  const email = findEmailColumn(grid, header, dataStart);

  let names: Omit<RosterColumns, 'email'>;
  if (header) names = headerNameColumns(header, email);
  else {
    const full = guessNameColumn(grid, email, dataStart);
    names = full === undefined ? {} : { full };
  }
  const columns: RosterColumns = { email, ...names };

  const { rows, warnings } = readRows(grid, columns, dataStart);
  applyStatuses(classId, rows);
  return { fileName, rows, columns: columnLabels(columns, header), warnings };
}
