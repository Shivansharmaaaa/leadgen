/**
 * Opting out, decided by rule, never by the model.
 *
 * Under the FCC's 2024 revocation rule a person can withdraw consent "by any
 * reasonable means", and the standard keywords (STOP, QUIT, END, REVOKE, OPT
 * OUT, CANCEL, UNSUBSCRIBE) must be honoured on their own. CASL and PECR
 * require the same of any unsubscribe request. Two ways to get this wrong
 * cost money or the client: letting an agent chat back at "STOP", and
 * treating "my AC won't stop rattling" as an opt-out.
 *
 * So a bare keyword counts, and so does a short message that plainly asks to
 * stop being contacted. A longer message that merely contains the word does
 * not.
 */

export type ConsentKeyword = { kind: "opt_out" | "opt_in"; keyword: string };

const OPT_OUT_WORDS = new Set([
  "stop", "stopall", "stop all", "unsubscribe", "cancel", "end", "quit", "revoke", "optout", "opt out",
]);
const OPT_IN_WORDS = new Set(["start", "unstop"]);

const OPT_OUT_PHRASE = new RegExp(
  "\\b(?:" + [
    "stop (?:texting|messaging|contacting|calling|emailing|sending)(?: me| us)?",
    "(?:don'?t|do not|never) (?:text|message|contact|call|email) (?:me|us)(?: again| anymore)?",
    "unsubscribe(?: me)?",
    "remove me(?: from (?:your|the|this) (?:list|texts?|messages?))?",
    "take me off(?: (?:your|the|this) list)?",
    "opt me out",
    "i (?:want to |would like to )?opt out",
    "no more (?:texts|messages|calls)",
  ].join("|") + ")\\b",
  "i",
);

/** The longest message still read as a request to stop rather than a story. */
const MAX_PHRASE_LENGTH = 80;

/**
 * "Don't call me, text me instead" is a channel preference, not a revocation:
 * unsubscribing that person from texts would do the opposite of what they asked.
 * Those go to the agent, which can record the preference.
 */
const PREFERENCE = /\b(?:instead|rather|prefer|only)\b/i;

/**
 * On a call, a bare "stop" or "end" means stop talking or end the call, and
 * "cancel" is usually the appointment: only an explicit request ("don't call
 * me again", "take me off your list") counts there, and START means nothing.
 */
export function detectConsentKeyword(body: string, channel?: string): ConsentKeyword | null {
  const bare = body.trim().toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
  if (channel !== "voice") {
    if (OPT_OUT_WORDS.has(bare)) return { kind: "opt_out", keyword: bare };
    if (OPT_IN_WORDS.has(bare)) return { kind: "opt_in", keyword: bare };
  }

  if (body.trim().length <= MAX_PHRASE_LENGTH) {
    const m = body.match(OPT_OUT_PHRASE);
    if (m && !PREFERENCE.test(body)) return { kind: "opt_out", keyword: m[0].toLowerCase() };
  }
  return null;
}

export function optOutConfirmation(businessName: string, channel?: string): string {
  if (channel === "voice") {
    return `Understood. I've taken you off our list, and ${businessName} won't contact you again. Take care.`;
  }
  return `You're unsubscribed from ${businessName} messages and won't hear from us again. ` +
    `Reply START to resubscribe.`;
}

export function optInConfirmation(businessName: string): string {
  return `You're resubscribed to messages from ${businessName}. Reply STOP at any time to opt out.`;
}
