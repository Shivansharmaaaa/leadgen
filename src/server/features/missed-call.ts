import { and, eq, gte, inArray } from "drizzle-orm";
import { db, conversations, events, leads, tenants } from "@/server/db";
import { contactData, publish } from "./webhooks";
import { resolveContact } from "@/server/core/identity";
import { deliver } from "@/server/core/ingest";

/**
 * FEATURE 5 — missed-call text-back.
 *
 * A call rings out; seconds later the caller gets a text. Cheapest possible
 * win: the lead is already trying to reach the business, and a large share of
 * them will answer a text when nobody picked up.
 *
 * Legally this is a service reply to an inbound contact attempt, not marketing
 * — the caller initiated contact. The justification is logged with the event.
 */
export async function sendMissedCallTextBack(args: {
  tenantId: string;
  fromNumber: string;
  providerCallId: string;
}): Promise<{ sent: boolean; reason?: string }> {
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, args.tenantId) });
  if (!tenant) return { sent: false, reason: "unknown tenant" };

  const contact = await resolveContact(args.tenantId, {
    channel: "voice",
    externalId: args.fromNumber,
  });

  if (contact.doNotContact) return { sent: false, reason: "do-not-contact" };

  const businessName = tenant.settings?.businessName ?? tenant.name;
  const body =
    `Hi, this is ${businessName} — sorry we missed your call. ` +
    `What can we help you with? Reply here and we'll get you sorted.`;

  const conversationId = await openSmsThread(args.tenantId, contact.id, args.fromNumber);

  const sent = await deliver({
    tenantId: args.tenantId,
    conversationId,
    channel: "sms",
    to: { channel: "sms", externalId: args.fromNumber },
    body,
  });

  await db.insert(events).values({
    tenantId: args.tenantId,
    type: "missed_call_text_back",
    conversationId,
    contactId: contact.id,
    payload: {
      callId: args.providerCallId,
      sent,
      basis: "service reply to an inbound call attempt",
    },
  });

  // Someone ringing right now is the warmest lead there is. Without a lead
  // row they were invisible to lead sources, cost per job, the CRM and
  // reactivation. One open lead per person per month, not one per ring.
  const open = await db.query.leads.findFirst({
    where: and(eq(leads.tenantId, args.tenantId), eq(leads.contactId, contact.id),
      inArray(leads.status, ["new", "qualified"]), gte(leads.createdAt, new Date(Date.now() - 30 * 86400_000))),
  });
  if (!open) {
    const [lead] = await db.insert(leads).values({
      tenantId: args.tenantId, contactId: contact.id, conversationId, sourceChannel: "voice", source: "missed_call",
      summary: "Called and nobody answered; texted back.",
    }).returning();
    await publish(args.tenantId, "lead.created", {
      lead_id: lead.id, source: "missed_call", conversation_id: conversationId, first_response: sent ? "sent" : "not_sent",
      contact: await contactData(contact.id),
    });
  }

  return { sent };
}

async function openSmsThread(tenantId: string, contactId: string, phone: string): Promise<string> {
  const existing = await db.query.conversations.findFirst({
    where: and(
      eq(conversations.tenantId, tenantId),
      eq(conversations.contactId, contactId),
      eq(conversations.channel, "sms"),
    ),
  });
  if (existing) return existing.id;

  const [created] = await db.insert(conversations).values({
    tenantId, contactId, channel: "sms", externalThreadId: phone,
  }).returning();
  return created.id;
}
