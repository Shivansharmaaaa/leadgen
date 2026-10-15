import { db, tenants, locations, staff, knowledgeFacts, knowledgeDocs } from "@/server/db";
import { eq } from "drizzle-orm";

/** A realistic US home-services tenant — the wedge vertical. */
async function main() {
  const slug = "northside-hvac";

  await db.delete(tenants).where(eq(tenants.slug, slug));

  const [tenant] = await db.insert(tenants).values({
    name: "Northside Heating & Air",
    slug,
    country: "US",
    timezone: "America/New_York",
    vertical: "home_services",
    plan: "voice",
    settings: {
      businessName: "Northside Heating & Air",
      agentName: "Alex",
      tone: "warm",
      priceFloor: 89,
      priceCeiling: 15000,
      currency: "USD",
      autoSendThreshold: 0.75,
      recordCalls: true,
      escalationTriggers: ["insurance claim", "warranty dispute"],
    },
  }).returning();

  const [location] = await db.insert(locations).values({
    tenantId: tenant.id,
    name: "Northside Main",
    addressLine1: "1480 Dorchester Ave",
    city: "Boston",
    region: "MA",
    postalCode: "02122",
    country: "US",
    phone: "+16175550142",
    timezone: "America/New_York",
    hours: [
      { day: 1, open: "08:00", close: "17:00" },
      { day: 2, open: "08:00", close: "17:00" },
      { day: 3, open: "08:00", close: "17:00" },
      { day: 4, open: "08:00", close: "17:00" },
      { day: 5, open: "08:00", close: "17:00" },
      { day: 6, open: "09:00", close: "14:00" },
    ],
    serviceArea: ["Boston", "Quincy", "Milton", "Dorchester", "Braintree", "Somerville"],
  }).returning();

  await db.insert(staff).values({
    tenantId: tenant.id,
    email: "owner@northsidehvac.example",
    name: "Dana Whitfield",
    role: "owner",
  });

  await db.insert(knowledgeFacts).values([
    { tenantId: tenant.id, category: "pricing", key: "Diagnostic visit", value: "$89, waived if you proceed with the repair" },
    { tenantId: tenant.id, category: "pricing", key: "Emergency after-hours callout", value: "$249 flat, plus parts and labour" },
    { tenantId: tenant.id, category: "pricing", key: "Annual maintenance plan", value: "$219/year, covers two tune-ups" },
    { tenantId: tenant.id, category: "pricing", key: "Full AC system replacement", value: "typically $6,500 to $12,500 depending on tonnage — quoted on site only" },
    { tenantId: tenant.id, category: "services", key: "Offered", value: "AC repair, AC installation, furnace repair, furnace installation, heat pump service, ductwork, annual maintenance, indoor air quality" },
    { tenantId: tenant.id, category: "services", key: "Not offered", value: "plumbing, electrical panel work, roofing, appliance repair" },
    { tenantId: tenant.id, category: "policy", key: "Emergency response", value: "Same-day emergency slots held daily; no-heat calls in winter are prioritised" },
    { tenantId: tenant.id, category: "policy", key: "Warranty", value: "1 year on labour, manufacturer warranty on parts" },
    { tenantId: tenant.id, category: "policy", key: "Payment", value: "Card, check, ACH. Financing available on replacements over $3,000." },
    { tenantId: tenant.id, category: "policy", key: "Cancellation", value: "Free if cancelled more than 2 hours before the appointment" },
  ]);

  await db.insert(knowledgeDocs).values([
    {
      tenantId: tenant.id,
      title: "About Northside Heating & Air",
      content:
        "Northside Heating & Air has served the Boston south shore since 2004. Family owned, " +
        "14 licensed technicians, average 11 years experience. We are a Carrier Factory " +
        "Authorized Dealer and also service Trane, Lennox, Rheem and Mitsubishi systems. " +
        "All technicians are EPA 608 certified and background checked. We are fully licensed " +
        "and insured in Massachusetts.",
      tokenEstimate: 80,
    },
    {
      tenantId: tenant.id,
      title: "Common questions",
      content:
        "How soon can someone come out? Most non-emergency calls are seen within 48 hours; " +
        "emergencies usually same day. Do you charge to come out? Yes, $89 diagnostic, waived " +
        "if you proceed with the repair. Do you work weekends? Saturdays 9am-2pm; Sundays are " +
        "emergency only. How long does a replacement take? Usually one full day. Do you offer " +
        "financing? Yes, on replacements over $3,000, subject to approval.",
      tokenEstimate: 95,
    },
  ]);

  console.log(`✓ Seeded tenant ${tenant.name}`);
  console.log(`  tenant id   ${tenant.id}`);
  console.log(`  location id ${location.id}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
