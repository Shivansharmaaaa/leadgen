import { eq } from "drizzle-orm";
import { db, tenants, contacts, leads, leadFeatures } from "@/server/db";
import { trainFederated, DEFAULT_DP, computeEpsilon } from "@/server/learning/federated";

/**
 * Does federated + DP training still produce a useful model?
 *
 * Privacy always costs accuracy. The question is how much, and whether the
 * pooled private model still beats what a small tenant could learn alone —
 * because if it does not, there is no reason for anyone to participate.
 */
const CHANNELS = ["webchat", "instagram", "voice", "sms", "email"] as const;
const URGENCIES = ["emergency", "this_week", "this_month", "researching"] as const;
const pick = <T,>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)];

function trueProb(f: { urgency: string; phone: boolean; latency: number; channel: string }) {
  let z = -1.2;
  if (f.phone) z += 1.6;
  if (f.urgency === "emergency") z += 1.4;
  if (f.urgency === "researching") z -= 1.1;
  if (f.latency < 60) z += 1.0;
  if (f.channel === "voice") z += 0.7;
  return 1 / (1 + Math.exp(-z));
}

async function makeTenant(slug: string, n: number) {
  await db.delete(tenants).where(eq(tenants.slug, slug));
  const [t] = await db.insert(tenants).values({
    name: slug, slug, country: "US", vertical: "fed_test",
  }).returning();
  const [c] = await db.insert(contacts).values({ tenantId: t.id }).returning();

  const rows: (typeof leadFeatures.$inferInsert)[] = [];
  for (let i = 0; i < n; i++) {
    const channel = pick(CHANNELS), urgency = pick(URGENCIES);
    const phone = Math.random() < 0.55;
    const latency = Math.random() < 0.4 ? Math.floor(Math.random() * 60) : Math.floor(Math.random() * 7200);
    const [lead] = await db.insert(leads).values({
      tenantId: t.id, contactId: c.id, sourceChannel: channel, urgency, service: "x",
    }).returning();
    rows.push({
      tenantId: t.id, leadId: lead.id, vertical: "fed_test", country: "US",
      sourceChannel: channel, hourOfDay: i % 24, dayOfWeek: i % 7, afterHours: false,
      responseLatencySec: latency, inboundMessageCount: 1 + (i % 5),
      serviceCategory: "repair", urgency, gavePhone: phone, gaveEmail: false,
      askedPrice: false, isReturningCustomer: false, geoBucket: "021",
      converted: Math.random() < trueProb({ urgency, phone, latency, channel }),
      labeledAt: new Date(),
    });
  }
  if (rows.length) await db.insert(leadFeatures).values(rows);
  return t;
}

async function main() {
  console.log("Building 5 tenants of differing size…\n");
  const sizes = [400, 300, 150, 80, 60];
  const created = [];
  for (let i = 0; i < sizes.length; i++) {
    created.push(await makeTenant(`fed-${i}`, sizes[i]));
  }
  console.log(`  sizes: ${sizes.join(", ")}  (total ${sizes.reduce((a, b) => a + b, 0)})`);

  console.log("\nFederated training — each tenant fits locally, only weights are shared.");
  for (const noise of [0, 0.3, 0.6, 1.2]) {
    const res = await trainFederated("fed_test", "US", { ...DEFAULT_DP, noiseMultiplier: noise });
    const eps = noise === 0 ? Infinity : computeEpsilon(noise, DEFAULT_DP.delta);
    console.log(
      `  noise ${noise.toFixed(1)}  ε=${eps === Infinity ? "∞ (no privacy)" : eps.toFixed(2).padStart(5)}  ` +
      `tenants=${res.participatingTenants}  ` +
      `private AUC ${res.meanTenantAuc?.toFixed(3) ?? "—"}  ` +
      `(non-private ${res.nonPrivateAuc?.toFixed(3) ?? "—"})`,
    );
  }

  console.log(`\n  ε is the privacy budget: lower = stronger guarantee.`);
  console.log(`  ε≈3 is a commonly accepted operating point for production systems.`);

  for (const t of created) await db.delete(tenants).where(eq(tenants.id, t.id));
  console.log("\n(test tenants cleaned up)");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
