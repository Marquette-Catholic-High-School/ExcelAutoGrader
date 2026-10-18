/**
 * `npm run backup`: copies the database and every uploaded workbook into <data folder>/backups/full-<time>/.
 * `npm run backup -- <folder>` puts the copy into that folder instead (e.g. a USB drive or a synced folder).
 * Safe while the app is running. Put a copy back with `npm run restore`.
 */
import path from 'node:path';
import { COMMANDS, backupData, checkNode, info, readConfig, runMain, success } from './lib.mjs';

runMain(async () => {
  checkNode();
  const destination = process.argv[2];
  if (destination === '--help' || destination === '-h') {
    console.log('Usage: npm run backup [-- <folder>]');
    return;
  }
  const target = await backupData(readConfig(), 'full', destination ? path.resolve(destination) : null);
  if (!target) {
    info('There is no data yet, so there is nothing to back up.');
    return;
  }
  success(`Backed up the database and uploaded workbooks to ${target}`);
  info(`To put it back later: ${COMMANDS.restore} -- "${target}"`);
});
