import { eq, and } from "drizzle-orm";
import {
  db, tenants, contacts, leads, leadFeatures, outreachAssignments,
} from "@/server/db";
import {
  fitUpliftModel, scoreUplift, assignCohort, measureLift, recordOutreachOutcome,
} from "@/server/learning/incrementality";
import { fit } from "@/server/learning/train";
import { encode, type FeatureRow } from "@/server/learning/features";

/**
 * Does ranking by UPLIFT actually beat ranking by P(convert)?
 *
 * Builds a population with four known segments, runs a campaign with a real
 * holdout, then compares how many INCREMENTAL conversions each ranking buys
 * for the same number of calls.
 */

// segment -> [P(convert | contacted), P(convert | not contacted)]
const SEGMENTS = {
  persuadable:     { pT: 0.45, pU: 0.08, channel: "sms",       urgency: "this_week",  phone: true,  n: 200 },
  sure_thing:      { pT: 0.82, pU: 0.76, channel: "voice",     urgency: "emergency",  phone: true,  n: 200 },
  lost_cause:      { pT: 0.04, pU: 0.02, channel: "instagram", urgency: "researching", phone: false, n: 200 },
  do_not_disturb:  { pT: 0.10, pU: 0.26, channel: "email",     urgency: "this_month", phone: false, n: 200 },
} as const;

const CAMPAIGN = "uplift_test";

async function main() {
  const slug = "uplift-test-tenant";
  await db.delete(tenants).where(eq(tenants.slug, slug));
  const [tenant] = await db.insert(tenants).values({
    name: "Uplift Test Co", slug, country: "US", vertical: "home_services",
  }).returning();

  console.log("Building population with a known uplift structure…\n");
  console.log("  segment          P(conv|called)  P(conv|not called)  true uplift");
  for (const [name, s] of Object.entries(SEGMENTS)) {
    console.log(`  ${name.padEnd(16)} ${s.pT.toFixed(2).padStart(13)} ${s.pU.toFixed(2).padStart(19)} ${(s.pT - s.pU >= 0 ? "+" : "") + (s.pT - s.pU).toFixed(2)}`);
  }

  const population: { leadId: string; contactId: string; segment: keyof typeof SEGMENTS }[] = [];

  for (const [name, s] of Object.entries(SEGMENTS) as [keyof typeof SEGMENTS, typeof SEGMENTS[keyof typeof SEGMENTS]][]) {
    for (let i = 0; i < s.n; i++) {
      const [contact] = await db.insert(contacts).values({
        tenantId: tenant.id, displayName: `${name}_${i}`,
        primaryPhone: s.phone ? `+1555${String(population.length).padStart(7, "0")}` : null,
        smsConsent: true,
      }).returning();

      const [lead] = await db.insert(leads).values({
        tenantId: tenant.id, contactId: contact.id,
        sourceChannel: s.channel, service: "AC repair", urgency: s.urgency,
        estimatedValue: "450",
      }).returning();

      await db.insert(leadFeatures).values({
        tenantId: tenant.id, leadId: lead.id,
        vertical: "home_services", country: "US",
        sourceChannel: s.channel,
        hourOfDay: 10 + (i % 8), dayOfWeek: i % 7, afterHours: false,
        responseLatencySec: s.phone ? 40 : 3000,
        inboundMessageCount: 2 + (i % 4),
        serviceCategory: "repair", urgency: s.urgency,
        gavePhone: s.phone, gaveEmail: !s.phone,
        askedPrice: i % 3 === 0, isReturningCustomer: false, geoBucket: "021",
      });

      population.push({ leadId: lead.id, contactId: contact.id, segment: name });
    }
  }
  console.log(`\n  ${population.length} leads created`);

  // ── Run the campaign: 15% holdout, simulate real outcomes ────────────────
  console.log("\nRunning campaign with a 15% holdout…");
  for (const p of population) {
    const cohort = await assignCohort({
      tenantId: tenant.id, contactId: p.contactId, leadId: p.leadId,
      campaign: CAMPAIGN, score: 50,
    });
    const s = SEGMENTS[p.segment];
    const prob = cohort === "treatment" ? s.pT : s.pU;
    const converted = Math.random() < prob;
    await recordOutreachOutcome({ campaign: CAMPAIGN, contactId: p.contactId, converted, value: 450 });
    await db.update(leadFeatures).set({ converted, labeledAt: new Date() })
      .where(eq(leadFeatures.leadId, p.leadId));
  }

  const lift = await measureLift(tenant.id, CAMPAIGN);
  console.log(`\n  treatment ${lift!.treatmentN} → ${(lift!.treatmentRate * 100).toFixed(1)}% booked`);
  console.log(`  holdout   ${lift!.holdoutN} → ${(lift!.holdoutRate * 100).toFixed(1)}% booked`);
  console.log(`  absolute lift ${(lift!.absoluteLift * 100).toFixed(1)}pp  ` +
    `95% CI [${(lift!.ciLow * 100).toFixed(1)}, ${(lift!.ciHigh * 100).toFixed(1)}]  ` +
    `${lift!.significant ? "SIGNIFICANT" : "not significant"}`);

  // ── Compare the two rankings ─────────────────────────────────────────────
  console.log("\nFitting uplift model (T-learner)…");
  const upliftModel = await fitUpliftModel(tenant.id, CAMPAIGN);
  console.log(`  treated arm n=${upliftModel.treatedN}  holdout arm n=${upliftModel.untreatedN}  usable=${upliftModel.usable}`);

  const allFeatures = await db.query.leadFeatures.findMany({
    where: eq(leadFeatures.tenantId, tenant.id),
  });
  const convModel = fit(allFeatures);

  const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
  const scored = allFeatures.map((f) => {
    const seg = population.find((p) => p.leadId === f.leadId)!.segment;
    const x = encode(f);
    let z = convModel!.bias;
    for (const [k, w] of Object.entries(convModel!.weights)) z += w * (x[k] ?? 0);
    const pConvert = sigmoid(z);
    const up = scoreUplift(upliftModel, f, pConvert);
    return { seg, pConvert, uplift: up.uplift, segment: up.segment };
  });

  const BUDGET = 200;
  const byConversion = [...scored].sort((a, b) => b.pConvert - a.pConvert).slice(0, BUDGET);
  const byUplift = [...scored].sort((a, b) => b.uplift - a.uplift).slice(0, BUDGET);

  const incremental = (list: typeof scored) =>
    list.reduce((s, r) => s + (SEGMENTS[r.seg].pT - SEGMENTS[r.seg].pU), 0);

  const mix = (list: typeof scored) => {
    const m = new Map<string, number>();
    for (const r of list) m.set(r.seg, (m.get(r.seg) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`).join(", ");
  };

  console.log(`\n── Who gets called, with a budget of ${BUDGET} calls ──`);
  console.log(`\n  Ranked by P(convert):`);
  console.log(`    picks:                ${mix(byConversion)}`);
  console.log(`    incremental bookings: ${incremental(byConversion).toFixed(1)}`);
  console.log(`\n  Ranked by UPLIFT:`);
  console.log(`    picks:                ${mix(byUplift)}`);
  console.log(`    incremental bookings: ${incremental(byUplift).toFixed(1)}`);

  const gain = incremental(byUplift) - incremental(byConversion);
  const pct = (gain / Math.max(0.01, incremental(byConversion))) * 100;
  console.log(`\n  → uplift ranking wins ${gain.toFixed(1)} extra bookings (${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%) for the same effort`);

  await db.delete(tenants).where(eq(tenants.slug, slug));
  console.log("\n(test tenant cleaned up)");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
