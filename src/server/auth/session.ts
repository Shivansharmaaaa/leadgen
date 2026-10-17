/**
 * Owner sign-in: one password per deployment, a signed session cookie.
 *
 * The dashboard and inbox show every customer's name, number and messages,
 * and the inbox API sends texts as the business and releases drafts the
 * guardrails held. None of it had any authentication. This is the minimum
 * that makes a deployment safe to put on the internet: ADMIN_PASSWORD in the
 * environment, a 12-hour httpOnly cookie signed with a key derived from it
 * (changing the password signs everyone out), checked by middleware.
 *
 * Web Crypto only, so the same code runs in the Edge middleware and in Node.
 * Per-user accounts and tenant mapping come later; this closes the hole now.
 */

export const SESSION_COOKIE = "lg_session";
export const SESSION_TTL_SECONDS = 12 * 3600;

const enc = new TextEncoder();

async function key(password: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest("SHA-256", enc.encode(`leadgen-session:${password}`));
  return crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[0-9a-f]+$/.test(hex) || hex.length % 2) return null;
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export async function createSession(password: string, now = Date.now()): Promise<string> {
  const expires = Math.floor(now / 1000) + SESSION_TTL_SECONDS;
  const sig = await crypto.subtle.sign("HMAC", await key(password), enc.encode(String(expires)));
  return `${expires}.${toHex(sig)}`;
}

export async function verifySession(token: string | undefined, password: string, now = Date.now()): Promise<boolean> {
  if (!token) return false;
  const [expires, sigHex] = token.split(".");
  const sig = sigHex ? fromHex(sigHex) : null;
  if (!sig || !/^\d+$/.test(expires) || Number(expires) < now / 1000) return false;
  // crypto.subtle.verify compares in constant time.
  return crypto.subtle.verify("HMAC", await key(password), sig, enc.encode(expires));
}

/** Constant-time password comparison, via HMAC of both sides. */
export async function passwordMatches(given: string, expected: string): Promise<boolean> {
  const k = await key("compare");
  const [a, b] = await Promise.all([
    crypto.subtle.sign("HMAC", k, enc.encode(given)),
    crypto.subtle.sign("HMAC", k, enc.encode(expected)),
  ]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/**
 * Pages and APIs only the business may see. Public surfaces are listed in
 * middleware. The browser voice demo is here too: it runs the model and the
 * speech server for whoever opens it, and writes to the database.
 */
export function isProtected(pathname: string): boolean {
  return /^\/(?:dashboard|inbox|settings|voice)(?:\/|$)/.test(pathname) ||
    /^\/api\/(?:inbox|voice)(?:\/|$)/.test(pathname);
}

/** Where to go after signing in: a path on this site only, never "//evil.com". */
export function safeNext(next: string | null | undefined): string {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/dashboard";
}
