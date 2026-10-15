import { asc, eq } from "drizzle-orm";
import {
  db, leads, contacts, conversations, messages, appointments,
  leadFeatures, tenants, locations,
} from "@/server/db";

/**
 * Turn a lead into a de-identified feature vector.
 *
 * Everything here is a bounded number or a low-cardinality category. No name,
 * phone, email, address or message text is stored. That is precisely what
 * makes it lawful to pool these rows across tenants — there is nothing in a
 * row that can be traced back to a person.
 */
export async function extractFeaturesForLead(leadId: string): Promise<void> {
  const lead = await db.query.leads.findFirst({ where: eq(leads.id, leadId) });
  if (!lead) return;

  const [tenant, contact] = await Promise.all([
    db.query.tenants.findFirst({ where: eq(tenants.id, lead.tenantId) }),
    db.query.contacts.findFirst({ where: eq(contacts.id, lead.contactId) }),
  ]);
  if (!tenant || !contact) return;

  const convo = lead.conversationId
    ? await db.query.conversations.findFirst({ where: eq(conversations.id, lead.conversationId) })
    : undefined;

  const msgs = convo
    ? await db.query.messages.findMany({
        where: eq(messages.conversationId, convo.id),
        orderBy: asc(messages.createdAt),
      })
    : [];

  const inbound = msgs.filter((m) => m.direction === "inbound");
  const firstInbound = inbound[0];
  const firstOutbound = msgs.find((m) => m.direction === "outbound");

  const responseLatencySec =
    firstInbound && firstOutbound
      ? Math.max(0, Math.round((firstOutbound.createdAt.getTime() - firstInbound.createdAt.getTime()) / 1000))
      : null;

  const createdLocal = lead.createdAt;
  const hourOfDay = createdLocal.getUTCHours();
  const dayOfWeek = createdLocal.getUTCDay();

  const location = await db.query.locations.findFirst({ where: eq(locations.tenantId, tenant.id) });
  const businessHours = location?.hours ?? [];
  const todaysWindow = businessHours.find((h) => h.day === dayOfWeek);
  const afterHours = !todaysWindow
    || hourOfDay < Number(todaysWindow.open.slice(0, 2))
    || hourOfDay >= Number(todaysWindow.close.slice(0, 2));

  const priorAppointments = await db.query.appointments.findMany({
    where: eq(appointments.contactId, lead.contactId),
  });

  const askedPrice = inbound.some((m) =>
    /\b(price|cost|quote|how much|charge|fee|estimate)\b/i.test(m.body));

  // Coarse geography only — never a full postcode or address.
  const geoBucket = location?.postalCode?.slice(0, 3) ?? null;

  const row = {
    tenantId: tenant.id,
    leadId: lead.id,
    vertical: tenant.vertical,
    country: tenant.country,
    sourceChannel: lead.sourceChannel,
    hourOfDay,
    dayOfWeek,
    afterHours,
    responseLatencySec,
    inboundMessageCount: inbound.length,
    serviceCategory: normalizeService(lead.service),
    urgency: lead.urgency,
    gavePhone: Boolean(contact.primaryPhone),
    gaveEmail: Boolean(contact.primaryEmail),
    askedPrice,
    isReturningCustomer: priorAppointments.length > 0,
    geoBucket,
  };

  await db.insert(leadFeatures).values(row)
    .onConflictDoUpdate({ target: leadFeatures.leadId, set: row });
}

/** Label a lead once the outcome is known. This is what the model learns from. */
export async function labelLead(leadId: string, converted: boolean, value?: number) {
  await db.update(leadFeatures)
    .set({
      converted,
      conversionValue: value != null ? String(value) : null,
      labeledAt: new Date(),
    })
    .where(eq(leadFeatures.leadId, leadId));
}

/** Collapse free-text services into a small, stable category set. */
export function normalizeService(service: string | null): string | null {
  if (!service) return null;
  const s = service.toLowerCase();
  if (/\b(ac|air con|cooling|a\/c)\b/.test(s)) return "cooling";
  if (/\b(furnace|heat|boiler|heating)\b/.test(s)) return "heating";
  if (/\b(duct|ventilation|air quality)\b/.test(s)) return "air_quality";
  if (/\b(install|replace|new system)\b/.test(s)) return "install";
  if (/\b(maintenance|tune|service plan|inspection)\b/.test(s)) return "maintenance";
  if (/\b(repair|fix|broken|not working)\b/.test(s)) return "repair";
  return "other";
}

/* ────────────────────────────────────────────────────────────────────────────
 * Encoding: feature row -> numeric vector the model can train on.
 * ──────────────────────────────────────────────────────────────────────────── */

export type FeatureRow = typeof leadFeatures.$inferSelect;

const CHANNELS = ["webchat", "email", "sms", "voice", "instagram", "messenger", "whatsapp"];
const URGENCIES = ["emergency", "this_week", "this_month", "researching"];
const SERVICES = ["cooling", "heating", "air_quality", "install", "maintenance", "repair", "other"];

export function encode(row: FeatureRow): Record<string, number> {
  const f: Record<string, number> = {};

  for (const c of CHANNELS) f[`ch_${c}`] = row.sourceChannel === c ? 1 : 0;
  for (const u of URGENCIES) f[`urg_${u}`] = row.urgency === u ? 1 : 0;
  for (const s of SERVICES) f[`svc_${s}`] = row.serviceCategory === s ? 1 : 0;

  f.after_hours = row.afterHours ? 1 : 0;
  f.gave_phone = row.gavePhone ? 1 : 0;
  f.gave_email = row.gaveEmail ? 1 : 0;
  f.asked_price = row.askedPrice ? 1 : 0;
  f.returning = row.isReturningCustomer ? 1 : 0;

  // Cyclical time-of-day so 23:00 and 00:00 are near each other.
  f.hour_sin = Math.sin((2 * Math.PI * row.hourOfDay) / 24);
  f.hour_cos = Math.cos((2 * Math.PI * row.hourOfDay) / 24);
  f.is_weekend = row.dayOfWeek === 0 || row.dayOfWeek === 6 ? 1 : 0;

  // Seasonality. The feature experiment on real campaign data found month
  // effects among the strongest signals (month_may -0.55, month_mar +0.43),
  // and for a trade whose demand is weather-driven it should matter more, not
  // less: a July AC call and a January AC call are different businesses.
  const month = row.createdAt ? row.createdAt.getUTCMonth() : 0;
  f.month_sin = Math.sin((2 * Math.PI * month) / 12);
  f.month_cos = Math.cos((2 * Math.PI * month) / 12);
  f.is_peak_cooling = month >= 5 && month <= 8 ? 1 : 0;   // Jun-Sep
  f.is_peak_heating = month === 11 || month <= 2 ? 1 : 0; // Dec-Mar
  f.is_shoulder_season = month === 3 || month === 4 || month === 9 || month === 10 ? 1 : 0;

  // Speed-to-lead. Log-scaled: the difference between 30s and 2min matters far
  // more than between 2h and 4h.
  const lat = row.responseLatencySec;
  f.log_latency = lat == null ? 0 : Math.log1p(Math.min(lat, 86400)) / Math.log(86401);
  f.latency_under_60s = lat != null && lat < 60 ? 1 : 0;

  f.msg_count = Math.min(row.inboundMessageCount, 20) / 20;

  return f;
}

export const FEATURE_KEYS = (() => {
  const dummy = {
    sourceChannel: "webchat", urgency: null, serviceCategory: null,
    afterHours: false, gavePhone: false, gaveEmail: false, askedPrice: false,
    isReturningCustomer: false, hourOfDay: 0, dayOfWeek: 1,
    responseLatencySec: null, inboundMessageCount: 0,
  } as unknown as FeatureRow;
  return Object.keys(encode(dummy)).sort();
})();
