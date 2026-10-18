import type { GradebookCell, GradebookResponse } from '../../../shared/types.js';
import { classAssignments, classRoster, teacherSummaries } from './assignments.js';
import { formatScore, lateness, round2 } from './common.js';
import { toCsv, type CsvValue } from './csv.js';
import { finalScore, latestBriefRows, teacherRowStatus } from './submissions.js';

const MISSING: GradebookCell = {
  submissionId: null,
  status: 'missing',
  finalScore: null,
  late: false,
  submittedAt: null,
};

/** Latest submission per enrolled student × assignment; every cell is present (missing ones included). */
export function buildGradebook(classId: number): GradebookResponse {
  const rows = classAssignments(classId);
  const latest = latestBriefRows(rows.map((r) => r.id));
  const students = classRoster(classId);
  const dueAt = new Map(rows.map((r) => [r.id, r.due_at]));

  const cells: GradebookResponse['cells'] = {};
  for (const student of students) {
    cells[student.id] = Object.fromEntries(rows.map((r) => [r.id, MISSING]));
  }
  for (const sub of latest) {
    const row = cells[sub.student_id];
    if (!row) continue;
    row[sub.assignment_id] = {
      submissionId: sub.id,
      status: teacherRowStatus(sub),
      finalScore: finalScore(sub),
      late: lateness(sub.submitted_at, dueAt.get(sub.assignment_id)!).late,
      submittedAt: sub.submitted_at,
    };
  }
  return { assignments: teacherSummaries(rows, latest), students, cells };
}

function cellText(cell: GradebookCell): string {
  if (cell.status === 'missing') return '';
  const score = cell.finalScore === null ? 'Ungraded' : formatScore(cell.finalScore);
  return cell.late ? `${score} LATE` : score;
}

/**
 * Header: Student, Email, "<title> (<points>)" per assignment, Total. A cell is the final score with a
 * " LATE" suffix when late, "Ungraded" when submitted but not scored yet, and blank when missing.
 */
export function gradebookCsv(book: GradebookResponse): string {
  const header: CsvValue[] = [
    'Student',
    'Email',
    ...book.assignments.map((a) => `${a.title} (${formatScore(a.points)})`),
    'Total',
  ];
  const lines = book.students.map((student) => {
    const row = book.cells[student.id] ?? {};
    const cells = book.assignments.map((a) => row[a.id] ?? MISSING);
    const total = round2(cells.reduce((sum, c) => sum + (c.finalScore ?? 0), 0));
    return [student.name, student.email, ...cells.map(cellText), formatScore(total)];
  });
  return toCsv([header, ...lines]);
}
