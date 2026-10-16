import net from "node:net";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import { db, tenants, locations, channelAccounts, contacts, messages, events, appointments } from "@/server/db";
import { deliver } from "@/server/core/ingest";
import { header, isAutomated, parseAddress, parseAddressList, stripQuoted } from "@/server/channels/email-inbound";
import { resetEmailTransport } from "@/server/channels/email";
import { intakeLead } from "@/server/features/lead-intake";
import { sendAppointmentReminder } from "@/server/features/reminders";
import { ScriptedProvider } from "@/server/agent/providers";
import { POST as inbound } from "@/app/api/webhooks/email/route";

/**
 * Email as a channel, end to end: parsing, the auto-reply loop guard, the
 * inbound webhook, threading, consent, opt-out, intake and reminders by
 * email — against Postgres and a real SMTP conversation with a tiny server
 * in this process. No model.
 *
 *   npm run email:test
 */
process.env.LLM_PROVIDER = "scripted";
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** Just enough SMTP to accept mail and keep it. */
async function smtpServer() {
  const received: string[] = [];
  const server = net.createServer((sock) => {
    sock.write("220 test ESMTP\r\n");
    let buf = "", inData = false, data = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === ".") { inData = false; received.push(data); data = ""; sock.write("250 OK queued\r\n"); }
          else data += (line.startsWith("..") ? line.slice(1) : line) + "\r\n";
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO") sock.write("250-test\r\n250 8BITMIME\r\n");
        else if (cmd === "DATA") { inData = true; sock.write("354 go ahead\r\n"); }
        else if (cmd === "QUIT") { sock.write("221 bye\r\n"); sock.end(); }
        else sock.write("250 OK\r\n");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { port: (server.address() as AddressInfo).port, received, close: () => server.close() };
}

/** Headers and decoded text of a captured message. */
function readMail(raw: string) {
  const [head, ...rest] = raw.split("\r\n\r\n");
  const unfolded = head.replace(/\r\n[ \t]+/g, " ");
  // RFC 2047: whitespace between adjacent encoded words is not part of the text.
  const decodeWords = (v: string) => v.replace(/\?=\s+=\?/g, "?==?").replace(/=\?utf-8\?([QB])\?([^?]*)\?=/gi, (_, enc: string, text: string) =>
    enc.toUpperCase() === "B" ? Buffer.from(text, "base64").toString("utf8")
      : Buffer.from(text.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1").toString("utf8"));
  const get = (name: string) => {
    const m = unfolded.match(new RegExp(`^${name}:\\s*(.*)$`, "im"));
    return m ? decodeWords(m[1].trim()) : null;
  };
  let body = rest.join("\r\n\r\n");
  if (/quoted-printable/i.test(get("Content-Transfer-Encoding") ?? "")) {
    body = Buffer.from(body.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1").toString("utf8");
  }
  return { get, body };
}

async function main() {
  console.log("\nParsing");
  check("name and address", JSON.stringify(parseAddress('"Priya Patel" <Priya@Example.COM>')) === '{"address":"priya@example.com","name":"Priya Patel"}');
  check("bare address", parseAddress("nora@example.com")?.address === "nora@example.com");
  check("junk is not an address", parseAddress("not an email") === null);
  check("a list with a comma inside a quoted name", parseAddressList('"Kim, Ben" <ben@x.com>, team@biz.com').join() === "ben@x.com,team@biz.com");
  const gmail = "Tuesday works.\n\nOn Fri, 16 Oct 2026 at 15:12, Alex at Northside <hello@biz.com>\nwrote:\n> We have Tuesday at 2pm.";
  check("Gmail's wrapped 'On … wrote:' and quotes are dropped", stripQuoted(gmail) === "Tuesday works.", JSON.stringify(stripQuoted(gmail)));
  const outlook = "Yes please book it\n\nFrom: Northside <hello@biz.com>\nSent: Friday\nSubject: Re: AC";
  check("Outlook's From/Sent block is dropped", stripQuoted(outlook) === "Yes please book it");
  check("a signature is dropped", stripQuoted("Thanks!\n-- \nPriya\n555 0101") === "Thanks!");
  check("unfolded header", header("Subject: a\r\n  long one\r\nMessage-ID: <x@y>", "Subject") === "a long one");

  console.log("\nThe loop guard: never answer a machine");
  check("out-of-office (Auto-Submitted)", isAutomated("p@x.com", "Auto-Submitted: auto-replied") !== null);
  check("Auto-Submitted: no is a person", isAutomated("p@x.com", "Auto-Submitted: no") === null);
  check("bulk / list mail", isAutomated("p@x.com", "Precedence: bulk") !== null && isAutomated("p@x.com", "List-Unsubscribe: <mailto:u@x>") !== null);
  check("bounces and no-reply senders", isAutomated("MAILER-DAEMON@x.com", "") !== null && isAutomated("no-reply@x.com", "") !== null);
  check("an ordinary person", isAutomated("priya@example.com", "Subject: AC broke") === null);

  const smtp = await smtpServer();
  process.env.SMTP_HOST = "127.0.0.1";
  process.env.SMTP_PORT = String(smtp.port);
  process.env.EMAIL_FROM = "fallback@example.com";
  delete process.env.SMTP_USER;
  resetEmailTransport();
  process.env.EMAIL_INBOUND_TOKEN = "inbound-secret-123";

  const slug = "email-test";
  await db.delete(tenants).where(eq(tenants.slug, slug));
  const [tenant] = await db.insert(tenants).values({
    name: "Email Test HVAC", slug, country: "US", timezone: "America/New_York",
    settings: { businessName: "Email Test HVAC", agentName: "Alex" },
  }).returning();
  const allDay = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: "00:00", close: "23:59" }));
  await db.insert(locations).values({ tenantId: tenant.id, name: "Main", country: "US", timezone: "America/New_York", hours: allDay });
  await db.insert(channelAccounts).values({ tenantId: tenant.id, channel: "email", externalAccountId: "hello@emailtest.example" });
  const post = (body: unknown, token = "inbound-secret-123") => inbound(new Request(
    `http://localhost/api/webhooks/email?token=${token}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  ));

  try {
    console.log("\nInbound webhook");
    check("wrong token → 401", (await post({}, "nope")).status === 401);
    ScriptedProvider.reset();
    // No times in it: offering a slot without checking availability is held by Gate 2.
    ScriptedProvider.enqueue("Sorry about that. Is it warm all the time, or only some of the time?");
    const r = await post({
      from: '"Priya Patel" <priya@example.com>', to: "Email Test HVAC <hello@emailtest.example>",
      subject: "AC not cooling", text: "Hi, my AC is blowing warm air.\n\n-- \nPriya",
      headers: "Message-ID: <abc123@mail.example.com>\r\nSubject: AC not cooling",
    });
    check("an email to the tenant's address is handled", r.status === 200 && (await r.json()).note === "handled");
    check("the agent saw only what she wrote", ScriptedProvider.requests.some((q) => JSON.stringify(q.history).includes("blowing warm air")) &&
      !ScriptedProvider.requests.some((q) => JSON.stringify(q.history).includes("-- ")));
    const mail = smtp.received.length ? readMail(smtp.received[smtp.received.length - 1]) : null;
    check("the reply went out over SMTP", Boolean(mail));
    check("threaded: 'Re: AC not cooling' with In-Reply-To", mail?.get("Subject") === "Re: AC not cooling" && mail?.get("In-Reply-To") === "<abc123@mail.example.com>",
      `${mail?.get("Subject")} / ${mail?.get("In-Reply-To")}`);
    check("from the business, at its own address", /^"?Email Test HVAC"? <hello@emailtest\.example>$/.test(mail?.get("From") ?? ""), mail?.get("From") ?? "");
    check("marked Auto-Submitted, so their auto-responder won't answer", mail?.get("Auto-Submitted") === "auto-replied");
    check("the reply text is the agent's", Boolean(mail?.body.includes("only some of the time")));
    const priya = await db.query.contacts.findFirst({ where: and(eq(contacts.tenantId, tenant.id), eq(contacts.primaryEmail, "priya@example.com")) });
    check("contact created with her name", priya?.displayName === "Priya Patel");

    const dupBefore = smtp.received.length;
    await post({ from: "priya@example.com", to: "hello@emailtest.example", subject: "AC not cooling", text: "Hi, my AC is blowing warm air.",
      headers: "Message-ID: <abc123@mail.example.com>" });
    check("the same Message-ID twice is answered once", smtp.received.length === dupBefore);

    const before = smtp.received.length;
    const ooo = await (await post({ from: "priya@example.com", to: "hello@emailtest.example", subject: "Out of office",
      text: "I'm away until Monday.", headers: "Auto-Submitted: auto-replied\r\nMessage-ID: <ooo@x>" })).json();
    check("an out-of-office is stored as ignored, not answered", ooo.note.startsWith("automated") && smtp.received.length === before);
    check("…and logged", (await db.query.events.findMany({ where: and(eq(events.tenantId, tenant.id), eq(events.type, "email_ignored")) })).length === 1);
    check("mail to an unknown address finds no tenant", (await (await post({ from: "x@y.com", to: "nobody@else.example", text: "hi" })).json()).note.startsWith("no tenant"));

    console.log("\nConsent");
    const [convo] = await db.query.conversations.findMany({ where: and(eq((await import("@/server/db")).conversations.tenantId, tenant.id)) });
    const promo = await deliver({ tenantId: tenant.id, conversationId: convo.id, channel: "email",
      to: { channel: "email", externalId: "priya@example.com" }, body: "20% off this week!", initiated: true });
    const held = await db.query.messages.findFirst({ where: and(eq(messages.conversationId, convo.id), eq(messages.body, "20% off this week!")) });
    check("a marketing email without email consent is held", !promo && held?.status === "held_for_review", String(held?.meta?.holdReason));
    await post({ from: "priya@example.com", to: "hello@emailtest.example", subject: "Re: AC not cooling", text: "unsubscribe", headers: "Message-ID: <unsub@x>" });
    const unsub = await db.query.contacts.findFirst({ where: eq(contacts.id, priya!.id) });
    check("replying 'unsubscribe' opts her out", unsub?.doNotContact === true);

    console.log("\nEmail-only form lead");
    ScriptedProvider.enqueue("Happy to help with that. What's the best number to reach you on?");
    const lead = await intakeLead(tenant.id, { source: "website", externalId: "e-1", name: "Nora Silva", email: "nora@example.com", service: "Heat pump quote", message: "Looking at a heat pump for a 3-bed." });
    const leadMail = readMail(smtp.received[smtp.received.length - 1]);
    check("gets an instant reply by email (an answer to her own enquiry)", lead.firstResponse === "sent", `${lead.firstResponse} ${lead.reason ?? ""}`);
    check("with a subject naming her request", leadMail.get("Subject") === "Your Heat pump quote request — Email Test HVAC", leadMail.get("Subject") ?? "");
    check("introducing who it is, with a way to stop", leadMail.body.includes("Hi Nora, it's Alex at Email Test HVAC") && leadMail.body.includes("unsubscribe"));

    console.log("\nReminder by email when there is no mobile");
    const nora = await db.query.contacts.findFirst({ where: and(eq(contacts.tenantId, tenant.id), eq(contacts.primaryEmail, "nora@example.com")) });
    const starts = new Date(Date.now() + 3 * 86400_000);
    const [appt] = await db.insert(appointments).values({ tenantId: tenant.id, contactId: nora!.id, service: "Heat pump survey",
      startsAt: starts, endsAt: new Date(starts.getTime() + 3600_000) }).returning();
    const sent = await sendAppointmentReminder({ appointmentId: appt.id, kind: "confirmation", startsAt: starts.toISOString() });
    const rem = readMail(smtp.received[smtp.received.length - 1]);
    check("sent by email", sent.sent === true, JSON.stringify(sent));
    check("subject says what it is", rem.get("Subject") === "Booked: Heat pump survey — Email Test HVAC", rem.get("Subject") ?? "");
  } finally {
    smtp.close();
    await db.delete(tenants).where(eq(tenants.id, tenant.id));
  }

  console.log(failures ? `\n✗ ${failures} check(s) failed` : "\n✓ all checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
