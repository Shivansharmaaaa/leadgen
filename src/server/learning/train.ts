import { and, eq, isNotNull } from "drizzle-orm";
import { db, leadFeatures, modelWeights } from "@/server/db";
import { encode, FEATURE_KEYS, type FeatureRow } from "./features";

/**
 * Logistic regression with L2.
 *
 * Optimiser note, from `npm run benchmark` on 41k real campaign records:
 * Adam, class weighting, feature crosses and gradient-boosted stumps were all
 * measured against this. The spread between the best and worst was 0.026 AUC
 * and between the best and this baseline just 0.003 — while adding features
 * moved it 0.102. The optimiser is not the bottleneck, so this stays simple
 * and effort goes into `features.ts`. Use `trainAdam` from `optimizers.ts`
 * when convergence speed matters: it reaches the same accuracy in 40 epochs
 * rather than 400, with early stopping.
 *
 * Trained by batch gradient descent.
 *
 * Deliberately not a neural net. With a few dozen well-chosen features and
 * thousands (not millions) of labelled leads, regularised logistic regression
 * is at least as accurate, trains in milliseconds, needs no GPU or serving
 * infrastructure, and — critically for a product that tells a business owner
 * who to call — the weights are directly readable as "after-hours leads convert
 * 1.4x" rather than being an unexplainable score.
 */

const EPOCHS = 400;
const LEARNING_RATE = 0.35;
const L2 = 0.01;

export type TrainedModel = {
  weights: Record<string, number>;
  bias: number;
  sampleSize: number;
  baseRate: number;
  auc: number | null;
};

const sigmoid = (z: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

export function fit(rows: FeatureRow[]): TrainedModel | null {
  const labelled = rows.filter((r) => r.converted !== null);
  if (labelled.length < 20) return null;

  const X = labelled.map((r) => encode(r));
  const y: number[] = labelled.map((r) => (r.converted ? 1 : 0));
  const n = labelled.length;
  const baseRate = y.reduce((a, b) => a + b, 0) / n;

  // Degenerate: everything converted, or nothing did. No signal to learn.
  if (baseRate === 0 || baseRate === 1) return null;

  const weights: Record<string, number> = {};
  for (const k of FEATURE_KEYS) weights[k] = 0;
  // Start the bias at the log-odds of the base rate so training begins calibrated.
  let bias = Math.log(baseRate / (1 - baseRate));

  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    const grad: Record<string, number> = {};
    for (const k of FEATURE_KEYS) grad[k] = 0;
    let gradBias = 0;

    for (let i = 0; i < n; i++) {
      let z = bias;
      for (const k of FEATURE_KEYS) z += weights[k] * (X[i][k] ?? 0);
      const err = sigmoid(z) - y[i];
      for (const k of FEATURE_KEYS) grad[k] += err * (X[i][k] ?? 0);
      gradBias += err;
    }

    for (const k of FEATURE_KEYS) {
      weights[k] -= LEARNING_RATE * (grad[k] / n + L2 * weights[k]);
    }
    bias -= LEARNING_RATE * (gradBias / n);
  }

  const scores = X.map((x) => {
    let z = bias;
    for (const k of FEATURE_KEYS) z += weights[k] * (x[k] ?? 0);
    return sigmoid(z);
  });

  // NOTE: this AUC is in-sample and therefore optimistic. `fitWithHoldout`
  // below is what should be quoted anywhere a number is reported to a human.
  return { weights, bias, sampleSize: n, baseRate, auc: rocAuc(scores, y) };
}

/**
 * Train on a random split and score on data the model never saw.
 *
 * In-sample AUC flatters a regularised model and is not a number worth putting
 * in front of anyone. Everything reported to a user comes from here.
 */
export function fitWithHoldout(
  rows: FeatureRow[],
  testFraction = 0.25,
  seed = 42,
): { model: TrainedModel | null; testAuc: number | null; testN: number; trainN: number } {
  const labelled = rows.filter((r) => r.converted !== null);
  if (labelled.length < 60) return { model: fit(labelled), testAuc: null, testN: 0, trainN: labelled.length };

  // Deterministic shuffle so repeated runs are comparable.
  let state = seed;
  const rand = () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const shuffled = [...labelled].sort(() => rand() - 0.5);

  const cut = Math.floor(shuffled.length * (1 - testFraction));
  const train = shuffled.slice(0, cut);
  const test = shuffled.slice(cut);

  const model = fit(train);
  if (!model) return { model: null, testAuc: null, testN: test.length, trainN: train.length };

  const testScores = test.map((r) => {
    const x = encode(r);
    let z = model.bias;
    for (const k of FEATURE_KEYS) z += model.weights[k] * (x[k] ?? 0);
    return sigmoid(z);
  });
  const testLabels: number[] = test.map((r) => (r.converted ? 1 : 0));

  return {
    model: { ...model, auc: rocAuc(testScores, testLabels) },
    testAuc: rocAuc(testScores, testLabels),
    testN: test.length,
    trainN: train.length,
  };
}

/** Rank-based AUC. 0.5 is a coin flip; below ~0.6 the model is not worth shipping. */
export function rocAuc(scores: number[], labels: number[]): number | null {
  const pos = scores.filter((_, i) => labels[i] === 1);
  const neg = scores.filter((_, i) => labels[i] === 0);
  if (pos.length === 0 || neg.length === 0) return null;

  let concordant = 0;
  for (const p of pos) for (const q of neg) {
    concordant += p > q ? 1 : p === q ? 0.5 : 0;
  }
  return concordant / (pos.length * neg.length);
}

/**
 * Train the pooled model for one vertical+country, plus a private model for
 * each tenant with enough of its own data. Scoring blends the two.
 */
export async function trainScope(vertical: string, country: string) {
  const rows = await db.query.leadFeatures.findMany({
    where: and(
      eq(leadFeatures.vertical, vertical),
      eq(leadFeatures.country, country),
      isNotNull(leadFeatures.converted),
    ),
  });

  const results: { scope: string; model: TrainedModel | null }[] = [];

  const global = fit(rows);
  if (global) {
    await persist(vertical, country, null, global);
    results.push({ scope: "global", model: global });
  }

  const byTenant = new Map<string, FeatureRow[]>();
  for (const r of rows) {
    const list = byTenant.get(r.tenantId) ?? [];
    list.push(r);
    byTenant.set(r.tenantId, list);
  }

  for (const [tenantId, tenantRows] of byTenant) {
    const local = fit(tenantRows);
    if (local) {
      await persist(vertical, country, tenantId, local);
      results.push({ scope: tenantId, model: local });
    }
  }

  return results;
}

async function persist(
  vertical: string, country: string, tenantId: string | null, model: TrainedModel,
) {
  const where = tenantId
    ? and(eq(modelWeights.vertical, vertical), eq(modelWeights.country, country), eq(modelWeights.tenantId, tenantId))
    : and(eq(modelWeights.vertical, vertical), eq(modelWeights.country, country));

  const prior = await db.query.modelWeights.findMany({ where });
  const version = Math.max(0, ...prior.map((p) => p.version)) + 1;

  for (const p of prior) {
    if (p.tenantId === tenantId) {
      await db.update(modelWeights).set({ active: false }).where(eq(modelWeights.id, p.id));
    }
  }

  await db.insert(modelWeights).values({
    vertical, country, tenantId, version,
    weights: model.weights,
    bias: model.bias.toFixed(6),
    sampleSize: model.sampleSize,
    baseRate: model.baseRate.toFixed(5),
    auc: model.auc != null ? model.auc.toFixed(4) : null,
    active: true,
  });
}
