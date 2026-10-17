import { eq, and } from "drizzle-orm";
import { db, knowledgeFacts } from "@/server/db";

/**
 * Canned replies, in two forms.
 *
 * 1. FULL ANSWER — a question whose answer is a fixed fact the business has
 *    already written down. "Do you charge for the call-out?" has exactly one
 *    correct answer and the model cannot improve on it, so it is served from
 *    the knowledge facts directly: no generation, no tokens, no risk of the
 *    number drifting.
 *
 * 2. PREFIX — an opener spoken immediately while the model writes the rest.
 *    This is the bigger latency win: the caller hears a human-sounding
 *    acknowledgement at ~0ms instead of three seconds of silence, and the
 *    model's reply arrives behind it. The model is told what was already said
 *    so it continues rather than repeating it.
 *
 * Both are deliberately high-precision. A canned line that misfires is worse
 * than the latency it saves, so patterns match intent narrowly and anything
 * uncertain falls through to the model.
 */

export type FastPath =
  | { kind: "full"; text: string; factKey: string }
  | { kind: "prefix"; text: string; intent: string }
  | { kind: "none" };

/* ── 1. Full answers, built from the tenant's own verified facts ─────────── */

type FaqRule = {
  /** Must match for the rule to fire. */
  test: RegExp;
  /** If this also matches, the rule does not fire. */
  unless?: RegExp;
  /** Fact(s) to answer from, as `category/key`. All must exist. */
  fact: string | string[];
  /** How to speak it, given the fact values in the order listed. */
  say: (...values: string[]) => string;
};

/**
 * Facts are written for a page. Parentheses and semicolons read badly aloud,
 * so they become commas and sentence breaks — and the joins are tidied, or the
 * voice says "Dealer, ." and starts the next sentence in lower case.
 */
function speakable(x: string): string {
  let t = x
    .replace(/\s*\(([^)]*)\)\s*/g, ", $1, ")
    .replace(/\s*;\s*/g, ". ")
    .replace(/\s+,/g, ",")
    .replace(/,\s*([.!?])/g, "$1")
    .replace(/,{2,}/g, ",")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/,$/, "");
  t = t.replace(/([.!?])\s+([a-z])/g, (_, p, c) => `${p} ${c.toUpperCase()}`);
  return t;
}

const asSentence = (x: string) => {
  const t = speakable(x);
  return t[0].toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? "" : ".");
};

/** Words that make "options" or "available" about a TIME, not a product. */
const TIME_WORDS = /\b(?:times?|slots?|appointments?|days?|today|tomorrow|tonight|morning|afternoon|evening|week|weekend|when|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;

const FAQ_RULES: FaqRule[] = [
  {
    // "What AC options do you have?" was answered with appointment times.
    // Product questions get the product facts, unless time words make it
    // about scheduling after all.
    test: /\b(?:options?|types?|kinds?|brands?|makes?|models?|systems?|units?)\b.*\b(?:have|offer|sell|install|do you|available|carry|got)\b|\b(?:what|which) (?:options?|types?|kinds?|brands?|systems?|units?)\b/i,
    unless: TIME_WORDS,
    fact: ["products/AC system types", "products/Brands installed", "products/How a system is chosen"],
    say: (types, brands, how) =>
      `We do ${speakable(types)}. ${asSentence(brands)} ${asSentence(how)} ` +
      `Would you like me to set up that visit?`,
  },
  {
    // Answerable from the facts, yet the model offered a callback instead.
    // Needs a comparison or a running-cost question: a bare "energy bills"
    // complaint may be a fault, so it goes to the model.
    test: /\b(?:cheaper|cheapest|more efficient|most efficient|less to run|cheaper to run|running costs?|cost(?:s)? to run|efficiency)\b/i,
    unless: TIME_WORDS,
    fact: "products/Efficiency options",
    say: (eff) =>
      `We offer ${speakable(eff)}. A technician can work out which pays off for your home on the ` +
      `free visit. Would you like me to set that up?`,
  },
  {
    test: /\b(?:do you |is there (?:a|any) |what(?:'s| is) the )?(?:charge|cost|fee|price)\b.*\b(?:call ?out|come out|visit|diagnos|turn up|show up)\b|\bcall ?out (?:fee|charge|cost)\b/i,
    fact: "pricing/Diagnostic visit",
    say: (v) => `The diagnostic visit is ${v}.`,
  },
  {
    test: /\b(?:after[- ]?hours|out of hours|emergency)\b.*\b(?:cost|charge|price|fee|rate)\b|\bhow much\b.*\bemergency\b/i,
    fact: "pricing/Emergency after-hours callout",
    say: (v) => `An emergency after-hours callout is ${v}.`,
  },
  {
    test: /\b(?:maintenance|service) (?:plan|contract|agreement)\b|\bannual (?:plan|maintenance|service)\b/i,
    fact: "pricing/Annual maintenance plan",
    say: (v) => `Our annual maintenance plan is ${v}.`,
  },
  {
    test: /\b(?:what|which) (?:services|work|jobs)\b.*\b(?:do you|you do|offer|provide)\b|\bwhat do you (?:do|offer|handle)\b/i,
    fact: "services/Offered",
    say: (v) => `We handle ${v}.`,
  },
  {
    test: /\b(?:do you (?:take|accept)|how (?:do|can) i pay|payment (?:options|methods))\b|\bcan i pay by\b/i,
    fact: "policy/Payment",
    say: (v) => `${v}.`,
  },
  {
    test: /\b(?:what(?:'s| is) (?:the|your) )?warranty\b|\bguarantee(?:d)? (?:on|for) (?:the|your) work\b/i,
    fact: "policy/Warranty",
    say: (v) => `${v}.`,
  },
  {
    test: /\b(?:cancel|cancellation|reschedul)\w*\b.*\b(?:policy|fee|charge|free)\b|\bwhat if i (?:need to )?cancel\b/i,
    fact: "policy/Cancellation",
    say: (v) => `${v}.`,
  },
];

/* ── 2. Prefixes, spoken while the model works ──────────────────────────── */

type PrefixRule = { intent: string; test: RegExp; openers: string[] };

/** Asking for certainty the business can't give: approval, admission, a result. */
const GUARANTEE_ASK = /\b(?:guarantee[ds]?|promise|definitely|for sure|100 ?%|certain(?:ly)?)\b/i;

const PREFIX_RULES: PrefixRule[] = [
  {
    intent: "greeting",
    test: /^(?:hi|hey|hello|yo|good (?:morning|afternoon|evening))\b/i,
    openers: [
      "Hi there.",
      "Hello.",
      "Hi, thanks for calling.",
    ],
  },
  {
    intent: "thanks",
    test: /\b(?:thank you|thanks|cheers|appreciate it|much appreciated)\b/i,
    openers: [
      "You're welcome.",
      "No problem at all.",
      "Of course.",
    ],
  },
  {
    intent: "farewell",
    test: /\b(?:bye|goodbye|see you|take care|that'?s all|nothing else|i'?m done)\b/i,
    openers: [
      "Thanks for calling.",
      "Take care.",
    ],
  },
  {
    intent: "acknowledge",
    test: /^(?:yes|yeah|yep|yup|no|nope|ok|okay|sure|right|alright|got it|i see|mm|mhm)\b/i,
    openers: [
      "Okay.",
      "Got it.",
      "Sure.",
      "Mm-hmm.",
      "Understood.",
    ],
  },
  {
    intent: "presence",
    test: /\b(?:are you (?:there|still there|listening)|can you (?:hear|understand) me|hello\?|you there)\b|\bi(?:'?m| am) (?:talking|speaking) to you\b/i,
    openers: [
      "Yes, I'm here.",
      "I can hear you.",
    ],
  },
  {
    intent: "breakdown",
    test: /\b(?:not (?:working|cooling|heating|turning on)|stopped working|broken|broke down|won'?t (?:turn on|start|work|cool|heat)|no (?:heat|cooling|air)|blowing (?:warm|cold|hot))\b/i,
    openers: [
      "Sorry to hear that.",
      "Okay, sorry you're dealing with that.",
      "Ah, that's no fun.",
      "Okay, let's get that sorted.",
      "Oh no, let's sort that out.",
    ],
  },
  {
    intent: "emergency",
    test: /\b(?:emergency|urgent|right away|as soon as possible|asap|freezing|no heat at all|flooding|burst)\b/i,
    openers: [
      "Okay, that's one we prioritise.",
      "Understood, let's treat that as urgent.",
      "Okay, we'll move quickly on that.",
      "Got it, that needs sorting today.",
    ],
  },
  {
    intent: "noise_or_smell",
    test: /\b(?:noise|noisy|sound|banging|rattling|grinding|squealing|humming|buzzing|vibrat\w*)\b|\b(?:smell|smells|smelling|burning|odour|odor)\b/i,
    openers: [
      "Okay, that's worth looking at properly.",
      "Hmm, let's get a technician on that.",
      "Good that you called about it.",
      "Okay, that's worth checking out.",
    ],
  },
  {
    intent: "leak",
    test: /\b(?:leak|leaking|dripping|water (?:coming|pooling)|puddle)\b/i,
    openers: [
      "Okay, a leak we want to catch early.",
      "Got it, let's get that looked at.",
      "Good call ringing about that.",
      "Okay, let's not leave that one.",
    ],
  },
  {
    intent: "booking",
    // Not the bare word "available": "what AC options do you have available"
    // is a product question, and this opener made it sound like scheduling.
    test: /\b(?:can (?:someone|you) come|come out|book|schedule|appointment|availability|when can you|what times?|any slots?|free (?:on|tomorrow|today))\b/i,
    openers: [
      "Sure, let me check what we have.",
      "Of course, let me look at the diary.",
    ],
  },
  {
    intent: "quote",
    test: /\b(?:quote|estimate|how much (?:would|will|does)|what would it cost|ballpark)\b/i,
    openers: [
      "Happy to help with that.",
      "Sure, let me explain how that works.",
    ],
  },
  {
    intent: "advice",
    test: /\b(?:what|which) (?:brand|make|model|system|unit|size|type)\b|\b(?:recommend|suggest|advise|best) (?:brand|make|system|unit|option|one)\b|\bwhat (?:would you|do you) (?:recommend|suggest)\b/i,
    openers: [
      "Good question.",
      "Happy to talk that through.",
    ],
  },
  {
    intent: "replacement",
    test: /\b(?:replace|replacing|new (?:system|unit|ac|furnace|boiler)|upgrade|install(?:ation)?|how old)\b/i,
    openers: [
      "Sure, let's look at that.",
      "Okay, happy to go through that.",
    ],
  },
  {
    intent: "maintenance",
    test: /\b(?:service|servicing|maintenance|tune[- ]?up|check[- ]?up|annual|filter|clean)\b/i,
    openers: [
      "Of course.",
      "Sure, we can sort that.",
    ],
  },
  {
    intent: "existing_job",
    test: /\b(?:you (?:came|were) (?:out|here)|last (?:time|week|month|year)|previous(?:ly)?|already (?:booked|had)|follow(?:ing)? up|my appointment)\b/i,
    openers: [
      "Let me pull that up.",
      "Okay, let me check on that.",
    ],
  },
  {
    intent: "efficiency",
    test: /\b(?:bill|bills|energy|efficien\w*|running cost|electricity|expensive to run|using (?:a lot|more))\b/i,
    openers: [
      "That's worth looking at.",
      "Okay, let's work out what's going on.",
    ],
  },
  {
    intent: "thermostat",
    test: /\b(?:thermostat|temperature (?:setting|control)|smart (?:thermostat|control)|nest|ecobee)\b/i,
    openers: [
      "Sure.",
      "Okay, let's check that.",
    ],
  },
  {
    intent: "area_check",
    test: /\b(?:do you (?:cover|service|come (?:to|out to))|are you in|service area|how far|based in|located)\b/i,
    openers: [
      "Let me check that for you.",
      "Sure, let me see.",
    ],
  },
  {
    // A yes/no question may have "no" for an answer, and the opener is spoken
    // before the model decides: "Of course. We can't guarantee an offer."
    // So it commits to nothing.
    intent: "yes_no_question",
    test: /^(?:can|could|do|does|is|are|would|should|will|have|has)\b/i,
    openers: [
      "Good question.",
      "Let me check.",
      "Okay, so.",
    ],
  },
  {
    intent: "general_question",
    test: /^(?:how|what|when|where|why|who|which)\b/i,
    openers: [
      "Sure.",
      "Let me help with that.",
      "Good question.",
    ],
  },
];

/* ── Resolution ─────────────────────────────────────────────────────────── */

/** Openers that only make sense once a conversation. */
const ONCE_ONLY = new Set(["greeting", "presence"]);

export async function resolveFastPath(
  tenantId: string,
  text: string,
  seed = Math.random(),
  opts: { alreadySpoken?: boolean; recent?: string[] } = {},
): Promise<FastPath> {
  const t = text.trim();
  if (t.length === 0) return { kind: "none" };

  // A full answer only fires when the question is ALL the caller asked. A
  // compound message ("it's broken, and what's the call-out?") needs the model.
  const sentences = t.split(/[.!?]+/).map((x) => x.trim()).filter(Boolean);
  if (sentences.length === 1 && t.split(/\s+/).length <= 16) {
    for (const rule of FAQ_RULES) {
      if (!rule.test.test(t)) continue;
      if (rule.unless?.test(t)) continue;
      const keys = Array.isArray(rule.fact) ? rule.fact : [rule.fact];
      const values: string[] = [];
      for (const k of keys) {
        const [category, key] = k.split("/");
        const fact = await db.query.knowledgeFacts.findFirst({
          where: and(
            eq(knowledgeFacts.tenantId, tenantId),
            eq(knowledgeFacts.category, category),
            eq(knowledgeFacts.key, key),
          ),
        });
        if (!fact) break;
        values.push(fact.value);
      }
      // Any fact missing means no canned answer — never invent one.
      if (values.length === keys.length) {
        return { kind: "full", text: rule.say(...values), factKey: keys.join("+") };
      }
    }
  }

  // "Can you guarantee I'll get PR?" The honest answer is no, so the opener
  // must not sound like yes, whatever intent the rest of the sentence has.
  if (GUARANTEE_ASK.test(t)) {
    return { kind: "prefix", text: "Let me be straight with you.", intent: "guarantee" };
  }

  for (const rule of PREFIX_RULES) {
    // Greeting someone who is already mid-conversation is the clearest
    // possible signal that nothing is being remembered.
    if (opts.alreadySpoken && ONCE_ONLY.has(rule.intent)) continue;
    if (rule.test.test(t)) {
      /**
       * Never reuse an opener this conversation has already heard. Hearing
       * the same three words at the start of every reply is what makes a
       * line sound canned even when the rest of the answer is fresh.
       */
      const said = (opts.recent ?? []).map((r) => r.toLowerCase());
      const fresh = rule.openers.filter(
        (o) => !said.some((r) => r.startsWith(o.toLowerCase().replace(/[.!?]$/, ""))),
      );
      const pool = fresh.length > 0 ? fresh : rule.openers;
      const opener = pool[Math.floor(seed * pool.length) % pool.length];
      return { kind: "prefix", text: opener, intent: rule.intent };
    }
  }

  return { kind: "none" };
}

/* ── Cleanup ────────────────────────────────────────────────────────────── */

/** Generic openers that are redundant once a prefix has already been spoken. */
const REDUNDANT_OPENER =
  /^(?:(?:well|so|okay|ok|alright|right|sure|yes|yeah|absolutely|of course|certainly|no problem|got it|understood|i see|i understand)[,.!]?\s+)+/i;

const REDUNDANT_PHRASE =
  /^(?:i can (?:certainly |definitely )?help (?:you )?with that|i'?d be happy to help(?: with that)?|happy to help(?: with that)?|let me help (?:you )?with that|sorry to hear that|sorry about that|that(?:'s| is) (?:no good|frustrating|rough))[,.!]?\s*/i;

/**
 * A greeting the model adds after the opener already greeted them.
 * "Hi there. Hi there. I'm Alex..." is the exact failure this removes.
 */
const REDUNDANT_GREETING =
  /^(?:hi(?: there)?|hello(?: there)?|hey(?: there)?|good (?:morning|afternoon|evening))[,.!]?\s*/i;

/**
 * Tidy the model's continuation after a prefix was already spoken aloud.
 *
 * A 3B model follows "do not repeat the acknowledgement" only sometimes, and
 * "Right, let's get that sorted. I can help with that." lands as two openers
 * in a row. Stripping them deterministically is more reliable than asking
 * again, and costs nothing.
 *
 * Also removes stray wrapping quotes, which small models emit surprisingly
 * often and which a text-to-speech voice reads as a pause or a literal
 * "quote".
 */
export function cleanContinuation(text: string, hadPrefix: boolean): string {
  let out = text.trim();

  // Unbalanced or wrapping quotes around the whole reply.
  out = out.replace(/^["'“”']+/, "").replace(/["'“”']+$/, "");

  if (hadPrefix) {
    const before = out;
    out = out.replace(REDUNDANT_GREETING, "");
    out = out.replace(REDUNDANT_PHRASE, "");
    out = out.replace(REDUNDANT_OPENER, "");
    // Only re-capitalise if something was actually removed.
    if (out !== before && out.length > 0) out = out[0].toUpperCase() + out.slice(1);
  }

  return out.trim();
}
