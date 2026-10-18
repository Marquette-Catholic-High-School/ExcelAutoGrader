/** Chooses which answer-key cells the autograder checks for a given grading config. */
import type { GradingConfig } from '../../../shared/types.js';
import { isBlank, valuesEqual } from './compare.js';
import { normalizeFormula, volatileFunctions } from './formula.js';
import { findSheetByName, matchSheets } from './match.js';
import { parseRange, rangeContains, type RangeRef } from './ranges.js';
import type { GradeCell, ModelSheet, WorkbookModel } from './read.js';

/** Addresses listed in the warning about volatile key cells. */
const MAX_LISTED_ADDRESSES = 5;

export interface SheetSelection {
  sheet: ModelSheet;
  /** Row-major. */
  cells: GradeCell[];
}

export interface KeySelection {
  /** One entry per key sheet, in workbook order (cells may be empty). */
  sheets: SheetSelection[];
  /** Problems with the key or config (unknown range sheets, formulas without results, volatile functions). */
  warnings: string[];
  /** Problems pairing template sheets with key sheets (only interesting while setting up). */
  templateWarnings: string[];
  /** Cells skipped because the template already contains them. */
  excludedByTemplate: number;
}

/** A key cell is gradable when it has a formula or a non-blank value. */
export function isGradable(cell: GradeCell): boolean {
  return cell.formula !== undefined || cell.isError || !isBlank(cell.value);
}

export function selectGradableCells(
  key: WorkbookModel,
  config: GradingConfig,
  template: WorkbookModel | null,
): KeySelection {
  const warnings: string[] = [];
  const templateWarnings: string[] = [];
  const rangesBySheet = config.scope === 'ranges' ? groupRanges(key, config.ranges, warnings) : null;
  const templateSheets = template && config.excludeTemplateCells ? pairTemplate(key, template, templateWarnings) : null;

  let excludedByTemplate = 0;
  let unknownResults = 0;
  const sheets = key.sheets.map((sheet): SheetSelection => {
    const ranges = rangesBySheet?.get(sheet.index) ?? [];
    const templateSheet = templateSheets?.[sheet.index] ?? null;
    const cells: GradeCell[] = [];
    for (const cell of sheet.list) {
      if (!isGradable(cell)) continue;
      if (config.scope === 'formulas' && cell.formula === undefined) continue;
      if (rangesBySheet && !ranges.some((range) => rangeContains(range, cell.r, cell.c))) continue;
      if (cell.missingValue) {
        unknownResults += 1;
        continue;
      }
      const templateCell = templateSheet?.cells.get(cell.address);
      if (templateCell && matchesTemplate(cell, templateCell, config)) {
        excludedByTemplate += 1;
        continue;
      }
      cells.push(cell);
    }
    return { sheet, cells };
  });

  if (unknownResults > 0) {
    const count = unknownResults === 1 ? '1 formula cell' : `${unknownResults} formula cells`;
    warnings.push(
      `${count} in the answer key had no saved result and could not be calculated, so ` +
        `${unknownResults === 1 ? 'it is' : 'they are'} not graded. Open the key in Excel, save it, and upload it again.`,
    );
  }
  const volatile = sheets.flatMap(({ sheet, cells }) =>
    cells
      .filter((cell) => cell.formula !== undefined && volatileFunctions(cell.formula).length > 0)
      .map((cell) => `${sheetPrefix(sheet.name)}${cell.address}`),
  );
  if (volatile.length > 0) warnings.push(volatileWarning(volatile));
  return { sheets, warnings, templateWarnings, excludedByTemplate };
}

/** Key cells calling TODAY(), NOW(), RAND()... are checked by formula, not by their saved result (compareCell). */
function volatileWarning(addresses: string[]): string {
  const one = addresses.length === 1;
  const listed = addresses.slice(0, MAX_LISTED_ADDRESSES).join(', ');
  const more = addresses.length > MAX_LISTED_ADDRESSES ? ` and ${addresses.length - MAX_LISTED_ADDRESSES} more` : '';
  return (
    `${one ? '1 cell' : `${addresses.length} cells`} in the answer key ${one ? 'uses' : 'use'} TODAY(), NOW() or ` +
    `RAND() (${listed}${more}). ${one ? 'Its saved result changes' : 'Their saved results change'} over time, so ` +
    `${one ? 'it counts' : 'they count'} as correct when the student's formula uses the same function.`
  );
}

/** "Sheet1!" or "'My Sheet'!" */
function sheetPrefix(name: string): string {
  return /^[A-Za-z_][\w.]*$/.test(name) ? `${name}!` : `'${name.replace(/'/g, "''")}'!`;
}

/**
 * Students should not get credit for what they were given: a key cell is skipped when the template has the
 * same value there and, if the key cell is a formula, the same formula too.
 */
function matchesTemplate(keyCell: GradeCell, templateCell: GradeCell, config: GradingConfig): boolean {
  if (templateCell.missingValue || !valuesEqual(keyCell, templateCell, config)) return false;
  if (keyCell.formula === undefined) return true;
  return templateCell.formula !== undefined && normalizeFormula(templateCell.formula) === normalizeFormula(keyCell.formula);
}

/** Ranges grouped by key sheet index; a range without a sheet prefix belongs to the first sheet. */
function groupRanges(key: WorkbookModel, ranges: string[], warnings: string[]): Map<number, RangeRef[]> {
  const names = key.sheets.map((sheet) => sheet.name);
  const grouped = new Map<number, RangeRef[]>();
  for (const text of ranges) {
    const range = parseRange(text);
    if (!range) continue;
    const index = range.sheet === null ? 0 : findSheetByName(names, range.sheet);
    if (index < 0) {
      warnings.push(`The range "${range.text}" refers to a sheet named "${range.sheet}", which isn't in the answer key.`);
      continue;
    }
    const list = grouped.get(index) ?? [];
    list.push(range);
    grouped.set(index, list);
  }
  return grouped;
}

/** Template sheet for each key sheet index (null when the template has no matching sheet). */
function pairTemplate(key: WorkbookModel, template: WorkbookModel, warnings: string[]): (ModelSheet | null)[] {
  const keyNames = key.sheets.map((sheet) => sheet.name);
  const matches = matchSheets(keyNames, template.sheets.map((sheet) => sheet.name));
  return matches.map((match) => {
    const keyName = keyNames[match.keyIndex];
    if (match.otherIndex === null) {
      warnings.push(`The template has no sheet matching "${keyName}", so no cells on that sheet were skipped.`);
      return null;
    }
    const sheet = template.sheets[match.otherIndex];
    if (match.method === 'position') {
      warnings.push(`The template has no sheet named "${keyName}"; compared it with "${sheet.name}" instead.`);
    }
    return sheet;
  });
}
