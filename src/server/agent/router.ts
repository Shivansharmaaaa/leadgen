import { resolveFastPath, type FastPath } from "./fast-path";
import { screenScope, type ScopeVerdict } from "@/server/core/scope";

/**
 * Turn router.
 *
 * Not every turn needs the same machinery. Most of what a caller says is
 * conversational — a greeting, an acknowledgement, a clarification — and
 * running it through the full transactional path means loading eight tool
 * schemas, the whole knowledge base and two guardrail gates to produce one
 * sentence. The transactional turns, the ones that book a job or quote a
 * price, genuinely need all of it.
 *
 * So each turn is routed to the cheapest tier that can answer it correctly.
 * The tiers are ordered by cost, and a turn takes the first one that fits:
 *
 *   canned      a fixed fact, served with no model at all          ~10ms
 *   chat        conversational; no tools, short reply, small model  fast
 *   transact    needs tools, facts or booking: the full pipeline    slow
 *
 * This is also where a speech-to-speech model slots in later: `chat` is
 * exactly the tier Moshi is good at and `transact` is the tier it cannot do,
 * so the routing boundary is already the right one.
 */

export type Tier = "canned" | "chat" | "transact" | "redirect";

export type Route = {
  tier: Tier;
  reason: string;
  /** Present when the tier is "canned" or a prefix was matched. */
  fastPath?: FastPath;
  /** Present when the tier is "redirect". */
  scope?: ScopeVerdict;
};

/** Turns that plainly need a tool, a price, or a commitment. */
const TRANSACTIONAL = [
  /\b(book|schedule|appointment|come out|send someone|availability|available|slot|when can)\b/i,
  /\b(price|cost|quote|charge|fee|estimate|how much|financing|deposit)\b/i,
  /\b(cancel|reschedul|confirm|change (?:my|the) (?:time|appointment|booking))\b/i,
  /\b(warranty|guarantee|policy|insurance|contract)\b/i,
  /\b(my (?:name|number) is|you can reach me|call me on|phone number)\b/i,
  // A described fault is the start of a job, so it belongs on the full path.
  /\b(not (?:working|cooling|heating)|broken|leak|smell|noise|no heat|blowing warm|stopped working)\b/i,
];

/** Turns that are plainly just conversation. */
const CONVERSATIONAL = [
  /^(?:hi|hello|hey|good (?:morning|afternoon|evening))\b/i,
  /\b(?:thank you|thanks|cheers|appreciate it|that'?s great|perfect|brilliant|lovely)\b/i,
  /\b(?:bye|goodbye|see you|take care|that'?s all|nothing else)\b/i,
  /\b(?:can you (?:hear|understand) me|are you (?:there|still there)|hello\?)\b/i,
  /\b(?:sorry|pardon|say that again|repeat that|what was that)\b/i,
  /^(?:yes|no|yeah|yep|nope|ok|okay|sure|right|got it|understood)\b/i,
];

export async function routeTurn(
  tenantId: string,
  text: string,
  businessName: string,
): Promise<Route> {
  const t = text.trim();

  // Out of scope short-circuits everything — answered with no model at all.
  const scope = screenScope(t, businessName);
  if (!scope.inScope) {
    return { tier: "redirect", reason: scope.kind, scope };
  }

  const fast = await resolveFastPath(tenantId, t);
  if (fast.kind === "full") {
    return { tier: "canned", reason: `fact:${fast.factKey}`, fastPath: fast };
  }

  // Transactional beats conversational when both match: "thanks, can you come
  // Tuesday?" needs the booking path, not the chat one.
  if (TRANSACTIONAL.some((re) => re.test(t))) {
    return { tier: "transact", reason: "tool or commitment needed", fastPath: fast };
  }

  if (CONVERSATIONAL.some((re) => re.test(t)) || t.split(/\s+/).length <= 5) {
    return { tier: "chat", reason: "conversational", fastPath: fast };
  }

  // Unknown shape: the expensive path is the safe one.
  return { tier: "transact", reason: "unclassified — defaulting to full path", fastPath: fast };
}
