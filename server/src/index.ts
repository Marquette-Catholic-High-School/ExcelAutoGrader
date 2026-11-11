import { createApp } from './app.js';
import { db } from './db.js';
import { describeEmailSetup } from './services/email/config.js';
import { startScheduler, stopScheduler } from './services/email/notifications.js';
import { startWorker, stopWorker } from './services/email/outbox.js';
import { stopRenderPool } from './services/reports/render.js';

const PORT = Number(process.env.PORT ?? 3001);
// 127.0.0.1 keeps the app reachable from this computer only; set HOST=0.0.0.0 to serve your local network.
const HOST = process.env.HOST || '127.0.0.1';

// Express 5 hands listen errors (port taken, not allowed) to this callback instead of throwing.
const server = createApp().listen(PORT, HOST, (err?: Error) => {
  if (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const reason =
      code === 'EADDRINUSE'
        ? 'the port is already used by another program'
        : code === 'EACCES'
          ? 'this computer does not allow the app to use that port'
          : err.message;
    console.error(`Could not listen on ${HOST}:${PORT}: ${reason}. Change PORT (in config.env for an installed copy).`);
    process.exit(1);
  }
  const shown = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST;
  console.log(`Excel Autograder listening on http://${shown}:${PORT}`);
  // Background email: the worker sends the outbox, the scheduler queues overdue reminders and daily reports.
  console.log(describeEmailSetup());
  startWorker();
  startScheduler();
});

/**
 * Stops accepting requests and the email worker and scheduler, lets running requests and an email being sent finish
 * (up to a few seconds), then closes the database, which checkpoints and removes its -wal file, so the data folder
 * holds one self-contained app.db afterwards.
 */
let stopping = false;
function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, shutting down.`);
  stopScheduler();
  void stopRenderPool();
  const emailStopped = stopWorker().catch((err) => console.error('Stopping the email worker failed:', err));
  const finish = () => {
    try {
      db.close();
    } catch {
      // already closed
    }
    process.exit(0);
  };
  server.close(() => void emailStopped.finally(finish));
  server.closeIdleConnections();
  setTimeout(() => server.closeAllConnections(), 3000).unref();
  setTimeout(finish, 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
