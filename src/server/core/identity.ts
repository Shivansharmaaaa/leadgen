import { and, eq, or, isNotNull } from "drizzle-orm";
import { db, contacts, contactIdentities, tenants } from "@/server/db";
import type { Channel, ChannelIdentity } from "./types";
import { normalizePhone, normalizeEmail } from "./phone";
import { isSuppressed } from "./suppression";

type Contact = typeof contacts.$inferSelect;

/** Channels whose externalId *is* a phone number. */
const PHONE_CHANNELS: Channel[] = ["sms", "voice", "whatsapp"];

/**
 * Collapse a platform id into its canonical form so the same human always
 * produces the same key.
 */
export function normalizeExternalId(channel: Channel, externalId: string, country = "US"): string {
  if (PHONE_CHANNELS.includes(channel)) {
    return normalizePhone(externalId, country) ?? externalId.trim();
  }
  if (channel === "email") return normalizeEmail(externalId) ?? externalId.trim().toLowerCase();
  return externalId.trim();
}

/**
 * The contact graph. Given however a person showed up, return the single
 * contact row that represents them — creating or merging as needed.
 *
 * This is what makes "she DM'd on Instagram Tuesday, then called Thursday"
 * render as one timeline instead of two strangers.
 */
export async function resolveContact(
  tenantId: string,
  identity: ChannelIdentity,
): Promise<Contact> {
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  const country = tenant?.country ?? "US";

  const externalId = normalizeExternalId(identity.channel, identity.externalId, country);

  // Identifiers this event carries, from the id itself and from any extras.
  const phone =
    normalizePhone(identity.phone ?? "", country) ??
    (PHONE_CHANNELS.includes(identity.channel) ? normalizePhone(externalId, country) : null);
  const email =
    normalizeEmail(identity.email) ??
    (identity.channel === "email" ? normalizeEmail(externalId) : null);

  return db.transaction(async (tx) => {
    // 1. Exact identity hit — the common path.
    const existing = await tx.query.contactIdentities.findFirst({
      where: and(
        eq(contactIdentities.tenantId, tenantId),
        eq(contactIdentities.channel, identity.channel),
        eq(contactIdentities.externalId, externalId),
      ),
    });

    if (existing) {
      const contact = await tx.query.contacts.findFirst({
        where: eq(contacts.id, existing.contactId),
      });
      if (contact) return backfill(tx, contact, { phone, email, name: identity.name });
    }

    // 2. No identity row yet. Try to attach to a contact we already know by a
    //    strong identifier — this is the cross-channel merge.
    let contact: Contact | undefined;
    if (phone || email) {
      const clauses = [];
      if (phone) clauses.push(eq(contacts.primaryPhone, phone));
      if (email) clauses.push(eq(contacts.primaryEmail, email));
      contact = await tx.query.contacts.findFirst({
        where: and(eq(contacts.tenantId, tenantId), or(...clauses)),
      });
    }

    // 3. Genuinely new human.
    if (!contact) {
      const [created] = await tx
        .insert(contacts)
        .values({
          tenantId,
          displayName: identity.name ?? identity.handle ?? null,
          primaryPhone: phone,
          primaryEmail: email,
          // Someone who had themselves erased comes back as do-not-contact:
          // they can still be answered, but the business never starts it.
          doNotContact: await isSuppressed(tenantId, [phone, email]),
        })
        .returning();
      contact = created;
    } else {
      contact = await backfill(tx, contact, { phone, email, name: identity.name });
    }

    // 4. Record how we reached them this time.
    await tx
      .insert(contactIdentities)
      .values({
        tenantId,
        contactId: contact.id,
        channel: identity.channel,
        externalId,
        handle: identity.handle ?? null,
      })
      .onConflictDoNothing();

    // 5. A phone or email learned here becomes its own identity, so the next
    //    call or email from it lands on this same contact.
    await linkDerivedIdentities(tx, tenantId, contact.id, { phone, email });

    return contact;
  });
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Fill in identifiers we did not previously have. Never overwrites a known value. */
async function backfill(
  tx: Tx,
  contact: Contact,
  incoming: { phone: string | null; email: string | null; name?: string | null },
): Promise<Contact> {
  const patch: Partial<Contact> = {};
  if (!contact.primaryPhone && incoming.phone) patch.primaryPhone = incoming.phone;
  if (!contact.primaryEmail && incoming.email) patch.primaryEmail = incoming.email;
  if (!contact.displayName && incoming.name) patch.displayName = incoming.name;

  if (Object.keys(patch).length === 0) return contact;

  const [updated] = await tx
    .update(contacts)
    .set(patch)
    .where(eq(contacts.id, contact.id))
    .returning();

  await linkDerivedIdentities(tx, contact.tenantId, contact.id, {
    phone: patch.primaryPhone ?? null,
    email: patch.primaryEmail ?? null,
  });

  return updated;
}

async function linkDerivedIdentities(
  tx: Tx,
  tenantId: string,
  contactId: string,
  ids: { phone: string | null; email: string | null },
) {
  const rows: (typeof contactIdentities.$inferInsert)[] = [];
  if (ids.phone) {
    for (const channel of PHONE_CHANNELS) {
      rows.push({ tenantId, contactId, channel, externalId: ids.phone });
    }
  }
  if (ids.email) {
    rows.push({ tenantId, contactId, channel: "email", externalId: ids.email });
  }
  if (rows.length) await tx.insert(contactIdentities).values(rows).onConflictDoNothing();
}

/**
 * Attach an identifier the agent collected mid-conversation ("what's your
 * number?"). Returns false when it already belonged to a *different* contact,
 * which the caller should surface rather than silently merge.
 */
export async function linkIdentifierToContact(
  tenantId: string,
  contactId: string,
  kind: "phone" | "email",
  rawValue: string,
  country = "US",
): Promise<{ ok: boolean; reason?: string }> {
  const value =
    kind === "phone" ? normalizePhone(rawValue, country) : normalizeEmail(rawValue);
  if (!value) return { ok: false, reason: `"${rawValue}" is not a valid ${kind}` };

  const clash = await db.query.contacts.findFirst({
    where: and(
      eq(contacts.tenantId, tenantId),
      kind === "phone" ? eq(contacts.primaryPhone, value) : eq(contacts.primaryEmail, value),
    ),
  });
  if (clash && clash.id !== contactId) {
    return { ok: false, reason: `that ${kind} already belongs to another contact` };
  }

  await db.transaction(async (tx) => {
    await tx
      .update(contacts)
      .set(kind === "phone" ? { primaryPhone: value } : { primaryEmail: value })
      .where(eq(contacts.id, contactId));
    await linkDerivedIdentities(tx, tenantId, contactId, {
      phone: kind === "phone" ? value : null,
      email: kind === "email" ? value : null,
    });
  });

  return { ok: true };
}

/** Every channel we can reach this contact on — powers the unified timeline. */
export async function identitiesForContact(contactId: string) {
  return db.query.contactIdentities.findMany({
    where: eq(contactIdentities.contactId, contactId),
  });
}
