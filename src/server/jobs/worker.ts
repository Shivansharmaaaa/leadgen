import { and, asc, eq, lte, or, isNull, lt, sql } from "drizzle-orm";
import { db, jobs } from "@/server/db";
import { HANDLERS } from "./handlers";

/**
 * Postgres-backed job worker. No Redis, no broker.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes this safe to run on several processes
 * at once: each worker claims a disjoint set of rows without blocking the
 * others. Stale locks are reclaimed so a crashed worker cannot strand a job.
 */
const LOCK_TIMEOUT_MS = 5 * 60_000;
const BACKOFF_BASE_MS = 30_000;

export async function claimJob() {
  const staleBefore = new Date(Date.now() - LOCK_TIMEOUT_MS);

  const rows = await db.execute(sql`
    UPDATE jobs SET status = 'running', locked_at = now(), attempts = attempts + 1
    WHERE id = (
      SELECT id FROM jobs
      WHERE (status = 'pending' AND run_at <= now())
         OR (status = 'running' AND locked_at < ${staleBefore.toISOString()})
      ORDER BY run_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, type, payload, tenant_id, attempts, max_attempts
  `);

  const row = (rows as unknown as Record<string, unknown>[])[0];
  return row ?? null;
}

export async function runOnce(): Promise<{ ran: boolean; type?: string; result?: unknown; error?: string }> {
  const job = await claimJob();
  if (!job) return { ran: false };

  const id = String(job.id);
  const type = String(job.type);
  const payload = (job.payload ?? {}) as Record<string, unknown>;
  const tenantId = job.tenant_id ? String(job.tenant_id) : null;
  const attempts = Number(job.attempts);
  const maxAttempts = Number(job.max_attempts);

  const handler = HANDLERS[type];
  if (!handler) {
    await db.update(jobs)
      .set({ status: "dead", lastError: `no handler for type "${type}"` })
      .where(eq(jobs.id, id));
    return { ran: true, type, error: "no handler" };
  }

  try {
    const result = await handler(payload, tenantId);
    await db.update(jobs)
      .set({ status: "done", lockedAt: null, lastError: null })
      .where(eq(jobs.id, id));
    return { ran: true, type, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const exhausted = attempts >= maxAttempts;

    await db.update(jobs).set({
      status: exhausted ? "dead" : "pending",
      lockedAt: null,
      lastError: message,
      // Exponential backoff so a failing external API is not hammered.
      runAt: exhausted ? new Date() : new Date(Date.now() + BACKOFF_BASE_MS * 2 ** (attempts - 1)),
    }).where(eq(jobs.id, id));

    return { ran: true, type, error: message };
  }
}

/** Long-running loop. `npm run worker`. */
export async function runWorker(opts: { pollMs?: number; signal?: AbortSignal } = {}) {
  const pollMs = opts.pollMs ?? 2000;
  console.log(`[worker] started — polling every ${pollMs}ms`);

  while (!opts.signal?.aborted) {
    let drained = 0;
    // Drain the queue before sleeping, so a burst is handled promptly.
    for (;;) {
      const res = await runOnce();
      if (!res.ran) break;
      drained++;
      const status = res.error ? `✗ ${res.error}` : `✓ ${JSON.stringify(res.result).slice(0, 120)}`;
      console.log(`[worker] ${res.type} ${status}`);
      if (drained > 100) break;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  console.log("[worker] stopped");
}
