import { readFileSync } from "node:fs";
import { fit, rocAuc } from "@/server/learning/train";
import { trainAdam, trainBoosted, type Trained } from "@/server/learning/optimizers";
import { encode, FEATURE_KEYS, type FeatureRow } from "@/server/learning/features";
import { fitCalibrator, applyCalibrator, expectedCalibrationError } from "@/server/learning/calibration";

/** Benchmark every training method on real campaign data, same split for all. */

const DAYS = ["mon", "tue", "wed", "thu", "fri"];

function loadRows(): FeatureRow[] {
  const text = readFileSync("data/bank-marketing.csv", "utf8").trim();
  const lines = text.split("\n");
  const head = lines[0].split(";").map((h) => h.replace(/"/g, "").trim());

  return lines.slice(1).map((line) => {
    const cells = line.split(";").map((c) => c.replace(/"/g, "").trim());
    const r = Object.fromEntries(head.map((h, i) => [h, cells[i]])) as Record<string, string>;
    const prevSuccess = r.poutcome === "success";
    const previouslyContacted = r.poutcome !== "nonexistent";
    const pdays = Number(r.pdays);
    const recent = pdays !== 999 && pdays < 10;

    return {
      sourceChannel: r.contact === "cellular" ? "sms" : "voice",
      urgency: prevSuccess ? "this_week" : previouslyContacted ? "this_month" : "researching",
      serviceCategory: "other",
      afterHours: false,
      gavePhone: true,
      gaveEmail: false,
      askedPrice: r.loan === "yes" || r.housing === "yes",
      isReturningCustomer: prevSuccess,
      hourOfDay: 9 + (DAYS.indexOf(r.day_of_week) % 8),
      dayOfWeek: Math.max(1, DAYS.indexOf(r.day_of_week) + 1),
      responseLatencySec: recent ? 30 : Number(r.campaign) * 600,
      inboundMessageCount: Math.min(20, Number(r.previous) + 1),
      converted: r.y === "yes",
    } as unknown as FeatureRow;
  });
}

function split(rows: FeatureRow[], testFraction = 0.25, seed = 42) {
  let state = seed;
  const rand = () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const shuffled = [...rows].sort(() => rand() - 0.5);
  const cut = Math.floor(shuffled.length * (1 - testFraction));
  return { train: shuffled.slice(0, cut), test: shuffled.slice(cut) };
}

function main() {
  const rows = loadRows();
  const { train, test } = split(rows);
  const baseRate = rows.filter((r) => r.converted).length / rows.length;

  console.log(`\nUCI Bank Marketing · ${rows.length.toLocaleString()} rows · ${(baseRate * 100).toFixed(1)}% base rate`);
  console.log(`train ${train.length.toLocaleString()} · test ${test.length.toLocaleString()}\n`);

  const results: Trained[] = [];

  // Baseline: the original batch GD trainer.
  const baseline = fit(train);
  if (baseline) {
    const scores = test.map((r) => {
      const x = encode(r);
      let z = baseline.bias;
      for (const k of FEATURE_KEYS) z += baseline.weights[k] * (x[k] ?? 0);
      return 1 / (1 + Math.exp(-z));
    });
    results.push({
      method: "batch GD (original)",
      predict: () => 0,
      weights: baseline.weights,
      bias: baseline.bias,
      trainAuc: baseline.auc,
      testAuc: rocAuc(scores, test.map((r) => (r.converted ? 1 : 0))),
      epochs: 400,
    });
  }

  results.push(trainAdam(train, test));
  results.push(trainAdam(train, test, { classWeight: "auto" }));
  results.push(trainAdam(train, test, { useCrosses: true }));
  results.push(trainAdam(train, test, { useCrosses: true, classWeight: "auto" }));
  results.push(trainBoosted(train, test));

  console.log("method                              train AUC   TEST AUC   epochs");
  console.log("─".repeat(70));
  const sorted = [...results].sort((a, b) => (b.testAuc ?? 0) - (a.testAuc ?? 0));
  for (const r of sorted) {
    const star = r === sorted[0] ? "  ★" : "";
    console.log(
      `${r.method.padEnd(34)} ${(r.trainAuc?.toFixed(3) ?? "—").padStart(7)}   ` +
      `${(r.testAuc?.toFixed(3) ?? "—").padStart(8)}   ${String(r.epochs).padStart(6)}${star}`,
    );
  }

  const winner = sorted[0];
  const base = results[0];
  const gain = ((winner.testAuc ?? 0) - (base.testAuc ?? 0));
  console.log("─".repeat(70));
  console.log(`winner: ${winner.method}  (+${gain.toFixed(3)} AUC over the original)\n`);

  // Does the winner's extra accuracy translate into better targeting?
  if (winner.predict) {
    const probs = test.map(winner.predict);
    const labels: number[] = test.map((r) => (r.converted ? 1 : 0));
    const cal = fitCalibrator(probs, labels);
    const calibrated = probs.map((p) => applyCalibrator(p, cal));

    console.log(`calibration ECE  ${expectedCalibrationError(probs, labels).toFixed(4)} → ` +
      `${expectedCalibrationError(calibrated, labels).toFixed(4)} after Platt`);

    const paired = probs.map((p, i) => ({ p, y: labels[i] })).sort((a, b) => b.p - a.p);
    const bucket = Math.floor(paired.length / 10);
    const testBase = labels.reduce((a, b) => a + b, 0) / labels.length;
    console.log(`\ndecile lift on held-out data:`);
    for (const d of [0, 1, 9]) {
      const slice = paired.slice(d * bucket, (d + 1) * bucket);
      const rate = slice.reduce((s, r) => s + r.y, 0) / slice.length;
      console.log(`  decile ${String(d + 1).padStart(2)}  ${(rate * 100).toFixed(1)}% convert   ${(rate / testBase).toFixed(2)}x base`);
    }
  }
  console.log();
  process.exit(0);
}

main();
