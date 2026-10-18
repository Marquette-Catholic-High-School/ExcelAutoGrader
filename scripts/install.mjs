/**
 * Sets up (or re-sets up) this copy of Excel Autograder: dependencies, settings, web app build, optional demo
 * data, and starts the app. Safe to run again: existing data and config.env are kept.
 * Normally started by install.sh / install.ps1; can also be run as `npm run setup`.
 *
 *   --demo           load the demo teacher, students and assignments (replaces existing data after asking)
 *   --no-demo        start with an empty database (default when not asked interactively)
 *   --port <n>       port to listen on (saved in config.env)
 *   --host <ip>      127.0.0.1 (this computer only, default) or 0.0.0.0 (whole network)
 *   --start          start the app at the end without asking (default when it was already running)
 *   --no-start       don't start the app at the end
 *   --yes            accept the defaults without asking
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  COMMANDS,
  CONFIG_FILE,
  DEFAULT_REPO,
  IS_WINDOWS,
  LOG_DIR,
  ROOT,
  ScriptError,
  acquireLock,
  appUrl,
  backupData,
  bold,
  buildClient,
  checkNode,
  confirm,
  dataDir,
  dim,
  ensureOwner,
  git,
  info,
  installDependencies,
  readConfig,
  run,
  runMain,
  samePath,
  serverStatus,
  startServer,
  step,
  stopServer,
  success,
  validatePort,
  warn,
  writeConfig,
} from './lib.mjs';

function parseArgs(argv) {
  const options = { demo: undefined, start: undefined, yes: false, port: undefined, host: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith('--')) throw new ScriptError(`${arg} needs a value.`);
      return next;
    };
    if (arg === '--demo') options.demo = true;
    else if (arg === '--no-demo') options.demo = false;
    else if (arg === '--start') options.start = true;
    else if (arg === '--no-start') options.start = false;
    else if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--port') options.port = validatePort(value());
    else if (arg === '--host') options.host = value();
    else if (arg === '--help' || arg === '-h') {
      console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*|^ \* ?/gm, ''));
      process.exit(0);
    } else throw new ScriptError(`Unknown option "${arg}". Run with --help to see the options.`);
  }
  return options;
}

function repositoryUrl() {
  if (process.env.EXCEL_AUTOGRADER_REPO) return process.env.EXCEL_AUTOGRADER_REPO;
  try {
    const { repository } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return (typeof repository === 'string' ? repository : repository?.url) || DEFAULT_REPO;
  } catch {
    return DEFAULT_REPO;
  }
}

/**
 * A folder that came from GitHub's "Download ZIP" (no .git) works, but could never update itself. Turn it into a
 * proper git checkout of the latest version; untracked files (config.env, server/data, logs) are not touched.
 */
function connectToGitHub() {
  if (fs.existsSync(path.join(ROOT, '.git'))) return;
  step('Connecting this folder to GitHub, so it can update itself');
  info(dim('This folder was not downloaded with git (for example, it came from a ZIP file).'));
  const repo = repositoryUrl();
  const branch = process.env.EXCEL_AUTOGRADER_BRANCH || 'main';
  try {
    git(['init', '-q']);
    git(['remote', 'add', 'origin', repo]);
    git(['fetch', '-q', 'origin', branch]);
    git(['checkout', '-q', '-f', '-B', branch, `origin/${branch}`]);
    git(['branch', '-q', `--set-upstream-to=origin/${branch}`, branch]);
    success(`Connected to ${repo} (${git(['log', '-1', '--format=%h %s'])}).`);
  } catch (err) {
    fs.rmSync(path.join(ROOT, '.git'), { recursive: true, force: true });
    warn(`Could not connect this folder to GitHub, so it will not be able to update itself:\n      ${err.message}`);
    warn('Check the internet connection and run the installer again to fix that.');
  }
}

runMain(async () => {
  const options = parseArgs(process.argv.slice(2));
  const ask = (question, defaultYes) => (options.yes ? Promise.resolve(defaultYes) : confirm(question, defaultYes));

  console.log(bold('\nExcel Autograder setup'));
  info(dim(ROOT));

  step('Checking Node.js');
  checkNode();
  success(`Node.js ${process.versions.node}`);
  ensureOwner('setup');
  acquireLock('install');
  fs.mkdirSync(LOG_DIR, { recursive: true });

  connectToGitHub();

  step('Installing dependencies (this can take a minute)');
  const before = await serverStatus(readConfig());
  if (before.running) {
    // Its files are about to be replaced (on Windows they can't be while it runs). Started again at the end.
    info('Stopping the running app while its files are replaced; it is started again at the end.');
    await stopServer(readConfig());
  }
  installDependencies();
  success('Dependencies installed.');

  step('Settings');
  const existed = fs.existsSync(CONFIG_FILE);
  const config = writeConfig({ PORT: options.port, HOST: options.host });
  success(
    `${existed ? 'Using' : 'Created'} ${path.relative(ROOT, CONFIG_FILE)}: port ${config.PORT || '3001'}, ` +
      `${config.HOST === '0.0.0.0' ? 'open to your network' : 'this computer only'}.`,
  );
  info(dim('Edit config.env to change the port, network access or data folder.'));

  step('Building the web app');
  buildClient();
  success('Web app built.');

  step('Data');
  const data = dataDir(config);
  const hasData = fs.existsSync(path.join(data, 'app.db'));
  let demo = options.demo;
  if (hasData) {
    if (demo) {
      const asked = !options.yes && process.stdin.isTTY;
      demo = await ask('Replace ALL existing classes, accounts and submissions with demo data?', false);
      if (!demo && !asked) {
        info(
          'Existing data found, so the demo data was not loaded (run the installer in a terminal without --yes ' +
            `to be asked, or use ${COMMANDS.seed}).`,
        );
      }
    }
    if (!demo) info(`Keeping your existing data in ${data}`);
  } else if (demo === undefined) {
    demo = await ask('Load demo data (a sample teacher, students and graded assignments) to try things out?', false);
  }
  if (demo) {
    if (hasData) {
      const backup = await backupData(config, 'before-demo');
      if (backup) success(`Backed up the current data to ${backup}`);
    }
    run(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'src/seed.ts', '--yes'], {
      cwd: path.join(ROOT, 'server'),
      env: { DATA_DIR: data, EXCEL_AUTOGRADER_INSTALLER: '1', NODE_ENV: undefined },
    });
  } else if (!hasData) {
    info('Starting with an empty database. Open the app and choose "Create an account" to make the first teacher.');
  }

  step('Starting Excel Autograder');
  let started = false;
  if (before.running) {
    info('It was running before, so it is started again.');
    await startServer(config);
    started = true;
  } else if (options.start ?? (await ask('Start Excel Autograder now?', true))) {
    await startServer(config);
    started = true;
  } else {
    info('Not started.');
  }

  const url = bold(appUrl(config));
  console.log(
    started
      ? `\n${bold('All set!')} Open ${url} in your browser.\n`
      : `\n${bold('All set!')} Start the app with ${bold(COMMANDS.start)}, then open ${url} in your browser.\n`,
  );
  const caller = process.env.EXCEL_AUTOGRADER_CALLER_CWD;
  if (caller && !samePath(caller, ROOT)) {
    console.log('  First go to the app folder:');
    console.log(`    ${bold(`cd "${ROOT}"`)}\n`);
    console.log('  Then, in that folder:');
  } else {
    console.log('  Run these in this folder:');
  }
  const rows = [
    [COMMANDS.start, 'start in the background'],
    [COMMANDS.stop, 'stop'],
    [COMMANDS.status, 'is it running?'],
    [COMMANDS.update, 'get the latest version from GitHub'],
  ];
  const width = Math.max(...rows.map(([command]) => command.length)) + 2;
  for (const [command, what] of rows) console.log(`    ${bold(command.padEnd(width))}${what}`);
  if (IS_WINDOWS) console.log(dim('  (You can also double-click start-app.cmd, stop-app.cmd and update.cmd in that folder.)'));
  console.log(dim(`\n  Folder: ${ROOT}`));
  console.log(dim(`  The app does not start by itself after the computer restarts; run ${COMMANDS.start} again.\n`));
});
