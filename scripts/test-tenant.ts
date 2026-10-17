import { and, like, lt } from "drizzle-orm";
import { db, tenants } from "@/server/db";

/**
 * A tenant slug no other run of the same suite is using. With a fixed slug,
 * each run began by deleting the tenant of that name, so two runs at once (two
 * sessions share this database) pulled it out from under each other mid-test.
 * Also clears tenants left by crashed runs more than an hour ago.
 */
export async function testSlug(base: string): Promise<string> {
  await db.delete(tenants).where(and(like(tenants.slug, `${base}-%`), lt(tenants.createdAt, new Date(Date.now() - 3600_000))));
  return `${base}-${process.pid}`;
}
