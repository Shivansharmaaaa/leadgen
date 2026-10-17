import { eq } from "drizzle-orm";
import { db, tenants } from "@/server/db";
import { routeTurn } from "@/server/agent/router";
import { schedulingInPlay } from "@/server/agent/scheduling";
import { readAgreement } from "@/server/core/scope";
import { testSlug } from "./test-tenant";

/**
 * Which path a spoken turn takes, whether the calendar is read for it, and
 * whether a reply accepts an offered callback. Each case below is a turn the
 * fine-tune replay saw production get wrong, or one a fix must not break.
 *
 *   npm run routing:test
 */
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}
const msgs = (agent: string, caller: string) => [
  { direction: "outbound", body: agent }, { direction: "inbound", body: caller },
];

async function main() {
  const slug = await testSlug("routing-test");
  await db.delete(tenants).where(eq(tenants.slug, slug));
  // No facts: the canned tier never answers, so only routing is under test.
  const [tenant] = await db.insert(tenants).values({ name: "Routing Test", slug, country: "CA", timezone: "America/Toronto",
    settings: { businessName: "Routing Test Immigration" } }).returning();
  const tier = async (text: string, last?: string) => (await routeTurn(tenant.id, text, "Routing Test Immigration", last)).tier;

  try {
    console.log("\nA name given for a booking stays on the booking path");
    check("'This is Grace Fontaine.' after 'What name should I put it under?'",
      (await tier("This is Grace Fontaine.", "Perfect. What name should I put it under?")) === "transact");
    check("'I'm Grace Fontaine.' after 'And what's your name, please?'",
      (await tier("I'm Grace Fontaine.", "Sure. And what's your name, please?")) === "transact");
    check("a bare 'Grace Fontaine.' after 'Can I get your name?'",
      (await tier("Grace Fontaine.", "Great. Can I get your name?")) === "transact");
    check("'My name's Dana.' with no question before it", (await tier("My name's Dana.")) === "transact");
    check("'thanks, bye' is still small talk", (await tier("Thanks, bye.", "You're booked for Tuesday at 10 AM.")) === "chat");

    console.log("\nAsking for a time reads the calendar");
    check("'What's the earliest you have?' → booking path", (await tier("What's the earliest you have?", "Okay.")) === "transact");
    check("… and the calendar is read", schedulingInPlay(msgs("Okay.", "What's the earliest you have?")));
    check("'When could you fit me in?' reads the calendar", schedulingInPlay(msgs("Do you have the letter yet?", "When could you fit me in?")));
    check("'Any openings next week?' reads the calendar", schedulingInPlay(msgs("Sure.", "Any openings?")));
    check("'Can you book me in?' reads the calendar", schedulingInPlay(msgs("Sure.", "Can you book me in?")));
    check("'Yes please.' to 'Would you like me to find you a time?' reads the calendar",
      schedulingInPlay(msgs("Labour's covered for a year. Would you like me to find you a time?", "Yes please.")));
    check("'Yes.' to 'Shall I get you booked in?' reads the calendar",
      schedulingInPlay(msgs("It's free. Shall I get you booked in?", "Yes.")));

    console.log("\nProduct questions do not (slots in context made the model answer them with times)");
    check("'what AC options do you have'", !schedulingInPlay(msgs("Hi, how can I help?", "what AC options do you have")));
    check("'which one is cheaper to run'", !schedulingInPlay(msgs("We install central air and heat pumps.", "which one is cheaper to run")));
    check("'what brands do you install'", !schedulingInPlay(msgs("Okay.", "what brands do you install")));
    check("'what's the earliest model year you service?'", !schedulingInPlay(msgs("Okay.", "what's the earliest model year you service?")));
    check("'is the next one cheaper?'", !schedulingInPlay(msgs("There's the standard and the high-efficiency.", "is the next one cheaper?")));

    console.log("\nAccepting a callback");
    for (const yes of ["Yes please.", "Yeah, that'd be great.", "Sure, that would help.", "That'd be great, thanks.", "Yes, that would be great."]) {
      check(`'${yes}' is a yes`, readAgreement(yes) === "yes", readAgreement(yes));
    }
    check("'No, it's fine.' is a no", readAgreement("No, it's fine.") === "no");
    check("'okay can someone come out tomorrow' is a new request, not consent",
      readAgreement("okay can someone come out tomorrow") === "unclear");
    check("'That'd be great, can you do Tuesday instead?' is a new request",
      readAgreement("That'd be great, can you do Tuesday instead?") === "unclear");
  } finally {
    await db.delete(tenants).where(eq(tenants.id, tenant.id));
  }

  console.log(failures ? `\n✗ ${failures} check(s) failed` : "\n✓ all checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
