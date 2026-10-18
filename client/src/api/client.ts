import type { ApiError } from '@shared/types';

const TOKEN_KEY = 'excel-autograder-token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage unavailable (private mode) — the session just won't persist
  }
}

/** Error thrown for any non-2xx API response. `message` is the server's user-facing `error` text. */
export class ApiRequestError extends Error {
  constructor(
    public status: number,
    message: string,
    public fields?: Record<string, string>,
  ) {
    super(message);
  }
}

/** Called on any 401 so the auth context can drop the user and redirect to /login. */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

async function toError(res: Response): Promise<ApiRequestError> {
  let body: Partial<ApiError> = {};
  try {
    body = await res.json();
  } catch {
    // non-JSON error (proxy down etc.)
  }
  const fallback = res.status === 0 || res.status >= 500 ? 'The server is not responding. Is it running?' : res.statusText;
  return new ApiRequestError(res.status, body.error || fallback || 'Request failed', body.fields);
}

async function request(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) {
    payload = body; // browser sets the multipart boundary
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: payload });
  } catch {
    throw new ApiRequestError(0, 'Could not reach the server. Is it running?');
  }
  if (res.status === 401 && token) onUnauthorized?.();
  if (!res.ok) throw await toError(res);
  return res;
}

async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await request(method, path, body);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => json<T>('GET', path),
  post: <T>(path: string, body?: unknown) => json<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => json<T>('PATCH', path, body),
  delete: <T>(path: string) => json<T>('DELETE', path),
  /** multipart upload; method defaults to POST */
  upload: <T>(path: string, form: FormData, method: 'POST' | 'PATCH' = 'POST') => json<T>(method, path, form),

  /** Fetches an authenticated file and triggers a browser download with the server-provided filename. */
  async download(path: string, fallbackName = 'download.xlsx'): Promise<void> {
    const res = await request('GET', path);
    const blob = await res.blob();
    const name = filenameFromDisposition(res.headers.get('Content-Disposition')) ?? fallbackName;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },
};

/**
 * The file name from a Content-Disposition header: the UTF-8 `filename*` form when present, else the quoted
 * `filename="…"` form (which may contain ';' and backslash-escaped quotes), else a bare `filename=token`.
 */
export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      // fall through
    }
  }
  const quoted = /filename="((?:[^"\\]|\\.)*)"/i.exec(header);
  if (quoted) return quoted[1].replace(/\\(.)/g, '$1');
  const token = /filename=([^;\s]+)/i.exec(header);
  return token ? token[1] : null;
}
