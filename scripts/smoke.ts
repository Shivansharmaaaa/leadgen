import { eq, desc } from "drizzle-orm";
import {
  db, tenants, contacts, contactIdentities, conversations, messages, leads, appointments, events, agentRuns,
  locations, knowledgeFacts, knowledgeDocs, staff,
} from "@/server/db";
import { handleInbound } from "@/server/core/ingest";
import { getProvider } from "@/server/agent/providers";
import type { InboundMessage } from "@/server/core/types";

// .env may hold live Twilio and SMTP credentials; a smoke run proves the
// pipeline and must never text or email anyone.
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.SMTP_HOST;

const line = (s = "") => console.log(s);
const rule = () => line("─".repeat(72));

async function say(msg: InboundMessage, label: string) {
  line();
  rule();
  line(`${label}`);
  line(`  customer › ${msg.body}`);
  const t0 = Date.now();
  const res = await handleInbound(msg);
  const ms = Date.now() - t0;

  if (res.duplicate) { line("  (duplicate — ignored, idempotency working)"); return res; }

  const o = res.outcome;
  if (o?.toolCalls.length) {
    for (const tc of o.toolCalls) {
      const out = tc.output as Record<string, unknown>;
      const summary = out?.ok === false ? `✗ ${out.error}` : "✓";
      line(`     ⚙ ${tc.name} ${summary} (${tc.ms}ms)`);
    }
  }
  if (o?.holdReason) line(`     ⛔ HELD: ${o.holdReason}`);
  if (o?.reply) line(`  agent    › ${o.reply}`);
  line(`     [${ms}ms total · $${o?.costUsd.toFixed(6) ?? "0"} · ${o?.provider}:${o?.model}]`);
  return res;
}

async function main() {
  const source = await db.query.tenants.findFirst({ where: eq(tenants.slug, "northside-hvac") });
  if (!source) throw new Error("run `npm run seed` first");

  // Run against a fresh copy of the demo business, never the business itself:
  // a clean slate here used to mean deleting every contact of northside-hvac,
  // which wiped eval history and anyone else's test data in a shared
  // database. The copy is replaced on each run and left for inspecting
  // (TENANT_SLUG=northside-hvac-smoke).
  const tenant = await cloneTenant(source, "northside-hvac-smoke");

  const provider = getProvider();
  rule();
  line(`LEADGEN SMOKE TEST`);
  line(`  provider: ${provider.id}:${provider.model}`);
  if (!provider.productionGrade) {
    line(`  ⚠ local model — proves the pipeline, NOT production reply quality`);
  }

  // ── Act 1: a stranger DMs on Instagram ────────────────────────────────────
  const igId = "ig_user_88213";
  await say({
    tenantId: tenant.id,
    channel: "instagram",
    externalId: "ig_msg_1",
    externalThreadId: "ig_thread_1",
    from: { channel: "instagram", externalId: igId, handle: "@marcus.r", name: "Marcus Reyes" },
    body: "hey do you guys fix AC units? mine is blowing warm air",
  }, "ACT 1 — cold Instagram DM");

  await say({
    tenantId: tenant.id,
    channel: "instagram",
    externalId: "ig_msg_2",
    externalThreadId: "ig_thread_1",
    from: { channel: "instagram", externalId: igId, handle: "@marcus.r" },
    body: "it's pretty urgent, the house is 84 degrees. I'm in Quincy. my number is (617) 555-0188",
  }, "ACT 2 — urgency + phone number handed over");

  // ── Act 3: webhook redelivery ─────────────────────────────────────────────
  await say({
    tenantId: tenant.id,
    channel: "instagram",
    externalId: "ig_msg_2",
    externalThreadId: "ig_thread_1",
    from: { channel: "instagram", externalId: igId, handle: "@marcus.r" },
    body: "it's pretty urgent, the house is 84 degrees. I'm in Quincy. my number is (617) 555-0188",
  }, "ACT 3 — Meta redelivers the same webhook");

  // ── Act 4: the same human phones in. Different channel, same person. ──────
  await say({
    tenantId: tenant.id,
    channel: "voice",
    externalId: "call_sid_1",
    externalThreadId: "call_sid_1",
    from: { channel: "voice", externalId: "+16175550188" },
    body: "Hi, I messaged you on Instagram earlier about my air conditioning. Can I get someone out tomorrow?",
  }, "ACT 4 — same person calls the office line");

  // ── Act 5: guardrail — a question that invites an invented price ──────────
  await say({
    tenantId: tenant.id,
    channel: "instagram",
    externalId: "ig_msg_5",
    externalThreadId: "ig_thread_1",
    from: { channel: "instagram", externalId: igId },
    body: "and roughly what would a whole new system run me?",
  }, "ACT 5 — price question (must quote only verified facts)");

  // ── Act 6: escalation trigger ─────────────────────────────────────────────
  await say({
    tenantId: tenant.id,
    channel: "instagram",
    externalId: "ig_msg_6",
    externalThreadId: "ig_thread_1",
    from: { channel: "instagram", externalId: igId },
    body: "actually my lawyer says the last company damaged my ducts, I want to discuss a refund",
  }, "ACT 6 — legal + refund (must escalate, not answer)");

  // ── Results ───────────────────────────────────────────────────────────────
  line();
  rule();
  line("IDENTITY RESOLUTION");
  const allContacts = await db.query.contacts.findMany({ where: eq(contacts.tenantId, tenant.id) });
  for (const c of allContacts) {
    const ids = await db.query.contactIdentities.findMany({
      where: eq(contactIdentities.contactId, c.id),
    });
    line(`  contact: ${c.displayName ?? "(unnamed)"} | phone ${c.primaryPhone ?? "—"} | email ${c.primaryEmail ?? "—"}`);
    line(`    reachable on: ${ids.map((i) => `${i.channel}:${i.externalId}`).join(", ")}`);
  }
  line(`  → ${allContacts.length} contact row(s) for a person who used 2 channels`);
  line(`     (1 means cross-channel identity resolution worked)`);

  line();
  line("CONVERSATIONS");
  const convs = await db.query.conversations.findMany({
    where: eq(conversations.tenantId, tenant.id), orderBy: desc(conversations.lastMessageAt),
  });
  for (const c of convs) {
    const msgs = await db.query.messages.findMany({ where: eq(messages.conversationId, c.id) });
    line(`  ${c.channel.padEnd(10)} ${msgs.length} msgs  ai_paused=${c.aiPaused}`);
  }

  line();
  line("OUTCOMES CAPTURED");
  const [ls, appts, evs, runs] = await Promise.all([
    db.query.leads.findMany({ where: eq(leads.tenantId, tenant.id) }),
    db.query.appointments.findMany({ where: eq(appointments.tenantId, tenant.id) }),
    db.query.events.findMany({ where: eq(events.tenantId, tenant.id) }),
    db.query.agentRuns.findMany({ where: eq(agentRuns.tenantId, tenant.id) }),
  ]);
  for (const l of ls) line(`  lead: ${l.service} | ${l.urgency} | score ${l.score} | ${l.status}`);
  for (const a of appts) line(`  appointment: ${a.service} @ ${a.startsAt.toISOString()} (${a.status})`);
  line(`  events: ${evs.map((e) => e.type).join(", ")}`);

  const totalCost = runs.reduce((s, r) => s + Number(r.costUsd), 0);
  const avgLatency = runs.length ? Math.round(runs.reduce((s, r) => s + r.latencyMs, 0) / runs.length) : 0;
  line();
  line(`  ${runs.length} agent runs · avg ${avgLatency}ms · total $${totalCost.toFixed(6)}`);
  rule();
  process.exit(0);
}

main().catch((e) => { console.error("\n✗ FAILED:", e); process.exit(1); });

/** A copy of a tenant's set-up (settings, locations, knowledge, team), with no activity. */
async function cloneTenant(src: typeof tenants.$inferSelect, slug: string) {
  await db.delete(tenants).where(eq(tenants.slug, slug));
  const { id: _id, createdAt: _c, slug: _s, ...rest } = src;
  const [copy] = await db.insert(tenants).values({ ...rest, slug, name: `${src.name} (smoke test)` }).returning();
  const strip = <T extends { id: string; tenantId: string }>(rows: T[]) =>
    rows.map(({ id: _i, ...r }) => ({ ...r, tenantId: copy.id }));
  const [locs, facts, docs, team] = await Promise.all([
    db.query.locations.findMany({ where: eq(locations.tenantId, src.id) }),
    db.query.knowledgeFacts.findMany({ where: eq(knowledgeFacts.tenantId, src.id) }),
    db.query.knowledgeDocs.findMany({ where: eq(knowledgeDocs.tenantId, src.id) }),
    db.query.staff.findMany({ where: eq(staff.tenantId, src.id) }),
  ]);
  if (locs.length) await db.insert(locations).values(strip(locs));
  if (facts.length) await db.insert(knowledgeFacts).values(strip(facts));
  if (docs.length) await db.insert(knowledgeDocs).values(strip(docs));
  // The team without phones: a smoke run must never page a real person.
  if (team.length) await db.insert(staff).values(strip(team).map((m) => ({ ...m, phone: null })));
  return copy;
}
