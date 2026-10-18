/**
 * `npm run seed`: resets the database and uploads in DATA_DIR (default server/data) and fills them with a demo
 * teacher, students, classes, assignments and autograded submissions.
 * `npm run seed -- --samples` also rewrites the sample workbooks in samples/. They are committed to git, so this
 * is off by default: rewriting them would leave an installed copy with local changes that block `update`.
 * When the database holds accounts that are not demo accounts, it asks first (`--yes` skips the question).
 *
 * The environment and the question come before anything changes, so a refused run changes nothing.
 */
import readline from 'node:readline/promises';

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed: NODE_ENV is "production" and seeding deletes every class, account and upload.');
  process.exit(1);
}

const { DATA_DIR, db } = await import('./db.js');

const { realAccounts } = db
  .prepare("SELECT count(*) AS realAccounts FROM users WHERE email NOT LIKE '%@demo.test'")
  .get() as { realAccounts: number };
if (realAccounts > 0 && !process.argv.includes('--yes')) {
  const warning =
    `${DATA_DIR} has ${realAccounts} account(s) that are not demo accounts. Seeding deletes them, ` +
    'with every class, assignment, submission and uploaded workbook.';
  if (!process.stdin.isTTY) {
    console.error(`Refusing to seed: ${warning}\nRun it again with --yes to go ahead.`);
    process.exit(1);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${warning}\nType "delete" to go ahead: `);
  rl.close();
  if (answer.trim().toLowerCase() !== 'delete') {
    console.log('Nothing was changed.');
    process.exit(1);
  }
}

const { SAMPLES_DIR, seedDemoData, writeSamples } = await import('./demo/seed.js');

console.log('Excel Autograder demo seed');
console.log(`This replaces everything in ${DATA_DIR} (database and uploaded files) with demo data.`);

const started = Date.now();
const { accounts, joinCodes } = await seedDemoData();
if (process.argv.includes('--samples')) writeSamples();

const columns = ['role', 'name', 'email', 'password'] as const;
const widths = columns.map((key) => Math.max(...accounts.map((a) => a[key].length)));

console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s. Demo accounts:\n`);
for (const a of accounts) {
  const cells = columns.map((key, i) => a[key].padEnd(widths[i]));
  console.log(`  ${[...cells, a.note].join('  ')}`.trimEnd());
}
console.log(`\nJoin codes: ${joinCodes.map((c) => `${c.name} ${c.joinCode}`).join(', ')}`);
console.log(`Sample workbooks to try uploading by hand: ${SAMPLES_DIR}`);
// The installer starts the app itself right after seeding.
if (!process.env.EXCEL_AUTOGRADER_INSTALLER) {
  console.log('\nStart the app with `npm run dev` (development) or `npm start` (installed copy).');
  console.log('(If it was already running, just sign in again: sessions were cleared.)');
}
