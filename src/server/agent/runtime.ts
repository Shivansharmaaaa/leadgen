import { desc, eq } from "drizzle-orm";
import {
  db, agentRuns, messages as messagesTable, conversations, contacts, locations, tenants,
  type ToolCallRecord,
} from "@/server/db";
import { loadKnowledge } from "@/server/core/knowledge";
import { screenInbound, screenOutbound, disclosureReply, handoffReply, safetyReply } from "@/server/core/guardrails";
import type { Channel } from "@/server/core/types";
import { buildSystemPrompt } from "./prompt";
import { recall } from "@/server/memory/store";
import { TOOL_DEFS, executeTool, availabilityChecked, type AgentContext } from "./tools";
import { getProvider, type LlmHistory, type ToolSpec, LlmError } from "./providers";

const MAX_TOOL_ITERATIONS = 6;
const HISTORY_LIMIT = 30;

export type AgentOutcome = {
  reply: string | null;
  /** Set when the reply must not auto-send: guardrail hold or escalation. */
  holdReason?: string;
  escalated: boolean;
  toolCalls: ToolCallRecord[];
  costUsd: number;
  latencyMs: number;
  provider: string;
  model: string;
  productionGrade: boolean;
};

const toolSpecs: ToolSpec[] = TOOL_DEFS.map((t) => ({
  name: t.name,
  description: t.description ?? "",
  inputSchema: t.input_schema as Record<string, unknown>,
}));

/**
 * Run one agent turn for a conversation.
 *
 * A manual loop rather than the SDK tool runner: every tool call is persisted
 * for audit, guardrails intercept between steps, and this path must not carry a
 * beta dependency.
 */
export async function runAgentTurn(opts: {
  conversationId: string;
  inboundMessageId?: string;
}): Promise<AgentOutcome> {
  const started = Date.now();

  const conversation = await db.query.conversations.findFirst({
    where: eq(conversations.id, opts.conversationId),
  });
  if (!conversation) throw new Error(`conversation ${opts.conversationId} not found`);

  const [tenant, contact] = await Promise.all([
    db.query.tenants.findFirst({ where: eq(tenants.id, conversation.tenantId) }),
    db.query.contacts.findFirst({ where: eq(contacts.id, conversation.contactId) }),
  ]);
  if (!tenant || !contact) throw new Error("tenant or contact missing");

  const location = await db.query.locations.findFirst({
    where: eq(locations.tenantId, tenant.id),
  });

  const history = await db.query.messages.findMany({
    where: eq(messagesTable.conversationId, conversation.id),
    orderBy: desc(messagesTable.createdAt),
    limit: HISTORY_LIMIT,
  });
  const ordered = history.reverse();
  const latestInbound = [...ordered].reverse().find((m) => m.direction === "inbound");

  const provider = getProvider(conversation.channel);
  const ctx: AgentContext = {
    tenant,
    contactId: contact.id,
    conversationId: conversation.id,
    location,
  };

  // Gate 1: should the AI touch this at all?
  if (latestInbound) {
    const verdict = screenInbound(latestInbound.body, tenant.settings ?? {});
    if (verdict.escalate) {
      await executeTool(ctx, "escalate_to_human", {
        reason: `${verdict.reason}: ${verdict.trigger}`,
        urgency: "now",
      });
      // A fixed reply, safe to send as is. Returning none left a texter in
      // silence with the AI paused; on a gas leak it must say what to do.
      const businessName = tenant.settings?.businessName ?? tenant.name;
      const outcome: AgentOutcome = {
        reply: verdict.safety ? safetyReply(businessName) : handoffReply(businessName),
        escalated: true,
        toolCalls: [{ name: "escalate_to_human", input: verdict, output: { ok: true }, ms: 0 }],
        costUsd: 0,
        latencyMs: Date.now() - started,
        provider: provider.id,
        model: provider.model,
        productionGrade: provider.productionGrade,
      };
      await persistRun(tenant.id, conversation.id, opts.inboundMessageId, outcome, {
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
      }, "escalated");
      return outcome;
    }

    // Asked whether this is a person: a truthful answer is a legal
    // requirement, so it does not depend on what the model would say.
    if (verdict.disclose) {
      const outcome: AgentOutcome = {
        reply: disclosureReply(tenant.settings?.businessName ?? tenant.name),
        escalated: false,
        toolCalls: [],
        costUsd: 0,
        latencyMs: Date.now() - started,
        provider: provider.id,
        model: provider.model,
        productionGrade: provider.productionGrade,
      };
      await persistRun(tenant.id, conversation.id, opts.inboundMessageId, outcome, {
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
      }, "replied");
      return outcome;
    }
  }

  const [knowledge, memories] = await Promise.all([
    loadKnowledge(tenant.id),
    recall(contact.id),
  ]);
  const { system, context } = buildSystemPrompt({
    tenant, contact, location,
    channel: conversation.channel as Channel,
    knowledge,
    memories,
  });

  const llmHistory: LlmHistory = ordered
    .filter((m) => m.body.trim().length > 0)
    .map((m) =>
      m.direction === "inbound"
        ? ({ role: "user", content: m.body } as const)
        : ({ role: "assistant", content: m.body } as const),
    );

  if (llmHistory.length === 0) {
    llmHistory.push({ role: "user", content: "(the customer opened a conversation)" });
  }

  const toolRecords: ToolCallRecord[] = [];
  let totalIn = 0, totalOut = 0, totalCacheRead = 0;
  let escalated = false;
  let finalText = "";
  let stopReason = "end_turn";

  try {
    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const turn = await provider.complete({ system, context, history: llmHistory, tools: toolSpecs });
      totalIn += turn.usage.inputTokens;
      totalOut += turn.usage.outputTokens;
      totalCacheRead += turn.usage.cacheReadTokens;
      stopReason = turn.stopReason;

      if (turn.stopReason === "refusal") {
        finalText = "";
        escalated = true;
        await executeTool(ctx, "escalate_to_human", { reason: "model refusal", urgency: "soon" });
        break;
      }

      if (turn.toolCalls.length === 0) {
        finalText = turn.text;
        break;
      }

      llmHistory.push({
        role: "assistant",
        content: turn.text,
        toolCalls: turn.toolCalls,
      });

      for (const call of turn.toolCalls) {
        const t0 = Date.now();
        let result: unknown;
        try {
          result = await executeTool(ctx, call.name, call.input);
        } catch (err) {
          result = { ok: false, error: err instanceof Error ? err.message : "tool failed" };
        }
        const ms = Date.now() - t0;

        toolRecords.push({ name: call.name, input: call.input, output: result, ms });
        if (call.name === "escalate_to_human") escalated = true;

        llmHistory.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: JSON.stringify(result),
        });
      }

      // Keep whatever prose accompanied the tool call as a fallback reply.
      if (turn.text) finalText = turn.text;
    }
  } catch (err) {
    const message = err instanceof LlmError ? err.message : String(err);
    const outcome: AgentOutcome = {
      reply: null,
      holdReason: `model error: ${message}`,
      escalated: false,
      toolCalls: toolRecords,
      costUsd: 0,
      latencyMs: Date.now() - started,
      provider: provider.id,
      model: provider.model,
      productionGrade: provider.productionGrade,
    };
    await persistRun(
      tenant.id, conversation.id, opts.inboundMessageId, outcome,
      { inputTokens: totalIn, outputTokens: totalOut, cacheReadTokens: totalCacheRead },
      "error", message,
    );
    return outcome;
  }

  // Gate 2: is the draft safe to send?
  let holdReason: string | undefined;
  if (finalText) {
    const verdict = screenOutbound(finalText, tenant.settings ?? {}, {
      availabilityChecked: await availabilityChecked(conversation.id, toolRecords),
    });
    if (!verdict.allow) {
      holdReason = `guardrail: ${verdict.holdReason}`;
      toolRecords.push({
        name: "__guardrail", input: { text: finalText },
        output: verdict, ms: 0, blocked: verdict.holdReason,
      });
    }
  }

  const usage = { inputTokens: totalIn, outputTokens: totalOut, cacheReadTokens: totalCacheRead };
  const outcome: AgentOutcome = {
    reply: finalText || null,
    holdReason,
    escalated,
    toolCalls: toolRecords,
    costUsd: provider.costUsd(usage),
    latencyMs: Date.now() - started,
    provider: provider.id,
    model: provider.model,
    productionGrade: provider.productionGrade,
  };

  await persistRun(
    tenant.id, conversation.id, opts.inboundMessageId, outcome, usage,
    escalated ? "escalated" : holdReason ? "held" : "replied",
    undefined, stopReason,
  );

  return outcome;
}

async function persistRun(
  tenantId: string,
  conversationId: string,
  inboundMessageId: string | undefined,
  outcome: AgentOutcome,
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number },
  result: string,
  error?: string,
  stopReason?: string,
) {
  await db.insert(agentRuns).values({
    tenantId,
    conversationId,
    inboundMessageId: inboundMessageId ?? null,
    model: `${outcome.provider}:${outcome.model}`,
    toolCalls: outcome.toolCalls,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    latencyMs: outcome.latencyMs,
    costUsd: outcome.costUsd.toFixed(6),
    outcome: result,
    stopReason: stopReason ?? null,
    error: error ?? null,
  });
}
