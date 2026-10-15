import Anthropic from "@anthropic-ai/sdk";
import type {
  CompleteRequest, LlmProvider, LlmTurn, LlmUsage, LlmToolCall,
} from "./types";
import { LlmError } from "./types";

/** Published per-MTok rates, used for the per-conversation cost column. */
const PRICING: Record<string, { in: number; out: number; cacheRead: number }> = {
  "claude-opus-5-5": { in: 4.0, out: 20.0, cacheRead: 0.2 },
  "claude-opus-5": { in: 5.0, out: 25.0, cacheRead: 0.5 },
  "claude-sonnet-5-5": { in: 2.0, out: 10.0, cacheRead: 0.2 },
  "claude-haiku-4-5": { in: 1.0, out: 5.0, cacheRead: 0.1 },
};

export class AnthropicProvider implements LlmProvider {
  readonly id = "anthropic";
  readonly productionGrade = true;
  private client: Anthropic;

  constructor(
    readonly model = process.env.LEADGEN_MODEL ?? "claude-opus-5-5",
    /**
     * Conversational replies are latency-sensitive and not reasoning-heavy.
     * Opus 5.5 defaults to `medium`; `low` is the right call here and the docs
     * ask for it to be set explicitly rather than left implicit.
     */
    private effort: "low" | "medium" | "high" = "low",
  ) {
    // Resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile.
    this.client = new Anthropic();
  }

  async complete(req: CompleteRequest): Promise<LlmTurn> {
    const tools: Anthropic.Tool[] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      strict: true,
    }));

    try {
      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: req.maxTokens ?? 2048,
        // Business facts and persona are stable across a conversation — cache them.
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        output_config: { effort: this.effort },
        tools,
        messages: toAnthropicMessages(req.history),
      });

      if (res.stop_reason === "refusal") {
        return {
          text: "", toolCalls: [], stopReason: "refusal",
          usage: usageOf(res), raw: res,
        };
      }

      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text).join("").trim();

      const toolCalls: LlmToolCall[] = res.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
        .map((b) => ({ id: b.id, name: b.name, input: b.input as Record<string, unknown> }));

      return {
        text,
        toolCalls,
        stopReason:
          res.stop_reason === "tool_use" ? "tool_use"
          : res.stop_reason === "max_tokens" ? "max_tokens"
          : res.stop_reason === "end_turn" ? "end_turn"
          : "other",
        usage: usageOf(res),
        raw: res,
      };
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) {
        throw new LlmError("Claude rejected the credentials — set ANTHROPIC_API_KEY or run `ant auth login`.", this.id, err);
      }
      if (err instanceof Anthropic.RateLimitError) {
        throw new LlmError("Claude rate limit hit; retry shortly.", this.id, err);
      }
      if (err instanceof Anthropic.APIConnectionError) {
        throw new LlmError("Could not reach the Claude API.", this.id, err);
      }
      throw new LlmError(err instanceof Error ? err.message : "Claude request failed", this.id, err);
    }
  }

  costUsd(u: LlmUsage): number {
    const p = PRICING[this.model] ?? PRICING["claude-opus-5-5"];
    return (
      (u.inputTokens / 1e6) * p.in +
      (u.outputTokens / 1e6) * p.out +
      (u.cacheReadTokens / 1e6) * p.cacheRead
    );
  }
}

function usageOf(res: Anthropic.Message): LlmUsage {
  return {
    inputTokens: res.usage.input_tokens ?? 0,
    outputTokens: res.usage.output_tokens ?? 0,
    cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
  };
}

/** Rebuild Anthropic's content-block shape from the neutral history. */
function toAnthropicMessages(history: CompleteRequest["history"]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];

  for (const entry of history) {
    if (entry.role === "user") {
      out.push({ role: "user", content: entry.content });
      continue;
    }

    if (entry.role === "assistant") {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (entry.content) blocks.push({ type: "text", text: entry.content });
      for (const tc of entry.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
      }
      if (blocks.length) out.push({ role: "assistant", content: blocks });
      continue;
    }

    // Consecutive tool results must be collapsed into ONE user message, or the
    // model learns to stop issuing parallel tool calls.
    const block: Anthropic.ToolResultBlockParam = {
      type: "tool_result",
      tool_use_id: entry.toolCallId,
      content: entry.content,
    };
    const last = out[out.length - 1];
    if (last && last.role === "user" && Array.isArray(last.content)) {
      (last.content as Anthropic.ContentBlockParam[]).push(block);
    } else {
      out.push({ role: "user", content: [block] });
    }
  }

  return out;
}
