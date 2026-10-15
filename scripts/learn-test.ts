import { eq, and, isNull } from "drizzle-orm";
import { db, tenants, leads, contacts, leadFeatures, modelWeights } from "@/server/db";
import { trainScope } from "@/server/learning/train";
import { scoreLeadFeatures } from "@/server/learning/scorer";
import type { FeatureRow } from "@/server/learning/features";

/**
 * Generates leads from a KNOWN hidden rule, trains on them, and checks the
 * model recovers it. If AUC is near 0.5 the learning layer is broken.
 */

const CHANNELS = ["webchat", "instagram", "voice", "sms", "email"] as const;
const URGENCIES = ["emergency", "this_week", "this_month", "researching"] as const;
const SERVICES = ["cooling", "heating", "repair", "install", "maintenance"] as const;

const pick = <T,>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)];

/** The hidden truth the model is supposed to discover. */
function trueConversionProbability(f: {
  channel: string; urgency: string; gavePhone: boolean;
  latency: number; askedPrice: boolean; afterHours: boolean;
}): number {
  let z = -1.2;
  if (f.gavePhone) z += 1.6;                       // strongest signal
  if (f.urgency === "emergency") z += 1.4;
  if (f.urgency === "this_week") z += 0.6;
  if (f.urgency === "researching") z -= 1.1;
  if (f.latency < 60) z += 1.0;                    // speed-to-lead
  else if (f.latency > 3600) z -= 0.8;
  if (f.channel === "voice") z += 0.7;
  if (f.askedPrice && !f.gavePhone) z -= 0.5;
  if (f.afterHours) z += 0.3;
  return 1 / (1 + Math.exp(-z));
}

async function synthesiseTenant(name: string, slug: string, count: number) {
  await db.delete(tenants).where(eq(tenants.slug, slug));
  const [tenant] = await db.insert(tenants).values({
    name, slug, country: "US", vertical: "home_services",
  }).returning();

  const [contact] = await db.insert(contacts).values({
    tenantId: tenant.id, displayName: "synthetic",
  }).returning();

  const rows: (typeof leadFeatures.$inferInsert)[] = [];
  for (let i = 0; i < count; i++) {
    const channel = pick(CHANNELS);
    const urgency = pick(URGENCIES);
    const gavePhone = Math.random() < 0.55;
    const askedPrice = Math.random() < 0.4;
    const afterHours = Math.random() < 0.3;
    const latency = Math.random() < 0.4
      ? Math.floor(Math.random() * 60)
      : Math.floor(Math.random() * 7200);

    const p = trueConversionProbability({ channel, urgency, gavePhone, latency, askedPrice, afterHours });

    const [lead] = await db.insert(leads).values({
      tenantId: tenant.id, contactId: contact.id,
      sourceChannel: channel, service: pick(SERVICES), urgency,
    }).returning();

    rows.push({
      tenantId: tenant.id, leadId: lead.id,
      vertical: "home_services", country: "US",
      sourceChannel: channel,
      hourOfDay: Math.floor(Math.random() * 24),
      dayOfWeek: Math.floor(Math.random() * 7),
      afterHours,
      responseLatencySec: latency,
      inboundMessageCount: 1 + Math.floor(Math.random() * 6),
      serviceCategory: pick(SERVICES),
      urgency,
      gavePhone,
      gaveEmail: Math.random() < 0.3,
      askedPrice,
      isReturningCustomer: Math.random() < 0.15,
      geoBucket: "021",
      converted: Math.random() < p,
      labeledAt: new Date(),
    });
  }
  if (rows.length) await db.insert(leadFeatures).values(rows);
  return tenant;
}

async function main() {
  console.log("Generating synthetic labelled leads from a known hidden rule…\n");

  const big = await synthesiseTenant("Synth Large HVAC", "synth-large", 600);
  const small = await synthesiseTenant("Synth Small HVAC", "synth-small", 40);
  const brandNew = await synthesiseTenant("Synth Brand New", "synth-new", 0);

  const results = await trainScope("home_services", "US");
  console.log("Trained models:");
  for (const r of results) {
    if (!r.model) continue;
    const label = r.scope === "global" ? "POOLED (all tenants)" : `tenant ${r.scope.slice(0, 8)}`;
    console.log(`  ${label.padEnd(26)} n=${String(r.model.sampleSize).padStart(4)}  ` +
      `base=${(r.model.baseRate * 100).toFixed(1)}%  AUC=${r.model.auc?.toFixed(3) ?? "n/a"}`);
  }

  const globalModel = await db.query.modelWeights.findFirst({
    where: and(eq(modelWeights.vertical, "home_services"), isNull(modelWeights.tenantId), eq(modelWeights.active, true)),
  });

  console.log("\nTop learned weights (did it recover the hidden rule?):");
  const sorted = Object.entries(globalModel?.weights ?? {})
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 8);
  for (const [k, w] of sorted) {
    const bar = "█".repeat(Math.min(28, Math.round(Math.abs(w) * 14)));
    console.log(`  ${k.padEnd(20)} ${w >= 0 ? "+" : "-"}${Math.abs(w).toFixed(3)} ${bar}`);
  }

  console.log("\nCold start — the same hot lead scored for three different clients:");
  const hotLead = {
    tenantId: "", leadId: "", vertical: "home_services", country: "US",
    sourceChannel: "voice", hourOfDay: 19, dayOfWeek: 2, afterHours: true,
    responseLatencySec: 25, inboundMessageCount: 4, serviceCategory: "cooling",
    urgency: "emergency", gavePhone: true, gaveEmail: false, askedPrice: false,
    isReturningCustomer: false, geoBucket: "021",
  } as unknown as FeatureRow;

  for (const [label, t] of [
    ["600 leads of history", big], ["40 leads of history", small], ["brand new, 0 leads", brandNew],
  ] as const) {
    const s = await scoreLeadFeatures({ ...hotLead, tenantId: t.id });
    console.log(
      `  ${label.padEnd(22)} score ${String(s.score).padStart(3)}/100  ` +
      `basis=${s.basis.padEnd(8)} own-data weight=${(s.tenantWeight * 100).toFixed(0)}%`,
    );
  }

  const cold = await scoreLeadFeatures({
    ...hotLead, tenantId: big.id, urgency: "researching",
    gavePhone: false, responseLatencySec: 7200, askedPrice: true, afterHours: false,
  } as FeatureRow);
  const hot = await scoreLeadFeatures({ ...hotLead, tenantId: big.id });
  console.log(`\nSeparation check: hot lead ${hot.score}/100 vs cold lead ${cold.score}/100`);
  console.log(`  top factors on the hot lead: ${hot.topFactors.map((f) => f.feature).join(", ")}`);

  for (const slug of ["synth-large", "synth-small", "synth-new"]) {
    await db.delete(tenants).where(eq(tenants.slug, slug));
  }
  // The pooled model trained on synthetic rows must not survive as production
  // state — deleting the tenants leaves it orphaned but still active.
  await db.delete(modelWeights).where(
    and(eq(modelWeights.vertical, "home_services"), isNull(modelWeights.tenantId)),
  );
  console.log("\n(synthetic tenants and the pooled model they trained are cleaned up)");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
