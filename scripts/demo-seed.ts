import { eq } from "drizzle-orm";
import { db, tenants, locations, staff, knowledgeFacts, jobs, leads, contacts, appointments } from "@/server/db";
import { handleInbound } from "@/server/core/ingest";
import { intakeLead } from "@/server/features/lead-intake";
import { sendMissedCallTextBack } from "@/server/features/missed-call";
import { chatTurn } from "@/server/features/webchat";
import { executeTool } from "@/server/agent/tools";
import { ScriptedProvider } from "@/server/agent/providers";

/**
 * A demo business with a realistic day of activity, built through the real
 * pipelines, so every feature has something to show:
 *
 *   npm run demo:seed
 *   TENANT_SLUG=demo-hvac npm run dev     # then /dashboard, /inbox, /settings
 *
 * Nothing is sent: the model is scripted, Twilio and SMTP are switched off
 * for this process, every number is a fictional 555-01xx one, and the demo
 * tenant's pending jobs are deleted at the end so a worker can never text
 * them. Re-running replaces the demo tenant.
 */
process.env.LLM_PROVIDER = "scripted";
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.SMTP_HOST;

const SLUG = "demo-hvac";
const TZ = "America/New_York";
const BIZ = "Harbor Heating & Cooling";
const CONSENT = `By checking this box, I agree that ${BIZ} may contact me by text message, including automated texts, ` +
  "at the number I provided. Consent is not a condition of purchase. Message and data rates may apply. Reply STOP to opt out.";
const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

async function main() {
  await db.delete(tenants).where(eq(tenants.slug, SLUG));
  const [tenant] = await db.insert(tenants).values({
    name: BIZ, slug: SLUG, country: "US", timezone: TZ, vertical: "home_services",
    settings: {
      businessName: BIZ, agentName: "Jordan", currency: "USD", priceFloor: 95, priceCeiling: 15000,
      escalationTriggers: ["insurance claim"], intakeKey: "lk_demo_only_not_secret",
      webchatOrigins: ["https://www.harborheating.example"],
      sourceSpend: { angi: 900, google_lsa: 600, thumbtack: 250 },
      asrContext: "this is a heating and cooling business: 'an answer' or 'a sea' is almost certainly 'an AC'",
    },
  }).returning();
  const weekdays = [1, 2, 3, 4, 5].map((day) => ({ day, open: "08:00", close: "17:00" }));
  const [location] = await db.insert(locations).values({
    tenantId: tenant.id, name: "Harbor Main", city: "Boston", region: "MA", country: "US", timezone: TZ,
    hours: [...weekdays, { day: 6, open: "09:00", close: "13:00" }],
  }).returning();
  await db.insert(staff).values([
    { tenantId: tenant.id, email: "owner@harborheating.example", name: "Maria Lopez", role: "owner", phone: "+16175550190" },
    { tenantId: tenant.id, email: "tech@harborheating.example", name: "Dev Patel", role: "tech", phone: "+16175550191", onCall: true },
  ]);
  await db.insert(knowledgeFacts).values([
    { tenantId: tenant.id, category: "pricing", key: "Diagnostic visit", value: "$95, waived if you go ahead with the repair" },
    { tenantId: tenant.id, category: "warranty", key: "Labour warranty", value: "1 year on all repairs" },
  ]);

  const say = async (n: number, from: string, body: string, reply?: string) => {
    if (reply) ScriptedProvider.enqueue(reply);
    return handleInbound({ tenantId: tenant.id, channel: "sms", externalId: `demo-sms-${n}`, externalThreadId: null,
      from: { channel: "sms", externalId: from }, body });
  };

  // Form leads: one that can be texted, one whose form wording is incomplete, one email-only.
  ScriptedProvider.enqueue("Sorry it's not cooling. Is it blowing warm air, or not running at all?");
  await intakeLead(tenant.id, { source: "website", externalId: "web-1001", name: "Priya Patel", phone: "6175550101",
    service: "AC repair", message: "AC is blowing warm air", submittedAt: ago(5), consent: { sms: true, language: CONSENT } });
  ScriptedProvider.enqueue("Happy to quote that. How old is the current furnace?");
  await intakeLead(tenant.id, { source: "angi", externalId: "angi-2001", name: "Marcus Kim", phone: "6175550102",
    service: "Furnace replacement", submittedAt: ago(4), consent: { sms: true, language: "I agree to be contacted about my request." } });
  ScriptedProvider.enqueue("Thanks. Is the heat pump for the whole house or a single room?");
  await intakeLead(tenant.id, { source: "thumbtack", externalId: "tt-3001", name: "Nora Silva", email: "nora@example.com",
    service: "Heat pump quote", message: "3-bed colonial", submittedAt: ago(3) });

  // A missed call, a website chat, a handover nobody answered, a gas smell, a STOP.
  await sendMissedCallTextBack({ tenantId: tenant.id, fromNumber: "+16175550103", providerCallId: "CA-demo-1" });
  await chatTurn({ tenantId: tenant.id, sessionId: "demoSessionAAAAAAAAAAAAAAAA", text: "Do you service Mitsubishi mini-splits?" });
  await say(1, "+16175550104", "I want a refund for the visit last week, the noise is back");
  await say(2, "+16175550105", "There's a strong gas smell near the furnace");
  await say(3, "+16175550106", "Can someone come out tomorrow? My AC is dripping water", "Sorry about the leak. Is it dripping from the indoor unit?");
  await say(4, "+16175550107", "STOP");

  // A booking (with reminders), and yesterday's job waiting to be closed.
  const booked = await say(5, "+16175550108", "Yes please, Tuesday at 10 works", "Great — I'll get that booked.");
  const [booker] = await db.query.contacts.findMany({ where: eq(contacts.id, booked.contactId) });
  await db.update(contacts).set({ displayName: "Leah Brooks", primaryPhone: "+16175550108" }).where(eq(contacts.id, booker.id));
  const nextTue = new Date(Date.now() + 4 * 86400_000);
  nextTue.setUTCHours(14, 0, 0, 0);
  await executeTool({ tenant, contactId: booker.id, conversationId: booked.conversationId, location }, "book_appointment",
    { service: "AC tune-up", starts_at: nextTue.toISOString() });
  const [past] = await db.insert(contacts).values({ tenantId: tenant.id, displayName: "Owen Murphy", primaryPhone: "+16175550109" }).returning();
  await db.insert(appointments).values({ tenantId: tenant.id, contactId: past.id, locationId: location.id, service: "Furnace repair",
    startsAt: new Date(Date.now() - 20 * 3600_000), endsAt: new Date(Date.now() - 19 * 3600_000) });

  // Dormant leads that agreed to texts: material for a reactivation campaign.
  for (let i = 0; i < 8; i++) {
    const [c] = await db.insert(contacts).values({
      tenantId: tenant.id, displayName: `Past customer ${i + 1}`, primaryPhone: `+1617555012${i}`, smsConsent: true,
      consentSource: "demo", consentAt: new Date(Date.now() - 90 * 86400_000),
    }).returning();
    await db.insert(leads).values({ tenantId: tenant.id, contactId: c.id, sourceChannel: "sms", source: i % 2 ? "angi" : "google_lsa",
      service: i % 3 ? "AC tune-up" : "Duct cleaning", estimatedValue: String(150 + i * 40),
      createdAt: new Date(Date.now() - 45 * 86400_000), updatedAt: new Date(Date.now() - 40 * 86400_000) });
  }

  // Nothing this demo scheduled may ever run: no worker should text these numbers.
  const removed = await db.delete(jobs).where(eq(jobs.tenantId, tenant.id)).returning({ id: jobs.id });
  console.log(`✓ demo tenant "${SLUG}" (${BIZ}) ready; ${removed.length} scheduled job(s) removed so nothing is ever sent.`);
  console.log(`  View it: TENANT_SLUG=${SLUG} npm run dev, then /dashboard, /inbox, /settings`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
