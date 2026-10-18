import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Response } from 'express';
import multer from 'multer';
import type { FileInfo } from '../../shared/types.js';
import { UPLOAD_DIR, get, nowIso, run, type FileRow } from './db.js';
import { badRequest, notFound } from './http.js';

export const ALLOWED_EXTENSIONS = ['.xlsx', '.xlsm', '.xls', '.csv', '.ods'];
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Multer instance that stores spreadsheet uploads in data/uploads under random names.
 * Use e.g. `upload.single('file')` or `upload.fields([{ name: 'keyFile', maxCount: 1 }, ...])`.
 * Non-spreadsheet files are rejected with a 400.
 */
export const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 3 },
  fileFilter: (_req, file, cb) => {
    // Browsers send multipart filenames as latin1; recover UTF-8 names like "Résumé.xlsx".
    file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      cb(badRequest(`"${file.originalname}" is not a spreadsheet. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`));
      return;
    }
    cb(null, true);
  },
});

/** Records an uploaded multer file in the `files` table and returns the new row. */
export function saveFileRecord(file: Express.Multer.File, uploadedBy: number): FileRow {
  const { lastInsertRowid } = run(
    'INSERT INTO files (original_name, stored_name, size, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?)',
    file.originalname,
    file.filename,
    file.size,
    uploadedBy,
    nowIso(),
  );
  return get<FileRow>('SELECT * FROM files WHERE id = ?', lastInsertRowid)!;
}

export function getFile(fileId: number | null | undefined): FileRow | null {
  if (!fileId) return null;
  return get<FileRow>('SELECT * FROM files WHERE id = ?', fileId) ?? null;
}

export function filePath(file: FileRow): string {
  return path.join(UPLOAD_DIR, file.stored_name);
}

export function toFileInfo(file: FileRow | null): FileInfo | null {
  return file ? { name: file.original_name, size: file.size } : null;
}

/** Deletes the DB row and the file on disk (ignores missing files). */
export function deleteFile(fileId: number | null | undefined): void {
  const file = getFile(fileId);
  if (!file) return;
  run('DELETE FROM files WHERE id = ?', file.id);
  fs.rm(filePath(file), { force: true }, () => {});
}

/** Removes a multer temp upload that will not be kept (e.g. validation failed). */
export function discardUpload(file: Express.Multer.File | undefined): void {
  if (file) fs.rm(file.path, { force: true }, () => {});
}

/**
 * Streams a stored file as an attachment with its original name. The path is given relative to UPLOAD_DIR as
 * `root`: send() refuses (404) any path segment starting with a dot, and with an absolute path that check would
 * also cover DATA_DIR itself, breaking every download when it lives in e.g. ~/.excel-autograder. Stored names
 * are random UUIDs, never dotfiles.
 */
export function sendFile(res: Response, file: FileRow | null): void {
  if (!file) throw notFound('File not found.');
  if (!fs.existsSync(filePath(file))) throw notFound('File is missing from storage.');
  res.download(file.stored_name, file.original_name, { root: UPLOAD_DIR });
}
