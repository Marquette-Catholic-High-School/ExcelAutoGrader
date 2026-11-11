/**
 * Email setup, shared by the installer, the update and `npm run email-setup`: asks for the Cloudflare API token
 * (hidden), checks it with Cloudflare's mail server, asks for the address used in email links and the time zone,
 * offers a test email, and saves the settings in config.env.
 *
 * The token is never printed or logged (not even partly) and never passed on a command line. For unattended
 * installs it can come from the CLOUDFLARE_API_TOKEN environment variable.
 */
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {
  COMMANDS,
  CONFIG_FILE,
  DEFAULT_PORT,
  EMAIL_DEFAULTS,
  ROOT,
  ScriptError,
  StoppedError,
  askSecret,
  askText,
  bold,
  dim,
  info,
  isNetworkHost,
  readConfig,
  success,
  warn,
  writeConfig,
} from './lib.mjs';

/** Time limit for each step of talking to the mail server (connecting, greeting, each reply). */
const SMTP_TIMEOUT_MS = 10_000;
/** API tokens are one word of printable characters (Cloudflare's: 40 letters, digits, - and _). */
const TOKEN_PATTERN = /^[\x21-\x7e]{20,}$/;
const NETWORK_CODES = new Set([
  'ETIMEDOUT',
  'ECONNECTION',
  'ESOCKET',
  'EDNS',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

export const emailConfigured = (config = readConfig()) => Boolean(config.CLOUDFLARE_API_TOKEN);

export const emailOffNote = () => `Email is off; run ${COMMANDS.emailSetup} to turn it on.`;

const tokenFromEnvironment = () => (process.env.CLOUDFLARE_API_TOKEN ?? '').trim();

/**
 * Whether the installer's or the update's Email step should set up email: null when it should only print
 * emailOffNote(), otherwise { interactive } (false: use CLOUDFLARE_API_TOKEN from the environment, ask nothing).
 */
export function emailSetupMode({ yes = false, skip = false } = {}) {
  if (skip) return null;
  if (!yes && process.stdin.isTTY) return { interactive: true };
  return tokenFromEnvironment() ? { interactive: false } : null;
}

/** Mail server settings from config.env (defaults: Cloudflare Email Service). */
export function smtpSettings(config = readConfig()) {
  const value = (key) => config[key] || EMAIL_DEFAULTS[key];
  return {
    host: value('SMTP_HOST'),
    port: Number(value('SMTP_PORT')),
    user: value('SMTP_USER'),
    fromName: value('EMAIL_FROM_NAME'),
    fromAddress: value('EMAIL_FROM_ADDRESS'),
    // Only for trying things out against a local mail server with a self-signed certificate.
    allowSelfSigned: config.SMTP_TLS_ALLOW_SELF_SIGNED === '1',
  };
}

export const describeSender = (settings) => `"${settings.fromName}" <${settings.fromAddress}>`;

const requireFromServer = () => createRequire(path.join(ROOT, 'server', 'package.json'));

/** False before the app's dependencies are installed (a first install, or an update from before email). */
export function nodemailerAvailable() {
  try {
    requireFromServer().resolve('nodemailer');
    return true;
  } catch {
    return false;
  }
}

/** nodemailer from the server's dependencies (the scripts themselves have none). */
function loadNodemailer() {
  try {
    return requireFromServer()('nodemailer');
  } catch {
    throw new ScriptError(
      "The app's dependencies are not installed, so email can't be checked. " +
        `Run the installer first (${COMMANDS.install}).`,
    );
  }
}

/** Runs `action(transporter)` against the mail server with a time limit. Returns null if it worked, else the error. */
async function withMailServer(settings, token, action) {
  const transporter = loadNodemailer().createTransport({
    host: settings.host,
    port: settings.port,
    secure: true, // Cloudflare only offers implicit TLS on port 465 (no STARTTLS)
    auth: { user: settings.user, pass: token },
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
    dnsTimeout: SMTP_TIMEOUT_MS,
    tls: settings.allowSelfSigned ? { rejectUnauthorized: false } : undefined,
  });
  let timer;
  const timeLimit = new Promise((resolve, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error('no answer in time'), { code: 'ETIMEDOUT' })),
      3 * SMTP_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([action(transporter), timeLimit]);
    return null;
  } catch (err) {
    return err;
  } finally {
    clearTimeout(timer);
    transporter.close();
  }
}

/** Signs in to the mail server with the token (sends nothing). */
export const verifyLogin = (settings, token) => withMailServer(settings, token, (transporter) => transporter.verify());

export function sendTestEmail(settings, token, to) {
  const where = readConfig().APP_URL || os.hostname();
  return withMailServer(settings, token, (transporter) =>
    transporter.sendMail({
      from: { name: settings.fromName, address: settings.fromAddress },
      to,
      subject: 'Test email from Excel Autograder',
      text:
        `This is a test email from Excel Autograder (${where}).\n\n` +
        'Email works: students can get submission receipts and overdue reminders, and teachers their daily report, ' +
        'from this address. Teachers choose what is sent for each class in the app.\n',
    }),
  );
}

const redact = (text, token) => (token ? String(text).split(token).join('[token]') : String(text));

/** What went wrong talking to the mail server, and what to do about it (lines for warn()). */
export function explainMailError(err, settings, token) {
  const reply = redact(err.response || err.message || err, token).trim();
  const code = err.responseCode;
  const server = `${settings.host} on port ${settings.port}`;
  if (code === 535 || err.code === 'EAUTH') {
    return [
      `The mail server did not accept the token (${reply}).`,
      'Check that it was copied completely, has the "Email Sending: Edit" permission, and is not expired or revoked',
      '(Cloudflare dashboard > My Profile > API Tokens).',
    ];
  }
  if (code === 550) {
    const domain = settings.fromAddress.split('@')[1] || settings.fromAddress;
    return [
      `The mail server refused the sender ${settings.fromAddress} (${reply}).`,
      `Onboard ${domain} for Email Sending in the Cloudflare dashboard (Email > Email Sending), or change`,
      `EMAIL_FROM_ADDRESS in ${CONFIG_FILE}.`,
    ];
  }
  if (code === 554) {
    return [
      `The mail server refused the message because of its sending policy (${reply}).`,
      'Check the Email Sending page of the Cloudflare dashboard (sending limits, account status).',
    ];
  }
  if (code >= 400 && code < 500) {
    return [`The mail server is busy or limiting email right now (${reply}). Try again in a few minutes.`];
  }
  if (err.code === 'ETLS' || /certificate|ssl|tls|wrong version number/i.test(reply)) {
    return [
      `Could not set up a secure connection with ${server} (${reply}).`,
      'Cloudflare needs port 465 with TLS (SMTP_PORT=465). A network filter that inspects encrypted traffic can also',
      'cause this.',
    ];
  }
  if (NETWORK_CODES.has(err.code) || NETWORK_CODES.has(err.cause?.code)) {
    return [
      `Could not reach ${server} (${reply}).`,
      `This computer must be able to connect out to port ${settings.port}, which some school and home networks`,
      `block. Ask the network administrator to allow outgoing connections to ${settings.host} on port ${settings.port}.`,
    ];
  }
  return [`The mail server answered: ${reply}`];
}

/** Asks until one of the letters (or Enter, for `fallback`) is typed. */
async function choose(question, letters, fallback) {
  for (;;) {
    const answer = (await askText(question)).toLowerCase();
    if (!answer) return fallback;
    if (letters.includes(answer[0])) return answer[0];
  }
}

/** The address other computers most likely open the app at (no :80 for port 80). */
export function suggestedAppUrl(config = readConfig()) {
  const port = Number(config.PORT || DEFAULT_PORT);
  const suffix = port === 80 ? '' : `:${port}`;
  if (!isNetworkHost(config.HOST)) return `http://localhost${suffix}`;
  let host = config.HOST && !['0.0.0.0', '::'].includes(config.HOST) ? config.HOST : null;
  if (!host) {
    const name = os.hostname();
    const ip = Object.values(os.networkInterfaces())
      .flat()
      .find((entry) => entry && entry.family === 'IPv4' && !entry.internal)?.address;
    // A full name (grader.school.org) works from anywhere on the network; a bare one often doesn't.
    host = (name.includes('.') && !name.endsWith('.local')) || !ip ? name : ip;
  }
  return `http://${host.includes(':') ? `[${host}]` : host}${suffix}`;
}

/** "grader.school.org" → "http://grader.school.org"; null when it isn't a web address. */
function normalizeAppUrl(text) {
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.search || url.hash) return null;
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

async function askAppUrl(config) {
  const current = config.APP_URL || suggestedAppUrl(config);
  if (!isNetworkHost(config.HOST)) {
    info(dim('Only this computer can open the app (HOST in config.env), so links in emails only work here.'));
  }
  for (;;) {
    const answer = await askText(`Address students use to open the app, for links in emails [${current}]:`);
    const url = normalizeAppUrl(answer || current);
    if (url) return url;
    warn('That is not a web address (for example http://grading-pc or https://grader.school.org).');
  }
}

/** The IANA name in its usual spelling ("america/chicago" → "America/Chicago"); null when there is no such zone. */
function canonicalTimeZone(name) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** Returns TIME_ZONE to save: '' follows this computer's time zone. */
async function askTimeZone(config) {
  const computer = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const current = config.TIME_ZONE || computer;
  if (/^(Etc\/)?(UTC|GMT|Universal|Zulu)$/i.test(current)) {
    info(dim(`This computer's clock is set to ${current}. Type your school's time zone, e.g. America/Chicago.`));
  }
  for (;;) {
    const answer = await askText(`Time zone for the daily report and reminders [${current}]:`);
    if (!answer) return config.TIME_ZONE ?? '';
    const zone = canonicalTimeZone(answer);
    if (zone) return zone;
    warn(`"${answer}" is not a time zone name. Use one like America/Chicago, America/New_York or Europe/London.`);
  }
}

async function offerTestEmail(settings, token) {
  for (;;) {
    const to = await askText('Send a test email to (an address you can check; press Enter to skip):');
    if (!to) return;
    if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(to)) {
      warn('That is not an email address.');
      continue;
    }
    info(`Sending a test email to ${to} from ${describeSender(settings)}...`);
    const err = await sendTestEmail(settings, token, to);
    if (!err) {
      success('Sent. It should arrive within a few minutes (check the spam folder too).');
      return;
    }
    for (const line of explainMailError(err, settings, token)) warn(line);
    info(dim(`The settings were saved anyway. To try again later: ${COMMANDS.emailSetup}`));
    return;
  }
}

/**
 * Turns email on: gets the token (CLOUDFLARE_API_TOKEN from the environment, else asked for when `interactive`),
 * checks it with the mail server, and saves it in config.env; when `interactive` also asks for the address used in
 * email links and the time zone, and offers a test email. With `replacing`, skipping keeps the saved token. With
 * `checkLater` (the update asks before it installs dependencies), a token that can't be checked yet because the
 * mail library isn't installed is saved unchecked: the caller checks it later with checkSavedToken().
 * Returns true when config.env changed.
 */
export async function setUpEmail({ interactive, replacing = false, checkLater = false }) {
  const config = readConfig();
  const settings = smtpSettings(config);
  const deferCheck = checkLater && !nodemailerAvailable();
  let token = tokenFromEnvironment();
  const skipped = () => {
    if (replacing) info('Kept the saved token.');
    else info(`Skipped: the app sends no email. To turn it on later: ${bold(COMMANDS.emailSetup)}`);
    return false;
  };
  if (interactive && !replacing) {
    info('The app can email students a receipt for each submission and reminders about overdue work, and');
    info(`teachers a daily report. It sends through Cloudflare Email Service, from ${describeSender(settings)}.`);
    info(dim('This needs a Cloudflare API token with the "Email Sending: Edit" permission (Cloudflare dashboard >'));
    info(dim('My Profile > API Tokens > Create Token). You can also do this later.'));
  }
  if (token) info('Using the Cloudflare API token from the CLOUDFLARE_API_TOKEN environment variable.');

  let verified = false;
  for (;;) {
    if (!token) {
      token = await askSecret('Cloudflare API token (hidden as you type or paste it; Enter skips):');
      if (!token) return skipped();
      info(dim(`(${token.length} characters received)`));
    }
    if (!TOKEN_PATTERN.test(token)) {
      warn('That does not look like an API token (too short, or it has spaces or unusual characters).');
      if (!interactive) return false;
      token = '';
      continue;
    }
    if (deferCheck) {
      info(dim("The token will be checked with the mail server once the update has installed the app's dependencies."));
      break;
    }
    info(`Checking the token with ${settings.host}...`);
    const err = await verifyLogin(settings, token);
    if (!err) {
      success('The mail server accepted the token.');
      verified = true;
      break;
    }
    for (const line of explainMailError(err, settings, token)) warn(line);
    if (!interactive) {
      warn(`Saved anyway. To change it: ${COMMANDS.emailSetup}`);
      break;
    }
    const question = 'Enter the token [a]gain, [k]eep it anyway, or [s]kip email for now? [A/k/s]';
    const choice = await choose(question, 'aks', 'a');
    if (choice === 's') return skipped();
    if (choice === 'k') break;
    token = '';
  }

  const changes = { CLOUDFLARE_API_TOKEN: token };
  if (interactive) {
    changes.APP_URL = await askAppUrl(config);
    changes.TIME_ZONE = await askTimeZone(config);
  }
  writeConfig(changes);
  success(`Email is on. The token is saved in ${CONFIG_FILE} (keep that file private).`);
  if (interactive && verified) await offerTestEmail(settings, token);
  return true;
}

/**
 * setUpEmail for the installer and the update, where email is optional: a problem is reported but does not stop
 * the install or update (Ctrl+C still does). Returns true when config.env changed.
 */
export async function optionalEmailSetup(mode) {
  try {
    return await setUpEmail(mode);
  } catch (err) {
    if (err instanceof StoppedError) throw err;
    warn(`Email could not be set up: ${err.message}`);
    info(emailOffNote());
    return false;
  }
}

/** Signs in with the saved token and reports the result; never throws (the update, after saving it unchecked). */
export async function checkSavedToken() {
  const config = readConfig();
  const settings = smtpSettings(config);
  try {
    info(`Checking the saved Cloudflare API token with ${settings.host}...`);
    const err = await verifyLogin(settings, config.CLOUDFLARE_API_TOKEN);
    if (!err) {
      success('The mail server accepted the token.');
      return true;
    }
    for (const line of explainMailError(err, settings, config.CLOUDFLARE_API_TOKEN)) warn(line);
  } catch (err) {
    warn(`The token could not be checked: ${err.message}`);
  }
  info(dim(`The token is saved anyway. To change it or send a test email: ${COMMANDS.emailSetup}`));
  return false;
}

/** Signs in with the saved token and offers a test email (npm run email-setup on a copy where email is on). */
export async function testSavedEmail() {
  const config = readConfig();
  const settings = smtpSettings(config);
  info(`Checking the saved token with ${settings.host}...`);
  const err = await verifyLogin(settings, config.CLOUDFLARE_API_TOKEN);
  if (err) {
    for (const line of explainMailError(err, settings, config.CLOUDFLARE_API_TOKEN)) warn(line);
    return false;
  }
  success('The mail server accepted the token.');
  await offerTestEmail(settings, config.CLOUDFLARE_API_TOKEN);
  return true;
}
