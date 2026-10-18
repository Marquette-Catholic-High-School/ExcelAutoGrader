import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { AuthResponse, User } from '../../../shared/types.js';
import { startTestServer, type TestServer } from '../test-utils.js';

let srv: TestServer;
let dbm: typeof import('../db.js');

before(async () => {
  srv = await startTestServer();
  dbm = await import('../db.js'); // after startTestServer(): db.ts reads DATA_DIR at import time
});

after(async () => {
  await srv.close();
});

/** Tests check the status first, so bodies are typed as "success or error" for convenient assertions. */
type Body<T> = T & { error: string; fields: Record<string, string> };

let seq = 0;
const uniqueEmail = (prefix = 'user') => `${prefix}.${++seq}-${process.pid}@auth.example.test`;

function register(json: Record<string, unknown>) {
  return srv.request<Body<AuthResponse>>('POST', '/api/auth/register', { json });
}

function login(email: string, password: string) {
  return srv.request<Body<AuthResponse>>('POST', '/api/auth/login', { json: { email, password } });
}

describe('POST /api/auth/register', () => {
  it('creates an account, normalizes the email and signs the user in', async () => {
    const email = uniqueEmail('Teacher');
    const res = await register({
      name: '  Grace Hopper ',
      email: `  ${email.toUpperCase()} `,
      password: 'password123',
      role: 'teacher',
    });
    assert.equal(res.status, 201);
    assert.match(res.body.token, /^[0-9a-f]{64}$/);
    const user = res.body.user;
    assert.equal(user.name, 'Grace Hopper');
    assert.equal(user.email, email.toLowerCase());
    assert.equal(user.role, 'teacher');
    assert.equal(user.mustChangePassword, false);
    assert.ok(!Number.isNaN(Date.parse(user.createdAt)));
    assert.equal('password_hash' in user, false);

    const me = await srv.request<{ user: User }>('GET', '/api/auth/me', { token: res.body.token });
    assert.equal(me.status, 200);
    assert.deepEqual(me.body.user, user);
  });

  it('reports every invalid field', async () => {
    const res = await register({ name: ' ', email: 'not-an-email', password: 'short', role: 'admin' });
    assert.equal(res.status, 400);
    assert.deepEqual(Object.keys(res.body.fields).sort(), ['email', 'name', 'password', 'role']);
    assert.equal(typeof res.body.error, 'string');
  });

  it('uses the field message as the error when a single field is invalid', async () => {
    const res = await register({ name: 'Ann', email: uniqueEmail(), password: 'short', role: 'student' });
    assert.equal(res.status, 400);
    assert.deepEqual(Object.keys(res.body.fields), ['password']);
    assert.equal(res.body.error, res.body.fields.password);
  });

  it('rejects names over 100 characters and a missing body', async () => {
    const long = await register({
      name: 'x'.repeat(101),
      email: uniqueEmail(),
      password: 'password123',
      role: 'student',
    });
    assert.equal(long.status, 400);
    assert.ok(long.body.fields.name);

    const empty = await srv.request('POST', '/api/auth/register');
    assert.equal(empty.status, 400);
    assert.ok(empty.body.fields.email);
  });

  it('returns 409 with fields.email for a duplicate email, ignoring case and spaces', async () => {
    const email = uniqueEmail();
    assert.equal((await register({ name: 'First', email, password: 'password123', role: 'student' })).status, 201);
    const dup = await register({
      name: 'Second',
      email: ` ${email.toUpperCase()}`,
      password: 'password123',
      role: 'teacher',
    });
    assert.equal(dup.status, 409);
    assert.equal(typeof dup.body.error, 'string');
    assert.equal(typeof dup.body.fields.email, 'string');
  });
});

describe('POST /api/auth/login', () => {
  const email = uniqueEmail('login');

  before(async () => {
    await register({ name: 'Login User', email, password: 'password123', role: 'student' });
  });

  it('signs in case-insensitively and creates a new session', async () => {
    const res = await login(`  ${email.toUpperCase()}  `, 'password123');
    assert.equal(res.status, 200);
    assert.equal(res.body.user.email, email);
    const me = await srv.request('GET', '/api/auth/me', { token: res.body.token });
    assert.equal(me.status, 200);
  });

  it('gives the same 401 for a wrong password and an unknown email', async () => {
    const wrong = await login(email, 'wrong-password');
    const unknown = await login(uniqueEmail('nobody'), 'password123');
    for (const res of [wrong, unknown]) {
      assert.equal(res.status, 401);
      assert.deepEqual(res.body, { error: 'Incorrect email or password.' });
    }
  });

  it('asks for missing credentials with field errors', async () => {
    const res = await srv.request('POST', '/api/auth/login', { json: { email: '', password: '' } });
    assert.equal(res.status, 400);
    assert.deepEqual(Object.keys(res.body.fields).sort(), ['email', 'password']);
  });
});

describe('sessions', () => {
  const me = (token?: string) => srv.request<Body<{ user: User }>>('GET', '/api/auth/me', { token });

  it('rejects missing and unknown tokens with 401', async () => {
    const missing = await me();
    assert.equal(missing.status, 401);
    assert.deepEqual(missing.body, { error: 'Please sign in.' });
    const unknown = await me('not-a-real-token');
    assert.equal(unknown.status, 401);
    assert.deepEqual(unknown.body, { error: 'Please sign in again.' });
    assert.equal((await srv.request('POST', '/api/auth/logout')).status, 401);
  });

  it('logout ends only the current session', async () => {
    const first = await srv.registerUser('student');
    const second = await login(first.user.email, 'password123');
    const res = await srv.request('POST', '/api/auth/logout', { token: first.token });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
    const signedOut = await me(first.token);
    assert.equal(signedOut.status, 401);
    assert.equal(signedOut.body.error, 'Please sign in again.');
    assert.equal((await me(second.body.token)).status, 200);
  });

  it('says an expired session has expired, then forgets it', async () => {
    const { token } = await srv.registerUser('teacher');
    dbm.run('UPDATE sessions SET expires_at = ? WHERE token = ?', new Date(Date.now() - 1000).toISOString(), token);
    const expired = await me(token);
    assert.equal(expired.status, 401);
    assert.equal(expired.body.error, 'Your session has expired. Please sign in again.');
    assert.equal(dbm.get('SELECT 1 FROM sessions WHERE token = ?', token), undefined);
    assert.equal((await me(token)).body.error, 'Please sign in again.');
  });
});

describe('POST /api/auth/change-password', () => {
  it('validates the current and the new password', async () => {
    const { token } = await srv.registerUser('teacher');
    const change = (json: Record<string, unknown>) =>
      srv.request('POST', '/api/auth/change-password', { token, json });

    const wrong = await change({ currentPassword: 'nope-nope', newPassword: 'brand-new-pass' });
    assert.equal(wrong.status, 400);
    assert.deepEqual(Object.keys(wrong.body.fields), ['currentPassword']);

    const short = await change({ currentPassword: 'password123', newPassword: 'short' });
    assert.equal(short.status, 400);
    assert.deepEqual(Object.keys(short.body.fields), ['newPassword']);

    const same = await change({ currentPassword: 'password123', newPassword: 'password123' });
    assert.equal(same.status, 400);
    assert.deepEqual(Object.keys(same.body.fields), ['newPassword']);

    assert.equal((await srv.request('POST', '/api/auth/change-password', { json: {} })).status, 401);
  });

  it('changes the password, keeps this session and ends the others', async () => {
    const { token, user } = await srv.registerUser('student');
    const other = await login(user.email, 'password123');

    const res = await srv.request<{ user: User }>('POST', '/api/auth/change-password', {
      token,
      json: { currentPassword: 'password123', newPassword: 'a-better-password' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.id, user.id);
    assert.equal(res.body.user.mustChangePassword, false);

    assert.equal((await srv.request('GET', '/api/auth/me', { token })).status, 200);
    assert.equal((await srv.request('GET', '/api/auth/me', { token: other.body.token })).status, 401);
    assert.equal((await login(user.email, 'password123')).status, 401);
    assert.equal((await login(user.email, 'a-better-password')).status, 200);
  });
});
