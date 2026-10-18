/**
 * Semicolon-delimited text files, as saved by European-locale Excel ("sep=;" first line, or ";" between fields),
 * write numbers with "," as the decimal separator and "." or a space between thousands. SheetJS reads "1,50" there as
 * 150, so such files are recognized before parsing and their numbers are read again from the original text.
 */
import type * as XLSX from 'xlsx';
import { hasFormula } from './cells.js';

const SNIFF_BYTES = 64 * 1024;
const DECIMAL_COMMA_NUMBER = /^[-+]?\d{1,3}(?:[. ]\d{3})*(?:,\d+)?$|^[-+]?\d+(?:,\d+)?$/;
const CURRENCY = '[$€£¥]';

/** True for text whose first line is "sep=;", or whose first non-empty line has more ";" than "," and no tabs. */
export function isSemicolonDelimited(buf: Buffer): boolean {
  const text = decodeStart(buf);
  if (/^\s*</.test(text)) return false; // HTML or XML spreadsheet
  let start = 0;
  while (start < text.length) {
    const { line, next } = readLine(text, start);
    if (start === 0 && /^sep=/.test(line)) return /^sep=;\s*$/.test(line);
    if (line.trim()) {
      const outside = line.replace(/"(?:[^"]|"")*"?/g, '');
      const count = (ch: string) => outside.split(ch).length - 1;
      return count(';') > count(',') && count('\t') === 0;
    }
    start = next;
  }
  return false;
}

/** Re-reads every number of a semicolon-delimited sheet from its original text (kept in `w`) with decimal commas. */
export function readDecimalCommas(wb: XLSX.WorkBook): void {
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    for (const key of Object.keys(ws)) {
      if (key.charCodeAt(0) === 33) continue;
      const cell = ws[key] as XLSX.CellObject;
      if (!cell || typeof cell !== 'object' || hasFormula(cell) || cell.t === 'b' || cell.t === 'e') continue;
      const text = typeof cell.w === 'string' ? cell.w : typeof cell.v === 'string' ? cell.v : null;
      const value = text === null ? null : parseDecimalComma(text);
      if (value === null) continue;
      cell.t = 'n';
      cell.v = value;
      cell.w = text as string;
      delete cell.z; // SheetJS may have taken "1.234,5" for a date
    }
  }
}

/** "1,50" → 1.5, "1.234,5" → 1234.5, "1 234" → 1234, "12,5 %" → 0.125, "1.234,50 €" → 1234.5; null otherwise. */
export function parseDecimalComma(text: string): number | null {
  let t = text.replace(/[  ]/g, ' ').trim();
  let percent = false;
  if (t.endsWith('%')) {
    percent = true;
    t = t.slice(0, -1).trimEnd();
  }
  t = t.replace(new RegExp(`^([-+]?)\\s*${CURRENCY}\\s*`), '$1').replace(new RegExp(`\\s*${CURRENCY}$`), '');
  if (!DECIMAL_COMMA_NUMBER.test(t)) return null;
  const n = Number(t.replace(/[. ]/g, '').replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  return percent ? n / 100 : n;
}

/** The start of the file as text (UTF-16 by BOM, otherwise bytes as Latin-1, which is enough to find delimiters). */
function decodeStart(buf: Buffer): string {
  const head = buf.subarray(0, SNIFF_BYTES);
  const utf16 = () => head.subarray(2, 2 + ((head.length - 2) & ~1));
  if (head[0] === 0xff && head[1] === 0xfe) return utf16().toString('utf16le');
  if (head[0] === 0xfe && head[1] === 0xff) return Buffer.from(utf16()).swap16().toString('utf16le');
  const bom = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0;
  return head.subarray(bom).toString('latin1');
}

/** The line starting at `start` (a line break inside "quotes" does not end it) and where the next one starts. */
function readLine(text: string, start: number): { line: string; next: number } {
  let quoted = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) {
      const next = ch === '\r' && text[i + 1] === '\n' ? i + 2 : i + 1;
      return { line: text.slice(start, i), next };
    }
  }
  return { line: text.slice(start), next: text.length };
}
