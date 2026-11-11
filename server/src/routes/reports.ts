/** PDF reports (docs/API.md "Reports (PDF)"). Teacher-only: the owner of the class. */
import { Router, type Response } from 'express';
import { isEnrolled, teacherAssignment, teacherClass } from '../access.js';
import { currentUser, requireAuth, requireRole } from '../auth.js';
import type { ClassRow, UserRow } from '../db.js';
import { intParam, notFound } from '../http.js';
import { safeFileName } from '../services/csv.js';
import { assignmentReport, gradebookReport, studentReports } from '../services/reports/data.js';
import type { ReportContext } from '../services/reports/pdf.js';
import { renderReport } from '../services/reports/render.js';
import type { RenderJob } from '../services/reports/render-worker.js';

const router = Router();
const teacherOnly = [requireAuth, requireRole('teacher')];

/**
 * Content-Disposition for a download named `fileName`: an ASCII fallback (accents dropped) for old clients and the
 * exact UTF-8 name per RFC 5987/6266, so "Nguyễn Thị Hương - Algebra.pdf" keeps its name when saved.
 */
function attachmentHeader(fileName: string): string {
  const ascii = fileName
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\%]/g, '_');
  const hex = (c: string) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`;
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, hex);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** "<subject> - <class>.pdf" */
function pdfFileName(subject: string, fallback: string, cls: ClassRow): string {
  return `${safeFileName(subject, fallback)} - ${safeFileName(cls.name, 'Class')}.pdf`;
}

function context(cls: ClassRow, teacher: UserRow): ReportContext {
  return { className: cls.name, teacherName: teacher.name, generatedAt: new Date() };
}

/** Renders in a worker thread (`build` reads the data on this one); 503/429 when too many reports are in progress. */
async function sendPdf(res: Response, user: UserRow, fileName: string, build: () => RenderJob): Promise<void> {
  const pdf = await renderReport(user.id, build);
  res.set('Content-Disposition', attachmentHeader(fileName));
  res.set('Cache-Control', 'no-store');
  res.type('application/pdf');
  res.send(pdf);
}

router.get('/api/reports/assignments/:assignmentId.pdf', ...teacherOnly, async (req, res) => {
  const user = currentUser(req);
  const { cls, assignment } = teacherAssignment(intParam(req.params.assignmentId, 'assignment id'), user);
  await sendPdf(res, user, pdfFileName(assignment.title, 'Assignment', cls), () => ({
    kind: 'assignment',
    report: assignmentReport(assignment),
    ctx: context(cls, user),
  }));
});

router.get('/api/reports/classes/:classId/students.pdf', ...teacherOnly, async (req, res) => {
  const user = currentUser(req);
  const cls = teacherClass(intParam(req.params.classId, 'class id'), user);
  await sendPdf(res, user, pdfFileName('All students', 'All students', cls), () => ({
    kind: 'students',
    reports: studentReports(cls.id),
    ctx: context(cls, user),
  }));
});

router.get('/api/reports/classes/:classId/students/:studentId.pdf', ...teacherOnly, async (req, res) => {
  const user = currentUser(req);
  const cls = teacherClass(intParam(req.params.classId, 'class id'), user);
  const studentId = intParam(req.params.studentId, 'student id');
  if (!isEnrolled(cls.id, studentId)) throw notFound('That student is not in this class.');
  const [report] = studentReports(cls.id, [studentId]);
  await sendPdf(res, user, pdfFileName(report.student.name, 'Student', cls), () => ({
    kind: 'student',
    report,
    ctx: context(cls, user),
  }));
});

router.get('/api/reports/classes/:classId/gradebook.pdf', ...teacherOnly, async (req, res) => {
  const user = currentUser(req);
  const cls = teacherClass(intParam(req.params.classId, 'class id'), user);
  await sendPdf(res, user, pdfFileName('Gradebook', 'Gradebook', cls), () => ({
    kind: 'gradebook',
    report: gradebookReport(cls.id),
    ctx: context(cls, user),
  }));
});

export default router;
