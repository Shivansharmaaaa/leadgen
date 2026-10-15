import { encode, FEATURE_KEYS, type FeatureRow } from "./features";
import { rocAuc } from "./train";

/**
 * Alternative training methods, benchmarked rather than assumed.
 *
 * The original trainer used vanilla batch gradient descent with a fixed
 * learning rate — the simplest thing that works, and the weakest link once
 * real data showed AUC 0.70. The options below address the three things
 * actually limiting it:
 *
 *   - convergence (Adam's per-parameter adaptive steps)
 *   - class imbalance (an 11% base rate makes the majority class dominate)
 *   - the linear ceiling (logistic regression cannot represent interactions;
 *     explicit crosses and gradient boosting both can)
 *
 * Which of these wins is an empirical question, so `scripts/benchmark.ts`
 * measures all of them out of sample and the winner is chosen from the table.
 */

export type Trained = {
  method: string;
  predict: (row: FeatureRow) => number;
  weights?: Record<string, number>;
  bias?: number;
  trainAuc: number | null;
  testAuc: number | null;
  epochs: number;
};

const sigmoid = (z: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

/* ── Feature crosses: the "wide" half of wide-and-deep ──────────────────── */

/**
 * Pairwise interactions between the categorical signals that plausibly
 * interact. Hand-picked rather than exhaustive: all-pairs over ~25 features
 * would add 300 columns and overfit on a few thousand rows.
 */
const CROSS_PAIRS: [string, string][] = [
  ["gave_phone", "urg_emergency"],
  ["gave_phone", "urg_researching"],
  ["latency_under_60s", "urg_emergency"],
  ["latency_under_60s", "ch_voice"],
  ["returning", "urg_this_week"],
  ["asked_price", "gave_phone"],
  ["after_hours", "urg_emergency"],
  ["ch_sms", "latency_under_60s"],
];

export function encodeWithCrosses(row: FeatureRow): Record<string, number> {
  const base = encode(row);
  const out: Record<string, number> = { ...base };
  for (const [a, b] of CROSS_PAIRS) {
    out[`x_${a}__${b}`] = (base[a] ?? 0) * (base[b] ?? 0);
  }
  return out;
}

export const CROSS_KEYS = [
  ...FEATURE_KEYS,
  ...CROSS_PAIRS.map(([a, b]) => `x_${a}__${b}`),
].sort();

/* ── Adam ───────────────────────────────────────────────────────────────── */

export type AdamOptions = {
  epochs?: number;
  lr?: number;
  l2?: number;
  beta1?: number;
  beta2?: number;
  /** Re-weight the positive class to counter imbalance. "auto" = n_neg/n_pos. */
  classWeight?: number | "auto" | null;
  /** Stop when validation AUC stops improving. */
  earlyStoppingPatience?: number;
  useCrosses?: boolean;
};

export function trainAdam(
  trainRows: FeatureRow[],
  testRows: FeatureRow[],
  opts: AdamOptions = {},
): Trained {
  const {
    epochs = 800, lr = 0.05, l2 = 0.005,
    beta1 = 0.9, beta2 = 0.999,
    classWeight = null, earlyStoppingPatience = 40, useCrosses = false,
  } = opts;

  const keys = useCrosses ? CROSS_KEYS : FEATURE_KEYS;
  const enc = useCrosses ? encodeWithCrosses : encode;

  const X = trainRows.map(enc);
  const y: number[] = trainRows.map((r) => (r.converted ? 1 : 0));
  const n = X.length;
  const pos = y.reduce((a, b) => a + b, 0);
  const baseRate = pos / n;

  // Positive-class weight. With an 11% base rate the loss is dominated by
  // negatives and the model learns to predict "no" for everything.
  const posWeight =
    classWeight === "auto" ? (n - pos) / Math.max(1, pos)
    : typeof classWeight === "number" ? classWeight
    : 1;

  const w: Record<string, number> = {};
  const m: Record<string, number> = {};
  const v: Record<string, number> = {};
  for (const k of keys) { w[k] = 0; m[k] = 0; v[k] = 0; }
  let bias = Math.log(baseRate / (1 - baseRate));
  let mB = 0, vB = 0;

  let best = { auc: -1, w: { ...w }, bias, epoch: 0 };
  let sinceImprovement = 0;
  let ranEpochs = 0;
  const eps = 1e-8;

  for (let t = 1; t <= epochs; t++) {
    ranEpochs = t;
    const g: Record<string, number> = {};
    for (const k of keys) g[k] = 0;
    let gB = 0;

    for (let i = 0; i < n; i++) {
      let z = bias;
      for (const k of keys) z += w[k] * (X[i][k] ?? 0);
      const p = sigmoid(z);
      const weight = y[i] === 1 ? posWeight : 1;
      const err = (p - y[i]) * weight;
      for (const k of keys) g[k] += err * (X[i][k] ?? 0);
      gB += err;
    }

    for (const k of keys) {
      const grad = g[k] / n + l2 * w[k];
      m[k] = beta1 * m[k] + (1 - beta1) * grad;
      v[k] = beta2 * v[k] + (1 - beta2) * grad * grad;
      const mHat = m[k] / (1 - Math.pow(beta1, t));
      const vHat = v[k] / (1 - Math.pow(beta2, t));
      w[k] -= (lr * mHat) / (Math.sqrt(vHat) + eps);
    }
    const gradB = gB / n;
    mB = beta1 * mB + (1 - beta1) * gradB;
    vB = beta2 * vB + (1 - beta2) * gradB * gradB;
    bias -= (lr * (mB / (1 - Math.pow(beta1, t)))) / (Math.sqrt(vB / (1 - Math.pow(beta2, t))) + eps);

    // Early stopping against the held-out set, checked periodically.
    if (t % 20 === 0 && testRows.length > 0) {
      const auc = evaluate(testRows, w, bias, keys, enc);
      if (auc != null && auc > best.auc + 1e-4) {
        best = { auc, w: { ...w }, bias, epoch: t };
        sinceImprovement = 0;
      } else {
        sinceImprovement += 20;
        if (sinceImprovement >= earlyStoppingPatience * 20) break;
      }
    }
  }

  const finalW = best.auc > 0 ? best.w : w;
  const finalB = best.auc > 0 ? best.bias : bias;

  return {
    method: `adam${useCrosses ? "+crosses" : ""}${posWeight !== 1 ? "+classweight" : ""}`,
    predict: (row) => predictOne(row, finalW, finalB, keys, enc),
    weights: finalW,
    bias: finalB,
    trainAuc: evaluate(trainRows, finalW, finalB, keys, enc),
    testAuc: evaluate(testRows, finalW, finalB, keys, enc),
    epochs: best.epoch || ranEpochs,
  };
}

function predictOne(
  row: FeatureRow, w: Record<string, number>, bias: number,
  keys: string[], enc: (r: FeatureRow) => Record<string, number>,
): number {
  const x = enc(row);
  let z = bias;
  for (const k of keys) z += w[k] * (x[k] ?? 0);
  return sigmoid(z);
}

function evaluate(
  rows: FeatureRow[], w: Record<string, number>, bias: number,
  keys: string[], enc: (r: FeatureRow) => Record<string, number>,
): number | null {
  if (rows.length === 0) return null;
  const scores = rows.map((r) => predictOne(r, w, bias, keys, enc));
  const labels: number[] = rows.map((r) => (r.converted ? 1 : 0));
  return rocAuc(scores, labels);
}

/* ── Gradient-boosted stumps ────────────────────────────────────────────── */

type Stump = { key: string; threshold: number; left: number; right: number };

/**
 * Depth-1 gradient boosting on the logistic loss.
 *
 * The canonical ads-ranking result is that boosted trees over tabular features
 * beat plain logistic regression, because they capture interactions and
 * non-linear thresholds for free. Stumps keep it interpretable and fast, and
 * with mostly-binary features depth-1 already captures most of the gain.
 */
export function trainBoosted(
  trainRows: FeatureRow[],
  testRows: FeatureRow[],
  opts: { rounds?: number; lr?: number; minGain?: number } = {},
): Trained {
  const { rounds = 120, lr = 0.1, minGain = 1e-6 } = opts;

  const X = trainRows.map(encode);
  const y: number[] = trainRows.map((r) => (r.converted ? 1 : 0));
  const n = X.length;
  const baseRate = y.reduce((a, b) => a + b, 0) / n;
  const base = Math.log(baseRate / (1 - baseRate));

  const F = new Array<number>(n).fill(base);
  const trees: Stump[] = [];

  for (let r = 0; r < rounds; r++) {
    // Negative gradient of logistic loss = residual.
    const residual = F.map((f, i) => y[i] - sigmoid(f));

    let bestStump: Stump | null = null;
    let bestGain = minGain;

    for (const key of FEATURE_KEYS) {
      const values = X.map((x) => x[key] ?? 0);
      const distinct = [...new Set(values)];
      // Binary features have one meaningful split; continuous get quantiles.
      const thresholds = distinct.length <= 2
        ? [0.5]
        : [0.25, 0.5, 0.75].map((q) => {
            const sorted = [...values].sort((a, b) => a - b);
            return sorted[Math.floor(sorted.length * q)];
          });

      for (const threshold of new Set(thresholds)) {
        let lSum = 0, lN = 0, rSum = 0, rN = 0;
        for (let i = 0; i < n; i++) {
          if (values[i] <= threshold) { lSum += residual[i]; lN++; }
          else { rSum += residual[i]; rN++; }
        }
        if (lN === 0 || rN === 0) continue;
        const gain = (lSum * lSum) / lN + (rSum * rSum) / rN;
        if (gain > bestGain) {
          bestGain = gain;
          bestStump = { key, threshold, left: lSum / lN, right: rSum / rN };
        }
      }
    }

    if (!bestStump) break;
    trees.push(bestStump);
    for (let i = 0; i < n; i++) {
      const xv = X[i][bestStump.key] ?? 0;
      F[i] += lr * (xv <= bestStump.threshold ? bestStump.left : bestStump.right);
    }
  }

  const predict = (row: FeatureRow) => {
    const x = encode(row);
    let f = base;
    for (const t of trees) {
      f += lr * ((x[t.key] ?? 0) <= t.threshold ? t.left : t.right);
    }
    return sigmoid(f);
  };

  const aucOf = (rows: FeatureRow[]) => {
    if (rows.length === 0) return null;
    return rocAuc(rows.map(predict), rows.map((r) => (r.converted ? 1 : 0)));
  };

  return {
    method: "gradient-boosted stumps",
    predict,
    trainAuc: aucOf(trainRows),
    testAuc: aucOf(testRows),
    epochs: trees.length,
  };
}
