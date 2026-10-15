import { and, eq } from "drizzle-orm";
import { db, tenants, contacts, conversations, messages, leads, appointments } from "@/server/db";
import { runAgentTurn, type AgentOutcome } from "@/server/agent/runtime";
import { getProvider } from "@/server/agent/providers";
import type { Check, Scenario } from "./scenarios";

export type CheckResult = { check: Check; passed: boolean; detail?: string };

export type ScenarioResult = {
  scenario: Scenario;
  results: CheckResult[];
  passed: boolean;
  reply: string | null;
  latencyMs: number;
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
};

export async function runEval(tenantSlug = "northside-hvac", scenarios: Scenario[]): Promise<EvalReport> {
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.slug, tenantSlug) });
  if (!tenant) throw new Error(`tenant ${tenantSlug} not found — run npm run seed`);

  const provider = getProvider();
  const results: ScenarioResult[] = [];

  for (const scenario of scenarios) {
    results.push(await runScenario(tenant.id, scenario));
  }

  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const at = (q: number) => latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))] : 0;
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
  };
}

async function runScenario(tenantId: string, scenario: Scenario): Promise<ScenarioResult> {
  // Isolated contact + conversation so scenarios cannot contaminate each other.
  const [contact] = await db.insert(contacts).values({
    tenantId, displayName: null,
  }).returning();

  const [conversation] = await db.insert(conversations).values({
    tenantId, contactId: contact.id, channel: scenario.channel,
    externalThreadId: `eval_${scenario.id}_${Date.now()}`,
  }).returning();

  let outcome: AgentOutcome | null = null;
  let error: string | undefined;

  try {
    for (const turn of scenario.turns) {
      const [msg] = await db.insert(messages).values({
        tenantId, conversationId: conversation.id,
        direction: "inbound", channel: scenario.channel,
        authorType: "contact", body: turn,
      }).returning();

      outcome = await runAgentTurn({
        conversationId: conversation.id,
        inboundMessageId: msg.id,
      });

      // Persist the agent's reply so the next turn sees real history.
      if (outcome.reply) {
        await db.insert(messages).values({
          tenantId, conversationId: conversation.id,
          direction: "outbound", channel: scenario.channel,
          authorType: "ai", body: outcome.reply,
          status: outcome.holdReason ? "held_for_review" : "sent",
        });
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const results = outcome
    ? await Promise.all(scenario.checks.map((c) => evaluate(c, outcome!, tenantId, conversation.id)))
    : scenario.checks.map((check) => ({ check, passed: false, detail: error ?? "no outcome" }));

  // Clean up so repeated eval runs do not pollute the tenant's real numbers.
  await db.delete(contacts).where(eq(contacts.id, contact.id));

  return {
    scenario,
    results,
    passed: results.every((r) => r.passed),
    reply: outcome?.reply ?? null,
    latencyMs: outcome?.latencyMs ?? 0,
    costUsd: outcome?.costUsd ?? 0,
    error,
  };
}

const MONEY = /[$£€]\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)/g;

async function evaluate(
  check: Check, outcome: AgentOutcome, tenantId: string, conversationId: string,
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
      const appt = await db.query.appointments.findFirst({
        where: eq(appointments.tenantId, tenantId),
      });
      return { check, passed: Boolean(appt) };
    }
  }
}
