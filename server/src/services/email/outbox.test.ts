import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, before, describe, test } from 'node:test';
import { captureConsole, TEST_TOKEN, useMemoryEmail, type OutboxRow } from './testing.js';

// db.ts opens DATA_DIR/app.db when first imported.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'excel-autograder-outbox-test-'));
useMemoryEmail();

let db: typeof import('../../db.js');
let outbox: typeof import('./outbox.js');
let mailer: typeof import('./mailer.js');

before(async () => {
  db = await import('../../db.js');
  outbox = await import('./outbox.js');
  mailer = await import('./mailer.js');
});

afterEach(() => {
  mailer.memoryMailbox.reset();
  db.run('DELETE FROM email_outbox');
  db.run('DELETE FROM email_quota');
  db.run('DELETE FROM email_recipients');
  process.env.CLOUDFLARE_API_TOKEN = TEST_TOKEN;
  delete process.env.EMAIL_DAILY_LIMIT;
});

const T0 = new Date('2026-11-12T15:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const MINUTE = 60_000;

/** A test email: the worker sends those without checking an account or class (see scheduler.test.ts for those). */
function queue(address = 'ana@school.test', subject = 'Hello') {
  const id = outbox.enqueue(
    { kind: 'test', to: { name: 'Ana Lopez', address }, subject, html: '<p>Hi</p>', text: 'Hi' },
    T0,
  );
  assert.ok(id, 'queued');
  return id;
}

const CONTENT = { subject: 'Subject', html: '<p>Hi</p>', text: 'Hi' };

const row = (id: number) => db.get<OutboxRow>('SELECT * FROM email_outbox WHERE id = ?', id)!;

/** One worker run at a fixed time, without pauses and without log noise. */
async function work(now: Date, limit = 5) {
  const { result } = await captureConsole(() => outbox.processOutboxOnce({ now: () => now, gapMs: 0, limit }));
  return result;
}

describe('outbox worker', () => {
  test('sends queued messages and marks them sent', async () => {
    const id = queue();
    assert.equal(row(id).state, 'queued');
    assert.equal(row(id).attempts, 0);

    const result = await work(T0);
    assert.deepEqual(result, { sent: 1, retried: 0, failed: 0, dropped: 0 });
    const sent = row(id);
    assert.equal(sent.state, 'sent');
    assert.equal(sent.attempts, 1);
    assert.equal(sent.sent_at, T0.toISOString());
    assert.equal(sent.last_error, null);
    assert.equal(mailer.memoryMailbox.messages.length, 1);
    assert.equal(mailer.memoryMailbox.messages[0].from, `"Podner's Excel" <noreply@mchstech.org>`);

    assert.deepEqual(await work(at(MINUTE)), { sent: 0, retried: 0, failed: 0, dropped: 0 }, 'nothing sent twice');
  });

  test('temporary failures are retried after 1 min, 5 min, 30 min and 2 h, then marked failed', async () => {
    const id = queue();
    const failures = [
      { responseCode: 451, response: '451 4.3.0 Temporary server error', command: 'DATA' },
      { code: 'ECONNECTION', message: 'Connection closed unexpectedly' },
      { code: 'ETIMEDOUT', message: 'Connection timeout' },
      { responseCode: 421, response: '421 4.7.0 Try again later' },
      { code: 'ESOCKET', message: 'socket hang up' },
    ];
    mailer.memoryMailbox.failNext(...failures);
    const delays = [MINUTE, 5 * MINUTE, 30 * MINUTE, 120 * MINUTE];

    let now = T0;
    for (const [i, waitMs] of delays.entries()) {
      assert.equal((await work(now)).retried, 1, `attempt ${i + 1} is retried`);
      const r = row(id);
      assert.equal(r.state, 'queued');
      assert.equal(r.attempts, i + 1);
      assert.equal(r.next_attempt_at, new Date(now.getTime() + waitMs).toISOString());
      assert.ok(r.last_error, 'error stored');

      assert.equal((await work(new Date(now.getTime() + waitMs - 1000))).retried, 0, 'not before the backoff');
      now = new Date(now.getTime() + waitMs);
    }
    assert.equal((await work(now)).failed, 1, 'fifth failure is final');
    const r = row(id);
    assert.equal(r.state, 'failed');
    assert.equal(r.attempts, 5);
    assert.equal(r.last_error, 'socket hang up');
    assert.equal(mailer.memoryMailbox.messages.length, 0);
  });

  test('a retry that works is marked sent', async () => {
    const id = queue();
    mailer.memoryMailbox.failNext({ responseCode: 452, response: '452 4.5.3 Too many recipients' });
    await work(T0);
    await work(at(MINUTE));
    const r = row(id);
    assert.equal(r.state, 'sent');
    assert.equal(r.attempts, 2);
    assert.equal(r.last_error, null);
  });

  test('permanent failures (5xx) fail at once with the server message', async () => {
    const id = queue();
    mailer.memoryMailbox.failNext({
      responseCode: 550,
      response: '550 5.7.1 Sender domain not onboarded',
      command: 'MAIL FROM',
      permanent: true,
    });
    assert.equal((await work(T0)).failed, 1);
    const r = row(id);
    assert.equal(r.state, 'failed');
    assert.equal(r.attempts, 1);
    assert.equal(r.last_error, '550 5.7.1 Sender domain not onboarded');
  });

  test('an authentication failure is permanent and the token never reaches the log or the database', async () => {
    const id = queue();
    const base64 = Buffer.from(TEST_TOKEN).toString('base64');
    mailer.memoryMailbox.failNext({
      code: 'EAUTH',
      responseCode: 535,
      response: `535 5.7.8 Authentication failed for ${TEST_TOKEN} (${base64})`,
      command: 'AUTH PLAIN',
    });
    const { result, output } = await captureConsole(() => outbox.processOutboxOnce({ now: () => T0, gapMs: 0 }));
    assert.equal(result.failed, 1);
    const r = row(id);
    assert.equal(r.state, 'failed');
    assert.ok(r.last_error?.startsWith('535 5.7.8 Authentication failed'));
    assert.ok(!r.last_error?.includes(TEST_TOKEN) && !r.last_error?.includes(base64), r.last_error ?? '');
    assert.ok(output.includes('[redacted]'), 'the failure is logged');
    assert.ok(!output.includes(TEST_TOKEN) && !output.includes(base64), output);
  });

  test('sends at most `limit` messages per run, oldest first, pausing between them', async () => {
    const ids = [queue('a@school.test', 'A'), queue('b@school.test', 'B'), queue('c@school.test', 'C')];
    const pauses: number[] = [];
    const run = () =>
      outbox.processOutboxOnce({ now: () => T0, limit: 2, gapMs: 1000, pause: async (ms) => void pauses.push(ms) });
    assert.equal((await run()).sent, 2);
    assert.deepEqual(pauses, [1000], 'one pause between two sends');
    assert.deepEqual(
      mailer.memoryMailbox.messages.map((m) => m.subject),
      ['A', 'B'],
    );
    assert.equal(row(ids[2]).state, 'queued');
    assert.equal((await run()).sent, 1);
    assert.equal(row(ids[2]).state, 'sent');
  });

  test('a message whose send never finished is retried later, not twice at once', async () => {
    const id = queue();
    // As if a worker claimed it and the server stopped before the send finished.
    db.run('UPDATE email_outbox SET attempts = 1, next_attempt_at = ? WHERE id = ?', at(15 * MINUTE).toISOString(), id);
    assert.equal((await work(at(MINUTE))).sent, 0);
    assert.equal((await work(at(15 * MINUTE))).sent, 1);
    assert.equal(row(id).attempts, 2);
  });

  test('nothing is queued while email is not configured, and leftovers are not sent later', async () => {
    const leftover = queue();
    delete process.env.CLOUDFLARE_API_TOKEN;
    const id = outbox.enqueue({ kind: 'test', to: { name: 'T', address: 't@school.test' }, ...CONTENT });
    assert.equal(id, null);
    await work(T0);
    assert.equal(row(leftover).state, 'failed');
    assert.match(row(leftover).last_error ?? '', /turned off/);
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM email_outbox')!.n, 1);
  });

  test('one address gets at most 50 emails a day', async () => {
    const email = { kind: 'receipt' as const, to: { name: 'B', address: 'busy@school.test' }, ...CONTENT };
    for (let i = 0; i < outbox.MAX_PER_RECIPIENT_PER_DAY; i++) assert.ok(outbox.enqueue(email, T0));
    const { result, output } = await captureConsole(() => outbox.enqueue(email, T0));
    assert.equal(result, null);
    assert.match(output, /already got 50 emails/);
    assert.ok(outbox.enqueue(email, at(24 * 60 * MINUTE + 1)), 'accepted again a day later');
  });

  test('address variants count as one mailbox: +tags, case, and Gmail dots', async () => {
    const recipients = await import('./recipients.js');
    assert.equal(recipients.recipientKey('Victim+7@Gmail.com'), 'victim@gmail.com');
    assert.equal(recipients.recipientKey('v.i.c.t.i.m@googlemail.com'), 'victim@gmail.com');
    assert.equal(recipients.recipientKey('first.last+x@school.org'), 'first.last@school.org', 'dots matter elsewhere');
    const variant = (i: number) => ({
      kind: 'receipt' as const,
      to: { name: 'V', address: i % 2 ? `victim+${i}@gmail.com` : `vic.tim+${i}@GMAIL.com` },
      ...CONTENT,
    });
    for (let i = 0; i < outbox.MAX_PER_RECIPIENT_PER_DAY; i++) assert.ok(outbox.enqueue(variant(i), T0), `#${i}`);
    const { result } = await captureConsole(() => outbox.enqueue(variant(99), T0));
    assert.equal(result, null, 'the 51st email to the same mailbox is refused');
  });

  test('the whole server sends at most EMAIL_DAILY_LIMIT emails in 24 hours', async () => {
    process.env.EMAIL_DAILY_LIMIT = '3';
    for (const name of ['a', 'b', 'c']) assert.ok(queue(`${name}@school.test`));
    const { result, output } = await captureConsole(() =>
      outbox.enqueue({ kind: 'receipt', to: { name: 'D', address: 'd@school.test' }, ...CONTENT }, T0),
    );
    assert.equal(result, null);
    assert.match(output, /already sent 3 emails in the last 24 hours \(EMAIL_DAILY_LIMIT/);
    await assert.rejects(
      outbox.sendAndRecord({ kind: 'test', to: { name: 'T', address: 't@school.test' }, ...CONTENT }, () => T0),
      outbox.EmailLimitError,
      'on-demand sends count too',
    );
    db.run('DELETE FROM email_outbox');
    const { result: again } = await captureConsole(() =>
      outbox.enqueue({ kind: 'receipt', to: { name: 'D', address: 'd@school.test' }, ...CONTENT }, T0),
    );
    assert.equal(again, null, 'deleting log rows (e.g. with a class) does not reset the count');
  });

  test("a teacher's classes send at most 1000 emails a day, 300 of them to invited students", async () => {
    const teacher = db.run(
      `INSERT INTO users (email, name, password_hash, role, created_at)
       VALUES ('t@school.test', 'T', 'x', 'teacher', ?)`,
      T0.toISOString(),
    ).lastInsertRowid;
    const classId = db.run(
      "INSERT INTO classes (teacher_id, name, join_code, created_at) VALUES (?, 'C', 'QUOTA1', ?)",
      teacher,
      T0.toISOString(),
    ).lastInsertRowid;
    const insertQuota = db.db.prepare(
      'INSERT INTO email_quota (created_at, recipient_key, teacher_id, pending) VALUES (?, ?, ?, ?)',
    );
    const fill = (n: number, pending: number) => {
      for (let i = 0; i < n; i++) {
        insertQuota.run(T0.toISOString(), `fill${pending}-${i}@school.test`, teacher, pending);
      }
    };
    const email = (address: string, toPending: boolean) => ({
      kind: 'receipt' as const,
      to: { name: 'S', address },
      ...CONTENT,
      classId,
      toPending,
    });
    fill(outbox.MAX_PENDING_PER_TEACHER_PER_DAY, 1);
    const pending = await captureConsole(() => outbox.enqueue(email('invited@school.test', true), T0));
    assert.equal(pending.result, null);
    assert.match(pending.output, /already emailed 300 invited students/);
    assert.ok(outbox.enqueue(email('member@school.test', false), T0), 'students with an account still get theirs');
    fill(outbox.MAX_PER_TEACHER_PER_DAY - outbox.MAX_PENDING_PER_TEACHER_PER_DAY - 1, 0);
    const over = await captureConsole(() => outbox.enqueue(email('member2@school.test', false), T0));
    assert.equal(over.result, null);
    assert.match(over.output, /already sent 1000 emails/);
    db.run('DELETE FROM classes WHERE id = ?', classId);
    db.run('DELETE FROM users WHERE id = ?', teacher);
  });

  test('startWorker sends in the background and stopWorker waits for it', async () => {
    outbox.enqueue({ kind: 'test', to: { name: 'Ana', address: 'ana@school.test' }, ...CONTENT });
    outbox.startWorker(10, 0);
    const deadline = Date.now() + 3000;
    while (mailer.memoryMailbox.messages.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await outbox.stopWorker();
    assert.equal(mailer.memoryMailbox.messages.length, 1);
  });
});
