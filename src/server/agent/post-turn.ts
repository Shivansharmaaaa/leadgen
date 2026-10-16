import { and, asc, desc, eq } from "drizzle-orm";
import { db, leads, messages, conversations, events } from "@/server/db";
import { normalizeService } from "@/server/learning/features";
import { extractFeaturesForLead } from "@/server/learning/features";

/**
 * Lead qualification after the caller has already been answered.
 *
 * On a spoken channel the agent must not pay a generation round-trip for
 * bookkeeping the caller never hears. The signals that matter — what service,
 * how urgent — are reliably recoverable from the transcript with keywords, so
 * this runs once the turn is over and costs nothing on the critical path.
 *
 * It is deliberately conservative: if the transcript does not clearly indicate
 * a service, no lead is written rather than a wrong one.
 */

const SERVICE_PATTERNS: [RegExp, string][] = [
  [/\b(a\/?c|air con(?:ditioning)?|cooling|not cooling|blowing warm|warm air)\b/i, "AC repair"],
  [/\b(furnace|heater|heating|no heat|boiler|radiator)\b/i, "Furnace repair"],
  [/\b(heat ?pump|mini ?split)\b/i, "Heat pump service"],
  [/\b(duct|ventilation|air quality|vents?)\b/i, "Ductwork"],
  [/\b(install|replace(?:ment)?|new system|new unit)\b/i, "System replacement"],
  [/\b(maintenance|tune[- ]?up|service plan|annual|inspection)\b/i, "Maintenance"],
  [/\b(thermostat)\b/i, "Thermostat"],
];

const URGENCY_PATTERNS: [RegExp, string][] = [
  [/\b(emergency|urgent|asap|right away|today|no heat|freezing|flooding|baby|elderly|immediately)\b/i, "emergency"],
  [/\b(this week|tomorrow|soon|couple of days|few days)\b/i, "this_week"],
  [/\b(this month|next week|sometime|when you can)\b/i, "this_month"],
  [/\b(just (?:looking|curious|researching)|quote|estimate|pricing|thinking about|shopping)\b/i, "researching"],
];

export async function qualifyFromTranscript(conversationId: string): Promise<{
  created: boolean; service?: string; urgency?: string; score?: number;
}> {
  const convo = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
  });
  if (!convo) return { created: false };

  const msgs = await db.query.messages.findMany({
    where: eq(messages.conversationId, conversationId),
    orderBy: asc(messages.createdAt),
  });

  const transcript = msgs
    .filter((m) => m.direction === "inbound")
    .map((m) => m.body)
    .join(" ");
  if (!transcript.trim()) return { created: false };

  const service = SERVICE_PATTERNS.find(([re]) => re.test(transcript))?.[1];
  if (!service) return { created: false };

  const urgency = URGENCY_PATTERNS.find(([re]) => re.test(transcript))?.[1] ?? "this_month";

  // Score from signals that are known to matter, bounded and explainable.
  let score = 40;
  if (urgency === "emergency") score += 35;
  else if (urgency === "this_week") score += 20;
  else if (urgency === "researching") score -= 20;
  if (/\b(book|schedule|appointment|come out|send someone)\b/i.test(transcript)) score += 15;
  if (msgs.filter((m) => m.direction === "inbound").length >= 3) score += 10;
  score = Math.max(0, Math.min(100, score));

  const existing = await db.query.leads.findFirst({
    where: and(eq(leads.tenantId, convo.tenantId), eq(leads.conversationId, conversationId)),
  });

  const values = {
    service,
    urgency,
    intent: transcript.slice(0, 200),
    score,
    status: "qualified" as const,
    summary: `Captured from a ${convo.channel} conversation.`,
    updatedAt: new Date(),
  };

  if (existing) {
    await db.update(leads).set(values).where(eq(leads.id, existing.id));
    void extractFeaturesForLead(existing.id).catch(() => {});
    return { created: false, service, urgency, score };
  }

  const [lead] = await db.insert(leads).values({
    ...values,
    tenantId: convo.tenantId,
    contactId: convo.contactId,
    conversationId,
    sourceChannel: convo.channel,
  }).returning();

  await db.insert(events).values({
    tenantId: convo.tenantId,
    type: "lead_qualified",
    conversationId,
    contactId: convo.contactId,
    payload: { leadId: lead.id, service, urgency, score, source: "post_turn_heuristic" },
  });

  void extractFeaturesForLead(lead.id).catch(() => {});
  return { created: true, service, urgency, score };
}
