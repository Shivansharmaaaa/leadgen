import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { db, appointments, contacts, events, leads } from "@/server/db";
import { scheduleReviewRequest } from "./reviews";
import { contactData, publish } from "./webhooks";
import { labelLead } from "@/server/learning/features";

/**
 * FEATURE 15 — close the loop on a job.
 *
 * Nothing ever marked an appointment done or a no-show, so the review loop
 * (job done → review request → better Google rating → more inbound) never
 * ran, the dashboard's no-show count was always zero, and a lead that
 * became a job never counted as won for the models that learn from it.
 *
 * The owner closes each past job with one click. Done wins the lead and asks
 * for a review three hours later (everyone is asked: gating on sentiment is
 * against Google's policy and the FTC's rule). The CRM hears about it too.
 */

export type Outcome = "completed" | "no_show" | "cancelled";

export async function jobsToClose(tenantId: string, days = 14) {
  return db.query.appointments.findMany({
    where: and(
      eq(appointments.tenantId, tenantId),
      inArray(appointments.status, ["confirmed", "pending"]),
      lt(appointments.startsAt, new Date()),
      gte(appointments.startsAt, new Date(Date.now() - days * 86400_000)),
    ),
    orderBy: desc(appointments.startsAt),
    limit: 20,
  });
}

export async function recordAppointmentOutcome(
  tenantId: string, appointmentId: string, outcome: Outcome, by: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const appt = await db.query.appointments.findFirst({
    where: and(eq(appointments.id, appointmentId), eq(appointments.tenantId, tenantId)),
  });
  if (!appt) return { ok: false, error: "No such appointment." };
  if (appt.status !== "confirmed" && appt.status !== "pending") {
    return { ok: false, error: `It is already marked ${appt.status.replace("_", "-")}.` };
  }
  // A job can't be done, or missed, before it starts. Cancelling can be any time.
  if (outcome !== "cancelled" && appt.startsAt > new Date()) {
    return { ok: false, error: "That job hasn't started yet." };
  }

  await db.update(appointments).set({ status: outcome }).where(eq(appointments.id, appt.id));
  if (outcome === "completed" && appt.leadId) {
    await db.update(leads).set({ status: "won", updatedAt: new Date() }).where(eq(leads.id, appt.leadId));
    // The conversion label the scoring models learn from.
    await labelLead(appt.leadId, true);
  }
  await db.insert(events).values({
    tenantId, type: `appointment_${outcome}`, contactId: appt.contactId,
    payload: { appointmentId: appt.id, by },
  });
  if (outcome === "completed") await scheduleReviewRequest(appt.id);

  const contact = await db.query.contacts.findFirst({ where: eq(contacts.id, appt.contactId) });
  await publish(tenantId, outcome === "completed" ? "appointment.completed" : outcome === "no_show" ? "appointment.no_show" : "appointment.cancelled", {
    appointment_id: appt.id, service: appt.service, starts_at: appt.startsAt.toISOString(),
    contact: contact ? await contactData(contact.id) : null,
  });
  return { ok: true };
}

/**
 * Won or lost by hand: "went with a competitor", or booked by phone outside
 * the system. Without it a lead only ever got an outcome through a booking
 * here, so the models learnt from wrong labels and dead leads stayed on the
 * reactivation list.
 */
export async function setLeadOutcome(
  tenantId: string, leadId: string, outcome: "won" | "lost", by: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const lead = await db.query.leads.findFirst({ where: and(eq(leads.id, leadId), eq(leads.tenantId, tenantId)) });
  if (!lead) return { ok: false, error: "No such lead." };
  if (lead.status === outcome) return { ok: false, error: `It is already marked ${outcome}.` };
  await db.update(leads).set({ status: outcome, updatedAt: new Date() }).where(eq(leads.id, lead.id));
  await labelLead(lead.id, outcome === "won", lead.estimatedValue != null ? Number(lead.estimatedValue) : undefined);
  await db.insert(events).values({ tenantId, type: `lead_${outcome}`, contactId: lead.contactId, payload: { leadId: lead.id, by } });
  await publish(tenantId, outcome === "won" ? "lead.won" : "lead.lost", {
    lead_id: lead.id, service: lead.service, source: lead.source ?? lead.sourceChannel, contact: await contactData(lead.contactId),
  });
  return { ok: true };
}
