import type { LlmProvider } from "./types";
import { AnthropicProvider } from "./anthropic";
import { OllamaProvider } from "./ollama";
import { ScriptedProvider } from "./scripted";

export * from "./types";
export { AnthropicProvider, OllamaProvider, ScriptedProvider };

/**
 * Resolve the provider from the environment.
 *
 *   LLM_PROVIDER=ollama     → free local dev (default when no Claude key is present)
 *   LLM_PROVIDER=anthropic  → production
 *   LLM_PROVIDER=scripted   → no model at all, for pipeline tests
 *
 * Channel is passed so voice can run a different, faster model than chat
 * without touching any calling code.
 */
export function getProvider(channel?: string): LlmProvider {
  const explicit = process.env.LLM_PROVIDER?.toLowerCase();
  const hasClaudeKey = Boolean(process.env.ANTHROPIC_API_KEY);
  const choice = explicit ?? (hasClaudeKey ? "anthropic" : "ollama");

  if (choice === "scripted") return new ScriptedProvider();

  if (choice === "ollama") {
    // A smaller local model for voice: on a call, time-to-first-word matters
    // more than the last few points of quality.
    const model = channel === "voice"
      ? process.env.OLLAMA_VOICE_MODEL ?? process.env.OLLAMA_MODEL
      : process.env.OLLAMA_MODEL;
    return new OllamaProvider(model);
  }

  const model =
    channel === "voice"
      ? process.env.LEADGEN_VOICE_MODEL ?? process.env.LEADGEN_MODEL ?? "claude-opus-5-5"
      : process.env.LEADGEN_MODEL ?? "claude-opus-5-5";

  return new AnthropicProvider(model, "low");
}
