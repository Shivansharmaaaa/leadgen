import { readFileSync, writeFileSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import {
  db, tenants, locations, knowledgeFacts, knowledgeDocs, contacts, appointments, jobs,
} from "@/server/db";
import { POST } from "@/app/api/voice/stream/route";
import { ScriptedProvider, type CompleteRequest, type LlmHistory, type ToolSpec } from "@/server/agent/providers";
import { screenSentence } from "@/server/agent/voice-turn";
import { cleanContinuation } from "@/server/agent/fast-path";

/**
 * Render fine-tuning prompts with the production voice code.
 *
 * The overnight run trained on prompts assembled in Python: every tool always
 * on offer, tool results carried across turns, no calendar note. Production
 * does none of that, and 853 of its targets called tools the voice model is
 * never offered. Copying the production logic into Python would drift again
 * the next time voice-turn.ts changes, so this replays each scripted dialogue
 * through the real `POST /api/voice/stream` handler and records exactly what
 * the model is handed on every turn: system, per-turn context, history and
 * the tools offered on that turn.
 *
 *   npx tsx --env-file=.env scripts/finetune-render.ts [dialogues.jsonl] [rendered.jsonl]
 *
 * The provider is scripted: each planned reply is returned as the model's
 * output, with slot placeholders filled from the calendar note it was shown.
 * A planned reply the turn could not have produced is not a row: a tool that
 * was not offered, a sentence screenSentence would change, a reply Gate 2
 * would hold. Turns answered by rule (Gate 1, disclosure, scope, a canned
 * fact, a callback yes, opt-out) never reach the model and give no row.
 *
 * Nothing is sent: Twilio and SMTP are switched off, the replay runs against
 * copies of the tenants ("<slug>-ft") that are deleted at the end, every job
 * a booking schedules is deleted after its turn, and the clock is moved
 * forward a day or more, so nothing scheduled is ever due.
 */
process.env.LLM_PROVIDER = "scripted";
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.SMTP_HOST;

// ─── A clock each dialogue can set, and a seeded Math.random ───────────────

const RealDate = Date;
let clockOffset = 0;
class ShiftedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(RealDate.now() + clockOffset);
    else super(...(args as [string]));
  }
  static now() { return RealDate.now() + clockOffset; }
  // Dates parsed by the pg driver are RealDates; they are still Dates.
  static [Symbol.hasInstance](x: unknown) { return x instanceof RealDate; }
}
globalThis.Date = ShiftedDate as unknown as DateConstructor;

let randState = 1;
Math.random = () => {
  randState = (randState * 1664525 + 1013904223) >>> 0;
  return randState / 2 ** 32;
};

// ─── Dialogue scripts (written by finetune/dialogues.py) ───────────────────

type PlannedCall = { name: string; arguments: Record<string, unknown> };
type Planned = { kind: string; content?: string; tool_calls?: PlannedCall[]; offer?: [number, number] };
type Turn = { caller: string; agent: Planned[]; pick?: "a" | "b"; expect_rule?: boolean };
type Dialogue = {
  id: string; tenant: string; source: string; group: string;
  clock: { days: number; hour: number; minute: number };
  busy?: number;
  outbound?: { name?: string; interest?: string };
  turns: Turn[];
};
type Row = {
  id: string; source: string; kind: string; group: string; tenant: string; tier: "chat" | "transact";
  system: string; context: string | null; history: LlmHistory; tools: ToolSpec[];
  target: { content: string } | { tool_calls: PlannedCall[] };
};
type Slot = { starts_at: string; label: string };

const tally = new Map<string, number>();
const count = (k: string) => tally.set(k, (tally.get(k) ?? 0) + 1);
const examples = new Map<string, string[]>();
const problem = (k: string, detail: string) => {
  count(`drop:${k}`);
  const seen = examples.get(k) ?? [];
  if (seen.length < 6) examples.set(k, [...seen, detail]);
};

function slotsFrom(context: string | undefined): Slot[] | null {
  const m = context?.match(/# Open slots, checked just now\n(\{.*\})\n/);
  if (!m) return null;
  return (JSON.parse(m[1]) as { slots?: Slot[] }).slots ?? [];
}

/** "today at 3 PM", "tomorrow at 9:30 AM", "Tuesday at 10 AM". */
function spoken(s: Slot, tz: string): string {
  const at = new Date(s.starts_at);
  const day = formatInTimeZone(at, tz, "yyyy-MM-dd");
  const today = formatInTimeZone(new Date(), tz, "yyyy-MM-dd");
  const tomorrow = formatInTimeZone(new Date(Date.now() + 86400_000), tz, "yyyy-MM-dd");
  const when = day === today ? "today" : day === tomorrow ? "tomorrow" : formatInTimeZone(at, tz, "EEEE");
  return `${when} at ${formatInTimeZone(at, tz, "h:mm a").replace(":00", "")}`;
}

/** How a caller names it back: "Tuesday at 10", "tomorrow at 9:30". */
function short(s: Slot, tz: string): string {
  return spoken(s, tz).replace(/\s?[AP]M$/, "");
}

function fill(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}

const unfilled = (s: string) => /\{\w+\}/.test(s);

// ─── Tenants to replay against ─────────────────────────────────────────────

/** A copy of a tenant's set-up, identical in everything the prompt reads. */
async function cloneTenant(slug: string) {
  const src = await db.query.tenants.findFirst({ where: eq(tenants.slug, slug) });
  if (!src) throw new Error(`tenant ${slug} not found — run npm run seed and scripts/seed-verticals.ts`);
  const copySlug = `${slug}-ft`;
  await db.delete(tenants).where(eq(tenants.slug, copySlug));
  const { id: _id, createdAt: _c, slug: _s, ...rest } = src;
  // No webhooks: a booking would otherwise queue a delivery to the CRM.
  const settings = { ...(rest.settings ?? {}), webhooks: [] };
  const [copy] = await db.insert(tenants).values({ ...rest, slug: copySlug, settings }).returning();
  const strip = <T extends { id: string; tenantId: string }>(rows: T[]) =>
    rows.map(({ id: _i, ...r }) => ({ ...r, tenantId: copy.id }));
  const [locs, facts, docs] = await Promise.all([
    db.query.locations.findMany({ where: eq(locations.tenantId, src.id) }),
    db.query.knowledgeFacts.findMany({ where: eq(knowledgeFacts.tenantId, src.id) }),
    db.query.knowledgeDocs.findMany({ where: eq(knowledgeDocs.tenantId, src.id) }),
  ]);
  if (locs.length) await db.insert(locations).values(strip(locs));
  if (facts.length) await db.insert(knowledgeFacts).values(strip(facts));
  if (docs.length) await db.insert(knowledgeDocs).values(strip(docs));
  // No staff at all: nobody can be paged from a replay.
  const location = await db.query.locations.findFirst({ where: eq(locations.tenantId, copy.id) });
  return { tenant: copy, tz: location?.timezone ?? copy.timezone, location };
}

type Clone = Awaited<ReturnType<typeof cloneTenant>>;

/** Book some of the next week on a placeholder contact, so offers vary. */
async function fillCalendar(c: Clone, fraction: number) {
  if (!fraction || !c.location) return;
  const [holder] = await db.insert(contacts).values({ tenantId: c.tenant.id, displayName: "Existing booking" }).returning();
  const rows: (typeof appointments.$inferInsert)[] = [];
  for (let d = 0; d < 7; d++) {
    const day = formatInTimeZone(new Date(Date.now() + d * 86400_000), c.tz, "yyyy-MM-dd");
    const weekday = Number(formatInTimeZone(fromZonedTime(`${day}T12:00:00`, c.tz), c.tz, "i")) % 7;
    for (const w of c.location.hours.filter((h) => h.day === weekday)) {
      let t = fromZonedTime(`${day}T${w.open}:00`, c.tz);
      const close = fromZonedTime(`${day}T${w.close}:00`, c.tz);
      while (t.getTime() + 3600_000 <= close.getTime()) {
        if (Math.random() < fraction) {
          rows.push({ tenantId: c.tenant.id, contactId: holder.id, service: "Existing booking", status: "confirmed",
            startsAt: t, endsAt: new Date(t.getTime() + 3600_000) });
          t = new Date(t.getTime() + 3600_000);
        } else t = new Date(t.getTime() + 1800_000);
      }
    }
  }
  if (rows.length) await db.insert(appointments).values(rows);
}

// ─── Replay ────────────────────────────────────────────────────────────────

async function post(body: Record<string, unknown>) {
  const res = await POST(new Request("http://localhost/api/voice/stream", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  const text = await res.text();
  if (res.status !== 200) throw new Error(`voice route ${res.status}: ${text.slice(0, 200)}`);
  return text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)) as {
    type: string; text?: string; name?: string; ok?: boolean; provider?: string; reason?: string; message?: string;
  });
}

async function replay(d: Dialogue, clone: Clone, out: Row[]) {
  const { tz } = clone;
  // The dialogue's own clock: N days ahead, at a set local time of day.
  clockOffset = 0;
  const day = formatInTimeZone(new Date(RealDate.now() + d.clock.days * 86400_000), tz, "yyyy-MM-dd");
  const hhmm = `${String(d.clock.hour).padStart(2, "0")}:${String(d.clock.minute).padStart(2, "0")}`;
  clockOffset = fromZonedTime(`${day}T${hhmm}:00`, tz).getTime() - RealDate.now();
  if (clockOffset < 3600_000) throw new Error(`${d.id}: the clock must move forward (days >= 1)`);
  await fillCalendar(clone, d.busy ?? 0);

  const sessionId = `ft_${d.id}`;
  const vars: Record<string, string> = {};
  // Set inside the provider callback, so TypeScript cannot see it change.
  let offered = null as Slot[] | null;

  if (d.outbound) await post({ sessionId, tenant: clone.tenant.slug, outbound: d.outbound });

  for (const [ti, turn] of d.turns.entries()) {
    if (turn.pick && offered) {
      const s: Slot = turn.pick === "a" ? offered[0] : offered[1];
      Object.assign(vars, { pick: spoken(s, tz), pick_iso: s.starts_at, pick_short: short(s, tz) });
    }
    const filled = fill(turn.caller, vars);
    const said = filled.charAt(0).toUpperCase() + filled.slice(1);
    if (unfilled(said)) { problem("caller_unfilled", `${d.id}#${ti}: ${said}`); return; }

    ScriptedProvider.reset();
    const turnRows: Row[] = [];
    let bad: string | null = null;
    let bookedThisTurn = false;

    for (const plan of turn.agent) {
      ScriptedProvider.enqueue((req: CompleteRequest) => {
        const offeredNames = req.tools.map((t) => t.name);
        const tier: Row["tier"] = req.tools.length === 0 && req.context === undefined ? "chat" : "transact";
        const base: Omit<Row, "target"> = { id: d.id, source: d.source, kind: plan.kind, group: d.group, tenant: d.tenant,
          tier, system: req.system, context: req.context ?? null, history: [...req.history], tools: req.tools };
        if (plan.tool_calls) {
          const calls = plan.tool_calls.map((c) => ({
            name: c.name,
            arguments: JSON.parse(fill(JSON.stringify(c.arguments), vars)) as Record<string, unknown>,
          }));
          const missing = calls.find((c) => !offeredNames.includes(c.name));
          if (missing) bad ??= `unoffered:${missing.name}|${plan.kind}|offered=${offeredNames.join(",") || "none"}`;
          else if (calls.some((c) => unfilled(JSON.stringify(c.arguments)))) bad ??= `args_unfilled|${plan.kind}`;
          else {
            if (calls.some((c) => c.name === "book_appointment")) bookedThisTurn = true;
            turnRows.push({ ...base, target: { tool_calls: calls } });
            return { toolCalls: calls.map((c) => ({ name: c.name, input: c.arguments })) };
          }
          return { text: "" };
        }
        let text = plan.content ?? "";
        if (plan.offer) {
          const slots = slotsFrom(req.context);
          if (!slots) { bad ??= `no_slots_note|${plan.kind}|tier=${tier}`; return { text: "" }; }
          if (slots.length < 2) { bad ??= `too_few_slots|${plan.kind}`; return { text: "" }; }
          const pick = (i: number) => slots[Math.min(i, slots.length - 1)];
          offered = [pick(plan.offer[0]), pick(plan.offer[1])];
          if (offered[0].starts_at === offered[1].starts_at) offered = [slots[0], slots[1]];
          Object.assign(vars, {
            a: spoken(offered[0], tz), b: spoken(offered[1], tz),
            a_short: short(offered[0], tz), b_short: short(offered[1], tz),
          });
        }
        text = fill(text, vars);
        if (unfilled(text)) { bad ??= `content_unfilled|${plan.kind}: ${text}`; return { text: "" }; }
        // An opener was already spoken: the model's words are the continuation.
        if (req.context?.includes("# Already said")) text = cleanContinuation(text, true);
        const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
        const changed = sentences.find((s) => screenSentence(s, bookedThisTurn) !== s);
        if (changed) bad ??= `screened|${plan.kind}: ${changed}`;
        turnRows.push({ ...base, target: { content: text } });
        return { text };
      });
    }

    const events = await post({ sessionId, tenant: clone.tenant.slug, text: said });
    // Whatever a booking scheduled goes at once; nothing from a replay may run.
    await db.delete(jobs).where(eq(jobs.tenantId, clone.tenant.id));

    const made = ScriptedProvider.requests.length;
    const done = events.find((e) => e.type === "done");
    if (made === 0) {
      count(`ruled:${done?.provider ?? "none"}`);
      // Answered by rule where a reply was planned: the history now holds the
      // rule's words. Later turns that needed this one's slots stop on their own.
      if (!turn.expect_rule) problem(`unplanned_rule:${done?.provider}`, `${d.id}#${ti}: "${said}"`);
      continue;
    }
    if (turn.expect_rule) { problem("expected_rule_but_model", `${d.id}#${ti}: "${said}"`); return; }
    const held = events.find((e) => e.type === "held");
    const failedTool = events.find((e) => e.type === "tool" && e.ok === false);
    const error = events.find((e) => e.type === "error");
    if (bad) { problem((bad as string).split(/[|:]/)[0], `${d.id}#${ti}: ${bad}`); return; }
    if (error) { problem("error", `${d.id}#${ti}: ${error.message}`); return; }
    if (held) { problem("held", `${d.id}#${ti}: ${held.reason}`); return; }
    if (failedTool) { problem(`tool_failed:${failedTool.name}`, `${d.id}#${ti}`); return; }
    if (ScriptedProvider.pending() > 0) { problem("turn_ended_early", `${d.id}#${ti}: ${turn.agent.map((a) => a.kind).join(",")}`); return; }
    if (made > turn.agent.length) { problem("extra_request", `${d.id}#${ti}`); return; }
    for (const r of turnRows) { out.push(r); count(`row:${r.source}:${r.kind}`); }
  }
  count("dialogue_complete");
}

async function main() {
  const [input = "data/finetune/dialogues.jsonl", output = "data/finetune/rendered.jsonl"] = process.argv.slice(2);
  const dialogues = readFileSync(input, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Dialogue);
  const clones = new Map<string, Clone>();
  for (const slug of new Set(dialogues.map((d) => d.tenant))) clones.set(slug, await cloneTenant(slug));
  const cleanup = async () => {
    const ids = [...clones.values()].map((c) => c.tenant.id);
    if (ids.length) {
      await db.delete(jobs).where(inArray(jobs.tenantId, ids));
      await db.delete(tenants).where(inArray(tenants.id, ids));
    }
  };
  process.on("SIGINT", () => { void cleanup().finally(() => process.exit(130)); });

  const rows: Row[] = [];
  const t0 = RealDate.now();
  try {
    for (const [i, d] of dialogues.entries()) {
      randState = (i * 2654435761) >>> 0 || 1;
      const clone = clones.get(d.tenant)!;
      try {
        await replay(d, clone, rows);
      } catch (e) {
        problem("exception", `${d.id}: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        clockOffset = 0;
        // Each dialogue starts from the same empty calendar.
        await db.delete(appointments).where(eq(appointments.tenantId, clone.tenant.id));
        await db.delete(contacts).where(and(eq(contacts.tenantId, clone.tenant.id)));
      }
      if ((i + 1) % 100 === 0) {
        console.log(`  ${i + 1}/${dialogues.length} dialogues, ${rows.length} rows, ${((RealDate.now() - t0) / 1000).toFixed(0)}s`);
      }
    }
  } finally {
    await cleanup();
  }

  writeFileSync(output, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const report = Object.fromEntries([...tally.entries()].sort());
  writeFileSync(output.replace(/\.jsonl$/, ".report.json"),
    JSON.stringify({ dialogues: dialogues.length, rows: rows.length, tally: report, examples: Object.fromEntries(examples) }, null, 2));
  for (const [k, v] of Object.entries(report)) console.log(`  ${k.padEnd(48)} ${v}`);
  for (const [k, v] of examples) console.log(`  e.g. ${k}: ${v[0].slice(0, 200)}`);
  console.log(`✓ ${rows.length} rows from ${dialogues.length} dialogues → ${output}`);
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
