/** Pure calculations behind the PDF reports (no database access, so they are easy to test). */
import type {
  AssignmentSummary,
  CellFailReason,
  CellPrimitive,
  CellResult,
  GradebookCell,
  SubmissionDetail,
} from '../../../../shared/types.js';
import { round2 } from '../common.js';
import { percentOf } from './format.js';

/** Average and median are not rounded: percentages are computed from the exact values, then rounded for display. */
export interface ScoreStats {
  count: number;
  average: number;
  median: number;
  high: number;
  low: number;
}

export function scoreStats(scores: readonly number[]): ScoreStats | null {
  if (scores.length === 0) return null;
  const sorted = [...scores].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return {
    count: sorted.length,
    average: sorted.reduce((sum, s) => sum + s, 0) / sorted.length,
    median,
    high: sorted[sorted.length - 1],
    low: sorted[0],
  };
}

export const DISTRIBUTION_BANDS = 10;

/** Counts per 10% band (0–9.9%, ..., 90–100%); extra credit above 100% counts in the top band. */
export function scoreDistribution(scores: readonly number[], points: number): number[] {
  const bands = new Array<number>(DISTRIBUTION_BANDS).fill(0);
  for (const score of scores) {
    const band = Math.floor(percentOf(score, points) / (100 / DISTRIBUTION_BANDS));
    bands[Math.min(DISTRIBUTION_BANDS - 1, Math.max(0, band))] += 1;
  }
  return bands;
}

export interface GradeTotals {
  /** Sum of final scores over the scored assignments. */
  earned: number;
  /** Sum of the points of those assignments. */
  possible: number;
  /** earned / possible, or null when nothing is scored yet. */
  percent: number | null;
  scored: number;
}

/** Totals over scored work only: missing and ungraded assignments don't count against the student. */
export function gradeTotals(items: readonly { finalScore: number | null; points: number }[]): GradeTotals {
  let earned = 0;
  let possible = 0;
  let scored = 0;
  for (const item of items) {
    if (item.finalScore === null) continue;
    earned += item.finalScore;
    possible += item.points;
    scored += 1;
  }
  return {
    earned: round2(earned),
    possible: round2(possible),
    percent: scored ? percentOf(earned, possible) : null,
    scored,
  };
}

/* ------------------------------------------------------------------ */
/* Most-missed cells                                                  */
/* ------------------------------------------------------------------ */

export interface MissedCell {
  /** Excel-style reference: "C7", "Budget!C7" or "'Monthly Budget'!C7". */
  ref: string;
  /** Latest graded submissions that got the cell wrong, out of `checked` that were graded on it. */
  wrong: number;
  checked: number;
  percentWrong: number;
  /** The most common reason it was wrong. */
  reason: CellFailReason | null;
  /** The answer key's value and/or formula, e.g. "$1,234.50 (=SUM(B2:B6))". */
  expected: string | null;
}

export const MISSED_CELLS_LIMIT = 15;

/** 'Monthly Budget'!C7 — quoted like Excel when the sheet name isn't a plain word. */
export function cellRef(sheet: string, address: string): string {
  const name = /^[\p{L}_][\p{L}\p{N}_.]*$/u.test(sheet) ? sheet : `'${sheet.replace(/'/g, "''")}'`;
  return `${name}!${address}`;
}

/** 1250 → "1,250", 0.333333 → "0.3333", text quoted, null → "(empty)" — like the app's grade report. */
export function formatCellValue(value: CellPrimitive | undefined): string {
  if (value === null || value === undefined) return '(empty)';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    if (value !== 0 && Math.abs(value) < 0.0001) return String(Number(value.toPrecision(4)));
    return value.toLocaleString('en-US', { maximumFractionDigits: 4 });
  }
  return `"${value}"`;
}

const formulaText = (formula: string) => (formula.startsWith('=') ? formula : `=${formula}`);

function describeExpected(cell: CellResult): string | null {
  const formula = cell.expectedFormula ? formulaText(cell.expectedFormula) : null;
  if (cell.expected === undefined && cell.expectedText === undefined) return formula;
  const value = cell.expectedText ?? formatCellValue(cell.expected);
  return formula ? `${value} (${formula})` : value;
}

interface CellTally {
  ref: string;
  wrong: number;
  checked: number;
  reasons: Map<CellFailReason, number>;
  expected: string | null;
}

/** Cells most often wrong in the latest autograded submissions; cells nobody missed are left out. */
export function mostMissedCells(submissions: readonly SubmissionDetail[], limit = MISSED_CELLS_LIMIT): MissedCell[] {
  const tallies = new Map<string, CellTally>();
  for (const submission of submissions) {
    if (submission.autoStatus !== 'graded' || !submission.report) continue;
    for (const sheet of submission.report.sheets) {
      for (const cell of sheet.cells) {
        const ref = cellRef(sheet.keySheet, cell.address);
        let tally = tallies.get(ref);
        if (!tally) {
          tally = { ref, wrong: 0, checked: 0, reasons: new Map(), expected: null };
          tallies.set(ref, tally);
        }
        tally.checked += 1;
        tally.expected ??= describeExpected(cell);
        if (cell.correct) continue;
        tally.wrong += 1;
        if (cell.reason) tally.reasons.set(cell.reason, (tally.reasons.get(cell.reason) ?? 0) + 1);
      }
    }
  }
  // Stable sort: ties keep the answer key's order (sheet by sheet, cell by cell).
  return [...tallies.values()]
    .filter((t) => t.wrong > 0)
    .map((t) => ({
      ref: t.ref,
      wrong: t.wrong,
      checked: t.checked,
      percentWrong: percentOf(t.wrong, t.checked),
      reason: [...t.reasons].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      expected: t.expected,
    }))
    .sort((a, b) => b.wrong - a.wrong || b.percentWrong - a.percentWrong)
    .slice(0, limit);
}

/* ------------------------------------------------------------------ */
/* Student standing                                                   */
/* ------------------------------------------------------------------ */

/** How one student stands in a class. */
export interface StudentSummary {
  overall: GradeTotals;
  /** Assignments with a submission, out of `assignments`. */
  completed: number;
  assignments: number;
  late: number;
  /** Past due with no submission. */
  missing: number;
  /** Submitted, waiting for a score. */
  needsGrading: number;
  /** Totals over scored assignments that are autograded (grading mode "auto"). */
  autograded: GradeTotals;
}

/** One assignment from one student's point of view. */
export interface SummaryRow {
  assignment: AssignmentSummary;
  cell: GradebookCell;
  pastDue: boolean;
}

export function studentSummary(rows: readonly SummaryRow[]): StudentSummary {
  const scored = (list: readonly SummaryRow[]) =>
    gradeTotals(list.map((r) => ({ finalScore: r.cell.finalScore, points: r.assignment.points })));
  return {
    overall: scored(rows),
    completed: rows.filter((r) => r.cell.status !== 'missing').length,
    assignments: rows.length,
    late: rows.filter((r) => r.cell.late).length,
    missing: rows.filter((r) => r.cell.status === 'missing' && r.pastDue).length,
    needsGrading: rows.filter((r) => r.cell.status === 'needs_grading').length,
    autograded: scored(rows.filter((r) => r.assignment.gradingMode === 'auto')),
  };
}

/** Average of the students' overall percentages (students with nothing graded yet are left out). */
export function classAverage(summaries: Iterable<StudentSummary>): number | null {
  const percents = [...summaries].flatMap((s) => (s.overall.percent === null ? [] : [s.overall.percent]));
  if (percents.length === 0) return null;
  return Math.round((percents.reduce((sum, p) => sum + p, 0) / percents.length) * 10) / 10;
}
