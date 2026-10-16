import type {
  CompleteRequest, LlmProvider, LlmTurn, LlmUsage, LlmToolCall,
} from "./types";
import { LlmError } from "./types";

/**
 * Local model via Ollama. Free, offline, and good enough to prove the pipeline
 * end to end — ingest, identity resolution, tool execution, guardrails, booking.
 *
 * It is NOT quality-representative of production. An 8B local model follows
 * tool schemas loosely and invents facts more readily, which is exactly the
 * failure mode this product cannot ship. Use it to test plumbing; measure real
 * reply quality on Claude.
 */
export class OllamaProvider implements LlmProvider {
  readonly id = "ollama";
  readonly productionGrade = false;

  constructor(
    readonly model = process.env.OLLAMA_MODEL ?? "llama3.1:latest",
    private baseUrl = process.env.OLLAMA_URL ?? "http://localhost:11434",
    private temperature = 0.2,
  ) {}

  async complete(req: CompleteRequest): Promise<LlmTurn> {
    const body = {
      model: this.model,
      stream: false,
      options: { temperature: this.temperature, num_ctx: 8192 },
      messages: [
        { role: "system", content: systemContent(req) },
        ...toOllamaMessages(req.history),
      ],
      tools: req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      })),
    };

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      throw new LlmError(
        `Could not reach Ollama at ${this.baseUrl}. Is \`ollama serve\` running?`,
        this.id, err,
      );
    }

    if (!res.ok) {
      throw new LlmError(`Ollama returned ${res.status}: ${await res.text()}`, this.id);
    }

    const json = (await res.json()) as OllamaChatResponse;
    const rawCalls = json.message?.tool_calls ?? [];
    let text = (json.message?.content ?? "").trim();

    const toolCalls: LlmToolCall[] = rawCalls.map((c, i) => ({
      // Ollama does not issue call ids; synthesise stable ones for this turn.
      id: `ollama_${Date.now()}_${i}`,
      name: c.function.name,
      input: coerceArgs(c.function.arguments),
    }));

    // Small models intermittently emit a tool call as literal JSON in the
    // message body instead of in tool_calls. Left alone the call silently
    // never runs and the raw JSON is shown to the customer. Salvage it.
    let kept = keepOffered(toolCalls, req.tools.map((t) => t.name));

    if (kept.length === 0) {
      const salvaged = salvageTextToolCall(text, req.tools.map((t) => t.name));
      if (salvaged) {
        kept = [{ id: `ollama_salvaged_${Date.now()}`, ...salvaged.call }];
        text = salvaged.remainingText;
      }
    }
    toolCalls.length = 0;
    toolCalls.push(...kept);

    return {
      text,
      toolCalls,
      stopReason: toolCalls.length > 0 ? "tool_use"
        : json.done_reason === "length" ? "max_tokens"
        : "end_turn",
      usage: {
        inputTokens: json.prompt_eval_count ?? 0,
        outputTokens: json.eval_count ?? 0,
        cacheReadTokens: 0,
      },
      raw: json,
    };
  }

  /**
   * Stream tokens as they are generated. Yields text deltas; returns the
   * assembled turn when finished.
   */
  async *stream(req: CompleteRequest): AsyncGenerator<string, LlmTurn, undefined> {
    const body = {
      model: this.model,
      stream: true,
      options: { temperature: this.temperature, num_ctx: 8192 },
      messages: [{ role: "system", content: systemContent(req) }, ...toOllamaMessages(req.history)],
      tools: req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      })),
    };

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      throw new LlmError(
        `Could not reach Ollama at ${this.baseUrl}. Is \`ollama serve\` running?`,
        this.id, err,
      );
    }
    if (!res.ok || !res.body) {
      // Surfaces "model 'x' not found" rather than a bare status code.
      throw new LlmError(`Ollama stream failed: ${res.status} ${await res.text()}`, this.id);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    const toolCalls: LlmToolCall[] = [];
    let usage: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    let doneReason: string | undefined;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Ollama emits newline-delimited JSON, one object per token batch.
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;

        let chunk: OllamaChatResponse;
        try { chunk = JSON.parse(line) as OllamaChatResponse; } catch { continue; }

        const delta = chunk.message?.content ?? "";
        if (delta) { text += delta; yield delta; }

        for (const [i, c] of (chunk.message?.tool_calls ?? []).entries()) {
          toolCalls.push({
            id: `ollama_${Date.now()}_${i}`,
            name: c.function.name,
            input: coerceArgs(c.function.arguments),
          });
        }
        if (chunk.prompt_eval_count) usage.inputTokens = chunk.prompt_eval_count;
        if (chunk.eval_count) usage.outputTokens = chunk.eval_count;
        if (chunk.done_reason) doneReason = chunk.done_reason;
      }
    }

    let kept = keepOffered(toolCalls, req.tools.map((t) => t.name));
    if (kept.length === 0) {
      const salvaged = salvageTextToolCall(text, req.tools.map((t) => t.name));
      if (salvaged) kept = [{ id: `ollama_salvaged_${Date.now()}`, ...salvaged.call }];
    }
    toolCalls.length = 0;
    toolCalls.push(...kept);

    return {
      text: text.trim(),
      toolCalls,
      stopReason: toolCalls.length > 0 ? "tool_use" : doneReason === "length" ? "max_tokens" : "end_turn",
      usage,
    };
  }

  /** Local inference has no marginal API cost. Hardware time is not metered here. */
  costUsd(_u: LlmUsage): number {
    return 0;
  }
}

type OllamaChatResponse = {
  message?: {
    role: string;
    content?: string;
    tool_calls?: { function: { name: string; arguments: unknown } }[];
  };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
};

/**
 * Context goes after the stable system text, never before it: Ollama reuses
 * the KV cache only up to the first token that differs from the last request.
 */
function systemContent(req: CompleteRequest): string {
  return req.context ? `${req.system}\n\n${req.context}` : req.system;
}

/** Small models sometimes emit arguments as a JSON string rather than an object. */
function coerceArgs(args: unknown): Record<string, unknown> {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      /* fall through — the runtime validates and reports a tool error */
    }
  }
  return {};
}

function toOllamaMessages(history: CompleteRequest["history"]) {
  return history.map((entry) => {
    if (entry.role === "user") return { role: "user", content: entry.content };
    if (entry.role === "assistant") {
      return {
        role: "assistant",
        content: entry.content,
        ...(entry.toolCalls?.length
          ? {
              tool_calls: entry.toolCalls.map((tc) => ({
                function: { name: tc.name, arguments: tc.input },
              })),
            }
          : {}),
      };
    }
    return { role: "tool", content: entry.content, tool_name: entry.name };
  });
}

/**
 * Recover a tool call the model wrote into its prose.
 *
 * Accepts the shapes small models actually produce:
 *   {"name": "x", "parameters": {...}}
 *   {"name": "x", "arguments": {...}}
 *   {"function": {"name": "x", "arguments": {...}}}
 * Only ever matches a name the model was actually offered, so arbitrary JSON
 * in a customer message can never be turned into a tool invocation.
 */
export function salvageTextToolCall(
  text: string,
  allowedNames: string[],
): { call: { name: string; input: Record<string, unknown> }; remainingText: string } | null {
  if (!text.includes("{") || !text.includes('"name"') && !text.includes('"function"')) return null;

  // Repair before extracting: a dropped `":` after the arguments key also
  // throws off quote tracking, so brace matching on the raw text fails too.
  const repaired = repairToolJson(text);

  for (const candidate of extractJsonObjects(repaired)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;

    const obj = parsed as Record<string, unknown>;
    const inner = (obj.function ?? obj) as Record<string, unknown>;
    const name = typeof inner.name === "string" ? inner.name : null;
    if (!name || !allowedNames.includes(name)) continue;

    const rawArgs = inner.parameters ?? inner.arguments ?? inner.input ?? {};
    const input = coerceArgs(rawArgs);

    return {
      call: { name, input },
      remainingText: repaired.replace(candidate, "").trim(),
    };
  }
  return null;
}

/**
 * Fix the near-JSON 3B models emit when they type a tool call as text, e.g.
 *   {"name":"qualify_lead","parameters{"service":"AC repair"}}
 * Only the key that introduces the arguments object is touched; anything
 * else that fails to parse is still rejected.
 */
export function repairToolJson(text: string): string {
  return text.replace(/"(parameters|arguments|input)\s*(?:"\s*)?:?\s*\{/g, '"$1":{');
}

/** Walk the string tracking brace depth so nested objects stay intact. */
function extractJsonObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  return out;
}

/**
 * Drop tool calls for tools that were not offered on this request.
 *
 * Small models reach for tools they remember rather than tools they were
 * given: with a three-tool request, llama3.2:3b still emitted
 * `save_contact_detail`. Executing it anyway means running work the caller is
 * waiting through, for a tool the caller's turn deliberately excluded —
 * and it silently defeats any precondition gating upstream.
 */
function keepOffered(calls: LlmToolCall[], offered: string[]): LlmToolCall[] {
  const allowed = new Set(offered);
  return calls.filter((c) => {
    if (allowed.has(c.name)) return true;
    console.warn(`[ollama] dropped unoffered tool call "${c.name}"`);
    return false;
  });
}
