/**
 * Test-only helpers shared by routes/assignments.test.ts and routes/submissions.test.ts: spreadsheet
 * builders and HTTP shortcuts for setting up a class with students and assignments.
 * Nothing here imports db.ts, so it is safe to import before startTestServer().
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import type {
  ApiError,
  AssignmentDetail,
  AuthResponse,
  ClassSummary,
  GradingConfig,
  SubmissionDetail,
} from '../../../shared/types.js';
import { fileBlob, type TestResponse, type TestServer } from '../test-utils.js';

/** A plain value, or a formula with its cached value. */
export type CellSpec = string | number | boolean | null | { f: string; v: number | string };

/** Builds an .xlsx file in memory: { Sheet1: [[...row 1], [...row 2]] }. */
export function workbook(sheets: Record<string, CellSpec[][]>): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    const values = rows.map((row) => row.map((cell) => (cell !== null && typeof cell === 'object' ? cell.v : cell)));
    const ws = XLSX.utils.aoa_to_sheet(values);
    rows.forEach((row, r) =>
      row.forEach((cell, c) => {
        if (cell === null || typeof cell !== 'object') return;
        ws[XLSX.utils.encode_cell({ r, c })] = { t: typeof cell.v === 'number' ? 'n' : 's', v: cell.v, f: cell.f };
      }),
    );
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

const HEADER: CellSpec[] = ['Item', 'Qty', 'Price', 'Total'];

/** Answer key: two formula cells (D2, D3). */
export const KEY = workbook({
  Sheet1: [HEADER, ['Pens', 2, 3, { f: 'B2*C2', v: 6 }], ['Pads', 4, 5, { f: 'B3*C3', v: 20 }]],
});
/** Starter file: the key without the totals. */
export const TEMPLATE = workbook({ Sheet1: [HEADER, ['Pens', 2, 3, null], ['Pads', 4, 5, null]] });
/** Matches the key exactly. */
export const PERFECT = KEY;
/** D2 right; D3 wrong → half of the formula cells. */
export const HALF = workbook({
  Sheet1: [HEADER, ['Pens', 2, 3, { f: 'B2*C2', v: 6 }], ['Pads', 4, 5, { f: 'B3+C3', v: 9 }]],
});
/** A key with values only (nothing to grade when checking formulas). */
export const NO_FORMULAS = workbook({ Sheet1: [HEADER, ['Pens', 2, 3, 6]] });
export const GARBAGE = Buffer.from('this is definitely not a spreadsheet');

/** Only the formula cells are graded, so scores are easy to predict (PERFECT = 100%, HALF = 50%). */
export const FORMULAS_CONFIG: Partial<GradingConfig> = { scope: 'formulas' };

export const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

export interface Actor {
  token: string;
  id: number;
  name: string;
  email: string;
}

export interface ClassFixture {
  classId: number;
  teacher: Actor;
  students: Actor[];
}

/** The error body of a failed request. */
export function apiError(res: TestResponse<unknown>): ApiError & { fields: Record<string, string> } {
  const body = res.body as ApiError;
  return { ...body, fields: body.fields ?? {} };
}

export function expectOk<T>(res: TestResponse<T>, label: string): T {
  assert.ok(res.status >= 200 && res.status < 300, `${label}: HTTP ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

async function actor(srv: TestServer, role: 'teacher' | 'student', name: string): Promise<Actor> {
  const auth: AuthResponse = await srv.registerUser(role, name);
  return { token: auth.token, id: auth.user.id, name: auth.user.name, email: auth.user.email };
}

/** A teacher with a class and enrolled students (enrolled through the teacher's "add students"). */
export async function setupClass(
  srv: TestServer,
  studentNames: string[],
  className = 'Algebra I',
): Promise<ClassFixture> {
  const teacher = await actor(srv, 'teacher', 'Ms. Rivera');
  const cls = expectOk(
    await srv.request<ClassSummary>('POST', '/api/classes', { token: teacher.token, json: { name: className } }),
    'create class',
  );
  const students: Actor[] = [];
  for (const name of studentNames) students.push(await actor(srv, 'student', name));
  if (students.length) {
    expectOk(
      await srv.request('POST', `/api/classes/${cls.id}/students`, {
        token: teacher.token,
        json: { students: students.map((s) => ({ name: s.name, email: s.email })) },
      }),
      'add students',
    );
  }
  return { classId: cls.id, teacher, students };
}

export interface AssignmentOptions {
  title?: string;
  description?: string;
  dueAt?: string;
  points?: number | string;
  gradingMode?: string;
  gradingConfig?: Partial<GradingConfig> | string;
  key?: Buffer;
  keyName?: string;
  template?: Buffer;
}

export function assignmentForm(opts: AssignmentOptions): FormData {
  const form = new FormData();
  const set = (name: string, value: unknown) => {
    if (value !== undefined) form.append(name, typeof value === 'string' ? value : JSON.stringify(value));
  };
  set('title', opts.title);
  set('description', opts.description);
  set('dueAt', opts.dueAt);
  set('points', opts.points === undefined ? undefined : String(opts.points));
  set('gradingMode', opts.gradingMode);
  set('gradingConfig', opts.gradingConfig);
  if (opts.key) form.append('keyFile', fileBlob(opts.key), opts.keyName ?? 'key.xlsx');
  if (opts.template) form.append('templateFile', fileBlob(opts.template), 'starter.xlsx');
  return form;
}

export function createAssignmentRequest(srv: TestServer, fx: ClassFixture, opts: AssignmentOptions) {
  const form = assignmentForm({
    title: 'Sales totals',
    dueAt: inDays(7),
    points: 100,
    gradingMode: 'auto',
    gradingConfig: FORMULAS_CONFIG,
    ...opts,
  });
  return srv.request<AssignmentDetail>('POST', `/api/classes/${fx.classId}/assignments`, {
    token: fx.teacher.token,
    form,
  });
}

/** Creates an autograded assignment with KEY (overridable) and returns it. */
export async function createAssignment(srv: TestServer, fx: ClassFixture, opts: AssignmentOptions = {}) {
  return expectOk(await createAssignmentRequest(srv, fx, { key: KEY, ...opts }), 'create assignment');
}

export function updateAssignment(srv: TestServer, token: string, assignmentId: number, opts: AssignmentOptions) {
  return srv.request<AssignmentDetail>('PATCH', `/api/assignments/${assignmentId}`, {
    token,
    form: assignmentForm(opts),
  });
}

export function submitRequest(
  srv: TestServer,
  token: string,
  assignmentId: number,
  file: Buffer,
  opts: { studentId?: number | string; fileName?: string } = {},
) {
  const form = new FormData();
  form.append('file', fileBlob(file), opts.fileName ?? 'work.xlsx');
  if (opts.studentId !== undefined) form.append('studentId', String(opts.studentId));
  return srv.request<SubmissionDetail>('POST', `/api/assignments/${assignmentId}/submissions`, { token, form });
}

export async function submit(srv: TestServer, token: string, assignmentId: number, file: Buffer) {
  return expectOk(await submitRequest(srv, token, assignmentId, file), 'submit');
}

/** Files currently in the upload directory (temp uploads and stored files). */
export function uploadedFileNames(srv: TestServer): string[] {
  const dir = path.join(srv.dataDir, 'uploads');
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

/** Polls until `check` passes (temp uploads are removed asynchronously). */
export async function eventually(check: () => void, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      check();
      return;
    } catch (err) {
      if (Date.now() - start > timeoutMs) throw err;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
