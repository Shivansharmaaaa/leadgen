import { eq } from "drizzle-orm";
import { db, calls, conversations } from "@/server/db";
import { handleInbound } from "@/server/core/ingest";
import { tenantForNumber, verifyTwilioSignature } from "@/server/channels/twilio";
import { recordingDisclosureRequired } from "@/server/core/guardrails";
import { resolveContact } from "@/server/core/identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Live inbound phone call, answered by the agent.
 *
 * Uses TwiML <Gather input="speech">: Twilio performs the speech-to-text and
 * posts the transcript here, we run the normal agent turn, and reply with
 * <Say>. Round-trip lands around 2-3s — not the sub-second target, but it is
 * REAL, needs no media-streaming infrastructure, and works with any phone.
 * The low-latency path (ConversationRelay or a raw media stream into
 * Kokoro/Parakeet) swaps in behind the same ingest pipeline later.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  const params = Object.fromEntries(new URLSearchParams(raw)) as Record<string, string>;

  // Twilio signs the public URL it called. Behind a tunnel, trust the
  // forwarded host so the signature base string matches.
  const forwardedHost = req.headers.get("x-forwarded-host");
  const url = forwardedHost
    ? `https://${forwardedHost}${new URL(req.url).pathname}`
    : req.url;

  if (!verifyTwilioSignature(req.headers.get("x-twilio-signature"), url, params)) {
    return new Response("invalid signature", { status: 403 });
  }

  const from = params.From ?? "";
  const to = params.To ?? "";
  const callSid = params.CallSid ?? "";
  const speech = (params.SpeechResult ?? "").trim();

  const tenant = await tenantForNumber(to);
  if (!tenant) return twiml(`<Say>Sorry, this number is not configured.</Say><Hangup/>`);

  const businessName = tenant.settings?.businessName ?? tenant.name;

  // ── First leg: greet, disclose, start listening ──────────────────────────
  if (!speech) {
    const contact = await resolveContact(tenant.id, { channel: "voice", externalId: from });

    await db.insert(calls).values({
      tenantId: tenant.id,
      contactId: contact.id,
      direction: "inbound",
      providerCallId: callSid,
      fromNumber: from,
      toNumber: to,
      answeredByAi: true,
    }).onConflictDoNothing();

    // Disclosure is not optional: CA SB 1001, the EU AI Act, and recording
    // consent in two-party states all land in this opening line.
    const needsRecordingNotice =
      tenant.settings?.recordCalls && recordingDisclosureRequired(tenant.country, null);

    const greeting =
      `Thanks for calling ${businessName}. I'm an AI assistant` +
      (needsRecordingNotice ? `, and this call is recorded` : "") +
      `. How can I help you today?`;

    return twiml(`
      <Say voice="Polly.Joanna">${escapeXml(greeting)}</Say>
      <Gather input="speech" speechTimeout="auto" language="en-US"
              action="/api/webhooks/twilio/voice" method="POST">
        <Pause length="3"/>
      </Gather>
      <Say voice="Polly.Joanna">I didn't catch that. Please call back and we'll help.</Say>
      <Hangup/>
    `);
  }

  // ── Subsequent legs: run a real agent turn on the transcript ─────────────
  const result = await handleInbound({
    tenantId: tenant.id,
    channel: "voice",
    externalId: `${callSid}_${params.SequenceNumber ?? Date.now()}`,
    externalThreadId: callSid,
    from: { channel: "voice", externalId: from },
    body: speech,
    meta: { callSid },
  });

  const outcome = result.outcome;

  // Escalation or a held reply both mean: stop talking, get a human.
  if (outcome?.escalated || (outcome?.holdReason && !outcome.reply)) {
    return twiml(`
      <Say voice="Polly.Joanna">Let me get a team member to help you with that. Someone will call you right back.</Say>
      <Hangup/>
    `);
  }

  const reply = outcome?.reply
    ?? "Sorry, I didn't quite get that. Could you say it another way?";

  return twiml(`
    <Say voice="Polly.Joanna">${escapeXml(reply)}</Say>
    <Gather input="speech" speechTimeout="auto" language="en-US"
            action="/api/webhooks/twilio/voice" method="POST">
      <Pause length="3"/>
    </Gather>
    <Say voice="Polly.Joanna">Thanks for calling ${escapeXml(businessName)}. Goodbye.</Say>
    <Hangup/>
  `);
}

/** Twilio also probes with GET when you click "Test" in the console. */
export async function GET() {
  return twiml(`<Say>Leadgen voice webhook is live.</Say><Hangup/>`);
}

function twiml(body: string) {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, {
    headers: { "content-type": "text/xml; charset=utf-8" },
  });
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
