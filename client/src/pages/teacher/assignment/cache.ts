import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { qk } from '../../../api/endpoints';

function invalidateAll(qc: QueryClient, keys: { queryKey: QueryKey; exact?: boolean }[]) {
  return Promise.all(keys.map((k) => qc.invalidateQueries(k)));
}

/**
 * After an assignment is created, edited, deleted or re-graded.
 * qk.assignment(id) is a prefix of its submissions, attempts and key-workbook queries, so they refresh too.
 */
export function invalidateAssignment(qc: QueryClient, classId: number, assignmentId?: number) {
  const keys: { queryKey: QueryKey; exact?: boolean }[] = [
    { queryKey: qk.classes, exact: true },
    { queryKey: qk.class(classId), exact: true },
    { queryKey: qk.classAssignments(classId) },
    { queryKey: qk.gradebook(classId) },
    { queryKey: qk.myAssignments },
  ];
  if (assignmentId !== undefined) keys.push({ queryKey: qk.assignment(assignmentId) });
  return invalidateAll(qc, keys);
}

/** After a submission is graded or uploaded (counts, statuses and gradebook cells change). */
export function invalidateSubmissions(qc: QueryClient, classId: number, assignmentId: number, studentId?: number) {
  const keys: { queryKey: QueryKey; exact?: boolean }[] = [
    { queryKey: qk.assignment(assignmentId), exact: true },
    { queryKey: qk.assignmentSubmissions(assignmentId) },
    { queryKey: qk.gradebook(classId) },
    { queryKey: qk.classAssignments(classId) },
    { queryKey: qk.myAssignments },
  ];
  if (studentId !== undefined) keys.push({ queryKey: qk.studentSubmissions(assignmentId, studentId) });
  return invalidateAll(qc, keys);
}
