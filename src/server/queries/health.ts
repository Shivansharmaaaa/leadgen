import { and, eq, lt, or, isNull, sql } from "drizzle-orm";
import { db, jobs } from "@/server/db";

/**
 * Is the worker running? Reminders, team alerts, webhooks, campaigns and the
 * morning summary are all jobs; if nobody runs `npm run worker` they quietly
 * never happen. Jobs that were due more than ten minutes ago and are still
 * pending are the tell.
 */
export async function overdueJobs(tenantId?: string): Promise<{ count: number; oldestMinutes: number | null }> {
  const cutoff = new Date(Date.now() - 10 * 60_000);
  const rows = await db.select({
    n: sql<number>`count(*)::int`,
    oldest: sql<Date | null>`min(${jobs.runAt})`,
  }).from(jobs).where(and(
    eq(jobs.status, "pending"),
    lt(jobs.runAt, cutoff),
    tenantId ? or(eq(jobs.tenantId, tenantId), isNull(jobs.tenantId)) : undefined,
  ));
  const { n, oldest } = rows[0];
  return { count: n, oldestMinutes: oldest ? Math.round((Date.now() - new Date(oldest).getTime()) / 60_000) : null };
}
