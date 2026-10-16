import { and, desc, eq } from "drizzle-orm";
import { addDays } from "date-fns";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { db, contacts, conversations, events, jobs, leads, locations, tenants } from "@/server/db";
import { deliver } from "@/server/core/deliver";
import { assignCohort } from "@/server/learning/incrementality";
import { buildReactivationList } from "./reactivation";

/**
 * FEATURE 14 — reactivation campaigns that actually send.
 *
 * The dashboard already ranked dormant leads by expected incremental value
 * (uplift x job value), but nothing contacted them: "nurture" is one of the
 * three things competitors sell, and here it stopped at a list. The owner
 * now presses one button.
 *
 * Every campaign runs as an experiment. Each candidate is randomly assigned
 * to treatment or a ~15% holdout BEFORE anything is sent, so the dashboard's
 * lift report compares like with like and can say "not yet proven" honestly.
 * People in the do-not-disturb segment (contact makes them LESS likely to
 * book) are never selected.
 *
 * These are marketing messages, the strictest class: SMS needs written
 * consent and email needs email consent (both re-checked by the channel gate
 * at send time, so a STOP that arrives between launch and send wins), they go
 * out only between 10am and 7pm local, staggered so a carrier doesn't see a
 * burst, and every one says how to stop.
 */

const SEND_FROM = 10, SEND_UNTIL = 19, STAGGER_MS = 45_000;

export type LaunchReport = {
  campaign: string;
  selected: number;
  treatment: number;
  holdout: number;
  alreadyInCampaign: number;
  skipped: { reason: string; count: number }[];
  firstSendAt: string | null;
};

export async function launchReactivation(tenantId: string, opts: { campaign?: string; limit?: number } = {}): Promise<LaunchReport> {
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  if (!tenant) throw new Error("unknown tenant");
  const tz = await timezoneFor(tenantId);
  const campaign = opts.campaign ?? `reactivation-${formatInTimeZone(new Date(), tz, "yyyy-MM-dd")}`;
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 200);

  const candidates = await buildReactivationList(tenantId, { minDaysDormant: 14, limit: limit * 3 });
  const skipped = new Map<string, number>();
  const skip = (reason: string) => skipped.set(reason, (skipped.get(reason) ?? 0) + 1);

  const chosen = [];
  for (const c of candidates) {
    if (chosen.length >= limit) break;
    if (c.segment === "do_not_disturb") { skip("contact would make them less likely to book"); continue; }
    const channel = c.contactableVia.includes("sms") ? "sms" : c.contactableVia.includes("email") ? "email" : null;
    if (!channel) { skip(c.blockedReason ?? "no consented channel"); continue; }
    chosen.push({ ...c, channel });
  }

  let treatment = 0, holdout = 0, already = 0;
  let at = nextSendTime(new Date(), tz);
  const firstSendAt = chosen.length ? at : null;
  for (const c of chosen) {
    const cohort = await assignCohort({ tenantId, contactId: c.contactId, leadId: c.leadId, campaign, score: c.score });
    if (cohort === "already_assigned") { already++; continue; }
    if (cohort === "holdout") { holdout++; continue; }
    treatment++;
    await db.insert(jobs).values({
      tenantId, type: "campaign_message", runAt: at,
      payload: { campaign, contactId: c.contactId, leadId: c.leadId, channel: c.channel },
      idempotencyKey: `campaign:${campaign}:${c.contactId}`,
    }).onConflictDoNothing();
    at = nextSendTime(new Date(at.getTime() + STAGGER_MS), tz);
  }

  await db.insert(events).values({
    tenantId, type: "campaign_launched",
    payload: { campaign, selected: chosen.length, treatment, holdout, alreadyInCampaign: already },
  });
  return {
    campaign, selected: chosen.length, treatment, holdout, alreadyInCampaign: already,
    skipped: [...skipped.entries()].map(([reason, count]) => ({ reason, count })),
    firstSendAt: firstSendAt?.toISOString() ?? null,
  };
}

export async function sendCampaignMessage(payload: Record<string, unknown>, tenantId: string | null, now = new Date()) {
  if (!tenantId) return { skipped: "no tenant" };
  const tz = await timezoneFor(tenantId);
  if (!withinHours(now, tz)) {
    // Picked up late (worker was down): wait for the next window, never send at night.
    const at = nextSendTime(now, tz);
    await db.insert(jobs).values({ tenantId, type: "campaign_message", runAt: at, payload,
      idempotencyKey: `campaign:${payload.campaign}:${payload.contactId}:${at.toISOString()}` }).onConflictDoNothing();
    return { deferredTo: at.toISOString() };
  }

  const [tenant, contact, lead] = await Promise.all([
    db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) }),
    db.query.contacts.findFirst({ where: eq(contacts.id, String(payload.contactId)) }),
    payload.leadId ? db.query.leads.findFirst({ where: eq(leads.id, String(payload.leadId)) }) : undefined,
  ]);
  if (!tenant || !contact) return { skipped: "contact gone" };
  if (lead && (lead.status === "booked" || lead.status === "won")) return { skipped: "booked since launch" };

  const channel = payload.channel === "email" ? "email" : "sms";
  const address = channel === "sms" ? contact.primaryPhone : contact.primaryEmail;
  if (!address) return { skipped: `no ${channel} address` };
  const business = tenant.settings?.businessName ?? tenant.name;
  const conversationId = await threadFor(tenantId, contact.id, channel, address);
  const sent = await deliver({
    tenantId, conversationId, channel, to: { channel, externalId: address },
    body: campaignText(channel, {
      firstName: contact.displayName?.split(/\s+/)[0] ?? null, agent: tenant.settings?.agentName ?? null,
      business, service: lead?.service ?? null,
    }),
    // Marketing: the channel gate requires consent and re-checks STOP now.
    initiated: true,
    meta: { campaign: payload.campaign, ...(channel === "email" ? { subject: `Still need help${lead?.service ? ` with ${lead.service.toLowerCase()}` : ""}? — ${business}` } : {}) },
  });
  await db.insert(events).values({
    tenantId, type: "campaign_message", conversationId, contactId: contact.id,
    payload: { campaign: payload.campaign, channel, sent },
  });
  return { sent };
}

export function campaignText(channel: "sms" | "email", a: {
  firstName: string | null; agent: string | null; business: string; service: string | null;
}): string {
  const hi = a.firstName ? `Hi ${a.firstName}, ` : "Hi, ";
  const who = a.agent ? `it's ${a.agent} at ${a.business}` : `it's ${a.business}`;
  const about = a.service ? `You asked us about ${a.service.replace(/^([A-Z])(?=[a-z])/, (c) => c.toLowerCase())} a while back.` : "You got in touch with us a while back.";
  const stop = channel === "sms" ? "Reply STOP to opt out." : "If you'd rather not hear from us, just reply \"unsubscribe\".";
  return `${hi}${who}. ${about} Is that still something you need? We have openings this week if you'd like us to come out. ${stop}`;
}

function withinHours(at: Date, tz: string): boolean {
  const h = Number(formatInTimeZone(at, tz, "H"));
  return h >= SEND_FROM && h < SEND_UNTIL;
}

/** `at` if it is inside the window, else the next window's opening. */
export function nextSendTime(at: Date, tz: string): Date {
  if (withinHours(at, tz)) return at;
  const h = Number(formatInTimeZone(at, tz, "H"));
  const day = h < SEND_FROM ? at : addDays(at, 1);
  return fromZonedTime(`${formatInTimeZone(day, tz, "yyyy-MM-dd")}T${String(SEND_FROM).padStart(2, "0")}:00:00`, tz);
}

async function timezoneFor(tenantId: string): Promise<string> {
  const loc = await db.query.locations.findFirst({ where: eq(locations.tenantId, tenantId) });
  const tenant = loc?.timezone ? null : await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  return loc?.timezone ?? tenant?.timezone ?? "UTC";
}

async function threadFor(tenantId: string, contactId: string, channel: "sms" | "email", address: string): Promise<string> {
  const existing = await db.query.conversations.findFirst({
    where: and(eq(conversations.tenantId, tenantId), eq(conversations.contactId, contactId), eq(conversations.channel, channel)),
    orderBy: desc(conversations.lastMessageAt),
  });
  if (existing) return existing.id;
  const [created] = await db.insert(conversations).values({
    tenantId, contactId, channel, externalThreadId: channel === "sms" ? address : null,
  }).returning();
  return created.id;
}
