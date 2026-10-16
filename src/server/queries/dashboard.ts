import { and, desc, eq, gte, sql } from "drizzle-orm";
import {
  db, tenants, events, leads, appointments, conversations, messages, agentRuns, contacts, locations,
  type BusinessHours,
} from "@/server/db";
import { slaReport } from "@/server/features/sla";
import { coachReport } from "@/server/features/scoring";
import { isOpen } from "@/server/features/staff-alerts";
import { buildReactivationList } from "@/server/features/reactivation";
import { findCrossSellOpportunities } from "@/server/features/referrals";
import { measureLift, type LiftReport } from "@/server/learning/incrementality";
import { outreachAssignments } from "@/server/db";

/**
 * Everything the owner-facing dashboard shows.
 *
 * This is the retention product. Clients do not churn because the AI was bad;
 * they churn because they cannot see what it did. Every number here answers
 * "what did I get for my money this month".
 */
export async function getDashboard(tenantSlug: string, days = 30) {
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.slug, tenantSlug) });
  if (!tenant) return null;

  const since = new Date(Date.now() - days * 86400_000);

  const [evs, leadRows, apptRows, convRows, runs, sla, reactivation, crossSell, coach, location] =
    await Promise.all([
      db.query.events.findMany({
        where: and(eq(events.tenantId, tenant.id), gte(events.createdAt, since)),
      }),
      db.query.leads.findMany({
        where: and(eq(leads.tenantId, tenant.id), gte(leads.createdAt, since)),
        orderBy: desc(leads.createdAt),
      }),
      db.query.appointments.findMany({
        where: and(eq(appointments.tenantId, tenant.id), gte(appointments.createdAt, since)),
        orderBy: desc(appointments.startsAt),
      }),
      db.query.conversations.findMany({
        where: and(eq(conversations.tenantId, tenant.id), gte(conversations.createdAt, since)),
      }),
      db.query.agentRuns.findMany({
        where: and(eq(agentRuns.tenantId, tenant.id), gte(agentRuns.createdAt, since)),
      }),
      slaReport(tenant.id, days),
      buildReactivationList(tenant.id, { minDaysDormant: 7, limit: 8 }),
      findCrossSellOpportunities(tenant.id, 8),
      coachReport(tenant.id, days),
      db.query.locations.findFirst({ where: eq(locations.tenantId, tenant.id) }),
    ]);

  const count = (type: string) => evs.filter((e) => e.type === type).length;

  // Incrementality: one lift report per campaign that has a holdout.
  const campaigns = await db
    .selectDistinct({ campaign: outreachAssignments.campaign })
    .from(outreachAssignments)
    .where(eq(outreachAssignments.tenantId, tenant.id));

  const liftReports = (
    await Promise.all(campaigns.map((c) => measureLift(tenant.id, c.campaign)))
  ).filter((r): r is LiftReport => r !== null);

  const byChannel = new Map<string, number>();
  for (const c of convRows) byChannel.set(c.channel, (byChannel.get(c.channel) ?? 0) + 1);

  // Against the business's own hours and time zone (this was a UTC proxy
  // for 8-5 Eastern, wrong for every other tenant).
  const tz = location?.timezone ?? tenant.timezone;
  const hours = (location?.hours ?? []) as BusinessHours[];
  const afterHoursConversations = hours.length
    ? convRows.filter((c) => !isOpen(c.createdAt, hours, tz)).length
    : 0;

  // Which lead sources turn into jobs. A source is the form or marketplace
  // when intake recorded one, otherwise the channel the person used.
  const sourceRows = new Map<string, { source: string; leads: number; booked: number }>();
  for (const l of leadRows) {
    const key = l.source ?? l.sourceChannel;
    const row = sourceRows.get(key) ?? { source: key, leads: 0, booked: 0 };
    row.leads++;
    if (l.status === "booked" || l.status === "won") row.booked++;
    sourceRows.set(key, row);
  }

  // What the client's website forms are getting wrong, in their words.
  const formProblems = new Map<string, number>();
  let leadsNotTexted = 0;
  for (const e of evs.filter((e) => e.type === "lead_intake")) {
    const consent = e.payload.consent as { sms?: boolean; problems?: string[] } | undefined;
    if (consent && consent.sms === false) {
      leadsNotTexted++;
      for (const p of consent.problems ?? []) formProblems.set(p, (formProblems.get(p) ?? 0) + 1);
    }
  }

  const alertEvents = evs.filter((e) => e.type === "staff_alert");
  const alertRecipients = alertEvents.flatMap((e) => (e.payload.recipients as { ok?: boolean; error?: string }[] | undefined) ?? []);
  const alertErrors = [...new Set(alertRecipients.filter((r) => !r.ok && r.error).map((r) => r.error!))];
  const alertProblems = [...new Set(alertEvents.map((e) => e.payload.problem).filter((p): p is string => typeof p === "string"))];

  const booked = apptRows.filter((a) => a.status === "confirmed" || a.status === "completed");
  const pipelineValue = leadRows.reduce((s, l) => s + Number(l.estimatedValue ?? 0), 0);
  const aiCost = runs.reduce((s, r) => s + Number(r.costUsd), 0);

  return {
    tenant,
    days,
    headline: {
      conversationsHandled: convRows.length,
      leadsCaptured: leadRows.length,
      appointmentsBooked: booked.length,
      afterHoursConversations,
      escalations: count("escalated_to_human"),
      repliesHeld: count("reply_held"),
      missedCallTextBacks: count("missed_call_text_back"),
      pipelineValue,
      aiCost,
    },
    sla,
    coach,
    leadSources: [...sourceRows.values()].sort((a, b) => b.leads - a.leads),
    forms: {
      leadsNotTexted,
      problems: [...formProblems.entries()].sort((a, b) => b[1] - a[1]),
    },
    appointmentsOps: {
      remindersSent: evs.filter((e) => e.type === "appointment_reminder" && e.payload.sent === true).length,
      confirmedByCustomer: apptRows.filter((a) => a.customerConfirmedAt).length,
      rescheduleRequests: apptRows.filter((a) => a.rescheduleRequestedAt && a.status === "pending").length,
      noShows: apptRows.filter((a) => a.status === "no_show").length,
    },
    alerts: {
      sent: alertRecipients.filter((r) => r.ok).length,
      failed: alertRecipients.filter((r) => !r.ok).length,
      heldForOpening: alertEvents.filter((e) => e.payload.deferredUntil).length,
      problems: [...alertErrors, ...alertProblems],
    },
    optOuts: count("opt_out"),
    byChannel: [...byChannel.entries()].sort((a, b) => b[1] - a[1]),
    recentLeads: leadRows.slice(0, 10),
    upcomingAppointments: apptRows
      .filter((a) => a.startsAt > new Date())
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
      .slice(0, 6),
    reactivation,
    crossSell,
    liftReports,
    agentRuns: runs.length,
    avgLatencyMs: runs.length
      ? Math.round(runs.reduce((s, r) => s + r.latencyMs, 0) / runs.length)
      : 0,
  };
}

export async function getInbox(tenantSlug: string, focus?: string) {
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.slug, tenantSlug) });
  if (!tenant) return null;

  const latest = await db.query.conversations.findMany({
    where: eq(conversations.tenantId, tenant.id),
    orderBy: desc(conversations.lastMessageAt),
    limit: 40,
  });
  // A thread linked from a staff alert or the dashboard goes first, even if
  // it has dropped out of the latest 40.
  const focused = focus && /^[0-9a-f-]{36}$/i.test(focus)
    ? await db.query.conversations.findFirst({
        where: and(eq(conversations.tenantId, tenant.id), eq(conversations.id, focus)),
      })
    : undefined;
  const convos = focused ? [focused, ...latest.filter((c) => c.id !== focused.id)] : latest;

  const threads = await Promise.all(
    convos.map(async (c) => {
      const [contact, msgs] = await Promise.all([
        db.query.contacts.findFirst({ where: eq(contacts.id, c.contactId) }),
        db.query.messages.findMany({
          where: eq(messages.conversationId, c.id),
          orderBy: desc(messages.createdAt),
          limit: 50,
        }),
      ]);
      return { conversation: c, contact, messages: msgs.reverse() };
    }),
  );

  return { tenant, threads, focus: focused?.id ?? null };
}

/** Every channel one person is reachable on — the cross-channel timeline. */
export async function getContactTimeline(contactId: string) {
  const [contact, identities, msgs] = await Promise.all([
    db.query.contacts.findFirst({ where: eq(contacts.id, contactId) }),
    db.query.contactIdentities.findMany({
      where: eq(sql`contact_id`, contactId) as never,
    }).catch(() => []),
    db.select({
      body: messages.body,
      channel: messages.channel,
      direction: messages.direction,
      createdAt: messages.createdAt,
    })
      .from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .where(eq(conversations.contactId, contactId))
      .orderBy(desc(messages.createdAt))
      .limit(100),
  ]);
  return { contact, identities, messages: msgs.reverse() };
}
