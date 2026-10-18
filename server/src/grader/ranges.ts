/**
 * A1 range references typed by teachers: "B2", "B2:D10", "$B$2:$D$10", "Sheet1!B2:B10", "'My Sheet'!F5".
 */

export const MAX_ROWS = 1_048_576;
export const MAX_COLS = 16_384; // column XFD

export interface CellPosition {
  /** 0-based row index */
  r: number;
  /** 0-based column index */
  c: number;
}

export interface RangeRef {
  /** The trimmed text the teacher typed. */
  text: string;
  /** Sheet name from the prefix, or null when the range has no sheet prefix (= first sheet). */
  sheet: string | null;
  /** Top-left and bottom-right corners (normalized so start <= end). */
  start: CellPosition;
  end: CellPosition;
}

const CELL_PART = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/;
const FORBIDDEN_SHEET_CHARS = /[[\]:*?/\\]/;

/** Parses a range reference, or returns null when it is not valid A1 notation. */
export function parseRange(input: string): RangeRef | null {
  const text = input.trim();
  if (!text || text.length > 300) return null;

  let sheet: string | null = null;
  let rest = text;
  const bang = text.lastIndexOf('!');
  if (bang >= 0) {
    sheet = parseSheetPrefix(text.slice(0, bang).trim());
    if (sheet === null) return null;
    rest = text.slice(bang + 1).trim();
  }

  const parts = rest.split(':');
  if (parts.length > 2) return null;
  const first = parseCell(parts[0].trim());
  const second = parts.length === 2 ? parseCell(parts[1].trim()) : first;
  if (!first || !second) return null;

  return {
    text,
    sheet,
    start: { r: Math.min(first.r, second.r), c: Math.min(first.c, second.c) },
    end: { r: Math.max(first.r, second.r), c: Math.max(first.c, second.c) },
  };
}

export function isValidRange(input: string): boolean {
  return parseRange(input) !== null;
}

export function rangeContains(range: RangeRef, r: number, c: number): boolean {
  return r >= range.start.r && r <= range.end.r && c >= range.start.c && c <= range.end.c;
}

/** Column index (0-based) → letters ("A", "Z", "AA", ...). */
export function columnLetters(c: number): string {
  let n = c + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Column letters → 0-based index, or -1 if out of Excel's range. */
export function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n >= 1 && n <= MAX_COLS ? n - 1 : -1;
}

export function encodeAddress(r: number, c: number): string {
  return `${columnLetters(c)}${r + 1}`;
}

function parseCell(text: string): CellPosition | null {
  const match = CELL_PART.exec(text);
  if (!match) return null;
  const c = columnIndex(match[1]);
  const row = Number(match[2]);
  if (c < 0 || row < 1 || row > MAX_ROWS) return null;
  return { r: row - 1, c };
}

/** "Sheet1" → Sheet1, "'My Sheet'" → My Sheet, "'Bob''s'" → Bob's; null when malformed. */
function parseSheetPrefix(prefix: string): string | null {
  if (prefix.startsWith("'")) {
    if (prefix.length < 3 || !prefix.endsWith("'")) return null;
    const inner = prefix.slice(1, -1);
    if (inner.replace(/''/g, '').includes("'")) return null;
    const name = inner.replace(/''/g, "'");
    return name.trim() && !FORBIDDEN_SHEET_CHARS.test(name) ? name : null;
  }
  if (!prefix || prefix.includes("'") || FORBIDDEN_SHEET_CHARS.test(prefix)) return null;
  return prefix;
}
