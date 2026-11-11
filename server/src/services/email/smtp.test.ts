/**
 * Sends through the real nodemailer SMTP transport to a local server that behaves like Cloudflare's: implicit TLS
 * (port 465 style, no STARTTLS), AUTH required with the user "api_token" and the API token as password, and 550 for a
 * sender domain that isn't onboarded. Nothing leaves 127.0.0.1. The server uses smtp-server's built-in self-signed
 * localhost certificate, which SMTP_TLS_ALLOW_SELF_SIGNED=1 lets the client accept.
 */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';
import { SMTPServer, type SMTPServerAuthentication, type SMTPServerSession } from 'smtp-server';

const TOKEN = 'cf-smtp-test-token-Hx81Kq';

interface Received {
  auth: { method: string; username?: string; password?: string | null } | null;
  secure: boolean;
  mailFrom: string;
  rcptTo: string[];
  raw: string;
}

let server: SMTPServer;
let received: Received[] = [];
let lastAuth: Received['auth'] = null;
let mailer: typeof import('./mailer.js');

function smtpError(message: string, responseCode: number): Error {
  return Object.assign(new Error(message), { responseCode });
}

before(async () => {
  server = new SMTPServer({
    secure: true,
    authOptional: false,
    authMethods: ['PLAIN', 'LOGIN'],
    disabledCommands: ['STARTTLS'],
    logger: false,
    onAuth(auth: SMTPServerAuthentication, _session, callback) {
      lastAuth = { method: auth.method, username: auth.username, password: auth.password };
      if (auth.username === 'api_token' && auth.password === TOKEN) callback(null, { user: 'cloudflare' });
      else callback(smtpError('5.7.8 Authentication credentials invalid', 535));
    },
    onMailFrom(address, _session, callback) {
      if (!address.address.endsWith('@mchstech.org')) callback(smtpError('5.7.1 Sender domain not onboarded', 550));
      else callback();
    },
    onData(stream, session: SMTPServerSession, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        received.push({
          auth: lastAuth,
          secure: session.secure,
          mailFrom: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
          rcptTo: session.envelope.rcptTo.map((r) => r.address),
          raw: Buffer.concat(chunks).toString('utf8'),
        });
        callback();
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.server.address() as AddressInfo;

  delete process.env.EMAIL_TRANSPORT;
  delete process.env.EMAIL_FROM_NAME;
  process.env.CLOUDFLARE_API_TOKEN = TOKEN;
  process.env.EMAIL_FROM_ADDRESS = 'noreply@mchstech.org';
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = String(port);
  process.env.SMTP_TLS_ALLOW_SELF_SIGNED = '1';
  mailer = await import('./mailer.js');
});

beforeEach(() => {
  received = [];
  lastAuth = null;
  process.env.CLOUDFLARE_API_TOKEN = TOKEN;
  process.env.EMAIL_FROM_ADDRESS = 'noreply@mchstech.org';
});

after(async () => {
  mailer.closeMailer();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const EMAIL = {
  to: { name: 'Ana Lopez', address: 'ana.lopez@students.mchstech.org' },
  subject: 'Received: Monthly Budget - Business Computing 101',
  text: 'Hi Ana, we received your work.',
  html: '<p>Hi Ana, we received your work.</p>',
};

/** The header block of a raw message, with folded lines joined. */
function headers(raw: string): string {
  return raw.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' ');
}

describe('SMTP (implicit TLS, like Cloudflare on port 465)', () => {
  test('authenticates as api_token with the API token and sends both parts from "Podner\'s Excel"', async () => {
    await mailer.sendNow(EMAIL);
    assert.equal(received.length, 1);
    const [mail] = received;
    assert.equal(mail.secure, true, 'TLS from the first byte');
    assert.deepEqual(mail.auth, { method: mail.auth?.method, username: 'api_token', password: TOKEN });
    assert.ok(['PLAIN', 'LOGIN'].includes(mail.auth!.method));
    assert.equal(mail.mailFrom, 'noreply@mchstech.org');
    assert.deepEqual(mail.rcptTo, ['ana.lopez@students.mchstech.org']);

    const head = headers(mail.raw);
    assert.match(head, /^From: "Podner's Excel" <noreply@mchstech\.org>$/m);
    assert.match(head, /^To: Ana Lopez <ana\.lopez@students\.mchstech\.org>$/m);
    assert.match(head, /^Subject: Received: Monthly Budget - Business Computing 101$/m);
    assert.match(head, /^Auto-Submitted: auto-generated$/m);
    assert.match(head, /^Message-ID: <[^>]+@mchstech\.org>$/m);
    assert.match(mail.raw, /Content-Type: multipart\/alternative/);
    assert.match(mail.raw, /Content-Type: text\/plain; charset=utf-8[\s\S]*Hi Ana, we received your work\./);
    assert.match(mail.raw, /Content-Type: text\/html; charset=utf-8[\s\S]*<p>Hi Ana, we received your work\.<\/p>/);
    assert.ok(!mail.raw.includes(TOKEN), 'the token is not in the message');
  });

  test('CR/LF in names and subjects cannot add headers', async () => {
    await mailer.sendNow({
      ...EMAIL,
      to: { name: 'Ana\r\nBcc: evil@attacker.example', address: 'ana.lopez@students.mchstech.org' },
      subject: 'Hello\r\nBcc: evil@attacker.example',
    });
    const head = headers(received[0].raw);
    assert.doesNotMatch(head, /^Bcc:/m);
    assert.match(head, /^Subject: Hello Bcc: evil@attacker\.example$/m);
    assert.deepEqual(received[0].rcptTo, ['ana.lopez@students.mchstech.org']);
  });

  test('a rejected token is a permanent 535 error with a hint about the token permission', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'wrong-token-value-123';
    const err = await mailer.sendNow(EMAIL).then(
      () => assert.fail('should not send'),
      (e: unknown) => e,
    );
    assert.ok(err instanceof mailer.EmailSendError);
    assert.equal(err.responseCode, 535);
    assert.equal(err.temporary, false);
    assert.match(err.message, /535/);
    assert.ok(!err.message.includes('wrong-token-value-123'));
    assert.match(mailer.friendlySendError(err), /^Cloudflare rejected the API token \(check it has Email Sending: /);
    assert.equal(received.length, 0);
  });

  test('a sender domain that is not onboarded is a permanent 550 error', async () => {
    process.env.EMAIL_FROM_ADDRESS = 'noreply@other-school.org';
    const err = await mailer.sendNow(EMAIL).then(
      () => assert.fail('should not send'),
      (e: unknown) => e,
    );
    assert.ok(err instanceof mailer.EmailSendError);
    assert.equal(err.responseCode, 550);
    assert.equal(err.temporary, false);
    assert.match(mailer.friendlySendError(err), /is other-school\.org onboarded for Email Sending\?/);
  });

  test('a mail server that is not reachable is a temporary error', async () => {
    const saved = process.env.SMTP_PORT;
    // Port 9 (discard) on loopback: nothing listens there, so the connection is refused at once.
    process.env.SMTP_PORT = '9';
    try {
      const err = await mailer.sendNow(EMAIL).then(
        () => assert.fail('should not send'),
        (e: unknown) => e,
      );
      assert.ok(err instanceof mailer.EmailSendError);
      assert.equal(err.temporary, true);
      assert.match(mailer.friendlySendError(err), /^Could not reach the mail server 127\.0\.0\.1:9/);
    } finally {
      process.env.SMTP_PORT = saved;
    }
  });

  test('reserved test domains (demo data) are never sent to', async () => {
    const err = await mailer.sendNow({ ...EMAIL, to: { name: 'Ava', address: 'ava@demo.test' } }).then(
      () => assert.fail('should not send'),
      (e: unknown) => e,
    );
    assert.ok(err instanceof mailer.EmailSendError);
    assert.equal(err.temporary, false);
    assert.match(err.message, /demo\.test is a reserved test domain/);
    assert.equal(mailer.friendlySendError(err), err.message, 'shown as is, without a "could not be sent" prefix');
    assert.equal(received.length, 0);
  });
});
