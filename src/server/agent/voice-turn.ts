import { desc, eq } from "drizzle-orm";
import {
  db, agentRuns, messages as messagesTable, conversations, contacts, locations, tenants,
  type ToolCallRecord,
} from "@/server/db";
import { loadKnowledge } from "@/server/core/knowledge";
import { screenInbound, screenOutbound, disclosureReply, handoffReply, safetyReply } from "@/server/core/guardrails";
import { recall } from "@/server/memory/store";
import { buildSystemPrompt } from "./prompt";
import { TOOL_DEFS, executeTool, availabilityChecked, type AgentContext } from "./tools";
import { getProvider, type LlmHistory, type ToolSpec } from "./providers";
import { qualifyFromTranscript } from "./post-turn";
import { screenScope, overBudget, MAX_AI_TURNS, readAgreement } from "@/server/core/scope";
import { resolveFastPath, cleanContinuation } from "./fast-path";
import { routeTurn, FAULT } from "./router";

/**
 * Low-latency agent turn for spoken channels.
 *
 * Differs from the general runtime in three ways, all aimed at time-to-first-
 * word rather than completeness:
 *
 *   1. Streams. The caller hears sentence one while sentence two is still
 *      being generated.
 *   2. Carries a reduced tool set. Eight tool schemas is ~1,000 tokens of
 *      prefill on every turn, and most of them cannot come up mid-call.
 *   3. Keeps less history. A phone conversation is short; thirty messages of
 *      context buys nothing and costs prefill time.
 */

/** Only the tools that can plausibly fire during a live call. */
/**
 * Only the tools whose RESULT the agent needs before it can speak.
 *
 * Measured: offering `qualify_lead` and `save_contact_detail` cost ~5s of
 * silence per turn on llama3.2:3b, because the model spends one whole
 * generation emitting tool calls and a second generating the reply — and it
 * called `save_contact_detail` twice for a caller who had given neither a name
 * nor a number. The caller hears none of this.
 *
 * Both are now handled off the critical path: identifiers are extracted
 * deterministically on the way in (`core/extract.ts`), and qualification runs
 * from the transcript after the turn (`post-turn.ts`).
 */
const VOICE_TOOL_NAMES = [
  "check_availability", "book_appointment", "offer_callback",
];

/**
 * Offer a tool only when it could actually succeed.
 *
 * A 3B model is loose about tool selection: on turn one, with no name, number
 * or chosen slot, it still reached for `book_appointment` — a call that can
 * only fail its own preconditions, after costing a full generation of silence.
 * Hiding a tool until its preconditions hold is cheaper and more reliable than
 * prompting the model not to use it.
 */
function toolsFor(args: {
  hasName: boolean;
  hasPhone: boolean;
  offeredSlot: boolean;
  schedulingInPlay: boolean;
}): ToolSpec[] {
  const allowed = new Set<string>(["offer_callback"]);
  // Offered only once the conversation is about WHEN. With it always on the
  // table, a 3B model answered "what AC options do you have" with appointment
  // times, because the question contained the word "available".
  if (args.schedulingInPlay) allowed.add("check_availability");
  // Booking needs someone to book, and a time they picked.
  if (args.hasName && args.hasPhone && args.offeredSlot) allowed.add("book_appointment");
  return VOICE_TOOLS.filter((t) => allowed.has(t.name));
}

export const VOICE_TOOLS: ToolSpec[] = TOOL_DEFS
  .filter((t) => VOICE_TOOL_NAMES.includes(t.name))
  .map((t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.input_schema as Record<string, unknown>,
  }));

const VOICE_HISTORY_LIMIT = 10;

/**
 * Map stored messages into the provider-neutral history shape.
 *
 * When the two recognisers disagreed about a caller's words, the alternative
 * hearing travels with the message. Deciding between "AC" and "answer" needs
 * exactly what the model has and the recogniser does not: the rest of the
 * conversation, and the fact that this is a heating-and-cooling line.
 */
function llmHistoryFrom(
  ordered: { direction: string; body: string; meta?: Record<string, unknown> | null }[],
): LlmHistory {
  const h: LlmHistory = ordered
    .filter((m) => m.body.trim().length > 0)
    .map((m) => {
      if (m.direction !== "inbound") return { role: "assistant", content: m.body } as const;
      const alts = Array.isArray(m.meta?.alternatives) ? (m.meta!.alternatives as string[]) : [];
      if (alts.length === 0) return { role: "user", content: m.body } as const;
      return {
        role: "user",
        content:
          `${m.body}\n\n[speech recognition was unsure — it may instead have been: ` +
          alts.map((a) => `"${a}"`).join(" or ") +
          `. Treat these as two hearings of ONE thing the caller said. Do not mention ` +
          `the uncertainty; answer whichever they most plausibly meant.]`,
      } as const;
    });
  if (h.length === 0) h.push({ role: "user", content: "(the caller is on the line)" });
  return h;
}
const MAX_TOOL_ITERATIONS = 3;

export type VoiceEvent =
  | { type: "sentence"; text: string; msSinceStart: number }
  | { type: "tool"; name: string; ok: boolean; ms: number }
  | { type: "escalated"; reason: string }
  | { type: "held"; reason: string }
  /** A speculative turn the server will not act on; the client runs the real one. */
  | { type: "declined"; reason: string }
  | { type: "done"; fullText: string; latencyMs: number; firstWordMs: number | null; provider: string; model: string }
  | { type: "error"; message: string };

/**
 * "I've got you booked for Saturday at 9", said with no booking made. The
 * caller hangs up believing it and nobody comes.
 */
const BOOKING_CLAIM = /\b(?:(?:i|we)(?:'ve| have)\s+(?:got\s+you\s+|now\s+)?(?:booked|scheduled|confirmed)|you(?:'re| are)\s+(?:all\s+)?(?:booked|scheduled|confirmed)|booked\s+you|got\s+you\s+(?:booked|down)\s+for|(?:i|we)(?:'ll| will)\s+send\s+(?:you\s+)?(?:a|the)\s+confirmation)\b/i;

/**
 * Screen one sentence before it is spoken. Gate 2 runs after the turn, when a
 * caller has already heard every word, so the two failures seen on test
 * calls are stopped here instead: a booking claimed but not made is never
 * said, and the intensifiers Gate 2 holds a reply for are dropped from the
 * sentence rather than letting the whole reply be held ("We can definitely
 * send someone" → "We can send someone").
 */
function screenSentence(sentence: string, booked: boolean): string | null {
  if (!booked && BOOKING_CLAIM.test(sentence)) return null;
  const out = sentence
    // A template slot the model left unfilled: "with Technician [Name]".
    .replace(/\s*(?:with\s+)?(?:(?:our\s+)?(?:technician|tech|engineer|mr\.?|ms\.?|mrs\.?|dr\.?)\s+)?\[[^\]]*\]/gi, "")
    .replace(/^(?:definitely|certainly|absolutely)\b\s*([,!.])?\s*/i, (_m, p: string | undefined) => (p === "," ? "Sure, " : "Sure. "))
    .replace(/\s*\b(?:definitely|certainly)\b,?/gi, "")
    .replace(/\bSure\.\s*$/, "Sure.")
    .trim();
  return out || null;
}

/** Split a token stream into speakable sentences as soon as each completes. */
function makeSentencer(opts: { hadPrefix: boolean } = { hadPrefix: false }) {
  let buffer = "";
  let first = true;
  const tidy = (sentence: string) => {
    if (!first) return sentence;
    first = false;
    return cleanContinuation(sentence, opts.hadPrefix);
  };
  return {
    push(delta: string): string[] {
      buffer += delta;
      const out: string[] = [];
      // Emit on sentence-ending punctuation followed by whitespace.
      const re = /([^.!?]*[.!?]+)(\s+|$)/g;
      let consumed = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(buffer)) !== null) {
        const sentence = tidy(m[1].trim());
        if (sentence.length > 0) { out.push(sentence); consumed = m.index + m[0].length; }
        else consumed = m.index + m[0].length;
      }
      if (consumed > 0) buffer = buffer.slice(consumed);
      // Long clause with no punctuation yet — speak it anyway rather than stall.
      if (buffer.length > 160) {
        const cut = buffer.lastIndexOf(" ", 160);
        if (cut > 40) {
          const chunk = tidy(buffer.slice(0, cut).trim());
          if (chunk) out.push(chunk);
          buffer = buffer.slice(cut + 1);
        }
      }
      return out;
    },
    flush(): string | null {
      const rest = tidy(buffer.trim());
      buffer = "";
      return rest.length > 0 ? rest : null;
    },
  };
}

export async function* runVoiceTurn(opts: {
  conversationId: string;
  inboundMessageId?: string;
  /**
   * The turn was started on a guess at what the caller said, before speech
   * recognition confirmed it. Irreversible tools are withheld: booking a job
   * from a misheard sentence is far worse than the second of latency the
   * guess was saving.
   */
  speculative?: boolean;
}): AsyncGenerator<VoiceEvent> {
  const started = Date.now();
  let firstWordMs: number | null = null;

  const conversation = await db.query.conversations.findFirst({
    where: eq(conversations.id, opts.conversationId),
  });
  if (!conversation) { yield { type: "error", message: "conversation not found" }; return; }

  const [tenant, contact] = await Promise.all([
    db.query.tenants.findFirst({ where: eq(tenants.id, conversation.tenantId) }),
    db.query.contacts.findFirst({ where: eq(contacts.id, conversation.contactId) }),
  ]);
  if (!tenant || !contact) { yield { type: "error", message: "tenant or contact missing" }; return; }

  const location = await db.query.locations.findFirst({ where: eq(locations.tenantId, tenant.id) });

  const history = await db.query.messages.findMany({
    where: eq(messagesTable.conversationId, conversation.id),
    orderBy: desc(messagesTable.createdAt),
    limit: VOICE_HISTORY_LIMIT,
  });
  const ordered = history.reverse();
  const latestInbound = [...ordered].reverse().find((m) => m.direction === "inbound");

  const ctx: AgentContext = {
    tenant, contactId: contact.id, conversationId: conversation.id, location,
  };

  // Has a time already been put in front of this caller? Only then can they
  // have chosen one.
  const offeredSlot = ordered.some(
    (m) => m.direction === "outbound" && /\b\d{1,2}(:\d{2})?\s?(am|pm)\b/i.test(m.body),
  );
  const JOB_REQUEST = /\b(?:need|want|get|send|have) (?:someone|somebody|a (?:tech|technician|engineer))\b|\b(?:service|repair|fix|replace|install|check|look at|tune up)\s+(?:my|the|our|a new|a|an)\b|\b(?:tune[- ]?ups?|maintenance|servicing)\b/i;
  const SCHEDULING = /\b(?:book|schedule|appointment|come out|come round|visit|availability|when can|what times?|slots?|today|tomorrow|tonight|this week|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|asap|as soon as|emergency|urgent)\b/i;
  const schedulingInPlay =
    offeredSlot ||
    ordered.slice(-4).some((m) => SCHEDULING.test(m.body)) ||
    // A described fault is a job: "no heat and a baby in the house" needs a
    // time today, and without the tool the model can only promise vaguely.
    ordered.slice(-4).some((m) => m.direction === "inbound" && FAULT.test(m.body)) ||
    // So is asking for work: "I need someone to service my heat pump", then
    // "what have you got?". A verb needs an object ("install my", "fix the"),
    // so "what brands do you install" stays a product question.
    ordered.slice(-4).some((m) => m.direction === "inbound" && JOB_REQUEST.test(m.body)) ||
    // The agent itself offered a visit, e.g. the product answer above.
    ordered.slice(-2).some((m) => m.direction === "outbound" && /\bset up (?:that|a) visit|book (?:you|a|that)\b/i.test(m.body));
  const activeTools = toolsFor({
    hasName: Boolean(contact.displayName),
    hasPhone: Boolean(contact.primaryPhone),
    offeredSlot,
    schedulingInPlay,
  }).filter((t) => !(opts.speculative && t.name === "book_appointment"));

  // Gate 1 runs before any generation — an escalation must not wait on tokens.
  if (latestInbound) {
    const verdict = screenInbound(latestInbound.body, tenant.settings ?? {});
    if (verdict.escalate) {
      // Escalating texts staff now, so it is never done on a guess: the
      // client sends the confirmed turn, which lands here for real.
      if (opts.speculative) {
        if (opts.inboundMessageId) {
          await db.delete(messagesTable).where(eq(messagesTable.id, opts.inboundMessageId));
        }
        yield { type: "declined", reason: "an escalation is never acted on from a guess" };
        return;
      }
      // Spoken before the staff alert (one Twilio call): on a gas smell the
      // caller needs to hear "leave the house" first, and nobody should be
      // left in silence with the AI paused.
      const businessName = tenant.settings?.businessName ?? tenant.name;
      const text = verdict.safety ? safetyReply(businessName) : handoffReply(businessName);
      for (const sentence of text.split(/(?<=[.!?])\s+/)) {
        yield { type: "sentence", text: sentence, msSinceStart: Date.now() - started };
      }
      const firstWordMs = Date.now() - started;
      await executeTool(ctx, "escalate_to_human", {
        reason: `${verdict.reason}: ${verdict.trigger}`, urgency: "now",
      });
      await db.insert(messagesTable).values({
        tenantId: tenant.id, conversationId: conversation.id,
        direction: "outbound", channel: "voice", authorType: "ai", body: text, status: "sent",
      });
      await db.insert(agentRuns).values({
        tenantId: tenant.id, conversationId: conversation.id,
        inboundMessageId: opts.inboundMessageId ?? null,
        model: verdict.safety ? "guardrail:safety" : "guardrail:handoff", toolCalls: [],
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
        latencyMs: Date.now() - started, costUsd: "0", outcome: "escalated",
      });
      yield { type: "escalated", reason: `${verdict.reason}: ${verdict.trigger}` };
      yield {
        type: "done", fullText: text, latencyMs: Date.now() - started, firstWordMs,
        provider: "guardrail", model: verdict.safety ? "safety" : "handoff",
      };
      return;
    }

    // Asked whether this is a person: answered truthfully without the model.
    if (verdict.disclose) {
      const text = disclosureReply(tenant.settings?.businessName ?? tenant.name);
      yield { type: "sentence", text, msSinceStart: Date.now() - started };
      await db.insert(messagesTable).values({
        tenantId: tenant.id, conversationId: conversation.id,
        direction: "outbound", channel: "voice", authorType: "ai", body: text, status: "sent",
      });
      await db.insert(agentRuns).values({
        tenantId: tenant.id, conversationId: conversation.id,
        inboundMessageId: opts.inboundMessageId ?? null,
        model: "guardrail:disclosure", toolCalls: [],
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
        latencyMs: Date.now() - started, costUsd: "0", outcome: "replied",
      });
      yield {
        type: "done", fullText: text, latencyMs: Date.now() - started,
        firstWordMs: Date.now() - started, provider: "guardrail", model: "disclosure",
      };
      return;
    }
  }

  // Scope gate — answered without a model call, so an off-topic question
  // costs no tokens and no latency.
  if (latestInbound) {
    const businessName = tenant.settings?.businessName ?? tenant.name;
    const scope = screenScope(latestInbound.body, businessName);
    if (!scope.inScope) {
      await db.insert(messagesTable).values({
        tenantId: tenant.id, conversationId: conversation.id,
        direction: "outbound", channel: "voice", authorType: "ai",
        body: scope.reply, status: "sent", meta: { scopeRedirect: scope.kind },
      });
      yield { type: "sentence", text: scope.reply, msSinceStart: Date.now() - started };
      yield {
        type: "done", fullText: scope.reply, latencyMs: Date.now() - started,
        firstWordMs: Date.now() - started, provider: "scope-guard", model: "n/a",
      };
      return;
    }
  }

  /**
   * The caller is answering an offered callback.
   *
   * A handover only happens on an explicit yes. A no carries on normally, and
   * anything ambiguous is treated as neither — stranding someone because
   * "no, it's fine" was misread as agreement is the failure that matters here.
   */
  const lastOutbound = [...ordered].reverse().find((m) => m.direction === "outbound");
  const callbackPending = Boolean(lastOutbound?.meta?.callbackOffered);

  if (callbackPending && latestInbound) {
    const answer = readAgreement(latestInbound.body);
    if (answer === "yes") {
      await executeTool(ctx, "escalate_to_human", {
        reason: "caller accepted a callback", urgency: "soon",
      });
      const line = "Great — I'll have a colleague call you back shortly.";
      await db.insert(messagesTable).values({
        tenantId: tenant.id, conversationId: conversation.id,
        direction: "outbound", channel: "voice", authorType: "ai",
        body: line, status: "sent", meta: { handover: true },
      });
      yield { type: "sentence", text: line, msSinceStart: Date.now() - started };
      yield { type: "escalated", reason: "caller accepted a callback" };
      yield {
        type: "done", fullText: line, latencyMs: Date.now() - started,
        firstWordMs: Date.now() - started, provider: "handover", model: "n/a",
      };
      return;
    }
  }

  // Budget gate — a conversation this long belongs to a person.
  const aiTurns = ordered.filter((m) => m.direction === "outbound" && m.authorType === "ai").length;
  if (overBudget(aiTurns)) {
    await executeTool(ctx, "escalate_to_human", {
      reason: `conversation exceeded ${MAX_AI_TURNS} AI turns`, urgency: "soon",
    });
    const handoff = "Let me get a colleague to pick this up with you — someone will call you shortly.";
    yield { type: "sentence", text: handoff, msSinceStart: Date.now() - started };
    yield { type: "escalated", reason: "turn budget exceeded" };
    yield {
      type: "done", fullText: handoff, latencyMs: Date.now() - started,
      firstWordMs: Date.now() - started, provider: "budget-guard", model: "n/a",
    };
    return;
  }

  const businessNameForRoute = tenant.settings?.businessName ?? tenant.name;
  const route = latestInbound
    ? await routeTurn(
        tenant.id, latestInbound.body, businessNameForRoute,
        [...ordered].reverse().find((m) => m.direction === "outbound")?.body,
      )
    : null;

  /**
   * Fast path.
   *
   * A question with one fixed answer is served from the tenant's own verified
   * facts with no generation at all. Everything else that matches a known
   * intent gets an opener spoken immediately, so the caller hears a reply at
   * ~0ms while the model writes the substance behind it.
   */
  let spokenPrefix: string | null = null;
  if (latestInbound) {
    const agentHasSpoken = ordered.some((m) => m.direction === "outbound");
    const recentReplies = ordered
      .filter((m) => m.direction === "outbound")
      .slice(-6)
      .map((m) => m.body);
    const fast = await resolveFastPath(
      tenant.id, latestInbound.body, Math.random(),
      { alreadySpoken: agentHasSpoken, recent: recentReplies });

    if (fast.kind === "full") {
      await db.insert(messagesTable).values({
        tenantId: tenant.id, conversationId: conversation.id,
        direction: "outbound", channel: "voice", authorType: "ai",
        body: fast.text, status: "sent", meta: { fastPath: fast.factKey },
      });
      yield { type: "sentence", text: fast.text, msSinceStart: Date.now() - started };
      void qualifyFromTranscript(conversation.id).catch(() => {});
      yield {
        type: "done", fullText: fast.text, latencyMs: Date.now() - started,
        firstWordMs: Date.now() - started, provider: "fast-path", model: fast.factKey,
      };
      return;
    }

    if (fast.kind === "prefix") {
      spokenPrefix = fast.text;
      firstWordMs = Date.now() - started;
      yield { type: "sentence", text: fast.text, msSinceStart: firstWordMs };
    }
  }

  /**
   * Chat tier.
   *
   * A greeting or a thank-you does not need eight tool schemas, the whole
   * knowledge base and a memory lookup to produce one sentence — that is
   * roughly 2.5k tokens of prefill for something a handful of tokens can
   * answer. Conversational turns get a lean prompt, no tools and a short
   * budget; anything that might need a fact or a booking was already routed
   * to the full path.
   */
  if (route?.tier === "chat") {
    const agentName = tenant.settings?.agentName ?? "Alex";
    const leanSystem = [
      `You are ${agentName}, answering the phone for ${businessNameForRoute}.`,
      "",
      "You are SPEAKING on a live call. One short sentence, two at most, then stop.",
      "Use contractions. No markdown, no lists, no emoji, no URLs.",
      "",
      ordered.some((m) => m.direction === "outbound")
        ? "You are ALREADY mid-conversation with this person. Do NOT greet them again, " +
          "do NOT introduce yourself again, and do NOT repeat anything you have already " +
          "said — look at the exchange above and move it forward."
        : "This is the first thing they have said.",
      "",
      "This is small talk, not a service request. Answer what they ACTUALLY said",
      "and then offer to help — never ask how their day is going, and never ask",
      "a question that ignores what they just told you.",
      "",
      "  greeting      -> greet back, ask what you can help with",
      "  thanks        -> accept it, ask if there is anything else",
      "  goodbye       -> say goodbye warmly and stop. Ask nothing.",
      "  can you hear  -> confirm you can, then ask what they need",
      "  yes/no/okay   -> acknowledge and move the conversation forward",
      "",
      "Never state a price, a time or a policy here — if they ask for one, say",
      "you'll check and stop.",
      "Never invent a colleague's name. Say \"a colleague\" or \"someone from the team\".",
      "",
      "What they say reaches you through speech recognition, which mishears. Read it in",
      `light of the conversation and ${tenant.settings?.asrContext ? `the fact that ${tenant.settings.asrContext}` : "what this business does"}.`,
      "",
      "If they repeat themselves, do NOT repeat your previous answer. Vary it, or",
      "ask something that moves things on — \"can you hear me alright?\", \"what's",
      "going on with the system?\"",
      spokenPrefix ? `\nYou have just said out loud: "${spokenPrefix}" — continue from there, do not repeat it.` : "",
    ].join("\n");

    const chatProvider = getProvider("voice");
    const sentencer = makeSentencer({ hadPrefix: Boolean(spokenPrefix) });
    let chatText = "";
    let chatIn = 0, chatOut = 0;

    try {
      if (chatProvider.stream) {
        const iter = chatProvider.stream({
          system: leanSystem,
          history: llmHistoryFrom(ordered),
          tools: [],
          maxTokens: 90,
        });
        while (true) {
          const step = await iter.next();
          if (step.done) {
            chatIn += step.value?.usage.inputTokens ?? 0;
            chatOut += step.value?.usage.outputTokens ?? 0;
            break;
          }
          firstWordMs ??= Date.now() - started;
          chatText += step.value;
          for (const sent of sentencer.push(step.value)) {
            yield { type: "sentence", text: sent, msSinceStart: Date.now() - started };
          }
        }
      } else {
        const turn = await chatProvider.complete({
          system: leanSystem, history: llmHistoryFrom(ordered), tools: [], maxTokens: 90,
        });
        chatText = turn.text;
        chatIn += turn.usage.inputTokens;
        chatOut += turn.usage.outputTokens;
        firstWordMs ??= Date.now() - started;
      }
      const rest = sentencer.flush();
      if (rest) yield { type: "sentence", text: rest, msSinceStart: Date.now() - started };
    } catch {
      chatText = "";
    }

    const spoken = (spokenPrefix ? `${spokenPrefix} ${chatText}` : chatText).trim()
      || "Sorry, could you say that again?";
    if (!chatText.trim() && !spokenPrefix) {
      yield { type: "sentence", text: spoken, msSinceStart: Date.now() - started };
      firstWordMs ??= Date.now() - started;
    }

    await db.insert(messagesTable).values({
      tenantId: tenant.id, conversationId: conversation.id,
      direction: "outbound", channel: "voice", authorType: "ai",
      body: spoken, status: "sent", meta: { tier: "chat" },
    });

    await db.insert(agentRuns).values({
      tenantId: tenant.id, conversationId: conversation.id,
      inboundMessageId: opts.inboundMessageId ?? null,
      model: `${chatProvider.id}:${chatProvider.model}:chat`,
      toolCalls: [], inputTokens: chatIn, outputTokens: chatOut, cacheReadTokens: 0,
      latencyMs: Date.now() - started,
      costUsd: chatProvider.costUsd({ inputTokens: chatIn, outputTokens: chatOut, cacheReadTokens: 0 }).toFixed(6),
      outcome: "replied",
    });

    yield {
      type: "done", fullText: spoken, latencyMs: Date.now() - started,
      firstWordMs, provider: `${chatProvider.id}:chat`, model: chatProvider.model,
    };
    return;
  }

  const [knowledge, memories] = await Promise.all([
    loadKnowledge(tenant.id),
    recall(contact.id, 10),
  ]);

  const built = buildSystemPrompt({
    tenant, contact, location, channel: "voice", knowledge, memories,
  });
  const system = built.system;

  /**
   * Per-turn notes go in `context`, never `system`. `system` is the stable
   * prefix the prompt cache reuses across turns — that split is what took
   * first-word latency from 22.8s to 1.1s — and anything appended to it
   * would invalidate the cache on every turn.
   */
  const notes: string[] = [];

  // The caller has already heard an opener: continue, do not restart.
  if (spokenPrefix) {
    notes.push(
      `# Already said\nYou have just said out loud: "${spokenPrefix}". The caller heard it. ` +
      `Carry straight on — do not repeat it, greet again, or open with another acknowledgement.`,
    );
  }

  /**
   * Asked for AC options, the agent read out appointment times; the caller
   * said "AC" to correct it and got the same answer word for word. A short
   * reply straight after an answer usually means "that is not what I meant".
   * Quoting the previous reply makes that visible to a small model.
   */
  const lastReply = [...ordered].reverse().find((m) => m.direction === "outbound")?.body;
  if (lastReply) {
    notes.push(
      `# Your previous reply\n"${lastReply.slice(0, 400)}"\nDo NOT repeat it or say anything ` +
      `close to it. If the caller's latest words are short, a repeat or a correction, you ` +
      `misunderstood them — re-read what they asked and answer that instead.`,
    );
  }

  /**
   * Times come from the calendar, not the model. Told to "ALWAYS call
   * check_availability", the 3B model still made slots up ("2:30 to 4:00 PM")
   * and Gate 2 held the reply, leaving the caller with nothing. While
   * scheduling is in play, check the calendar here (a read, a few ms) and
   * hand the model the real slots — every turn, not only the first: once
   * times were offered, the next turn could not see the list and offered
   * "11:15", which is not a slot, and booking needs the exact start time.
   * It also saves the tool round trip, which on a call is a second generation.
   */
  const toolRecords: ToolCallRecord[] = [];
  if (schedulingInPlay && activeTools.some((t) => t.name === "check_availability")) {
    const t0 = Date.now();
    const input = { service: "service visit" };
    const result = await executeTool(ctx, "check_availability", input)
      .catch((e) => ({ ok: false, error: String(e) }));
    const ms = Date.now() - t0;
    toolRecords.push({ name: "check_availability", input, output: result, ms });
    yield { type: "tool", name: "check_availability", ok: (result as { ok?: boolean }).ok !== false, ms };
    notes.push(
      `# Open slots, checked just now\n${JSON.stringify(result)}\n` +
      "When you offer times, offer two of THESE, by day and time, and no others. If there " +
      "are none, say so and offer a callback.",
    );
  }

  const context = notes.length ? `${built.context}\n\n${notes.join("\n\n")}` : built.context;

  const llmHistory = llmHistoryFrom(ordered);

  const provider = getProvider("voice");
  let fullText = "";
  let totalIn = 0, totalOut = 0;

  // What the caller actually heard, after screenSentence. Gate 2 judges this,
  // not the raw model text: a dropped word was never said.
  const said: string[] = [];
  const speak = (sentence: string): string | null => {
    const booked = toolRecords.some(
      (t) => t.name === "book_appointment" && (t.output as { ok?: boolean } | null)?.ok !== false,
    );
    const out = screenSentence(sentence, booked);
    if (out) said.push(out);
    return out;
  };

  try {
    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const sentencer = makeSentencer({ hadPrefix: Boolean(spokenPrefix) });
      let turnText = "";

      if (!provider.stream) {
        // Provider cannot stream — fall back to one blocking call.
        const turn = await provider.complete({ system, context, history: llmHistory, tools: activeTools });
        turnText = turn.text;
        if (turn.text) {
          firstWordMs ??= Date.now() - started;
          for (const s of [...sentencer.push(turn.text), sentencer.flush()]) {
            const text = s && speak(s);
            if (text) yield { type: "sentence", text, msSinceStart: Date.now() - started };
          }
        }
        totalIn += turn.usage.inputTokens; totalOut += turn.usage.outputTokens;

        if (turn.toolCalls.length === 0) { fullText += turnText; break; }
        llmHistory.push({ role: "assistant", content: turn.text, toolCalls: turn.toolCalls });
        for (const call of turn.toolCalls) {
          const t0 = Date.now();
          const result = await executeTool(ctx, call.name, call.input).catch((e) => ({ ok: false, error: String(e) }));
          const ms = Date.now() - t0;
          toolRecords.push({ name: call.name, input: call.input, output: result, ms });
          yield { type: "tool", name: call.name, ok: (result as { ok?: boolean }).ok !== false, ms };
          llmHistory.push({ role: "tool", toolCallId: call.id, name: call.name, content: JSON.stringify(result) });
        }
        fullText += turnText;
        continue;
      }

      const iter = provider.stream({ system, context, history: llmHistory, tools: activeTools });
      let final: Awaited<ReturnType<typeof provider.complete>> | undefined;

      while (true) {
        const step = await iter.next();
        if (step.done) { final = step.value; break; }
        turnText += step.value;
        // A small model sometimes types its tool call as JSON instead of
        // making it. Never speak that; the provider salvages it into a real
        // call when the stream ends.
        if (/^\s*\{/.test(turnText)) continue;
        firstWordMs ??= Date.now() - started;
        for (const s of sentencer.push(step.value)) {
          const text = speak(s);
          if (text) yield { type: "sentence", text, msSinceStart: Date.now() - started };
        }
      }

      const typedToolCall = /^\s*\{/.test(turnText);
      const rest = typedToolCall ? null : sentencer.flush();
      const restText = rest && speak(rest);
      if (restText) yield { type: "sentence", text: restText, msSinceStart: Date.now() - started };
      const spoken = typedToolCall ? "" : turnText;

      totalIn += final?.usage.inputTokens ?? 0;
      totalOut += final?.usage.outputTokens ?? 0;
      fullText += spoken;

      const calls = final?.toolCalls ?? [];
      if (calls.length === 0) break;

      llmHistory.push({ role: "assistant", content: spoken, toolCalls: calls });
      for (const call of calls) {
        const t0 = Date.now();
        const result = await executeTool(ctx, call.name, call.input).catch((e) => ({ ok: false, error: String(e) }));
        const ms = Date.now() - t0;
        toolRecords.push({ name: call.name, input: call.input, output: result, ms });
        yield { type: "tool", name: call.name, ok: (result as { ok?: boolean }).ok !== false, ms };
        llmHistory.push({ role: "tool", toolCallId: call.id, name: call.name, content: JSON.stringify(result) });

        // A genuine handover ends the turn: the caller is told once and the
        // agent stops. Continuing to generate after announcing a transfer is
        // what produced "handed to a human" followed by more agent chatter.
        if (call.name === "escalate_to_human") {
          const line = "Let me get a colleague to call you back about that — someone will be in touch shortly.";
          yield { type: "sentence", text: line, msSinceStart: Date.now() - started };
          yield { type: "escalated", reason: String(call.input.reason ?? "agent decided") };
          firstWordMs ??= Date.now() - started;
          await db.insert(messagesTable).values({
            tenantId: tenant.id, conversationId: conversation.id,
            direction: "outbound", channel: "voice", authorType: "ai",
            body: line, status: "sent", meta: { handover: true },
          });
          yield {
            type: "done", fullText: line, latencyMs: Date.now() - started,
            firstWordMs, provider: provider.id, model: provider.model,
          };
          return;
        }
      }
    }
  } catch (err) {
    yield { type: "error", message: err instanceof Error ? err.message : String(err) };
    return;
  }

  fullText = said.join(" ");

  /**
   * Silence is the worst possible outcome on a phone call.
   *
   * A turn can end with no text at all: the model emits only a tool call, or
   * the only call it made was dropped as unoffered. The caller then hears
   * nothing and assumes the line is dead — which is exactly what happened to
   * "hello can you talk to me", where the model called escalate_to_human and
   * said nothing.
   *
   * So: if an escalation fired, say the handoff line. Otherwise retry once
   * with no tools at all, which forces prose. Only if that also comes back
   * empty do we fall back to a fixed line.
   */
  if (!fullText.trim()) {
    const escalatedThisTurn = toolRecords.some((t) => t.name === "escalate_to_human");

    if (escalatedThisTurn) {
      fullText = "Let me get a colleague to help you with that — someone will call you right back.";
    } else {
      try {
        const retry = await provider.complete({ system, history: llmHistory, tools: [] });
        fullText = retry.text.trim();
        totalIn += retry.usage.inputTokens;
        totalOut += retry.usage.outputTokens;
      } catch {
        /* fall through to the fixed line */
      }
    }

    const lines = fullText.split(/(?<=[.!?])\s+/).filter(Boolean)
      .map((s) => screenSentence(s, false)).filter((s): s is string => Boolean(s));
    if (lines.length === 0) lines.push("Sorry, could you say that again?");
    fullText = lines.join(" ");

    for (const sentence of lines) {
      yield { type: "sentence", text: sentence, msSinceStart: Date.now() - started };
    }
    firstWordMs ??= Date.now() - started;
  }

  // Gate 2. Already spoken, so this records the violation for review rather
  // than blocking — the tradeoff streaming forces, and the reason the price
  // guard also lives in the prompt as a hard rule.
  const verdict = screenOutbound(fullText, tenant.settings ?? {}, {
    availabilityChecked: await availabilityChecked(conversation.id, toolRecords),
  });
  if (!verdict.allow) {
    toolRecords.push({ name: "__guardrail", input: { text: fullText }, output: verdict, ms: 0, blocked: verdict.holdReason });
    yield { type: "held", reason: verdict.holdReason ?? "guardrail" };
  }

  const storedText = spokenPrefix ? `${spokenPrefix} ${fullText}`.trim() : fullText;
  if (storedText.trim()) {
    await db.insert(messagesTable).values({
      tenantId: tenant.id, conversationId: conversation.id,
      direction: "outbound", channel: "voice", authorType: "ai",
      body: storedText.trim(),
      status: verdict.allow ? "sent" : "held_for_review",
      meta: {
        ...(verdict.allow ? {} : { holdReason: verdict.holdReason, alreadySpoken: true }),
        // Lets the next turn recognise a yes as accepting the callback.
        ...(toolRecords.some((t) => t.name === "offer_callback") ? { callbackOffered: true } : {}),
      },
    });
  }

  await db.insert(agentRuns).values({
    tenantId: tenant.id, conversationId: conversation.id,
    inboundMessageId: opts.inboundMessageId ?? null,
    model: `${provider.id}:${provider.model}`,
    toolCalls: toolRecords,
    inputTokens: totalIn, outputTokens: totalOut, cacheReadTokens: 0,
    latencyMs: Date.now() - started,
    costUsd: provider.costUsd({ inputTokens: totalIn, outputTokens: totalOut, cacheReadTokens: 0 }).toFixed(6),
    outcome: verdict.allow ? "replied" : "held",
  });

  // Bookkeeping, after the caller has already been answered.
  void qualifyFromTranscript(conversation.id).catch(() => {});

  yield {
    type: "done",
    fullText: fullText.trim(),
    latencyMs: Date.now() - started,
    firstWordMs,
    provider: provider.id,
    model: provider.model,
  };
}
