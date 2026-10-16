import { and, eq, inArray, or, sql } from "drizzle-orm";
import {
  db, calls, contactIdentities, contacts, events, suppressions, webhookReceipts,
} from "@/server/db";
import { normalizeEmail, normalizePhone } from "@/server/core/phone";
import { identifierHash } from "@/server/core/suppression";
import { contactData, publish } from "./webhooks";

/**
 * FEATURE 13 — erase a person on request.
 *
 * UK GDPR Art. 17 (and CCPA deletion, PIPEDA withdrawal) let a person have
 * their data deleted. Deleting the contact row was not enough: call records
 * keep the caller's number, transcript and recording link with the contact
 * set to null; raw webhook receipts keep the payload; some events carry an
 * address in their payload.
 *
 * Erasure must not undo an opt-out, either. "Delete my data and never call
 * me" is one request, and a bought list or an old form could otherwise bring
 * them straight back. So a keyed hash of each phone and email goes on a
 * suppression list (the ICO accepts keeping that minimum to honour an
 * objection), and any contact created later with a suppressed identifier is
 * born do-not-contact. If they get in touch themselves, they can still be
 * answered; the business just never starts it.
 *
 * Recipients must be told (Art. 19): the CRM gets a contact.erased webhook.
 */

export type ErasureReport = {
  erased: boolean;
  suppressed: number;
  callsDeleted: number;
  receiptsDeleted: number;
  eventsDeleted: number;
};

export async function eraseContact(tenantId: string, contactId: string, requestedBy: string): Promise<ErasureReport> {
  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, contactId), eq(contacts.tenantId, tenantId)),
  });
  if (!contact) return { erased: false, suppressed: 0, callsDeleted: 0, receiptsDeleted: 0, eventsDeleted: 0 };

  const tenant = await db.query.tenants.findFirst({ where: (t, { eq: e }) => e(t.id, tenantId) });
  const country = tenant?.country ?? "US";
  const identities = await db.query.contactIdentities.findMany({
    where: and(eq(contactIdentities.tenantId, tenantId), eq(contactIdentities.contactId, contactId)),
  });
  const phones = new Set<string>(), emails = new Set<string>();
  for (const v of [contact.primaryPhone, ...identities.map((i) => i.externalId)]) {
    const p = v ? normalizePhone(v, country) : null;
    if (p) phones.add(p);
  }
  for (const v of [contact.primaryEmail, ...identities.map((i) => i.externalId)]) {
    const e = normalizeEmail(v);
    if (e) emails.add(e);
  }
  const identifiers = [...phones, ...emails];

  // Tell the CRM first, while there is still something to tell it.
  await publish(tenantId, "contact.erased", { contact: await contactData(contactId), requested_by: requestedBy });

  return db.transaction(async (tx) => {
    if (identifiers.length) {
      await tx.insert(suppressions).values(identifiers.map((i) => ({
        tenantId, identifierHash: identifierHash(tenantId, i), reason: "erasure",
      }))).onConflictDoNothing();
    }

    const deletedCalls = await tx.delete(calls).where(and(eq(calls.tenantId, tenantId), or(
      eq(calls.contactId, contactId),
      ...(phones.size ? [inArray(calls.fromNumber, [...phones]), inArray(calls.toNumber, [...phones])] : []),
    ))).returning({ id: calls.id });

    // Raw payloads and event payloads that mention them, matched as text.
    let receipts = 0, eventsDeleted = 0;
    for (const id of identifiers) {
      const like = `%${id.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      receipts += (await tx.delete(webhookReceipts)
        .where(sql`${webhookReceipts.payload}::text ilike ${like}`).returning({ id: webhookReceipts.id })).length;
      eventsDeleted += (await tx.delete(events)
        .where(and(eq(events.tenantId, tenantId), sql`${events.payload}::text ilike ${like}`)).returning({ id: events.id })).length;
    }

    // Cascades to identities, conversations (and their messages and agent
    // runs), leads, appointments, memories, consents and events.
    await tx.delete(contacts).where(eq(contacts.id, contactId));

    // The record that it happened, with nothing about who.
    await tx.insert(events).values({
      tenantId, type: "contact_erased",
      payload: { requestedBy, identifiersSuppressed: identifiers.length, at: new Date().toISOString() },
    });

    return {
      erased: true, suppressed: identifiers.length, callsDeleted: deletedCalls.length,
      receiptsDeleted: receipts, eventsDeleted,
    };
  });
}
