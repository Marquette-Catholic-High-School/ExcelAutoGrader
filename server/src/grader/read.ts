/**
 * Opening spreadsheet files and turning them into the grading model.
 *
 * Every file goes through loadWorkbook(): format sniffing (so renamed/corrupt files fail with a friendly
 * WorkbookReadError instead of being parsed as garbage text), size limits (limits.ts), SheetJS parsing, and
 * HyperFormula recalculation of formulas saved without results. Parsed workbooks are cached by path + size + mtime,
 * which is safe because uploads are stored under unique names and never modified in place.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import type { CellPrimitive } from '../../../shared/types.js';
import { arrayAnchor, cellPrimitive, forEachCell, hasFormula } from './cells.js';
import { isBlank, type NumberUnit } from './compare.js';
import { isSemicolonDelimited, readDecimalCommas } from './csv.js';
import { MESSAGES, WorkbookReadError } from './errors.js';
import { DATE_1904_OFFSET, formatUnit, hasDatePart, numberFormat } from './format.js';
import { displayFormula } from './formula.js';
import { assertCellCount, assertTextWithinLimits, assertZipWithinLimits } from './limits.js';
import { encodeAddress } from './ranges.js';
import { recalculateMissingValues, type RecalcResult } from './recalc.js';

const READ_OPTIONS: XLSX.ParsingOptions = {
  type: 'buffer',
  cellFormula: true,
  cellDates: false,
  cellNF: true,
  cellText: true,
  // Rich-text HTML is never used (the viewer shows `w`); skipping it saves memory.
  cellHTML: false,
  // Keeps formula cells saved without a cached result (they would otherwise vanish); see forEachCell.
  sheetStubs: true,
  // Needed for column widths ("!cols") in the viewer.
  cellStyles: true,
};

/** Sheets whose used area exceeds this many cells are only graded within GRADE_LIMIT_ROWS x GRADE_LIMIT_COLS. */
export const MAX_GRADED_AREA = 200_000;
export const GRADE_LIMIT_ROWS = 1000;
export const GRADE_LIMIT_COLS = 100;

const CACHE_ENTRIES = 8;
const CACHE_MAX_BYTES = 4 * 1024 * 1024;
const ZIP_EXTENSIONS = ['.xlsx', '.xlsm', '.ods'];

export interface LoadedWorkbook {
  wb: XLSX.WorkBook;
  /** Lower-case extension including the dot ('' when the path has none). */
  ext: string;
  isCsv: boolean;
  recalc: RecalcResult | null;
  /** Grading models already built from this workbook, keyed by label. */
  models: Map<string, WorkbookModel>;
}

/** One non-empty cell (has a formula or a non-blank value). */
export interface GradeCell {
  address: string;
  r: number;
  c: number;
  /**
   * Error cells hold their display text ("#DIV/0!"). Never undefined. Dates are serials of the 1900 date system,
   * also in workbooks saved in the 1904 system.
   */
  value: CellPrimitive;
  isError: boolean;
  /**
   * Formula without "=" and without Excel's internal "_xlfn." prefixes. Cells filled by an array or spill formula
   * carry the formula of the range's top-left cell.
   */
  formula?: string;
  /** Formula cell whose result is unknown (saved without one and recalculation failed). */
  missingValue: boolean;
  /** Numbers formatted as a percentage or a time; sets the units of the numeric tolerance. */
  unit?: NumberUnit;
  /** A number as the workbook displays it ("31.8%", "10/16/2026"), when that differs from the plain number. */
  text?: string;
}

export interface ModelSheet {
  name: string;
  index: number;
  /** Every cell, by address (submissions are looked up here, however large the sheet). */
  cells: Map<string, GradeCell>;
  /** Row-major; within the top-left GRADE_LIMIT_ROWS x GRADE_LIMIT_COLS when `limited`. Key cells are chosen here. */
  list: GradeCell[];
  /** True when the sheet was too large, so `list` only has its top-left area. */
  limited: boolean;
}

export interface ModelOptions {
  /**
   * Warn when a large sheet is only checked within its top-left area. Default true; off for submissions, whose
   * cells are looked up by address anyway.
   */
  limitWarning?: boolean;
}

export interface WorkbookModel {
  sheets: ModelSheet[];
  /** Problems found while reading (large sheets, failed recalculation). Do not mutate. */
  warnings: readonly string[];
  isCsv: boolean;
}

type Container = 'zip' | 'cfb' | 'biff' | 'text' | 'binary';

const cache = new Map<string, LoadedWorkbook>();

/** Reads and parses a spreadsheet file. Throws WorkbookReadError for anything that is not a readable workbook. */
export function loadWorkbook(filePath: string): LoadedWorkbook {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new WorkbookReadError(MESSAGES.missing);
  }
  if (!stat.isFile()) throw new WorkbookReadError(MESSAGES.missing);

  const cacheKey = `${path.resolve(filePath)}|${stat.size}|${stat.mtimeMs}|${stat.ino}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    cache.delete(cacheKey);
    cache.set(cacheKey, cached);
    return cached;
  }

  const loaded = parseWorkbookBuffer(fs.readFileSync(filePath), path.extname(filePath).toLowerCase());
  if (stat.size <= CACHE_MAX_BYTES) {
    cache.set(cacheKey, loaded);
    while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
  }
  return loaded;
}

/** Parses file contents; `ext` (e.g. ".xlsx") is used to reject files whose content does not match. */
export function parseWorkbookBuffer(buf: Buffer, ext = ''): LoadedWorkbook {
  if (buf.length === 0) throw new WorkbookReadError(MESSAGES.empty);
  const container = sniffContainer(buf);
  if (container === 'binary') throw new WorkbookReadError(MESSAGES.unreadable);
  if (ZIP_EXTENSIONS.includes(ext) && container !== 'zip' && container !== 'cfb') {
    throw new WorkbookReadError(MESSAGES.wrongFormat(ext));
  }

  if (container === 'zip') assertZipWithinLimits(buf);
  if (container === 'text') assertTextWithinLimits(buf);
  const semicolons = container === 'text' && isSemicolonDelimited(buf);

  let wb: XLSX.WorkBook;
  try {
    // Always a fresh copy: SheetJS writes to the options it is given (reading UTF-16 text sets `type: 'binary'`),
    // which would break every later read if the shared constant were passed.
    const options: XLSX.ParsingOptions = { ...READ_OPTIONS, ...(semicolons ? { FS: ';' } : {}) };
    wb = XLSX.read(container === 'text' ? asUtf8Text(buf) : buf, options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new WorkbookReadError(/password/i.test(message) ? MESSAGES.password : MESSAGES.unreadable);
  }
  if (!wb || !Array.isArray(wb.SheetNames) || wb.SheetNames.length === 0) {
    throw new WorkbookReadError(MESSAGES.noSheets);
  }
  assertCellCount(wb);
  if (semicolons) readDecimalCommas(wb);

  const recalc = recalculateMissingValues(wb);
  const isCsv = container === 'text' && (ext === '.csv' || ext === '');
  return { wb, ext, isCsv, recalc, models: new Map() };
}

/**
 * The grading model of a workbook. `label` names the file in warnings, e.g. "the answer key" or
 * "the submission"; models are cached by label, so a label always comes with the same options.
 */
export function getModel(loaded: LoadedWorkbook, label: string, options: ModelOptions = {}): WorkbookModel {
  let model = loaded.models.get(label);
  if (!model) {
    model = buildModel(loaded, label, options);
    loaded.models.set(label, model);
  }
  return model;
}

function buildModel(loaded: LoadedWorkbook, label: string, options: ModelOptions): WorkbookModel {
  const warnings = recalcWarnings(loaded.recalc, label);
  const date1904 = Boolean(loaded.wb.Workbook?.WBProps?.date1904);
  const sheets = loaded.wb.SheetNames.map((name, index) => {
    const sheet = buildSheet(name, index, loaded.wb.Sheets[name], date1904);
    if (sheet.limited && options.limitWarning !== false) {
      const area = `A1:${encodeAddress(GRADE_LIMIT_ROWS - 1, GRADE_LIMIT_COLS - 1)}`;
      warnings.push(
        `Sheet "${name}" in ${label} is very large, so only its first ${GRADE_LIMIT_ROWS.toLocaleString('en-US')} ` +
          `rows and ${GRADE_LIMIT_COLS} columns (${area}) are checked.`,
      );
    }
    return sheet;
  });
  return { sheets, warnings, isCsv: loaded.isCsv };
}

function buildSheet(name: string, index: number, ws: XLSX.WorkSheet | undefined, date1904: boolean): ModelSheet {
  const all: GradeCell[] = [];
  let maxR = -1;
  let maxC = -1;
  if (ws) {
    forEachCell(ws, (cell, r, c, address) => {
      const { value, isError, missing } = cellPrimitive(cell);
      const formula = cellFormula(ws, cell);
      if (formula === undefined && !isError && isBlank(value)) return;
      const entry: GradeCell = { address, r, c, value, isError, missingValue: missing };
      if (formula !== undefined) entry.formula = formula;
      if (typeof value === 'number') describeNumber(entry, value, cell, date1904);
      all.push(entry);
      if (r > maxR) maxR = r;
      if (c > maxC) maxC = c;
    });
  }
  const limited = (maxR + 1) * (maxC + 1) > MAX_GRADED_AREA;
  const list = limited ? all.filter((x) => x.r < GRADE_LIMIT_ROWS && x.c < GRADE_LIMIT_COLS) : all;
  list.sort((a, b) => a.r - b.r || a.c - b.c);
  return { name, index, cells: new Map(all.map((x) => [x.address, x])), list, limited };
}

/** The cell's formula; cells filled by an array or spill formula get the formula of the range's top-left cell. */
function cellFormula(ws: XLSX.WorkSheet, cell: XLSX.CellObject): string | undefined {
  if (hasFormula(cell)) return displayFormula(cell.f as string);
  const anchor = arrayAnchor(ws, cell);
  return anchor && hasFormula(anchor) ? displayFormula(anchor.f as string) : undefined;
}

/**
 * Number format details of a numeric cell: dates of a 1904-system workbook move to the 1900 system (so the same
 * date compares equal across files), the display units, and the display text. General numbers stay as they are.
 */
function describeNumber(entry: GradeCell, value: number, cell: XLSX.CellObject, date1904: boolean): void {
  const format = numberFormat(cell);
  if (format) {
    if (date1904 && hasDatePart(format)) entry.value = value + DATE_1904_OFFSET;
    const unit = formatUnit(format);
    if (unit) entry.unit = unit;
  }
  if (typeof cell.w === 'string' && cell.w !== '' && cell.w !== String(entry.value)) entry.text = cell.w;
}

function recalcWarnings(recalc: RecalcResult | null, label: string): string[] {
  if (!recalc) return [];
  const subject = label.charAt(0).toUpperCase() + label.slice(1);
  const resave = 'Open the file in Excel, save it, and upload it again.';
  if (recalc.failure === 'too_large') {
    return [`${subject} was saved without formula results and is too large to recalculate. ${resave}`];
  }
  if (recalc.failure === 'engine_error') {
    return [`Some formulas in ${label} were saved without results and could not be recalculated. ${resave}`];
  }
  if (recalc.unsupported > 0) {
    const what =
      recalc.unsupported === 1
        ? `1 formula in ${label} uses a function`
        : `${recalc.unsupported} formulas in ${label} use functions`;
    return [`${what} the autograder can't calculate (shown as #NAME?). ${resave}`];
  }
  return [];
}

function sniffContainer(buf: Buffer): Container {
  if (buf[0] === 0x50 && buf[1] === 0x4b) return 'zip';
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0xd0cf11e0 && buf.readUInt32BE(4) === 0xa1b11ae1) return 'cfb';
  if (buf[0] === 0x09 && [0x00, 0x02, 0x04, 0x08].includes(buf[1])) return 'biff';
  if ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)) return 'text';
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'binary';
  const sample = buf.subarray(0, 8192);
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) return 'binary';
    if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
  }
  return control > sample.length * 0.1 ? 'binary' : 'text';
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * SheetJS decodes BOM-less text as Latin-1, which garbles "Café" in UTF-8 CSVs and turns the Windows-1252 bytes
 * 0x80-0x9F ("O’Brien", "Šimić") into invisible control characters. Text with a BOM, HTML/XML (which declare their
 * own encoding) and plain ASCII are passed through; valid UTF-8 gets a UTF-8 BOM; anything else is decoded as the
 * legacy encoding Excel saves "CSV" files in (decodeLegacyText) and passed on as UTF-8 with a BOM.
 */
function asUtf8Text(buf: Buffer): Buffer {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf;
  if (buf[0] === 0xff || buf[0] === 0xfe) return buf;
  if (/^\s*</.test(buf.subarray(0, 256).toString('latin1'))) return buf;
  if (!buf.some((byte) => byte > 0x7f)) return buf;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return Buffer.concat([UTF8_BOM, buf]);
  } catch {
    return Buffer.concat([UTF8_BOM, Buffer.from(decodeLegacyText(buf), 'utf8')]);
  }
}

/**
 * Windows-1252 characters of the bytes 0x80-0x9F (the rest of the code page is Latin-1). The five unassigned bytes
 * keep their Latin-1 meaning. Written out because Node's TextDecoder('windows-1252') decodes this range as Latin-1.
 */
const CP1252_80_9F = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ';

function decodeCp1252(buf: Buffer): string {
  const special = (ch: string) => CP1252_80_9F[ch.charCodeAt(0) - 0x80];
  return buf.toString('latin1').replace(/[\x80-\x9f]/g, special);
}

/** Mac Roman (Excel for Mac's plain "Comma Separated Values"), or null when this Node build cannot decode it. */
function decodeMacRoman(buf: Buffer): string | null {
  try {
    return new TextDecoder('macintosh').decode(buf);
  } catch {
    return null;
  }
}

const is = (pattern: RegExp, ch: string | undefined) => ch !== undefined && pattern.test(ch);

/**
 * How much the non-ASCII characters of `text` look like real words. A letter counts +1, or -1 when the case changes
 * oddly around it ("JosÈ", "OíBrien"). Between two letters, an apostrophe counts +1 ("O’Brien") and any other
 * punctuation or symbol -1 ("Mu–oz"). Control characters count -2.
 */
function plausibility(text: string): number {
  let score = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch.charCodeAt(0) < 0x80) continue;
    const prev = text[i - 1];
    const next = text[i + 1];
    if (is(/\p{L}/u, ch)) {
      const oddCase = (is(/\p{Lu}/u, ch) && is(/\p{Ll}/u, prev)) || (is(/\p{Ll}/u, ch) && is(/\p{Lu}/u, next));
      score += oddCase ? -1 : 1;
    } else if (is(/\p{Cc}/u, ch)) score -= 2;
    else if (is(/[\p{P}\p{S}]/u, ch) && is(/\p{L}/u, prev) && is(/\p{L}/u, next)) {
      score += /[’‘ʼ´]/.test(ch) ? 1 : -1;
    }
  }
  return score;
}

/** Text that is not UTF-8: Windows-1252 unless the Mac Roman reading of it is clearly more plausible. */
function decodeLegacyText(buf: Buffer): string {
  const windows = decodeCp1252(buf);
  const mac = decodeMacRoman(buf);
  return mac !== null && plausibility(mac) > plausibility(windows) ? mac : windows;
}
