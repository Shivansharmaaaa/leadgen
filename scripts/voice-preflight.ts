import { existsSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db, tenants } from "@/server/db";
import { VOICE_TOOLS } from "@/server/agent/voice-turn";

/**
 * Is the local voice stack actually ready? Checks what a live call depends on:
 *
 *   - the voice model is installed and answers
 *   - it emits a real tool call, not JSON in its prose
 *   - it is running on the GPU (on a Mac, Metal) rather than the CPU
 *   - the database is up and the demo tenant exists
 *
 * Exit codes for scripts/voice-local.sh: 0 ready, 1 model problem,
 * 2 database unreachable, 3 tenant not seeded.
 */
const BASE = process.env.OLLAMA_URL ?? "http://localhost:11434";
const MODEL = process.env.OLLAMA_VOICE_MODEL ?? process.env.OLLAMA_MODEL ?? "llama3.1:latest";

const ok = (s: string) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const bad = (s: string) => console.log(`  \x1b[31m✗\x1b[0m ${s}`);
const note = (s: string) => console.log(`  \x1b[33m!\x1b[0m ${s}`);

async function checkModel(): Promise<boolean> {
  const tools = VOICE_TOOLS.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL, stream: false, options: { temperature: 0 }, tools,
      messages: [
        { role: "system", content: "You book appointments for an HVAC company. Always check availability before offering times." },
        { role: "user", content: "Can someone come look at my furnace this week?" },
      ],
    }),
  }).catch((e: unknown) => { bad(`Ollama unreachable at ${BASE}: ${String(e)}`); return null; });
  if (!res) return false;
  if (!res.ok) { bad(`${MODEL}: ${res.status} ${await res.text()}`); return false; }

  const json = await res.json() as {
    message?: { content?: string; tool_calls?: { function: { name: string } }[] };
    eval_count?: number; eval_duration?: number; prompt_eval_count?: number; prompt_eval_duration?: number;
  };
  const call = json.message?.tool_calls?.[0]?.function.name;
  const tps = json.eval_count && json.eval_duration ? json.eval_count / (json.eval_duration / 1e9) : 0;
  const pps = json.prompt_eval_count && json.prompt_eval_duration
    ? json.prompt_eval_count / (json.prompt_eval_duration / 1e9) : 0;

  ok(`${MODEL} answers — generation ${tps.toFixed(0)} tok/s, prompt ${pps.toFixed(0)} tok/s`);
  if (call === "check_availability") ok(`native tool calling works (called ${call})`);
  else if (call) note(`called ${call} instead of check_availability — works, but loose`);
  else note(`no tool call on a booking request — the runtime will try to salvage JSON from prose`);

  const ps = await fetch(`${BASE}/api/ps`).then((r) => r.json() as Promise<{
    models?: { name: string; size: number; size_vram: number }[];
  }>).catch(() => ({ models: [] as { name: string; size: number; size_vram: number }[] }));
  const loaded = ps.models?.find((m) => m.name === MODEL || m.name.startsWith(`${MODEL}:`));
  // Ollama reports CPU matrix-unit buffers (Intel AMX) as VRAM too, so only
  // trust size_vram where a GPU can exist: Metal on a Mac, NVIDIA or AMD.
  const gpuPossible = process.platform === "darwin" || existsSync("/dev/nvidiactl") || existsSync("/dev/kfd");
  if (loaded && !gpuPossible) {
    note("no GPU on this machine — running on the CPU, expect slow first words");
  } else if (loaded) {
    const gpu = loaded.size ? Math.round((100 * loaded.size_vram) / loaded.size) : 0;
    if (gpu >= 99) ok(`running 100% on the GPU`);
    else if (gpu > 0) note(`split ${gpu}% GPU / ${100 - gpu}% CPU — close other GPU-heavy apps`);
    else note(`running on the CPU — expect slow first words`);
  }
  return true;
}

async function checkDatabase(): Promise<0 | 2 | 3> {
  try {
    const tenant = await db.query.tenants.findFirst({ where: eq(tenants.slug, "northside-hvac") });
    if (!tenant) { note("database is up but the demo tenant is not seeded"); return 3; }
    ok(`database ready, tenant "${tenant.name}"`);
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/relation .* does not exist/.test(msg)) { note("database is up but has no schema yet"); return 3; }
    bad(`database unreachable: ${msg}`);
    return 2;
  }
}

async function main() {
  const only = process.argv[2];
  if (only !== "--db") {
    if (!(await checkModel())) process.exit(1);
    if (only === "--model") process.exit(0);
  }
  process.exit(await checkDatabase());
}

main();
