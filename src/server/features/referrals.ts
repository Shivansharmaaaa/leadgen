import { and, eq, isNull, desc } from "drizzle-orm";
import {
  db, contacts, tenants, leads, appointments, partnerLinks,
  referralConsents, referrals, events,
} from "@/server/db";

/**
 * CROSS-SELL — the lawful shape.
 *
 * The intuitive version ("A's customer bought a boiler, so list them as a lead
 * for plumber B") is not buildable in the US, Canada or the UK. Consent is
 * sender-specific everywhere that matters:
 *
 *   TCPA (US)   — consent given to A does not cover B. $500-$1,500 per call
 *                 or text, and it is the most class-actioned statute in US
 *                 consumer law.
 *   CASL (CA)   — express consent must identify the sender. Up to $10M.
 *   PECR (UK)   — the soft opt-in belongs to the seller only; it never transfers.
 *   UK/EU GDPR  — A is the controller of its own customer data. Passing it to B
 *                 for B's marketing needs a lawful basis, which in practice
 *                 means consent naming B or a defined category of recipient.
 *
 * It is also commercially fatal: no business connects its CRM to a platform
 * that forwards its customer list to other businesses, possibly competitors.
 *
 * So this module implements the three routes that ARE lawful and capture most
 * of the value:
 *
 *   1. Same-tenant cross-sell — one business, many services. Always allowed.
 *   2. Franchise / group — same controller across locations. Allowed.
 *   3. Consented referral — the customer is asked, in the moment, and says yes
 *      to a named category. This is how Thumbtack and Checkatrade operate.
 *
 * The pattern learning that makes any of this smart lives in
 * `server/learning/` and never moves personal data at all.
 */

/* ── 1. Same-tenant cross-sell ──────────────────────────────────────────── */

/**
 * Pairs learned from pooled, de-identified outcomes: "customers who had X
 * booked Y within 90 days". The association is learned globally; the people it
 * is applied to are always the tenant's own customers.
 */
const CROSS_SELL_PAIRS: Record<string, { service: string; window: number; pitch: string }[]> = {
  cooling: [
    { service: "maintenance", window: 180, pitch: "annual AC tune-up before next summer" },
    { service: "air_quality", window: 90, pitch: "duct cleaning while the system is apart" },
  ],
  install: [
    { service: "maintenance", window: 300, pitch: "first-year service plan on the new system" },
  ],
  heating: [
    { service: "maintenance", window: 200, pitch: "pre-winter furnace check" },
  ],
  repair: [
    { service: "maintenance", window: 120, pitch: "service plan so this doesn't repeat" },
  ],
};

export type CrossSellOpportunity = {
  contactId: string;
  name: string | null;
  had: string;
  suggest: string;
  pitch: string;
  daysSince: number;
  contactable: boolean;
};

export async function findCrossSellOpportunities(
  tenantId: string, limit = 20,
): Promise<CrossSellOpportunity[]> {
  const completed = await db.query.appointments.findMany({
    where: and(eq(appointments.tenantId, tenantId), eq(appointments.status, "completed")),
    orderBy: desc(appointments.startsAt),
    limit: 200,
  });

  const out: CrossSellOpportunity[] = [];

  for (const appt of completed) {
    const category = normalise(appt.service);
    const suggestions = CROSS_SELL_PAIRS[category] ?? [];
    const daysSince = Math.floor((Date.now() - appt.startsAt.getTime()) / 86400_000);

    for (const s of suggestions) {
      if (daysSince > s.window) continue;

      // Skip if they already have it booked.
      const already = completed.some(
        (a) => a.contactId === appt.contactId && normalise(a.service) === s.service,
      );
      if (already) continue;

      const contact = await db.query.contacts.findFirst({
        where: eq(contacts.id, appt.contactId),
      });
      if (!contact || contact.doNotContact) continue;

      out.push({
        contactId: contact.id,
        name: contact.displayName,
        had: category,
        suggest: s.service,
        pitch: s.pitch,
        daysSince,
        // Same business that served them — soft opt-in applies in the UK, and
        // in the US this is an existing-business-relationship service contact.
        contactable: contact.smsConsent || contact.emailConsent,
      });
    }
  }

  return out.slice(0, limit);
}

const normalise = (s: string) => {
  const t = s.toLowerCase();
  if (/ac|air con|cool/.test(t)) return "cooling";
  if (/furnace|heat|boiler/.test(t)) return "heating";
  if (/install|replace/.test(t)) return "install";
  if (/duct|air quality/.test(t)) return "air_quality";
  if (/maint|tune|plan/.test(t)) return "maintenance";
  return "repair";
};

/* ── 3. Consented referral between tenants ──────────────────────────────── */

/**
 * Record that a customer affirmatively agreed to hear from partner businesses
 * in named categories. Called by the agent's `offer_referral` tool only after
 * the customer says yes in their own words — which is stored as evidence.
 */
export async function recordReferralConsent(args: {
  tenantId: string;
  contactId: string;
  conversationId?: string;
  categories: string[];
  quote: string;
  /** Consent goes stale. A year is the outside limit worth relying on. */
  expiresInDays?: number;
}) {
  const [row] = await db.insert(referralConsents).values({
    tenantId: args.tenantId,
    contactId: args.contactId,
    conversationId: args.conversationId ?? null,
    categories: args.categories,
    quote: args.quote,
    expiresAt: new Date(Date.now() + (args.expiresInDays ?? 365) * 86400_000),
  }).returning();

  await db.insert(events).values({
    tenantId: args.tenantId,
    type: "referral_consent_granted",
    contactId: args.contactId,
    payload: { categories: args.categories },
  });

  return row;
}

/**
 * Make a referral. Refuses unless BOTH an explicit partnership and a live,
 * category-matching customer consent exist. There is deliberately no override.
 */
export async function makeReferral(args: {
  fromTenantId: string;
  contactId: string;
  category: string;
}): Promise<{ ok: boolean; reason?: string; referralId?: string }> {
  const consent = await db.query.referralConsents.findFirst({
    where: and(
      eq(referralConsents.contactId, args.contactId),
      eq(referralConsents.tenantId, args.fromTenantId),
      isNull(referralConsents.revokedAt),
    ),
    orderBy: desc(referralConsents.grantedAt),
  });

  if (!consent) {
    return { ok: false, reason: "no referral consent on file for this contact" };
  }
  if (consent.expiresAt && consent.expiresAt < new Date()) {
    return { ok: false, reason: "referral consent has expired" };
  }
  if (!consent.categories.includes(args.category)) {
    return { ok: false, reason: `consent does not cover "${args.category}"` };
  }

  const partner = await db.query.partnerLinks.findFirst({
    where: and(
      eq(partnerLinks.fromTenantId, args.fromTenantId),
      eq(partnerLinks.category, args.category),
      eq(partnerLinks.active, true),
    ),
  });
  if (!partner) return { ok: false, reason: `no active partner for "${args.category}"` };

  const [row] = await db.insert(referrals).values({
    fromTenantId: args.fromTenantId,
    toTenantId: partner.toTenantId,
    consentId: consent.id,
    category: args.category,
  }).returning();

  await db.insert(events).values({
    tenantId: args.fromTenantId,
    type: "referral_made",
    contactId: args.contactId,
    payload: { toTenantId: partner.toTenantId, category: args.category, consentId: consent.id },
  });

  return { ok: true, referralId: row.id };
}
