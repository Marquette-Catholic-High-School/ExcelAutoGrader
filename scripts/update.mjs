/**
 * Updates this copy of Excel Autograder to the latest version on GitHub. Normally started by update.sh /
 * update.ps1 / update.cmd; can also be run as `npm run update`.
 *
 * 1. Checks GitHub for a new version (nothing else happens when you are already up to date).
 * 2. Downloads it, reinstalls dependencies if they changed (stopping the app for that), and builds the new web
 *    app next to the current one, while the app keeps running.
 * 3. Stops the app, backs up the database to <data folder>/backups (the newest ten are kept), switches to the
 *    new web app and starts the new version, if the app was running.
 * If any step fails, the previous version is put back and started again; if the new version had already
 * started, the database is put back from the backup made in step 3. config.env and the data folder are never
 * part of an update.
 *
 *   --check            only report whether an update is available (exit code 0: up to date, 100: available)
 *   --force            reinstall dependencies, rebuild and restart even when already up to date
 *   --no-restart       leave the running app alone (restart it yourself soon; ignored when dependencies change)
 *   --discard-changes  set aside edits made to the app's own files in this folder (asks first unless --yes)
 *   --reset-to-github  switch to GitHub's version even though this copy has commits that GitHub doesn't have,
 *                      e.g. after GitHub's history was rewritten (asks first unless --yes)
 *   --yes              don't ask questions
 */
// How an update is split between versions: this (old) copy fetches and moves the files to the new version,
// then runs the NEW copy's update.mjs with --continue-from <previous commit>, so the new version installs,
// builds and starts itself. The new copy records its progress in logs/update-state.json; if it fails, this
// old copy puts everything back, because it knows how the previous version is built and started. Future
// versions must keep accepting --continue-from and keep the state file's fields.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  COMMANDS,
  IS_WINDOWS,
  LOG_DIR,
  ROOT,
  ScriptError,
  acquireLock,
  backupDatabase,
  bold,
  buildClient,
  checkNode,
  confirm,
  dataDir,
  dim,
  discardClientBuild,
  ensureOwner,
  git,
  gitPaths,
  info,
  installDependencies,
  lockEnv,
  markFailedUpdateBackup,
  readConfig,
  red,
  restoreDatabase,
  run,
  runMain,
  samePath,
  serverStatus,
  startServer,
  step,
  stopServer,
  success,
  swapClientBuild,
  timestamp,
  uniquePath,
  warn,
} from './lib.mjs';

const STATE_FILE = path.join(LOG_DIR, 'update-state.json');
const EXIT_UPDATE_AVAILABLE = 100;

function parseArgs(argv) {
  const options = {
    check: false,
    force: false,
    restart: true,
    discard: false,
    resetToGitHub: false,
    yes: false,
    continueFrom: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') options.check = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--no-restart') options.restart = false;
    else if (arg === '--discard-changes') options.discard = true;
    else if (arg === '--reset-to-github') options.resetToGitHub = true;
    else if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--continue-from' && /^[0-9a-f]{7,64}$/.test(argv[i + 1] ?? '')) options.continueFrom = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*|^ \* ?/gm, ''));
      process.exit(0);
    } else throw new ScriptError(`Unknown option "${arg}". Run with --help to see the options.`);
  }
  return options;
}

const describe = (ref) => git(['log', '-1', '--format=%h (%cd) %s', '--date=short', ref]);
const count = (range) => Number(git(['rev-list', '--count', range]));
const exists = (file) => {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
};

/** Files that, when changed, mean dependencies must be reinstalled. */
const DEPENDENCY_FILES = ['package-lock.json', 'package.json', 'server/package.json', 'client/package.json'];

function dependenciesChanged(from, to) {
  return git(['diff', '--name-only', from, to, '--', ...DEPENDENCY_FILES]) !== '';
}

/* ------------------------------------------------------------------ */
/* State shared with the new version's update.mjs                     */
/* ------------------------------------------------------------------ */

function readState(runId) {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return state.run === runId ? state : null;
  } catch {
    return null;
  }
}

function saveState(state) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, STATE_FILE);
}

function newState(previous, target, wasRunning) {
  return {
    run: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    previous,
    target,
    wasRunning,
    // Set just before each step starts, so a crash halfway is undone too.
    depsTouched: false,
    oldStopped: false,
    backup: null,
    distSwapped: false,
    newStarted: false,
    result: 'running',
  };
}

/* ------------------------------------------------------------------ */
/* Checks before anything changes                                     */
/* ------------------------------------------------------------------ */

const notACheckout = () =>
  new ScriptError(
    `${ROOT} was not downloaded with git (for example, it came from a ZIP file), so it cannot update itself.\n` +
      `       Run the installer in this folder once (${COMMANDS.install}): it connects the folder to GitHub and ` +
      'keeps your data and settings.',
  );

function ensureRepository() {
  const result = run('git', ['rev-parse', '--show-toplevel'], { capture: true, allowFail: true });
  const stderr = (result.stderr ?? '').trim();
  if (result.status !== 0) {
    if (/dubious ownership/i.test(stderr)) {
      throw new ScriptError(
        `Git refuses to work in ${ROOT} because the folder belongs to another account.\n` +
          '       Run the update as the account that installed the app.',
      );
    }
    if (/not a git repository/i.test(stderr)) throw notACheckout();
    throw new ScriptError(`Git could not read ${ROOT}:\n${stderr}`);
  }
  if (!samePath(result.stdout.trim(), ROOT)) throw notACheckout();
  const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFail: true });
  if (!branch) throw new ScriptError('This copy is not on a branch (detached HEAD). Run "git checkout main" first.');
  const upstream =
    git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { allowFail: true }) ||
    `origin/${branch}`;
  return { branch, upstream, remote: upstream.split('/')[0] };
}

function fetchUpstream(remote, upstream) {
  const result = run('git', ['fetch', '--prune', remote], {
    capture: true,
    allowFail: true,
    env: { GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.status === 0) {
    if (git(['rev-parse', '--verify', '--quiet', upstream], { allowFail: true })) return;
    throw new ScriptError(`GitHub has no "${upstream.slice(remote.length + 1)}" branch for this app any more.`);
  }
  const url = git(['remote', 'get-url', remote], { allowFail: true }) || remote;
  const detail = (result.stderr ?? '').trim().split('\n').slice(-3).join('\n');
  throw new ScriptError(
    `Could not reach GitHub (${url}) to check for a new version. Nothing was changed.\n` +
      "       Check this computer's internet connection and try again.\n" +
      dim(detail),
  );
}

/** True when `sha` was GitHub's latest version at some point (so commits "only here" mean GitHub was rewritten). */
function wasPublished(sha, upstream) {
  const result = run('git', ['reflog', 'show', '--format=%H', `refs/remotes/${upstream}`], {
    capture: true,
    allowFail: true,
  });
  if (result.status !== 0) return false;
  const tips = result.stdout.split('\n').filter(Boolean);
  if (tips.includes(sha)) return true;
  return tips
    .slice(0, 50)
    .some((tip) => run('git', ['merge-base', '--is-ancestor', sha, tip], { capture: true, allowFail: true }).status === 0);
}

/** Paths, relative to the install folder, that hold settings and data and must never come from GitHub. */
function protectedPaths(config) {
  const paths = ['config.env', 'logs', 'server/data'];
  const rel = path.relative(ROOT, dataDir(config));
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) paths.push(rel.split(path.sep).join('/'));
  return paths;
}

/** Git would silently overwrite ignored files (config.env, the database) if a new version contained them. */
function guardProtectedPaths(target, config) {
  const tracked = gitPaths(['ls-tree', '-r', '-z', '--name-only', target, '--', ...protectedPaths(config)]);
  if (tracked.length === 0) return;
  throw new ScriptError(
    'The new version on GitHub contains files inside your settings or data folders, so it was not installed ' +
      '(it would overwrite your settings or data):\n' +
      tracked
        .slice(0, 10)
        .map((f) => `         ${f}`)
        .join('\n') +
      '\n       Ask whoever maintains the app on GitHub to remove them.',
  );
}

function trackedChanges() {
  const text = git(['status', '--porcelain', '--untracked-files=no'], { raw: true });
  return text ? text.split('\n') : [];
}

/** Moves a file into `folder`, keeping its path relative to the install folder. */
function setAside(file, folder, { copy = false } = {}) {
  const target = path.join(folder, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (copy) fs.cpSync(path.join(ROOT, file), target, { recursive: true });
  else fs.renameSync(path.join(ROOT, file), target);
}

/**
 * Edited app files, and files in the way of files the new version adds, would make git refuse to update (or
 * would be lost). Lists them; with --discard-changes they are moved into logs/discarded-<time>/.
 */
async function handleLocalChanges(target, options) {
  const changes = trackedChanges();
  const added = gitPaths(['diff', '--name-only', '-z', '--no-renames', '--diff-filter=A', 'HEAD', target]);
  const inTheWay = added.filter((file) => exists(path.join(ROOT, file)));
  if (changes.length === 0 && inTheWay.length === 0) return added;

  if (changes.length) {
    warn('These app files were changed in this folder:');
    for (const line of changes) info(dim(line));
  }
  if (inTheWay.length) {
    warn('These files are in the way of files that the new version adds:');
    for (const file of inTheWay) info(dim(`   ${file}`));
  }
  if (!options.discard) {
    throw new ScriptError(
      'Updating would overwrite them, so nothing was updated.\n' +
        '       Run the update again with --discard-changes to move them aside into the logs folder ' +
        '(your data and config.env are not affected).',
    );
  }
  if (!options.yes) {
    if (!process.stdin.isTTY) {
      throw new ScriptError(
        'Add --yes to confirm moving those files aside when running without a terminal (for example from cron ' +
          'or Task Scheduler). Nothing was updated.',
      );
    }
    if (!(await confirm('Move these files aside and continue?', false))) throw new ScriptError('Nothing was updated.');
  }
  const folder = uniquePath(LOG_DIR, `discarded-${timestamp()}`);
  for (const file of gitPaths(['diff', '--name-only', '-z', 'HEAD'])) {
    if (exists(path.join(ROOT, file))) setAside(file, folder, { copy: true });
  }
  for (const file of inTheWay) setAside(file, folder);
  git(['reset', '--hard', 'HEAD']);
  success(`Moved aside into ${folder}`);
  return added;
}

/** Files git must replace but can't (on Windows: a sample workbook open in Excel), found before anything changes. */
function blockedFiles(target) {
  const blocked = new Set();
  for (const file of gitPaths(['diff', '--name-only', '-z', '--no-renames', 'HEAD', target])) {
    const abs = path.join(ROOT, file);
    let dir = path.dirname(abs);
    while (!exists(dir)) dir = path.dirname(dir);
    try {
      fs.accessSync(dir, fs.constants.W_OK);
    } catch {
      blocked.add(`${path.relative(ROOT, dir) || '.'}${path.sep} (folder is read-only)`);
    }
    // Elsewhere only the folder matters: a file can be replaced even while a program has it open.
    if (!IS_WINDOWS || !exists(abs) || !fs.lstatSync(abs).isFile()) continue;
    try {
      fs.closeSync(fs.openSync(abs, 'r+'));
    } catch (err) {
      if (['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) blocked.add(file);
    }
  }
  return [...blocked];
}

/** Undoes a merge that failed halfway (git can leave some files already replaced). */
function restoreTree(previous, added) {
  if (git(['rev-parse', 'HEAD']) !== previous || trackedChanges().length) git(['reset', '--hard', previous]);
  for (const file of added) fs.rmSync(path.join(ROOT, file), { force: true });
}

/* ------------------------------------------------------------------ */
/* Installing the new version (runs in the NEW copy of this script)   */
/* ------------------------------------------------------------------ */

async function applyUpdate(previous, options, state) {
  const config = readConfig();
  const wasRunning = state.wasRunning;
  const save = (changes) => saveState(Object.assign(state, changes));

  const head = git(['rev-parse', 'HEAD']);
  if (options.force || (head !== previous && dependenciesChanged(previous, head))) {
    step('Installing updated dependencies');
    if ((await serverStatus(config)).running) {
      info('Stopping the app while its dependencies are replaced.');
      save({ oldStopped: true });
      await stopServer(config);
    }
    save({ depsTouched: true });
    installDependencies();
  }

  step('Building the web app');
  buildClient({ swap: false });
  success('Web app built.');

  const restart = wasRunning && (options.restart || state.oldStopped);
  if (restart && (await serverStatus(config)).running) {
    step('Stopping Excel Autograder');
    save({ oldStopped: true });
    await stopServer(config);
  }

  step('Backing up the database');
  const backup = await backupDatabase(config);
  save({ backup });
  if (backup) success(`Saved ${backup}`);
  else info('No database yet; nothing to back up.');

  save({ distSwapped: true });
  swapClientBuild();

  if (restart) {
    step('Starting the new version');
    save({ newStarted: true });
    await startServer(config);
  }

  console.log(`\n${bold('Update complete.')} ${describe('HEAD')}`);
  if (!wasRunning) info(`The app was not running. Start it with: ${COMMANDS.start}`);
  else if (!restart) {
    warn('The app is still running the previous version, but already shows the new version\'s pages,');
    warn(`which may not work with it. Restart it soon: ${COMMANDS.restart}`);
  } else if (!options.restart) {
    warn('--no-restart was ignored: the app had to be stopped to replace its dependencies, so it was started again.');
  }
}

/** --continue-from: the new version finishing an update that the previous version started. */
async function continueUpdate(options) {
  acquireLock('update');
  const state = readState(process.env.EXCEL_AUTOGRADER_UPDATE_RUN);
  if (!state) throw new ScriptError('--continue-from is only used by the update script itself.');
  try {
    await applyUpdate(options.continueFrom, options, state);
  } catch (err) {
    saveState(Object.assign(state, { result: 'failed', error: err.message }));
    console.error(`\n${red('The update failed:')} ${err.message}`);
    process.exitCode = 1;
    return;
  }
  saveState(Object.assign(state, { result: 'done' }));
}

/** Runs the new version's update.mjs and waits for it. */
async function handOver(state, options) {
  saveState(state);
  const args = ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'scripts', 'update.mjs')];
  args.push('--continue-from', state.previous);
  if (options.force) args.push('--force');
  if (!options.restart) args.push('--no-restart');
  if (options.yes) args.push('--yes');
  // Ctrl+C stops the new version's steps; this process stays to put the previous version back.
  const ignore = () => {};
  process.on('SIGINT', ignore);
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, ...lockEnv(), EXCEL_AUTOGRADER_UPDATE_RUN: state.run },
    });
    child.on('error', () => resolve(-1));
    child.on('exit', (exitCode) => resolve(exitCode ?? -1));
  });
  process.off('SIGINT', ignore);
  return { code, state: readState(state.run) ?? state };
}

/* ------------------------------------------------------------------ */
/* Putting the previous version back (runs in the OLD copy)           */
/* ------------------------------------------------------------------ */

async function rollback(state, config) {
  const { previous } = state;
  step('Putting the previous version back');
  try {
    // Only touch the server when this update stopped the old one or started the new one: otherwise the old
    // version is still running and simply keeps running.
    if ((state.oldStopped || state.newStarted) && (await serverStatus(config)).running) await stopServer(config);
    // (With --force and no new version HEAD never moved: local edits, if any, stay as they are.)
    if (git(['rev-parse', 'HEAD']) !== previous) git(['reset', '--hard', previous]);
    if (state.depsTouched) {
      info('Reinstalling the previous dependencies.');
      installDependencies();
    }
    if (state.distSwapped) {
      info('Rebuilding the previous web app.');
      buildClient();
    } else {
      discardClientBuild();
    }
    if (state.newStarted && state.backup && fs.existsSync(state.backup)) {
      const backups = path.dirname(state.backup);
      const asideDir = uniquePath(backups, `after-failed-update-${timestamp()}`);
      await restoreDatabase(state.backup, config, { asideDir });
      state.backup = markFailedUpdateBackup(state.backup, config);
      success('Database put back as it was before the update (the new version may have changed it).');
    }
    if (state.wasRunning && !(await serverStatus(config)).running) await startServer(config);
    success(`Back on ${describe('HEAD')}.`);
    return true;
  } catch (err) {
    warn(`Could not fully restore the previous version: ${err.message}`);
    warn(
      `To recover by hand, run "git reset --hard ${previous.slice(0, 12)}" in ${ROOT}, then the installer ` +
        `(${COMMANDS.install}).`,
    );
    return false;
  }
}

function failure(state, restored) {
  return (
    `The update failed${restored ? '; the previous version was put back' : ''}.` +
    (state.backup ? `\n       Database backup from just before the update: ${state.backup}` : '')
  );
}

/* ------------------------------------------------------------------ */
/* Main                                                               */
/* ------------------------------------------------------------------ */

runMain(async () => {
  const options = parseArgs(process.argv.slice(2));
  checkNode();
  if (options.continueFrom) return continueUpdate(options);

  console.log(`${bold('\nExcel Autograder update')} ${dim(new Date().toString())}`);
  info(dim(ROOT));
  ensureOwner('update');
  acquireLock(options.check ? 'update check' : 'update');
  const { upstream, remote } = ensureRepository();

  step('Checking GitHub for a new version');
  fetchUpstream(remote, upstream);
  const current = git(['rev-parse', 'HEAD']);
  const latest = git(['rev-parse', upstream]);
  const behind = count(`HEAD..${upstream}`);
  const ahead = count(`${upstream}..HEAD`);
  info(`Installed: ${describe('HEAD')}`);

  let mode = behind > 0 ? 'merge' : null;
  if (behind > 0) {
    info(`Available: ${describe(upstream)}`);
    info(`${behind} new change(s):`);
    for (const line of git(['log', '--format=%h %s', `HEAD..${upstream}`]).split('\n').slice(0, 15)) {
      info(dim(`  ${line}`));
    }
  }
  if (ahead > 0) {
    const rewritten = wasPublished(current, upstream);
    const why = rewritten
      ? "GitHub's copy of the app was rewritten (its history changed), so this copy can't simply move forward."
      : `This copy has ${ahead} commit(s) made in this folder that are not on GitHub.`;
    if (behind === 0 && !options.resetToGitHub) {
      success(`Already up to date (${rewritten ? 'GitHub has nothing newer' : `this copy has ${ahead} commit(s) that are not on GitHub`}).`);
    } else {
      warn(why);
      const remedy = rewritten
        ? 'Your data and settings are not affected. To switch to GitHub\'s current version, run the update again ' +
          'with --reset-to-github.'
        : 'To throw those commits away and switch to GitHub\'s version, run the update again with ' +
          '--reset-to-github (your data and settings are not affected). To keep them, ask whoever made them.';
      if (options.check) {
        info(remedy);
        process.exitCode = EXIT_UPDATE_AVAILABLE;
        return;
      }
      if (!options.resetToGitHub) throw new ScriptError(`${why}\n       ${remedy}`);
      if (!options.yes) {
        if (!process.stdin.isTTY) {
          throw new ScriptError('Add --yes to confirm --reset-to-github when running without a terminal.');
        }
        if (!(await confirm(`Throw away the ${ahead} commit(s) that are only in this folder and switch to GitHub's version?`, false))) {
          throw new ScriptError('Nothing was updated.');
        }
      }
      mode = 'reset';
    }
  }

  if (!mode) {
    if (behind === 0 && ahead === 0) success('Already up to date.');
    if (options.check || !options.force) return;
  } else if (options.check) {
    info('Run the update script without --check to install it.');
    process.exitCode = EXIT_UPDATE_AVAILABLE;
    return;
  }

  const config = readConfig();
  const before = await serverStatus(config);
  const state = newState(current, latest, before.running);

  if (!mode) {
    // --force without a new version: the same steps, in this process.
    try {
      await applyUpdate(current, options, state);
      return;
    } catch (err) {
      console.error(`\n${red('The update failed:')} ${err.message}`);
      throw new ScriptError(failure(state, await rollback(state, config)));
    }
  }

  guardProtectedPaths(latest, config);
  const added = await handleLocalChanges(latest, options);
  const blocked = blockedFiles(latest);
  if (blocked.length) {
    throw new ScriptError(
      `These files can't be replaced right now, so nothing was updated:\n${blocked.map((f) => `         ${f}`).join('\n')}\n` +
        `       Close them${IS_WINDOWS ? ' (is one open in Excel?)' : ''} or make them writable, then run the update again.`,
    );
  }

  step('Downloading the new version');
  try {
    git(mode === 'reset' ? ['reset', '--hard', latest] : ['merge', '--ff-only', latest]);
  } catch (err) {
    restoreTree(current, added);
    throw new ScriptError(`Downloading the new version failed, so nothing was changed.\n${err.message}`);
  }
  success(`Now on ${describe('HEAD')}.`);

  const result = await handOver(state, options);
  if (result.code === 0) return;
  throw new ScriptError(failure(result.state, await rollback(result.state, config)));
});
