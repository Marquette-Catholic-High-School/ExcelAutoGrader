/**
 * Autograding workflow on top of the spreadsheet engine (grader/index.ts): grading one upload, re-grading
 * every submission of an assignment, and clearing autograde results when an assignment becomes manual.
 */
import fs from 'node:fs';
import type { AutoStatus, GradingConfig, RegradeResponse } from '../../../shared/types.js';
import { all, run, transaction, type AssignmentRow, type FileRow } from '../db.js';
import { WorkbookReadError, gradeWorkbook } from '../grader/index.js';
import { filePath, getFile } from '../uploads.js';
import { round2 } from './common.js';
import { readConfig } from './config.js';

/** The auto_* columns of a submission row. */
export interface AutoGradeResult {
  auto_status: AutoStatus;
  auto_score: number | null;
  auto_report: string | null;
  auto_error: string | null;
}

export const NOT_APPLICABLE: AutoGradeResult = {
  auto_status: 'not_applicable',
  auto_score: null,
  auto_report: null,
  auto_error: null,
};

export const NO_GRADABLE_CELLS = 'The answer key has no gradable cells.';

/** Everything needed to grade against one assignment, resolved once (so a re-grade does not re-query it). */
interface GradingContext {
  keyPath: string;
  templatePath: string | null;
  config: GradingConfig;
  points: number;
}

function failed(message: string): AutoGradeResult {
  return { ...NOT_APPLICABLE, auto_status: 'error', auto_error: message };
}

function errorMessage(err: unknown): string {
  if (err instanceof WorkbookReadError) return err.message;
  console.error('Autograder error:', err);
  const detail = err instanceof Error && err.message ? ` (${err.message})` : '';
  return `The autograder ran into an unexpected problem${detail}. Grade this submission manually or try re-grading.`;
}

/** null when the assignment is not autograded; an error message when its answer key is unusable. */
function gradingContext(assignment: AssignmentRow): GradingContext | string | null {
  if (assignment.grading_mode !== 'auto') return null;
  const key = getFile(assignment.key_file_id);
  if (!key || !fs.existsSync(filePath(key))) {
    return 'The answer key for this assignment is missing. Upload it again in the assignment settings.';
  }
  const template = getFile(assignment.template_file_id);
  return {
    keyPath: filePath(key),
    templatePath: template ? filePath(template) : null,
    config: readConfig(assignment),
    points: assignment.points,
  };
}

function gradeWith(ctx: GradingContext | string | null, studentPath: string): AutoGradeResult {
  if (ctx === null) return NOT_APPLICABLE;
  if (typeof ctx === 'string') return failed(ctx);
  if (!fs.existsSync(studentPath)) return failed('The submitted file is missing from storage.');
  try {
    const report = gradeWorkbook({ ...ctx, studentPath });
    if (!report.total) return failed(NO_GRADABLE_CELLS);
    const fraction = Number.isFinite(report.fraction) ? Math.min(1, Math.max(0, report.fraction)) : 0;
    return {
      auto_status: 'graded',
      auto_score: round2(ctx.points * fraction),
      auto_report: JSON.stringify(report),
      auto_error: null,
    };
  } catch (err) {
    return failed(errorMessage(err));
  }
}

/** Grades one student workbook against the assignment's current key. Never throws. */
export function autoGrade(assignment: AssignmentRow, studentPath: string): AutoGradeResult {
  return gradeWith(gradingContext(assignment), studentPath);
}

function saveResult(submissionId: number, result: AutoGradeResult): void {
  run(
    'UPDATE submissions SET auto_status = ?, auto_score = ?, auto_report = ?, auto_error = ? WHERE id = ?',
    result.auto_status,
    result.auto_score,
    result.auto_report,
    result.auto_error,
    submissionId,
  );
}

/**
 * Re-runs the autograder on EVERY submission (all attempts) of an auto assignment. Teacher overrides and
 * feedback are untouched. `regraded` counts every submission that was re-run; `errors` those that failed.
 */
export function regradeAssignment(assignment: AssignmentRow): RegradeResponse {
  const files = all<FileRow & { submission_id: number }>(
    `SELECT f.*, s.id AS submission_id FROM submissions s JOIN files f ON f.id = s.file_id WHERE s.assignment_id = ?`,
    assignment.id,
  );
  const ctx = gradingContext(assignment);
  const results = files.map((file) => ({ id: file.submission_id, result: gradeWith(ctx, filePath(file)) }));
  transaction(() => {
    for (const { id, result } of results) saveResult(id, result);
  });
  return { regraded: results.length, errors: results.filter((r) => r.result.auto_status === 'error').length };
}

/** Manual grading: drop every autograde result of the assignment (scores, reports, errors). */
export function clearAutoGrades(assignmentId: number): void {
  run(
    `UPDATE submissions SET auto_status = 'not_applicable', auto_score = NULL, auto_report = NULL, auto_error = NULL
     WHERE assignment_id = ?`,
    assignmentId,
  );
}
