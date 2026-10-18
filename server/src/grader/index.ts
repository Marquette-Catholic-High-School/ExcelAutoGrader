/**
 * Public interface of the spreadsheet engine. Routes import ONLY from this file.
 *
 * All functions are synchronous and read files from disk by absolute path. They accept any format
 * SheetJS can read (.xlsx, .xlsm, .xls, .ods, .csv).
 *
 * Modules: read.ts (file sniffing, parsing, caching, grading model), limits.ts (size limits), csv.ts (semicolon
 * CSVs), format.ts (number formats), recalc.ts (HyperFormula for formulas saved without results), config.ts,
 * ranges.ts, formula.ts, compare.ts, match.ts (sheet pairing), select.ts (which key cells are graded), grade.ts
 * (report + preview), viewer.ts, fixtures.ts (test/seed workbooks). The grading rules are documented in
 * docs/API.md ("Autograder rules").
 */
import type { GradeReport, GradingConfig, KeyPreview, WorkbookData } from '../../../shared/types.js';
import { normalizeGradingConfig as normalizeConfig } from './config.js';
import { WorkbookReadError } from './errors.js';
import { gradeModels, previewModels } from './grade.js';
import { getModel, loadWorkbook, type WorkbookModel } from './read.js';
import { buildViewerData } from './viewer.js';

/** Thrown for unreadable/corrupt/password-protected files. `message` is shown to users verbatim. */
export { WorkbookReadError };

const KEY_LABEL = 'the answer key';
const TEMPLATE_LABEL = 'the template';
const SUBMISSION_LABEL = 'the submission';

/**
 * Validates and fills defaults for a grading config coming from a client (may be partial, a JSON string,
 * or garbage). Throws a plain Error with a user-facing message for invalid values
 * (e.g. 'Invalid range "Sheet1!ZZZ"'). Unknown keys are dropped; missing keys get DEFAULT_GRADING_CONFIG values.
 */
export function normalizeGradingConfig(input: unknown): GradingConfig {
  return normalizeConfig(input);
}

/**
 * Opens the file and throws WorkbookReadError if it cannot be read as a spreadsheet or is too large to grade
 * (more than about 2,000,000 filled cells; see limits.ts).
 */
export function assertReadableWorkbook(filePath: string): void {
  loadWorkbook(filePath);
}

/** Workbook → JSON for the in-browser viewer (values, formatted text, formulas, merges). */
export function parseWorkbookForViewer(filePath: string, fileName: string): WorkbookData {
  return buildViewerData(loadWorkbook(filePath), fileName);
}

/** Which cells the autograder would check for this key/config (shown to teachers while creating). */
export function previewKey(opts: { keyPath: string; templatePath?: string | null; config: GradingConfig }): KeyPreview {
  const key = getModel(loadWorkbook(opts.keyPath), KEY_LABEL);
  const template = loadTemplate(opts.templatePath, opts.config, false);
  return previewModels(key, template, opts.config);
}

/**
 * Compares a student workbook against the answer key. Never throws for a wrong/odd student file that is
 * readable (missing sheets etc. just fail cells); throws WorkbookReadError if a file is unreadable.
 * If the key yields zero gradable cells, returns total = 0 and fraction = 0 with a warning.
 */
export function gradeWorkbook(opts: {
  keyPath: string;
  studentPath: string;
  templatePath?: string | null;
  config: GradingConfig;
}): GradeReport {
  const key = withContext('answer key', () => getModel(loadWorkbook(opts.keyPath), KEY_LABEL));
  const template = loadTemplate(opts.templatePath, opts.config, true);
  // Submission cells are looked up by address, so a large sheet is never cut short and needs no warning.
  const student = getModel(loadWorkbook(opts.studentPath), SUBMISSION_LABEL, { limitWarning: false });
  return gradeModels(key, student, template, opts.config);
}

/** The template only matters when cells it already contains are excluded from grading. */
function loadTemplate(
  templatePath: string | null | undefined,
  config: GradingConfig,
  explainErrors: boolean,
): WorkbookModel | null {
  if (!templatePath || !config.excludeTemplateCells) return null;
  const load = () => getModel(loadWorkbook(templatePath), TEMPLATE_LABEL);
  return explainErrors ? withContext('starter template', load) : load();
}

/** While grading, say which of the assignment's own files failed so the teacher knows what to re-upload. */
function withContext<T>(what: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof WorkbookReadError) throw new WorkbookReadError(`Problem with the ${what}: ${err.message}`);
    throw err;
  }
}
