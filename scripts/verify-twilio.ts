import twilio from "twilio";

/** Confirm the credentials work and show which numbers are available. */
async function main() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;

  if (!sid || !token) {
    console.error("\n✗ TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set in .env\n");
    process.exit(1);
  }
  if (!sid.startsWith("AC")) {
    console.error("\n✗ TWILIO_ACCOUNT_SID should start with 'AC'\n");
    process.exit(1);
  }

  const client = twilio(sid, token);

  try {
    const account = await client.api.v2010.accounts(sid).fetch();
    console.log(`\n✓ authenticated as "${account.friendlyName}" (${account.status})`);

    const numbers = await client.incomingPhoneNumbers.list({ limit: 20 });
    if (numbers.length === 0) {
      console.log(`\n⚠ no phone numbers on this account.`);
      console.log(`  Buy one: Twilio Console → Phone Numbers → Buy a number`);
      console.log(`  Needs Voice + SMS capability.\n`);
      process.exit(0);
    }

    console.log(`\n${numbers.length} number(s):`);
    for (const n of numbers) {
      const caps = [
        n.capabilities.voice && "voice",
        n.capabilities.sms && "sms",
      ].filter(Boolean).join(", ");
      console.log(`  ${n.phoneNumber}   ${caps}`);
      console.log(`     voice webhook → ${n.voiceUrl || "(not set)"}`);
      console.log(`     sms webhook   → ${n.smsUrl || "(not set)"}`);
    }

    const configured = process.env.TWILIO_PHONE_NUMBER;
    if (!configured) {
      console.log(`\n⚠ TWILIO_PHONE_NUMBER is not set. Add one of the above to .env.`);
    } else if (!numbers.some((n) => n.phoneNumber === configured)) {
      console.log(`\n⚠ TWILIO_PHONE_NUMBER (${configured}) is not on this account.`);
    } else {
      console.log(`\n✓ TWILIO_PHONE_NUMBER matches an owned number`);
    }

    const balance = await client.balance.fetch();
    console.log(`\nbalance: ${balance.balance} ${balance.currency}`);
    console.log();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n✗ Twilio rejected the credentials: ${message}`);
    console.error(`  If you just regenerated the token, make sure .env has the NEW one.\n`);
    process.exit(1);
  }
  process.exit(0);
}
main();
