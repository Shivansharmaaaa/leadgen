import type { TenantSettings } from "@/server/db/schema";

/**
 * The layer that keeps the agent from costing the client money or a lawsuit.
 * Two gates: one on what comes in (should a human take this?) and one on what
 * goes out (is this safe to say?).
 */

/**
 * Matched as whole words. As substrings, "sue" escalated every message
 * containing "issue" — "I have an issue with my AC" went silent and paused
 * the AI — and "hurt" fired on "it hurts my ears, the noise".
 *
 * Bare "emergency" is deliberately absent: "do you do emergency repairs?" is
 * a sales question, and an urgent job is one to triage and book first, not to
 * hand off (see the emergency_urgency eval). Hazards to life are listed
 * explicitly and answered with SAFETY_REPLY.
 */
const DEFAULT_ESCALATION_TRIGGERS = [
  "lawyer", "attorney", "solicitor", "sue", "suing", "lawsuit", "legal action",
  "refund", "chargeback", "dispute", "cancel my contract",
  "injury", "injured", "hurt", "bleeding",
  "discrimination", "harassment", "complaint to", "ombudsman",
  "manager", "supervisor",
];

/** Danger to life. Escalated, and the person is told what to do first. */
const SAFETY_TRIGGERS = [
  "gas leak", "leaking gas", "smell gas", "smells of gas", "smells like gas", "smelling gas", "gas smell",
  "carbon monoxide", "co alarm", "co detector", "co monitor", "smoke coming", "on fire", "sparking", "sparks",
];

/** "Property manager" is a job title, not a demand for one. */
const ROLE_BEFORE_MANAGER = /\b(?:property|building|site|project|office|account|store|branch|facilities|facility|estate|general|operations|case|my)\s+(?:manager|supervisor)\b/i;

function containsPhrase(text: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`\\b${escaped}\\b`, "i").test(text);
}

/**
 * What a person who smells gas or hears a CO alarm must hear first: the
 * standard utility instruction. Not left to the model, and never replaced
 * by "someone will call you back".
 */
export function safetyReply(businessName: string): string {
  return "If you can smell gas or a carbon monoxide alarm is going off, please leave the house now " +
    "with everyone in it, don't switch anything on or off, and once you're outside call 911 or " +
    `your gas company. I'm alerting the ${businessName} team now and someone will call you straight back.`;
}

/** Sent whenever Gate 1 hands a conversation over, so nobody is left in silence. */
export function handoffReply(businessName: string): string {
  return `Thanks for telling me. I'm passing this to a member of the ${businessName} team, ` +
    "who'll get back to you shortly.";
}

/**
 * Asking FOR a person is a handoff. Asking WHETHER this is a person is a
 * disclosure question the agent must answer itself (CA SB 1001, EU AI Act).
 * A bare "real person" substring escalated "am I talking to a real person?"
 * while "I want to talk to a human" slipped through.
 */
const HUMAN_REQUEST_RE = new RegExp(
  String.raw`\b(?:speak|talk|chat)\s+(?:to|with)\s+(?:a\s+|an\s+|the\s+|some\s+)?(?:real\s+|actual\s+|live\s+)?` +
  String.raw`(?:human|person|someone|somebody|agent|representative|rep|operator)\b` +
  String.raw`|\b(?:get|give|put)\s+me\s+(?:through\s+to\s+)?(?:a\s+|an\s+)?(?:real\s+|actual\s+|live\s+)?` +
  String.raw`(?:human|person|representative|operator)\b`,
  "i",
);

/**
 * "How much does it cost to talk to someone?" asks the price of a
 * consultation; it is a buying question, not a demand for a human. On an
 * immigration line it was handed to staff, and the caller lost the booking.
 */
const PRICE_OF_RE = /\b(?:cost|costs|charge|charges|fee|price|pay)\s+(?:me\s+|us\s+)?(?:anything\s+)?(?:to|for)\s+$/;

const ANGER_MARKERS = [
  "unacceptable", "ridiculous", "furious", "appalling", "disgusted",
  "worst", "scam", "fraud", "never again", "terrible service",
];

export type InboundVerdict = {
  escalate: boolean;
  /** Danger to life: reply with safetyReply() and alert the on-call team. */
  safety?: boolean;
  /** Asked whether this is a person or a bot: answer with disclosureReply(). */
  disclose?: boolean;
  reason?: string;
  /** Matched phrase, for the audit log and the inbox banner. */
  trigger?: string;
};

/**
 * "Am I talking to a real person?" is a legal question, not a conversational
 * one: CA SB 1001 and the EU AI Act require a truthful answer. Fine-tuned for
 * bookings, the 3B voice model answered "Yes, you are talking to a real
 * person." Like identity extraction, this is not left to the model.
 */
const BEING = String.raw`(?:a\s+|an\s+)?(?:real\s+|actual\s+|live\s+)?(?:person|human|bot|robot|ai|a\.i\.|machine|computer|recording)\b`;
const DISCLOSURE_QUESTION_RE = new RegExp(
  String.raw`\b(?:are|r)\s+(?:you|u)\s+` + BEING +
  String.raw`|\b(?:am\s+i|i'?m|i\s+am)\s+(?:talking|speaking|chatting)\s+(?:to|with)\s+` + BEING +
  String.raw`|\bis\s+(?:this|that|it)\s+` + BEING,
  "i",
);

export function disclosureReply(businessName: string): string {
  return `I'm an AI assistant for ${businessName}. I can keep helping you, or have someone ` +
    `from the team call you back, whichever you'd prefer.`;
}

/** Gate 1 — decide whether the AI should answer this at all. */
export function screenInbound(body: string, settings: TenantSettings): InboundVerdict {
  const text = body.toLowerCase();

  for (const t of SAFETY_TRIGGERS) {
    if (containsPhrase(text, t)) return { escalate: true, safety: true, reason: "safety", trigger: t };
  }

  const triggers = [
    ...DEFAULT_ESCALATION_TRIGGERS,
    ...(settings.escalationTriggers ?? []).map((t) => t.toLowerCase()),
  ];
  const withoutTitles = text.replace(ROLE_BEFORE_MANAGER, " ");
  for (const t of triggers) {
    if (containsPhrase(withoutTitles, t)) {
      return { escalate: true, reason: "escalation_trigger", trigger: t };
    }
  }

  const asked = text.match(HUMAN_REQUEST_RE);
  if (asked && !PRICE_OF_RE.test(text.slice(0, asked.index))) {
    return { escalate: true, reason: "escalation_trigger", trigger: asked[0] };
  }

  // After escalation on purpose: "is this a bot? get me a human" is a handoff.
  const asking = text.match(DISCLOSURE_QUESTION_RE);
  if (asking) {
    return { escalate: false, disclose: true, reason: "ai_disclosure", trigger: asking[0] };
  }

  const angerHits = ANGER_MARKERS.filter((m) => text.includes(m));
  if (angerHits.length >= 2) {
    return { escalate: true, reason: "sentiment", trigger: angerHits.join(", ") };
  }

  return { escalate: false };
}

export type OutboundVerdict = {
  allow: boolean;
  /** Set when the reply must be queued for a human instead of sent. */
  holdReason?: string;
  violations: string[];
};

// Must carry an actual currency marker. An earlier version allowed a bare
// word boundary, which matched clock times ("2:30 PM") and held valid replies.
const MONEY_RE =
  /[$£€]\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)|\b(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)\s?(?:dollars|pounds|quid|usd|cad|gbp)\b/gi;
const CURRENCY_SYMBOL_RE = /[$£€]\s?\d|\d\s?(?:dollars|pounds|quid|usd|cad|gbp)\b/i;

/**
 * Gate 2 — validate a draft reply before it leaves the building.
 *
 * Price guard: any figure the agent states must sit inside the tenant's
 * configured range. Quoting $50 for a job that starts at $300 is the single
 * most expensive thing an AI receptionist can do.
 */
/**
 * Two clock times offered as a choice: "Thursday at 9 or Friday at 2pm".
 * Deliberately narrow — "we're open 8am to 5pm" is a fact, not a slot offer.
 */
const CLOCK = String.raw`(?:\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)|\bat\s+\d{1,2}(?::\d{2})?\b)`;
const SLOT_CHOICE_RE = new RegExp(`${CLOCK}[^.?!]{0,40}\\bor\\b[^.?!]{0,40}${CLOCK}`, "i");

/**
 * Unqualified guarantees. The agent has no standing to promise these.
 * Exported (and written into the fine-tuning prompt kit) so no training
 * target can teach the model a phrase this gate will always hold.
 */
export const PROMISE_PATTERNS: RegExp[] = [
  /\b(?:i|we)\s+guarantee\b/i,
  /\bdefinitely\b/i,
  /\bcertainly can\b/i,
  /\b100%\s+(?:sure|certain|guaranteed)\b/i,
  /\bno charge\b/i,
  /\bfree of charge\b/i,
  /\bi promise\b/i,
  /\bwill absolutely\b/i,
  /\bguaranteed to\b/i,
  // Committing to a visit without a booked slot is the expensive version of this.
  /\b(?:we|someone)\s+(?:can|will)\s+(?:come|be)\s+(?:out\s+)?(?:tomorrow|today|this\s+\w+day)\b/i,
];

/**
 * "Definitely" and "certainly" add certainty, not meaning: "We can
 * definitely help" says nothing "We can help" doesn't. Gate 2 holds a reply
 * for them, which on a text kept a new lead waiting on a person over one
 * word. They are dropped instead (a sentence that opens with one becomes
 * "Sure."), as the voice path already does before speaking. Real guarantees
 * ("I guarantee", "no charge", "we'll be out tomorrow") are untouched, and
 * Gate 2 still holds those.
 */
export function softenIntensifiers(text: string): string {
  return text
    .replace(/(^|[.!?]\s+)(?:definitely|certainly|absolutely)\b\s*([,!.])?\s*/gi,
      (_m, lead: string, p: string | undefined) => `${lead}${p === "," ? "Sure, " : "Sure. "}`)
    .replace(/\s*\b(?:definitely|certainly)\b,?/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function screenOutbound(
  body: string,
  settings: TenantSettings,
  /** False when check_availability has not run anywhere in the conversation. */
  opts: { availabilityChecked?: boolean } = {},
): OutboundVerdict {
  const violations: string[] = [];

  if (CURRENCY_SYMBOL_RE.test(body)) {
    const floor = settings.priceFloor;
    const ceiling = settings.priceCeiling;
    if (floor != null || ceiling != null) {
      for (const match of body.matchAll(MONEY_RE)) {
        const raw = match[1] ?? match[2];
        if (!raw) continue;
        const value = Number(raw.replace(/,/g, ""));
        if (!Number.isFinite(value) || value === 0) continue;
        if (floor != null && value < floor) {
          violations.push(`quoted ${match[0].trim()} below price floor ${floor}`);
        }
        if (ceiling != null && value > ceiling) {
          violations.push(`quoted ${match[0].trim()} above price ceiling ${ceiling}`);
        }
      }
    }
  }

  for (const re of PROMISE_PATTERNS) {
    if (re.test(body)) violations.push(`unauthorised promise: ${re.source}`);
  }

  // Times the calendar never returned: a customer turns up to nobody.
  if (opts.availabilityChecked === false && SLOT_CHOICE_RE.test(body)) {
    violations.push("offered appointment times without checking availability");
  }

  // A tool call the model typed into its reply instead of making it. Sent as
  // text it is gibberish to the customer — and on a call it is read aloud.
  // Also catches a leaked tool schema ({"type":"function",...}), which the
  // untuned model once pasted into a reply.
  if (/\{\s*"(?:name|function)"\s*:|\{\s*"type"\s*:\s*"function"/.test(body)) {
    violations.push("reply contains a raw tool call");
  }

  if (violations.length > 0) {
    return { allow: false, holdReason: violations.join("; "), violations };
  }
  return { allow: true, violations: [] };
}

/**
 * Consent + do-not-contact gate for anything the business initiates.
 * Replies inside an active conversation are service messages and are exempt;
 * this guards follow-ups, reactivation and campaigns.
 */
export function canInitiateOutbound(
  channel: string,
  contact: { doNotContact: boolean; smsConsent: boolean; emailConsent: boolean },
): { ok: boolean; reason?: string } {
  if (contact.doNotContact) return { ok: false, reason: "contact is on do-not-contact" };

  if ((channel === "sms" || channel === "whatsapp") && !contact.smsConsent) {
    return { ok: false, reason: "no written SMS consent on file (TCPA/CASL)" };
  }
  if (channel === "email" && !contact.emailConsent) {
    return { ok: false, reason: "no email consent on file (CASL/PECR)" };
  }
  if (channel === "voice") {
    return { ok: false, reason: "outbound AI voice requires prior express written consent (TCPA)" };
  }
  return { ok: true };
}

/** Jurisdictions where the caller must be told the line is recorded. */
export function recordingDisclosureRequired(country: string, region?: string | null): boolean {
  const twoParty = ["CA", "FL", "IL", "MD", "MA", "MT", "NV", "NH", "PA", "WA", "CT", "DE", "MI", "OR"];
  if (country === "GB" || country === "CA") return true;
  if (country === "US" && region && twoParty.includes(region.toUpperCase())) return true;
  return false;
}
