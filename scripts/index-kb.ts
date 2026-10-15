import { eq } from "drizzle-orm";
import { db, tenants } from "@/server/db";
import { indexTenant } from "@/server/retrieval";
import { hybridSearch } from "@/server/retrieval/retrieve";
import { getEmbeddingProvider } from "@/server/retrieval/embeddings";

async function main() {
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.slug, "northside-hvac") });
  if (!tenant) throw new Error("run npm run seed first");

  const provider = getEmbeddingProvider();
  console.log(`Indexing with ${provider.id}:${provider.model} (${provider.dimensions}d)\n`);

  const t0 = Date.now();
  const { docs, chunks } = await indexTenant(tenant.id);
  console.log(`✓ indexed ${docs} documents into ${chunks} chunks in ${Date.now() - t0}ms\n`);

  const queries = [
    "are your technicians certified",
    "how fast can you come out",
    "do you take credit cards or financing",
    "what brands do you work on",
  ];

  for (const q of queries) {
    const t = Date.now();
    const hits = await hybridSearch(tenant.id, q, 2);
    console.log(`"${q}"  ${Date.now() - t}ms`);
    for (const h of hits) {
      const via = [h.vectorRank && `vec#${h.vectorRank}`, h.textRank && `txt#${h.textRank}`]
        .filter(Boolean).join(" ");
      console.log(`   [${via}] ${h.content.slice(0, 110).replace(/\n/g, " ")}…`);
    }
    console.log();
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
