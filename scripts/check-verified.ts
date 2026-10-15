import twilio from "twilio";

async function main() {
  const client = twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);
  const target = process.argv[2];

  const ids = await client.outgoingCallerIds.list({ limit: 50 });
  console.log(`\nverified caller IDs on this account: ${ids.length}`);
  for (const i of ids) console.log(`   ${i.phoneNumber}  ${i.friendlyName ?? ""}`);

  if (target) {
    const ok = ids.some((i) => i.phoneNumber === target);
    console.log(`\n${target} → ${ok ? "✓ VERIFIED — callable" : "✗ NOT verified — trial accounts cannot call it"}`);
    if (!ok) {
      console.log(`\n  Verify it: Twilio Console → Phone Numbers → Manage → Verified Caller IDs`);
      console.log(`  Twilio will call/text you a code.\n`);
    } else {
      console.log();
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
