/**
 * Phone normalisation to E.164. Identity resolution depends on this being
 * stable: "(415) 555-0100", "415-555-0100" and "+14155550100" must collapse to
 * one key or the same caller shows up as three contacts.
 *
 * Covers the three target markets (US, CA, GB). Anything else is accepted only
 * if it already arrives in E.164 form.
 */
const DEFAULT_CC: Record<string, string> = { US: "1", CA: "1", GB: "44" };

export function normalizePhone(raw: string, country = "US"): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();

  // Already E.164.
  if (/^\+[1-9]\d{7,14}$/.test(trimmed)) return trimmed;

  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;

  const cc = DEFAULT_CC[country.toUpperCase()] ?? "1";

  if (cc === "1") {
    // NANP: 10 digits, or 11 beginning with 1.
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    return null;
  }

  if (cc === "44") {
    // UK national form drops a leading trunk 0: 07700 900123 -> +447700900123.
    let n = digits;
    if (n.startsWith("44")) n = n.slice(2);
    if (n.startsWith("0")) n = n.slice(1);
    if (n.length < 9 || n.length > 10) return null;
    return `+44${n}`;
  }

  return null;
}

/** Display form for the inbox. Falls back to the E.164 string. */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return "";
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  if (m) return `(${m[1]}) ${m[2]}-${m[3]}`;
  return e164;
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const e = raw.trim().toLowerCase();
  return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(e) ? e : null;
}
