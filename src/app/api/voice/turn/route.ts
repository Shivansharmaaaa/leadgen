import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, tenants } from "@/server/db";
import { handleInbound } from "@/server/core/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One spoken turn. The browser does speech-to-text, posts the transcript here,
 * and speaks the reply back. Exactly the same ingest pipeline a real phone call
 * uses — only the transport differs.
 */
export async function POST(req: Request) {
  const started = Date.now();

  let body: { sessionId?: string; text?: string; tenant?: string; callerId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const text = (body.text ?? "").trim();
  if (!text) return NextResponse.json({ error: "text is required" }, { status: 400 });

  const slug = body.tenant ?? "northside-hvac";
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.slug, slug) });
  if (!tenant) {
    return NextResponse.json({ error: `unknown tenant "${slug}" — run npm run seed` }, { status: 404 });
  }

  const sessionId = body.sessionId ?? `browser_${Date.now()}`;
  // A stable pseudo-number so repeat sessions resolve to the same contact.
  const callerId = body.callerId ?? `+1555${String(hash(sessionId)).padStart(7, "0").slice(0, 7)}`;

  const result = await handleInbound({
    tenantId: tenant.id,
    channel: "voice",
    externalId: `${sessionId}_${Date.now()}`,
    externalThreadId: sessionId,
    from: { channel: "voice", externalId: callerId },
    body: text,
  });

  return NextResponse.json({
    reply: result.outcome?.reply ?? null,
    held: result.outcome?.holdReason ?? null,
    escalated: result.outcome?.escalated ?? false,
    toolCalls: (result.outcome?.toolCalls ?? []).map((t) => ({
      name: t.name,
      ok: (t.output as { ok?: boolean })?.ok !== false,
      ms: t.ms,
    })),
    provider: result.outcome?.provider,
    model: result.outcome?.model,
    productionGrade: result.outcome?.productionGrade ?? false,
    costUsd: result.outcome?.costUsd ?? 0,
    latencyMs: Date.now() - started,
    conversationId: result.conversationId,
  });
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
