import { sql } from "drizzle-orm";
import { db } from "@/server/db";
import { overdueJobs } from "@/server/queries/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * For an uptime monitor: 200 when the database answers and the job worker
 * is keeping up, 503 otherwise. Says nothing about configuration or data.
 */
export async function GET() {
  let dbOk = false;
  try {
    await db.execute(sql`select 1`);
    dbOk = true;
  } catch {
    // reported below
  }
  const worker = dbOk ? ((await overdueJobs()).count > 0 ? "behind" : "ok") : "unknown";
  const ok = dbOk && worker === "ok";
  return Response.json({ ok, db: dbOk ? "ok" : "down", worker }, { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } });
}
