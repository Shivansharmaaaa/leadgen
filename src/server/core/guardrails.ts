import type { TenantSettings } from "@/server/db/schema";

/**
 * The layer that keeps the agent from costing the client money or a lawsuit.
 * Two gates: one on what comes in (should a human take this?) and one on what
 * goes out (is this safe to say?).
 */

const DEFAULT_ESCALATION_TRIGGERS = [
  "lawyer", "attorney", "solicitor", "sue", "lawsuit", "legal action",
  "refund", "chargeback", "dispute", "cancel my contract",
  "injury", "injured", "hurt", "bleeding", "emergency", "gas leak", "carbon monoxide",
  "discrimination", "harassment", "complaint to", "ombudsman",
  "speak to a human", "talk to a person", "real person", "manager", "supervisor",
];

const ANGER_MARKERS = [
  "unacceptable", "ridiculous", "furious", "appalling", "disgusted",
  "worst", "scam", "fraud", "never again", "terrible service",
];

export type InboundVerdict = {
  escalate: boolean;
  reason?: string;
  /** Matched phrase, for the audit log and the inbox banner. */
  trigger?: string;
};

/** Gate 1 — decide whether the AI should answer this at all. */
export function screenInbound(body: string, settings: TenantSettings): InboundVerdict {
  const text = body.toLowerCase();
  const triggers = [
    ...DEFAULT_ESCALATION_TRIGGERS,
    ...(settings.escalationTriggers ?? []).map((t) => t.toLowerCase()),
  ];

  for (const t of triggers) {
    if (text.includes(t)) {
      return { escalate: true, reason: "escalation_trigger", trigger: t };
    }
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
export function screenOutbound(body: string, settings: TenantSettings): OutboundVerdict {
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

  // Unqualified guarantees. The agent has no standing to promise these.
  const promises = [
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
  for (const re of promises) {
    if (re.test(body)) violations.push(`unauthorised promise: ${re.source}`);
  }

  // A tool call the model typed into its reply instead of making it. Sent as
  // text it is gibberish to the customer — and on a call it is read aloud.
  if (/\{\s*"(?:name|function)"\s*:/.test(body)) {
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
