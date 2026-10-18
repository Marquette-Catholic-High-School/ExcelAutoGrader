/**
 * Helpers for HTTP-level tests with node:test.
 *
 *   import { startTestServer } from '../test-utils.js';
 *   const srv = await startTestServer();          // fresh temp DATA_DIR + app on a random port
 *   const teacher = await srv.registerUser('teacher');
 *   const res = await srv.request('POST', '/api/classes', { token: teacher.token, json: { name: 'Algebra' } });
 *   await srv.close();
 *
 * Every test FILE runs in its own process (node --test), and db.ts reads DATA_DIR at import time, so
 * startTestServer() must be called before anything imports db.ts (import app modules dynamically, or only
 * through this helper).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { AuthResponse, Role } from '../../shared/types.js';

export interface TestResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export interface RequestOptions {
  token?: string;
  json?: unknown;
  /** multipart form; use `fileBlob()` for files */
  form?: FormData;
}

export interface TestServer {
  baseUrl: string;
  dataDir: string;
  request<T = any>(method: string, urlPath: string, opts?: RequestOptions): Promise<TestResponse<T>>;
  /** Registers a fresh user with a unique email; password is "password123". */
  registerUser(role: Role, name?: string): Promise<AuthResponse>;
  close(): Promise<void>;
}

let counter = 0;

export async function startTestServer(): Promise<TestServer> {
  if (!process.env.DATA_DIR) {
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'excel-autograder-test-'));
  }
  const dataDir = process.env.DATA_DIR;
  const { createApp } = await import('./app.js');
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  async function request<T = any>(method: string, urlPath: string, opts: RequestOptions = {}): Promise<TestResponse<T>> {
    const headers: Record<string, string> = {};
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    let body: BodyInit | undefined;
    if (opts.form) body = opts.form;
    else if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.json);
    }
    const res = await fetch(baseUrl + urlPath, { method, headers, body });
    const type = res.headers.get('content-type') ?? '';
    const parsed = type.includes('application/json') ? await res.json() : await res.text();
    return { status: res.status, body: parsed as T, headers: res.headers };
  }

  async function registerUser(role: Role, name?: string): Promise<AuthResponse> {
    counter += 1;
    const res = await request<AuthResponse>('POST', '/api/auth/register', {
      json: {
        name: name ?? `${role} ${counter}`,
        email: `${role}${counter}-${process.pid}@example.test`,
        password: 'password123',
        role,
      },
    });
    if (res.status >= 300) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  }

  return {
    baseUrl,
    dataDir,
    request,
    registerUser,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Wraps bytes (e.g. from XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })) as a Blob for FormData. */
export function fileBlob(bytes: Uint8Array | Buffer): Blob {
  return new Blob([new Uint8Array(bytes)]);
}
