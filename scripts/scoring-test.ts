import { eq } from "drizzle-orm";
import { db, tenants, contacts, conversations, messages, agentRuns, events, leads, appointments } from "@/server/db";
import { coachReport, scoreTranscript, type Transcript, type TranscriptMessage } from "@/server/features/scoring";
import { testSlug } from "./test-tenant";

/**
 * Conversation scoring: each flag fires on the case it exists for and stays
 * quiet on the case that looks like it but is fine.
 *
 *   npm run scoring:test
 */
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}

const NOW = new Date("2026-10-17T15:00:00Z");
const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000);
const cust = (body: string, minutesAgo: number): TranscriptMessage =>
  ({ direction: "inbound", authorType: "contact", body, status: "received", createdAt: at(minutesAgo) });
const ai = (body: string, minutesAgo: number, status = "sent", meta: Record<string, unknown> = {}): TranscriptMessage =>
  ({ direction: "outbound", authorType: "ai", body, status, createdAt: at(minutesAgo), meta });
const base = (o: Partial<Transcript>): Transcript => ({
  channel: "sms", messages: [], toolsCalled: [], booked: false, escalatedAt: null, optedOut: false,
  leadUrgency: null, hasLead: false, contactHasPhone: true, contactHasEmail: false, now: NOW, ...o,
});
const codes = (t: Transcript) => scoreTranscript(t).flags.map((f) => f.code);

console.log("\nOutcomes");
check("booked", scoreTranscript(base({ booked: true, messages: [cust("hi", 5), ai("hello", 5)] })).outcome === "booked");
check("opt-out wins over everything", scoreTranscript(base({ booked: true, optedOut: true })).outcome === "opted_out");
check("lead with a number is captured", scoreTranscript(base({ hasLead: true, messages: [cust("hi", 5)] })).outcome === "lead_captured");
check("one message and gone is abandoned", scoreTranscript(base({ contactHasPhone: false, messages: [cust("hi", 5)] })).outcome === "abandoned");

console.log("\nFlags fire where they should");
const timeAsk = base({ messages: [cust("Can someone come out tomorrow?", 10), ai("Sure, what's the address?", 10)] });
check("asked for a time, never offered one", codes(timeAsk).includes("time_asked_not_offered"));
check("…but not once availability was checked", !codes({ ...timeAsk, toolsCalled: ["check_availability"] }).includes("time_asked_not_offered"));
check("…nor once it was booked", !codes({ ...timeAsk, booked: true }).includes("time_asked_not_offered"));

const noDetails = base({ channel: "instagram", contactHasPhone: false, messages: [cust("hi", 30), ai("hey!", 30), cust("ok thanks", 20)] });
check("chat ended with no way to follow up", codes(noDetails).includes("no_contact_details"));
check("…a call always has the caller's number", !codes({ ...noDetails, channel: "voice" }).includes("no_contact_details"));

const price = base({ messages: [cust("How much is a tune-up?", 10), ai("Great question! When would suit you?", 10)] });
check("price question dodged", codes(price).includes("price_not_answered"));
check("…not when the reply gives one", !codes(base({ messages: [cust("How much is a tune-up?", 10), ai("A tune-up is $129.", 10)] })).includes("price_not_answered"));
check("…nor when it says how to get a quote", !codes(base({ messages: [cust("what does a new AC cost?", 10), ai("It depends on the size of the house, so we'd do a free estimate.", 10)] })).includes("price_not_answered"));

const slow = base({ messages: [cust("hello?", 30), ai("Hi!", 20)] });
check("first reply after 10 minutes is slow", codes(slow).includes("slow_first_reply"));
check("…a 20-second reply is not", !codes(base({ messages: [cust("hello?", 30), { ...ai("Hi!", 30), createdAt: new Date(at(30).getTime() + 20_000) }] })).includes("slow_first_reply"));

const stuck = base({ messages: [cust("are you open saturday?", 60), ai("Yes, 9 to 2.", 59, "held_for_review", { holdReason: "invented slot" })] });
check("a reply held for review for an hour, nothing sent", codes(stuck).includes("reply_stuck_in_review"));
check("…not if a person sent something after", !codes({ ...stuck, messages: [...stuck.messages, { ...ai("We're open 9-2 Saturday.", 50), authorType: "human" }] }).includes("reply_stuck_in_review"));

const esc = base({ escalatedAt: at(120), messages: [cust("I want a refund", 121), ai("Passing you to the team.", 120)] });
check("handed over two hours ago, no person replied", codes(esc).includes("escalation_unanswered"));
check("…not once a person replied", !codes({ ...esc, messages: [...esc.messages, { ...ai("Hi, Dana here.", 100), authorType: "human" }] }).includes("escalation_unanswered"));
check("…and not yet, 30 minutes in", !codes({ ...esc, escalatedAt: at(30) }).includes("escalation_unanswered"));

check("emergency left unbooked", codes(base({ leadUrgency: "emergency", messages: [cust("no heat, baby at home", 10)] })).includes("emergency_not_booked"));
check("…not when it was escalated", !codes(base({ leadUrgency: "emergency", escalatedAt: at(5) })).includes("emergency_not_booked"));
check("…nor when the on-call tech was told", !codes(base({ leadUrgency: "emergency", alerted: true })).includes("emergency_not_booked"));

const quiet = base({ messages: [cust("how soon can you come?", 3000), ai("We have Tuesday 2pm — want it?", 2999)], toolsCalled: ["check_availability"] });
check("went quiet a day ago, no follow-up", codes(quiet).includes("went_quiet_no_follow_up"));
check("…not after a follow-up went out", !codes({ ...quiet, messages: [...quiet.messages, ai("Still want Tuesday?", 1500, "sent", { followUp: true })] }).includes("went_quiet_no_follow_up"));

const repeat = base({ messages: [cust("hi", 10), ai("Could I get your name and the best number to reach you on?", 10), cust("why", 9), ai("Could I get your name and the best number to reach you on please?", 9)] });
check("agent repeated itself", codes(repeat).includes("agent_repeated_itself"));

console.log("\nScore");
check("a clean booking scores 100", scoreTranscript(base({ booked: true, messages: [cust("book me in", 5), { ...ai("Done.", 5), createdAt: new Date(at(5).getTime() + 5000) }] })).score === 100);
check("a high flag costs 25", scoreTranscript(timeAsk).score === 75, String(scoreTranscript(timeAsk).score));

async function integration() {
  console.log("\nCoach report over real rows");
  const slug = await testSlug("scoring-test");
  await db.delete(tenants).where(eq(tenants.slug, slug));
  const [tenant] = await db.insert(tenants).values({ name: "Scoring Test", slug, country: "US", timezone: "America/New_York" }).returning();
  try {
    const mk = async (name: string, phone: string | null, rows: { dir: "inbound" | "outbound"; body: string; agoMin: number; status?: "sent" | "received" | "held_for_review" }[]) => {
      const [c] = await db.insert(contacts).values({ tenantId: tenant.id, displayName: name, primaryPhone: phone }).returning();
      const [cv] = await db.insert(conversations).values({ tenantId: tenant.id, contactId: c.id, channel: "sms", lastMessageAt: new Date() }).returning();
      for (const r of rows) {
        await db.insert(messages).values({
          tenantId: tenant.id, conversationId: cv.id, direction: r.dir, channel: "sms",
          authorType: r.dir === "inbound" ? "contact" : "ai", body: r.body,
          status: r.status ?? (r.dir === "inbound" ? "received" : "sent"),
          createdAt: new Date(Date.now() - r.agoMin * 60_000),
        });
      }
      return { contact: c, convo: cv };
    };
    const good = await mk("Booked Bob", "+16175550301", [
      { dir: "inbound", body: "can you come tomorrow?", agoMin: 30 }, { dir: "outbound", body: "Yes — 10am or 2pm?", agoMin: 30 },
    ]);
    await db.insert(agentRuns).values({ tenantId: tenant.id, conversationId: good.convo.id, model: "x",
      toolCalls: [{ name: "check_availability", input: {}, output: {}, ms: 1 }] });
    await db.insert(appointments).values({ tenantId: tenant.id, contactId: good.contact.id, service: "AC",
      startsAt: new Date(Date.now() + 86400_000), endsAt: new Date(Date.now() + 90000_000) });
    const bad = await mk("Missed Mary", "+16175550302", [
      { dir: "inbound", body: "When can someone come out?", agoMin: 90 }, { dir: "outbound", body: "What's the problem?", agoMin: 89 },
    ]);
    await db.insert(leads).values({ tenantId: tenant.id, contactId: bad.contact.id, conversationId: bad.convo.id, sourceChannel: "sms" });
    const esc = await mk("Escalated Ed", "+16175550303", [{ dir: "inbound", body: "I want a refund", agoMin: 180 }]);
    await db.insert(events).values({ tenantId: tenant.id, type: "escalated_to_human", conversationId: esc.convo.id,
      contactId: esc.contact.id, createdAt: new Date(Date.now() - 179 * 60_000) });

    const report = await coachReport(tenant.id, 7);
    check("all three conversations scored", report.scored === 3, String(report.scored));
    check("outcomes counted", report.outcomes.booked === 1 && report.outcomes.lead_captured === 1 && report.outcomes.escalated === 1, JSON.stringify(report.outcomes));
    check("the missed booking is flagged", report.flags.some((f) => f.code === "time_asked_not_offered" && f.count === 1));
    check("the unanswered handover is flagged", report.flags.some((f) => f.code === "escalation_unanswered"));
    check("needs-attention lists the two bad ones, worst first, not the booking",
      report.needsAttention.length === 2 && !report.needsAttention.some((n) => n.conversationId === good.convo.id),
      report.needsAttention.map((n) => `${n.contactName}:${n.score}`).join(", "));
  } finally {
    await db.delete(tenants).where(eq(tenants.id, tenant.id));
  }
}

integration().then(() => {
  console.log(failures ? `\n✗ ${failures} check(s) failed` : "\n✓ all checks passed");
  process.exit(failures ? 1 : 0);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
