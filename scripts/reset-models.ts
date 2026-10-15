import { db, modelWeights } from "@/server/db";
import { seedPriorIfMissing } from "@/server/learning/prior";

async function main() {
  await db.delete(modelWeights);
  const res = await seedPriorIfMissing("home_services", "US");
  console.log(`cleared trained models; benchmark prior seeded: ${res.seeded}`);

  const rows = await db.query.modelWeights.findMany();
  for (const r of rows) {
    console.log(`  ${r.vertical}/${r.country} POOLED  n=${r.sampleSize}  base=${r.baseRate}`);
    const top = Object.entries(r.weights)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 5);
    console.log(`     ${top.map(([k, v]) => `${k} ${v >= 0 ? "+" : ""}${v.toFixed(2)}`).join("   ")}`);
  }
  process.exit(0);
}
main();
