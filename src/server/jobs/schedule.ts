import { addDays } from "date-fns";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { db, jobs, locations } from "@/server/db";

/**
 * Recurring work. Handlers existed for the nightly model retrain and the
 * reactivation digest, but nothing ever put them on the queue, so they never
 * ran. The worker calls this every few minutes; each job's idempotency key
 * carries its date, so the unique index makes it safe for any number of
 * workers to call it at once.
 */

const DIGEST_HOUR = 8;     // local, per tenant
const RETRAIN_HOUR_UTC = 3;

export async function ensureRecurringJobs(now = new Date()): Promise<number> {
  const tenantRows = await db.query.tenants.findMany();
  const rows: (typeof jobs.$inferInsert)[] = [];

  for (const t of tenantRows) {
    const loc = await db.query.locations.findFirst({ where: (l, { eq }) => eq(l.tenantId, t.id) });
    const tz = (loc as typeof locations.$inferSelect | undefined)?.timezone ?? t.timezone;
    const at = nextLocal(now, tz, DIGEST_HOUR);
    rows.push({
      tenantId: t.id, type: "daily_digest", runAt: at, payload: {},
      idempotencyKey: `daily_digest:${t.id}:${formatInTimeZone(at, tz, "yyyy-MM-dd")}`,
    });
  }

  const scopes = new Set(tenantRows.map((t) => `${t.vertical}|${t.country}`));
  const retrainAt = nextLocal(now, "UTC", RETRAIN_HOUR_UTC);
  for (const scope of scopes) {
    const [vertical, country] = scope.split("|");
    rows.push({
      tenantId: null, type: "train_models", runAt: retrainAt, payload: { vertical, country },
      idempotencyKey: `train_models:${vertical}:${country}:${formatInTimeZone(retrainAt, "UTC", "yyyy-MM-dd")}`,
    });
  }

  if (!rows.length) return 0;
  const inserted = await db.insert(jobs).values(rows).onConflictDoNothing().returning({ id: jobs.id });
  return inserted.length;
}

/** The next time it is `hour`:00 in `tz`, strictly after `now`. */
export function nextLocal(now: Date, tz: string, hour: number): Date {
  const today = fromZonedTime(`${formatInTimeZone(now, tz, "yyyy-MM-dd")}T${String(hour).padStart(2, "0")}:00:00`, tz);
  return today > now ? today : fromZonedTime(`${formatInTimeZone(addDays(now, 1), tz, "yyyy-MM-dd")}T${String(hour).padStart(2, "0")}:00:00`, tz);
}
