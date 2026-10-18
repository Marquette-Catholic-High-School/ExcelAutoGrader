/**
 * `npm run seed` in the install (or project) folder: replaces everything in the data folder with demo data (see
 * server/src/seed.ts). Uses DATA_DIR from config.env in an installed copy. It asks before deleting accounts that
 * are not demo accounts, and in an installed copy it first backs up the database and uploaded workbooks into
 * <data folder>/backups/before-seed-<time>/.
 *
 *   --samples   also rewrite the sample workbooks in samples/ (for development)
 *   --yes       don't ask
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  CONFIG_FILE,
  ROOT,
  ScriptError,
  acquireLock,
  backupData,
  checkNode,
  confirm,
  dataDir,
  ensureOwner,
  readConfig,
  run,
  runMain,
  success,
} from './lib.mjs';

async function countRealAccounts(file) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  try {
    return db.prepare("SELECT count(*) AS n FROM users WHERE email NOT LIKE '%@demo.test'").get().n;
  } catch {
    return 0;
  } finally {
    db.close();
  }
}

runMain(async () => {
  checkNode();
  const args = process.argv.slice(2);
  const yes = args.includes('--yes') || args.includes('-y');
  const installed = fs.existsSync(CONFIG_FILE);
  const config = readConfig();
  const data = dataDir(config);
  const database = path.join(data, 'app.db');
  if (installed) {
    ensureOwner('seed');
    acquireLock('seed');
  }
  if (fs.existsSync(database)) {
    const real = await countRealAccounts(database);
    if (real > 0 && !yes) {
      const warning = `${data} has ${real} account(s) that are not demo accounts. Seeding deletes them, with every class, assignment, submission and uploaded workbook.`;
      if (!process.stdin.isTTY) throw new ScriptError(`${warning}\n       Run it again with --yes to go ahead.`);
      console.log(`    ${warning}`);
      if (!(await confirm('Delete them and load the demo data?', false))) throw new ScriptError('Nothing was changed.');
    }
    if (installed) {
      const backup = await backupData(config, 'before-seed');
      if (backup) success(`Backed up the current data to ${backup}`);
    }
  }
  const passOn = args.filter((arg) => arg !== '--yes' && arg !== '-y');
  run(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'src/seed.ts', '--yes', ...passOn], {
    cwd: path.join(ROOT, 'server'),
    env: { DATA_DIR: data },
  });
});
