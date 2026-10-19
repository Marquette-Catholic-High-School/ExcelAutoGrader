/**
 * Parses a pasted roster into { name, email } rows. Accepted line shapes:
 *   Jane Doe, jane@school.edu          (comma or semicolon separated)
 *   jane@school.edu                    (no name: the student's own name replaces it when they sign up)
 *   Jane<TAB>Doe<TAB>jane@school.edu   (rows copied from Excel / Google Sheets; extra columns are joined)
 *   Jane Doe <jane@school.edu>         (copied from an email client)
 *   a@school.edu, b@school.edu         (several addresses on one line become several students)
 * A first line without an email that looks like a header ("Name, Email") is skipped silently.
 */

/** Mirrors the server's limit for POST /api/classes/:classId/students. */
export const MAX_STUDENTS_PER_REQUEST = 1000;
const NAME_MAX = 100;

const EMAIL_FIND = /[^\s@<>()[\]{},;:"']+@[^\s@<>()[\]{},;:"']+\.[^\s@<>()[\]{},;:"']+/;
const EMAIL_VALID = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const HEADER_HINT = /\b(e-?mail|name|student|first|last)\b/i;

export interface ParsedStudent {
  /** 1-based line number in the pasted text. */
  line: number;
  name: string;
  email: string;
  /**
   * True when no name was given: `name` is derived from the email for display, and the row is sent with a blank
   * name so the server stores a placeholder that the student's own name replaces when they sign up.
   */
  derivedName: boolean;
}

export interface ParseIssue {
  line: number;
  text: string;
  error: string;
}

export interface ParseResult {
  students: ParsedStudent[];
  issues: ParseIssue[];
}

/**
 * "jane.doe+math@school.edu" → "Jane Doe". Mirrors the server's placeholder name for a student added without a
 * name (server/src/services/classes.ts placeholderName), so previews show the name the roster will show.
 */
export function nameFromEmail(email: string): string {
  const local = email.split('@')[0].split('+')[0];
  const words = local
    .split(/[^\p{L}\p{M}']+/u)
    .map((word) => word.replace(/^'+|'+$/g, ''))
    .filter((word) => /\p{L}/u.test(word));
  const name = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
  return (name || local || email).slice(0, NAME_MAX);
}

/**
 * Same normalization as the server (server/src/services/classes.ts normalizeEmail), so an address copied with a
 * zero-width space or in full-width letters is listed (and de-duplicated) as the address the student will type.
 */
function normalizeEmail(email: string): string {
  return email.normalize('NFKC').replace(/\p{Cf}/gu, '').trim().toLowerCase();
}

function splitCells(line: string): string[] {
  if (line.includes('\t')) return line.split('\t');
  if (/[,;]/.test(line)) return line.split(/[,;]/);
  return [line];
}

/** Cleans what is left of a cell once the email is removed: brackets, quotes, stray separators. */
function cleanName(text: string): string {
  return text
    .replace(/[<>()[\]{}"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-–—:|]+|[-–—:|]+$/g, '')
    .trim();
}

function isIdLike(cell: string): boolean {
  return /^#?\d+$/.test(cell.trim());
}

interface Candidate {
  name: string;
  email: string;
}

function lineCandidates(line: string): Candidate[] {
  const cells = splitCells(line).map((c) => c.trim()).filter(Boolean);
  const withEmail = cells.filter((c) => EMAIL_FIND.test(c));
  if (withEmail.length === 0) return [];

  const emailOf = (cell: string) => normalizeEmail((EMAIL_FIND.exec(cell)?.[0] ?? '').replace(/\.+$/, ''));
  const restOf = (cell: string) => cleanName(cell.replace(EMAIL_FIND, ' '));

  if (withEmail.length > 1) {
    // Several addresses on one line ("a@x.edu, Bo Li <b@x.edu>"): one student per address.
    return withEmail.map((cell) => ({ name: restOf(cell), email: emailOf(cell) }));
  }
  const emailCell = withEmail[0];
  const nameParts = cells
    .filter((c) => c !== emailCell && !isIdLike(c))
    .map(cleanName)
    .concat(restOf(emailCell))
    .filter(Boolean);
  return [{ name: nameParts.join(' '), email: emailOf(emailCell) }];
}

export function parseStudentList(text: string): ParseResult {
  const students: ParsedStudent[] = [];
  const issues: ParseIssue[] = [];
  const seen = new Map<string, number>();
  let sawContent = false;

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    const trimmed = raw.trim();
    if (!trimmed) return;
    const first = !sawContent;
    sawContent = true;

    const candidates = lineCandidates(trimmed);
    if (candidates.length === 0) {
      if (first && HEADER_HINT.test(trimmed)) return;
      const partial = trimmed.split(/[\s,;]+/).find((token) => token.includes('@'));
      issues.push({
        line,
        text: trimmed,
        error: partial ? `"${partial}" is not a complete email address` : 'No email address found on this line',
      });
      return;
    }

    for (const c of candidates) {
      if (!EMAIL_VALID.test(c.email)) {
        issues.push({ line, text: trimmed, error: `"${c.email}" is not a valid email address` });
        continue;
      }
      const duplicateOf = seen.get(c.email);
      if (duplicateOf !== undefined) {
        issues.push({ line, text: trimmed, error: `${c.email} is already listed on line ${duplicateOf}` });
        continue;
      }
      const name = c.name || nameFromEmail(c.email);
      if (name.length > NAME_MAX) {
        issues.push({ line, text: trimmed, error: `Name is longer than ${NAME_MAX} characters` });
        continue;
      }
      seen.set(c.email, line);
      students.push({ line, name, email: c.email, derivedName: !c.name });
    }
  });

  return { students, issues };
}
