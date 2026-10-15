import { and, eq, gte } from "drizzle-orm";
import { db, appointments, contacts, events, tenants, jobs } from "@/server/db";
import { deliver } from "@/server/core/ingest";
import { canInitiateOutbound } from "@/server/core/guardrails";

/**
 * FEATURE 4 — review velocity loop.
 *
 * Completed job -> review request -> higher Google rating -> better local
 * ranking -> more inbound leads -> back into the same pipeline. This is the
 * loop that compounds, and it is why reputation tools (Podium, Birdeye) sell
 * so well to local businesses.
 *
 * Never gate the request on sentiment ("only ask happy customers") — review
 * gating violates Google's policy and the FTC's rule on review suppression.
 * Ask everyone; handle bad reviews with a good reply instead.
 */
export async function scheduleReviewRequest(appointmentId: string, delayHours = 3) {
  const appt = await db.query.appointments.findFirst({
    where: eq(appointments.id, appointmentId),
  });
  if (!appt) return;

  await db.insert(jobs).values({
    tenantId: appt.tenantId,
    type: "review_request",
    payload: { appointmentId },
    runAt: new Date(Date.now() + delayHours * 3600_000),
    idempotencyKey: `review_request:${appointmentId}`,
  }).onConflictDoNothing();
}

export async function sendReviewRequest(appointmentId: string): Promise<{ sent: boolean; reason?: string }> {
  const appt = await db.query.appointments.findFirst({
    where: eq(appointments.id, appointmentId),
  });
  if (!appt) return { sent: false, reason: "appointment not found" };
  if (appt.status !== "completed") return { sent: false, reason: `status is ${appt.status}` };

  const [tenant, contact] = await Promise.all([
    db.query.tenants.findFirst({ where: eq(tenants.id, appt.tenantId) }),
    db.query.contacts.findFirst({ where: eq(contacts.id, appt.contactId) }),
  ]);
  if (!tenant || !contact) return { sent: false, reason: "missing tenant or contact" };

  const channel = contact.smsConsent ? "sms" : contact.emailConsent ? "email" : null;
  if (!channel) return { sent: false, reason: "no consented channel for a review request" };

  const verdict = canInitiateOutbound(channel, contact);
  if (!verdict.ok) return { sent: false, reason: verdict.reason };

  const businessName = tenant.settings?.businessName ?? tenant.name;
  const reviewUrl = (tenant.settings as Record<string, unknown>).reviewUrl ?? "";
  const body =
    `Thanks for choosing ${businessName}! If we did right by you, a quick review ` +
    `really helps a small local business.${reviewUrl ? ` ${reviewUrl}` : ""}`;

  const { conversations } = await import("@/server/db");
  const convo = await db.query.conversations.findFirst({
    where: and(eq(conversations.contactId, contact.id), eq(conversations.channel, channel)),
  });
  const conversationId = convo?.id ?? (await db.insert(conversations).values({
    tenantId: tenant.id, contactId: contact.id, channel,
  }).returning())[0].id;

  const sent = await deliver({
    tenantId: tenant.id,
    conversationId,
    channel,
    to: {
      channel,
      externalId: channel === "sms" ? contact.primaryPhone! : contact.primaryEmail!,
    },
    body,
  });

  await db.insert(events).values({
    tenantId: tenant.id, type: "review_requested",
    contactId: contact.id, payload: { appointmentId, channel, sent },
  });

  return { sent };
}

/** Draft a public reply to a review. Low ratings always route to a human. */
export function draftReviewReply(rating: number, text: string, businessName: string): {
  reply: string; requiresHuman: boolean;
} {
  if (rating <= 3) {
    return {
      requiresHuman: true,
      reply:
        `Thank you for the feedback, and I'm sorry we fell short. ` +
        `I'd like to understand what happened — please contact us directly so we can put it right.`,
    };
  }
  return {
    requiresHuman: false,
    reply: `Thank you — we really appreciate you taking the time. The team at ${businessName} is glad we could help.`,
  };
}

export async function reviewVelocity(tenantId: string, days = 90) {
  const since = new Date(Date.now() - days * 86400_000);
  const rows = await db.query.events.findMany({
    where: and(eq(events.tenantId, tenantId), gte(events.createdAt, since)),
  });
  const requested = rows.filter((r) => r.type === "review_requested").length;
  const left = rows.filter((r) => r.type === "review_received").length;
  return { requested, left, conversionPct: requested ? (left / requested) * 100 : 0 };
}
