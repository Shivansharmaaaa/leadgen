import { handleInbound } from "@/server/core/ingest";
import { tenantForNumber, verifyTwilioSignature } from "@/server/channels/twilio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Inbound SMS. Same pipeline as every other channel. */
export async function POST(req: Request) {
  const raw = await req.text();
  const params = Object.fromEntries(new URLSearchParams(raw)) as Record<string, string>;

  const forwardedHost = req.headers.get("x-forwarded-host");
  const url = forwardedHost ? `https://${forwardedHost}${new URL(req.url).pathname}` : req.url;
  if (!verifyTwilioSignature(req.headers.get("x-twilio-signature"), url, params)) {
    return new Response("invalid signature", { status: 403 });
  }

  const tenant = await tenantForNumber(params.To ?? "");
  if (!tenant) return xml("");

  await handleInbound({
    tenantId: tenant.id,
    channel: "sms",
    externalId: params.MessageSid ?? null,
    externalThreadId: params.From ?? null,
    from: { channel: "sms", externalId: params.From ?? "" },
    body: params.Body ?? "",
  });

  // Empty TwiML: the reply is sent through the adapter, not the webhook
  // response, so held drafts and consent checks apply uniformly.
  return xml("");
}

function xml(body: string) {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, {
    headers: { "content-type": "text/xml; charset=utf-8" },
  });
}
