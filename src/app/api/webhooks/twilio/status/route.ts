import { eq } from "drizzle-orm";
import { db, calls } from "@/server/db";
import { tenantForNumber, verifyTwilioSignature } from "@/server/channels/twilio";
import { sendMissedCallTextBack } from "@/server/features/missed-call";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Call status callbacks. This is where missed-call text-back fires — the
 * cheapest win in the product, and it only works if it is immediate.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  const params = Object.fromEntries(new URLSearchParams(raw)) as Record<string, string>;

  const forwardedHost = req.headers.get("x-forwarded-host");
  const url = forwardedHost ? `https://${forwardedHost}${new URL(req.url).pathname}` : req.url;
  if (!verifyTwilioSignature(req.headers.get("x-twilio-signature"), url, params)) {
    return new Response("invalid signature", { status: 403 });
  }

  const status = params.CallStatus;
  const callSid = params.CallSid ?? "";
  const from = params.From ?? "";
  const to = params.To ?? "";

  const tenant = await tenantForNumber(to);
  if (!tenant) return new Response("ok");

  if (params.CallDuration) {
    await db.update(calls)
      .set({ durationSeconds: Number(params.CallDuration), outcome: status })
      .where(eq(calls.providerCallId, callSid));
  }

  // Nobody picked up and the AI did not handle it — text them straight back.
  if (["no-answer", "busy", "failed", "canceled"].includes(status)) {
    const res = await sendMissedCallTextBack({
      tenantId: tenant.id, fromNumber: from, providerCallId: callSid,
    });
    return Response.json({ ok: true, textBack: res });
  }

  return new Response("ok");
}
