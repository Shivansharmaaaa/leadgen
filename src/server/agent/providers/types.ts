/**
 * Provider-neutral LLM surface.
 *
 * The agent runtime talks only to this interface, so the same conversation
 * logic, tools and guardrails run against a local Ollama model for free during
 * development and against Claude in production. Swapping is one env var.
 */

export type ToolSpec = {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  inputSchema: Record<string, unknown>;
};

export type LlmToolCall = {
  /** Synthesised when the provider does not supply one (Ollama). */
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type LlmHistory = Array<
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: LlmToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string }
>;

export type LlmUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
};

export type LlmTurn = {
  text: string;
  toolCalls: LlmToolCall[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";
  usage: LlmUsage;
  raw?: unknown;
};

export type CompleteRequest = {
  system: string;
  history: LlmHistory;
  tools: ToolSpec[];
  maxTokens?: number;
};

export interface LlmProvider {
  /** "anthropic" | "ollama" | ... */
  readonly id: string;
  readonly model: string;
  /** False for local models — the UI warns that quality is not production-representative. */
  readonly productionGrade: boolean;
  complete(req: CompleteRequest): Promise<LlmTurn>;
  /**
   * Token stream for latency-sensitive channels.
   *
   * On a phone call the number that matters is time-to-first-audio, not
   * time-to-complete-reply. Streaming lets the caller hear the first sentence
   * while the rest is still being generated, which turns a 9-second wait into
   * roughly a 1-second one without the model being any faster.
   */
  stream?(req: CompleteRequest): AsyncGenerator<string, LlmTurn, undefined>;
  costUsd(usage: LlmUsage): number;
}

export class LlmError extends Error {
  constructor(message: string, readonly provider: string, readonly cause?: unknown) {
    super(message);
    this.name = "LlmError";
  }
}
