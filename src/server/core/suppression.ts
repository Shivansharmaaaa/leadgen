import { createHmac } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db, suppressions } from "@/server/db";

/**
 * The suppression list: keyed hashes of the phones and emails of people who
 * asked to be erased. See features/erasure.ts for why it exists.
 */

/**
 * Set SUPPRESSION_SECRET once and never change it: every existing entry is
 * keyed by it, and a new key would silently stop them matching, letting
 * erased people be contacted again. Deliberately not derived from
 * ADMIN_PASSWORD, which is meant to rotate.
 */
function suppressionKey(): string {
  return process.env.SUPPRESSION_SECRET ?? "leadgen-suppression";
}

/** Keyed, so the list cannot be reversed by hashing every phone number. */
export function identifierHash(tenantId: string, identifier: string): string {
  return createHmac("sha256", suppressionKey()).update(`${tenantId}:${identifier}`).digest("hex");
}

export async function isSuppressed(tenantId: string, identifiers: (string | null | undefined)[]): Promise<boolean> {
  const hashes = identifiers.filter((i): i is string => Boolean(i)).map((i) => identifierHash(tenantId, i));
  if (!hashes.length) return false;
  const hit = await db.query.suppressions.findFirst({
    where: and(eq(suppressions.tenantId, tenantId), inArray(suppressions.identifierHash, hashes)),
  });
  return Boolean(hit);
}
