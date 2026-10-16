import type { CompleteRequest, LlmProvider, LlmTurn, LlmUsage } from "./types";

/**
 * A provider with no model behind it, for testing the pipeline around the
 * agent: intake, threading, consent gates, delivery, jobs.
 *
 *   LLM_PROVIDER=scripted
 *
 * Replies come from a queue (`ScriptedProvider.enqueue`), falling back to a
 * fixed line. It never calls a tool, so anything a test asserts about the
 * pipeline holds regardless of model behaviour — and it runs while the GPU is
 * busy training, and gives the same answer every time.
 */
export class ScriptedProvider implements LlmProvider {
  readonly id = "scripted";
  readonly model = "scripted";
  readonly productionGrade = false;

  static readonly FALLBACK = "Thanks for getting in touch — what's the best time for us to reach you?";
  private static queue: string[] = [];
  /** Every request seen, so a test can check what the agent was given. */
  static readonly requests: CompleteRequest[] = [];

  static enqueue(...replies: string[]) {
    ScriptedProvider.queue.push(...replies);
  }

  static reset() {
    ScriptedProvider.queue = [];
    ScriptedProvider.requests.length = 0;
  }

  async complete(req: CompleteRequest): Promise<LlmTurn> {
    ScriptedProvider.requests.push(req);
    return {
      text: ScriptedProvider.queue.shift() ?? ScriptedProvider.FALLBACK,
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
    };
  }

  costUsd(_usage: LlmUsage): number {
    return 0;
  }
}
