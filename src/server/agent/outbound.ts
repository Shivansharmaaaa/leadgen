import type { TenantSettings } from "@/server/db";

/**
 * A call the agent places: a follow-up to someone who asked about something
 * on the business's website, which is the lawful shape of an outbound AI
 * call. Shared by the voice route (the opener), runVoiceTurn (the per-turn
 * note) and the fine-tune export, which must render it byte for byte.
 *
 * Nothing here is trade-specific: what the call is about, and what a booking
 * is called, come from the tenant's settings.
 */

export type OutboundCall = { name: string | null; interest: string };

/** Why the agent is calling, as the phrase after "You asked us about …". */
export function outboundReason(settings: TenantSettings, key: string | undefined): string {
  const reasons = settings.outboundReasons ?? {};
  return (key && reasons[key]) || Object.values(reasons)[0] || "your enquiry";
}

/** The opener: fixed text, so it plays instantly, and it says it is an AI. */
export function outboundOpener(
  settings: TenantSettings & { businessName?: string; agentName?: string },
  fallbackName: string,
  call: OutboundCall,
): string {
  const business = settings.businessName ?? fallbackName;
  const agent = settings.agentName ?? "Alex";
  return `Hi${call.name ? ` ${call.name}` : ""}, this is ${agent}, an AI assistant calling from ${business}. ` +
    `You asked us about ${call.interest} on our website, so I'm following up. Is now a good time for a quick chat?`;
}

/** Per-turn context for every turn after the opener. */
export function outboundNote(settings: TenantSettings, call: OutboundCall): string {
  const booking = settings.bookingNoun ?? "consultation";
  return (
    `# You placed this call\nYou called ${call.name ?? "this person"} because they asked about ` +
    `${call.interest} on our website, so they agreed to be contacted. You called them: never ask what ` +
    `they are calling about or how you can help. Your goal is to book a ${booking}.\n` +
    "- If it is a bad time, offer to call back when it suits them, and stop.\n" +
    `- Once they can talk, first say in a sentence or two what ${call.interest} involves with us, from ` +
    "the facts. Then ask ONE short question at a time about their situation and what they want.\n" +
    "- Tie what they tell you to what we actually offer, using only the facts you have.\n" +
    `- Answer objections with facts and value. If they hesitate on price, say what the facts say about ` +
    `payment, and that the ${booking} commits them to nothing (call it free only if the facts say so). ` +
    "Never pressure, never promise an outcome, and never invent a discount or a deadline.\n" +
    `- Once they are interested, offer two specific open times for the ${booking}.\n` +
    "- If they say no, or ask not to be called, thank them and end the call politely."
  );
}
