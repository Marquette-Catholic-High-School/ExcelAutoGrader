/**
 * Sets up (or re-sets up) this copy of Excel Autograder: dependencies, settings, web app build, optional demo
 * data, and starts the app. Safe to run again: existing data and config.env are kept.
 * Normally started by install.sh / install.ps1; can also be run as `npm run setup`.
 *
 *   --demo           load the demo teacher, students and assignments (replaces existing data after asking)
 *   --no-demo        start with an empty database (default when not asked interactively)
 *   --port <n>       port to listen on (saved in config.env; default 80 on Windows and Linux, 3001 on macOS)
 *   --host <ip>      0.0.0.0 (other computers on the network too; default on Windows and Linux) or
 *                    127.0.0.1 (this computer only; default on macOS)
 *   --start          start the app at the end without asking (default when it was already running)
 *   --no-start       don't start the app at the end
 *   --yes            accept the defaults without asking
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  COMMANDS,
  CONFIG_FILE,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_REPO,
  IS_WINDOWS,
  LOG_DIR,
  ROOT,
  ScriptError,
  acquireLock,
  addFirewallRule,
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
  firewallCommands,
  firewallStatus,
  grantLowPortPermission,
  info,
  installDependencies,
  isElevated,
  isNetworkHost,
  probePort,
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

/**
 * Checks the app may listen on its port before starting it. On Linux, ports below 1024 (such as 80) need a
 * permission that is offered here. Returns false when the port can't be used; the reason has been shown.
 */
async function preparePort(config, ask) {
  const port = Number(config.PORT || DEFAULT_PORT);
  const host = config.HOST || DEFAULT_HOST;
  const code = await probePort(port, host);
  if (!code) {
    success(`Port ${port} can be used.`);
    return true;
  }
  const other = port === 80 ? 8080 : port + 1;
  if (code === 'EACCES' && process.platform === 'linux' && port < 1024) return grantLowPortPermission(port, host, ask);
  if (code === 'EADDRINUSE' || (code === 'EACCES' && IS_WINDOWS && port < 1024)) {
    // Windows reports a port held by HTTP.sys (IIS, BranchCache, ...) as "access denied".
    warn(`Port ${port} is already used by another program${port === 80 ? ' (often another web server)' : ''}.`);
    if (IS_WINDOWS) {
      warn('On Windows this is usually IIS or another service that uses HTTP.sys (netstat shows PID 4 "System").');
      warn('To see which: netsh http show servicestate');
    }
    warn(`Stop that program, or run the installer again with --port ${other}.`);
    return false;
  }
  if (code === 'EACCES' && process.platform === 'darwin' && port < 1024) {
    warn(`On macOS, port ${port} only works when other computers may open the app: use --host 0.0.0.0, or another port.`);
    return false;
  }
  warn(`This computer does not allow the app to use port ${port} (${code}). Run the installer again with --port ${other}.`);
  return false;
}

/**
 * Other computers can only connect if the firewall lets them. On Windows this offers to add a rule (one UAC
 * prompt); it runs before anything listens on the network, because a listening program without a rule makes
 * Windows show its firewall pop-up, whose "Cancel" creates Block rules that override any Allow rule.
 */
async function openFirewall(config, ask) {
  const port = config.PORT || DEFAULT_PORT;
  if (!isNetworkHost(config.HOST)) return;
  if (!IS_WINDOWS) {
    const firewalld = spawnState('firewall-cmd', ['--state']) === 'running';
    if (firewalld) {
      warn(`The firewall (firewalld) is on. To let other computers in: sudo firewall-cmd --permanent --add-port=${port}/tcp` +
        ' && sudo firewall-cmd --reload');
    } else if (fs.existsSync('/usr/sbin/ufw')) {
      info(dim(`If the ufw firewall is on, let other computers in with: sudo ufw allow ${port}/tcp`));
    }
    return;
  }
  let status = firewallStatus(port);
  if (status.known && (!status.allow || status.block.length > 0)) {
    if (status.block.length > 0) {
      warn(`Windows Firewall has rules that block Node.js (${status.block.join(', ')}), probably from an earlier pop-up.`);
    }
    const elevated = isElevated();
    // The UAC prompt needs someone at the screen; never leave an unattended install waiting on it.
    if (elevated || process.stdin.isTTY) {
      const allow =
        elevated ||
        (await ask(`Let other computers through Windows Firewall on port ${port}? (Windows asks for administrator permission)`, true));
      if (allow) {
        addFirewallRule(port, elevated);
        status = firewallStatus(port);
      }
    }
  }
  if (status.known && status.allow && status.block.length === 0) {
    success(`Windows Firewall lets other computers reach port ${port} on domain and private networks.`);
  } else {
    warn('Other computers may be blocked by Windows Firewall. To allow them, run in an administrator PowerShell:');
    for (const command of firewallCommands(port)) info(command);
  }
  if (status.public.length > 0) {
    warn(`Windows treats ${status.public.map((name) => `"${name}"`).join(', ')} as a Public network, where the rule does not`);
    warn('apply, so other computers stay blocked there. If it is your school network, set it to Private: Settings >');
    warn('Network & internet > (the network) > Network profile type > Private, or in an administrator PowerShell:');
    for (const name of status.public) info(`Set-NetConnectionProfile -Name "${name}" -NetworkCategory Private`);
  }
}

/** Runs a command and returns its trimmed output, or '' when it can't run (used for optional checks). */
function spawnState(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return result.error ? '' : (result.stdout || '').trim();
}

/** Addresses other computers can use: the computer's name and its IPv4 addresses on the local network. */
function networkAddresses(port) {
  const suffix = Number(port) === 80 ? '' : `:${port}`;
  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => `http://${entry.address}${suffix}`);
  return [`http://${os.hostname()}${suffix}`, ...ips];
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
  let host = options.host;
  if (host === undefined && !existed) {
    const network = await ask(
      'Should other computers on your network be able to open the app (needed to host it for your students)?',
      DEFAULT_HOST === '0.0.0.0',
    );
    host = network ? '0.0.0.0' : '127.0.0.1';
  }
  const config = writeConfig({ PORT: options.port, HOST: host });
  const port = config.PORT || DEFAULT_PORT;
  success(
    `${existed ? 'Using' : 'Created'} ${path.relative(ROOT, CONFIG_FILE)}: port ${port}, ` +
      `${isNetworkHost(config.HOST) ? 'open to your network' : 'this computer only'}.`,
  );
  if (existed && options.port === undefined && port !== DEFAULT_PORT) {
    info(dim(`New installs here use port ${DEFAULT_PORT}. To switch this copy, run the installer with --port ${DEFAULT_PORT}.`));
  }
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

  step('Network');
  // Windows: firewall rule first (see openFirewall). Elsewhere the port permission comes first.
  if (IS_WINDOWS) await openFirewall(config, ask);
  const portReady = await preparePort(config, ask);
  if (!IS_WINDOWS && portReady) await openFirewall(config, ask);

  step('Starting Excel Autograder');
  let started = false;
  if (!portReady) {
    info(`Not started yet: port ${port} can't be used (see above). Start it with ${COMMANDS.start} once that is fixed.`);
  } else if (before.running) {
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
      : portReady
        ? `\n${bold('All set!')} Start the app with ${bold(COMMANDS.start)}, then open ${url} in your browser.\n`
        : `\n${bold('Installed, but not started:')} fix the port problem above, then run ${bold(COMMANDS.start)}.\n`,
  );
  if (isNetworkHost(config.HOST)) {
    console.log('  From other computers, open one of these (the name works if your network knows it):');
    for (const address of networkAddresses(port)) console.log(`    ${bold(address)}`);
    console.log('');
  }
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
