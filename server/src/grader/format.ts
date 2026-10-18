/** What a cell's Excel number format ("0.0%", "h:mm", "m/d/yyyy", '"$"#,##0.00') says about its value. */
import * as XLSX from 'xlsx';
import type { NumberUnit } from './compare.js';

/** 1904-01-01 is day 0 in the 1904 date system and day 1462 in the 1900 system. */
export const DATE_1904_OFFSET = 1462;

/** The cell's number format, or undefined for General / none. */
export function numberFormat(cell: XLSX.CellObject): string | undefined {
  return typeof cell.z === 'string' && cell.z.trim() !== '' && cell.z !== 'General' ? cell.z : undefined;
}

interface FormatInfo {
  unit: NumberUnit | undefined;
  datePart: boolean;
}

/** Workbooks use a handful of formats for many cells; remember what each one means. */
const infoCache = new Map<string, FormatInfo>();
const INFO_CACHE_ENTRIES = 1000;

/** 'percent' for formats with "%", 'time' for date/time formats showing hours or seconds (h:mm, [h]:mm, mm:ss). */
export function formatUnit(format: string): NumberUnit | undefined {
  return formatInfo(format).unit;
}

/** True for formats that show a calendar date (m/d/yyyy, d-mmm, mmmm yyyy), not just a time of day or duration. */
export function hasDatePart(format: string): boolean {
  return formatInfo(format).datePart;
}

function formatInfo(format: string): FormatInfo {
  let info = infoCache.get(format);
  if (!info) {
    const tokens = formatTokens(format);
    const isDate = isDateFormat(format);
    const time = /[hs]/i.test(tokens);
    info = {
      unit: tokens.includes('%') ? 'percent' : isDate && time ? 'time' : undefined,
      datePart: isDate && (/[dy]/i.test(tokens) || (/m/i.test(tokens) && !time)),
    };
    if (infoCache.size >= INFO_CACHE_ENTRIES) infoCache.clear();
    infoCache.set(format, info);
  }
  return info;
}

function isDateFormat(format: string): boolean {
  try {
    return XLSX.SSF.is_date(format) === true;
  } catch {
    return false;
  }
}

/**
 * The format without the parts that are shown literally: "quoted text", backslash-escaped characters, padding
 * (_x) and fill (*x) characters, and bracketed tags such as [$€-407], [Red] or [>=100] (the elapsed-time tokens
 * [h], [mm] and [ss] are kept).
 */
function formatTokens(format: string): string {
  return format
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/[_*]./g, '')
    .replace(/\[(?!(?:h+|m+|s+)\])[^\]]*\]/gi, '');
}
