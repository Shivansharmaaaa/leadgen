import { eq, and } from "drizzle-orm";
import { db, tenants, contacts, conversations, messages } from "@/server/db";

const API = "http://localhost:3100/api/inbox";
const post = async (body: unknown) => {
  const r = await fetch(API, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
};

async function main() {
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.slug, "northside-hvac") });
  if (!tenant) throw new Error("seed first");

  const [contact] = await db.insert(contacts).values({
    tenantId: tenant.id, displayName: "Takeover Test", primaryPhone: "+16175550999",
  }).returning();
  const [convo] = await db.insert(conversations).values({
    tenantId: tenant.id, contactId: contact.id, channel: "sms",
    externalThreadId: `takeover_${Date.now()}`,
  }).returning();
  await db.insert(messages).values({
    tenantId: tenant.id, conversationId: convo.id, direction: "inbound",
    channel: "sms", authorType: "contact", body: "What would a new system cost me?",
  });
  const [draft] = await db.insert(messages).values({
    tenantId: tenant.id, conversationId: convo.id, direction: "outbound",
    channel: "sms", authorType: "ai", body: "It'd be about $45 to swap that out.",
    status: "held_for_review", meta: { holdReason: "quoted $45 below price floor 89" },
  }).returning();

  console.log("1. take over the thread");
  console.log("  ", (await post({ action: "takeover", conversationId: convo.id })).json);
  let c = await db.query.conversations.findFirst({ where: eq(conversations.id, convo.id) });
  console.log(`   aiPaused in DB = ${c!.aiPaused}`);

  console.log("\n2. approve the held draft, edited to a lawful price");
  const approved = await post({
    action: "approve_draft", messageId: draft.id,
    body: "The diagnostic visit is $89, waived if you go ahead with the repair.",
  });
  console.log("  ", approved.json);
  const after = await db.query.messages.findFirst({ where: eq(messages.id, draft.id) });
  console.log(`   draft status = ${after!.status}  edited = ${after!.meta?.edited}`);

  console.log("\n3. send a human reply");
  console.log("  ", (await post({ action: "reply", conversationId: convo.id, body: "Dana here — happy to talk it through." })).json);

  console.log("\n4. discard a second bad draft");
  const [draft2] = await db.insert(messages).values({
    tenantId: tenant.id, conversationId: convo.id, direction: "outbound",
    channel: "sms", authorType: "ai", body: "I guarantee someone will be there by noon.",
    status: "held_for_review", meta: { holdReason: "unauthorised promise" },
  }).returning();
  console.log("  ", (await post({ action: "discard_draft", messageId: draft2.id })).json);
  const d2 = await db.query.messages.findFirst({ where: eq(messages.id, draft2.id) });
  console.log(`   status = ${d2!.status} · ${d2!.error}`);

  console.log("\n5. hand back to the AI");
  console.log("  ", (await post({ action: "release", conversationId: convo.id })).json);

  console.log("\n6. reject an invalid action");
  console.log("  ", (await post({ action: "nonsense" })).json);

  const final = await db.query.messages.findMany({
    where: eq(messages.conversationId, convo.id),
  });
  console.log(`\nthread now has ${final.length} messages: ${final.map((m) => `${m.authorType}/${m.status}`).join(", ")}`);

  await db.delete(contacts).where(eq(contacts.id, contact.id));
  console.log("(cleaned up)");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
