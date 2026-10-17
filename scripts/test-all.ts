import { spawnSync } from "node:child_process";

/**
 * Every check that runs without a model or a real send, in one command:
 * typecheck, each feature suite, and the import-order test. Exits non-zero
 * if anything fails, so it can gate a commit or a CI job.
 *
 *   npm test
 */
const SUITES = [
  "intake", "reminders", "alerts", "scoring", "webchat", "webhooks", "auth", "settings",
  "email", "erasure", "campaigns", "outcomes", "digest", "calendar", "imports",
];

type Row = { name: string; ok: boolean; passed: number; seconds: number; tail: string };
const rows: Row[] = [];

function run(name: string, cmd: string, args: string[]) {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 600_000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  rows.push({
    name, ok: r.status === 0,
    passed: (out.match(/^\s+✓ /gm) ?? []).length,
    seconds: Math.round((Date.now() - t0) / 1000),
    tail: out.trim().split("\n").filter((l) => /✗|error|Error/.test(l)).slice(0, 5).join("\n"),
  });
  const last = rows[rows.length - 1];
  console.log(`${last.ok ? "✓" : "✗"} ${name.padEnd(10)} ${last.passed ? `${last.passed} checks` : ""} (${last.seconds}s)`);
  if (!last.ok && last.tail) console.log(last.tail.replace(/^/gm, "    "));
}

run("typecheck", "npx", ["tsc", "--noEmit", "-p", "."]);
for (const s of SUITES) run(s, "npm", ["run", "-s", `${s}:test`]);

const failed = rows.filter((r) => !r.ok);
const total = rows.reduce((n, r) => n + r.passed, 0);
console.log(failed.length
  ? `\n✗ ${failed.length} of ${rows.length} failed: ${failed.map((r) => r.name).join(", ")}`
  : `\n✓ all ${rows.length} passed (${total} checks)`);
process.exit(failed.length ? 1 : 0);
