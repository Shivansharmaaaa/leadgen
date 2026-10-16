import { eq } from "drizzle-orm";
import { db, staff } from "@/server/db";
import { getTenant } from "@/server/settings";
import { overdueJobs } from "@/server/queries/health";

/**
 * What is set up, what isn't, and what to do about it — one command instead
 * of reading the README against .env.
 *
 *   npm run doctor
 */
type Line = { ok: boolean | "warn"; what: string; fix?: string };
const lines: Line[] = [];
const add = (ok: Line["ok"], what: string, fix?: string) => lines.push({ ok, what, fix });
const env = (k: string) => Boolean(process.env[k]?.trim());

async function main() {
  const prod = process.env.NODE_ENV === "production";

  add(env("ADMIN_PASSWORD") ? true : prod ? false : "warn", "Owner sign-in (ADMIN_PASSWORD)",
    "Set ADMIN_PASSWORD in .env. Without it the dashboard, inbox and settings are open in dev and closed in production.");
  add(env("SUPPRESSION_SECRET") ? true : "warn", "Erasure suppression key (SUPPRESSION_SECRET)",
    "Set it once to a long random value and never change it; a default key is in use.");
  add(env("ANTHROPIC_API_KEY") || process.env.LLM_PROVIDER === "anthropic" ? true : "warn", "Production model (Claude)",
    "Local Ollama is for development only. Set ANTHROPIC_API_KEY for production reply quality.");
  add(env("TWILIO_ACCOUNT_SID") && env("TWILIO_AUTH_TOKEN") ? true : false, "SMS and calls (Twilio)",
    "Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN. Texts, reminders and team alerts need it.");
  add(env("SMTP_HOST") && env("EMAIL_FROM") ? true : "warn", "Email out (SMTP_HOST, EMAIL_FROM)",
    "Needed for email replies, email reminders and the morning summary.");
  add(env("EMAIL_INBOUND_TOKEN") ? true : "warn", "Email in (EMAIL_INBOUND_TOKEN)",
    "Point your provider's inbound parse at /api/webhooks/email?token=<EMAIL_INBOUND_TOKEN>.");
  add(env("APP_URL") ? true : "warn", "Links in alerts and the summary (APP_URL)", "Set APP_URL to where the app is reachable.");

  const tenant = await getTenant();
  if (!tenant) {
    add(false, "A business to manage", "Run npm run seed (or set TENANT_SLUG).");
  } else {
    const s = tenant.settings ?? {};
    const team = await db.query.staff.findMany({ where: eq(staff.tenantId, tenant.id) });
    const reachable = team.filter((m) => m.phone && m.alerts);
    add(reachable.length > 0, `Team alerts: ${reachable.length} of ${team.length} people reachable by text`,
      "Add mobiles at /settings → Team, or nobody hears about handovers.");
    add(reachable.some((m) => m.onCall) ? true : "warn", "Someone on call for emergencies",
      "Tick 'On call' for at least one person at /settings → Team.");
    add(team.some((m) => m.email && m.alerts) ? true : "warn", "Someone to send the morning summary to",
      "Team members need an email with alerts on.");
    add(s.intakeKey ? true : "warn", "Lead intake (POST /api/leads)", "Create a key at /settings → Lead intake.");
    add(s.webchatOrigins?.length ? true : "warn", "Website chat allowed on your site",
      "List your site at /settings → Website chat.");
    add(s.webhooks?.length ? true : "warn", "CRM / Zapier webhooks", "Optional: add one at /settings → Send to your CRM.");
  }

  const overdue = await overdueJobs(tenant?.id);
  add(overdue.count === 0, overdue.count ? `Job worker: ${overdue.count} job(s) overdue (oldest ${overdue.oldestMinutes} min)` : "Job worker keeping up",
    "Run npm run worker: reminders, alerts, webhooks, campaigns and the summary depend on it.");

  for (const l of lines) {
    const mark = l.ok === true ? "✓" : l.ok === "warn" ? "!" : "✗";
    console.log(`  ${mark} ${l.what}`);
    if (l.ok !== true && l.fix) console.log(`      ${l.fix}`);
  }
  const bad = lines.filter((l) => l.ok === false).length;
  const warn = lines.filter((l) => l.ok === "warn").length;
  console.log(`\n${bad ? `${bad} to fix` : "Nothing blocking"}${warn ? `, ${warn} worth doing` : ""}.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
