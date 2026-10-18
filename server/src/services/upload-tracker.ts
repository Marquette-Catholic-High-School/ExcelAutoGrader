import type { Request, RequestHandler, Response } from 'express';
import { discardUpload } from '../uploads.js';

/**
 * Tracks the multer temp files of one request. Files are stored by multer directly under data/uploads, so a
 * file that is not explicitly kept (recorded in the `files` table) must be removed when the request ends.
 */
export class UploadTracker {
  private readonly kept = new Set<Express.Multer.File>();

  constructor(private readonly req: Request) {}

  /** The uploaded file for a field (works with upload.single and upload.fields). */
  file(field: string): Express.Multer.File | undefined {
    const { file, files } = this.req;
    if (file?.fieldname === field) return file;
    if (Array.isArray(files)) return files.find((f) => f.fieldname === field);
    return files?.[field]?.[0];
  }

  all(): Express.Multer.File[] {
    const { file, files } = this.req;
    const list: Express.Multer.File[] = file ? [file] : [];
    if (Array.isArray(files)) list.push(...files);
    else if (files) for (const group of Object.values(files)) list.push(...group);
    return list;
  }

  /** Marks files as stored for good. Call only after the database transaction that references them committed. */
  keep(...files: (Express.Multer.File | undefined)[]): void {
    for (const file of files) if (file) this.kept.add(file);
  }

  discardUnkept(): void {
    for (const file of this.all()) if (!this.kept.has(file)) discardUpload(file);
  }
}

export type UploadHandler = (req: Request, res: Response, uploads: UploadTracker) => void;

/**
 * Wraps a (synchronous) handler that runs after a multer middleware: whatever happens — success, validation
 * error or crash — every uploaded temp file that the handler did not keep is deleted.
 */
export function withUploads(handler: UploadHandler): RequestHandler {
  return (req, res) => {
    const uploads = new UploadTracker(req);
    try {
      handler(req, res, uploads);
    } finally {
      uploads.discardUnkept();
    }
  };
}
