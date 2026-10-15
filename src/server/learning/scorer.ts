import { and, eq, isNull } from "drizzle-orm";
import { db, modelWeights, leadFeatures, tenants } from "@/server/db";
import { encode, type FeatureRow } from "./features";

/**
 * Hierarchical (empirical-Bayes) blending.
 *
 * A brand-new client has zero conversion history, so a model trained only on
 * their data would be useless for months — the cold-start problem that makes
 * onboarding feel worthless. Instead we start them on the pooled model for
 * their vertical and country, and shift weight onto their own model as their
 * evidence accumulates:
 *
 *     lambda = n_tenant / (n_tenant + K)
 *     p      = lambda * p_tenant + (1 - lambda) * p_global
 *
 * Day one they get the benefit of every other client in their vertical.
 * By ~200 labelled leads they are running substantially on their own data.
 * No personal data is shared in either direction — only learned weights.
 */
const SHRINKAGE_K = 60;

export type Score = {
  probability: number;
  /** 0-100, for display. */
  score: number;
  /** How much of the score came from this tenant's own history. */
  tenantWeight: number;
  basis: "global" | "tenant" | "blended" | "base_rate";
  globalSampleSize: number;
  tenantSampleSize: number;
  /** The features pushing this score up or down, biggest first. */
  topFactors: { feature: string; contribution: number }[];
};

const sigmoid = (z: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

export async function scoreLeadFeatures(row: FeatureRow): Promise<Score> {
  const [globalModel, tenantModel] = await Promise.all([
    db.query.modelWeights.findFirst({
      where: and(
        eq(modelWeights.vertical, row.vertical),
        eq(modelWeights.country, row.country),
        isNull(modelWeights.tenantId),
        eq(modelWeights.active, true),
      ),
    }),
    db.query.modelWeights.findFirst({
      where: and(
        eq(modelWeights.vertical, row.vertical),
        eq(modelWeights.country, row.country),
        eq(modelWeights.tenantId, row.tenantId),
        eq(modelWeights.active, true),
      ),
    }),
  ]);

  const x = encode(row);

  const predict = (m: typeof globalModel) => {
    if (!m) return null;
    let z = Number(m.bias);
    const contributions: { feature: string; contribution: number }[] = [];
    for (const [k, w] of Object.entries(m.weights)) {
      const c = w * (x[k] ?? 0);
      z += c;
      if (c !== 0) contributions.push({ feature: k, contribution: c });
    }
    return { p: sigmoid(z), contributions };
  };

  const g = predict(globalModel);
  const t = predict(tenantModel);

  const nTenant = tenantModel?.sampleSize ?? 0;
  const lambda = nTenant / (nTenant + SHRINKAGE_K);

  let p: number;
  let basis: Score["basis"];
  let contributions: { feature: string; contribution: number }[];

  if (g && t) {
    p = lambda * t.p + (1 - lambda) * g.p;
    basis = lambda > 0.8 ? "tenant" : lambda < 0.2 ? "global" : "blended";
    contributions = lambda >= 0.5 ? t.contributions : g.contributions;
  } else if (g) {
    p = g.p; basis = "global"; contributions = g.contributions;
  } else if (t) {
    p = t.p; basis = "tenant"; contributions = t.contributions;
  } else {
    // Nothing trained yet. Fall back to a neutral prior rather than guessing.
    p = 0.3; basis = "base_rate"; contributions = [];
  }

  return {
    probability: p,
    score: Math.round(p * 100),
    tenantWeight: g && t ? lambda : t ? 1 : 0,
    basis,
    globalSampleSize: globalModel?.sampleSize ?? 0,
    tenantSampleSize: nTenant,
    topFactors: contributions
      .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
      .slice(0, 5),
  };
}

export async function scoreLead(leadId: string): Promise<Score | null> {
  const row = await db.query.leadFeatures.findFirst({
    where: eq(leadFeatures.leadId, leadId),
  });
  return row ? scoreLeadFeatures(row) : null;
}
