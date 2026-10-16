import { and, asc, desc, eq, gte, inArray } from "drizzle-orm";
import { db, agentRuns, appointments, contacts, conversations, events, leads, messages } from "@/server/db";
import { SLA_TARGET_SECONDS } from "./sla";

/**
 * FEATURE 10 — score every conversation, and say what was missed.
 *
 * The owner cannot read 300 transcripts a month. What they need is the
 * handful where money was left on the table, and why: the caller who asked
 * for a time and was never offered one, the price question nobody answered,
 * the reply that sat in review while the lead went cold. Competitors sell
 * this as a "coach"; it is also how a client sees that the agent is being
 * held to a standard rather than trusted blindly.
 *
 * Deterministic on purpose. Every flag is a rule over messages, tool calls
 * and events, so it costs nothing, runs on every conversation, and each
 * flag can be traced to the line that raised it. A model grader would be
 * neither cheap nor reproducible.
 */

export type Outcome = "opted_out" | "booked" | "escalated" | "lead_captured" | "engaged" | "abandoned";
export type Severity = "high" | "medium" | "low";
export type Flag = { code: string; severity: Severity; detail: string };

export type TranscriptMessage = {
  direction: "inbound" | "outbound";
  authorType: string;
  body: string;
  status: string;
  createdAt: Date;
  meta?: Record<string, unknown> | null;
};

export type Transcript = {
  channel: string;
  messages: TranscriptMessage[];
  toolsCalled: string[];
  booked: boolean;
  escalatedAt: Date | null;
  optedOut: boolean;
  leadUrgency: string | null;
  hasLead: boolean;
  contactHasPhone: boolean;
  contactHasEmail: boolean;
  now?: Date;
};

const REACHED = new Set(["sent", "delivered", "read"]);
const WEIGHT: Record<Severity, number> = { high: 25, medium: 10, low: 5 };

const ASKS_FOR_TIME = /\b(?:when can|when could|availab|come out|come by|send someone|book|appointment|schedule|today|tomorrow|this week|earliest|soonest|asap|as soon as)\b/i;
const ASKS_PRICE = /\b(?:how much|price|pricing|cost|costs|quote|charge|fee|estimate|rates?)\b/i;
const ANSWERS_PRICE = /\$|\d|\b(?:dollars?|free|waived|no charge|quote|estimate|depends on)\b|\b(?:eighty|ninety|hundred|thousand)\b/i;

export function scoreTranscript(t: Transcript): { outcome: Outcome; flags: Flag[]; score: number } {
  const now = t.now ?? new Date();
  const msgs = [...t.messages].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const inbound = msgs.filter((m) => m.direction === "inbound");
  const reached = msgs.filter((m) => m.direction === "outbound" && REACHED.has(m.status));
  const flags: Flag[] = [];
  const settled = t.booked || t.optedOut || Boolean(t.escalatedAt);

  // ── Outcome ────────────────────────────────────────────────────────────
  const outcome: Outcome =
    t.optedOut ? "opted_out"
    : t.booked ? "booked"
    : t.escalatedAt ? "escalated"
    : t.hasLead && (t.contactHasPhone || t.contactHasEmail) ? "lead_captured"
    : inbound.length >= 2 ? "engaged"
    : "abandoned";

  // ── What was missed ────────────────────────────────────────────────────
  const timeAsk = inbound.find((m) => ASKS_FOR_TIME.test(m.body));
  if (timeAsk && !t.booked && !t.optedOut && !t.escalatedAt && !t.toolsCalled.includes("check_availability")) {
    flags.push({ code: "time_asked_not_offered", severity: "high",
      detail: `Asked "${clip(timeAsk.body)}" and was never offered a time.` });
  }

  if (t.channel !== "voice" && !t.contactHasPhone && !t.contactHasEmail && inbound.length >= 2 && !t.optedOut) {
    flags.push({ code: "no_contact_details", severity: "high",
      detail: "The conversation ended without a phone number or email, so there is no way to follow up." });
  }

  for (const ask of inbound.filter((m) => ASKS_PRICE.test(m.body))) {
    const answer = reached.find((m) => m.createdAt >= ask.createdAt);
    if (!answer || !ANSWERS_PRICE.test(answer.body)) {
      flags.push({ code: "price_not_answered", severity: "medium",
        detail: `Asked "${clip(ask.body)}"; the reply gave no price, range or next step to one.` });
      break;
    }
  }

  const firstIn = inbound[0];
  const firstOut = firstIn && reached.find((m) => m.createdAt >= firstIn.createdAt);
  if (firstIn && firstOut) {
    const seconds = Math.round((firstOut.createdAt.getTime() - firstIn.createdAt.getTime()) / 1000);
    if (seconds > SLA_TARGET_SECONDS) {
      flags.push({ code: "slow_first_reply", severity: "medium",
        detail: `First reply took ${formatSeconds(seconds)} (target ${SLA_TARGET_SECONDS}s).` });
    }
  }

  const held = msgs.filter((m) => m.direction === "outbound" && m.status === "held_for_review");
  const stuck = held.find((h) =>
    now.getTime() - h.createdAt.getTime() > 15 * 60_000 && !reached.some((r) => r.createdAt > h.createdAt));
  if (stuck) {
    flags.push({ code: "reply_stuck_in_review", severity: "high",
      detail: `A reply has waited for review since ${stuck.createdAt.toISOString()} and nothing else was sent` +
        (stuck.meta?.holdReason ? ` (held: ${stuck.meta.holdReason})` : "") + "." });
  }

  if (t.escalatedAt && now.getTime() - t.escalatedAt.getTime() > 60 * 60_000) {
    const humanReply = reached.some((m) => m.authorType === "human" && m.createdAt > t.escalatedAt!);
    if (!humanReply) {
      flags.push({ code: "escalation_unanswered", severity: "high",
        detail: "Handed to the team over an hour ago; no person has replied." });
    }
  }

  if (t.leadUrgency === "emergency" && !t.booked && !t.escalatedAt) {
    flags.push({ code: "emergency_not_booked", severity: "high",
      detail: "Triaged as an emergency, but nothing was booked and nobody was alerted." });
  }

  const last = msgs[msgs.length - 1];
  const followedUp = msgs.some((m) => m.meta?.followUp === true);
  if (!settled && last?.direction === "outbound" && now.getTime() - last.createdAt.getTime() > 24 * 3600_000 && !followedUp && inbound.length > 0) {
    flags.push({ code: "went_quiet_no_follow_up", severity: "medium",
      detail: "The customer stopped replying over a day ago and no follow-up went out." });
  }

  const ai = reached.filter((m) => m.authorType === "ai").map((m) => normalise(m.body));
  for (let i = 1; i < ai.length; i++) {
    if (ai[i].length > 20 && ai.slice(0, i).some((prev) => similarity(prev, ai[i]) > 0.85)) {
      flags.push({ code: "agent_repeated_itself", severity: "low", detail: "The agent sent nearly the same message twice." });
      break;
    }
  }

  const score = Math.max(0, 100 - flags.reduce((s, f) => s + WEIGHT[f.severity], 0));
  return { outcome, flags, score };
}

export async function scoreConversation(conversationId: string) {
  const convo = await db.query.conversations.findFirst({ where: eq(conversations.id, conversationId) });
  if (!convo) return null;
  const [msgs, runs, contact, lead, appts, evs] = await Promise.all([
    db.query.messages.findMany({ where: eq(messages.conversationId, convo.id), orderBy: asc(messages.createdAt) }),
    db.query.agentRuns.findMany({ where: eq(agentRuns.conversationId, convo.id) }),
    db.query.contacts.findFirst({ where: eq(contacts.id, convo.contactId) }),
    db.query.leads.findFirst({ where: eq(leads.conversationId, convo.id), orderBy: desc(leads.updatedAt) }),
    db.query.appointments.findMany({
      where: and(eq(appointments.contactId, convo.contactId), gte(appointments.createdAt, convo.createdAt)),
    }),
    db.query.events.findMany({
      where: and(eq(events.conversationId, convo.id), inArray(events.type, ["escalated_to_human", "opt_out"])),
    }),
  ]);
  const escalation = evs.find((e) => e.type === "escalated_to_human");
  return {
    conversationId: convo.id,
    channel: convo.channel,
    contactName: contact?.displayName ?? null,
    lastMessageAt: convo.lastMessageAt,
    ...scoreTranscript({
      channel: convo.channel,
      messages: msgs.map((m) => ({ ...m, direction: m.direction as "inbound" | "outbound" })),
      toolsCalled: runs.flatMap((r) => r.toolCalls.filter((c) => !c.blocked).map((c) => c.name)),
      booked: appts.some((a) => a.status !== "cancelled"),
      escalatedAt: escalation?.createdAt ?? null,
      optedOut: evs.some((e) => e.type === "opt_out") || Boolean(contact?.doNotContact),
      leadUrgency: lead?.urgency ?? null,
      hasLead: Boolean(lead),
      contactHasPhone: Boolean(contact?.primaryPhone),
      contactHasEmail: Boolean(contact?.primaryEmail),
    }),
  };
}

export type CoachReport = {
  scored: number;
  averageScore: number | null;
  outcomes: Record<Outcome, number>;
  flags: { code: string; severity: Severity; count: number; example: string }[];
  needsAttention: NonNullable<Awaited<ReturnType<typeof scoreConversation>>>[];
};

export async function coachReport(tenantId: string, days = 30, limit = 200): Promise<CoachReport> {
  const since = new Date(Date.now() - days * 86400_000);
  const convos = await db.query.conversations.findMany({
    where: and(eq(conversations.tenantId, tenantId), gte(conversations.lastMessageAt, since)),
    orderBy: desc(conversations.lastMessageAt),
    limit,
  });
  const scored = (await Promise.all(convos.map((c) => scoreConversation(c.id)))).filter(
    (s): s is NonNullable<typeof s> => s !== null,
  );

  const outcomes = { opted_out: 0, booked: 0, escalated: 0, lead_captured: 0, engaged: 0, abandoned: 0 } as Record<Outcome, number>;
  const byFlag = new Map<string, { code: string; severity: Severity; count: number; example: string }>();
  for (const s of scored) {
    outcomes[s.outcome]++;
    for (const f of s.flags) {
      const row = byFlag.get(f.code) ?? { code: f.code, severity: f.severity, count: 0, example: f.detail };
      row.count++;
      byFlag.set(f.code, row);
    }
  }
  const order: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  return {
    scored: scored.length,
    averageScore: scored.length ? Math.round(scored.reduce((s, c) => s + c.score, 0) / scored.length) : null,
    outcomes,
    flags: [...byFlag.values()].sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count),
    needsAttention: scored.filter((s) => s.flags.some((f) => f.severity === "high"))
      .sort((a, b) => a.score - b.score).slice(0, 10),
  };
}

function clip(s: string, n = 80): string {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

function formatSeconds(s: number): string {
  if (s < 120) return `${s}s`;
  if (s < 7200) return `${Math.round(s / 60)} min`;
  return `${Math.round(s / 3600)} h`;
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

/** Dice coefficient over word bigrams: cheap, and enough to catch a repeat. */
function similarity(a: string, b: string): number {
  const grams = (s: string) => {
    const w = s.split(" ");
    const out = new Map<string, number>();
    for (let i = 0; i < w.length - 1; i++) out.set(`${w[i]} ${w[i + 1]}`, (out.get(`${w[i]} ${w[i + 1]}`) ?? 0) + 1);
    return out;
  };
  const ga = grams(a), gb = grams(b);
  let inter = 0, total = 0;
  for (const [g, n] of ga) { inter += Math.min(n, gb.get(g) ?? 0); total += n; }
  for (const n of gb.values()) total += n;
  return total ? (2 * inter) / total : 0;
}
