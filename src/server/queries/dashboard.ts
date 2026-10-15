import { and, desc, eq, gte, sql } from "drizzle-orm";
import {
  db, tenants, events, leads, appointments, conversations, messages, agentRuns, contacts,
} from "@/server/db";
import { slaReport } from "@/server/features/sla";
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

  const [evs, leadRows, apptRows, convRows, runs, sla, reactivation, crossSell] =
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

  const afterHoursConversations = convRows.filter((c) => {
    const h = c.createdAt.getUTCHours();
    return h < 12 || h >= 22; // crude UTC proxy for outside 8-5 Eastern
  }).length;

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

export async function getInbox(tenantSlug: string) {
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.slug, tenantSlug) });
  if (!tenant) return null;

  const convos = await db.query.conversations.findMany({
    where: eq(conversations.tenantId, tenant.id),
    orderBy: desc(conversations.lastMessageAt),
    limit: 40,
  });

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

  return { tenant, threads };
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
