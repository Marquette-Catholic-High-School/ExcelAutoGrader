import type { ErrorRequestHandler } from 'express';
import multer from 'multer';
import type { ApiError } from '../../shared/types.js';

/** Throw from any route handler; the error middleware turns it into `{ error, code?, fields? }` JSON (ApiError). */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public fields?: Record<string, string>,
    /** Machine-readable reason for clients that react to a specific error (ApiError.code). */
    public code?: ApiError['code'],
  ) {
    super(message);
  }
}

export const badRequest = (message: string, fields?: Record<string, string>) => new HttpError(400, message, fields);
export const forbidden = (message = 'You do not have access to this resource.') => new HttpError(403, message);
export const notFound = (message = 'Not found.') => new HttpError(404, message);

/** Parses a positive integer route param or throws 400. */
export function intParam(value: unknown, name = 'id'): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`Invalid ${name}.`);
  return n;
}

/** Busboy's messages for an upload that was cut short or is not valid multipart (a client fault). */
const BROKEN_UPLOAD = /^(Multipart:|Unexpected end of form|Malformed part header|Malformed content type)/;

/**
 * Message for a 4xx error raised by middleware (body-parser, send/res.download, ...): their own messages are
 * technical ("unsupported charset \"X\""), so each status gets a plain sentence instead.
 */
function clientErrorMessage(err: { type?: unknown; code?: unknown; name?: unknown }, status: number): string {
  if (err.type === 'entity.too.large' || status === 413) return 'The request is too large.';
  if (err.type === 'entity.parse.failed') return 'Malformed JSON body.';
  if (status === 404) {
    // send() reports a stored file that vanished between our existence check and the read this way.
    const fromSend = err.code === 'ENOENT' || err.code === 'ENOTDIR' || err.name === 'NotFoundError';
    return fromSend ? 'File is missing from storage.' : 'Not found.';
  }
  if (status === 415) return 'Unsupported request encoding.';
  return 'The request could not be processed.';
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  // Mid-stream failures (e.g. a download that broke off) cannot get a JSON body; Express closes the connection.
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err instanceof HttpError) {
    const body: ApiError = {
      error: err.message,
      ...(err.code ? { code: err.code } : {}),
      ...(err.fields ? { fields: err.fields } : {}),
    };
    res.status(err.status).json(body);
    return;
  }
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (max 25 MB).' : err.message;
    res.status(400).json({ error: message });
    return;
  }
  // Client faults reported by middleware: body too large (413), malformed JSON or Content-Encoding (400),
  // unsupported charset (415), file vanished during a download (404), ... keep their status; no stack is logged.
  const status: unknown = err?.status ?? err?.statusCode;
  if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status < 500) {
    res.status(status).json({ error: clientErrorMessage(err, status) });
    return;
  }
  if (typeof err?.message === 'string' && BROKEN_UPLOAD.test(err.message)) {
    res.status(400).json({ error: 'The upload was incomplete or malformed. Please try again.' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
};
