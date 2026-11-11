import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { HttpError } from '../../http.js';
import type { StudentReport } from './data.js';
import { pdfFontNames, pdfText } from './pdf-text.js';
import { MAX_IN_PROGRESS, MAX_PER_USER, renderReport, stopRenderPool } from './render.js';
import type { RenderJob } from './render-worker.js';
import { studentSummary } from './stats.js';

// Only Roboto, whatever fonts this computer has (set before the first report is made).
process.env.PDF_FALLBACK_FONTS = 'none';

after(() => stopRenderPool());

const ctx = { className: 'Algebra', teacherName: 'Ms. Rivera', generatedAt: new Date('2026-11-12T15:00:00Z') };

function students(count: number, name = (i: number) => `Student ${i}`): StudentReport[] {
  return Array.from({ length: count }, (_, i) => ({
    student: {
      id: i + 1,
      name: name(i),
      email: `s${i}@school.test`,
      joinedAt: '',
      mustChangePassword: false,
      pending: false,
    },
    rows: [],
    summary: studentSummary([]),
  }));
}

const job = (reports: StudentReport[]): RenderJob => ({ kind: 'students', reports, ctx });

const status = (err: unknown) => (err instanceof HttpError ? err.status : null);

describe('PDF rendering in worker threads', () => {
  test('makes the PDF in a worker while this thread keeps answering', async () => {
    let longestGap = 0;
    let last = Date.now();
    const timer = setInterval(() => {
      longestGap = Math.max(longestGap, Date.now() - last);
      last = Date.now();
    }, 5);
    const started = Date.now();
    const pdf = await renderReport(1, () => job(students(600)));
    const took = Date.now() - started;
    clearInterval(timer);
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    assert.ok(longestGap < Math.max(150, took / 4), `this thread was blocked for ${longestGap} ms of ${took} ms`);
  });

  test('one user can have at most two reports in progress; a refused request reads no data', async () => {
    const accepted = Array.from({ length: MAX_PER_USER }, () => renderReport(7, () => job(students(5))));
    let built = false;
    const refused = renderReport(7, () => {
      built = true;
      return job([]);
    });
    await assert.rejects(refused, (err) => status(err) === 429);
    assert.equal(built, false);
    for (const pdf of await Promise.all(accepted)) assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    assert.ok(await renderReport(7, () => job([])), 'accepted again once they are done');
  });

  test('the server answers "busy" (503) beyond the pool and its queue', async () => {
    const accepted = Array.from({ length: MAX_IN_PROGRESS }, (_, i) => renderReport(100 + i, () => job(students(20))));
    await assert.rejects(
      renderReport(999, () => job([])),
      (err) => status(err) === 503,
    );
    await Promise.all(accepted);
  });

  test('characters no font has print as "?" instead of empty boxes', async () => {
    const pdf = await renderReport(2, () => job(students(1, () => '王芳 Ana')));
    const text = pdfText(pdf);
    assert.match(text, /\?\? Ana/);
    assert.deepEqual(pdfFontNames(pdf).filter((f) => !f.startsWith('Roboto')), []);
  });
});
