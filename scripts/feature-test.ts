import { readFileSync } from "node:fs";
import { rocAuc } from "@/server/learning/train";

/**
 * Is the ceiling the optimizer or the features?
 *
 * Every training method converged to ~0.70 on the mapped feature set. If that
 * is an optimization limit, richer features will not help. If it is a feature
 * limit, they will — and the answer decides where effort should go.
 */

type Row = Record<string, string>;
const sigmoid = (z: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

function load(): Row[] {
  const text = readFileSync("data/bank-marketing.csv", "utf8").trim();
  const lines = text.split("\n");
  const head = lines[0].split(";").map((h) => h.replace(/"/g, "").trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(";").map((c) => c.replace(/"/g, "").trim());
    return Object.fromEntries(head.map((h, i) => [h, cells[i]])) as Row;
  });
}

/** What we currently capture: channel, timing, prior contact, urgency proxy. */
function lean(r: Row): Record<string, number> {
  const prevSuccess = r.poutcome === "success";
  const previously = r.poutcome !== "nonexistent";
  const pdays = Number(r.pdays);
  return {
    ch_cellular: r.contact === "cellular" ? 1 : 0,
    prev_success: prevSuccess ? 1 : 0,
    prev_contacted: previously ? 1 : 0,
    recent_contact: pdays !== 999 && pdays < 10 ? 1 : 0,
    campaign_n: Math.min(10, Number(r.campaign)) / 10,
    previous_n: Math.min(7, Number(r.previous)) / 7,
    has_loan: r.loan === "yes" ? 1 : 0,
    has_housing: r.housing === "yes" ? 1 : 0,
  };
}

/** Everything the dataset actually carries (minus the leaky `duration`). */
function rich(r: Row): Record<string, number> {
  const f = lean(r);
  const age = Number(r.age);

  f.age_lt30 = age < 30 ? 1 : 0;
  f.age_30_45 = age >= 30 && age < 45 ? 1 : 0;
  f.age_45_60 = age >= 45 && age < 60 ? 1 : 0;
  f.age_60plus = age >= 60 ? 1 : 0;

  for (const j of ["student", "retired", "blue-collar", "admin.", "technician", "management", "services", "unemployed"]) {
    f[`job_${j}`] = r.job === j ? 1 : 0;
  }
  for (const e of ["university.degree", "high.school", "basic.9y", "professional.course"]) {
    f[`edu_${e}`] = r.education === e ? 1 : 0;
  }
  f.married = r.marital === "married" ? 1 : 0;
  f.single = r.marital === "single" ? 1 : 0;
  f.default_unknown = r.default === "unknown" ? 1 : 0;

  for (const m of ["mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]) {
    f[`month_${m}`] = r.month === m ? 1 : 0;
  }

  // Macroeconomic context — the strongest signals in this dataset.
  f.emp_var_rate = Number(r["emp.var.rate"]) / 5;
  f.cons_price = (Number(r["cons.price.idx"]) - 93) / 2;
  f.cons_conf = (Number(r["cons.conf.idx"]) + 40) / 20;
  f.euribor = Number(r.euribor3m) / 5;
  f.nr_employed = (Number(r["nr.employed"]) - 5000) / 200;

  return f;
}

function trainAdam(X: Record<string, number>[], y: number[], keys: string[], epochs = 600) {
  const w: Record<string, number> = {}, m: Record<string, number> = {}, v: Record<string, number> = {};
  for (const k of keys) { w[k] = 0; m[k] = 0; v[k] = 0; }
  const base = y.reduce((a, b) => a + b, 0) / y.length;
  let bias = Math.log(base / (1 - base)), mB = 0, vB = 0;
  const lr = 0.05, b1 = 0.9, b2 = 0.999, l2 = 0.003, eps = 1e-8, n = X.length;

  for (let t = 1; t <= epochs; t++) {
    const g: Record<string, number> = {}; for (const k of keys) g[k] = 0;
    let gB = 0;
    for (let i = 0; i < n; i++) {
      let z = bias; for (const k of keys) z += w[k] * (X[i][k] ?? 0);
      const err = sigmoid(z) - y[i];
      for (const k of keys) g[k] += err * (X[i][k] ?? 0);
      gB += err;
    }
    for (const k of keys) {
      const grad = g[k] / n + l2 * w[k];
      m[k] = b1 * m[k] + (1 - b1) * grad;
      v[k] = b2 * v[k] + (1 - b2) * grad * grad;
      w[k] -= lr * (m[k] / (1 - b1 ** t)) / (Math.sqrt(v[k] / (1 - b2 ** t)) + eps);
    }
    const gb = gB / n;
    mB = b1 * mB + (1 - b1) * gb; vB = b2 * vB + (1 - b2) * gb * gb;
    bias -= lr * (mB / (1 - b1 ** t)) / (Math.sqrt(vB / (1 - b2 ** t)) + eps);
  }
  return { w, bias };
}

function run(name: string, encoder: (r: Row) => Record<string, number>, rows: Row[]) {
  let state = 42;
  const rand = () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const shuffled = [...rows].sort(() => rand() - 0.5);
  const cut = Math.floor(shuffled.length * 0.75);

  const enc = shuffled.map(encoder);
  const y = shuffled.map((r) => (r.y === "yes" ? 1 : 0));
  const keys = Object.keys(enc[0]).sort();

  const { w, bias } = trainAdam(enc.slice(0, cut), y.slice(0, cut), keys);
  const testScores = enc.slice(cut).map((x) => {
    let z = bias; for (const k of keys) z += w[k] * (x[k] ?? 0);
    return sigmoid(z);
  });
  const auc = rocAuc(testScores, y.slice(cut));

  console.log(`  ${name.padEnd(28)} ${keys.length.toString().padStart(3)} features   test AUC ${auc?.toFixed(3)}`);
  return { auc: auc ?? 0, w, keys };
}

function main() {
  const rows = load();
  console.log(`\nSame optimizer (Adam), same split. Only the features change.\n`);

  const leanR = run("what we capture today", lean, rows);
  const richR = run("everything available", rich, rows);

  console.log(`\n  → adding features: +${(richR.auc - leanR.auc).toFixed(3)} AUC`);
  console.log(`  → changing optimizer (earlier benchmark): +0.003 AUC`);

  console.log(`\nStrongest signals the richer model found:`);
  const top = Object.entries(richR.w).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 8);
  for (const [k, v] of top) {
    console.log(`  ${k.padEnd(24)} ${v >= 0 ? "+" : "-"}${Math.abs(v).toFixed(3)}`);
  }
  console.log();
  process.exit(0);
}

main();
