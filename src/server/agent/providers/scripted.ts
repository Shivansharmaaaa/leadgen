import type { CompleteRequest, LlmProvider, LlmToolCall, LlmTurn, LlmUsage } from "./types";

/**
 * One queued reply: plain text, a turn that calls tools, or a function of the
 * request (so a test can answer with a slot the calendar actually offered).
 */
export type ScriptedReply =
  | string
  | { text?: string; toolCalls?: Omit<LlmToolCall, "id">[] }
  | ((req: CompleteRequest) => string | { text?: string; toolCalls?: Omit<LlmToolCall, "id">[] });

/**
 * A provider with no model behind it, for testing the pipeline around the
 * agent: intake, threading, consent gates, delivery, jobs.
 *
 *   LLM_PROVIDER=scripted
 *
 * Replies come from a queue (`ScriptedProvider.enqueue`), falling back to a
 * fixed line. It calls a tool only when a queued reply says to, so anything a
 * test asserts about the pipeline holds regardless of model behaviour — and it
 * runs while the GPU is busy training, and gives the same answer every time.
 */
export class ScriptedProvider implements LlmProvider {
  readonly id = "scripted";
  readonly model = "scripted";
  readonly productionGrade = false;

  static readonly FALLBACK = "Thanks for getting in touch — what's the best time for us to reach you?";
  private static queue: ScriptedReply[] = [];
  /** Every request seen, so a test can check what the agent was given. */
  static readonly requests: CompleteRequest[] = [];

  static enqueue(...replies: ScriptedReply[]) {
    ScriptedProvider.queue.push(...replies);
  }

  static reset() {
    ScriptedProvider.queue = [];
    ScriptedProvider.requests.length = 0;
  }

  /** Replies still queued: a test can tell a turn ended earlier than it scripted. */
  static pending(): number {
    return ScriptedProvider.queue.length;
  }

  async complete(req: CompleteRequest): Promise<LlmTurn> {
    // A snapshot: the runtime pushes this turn's tool results onto the same
    // history array after the call returns.
    ScriptedProvider.requests.push({ ...req, history: [...req.history], tools: [...req.tools] });
    const next = ScriptedProvider.queue.shift() ?? ScriptedProvider.FALLBACK;
    const reply = typeof next === "function" ? next(req) : next;
    const { text = "", toolCalls = [] } = typeof reply === "string" ? { text: reply } : reply;
    const n = ScriptedProvider.requests.length;
    return {
      text,
      toolCalls: toolCalls.map((c, i) => ({ id: `scripted_${n}_${i}`, ...c })),
      stopReason: toolCalls.length ? "tool_use" : "end_turn",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
    };
  }

  costUsd(_usage: LlmUsage): number {
    return 0;
  }
}
