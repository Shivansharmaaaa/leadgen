import { and, eq, gte, inArray } from "drizzle-orm";
import nodemailer from "nodemailer";
import { db, appointments, conversations, events, leads, staff, tenants } from "@/server/db";
import { coachReport } from "./scoring";
import { jobsToClose } from "./appointment-outcomes";
import { slaReport } from "./sla";

/**
 * FEATURE 16 — the morning summary.
 *
 * Owners don't open dashboards; they read what lands in their inbox. Every
 * morning at 8 (their time) the people on the team with an email get what
 * happened in the last day, and what needs them: conversations where a lead
 * may have slipped, handovers nobody answered, jobs to close, and anyone who
 * opted out. Internal mail to the team, so it needs no customer consent.
 */

export type Digest = { subject: string; text: string; numbers: Record<string, number> };

export async function buildDigest(tenantId: string, now = new Date()): Promise<Digest | null> {
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  if (!tenant) return null;
  const since = new Date(now.getTime() - 24 * 3600_000);
  const business = tenant.settings?.businessName ?? tenant.name;

  const [convos, newLeads, booked, evs, coach, toClose, sla] = await Promise.all([
    db.query.conversations.findMany({ where: and(eq(conversations.tenantId, tenantId), gte(conversations.createdAt, since)) }),
    db.query.leads.findMany({ where: and(eq(leads.tenantId, tenantId), gte(leads.createdAt, since)) }),
    db.query.appointments.findMany({ where: and(eq(appointments.tenantId, tenantId), gte(appointments.createdAt, since),
      inArray(appointments.status, ["confirmed", "pending", "completed"])) }),
    // No upper bound: rows are stamped by Postgres, whose clock can run ahead of ours.
    db.query.events.findMany({ where: and(eq(events.tenantId, tenantId), gte(events.createdAt, since)) }),
    coachReport(tenantId, 1),
    jobsToClose(tenantId),
    slaReport(tenantId, 1),
  ]);
  const count = (type: string) => evs.filter((e) => e.type === type).length;
  const numbers = {
    conversations: convos.length,
    leads: newLeads.length,
    booked: booked.length,
    handovers: count("escalated_to_human"),
    optOuts: count("opt_out"),
    needsAttention: coach.needsAttention.length,
    jobsToClose: toClose.length,
  };

  const app = (process.env.APP_URL ?? "").replace(/\/$/, "");
  const lines = [
    `Good morning. Here's the last 24 hours at ${business}.`,
    "",
    `${numbers.conversations} conversation${numbers.conversations === 1 ? "" : "s"}, ${numbers.leads} new lead${numbers.leads === 1 ? "" : "s"}, ${numbers.booked} booked.`,
    sla.medianSeconds != null ? `Median first reply: ${sla.medianSeconds}s.` : null,
    numbers.handovers ? `${numbers.handovers} handed to the team.` : null,
    "",
  ];
  if (coach.needsAttention.length) {
    lines.push(`Needs you (${coach.needsAttention.length}):`);
    for (const n of coach.needsAttention.slice(0, 5)) {
      const why = n.flags.filter((f) => f.severity === "high").map((f) => f.detail).join(" ");
      lines.push(`- ${n.contactName ?? "Unknown"} (${n.channel}): ${why}${app ? ` ${app}/inbox?c=${n.conversationId}` : ""}`);
    }
    lines.push("");
  }
  if (toClose.length) lines.push(`${toClose.length} past job${toClose.length === 1 ? "" : "s"} to mark done or no-show, so review requests go out.${app ? ` ${app}/dashboard` : ""}`, "");
  if (numbers.optOuts) lines.push(`${numbers.optOuts} person${numbers.optOuts === 1 ? "" : "s"} opted out; they won't be contacted again.`, "");
  if (!coach.needsAttention.length && !toClose.length) lines.push("Nothing needs you this morning.", "");

  const attention = numbers.needsAttention + numbers.jobsToClose;
  return {
    subject: `${business}: ${numbers.leads} new lead${numbers.leads === 1 ? "" : "s"}, ${numbers.booked} booked` +
      (attention ? ` · ${attention} need${attention === 1 ? "s" : ""} you` : ""),
    text: lines.filter((l) => l !== null).join("\n").trim(),
    numbers,
  };
}

/** Email it to everyone on the team with an address and alerts on. */
export async function sendDigest(tenantId: string, now = new Date()): Promise<{ sent: number; skipped?: string }> {
  const digest = await buildDigest(tenantId, now);
  if (!digest) return { sent: 0, skipped: "no tenant" };
  const team = (await db.query.staff.findMany({ where: eq(staff.tenantId, tenantId) })).filter((s) => s.alerts && s.email);
  if (!team.length) return { sent: 0, skipped: "nobody on the team has an email" };
  if (!process.env.SMTP_HOST || !process.env.EMAIL_FROM) return { sent: 0, skipped: "email not configured" };

  const port = Number(process.env.SMTP_PORT ?? 587);
  const mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port, secure: port === 465, requireTLS: port === 587,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? "" } : undefined,
  });
  let sent = 0;
  for (const m of team) {
    try {
      await mailer.sendMail({ from: process.env.EMAIL_FROM, to: m.email, subject: digest.subject, text: digest.text });
      sent++;
    } catch (err) {
      console.error("digest send failed", m.email, err);
    }
  }
  await db.insert(events).values({ tenantId, type: "daily_digest", payload: { sent, numbers: digest.numbers } });
  return { sent };
}
