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
const NAME_EXPLICIT = /\b(?:my name is|my name's|name is|name's|call me)\s+([A-Za-z][A-Za-z'-]*)(?:\s+([A-Za-z][A-Za-z'-]*))?/i;
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
]);

const titleCase = (w: string) => w[0].toUpperCase() + w.slice(1).toLowerCase();

export function extractName(text: string): string | null {
  const m = text.match(NAME_EXPLICIT) ?? text.match(NAME_IMPLICIT);
  if (!m || NOT_A_NAME.has(m[1].toLowerCase())) return null;
  const parts = [m[1]];
  if (m[2] && !NOT_A_NAME.has(m[2].toLowerCase())) parts.push(m[2]);
  return parts.map(titleCase).join(" ");
}
