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
