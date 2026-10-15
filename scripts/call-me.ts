import twilio from "twilio";

/**
 * Place an outbound test call that connects you to your own agent.
 *
 * SCOPE: this is for calling YOUR OWN phone to test. Outbound AI-voice calling
 * to anyone else in the US needs prior express written consent — the FCC ruled
 * in 2024 that AI-generated voices are "artificial" under the TCPA, at
 * $500-$1,500 per call in statutory damages. The same applies under CRTC rules
 * in Canada and PECR in the UK.
 *
 * The product never places outbound AI calls on its own: `canInitiateOutbound`
 * in guardrails.ts refuses the voice channel outright. This script is a
 * developer tool, and it makes you type the number every time rather than
 * reading one from config, so it cannot be pointed at a list.
 *
 *   npm run call:me -- +15551234567
 */
async function main() {
  const to = process.argv[2];

  if (!to) {
    console.error(`
  Usage:  npm run call:me -- +15551234567

  Pass YOUR OWN number. This places a real call that costs real money.
`);
    process.exit(1);
  }

  if (!/^\+[1-9]\d{7,14}$/.test(to)) {
    console.error(`\n✗ "${to}" is not E.164 format. Use +15551234567.\n`);
    process.exit(1);
  }

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER;
  const publicUrl = process.env.PUBLIC_URL;

  const missing = [
    !sid && "TWILIO_ACCOUNT_SID",
    !token && "TWILIO_AUTH_TOKEN",
    !from && "TWILIO_PHONE_NUMBER",
    !publicUrl && "PUBLIC_URL (your tunnel address)",
  ].filter(Boolean);

  if (missing.length) {
    console.error(`\n✗ missing from .env: ${missing.join(", ")}\n`);
    process.exit(1);
  }

  const client = twilio(sid!, token!);
  const voiceUrl = `${publicUrl!.replace(/\/$/, "")}/api/webhooks/twilio/voice`;

  console.log(`\n  calling ${to}`);
  console.log(`  from    ${from}`);
  console.log(`  agent   ${voiceUrl}\n`);

  try {
    const call = await client.calls.create({
      to,
      from: from!,
      url: voiceUrl,
      method: "POST",
      statusCallback: `${publicUrl!.replace(/\/$/, "")}/api/webhooks/twilio/status`,
      statusCallbackMethod: "POST",
    });

    console.log(`  ✓ ringing — call SID ${call.sid}`);
    console.log(`\n  Answer it and talk. Try:`);
    console.log(`    "My AC is blowing warm air and the house is 84 degrees."`);
    console.log(`    "How much is the call-out?"        → quotes only verified facts`);
    console.log(`    "My lawyer says you damaged it."   → hands off to a human, hangs up`);
    console.log(`\n  Watch it land:  http://localhost:3100/inbox\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n  ✗ Twilio refused: ${message}`);
    if (message.includes("unverified")) {
      console.error(`\n  Trial accounts can only call VERIFIED numbers.`);
      console.error(`  Verify yours: Console → Phone Numbers → Verified Caller IDs\n`);
    } else {
      console.error();
    }
    process.exit(1);
  }
  process.exit(0);
}

main();
