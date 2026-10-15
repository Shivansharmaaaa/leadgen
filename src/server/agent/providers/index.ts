import type { LlmProvider } from "./types";
import { AnthropicProvider } from "./anthropic";
import { OllamaProvider } from "./ollama";

export * from "./types";
export { AnthropicProvider, OllamaProvider };

/**
 * Resolve the provider from the environment.
 *
 *   LLM_PROVIDER=ollama     → free local dev (default when no Claude key is present)
 *   LLM_PROVIDER=anthropic  → production
 *
 * Channel is passed so voice can run a different, faster model than chat
 * without touching any calling code.
 */
export function getProvider(channel?: string): LlmProvider {
  const explicit = process.env.LLM_PROVIDER?.toLowerCase();
  const hasClaudeKey = Boolean(process.env.ANTHROPIC_API_KEY);
  const choice = explicit ?? (hasClaudeKey ? "anthropic" : "ollama");

  if (choice === "ollama") {
    return new OllamaProvider();
  }

  const model =
    channel === "voice"
      ? process.env.LEADGEN_VOICE_MODEL ?? process.env.LEADGEN_MODEL ?? "claude-opus-5-5"
      : process.env.LEADGEN_MODEL ?? "claude-opus-5-5";

  return new AnthropicProvider(model, "low");
}
