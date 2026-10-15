import twilio from "twilio";
import { db, channelAccounts, tenants } from "@/server/db";
import { eq } from "drizzle-orm";

/**
 * Buy a number and wire all three webhooks at it, then register it against the
 * tenant so `tenantForNumber` can route inbound traffic without env lookups.
 */
async function main() {
  const wanted = process.argv[2];
  const publicUrl = (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");

  if (!wanted) { console.error("usage: npm run twilio:provision -- +1785..."); process.exit(1); }
  if (!publicUrl) { console.error("PUBLIC_URL not set in .env"); process.exit(1); }

  const client = twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);

  console.log(`\nbuying ${wanted} …`);
  let number;
  try {
    number = await client.incomingPhoneNumbers.create({
      phoneNumber: wanted,
      voiceUrl: `${publicUrl}/api/webhooks/twilio/voice`,
      voiceMethod: "POST",
      statusCallback: `${publicUrl}/api/webhooks/twilio/status`,
      statusCallbackMethod: "POST",
      smsUrl: `${publicUrl}/api/webhooks/twilio/sms`,
      smsMethod: "POST",
      friendlyName: "Leadgen agent line",
    });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.error(`\n✗ purchase failed: ${m}\n`);
    if (m.includes("not available")) console.error("  That number was taken. Re-run npm run twilio:numbers for fresh options.\n");
    process.exit(1);
  }

  console.log(`✓ bought ${number.phoneNumber}`);
  console.log(`   voice  → ${number.voiceUrl}`);
  console.log(`   status → ${number.statusCallback}`);
  console.log(`   sms    → ${number.smsUrl}`);

  // Route inbound traffic on this number to the demo tenant.
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.slug, "northside-hvac") });
  if (tenant) {
    for (const channel of ["voice", "sms"] as const) {
      await db.insert(channelAccounts).values({
        tenantId: tenant.id,
        channel,
        externalAccountId: number.phoneNumber,
        displayName: "Leadgen agent line",
        status: "active",
      }).onConflictDoNothing();
    }
    console.log(`✓ routed to tenant "${tenant.name}"`);
  }

  console.log(`\n  Add to .env:  TWILIO_PHONE_NUMBER=${number.phoneNumber}\n`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
