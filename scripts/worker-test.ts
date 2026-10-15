import { eq } from "drizzle-orm";
import { db, tenants, jobs, leads } from "@/server/db";
import { enqueue } from "@/server/jobs/handlers";
import { runOnce } from "@/server/jobs/worker";

async function main() {
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.slug, "northside-hvac") });
  if (!tenant) throw new Error("seed first");

  await db.delete(jobs);
  const existingLeads = await db.query.leads.findMany({ where: eq(leads.tenantId, tenant.id) });

  console.log("Enqueuing jobs…\n");
  await enqueue({ type: "train_models", payload: { vertical: "home_services", country: "US" } });
  await enqueue({ type: "label_outcomes", tenantId: tenant.id });
  await enqueue({ type: "reactivation_digest", tenantId: tenant.id });
  for (const l of existingLeads.slice(0, 3)) {
    await enqueue({ type: "extract_features", tenantId: tenant.id, payload: { leadId: l.id } });
  }
  await enqueue({ type: "does_not_exist", tenantId: tenant.id });

  const queued = await db.query.jobs.findMany();
  console.log(`${queued.length} jobs queued\n`);

  console.log("Draining…");
  for (let i = 0; i < 20; i++) {
    const res = await runOnce();
    if (!res.ran) break;
    const out = res.error ? `✗ ${res.error}` : `✓ ${JSON.stringify(res.result)}`;
    console.log(`  ${String(res.type).padEnd(20)} ${out.slice(0, 110)}`);
  }

  const after = await db.query.jobs.findMany();
  const byStatus = new Map<string, number>();
  for (const j of after) byStatus.set(j.status, (byStatus.get(j.status) ?? 0) + 1);
  console.log(`\nfinal: ${[...byStatus.entries()].map(([s, n]) => `${s}=${n}`).join("  ")}`);

  console.log("\nIdempotency — enqueue the same keyed job twice:");
  await db.delete(jobs);
  await enqueue({ type: "reactivation_digest", tenantId: tenant.id, idempotencyKey: "digest:today" });
  await enqueue({ type: "reactivation_digest", tenantId: tenant.id, idempotencyKey: "digest:today" });
  console.log(`  rows: ${(await db.query.jobs.findMany()).length} (1 means dedupe works)`);

  await db.delete(jobs);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
