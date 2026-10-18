import { DEFAULT_GRADING_CONFIG, type GradingConfig } from '../../../shared/types.js';
import type { AssignmentRow } from '../db.js';

/**
 * The stored config of an assignment. Stored configs were normalized on write; merging over the defaults
 * keeps old rows working if new options are added later.
 */
export function readConfig(row: Pick<AssignmentRow, 'grading_config'>): GradingConfig {
  try {
    const parsed: unknown = JSON.parse(row.grading_config);
    if (parsed && typeof parsed === 'object') {
      return { ...DEFAULT_GRADING_CONFIG, ...(parsed as Partial<GradingConfig>) };
    }
  } catch {
    // corrupt JSON: fall back to defaults
  }
  return { ...DEFAULT_GRADING_CONFIG };
}

/** Options that only control what students see; changing them never requires re-grading. */
const VISIBILITY_KEYS = new Set<keyof GradingConfig>(['showDetailsToStudents', 'showExpectedToStudents']);

function gradingSignature(config: GradingConfig): string {
  const entries = Object.entries(config)
    .filter(([key]) => !VISIBILITY_KEYS.has(key as keyof GradingConfig))
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}

/** True when the change affects scores (anything except the student-visibility flags). */
export function gradingRulesChanged(before: GradingConfig, after: GradingConfig): boolean {
  return gradingSignature(before) !== gradingSignature(after);
}
