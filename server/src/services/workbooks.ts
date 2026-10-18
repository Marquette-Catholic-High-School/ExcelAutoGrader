/** Thin wrappers around the spreadsheet engine that translate its errors into HTTP responses. */
import fs from 'node:fs';
import type { GradingConfig, KeyPreview, WorkbookData } from '../../../shared/types.js';
import type { FileRow } from '../db.js';
import { WorkbookReadError, assertReadableWorkbook, parseWorkbookForViewer, previewKey } from '../grader/index.js';
import { badRequest, notFound } from '../http.js';
import { filePath } from '../uploads.js';

/** The user-facing reason a temp upload is not a readable spreadsheet, or null when it is fine (or absent). */
export function unreadableReason(file: Express.Multer.File | undefined): string | null {
  if (!file) return null;
  try {
    assertReadableWorkbook(file.path);
    return null;
  } catch (err) {
    if (err instanceof WorkbookReadError) return err.message;
    throw err;
  }
}

/** Stored file → WorkbookData for the in-browser viewer. */
export function viewerWorkbook(file: FileRow | null, missingMessage = 'File not found.'): WorkbookData {
  if (!file) throw notFound(missingMessage);
  const full = filePath(file);
  if (!fs.existsSync(full)) throw notFound('This file is missing from storage. Ask for it to be uploaded again.');
  try {
    return parseWorkbookForViewer(full, file.original_name);
  } catch (err) {
    if (err instanceof WorkbookReadError) throw badRequest(err.message);
    throw err;
  }
}

/** previewKey with WorkbookReadError → 400 { fields: { keyFile } }. */
export function safePreview(keyPath: string, templatePath: string | null, config: GradingConfig): KeyPreview {
  try {
    return previewKey({ keyPath, templatePath, config });
  } catch (err) {
    if (err instanceof WorkbookReadError) throw badRequest(err.message, { keyFile: err.message });
    throw err;
  }
}

function noCellsMessage(config: GradingConfig, skipsTemplate: boolean, warnings: string[]): string {
  const templateNote = skipsTemplate
    ? ' Cells identical to the starter template are skipped, so make sure the key is the finished workbook, ' +
      'not the starter file.'
    : '';
  switch (config.scope) {
    case 'formulas':
      return (
        'The answer key has no formula cells to check. Check every filled cell instead, or upload a key that ' +
        `uses formulas.${templateNote}`
      );
    case 'ranges': {
      const detail = warnings.length ? ` ${warnings[0]}` : '';
      const base = 'The selected ranges are empty in the answer key. Check the sheet names and cell ranges.';
      return `${base}${detail}${templateNote}`;
    }
    default:
      return skipsTemplate
        ? 'Every filled cell in the answer key is identical to the starter template, so there is nothing to grade. ' +
            'Upload the finished workbook (with the answers filled in) as the key.'
        : 'The answer key has no filled-in cells to check. Upload the finished workbook with the answers filled in.';
  }
}

/** A message explaining why this key/config combination has nothing to grade, or null when it is gradable. */
export function noGradableCellsReason(
  keyPath: string,
  templatePath: string | null,
  config: GradingConfig,
): string | null {
  const preview = safePreview(keyPath, templatePath, config);
  if (preview.totalCells > 0) return null;
  return noCellsMessage(config, !!templatePath && config.excludeTemplateCells, preview.warnings);
}
