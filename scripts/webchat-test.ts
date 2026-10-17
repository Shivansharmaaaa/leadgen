import { eq } from "drizzle-orm";
import { db, tenants, locations, conversations } from "@/server/db";
import { deliver } from "@/server/core/ingest";
import { ScriptedProvider } from "@/server/agent/providers";
import { resetRateLimits, limits, allowedOrigin } from "@/server/features/webchat";
import { GET, OPTIONS, POST } from "@/app/api/chat/route";
import { testSlug } from "./test-tenant";

/**
 * The website chat API end to end against Postgres, with no model.
 *
 *   npm run webchat:test
 */
process.env.LLM_PROVIDER = "scripted";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}
const SITE = "https://webchat-test.example";
const session = () => crypto.randomUUID().replace(/-/g, "");

async function main() {
  const slug = await testSlug("webchat-test");
  await db.delete(tenants).where(eq(tenants.slug, slug));
  const [tenant] = await db.insert(tenants).values({
    name: "Webchat Test", slug, country: "US", timezone: "America/New_York",
    settings: { businessName: "Webchat Test", webchatOrigins: [SITE] },
  }).returning();
  await db.insert(locations).values({ tenantId: tenant.id, name: "Main", country: "US", timezone: "America/New_York", hours: [] });

  const post = (body: unknown, origin?: string, ip = "198.51.100.1") => POST(new Request("http://localhost/api/chat", {
    method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-forwarded-for": ip, ...(origin ? { origin } : {}) },
  }));

  try {
    console.log("\nA conversation");
    ScriptedProvider.reset();
    ScriptedProvider.enqueue("Sorry to hear that! What's going on with it?");
    const sid = session();
    const r1 = await post({ tenant: slug, sessionId: sid, text: "my furnace is making a banging noise" }, SITE);
    const d1 = await r1.json();
    check("visitor gets the agent's reply", r1.status === 200 && d1.reply?.body === "Sorry to hear that! What's going on with it?", JSON.stringify(d1));
    check("reply carries its stored id, for de-duplication", typeof d1.reply?.id === "string");
    check("the agent saw what the visitor wrote", ScriptedProvider.requests.some((r) => JSON.stringify(r.history).includes("banging noise")));
    check("allowed site gets CORS", r1.headers.get("access-control-allow-origin") === SITE);

    const r2 = await post({ tenant: slug, sessionId: sid, text: "it's a Lennox, about 10 years old" }, SITE);
    const d2 = await r2.clone().json();
    const convs = await db.query.conversations.findMany({ where: eq(conversations.tenantId, tenant.id) });
    check("same session threads into one conversation", r2.status === 200 && convs.length === 1, `${convs.length} conversation(s)`);

    console.log("\nA person replies from the inbox");
    // The widget's cursor is the server's own timestamp on the last reply it
    // has, never the visitor's clock.
    const since = d2.reply.at as string;
    await deliver({
      tenantId: tenant.id, conversationId: convs[0].id, channel: "webchat",
      to: { channel: "webchat", externalId: sid }, body: "Hi, Dana here — we can come Thursday.", authorType: "human",
    });
    const poll = await GET(new Request(`http://localhost/api/chat?tenant=${slug}&sessionId=${sid}&after=${encodeURIComponent(since)}`));
    const pd = await poll.json();
    check("the poll returns it, marked as the team", pd.messages?.length === 1 && pd.messages[0].from === "team", JSON.stringify(pd.messages));
    const other = await GET(new Request(`http://localhost/api/chat?tenant=${slug}&sessionId=${session()}&after=1970-01-01T00:00:00Z`));
    check("another session id reads nothing", (await other.json()).messages.length === 0);

    console.log("\nHandover and redelivery");
    const sid2 = session();
    const esc = await (await post({ tenant: slug, sessionId: sid2, text: "I want a refund" }, SITE)).json();
    check("a handover still answers the visitor", Boolean(esc.reply?.body?.includes("passing this to a member")), JSON.stringify(esc));
    const dupBody = { tenant: slug, sessionId: sid2, text: "hello?", clientMessageId: "abc123" };
    await post(dupBody, SITE);
    const dup = await (await post(dupBody, SITE)).json();
    check("a double-submitted message is not answered twice", dup.reply === null && dup.waitingForTeam === false, JSON.stringify(dup));

    console.log("\nAbuse");
    check("unknown tenant → 404", (await post({ tenant: "nope", sessionId: session(), text: "hi" })).status === 404);
    check("guessable session id → 400", (await post({ tenant: slug, sessionId: "123", text: "hi" })).status === 400);
    check("empty text → 400", (await post({ tenant: slug, sessionId: session(), text: "   " })).status === 400);
    check("over 1000 characters → 413", (await post({ tenant: slug, sessionId: session(), text: "x".repeat(1001) })).status === 413);
    const foreign = await post({ tenant: slug, sessionId: session(), text: "hi" }, "https://someone-else.example");
    check("another site gets no CORS header", foreign.headers.get("access-control-allow-origin") === null);
    const pre = await OPTIONS(new Request(`http://localhost/api/chat?tenant=${slug}`, { method: "OPTIONS", headers: { origin: SITE } }));
    check("preflight from the tenant's site is allowed", pre.status === 204 && pre.headers.get("access-control-allow-origin") === SITE);
    check("origins compare without a trailing slash or case", allowedOrigin("HTTPS://Webchat-Test.example", [SITE + "/"]) !== null);

    resetRateLimits();
    const flood = session();
    let limited = 0;
    for (let i = 0; i < limits().perSession + 3; i++) {
      const r = await post({ tenant: slug, sessionId: flood, text: `msg ${i}` }, SITE, "198.51.100.9");
      if (r.status === 429) limited++;
    }
    check(`one session is capped at ${limits().perSession} messages an hour`, limited === 3, `${limited} refused`);
    resetRateLimits();
    let ipLimited = 0;
    for (let i = 0; i < limits().perIp + 2; i++) {
      const r = await post({ tenant: slug, sessionId: session(), text: "hi" }, SITE, "198.51.100.50");
      if (r.status === 429) ipLimited++;
    }
    check(`new session ids do not dodge the per-IP cap (${limits().perIp})`, ipLimited === 2, `${ipLimited} refused`);
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
