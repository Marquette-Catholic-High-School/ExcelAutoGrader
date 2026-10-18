/**
 * Parsing and validation of the assignment create/update form (multipart text fields, or JSON).
 * Field errors are collected so the teacher sees every problem at once.
 */
import type { GradingConfig, GradingMode } from '../../../shared/types.js';
import { normalizeGradingConfig } from '../grader/index.js';
import { badRequest } from '../http.js';
import { round2 } from './common.js';

export const KEY_REQUIRED = 'Upload the finished workbook (answer key) to autograde, or choose manual grading.';

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 10_000;
const MAX_POINTS = 10_000;

export type FieldErrors = Record<string, string>;

/** Only the fields present in the request (all of them on create). */
export interface AssignmentInput {
  title?: string;
  description?: string;
  dueAt?: string;
  points?: number;
  gradingMode?: GradingMode;
  gradingConfig?: GradingConfig;
  removeTemplate: boolean;
}

/** Last value of a body field (multer turns repeated fields into arrays). */
function rawField(body: unknown, name: string): unknown {
  if (!body || typeof body !== 'object') return undefined;
  const value = (body as Record<string, unknown>)[name];
  return Array.isArray(value) ? value[value.length - 1] : value;
}

function textField(body: unknown, name: string): string | undefined {
  const value = rawField(body, name);
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string' ? value : String(value);
}

/**
 * Accepts a JSON string (multipart) or an object (JSON body). Returns the normalized config or a
 * user-facing error message.
 */
export function parseGradingConfig(raw: unknown): GradingConfig | string {
  let input = raw;
  if (typeof raw === 'string') {
    try {
      input = JSON.parse(raw);
    } catch {
      return 'The grading settings could not be read. Refresh the page and try again.';
    }
  }
  try {
    return normalizeGradingConfig(input);
  } catch (err) {
    return err instanceof Error && err.message ? err.message : 'The grading settings are not valid.';
  }
}

function parseTitle(raw: string | undefined, errors: FieldErrors): string | undefined {
  const title = (raw ?? '').trim();
  if (!title) errors.title = 'Give the assignment a title.';
  else if (title.length > MAX_TITLE) errors.title = `Keep the title to ${MAX_TITLE} characters or fewer.`;
  else return title;
  return undefined;
}

function parseDescription(raw: string, errors: FieldErrors): string | undefined {
  const description = raw.trim();
  if (description.length <= MAX_DESCRIPTION) return description;
  errors.description = 'The description can be at most 10,000 characters.';
  return undefined;
}

function parseDueAt(raw: string | undefined, errors: FieldErrors): string | undefined {
  const text = (raw ?? '').trim();
  const ms = Date.parse(text);
  if (!text) errors.dueAt = 'Choose a due date.';
  else if (!Number.isFinite(ms)) errors.dueAt = 'Enter a valid due date and time.';
  else return new Date(ms).toISOString();
  return undefined;
}

function parsePoints(raw: string | undefined, errors: FieldErrors): number | undefined {
  const text = (raw ?? '').trim();
  const points = round2(Number(text));
  if (!text) errors.points = 'Enter how many points the assignment is worth.';
  else if (!Number.isFinite(points)) errors.points = 'Points must be a number.';
  else if (points <= 0) errors.points = 'Points must be greater than 0.';
  else if (points > MAX_POINTS) errors.points = 'Points can be at most 10,000.';
  else return points;
  return undefined;
}

export function parseAssignmentInput(
  body: unknown,
  mode: 'create' | 'update',
): { input: AssignmentInput; errors: FieldErrors } {
  const isCreate = mode === 'create';
  const errors: FieldErrors = {};
  const input: AssignmentInput = { removeTemplate: textField(body, 'removeTemplate') === 'true' };

  const title = textField(body, 'title');
  if (title !== undefined || isCreate) input.title = parseTitle(title, errors);

  const description = textField(body, 'description');
  if (description !== undefined) input.description = parseDescription(description, errors);
  else if (isCreate) input.description = '';

  const dueAt = textField(body, 'dueAt');
  if (dueAt !== undefined || isCreate) input.dueAt = parseDueAt(dueAt, errors);

  const points = textField(body, 'points');
  if (points !== undefined || isCreate) input.points = parsePoints(points, errors);

  const gradingMode = textField(body, 'gradingMode');
  if (gradingMode === 'auto' || gradingMode === 'manual') input.gradingMode = gradingMode;
  else if (gradingMode !== undefined) errors.gradingMode = 'Choose autograding or manual grading.';

  const rawConfig = rawField(body, 'gradingConfig');
  if (rawConfig !== undefined && rawConfig !== null && rawConfig !== '') {
    const config = parseGradingConfig(rawConfig);
    if (typeof config === 'string') errors.gradingConfig = config;
    else input.gradingConfig = config;
  }

  return { input, errors };
}

/**
 * Throws one 400 with every field error. The top-level message is the answer-key problem when there is one
 * (the most important fix), otherwise the single error, otherwise a summary.
 */
export function throwIfErrors(errors: FieldErrors): void {
  const messages = Object.values(errors);
  if (messages.length === 0) return;
  const error = errors.keyFile ?? (messages.length === 1 ? messages[0] : 'Please fix the highlighted fields.');
  throw badRequest(error, errors);
}
