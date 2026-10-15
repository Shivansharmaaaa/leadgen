/**
 * Score calibration.
 *
 * A regularised, blended model produces good RANKINGS but dishonest
 * PROBABILITIES — L2 shrinks weights toward zero and the hierarchical blend
 * averages two differently-calibrated models. Ad platforms care about this
 * because a miscalibrated pCVR means mis-bidding; we care because the
 * dashboard tells a business owner "82" and they reasonably read that as
 * "82% likely to book".
 *
 * Platt scaling: fit a 1-D logistic regression mapping raw score -> observed
 * frequency. Cheap, monotonic (so rankings are preserved exactly), and stable
 * on the few hundred labelled examples a real tenant will have — isotonic
 * regression overfits badly at that size.
 */
export type Calibrator = { a: number; b: number };

const sigmoid = (z: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
const logit = (p: number) => {
  const q = Math.min(0.999, Math.max(0.001, p));
  return Math.log(q / (1 - q));
};

export function fitCalibrator(rawProbs: number[], labels: number[]): Calibrator | null {
  if (rawProbs.length < 30) return null;
  const pos = labels.reduce((s, y) => s + y, 0);
  if (pos === 0 || pos === labels.length) return null;

  const x = rawProbs.map(logit);
  let a = 1, b = 0;

  for (let epoch = 0; epoch < 300; epoch++) {
    let ga = 0, gb = 0;
    for (let i = 0; i < x.length; i++) {
      const err = sigmoid(a * x[i] + b) - labels[i];
      ga += err * x[i];
      gb += err;
    }
    a -= 0.1 * (ga / x.length);
    b -= 0.1 * (gb / x.length);
  }
  return { a, b };
}

export function applyCalibrator(p: number, c: Calibrator | null): number {
  if (!c) return p;
  return sigmoid(c.a * logit(p) + c.b);
}

/**
 * Expected Calibration Error. Below ~0.05 is trustworthy; above ~0.15 means
 * the number on the dashboard is lying and should be shown as a rank instead.
 */
export function expectedCalibrationError(probs: number[], labels: number[], bins = 10): number {
  if (probs.length === 0) return 0;
  let ece = 0;

  for (let b = 0; b < bins; b++) {
    const lo = b / bins, hi = (b + 1) / bins;
    const idx = probs
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p >= lo && (b === bins - 1 ? p <= hi : p < hi));
    if (idx.length === 0) continue;

    const avgP = idx.reduce((s, { p }) => s + p, 0) / idx.length;
    const avgY = idx.reduce((s, { i }) => s + labels[i], 0) / idx.length;
    ece += (idx.length / probs.length) * Math.abs(avgP - avgY);
  }
  return ece;
}
