import { eq } from "drizzle-orm";
import { db, tenants, contacts, contactMemories } from "@/server/db";
import { extractMemories } from "@/server/memory/extract";
import { remember, recall, renderMemoryBlock } from "@/server/memory/store";

async function main() {
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.slug, "northside-hvac") });
  if (!tenant) throw new Error("seed first");

  const [contact] = await db.insert(contacts).values({
    tenantId: tenant.id, displayName: "Memory Test",
  }).returning();

  const messages = [
    "Hi, my Carrier unit is making a noise. It was installed in 2019.",
    "The unit is on the roof, and the gate code is 4471.",
    "Also I have a dog in the yard, and I'm only available after 5pm.",
    "Please don't call, text me instead.",
  ];

  console.log("Extracting from 4 customer messages…\n");
  for (const m of messages) {
    const n = await extractMemories({ tenantId: tenant.id, contactId: contact.id, text: m });
    console.log(`  "${m.slice(0, 54)}…"  → ${n} memories`);
  }

  console.log("\n--- what the agent now knows ---");
  console.log(renderMemoryBlock(await recall(contact.id)));

  console.log("\n--- supersession: customer corrects the gate code ---");
  await remember({
    tenantId: tenant.id, contactId: contact.id,
    kind: "property", key: "access_code", value: "Access code: 9920",
    confidence: 0.95, origin: "agent_tool",
  });
  const live = await recall(contact.id);
  console.log(`  live memories: ${live.length}`);
  console.log(`  access code now: ${live.find((m) => m.key === "access_code")?.value}`);

  const all = await db.query.contactMemories.findMany({
    where: eq(contactMemories.contactId, contact.id),
  });
  const superseded = all.filter((m) => m.supersededAt !== null);
  console.log(`  superseded rows kept for audit: ${superseded.length} (${superseded.map((m) => m.value).join(", ")})`);

  await db.delete(contacts).where(eq(contacts.id, contact.id));
  console.log("\n(test contact cleaned up)");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
