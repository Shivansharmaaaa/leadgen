import { mkdirSync, writeFileSync } from "node:fs";
import { SCENARIOS } from "@/server/eval/scenarios";
import { runEval } from "@/server/eval/runner";

const GREEN = "\x1b[32m", RED = "\x1b[31m", DIM = "\x1b[2m", RESET = "\x1b[0m", BOLD = "\x1b[1m";

/**
 *   npm run eval                      every scenario on its own channel
 *   npm run eval -- price,legal       only scenarios whose id contains "price" or "legal"
 *   npm run eval -- --voice           every scenario as a phone call, through
 *                                     the streaming path the live call uses
 *   npm run eval -- --tag lora-r16    label the run in the saved JSON
 */
async function main() {
  const args = process.argv.slice(2);
  const voice = args.includes("--voice");
  const tagAt = args.indexOf("--tag");
  const tag = tagAt >= 0 ? args[tagAt + 1] : undefined;
  const only = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--tag");

  const filters = only?.split(",").filter(Boolean) ?? [];
  let scenarios = filters.length ? SCENARIOS.filter((s) => filters.some((f) => s.id.includes(f))) : SCENARIOS;
  if (voice) scenarios = scenarios.map((s) => ({ ...s, channel: "voice" as const }));

  console.log(`\n${BOLD}LEADGEN EVAL${RESET}  —  ${scenarios.length} scenarios${voice ? " (all as voice)" : ""}\n`);

  const report = await runEval("northside-hvac", scenarios);

  console.log(`provider: ${report.provider}:${report.model}` +
    (report.productionGrade ? "" : `  ${DIM}(local model — not production-representative)${RESET}`));
  console.log("─".repeat(76));

  for (const r of report.scenarios) {
    const icon = r.passed ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
    console.log(`\n${icon}  ${r.scenario.name}  ${DIM}[${r.scenario.id}]${RESET}`);

    if (!r.passed) {
      console.log(`      ${DIM}stake: ${r.scenario.stake}${RESET}`);
      for (const c of r.results.filter((x) => !x.passed)) {
        console.log(`      ${RED}✗${RESET} ${describe(c.check)}${c.detail ? ` ${DIM}— ${c.detail}${RESET}` : ""}`);
      }
      if (r.reply) console.log(`      ${DIM}reply: "${r.reply.slice(0, 160)}"${RESET}`);
      if (r.error) console.log(`      ${RED}error: ${r.error}${RESET}`);
    }
  }

  console.log("\n" + "─".repeat(76));
  const pct = (report.passRate * 100).toFixed(0);
  const colour = report.passRate >= 0.9 ? GREEN : RED;
  console.log(
    `${BOLD}${colour}${pct}% scenarios passed${RESET}  ` +
    `(${report.checksPassed}/${report.checksTotal} checks)`,
  );
  console.log(
    `latency p50 ${report.p50LatencyMs}ms · p95 ${report.p95LatencyMs}ms · ` +
    (report.p50FirstWordMs !== null ? `first word p50 ${report.p50FirstWordMs}ms · ` : "") +
    `cost $${report.totalCostUsd.toFixed(4)}`,
  );

  // Every run is kept so model and prompt changes can be compared afterwards.
  mkdirSync("data/eval", { recursive: true });
  const file = `data/eval/${new Date().toISOString().replace(/[:.]/g, "-")}` +
    `_${report.model.replace(/[^a-z0-9.-]/gi, "_")}${tag ? `_${tag}` : ""}.json`;
  writeFileSync(file, JSON.stringify({ tag, voice, ...report }, null, 2));
  console.log(`${DIM}saved ${file}${RESET}\n`);

  process.exit(report.passRate >= 0.9 ? 0 : 1);
}

function describe(c: { type: string } & Record<string, unknown>): string {
  switch (c.type) {
    case "calls_tool": return `should call ${c.tool}`;
    case "does_not_call_tool": return `should NOT call ${c.tool}`;
    case "escalates": return "should escalate to a human";
    case "does_not_escalate": return "should NOT escalate";
    case "reply_matches": return `reply should match /${c.pattern}/`;
    case "reply_avoids": return `reply should avoid /${c.pattern}/`;
    case "no_unverified_price": return "must not invent a price";
    case "held_by_guardrail": return "should be held by a guardrail";
    case "not_held": return "should not be held";
    case "max_latency_ms": return `under ${c.ms}ms`;
    case "creates_lead": return "should create a lead row";
    case "books_appointment": return "should book an appointment";
    default: return c.type;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
