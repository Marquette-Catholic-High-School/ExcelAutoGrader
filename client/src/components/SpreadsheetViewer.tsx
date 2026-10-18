import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, Badge, Button, EmptyState, Group, Skeleton, Switch, Text, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import {
  IconAlertTriangle,
  IconArrowRight,
  IconCheck,
  IconCircleCheck,
  IconCircleX,
  IconFileSpreadsheet,
  IconInfoCircle,
  IconMathFunction,
  IconTableOff,
  IconX,
} from '@tabler/icons-react';
import type { GradeReport, ViewerSheet, WorkbookData } from '@shared/types';
import { endpoints, qk } from '../api/endpoints';
import { ErrorAlert } from './QueryState';
import { parseAddress, parseRange, toAddress, type CellPos } from './viewer/a1';
import { cellDisplayText, cellEditText, describeCellResult } from './viewer/cellFormat';
import { SheetGrid, type SheetGridHandle } from './viewer/SheetGrid';
import { buildSheetModel } from './viewer/sheetModel';
import classes from './viewer/SpreadsheetViewer.module.css';

export interface CellHighlight {
  status: 'correct' | 'incorrect';
  /** Tooltip text, e.g. "Expected 42, got 41". */
  message?: string;
}

/** highlights[sheetName][A1 address] */
export type HighlightMap = Record<string, Record<string, CellHighlight>>;

export interface CellFocus {
  sheet: string;
  address: string;
}

export interface SpreadsheetViewerProps {
  workbook: WorkbookData;
  highlights?: HighlightMap;
  /** Height of the scrollable grid in px. Default 520. */
  height?: number;
  /** When this changes, switch to the sheet, select the cell and scroll it into view. */
  focus?: CellFocus | null;
  /** Optional controlled active sheet. */
  activeSheet?: string;
  onSheetChange?: (sheetName: string) => void;
  /** Extra controls for the toolbar (e.g. a download button). */
  actions?: ReactNode;
}

/** Exact sheet name first, then a case/whitespace-insensitive match. */
function findSheet(sheets: ViewerSheet[], name: string): ViewerSheet | undefined {
  const loose = (s: string) => s.trim().toLowerCase();
  return sheets.find((s) => s.name === name) ?? sheets.find((s) => loose(s.name) === loose(name));
}

/** Moves a position to the top-left of the merged range containing it (without building a full model). */
function anchorInSheet(sheet: ViewerSheet, pos: CellPos): CellPos {
  for (const text of sheet.merges) {
    const m = parseRange(text);
    if (m && pos.r >= m.r1 && pos.r <= m.r2 && pos.c >= m.c1 && pos.c <= m.c2) return { r: m.r1, c: m.c1 };
  }
  return pos;
}

interface SheetCounts {
  correct: number;
  incorrect: number;
}

function countHighlights(highlights: HighlightMap | undefined): Record<string, SheetCounts> {
  const out: Record<string, SheetCounts> = {};
  for (const [name, cells] of Object.entries(highlights ?? {})) {
    const counts = { correct: 0, incorrect: 0 };
    for (const h of Object.values(cells)) counts[h.status] += 1;
    out[name] = counts;
  }
  return out;
}

/**
 * Excel-like read-only grid: sheet tabs, column letters / row numbers, a formula bar for the selected cell,
 * a "show formulas" toggle, and colored highlights (green = correct, red = incorrect) with tooltips.
 */
export function SpreadsheetViewer({
  workbook,
  highlights,
  height = 520,
  focus,
  activeSheet,
  onSheetChange,
  actions,
}: SpreadsheetViewerProps) {
  const { sheets } = workbook;
  const [ownSheet, setOwnSheet] = useState(() => sheets[0]?.name ?? '');
  const sheet = sheets.find((s) => s.name === (activeSheet ?? ownSheet)) ?? sheets[0];
  const sheetName = sheet?.name ?? '';
  const [showFormulas, setShowFormulas] = useState(false);
  const [selection, setSelection] = useState<Record<string, CellPos>>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<SheetGridHandle>(null);
  const pendingScroll = useRef<{ sheet: string; pos: CellPos } | null>(null);

  const sheetHighlights = sheet ? highlights?.[sheet.name] : undefined;
  const model = useMemo(
    () => (sheet ? buildSheetModel(sheet, sheetHighlights ? Object.keys(sheetHighlights) : []) : null),
    [sheet, sheetHighlights],
  );
  const counts = useMemo(() => countHighlights(highlights), [highlights]);
  const activeCounts = counts[sheetName];
  const incorrectCells = useMemo(
    () =>
      Object.entries(sheetHighlights ?? {})
        .filter(([, h]) => h.status === 'incorrect')
        .map(([address]) => parseAddress(address))
        .filter((p): p is CellPos => p !== null)
        .sort((a, b) => a.r - b.r || a.c - b.c),
    [sheetHighlights],
  );

  const changeSheet = useCallback(
    (name: string) => {
      setOwnSheet(name);
      onSheetChange?.(name);
    },
    [onSheetChange],
  );

  const selected = selection[sheetName] ?? null;
  const select = useCallback(
    (pos: CellPos) => setSelection((prev) => ({ ...prev, [sheetName]: pos })),
    [sheetName],
  );

  // External focus requests (e.g. a click on a grade report row). Runs only when `focus` itself changes.
  useEffect(() => {
    if (!focus) return;
    const target = findSheet(sheets, focus.sheet);
    const pos = parseAddress(focus.address);
    if (!target || !pos) return;
    const anchor = anchorInSheet(target, pos);
    if (target.name !== sheetName) changeSheet(target.name);
    setSelection((prev) => ({ ...prev, [target.name]: anchor }));
    pendingScroll.current = { sheet: target.name, pos: anchor };
    rootRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [focus]);

  // Scroll the grid once the requested sheet is on screen.
  useLayoutEffect(() => {
    const pending = pendingScroll.current;
    if (pending && pending.sheet === sheetName && gridRef.current) {
      pendingScroll.current = null;
      gridRef.current.scrollToCell(pending.pos);
    }
  });

  const goToNextIncorrect = () => {
    const next =
      incorrectCells.find((p) => !selected || p.r > selected.r || (p.r === selected.r && p.c > selected.c)) ??
      incorrectCells[0];
    if (!next || !sheet) return;
    const anchor = anchorInSheet(sheet, next);
    select(anchor);
    gridRef.current?.scrollToCell(anchor);
  };

  const selAddress = selected ? toAddress(selected) : null;
  const selCell = selAddress && sheet ? sheet.cells[selAddress] : undefined;
  const selHighlight = selAddress ? sheetHighlights?.[selAddress] : undefined;
  const editText = cellEditText(selCell);

  const copySelection = () => {
    if (!selAddress) return;
    const text = editText || cellDisplayText(selCell, false);
    navigator.clipboard
      ?.writeText(text)
      .then(() => notifications.show({ message: `Copied ${selAddress}`, autoClose: 1500 }))
      .catch(() => undefined);
  };

  const onTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = sheets.length - 1;
    const next =
      e.key === 'ArrowRight' ? Math.min(last, index + 1)
      : e.key === 'ArrowLeft' ? Math.max(0, index - 1)
      : e.key === 'Home' ? 0
      : e.key === 'End' ? last
      : null;
    if (next === null) return;
    e.preventDefault();
    changeSheet(sheets[next].name);
    e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };

  if (!sheet || !model) {
    return (
      <div className={classes.root} ref={rootRef}>
        <div className={classes.empty}>
          <EmptyState
            icon={<IconTableOff size={32} />}
            title="This workbook has no sheets"
            description="There is nothing to display. Try downloading the file and opening it in Excel."
          />
        </div>
      </div>
    );
  }

  const hasHighlights = !!activeCounts && activeCounts.correct + activeCounts.incorrect > 0;

  return (
    <div className={classes.root} ref={rootRef}>
      <div className={classes.toolbar}>
        <Group gap="xs" wrap="wrap" style={{ minWidth: 0 }}>
          <Group gap={6} wrap="nowrap" style={{ minWidth: 0, maxWidth: 320 }}>
            <IconFileSpreadsheet size={16} color="var(--mantine-color-brand-filled)" style={{ flexShrink: 0 }} />
            <Text size="sm" fw={500} truncate="end" title={workbook.fileName}>
              {workbook.fileName}
            </Text>
          </Group>
          {hasHighlights && (
            <>
              <Badge color="green" variant="light" leftSection={<IconCheck size={12} />}>
                Correct · {activeCounts.correct}
              </Badge>
              <Badge color="red" variant="light" leftSection={<IconX size={12} />}>
                Incorrect · {activeCounts.incorrect}
              </Badge>
              {incorrectCells.length > 0 && (
                <Button
                  size="compact-xs"
                  variant="subtle"
                  color="red"
                  rightSection={<IconArrowRight size={12} />}
                  onClick={goToNextIncorrect}
                >
                  Next incorrect
                </Button>
              )}
            </>
          )}
        </Group>
        <Group gap="sm" wrap="nowrap">
          {actions}
          <Tooltip label="Shortcut: Ctrl + `" openDelay={400}>
            <Switch
              size="sm"
              label="Show formulas"
              checked={showFormulas}
              onChange={(e) => setShowFormulas(e.currentTarget.checked)}
            />
          </Tooltip>
        </Group>
      </div>

      <div className={classes.formulaBar}>
        <div className={classes.nameBox} aria-label="Selected cell">
          {selAddress ?? ''}
        </div>
        <div className={classes.fx} aria-hidden>
          <IconMathFunction size={16} />
        </div>
        <div className={classes.formulaText}>
          {!selected ? (
            <span className={classes.formulaPlaceholder}>Select a cell to see its formula or value</span>
          ) : editText ? (
            <span className={classes.formulaValue} data-formula={selCell?.f ? true : undefined} title={editText}>
              {editText}
            </span>
          ) : (
            <span className={classes.formulaPlaceholder}>Empty cell</span>
          )}
        </div>
      </div>

      {hasHighlights && (
        <div className={classes.status} data-status={selHighlight?.status}>
          {selHighlight ? (
            <>
              {selHighlight.status === 'correct' ? (
                <IconCircleCheck size={16} style={{ flexShrink: 0, marginTop: 1 }} />
              ) : (
                <IconCircleX size={16} style={{ flexShrink: 0, marginTop: 1 }} />
              )}
              <span>
                <strong>{selAddress}</strong> —{' '}
                {selHighlight.message ?? (selHighlight.status === 'correct' ? 'Correct' : 'Incorrect')}
              </span>
            </>
          ) : (
            <>
              <IconInfoCircle size={16} style={{ flexShrink: 0, marginTop: 1, color: 'var(--mantine-color-dimmed)' }} />
              <Text span size="sm" c="dimmed">
                Green cells are correct and red cells need another look. Select or hover a colored cell to see why.
              </Text>
            </>
          )}
        </div>
      )}

      {sheet.truncated && (
        <Alert color="yellow" variant="light" radius={0} p="xs" icon={<IconAlertTriangle size={18} />}>
          This sheet is too large to show in full — only the first {sheet.rowCount.toLocaleString()} rows and{' '}
          {sheet.colCount.toLocaleString()} columns are shown. Download the file to see everything.
        </Alert>
      )}

      {model.hasContent ? (
        <SheetGrid
          key={sheet.name}
          ref={gridRef}
          model={model}
          highlights={sheetHighlights}
          showFormulas={showFormulas}
          selected={selected}
          onSelect={select}
          onToggleFormulas={() => setShowFormulas((v) => !v)}
          onCopy={copySelection}
          height={height}
          label={`Sheet ${sheet.name} of ${workbook.fileName}`}
        />
      ) : (
        <div className={classes.empty} style={{ minHeight: Math.min(height, 260) }}>
          <EmptyState
            icon={<IconTableOff size={32} />}
            title="This sheet is empty"
            description={
              sheets.length > 1
                ? `There is nothing on “${sheet.name}”. Check the other sheets below.`
                : `There is nothing on “${sheet.name}”.`
            }
          />
        </div>
      )}

      <div className={classes.tabs} role="tablist" aria-label="Sheets">
        {sheets.map((s, i) => {
          const active = s.name === sheet.name;
          const c = counts[s.name];
          return (
            <button
              key={s.name}
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              className={classes.tab}
              title={s.name}
              onClick={() => changeSheet(s.name)}
              onKeyDown={(e) => onTabKeyDown(e, i)}
            >
              <span className={classes.tabName}>{s.name}</span>
              {c && c.incorrect > 0 && (
                <span className={classes.tabCount} aria-label={`${c.incorrect} incorrect`}>
                  {c.incorrect}
                </span>
              )}
              {c && c.incorrect === 0 && c.correct > 0 && (
                <span className={classes.tabCount} data-ok aria-label="All correct">
                  <IconCheck size={11} stroke={3} />
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Builds highlights from an autograde report.
 * target 'student' keys highlights by the matched student sheet name (sheet.studentSheet);
 * target 'key' keys them by sheet.keySheet. Messages describe expected vs actual when known.
 */
export function highlightsFromReport(report: GradeReport, target: 'student' | 'key'): HighlightMap {
  const map: HighlightMap = {};
  for (const sheet of report.sheets) {
    const name = target === 'student' ? sheet.studentSheet : sheet.keySheet;
    if (!name) continue;
    const cells = (map[name] ??= {});
    for (const cell of sheet.cells) {
      cells[cell.address] = { status: cell.correct ? 'correct' : 'incorrect', message: describeCellResult(cell) };
    }
  }
  return map;
}

function ViewerSkeleton({ height }: { height: number }) {
  return (
    <div className={classes.root} aria-busy="true" aria-label="Loading workbook">
      <Group justify="space-between" px="sm" py={10}>
        <Skeleton h={16} w={180} />
        <Skeleton h={16} w={120} />
      </Group>
      <Skeleton h={height + 66} radius={0} />
    </div>
  );
}

/** Focus requests come with KEY sheet names (from GradeReportView); map them to the matched student sheet. */
function useStudentFocus(focus: CellFocus | null | undefined, report: GradeReport | null | undefined) {
  return useMemo(() => {
    if (!focus) return null;
    const match = report?.sheets.find((s) => s.keySheet === focus.sheet);
    return match?.studentSheet ? { sheet: match.studentSheet, address: focus.address } : focus;
  }, [focus, report]);
}

/**
 * Loads GET /api/submissions/:id/workbook and renders it (with loader/error states).
 * `focus.sheet` may be a key sheet name (as passed by GradeReportView.onCellClick); it is mapped to the student's
 * matching sheet using the report.
 */
export function SubmissionWorkbookViewer(props: {
  submissionId: number;
  report?: GradeReport | null;
  height?: number;
  focus?: CellFocus | null;
  actions?: ReactNode;
}) {
  const { submissionId, report, height = 520, focus, actions } = props;
  const query = useQuery({
    queryKey: qk.submissionWorkbook(submissionId),
    queryFn: () => endpoints.getSubmissionWorkbook(submissionId),
    staleTime: Infinity,
  });
  const highlights = useMemo(() => (report ? highlightsFromReport(report, 'student') : undefined), [report]);
  const studentFocus = useStudentFocus(focus, report);

  if (query.isPending) return <ViewerSkeleton height={height} />;
  if (query.isError) {
    return <ErrorAlert error={query.error} title="Could not open this workbook" onRetry={() => query.refetch()} />;
  }
  return (
    <SpreadsheetViewer
      key={submissionId}
      workbook={query.data}
      highlights={highlights}
      height={height}
      focus={studentFocus}
      actions={actions}
    />
  );
}

/** Loads GET /api/assignments/:id/key/workbook (teacher only) and renders it. */
export function KeyWorkbookViewer(props: {
  assignmentId: number;
  report?: GradeReport | null;
  height?: number;
  focus?: CellFocus | null;
  actions?: ReactNode;
}) {
  const { assignmentId, report, height = 520, focus, actions } = props;
  const query = useQuery({
    queryKey: qk.keyWorkbook(assignmentId),
    queryFn: () => endpoints.getKeyWorkbook(assignmentId),
  });
  const highlights = useMemo(() => (report ? highlightsFromReport(report, 'key') : undefined), [report]);

  if (query.isPending) return <ViewerSkeleton height={height} />;
  if (query.isError) {
    return <ErrorAlert error={query.error} title="Could not open the answer key" onRetry={() => query.refetch()} />;
  }
  return (
    <SpreadsheetViewer
      workbook={query.data}
      highlights={highlights}
      height={height}
      focus={focus ?? null}
      actions={actions}
    />
  );
}
