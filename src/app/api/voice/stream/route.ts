import { eq } from "drizzle-orm";
import { db, tenants, messages as messagesTable, conversations } from "@/server/db";
import { resolveContact } from "@/server/core/identity";
import { extractIdentifiers } from "@/server/core/extract";
import { linkIdentifierToContact } from "@/server/core/identity";
import { extractMemories } from "@/server/memory/extract";
import { runVoiceTurn } from "@/server/agent/voice-turn";
import { and } from "drizzle-orm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Streaming voice turn over Server-Sent Events.
 *
 * The browser speaks each sentence the moment it arrives rather than waiting
 * for the full reply, so perceived latency becomes time-to-first-sentence.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    sessionId?: string; text?: string; tenant?: string;
  };

  const text = (body.text ?? "").trim();
  if (!text) return new Response("text is required", { status: 400 });

  const tenant = await db.query.tenants.findFirst({
    where: eq(tenants.slug, body.tenant ?? "northside-hvac"),
  });
  if (!tenant) return new Response("unknown tenant — run npm run seed", { status: 404 });

  const sessionId = body.sessionId ?? `browser_${Date.now()}`;
  const callerId = `+1555${String(hash(sessionId)).padStart(7, "0").slice(0, 7)}`;

  const contact = await resolveContact(tenant.id, { channel: "voice", externalId: callerId });

  // Same deterministic harvesting the main pipeline does.
  const found = extractIdentifiers(text, tenant.country);
  for (const phone of found.phones) await linkIdentifierToContact(tenant.id, contact.id, "phone", phone);
  for (const email of found.emails) await linkIdentifierToContact(tenant.id, contact.id, "email", email);

  let conversation = await db.query.conversations.findFirst({
    where: and(
      eq(conversations.tenantId, tenant.id),
      eq(conversations.channel, "voice"),
      eq(conversations.externalThreadId, sessionId),
    ),
  });
  if (!conversation) {
    [conversation] = await db.insert(conversations).values({
      tenantId: tenant.id, contactId: contact.id,
      channel: "voice", externalThreadId: sessionId,
    }).returning();
  }

  const [inbound] = await db.insert(messagesTable).values({
    tenantId: tenant.id, conversationId: conversation.id,
    direction: "inbound", channel: "voice", authorType: "contact", body: text,
  }).returning();

  await extractMemories({
    tenantId: tenant.id, contactId: contact.id, text,
    conversationId: conversation.id, messageId: inbound.id,
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      try {
        for await (const ev of runVoiceTurn({
          conversationId: conversation!.id,
          inboundMessageId: inbound.id,
        })) {
          send(ev);
        }
      } catch (err) {
        send({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
