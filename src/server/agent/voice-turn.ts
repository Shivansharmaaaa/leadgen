import { desc, eq } from "drizzle-orm";
import {
  db, agentRuns, messages as messagesTable, conversations, contacts, locations, tenants,
  type ToolCallRecord,
} from "@/server/db";
import { loadKnowledge } from "@/server/core/knowledge";
import { screenInbound, screenOutbound } from "@/server/core/guardrails";
import { recall } from "@/server/memory/store";
import { buildSystemPrompt } from "./prompt";
import { TOOL_DEFS, executeTool, availabilityChecked, type AgentContext } from "./tools";
import { getProvider, type LlmHistory, type ToolSpec } from "./providers";

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
const VOICE_TOOL_NAMES = [
  "check_availability", "book_appointment", "save_contact_detail",
  "qualify_lead", "escalate_to_human",
];

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
        const turn = await provider.complete({ system, context, history: llmHistory, tools: VOICE_TOOLS });
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

      const iter = provider.stream({ system, context, history: llmHistory, tools: VOICE_TOOLS });
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

  yield {
    type: "done",
    fullText: fullText.trim(),
    latencyMs: Date.now() - started,
    firstWordMs,
    provider: provider.id,
    model: provider.model,
  };
}
