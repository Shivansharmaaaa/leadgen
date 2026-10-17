import { and, eq, isNotNull } from "drizzle-orm";
import { db, outreachAssignments, leadFeatures, contacts } from "@/server/db";
import { encode, type FeatureRow } from "./features";
import { fit, type TrainedModel } from "./train";

/**
 * Uplift modelling — who is worth contacting, as opposed to who is likely to
 * convert.
 *
 * This is the idea worth stealing from ad measurement. A call-back list ranked
 * by P(convert) spends effort on two groups that cannot be moved: people who
 * would have booked anyway (sure things) and people who never will (lost
 * causes). The return is entirely in the persuadables — those whose outcome
 * CHANGES because you contacted them.
 *
 *     uplift(x) = P(convert | contacted, x) - P(convert | not contacted, x)
 *
 * Estimating the second term requires a genuine holdout, so every campaign
 * withholds a random slice. That holdout doubles as the client's ROI proof:
 * "your contacted group booked 23%, your untouched group booked 9%" is an
 * answer to "is this software actually doing anything" that no competitor
 * relying on attribution can give.
 *
 * T-learner (two separate models) rather than a single model with a treatment
 * flag: with a few hundred rows per tenant, a flag gets swamped by the other
 * features and the uplift signal disappears.
 */
const DEFAULT_HOLDOUT_PCT = 0.15;

export type UpliftModel = {
  treated: TrainedModel | null;
  untreated: TrainedModel | null;
  treatedN: number;
  untreatedN: number;
  usable: boolean;
};

const sigmoid = (z: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

function predict(model: TrainedModel | null, x: Record<string, number>): number | null {
  if (!model) return null;
  let z = model.bias;
  for (const [k, w] of Object.entries(model.weights)) z += w * (x[k] ?? 0);
  return sigmoid(z);
}

/** Train the two arms from assignment history joined to features. */
export async function fitUpliftModel(tenantId: string, campaign?: string): Promise<UpliftModel> {
  const assignments = await db.query.outreachAssignments.findMany({
    where: and(
      eq(outreachAssignments.tenantId, tenantId),
      ...(campaign ? [eq(outreachAssignments.campaign, campaign)] : []),
    ),
  });

  const treatedRows: FeatureRow[] = [];
  const untreatedRows: FeatureRow[] = [];

  for (const a of assignments) {
    if (!a.leadId) continue;
    const f = await db.query.leadFeatures.findFirst({
      where: eq(leadFeatures.leadId, a.leadId),
    });
    if (!f) continue;
    const row = { ...f, converted: a.converted } as FeatureRow;
    (a.cohort === "treatment" ? treatedRows : untreatedRows).push(row);
  }

  const treated = fit(treatedRows);
  const untreated = fit(untreatedRows);

  return {
    treated,
    untreated,
    treatedN: treatedRows.length,
    untreatedN: untreatedRows.length,
    usable: Boolean(treated && untreated),
  };
}

export type UpliftScore = {
  uplift: number;
  pTreated: number | null;
  pUntreated: number | null;
  segment: "persuadable" | "sure_thing" | "lost_cause" | "do_not_disturb" | "unknown";
  /** True when there is not yet enough holdout data and we fell back to P(convert). */
  fallback: boolean;
};

/**
 * Segment names follow the standard uplift quadrants. "do_not_disturb" is the
 * one people forget: contacting them makes conversion LESS likely, which is
 * real — an unwanted call about a job they already decided against.
 */
export function scoreUplift(model: UpliftModel, row: FeatureRow, baseProb: number): UpliftScore {
  const x = encode(row);
  const pT = predict(model.treated, x);
  const pU = predict(model.untreated, x);

  if (pT == null || pU == null) {
    return {
      uplift: baseProb, pTreated: pT, pUntreated: pU,
      segment: "unknown", fallback: true,
    };
  }

  const uplift = pT - pU;
  let segment: UpliftScore["segment"];
  if (uplift > 0.05) segment = pU > 0.5 ? "sure_thing" : "persuadable";
  else if (uplift < -0.02) segment = "do_not_disturb";
  else segment = pT > 0.5 ? "sure_thing" : "lost_cause";

  return { uplift, pTreated: pT, pUntreated: pU, segment, fallback: false };
}

/* ── Assignment + measurement ───────────────────────────────────────────── */

/** Randomly assign a candidate to treatment or holdout, once per campaign. */
export async function assignCohort(args: {
  tenantId: string;
  contactId: string;
  leadId?: string | null;
  campaign: string;
  score: number;
  holdoutPct?: number;
  /** Source of randomness; injectable so a test is not decided by luck. */
  random?: () => number;
}): Promise<"treatment" | "holdout" | "already_assigned"> {
  const existing = await db.query.outreachAssignments.findFirst({
    where: and(
      eq(outreachAssignments.campaign, args.campaign),
      eq(outreachAssignments.contactId, args.contactId),
    ),
  });
  if (existing) return "already_assigned";

  const cohort = (args.random ?? Math.random)() < (args.holdoutPct ?? DEFAULT_HOLDOUT_PCT) ? "holdout" : "treatment";

  await db.insert(outreachAssignments).values({
    tenantId: args.tenantId,
    contactId: args.contactId,
    leadId: args.leadId ?? null,
    campaign: args.campaign,
    cohort,
    scoreAtAssignment: args.score,
  }).onConflictDoNothing();

  return cohort;
}

export type LiftReport = {
  campaign: string;
  treatmentN: number;
  holdoutN: number;
  treatmentRate: number;
  holdoutRate: number;
  absoluteLift: number;
  relativeLift: number;
  /** 95% CI on the absolute lift. Crosses zero = not yet proven. */
  ciLow: number;
  ciHigh: number;
  significant: boolean;
  incrementalConversions: number;
};

/**
 * The honest answer to "did this actually work".
 *
 * Two-proportion z-interval. If the interval crosses zero we say so rather
 * than claiming a win — the whole point of running a holdout is to be able to
 * tell the difference.
 */
export async function measureLift(tenantId: string, campaign: string): Promise<LiftReport | null> {
  const rows = await db.query.outreachAssignments.findMany({
    where: and(
      eq(outreachAssignments.tenantId, tenantId),
      eq(outreachAssignments.campaign, campaign),
    ),
  });
  if (rows.length === 0) return null;

  const treat = rows.filter((r) => r.cohort === "treatment");
  const hold = rows.filter((r) => r.cohort === "holdout");
  if (treat.length === 0 || hold.length === 0) return null;

  const pT = treat.filter((r) => r.converted).length / treat.length;
  const pH = hold.filter((r) => r.converted).length / hold.length;
  const abs = pT - pH;

  const se = Math.sqrt(
    (pT * (1 - pT)) / treat.length + (pH * (1 - pH)) / hold.length,
  );
  const margin = 1.96 * se;

  return {
    campaign,
    treatmentN: treat.length,
    holdoutN: hold.length,
    treatmentRate: pT,
    holdoutRate: pH,
    absoluteLift: abs,
    relativeLift: pH > 0 ? abs / pH : 0,
    ciLow: abs - margin,
    ciHigh: abs + margin,
    significant: abs - margin > 0,
    incrementalConversions: Math.round(abs * treat.length),
  };
}

/** Record the outcome so the next model learns from it. */
export async function recordOutreachOutcome(args: {
  campaign: string;
  contactId: string;
  converted: boolean;
  value?: number;
}) {
  await db.update(outreachAssignments)
    .set({
      converted: args.converted,
      convertedAt: args.converted ? new Date() : null,
      conversionValue: args.value != null ? String(args.value) : null,
    })
    .where(and(
      eq(outreachAssignments.campaign, args.campaign),
      eq(outreachAssignments.contactId, args.contactId),
    ));
}
