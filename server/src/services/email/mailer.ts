/**
 * Sends one email through the configured transport:
 * - smtp:   nodemailer over implicit TLS (Cloudflare Email Service: port 465, user "api_token", the API token as
 *           password), one pooled connection;
 * - memory: kept in a list for tests (memoryMailbox), never sent;
 * - log:    written to the server log for development, never sent.
 * Errors come out as EmailSendError, with the mail server's message and whether a retry may succeed.
 */
import crypto from 'node:crypto';
import nodemailer, { type SendMailOptions, type Transporter } from 'nodemailer';
import { emailConfig, type EmailConfig } from './config.js';
import { cleanHeaderText } from './format.js';

export interface Recipient {
  name: string;
  address: string;
}

export interface MailContent {
  subject: string;
  html: string;
  text: string;
}

export interface OutgoingEmail extends MailContent {
  to: Recipient;
  /** One-click unsubscribe link (RFC 8058) for the List-Unsubscribe headers; left out of test emails. */
  unsubscribeUrl?: string | null;
}

export class EmailNotConfiguredError extends Error {
  constructor() {
    super(
      "Email isn't set up on this server. Add the Cloudflare API token (the update script asks for it, or set " +
        'CLOUDFLARE_API_TOKEN in config.env) and restart the app.',
    );
  }
}

/** A failed send. `message` is the mail server's own reply (or the network error), with secrets removed. */
export class EmailSendError extends Error {
  constructor(
    message: string,
    /** A later attempt may succeed (SMTP 4xx replies, network trouble). */
    readonly temporary: boolean,
    readonly responseCode: number | null = null,
    /** SMTP command the server rejected, e.g. "MAIL FROM", "AUTH PLAIN". */
    readonly command: string | null = null,
  ) {
    super(message);
  }
}

/* ------------------------------------------------------------------ */
/* Secrets and errors                                                 */
/* ------------------------------------------------------------------ */

/** Removes the API token (as is and base64-encoded, as AUTH sends it) from text bound for logs or the database. */
export function scrubSecrets(text: string, token = emailConfig().token): string {
  if (!token) return text;
  let clean = text;
  for (const secret of [token, Buffer.from(token).toString('base64')]) clean = clean.split(secret).join('[redacted]');
  return clean;
}

/** Network-level failures worth retrying: the server may simply be unreachable for a moment. */
const TEMPORARY_CODES = new Set([
  'ECONNECTION',
  'ETIMEDOUT',
  'ESOCKET',
  'EDNS',
  'ETLS',
  'EPROTOCOL',
  'EMAXLIMIT',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

interface NodemailerLikeError {
  message?: unknown;
  code?: unknown;
  response?: unknown;
  responseCode?: unknown;
  command?: unknown;
  permanent?: unknown;
}

export function toSendError(err: unknown, token: string): EmailSendError {
  if (err instanceof EmailSendError) return err;
  const e = (err && typeof err === 'object' ? err : { message: String(err) }) as NodemailerLikeError;
  const responseCode = typeof e.responseCode === 'number' ? e.responseCode : null;
  const code = typeof e.code === 'string' ? e.code : '';
  const raw = typeof e.response === 'string' && e.response ? e.response : String(e.message ?? 'Unknown error');
  const message = scrubSecrets(cleanHeaderText(raw, 500), token) || 'Unknown error';
  // nodemailer sets `permanent` from the reply class (5xx except 503); without a reply, network errors are temporary.
  const temporary =
    typeof e.permanent === 'boolean'
      ? !e.permanent
      : responseCode !== null
        ? responseCode < 500 || responseCode === 503
        : TEMPORARY_CODES.has(code);
  return new EmailSendError(message, temporary, responseCode, typeof e.command === 'string' ? e.command : null);
}

/** A sentence for a teacher who pressed "send test email" (or "send report now") and it failed. */
export function friendlySendError(err: EmailSendError, cfg: EmailConfig = emailConfig()): string {
  const domain = cfg.fromAddress.split('@')[1] ?? cfg.fromAddress;
  const said = ` The mail server said: ${err.message}`;
  if (err.responseCode === 535 || (/^AUTH/i.test(err.command ?? '') && !err.temporary)) {
    return `Cloudflare rejected the API token (check it has Email Sending: Edit).${said}`;
  }
  if (err.responseCode === 550 && (/MAIL FROM/i.test(err.command ?? '') || /5\.7\.1/.test(err.message))) {
    return `Cloudflare refused the sender address — is ${domain} onboarded for Email Sending?${said}`;
  }
  if (err.responseCode === null) {
    // Refused before reaching a mail server (e.g. a reserved test domain): the reason is already a sentence.
    if (!err.temporary) return err.message;
    return `Could not reach the mail server ${cfg.host}:${cfg.port}. Check the server's internet connection.${said}`;
  }
  return `The email could not be sent.${said}`;
}

/* ------------------------------------------------------------------ */
/* Addresses that can't receive mail                                   */
/* ------------------------------------------------------------------ */

/** Reserved names (RFC 2606/6761) used by demo data and tests: mail to them would only bounce. */
const RESERVED_TLDS = new Set(['test', 'example', 'invalid', 'localhost', 'local']);
const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org'];

export function undeliverableReason(address: string): string | null {
  const domain = address.split('@').pop()?.toLowerCase() ?? '';
  const tld = domain.split('.').pop() ?? '';
  const reserved = RESERVED_TLDS.has(tld) || RESERVED_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
  return reserved ? `${domain} is a reserved test domain that can't receive email.` : null;
}

/* ------------------------------------------------------------------ */
/* Transports                                                         */
/* ------------------------------------------------------------------ */

function buildMessage(cfg: EmailConfig, email: OutgoingEmail): SendMailOptions {
  // Automatic mail: ask mail servers (Exchange in particular) not to send out-of-office replies to it.
  const headers: Record<string, string> = {
    'Auto-Submitted': 'auto-generated',
    'X-Auto-Response-Suppress': 'OOF, AutoReply',
  };
  const message: SendMailOptions = {
    from: { name: cfg.fromName, address: cfg.fromAddress },
    to: { name: cleanHeaderText(email.to.name, 100), address: email.to.address.trim() },
    subject: cleanHeaderText(email.subject),
    text: email.text,
    html: email.html,
    headers,
    disableFileAccess: true,
    disableUrlAccess: true,
  };
  if (email.unsubscribeUrl) {
    // Mail apps show an "Unsubscribe" button that POSTs to the link (no sign-in needed).
    message.list = { unsubscribe: email.unsubscribeUrl };
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
  return message;
}

const STARTTLS_PORTS = new Set([25, 587, 2525]);

let pooled: { key: string; transporter: Transporter } | null = null;

/** One pooled SMTP connection, rebuilt when the settings change (tests point it at a local server). */
function smtpTransporter(cfg: EmailConfig): Transporter {
  const tokenHash = crypto.createHash('sha256').update(cfg.token).digest('hex');
  const key = [cfg.host, cfg.port, cfg.user, tokenHash, cfg.allowSelfSigned].join('|');
  if (pooled?.key === key) return pooled.transporter;
  pooled?.transporter.close();
  const transporter = nodemailer.createTransport({
    pool: true,
    maxConnections: 1,
    // Cloudflare accepts at most 50 recipients per SMTP session; every message here has one.
    maxMessages: 25,
    idleTimeout: 30_000,
    host: cfg.host,
    port: cfg.port,
    // Implicit TLS (Cloudflare's port 465 offers nothing else), except on the STARTTLS ports, where the connection
    // must still be upgraded before AUTH: the token is never sent in clear text.
    secure: !STARTTLS_PORTS.has(cfg.port),
    requireTLS: STARTTLS_PORTS.has(cfg.port),
    auth: { user: cfg.user, pass: cfg.token },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
    dnsTimeout: 10_000,
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: !cfg.allowSelfSigned },
    logger: false,
    debug: false,
  });
  pooled = { key, transporter };
  return transporter;
}

/** Closes the pooled SMTP connection (at shutdown). */
export function closeMailer(): void {
  pooled?.transporter.close();
  pooled = null;
}

export interface CapturedEmail extends OutgoingEmail {
  /** The From header as written, e.g. "Podner's Excel" <noreply@mchstech.org> */
  from: string;
  /** The whole MIME message. */
  raw: string;
}

const captured: CapturedEmail[] = [];
const injectedFailures: unknown[] = [];

/** The memory transport's mailbox, for tests. */
export const memoryMailbox = {
  get messages(): readonly CapturedEmail[] {
    return captured;
  },
  reset(): void {
    captured.length = 0;
    injectedFailures.length = 0;
  },
  /** The next sends fail with these errors, one per send, e.g. { responseCode: 451, response: '451 4.3.0 Later' }. */
  failNext(...errors: unknown[]): void {
    injectedFailures.push(...errors);
  },
};

const memoryTransport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });

async function sendToMemory(email: OutgoingEmail, message: SendMailOptions): Promise<void> {
  if (injectedFailures.length > 0) throw injectedFailures.shift();
  const info = await memoryTransport.sendMail(message);
  const raw = info.message.toString();
  const from = /^From: (.*)$/m.exec(raw)?.[1] ?? '';
  captured.push({
    ...email,
    to: { name: String((message.to as Recipient).name), address: (message.to as Recipient).address },
    subject: String(message.subject),
    from,
    raw,
  });
}

function logEmail(message: SendMailOptions): void {
  const to = message.to as Recipient;
  console.log(
    `[email] Not sent (EMAIL_TRANSPORT=log). To: ${to.name} <${to.address}>\n` +
      `[email] Subject: ${String(message.subject)}\n${String(message.text)}`,
  );
}

/**
 * Sends right away (the outbox worker, test email, daily report on demand). Throws EmailNotConfiguredError without
 * an API token and EmailSendError when the transport fails.
 */
export async function sendNow(email: OutgoingEmail): Promise<void> {
  const cfg = emailConfig();
  if (!cfg.token) throw new EmailNotConfiguredError();
  const message = buildMessage(cfg, email);
  try {
    if (cfg.transport === 'memory') await sendToMemory(email, message);
    else if (cfg.transport === 'log') logEmail(message);
    else {
      const reserved = undeliverableReason(email.to.address);
      if (reserved) throw new EmailSendError(reserved, false);
      await smtpTransporter(cfg).sendMail(message);
    }
  } catch (err) {
    throw toSendError(err, cfg.token);
  }
}
