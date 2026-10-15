import { eq } from "drizzle-orm";
import { db, appointments, contacts, events, tenants, channelAccounts } from "@/server/db";
import { createHash } from "node:crypto";

/**
 * FEATURE 6 — ad conversion feedback.
 *
 * Push the BOOKED JOB back to Meta and Google as a conversion, instead of
 * letting their algorithms optimise on form fills. The ad platform then buys
 * more of the traffic that becomes revenue rather than more of the traffic
 * that becomes junk leads.
 *
 * This is the stickiest thing in the product: once a client's ad spend is
 * being optimised on your conversion signal, replacing you means their cost
 * per job goes back up.
 *
 * Meta's Conversions API requires identifiers to be SHA-256 hashed before
 * transmission — raw email or phone must never leave this process.
 */
const sha256 = (v: string) => createHash("sha256").update(v.trim().toLowerCase()).digest("hex");

export type ConversionEvent = {
  eventName: "Lead" | "Schedule" | "Purchase";
  value?: number;
  currency?: string;
  eventTime: number;
  hashedEmail?: string;
  hashedPhone?: string;
  eventId: string;
};

export async function buildConversionEvent(
  appointmentId: string,
  eventName: ConversionEvent["eventName"] = "Schedule",
): Promise<{ event: ConversionEvent; tenantId: string } | null> {
  const appt = await db.query.appointments.findFirst({
    where: eq(appointments.id, appointmentId),
  });
  if (!appt) return null;

  const [tenant, contact] = await Promise.all([
    db.query.tenants.findFirst({ where: eq(tenants.id, appt.tenantId) }),
    db.query.contacts.findFirst({ where: eq(contacts.id, appt.contactId) }),
  ]);
  if (!tenant || !contact) return null;

  return {
    tenantId: tenant.id,
    event: {
      eventName,
      value: undefined,
      currency: tenant.settings?.currency ?? "USD",
      eventTime: Math.floor(appt.createdAt.getTime() / 1000),
      // Hashed before it ever leaves this function.
      hashedEmail: contact.primaryEmail ? sha256(contact.primaryEmail) : undefined,
      hashedPhone: contact.primaryPhone ? sha256(contact.primaryPhone.replace(/\D/g, "")) : undefined,
      // Deterministic id so Meta deduplicates against the browser pixel.
      eventId: `appt_${appt.id}`,
    },
  };
}

/** POST to Meta's Conversions API for the tenant's pixel. */
export async function sendToMetaCapi(tenantId: string, event: ConversionEvent) {
  const account = await db.query.channelAccounts.findFirst({
    where: eq(channelAccounts.tenantId, tenantId),
  });
  const pixelId = account?.config?.pixelId as string | undefined;
  const token = account?.credentials?.capiToken;

  if (!pixelId || !token) {
    return { sent: false, reason: "no pixel id or CAPI token configured for this tenant" };
  }

  const res = await fetch(`https://graph.facebook.com/v21.0/${pixelId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      access_token: token,
      data: [{
        event_name: event.eventName,
        event_time: event.eventTime,
        event_id: event.eventId,
        action_source: "phone_call",
        user_data: {
          ...(event.hashedEmail ? { em: [event.hashedEmail] } : {}),
          ...(event.hashedPhone ? { ph: [event.hashedPhone] } : {}),
        },
        ...(event.value ? { custom_data: { value: event.value, currency: event.currency } } : {}),
      }],
    }),
  });

  const ok = res.ok;
  await db.insert(events).values({
    tenantId, type: "conversion_pushed",
    payload: { platform: "meta", eventName: event.eventName, ok, status: res.status },
  });

  return { sent: ok, reason: ok ? undefined : await res.text() };
}
