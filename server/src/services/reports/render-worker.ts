/**
 * Runs in a worker thread (render.ts): lays out and renders one report at a time, so a big class's PDF never holds
 * up the server's other requests. It gets the report data, already read from the database by the main thread, and
 * never opens the database itself.
 */
import { parentPort } from 'node:worker_threads';
import type { TDocumentDefinitions } from 'pdfmake/interfaces.js';
import { assignmentReportPdf } from './assignment-pdf.js';
import type { AssignmentReport, GradebookReport, StudentReport } from './data.js';
import { gradebookPdf } from './gradebook-pdf.js';
import { renderPdf, type ReportContext } from './pdf.js';
import { allStudentsPdf, studentReportPdf } from './student-pdf.js';

export type RenderJob =
  | { kind: 'assignment'; report: AssignmentReport; ctx: ReportContext }
  | { kind: 'student'; report: StudentReport; ctx: ReportContext }
  | { kind: 'students'; reports: StudentReport[]; ctx: ReportContext }
  | { kind: 'gradebook'; report: GradebookReport; ctx: ReportContext };

export interface RenderRequest {
  id: number;
  job: RenderJob;
}

export type RenderReply = { id: number; pdf: Uint8Array } | { id: number; error: string };

export function buildDocument(job: RenderJob): TDocumentDefinitions {
  switch (job.kind) {
    case 'assignment':
      return assignmentReportPdf(job.report, job.ctx);
    case 'student':
      return studentReportPdf(job.report, job.ctx);
    case 'students':
      return allStudentsPdf(job.reports, job.ctx);
    case 'gradebook':
      return gradebookPdf(job.report, job.ctx);
  }
}

parentPort?.on('message', async ({ id, job }: RenderRequest) => {
  try {
    // A copy with its own memory, handed over without another copy (Buffers may share a pool).
    const pdf = new Uint8Array(await renderPdf(buildDocument(job)));
    parentPort!.postMessage({ id, pdf } satisfies RenderReply, [pdf.buffer]);
  } catch (err) {
    const error = err instanceof Error ? (err.stack ?? err.message) : String(err);
    parentPort!.postMessage({ id, error } satisfies RenderReply);
  }
});
