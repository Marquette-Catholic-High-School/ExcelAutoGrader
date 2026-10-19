/**
 * Typed wrappers for every endpoint in docs/API.md, plus TanStack Query keys.
 * Pages should use these instead of calling `api` with raw paths.
 *
 *   const { data } = useQuery({ queryKey: qk.class(id), queryFn: () => endpoints.getClass(id) });
 *   const m = useMutation({ mutationFn: endpoints.createClass, onSuccess: () => qc.invalidateQueries({ queryKey: qk.classes }) });
 */
import type {
  AddStudentsRequest,
  AddStudentsResponse,
  AssignmentDetail,
  AssignmentFormFields,
  AssignmentSubmissionsResponse,
  AssignmentSummary,
  AuthResponse,
  ChangePasswordRequest,
  ClassSummary,
  CreateClassRequest,
  GradebookResponse,
  GradeSubmissionRequest,
  GradingConfig,
  KeyPreview,
  LoginRequest,
  OkResponse,
  RegisterRequest,
  RegradeResponse,
  ResetPasswordResponse,
  RosterPreview,
  StudentInfo,
  SubmissionDetail,
  UpdateClassRequest,
  User,
  WorkbookData,
} from '@shared/types';
import { api } from './client';

export const qk = {
  me: ['me'] as const,
  classes: ['classes'] as const,
  class: (id: number) => ['classes', id] as const,
  students: (classId: number) => ['classes', classId, 'students'] as const,
  classAssignments: (classId: number) => ['classes', classId, 'assignments'] as const,
  gradebook: (classId: number) => ['classes', classId, 'gradebook'] as const,
  myAssignments: ['my-assignments'] as const,
  /** Prefix of every assignment* key below (for invalidating them all, optionally with a predicate). */
  assignments: ['assignments'] as const,
  assignment: (id: number) => ['assignments', id] as const,
  assignmentSubmissions: (id: number) => ['assignments', id, 'submissions'] as const,
  studentSubmissions: (assignmentId: number, studentId: number) =>
    ['assignments', assignmentId, 'students', studentId, 'submissions'] as const,
  mySubmissions: (assignmentId: number) => ['assignments', assignmentId, 'my-submissions'] as const,
  keyWorkbook: (assignmentId: number) => ['assignments', assignmentId, 'key-workbook'] as const,
  submission: (id: number) => ['submissions', id] as const,
  submissionWorkbook: (id: number) => ['submissions', id, 'workbook'] as const,
};

/** Fields for creating/updating an assignment. Files are optional on update. */
export interface AssignmentFormPayload extends Partial<AssignmentFormFields> {
  keyFile?: File | null;
  templateFile?: File | null;
  removeTemplate?: boolean;
}

function assignmentForm(p: AssignmentFormPayload): FormData {
  const fd = new FormData();
  if (p.title !== undefined) fd.append('title', p.title);
  if (p.description !== undefined) fd.append('description', p.description);
  if (p.dueAt !== undefined) fd.append('dueAt', p.dueAt);
  if (p.points !== undefined) fd.append('points', String(p.points));
  if (p.gradingMode !== undefined) fd.append('gradingMode', p.gradingMode);
  if (p.gradingConfig !== undefined) fd.append('gradingConfig', JSON.stringify(p.gradingConfig));
  if (p.removeTemplate) fd.append('removeTemplate', 'true');
  if (p.keyFile) fd.append('keyFile', p.keyFile);
  if (p.templateFile) fd.append('templateFile', p.templateFile);
  return fd;
}

export const endpoints = {
  // auth
  register: (body: RegisterRequest) => api.post<AuthResponse>('/api/auth/register', body),
  login: (body: LoginRequest) => api.post<AuthResponse>('/api/auth/login', body),
  logout: () => api.post<OkResponse>('/api/auth/logout'),
  me: () => api.get<{ user: User }>('/api/auth/me'),
  changePassword: (body: ChangePasswordRequest) => api.post<{ user: User }>('/api/auth/change-password', body),

  // classes
  listClasses: () => api.get<ClassSummary[]>('/api/classes'),
  createClass: (body: CreateClassRequest) => api.post<ClassSummary>('/api/classes', body),
  getClass: (classId: number) => api.get<ClassSummary>(`/api/classes/${classId}`),
  updateClass: (classId: number, body: UpdateClassRequest) => api.patch<ClassSummary>(`/api/classes/${classId}`, body),
  deleteClass: (classId: number) => api.delete<OkResponse>(`/api/classes/${classId}`),
  regenerateJoinCode: (classId: number) => api.post<ClassSummary>(`/api/classes/${classId}/regenerate-code`),
  joinClass: (joinCode: string) => api.post<ClassSummary>('/api/classes/join', { joinCode }),
  listStudents: (classId: number) => api.get<StudentInfo[]>(`/api/classes/${classId}/students`),
  addStudents: (classId: number, body: AddStudentsRequest) =>
    api.post<AddStudentsResponse>(`/api/classes/${classId}/students`, body),
  /** Reads an uploaded roster (CSV/Excel) and reports what adding each row would do; nothing is saved. */
  importRosterPreview: (classId: number, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return api.upload<RosterPreview>(`/api/classes/${classId}/students/import-preview`, fd);
  },
  removeStudent: (classId: number, studentId: number) =>
    api.delete<OkResponse>(`/api/classes/${classId}/students/${studentId}`),
  resetStudentPassword: (classId: number, studentId: number) =>
    api.post<ResetPasswordResponse>(`/api/classes/${classId}/students/${studentId}/reset-password`),

  // assignments
  listClassAssignments: (classId: number) => api.get<AssignmentSummary[]>(`/api/classes/${classId}/assignments`),
  listMyAssignments: () => api.get<AssignmentSummary[]>('/api/me/assignments'),
  createAssignment: (classId: number, payload: AssignmentFormPayload) =>
    api.upload<AssignmentDetail>(`/api/classes/${classId}/assignments`, assignmentForm(payload)),
  getAssignment: (assignmentId: number) => api.get<AssignmentDetail>(`/api/assignments/${assignmentId}`),
  updateAssignment: (assignmentId: number, payload: AssignmentFormPayload) =>
    api.upload<AssignmentDetail>(`/api/assignments/${assignmentId}`, assignmentForm(payload), 'PATCH'),
  deleteAssignment: (assignmentId: number) => api.delete<OkResponse>(`/api/assignments/${assignmentId}`),
  regradeAssignment: (assignmentId: number) => api.post<RegradeResponse>(`/api/assignments/${assignmentId}/regrade`),
  downloadTemplate: (assignmentId: number) => api.download(`/api/assignments/${assignmentId}/template/download`),
  downloadKey: (assignmentId: number) => api.download(`/api/assignments/${assignmentId}/key/download`),
  getKeyWorkbook: (assignmentId: number) => api.get<WorkbookData>(`/api/assignments/${assignmentId}/key/workbook`),
  /**
   * What the autograder would check. Pass a new keyFile, or (when editing) the assignmentId to reuse its stored
   * key/template. ignoreStoredTemplate: the teacher is removing the stored template in the form.
   */
  previewKey: (p: {
    config: GradingConfig;
    keyFile?: File | null;
    templateFile?: File | null;
    assignmentId?: number;
    ignoreStoredTemplate?: boolean;
  }) => {
    const fd = new FormData();
    if (p.keyFile) fd.append('keyFile', p.keyFile);
    if (p.templateFile) fd.append('templateFile', p.templateFile);
    if (p.assignmentId !== undefined) fd.append('assignmentId', String(p.assignmentId));
    if (p.ignoreStoredTemplate) fd.append('ignoreStoredTemplate', 'true');
    fd.append('gradingConfig', JSON.stringify(p.config));
    return api.upload<KeyPreview>('/api/grader/preview', fd);
  },

  // submissions
  listAssignmentSubmissions: (assignmentId: number) =>
    api.get<AssignmentSubmissionsResponse>(`/api/assignments/${assignmentId}/submissions`),
  listStudentSubmissions: (assignmentId: number, studentId: number) =>
    api.get<SubmissionDetail[]>(`/api/assignments/${assignmentId}/students/${studentId}/submissions`),
  listMySubmissions: (assignmentId: number) =>
    api.get<SubmissionDetail[]>(`/api/assignments/${assignmentId}/my-submissions`),
  /** Students omit studentId; teachers uploading on a student's behalf pass it. */
  submit: (assignmentId: number, file: File, studentId?: number) => {
    const fd = new FormData();
    fd.append('file', file);
    if (studentId !== undefined) fd.append('studentId', String(studentId));
    return api.upload<SubmissionDetail>(`/api/assignments/${assignmentId}/submissions`, fd);
  },
  getSubmission: (submissionId: number) => api.get<SubmissionDetail>(`/api/submissions/${submissionId}`),
  gradeSubmission: (submissionId: number, body: GradeSubmissionRequest) =>
    api.patch<SubmissionDetail>(`/api/submissions/${submissionId}/grade`, body),
  downloadSubmission: (submissionId: number) => api.download(`/api/submissions/${submissionId}/download`),
  getSubmissionWorkbook: (submissionId: number) =>
    api.get<WorkbookData>(`/api/submissions/${submissionId}/workbook`),

  // gradebook
  getGradebook: (classId: number) => api.get<GradebookResponse>(`/api/classes/${classId}/gradebook`),
  downloadGradebookCsv: (classId: number) => api.download(`/api/classes/${classId}/gradebook.csv`, 'gradebook.csv'),
};
