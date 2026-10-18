/**
 * Puts back a backup of the database (and, for a full backup, the uploaded workbooks).
 *
 *   npm run restore                      list the backups, newest first
 *   npm run restore -- latest            restore the newest one
 *   npm run restore -- <n>               restore number <n> from the list
 *   npm run restore -- <file or folder>  restore a backup file (.db) or a folder made by npm run backup
 *   --yes                                don't ask
 *
 * Stops the app if it is running, moves the current database (with its -wal/-shm files) and, for a full backup,
 * the uploads folder into <data folder>/backups/before-restore-<time>/, puts the backup in place, checks it and
 * starts the app again. Never copy a backup over app.db by hand: a leftover app.db-wal file corrupts it.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  COMMANDS,
  ScriptError,
  acquireLock,
  backupsDir,
  bold,
  checkNode,
  confirm,
  dataDir,
  dim,
  ensureOwner,
  info,
  readConfig,
  restoreDatabase,
  runMain,
  serverStatus,
  startServer,
  step,
  stopServer,
  success,
} from './lib.mjs';

function listBackups(config) {
  const dir = backupsDir(config);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    // after-failed-update-*: the database as a failed new version left it; kept for diagnosis, not for restoring.
    .filter((name) => !name.startsWith('after-failed-update-'))
    .map((name) => {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isFile() && name.endsWith('.db')) return { name, file: full, uploads: null, mtime: stat.mtimeMs, size: stat.size };
      const db = path.join(full, 'app.db');
      if (stat.isDirectory() && fs.existsSync(db)) {
        const uploads = path.join(full, 'uploads');
        return { name, file: db, uploads: fs.existsSync(uploads) ? uploads : null, mtime: stat.mtimeMs, size: fs.statSync(db).size };
      }
      return null;
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
}

function choose(arg, backups) {
  if (arg === 'latest') return backups[0] ?? null;
  if (/^\d+$/.test(arg)) return backups[Number(arg) - 1] ?? null;
  const target = path.resolve(arg);
  if (!fs.existsSync(target)) return null;
  if (fs.statSync(target).isDirectory()) {
    const file = path.join(target, 'app.db');
    if (!fs.existsSync(file)) return null;
    const uploads = path.join(target, 'uploads');
    return { name: target, file, uploads: fs.existsSync(uploads) ? uploads : null };
  }
  return { name: target, file: target, uploads: null };
}

runMain(async () => {
  checkNode();
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*|^ \* ?/gm, ''));
    return;
  }
  const yes = args.includes('--yes') || args.includes('-y');
  const arg = args.find((a) => !a.startsWith('-'));
  const config = readConfig();
  const backups = listBackups(config);

  if (!arg) {
    if (backups.length === 0) {
      info(`There are no backups in ${backupsDir(config)} yet.`);
      return;
    }
    console.log(`\nBackups in ${backupsDir(config)}, newest first:\n`);
    backups.forEach((b, i) => {
      const when = new Date(b.mtime).toLocaleString();
      const kind = b.uploads ? 'database + uploads' : 'database';
      console.log(`  ${String(i + 1).padStart(2)}  ${b.name.padEnd(48)} ${dim(`${when}, ${kind}, ${(b.size / 1024).toFixed(0)} KB`)}`);
    });
    console.log(`\nRestore one with: ${bold(`${COMMANDS.restore} -- <number>`)} (or latest)\n`);
    return;
  }

  const chosen = choose(arg, backups);
  if (!chosen) throw new ScriptError(`No backup "${arg}". Run ${COMMANDS.restore} to list them.`);
  ensureOwner('restore');
  acquireLock('restore');

  info(`Backup: ${chosen.file}${chosen.uploads ? ' (with uploaded workbooks)' : ''}`);
  info(`Data folder: ${dataDir(config)}`);
  if (!yes) {
    if (!process.stdin.isTTY) throw new ScriptError('Add --yes to restore without a terminal.');
    const what = chosen.uploads ? 'database and uploaded workbooks' : 'database';
    if (!(await confirm(`Replace the current ${what} with this backup? (The current one is kept.)`, false))) {
      throw new ScriptError('Nothing was changed.');
    }
  }

  const { running } = await serverStatus(config);
  if (running) {
    step('Stopping Excel Autograder');
    await stopServer(config);
  }
  step('Restoring');
  const aside = await restoreDatabase(chosen.file, config, { uploadsFrom: chosen.uploads });
  success(`Restored ${chosen.file}`);
  info(`The data it replaced is in ${aside}`);
  if (running) {
    step('Starting Excel Autograder');
    await startServer(config);
  } else {
    info(`Start the app with: ${COMMANDS.start}`);
  }
});
