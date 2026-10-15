import { eq } from "drizzle-orm";
import { db, tenants, locations } from "@/server/db";
import { loadKnowledge } from "@/server/core/knowledge";
import { buildSystemPrompt } from "@/server/agent/prompt";
import { TOOL_DEFS } from "@/server/agent/tools";

async function main() {
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.slug, "northside-hvac") });
  if (!tenant) throw new Error("seed first");
  const location = await db.query.locations.findFirst({ where: eq(locations.tenantId, tenant.id) });
  const knowledge = await loadKnowledge(tenant.id);
  const contact = { displayName: null, primaryPhone: null, primaryEmail: null, doNotContact: false } as never;

  const system = buildSystemPrompt({ tenant, contact, location, channel: "webchat", knowledge });
  const toolsJson = JSON.stringify(TOOL_DEFS);
  const est = (s: string) => Math.ceil(s.length / 4);
  const total = est(system) + est(toolsJson);

  console.log(`system prompt : ${system.length} chars  ~${est(system)} tokens`);
  console.log(`tool schemas  : ${toolsJson.length} chars  ~${est(toolsJson)} tokens`);
  console.log(`TOTAL         : ~${total} tokens`);
  console.log(`num_ctx 8192  : ${total > 8192 ? "OVERFLOWING — silently truncated" : "fits"}`);
  process.exit(0);
}
main();
