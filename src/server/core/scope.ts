/**
 * Topic scope guard.
 *
 * A caller asked "so what model do you want can you tell me" and the agent
 * spent a full generation producing a deflection. Two costs there: tokens on
 * something the business does not want discussed, and seconds of silence for
 * an answer that is always the same.
 *
 * Clearly out-of-scope turns are answered deterministically — no model call,
 * no tokens, no latency — and the answer is a short, natural redirect rather
 * than a refusal. Anything ambiguous goes to the model, because a guard that
 * misfires on a real customer is far worse than one that lets a stray
 * question through.
 */

/** Asked about the assistant itself, its model, vendor, or prompt. */
const META_PATTERNS = [
  /\bwhat (?:ai |language )?model\b/i,
  /\bwhich (?:ai |language )?model\b/i,
  /\b(?:are you|you'?re) (?:chatgpt|gpt|claude|gemini|llama|openai)\b/i,
  /\bwho (?:made|built|created|trained) you\b/i,
  /\b(?:system|your) prompt\b/i,
  /\bwhat (?:are your|were your) instructions\b/i,
  /\bignore (?:your |all |previous )?(?:instructions|rules)\b/i,
  /\bhow (?:do|does) (?:you|this) work\b.*\b(?:ai|model|llm|trained)\b/i,
];

/** General-knowledge or assistant-style requests with no business relevance. */
const OFF_TOPIC_PATTERNS = [
  /\b(?:write|compose|draft) me (?:a|an|some)\b/i,
  /\btell me a (?:joke|story|poem)\b/i,
  /\bwhat(?:'s| is) the (?:capital|population|weather) (?:of|in)\b/i,
  /\b(?:translate|summarise|summarize) (?:this|the following)\b/i,
  /\bwho (?:is|was) the (?:president|prime minister|king|queen)\b/i,
  /\b(?:python|javascript|sql|code|function|algorithm)\b.*\b(?:write|fix|debug|explain)\b/i,
  /\bwhat(?:'s| is) \d+\s*[-+*/x]\s*\d+/i,
  /\b(?:recipe|football|cricket|movie|song|horoscope)\b/i,
  // General advice the business has no standing to give.
  /\bwhat (?:should|do) i (?:wear|eat|watch|read|buy)\b/i,
  /\b(?:recommend|suggest) (?:a|an|some)\b(?!.*\b(?:technician|engineer|time|slot|appointment|service|unit|system|filter)\b)/i,
  /\bwhat(?:'s| is) your (?:opinion|advice) (?:on|about)\b/i,
];

/** Anything that plausibly belongs to a home-services enquiry. */
const IN_SCOPE_PATTERNS = [
  /\b(a\/?c|air con|cooling|heat|heating|furnace|boiler|hvac|thermostat|duct|vent|unit|system|filter)\b/i,
  /\b(book|schedule|appointment|available|availability|come out|visit|slot|time)\b/i,
  /\b(price|cost|quote|charge|fee|estimate|how much|financing|payment)\b/i,
  /\b(broken|not working|repair|fix|install|replace|service|maintenance|leak|noise|smell)\b/i,
  /\b(name|number|phone|email|address|postcode|zip)\b/i,
  /\b(emergency|urgent|today|tomorrow|warranty|guarantee|technician|engineer)\b/i,
  /\b(yes|no|ok|okay|sure|thanks|thank you|please|hello|hi|hey|bye|goodbye)\b/i,
];

export type ScopeVerdict =
  | { inScope: true }
  | { inScope: false; kind: "meta" | "off_topic"; reply: string };

export function screenScope(body: string, businessName: string): ScopeVerdict {
  const text = body.trim();
  if (text.length === 0) return { inScope: true };

  // A short reply inside a live conversation is almost never off-topic.
  if (text.split(/\s+/).length <= 3) return { inScope: true };

  const hasBusinessSignal = IN_SCOPE_PATTERNS.some((re) => re.test(text));

  if (META_PATTERNS.some((re) => re.test(text))) {
    return {
      inScope: false,
      kind: "meta",
      reply:
        `I'm the AI assistant for ${businessName}, so I'll stick to what we do here. ` +
        `What's going on with your system?`,
    };
  }

  // Off-topic only counts when nothing in the message relates to the business,
  // so "my AC is broken, and what's the weather" still reaches the model.
  if (!hasBusinessSignal && OFF_TOPIC_PATTERNS.some((re) => re.test(text))) {
    return {
      inScope: false,
      kind: "off_topic",
      reply:
        `That's outside what I can help with — I'm here for ${businessName}. ` +
        `Is there something I can sort out with your heating or cooling?`,
    };
  }

  return { inScope: true };
}

/**
 * Per-conversation budget.
 *
 * Caps how long a single conversation can run before a human takes it. Without
 * one, a caller who keeps talking can run indefinitely at full model cost, and
 * a conversation that has gone twenty turns without booking is one a person
 * should be handling anyway.
 */
export const MAX_AI_TURNS = 20;

export function overBudget(aiTurns: number): boolean {
  return aiTurns >= MAX_AI_TURNS;
}


/**
 * Did the caller just agree to something?
 *
 * Used to turn an offered callback into a real one. Deliberately narrow: a
 * handover that happens on a misread "no" strands the caller, so anything
 * ambiguous is treated as neither and the conversation carries on.
 */
/** "That'd be great", "that would help": agreement in full, not a new request. */
const AGREE_PHRASE = String.raw`that'?d (?:be (?:great|good|lovely|perfect|helpful|brilliant)|help)|that would (?:be (?:great|good|lovely|perfect|helpful|brilliant)|help)`;
const AFFIRMATIVE = new RegExp(String.raw`^(?:yes|yeah|yep|yup|sure|ok|okay|please|please do|that(?:'?s| is) (?:fine|great|good)|go ahead|sounds good|alright|why not|definitely|absolutely|${AGREE_PHRASE})\b`, "i");
const NEGATIVE = /^(?:no|nope|nah|not (?:really|now|yet)|that(?:'?s| is) (?:ok|okay|fine)[, ]*(?:i'?m fine|no thanks)?|don'?t|no thanks|i'?m (?:good|fine|okay))\b/i;

export type Agreement = "yes" | "no" | "unclear";

export function readAgreement(text: string): Agreement {
  const t = text.trim();
  if (!t) return "unclear";

  /**
   * Agreement only when agreeing is ALL they said. "Okay, can someone come out
   * tomorrow?" begins with "okay" but is a new request — reading it as "yes"
   * to an offered callback handed a caller who wanted a visit to a human.
   * Anything beyond the agreement itself goes back to normal handling.
   */
  const rest = t
    .replace(/^(?:yes|yeah|yep|yup|sure|ok|okay|please|alright|no|nope|nah)\b[\s,.!]*/i, "")
    .replace(new RegExp(String.raw`^(?:please|please do|go ahead|that'?s (?:fine|great|good|ok|okay)|sounds good|thanks?(?: you)?|cheers|${AGREE_PHRASE})\b[\s,.!]*`, "i"), "")
    .trim();
  const extra = rest.split(/\s+/).filter(Boolean).length;
  if (extra > 2) return "unclear";

  if (NEGATIVE.test(t)) return "no";
  if (AFFIRMATIVE.test(t)) return "yes";
  return "unclear";
}
