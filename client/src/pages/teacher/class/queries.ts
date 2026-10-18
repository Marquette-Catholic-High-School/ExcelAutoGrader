import type { QueryClient } from '@tanstack/react-query';
import { qk } from '../../../api/endpoints';

/** After a class's details change (name, description, join code). */
export function invalidateClassSummary(qc: QueryClient, classId: number) {
  void qc.invalidateQueries({ queryKey: qk.classes, exact: true });
  void qc.invalidateQueries({ queryKey: qk.class(classId), exact: true });
}

/**
 * After the roster changes: class counts, the roster itself, the gradebook, assignment counts, the dashboard,
 * and the per-assignment submission tables (one row per enrolled student).
 */
export function invalidateRoster(qc: QueryClient, classId: number) {
  invalidateClassSummary(qc, classId);
  void qc.invalidateQueries({ queryKey: qk.students(classId) });
  void qc.invalidateQueries({ queryKey: qk.gradebook(classId) });
  void qc.invalidateQueries({ queryKey: qk.classAssignments(classId) });
  void qc.invalidateQueries({ queryKey: qk.myAssignments });
  // Every cached qk.assignmentSubmissions(id) (['assignments', id, 'submissions']), including assignments that are
  // not in a cached class list; the per-student attempt lists and other assignment queries are unaffected.
  void qc.invalidateQueries({ queryKey: qk.assignments, predicate: (q) => q.queryKey[2] === 'submissions' });
}
