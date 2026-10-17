import { eq } from "drizzle-orm";
import { db, tenants, messages as messagesTable, conversations, contacts, events } from "@/server/db";
import { detectConsentKeyword, optOutConfirmation } from "@/server/core/opt-out";
import { outboundOpener, outboundReason } from "@/server/agent/outbound";
import { personaFor, planDelivery } from "@/server/voice/delivery";
import { screenInbound } from "@/server/core/guardrails";
import { resolveContact } from "@/server/core/identity";
import { extractIdentifiers, extractName } from "@/server/core/extract";
import { linkIdentifierToContact } from "@/server/core/identity";
import { extractMemories } from "@/server/memory/extract";
import { runVoiceTurn, isUrgent } from "@/server/agent/voice-turn";
import { and, desc, gte } from "drizzle-orm";

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
    sessionId?: string; text?: string; tenant?: string; speculative?: boolean;
    alternatives?: string[]; discard?: string;
    /** Start a call the agent places: it speaks first, as a sales follow-up. */
    outbound?: { name?: string; interest?: string };
  };
  const speculative = Boolean(body.speculative);
  // Other hearings of the same utterance when the two recognisers disagreed.
  // Capped and length-limited: this is caller-controlled text going to a model.
  const alternatives = (Array.isArray(body.alternatives) ? body.alternatives : [])
    .filter((a): a is string => typeof a === "string" && a.trim().length > 0)
    .slice(0, 2)
    .map((a) => a.trim().slice(0, 300));

  const text = (body.text ?? "").trim();
  if (!text && !body.outbound) return new Response("text is required", { status: 400 });

  const tenant = await db.query.tenants.findFirst({
    where: eq(tenants.slug, body.tenant ?? "northside-hvac"),
  });
  if (!tenant) return new Response("unknown tenant — run npm run seed", { status: 404 });
  const persona = personaFor(tenant.settings, tenant.country);
  /** A fixed reply as sentence events, each with its delivery plan. */
  const planned = (reply: string, heard: string) =>
    reply.split(/(?<=[.!?])\s+/).map((sentence, i) => ({
      type: "sentence", text: sentence, msSinceStart: 0,
      delivery: planDelivery(sentence, { heard, index: i }, persona),
    }));

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

  // Saved before the turn, so book_appointment (which needs a name) is
  // offered on the very turn the caller gives it. Never replaces a different
  // name, only extends one ("Sam" -> "Sam Carter"). The agent's last line lets
  // a bare "Grace Fontaine." count, but only as the answer to a name question.
  const lastAgentLine = (await db.query.messages.findFirst({
    columns: { body: true },
    where: and(eq(messagesTable.conversationId, conversation.id), eq(messagesTable.direction, "outbound")),
    orderBy: desc(messagesTable.createdAt),
  }))?.body;
  const name = extractName(text, { lastAgentLine });
  if (name && (!contact.displayName || (name.startsWith(contact.displayName) && name !== contact.displayName))) {
    await db.update(contacts).set({ displayName: name }).where(eq(contacts.id, contact.id));
  }

  /**
   * A call the agent places. Framed as a follow-up to someone who asked to be
   * contacted (a website enquiry), which is the lawful shape of an outbound AI
   * call; it says it is an AI in the first sentence. The opener is fixed text,
   * so it plays instantly, and its meta tells every later turn what this call
   * is for (runVoiceTurn reads it).
   */
  if (body.outbound) {
    const name = String(body.outbound.name ?? "").replace(/[^A-Za-z' -]/g, "").trim().slice(0, 40) || null;
    const interest = outboundReason(tenant.settings ?? {}, body.outbound.interest);
    // Placing a call means having their number, so the booking tool (which
    // needs a name and a phone) is available from the start.
    await db.update(contacts).set({
      ...(name && !contact.displayName ? { displayName: name } : {}),
      ...(!contact.primaryPhone ? { primaryPhone: callerId } : {}),
    }).where(eq(contacts.id, contact.id));
    const opener = outboundOpener(tenant.settings ?? {}, tenant.name, { name, interest });
    await db.insert(messagesTable).values({
      tenantId: tenant.id, conversationId: conversation.id,
      direction: "outbound", channel: "voice", authorType: "ai", body: opener, status: "sent",
      meta: { outboundCall: { name, interest } },
    });
    return sse([
      ...planned(opener, ""),
      { type: "done", fullText: opener, latencyMs: 0, firstWordMs: 0, provider: "rule", model: "outbound-opener" },
    ]);
  }

  // A guess the client abandoned after it had already been answered: the
  // guess and its reply go, or the model sees itself answering one turn
  // twice (a session at 10:57 stored two different replies to "hello can
  // you talk to me"). Only a recent message in this same conversation.
  const discard = typeof body.discard === "string" && /^[0-9a-f-]{36}$/i.test(body.discard) ? body.discard : null;
  if (discard) {
    const old = await db.query.messages.findFirst({
      where: and(eq(messagesTable.id, discard), eq(messagesTable.conversationId, conversation.id)),
    });
    if (old && old.direction === "inbound" && Date.now() - old.createdAt.getTime() < 120_000) {
      await db.delete(messagesTable).where(and(
        eq(messagesTable.conversationId, conversation.id),
        gte(messagesTable.createdAt, old.createdAt),
      ));
    }
  }

  const [inbound] = await db.insert(messagesTable).values({
    tenantId: tenant.id, conversationId: conversation.id,
    direction: "inbound", channel: "voice", authorType: "contact", body: text,
    meta: {
      ...(speculative ? { speculative: true } : {}),
      ...(alternatives.length ? { alternatives } : {}),
    },
  }).returning();

  // Opting out is decided by rule before the agent runs, as handleInbound
  // does for the other routes: a chatty reply to "don't call me again" is
  // what a TCPA claim quotes. A guess is never acted on: "don't call me"
  // may end "…, text me instead", which is a preference, not an opt-out. The
  // client sends the confirmed turn instead.
  const consent = detectConsentKeyword(text, "voice");
  if (consent?.kind === "opt_out") {
    if (speculative) {
      await db.delete(messagesTable).where(eq(messagesTable.id, inbound.id));
      return sse([{ type: "declined", reason: "an opt-out is never acted on from a guess" }]);
    }
    await db.update(contacts).set({ doNotContact: true }).where(eq(contacts.id, contact.id));
    await db.insert(events).values({
      tenantId: tenant.id, type: "opt_out", conversationId: conversation.id, contactId: contact.id,
      payload: { keyword: consent.keyword, channel: "voice", messageId: inbound.id },
    });
    const confirmation = optOutConfirmation(tenant.settings?.businessName ?? tenant.name, "voice");
    await db.insert(messagesTable).values({
      tenantId: tenant.id, conversationId: conversation.id,
      direction: "outbound", channel: "voice", authorType: "system", body: confirmation,
    });
    return sse([
      ...planned(confirmation, text),
      { type: "done", fullText: confirmation, latencyMs: 0, firstWordMs: 0, provider: "rule", model: "opt-out" },
    ]);
  }

  await extractMemories({
    tenantId: tenant.id, contactId: contact.id, text,
    conversationId: conversation.id, messageId: inbound.id,
  });

  const encoder = new TextEncoder();
  let completed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          /* client went away mid-turn */
        }
      };
      // Lets the client name this turn later, if it turns out to be a guess
      // it has to discard.
      send({ type: "inbound", id: inbound.id });
      try {
        // How each sentence is spoken: pace, pauses, style (voice/delivery.ts).
        // Planned here, where the turn's context is known, so the page only
        // has to apply it.
        let index = 0;
        let booked = false;
        const safety = Boolean(screenInbound(text, tenant.settings ?? {}).safety);
        const urgent = isUrgent(text);
        for await (const ev of runVoiceTurn({
          conversationId: conversation!.id,
          inboundMessageId: inbound.id,
          speculative,
        })) {
          if (ev.type === "tool" && ev.name === "book_appointment" && ev.ok) booked = true;
          if (ev.type === "sentence") {
            send({ ...ev, delivery: planDelivery(ev.text, { heard: text, index: index++, safety, booked, urgent }, persona) });
            continue;
          }
          send(ev);
        }
        completed = true;
        // The guess held: it is an ordinary turn now.
        if (speculative) {
          await db.update(messagesTable)
            .set({ meta: alternatives.length ? { alternatives } : {} })
            .where(eq(messagesTable.id, inbound.id));
        }
      } catch (err) {
        send({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        try { controller.close(); } catch { /* already closed */ }
      }
    },

    /**
     * The client aborted — speech recognition settled on something other than
     * the guess. Remove the misheard utterance so it never becomes history
     * the next turn reasons from.
     */
    async cancel() {
      if (completed || !speculative) return;
      await db.delete(messagesTable).where(eq(messagesTable.id, inbound.id));
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
};

/** A turn decided without the model: every event at once. */
function sse(evs: unknown[]): Response {
  return new Response(evs.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: SSE_HEADERS });
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
