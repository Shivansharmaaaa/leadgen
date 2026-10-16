import { and, desc, eq, gte } from "drizzle-orm";
import { addDays } from "date-fns";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import {
  db, staff, contacts, conversations, events, jobs, leads, locations, messages, tenants,
  type BusinessHours,
} from "@/server/db";
import { screenInbound } from "@/server/core/guardrails";
import { resolveFromNumber, twilioClient } from "@/server/channels/twilio";

/**
 * FEATURE 9 — tell a person when the AI hands over.
 *
 * An escalation used to pause the AI and write an event, and nothing else:
 * the customer was promised a call back by a team that did not know. At 2am
 * with no heat, or with a gas smell, that is the job lost or worse.
 *
 * Who hears about it depends on how bad it is and what time it is:
 *
 *   emergency (danger to life, or a job the agent triaged as an emergency)
 *       → the on-call staff, at any hour; everyone with alerts if nobody is on call
 *   anything else, during opening hours → everyone with alerts on
 *   anything else, after hours → held until opening time, never a 3am text
 *
 * Alerts go straight to staff phones through Twilio. They are internal, so
 * they never enter the customer's thread. One alert per conversation per
 * half hour: an escalated thread can re-trigger every turn.
 */

const REALERT_WINDOW_MS = 30 * 60_000;

export type AlertUrgency = "now" | "soon" | "whenever";
export type StaffRow = typeof staff.$inferSelect;

export function pickRecipients(rows: StaffRow[], o: { emergency: boolean; withinHours: boolean }): StaffRow[] {
  const reachable = rows.filter((s) => s.alerts && s.phone);
  if (o.emergency) {
    const onCall = reachable.filter((s) => s.onCall);
    return onCall.length ? onCall : reachable;
  }
  return o.withinHours ? reachable : [];
}

export type AlertResult = {
  sent: number;
  failed: number;
  deferredUntil?: string;
  skipped?: string;
  emergency: boolean;
};

export async function alertStaff(args: {
  tenantId: string;
  conversationId: string;
  reason: string;
  urgency?: AlertUrgency;
  /** Set when a held alert fires at opening time, so it is not held again. */
  deferred?: boolean;
}): Promise<AlertResult> {
  const [tenant, convo] = await Promise.all([
    db.query.tenants.findFirst({ where: eq(tenants.id, args.tenantId) }),
    db.query.conversations.findFirst({ where: eq(conversations.id, args.conversationId) }),
  ]);
  if (!tenant || !convo) return { sent: 0, failed: 0, skipped: "unknown tenant or conversation", emergency: false };

  const [contact, lead, lastInbound, location, team] = await Promise.all([
    db.query.contacts.findFirst({ where: eq(contacts.id, convo.contactId) }),
    db.query.leads.findFirst({ where: eq(leads.conversationId, convo.id), orderBy: desc(leads.updatedAt) }),
    db.query.messages.findFirst({
      where: and(eq(messages.conversationId, convo.id), eq(messages.direction, "inbound")),
      orderBy: desc(messages.createdAt),
    }),
    db.query.locations.findFirst({ where: eq(locations.tenantId, tenant.id) }),
    db.query.staff.findMany({ where: eq(staff.tenantId, tenant.id) }),
  ]);

  const emergency =
    /^safety:/.test(args.reason) ||
    lead?.urgency === "emergency" ||
    Boolean(lastInbound && screenInbound(lastInbound.body, {}).safety);

  const recent = await db.query.events.findMany({
    where: and(
      eq(events.tenantId, tenant.id), eq(events.conversationId, convo.id), eq(events.type, "staff_alert"),
      gte(events.createdAt, new Date(Date.now() - REALERT_WINDOW_MS)),
    ),
  });
  // A thread that has become an emergency since its last alert is alerted again.
  if (recent.some((e) => e.payload.emergency === true || !emergency) && !args.deferred) {
    return { sent: 0, failed: 0, skipped: "already alerted in the last 30 minutes", emergency };
  }

  const tz = location?.timezone ?? tenant.timezone;
  const hours = (location?.hours ?? []) as BusinessHours[];
  const withinHours = isOpen(new Date(), hours, tz);
  const recipients = pickRecipients(team, { emergency, withinHours: withinHours || Boolean(args.deferred) });
  const businessName = tenant.settings?.businessName ?? tenant.name;

  if (!emergency && !withinHours && !args.deferred) {
    const at = nextOpening(new Date(), hours, tz);
    if (at) {
      await db.insert(jobs).values({
        tenantId: tenant.id, type: "staff_alert", runAt: at,
        payload: { conversationId: convo.id, reason: args.reason, urgency: args.urgency ?? "soon" },
        idempotencyKey: `staff_alert:${convo.id}:${at.toISOString()}`,
      }).onConflictDoNothing();
      await logAlert(tenant.id, convo.id, convo.contactId, { emergency, deferredUntil: at.toISOString(), reason: args.reason, recipients: [] });
      return { sent: 0, failed: 0, deferredUntil: at.toISOString(), emergency };
    }
  }

  if (recipients.length === 0) {
    await logAlert(tenant.id, convo.id, convo.contactId, {
      emergency, reason: args.reason, recipients: [], problem: "no staff with a phone and alerts on",
    });
    return { sent: 0, failed: 0, skipped: "no staff with a phone and alerts on", emergency };
  }

  const body = alertText({
    emergency, businessName,
    who: contact?.displayName ?? null,
    phone: contact?.primaryPhone ?? null,
    said: lastInbound?.body ?? null,
    reason: args.reason,
    service: lead?.service ?? null,
    link: process.env.APP_URL ? `${process.env.APP_URL.replace(/\/$/, "")}/inbox?c=${convo.id}` : null,
  });

  const client = twilioClient();
  const from = await resolveFromNumber(tenant.id);
  const results = await Promise.all(recipients.map(async (s) => {
    if (!client || !from) return { staffId: s.id, ok: false, error: "Twilio not configured" };
    try {
      const m = await client.messages.create({ to: s.phone!, from, body });
      return { staffId: s.id, ok: true, sid: m.sid };
    } catch (err) {
      return { staffId: s.id, ok: false, error: err instanceof Error ? err.message : "send failed" };
    }
  }));

  await logAlert(tenant.id, convo.id, convo.contactId, { emergency, reason: args.reason, recipients: results, body });
  return { sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, emergency };
}

export function alertText(a: {
  emergency: boolean; businessName: string; who: string | null; phone: string | null;
  said: string | null; reason: string; service: string | null; link: string | null;
}): string {
  const said = a.said ? `"${a.said.length > 140 ? a.said.slice(0, 137).trimEnd() + "..." : a.said}"` : null;
  return [
    `${a.emergency ? "EMERGENCY" : "Needs a person"} - ${a.businessName}`,
    [a.who, a.phone].filter(Boolean).join(", ") || "Unknown caller",
    a.service ? `Job: ${a.service}` : null,
    said,
    `Why: ${a.reason}`,
    a.link,
  ].filter(Boolean).join("\n");
}

async function logAlert(tenantId: string, conversationId: string, contactId: string, payload: Record<string, unknown>) {
  await db.insert(events).values({ tenantId, type: "staff_alert", conversationId, contactId, payload });
}

/** Hours use 0-6 for Sunday-Saturday and "HH:MM" local times, as in tools.ts. */
export function isOpen(at: Date, hours: BusinessHours[], tz: string): boolean {
  const weekday = Number(formatInTimeZone(at, tz, "i")) % 7;
  const hhmm = formatInTimeZone(at, tz, "HH:mm");
  return hours.some((h) => h.day === weekday && h.open <= hhmm && hhmm < h.close);
}

export function nextOpening(after: Date, hours: BusinessHours[], tz: string): Date | null {
  for (let d = 0; d < 8; d++) {
    const day = addDays(after, d);
    const weekday = Number(formatInTimeZone(day, tz, "i")) % 7;
    const date = formatInTimeZone(day, tz, "yyyy-MM-dd");
    const opens = hours.filter((h) => h.day === weekday).map((h) => h.open).sort();
    for (const open of opens) {
      const at = fromZonedTime(`${date}T${open}:00`, tz);
      if (at > after) return at;
    }
  }
  return null;
}
