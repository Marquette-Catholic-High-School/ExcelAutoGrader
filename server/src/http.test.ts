import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import type { Request, Response } from 'express';
import {
  KEY,
  PERFECT,
  TEMPLATE,
  createAssignment,
  setupClass,
  submit,
  type ClassFixture,
} from './services/test-fixtures.js';
import { startTestServer, type TestServer } from './test-utils.js';

// Everything in this file runs with DATA_DIR inside a dot-directory (like ~/.excel-autograder): send() refuses
// dotfile path segments, so downloads must not hand it the absolute path.
process.env.DATA_DIR = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'excel-autograder-http-test-')), '.dotdata');

let srv: TestServer;
let fx: ClassFixture;
let http: typeof import('./http.js');
let db: typeof import('./db.js');

before(async () => {
  srv = await startTestServer();
  http = await import('./http.js');
  db = await import('./db.js');
  fx = await setupClass(srv, ['Ana Lopez']);
});

after(() => srv.close());

/** console.error calls made while a test runs (the error handler must not log client faults). */
let logged: unknown[][] = [];
const originalConsoleError = console.error;
beforeEach(() => {
  logged = [];
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
});
afterEach(() => {
  console.error = originalConsoleError;
});

/** Raw request, for bodies and headers test-utils' request() cannot produce. */
async function raw(method: string, urlPath: string, headers: Record<string, string>, body?: BodyInit) {
  const res = await fetch(srv.baseUrl + urlPath, {
    method,
    headers: { Authorization: `Bearer ${fx.teacher.token}`, ...headers },
    body,
  });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as { error: string } };
}

describe('downloads with DATA_DIR in a dot-directory', () => {
  test('the data directory really is a dot-directory', () => {
    assert.ok(srv.dataDir.split(path.sep).some((part) => part.startsWith('.') && part.length > 1), srv.dataDir);
  });

  test('template, key and submission downloads return the stored bytes', async () => {
    const assignment = await createAssignment(srv, fx, { title: 'Dot downloads', template: TEMPLATE });
    const sub = await submit(srv, fx.students[0].token, assignment.id, PERFECT);
    const cases: [string, Buffer, string][] = [
      [`/api/assignments/${assignment.id}/template/download`, TEMPLATE, 'starter.xlsx'],
      [`/api/assignments/${assignment.id}/key/download`, KEY, 'key.xlsx'],
      [`/api/submissions/${sub.id}/download`, PERFECT, 'work.xlsx'],
    ];
    for (const [url, bytes, name] of cases) {
      const res = await fetch(srv.baseUrl + url, { headers: { Authorization: `Bearer ${fx.teacher.token}` } });
      assert.equal(res.status, 200, url);
      assert.match(res.headers.get('content-disposition') ?? '', new RegExp(`attachment.*${name.replace('.', '\\.')}`));
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes, url);
    }
    assert.deepEqual(logged, []);
  });

  test('a stored file missing on disk is a 404, not a 500', async () => {
    const assignment = await createAssignment(srv, fx, { title: 'Vanished key' });
    const row = db.get<{ stored_name: string }>(
      'SELECT f.stored_name FROM files f JOIN assignments a ON a.key_file_id = f.id WHERE a.id = ?',
      assignment.id,
    )!;
    fs.rmSync(path.join(db.UPLOAD_DIR, row.stored_name));
    const res = await srv.request('GET', `/api/assignments/${assignment.id}/key/download`, { token: fx.teacher.token });
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'File is missing from storage.' });
  });
});

describe('client faults caught by middleware are 4xx', () => {
  const studentsUrl = () => `/api/classes/${fx.classId}/students`;
  const submissionsUrl = async () => `/api/assignments/${(await createAssignment(srv, fx)).id}/submissions`;

  test('a JSON body over 1 MB is 413', async () => {
    const body = JSON.stringify({
      students: [{ name: 'Big Request', email: 'big@request.test' }],
      padding: 'x'.repeat(1.2 * 1024 * 1024),
    });
    const res = await raw('POST', studentsUrl(), { 'Content-Type': 'application/json' }, body);
    assert.equal(res.status, 413);
    assert.deepEqual(res.body, { error: 'The request is too large.' });
  });

  test('malformed JSON is 400', async () => {
    const res = await raw('POST', studentsUrl(), { 'Content-Type': 'application/json' }, '{"students": [');
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'Malformed JSON body.' });
  });

  test('a body that does not match its Content-Encoding is 400', async () => {
    const res = await raw(
      'POST',
      studentsUrl(),
      { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
      JSON.stringify({ students: [] }),
    );
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'The request could not be processed.' });
  });

  test('an unsupported charset or content encoding is 415', async () => {
    const charset = await raw('POST', studentsUrl(), { 'Content-Type': 'application/json; charset=iso-8859-2' }, '{}');
    assert.equal(charset.status, 415);
    assert.deepEqual(charset.body, { error: 'Unsupported request encoding.' });
    const encoding = await raw(
      'POST',
      studentsUrl(),
      { 'Content-Type': 'application/json', 'Content-Encoding': 'compress' },
      '{}',
    );
    assert.equal(encoding.status, 415);
  });

  test('a multipart upload without a boundary is 400', async () => {
    const res = await raw('POST', await submissionsUrl(), { 'Content-Type': 'multipart/form-data' }, 'file=1');
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'The upload was incomplete or malformed. Please try again.' });
  });

  test('a multipart upload that is cut off is 400', async () => {
    const body =
      '--XYZ\r\nContent-Disposition: form-data; name="file"; filename="work.xlsx"\r\n' +
      'Content-Type: application/octet-stream\r\n\r\nPK\u0003\u0004 not finished';
    const res = await raw('POST', await submissionsUrl(), { 'Content-Type': 'multipart/form-data; boundary=XYZ' }, body);
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'The upload was incomplete or malformed. Please try again.' });
  });

  test('none of these log a stack trace', async () => {
    await raw('POST', studentsUrl(), { 'Content-Type': 'application/json' }, '{');
    await raw('POST', await submissionsUrl(), { 'Content-Type': 'multipart/form-data' }, 'x');
    assert.deepEqual(logged, []);
  });
});

describe('errorHandler', () => {
  /** Calls the handler directly with a minimal response double. */
  function handle(err: unknown, headersSent = false) {
    const out: { status?: number; body?: unknown; forwarded?: unknown } = {};
    const res = {
      headersSent,
      status(code: number) {
        out.status = code;
        return this;
      },
      json(body: unknown) {
        out.body = body;
        return this;
      },
    } as unknown as Response;
    http.errorHandler(err, {} as Request, res, (e?: unknown) => {
      out.forwarded = e;
    });
    return out;
  }

  test('keeps any numeric 4xx status or statusCode', () => {
    assert.deepEqual(handle(Object.assign(new Error('nope'), { statusCode: 422 })), {
      status: 422,
      body: { error: 'The request could not be processed.' },
    });
    assert.deepEqual(handle(Object.assign(new Error('gone'), { status: 404, name: 'NotFoundError' })), {
      status: 404,
      body: { error: 'File is missing from storage.' },
    });
    assert.deepEqual(handle(Object.assign(new Error('x'), { status: 404 })), {
      status: 404,
      body: { error: 'Not found.' },
    });
    assert.deepEqual(logged, []);
  });

  test('HttpErrors keep their message and fields', () => {
    assert.deepEqual(handle(http.badRequest('Bad.', { title: 'Required.' })), {
      status: 400,
      body: { error: 'Bad.', fields: { title: 'Required.' } },
    });
  });

  test('HttpErrors with a code send it (ApiError.code)', () => {
    assert.deepEqual(handle(new http.HttpError(401, 'Sign up first.', { email: 'Sign up first.' }, 'needs_signup')), {
      status: 401,
      body: { error: 'Sign up first.', code: 'needs_signup', fields: { email: 'Sign up first.' } },
    });
    assert.deepEqual(handle(new http.HttpError(401, 'No.', undefined, 'needs_signup')), {
      status: 401,
      body: { error: 'No.', code: 'needs_signup' },
    });
  });

  test('unexpected errors (and 5xx statuses) are 500 and logged', () => {
    for (const err of [new Error('boom'), Object.assign(new Error('upstream'), { status: 502 }), 'a string']) {
      assert.deepEqual(handle(err), { status: 500, body: { error: 'Something went wrong on the server.' } });
    }
    assert.equal(logged.length, 3);
  });

  test('hands errors after the response started to Express', () => {
    const err = new Error('stream broke');
    assert.deepEqual(handle(err, true), { forwarded: err });
  });
});
