import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';

// db.ts opens DATA_DIR/app.db at import time, so the old-format database is written before importing it.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'excel-autograder-email-migration-'));
process.env.DATA_DIR = dataDir;

/** Users and classes as the release before email notifications created them. */
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
      created_at TEXT NOT NULL,
      created_by_teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      pending INTEGER NOT NULL DEFAULT 0,
      placeholder_name INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      join_code TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
    INSERT INTO users (email, name, password_hash, role, created_at)
    VALUES ('rivera@old.test', 'Ms. Rivera', 'scrypt:00:00', 'teacher', '2026-01-01T00:00:00.000Z');
    INSERT INTO classes (teacher_id, name, join_code, created_at)
    VALUES (1, 'Algebra I', 'ABCDEF', '2026-01-02T00:00:00.000Z');
  `);
  old.close();
}

describe('email migration', () => {
  test('adds the email columns and table to an existing database', async () => {
    writeOldDatabase();
    const started = new Date().toISOString();
    const dbm = await import('../../db.js');

    const columns = (table: string) => dbm.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name);
    for (const name of ['email_opt_out', 'notification_settings', 'daily_report_last_date', 'daily_report_last_at']) {
      assert.ok(columns('users').includes(name), `users.${name}`);
    }
    assert.ok(columns('classes').includes('notification_settings'));
    assert.ok(columns('classes').includes('reminders_since'));
    assert.ok(columns('email_outbox').includes('next_attempt_at'));

    const teacher = dbm.get<{ email_opt_out: number; notification_settings: string | null }>(
      'SELECT email_opt_out, notification_settings FROM users WHERE id = 1',
    )!;
    assert.deepEqual({ ...teacher }, { email_opt_out: 0, notification_settings: null });

    // An existing class only gets reminders for assignments due after the update, not since it was created.
    const cls = dbm.get<{ reminders_since: string; notification_settings: string | null }>(
      'SELECT reminders_since, notification_settings FROM classes WHERE id = 1',
    )!;
    assert.ok(cls.reminders_since >= started, `${cls.reminders_since} >= ${started}`);
    assert.equal(cls.notification_settings, null);
  });
});
