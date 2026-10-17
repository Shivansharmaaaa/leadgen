import { and, eq, gte, or, sql } from "drizzle-orm";
import { db, tenants, contacts, conversations, messages, leads, appointments, jobs } from "@/server/db";
import { runAgentTurn, type AgentOutcome } from "@/server/agent/runtime";
import { getProvider } from "@/server/agent/providers";
import { POST as voiceStream } from "@/app/api/voice/stream/route";
import type { Check, Scenario } from "./scenarios";

export type CheckResult = { check: Check; passed: boolean; detail?: string };

export type ScenarioResult = {
  scenario: Scenario;
  results: CheckResult[];
  passed: boolean;
  reply: string | null;
  latencyMs: number;
  /** Voice path only: time until the first token, which is what a caller hears. */
  firstWordMs: number | null;
  costUsd: number;
  error?: string;
};

export type EvalReport = {
  provider: string;
  model: string;
  productionGrade: boolean;
  scenarios: ScenarioResult[];
  passRate: number;
  checksPassed: number;
  checksTotal: number;
  totalCostUsd: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p50FirstWordMs: number | null;
};

export async function runEval(tenantSlug = "northside-hvac", scenarios: Scenario[]): Promise<EvalReport> {
  const bySlug = new Map<string, { id: string; slug: string }>();
  for (const slug of new Set(scenarios.map((s) => s.tenant ?? tenantSlug))) {
    const tenant = await db.query.tenants.findFirst({ where: eq(tenants.slug, slug) });
    if (!tenant) throw new Error(`tenant ${slug} not found — run npm run seed (and scripts/seed-verticals.ts)`);
    bySlug.set(slug, tenant);
  }

  // Report the model the voice path actually uses, since most
  // scenarios run on that channel.
  const provider = getProvider("voice");
  const results: ScenarioResult[] = [];

  for (const scenario of scenarios) {
    results.push(await runScenario(bySlug.get(scenario.tenant ?? tenantSlug)!, scenario));
  }

  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const at = (q: number) => latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))] : 0;
  const firstWords = results.flatMap((r) => r.firstWordMs ?? []).sort((a, b) => a - b);
  const checksTotal = results.reduce((s, r) => s + r.results.length, 0);
  const checksPassed = results.reduce((s, r) => s + r.results.filter((c) => c.passed).length, 0);

  return {
    provider: provider.id,
    model: provider.model,
    productionGrade: provider.productionGrade,
    scenarios: results,
    passRate: results.length ? results.filter((r) => r.passed).length / results.length : 0,
    checksPassed,
    checksTotal,
    totalCostUsd: results.reduce((s, r) => s + r.costUsd, 0),
    p50LatencyMs: at(0.5),
    p95LatencyMs: at(0.95),
    p50FirstWordMs: firstWords.length ? firstWords[Math.floor(firstWords.length / 2)] : null,
  };
}

async function runScenario(tenant: { id: string; slug: string }, scenario: Scenario): Promise<ScenarioResult> {
  const tenantId = tenant.id;
  const startedAt = new Date();
  const threadId = `eval_${scenario.id}_${Date.now()}`;
  let contactId: string | null = null;
  let conversationId: string | null = null;

  // Text channels: an isolated contact + conversation so scenarios cannot
  // contaminate each other. Voice: the route makes its own, as on a live call.
  if (scenario.channel !== "voice") {
    const [contact] = await db.insert(contacts).values({ tenantId, displayName: null }).returning();
    const [conversation] = await db.insert(conversations).values({
      tenantId, contactId: contact.id, channel: scenario.channel, externalThreadId: threadId,
    }).returning();
    contactId = contact.id;
    conversationId = conversation.id;
  }

  let outcome: AgentOutcome | null = null;
  let firstWordMs: number | null = null;
  let error: string | undefined;

  try {
    for (const turn of scenario.turns) {
      // Spoken scenarios go through POST /api/voice/stream, exactly as a live
      // call does: caller ID, the name and number harvested before the turn
      // (which decides whether book_appointment is offered), the opt-out rule.
      // Calling runVoiceTurn directly skipped all of that, so no caller ever
      // had a name and booking could not be offered, let alone tested.
      if (scenario.channel === "voice") {
        ({ outcome, firstWordMs } = await collectVoiceTurn(tenant.slug, threadId, turn));
        continue;
      }

      const [msg] = await db.insert(messages).values({
        tenantId, conversationId: conversationId!,
        direction: "inbound", channel: scenario.channel,
        authorType: "contact", body: turn,
      }).returning();

      outcome = await runAgentTurn({
        conversationId: conversationId!,
        inboundMessageId: msg.id,
      });

      // Persist the agent's reply so the next turn sees real history.
      if (outcome.reply) {
        await db.insert(messages).values({
          tenantId, conversationId: conversationId!,
          direction: "outbound", channel: scenario.channel,
          authorType: "ai", body: outcome.reply,
          status: outcome.holdReason ? "held_for_review" : "sent",
        });
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  if (scenario.channel === "voice") {
    const conversation = await db.query.conversations.findFirst({
      where: and(eq(conversations.tenantId, tenantId), eq(conversations.channel, "voice"),
        eq(conversations.externalThreadId, threadId)),
    });
    contactId = conversation?.contactId ?? null;
    conversationId = conversation?.id ?? null;
  }

  const results = outcome && contactId && conversationId
    ? await Promise.all(scenario.checks.map((c) => evaluate(c, outcome!, tenantId, conversationId!, contactId!)))
    : scenario.checks.map((check) => ({ check, passed: false, detail: error ?? "no outcome" }));

  // Clean up so repeated eval runs do not pollute the tenant's real numbers:
  // the contact (its conversation, messages, lead and bookings go with it) and
  // any job the run scheduled for them — a reminder, an alert, a follow-up.
  if (contactId) {
    const booked = await db.select({ id: appointments.id }).from(appointments)
      .where(eq(appointments.contactId, contactId));
    const ids = [contactId, conversationId, ...booked.map((b) => b.id)].filter(Boolean) as string[];
    await db.delete(jobs).where(and(
      eq(jobs.tenantId, tenantId), gte(jobs.createdAt, startedAt),
      or(...ids.map((id) => sql`${jobs.payload}::text like ${"%" + id + "%"}`)),
    ));
    await db.delete(contacts).where(eq(contacts.id, contactId));
  }

  return {
    scenario,
    results,
    passed: results.every((r) => r.passed),
    reply: outcome?.reply ?? null,
    latencyMs: outcome?.latencyMs ?? 0,
    firstWordMs,
    costUsd: outcome?.costUsd ?? 0,
    error,
  };
}

type VoiceEvent = {
  type: string; name?: string; ok?: boolean; ms?: number; reason?: string; message?: string;
  fullText?: string; latencyMs?: number; firstWordMs?: number | null;
};

/** One caller turn through the live voice route, drained into the shape the checks grade. */
async function collectVoiceTurn(
  tenantSlug: string, sessionId: string, text: string,
): Promise<{ outcome: AgentOutcome; firstWordMs: number | null }> {
  const res = await voiceStream(new Request("http://localhost/api/voice/stream", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenant: tenantSlug, sessionId, text }),
  }));
  const body = await res.text();
  if (res.status !== 200) throw new Error(`voice route ${res.status}: ${body.slice(0, 200)}`);
  const events = body.split("\n").filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)) as VoiceEvent);

  const provider = getProvider("voice");
  const outcome: AgentOutcome = {
    reply: null, escalated: false, toolCalls: [], costUsd: 0, latencyMs: 0,
    provider: provider.id, model: provider.model, productionGrade: provider.productionGrade,
  };
  let firstWordMs: number | null = null;

  for (const ev of events) {
    if (ev.type === "tool") {
      outcome.toolCalls.push({ name: ev.name ?? "", input: {}, output: { ok: ev.ok }, ms: ev.ms ?? 0 });
    } else if (ev.type === "escalated") {
      outcome.escalated = true;
    } else if (ev.type === "held") {
      outcome.holdReason = `guardrail: ${ev.reason}`;
    } else if (ev.type === "error") {
      outcome.holdReason = `model error: ${ev.message}`;
    } else if (ev.type === "done") {
      outcome.reply = ev.fullText || null;
      outcome.latencyMs = ev.latencyMs ?? 0;
      firstWordMs = ev.firstWordMs ?? null;
    }
  }
  return { outcome, firstWordMs };
}

const MONEY = /[$£€]\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)/g;

async function evaluate(
  check: Check, outcome: AgentOutcome, tenantId: string, conversationId: string, contactId: string,
): Promise<CheckResult> {
  const reply = outcome.reply ?? "";
  const toolNames = outcome.toolCalls.map((t) => t.name);

  switch (check.type) {
    case "calls_tool":
      return {
        check,
        passed: toolNames.includes(check.tool),
        detail: `called: ${toolNames.join(", ") || "none"}`,
      };

    case "does_not_call_tool":
      return { check, passed: !toolNames.includes(check.tool) };

    case "escalates":
      return { check, passed: outcome.escalated, detail: outcome.holdReason };

    case "does_not_escalate":
      return { check, passed: !outcome.escalated, detail: outcome.holdReason };

    case "reply_matches": {
      const re = new RegExp(check.pattern, check.flags ?? "i");
      return { check, passed: re.test(reply), detail: reply.slice(0, 120) };
    }

    case "reply_avoids": {
      const re = new RegExp(check.pattern, check.flags ?? "i");
      return { check, passed: !re.test(reply), detail: reply.slice(0, 120) };
    }

    case "no_unverified_price": {
      const found = [...reply.matchAll(MONEY)].map((m) => Number(m[1].replace(/,/g, "")));
      const invented = found.filter((v) => !check.allowed.includes(v));
      return {
        check,
        passed: invented.length === 0,
        detail: invented.length ? `invented: ${invented.join(", ")}` : `quoted: ${found.join(", ") || "none"}`,
      };
    }

    case "held_by_guardrail":
      return { check, passed: Boolean(outcome.holdReason), detail: outcome.holdReason };

    case "not_held":
      return { check, passed: !outcome.holdReason, detail: outcome.holdReason };

    case "max_latency_ms":
      return {
        check,
        passed: outcome.latencyMs <= check.ms,
        detail: `${outcome.latencyMs}ms`,
      };

    case "creates_lead": {
      const lead = await db.query.leads.findFirst({
        where: and(eq(leads.tenantId, tenantId), eq(leads.conversationId, conversationId)),
      });
      return { check, passed: Boolean(lead), detail: lead ? `score ${lead.score}` : "no lead row" };
    }

    case "books_appointment": {
      // This caller's booking — any appointment the tenant has used to pass.
      const appt = await db.query.appointments.findFirst({
        where: and(eq(appointments.tenantId, tenantId), eq(appointments.contactId, contactId)),
      });
      return { check, passed: Boolean(appt) };
    }

    case "saves_name": {
      const contact = await db.query.contacts.findFirst({ where: eq(contacts.id, contactId) });
      const saved = contact?.displayName ?? null;
      return {
        check,
        passed: saved?.toLowerCase() === check.name.toLowerCase(),
        detail: `saved: ${saved ?? "nothing"}`,
      };
    }
  }
}
