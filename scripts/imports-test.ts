import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Load every entry point FIRST, each in a fresh process.
 *
 * An import cycle only bites when a particular module is loaded before the
 * others: tools.ts -> reminders -> ingest -> runtime -> tools crashed
 * /api/voice/stream on every request, while the Twilio webhooks (which load
 * ingest.ts first) kept working. Typecheck does not see this, and neither
 * does a test that happens to import things in a lucky order.
 *
 *   npm run imports:test
 */
const ENTRIES = [
  "@/server/agent/voice-turn", "@/server/agent/tools", "@/server/agent/runtime",
  "@/server/core/ingest", "@/server/core/deliver", "@/server/eval/runner",
  "@/server/jobs/handlers", "@/server/jobs/worker", "@/server/queries/dashboard",
  "@/server/features/reminders", "@/server/features/staff-alerts", "@/server/features/lead-intake",
  "@/server/features/scoring", "@/server/features/missed-call", "@/server/features/reviews",
  "@/server/features/webchat", "@/server/features/webhooks",
  "@/app/api/voice/stream/route", "@/app/api/voice/turn/route", "@/app/api/voice/stt/route",
  "@/app/api/voice/tts/route", "@/app/api/webhooks/twilio/voice/route",
  "@/app/api/webhooks/twilio/sms/route", "@/app/api/webhooks/twilio/status/route",
  "@/app/api/inbox/route", "@/app/api/leads/route", "@/app/api/chat/route",
  "@/app/api/auth/login/route", "@/app/api/auth/logout/route", "@/middleware",
  "@/server/settings", "@/app/settings/actions",
  "@/server/channels/email", "@/app/api/webhooks/email/route",
  "@/server/features/erasure", "@/server/core/suppression", "@/server/core/identity",
  "@/server/features/campaigns", "@/app/dashboard/actions", "@/server/features/appointment-outcomes",
  "@/server/features/digest", "@/server/jobs/schedule", "@/server/queries/source-roi",
  "@/server/queries/health", "@/app/api/health/route",
];

const dir = mkdtempSync(join(process.cwd(), "scripts", ".imports-"));
let failed = 0;
try {
  for (const entry of ENTRIES) {
    const file = join(dir, "probe.ts");
    writeFileSync(file, `export {};\nawait import(${JSON.stringify(entry)});\n`);
    const r = spawnSync("npx", ["tsx", "--env-file=.env", file], { encoding: "utf8", timeout: 60_000 });
    const ok = r.status === 0;
    if (!ok) failed++;
    const why = ok ? "" : `  — ${(r.stderr || r.stdout).split("\n").find((l) => /Error/.test(l)) ?? `exit ${r.status}`}`;
    console.log(`  ${ok ? "✓" : "✗"} ${entry}${why}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `\n✗ ${failed} entry point(s) fail to load` : `\n✓ all ${ENTRIES.length} entry points load first without error`);
process.exit(failed ? 1 : 0);
