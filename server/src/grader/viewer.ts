/** Workbook → JSON for the in-browser spreadsheet viewer. */
import type * as XLSX from 'xlsx';
import type { CellType, ViewerCell, ViewerSheet, WorkbookData } from '../../../shared/types.js';
import { cellPrimitive, forEachCell, hasFormula } from './cells.js';
import { displayFormula } from './formula.js';
import type { LoadedWorkbook } from './read.js';
import { encodeAddress } from './ranges.js';

export const VIEWER_MAX_ROWS = 1000;
export const VIEWER_MAX_COLS = 100;

/** Average character width in pixels, for column widths stored only in pixels. */
const PIXELS_PER_CHAR = 7;

export function buildViewerData(loaded: LoadedWorkbook, fileName: string): WorkbookData {
  return {
    fileName,
    sheets: loaded.wb.SheetNames.map((name) => buildViewerSheet(name, loaded.wb.Sheets[name])),
  };
}

function buildViewerSheet(name: string, ws: XLSX.WorkSheet | undefined): ViewerSheet {
  const cells: Record<string, ViewerCell> = {};
  let maxR = -1;
  let maxC = -1;
  if (ws) {
    forEachCell(ws, (cell, r, c, address) => {
      const viewerCell = toViewerCell(cell);
      if (!viewerCell) return;
      if (r > maxR) maxR = r;
      if (c > maxC) maxC = c;
      if (r < VIEWER_MAX_ROWS && c < VIEWER_MAX_COLS) cells[address] = viewerCell;
    });
  }

  const merges: string[] = [];
  for (const merge of ws?.['!merges'] ?? []) {
    maxR = Math.max(maxR, merge.e.r);
    maxC = Math.max(maxC, merge.e.c);
    if (merge.s.r >= VIEWER_MAX_ROWS || merge.s.c >= VIEWER_MAX_COLS) continue;
    const endR = Math.min(merge.e.r, VIEWER_MAX_ROWS - 1);
    const endC = Math.min(merge.e.c, VIEWER_MAX_COLS - 1);
    if (endR === merge.s.r && endC === merge.s.c) continue;
    merges.push(`${encodeAddress(merge.s.r, merge.s.c)}:${encodeAddress(endR, endC)}`);
  }

  const rowCount = Math.min(maxR + 1, VIEWER_MAX_ROWS);
  const colCount = Math.min(maxC + 1, VIEWER_MAX_COLS);
  const sheet: ViewerSheet = {
    name,
    rowCount,
    colCount,
    truncated: maxR + 1 > VIEWER_MAX_ROWS || maxC + 1 > VIEWER_MAX_COLS,
    cells,
    merges,
  };
  const colWidths = columnWidths(ws?.['!cols'], colCount);
  if (colWidths) sheet.colWidths = colWidths;
  return sheet;
}

/** null for cells with nothing to show (no value and no formula). */
function toViewerCell(cell: XLSX.CellObject): ViewerCell | null {
  const formula = hasFormula(cell) ? displayFormula(cell.f as string) : undefined;
  const { value, isError, missing } = cellPrimitive(cell);
  if (formula === undefined && (value === null || value === '')) return null;

  const out: ViewerCell = { v: value, t: viewerType(value, isError) };
  const text = missing ? undefined : cell.w;
  if (typeof text === 'string' && !(typeof value === 'string' && text === value)) out.w = text;
  if (formula !== undefined) out.f = formula;
  return out;
}

function viewerType(value: unknown, isError: boolean): CellType {
  if (isError) return 'e';
  if (typeof value === 'number') return 'n';
  if (typeof value === 'boolean') return 'b';
  return 's';
}

/** Widths in characters (index 0 = column A), or undefined when the file stores none. */
function columnWidths(cols: XLSX.ColInfo[] | undefined, colCount: number): (number | null)[] | undefined {
  if (!cols?.length || colCount === 0) return undefined;
  const widths: (number | null)[] = [];
  for (let c = 0; c < Math.min(cols.length, colCount); c += 1) {
    const col = cols[c];
    const chars = col?.wch ?? (col?.wpx !== undefined ? col.wpx / PIXELS_PER_CHAR : col?.width);
    widths.push(typeof chars === 'number' && Number.isFinite(chars) && chars >= 0 ? Math.round(chars * 10) / 10 : null);
  }
  return widths.some((w) => w !== null) ? widths : undefined;
}
