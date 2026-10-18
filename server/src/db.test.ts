import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';

// db.ts opens DATA_DIR/app.db at import time, so the old-format database is written before importing it.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'excel-autograder-db-test-'));
process.env.DATA_DIR = dataDir;

/** The users table as the first release created it (no created_by_teacher_id). */
function writeOldDatabase(): void {
  const old = new DatabaseSync(path.join(dataDir, 'app.db'));
  old.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('teacher', 'student')),
      must_change_password INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    INSERT INTO users (email, name, password_hash, role, must_change_password, created_at)
    VALUES ('finn@old.test', 'Finn Murphy', 'scrypt:00:00', 'student', 1, '2026-01-01T00:00:00.000Z');
  `);
  old.close();
}

describe('database migrations', () => {
  test('adds users.created_by_teacher_id to an existing database, keeping its rows', async () => {
    writeOldDatabase();
    const dbm = await import('./db.js');
    const columns = dbm.all<{ name: string; notnull: number; dflt_value: unknown }>('PRAGMA table_info(users)');
    const column = columns.find((c) => c.name === 'created_by_teacher_id');
    assert.ok(column, 'column added');
    assert.equal(column.notnull, 0);
    assert.equal(column.dflt_value, null);

    const foreignKeys = dbm.all<{ table: string; from: string; on_delete: string }>('PRAGMA foreign_key_list(users)');
    assert.deepEqual(
      foreignKeys.map((fk) => [fk.from, fk.table, fk.on_delete]),
      [['created_by_teacher_id', 'users', 'SET NULL']],
    );

    const finn = dbm.get<{ name: string; created_by_teacher_id: number | null }>(
      'SELECT name, created_by_teacher_id FROM users WHERE email = ?',
      'finn@old.test',
    );
    assert.deepEqual({ ...finn }, { name: 'Finn Murphy', created_by_teacher_id: null });
  });
});
