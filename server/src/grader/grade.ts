/** Autograding and key preview over already-loaded workbook models. */
import type { CellResult, GradeReport, GradingConfig, KeyPreview, SheetReport } from '../../../shared/types.js';
import { compareCell, isBlank } from './compare.js';
import { matchSheets } from './match.js';
import type { GradeCell, ModelSheet, WorkbookModel } from './read.js';
import { selectGradableCells } from './select.js';

export const NO_GRADABLE_CELLS = 'The answer key has no gradable cells for this configuration.';
const SAMPLE_SIZE = 8;

/** Compares a submission with the key. Missing sheets fail their cells; nothing here throws for odd files. */
export function gradeModels(
  key: WorkbookModel,
  student: WorkbookModel,
  template: WorkbookModel | null,
  config: GradingConfig,
): GradeReport {
  const selection = selectGradableCells(key, config, template);
  const warnings: string[] = [...key.warnings, ...selection.warnings, ...student.warnings];
  // Only key sheets with graded cells take part in pairing, so an instructions sheet cannot take the position
  // of the sheet a one-sheet submission (a CSV, a renamed sheet) should be compared with.
  const graded = selection.sheets.filter((s) => s.cells.length > 0);
  const matches = matchSheets(
    graded.map((s) => s.sheet.name),
    student.sheets.map((sheet) => sheet.name),
    { fallbackInOrder: true },
  );

  const sheets: SheetReport[] = [];
  for (const [i, { sheet, cells }] of graded.entries()) {
    const match = matches[i];
    const studentSheet = match.otherIndex === null ? null : student.sheets[match.otherIndex];
    if (!studentSheet) {
      const count = cells.length === 1 ? '1 graded cell was' : `${cells.length} graded cells were`;
      warnings.push(`The submission has no sheet named "${sheet.name}", so its ${count} marked incorrect.`);
    } else if (match.method === 'position') {
      warnings.push(`No sheet named "${sheet.name}" in the submission; compared with "${studentSheet.name}" instead.`);
    }
    sheets.push(gradeSheet(sheet, cells, studentSheet, config));
  }

  const correct = sheets.reduce((sum, s) => sum + s.correct, 0);
  const total = sheets.reduce((sum, s) => sum + s.total, 0);
  if (total === 0) warnings.push(NO_GRADABLE_CELLS);
  if (student.isCsv && sheets.some((s) => s.cells.some((c) => c.reason === 'formula_required'))) {
    warnings.push(
      "CSV files can't store formulas, so cells that need a formula were marked as typed-in values. " +
        'Save the work as an Excel workbook (.xlsx) and upload it again.',
    );
  }
  return { correct, total, fraction: total ? correct / total : 0, sheets, warnings: unique(warnings) };
}

function gradeSheet(
  keySheet: ModelSheet,
  keyCells: GradeCell[],
  studentSheet: ModelSheet | null,
  config: GradingConfig,
): SheetReport {
  const cells = keyCells.map((keyCell) => gradeCell(keySheet.name, keyCell, studentSheet, config));
  return {
    keySheet: keySheet.name,
    studentSheet: studentSheet?.name ?? null,
    correct: cells.filter((cell) => cell.correct).length,
    total: cells.length,
    cells,
  };
}

function gradeCell(sheetName: string, keyCell: GradeCell, studentSheet: ModelSheet | null, config: GradingConfig) {
  const result: CellResult = {
    sheet: sheetName,
    address: keyCell.address,
    correct: false,
    expected: keyCell.value,
    actual: null,
  };
  if (keyCell.formula !== undefined) result.expectedFormula = keyCell.formula;
  if (keyCell.text !== undefined) result.expectedText = keyCell.text;
  if (!studentSheet) {
    result.reason = 'missing_sheet';
    return result;
  }

  const studentCell = studentSheet.cells.get(keyCell.address);
  const verdict = compareCell(keyCell, studentCell, config);
  result.correct = verdict.correct;
  if (verdict.reason) result.reason = verdict.reason;
  if (studentCell) {
    const blankValue = studentCell.formula === undefined && !studentCell.isError && isBlank(studentCell.value);
    result.actual = blankValue ? null : studentCell.value;
    if (studentCell.formula !== undefined) result.actualFormula = studentCell.formula;
    if (studentCell.text !== undefined && result.actual !== null) result.actualText = studentCell.text;
  }
  return result;
}

/** What the autograder would check for this key/config, for the assignment form. */
export function previewModels(key: WorkbookModel, template: WorkbookModel | null, config: GradingConfig): KeyPreview {
  const selection = selectGradableCells(key, config, template);
  const sheets = selection.sheets.map(({ sheet, cells }) => ({
    name: sheet.name,
    gradedCells: cells.length,
    sampleAddresses: cells.slice(0, SAMPLE_SIZE).map((cell) => cell.address),
  }));
  const totalCells = sheets.reduce((sum, s) => sum + s.gradedCells, 0);
  const formulaCells = selection.sheets.reduce(
    (sum, s) => sum + s.cells.filter((cell) => cell.formula !== undefined).length,
    0,
  );

  const warnings = [...key.warnings, ...selection.warnings, ...selection.templateWarnings];
  if (template && template.warnings.length) warnings.push(...template.warnings);
  if (totalCells === 0) {
    warnings.push(NO_GRADABLE_CELLS);
    const hint = emptySelectionHint(key, config, selection.excludedByTemplate);
    if (hint) warnings.push(hint);
  }
  return { totalCells, formulaCells, sheets, warnings: unique(warnings) };
}

function emptySelectionHint(key: WorkbookModel, config: GradingConfig, excludedByTemplate: number): string | null {
  if (excludedByTemplate > 0) {
    return (
      'Every graded cell in the answer key is identical to the template, so students would have nothing to ' +
      'fill in. Make sure the answer key is the finished workbook.'
    );
  }
  if (key.sheets.every((sheet) => sheet.list.length === 0)) return 'The answer key is empty.';
  if (config.scope === 'formulas') {
    return 'The answer key has no formulas. Grade all filled-in cells instead, or add formulas to the key.';
  }
  if (config.scope === 'ranges') return 'None of the ranges contain any filled-in cells in the answer key.';
  return null;
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}
