/**
 * Shared helpers for the install, update, service, backup and restore scripts. Plain Node (no dependencies), so
 * the same code runs on macOS, Linux and Windows; install.sh / install.ps1 / update.sh / update.ps1 only check
 * prerequisites and hand over to these scripts.
 *
 * Files shared between versions (an update runs the old and the new copy of these scripts one after the other,
 * so keep their formats compatible):
 *   logs/server.pid        JSON { pid, instance, startedAt } of the background server (older copies: a bare pid)
 *   logs/maintenance.lock  JSON { pid, token, command, startedAt } while an install/update/start/stop runs
 *   logs/update-state.json progress of the running update (see update.mjs)
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const IS_WINDOWS = process.platform === 'win32';
export const MIN_NODE = { major: 22, minor: 13 };
export const CONFIG_FILE = path.join(ROOT, 'config.env');
export const LOG_DIR = path.join(ROOT, 'logs');
export const LOG_FILE = path.join(LOG_DIR, 'server.log');
export const PID_FILE = path.join(LOG_DIR, 'server.pid');
export const LOCK_FILE = path.join(LOG_DIR, 'maintenance.lock');
const SERVER_DIR = path.join(ROOT, 'server');
const SERVER_ENTRY = path.join(SERVER_DIR, 'src', 'index.ts');
const CLIENT_DIR = path.join(ROOT, 'client');
const CLIENT_DIST = path.join(CLIENT_DIR, 'dist');
/** The web app is built here first and swapped in afterwards, so the running app never serves a half-built copy. */
const CLIENT_STAGING = path.join(CLIENT_DIR, 'dist.new');
const CLIENT_INDEX = path.join(CLIENT_DIST, 'index.html');
export const DEFAULT_REPO = 'https://github.com/Marquette-Catholic-High-School/ExcelAutoGrader.git';

/** What to type for each action on this computer (npm.ps1 is blocked by PowerShell's default policy on Windows). */
export const COMMANDS = IS_WINDOWS
  ? {
      start: '.\\start-app.cmd',
      stop: '.\\stop-app.cmd',
      restart: '.\\restart-app.cmd',
      status: '.\\status-app.cmd',
      serve: 'npm.cmd run serve',
      update: '.\\update.cmd',
      install: '.\\install.cmd',
      backup: 'npm.cmd run backup',
      restore: 'npm.cmd run restore',
      seed: 'npm.cmd run seed',
    }
  : {
      start: 'npm start',
      stop: 'npm stop',
      restart: 'npm restart',
      status: 'npm run status',
      serve: 'npm run serve',
      update: './update.sh',
      install: './install.sh',
      backup: 'npm run backup',
      restore: 'npm run restore',
      seed: 'npm run seed',
    };

/* ------------------------------------------------------------------ */
/* Output                                                             */
/* ------------------------------------------------------------------ */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : String(text));
export const bold = paint('1');
export const dim = paint('2');
export const green = paint('32');
export const yellow = paint('33');
export const red = paint('31');

export const step = (message) => console.log(`\n${bold('==>')} ${bold(message)}`);
export const info = (message) => console.log(`    ${message}`);
export const success = (message) => console.log(`    ${green('✔')} ${message}`);
export const warn = (message) => console.log(`    ${yellow('!')} ${message}`);

/** An expected failure with a message for the person running the script (no stack trace). */
export class ScriptError extends Error {}

/** Runs main() and turns failures into a readable message and exit code 1. */
export function runMain(main) {
  main().catch((err) => {
    if (err instanceof ScriptError) console.error(`\n${red('Error:')} ${err.message}`);
    else console.error(`\n${red('Unexpected error:')}`, err);
    process.exitCode = 1;
  });
}

/** Local time as YYYYMMDD-HHMMSS (used in backup and folder names). */
export function timestamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

/** dir/base+ext, or dir/base-2+ext, -3, ... if that already exists. */
export function uniquePath(dir, base, ext = '') {
  let candidate = path.join(dir, `${base}${ext}`);
  for (let i = 2; fs.existsSync(candidate); i++) candidate = path.join(dir, `${base}-${i}${ext}`);
  return candidate;
}

/** True when both paths name the same folder (case-insensitive where the OS is, symlinks and 8.3 names resolved). */
export function samePath(a, b) {
  try {
    return path.relative(fs.realpathSync.native(a), fs.realpathSync.native(b)) === '';
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Commands                                                           */
/* ------------------------------------------------------------------ */

const MISSING_HELP = {
  git:
    'Git is not installed (or not on PATH). Install it (Windows: winget install Git.Git or https://git-scm.com; ' +
    'macOS: xcode-select --install; Linux: your package manager), then run this again.',
  npm: 'npm is missing. Reinstall Node.js from https://nodejs.org, then run this again.',
};

/** How to start npm without a shell where possible (Windows only has npm.cmd, which needs one). */
function npmInvocation(args) {
  if (!IS_WINDOWS) return { file: 'npm', args, shell: false };
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(cli)) return { file: process.execPath, args: [cli, ...args], shell: false };
  // One command string (not an args array) so Node does not warn about unescaped arguments (DEP0190). Every
  // argument this file passes to npm is a fixed word without spaces or shell characters.
  return { file: ['npm.cmd', ...args].join(' '), args: [], shell: true };
}

/**
 * Runs a command and waits for it. Output goes to the terminal unless `capture` is set. Throws ScriptError when the
 * command fails, unless `allowFail` is set. A missing program always throws.
 */
export function run(cmd, args, { cwd = ROOT, env, capture = false, allowFail = false } = {}) {
  const invocation = cmd === 'npm' ? npmInvocation(args) : { file: cmd, args, shell: false };
  const result = spawnSync(invocation.file, invocation.args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: invocation.shell,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) {
    if (result.error.code === 'ENOENT') throw new ScriptError(MISSING_HELP[cmd] ?? `${cmd} is not installed (or not on PATH).`);
    if (allowFail) return result;
    throw new ScriptError(`Could not run ${cmd}: ${result.error.message}`);
  }
  if (result.status !== 0 && !allowFail) {
    const details = capture && result.stderr ? `\n${result.stderr.trim()}` : '';
    throw new ScriptError(`"${[cmd, ...args].join(' ')}" failed (exit code ${result.status}).${details}`);
  }
  return result;
}

/**
 * Runs git in the install folder and returns its stdout, trimmed (`raw` keeps leading spaces and NUL separators,
 * for --porcelain and -z output). Never prompts for a password: the repository is public.
 */
export function git(args, { raw = false, ...options } = {}) {
  const result = run('git', args, { capture: true, ...options, env: { GIT_TERMINAL_PROMPT: '0', ...options.env } });
  const out = result.stdout ?? '';
  return raw ? out.replace(/\s+$/, '') : out.trim();
}

/** Paths from a git command with -z output. */
export function gitPaths(args, options = {}) {
  return git(args, { raw: true, ...options }).split('\0').filter(Boolean);
}

export function checkNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor)) return;
  throw new ScriptError(
    `Node.js ${process.versions.node} is too old; Excel Autograder needs ${MIN_NODE.major}.${MIN_NODE.minor} or newer.\n` +
      '       Install the current LTS version from https://nodejs.org and run this again.',
  );
}

/** Refuses to run as another account than the folder's owner (e.g. with sudo), which would leave files it can't change. */
export function ensureOwner(action) {
  if (IS_WINDOWS || typeof process.getuid !== 'function') return;
  const uid = process.getuid();
  const owner = fs.statSync(ROOT).uid;
  if (uid === owner) return;
  const name = (id) => {
    const r = spawnSync('id', ['-un', String(id)], { encoding: 'utf8' });
    return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : `user ${id}`;
  };
  throw new ScriptError(
    `${ROOT} belongs to the account "${name(owner)}", but this ${action} is running as "${name(uid)}"` +
      `${uid === 0 ? ' (sudo or root)' : ''}.\n` +
      `       Run it as "${name(owner)}"${uid === 0 ? ' without sudo' : ''}, so the app's files keep the right owner.`,
  );
}

/**
 * Installs exactly what package-lock.json lists. --include=dev: the app needs its build tools and tsx at run
 * time, even on computers where NODE_ENV=production or an .npmrc says to leave devDependencies out.
 */
export function installDependencies() {
  const lockfile = fs.existsSync(path.join(ROOT, 'package-lock.json'));
  run('npm', [lockfile ? 'ci' : 'install', '--include=dev', '--no-audit', '--no-fund']);
}

function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      // Windows refuses while another program (a virus scanner, Explorer) has a file in the folder open.
      if (attempt >= 10 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    }
  }
}

/**
 * Builds the web app into client/dist.new. With `swap` (default) it then replaces client/dist; otherwise call
 * swapClientBuild() later. The build never touches client/dist itself, so a failed build changes nothing.
 */
export function buildClient({ swap = true } = {}) {
  discardClientBuild();
  run('npm', ['run', 'build'], { env: { EXCEL_AUTOGRADER_CLIENT_OUT_DIR: 'dist.new' } });
  if (swap) swapClientBuild();
}

/** Puts a finished client/dist.new in place of client/dist. Returns false when there is nothing to swap. */
export function swapClientBuild() {
  // A build configuration that ignores EXCEL_AUTOGRADER_CLIENT_OUT_DIR writes client/dist directly: nothing to swap.
  if (!fs.existsSync(path.join(CLIENT_STAGING, 'index.html'))) return false;
  const old = `${CLIENT_DIST}.old`;
  fs.rmSync(old, { recursive: true, force: true });
  if (fs.existsSync(CLIENT_DIST)) renameWithRetry(CLIENT_DIST, old);
  try {
    renameWithRetry(CLIENT_STAGING, CLIENT_DIST);
  } catch (err) {
    if (fs.existsSync(old) && !fs.existsSync(CLIENT_DIST)) renameWithRetry(old, CLIENT_DIST);
    throw new ScriptError(`Could not put the new web app in place: ${err.message}`);
  }
  fs.rmSync(old, { recursive: true, force: true });
  return true;
}

/** Removes a staged (unused or half-built) client/dist.new. */
export function discardClientBuild() {
  fs.rmSync(CLIENT_STAGING, { recursive: true, force: true });
}

/** Asks a yes/no question; returns the default when nobody is at a terminal (scheduled runs, CI). */
export async function confirm(question, defaultYes) {
  if (!process.stdin.isTTY) return defaultYes;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`    ${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
    return answer ? answer.startsWith('y') : defaultYes;
  } finally {
    rl.close();
  }
}

/* ------------------------------------------------------------------ */
/* One install/update/start/stop at a time                            */
/* ------------------------------------------------------------------ */

let heldLock = null;

const bootTime = () => Date.now() - os.uptime() * 1000;

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** True while the process that wrote the lock is still alive (and is not some other program that got its pid). */
function lockIsLive(holder) {
  if (!holder || !Number.isInteger(holder.pid) || !isAlive(holder.pid)) return false;
  if (typeof holder.startedAt === 'number' && holder.startedAt < bootTime() - 60_000) return false;
  const command = commandLine(holder.pid);
  if (command === null) return true;
  return /node/i.test(command);
}

/**
 * Takes logs/maintenance.lock so two installs/updates (or an update and "npm start") never run at the same time.
 * A lock left behind by a process that no longer runs is taken over. A child started with lockEnv() shares the
 * parent's lock. Released automatically when the process exits.
 */
export function acquireLock(command) {
  if (heldLock) return;
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const inherited = process.env.EXCEL_AUTOGRADER_LOCK;
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = crypto.randomUUID();
    try {
      const record = { pid: process.pid, token, command, startedAt: Date.now() };
      fs.writeFileSync(LOCK_FILE, `${JSON.stringify(record)}\n`, { flag: 'wx' });
      heldLock = { token, own: true };
      process.on('exit', releaseLock);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw new ScriptError(`Could not create ${LOCK_FILE}: ${err.message}`);
    }
    const text = readText(LOCK_FILE);
    if (text === null) continue;
    const holder = parseJson(text);
    if (inherited && holder?.token === inherited) {
      heldLock = { token: inherited, own: false };
      return;
    }
    if (lockIsLive(holder)) {
      const since = typeof holder.startedAt === 'number' ? `, started ${new Date(holder.startedAt).toLocaleString()}` : '';
      throw new ScriptError(
        `Another ${holder.command ?? 'install or update'} of Excel Autograder is already running ` +
          `(process ${holder.pid}${since}).\n       Wait for it to finish, then try again. ` +
          `(If you are sure nothing is running, delete ${LOCK_FILE}.)`,
      );
    }
    // Left behind by a process that is gone: take it over (unless someone else just did).
    if (readText(LOCK_FILE) === text) fs.rmSync(LOCK_FILE, { force: true });
  }
  throw new ScriptError(`Could not take ${LOCK_FILE}. Try again in a moment.`);
}

export function releaseLock() {
  if (!heldLock) return;
  if (heldLock.own && parseJson(readText(LOCK_FILE))?.token === heldLock.token) fs.rmSync(LOCK_FILE, { force: true });
  heldLock = null;
}

/** Environment that lets a child process share this process's lock. */
export function lockEnv() {
  return heldLock ? { EXCEL_AUTOGRADER_LOCK: heldLock.token } : {};
}

/* ------------------------------------------------------------------ */
/* Settings (config.env)                                              */
/* ------------------------------------------------------------------ */

const DEFAULT_CONFIG = `# Excel Autograder settings, read when the app starts and by the update script.
# Restart the app after changing them: ${COMMANDS.restart}

# Port the app listens on. Open http://localhost:<PORT> in a browser.
PORT=3001

# 127.0.0.1 = only this computer can open the app.
# 0.0.0.0   = other computers on your network can open it too, at http://<this computer's name or IP>:<PORT>.
#             Anyone who can reach it can create an account, so only do this on a network you trust.
HOST=127.0.0.1

# Folder for the database and uploaded workbooks. Leave empty to use server/data inside the install folder.
# A relative path is relative to the install folder; ~ means your home folder.
DATA_DIR=
`;

/** Parses config.env (KEY=VALUE lines, # comments). Missing file → {}. */
export function readConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  const config = {};
  for (const line of fs.readFileSync(CONFIG_FILE, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, '$2');
    if (value !== '') config[match[1]] = value;
  }
  return config;
}

/** Creates config.env with defaults if missing, then applies `changes` (e.g. { PORT: '8080' }). */
export function writeConfig(changes = {}) {
  let text = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, 'utf8') : DEFAULT_CONFIG;
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    const line = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');
    text = line.test(text) ? text.replace(line, `${key}=${value}`) : `${text.trimEnd()}\n${key}=${value}\n`;
  }
  fs.writeFileSync(CONFIG_FILE, text);
  return readConfig();
}

export function validatePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ScriptError(`"${value}" is not a valid port.`);
  return String(port);
}

/** The data folder: DATA_DIR from config.env (relative to the install folder, ~ = home folder) or server/data. */
export function dataDir(config = readConfig()) {
  if (!config.DATA_DIR) return path.join(SERVER_DIR, 'data');
  const expanded = config.DATA_DIR.replace(/^~(?=$|[\\/])/, os.homedir()).replace(
    /%USERPROFILE%/gi,
    os.homedir(),
  );
  return path.resolve(ROOT, expanded);
}

export function appUrl(config = readConfig()) {
  const host = !config.HOST || ['127.0.0.1', '0.0.0.0', '::', 'localhost'].includes(config.HOST) ? 'localhost' : config.HOST;
  return `http://${host}:${config.PORT || '3001'}`;
}

/** Address to probe for the health check (a wildcard bind is reachable on loopback). */
function healthUrl(config) {
  const host = !config.HOST || ['0.0.0.0', '::', 'localhost'].includes(config.HOST) ? '127.0.0.1' : config.HOST;
  return `http://${host.includes(':') ? `[${host}]` : host}:${config.PORT || '3001'}/api/health`;
}

/* ------------------------------------------------------------------ */
/* Backups                                                            */
/* ------------------------------------------------------------------ */

const KEEP_BACKUPS = 10;
const KEEP_FAILED_UPDATE_BACKUPS = 3;

export const backupsDir = (config = readConfig()) => path.join(dataDir(config), 'backups');

/** Writes a consistent copy of an SQLite database (safe while the app is running). */
async function copyDatabase(source, target) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(source);
  try {
    db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
  } finally {
    db.close();
  }
}

function pruneBackups(dir) {
  const groups = [
    { pattern: /^app-\d{8}-\d{6}(-\d+)?\.db$/, keep: KEEP_BACKUPS },
    { pattern: /^app-\d{8}-\d{6}(-\d+)?-before-failed-update\.db$/, keep: KEEP_FAILED_UPDATE_BACKUPS },
    { pattern: /^after-failed-update-\d{8}-\d{6}(-\d+)?$/, keep: 2 },
  ];
  const entries = fs.readdirSync(dir).map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }));
  for (const { pattern, keep } of groups) {
    const old = entries
      .filter((e) => pattern.test(e.name))
      .sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name))
      .slice(keep);
    for (const e of old) fs.rmSync(path.join(dir, e.name), { recursive: true, force: true });
  }
}

/**
 * Writes a consistent copy of the database to <data>/backups/app-<local time>.db and keeps the newest ten.
 * Returns the backup path, or null when there is no database yet.
 */
export async function backupDatabase(config = readConfig()) {
  const source = path.join(dataDir(config), 'app.db');
  if (!fs.existsSync(source)) return null;
  const dir = backupsDir(config);
  fs.mkdirSync(dir, { recursive: true });
  const target = uniquePath(dir, `app-${timestamp()}`, '.db');
  await copyDatabase(source, target);
  pruneBackups(dir);
  return target;
}

/** Marks an update backup as belonging to a failed update, so retries don't push the regular backups out. */
export function markFailedUpdateBackup(file, config = readConfig()) {
  if (!file || !fs.existsSync(file) || !/^app-\d{8}-\d{6}(-\d+)?\.db$/.test(path.basename(file))) return file;
  const target = file.replace(/\.db$/, '-before-failed-update.db');
  fs.renameSync(file, target);
  pruneBackups(backupsDir(config));
  return target;
}

/**
 * Copies the database and every uploaded workbook into <data>/backups/<label>-<local time>/ (or into `destination`).
 * Returns that folder, or null when there is nothing to back up yet.
 */
export async function backupData(config = readConfig(), label = 'full', destination = null) {
  const data = dataDir(config);
  const db = path.join(data, 'app.db');
  const uploads = path.join(data, 'uploads');
  if (!fs.existsSync(db) && !fs.existsSync(uploads)) return null;
  const parent = destination ?? backupsDir(config);
  fs.mkdirSync(parent, { recursive: true });
  const target = uniquePath(parent, `${label}-${timestamp()}`);
  fs.mkdirSync(target);
  if (fs.existsSync(db)) await copyDatabase(db, path.join(target, 'app.db'));
  if (fs.existsSync(uploads)) fs.cpSync(uploads, path.join(target, 'uploads'), { recursive: true });
  return target;
}

async function checkIntegrity(file) {
  const { DatabaseSync } = await import('node:sqlite');
  let db;
  try {
    db = new DatabaseSync(file);
    const rows = db.prepare('PRAGMA integrity_check').all();
    const result = rows.map((r) => Object.values(r)[0]).join('; ');
    if (result !== 'ok') throw new Error(result);
  } catch (err) {
    throw new ScriptError(`${file} is not a usable database (${err.message}).`);
  } finally {
    db?.close();
  }
}

/**
 * Replaces the database with a backup. The app must be stopped. The current app.db and its -wal/-shm files (which
 * belong together: copying a backup over app.db while an old -wal stays behind corrupts it) are moved into
 * `asideDir` (default <data>/backups/before-restore-<time>/). With `uploadsFrom`, the uploads folder is replaced
 * too. Returns the folder holding the previous files.
 */
export async function restoreDatabase(backupFile, config = readConfig(), { asideDir, uploadsFrom } = {}) {
  const data = dataDir(config);
  fs.mkdirSync(data, { recursive: true });
  const incoming = path.join(data, 'app.db.restoring');
  fs.rmSync(incoming, { force: true });
  fs.copyFileSync(backupFile, incoming);
  try {
    await checkIntegrity(incoming);
  } catch (err) {
    fs.rmSync(incoming, { force: true });
    fs.rmSync(`${incoming}-wal`, { force: true });
    fs.rmSync(`${incoming}-shm`, { force: true });
    throw err;
  }
  fs.rmSync(`${incoming}-wal`, { force: true });
  fs.rmSync(`${incoming}-shm`, { force: true });

  const aside = asideDir ?? uniquePath(backupsDir(config), `before-restore-${timestamp()}`);
  fs.mkdirSync(aside, { recursive: true });
  const moved = [];
  try {
    for (const name of ['app.db', 'app.db-wal', 'app.db-shm']) {
      const file = path.join(data, name);
      if (!fs.existsSync(file)) continue;
      renameWithRetry(file, path.join(aside, name));
      moved.push(name);
    }
    if (uploadsFrom) {
      const uploads = path.join(data, 'uploads');
      if (fs.existsSync(uploads)) {
        renameWithRetry(uploads, path.join(aside, 'uploads'));
        moved.push('uploads');
      }
      fs.cpSync(uploadsFrom, uploads, { recursive: true });
    }
    renameWithRetry(incoming, path.join(data, 'app.db'));
  } catch (err) {
    for (const name of moved.reverse()) {
      fs.rmSync(path.join(data, name), { recursive: true, force: true });
      renameWithRetry(path.join(aside, name), path.join(data, name));
    }
    fs.rmSync(incoming, { force: true });
    throw new ScriptError(`Could not restore ${backupFile}: ${err.message}`);
  }
  pruneBackups(backupsDir(config));
  return aside;
}

/* ------------------------------------------------------------------ */
/* Running the server                                                 */
/* ------------------------------------------------------------------ */

/** Environment for the production server: settings from config.env, absolute data folder. */
function serverEnv(config, instance) {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: config.PORT || '3001',
    HOST: config.HOST || '127.0.0.1',
    DATA_DIR: dataDir(config),
    EXCEL_AUTOGRADER_INSTANCE: instance,
  };
  delete env.EXCEL_AUTOGRADER_LOCK;
  return env;
}

// The absolute entry path makes this copy's server recognisable in the process list.
const serverArgs = () => ['--disable-warning=ExperimentalWarning', '--import', 'tsx', SERVER_ENTRY];

function readPidRecord() {
  const text = readText(PID_FILE);
  if (text === null) return null;
  const json = parseJson(text);
  const record = json && typeof json === 'object' ? json : { pid: Number(text.trim()) };
  return Number.isInteger(record.pid) && record.pid > 0 ? record : null;
}

function writePidRecord(record) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const tmp = `${PID_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record)}\n`);
  fs.renameSync(tmp, PID_FILE);
}

/** Removes the pid file, but only while it still names `pid` (another run may have written a new one). */
function removePidFile(pid) {
  if (readPidRecord()?.pid === pid) fs.rmSync(PID_FILE, { force: true });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * The command line of a running process: '' when there is no such process (or it can't be read), null when this
 * computer has no way to tell.
 */
function commandLine(pid) {
  if (IS_WINDOWS) {
    const ps = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}').CommandLine`,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 20_000 },
    );
    if (!ps.error && ps.status === 0) return ps.stdout.trim();
    const list = spawnSync('tasklist.exe', ['/FI', `PID eq ${Number(pid)}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (list.error || list.status !== 0) return null;
    return /^"node\.exe"/i.test(list.stdout.trim()) ? null : '';
  }
  if (fs.existsSync('/proc/self/cmdline')) {
    const text = readText(`/proc/${Number(pid)}/cmdline`);
    return text === null ? '' : text.split('\0').join(' ').trim();
  }
  const ps = spawnSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  if (ps.error) return null;
  return ps.status === 0 ? ps.stdout.trim() : '';
}

const normalizeCommand = (text) => {
  const slashes = text.replaceAll('\\', '/');
  return IS_WINDOWS || process.platform === 'darwin' ? slashes.toLowerCase() : slashes;
};

/** Asks /api/health who is answering on the configured port. */
async function probeHealth(config) {
  try {
    const res = await fetch(healthUrl(config), { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return { answering: false, instance: null };
    const body = await res.json().catch(() => ({}));
    return { answering: body?.ok === true, instance: typeof body?.instance === 'string' ? body.instance : null };
  } catch {
    return { answering: false, instance: null };
  }
}

/** True when the pid file's process is this copy's server (guards against stale pid files and reused pids). */
function isOurServer(record, health) {
  if (!isAlive(record.pid)) return false;
  if (record.instance && health.instance === record.instance) return true;
  if (typeof record.startedAt === 'number' && record.startedAt < bootTime() - 60_000) return false;
  const command = commandLine(record.pid);
  if (command === null) return true;
  const seen = normalizeCommand(command);
  return record.instance ? seen.includes(normalizeCommand(SERVER_ENTRY)) : seen.includes('src/index.ts');
}

/**
 * running: this copy's server process exists (pid in logs/server.pid); healthy: it answers on the port;
 * answering: something (maybe another program) answers /api/health on the port.
 */
export async function serverStatus(config = readConfig()) {
  const health = await probeHealth(config);
  let record = readPidRecord();
  if (record && !isOurServer(record, health)) {
    removePidFile(record.pid);
    record = null;
  }
  const healthy = Boolean(record && health.answering && (!record.instance || health.instance === record.instance));
  return {
    running: record !== null,
    pid: record?.pid ?? null,
    healthy,
    answering: health.answering,
    url: appUrl(config),
  };
}

/** The server log since the last start (earlier runs only confuse an error message). */
function logTail(lines = 30) {
  const text = readText(LOG_FILE);
  if (text === null) return '(no log yet)';
  const marker = text.lastIndexOf('\n--- ');
  return text
    .slice(marker >= 0 ? marker + 1 : 0)
    .trimEnd()
    .split('\n')
    .slice(-lines)
    .join('\n');
}

/** Fails early, with advice, when another program already uses the port. */
async function ensurePortFree(config) {
  const port = Number(config.PORT || '3001');
  const host = config.HOST || '127.0.0.1';
  const code = await new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (err) => resolve(err.code ?? 'ERROR'));
    probe.listen({ port, host, exclusive: true }, () => probe.close(() => resolve(null)));
  });
  if (!code) return;
  const where = `in ${CONFIG_FILE} (for example PORT=${port === 3001 ? 3002 : port + 1})`;
  if (code === 'EADDRINUSE') {
    throw new ScriptError(
      `Port ${port} is already used by another program.\n       Stop that program, or change PORT ${where}, then try again.`,
    );
  }
  if (code === 'EACCES') {
    throw new ScriptError(
      `This computer does not allow the app to use port ${port}` +
        `${IS_WINDOWS ? ' (Windows reserves some ports, e.g. for Hyper-V or WSL)' : ''}.\n       Change PORT ${where}, then try again.`,
    );
  }
  if (code === 'EADDRNOTAVAIL') {
    throw new ScriptError(`HOST=${host} in ${CONFIG_FILE} is not an address of this computer. Use 127.0.0.1 or 0.0.0.0.`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Starts the server in the background (log in logs/server.log) and waits until it answers. */
export async function startServer(config = readConfig()) {
  const status = await serverStatus(config);
  if (status.running) {
    for (let waited = 0; !status.healthy && waited < 15_000; waited += 500) {
      await sleep(500);
      Object.assign(status, await serverStatus(config));
      if (!status.running) break;
    }
    if (status.running && status.healthy) {
      success(`Already running at ${status.url} (process ${status.pid}).`);
      return status;
    }
    if (status.running) {
      throw new ScriptError(
        `Excel Autograder (process ${status.pid}) is running but not answering.\n` +
          `       Restart it with ${COMMANDS.restart}, or see ${LOG_FILE}.`,
      );
    }
  }
  if (status.answering) {
    throw new ScriptError(
      `Something else is already answering on port ${config.PORT || '3001'} (another copy of Excel Autograder, or a ` +
        'development server from "npm run dev"?).\n       Stop it, or change PORT in config.env, then try again.',
    );
  }
  if (!fs.existsSync(CLIENT_INDEX)) {
    throw new ScriptError(`The web app has not been built yet. Run the installer (${COMMANDS.install}) first.`);
  }
  await ensurePortFree(config);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const log = fs.openSync(LOG_FILE, 'a');
  fs.writeSync(log, `\n--- ${new Date().toString()}: starting Excel Autograder ---\n`);
  const instance = crypto.randomUUID();
  const child = spawn(process.execPath, serverArgs(), {
    cwd: SERVER_DIR,
    env: serverEnv(config, instance),
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  child.on('error', () => {});
  child.unref();
  fs.closeSync(log);
  if (!child.pid) throw new ScriptError(`Could not start ${process.execPath}.`);
  writePidRecord({ pid: child.pid, instance, startedAt: Date.now() });

  for (let waited = 0; waited < 30_000; waited += 500) {
    const health = await probeHealth(config);
    if (health.answering && health.instance === instance) {
      success(`Excel Autograder is running at ${bold(appUrl(config))} (process ${child.pid}).`);
      return serverStatus(config);
    }
    if (!isAlive(child.pid)) break;
    await sleep(500);
  }
  if (isAlive(child.pid)) {
    try {
      process.kill(child.pid);
    } catch {
      // already gone
    }
  }
  removePidFile(child.pid);
  throw new ScriptError(`The server did not start. Its log (${LOG_FILE}) says:\n\n${logTail()}`);
}

/** Stops the background server. Returns true if one was running. */
export async function stopServer(config = readConfig()) {
  const status = await serverStatus(config);
  if (!status.running) {
    if (status.answering) {
      warn(`The app on port ${config.PORT || '3001'} was not started by ${COMMANDS.start} (a development server?).`);
      warn('Stop it in the terminal where it is running (Ctrl+C).');
    }
    return false;
  }
  const signal = (name) => {
    try {
      process.kill(status.pid, name);
    } catch (err) {
      if (err.code !== 'ESRCH') throw new ScriptError(`Could not stop process ${status.pid}: ${err.message}`);
    }
  };
  // The server closes the database cleanly on SIGTERM (on Windows this ends the process at once).
  signal('SIGTERM');
  for (let waited = 0; waited < 10_000 && isAlive(status.pid); waited += 250) await sleep(250);
  if (isAlive(status.pid)) signal('SIGKILL');
  for (let waited = 0; waited < 5_000 && isAlive(status.pid); waited += 250) await sleep(250);
  if (isAlive(status.pid)) throw new ScriptError(`Process ${status.pid} did not stop.`);
  removePidFile(status.pid);
  success(`Stopped Excel Autograder (process ${status.pid}).`);
  return true;
}

/** Runs the server in this terminal until Ctrl+C. */
export async function serveForeground(config = readConfig()) {
  if (!fs.existsSync(CLIENT_INDEX)) {
    throw new ScriptError(`The web app has not been built yet. Run the installer (${COMMANDS.install}) first.`);
  }
  const status = await serverStatus(config);
  if (status.running) {
    throw new ScriptError(`Already running in the background at ${status.url}. Stop it first: ${COMMANDS.stop}`);
  }
  if (status.answering) throw new ScriptError(`Something else is already answering on port ${config.PORT || '3001'}.`);
  await ensurePortFree(config);
  const instance = crypto.randomUUID();
  const child = spawn(process.execPath, serverArgs(), { cwd: SERVER_DIR, env: serverEnv(config, instance), stdio: 'inherit' });
  writePidRecord({ pid: child.pid, instance, startedAt: Date.now() });
  const forward = (signal) => child.kill(signal);
  process.on('SIGINT', forward);
  process.on('SIGTERM', forward);
  const code = await new Promise((resolve) => child.on('exit', (exitCode) => resolve(exitCode ?? 0)));
  removePidFile(child.pid);
  process.exitCode = code;
}
