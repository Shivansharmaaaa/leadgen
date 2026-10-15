import { OllamaProvider } from "@/server/agent/providers/ollama";
import { TOOL_DEFS } from "@/server/agent/tools";

async function main() {
  const model = process.argv[2] ?? "llama3.1:latest";
  const p = new OllamaProvider(model);
  const tools = TOOL_DEFS.map((t) => ({
    name: t.name, description: t.description ?? "", inputSchema: t.input_schema as Record<string, unknown>,
  }));
  const t0 = Date.now();
  const turn = await p.complete({
    system: "You are Alex, answering the phone for Northside Heating & Air. Be brief and conversational.",
    history: [{ role: "user", content: "Hi, my AC is blowing warm air." }],
    tools,
  });
  console.log(`  ${model.padEnd(20)} ${Date.now() - t0}ms   "${turn.text.slice(0, 60)}"`);
  process.exit(0);
}
main();
