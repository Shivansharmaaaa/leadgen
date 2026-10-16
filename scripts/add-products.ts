import { eq } from "drizzle-orm";
import { db, tenants, knowledgeFacts } from "@/server/db";

/**
 * Product facts for the demo tenant. A caller asking "what AC options do you
 * have" was answered with appointment times because there was nothing about
 * the systems themselves to answer from — only a brand list buried in prose.
 */
export const PRODUCT_FACTS = [
  { key: "AC system types", value: "central air conditioning, heat pumps (heat and cool), and ductless mini-splits for rooms without ducts" },
  { key: "Brands installed", value: "Carrier (we are a Carrier Factory Authorized Dealer); we also install and service Trane, Lennox, Rheem and Mitsubishi" },
  { key: "Efficiency options", value: "standard, high-efficiency and variable-speed systems; higher efficiency costs more up front and less to run" },
  { key: "How a system is chosen", value: "a technician sizes it to the home on a free in-home visit, then quotes in writing; we do not quote a replacement sight-unseen" },
];

async function main() {
  const t = await db.query.tenants.findFirst({ where: eq(tenants.slug, "northside-hvac") });
  if (!t) throw new Error("seed first");
  for (const f of PRODUCT_FACTS) {
    await db.insert(knowledgeFacts)
      .values({ tenantId: t.id, category: "products", key: f.key, value: f.value })
      .onConflictDoUpdate({
        target: [knowledgeFacts.tenantId, knowledgeFacts.category, knowledgeFacts.key],
        set: { value: f.value },
      });
  }
  console.log(`✓ ${PRODUCT_FACTS.length} product facts`);
  process.exit(0);
}
main();
