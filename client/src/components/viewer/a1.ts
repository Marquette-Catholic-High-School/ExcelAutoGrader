/** A1-notation helpers for the spreadsheet viewer. Rows and columns are 0-based. */

export interface CellPos {
  r: number;
  c: number;
}

export interface CellRange {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

/** 0 → "A", 25 → "Z", 26 → "AA". */
export function columnLetter(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** {r: 6, c: 1} → "B7". */
export function toAddress(pos: CellPos): string {
  return `${columnLetter(pos.c)}${pos.r + 1}`;
}

const ADDRESS_RE = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/;

/** "B7" (also "$B$7" or "Sheet1!B7") → {r: 6, c: 1}; null when it is not a single-cell address. */
export function parseAddress(address: string): CellPos | null {
  const bare = address.includes('!') ? address.slice(address.lastIndexOf('!') + 1) : address;
  const m = ADDRESS_RE.exec(bare.trim());
  if (!m) return null;
  let c = 0;
  for (const ch of m[1].toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
  const r = Number(m[2]);
  if (r < 1) return null;
  return { r: r - 1, c: c - 1 };
}

/** "A1:C2" → range (normalized so r1 ≤ r2, c1 ≤ c2); a single address yields a 1×1 range. */
export function parseRange(range: string): CellRange | null {
  const [a, b = a] = range.split(':');
  const start = parseAddress(a);
  const end = parseAddress(b);
  if (!start || !end) return null;
  return {
    r1: Math.min(start.r, end.r),
    c1: Math.min(start.c, end.c),
    r2: Math.max(start.r, end.r),
    c2: Math.max(start.c, end.c),
  };
}
