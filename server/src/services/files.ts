import fs from 'node:fs';
import { all, run, type FileRow } from '../db.js';
import { filePath } from '../uploads.js';
import { idList } from './common.js';

/**
 * Every stored file that belongs to these assignments: answer keys, starter templates and all submission
 * files. Collect them BEFORE deleting the assignments, then pass them to purgeFiles.
 */
export function assignmentFiles(assignmentIds: readonly number[]): FileRow[] {
  if (assignmentIds.length === 0) return [];
  const ids = idList(assignmentIds);
  return all<FileRow>(
    `SELECT * FROM files WHERE id IN (
       SELECT key_file_id FROM assignments WHERE id IN (SELECT value FROM json_each(?))
       UNION SELECT template_file_id FROM assignments WHERE id IN (SELECT value FROM json_each(?))
       UNION SELECT file_id FROM submissions WHERE assignment_id IN (SELECT value FROM json_each(?))
     )`,
    ids,
    ids,
    ids,
  );
}

/**
 * Deletes file rows and their bytes on disk. Call after the rows that referenced them are gone (submissions
 * reference files without ON DELETE, so their rows must be deleted first).
 */
export function purgeFiles(files: readonly FileRow[]): void {
  if (files.length === 0) return;
  run('DELETE FROM files WHERE id IN (SELECT value FROM json_each(?))', idList(files.map((f) => f.id)));
  for (const file of files) {
    try {
      fs.rmSync(filePath(file), { force: true });
    } catch (err) {
      // The rows are gone already; a leftover file on disk must not fail the request.
      console.warn(`Could not remove stored file ${file.stored_name}:`, err);
    }
  }
}
