import { sql } from 'drizzle-orm';
import { config } from '../config.ts';
import { db } from '../db/index.ts';
import { logger } from '../lib/logger.ts';

// A small Postgres-backed job queue (no Redis needed). Jobs are claimed with
// FOR UPDATE SKIP LOCKED, so several server instances can share the same table safely.

export interface JobContext {
  id: number;
  type: string;
  attempts: number;
  maxAttempts: number;
}

type Handler = (payload: any, ctx: JobContext) => Promise<void>;
const handlers = new Map<string, Handler>();

/** Throw this from a handler to fail a job without retrying. */
export class PermanentJobError extends Error {}

export function registerJob<P>(type: string, handler: (payload: P, ctx: JobContext) => Promise<void>): void {
  handlers.set(type, handler as Handler);
}

export interface EnqueueOptions {
  delayMs?: number;
  runAt?: Date;
  /** Only one queued job per key. A second enqueue is ignored (or debounced, see below). */
  uniqueKey?: string;
  /** With uniqueKey: push the queued job's run time back, capped at maxWaitMs after it was first queued. */
  debounce?: { maxWaitMs: number };
  maxAttempts?: number;
}

export async function enqueue(type: string, payload: Record<string, unknown> = {}, opts: EnqueueOptions = {}) {
  const runAt = (opts.runAt ?? new Date(Date.now() + (opts.delayMs ?? 0))).toISOString();
  const maxAttempts = opts.maxAttempts ?? 5;
  const json = JSON.stringify(payload);
  if (!opts.uniqueKey) {
    await db.execute(
      sql`INSERT INTO jobs (type, payload, run_at, max_attempts) VALUES (${type}, ${json}::jsonb, ${runAt}::timestamptz, ${maxAttempts})`,
    );
  } else if (opts.debounce) {
    const maxWaitSec = Math.ceil(opts.debounce.maxWaitMs / 1000);
    await db.execute(sql`
      INSERT INTO jobs (type, payload, run_at, max_attempts, unique_key)
      VALUES (${type}, ${json}::jsonb, ${runAt}::timestamptz, ${maxAttempts}, ${opts.uniqueKey})
      ON CONFLICT (unique_key) WHERE status = 'queued'
      DO UPDATE SET
        run_at = LEAST(EXCLUDED.run_at, jobs.first_queued_at + ${maxWaitSec}::int * interval '1 second'),
        payload = EXCLUDED.payload,
        updated_at = now()`);
  } else {
    await db.execute(sql`
      INSERT INTO jobs (type, payload, run_at, max_attempts, unique_key)
      VALUES (${type}, ${json}::jsonb, ${runAt}::timestamptz, ${maxAttempts}, ${opts.uniqueKey})
      ON CONFLICT (unique_key) WHERE status = 'queued' DO NOTHING`);
  }
  if (!opts.delayMs && !opts.runAt) kick();
}

/** Removes queued (not yet running) jobs with this unique key. */
export async function cancelQueued(uniqueKey: string): Promise<void> {
  await db.execute(sql`DELETE FROM jobs WHERE unique_key = ${uniqueKey} AND status = 'queued'`);
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

let stopped = true;
let polling = false;
let running = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let recoveryTimer: ReturnType<typeof setInterval> | null = null;

function schedulePoll(ms: number) {
  if (stopped) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(poll, ms);
}

function kick() {
  if (!stopped && !polling) schedulePoll(0);
}

interface ClaimedJob {
  id: number | string;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

async function poll() {
  timer = null;
  if (stopped || polling) return;
  polling = true;
  let claimedFull = false;
  try {
    const capacity = config.worker.concurrency - running;
    if (capacity > 0) {
      const res = await db.execute(sql`
        UPDATE jobs SET status = 'running', locked_at = now(), attempts = attempts + 1, updated_at = now()
        WHERE id IN (
          SELECT id FROM jobs WHERE status = 'queued' AND run_at <= now()
          ORDER BY run_at LIMIT ${capacity} FOR UPDATE SKIP LOCKED
        )
        RETURNING id, type, payload, attempts, max_attempts`);
      const rows = res.rows as unknown as ClaimedJob[];
      claimedFull = rows.length === capacity;
      for (const row of rows) {
        running++;
        void runJob(row).finally(() => {
          running--;
          kick();
        });
      }
    }
  } catch (err) {
    logger.error('Job poll failed', { err });
  } finally {
    polling = false;
  }
  schedulePoll(claimedFull ? 0 : 500);
}

async function runJob(row: ClaimedJob) {
  const id = Number(row.id);
  const handler = handlers.get(row.type);
  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  try {
    if (!handler) throw new PermanentJobError(`No handler registered for job type "${row.type}"`);
    await handler(payload, { id, type: row.type, attempts: row.attempts, maxAttempts: row.max_attempts });
    await db.execute(sql`UPDATE jobs SET status = 'done', last_error = NULL, updated_at = now() WHERE id = ${id}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const permanent = err instanceof PermanentJobError || row.attempts >= row.max_attempts;
    logger.warn(`Job ${row.type}#${id} failed (attempt ${row.attempts}/${row.max_attempts})`, { error: message });
    try {
      if (permanent) {
        await db.execute(sql`UPDATE jobs SET status = 'failed', last_error = ${message}, updated_at = now() WHERE id = ${id}`);
      } else {
        const backoffSec = Math.min(3600, 5 * 2 ** (row.attempts - 1));
        // If an identical job is already queued it will do the work, so this one can retire.
        await db.execute(sql`
          UPDATE jobs SET
            status = CASE WHEN unique_key IS NOT NULL AND EXISTS (
              SELECT 1 FROM jobs q WHERE q.unique_key = jobs.unique_key AND q.status = 'queued' AND q.id <> jobs.id
            ) THEN 'done' ELSE 'queued' END,
            run_at = now() + ${backoffSec}::int * interval '1 second',
            last_error = ${message},
            updated_at = now()
          WHERE id = ${id}`);
      }
    } catch (updateErr) {
      logger.error(`Could not record failure of job ${id}`, { err: updateErr });
      await db.execute(sql`UPDATE jobs SET status = 'failed', last_error = ${message} WHERE id = ${id}`).catch(() => {});
    }
  }
}

/** Jobs whose worker died (crash, deploy) are requeued after 10 minutes. */
async function recoverStale() {
  try {
    await db.execute(sql`
      UPDATE jobs j SET status = 'queued', updated_at = now(), last_error = 'Requeued after worker timeout'
      WHERE status = 'running' AND locked_at < now() - interval '10 minutes'
        AND (unique_key IS NULL OR NOT EXISTS (
          SELECT 1 FROM jobs q WHERE q.unique_key = j.unique_key AND q.status = 'queued'))`);
  } catch (err) {
    logger.error('Stale job recovery failed', { err });
  }
}

export function startWorker(): void {
  if (!stopped) return;
  stopped = false;
  schedulePoll(0);
  recoveryTimer = setInterval(recoverStale, 60_000);
  logger.info(`Job worker started (concurrency ${config.worker.concurrency})`);
}

export async function stopWorker(timeoutMs = 10_000): Promise<void> {
  stopped = true;
  if (timer) clearTimeout(timer);
  if (recoveryTimer) clearInterval(recoveryTimer);
  const deadline = Date.now() + timeoutMs;
  while (running > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
}

/** Test helper: waits until no job is queued-and-due or running. */
export async function drainJobs(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await db.execute(
      sql`SELECT count(*)::int AS n FROM jobs WHERE status = 'running' OR (status = 'queued' AND run_at <= now() + interval '6 seconds')`,
    );
    if (Number((res.rows[0] as { n: number }).n) === 0 && running === 0) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Timed out waiting for jobs to finish');
}
