import { readFileSync } from "node:fs";
import { fit, fitWithHoldout, rocAuc } from "@/server/learning/train";
import { fitCalibrator, applyCalibrator, expectedCalibrationError } from "@/server/learning/calibration";
import { encode, FEATURE_KEYS, type FeatureRow } from "@/server/learning/features";

/**
 * Train the lead-scoring model on REAL campaign data.
 *
 * UCI Bank Marketing: 41,188 real outbound telemarketing contacts with a
 * binary conversion label. Closest public analogue to the problem — outbound
 * contact, timing, prior-contact history, binary outcome, and a realistic
 * 11% base rate rather than the balanced classes of synthetic data.
 *
 * `duration` is EXCLUDED. The dataset authors warn it is only known after the
 * call ends, so including it leaks the label and inflates AUC to ~0.93 for a
 * model that would be useless in production.
 */
const CSV = "data/bank-marketing.csv";

type Raw = Record<string, string>;

function loadCsv(path: string): Raw[] {
  const text = readFileSync(path, "utf8").trim();
  const lines = text.split("\n");
  const head = lines[0].split(";").map((h) => h.replace(/"/g, "").trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(";").map((c) => c.replace(/"/g, "").trim());
    return Object.fromEntries(head.map((h, i) => [h, cells[i]])) as Raw;
  });
}

const MONTHS = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
const DAYS = ["mon","tue","wed","thu","fri"];

/**
 * Map the campaign record onto our own feature space. This is the real test:
 * if our encoder and trainer generalise to someone else's outbound campaign
 * data, they are not just fitting our synthetic generator.
 */
function toFeatureRow(r: Raw): FeatureRow {
  const previouslyContacted = r.poutcome !== "nonexistent";
  const prevSuccess = r.poutcome === "success";
  // pdays = 999 means never previously contacted.
  const pdays = Number(r.pdays);
  const recentlyContacted = pdays !== 999 && pdays < 10;

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
    // More prior contacts in this campaign = colder lead: use as latency proxy.
    responseLatencySec: recentlyContacted ? 30 : Number(r.campaign) * 600,
    inboundMessageCount: Math.min(20, Number(r.previous) + 1),
    converted: r.y === "yes",
  } as unknown as FeatureRow;
}

function main() {
  console.log("Loading UCI Bank Marketing…");
  const raw = loadCsv(CSV);
  const rows = raw.map(toFeatureRow);
  const positives = rows.filter((r) => r.converted).length;

  console.log(`  ${rows.length.toLocaleString()} records · ${positives.toLocaleString()} conversions ` +
    `(${((positives / rows.length) * 100).toFixed(1)}% base rate)`);
  console.log(`  'duration' excluded — it leaks the label\n`);

  console.log("Training with a 25% holdout…");
  const { model, testAuc, trainN, testN } = fitWithHoldout(rows, 0.25);
  if (!model) { console.error("training failed"); process.exit(1); }

  const inSample = fit(rows);
  console.log(`  train ${trainN.toLocaleString()} · test ${testN.toLocaleString()}`);
  console.log(`  in-sample AUC      ${inSample?.auc?.toFixed(3)}   (optimistic — do not quote)`);
  console.log(`  OUT-OF-SAMPLE AUC  ${testAuc?.toFixed(3)}   ← the honest number`);

  console.log("\nTop learned weights on real data:");
  const top = Object.entries(model.weights)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 10);
  for (const [k, w] of top) {
    const bar = "█".repeat(Math.min(26, Math.round(Math.abs(w) * 12)));
    console.log(`  ${k.padEnd(20)} ${w >= 0 ? "+" : "-"}${Math.abs(w).toFixed(3)} ${bar}`);
  }

  // ── Calibration ─────────────────────────────────────────────────────────
  const sigmoid = (z: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
  const probs = rows.map((r) => {
    const x = encode(r);
    let z = model.bias;
    for (const k of FEATURE_KEYS) z += model.weights[k] * (x[k] ?? 0);
    return sigmoid(z);
  });
  const labels: number[] = rows.map((r) => (r.converted ? 1 : 0));

  const eceBefore = expectedCalibrationError(probs, labels);
  const cal = fitCalibrator(probs, labels);
  const calibrated = probs.map((p) => applyCalibrator(p, cal));
  const eceAfter = expectedCalibrationError(calibrated, labels);

  console.log(`\nCalibration (how honest the score is):`);
  console.log(`  expected calibration error  ${eceBefore.toFixed(4)} → ${eceAfter.toFixed(4)} after Platt scaling`);
  console.log(`  ranking preserved: AUC ${rocAuc(calibrated, labels)?.toFixed(3)} (monotonic, unchanged)`);

  // ── Lift by decile: what the business actually feels ─────────────────────
  console.log(`\nLift by score decile (what targeting the top decile buys you):`);
  const paired = probs.map((p, i) => ({ p, y: labels[i] })).sort((a, b) => b.p - a.p);
  const bucket = Math.floor(paired.length / 10);
  const baseRate = positives / rows.length;
  for (const d of [0, 1, 4, 9]) {
    const slice = paired.slice(d * bucket, (d + 1) * bucket);
    const rate = slice.reduce((s, r) => s + r.y, 0) / slice.length;
    console.log(`  decile ${d + 1}${d === 0 ? " (best)" : d === 9 ? " (worst)" : "       "}  ` +
      `${(rate * 100).toFixed(1)}% convert   ${(rate / baseRate).toFixed(2)}x base rate`);
  }
  process.exit(0);
}

main();
