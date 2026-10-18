/**
 * Formula text helpers. SheetJS returns formulas without the leading "=" and keeps Excel's internal
 * prefixes for newer functions (e.g. "_xlfn.XLOOKUP"), which we hide from people and from HyperFormula.
 */
import { MAX_COLS, MAX_ROWS, columnIndex, encodeAddress, type CellPosition } from './ranges.js';

const INTERNAL_PREFIX = /_xl(?:fn|ws|udf)\./gi;

/** Functions whose result depends on when (or by chance) the workbook was calculated. */
const VOLATILE_CALL = /\b(TODAY|NOW|RAND|RANDBETWEEN|RANDARRAY)\s*\(/gi;

/**
 * An A1 area reference: an optional sheet prefix (Sheet1! or 'My Sheet'!), then cell:cell, column:column or
 * row:row. Group 1 is the character before it (it must not continue a name, number or reference).
 */
const AREA_REFERENCE =
  /(^|[^\w.$'!\]])((?:'(?:[^']|'')+'|[A-Za-z_\\][\w.]*)!)?(\$?[A-Za-z]{1,3}\$?\d{1,7}|\$?[A-Za-z]{1,3}|\$?\d{1,7}):(\$?[A-Za-z]{1,3}\$?\d{1,7}|\$?[A-Za-z]{1,3}|\$?\d{1,7})(?![\w.(!$])/g;

const AREA_PART = /^\$?([A-Za-z]{0,3})\$?(\d*)$/;

/** Functions that build an array whose size is given by literal arguments (rows, columns). */
const ARRAY_BUILDER_CALL = /\b(SEQUENCE|MUNIT|OFFSET)\s*\(/gi;

export interface AreaReference {
  /** Sheet named by the prefix, or null when the reference has none (= the formula's own sheet). */
  sheet: string | null;
  /** Corners normalized so start <= end; whole columns or rows span the entire sheet. */
  start: CellPosition;
  end: CellPosition;
}

/** Formula as a person would type it, without the leading "=" (e.g. "XLOOKUP(A2,B:B,C:C)"). */
export function displayFormula(formula: string): string {
  return formula.trim().replace(/^=/, '').replace(INTERNAL_PREFIX, '');
}

/**
 * Canonical form used to decide whether two formulas are "the same": no "=", no internal prefixes,
 * no "$" anchors, no whitespace, upper case — except inside "string literals", which are kept verbatim.
 * Quoted sheet names ('My Sheet'!A1) keep their spaces but are upper-cased (sheet names are case-insensitive).
 */
export function normalizeFormula(formula: string): string {
  const source = displayFormula(formula);
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'") {
      const end = closingQuote(source, i);
      const literal = source.slice(i, end + 1);
      out += ch === '"' ? literal : literal.toUpperCase();
      i = end + 1;
      continue;
    }
    if (ch !== '$' && !/\s/.test(ch)) out += ch.toUpperCase();
    i += 1;
  }
  return out;
}

/**
 * Formula text for HyperFormula ("=" included). Bridges the differences from Excel's file syntax that matter in
 * practice: bare TRUE/FALSE literals (HyperFormula only knows TRUE()/FALSE()) and CONCAT, which becomes the
 * equivalent TEXTJOIN("",FALSE(),...). String literals and quoted sheet names are left untouched.
 */
export function engineFormula(formula: string): string {
  const source = displayFormula(formula);
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'") {
      const end = closingQuote(source, i);
      out += source.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (!/[A-Za-z_]/.test(ch)) {
      out += ch;
      i += 1;
      continue;
    }
    let end = i + 1;
    while (end < source.length && /[\w.]/.test(source[end])) end += 1;
    const word = source.slice(i, end);
    const upper = word.toUpperCase();
    const next = source[end];
    if (next === '(' && upper === 'CONCAT') {
      out += 'TEXTJOIN("",FALSE(),';
      end += 1;
      // CONCAT() has no arguments to join; keep it a call HyperFormula reports as an error instead of a syntax error.
      if (source[end] === ')') out = out.slice(0, -1);
    } else if ((upper === 'TRUE' || upper === 'FALSE') && next !== '(' && next !== '!') {
      out += `${upper}()`;
    } else {
      out += word;
    }
    i = end;
  }
  return `=${out}`;
}

/**
 * The formula with the inside of its "string literals" blanked out (same length, quotes kept), so text such as
 * "TODAY()" or "A1:B2" inside a literal is not mistaken for formula syntax. Quoted sheet names are kept.
 */
export function maskStringLiterals(formula: string): string {
  let out = '';
  let i = 0;
  while (i < formula.length) {
    const ch = formula[i];
    if (ch === '"' || ch === "'") {
      const end = closingQuote(formula, i);
      const length = end - i + 1;
      out += ch === "'" ? formula.slice(i, end + 1) : length < 2 ? '"' : `"${' '.repeat(length - 2)}"`;
      i = end + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** The volatile functions (TODAY, NOW, RAND, RANDBETWEEN, RANDARRAY) a formula calls: upper case, no duplicates. */
export function volatileFunctions(formula: string): string[] {
  const names = new Set<string>();
  for (const match of maskStringLiterals(displayFormula(formula)).matchAll(VOLATILE_CALL)) {
    names.add(match[1].toUpperCase());
  }
  return [...names];
}

/**
 * Rewrites the A1 area references of a formula (A1:B2, $A$1:$B$2, A:C, 1:5, Sheet1!A1:B2, 'My Sheet'!A:A) outside
 * string literals. `replace` gets each reference and returns its new corners, or null to keep it as written.
 * Rewritten references are absolute: the result is only evaluated, never copied to other cells.
 */
export function mapAreaReferences(
  formula: string,
  replace: (ref: AreaReference) => { start: CellPosition; end: CellPosition } | null,
): string {
  let out = '';
  let last = 0;
  for (const match of maskStringLiterals(formula).matchAll(AREA_REFERENCE)) {
    const [whole, before, prefix = '', first, second] = match;
    const ref = parseArea(prefix, first, second);
    const corners = ref && replace(ref);
    if (!corners) continue;
    const at = match.index + before.length;
    out += `${formula.slice(last, at)}${formula.slice(at, at + prefix.length)}`;
    out += `${absoluteAddress(corners.start)}:${absoluteAddress(corners.end)}`;
    last = match.index + whole.length;
  }
  return out + formula.slice(last);
}

/**
 * Cells of the arrays a formula builds from literal sizes: SEQUENCE(rows, [cols]), MUNIT(size) and
 * OFFSET(ref, rows, cols, [height], [width]). HyperFormula materializes them (it only supports literal sizes), so
 * they count toward the recalculation budget like the ranges a formula references.
 */
export function generatedArrayCells(formula: string): number {
  const masked = maskStringLiterals(formula);
  let cells = 0;
  for (const match of masked.matchAll(ARRAY_BUILDER_CALL)) {
    const args = callArguments(masked, match.index + match[0].length).map(literalSize);
    const name = match[1].toUpperCase();
    if (name === 'SEQUENCE') cells += (args[0] ?? 1) * (args[1] ?? 1);
    else if (name === 'MUNIT') cells += (args[0] ?? 1) ** 2;
    else cells += (args[3] ?? 1) * (args[4] ?? 1);
  }
  return cells;
}

function parseArea(prefix: string, first: string, second: string): AreaReference | null {
  const a = parseAreaPart(first);
  const b = parseAreaPart(second);
  if (!a || !b || a.kind !== b.kind) return null;
  const sheet = prefix ? sheetFromPrefix(prefix.slice(0, -1)) : null;
  const top = Math.min(a.r, b.r);
  const left = Math.min(a.c, b.c);
  const bottom = Math.max(a.r, b.r);
  const right = Math.max(a.c, b.c);
  if (a.kind === 'column') return { sheet, start: { r: 0, c: left }, end: { r: MAX_ROWS - 1, c: right } };
  if (a.kind === 'row') return { sheet, start: { r: top, c: 0 }, end: { r: bottom, c: MAX_COLS - 1 } };
  return { sheet, start: { r: top, c: left }, end: { r: bottom, c: right } };
}

function parseAreaPart(text: string): { kind: 'cell' | 'column' | 'row'; r: number; c: number } | null {
  const match = AREA_PART.exec(text);
  if (!match) return null;
  const [, letters, digits] = match;
  const c = letters ? columnIndex(letters) : 0;
  const row = digits ? Number(digits) : 1;
  if (c < 0 || row < 1 || row > MAX_ROWS) return null;
  const kind = letters && digits ? 'cell' : letters ? 'column' : 'row';
  return { kind, r: row - 1, c };
}

/** "Sheet1" → Sheet1, "'My Sheet'" → My Sheet, "'Bob''s'" → Bob's. */
function sheetFromPrefix(prefix: string): string {
  return prefix.startsWith("'") ? prefix.slice(1, -1).replace(/''/g, "'") : prefix;
}

function absoluteAddress(position: CellPosition): string {
  return encodeAddress(position.r, position.c).replace(/^([A-Z]+)/, '$$$1$$');
}

/** The top-level arguments of the call whose "(" ends just before `from` (text with string literals masked). */
function callArguments(text: string, from: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(' || ch === '{') depth += 1;
    else if ((ch === ')' || ch === '}') && depth > 0) depth -= 1;
    else if (ch === ')' || (ch === ',' && depth === 0)) {
      args.push(text.slice(start, i).trim());
      if (ch === ')') return args;
      start = i + 1;
    }
  }
  return args;
}

/** A whole-number literal argument such as "1048576"; undefined for anything else (omitted, references, formulas). */
function literalSize(arg: string): number | undefined {
  return /^\+?\d+(\.\d*)?$/.test(arg) ? Math.trunc(Number(arg)) : undefined;
}

/** Index of the quote closing the literal that starts at `start` (doubled quotes are escapes). */
function closingQuote(text: string, start: number): number {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === quote) {
      if (text[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i;
    }
    i += 1;
  }
  return text.length - 1;
}
