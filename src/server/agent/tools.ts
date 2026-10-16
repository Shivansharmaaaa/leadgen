import { and, eq, gt, gte, lt, lte, desc, inArray, sql } from "drizzle-orm";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { addDays, addMinutes, startOfDay, isBefore, isAfter } from "date-fns";
import type Anthropic from "@anthropic-ai/sdk";
import {
  db, appointments, leads, contacts, conversations, events, locations, agentRuns,
  type tenants, type BusinessHours, type ToolCallRecord,
} from "@/server/db";
import { linkIdentifierToContact } from "@/server/core/identity";
import { scheduleAppointmentReminders } from "@/server/features/reminders";
import { alertStaff, type AlertUrgency } from "@/server/features/staff-alerts";
import { searchKnowledge } from "@/server/core/knowledge";
import { remember } from "@/server/memory/store";
import { hybridSearch } from "@/server/retrieval/retrieve";

export type AgentContext = {
  tenant: typeof tenants.$inferSelect;
  contactId: string;
  conversationId: string;
  location?: typeof locations.$inferSelect;
};

export type ToolResult = { ok: boolean; [k: string]: unknown };

/* ────────────────────────────────────────────────────────────────────────────
 * Tool schemas. These go to the model; the executors below are the only code
 * allowed to touch tenant data, which is why the agent can't invent an
 * appointment or a price.
 * ──────────────────────────────────────────────────────────────────────────── */

export const TOOL_DEFS: Anthropic.Tool[] = [
  {
    name: "check_availability",
    description:
      "Find real open appointment slots. ALWAYS call this before offering any time. " +
      "Never state availability from memory or guess — only times this returns exist.",
    input_schema: {
      type: "object",
      properties: {
        service: { type: "string", description: "Service requested, e.g. 'AC repair'" },
        from_date: { type: "string", description: "ISO date (YYYY-MM-DD) to start searching. Defaults to today." },
        days: { type: "integer", description: "How many days ahead to search. Default 5, max 14." },
        duration_minutes: { type: "integer", description: "Slot length. Default 60." },
      },
      required: ["service"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "book_appointment",
    description:
      "Book a slot returned by check_availability. Requires a contact name and phone " +
      "on file — call save_contact_detail first if either is missing.",
    input_schema: {
      type: "object",
      properties: {
        service: { type: "string" },
        starts_at: { type: "string", description: "Exact ISO-8601 start time from check_availability" },
        duration_minutes: { type: "integer", description: "Default 60." },
        notes: { type: "string", description: "What the customer described, in their words." },
      },
      required: ["service", "starts_at"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "save_contact_detail",
    description:
      "Store a name, phone number or email the customer gave you. Call this as soon " +
      "as you learn it — it links this person across every channel they use.",
    input_schema: {
      type: "object",
      properties: {
        field: { type: "string", enum: ["name", "phone", "email"] },
        value: { type: "string" },
      },
      required: ["field", "value"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "qualify_lead",
    description:
      "Record what this person needs and how ready they are to buy. Call once you " +
      "know the service and rough urgency, even if they have not booked.",
    input_schema: {
      type: "object",
      properties: {
        service: { type: "string" },
        intent: { type: "string", description: "One line: what they actually want." },
        urgency: { type: "string", enum: ["emergency", "this_week", "this_month", "researching"] },
        estimated_value: { type: "number", description: "Rough job value in the tenant's currency, if inferable." },
        score: { type: "integer", description: "0-100 readiness to buy." },
        summary: { type: "string", description: "Two sentences for the owner's dashboard." },
      },
      required: ["service", "intent", "urgency", "score"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "lookup_customer_history",
    description:
      "Check whether this person is an existing customer and what work was done before. " +
      "Call it when they imply prior contact ('you came out last year').",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    name: "search_knowledge",
    description:
      "Search the business's own documents for an answer not already in your context. " +
      "If this returns nothing, say you'll check with the team — do not improvise.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "record_consent",
    description:
      "Record explicit permission to contact this person later by SMS or email. " +
      "Only call this when they clearly agreed in their own words. Quote them in `quote`.",
    input_schema: {
      type: "object",
      properties: {
        channel: { type: "string", enum: ["sms", "email"] },
        quote: { type: "string", description: "The customer's exact words granting permission." },
      },
      required: ["channel", "quote"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "remember",
    description:
      "Store a durable fact about this customer that will still matter on a future " +
      "job: their equipment, access instructions, a constraint on when they're " +
      "available, a heads-up for the technician. Do NOT use it for things only " +
      "relevant to this conversation.",
    input_schema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["equipment", "property", "preference", "constraint", "relationship", "history", "caution"],
        },
        key: { type: "string", description: "Short stable slug, e.g. 'system_brand'. Reusing a key replaces the old value." },
        value: { type: "string", description: "The fact, written so a technician reading it next year understands it." },
      },
      required: ["kind", "key", "value"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "offer_callback",
    description:
      "Offer to have a colleague call the customer back about something you " +
      "cannot answer or do. This does NOT transfer them — it asks whether they " +
      "want a callback, and nothing happens unless they say yes. Use it when " +
      "you are out of your depth, not for ordinary questions you can answer.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "What the colleague would be calling about." },
      },
      required: ["reason"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "escalate_to_human",
    description:
      "Hand this conversation to a human and stop replying. Use ONLY for: a legal " +
      "or insurance matter, a medical or safety issue, a refund or billing dispute, " +
      "repeated frustration after you have already tried to help, or an explicit " +
      "request to speak to a named person or 'a real person'. " +
      "Do NOT use it for small talk, greetings, or someone simply asking whether " +
      "you can talk, hear, or help them — answer those yourself.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string" },
        urgency: { type: "string", enum: ["now", "soon", "whenever"] },
      },
      required: ["reason", "urgency"],
      additionalProperties: false,
    },
    strict: true,
  },
];

/**
 * Has the calendar been asked at any point in this conversation? Gate 2 holds
 * a reply that offers times when it has not, since those times are invented.
 */
export async function availabilityChecked(conversationId: string, thisTurn: ToolCallRecord[]): Promise<boolean> {
  if (thisTurn.some((t) => t.name === "check_availability")) return true;
  const earlier = await db.query.agentRuns.findFirst({
    columns: { id: true },
    where: and(
      eq(agentRuns.conversationId, conversationId),
      sql`${agentRuns.toolCalls} @> '[{"name":"check_availability"}]'::jsonb`,
    ),
  });
  return Boolean(earlier);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Executors
 * ──────────────────────────────────────────────────────────────────────────── */

export async function executeTool(
  ctx: AgentContext,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  switch (name) {
    case "check_availability": return checkAvailability(ctx, input);
    case "book_appointment": return bookAppointment(ctx, input);
    case "save_contact_detail": return saveContactDetail(ctx, input);
    case "qualify_lead": return qualifyLead(ctx, input);
    case "lookup_customer_history": return lookupHistory(ctx);
    case "search_knowledge": return doSearch(ctx, input);
    case "record_consent": return recordConsent(ctx, input);
    case "remember": return storeMemory(ctx, input);
    case "escalate_to_human": return escalate(ctx, input);
    case "offer_callback": return offerCallback(ctx, input);
    default: return { ok: false, error: `unknown tool ${name}` };
  }
}

async function checkAvailability(ctx: AgentContext, input: Record<string, unknown>): Promise<ToolResult> {
  const tz = ctx.location?.timezone ?? ctx.tenant.timezone;
  const duration = clampInt(input.duration_minutes, 15, 480, 60);
  const days = clampInt(input.days, 1, 14, 5);
  const now = new Date();

  const fromDate =
    typeof input.from_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.from_date)
      ? fromZonedTime(`${input.from_date}T00:00:00`, tz)
      : startOfDay(now);

  const hours: BusinessHours[] = ctx.location?.hours ?? [];
  if (hours.length === 0) {
    return { ok: false, error: "no business hours configured — cannot offer times" };
  }

  const rangeEnd = addDays(fromDate, days);
  const booked = await db.query.appointments.findMany({
    where: and(
      eq(appointments.tenantId, ctx.tenant.id),
      gte(appointments.startsAt, fromDate),
      lte(appointments.startsAt, rangeEnd),
    ),
  });
  const busy = booked
    .filter((a) => a.status === "confirmed" || a.status === "pending")
    .map((a) => ({ start: a.startsAt, end: a.endsAt }));

  const slots: { starts_at: string; label: string }[] = [];

  for (let d = 0; d < days && slots.length < 8; d++) {
    const day = addDays(fromDate, d);
    const weekday = Number(formatInTimeZone(day, tz, "i")) % 7; // ISO 1-7 (Mon-Sun) -> 0-6 (Sun-Sat)
    const todaysHours = hours.filter((h) => h.day === weekday);

    for (const window of todaysHours) {
      const dateStr = formatInTimeZone(day, tz, "yyyy-MM-dd");
      let cursor = fromZonedTime(`${dateStr}T${window.open}:00`, tz);
      const close = fromZonedTime(`${dateStr}T${window.close}:00`, tz);

      while (isBefore(addMinutes(cursor, duration), addMinutes(close, 1))) {
        const slotEnd = addMinutes(cursor, duration);
        const inPast = isBefore(cursor, addMinutes(now, 60)); // need an hour's notice
        const overlaps = busy.some((b) => isBefore(cursor, b.end) && isAfter(slotEnd, b.start));

        if (!inPast && !overlaps) {
          slots.push({
            starts_at: cursor.toISOString(),
            label: formatInTimeZone(cursor, tz, "EEEE d MMM, h:mm a"),
          });
          if (slots.length >= 8) break;
        }
        cursor = addMinutes(cursor, 30);
      }
    }
  }

  return {
    ok: true,
    timezone: tz,
    slots,
    note: slots.length === 0 ? "No open slots in this range — offer to have someone call back." : undefined,
  };
}

async function bookAppointment(ctx: AgentContext, input: Record<string, unknown>): Promise<ToolResult> {
  const contact = await db.query.contacts.findFirst({ where: eq(contacts.id, ctx.contactId) });
  if (!contact) return { ok: false, error: "contact not found" };
  if (!contact.displayName) return { ok: false, error: "need the customer's name first — call save_contact_detail" };
  if (!contact.primaryPhone) return { ok: false, error: "need a callback phone number first — call save_contact_detail" };

  const startsAt = new Date(String(input.starts_at));
  if (Number.isNaN(startsAt.getTime())) return { ok: false, error: "starts_at is not a valid ISO datetime" };
  if (isBefore(startsAt, new Date())) return { ok: false, error: "that time is in the past" };

  const duration = clampInt(input.duration_minutes, 15, 480, 60);
  const endsAt = addMinutes(startsAt, duration);

  // Re-check the slot at write time: availability may have changed mid-conversation.
  // Only live bookings block it (filtering after findFirst let a cancelled one
  // hide a confirmed one in the same slot), and back-to-back slots don't overlap.
  const clash = await db.query.appointments.findFirst({
    where: and(
      eq(appointments.tenantId, ctx.tenant.id),
      inArray(appointments.status, ["confirmed", "pending"]),
      lt(appointments.startsAt, endsAt),
      gt(appointments.endsAt, startsAt),
    ),
  });
  if (clash) {
    return { ok: false, error: "that slot was just taken — call check_availability again" };
  }

  const lead = await db.query.leads.findFirst({
    where: and(eq(leads.tenantId, ctx.tenant.id), eq(leads.contactId, ctx.contactId)),
    orderBy: desc(leads.createdAt),
  });

  const [appt] = await db.insert(appointments).values({
    tenantId: ctx.tenant.id,
    contactId: ctx.contactId,
    leadId: lead?.id,
    locationId: ctx.location?.id,
    service: String(input.service),
    startsAt,
    endsAt,
    notes: input.notes ? String(input.notes) : null,
    status: "confirmed",
  }).returning();

  if (lead) {
    await db.update(leads).set({ status: "booked", updatedAt: new Date() }).where(eq(leads.id, lead.id));
  }

  const convo = await db.query.conversations.findFirst({ where: eq(conversations.id, ctx.conversationId) });
  await scheduleAppointmentReminders(appt.id, { bookedOnCall: convo?.channel === "voice" });

  await db.insert(events).values({
    tenantId: ctx.tenant.id,
    type: "appointment_booked",
    conversationId: ctx.conversationId,
    contactId: ctx.contactId,
    payload: { appointmentId: appt.id, service: appt.service, startsAt: startsAt.toISOString() },
  });

  const tz = ctx.location?.timezone ?? ctx.tenant.timezone;
  return {
    ok: true,
    appointment_id: appt.id,
    confirmed_for: formatInTimeZone(startsAt, tz, "EEEE d MMMM 'at' h:mm a"),
  };
}

async function saveContactDetail(ctx: AgentContext, input: Record<string, unknown>): Promise<ToolResult> {
  const field = String(input.field);
  const value = String(input.value).trim();

  if (field === "name") {
    await db.update(contacts).set({ displayName: value }).where(eq(contacts.id, ctx.contactId));
    return { ok: true, saved: "name" };
  }

  const res = await linkIdentifierToContact(
    ctx.tenant.id, ctx.contactId,
    field === "phone" ? "phone" : "email",
    value, ctx.tenant.country,
  );
  return res.ok ? { ok: true, saved: field } : { ok: false, error: res.reason };
}

async function qualifyLead(ctx: AgentContext, input: Record<string, unknown>): Promise<ToolResult> {
  const conversation = await db.query.conversations.findFirst({
    where: eq(conversations.id, ctx.conversationId),
  });

  const existing = await db.query.leads.findFirst({
    where: and(eq(leads.tenantId, ctx.tenant.id), eq(leads.conversationId, ctx.conversationId)),
  });

  const values = {
    service: String(input.service),
    intent: String(input.intent),
    urgency: String(input.urgency),
    score: clampInt(input.score, 0, 100, 50),
    estimatedValue: input.estimated_value != null ? String(input.estimated_value) : null,
    summary: input.summary ? String(input.summary) : null,
    status: "qualified" as const,
    updatedAt: new Date(),
  };

  if (existing) {
    await db.update(leads).set(values).where(eq(leads.id, existing.id));
    return { ok: true, lead_id: existing.id, updated: true };
  }

  const [lead] = await db.insert(leads).values({
    ...values,
    tenantId: ctx.tenant.id,
    contactId: ctx.contactId,
    conversationId: ctx.conversationId,
    sourceChannel: conversation?.channel ?? "webchat",
  }).returning();

  await db.insert(events).values({
    tenantId: ctx.tenant.id,
    type: "lead_qualified",
    conversationId: ctx.conversationId,
    contactId: ctx.contactId,
    payload: { leadId: lead.id, score: values.score, urgency: values.urgency, service: values.service },
  });

  return { ok: true, lead_id: lead.id, created: true };
}

async function lookupHistory(ctx: AgentContext): Promise<ToolResult> {
  const [contact, appts] = await Promise.all([
    db.query.contacts.findFirst({ where: eq(contacts.id, ctx.contactId) }),
    db.query.appointments.findMany({
      where: eq(appointments.contactId, ctx.contactId),
      orderBy: desc(appointments.startsAt),
      limit: 5,
    }),
  ]);

  const tz = ctx.tenant.timezone;
  return {
    ok: true,
    known_customer: appts.length > 0,
    name: contact?.displayName ?? null,
    past_appointments: appts.map((a) => ({
      service: a.service,
      when: formatInTimeZone(a.startsAt, tz, "d MMM yyyy"),
      status: a.status,
    })),
  };
}

async function doSearch(ctx: AgentContext, input: Record<string, unknown>): Promise<ToolResult> {
  const query = String(input.query);

  // Hybrid dense+lexical retrieval first; fall back to plain full-text if the
  // tenant's documents have not been indexed (or embeddings are unavailable).
  try {
    const hits = await hybridSearch(ctx.tenant.id, query, 4);
    if (hits.length > 0) {
      return {
        ok: true,
        found: true,
        results: hits.map((h) => ({ content: h.content })),
        retrieval: "hybrid",
      };
    }
  } catch {
    /* fall through to lexical-only */
  }

  const rows = await searchKnowledge(ctx.tenant.id, query);
  return {
    ok: true,
    found: rows.length > 0,
    results: rows.map((r) => ({ title: r.title, content: r.content.slice(0, 1200) })),
    retrieval: "fulltext",
  };
}

async function recordConsent(ctx: AgentContext, input: Record<string, unknown>): Promise<ToolResult> {
  const channel = String(input.channel);
  const quote = String(input.quote);

  await db.update(contacts)
    .set({
      ...(channel === "sms" ? { smsConsent: true } : { emailConsent: true }),
      consentSource: `agent-collected in conversation ${ctx.conversationId}: "${quote}"`,
      consentAt: new Date(),
    })
    .where(eq(contacts.id, ctx.contactId));

  await db.insert(events).values({
    tenantId: ctx.tenant.id,
    type: "consent_recorded",
    conversationId: ctx.conversationId,
    contactId: ctx.contactId,
    payload: { channel, quote },
  });

  return { ok: true, recorded: channel };
}

async function escalate(ctx: AgentContext, input: Record<string, unknown>): Promise<ToolResult> {
  await db.update(conversations)
    .set({ aiPaused: true, status: "open" })
    .where(eq(conversations.id, ctx.conversationId));

  await db.insert(events).values({
    tenantId: ctx.tenant.id,
    type: "escalated_to_human",
    conversationId: ctx.conversationId,
    contactId: ctx.contactId,
    payload: { reason: String(input.reason), urgency: String(input.urgency) },
  });

  // The customer has just been promised a person; make sure one knows. An
  // alert failure must never stop the handover itself.
  const alert = await alertStaff({
    tenantId: ctx.tenant.id, conversationId: ctx.conversationId,
    reason: String(input.reason), urgency: String(input.urgency) as AlertUrgency,
  }).catch((err) => ({ error: err instanceof Error ? err.message : "alert failed" }));

  return {
    ok: true,
    escalated: true,
    alerted: alert,
    instruction: "Tell the customer a team member will follow up shortly, then stop.",
  };
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

async function storeMemory(ctx: AgentContext, input: Record<string, unknown>): Promise<ToolResult> {
  const res = await remember({
    tenantId: ctx.tenant.id,
    contactId: ctx.contactId,
    kind: String(input.kind) as Parameters<typeof remember>[0]["kind"],
    key: String(input.key),
    value: String(input.value),
    confidence: 0.9,
    conversationId: ctx.conversationId,
    origin: "agent_tool",
  });
  return {
    ok: true,
    stored: res.unchanged ? "already known" : res.superseded ? "updated" : "new",
  };
}

/**
 * Offering a callback is not the same as making one.
 *
 * Unilaterally announcing "I'm handing you to a human" over a question the
 * agent could have answered strands the caller: nobody is actually on the
 * line, and the conversation is over. This asks first, and only a yes from
 * the caller turns into a real handover.
 */
async function offerCallback(ctx: AgentContext, input: Record<string, unknown>): Promise<ToolResult> {
  await db.insert(events).values({
    tenantId: ctx.tenant.id,
    type: "callback_offered",
    conversationId: ctx.conversationId,
    contactId: ctx.contactId,
    payload: { reason: String(input.reason) },
  });
  return {
    ok: true,
    offered: true,
    instruction:
      "Ask the caller, in one short sentence, whether they would like a colleague " +
      "to call them back about this. Do NOT say you are transferring them, and do " +
      "NOT end the conversation. Wait for their answer.",
  };
}
