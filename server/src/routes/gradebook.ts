import { Router } from 'express';
import { teacherClass } from '../access.js';
import { currentUser, requireAuth, requireRole } from '../auth.js';
import { intParam } from '../http.js';
import { safeFileName } from '../services/csv.js';
import { buildGradebook, gradebookCsv } from '../services/gradebook.js';

const router = Router();

router.get('/api/classes/:classId/gradebook', requireAuth, requireRole('teacher'), (req, res) => {
  const cls = teacherClass(intParam(req.params.classId, 'class id'), currentUser(req));
  res.json(buildGradebook(cls.id));
});

router.get('/api/classes/:classId/gradebook.csv', requireAuth, requireRole('teacher'), (req, res) => {
  const cls = teacherClass(intParam(req.params.classId, 'class id'), currentUser(req));
  const csv = gradebookCsv(buildGradebook(cls.id));
  res.attachment(`${safeFileName(cls.name, 'class')} gradebook.csv`);
  res.type('text/csv; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  res.send(csv);
});

export default router;
