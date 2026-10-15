import twilio from "twilio";

/** Show account status and list numbers available to buy. Read-only. */
async function main() {
  const sid = process.env.TWILIO_ACCOUNT_SID!;
  const client = twilio(sid, process.env.TWILIO_AUTH_TOKEN!);

  const account = await client.api.v2010.accounts(sid).fetch();
  const balance = await client.balance.fetch();

  console.log(`\naccount   ${account.friendlyName}`);
  console.log(`type      ${account.type}`);
  console.log(`status    ${account.status}`);
  console.log(`balance   ${balance.balance} ${balance.currency}`);

  if (account.type === "Trial") {
    console.log(`\n⚠ TRIAL account:`);
    console.log(`   · can only call/text VERIFIED numbers`);
    console.log(`   · every call carries a Twilio trial message first`);
    console.log(`   · verify your number: Console → Phone Numbers → Verified Caller IDs`);
  }

  for (const country of ["US", "GB"]) {
    try {
      const avail = await client.availablePhoneNumbers(country)
        .local.list({ voiceEnabled: true, smsEnabled: true, limit: 3 });
      if (avail.length === 0) { console.log(`\n${country}: none returned`); continue; }
      console.log(`\n${country} numbers available (voice + SMS):`);
      for (const n of avail) {
        console.log(`   ${n.phoneNumber}   ${n.locality ?? ""} ${n.region ?? ""}`.trimEnd());
      }
    } catch (err) {
      console.log(`\n${country}: ${err instanceof Error ? err.message : "lookup failed"}`);
    }
  }

  console.log(`\nA US local number is ~$1.15/month plus usage.`);
  console.log(`Buy one: Console → Phone Numbers → Buy a number (voice + SMS)\n`);
  process.exit(0);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
