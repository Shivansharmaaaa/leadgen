import { db, modelWeights } from "@/server/db";

async function main() {
  const rows = await db.query.modelWeights.findMany();
  console.log(`model_weights rows: ${rows.length}`);
  for (const r of rows) {
    console.log(`  ${r.vertical}/${r.country}  tenant=${r.tenantId ? r.tenantId.slice(0, 8) : "POOLED"}  n=${r.sampleSize}  base=${r.baseRate}  active=${r.active}`);
    const top = Object.entries(r.weights)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 5);
    console.log(`     ${top.map(([k, v]) => `${k} ${v >= 0 ? "+" : ""}${v.toFixed(2)}`).join("   ")}`);
  }
  process.exit(0);
}
main();
