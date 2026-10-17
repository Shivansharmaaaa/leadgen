import { mkdirSync, writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db, tenants, locations } from "@/server/db";
import { loadKnowledge } from "@/server/core/knowledge";
import { buildSystemPrompt } from "@/server/agent/prompt";
import { VOICE_TOOLS } from "@/server/agent/voice-turn";
import { PROMISE_PATTERNS } from "@/server/core/guardrails";

/**
 * Export what the fine-tuning data has to match: the real voice system
 * prompt and the real voice tool schemas.
 *
 * Training on a hand-copied prompt would teach the model a prompt it never
 * sees in production. This writes the production one, twice:
 *
 *   template — with {{BUSINESS}}, {{AGENT}} and {{FACTS}} placeholders, so
 *              public dialogue data about other businesses can be rendered
 *              into exactly the production layout
 *   hvac     — the seeded tenant's prompt as served, for in-domain examples
 */
async function main() {
  const tools = VOICE_TOOLS.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));

  const placeholderTenant = {
    name: "{{BUSINESS}}", timezone: "UTC",
    settings: { businessName: "{{BUSINESS}}", agentName: "{{AGENT}}" },
  } as never;
  const knownContact = {
    displayName: "{{NAME}}", primaryPhone: "{{PHONE}}", primaryEmail: null, doNotContact: false,
  } as never;
  const unknownContact = {
    displayName: null, primaryPhone: null, primaryEmail: null, doNotContact: false,
  } as never;

  const template = buildSystemPrompt({
    tenant: placeholderTenant, contact: knownContact, channel: "voice",
    knowledge: { factsBlock: "{{FACTS}}", proseBlock: "", truncated: false },
  });

  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.slug, "northside-hvac") });
  if (!tenant) throw new Error("tenant northside-hvac not found — run npm run seed");
  const location = await db.query.locations.findFirst({ where: eq(locations.tenantId, tenant.id) });
  const knowledge = await loadKnowledge(tenant.id);
  const hvac = buildSystemPrompt({ tenant, contact: unknownContact, location, channel: "voice", knowledge });
  const hvacKnown = buildSystemPrompt({ tenant, contact: knownContact, location, channel: "voice", knowledge });

  mkdirSync("data/finetune", { recursive: true });
  writeFileSync("data/finetune/prompt-kit.json", JSON.stringify({
    tools,
    template,
    // Phrases Gate 2 always holds: build_dataset.py refuses any target using one.
    holdPatterns: PROMISE_PATTERNS.map((re) => ({ source: re.source, flags: re.flags })),
    hvac: {
      business: tenant.settings?.businessName ?? tenant.name,
      agent: tenant.settings?.agentName ?? "Alex",
      timezone: location?.timezone ?? tenant.timezone,
      system: hvac.system,
      contextUnknown: hvac.context,
      contextKnown: hvacKnown.context,
    },
  }, null, 2));
  console.log(`✓ data/finetune/prompt-kit.json  (${tools.length} tools, system ${hvac.system.length} chars)`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
