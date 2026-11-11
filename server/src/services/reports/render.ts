/**
 * Renders PDF reports in worker threads (render-worker.ts). Laying out a report is CPU work that grows with
 * students × assignments (seconds for a class of a thousand), so it must not run on the thread that answers every
 * other request. A small pool takes one report per worker; a few more may wait. Beyond that the server answers
 * "busy" (503), and one user can't have more than a couple of reports in progress (429).
 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHARE_ENV, Worker } from 'node:worker_threads';
import { HttpError } from '../../http.js';
import type { RenderJob, RenderReply, RenderRequest } from './render-worker.js';

/** Workers rendering at once. */
const POOL_SIZE = Math.max(1, Math.min(2, os.availableParallelism() - 1));
/** Reports waiting for a worker, over all users. */
const MAX_WAITING = 6;
/** Reports in progress (rendering or waiting) before the server answers "busy". */
export const MAX_IN_PROGRESS = POOL_SIZE + MAX_WAITING;
/** Reports one user may have in progress. */
export const MAX_PER_USER = 2;
/** A report that takes longer than this is given up on (its worker is stopped). */
const RENDER_TIMEOUT_MS = 120_000;
/** An idle worker is stopped after this long (it holds pdfmake and its fonts in memory). */
const IDLE_MS = 60_000;

const WORKER_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'render-worker-entry.mjs');

export const BUSY_MESSAGE = 'The server is busy making other reports. Please try again in a minute.';
export const TOO_MANY_MESSAGE = 'You already have reports being made. Wait for them to finish, then try again.';

interface Job {
  id: number;
  job: RenderJob;
  resolve: (pdf: Buffer) => void;
  reject: (err: Error) => void;
}

interface PoolWorker {
  worker: Worker;
  job: Job | null;
  timer: NodeJS.Timeout | null;
}

const workers: PoolWorker[] = [];
const waiting: Job[] = [];
const perUser = new Map<number, number>();
let nextId = 1;

function finish(slot: PoolWorker, outcome: { pdf?: Buffer; error?: Error }): void {
  const job = slot.job;
  slot.job = null;
  slot.worker.unref();
  if (slot.timer) clearTimeout(slot.timer);
  slot.timer = null;
  if (job) {
    if (outcome.error) job.reject(outcome.error);
    else job.resolve(outcome.pdf!);
  }
  dispatch();
}

function retire(slot: PoolWorker, error: Error | null): void {
  const index = workers.indexOf(slot);
  if (index >= 0) workers.splice(index, 1);
  if (slot.timer) clearTimeout(slot.timer);
  const job = slot.job;
  slot.job = null;
  void slot.worker.terminate();
  if (job) job.reject(error ?? new Error('The report could not be made.'));
  dispatch();
}

function startWorker(): PoolWorker {
  const worker = new Worker(WORKER_FILE, {
    env: SHARE_ENV,
    resourceLimits: { maxOldGenerationSizeMb: 1536 },
  });
  const slot: PoolWorker = { worker, job: null, timer: null };
  worker.on('message', (reply: RenderReply) => {
    if (!slot.job || reply.id !== slot.job.id) return;
    if ('error' in reply) finish(slot, { error: new Error(reply.error) });
    else finish(slot, { pdf: Buffer.from(reply.pdf.buffer, reply.pdf.byteOffset, reply.pdf.byteLength) });
  });
  worker.on('error', (err) => retire(slot, err));
  worker.on('exit', () => retire(slot, new Error('The report could not be made (the worker stopped).')));
  // After the listeners (adding a 'message' listener refs the worker again): an idle worker doesn't keep the process
  // alive (tests, shutdown). dispatch() refs it while it renders.
  worker.unref();
  workers.push(slot);
  return slot;
}

function idle(slot: PoolWorker): void {
  slot.timer = setTimeout(() => retire(slot, null), IDLE_MS);
  slot.timer.unref();
}

function dispatch(): void {
  while (waiting.length > 0) {
    const slot = workers.find((w) => !w.job) ?? (workers.length < POOL_SIZE ? startWorker() : null);
    if (!slot) return;
    const job = waiting.shift()!;
    if (slot.timer) clearTimeout(slot.timer);
    slot.job = job;
    slot.worker.ref();
    slot.timer = setTimeout(() => retire(slot, new HttpError(503, BUSY_MESSAGE)), RENDER_TIMEOUT_MS);
    slot.timer.unref();
    slot.worker.postMessage({ id: job.id, job: job.job } satisfies RenderRequest);
  }
  for (const slot of workers) if (!slot.job && !slot.timer) idle(slot);
}

const inProgress = () => workers.filter((w) => w.job).length + waiting.length;

/**
 * Renders the report that `build` describes for `userId`. Capacity is checked before `build` runs, so a request
 * that is turned away costs nothing (building reads the whole gradebook).
 */
export function renderReport(userId: number, build: () => RenderJob): Promise<Buffer> {
  if ((perUser.get(userId) ?? 0) >= MAX_PER_USER) return Promise.reject(new HttpError(429, TOO_MANY_MESSAGE));
  if (inProgress() >= MAX_IN_PROGRESS) return Promise.reject(new HttpError(503, BUSY_MESSAGE));
  let job: RenderJob;
  try {
    job = build();
  } catch (err) {
    return Promise.reject(err);
  }
  perUser.set(userId, (perUser.get(userId) ?? 0) + 1);
  const done = () => {
    const left = (perUser.get(userId) ?? 1) - 1;
    if (left > 0) perUser.set(userId, left);
    else perUser.delete(userId);
  };
  return new Promise<Buffer>((resolve, reject) => {
    waiting.push({ id: nextId++, job, resolve, reject });
    dispatch();
  }).finally(done);
}

/** Stops the workers (at shutdown); reports still waiting fail. */
export async function stopRenderPool(): Promise<void> {
  for (const job of waiting.splice(0)) job.reject(new HttpError(503, BUSY_MESSAGE));
  await Promise.all(workers.splice(0).map((slot) => {
    if (slot.timer) clearTimeout(slot.timer);
    slot.job?.reject(new HttpError(503, BUSY_MESSAGE));
    slot.job = null;
    slot.worker.removeAllListeners('exit');
    return slot.worker.terminate();
  }));
}
