/**
 * The virtualized cell grid of the spreadsheet viewer: a plain <table> (no Mantine component per cell) with sticky
 * column letters and row numbers. Only the rows and columns in (and near) the viewport are rendered — the rest is
 * represented by spacer rows/columns — so 1000×100 sheets stay fast.
 */
import {
  memo,
  useCallback,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
} from 'react';
import { useElementSize, useMergedRef } from '@mantine/hooks';
import type { ViewerCell } from '@shared/types';
import type { CellHighlight } from '../SpreadsheetViewer';
import type { CellPos, CellRange } from './a1';
import { cellAlign, cellDisplayText } from './cellFormat';
import {
  HEADER_HEIGHT,
  ROW_HEIGHT,
  cellKey,
  cellRangeAt,
  displayRowCount,
  layoutColumns,
  rowHeaderWidth,
  toAnchor,
  type ColumnLayout,
  type SheetModel,
} from './sheetModel';
import classes from './SpreadsheetViewer.module.css';

/** Rows rendered above/below the viewport, and the step the row window moves in (fewer re-renders). */
const ROW_OVERSCAN = 16;
const ROW_CHUNK = 12;
/** Same for columns, in pixels and columns. */
const COL_OVERSCAN_PX = 360;
const COL_CHUNK = 4;
/** Used before the grid has been measured. */
const FALLBACK_WIDTH = 1200;

export interface SheetGridHandle {
  /** Scrolls the grid so the cell (or its merged range) is fully visible, like scrollIntoView 'nearest'. */
  scrollToCell: (pos: CellPos) => void;
  focus: () => void;
}

interface SheetGridProps {
  model: SheetModel;
  highlights?: Record<string, CellHighlight>;
  showFormulas: boolean;
  selected: CellPos | null;
  onSelect: (pos: CellPos) => void;
  onToggleFormulas: () => void;
  onCopy: () => void;
  height: number;
  label: string;
  ref?: Ref<SheetGridHandle>;
}

/** Rendered rows [start, end) and columns [cStart, cEnd). */
interface GridWindow {
  start: number;
  end: number;
  cStart: number;
  cEnd: number;
}

interface HoverTip {
  r: number;
  c: number;
  message: string;
  x: number;
  y: number;
  below: boolean;
}

/** Index of the last column whose left edge is at or before `x`. */
function columnAt(cols: ColumnLayout, x: number): number {
  let lo = 0;
  let hi = cols.count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cols.offsets[mid] <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function computeWindow(
  el: { scrollTop: number; scrollLeft: number; clientHeight: number; clientWidth: number },
  rows: number,
  cols: ColumnLayout,
  headerWidth: number,
): GridWindow {
  const first = Math.floor(Math.max(0, el.scrollTop) / ROW_HEIGHT);
  const visible = Math.ceil(el.clientHeight / ROW_HEIGHT) + 1;
  const start = Math.max(0, Math.floor((first - ROW_OVERSCAN) / ROW_CHUNK) * ROW_CHUNK);
  const last = Math.ceil((first + visible + ROW_OVERSCAN) / ROW_CHUNK) * ROW_CHUNK;
  const end = Math.max(Math.min(rows, start + 1), Math.min(rows, last));

  const left = Math.max(0, el.scrollLeft - COL_OVERSCAN_PX);
  const right = el.scrollLeft + el.clientWidth - headerWidth + COL_OVERSCAN_PX;
  const cStart = Math.floor(columnAt(cols, left) / COL_CHUNK) * COL_CHUNK;
  const cEnd = Math.min(cols.count, Math.ceil((columnAt(cols, right) + 1) / COL_CHUNK) * COL_CHUNK);
  return { start, end, cStart, cEnd: Math.max(cEnd, Math.min(cols.count, cStart + 1)) };
}

function sameWindow(a: GridWindow, b: GridWindow): boolean {
  return a.start === b.start && a.end === b.end && a.cStart === b.cStart && a.cEnd === b.cEnd;
}

function spanWidth(cols: ColumnLayout, c1: number, c2: number): number {
  const last = Math.min(c2, cols.count - 1);
  return cols.offsets[last] + cols.widths[last] - cols.offsets[c1];
}

/** Reads data-r / data-c from the cell or header under a pointer event. */
function cellFromEvent(target: EventTarget | null): { r?: number; c?: number } | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest<HTMLElement>('[data-r], [data-c]');
  if (!el) return null;
  const r = el.dataset.r === undefined ? undefined : Number(el.dataset.r);
  const c = el.dataset.c === undefined ? undefined : Number(el.dataset.c);
  return { r, c };
}

export function SheetGrid({
  model,
  highlights,
  showFormulas,
  selected,
  onSelect,
  onToggleFormulas,
  onCopy,
  height,
  label,
  ref,
}: SheetGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { ref: sizeRef, width: viewportWidth } = useElementSize<HTMLDivElement>();
  const mergedRef = useMergedRef(scrollRef, sizeRef);

  const rows = displayRowCount(model, height);
  const headerWidth = rowHeaderWidth(rows);
  const cols = useMemo(() => layoutColumns(model, viewportWidth - headerWidth), [model, viewportWidth, headerWidth]);
  const [win, setWin] = useState<GridWindow>(() => {
    const initial = { scrollTop: 0, scrollLeft: 0, clientHeight: height, clientWidth: FALLBACK_WIDTH };
    return computeWindow(initial, rows, cols, headerWidth);
  });
  const [tip, setTip] = useState<HoverTip | null>(null);
  const selectedId = `${useId()}-sel`;

  const updateWindow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const next = computeWindow(
      {
        scrollTop: el.scrollTop,
        scrollLeft: el.scrollLeft,
        clientHeight: el.clientHeight || height,
        clientWidth: el.clientWidth || FALLBACK_WIDTH,
      },
      rows,
      cols,
      headerWidth,
    );
    setWin((prev) => (sameWindow(prev, next) ? prev : next));
  }, [height, rows, cols, headerWidth]);

  useLayoutEffect(updateWindow, [updateWindow]);

  const scrollToCell = useCallback(
    (pos: CellPos) => {
      const el = scrollRef.current;
      if (!el) return;
      const range = cellRangeAt(model, pos);
      const top = HEADER_HEIGHT + range.r1 * ROW_HEIGHT;
      const bottom = HEADER_HEIGHT + (range.r2 + 1) * ROW_HEIGHT;
      const c1 = Math.min(range.c1, cols.count - 1);
      const left = headerWidth + cols.offsets[c1];
      const right = left + spanWidth(cols, c1, range.c2);
      let { scrollTop, scrollLeft } = el;
      if (top - HEADER_HEIGHT < scrollTop) scrollTop = top - HEADER_HEIGHT;
      else if (bottom > scrollTop + el.clientHeight) scrollTop = bottom - el.clientHeight;
      if (left - headerWidth < scrollLeft) scrollLeft = left - headerWidth;
      else if (right > scrollLeft + el.clientWidth) scrollLeft = Math.min(left - headerWidth, right - el.clientWidth);
      if (scrollTop !== el.scrollTop || scrollLeft !== el.scrollLeft) {
        el.scrollTo({ top: scrollTop, left: scrollLeft });
        updateWindow();
      }
    },
    [model, cols, headerWidth, updateWindow],
  );

  useImperativeHandle(ref, () => ({ scrollToCell, focus: () => scrollRef.current?.focus({ preventScroll: true }) }), [
    scrollToCell,
  ]);

  // Latest selection, also updated between renders so fast key repeats build on each other.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const select = (pos: CellPos) => {
    const anchor = toAnchor(model, {
      r: Math.max(0, Math.min(rows - 1, pos.r)),
      c: Math.max(0, Math.min(cols.count - 1, pos.c)),
    });
    selectedRef.current = anchor;
    onSelect(anchor);
    scrollToCell(anchor);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === '`' || e.code === 'Backquote')) {
      e.preventDefault();
      onToggleFormulas();
      return;
    }
    const current = selectedRef.current;
    if (mod && e.key.toLowerCase() === 'c' && current) {
      e.preventDefault();
      onCopy();
      return;
    }
    const el = scrollRef.current;
    const pageRows = Math.max(1, Math.floor(((el?.clientHeight ?? height) - HEADER_HEIGHT) / ROW_HEIGHT) - 1);
    const lastRow = Math.max(0, model.contentRows - 1);
    const lastCol = Math.max(0, model.contentCols - 1);
    const cur = current ?? { r: 0, c: 0 };
    const range = cellRangeAt(model, cur);
    let next: CellPos;
    switch (e.key) {
      case 'ArrowUp':
        next = { r: mod ? 0 : range.r1 - 1, c: cur.c };
        break;
      case 'ArrowDown':
        next = { r: mod ? lastRow : range.r2 + 1, c: cur.c };
        break;
      case 'ArrowLeft':
        next = { r: cur.r, c: mod ? 0 : range.c1 - 1 };
        break;
      case 'ArrowRight':
        next = { r: cur.r, c: mod ? lastCol : range.c2 + 1 };
        break;
      case 'Enter':
        next = { r: e.shiftKey ? range.r1 - 1 : range.r2 + 1, c: cur.c };
        break;
      case 'Home':
        next = mod ? { r: 0, c: 0 } : { r: cur.r, c: 0 };
        break;
      case 'End':
        next = mod ? { r: lastRow, c: lastCol } : { r: cur.r, c: lastCol };
        break;
      case 'PageUp':
        next = { r: cur.r - pageRows, c: cur.c };
        break;
      case 'PageDown':
        next = { r: cur.r + pageRows, c: cur.c };
        break;
      default:
        return;
    }
    e.preventDefault();
    select(next);
  };

  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const hit = cellFromEvent(e.target);
    if (!hit) return;
    e.preventDefault(); // keep the browser from starting a text selection; focus manually instead
    scrollRef.current?.focus({ preventScroll: true });
    select({ r: hit.r ?? 0, c: hit.c ?? 0 });
  };

  const onMouseOver = (e: React.MouseEvent<HTMLDivElement>) => {
    const hit = cellFromEvent(e.target);
    const el = scrollRef.current;
    if (!hit || hit.r === undefined || hit.c === undefined || !el) {
      if (tip) setTip(null);
      return;
    }
    const { r, c } = hit;
    if (tip && tip.r === r && tip.c === c) return;
    const message = highlights?.[`${cols.letters[c]}${r + 1}`]?.message;
    if (!message) {
      if (tip) setTip(null);
      return;
    }
    const range = cellRangeAt(model, { r, c });
    const top = HEADER_HEIGHT + range.r1 * ROW_HEIGHT;
    const center = headerWidth + cols.offsets[c] + spanWidth(cols, c, range.c2) / 2;
    const minX = el.scrollLeft + headerWidth + 80;
    const maxX = el.scrollLeft + el.clientWidth - 80;
    const below = top - el.scrollTop < HEADER_HEIGHT + 56;
    setTip({
      r,
      c,
      message,
      x: maxX > minX ? Math.min(maxX, Math.max(minX, center)) : center,
      y: below ? HEADER_HEIGHT + (range.r2 + 1) * ROW_HEIGHT : top,
      below,
    });
  };

  // The window can briefly lag behind a change in column count (e.g. after a resize); clamp it.
  const cEnd = Math.min(win.cEnd, cols.count);
  const cStart = Math.min(win.cStart, Math.max(0, cEnd - 1));
  const leftPad = cols.offsets[cStart];
  const rightPad = cEnd < cols.count ? cols.total - cols.offsets[cEnd] : 0;
  const spanAll = 1 + (cEnd - cStart) + (leftPad > 0 ? 1 : 0) + (rightPad > 0 ? 1 : 0);

  const selRange: CellRange | null = selected ? cellRangeAt(model, selected) : null;
  const selKey = selected ? cellKey(selected.r, selected.c) : -1;
  const selVisible =
    !!selRange && selRange.r2 >= win.start && selRange.r1 < win.end && selRange.c2 >= cStart && selRange.c1 < cEnd;

  const rowEls = [];
  for (let r = win.start; r < win.end; r++) {
    const isMergeRow = model.mergeRows.has(r);
    rowEls.push(
      <GridRow
        key={r}
        r={r}
        cols={cols}
        cStart={cStart}
        cEnd={cEnd}
        leftPad={leftPad > 0}
        rightPad={rightPad > 0}
        cells={model.sheet.cells}
        merges={isMergeRow ? model.mergeByCell : null}
        windowStart={isMergeRow ? win.start : 0}
        windowEnd={isMergeRow ? win.end : 0}
        highlights={highlights}
        showFormulas={showFormulas}
        selKey={isMergeRow || selected?.r === r ? selKey : -1}
        headerActive={!!selRange && r >= selRange.r1 && r <= selRange.r2}
        selectedId={selectedId}
      />,
    );
  }

  const dataCols = [];
  for (let c = cStart; c < cEnd; c++) dataCols.push(<col key={c} style={{ width: cols.widths[c] }} />);

  return (
    <div
      ref={mergedRef}
      className={classes.scroller}
      style={{ height }}
      tabIndex={0}
      role="grid"
      aria-label={label}
      aria-readonly
      aria-rowcount={rows + 1}
      aria-colcount={cols.count + 1}
      aria-activedescendant={selVisible ? selectedId : undefined}
      onScroll={() => {
        updateWindow();
        if (tip) setTip(null);
      }}
      onFocus={() => {
        // Like Excel, a sheet always has an active cell once you are in it.
        if (!selected) onSelect({ r: 0, c: 0 });
      }}
      onKeyDown={onKeyDown}
      onMouseDown={onMouseDown}
      onMouseOver={onMouseOver}
      onMouseLeave={() => setTip(null)}
    >
      <div className={classes.canvas}>
        <table className={classes.table} role="presentation" style={{ width: headerWidth + cols.total }}>
          <colgroup>
            <col style={{ width: headerWidth }} />
            {leftPad > 0 && <col style={{ width: leftPad }} />}
            {dataCols}
            {rightPad > 0 && <col style={{ width: rightPad }} />}
          </colgroup>
          <HeaderRow
            cols={cols}
            cStart={cStart}
            cEnd={cEnd}
            leftPad={leftPad > 0}
            rightPad={rightPad > 0}
            activeFrom={selRange?.c1 ?? -1}
            activeTo={selRange?.c2 ?? -1}
          />
          <tbody role="rowgroup">
            {win.start > 0 && (
              <tr className={classes.spacer} aria-hidden style={{ height: win.start * ROW_HEIGHT }}>
                <td colSpan={spanAll} />
              </tr>
            )}
            {rowEls}
            {win.end < rows && (
              <tr className={classes.spacer} aria-hidden style={{ height: (rows - win.end) * ROW_HEIGHT }}>
                <td colSpan={spanAll} />
              </tr>
            )}
          </tbody>
        </table>
        {tip && (
          <div
            className={classes.tooltip}
            role="tooltip"
            data-below={tip.below || undefined}
            style={{ left: tip.x, top: tip.y }}
          >
            {tip.message}
          </div>
        )}
      </div>
    </div>
  );
}

const HeaderRow = memo(function HeaderRow({
  cols,
  cStart,
  cEnd,
  leftPad,
  rightPad,
  activeFrom,
  activeTo,
}: {
  cols: ColumnLayout;
  cStart: number;
  cEnd: number;
  leftPad: boolean;
  rightPad: boolean;
  activeFrom: number;
  activeTo: number;
}) {
  const ths = [];
  for (let c = cStart; c < cEnd; c++) {
    ths.push(
      <th
        key={c}
        role="columnheader"
        aria-colindex={c + 2}
        data-c={c}
        data-active={(c >= activeFrom && c <= activeTo) || undefined}
      >
        {cols.letters[c]}
      </th>,
    );
  }
  return (
    <thead role="rowgroup">
      <tr role="row" aria-rowindex={1}>
        <th className={`${classes.corner} ${classes.rowHeader}`} role="columnheader" aria-label="Row numbers" />
        {leftPad && <th className={classes.pad} aria-hidden />}
        {ths}
        {rightPad && <th className={classes.pad} aria-hidden />}
      </tr>
    </thead>
  );
});

interface GridRowProps {
  r: number;
  cols: ColumnLayout;
  cStart: number;
  cEnd: number;
  leftPad: boolean;
  rightPad: boolean;
  cells: Record<string, ViewerCell>;
  /** Only passed for rows touched by a merge (so other rows keep stable props and skip re-rendering). */
  merges: Map<number, CellRange> | null;
  windowStart: number;
  windowEnd: number;
  highlights?: Record<string, CellHighlight>;
  showFormulas: boolean;
  /** cellKey of the selected cell, or -1 when it is not in this row. */
  selKey: number;
  headerActive: boolean;
  selectedId: string;
}

const GridRow = memo(function GridRow({
  r,
  cols,
  cStart,
  cEnd,
  leftPad,
  rightPad,
  cells,
  merges,
  windowStart,
  windowEnd,
  highlights,
  showFormulas,
  selKey,
  headerActive,
  selectedId,
}: GridRowProps) {
  const renderCell = (r0: number, c0: number, rowSpan: number, colSpan: number) => {
    const address = `${cols.letters[c0]}${r0 + 1}`;
    const cell = cells[address];
    const hl = highlights?.[address];
    const isSelected = selKey === cellKey(r0, c0);
    const formula = showFormulas && !!cell?.f;
    return (
      <td
        key={c0}
        role="gridcell"
        aria-colindex={c0 + 2}
        aria-selected={isSelected || undefined}
        id={isSelected ? selectedId : undefined}
        className={classes.cell}
        rowSpan={rowSpan > 1 ? rowSpan : undefined}
        colSpan={colSpan > 1 ? colSpan : undefined}
        data-r={r0}
        data-c={c0}
        data-align={cellAlign(cell, showFormulas)}
        data-hl={hl?.status}
        data-selected={isSelected || undefined}
        data-formula={formula || undefined}
        data-error={(cell?.t === 'e' && !formula) || undefined}
        data-merged={rowSpan > 1 || colSpan > 1 || undefined}
      >
        {cellDisplayText(cell, showFormulas)}
        {hl && (
          <span className={classes.srOnly}>{hl.message ?? (hl.status === 'correct' ? 'Correct' : 'Incorrect')}</span>
        )}
      </td>
    );
  };

  const tds = [];
  for (let c = cStart; c < cEnd; c++) {
    const m = merges?.get(cellKey(r, c));
    if (!m) {
      tds.push(renderCell(r, c, 1, 1));
      continue;
    }
    // A merge renders once, at its anchor — or at the window's first row/column when the anchor is scrolled away.
    if (r !== Math.max(m.r1, windowStart) || c !== Math.max(m.c1, cStart)) continue;
    const rowSpan = Math.min(m.r2, windowEnd - 1) - r + 1;
    const colSpan = Math.min(m.c2, cEnd - 1) - c + 1;
    tds.push(renderCell(m.r1, m.c1, rowSpan, colSpan));
  }

  return (
    <tr role="row" aria-rowindex={r + 2}>
      <th className={classes.rowHeader} role="rowheader" data-r={r} data-active={headerActive || undefined}>
        {r + 1}
      </th>
      {leftPad && <td className={classes.pad} aria-hidden />}
      {tds}
      {rightPad && <td className={classes.pad} aria-hidden />}
    </tr>
  );
});
