import { DEFAULT_GRADING_CONFIG } from '../../../shared/types.js';
import type { GradingConfig, GradingScope } from '../../../shared/types.js';
import { isValidRange } from './ranges.js';

export const MAX_RANGES = 100;
export const MAX_TOLERANCE = 1e9;

const SCOPES: GradingScope[] = ['all', 'formulas', 'ranges'];

const BOOLEAN_LABELS = {
  caseSensitive: 'Case-sensitive text',
  ignoreWhitespace: 'Ignore extra spaces',
  requireFormulas: 'Require formulas',
  excludeTemplateCells: 'Skip cells from the template',
  showDetailsToStudents: 'Show cell details to students',
  showExpectedToStudents: 'Show expected answers to students',
} satisfies Partial<Record<keyof GradingConfig, string>>;

type BooleanKey = keyof typeof BOOLEAN_LABELS;

/**
 * Validates and fills defaults for a grading config (object, JSON string, or nothing).
 * Unknown keys are dropped. Throws a plain Error with a user-facing message for invalid values.
 */
export function normalizeGradingConfig(input: unknown): GradingConfig {
  const raw = toObject(input);
  const config: GradingConfig = { ...DEFAULT_GRADING_CONFIG, ranges: [...DEFAULT_GRADING_CONFIG.ranges] };

  if (isSet(raw.scope)) config.scope = parseScope(raw.scope);
  if (isSet(raw.numericTolerance)) config.numericTolerance = parseTolerance(raw.numericTolerance);
  if (isSet(raw.ranges)) config.ranges = parseRanges(raw.ranges);
  for (const key of Object.keys(BOOLEAN_LABELS) as BooleanKey[]) {
    if (isSet(raw[key])) config[key] = parseBoolean(raw[key], BOOLEAN_LABELS[key]);
  }

  if (config.scope === 'ranges' && config.ranges.length === 0) {
    throw new Error('Add at least one cell range to grade, e.g. Sheet1!B2:B10.');
  }
  return config;
}

function toObject(input: unknown): Record<string, unknown> {
  let value = input;
  if (typeof value === 'string') {
    if (!value.trim()) return {};
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error('The grading settings could not be read. Refresh the page and try again.');
    }
  }
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The grading settings could not be read. Refresh the page and try again.');
  }
  return value as Record<string, unknown>;
}

function isSet(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function parseScope(value: unknown): GradingScope {
  if (typeof value === 'string' && (SCOPES as string[]).includes(value)) return value as GradingScope;
  throw new Error('Choose which cells to grade: all filled-in cells, formula cells, or specific ranges.');
}

function parseTolerance(value: unknown): number {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > MAX_TOLERANCE) {
    throw new Error('Numeric tolerance must be a number from 0 to 1,000,000,000 (for example 0.01).');
  }
  return n;
}

function parseBoolean(value: unknown, label: string): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`The "${label}" setting must be on or off.`);
}

/** Accepts a list (or a comma/semicolon/newline separated string); drops blanks and duplicates. */
function parseRanges(value: unknown): string[] {
  const items = typeof value === 'string' ? value.split(/[,;\n]+/) : value;
  if (!Array.isArray(items)) {
    throw new Error('Ranges must be a list of cell ranges such as Sheet1!B2:B10.');
  }
  const ranges: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string') throw new Error('Ranges must be a list of cell ranges such as Sheet1!B2:B10.');
    const text = item.trim();
    if (!text || ranges.includes(text)) continue;
    if (!isValidRange(text)) {
      throw new Error(
        `Invalid range "${text}". Use a cell like B5 or a range like B2:D10, optionally with a sheet name ` +
          "(Sheet1!B2:D10 or 'My Sheet'!B2).",
      );
    }
    ranges.push(text);
  }
  if (ranges.length > MAX_RANGES) throw new Error(`You can add up to ${MAX_RANGES} ranges.`);
  return ranges;
}
