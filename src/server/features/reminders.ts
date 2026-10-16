import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { db, appointments, contacts, conversations, events, jobs, locations, messages, tenants } from "@/server/db";
import { deliver } from "@/server/core/ingest";

/**
 * FEATURE 8 — appointment confirmations and reminders.
 *
 * A booked job the customer forgets is a technician driving to an empty
 * house. Every product in this category sends a reminder the day before and
 * on the day, and lets the customer confirm or ask to move it by reply.
 *
 * Legally these are transactional: information about a booking the person
 * made, using the number they gave to make it. TCPA needs only prior express
 * consent for that (giving the number when booking), not the written consent
 * marketing needs; CASL exempts it from consent but still requires the sender
 * be identified and an unsubscribe offered; PECR treats it as a service
 * message. So reminders go to anyone not on do-not-contact, always name the
 * business and always carry "Reply STOP".
 *
 * Replies are read only when the last thing we sent in that thread was a
 * reminder: a bare "yes" anywhere else belongs to the agent's conversation.
 * "R" never re-books by itself — the slot is held as pending and a person
 * finds a new time, because a local model with a booking tool can double-book.
 * CANCEL is a carrier opt-out keyword, so it is never offered as a reply.
 */

/** Never text outside these local hours (TCPA's 8am–9pm, Florida's 8pm). */
const SEND_FROM_HOUR = 8;
const SEND_UNTIL_HOUR = 20;

export type ReminderKind = "confirmation" | "day_before" | "same_day";

export async function scheduleAppointmentReminders(appointmentId: string, opts: { bookedOnCall?: boolean } = {}) {
  const appt = await db.query.appointments.findFirst({ where: eq(appointments.id, appointmentId) });
  if (!appt) return [];
  const tz = await timezoneFor(appt.tenantId, appt.locationId);
  const now = new Date();

  const plan: { kind: ReminderKind; at: Date }[] = [];
  // Someone who booked by voice has nothing in writing.
  if (opts.bookedOnCall) plan.push({ kind: "confirmation", at: now });

  const dayBefore = clampToSendingHours(new Date(appt.startsAt.getTime() - 24 * 3600_000), tz);
  if (dayBefore > now) plan.push({ kind: "day_before", at: dayBefore });

  // Two hours ahead, only if that falls inside sending hours on the day; a
  // 9am job does not get a 7am text, the day-before reminder covers it.
  const sameDay = new Date(appt.startsAt.getTime() - 2 * 3600_000);
  if (sameDay > now && withinSendingHours(sameDay, tz) && sameDay.getTime() - dayBefore.getTime() > 6 * 3600_000) {
    plan.push({ kind: "same_day", at: sameDay });
  }

  for (const p of plan) {
    await db.insert(jobs).values({
      tenantId: appt.tenantId,
      type: "appointment_reminder",
      payload: { appointmentId, kind: p.kind, startsAt: appt.startsAt.toISOString() },
      runAt: p.at,
      // Keyed on the start time: a rescheduled job gets fresh reminders, and the
      // old ones see the time moved and stand down.
      idempotencyKey: `reminder:${appointmentId}:${p.kind}:${appt.startsAt.toISOString()}`,
    }).onConflictDoNothing();
  }
  return plan;
}

export async function sendAppointmentReminder(payload: Record<string, unknown>): Promise<{ sent: boolean; reason?: string }> {
  const appt = await db.query.appointments.findFirst({ where: eq(appointments.id, String(payload.appointmentId)) });
  if (!appt) return { sent: false, reason: "appointment not found" };
  if (appt.status === "cancelled" || appt.status === "completed" || appt.status === "no_show") {
    return { sent: false, reason: `appointment is ${appt.status}` };
  }
  if (appt.startsAt.toISOString() !== payload.startsAt) return { sent: false, reason: "appointment was moved" };
  if (appt.startsAt <= new Date()) return { sent: false, reason: "appointment has started" };
  const kind = payload.kind as ReminderKind;
  if (kind !== "confirmation" && appt.rescheduleRequestedAt) return { sent: false, reason: "reschedule requested" };

  const [tenant, contact] = await Promise.all([
    db.query.tenants.findFirst({ where: eq(tenants.id, appt.tenantId) }),
    db.query.contacts.findFirst({ where: eq(contacts.id, appt.contactId) }),
  ]);
  if (!tenant || !contact) return { sent: false, reason: "missing tenant or contact" };
  if (contact.doNotContact) return { sent: false, reason: "contact is on do-not-contact" };
  if (!contact.primaryPhone) return { sent: false, reason: "no phone number to text" };

  const tz = await timezoneFor(appt.tenantId, appt.locationId);
  if (kind !== "confirmation" && !withinSendingHours(new Date(), tz)) {
    return { sent: false, reason: "outside sending hours" };
  }

  const body = reminderText(kind, {
    business: tenant.settings?.businessName ?? tenant.name,
    firstName: contact.displayName?.split(/\s+/)[0] ?? null,
    service: appt.service,
    when: appt.startsAt,
    tz,
    customerConfirmed: Boolean(appt.customerConfirmedAt),
  });

  const conversationId = await smsThread(appt.tenantId, contact.id, contact.primaryPhone);
  const sent = await deliver({
    tenantId: appt.tenantId,
    conversationId,
    channel: "sms",
    to: { channel: "sms", externalId: contact.primaryPhone },
    body,
    initiated: true,
    transactional: true,
    meta: { reminderFor: appt.id, reminderKind: kind },
  });

  await db.insert(events).values({
    tenantId: appt.tenantId, type: "appointment_reminder", conversationId, contactId: contact.id,
    payload: { appointmentId: appt.id, kind, sent },
  });
  return { sent };
}

export function reminderText(kind: ReminderKind, a: {
  business: string; firstName: string | null; service: string; when: Date; tz: string; customerConfirmed: boolean;
}): string {
  const hi = a.firstName ? `Hi ${a.firstName}, ` : "Hi, ";
  const day = formatInTimeZone(a.when, a.tz, "EEE d MMM");
  const time = formatInTimeZone(a.when, a.tz, "h:mm a");
  // "Furnace tune-up" reads as "your furnace tune-up"; "AC repair" keeps its capitals.
  const service = a.service.replace(/^([A-Z])(?=[a-z])/, (c) => c.toLowerCase());
  switch (kind) {
    case "confirmation":
      return `${a.business}: you're booked for ${service} on ${day} at ${time}. ` +
        `We'll text a reminder the day before. Reply R to reschedule, STOP to opt out.`;
    case "day_before":
      return `${hi}a reminder from ${a.business}: your ${service} is tomorrow, ${day}, at ${time}. ` +
        (a.customerConfirmed ? "Reply R to reschedule, STOP to opt out." : "Reply C to confirm or R to reschedule. STOP to opt out.");
    case "same_day":
      return `${hi}${a.business} here — we'll see you today at ${time} for your ${service}. ` +
        `Reply R if you need to reschedule, STOP to opt out.`;
  }
}

export type ReminderReply = { action: "confirmed" | "reschedule"; appointmentId: string; reply: string };

/**
 * Read a reply to a reminder. Returns null — and the agent handles the
 * message as usual — unless the last outbound message in this conversation
 * was a reminder and the reply is one of the offered answers.
 */
export async function handleReminderReply(args: {
  tenantId: string; conversationId: string; body: string;
}): Promise<ReminderReply | null> {
  const answer = args.body.trim().toLowerCase().replace(/[^a-z ]/g, "").trim();
  const confirm = ["c", "confirm", "confirmed", "yes", "y", "yep", "yes please"].includes(answer);
  const reschedule = ["r", "reschedule", "rebook", "change", "move it"].includes(answer);
  if (!confirm && !reschedule) return null;

  const lastOut = await db.query.messages.findFirst({
    where: and(eq(messages.conversationId, args.conversationId), eq(messages.direction, "outbound")),
    orderBy: desc(messages.createdAt),
  });
  const apptId = lastOut?.meta?.reminderFor;
  if (typeof apptId !== "string") return null;

  const appt = await db.query.appointments.findFirst({
    where: and(eq(appointments.id, apptId), eq(appointments.tenantId, args.tenantId),
      inArray(appointments.status, ["confirmed", "pending"]), gt(appointments.startsAt, new Date())),
  });
  if (!appt) return null;
  const tz = await timezoneFor(appt.tenantId, appt.locationId);
  const when = formatInTimeZone(appt.startsAt, tz, "EEE d MMM 'at' h:mm a");

  if (confirm) {
    await db.update(appointments).set({ customerConfirmedAt: new Date() }).where(eq(appointments.id, appt.id));
    await db.insert(events).values({
      tenantId: args.tenantId, type: "appointment_confirmed_by_customer", conversationId: args.conversationId,
      contactId: appt.contactId, payload: { appointmentId: appt.id },
    });
    return { action: "confirmed", appointmentId: appt.id, reply: `Thanks — you're confirmed for ${when}. See you then.` };
  }

  // Hold the slot as pending rather than freeing it: if nobody gets back to
  // them, the job still happens at the original time.
  await db.update(appointments).set({ status: "pending", rescheduleRequestedAt: new Date() })
    .where(eq(appointments.id, appt.id));
  await db.insert(events).values({
    tenantId: args.tenantId, type: "reschedule_requested", conversationId: args.conversationId,
    contactId: appt.contactId, payload: { appointmentId: appt.id, originalStartsAt: appt.startsAt.toISOString() },
  });
  return {
    action: "reschedule", appointmentId: appt.id,
    reply: `No problem. Someone from the team will text you shortly to find a new time. ` +
      `Until then we're keeping ${when} for you.`,
  };
}

function withinSendingHours(at: Date, tz: string): boolean {
  const hour = Number(formatInTimeZone(at, tz, "H"));
  return hour >= SEND_FROM_HOUR && hour < SEND_UNTIL_HOUR;
}

/**
 * Move a send time into sending hours on the same local day: an early-morning
 * time goes to the start of the window, a late-evening one to the end.
 */
function clampToSendingHours(at: Date, tz: string): Date {
  const hour = Number(formatInTimeZone(at, tz, "H"));
  if (hour >= SEND_FROM_HOUR && hour < SEND_UNTIL_HOUR) return at;
  const day = formatInTimeZone(at, tz, "yyyy-MM-dd");
  if (hour < SEND_FROM_HOUR) return fromZonedTime(`${day}T${String(SEND_FROM_HOUR).padStart(2, "0")}:00:00`, tz);
  return fromZonedTime(`${day}T${String(SEND_UNTIL_HOUR - 1).padStart(2, "0")}:00:00`, tz);
}

async function timezoneFor(tenantId: string, locationId: string | null): Promise<string> {
  if (locationId) {
    const loc = await db.query.locations.findFirst({ where: eq(locations.id, locationId) });
    if (loc?.timezone) return loc.timezone;
  }
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  return tenant?.timezone ?? "UTC";
}

async function smsThread(tenantId: string, contactId: string, phone: string): Promise<string> {
  const existing = await db.query.conversations.findFirst({
    where: and(eq(conversations.tenantId, tenantId), eq(conversations.contactId, contactId), eq(conversations.channel, "sms")),
    orderBy: desc(conversations.lastMessageAt),
  });
  if (existing) return existing.id;
  const [created] = await db.insert(conversations).values({
    tenantId, contactId, channel: "sms", externalThreadId: phone,
  }).returning();
  return created.id;
}
