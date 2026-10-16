import { desc, eq } from "drizzle-orm";
import {
  db, agentRuns, messages as messagesTable, conversations, contacts, locations, tenants,
  type ToolCallRecord,
} from "@/server/db";
import { loadKnowledge } from "@/server/core/knowledge";
import { screenInbound, screenOutbound, disclosureReply } from "@/server/core/guardrails";
import { recall } from "@/server/memory/store";
import { buildSystemPrompt } from "./prompt";
import { TOOL_DEFS, executeTool, availabilityChecked, type AgentContext } from "./tools";
import { getProvider, type LlmHistory, type ToolSpec } from "./providers";
import { qualifyFromTranscript } from "./post-turn";
import { screenScope, overBudget, MAX_AI_TURNS } from "@/server/core/scope";

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
  "check_availability", "book_appointment", "escalate_to_human",
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
}): ToolSpec[] {
  const allowed = new Set<string>(["check_availability", "escalate_to_human"]);
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
const MAX_TOOL_ITERATIONS = 3;

export type VoiceEvent =
  | { type: "sentence"; text: string; msSinceStart: number }
  | { type: "tool"; name: string; ok: boolean; ms: number }
  | { type: "escalated"; reason: string }
  | { type: "held"; reason: string }
  | { type: "done"; fullText: string; latencyMs: number; firstWordMs: number | null; provider: string; model: string }
  | { type: "error"; message: string };

/** Split a token stream into speakable sentences as soon as each completes. */
function makeSentencer() {
  let buffer = "";
  return {
    push(delta: string): string[] {
      buffer += delta;
      const out: string[] = [];
      // Emit on sentence-ending punctuation followed by whitespace.
      const re = /([^.!?]*[.!?]+)(\s+|$)/g;
      let consumed = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(buffer)) !== null) {
        const sentence = m[1].trim();
        if (sentence.length > 0) { out.push(sentence); consumed = m.index + m[0].length; }
      }
      if (consumed > 0) buffer = buffer.slice(consumed);
      // Long clause with no punctuation yet — speak it anyway rather than stall.
      if (buffer.length > 160) {
        const cut = buffer.lastIndexOf(" ", 160);
        if (cut > 40) { out.push(buffer.slice(0, cut).trim()); buffer = buffer.slice(cut + 1); }
      }
      return out;
    },
    flush(): string | null {
      const rest = buffer.trim();
      buffer = "";
      return rest.length > 0 ? rest : null;
    },
  };
}

export async function* runVoiceTurn(opts: {
  conversationId: string;
  inboundMessageId?: string;
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
  const activeTools = toolsFor({
    hasName: Boolean(contact.displayName),
    hasPhone: Boolean(contact.primaryPhone),
    offeredSlot,
  });

  // Gate 1 runs before any generation — an escalation must not wait on tokens.
  if (latestInbound) {
    const verdict = screenInbound(latestInbound.body, tenant.settings ?? {});
    if (verdict.escalate) {
      await executeTool(ctx, "escalate_to_human", {
        reason: `${verdict.reason}: ${verdict.trigger}`, urgency: "now",
      });
      yield { type: "escalated", reason: `${verdict.reason}: ${verdict.trigger}` };
      yield {
        type: "done", fullText: "", latencyMs: Date.now() - started, firstWordMs: null,
        provider: "guardrail", model: "n/a",
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

  const [knowledge, memories] = await Promise.all([
    loadKnowledge(tenant.id),
    recall(contact.id, 10),
  ]);

  const { system, context } = buildSystemPrompt({
    tenant, contact, location, channel: "voice", knowledge, memories,
  });

  const llmHistory: LlmHistory = ordered
    .filter((m) => m.body.trim().length > 0)
    .map((m) => m.direction === "inbound"
      ? ({ role: "user", content: m.body } as const)
      : ({ role: "assistant", content: m.body } as const));
  if (llmHistory.length === 0) llmHistory.push({ role: "user", content: "(the caller is on the line)" });

  const provider = getProvider("voice");
  const toolRecords: ToolCallRecord[] = [];
  let fullText = "";
  let totalIn = 0, totalOut = 0;

  try {
    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const sentencer = makeSentencer();
      let turnText = "";

      if (!provider.stream) {
        // Provider cannot stream — fall back to one blocking call.
        const turn = await provider.complete({ system, context, history: llmHistory, tools: activeTools });
        turnText = turn.text;
        if (turn.text) {
          firstWordMs ??= Date.now() - started;
          for (const s of sentencer.push(turn.text)) {
            yield { type: "sentence", text: s, msSinceStart: Date.now() - started };
          }
          const rest = sentencer.flush();
          if (rest) yield { type: "sentence", text: rest, msSinceStart: Date.now() - started };
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
          yield { type: "sentence", text: s, msSinceStart: Date.now() - started };
        }
      }

      const typedToolCall = /^\s*\{/.test(turnText);
      const rest = typedToolCall ? null : sentencer.flush();
      if (rest) yield { type: "sentence", text: rest, msSinceStart: Date.now() - started };
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
        if (call.name === "escalate_to_human") {
          yield { type: "escalated", reason: String(call.input.reason ?? "agent decided") };
        }
        llmHistory.push({ role: "tool", toolCallId: call.id, name: call.name, content: JSON.stringify(result) });
      }
    }
  } catch (err) {
    yield { type: "error", message: err instanceof Error ? err.message : String(err) };
    return;
  }

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

    if (!fullText.trim()) {
      fullText = "Sorry, could you say that again?";
    }

    for (const sentence of fullText.split(/(?<=[.!?])\s+/).filter(Boolean)) {
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

  if (fullText.trim()) {
    await db.insert(messagesTable).values({
      tenantId: tenant.id, conversationId: conversation.id,
      direction: "outbound", channel: "voice", authorType: "ai",
      body: fullText.trim(),
      status: verdict.allow ? "sent" : "held_for_review",
      meta: verdict.allow ? {} : { holdReason: verdict.holdReason, alreadySpoken: true },
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
