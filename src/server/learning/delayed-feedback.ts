import { and, eq, isNotNull } from "drizzle-orm";
import { db, leadFeatures, appointments, leads } from "@/server/db";

/**
 * Delayed feedback correction.
 *
 * The naive labeller marked any lead still unconverted after 30 days as a
 * negative. That is wrong in the same way it is wrong for ad conversions, and
 * ad platforms learned it the hard way: conversions arrive on a long tail, so
 * treating "not yet" as "no" systematically over-counts negatives and biases
 * the model against slow-converting segments — exactly the high-value
 * replacement jobs that take weeks to decide.
 *
 * Instead: estimate the empirical conversion-delay distribution from leads
 * that DID convert, then weight each unconverted lead's negative label by how
 * much of that distribution has already elapsed. A lead unconverted at a point
 * where only 40% of conversions have historically landed is only 40% of a
 * negative; the rest is still undecided.
 */
export type DelayModel = {
  /** Empirical CDF: fraction of conversions that land within N days. */
  cdf: number[];
  medianDays: number;
  p90Days: number;
  sampleSize: number;
};

const MAX_DAYS = 120;

export async function fitDelayModel(tenantId?: string): Promise<DelayModel> {
  const converted = await db.query.leadFeatures.findMany({
    where: and(
      eq(leadFeatures.converted, true),
      ...(tenantId ? [eq(leadFeatures.tenantId, tenantId)] : []),
    ),
  });

  const delays: number[] = [];
  for (const f of converted) {
    const lead = await db.query.leads.findFirst({ where: eq(leads.id, f.leadId) });
    if (!lead) continue;
    const appt = await db.query.appointments.findFirst({
      where: eq(appointments.contactId, lead.contactId),
    });
    if (!appt) continue;
    const days = Math.floor((appt.createdAt.getTime() - lead.createdAt.getTime()) / 86400_000);
    if (days >= 0 && days <= MAX_DAYS) delays.push(days);
  }

  // No history yet: assume a reasonable home-services shape rather than
  // pretending every unconverted lead is a confirmed loss.
  if (delays.length < 10) return defaultDelayModel(delays.length);

  delays.sort((a, b) => a - b);
  const cdf: number[] = [];
  for (let d = 0; d <= MAX_DAYS; d++) {
    cdf[d] = delays.filter((x) => x <= d).length / delays.length;
  }

  return {
    cdf,
    medianDays: delays[Math.floor(delays.length * 0.5)],
    p90Days: delays[Math.floor(delays.length * 0.9)],
    sampleSize: delays.length,
  };
}

/** Most home-services leads convert fast; a minority take weeks. */
function defaultDelayModel(sampleSize: number): DelayModel {
  const cdf: number[] = [];
  for (let d = 0; d <= MAX_DAYS; d++) {
    // Exponential with ~7-day mean, capped — about 63% by day 7, 95% by day 21.
    cdf[d] = 1 - Math.exp(-d / 7);
  }
  return { cdf, medianDays: 5, p90Days: 16, sampleSize };
}

/**
 * How much of a negative an unconverted lead currently is.
 * 1.0 = effectively a confirmed loss. 0.2 = still mostly undecided.
 */
export function negativeWeight(ageDays: number, model: DelayModel): number {
  const d = Math.max(0, Math.min(MAX_DAYS, Math.floor(ageDays)));
  return model.cdf[d] ?? 1;
}

/**
 * Label the backlog, delay-aware. Only leads that are confidently resolved get
 * a hard label; the undecided middle is left unlabelled rather than guessed.
 */
export async function labelWithDelayCorrection(
  tenantId: string,
  confidenceThreshold = 0.9,
): Promise<{ positives: number; negatives: number; stillUndecided: number; medianDays: number }> {
  const model = await fitDelayModel(tenantId);

  const rows = await db.query.leads.findMany({ where: eq(leads.tenantId, tenantId) });
  let positives = 0, negatives = 0, stillUndecided = 0;

  for (const lead of rows) {
    const appts = await db.query.appointments.findMany({
      where: eq(appointments.contactId, lead.contactId),
    });
    const won = appts.some((a) => a.status === "completed" || a.status === "confirmed");

    if (won) {
      await db.update(leadFeatures)
        .set({
          converted: true,
          conversionValue: lead.estimatedValue,
          labeledAt: new Date(),
        })
        .where(eq(leadFeatures.leadId, lead.id));
      positives++;
      continue;
    }

    const ageDays = (Date.now() - lead.createdAt.getTime()) / 86400_000;
    const w = negativeWeight(ageDays, model);

    if (w >= confidenceThreshold) {
      await db.update(leadFeatures)
        .set({ converted: false, labeledAt: new Date() })
        .where(eq(leadFeatures.leadId, lead.id));
      negatives++;
    } else {
      stillUndecided++;
    }
  }

  return { positives, negatives, stillUndecided, medianDays: model.medianDays };
}
