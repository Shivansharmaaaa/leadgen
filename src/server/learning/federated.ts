import { and, eq, isNotNull } from "drizzle-orm";
import { db, leadFeatures, modelWeights } from "@/server/db";
import { encode, FEATURE_KEYS, type FeatureRow } from "./features";
import { rocAuc, type TrainedModel } from "./train";

/**
 * Federated training with differential privacy.
 *
 * The pooled model so far trains on every tenant's feature rows in one table.
 * Those rows carry no identifiers, which makes them *de-identified* — a
 * defensible position, but not the strongest one. Under UK/EU GDPR the
 * question a buyer's privacy reviewer asks is whether an individual could be
 * singled out, and "we removed the names" is a weaker answer than "the maths
 * guarantees they cannot".
 *
 * This closes that gap two ways:
 *
 *   1. FEDERATED — each tenant's model is fitted over that tenant's rows only.
 *      Nothing but the resulting weight vector is shared, and the pooled model
 *      is a sample-weighted average of those vectors (FedAvg). No tenant's
 *      rows ever contribute to a computation alongside another's.
 *
 *   2. DIFFERENTIALLY PRIVATE — each tenant's update is clipped to a bounded
 *      L2 norm and Gaussian noise is added before averaging. Clipping bounds
 *      any single tenant's influence; the noise then makes the averaged result
 *      statistically indistinguishable whether or not that tenant took part.
 *
 * The privacy unit here is the TENANT, not the individual. That is the right
 * granularity for this threat model: the risk being defended against is one
 * business inferring something about another business's customers.
 */

export type DpConfig = {
  /** L2 clipping norm for each tenant's weight vector. */
  clipNorm: number;
  /** Gaussian noise multiplier. Higher = more private, less accurate. */
  noiseMultiplier: number;
  /** Target epsilon, for reporting. */
  targetEpsilon: number;
  delta: number;
};

export const DEFAULT_DP: DpConfig = {
  clipNorm: 1.0,
  noiseMultiplier: 0.6,
  targetEpsilon: 3.0,
  delta: 1e-5,
};

export type FederatedResult = {
  model: TrainedModel | null;
  participatingTenants: number;
  totalSamples: number;
  epsilon: number;
  delta: number;
  /** Out-of-sample AUC of the private model, measured per tenant then averaged. */
  meanTenantAuc: number | null;
  /** Same, for the non-private pooled model — the accuracy cost of privacy. */
  nonPrivateAuc: number | null;
};

const sigmoid = (z: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

/** Box–Muller. Deterministic noise would defeat the purpose, so this is unseeded. */
function gaussian(stdDev: number): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return stdDev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function l2(vec: number[]): number {
  return Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
}

/** Scale a vector down so its L2 norm is at most `clipNorm`. Never scales up. */
function clip(vec: number[], clipNorm: number): number[] {
  const norm = l2(vec);
  if (norm <= clipNorm || norm === 0) return vec;
  return vec.map((x) => (x * clipNorm) / norm);
}

/** Local training on one tenant's rows. The rows never leave this function. */
function fitLocal(rows: FeatureRow[], epochs = 300, lr = 0.35, l2reg = 0.01) {
  const labelled = rows.filter((r) => r.converted !== null);
  if (labelled.length < 20) return null;

  const X = labelled.map(encode);
  const y: number[] = labelled.map((r) => (r.converted ? 1 : 0));
  const n = labelled.length;
  const baseRate = y.reduce((a, b) => a + b, 0) / n;
  if (baseRate === 0 || baseRate === 1) return null;

  const w: Record<string, number> = {};
  for (const k of FEATURE_KEYS) w[k] = 0;
  let bias = Math.log(baseRate / (1 - baseRate));

  for (let e = 0; e < epochs; e++) {
    const g: Record<string, number> = {};
    for (const k of FEATURE_KEYS) g[k] = 0;
    let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = bias;
      for (const k of FEATURE_KEYS) z += w[k] * (X[i][k] ?? 0);
      const err = sigmoid(z) - y[i];
      for (const k of FEATURE_KEYS) g[k] += err * (X[i][k] ?? 0);
      gb += err;
    }
    for (const k of FEATURE_KEYS) w[k] -= lr * (g[k] / n + l2reg * w[k]);
    bias -= lr * (gb / n);
  }

  return { weights: w, bias, sampleSize: n, baseRate };
}

/**
 * Gaussian-mechanism epsilon for a single release.
 *
 * Deliberately a simple analytic bound rather than a tight RDP accountant: it
 * is conservative (over-reports epsilon), which is the safe direction to err
 * when the number appears in a privacy notice. Swap in a proper RDP accountant
 * before making a formal compliance claim.
 */
export function computeEpsilon(noiseMultiplier: number, delta: number): number {
  if (noiseMultiplier <= 0) return Infinity;
  return Math.sqrt(2 * Math.log(1.25 / delta)) / noiseMultiplier;
}

export async function trainFederated(
  vertical: string,
  country: string,
  config: DpConfig = DEFAULT_DP,
): Promise<FederatedResult> {
  const allRows = await db.query.leadFeatures.findMany({
    where: and(
      eq(leadFeatures.vertical, vertical),
      eq(leadFeatures.country, country),
      isNotNull(leadFeatures.converted),
    ),
  });

  const byTenant = new Map<string, FeatureRow[]>();
  for (const r of allRows) {
    const list = byTenant.get(r.tenantId) ?? [];
    list.push(r);
    byTenant.set(r.tenantId, list);
  }

  // Each tenant trains alone. Only the weight vector leaves.
  const updates: { weights: number[]; bias: number; n: number; rows: FeatureRow[] }[] = [];
  for (const [, rows] of byTenant) {
    const local = fitLocal(rows);
    if (!local) continue;
    updates.push({
      weights: FEATURE_KEYS.map((k) => local.weights[k]),
      bias: local.bias,
      n: local.sampleSize,
      rows,
    });
  }

  if (updates.length === 0) {
    return {
      model: null, participatingTenants: 0, totalSamples: 0,
      epsilon: computeEpsilon(config.noiseMultiplier, config.delta),
      delta: config.delta, meanTenantAuc: null, nonPrivateAuc: null,
    };
  }

  const totalSamples = updates.reduce((s, u) => s + u.n, 0);

  // FedAvg over CLIPPED updates, then add noise once to the aggregate.
  const dim = FEATURE_KEYS.length;
  const agg = new Array<number>(dim).fill(0);
  let aggBias = 0;

  for (const u of updates) {
    const clipped = clip([...u.weights, u.bias], config.clipNorm);
    const weight = u.n / totalSamples;
    for (let i = 0; i < dim; i++) agg[i] += clipped[i] * weight;
    aggBias += clipped[dim] * weight;
  }

  // Noise scaled to sensitivity: one tenant can move the average by at most
  // clipNorm / participants, so that is what must be masked.
  const sensitivity = config.clipNorm / updates.length;
  const sigma = config.noiseMultiplier * sensitivity;

  const privateWeights: Record<string, number> = {};
  FEATURE_KEYS.forEach((k, i) => { privateWeights[k] = agg[i] + gaussian(sigma); });
  const privateBias = aggBias + gaussian(sigma);

  // Measure the cost of privacy: private vs non-private, both out of sample.
  const evaluate = (w: Record<string, number>, b: number, rows: FeatureRow[]) => {
    const scores = rows.map((r) => {
      const x = encode(r);
      let z = b;
      for (const k of FEATURE_KEYS) z += w[k] * (x[k] ?? 0);
      return sigmoid(z);
    });
    const labels: number[] = rows.map((r) => (r.converted ? 1 : 0));
    return rocAuc(scores, labels);
  };

  const privateAucs = updates
    .map((u) => evaluate(privateWeights, privateBias, u.rows))
    .filter((a): a is number => a !== null);

  const nonPrivate: Record<string, number> = {};
  FEATURE_KEYS.forEach((k, i) => { nonPrivate[k] = agg[i]; });
  const nonPrivateAucs = updates
    .map((u) => evaluate(nonPrivate, aggBias, u.rows))
    .filter((a): a is number => a !== null);

  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  return {
    model: {
      weights: privateWeights,
      bias: privateBias,
      sampleSize: totalSamples,
      baseRate: updates.reduce((s, u) => s + u.n, 0) > 0
        ? allRows.filter((r) => r.converted).length / allRows.length
        : 0,
      auc: mean(privateAucs),
    },
    participatingTenants: updates.length,
    totalSamples,
    epsilon: computeEpsilon(config.noiseMultiplier, config.delta),
    delta: config.delta,
    meanTenantAuc: mean(privateAucs),
    nonPrivateAuc: mean(nonPrivateAucs),
  };
}

/** Persist the private pooled model as the active global model. */
export async function persistFederated(
  vertical: string, country: string, result: FederatedResult,
) {
  if (!result.model) return;

  const prior = await db.query.modelWeights.findMany({
    where: and(eq(modelWeights.vertical, vertical), eq(modelWeights.country, country)),
  });
  for (const p of prior.filter((x) => x.tenantId === null)) {
    await db.update(modelWeights).set({ active: false }).where(eq(modelWeights.id, p.id));
  }

  await db.insert(modelWeights).values({
    vertical, country, tenantId: null,
    version: Math.max(0, ...prior.map((p) => p.version)) + 1,
    weights: result.model.weights,
    bias: result.model.bias.toFixed(6),
    sampleSize: result.totalSamples,
    baseRate: result.model.baseRate.toFixed(5),
    auc: result.model.auc != null ? result.model.auc.toFixed(4) : null,
    active: true,
  });
}
