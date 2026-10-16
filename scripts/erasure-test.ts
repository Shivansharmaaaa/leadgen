import { and, eq, sql } from "drizzle-orm";
import {
  db, tenants, locations, contacts, contactIdentities, conversations, messages, leads, appointments, calls,
  events, suppressions, webhookReceipts, jobs,
} from "@/server/db";
import { handleInbound } from "@/server/core/ingest";
import { eraseContact } from "@/server/features/erasure";
import { intakeLead } from "@/server/features/lead-intake";

/**
 * Erasure on request: everything about the person goes, including the
 * places a plain DELETE of the contact would have left behind, and their
 * opt-out survives so they are never contacted again.
 *
 *   npm run erasure:test
 */
process.env.LLM_PROVIDER = "scripted";
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.SMTP_HOST;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const slug = "erasure-test";
  await db.delete(tenants).where(eq(tenants.slug, slug));
  const [tenant] = await db.insert(tenants).values({
    name: "Erasure Test", slug, country: "GB", timezone: "Europe/London",
    settings: { businessName: "Erasure Test", webhooks: [{ url: "https://crm.example.com/hook", secret: "s" }] },
  }).returning();
  await db.insert(locations).values({ tenantId: tenant.id, name: "Main", country: "GB", timezone: "Europe/London", hours: [] });
  const PHONE = "+447700900123", EMAIL = "sam.k_test@example.co.uk";

  try {
    // A person with history on two channels, a lead, a booking and a call.
    const sms = await handleInbound({
      tenantId: tenant.id, channel: "sms", externalId: "SM-e1", externalThreadId: null,
      from: { channel: "sms", externalId: PHONE, name: "Sam Kaur" }, body: `Boiler's broken. Email me at ${EMAIL}`,
    });
    const contactId = sms.contactId;
    await db.insert(leads).values({ tenantId: tenant.id, contactId, conversationId: sms.conversationId, sourceChannel: "sms", service: "Boiler" });
    await db.insert(appointments).values({ tenantId: tenant.id, contactId, service: "Boiler", startsAt: new Date(Date.now() + 86400_000), endsAt: new Date(Date.now() + 90000_000) });
    await db.insert(calls).values({ tenantId: tenant.id, contactId: null, direction: "inbound", providerCallId: "CA-e1",
      fromNumber: PHONE, toNumber: "+441130000000", transcript: [{ who: "caller", text: "my boiler" }] as never });
    await db.insert(webhookReceipts).values({ provider: "twilio-test-erasure", externalId: "SM-e1-raw", payload: { From: PHONE, Body: "Boiler's broken" } });
    await db.insert(events).values({ tenantId: tenant.id, type: "email_ignored", payload: { from: EMAIL, reason: "test" } });
    const otherTenantReceipt = await db.insert(webhookReceipts).values({ provider: "twilio-test-erasure", externalId: "SM-other", payload: { From: "+447700900999" } }).returning();

    const ids = await db.query.contactIdentities.findMany({ where: eq(contactIdentities.contactId, contactId) });
    check("set-up: the email in the text was linked to the same person", ids.some((i) => i.externalId === EMAIL.toLowerCase()) ||
      (await db.query.contacts.findFirst({ where: eq(contacts.id, contactId) }))?.primaryEmail === EMAIL.toLowerCase());

    console.log("\nErase");
    const report = await eraseContact(tenant.id, contactId, "test");
    check("reports what it did", report.erased && report.suppressed === 2 && report.callsDeleted === 1, JSON.stringify(report));
    check("the contact is gone", !(await db.query.contacts.findFirst({ where: eq(contacts.id, contactId) })));
    check("their conversations and messages are gone", !(await db.query.conversations.findFirst({ where: eq(conversations.id, sms.conversationId) })) &&
      (await db.query.messages.findMany({ where: eq(messages.conversationId, sms.conversationId) })).length === 0);
    check("their lead and booking are gone", (await db.query.leads.findMany({ where: eq(leads.tenantId, tenant.id) })).length === 0 &&
      (await db.query.appointments.findMany({ where: eq(appointments.tenantId, tenant.id) })).length === 0);
    check("the call record (number, transcript) is gone — a contact delete alone left it", (await db.query.calls.findMany({ where: eq(calls.tenantId, tenant.id) })).length === 0);
    check("the raw webhook payload with their number is gone", !(await db.query.webhookReceipts.findFirst({ where: eq(webhookReceipts.externalId, "SM-e1-raw") })));
    check("someone else's raw payload is untouched", Boolean(await db.query.webhookReceipts.findFirst({ where: eq(webhookReceipts.id, otherTenantReceipt[0].id) })));
    const leftover = await db.select({ n: sql<number>`count(*)::int` }).from(events)
      .where(and(eq(events.tenantId, tenant.id), sql`${events.payload}::text ilike ${"%" + EMAIL + "%"}`));
    check("no event payload still mentions them", leftover[0].n === 0);
    const log = await db.query.events.findFirst({ where: and(eq(events.tenantId, tenant.id), eq(events.type, "contact_erased")) });
    check("the erasure itself is logged, with nothing about who", Boolean(log) && !JSON.stringify(log?.payload).includes("447700") && !JSON.stringify(log?.payload).includes("example"));
    const sup = await db.query.suppressions.findMany({ where: eq(suppressions.tenantId, tenant.id) });
    check("the suppression list holds hashes, not the number or email", sup.length === 2 && !sup.some((r) => r.identifierHash.includes("447700") || r.identifierHash.includes("@")));
    const crm = await db.query.jobs.findMany({ where: and(eq(jobs.tenantId, tenant.id), eq(jobs.type, "webhook_delivery")) });
    check("the CRM is told to erase them too (Art. 19)", crm.some((j) => (j.payload.event as { type: string }).type === "contact.erased"));

    console.log("\nThey are never contacted again");
    const back = await intakeLead(tenant.id, { source: "website", externalId: "bought-list-1", name: "Sam K", phone: "07700 900123",
      consent: { sms: true, language: "I agree that Erasure Test may text me. Consent is not a condition of purchase." } });
    const reborn = back.contactId ? await db.query.contacts.findFirst({ where: eq(contacts.id, back.contactId) }) : null;
    check("their number arriving again creates a do-not-contact record", reborn?.doNotContact === true);
    check("so the business doesn't text them, even with a ticked box", back.firstResponse !== "sent" && back.firstResponse === "held_for_review", `${back.firstResponse}: ${back.reason}`);
    const fresh = await intakeLead(tenant.id, { source: "website", externalId: "x-2", phone: "07700 900555" });
    const freshContact = fresh.contactId ? await db.query.contacts.findFirst({ where: eq(contacts.id, fresh.contactId) }) : null;
    check("someone else is not affected", freshContact?.doNotContact === false);
    check("erasing someone who isn't there is a no-op", !(await eraseContact(tenant.id, "00000000-0000-0000-0000-000000000000", "test")).erased);
  } finally {
    await db.delete(webhookReceipts).where(eq(webhookReceipts.provider, "twilio-test-erasure"));
    await db.delete(tenants).where(eq(tenants.id, tenant.id));
  }

  console.log(failures ? `\n✗ ${failures} check(s) failed` : "\n✓ all checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
