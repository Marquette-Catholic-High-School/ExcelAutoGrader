/**
 * Start/stop the installed app (npm start, npm stop, npm restart, npm run status, npm run serve; on Windows also
 * start-app.cmd, stop-app.cmd, restart-app.cmd and status-app.cmd).
 *
 *   node scripts/service.mjs start     run in the background (log: logs/server.log)
 *   node scripts/service.mjs stop
 *   node scripts/service.mjs restart
 *   node scripts/service.mjs status    exit code 0: running, 3: not running, 1: not answering / something else
 *   node scripts/service.mjs run       run in this terminal until Ctrl+C
 *
 * Settings come from config.env (PORT, HOST, DATA_DIR). Uses the built web app in client/dist.
 */
import {
  COMMANDS,
  LOG_FILE,
  ScriptError,
  acquireLock,
  bold,
  checkNode,
  checkPortPermission,
  ensureOwner,
  info,
  readConfig,
  runMain,
  serveForeground,
  serverStatus,
  startServer,
  stopServer,
  success,
  warn,
} from './lib.mjs';

const ACTIONS = ['start', 'stop', 'restart', 'status', 'run'];

runMain(async () => {
  checkNode();
  const action = process.argv[2];
  if (!ACTIONS.includes(action)) {
    throw new ScriptError(`Usage: node scripts/service.mjs <${ACTIONS.join('|')}>`);
  }
  if (action !== 'status') ensureOwner(`"${action}"`);
  // Not while an install or update is replacing the app's files (status and run don't change anything).
  if (['start', 'stop', 'restart'].includes(action)) acquireLock(action);
  const config = readConfig();
  switch (action) {
    case 'start':
      await startServer(config);
      info(`Log file: ${LOG_FILE}`);
      break;
    case 'stop':
      if (!(await stopServer(config))) info('Excel Autograder is not running.');
      break;
    case 'restart':
      await checkPortPermission(config);
      await stopServer(config);
      await startServer(config);
      break;
    case 'status': {
      const status = await serverStatus(config);
      if (status.running && status.healthy) {
        success(`Running at ${bold(status.url)} (process ${status.pid}).`);
      } else if (status.running) {
        warn(`Process ${status.pid} is running but not answering. See ${LOG_FILE}.`);
        process.exitCode = 1;
      } else if (status.answering) {
        warn(`Something is answering at ${status.url}, but it was not started by ${COMMANDS.start}.`);
        process.exitCode = 1;
      } else {
        info(`Excel Autograder is not running. Start it with: ${COMMANDS.start}`);
        process.exitCode = 3;
      }
      break;
    }
    case 'run':
      await serveForeground(config);
      break;
  }
});
