/**
 * Email settings from the environment (config.env, passed in by the start scripts): see docs/API.md, "Email".
 * Read on every call, so tests can change them. The API token is the SMTP password: never log or return it.
 */
import os from 'node:os';
import type { EmailStatus } from '../../../../shared/types.js';
import { cleanHeaderText } from './format.js';

export type EmailTransportKind = 'smtp' | 'memory' | 'log';

export interface EmailConfig {
  /** Cloudflare API token, the SMTP password. Empty = email is off. */
  token: string;
  fromName: string;
  fromAddress: string;
  host: string;
  port: number;
  user: string;
  /** smtp sends for real; memory (tests) and log (development) never do. */
  transport: EmailTransportKind;
  /** SMTP_TLS_ALLOW_SELF_SIGNED=1: accept a self-signed server certificate (local test servers only). */
  allowSelfSigned: boolean;
}

export const DEFAULT_FROM_NAME = "Podner's Excel";
export const DEFAULT_FROM_ADDRESS = 'noreply@mchstech.org';
export const DEFAULT_SMTP_HOST = 'smtp.mx.cloudflare.net';
export const DEFAULT_SMTP_PORT = 465;
export const DEFAULT_SMTP_USER = 'api_token';

const env = (name: string) => (process.env[name] ?? '').trim();

const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(message);
}

function transportKind(value: string): EmailTransportKind {
  const kind = value.toLowerCase();
  if (kind === '' || kind === 'smtp') return 'smtp';
  if (kind === 'memory' || kind === 'log') return kind;
  warnOnce(`EMAIL_TRANSPORT "${value}" is not smtp, memory or log; emails are only written to the log.`);
  return 'log';
}

function smtpPort(value: string): number {
  if (!value) return DEFAULT_SMTP_PORT;
  const port = Number(value);
  if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  warnOnce(`SMTP_PORT "${value}" is not a valid port; using ${DEFAULT_SMTP_PORT}.`);
  return DEFAULT_SMTP_PORT;
}

export function emailConfig(): EmailConfig {
  return {
    token: env('CLOUDFLARE_API_TOKEN'),
    fromName: cleanHeaderText(env('EMAIL_FROM_NAME'), 100) || DEFAULT_FROM_NAME,
    fromAddress: env('EMAIL_FROM_ADDRESS') || DEFAULT_FROM_ADDRESS,
    host: env('SMTP_HOST') || DEFAULT_SMTP_HOST,
    port: smtpPort(env('SMTP_PORT')),
    user: env('SMTP_USER') || DEFAULT_SMTP_USER,
    transport: transportKind(env('EMAIL_TRANSPORT')),
    allowSelfSigned: env('SMTP_TLS_ALLOW_SELF_SIGNED') === '1',
  };
}

/** Most emails the server sends in 24 hours, unless EMAIL_DAILY_LIMIT (config.env) sets another number. */
export const DEFAULT_DAILY_EMAIL_LIMIT = 2000;

export function dailyEmailLimit(): number {
  const raw = env('EMAIL_DAILY_LIMIT');
  if (!raw) return DEFAULT_DAILY_EMAIL_LIMIT;
  const limit = Number(raw);
  if (Number.isInteger(limit) && limit > 0) return limit;
  warnOnce(`EMAIL_DAILY_LIMIT "${raw}" is not a whole number above 0; using ${DEFAULT_DAILY_EMAIL_LIMIT}.`);
  return DEFAULT_DAILY_EMAIL_LIMIT;
}

/** Email is on when there is an API token (also with the memory/log transports, which need a placeholder one). */
export function emailConfigured(): boolean {
  return env('CLOUDFLARE_API_TOKEN') !== '';
}

/* ------------------------------------------------------------------ */
/* Time zone                                                          */
/* ------------------------------------------------------------------ */

function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** The canonical spelling of a valid IANA zone ("america/chicago" → "America/Chicago"), else null. */
function canonicalTimeZone(name: string): string | null {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

let zoneCache: { raw: string; zone: string } | undefined;

/** TIME_ZONE when it names a real zone, else the computer's own zone. */
export function timeZone(): string {
  const raw = env('TIME_ZONE');
  if (zoneCache?.raw === raw) return zoneCache.zone;
  let zone = raw ? canonicalTimeZone(raw) : null;
  if (!zone) {
    zone = systemTimeZone();
    if (raw) warnOnce(`TIME_ZONE "${raw}" is not a known time zone (e.g. America/Chicago); using ${zone}.`);
  }
  zoneCache = { raw, zone };
  return zone;
}

/* ------------------------------------------------------------------ */
/* Links                                                              */
/* ------------------------------------------------------------------ */

/** APP_URL without a trailing slash ("http://" is added when no scheme is given), or null when unset or invalid. */
export function configuredAppUrl(): string | null {
  const raw = env('APP_URL').replace(/\/+$/, '');
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol === 'http:' || url.protocol === 'https:') return withScheme;
  } catch {
    // reported below
  }
  warnOnce(`APP_URL "${raw}" is not a web address (like https://excel.example.org); links use this computer's name.`);
  return null;
}

/** Base address for links in emails: APP_URL, or a guess from this computer's name and PORT. */
export function appUrl(): string {
  const configured = configuredAppUrl();
  if (configured) return configured;
  const port = Number(process.env.PORT || 3001);
  const host = os.hostname().toLowerCase() || 'localhost';
  return port === 80 ? `http://${host}` : `http://${host}:${port}`;
}

/** Absolute link to an app page, e.g. link('/student/assignments/4'). */
export function link(pagePath: string): string {
  return `${appUrl()}${pagePath}`;
}

export function emailStatus(): EmailStatus {
  const cfg = emailConfig();
  return {
    configured: cfg.token !== '',
    fromName: cfg.fromName,
    fromAddress: cfg.fromAddress,
    timeZone: timeZone(),
    appUrl: configuredAppUrl(),
  };
}

/** REQUIRE_CODE_FOR_INVITES, read the same way as routes/auth.ts: on unless 0, false, no or off. */
export function inviteCodeRequired(): boolean {
  const value = env('REQUIRE_CODE_FOR_INVITES').toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(value);
}

/** One line for the server log at startup (no token). */
export function describeEmailSetup(): string {
  const cfg = emailConfig();
  if (!cfg.token) return 'Email: off (no Cloudflare API token; add one with the update script to send email).';
  const via = cfg.transport === 'smtp' ? `${cfg.host}:${cfg.port}` : `the ${cfg.transport} transport (nothing is sent)`;
  return (
    `Email: sending as ${cfg.fromName} <${cfg.fromAddress}> through ${via}; ` +
    `times in ${timeZone()}; links to ${appUrl()}.`
  );
}
