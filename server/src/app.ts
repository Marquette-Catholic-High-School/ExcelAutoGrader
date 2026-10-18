import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { errorHandler, notFound } from './http.js';
import authRouter from './routes/auth.js';
import classesRouter from './routes/classes.js';
import assignmentsRouter from './routes/assignments.js';
import submissionsRouter from './routes/submissions.js';
import gradebookRouter from './routes/gradebook.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(here, '../../client/dist');

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // `instance` lets the start/stop scripts recognise the server they started (a random id they pass in).
  app.get('/api/health', (_req, res) => {
    const instance = process.env.EXCEL_AUTOGRADER_INSTANCE;
    res.json(instance ? { ok: true, instance } : { ok: true });
  });

  // Every router declares full /api/... paths.
  app.use(authRouter);
  app.use(classesRouter);
  app.use(assignmentsRouter);
  app.use(submissionsRouter);
  app.use(gradebookRouter);

  app.use('/api', (_req, _res, next) => next(notFound('No such API endpoint.')));

  // `npm run build` then `npm start -w server` serves the built client from the same port.
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    // `root` keeps send()'s dotfile check off the install path (which may sit under a dot-directory).
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile('index.html', { root: clientDist }));
  }

  app.use(errorHandler);
  return app;
}
