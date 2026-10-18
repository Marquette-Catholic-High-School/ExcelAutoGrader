/** Precomputed layout data for one sheet, so the grid can render rows cheaply. */
import type { ViewerSheet } from '@shared/types';
import { columnLetter, parseAddress, parseRange, type CellPos, type CellRange } from './a1';
import { cellDisplayText } from './cellFormat';

export const ROW_HEIGHT = 24;
export const HEADER_HEIGHT = 24;
export const DEFAULT_COL_WIDTH = 90;
const MIN_COL_WIDTH = 48;
const MAX_COL_WIDTH = 640;
/** Columns without a stored width (e.g. every CSV column) grow to fit their text, up to this. */
const AUTO_MAX_WIDTH = 320;
/** Highlights/merges outside the sheet's range may extend the grid, but never beyond these. */
const MAX_ROWS = 5000;
const MAX_COLS = 200;

/** Unique numeric key for a cell (Excel has at most 16,384 columns). */
export function cellKey(r: number, c: number): number {
  return r * 16384 + c;
}

export interface SheetModel {
  sheet: ViewerSheet;
  /** Rows/columns that hold data, merges or highlights (before padding to fill the viewport). */
  contentRows: number;
  contentCols: number;
  /** Every cell inside a merged range (anchor included) → that range. */
  mergeByCell: Map<number, CellRange>;
  /** Rows touched by at least one merge (they need the window bounds to clip row spans). */
  mergeRows: Set<number>;
  /** Pixel width of each content column. */
  columnWidths: number[];
  /** False for a sheet with no cells, merges or highlights. */
  hasContent: boolean;
}

export function buildSheetModel(sheet: ViewerSheet, highlightAddresses: string[] = []): SheetModel {
  let rows = Math.max(0, sheet.rowCount);
  let cols = Math.max(0, sheet.colCount);
  const extend = (pos: CellPos) => {
    rows = Math.max(rows, Math.min(pos.r + 1, MAX_ROWS));
    cols = Math.max(cols, Math.min(pos.c + 1, MAX_COLS));
  };
  for (const address of highlightAddresses) {
    const pos = parseAddress(address);
    if (pos) extend(pos);
  }

  const mergeByCell = new Map<number, CellRange>();
  const mergeRows = new Set<number>();
  for (const text of sheet.merges) {
    const parsed = parseRange(text);
    if (!parsed || (parsed.r1 === parsed.r2 && parsed.c1 === parsed.c2)) continue;
    const m: CellRange = { ...parsed, r2: Math.min(parsed.r2, MAX_ROWS - 1), c2: Math.min(parsed.c2, MAX_COLS - 1) };
    if (m.r1 > m.r2 || m.c1 > m.c2) continue;
    extend({ r: m.r2, c: m.c2 });
    for (let r = m.r1; r <= m.r2; r++) {
      mergeRows.add(r);
      for (let c = m.c1; c <= m.c2; c++) mergeByCell.set(cellKey(r, c), m);
    }
  }

  const hasContent = hasAnyCell(sheet) || mergeByCell.size > 0 || highlightAddresses.length > 0;
  const columnWidths = contentColumnWidths(sheet, cols);
  return { sheet, contentRows: rows, contentCols: cols, mergeByCell, mergeRows, columnWidths, hasContent };
}

/** 0-based column of an A1 address, read from its leading letters ("AB12" → 27). */
function addressColumn(address: string): number {
  let c = 0;
  for (let i = 0; i < address.length; i++) {
    const code = address.charCodeAt(i);
    if (code < 65 || code > 90) break;
    c = c * 26 + (code - 64);
  }
  return c - 1;
}

/** Excel's stored widths where known; other columns are sized to their longest text (never below the default). */
function contentColumnWidths(sheet: ViewerSheet, cols: number): number[] {
  const stored = (c: number) => sheet.colWidths?.[c];
  const widths = Array.from({ length: cols }, (_, c) => columnWidthPx(stored(c)));
  const auto = widths.map((_, c) => !((stored(c) ?? 0) > 0));
  if (!auto.some(Boolean)) return widths;
  const longest: string[] = new Array<string>(cols).fill('');
  for (const address in sheet.cells) {
    const c = addressColumn(address);
    if (c < 0 || c >= cols || !auto[c]) continue;
    const text = cellDisplayText(sheet.cells[address], false);
    if (text.length > longest[c].length) longest[c] = text;
  }
  return widths.map((w, c) =>
    auto[c] && longest[c] ? Math.min(AUTO_MAX_WIDTH, Math.max(w, Math.ceil(textWidth(longest[c]) + 16))) : w,
  );
}

let measureContext: CanvasRenderingContext2D | null | undefined;

/** Rendered width of grid text in pixels (13px, the page font); estimated where canvas is unavailable. */
function textWidth(text: string): number {
  if (measureContext === undefined) {
    measureContext = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
    if (measureContext) measureContext.font = `13px ${getComputedStyle(document.body).fontFamily}`;
  }
  return measureContext ? measureContext.measureText(text).width : text.length * 8;
}

function hasAnyCell(sheet: ViewerSheet): boolean {
  for (const key in sheet.cells) if (Object.hasOwn(sheet.cells, key)) return true;
  return false;
}

/** Excel column width in characters → pixels. */
export function columnWidthPx(chars: number | null | undefined): number {
  if (chars === null || chars === undefined || !(chars > 0)) return DEFAULT_COL_WIDTH;
  return Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, Math.round(chars * 7 + 12)));
}

export interface ColumnLayout {
  count: number;
  widths: number[];
  /** Left edge of each column, relative to the first data column. */
  offsets: number[];
  letters: string[];
  total: number;
}

/**
 * Column widths for the grid. Unless the sheet was truncated, blank columns are added so the grid fills
 * `minWidth` pixels like a real spreadsheet does.
 */
export function layoutColumns(model: SheetModel, minWidth: number): ColumnLayout {
  const widths: number[] = [];
  const offsets: number[] = [];
  const letters: string[] = [];
  let total = 0;
  const push = (c: number) => {
    const w = model.columnWidths[c] ?? columnWidthPx(model.sheet.colWidths?.[c]);
    widths.push(w);
    offsets.push(total);
    letters.push(columnLetter(c));
    total += w;
  };
  const base = Math.max(1, model.contentCols);
  for (let c = 0; c < base; c++) push(c);
  if (!model.sheet.truncated) {
    push(widths.length);
    while (total < minWidth && widths.length < MAX_COLS) push(widths.length);
  }
  return { count: widths.length, widths, offsets, letters, total };
}

/** Total grid rows: the content plus blank rows to fill the viewport (none when the sheet was truncated). */
export function displayRowCount(model: SheetModel, viewportHeight: number): number {
  const base = Math.max(1, model.contentRows);
  if (model.sheet.truncated) return base;
  return Math.min(MAX_ROWS, Math.max(base + 1, Math.ceil((viewportHeight - HEADER_HEIGHT) / ROW_HEIGHT)));
}

/** Width of the row-number column, wide enough for the largest row number. */
export function rowHeaderWidth(rows: number): number {
  return Math.max(40, String(rows).length * 8 + 18);
}

/** The merged range a cell belongs to, or a 1×1 range. */
export function cellRangeAt(model: SheetModel, pos: CellPos): CellRange {
  return model.mergeByCell.get(cellKey(pos.r, pos.c)) ?? { r1: pos.r, c1: pos.c, r2: pos.r, c2: pos.c };
}

/** Moves a position onto the anchor (top-left) of its merge, if it is inside one. */
export function toAnchor(model: SheetModel, pos: CellPos): CellPos {
  const m = model.mergeByCell.get(cellKey(pos.r, pos.c));
  return m ? { r: m.r1, c: m.c1 } : pos;
}
