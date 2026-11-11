/**
 * `npm run email-setup` (Windows: double-click email-setup.cmd): turns email on by saving a Cloudflare API token in
 * config.env, or changes, tests or removes it. Restarts the app if it is running, so the change takes effect.
 *
 *   --remove   remove the saved token, which turns email off
 *
 * Without a terminal it saves the token from the CLOUDFLARE_API_TOKEN environment variable.
 */
import fs from 'node:fs';
import {
  COMMANDS,
  CONFIG_FILE,
  ROOT,
  ScriptError,
  acquireLock,
  askText,
  bold,
  checkNode,
  checkPortPermission,
  dim,
  ensureConfigFile,
  ensureOwner,
  info,
  readConfig,
  runMain,
  serverStatus,
  startServer,
  step,
  stopServer,
  success,
  writeConfig,
} from './lib.mjs';
import { describeSender, emailConfigured, emailSetupMode, setUpEmail, smtpSettings, testSavedEmail } from './email.mjs';

function parseArgs(argv) {
  const options = { remove: false };
  for (const arg of argv) {
    if (arg === '--remove') options.remove = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*|^ \* ?/gm, ''));
      process.exit(0);
    } else throw new ScriptError(`Unknown option "${arg}". Run with --help to see the options.`);
  }
  return options;
}

function removeToken() {
  writeConfig({ CLOUDFLARE_API_TOKEN: '' });
  success('Removed the Cloudflare API token: the app sends no email.');
  return true;
}

/** What to do on a copy where email is already on. Returns true when config.env changed. */
async function manageEmail() {
  success(`Email is on: a Cloudflare API token is saved in ${CONFIG_FILE}.`);
  info(`Emails come from ${describeSender(smtpSettings())}.`);
  if (!process.stdin.isTTY) {
    info(`Nothing changed. Run this in a terminal to change the token, or use --remove to turn email off.`);
    return false;
  }
  for (;;) {
    const question = '[c]hange the token, [t]est it (and send a test email), [r]emove it, or Enter to keep it:';
    const answer = (await askText(question)).toLowerCase();
    if (!answer) return false;
    if (answer.startsWith('c')) return setUpEmail({ interactive: true, replacing: true });
    if (answer.startsWith('t')) {
      await testSavedEmail();
      return false;
    }
    if (answer.startsWith('r')) return removeToken();
  }
}

/** Restarts a running app so it reads config.env again. */
async function applyChange() {
  const config = readConfig();
  const status = await serverStatus(config);
  if (!status.running) {
    info(`The app is not running; the settings apply when it starts (${COMMANDS.start}).`);
    return;
  }
  step('Restarting Excel Autograder so the change takes effect');
  await checkPortPermission(config);
  await stopServer(config);
  await startServer(config);
}

runMain(async () => {
  const options = parseArgs(process.argv.slice(2));
  checkNode();
  ensureOwner('email setup');
  // Not while an install or update runs (and the restart at the end needs the lock anyway).
  acquireLock('email setup');

  console.log(bold('\nExcel Autograder email setup'));
  info(dim(ROOT));
  const { added } = ensureConfigFile();
  if (added.length) info(dim(`Added new settings to config.env: ${added.join(', ')}.`));

  let changed;
  if (options.remove) {
    changed = emailConfigured() ? removeToken() : false;
    if (!changed) info('No token is saved; email is already off.');
  } else if (emailConfigured()) {
    changed = await manageEmail();
  } else {
    const mode = emailSetupMode();
    if (!mode) {
      throw new ScriptError(
        'Run this in a terminal, so it can ask for the Cloudflare API token (or set the CLOUDFLARE_API_TOKEN ' +
          'environment variable).',
      );
    }
    step('Email');
    changed = await setUpEmail(mode);
  }
  if (changed) await applyChange();
  console.log('');
});
