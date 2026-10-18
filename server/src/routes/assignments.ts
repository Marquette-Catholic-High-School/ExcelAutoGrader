import { Router, type RequestHandler, type Response } from 'express';
import { DEFAULT_GRADING_CONFIG, type GradingConfig, type OkResponse } from '../../../shared/types.js';
import { assignmentAccess, classAccess, teacherAssignment, teacherClass } from '../access.js';
import { currentUser, requireAuth, requireRole } from '../auth.js';
import { nowIso, run, transaction, type AssignmentRow, type FileRow, type UserRow } from '../db.js';
import { badRequest, intParam, notFound } from '../http.js';
import { filePath, getFile, saveFileRecord, sendFile, upload } from '../uploads.js';
import {
  KEY_REQUIRED,
  parseAssignmentInput,
  parseGradingConfig,
  throwIfErrors,
  type AssignmentInput,
  type FieldErrors,
} from '../services/assignment-form.js';
import {
  assignmentWithClass,
  classAssignments,
  summariesFor,
  toAssignmentDetail,
  userAssignments,
} from '../services/assignments.js';
import { gradingRulesChanged, readConfig } from '../services/config.js';
import { assignmentFiles, purgeFiles } from '../services/files.js';
import { clearAutoGrades, regradeAssignment } from '../services/grading.js';
import { withUploads, type UploadTracker } from '../services/upload-tracker.js';
import { noGradableCellsReason, safePreview, unreadableReason, viewerWorkbook } from '../services/workbooks.js';

const router = Router();

const assignmentFilesUpload = upload.fields([
  { name: 'keyFile', maxCount: 1 },
  { name: 'templateFile', maxCount: 1 },
]);

const classIdOf = (params: Record<string, unknown>) => intParam(params.classId, 'class id');
const assignmentIdOf = (params: Record<string, unknown>) => intParam(params.assignmentId, 'assignment id');

/** Rejects before multer writes anything to disk when the teacher does not own the class/assignment. */
const ownsClass: RequestHandler = (req, _res, next) => {
  teacherClass(classIdOf(req.params), currentUser(req));
  next();
};
const ownsAssignment: RequestHandler = (req, _res, next) => {
  teacherAssignment(assignmentIdOf(req.params), currentUser(req));
  next();
};

function sendDetail(res: Response, assignmentId: number, user: UserRow, isTeacher: boolean) {
  const row = assignmentWithClass(assignmentId);
  if (!row) throw notFound('Assignment not found.');
  res.json(toAssignmentDetail(row, user, isTeacher));
}

/** Adds keyFile/templateFile errors for unreadable uploads. */
function checkUploadsReadable(uploads: UploadTracker, errors: FieldErrors): void {
  for (const field of ['keyFile', 'templateFile']) {
    const reason = unreadableReason(uploads.file(field));
    if (reason) errors[field] = reason;
  }
}

/** For an autograded assignment: the key must exist and must yield at least one gradable cell. */
function checkKeyGradable(
  keyPath: string | null,
  templatePath: string | null,
  config: GradingConfig,
  errors: FieldErrors,
): void {
  if (!keyPath) {
    errors.keyFile = KEY_REQUIRED;
    return;
  }
  if (Object.keys(errors).length > 0) return; // config or files are invalid: a preview would be meaningless
  const reason = noGradableCellsReason(keyPath, templatePath, config);
  if (reason) errors.keyFile = reason;
}

const storedPath = (file: FileRow | null) => (file ? filePath(file) : null);

/* ------------------------------------------------------------------ */
/* Lists & detail                                                     */
/* ------------------------------------------------------------------ */

router.get('/api/classes/:classId/assignments', requireAuth, (req, res) => {
  const user = currentUser(req);
  const { cls, isTeacher } = classAccess(classIdOf(req.params), user);
  res.json(summariesFor(classAssignments(cls.id), user, isTeacher));
});

router.get('/api/me/assignments', requireAuth, (req, res) => {
  const user = currentUser(req);
  res.json(summariesFor(userAssignments(user), user, user.role === 'teacher'));
});

router.get('/api/assignments/:assignmentId', requireAuth, (req, res) => {
  const user = currentUser(req);
  const { assignment, isTeacher } = assignmentAccess(assignmentIdOf(req.params), user);
  sendDetail(res, assignment.id, user, isTeacher);
});

/* ------------------------------------------------------------------ */
/* Create                                                             */
/* ------------------------------------------------------------------ */

router.post(
  '/api/classes/:classId/assignments',
  requireAuth,
  requireRole('teacher'),
  ownsClass,
  assignmentFilesUpload,
  withUploads((req, res, uploads) => {
    const user = currentUser(req);
    const cls = teacherClass(classIdOf(req.params), user);
    const { input, errors } = parseAssignmentInput(req.body, 'create');
    const keyFile = uploads.file('keyFile');
    const templateFile = uploads.file('templateFile');
    checkUploadsReadable(uploads, errors);

    // Without an explicit mode, an assignment is autograded (and therefore needs its answer key).
    const mode = input.gradingMode ?? 'auto';
    const config = input.gradingConfig ?? { ...DEFAULT_GRADING_CONFIG };
    if (mode === 'auto') checkKeyGradable(keyFile?.path ?? null, templateFile?.path ?? null, config, errors);
    throwIfErrors(errors);

    const assignmentId = transaction(() => {
      const key = keyFile ? saveFileRecord(keyFile, user.id) : null;
      const template = templateFile ? saveFileRecord(templateFile, user.id) : null;
      return run(
        `INSERT INTO assignments (class_id, title, description, due_at, points, grading_mode, grading_config,
           key_file_id, template_file_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        cls.id,
        input.title!,
        input.description ?? '',
        input.dueAt!,
        input.points!,
        mode,
        JSON.stringify(config),
        key?.id ?? null,
        template?.id ?? null,
        nowIso(),
      ).lastInsertRowid;
    });
    uploads.keep(keyFile, templateFile);
    sendDetail(res, assignmentId, user, true);
  }),
);

/* ------------------------------------------------------------------ */
/* Update                                                             */
/* ------------------------------------------------------------------ */

interface UpdatePlan {
  next: AssignmentRow;
  oldKey: FileRow | null;
  oldTemplate: FileRow | null;
  replaceKey: boolean;
  replaceTemplate: boolean;
  needsRegrade: boolean;
  switchedToManual: boolean;
}

/** Validates the update and works out what changes; throws 400 with every field error. */
function planUpdate(assignment: AssignmentRow, input: AssignmentInput, uploads: UploadTracker, errors: FieldErrors) {
  const keyFile = uploads.file('keyFile');
  const templateFile = uploads.file('templateFile');
  checkUploadsReadable(uploads, errors);

  const oldKey = getFile(assignment.key_file_id);
  const oldTemplate = getFile(assignment.template_file_id);
  const oldConfig = readConfig(assignment);
  const mode = input.gradingMode ?? assignment.grading_mode;
  const config = input.gradingConfig ?? oldConfig;
  const points = input.points ?? assignment.points;
  const removeTemplate = input.removeTemplate && !templateFile; // a new upload replaces the template anyway

  const replaceKey = !!keyFile;
  const replaceTemplate = !!templateFile || (removeTemplate && !!oldTemplate);
  const modeChanged = mode !== assignment.grading_mode;
  const keyInputsChanged = replaceKey || replaceTemplate || modeChanged || gradingRulesChanged(oldConfig, config);

  if (mode === 'auto' && (keyInputsChanged || !oldKey)) {
    const keyPath = keyFile?.path ?? storedPath(oldKey);
    const templatePath = templateFile?.path ?? (removeTemplate ? null : storedPath(oldTemplate));
    checkKeyGradable(keyPath, templatePath, config, errors);
  }
  throwIfErrors(errors);

  const next: AssignmentRow = {
    ...assignment,
    title: input.title ?? assignment.title,
    description: input.description ?? assignment.description,
    due_at: input.dueAt ?? assignment.due_at,
    points,
    grading_mode: mode,
    grading_config: JSON.stringify(config),
  };
  const plan: UpdatePlan = {
    next,
    oldKey,
    oldTemplate,
    replaceKey,
    replaceTemplate,
    needsRegrade: mode === 'auto' && (keyInputsChanged || points !== assignment.points),
    switchedToManual: modeChanged && mode === 'manual',
  };
  return plan;
}

router.patch(
  '/api/assignments/:assignmentId',
  requireAuth,
  requireRole('teacher'),
  ownsAssignment,
  assignmentFilesUpload,
  withUploads((req, res, uploads) => {
    const user = currentUser(req);
    const { assignment } = teacherAssignment(assignmentIdOf(req.params), user);
    const { input, errors } = parseAssignmentInput(req.body, 'update');
    const plan = planUpdate(assignment, input, uploads, errors);
    const keyFile = uploads.file('keyFile');
    const templateFile = uploads.file('templateFile');
    const { next } = plan;

    transaction(() => {
      if (keyFile) next.key_file_id = saveFileRecord(keyFile, user.id).id;
      if (plan.replaceTemplate) next.template_file_id = templateFile ? saveFileRecord(templateFile, user.id).id : null;
      run(
        `UPDATE assignments SET title = ?, description = ?, due_at = ?, points = ?, grading_mode = ?,
           grading_config = ?, key_file_id = ?, template_file_id = ?
         WHERE id = ?`,
        next.title,
        next.description,
        next.due_at,
        next.points,
        next.grading_mode,
        next.grading_config,
        next.key_file_id,
        next.template_file_id,
        next.id,
      );
      if (plan.switchedToManual) clearAutoGrades(next.id);
    });
    uploads.keep(keyFile, templateFile);

    const replaced = [plan.replaceKey && plan.oldKey, plan.replaceTemplate && plan.oldTemplate];
    purgeFiles(replaced.filter((f): f is FileRow => !!f));
    if (plan.needsRegrade) regradeAssignment(next);
    sendDetail(res, next.id, user, true);
  }),
);

/* ------------------------------------------------------------------ */
/* Delete & regrade                                                   */
/* ------------------------------------------------------------------ */

router.delete('/api/assignments/:assignmentId', requireAuth, requireRole('teacher'), (req, res) => {
  const { assignment } = teacherAssignment(assignmentIdOf(req.params), currentUser(req));
  const files = assignmentFiles([assignment.id]);
  transaction(() => {
    run('DELETE FROM submissions WHERE assignment_id = ?', assignment.id);
    run('DELETE FROM assignments WHERE id = ?', assignment.id);
  });
  purgeFiles(files);
  const ok: OkResponse = { ok: true };
  res.json(ok);
});

router.post('/api/assignments/:assignmentId/regrade', requireAuth, requireRole('teacher'), (req, res) => {
  const { assignment } = teacherAssignment(assignmentIdOf(req.params), currentUser(req));
  if (assignment.grading_mode !== 'auto') {
    throw badRequest('This assignment is graded manually. Turn on autograding (with an answer key) to re-grade it.');
  }
  if (!assignment.key_file_id) throw badRequest(KEY_REQUIRED, { keyFile: KEY_REQUIRED });
  res.json(regradeAssignment(assignment));
});

/* ------------------------------------------------------------------ */
/* Files                                                              */
/* ------------------------------------------------------------------ */

router.get('/api/assignments/:assignmentId/template/download', requireAuth, (req, res) => {
  const { assignment } = assignmentAccess(assignmentIdOf(req.params), currentUser(req));
  const template = getFile(assignment.template_file_id);
  if (!template) throw notFound('This assignment has no starter file.');
  sendFile(res, template);
});

router.get('/api/assignments/:assignmentId/key/download', requireAuth, requireRole('teacher'), (req, res) => {
  const { assignment } = teacherAssignment(assignmentIdOf(req.params), currentUser(req));
  const key = getFile(assignment.key_file_id);
  if (!key) throw notFound('This assignment has no answer key.');
  sendFile(res, key);
});

router.get('/api/assignments/:assignmentId/key/workbook', requireAuth, requireRole('teacher'), (req, res) => {
  const { assignment } = teacherAssignment(assignmentIdOf(req.params), currentUser(req));
  res.json(viewerWorkbook(getFile(assignment.key_file_id), 'This assignment has no answer key.'));
});

/* ------------------------------------------------------------------ */
/* Key preview (nothing is stored)                                    */
/* ------------------------------------------------------------------ */

/** The owned assignment named by the optional `assignmentId` form field. */
function previewAssignment(body: unknown, user: UserRow): AssignmentRow | null {
  const raw = (body as Record<string, unknown> | undefined)?.assignmentId;
  if (raw === undefined || raw === null || raw === '') return null;
  return teacherAssignment(intParam(raw, 'assignment id'), user).assignment;
}

router.post(
  '/api/grader/preview',
  requireAuth,
  requireRole('teacher'),
  assignmentFilesUpload,
  withUploads((req, res, uploads) => {
    const user = currentUser(req);
    const assignment = previewAssignment(req.body, user);
    const errors: FieldErrors = {};
    checkUploadsReadable(uploads, errors);

    const rawConfig = (req.body as Record<string, unknown> | undefined)?.gradingConfig;
    const config = rawConfig ? parseGradingConfig(rawConfig) : { ...DEFAULT_GRADING_CONFIG };
    if (typeof config === 'string') errors.gradingConfig = config;

    const keyPath = uploads.file('keyFile')?.path ?? storedPath(getFile(assignment?.key_file_id));
    if (!keyPath && !errors.keyFile) errors.keyFile = 'Upload the finished workbook (answer key) to preview it.';
    throwIfErrors(errors);

    const ignoreStored = (req.body as Record<string, unknown> | undefined)?.ignoreStoredTemplate === 'true';
    const storedTemplate = ignoreStored ? null : getFile(assignment?.template_file_id);
    const templatePath = uploads.file('templateFile')?.path ?? storedPath(storedTemplate);
    res.json(safePreview(keyPath!, templatePath, config as GradingConfig));
  }),
);

export default router;
