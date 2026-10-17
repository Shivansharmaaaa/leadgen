import { executeTool, type AgentContext } from "./tools";
import type { ToolCallRecord } from "@/server/db";

/**
 * Is booking in play in this conversation, and if so, what is actually open?
 *
 * Shared by the voice and text pipelines. Told to "ALWAYS call
 * check_availability", the 3B model still made slots up ("2:30 to 4:00 PM")
 * and Gate 2 held the reply, leaving the customer with nothing. So while
 * scheduling is in play the calendar is read before generation and the real
 * slots go into the per-turn context.
 */

type Msg = { direction: string; body: string };

/** A described fault is the start of a job. */
export const FAULT = /\b(not (?:working|cooling|heating)|(?:isn't|is not|won't|will not|doesn't|does not|stopped) (?:working|cooling|heating|running|turning on|turn on|start(?:ing)?|blowing)|broken|leak|smell|noise|no heat|blowing warm)\b/i;

const SCHEDULING = /\b(?:book|schedule|appointment|consult(?:ation)?s?|sessions?|meeting|come out|come round|visit|availability|when can|what times?|slots?|today|tomorrow|tonight|this week|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|asap|as soon as|emergency|urgent)\b/i;

/**
 * Asking for work: "I need someone to service my heat pump", then "what have
 * you got?". A verb needs an object ("install my", "fix the"), so "what brands
 * do you install" stays a product question.
 */
const JOB_REQUEST = /\b(?:need|want|get|send|have) (?:someone|somebody|a (?:tech|technician|engineer))\b|\b(?:service|repair|fix|replace|install|check|look at|tune up)\s+(?:my|the|our|a new|a|an)\b|\b(?:tune[- ]?ups?|maintenance|servicing|repairs)\b/i;

/**
 * Asking for a time in words SCHEDULING misses: "when could you fit me in?",
 * "what's the earliest you have?", "any openings?". Anchored to times and
 * slots, so "the earliest model year you service" and "is the next one
 * cheaper?" stay product questions: slots in context made the 3B model answer
 * product questions with appointment times.
 */
export const BOOKING_INTENT = new RegExp([
  String.raw`\bwhen could\b`,
  String.raw`\bfit (?:me|us|him|her|them|it) in\b`,
  String.raw`\b(?:earliest|soonest)\s+(?:available|opening|appointment|slot|time|visit|you(?:'ve| have| can| could| got)?)\b`,
  String.raw`\bnext\s+(?:available|opening|appointment|slot)\b`,
  String.raw`\bany (?:openings|availability|slots|appointments|times)\b`,
  String.raw`\bbook (?:me|us|him|her|them) in\b`,
].join("|"), "i");

/** The agent offered to book: "Would you like me to find you a time?" makes "yes please" a request for times. */
const AGENT_BOOKING_OFFER = /\bset up (?:that|a) visit|\bbook (?:you|a|that)\b|\bfind you a time\b|\bget you (?:booked|in|scheduled)\b/i;

/** Has a time already been put in front of this customer? Only then can they have chosen one. */
export function slotOffered(ordered: Msg[]): boolean {
  return ordered.some((m) => m.direction === "outbound" && /\b\d{1,2}(:\d{2})?\s?(am|pm)\b/i.test(m.body));
}

export function schedulingInPlay(ordered: Msg[]): boolean {
  const recent = ordered.slice(-4);
  return (
    slotOffered(ordered) ||
    recent.some((m) => SCHEDULING.test(m.body)) ||
    // A described fault is a job: "no heat and a baby in the house" needs a
    // time today, and without the tool the model can only promise vaguely.
    recent.some((m) => m.direction === "inbound" && (FAULT.test(m.body) || JOB_REQUEST.test(m.body) || BOOKING_INTENT.test(m.body))) ||
    // The agent itself offered a visit or a booking.
    ordered.slice(-2).some((m) => m.direction === "outbound" && AGENT_BOOKING_OFFER.test(m.body))
  );
}

/**
 * Read the calendar for the model. Returns the context note and the tool
 * record (so Gate 2 knows availability was checked), or null when there is
 * nothing usable to say: a tenant with no hours gets no note, not an error.
 */
export async function openSlotsNote(
  ctx: AgentContext,
): Promise<{ note: string; record: ToolCallRecord } | null> {
  const t0 = Date.now();
  const input = { service: "service visit" };
  const result = await executeTool(ctx, "check_availability", input)
    .catch((e) => ({ ok: false, error: String(e) }));
  const record: ToolCallRecord = { name: "check_availability", input, output: result, ms: Date.now() - t0 };
  if ((result as { ok?: boolean }).ok === false) return null;
  return {
    record,
    note:
      `# Open slots, checked just now\n${JSON.stringify(result)}\n` +
      "When you offer times, offer two of THESE, by day and time, and no others. If there " +
      "are none, say so and offer a callback.",
  };
}
