import { normalizePhone, normalizeEmail } from "./phone";

/**
 * Deterministic identifier extraction from message text.
 *
 * Identity resolution must NOT depend on the model remembering to call
 * save_contact_detail — the smoke test proved it will sometimes just reply
 * with an emoji instead. A regex finds a phone number every time, for free,
 * in microseconds. The model's tool stays available for the cases where the
 * customer spells a number out in words.
 */

// Deliberately strict: must look like a real number, not "84 degrees" or "$12,500".
const PHONE_CANDIDATE =
  /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b|(?:\+44|0)\s?7\d{3}[\s.-]?\d{6}\b/g;

const EMAIL_CANDIDATE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

export type ExtractedIdentifiers = { phones: string[]; emails: string[] };

export function extractIdentifiers(text: string, country = "US"): ExtractedIdentifiers {
  const phones = new Set<string>();
  const emails = new Set<string>();

  // Strip currency amounts first so "$12,500" can never parse as a phone number.
  const cleaned = text.replace(/[$£€]\s?[\d,]+(?:\.\d{2})?/g, " ");

  for (const m of cleaned.matchAll(PHONE_CANDIDATE)) {
    const normalized = normalizePhone(m[0], country);
    if (normalized) phones.add(normalized);
  }
  for (const m of text.matchAll(EMAIL_CANDIDATE)) {
    const normalized = normalizeEmail(m[0]);
    if (normalized) emails.add(normalized);
  }

  return { phones: [...phones], emails: [...emails] };
}

/**
 * A name the caller states outright. Booking needs a name on file, and on a
 * call the details are saved after the turn, so the turn where the caller
 * says "my name is Sam Carter" could not book and the model said "booked"
 * anyway. Strict on purpose: lowercase only after an explicit "my name is" or
 * "call me"; after "I'm", "it's" or "this is" the name must be capitalised, so
 * "I'm calling about my AC" never produces a customer called "Calling".
 */
const NAME_EXPLICIT = /\b(?:my name is|my name's|name is|name's|call me|(?:it'?ll|it will) be under|put it under|under the name(?: of)?|name will be)\s+([A-Za-z][A-Za-z'-]*)(?:\s+([A-Za-z][A-Za-z'-]*))?/i;
/** A name spelled out letter by letter after it is said: "Harpreet, h a r p r e e t". */
const SPELLED_RUN = /,?\s*\b[A-Za-z](?:[\s-]+[A-Za-z]\b){1,}[.,]?(?=\s|$)/g;
const NAME_IMPLICIT = /\b(?:[Tt]his is|[Ii]t's|[Ii]t is|I'm|I am)\s+([A-Z][a-z'-]+)(?:\s+([A-Z][a-z'-]+))?/;
const NOT_A_NAME = new Set([
  "and", "a", "an", "the", "just", "not", "no", "so", "very", "really", "still", "also", "here", "there",
  "calling", "looking", "trying", "wondering", "having", "getting", "going", "speaking", "interested",
  "fine", "good", "great", "okay", "ok", "sure", "sorry", "home", "available", "urgent", "about", "from",
  "with", "at", "in", "on", "for", "my", "your", "our", "it", "is", "and", "but", "or", "please",
  // "It's Tuesday at 10", "it is Saturday I want": a time, not a person.
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "today", "tomorrow", "tonight",
  "morning", "afternoon", "evening", "january", "february", "march", "april", "june", "july", "august",
  "september", "october", "november", "december", "noon", "midday",
  // "I'm Canadian, on a work permit": on an immigration or admissions line a
  // nationality is the most common thing after "I'm", and the route never
  // replaces a name once one is saved.
  "american", "canadian", "british", "english", "scottish", "welsh", "irish", "indian", "pakistani",
  "bangladeshi", "nepali", "nepalese", "chinese", "filipino", "filipina", "vietnamese", "korean", "japanese",
  "nigerian", "ghanaian", "kenyan", "jamaican", "mexican", "brazilian", "colombian", "iranian", "iraqi",
  "syrian", "afghan", "ukrainian", "russian", "polish", "romanian", "turkish", "egyptian", "moroccan",
  "french", "german", "italian", "spanish", "portuguese", "australian", "punjabi", "tamil", "gujarati",
  "international", "domestic", "overseas", "local", "new", "single", "married", "divorced", "retired",
  "pregnant", "unemployed", "self-employed", "permanent", "express", "currently", "already", "still",
  "you", "we", "they", "he", "she", "can", "be", "if",
  // What ends "Tuesday at 9, please. Thanks." — a sign-off, never a person.
  "thanks", "thank", "perfect", "works", "that", "this", "cheers", "lovely", "brilliant", "awesome",
  "excellent", "wonderful", "fantastic", "cool", "bye", "goodbye", "hello", "hi", "hey", "ugh", "hmm",
  "wow", "right", "alright", "done", "deal", "absolutely", "definitely", "exactly", "correct",
]);

/** A pick from offered times: a day, a time, an ordinal. "What times do you have?" is not one. */
export const TIME_PICK = /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|tonight|noon)\b|\b\d{1,2}:\d{2}\b|\b\d{1,2}\s*(?:am|pm|a\.m\.|p\.m\.|o'?clock)\b|\bat\s+(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:am|pm|o'?clock|thirty)\b|\b(?:first|second|earlier|later|other)\s+one\b|\beither\b/i;
/** Seven or more digits: a phone number said with the name. */
const PHONE_RUN = /\d(?:[\s().-]*\d){6,}/;

const titleCase = (w: string) => w[0].toUpperCase() + w.slice(1).toLowerCase();

/** The agent's last line asked for a name: "Can I get your name?", "What name should I put it under?" */
const NAME_QUESTION = /\bname\b[^?]*\?/i;
/** Answers to a name question that are not names: a time, a choice, a yes. */
const NOT_A_BARE_NAME = /\d|\b(?:yes|yeah|yep|no|nope|sure|okay|ok|first|second|other|one|earlier|later|am|pm|o'?clock|thirty|fifteen|half|quarter|noon|nine|ten|eleven|twelve|two|three|four|five|six|seven|eight)\b/i;

/**
 * A name the caller states outright, or, when the agent has just asked for
 * one, given on its own: "Grace Fontaine." The bare form is only trusted
 * after a name question, and only as one to three plain words: "Saturday at
 * nine", "the first one" and "yes" answer a different question. A spelled-out
 * surname after it ("Tori, t o r i") is dropped.
 */
export function extractName(raw: string, opts: { lastAgentLine?: string | null } = {}): string | null {
  // "It's Harpreet, h a r p r e e t Sandhu, s a n d h u." → "It's Harpreet Sandhu."
  const text = raw.replace(SPELLED_RUN, "").replace(/\s{2,}/g, " ");
  const asked = Boolean(opts.lastAgentLine && NAME_QUESTION.test(opts.lastAgentLine));
  // "My first name is Billy, my last name is Beane": "name is Billy" alone loses the surname.
  const split = firstAndLast(text, asked);
  if (split) return split;
  const m = text.match(NAME_EXPLICIT) ?? text.match(NAME_IMPLICIT);
  if (m && !NOT_A_NAME.has(m[1].toLowerCase())) {
    const parts = [m[1]];
    if (m[2] && !NOT_A_NAME.has(m[2].toLowerCase())) parts.push(m[2]);
    return parts.map(titleCase).join(" ");
  }
  if (asked) {
    const bare = bareName(text);
    if (bare) return bare;
  }
  if (asked || TIME_PICK.test(text) || PHONE_RUN.test(text)) return nameSentence(text, asked);
  return null;
}

/**
 * A name on a sentence of its own inside a longer turn: "Tuesday at 9,
 * please. Carlos Mendes." Callers say the pick and the name in one breath,
 * and without this the name was lost and booking was never offered. Asked
 * for a name, one to three words will do. Unasked, only a full name (two or
 * three capitalised words): a lone word volunteered unasked ("Ugh.") would
 * be saved, and the route never replaces a saved name.
 */
function nameSentence(text: string, asked: boolean): string | null {
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (TIME_PICK.test(sentence)) continue;
    const name = bareName(sentence);
    if (!name) continue;
    if (asked) return name;
    const words = name.split(" ");
    if (words.length >= 2 && words.every((w) => new RegExp(`\\b${w}\\b`).test(sentence))) return name;
  }
  return null;
}

/** "First name Will", and "my last name is McCormick" after a first name. */
const FIRST_NAME = /\bfirst name(?:'s| is)?\s+([A-Za-z][A-Za-z'-]*)/i;
const LAST_NAME = /\b(?:last|sur) ?name(?:'s| is)?\s+([A-Za-z][A-Za-z'-]*)/i;
/** What callers say before a name when asked for one. */
const LEAD_IN = /^(?:(?:oh|um|uh|so|yeah|yes|yep|sure|okay|ok|of course|certainly|right|alright|it'?s|its|it is|that'?s|that is|this is|the name is|name is|name)\b[\s,.!]*)+/i;

/** "…and my last name is Real": the surname stated apart from the first name. */
function firstAndLast(text: string, asked: boolean): string | null {
  const last = text.match(LAST_NAME)?.[1];
  const first = text.match(FIRST_NAME)?.[1];
  if (last && !NOT_A_NAME.has(last.toLowerCase())) {
    const before = text.slice(0, text.search(LAST_NAME));
    const m = before.match(NAME_EXPLICIT) ?? before.match(NAME_IMPLICIT);
    const given = first ?? m?.[1] ?? (asked ? bareName(before)?.split(" ")[0] : undefined);
    if (given && !NOT_A_NAME.has(given.toLowerCase())) return `${titleCase(given)} ${titleCase(last)}`;
  }
  if (first && !NOT_A_NAME.has(first.toLowerCase())) return titleCase(first);
  return null;
}

/** Said after the name and before the number: "John Smith. It's 689…", "Tori Childs. Yes, 215…". */
const TRAIL_OUT = /[\s,.!?]*\b(?:it'?s|its|it is|and|yeah|yes|that'?s|(?:my\s+)?(?:last|first|sur) ?name(?:'s| is)?)[\s,.!?]*$/i;

/** The answer to "can I get your name?": a name on its own, perhaps with their number after it. */
function bareName(text: string): string | null {
  const cut = text
    // A number after the name: extractIdentifiers takes that part.
    .replace(/\d[\s\S]*$/, "")
    .replace(/\b(?:and\s+)?(?:my\s+|the\s+)?(?:phone\s+|cell\s+|mobile\s+)?(?:number|no\.?)(?:\s+is)?[\s,.]*$/i, "")
    .replace(LEAD_IN, "")
    .replace(/[\s,.!?]+$/, "");
  let trimmed = cut;
  for (let prev = ""; prev !== trimmed;) { prev = trimmed; trimmed = trimmed.replace(TRAIL_OUT, ""); }
  if (!trimmed || NOT_A_BARE_NAME.test(trimmed)) return null;
  // Initials go; a name said twice ("Larry Larry Phillips", "Chester Parrot Chester Parrot") counts once.
  let words = trimmed.split(/[\s,.]+/).filter((w) => w.length > 1);
  words = words.filter((w, i) => i === 0 || w.toLowerCase() !== words[i - 1].toLowerCase());
  const half = words.length / 2;
  if (words.length % 2 === 0 && words.slice(0, half).join(" ").toLowerCase() === words.slice(half).join(" ").toLowerCase()) {
    words = words.slice(0, half);
  }
  if (words.length === 0 || words.length > 3) return null;
  if (!words.every((w) => /^[A-Za-z][A-Za-z'-]*$/.test(w))) return null;
  if (words.some((w) => NOT_A_NAME.has(w.toLowerCase()))) return null;
  return words.map(titleCase).join(" ");
}
