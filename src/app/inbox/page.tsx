import Link from "next/link";
import { getInbox } from "@/server/queries/dashboard";
import { currentTenantSlug } from "@/server/settings";
import { TakeoverButton, ReplyBox, HeldDraft, EraseButton } from "./ThreadControls";

export const dynamic = "force-dynamic";

const CHANNEL_ICON: Record<string, string> = {
  webchat: "💬", email: "✉️", sms: "📱", voice: "📞",
  instagram: "📷", messenger: "💬", whatsapp: "🟢", gbp_review: "⭐",
};

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ c?: string; view?: string }> }) {
  const { c, view } = await searchParams;
  const data = await getInbox(currentTenantSlug(), c, view === "attention" ? "attention" : "all");
  if (!data) {
    return (
      <main style={{ maxWidth: 600, margin: "0 auto", padding: 64 }}>
        <h1>No tenant found</h1>
        <p style={{ color: "var(--muted)" }}>Run <code>npm run seed</code> then <code>npm run smoke</code>.</p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 1000, margin: "0 auto", padding: "40px 24px 100px" }}>
      <Link href="/" style={{ color: "var(--muted)", fontSize: 13, textDecoration: "none" }}>← home</Link>
      <h1 style={{ fontSize: 26, margin: "8px 0 2px" }}>Inbox</h1>
      <p style={{ color: "var(--muted)", marginTop: 0, fontSize: 14 }}>
        Every channel, one thread per person. {data.threads.length} conversations.
      </p>
      <nav style={{ display: "flex", gap: 14, fontSize: 13, marginTop: 10 }}>
        <Link href="/inbox" style={{ color: data.view === "all" ? "var(--text)" : "var(--accent)", fontWeight: data.view === "all" ? 600 : 400 }}>All</Link>
        <Link href="/inbox?view=attention" style={{ color: data.view === "attention" ? "var(--text)" : "var(--accent)", fontWeight: data.view === "attention" ? 600 : 400 }}>
          Needs attention ({data.attentionCount})
        </Link>
      </nav>

      {data.threads.length === 0 && (
        <p style={{ color: "var(--muted)", marginTop: 40 }}>
          Nothing yet. Run <code>npm run smoke</code> or talk to it at <Link href="/voice">/voice</Link>.
        </p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 28 }}>
        {data.threads.map(({ conversation, contact, messages, missed }) => (
          <article key={conversation.id} id={conversation.id} style={{
            border: `1px solid ${conversation.id === data.focus ? "var(--accent)" : "var(--border)"}`,
            borderRadius: "var(--radius)",
            background: "var(--panel)", overflow: "hidden",
          }}>
            <header style={{
              display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
              padding: "12px 16px", borderBottom: "1px solid var(--border)",
              background: "var(--panel-2)",
            }}>
              <span style={{ fontSize: 16 }}>{CHANNEL_ICON[conversation.channel] ?? "•"}</span>
              <strong style={{ fontSize: 15 }}>
                {contact?.displayName ?? contact?.primaryPhone ?? "Unknown contact"}
              </strong>
              <span style={{ fontSize: 12, color: "var(--muted)" }}>{conversation.channel}</span>

              {conversation.aiPaused && <Badge tone="warn">human has this thread</Badge>}
              <TakeoverButton conversationId={conversation.id} aiPaused={conversation.aiPaused} />
              {contact?.primaryPhone && !contact.doNotContact && (
                // A lead that couldn't be texted (no written consent) can still be phoned by a person.
                <a href={`tel:${contact.primaryPhone}`} style={{ fontSize: 12, color: "var(--accent)" }}>call {contact.primaryPhone}</a>
              )}
              {contact?.smsConsent && <Badge tone="ok">SMS consent</Badge>}
              {contact?.doNotContact && <Badge tone="danger">do not contact</Badge>}
              {contact && <EraseButton contactId={contact.id} name={contact.displayName ?? contact.primaryPhone ?? contact.primaryEmail ?? "this person"} />}

              <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--muted)" }}>
                {conversation.lastMessageAt.toLocaleString("en-US", {
                  timeZone: data.tenant.timezone,
                  month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
                })}
              </span>
            </header>

            {missed.length > 0 && (
              <div style={{ padding: "8px 16px", fontSize: 13, color: "var(--danger)", borderBottom: "1px solid var(--border)" }}>
                Missed: {missed.join(" ")}
              </div>
            )}
            <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
              {messages.slice(-8).map((m) => {
                const outbound = m.direction === "outbound";
                const held = m.status === "held_for_review";

                if (held) {
                  return (
                    <div key={m.id} style={{ alignSelf: "flex-end", maxWidth: "86%" }}>
                      <HeldDraft
                        messageId={m.id}
                        body={m.body}
                        reason={typeof m.meta?.holdReason === "string" ? m.meta.holdReason : undefined}
                      />
                    </div>
                  );
                }

                return (
                  <div key={m.id} style={{ alignSelf: outbound ? "flex-end" : "flex-start", maxWidth: "78%" }}>
                    <div style={{
                      padding: "9px 13px", borderRadius: 13, fontSize: 14, lineHeight: 1.45,
                      background: outbound ? "#1d2b22" : "var(--panel-2)",
                      border: held ? "1px dashed var(--danger)" : "1px solid var(--border)",
                      whiteSpace: "pre-wrap",
                    }}>
                      {m.body || <em style={{ color: "var(--muted)" }}>(empty)</em>}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 3, textAlign: outbound ? "right" : "left" }}>
                      {m.authorType}
                      {held && <span style={{ color: "var(--danger)" }}> · held for review</span>}
                      {m.status === "failed" && <span style={{ color: "var(--danger)" }}> · failed</span>}
                    </div>
                  </div>
                );
              })}

              <ReplyBox conversationId={conversation.id} />
            </div>
          </article>
        ))}
      </div>
    </main>
  );
}

function Badge({ tone, children }: { tone: "ok" | "warn" | "danger"; children: React.ReactNode }) {
  const colour = tone === "ok" ? "var(--accent)" : tone === "warn" ? "var(--warn)" : "var(--danger)";
  return (
    <span style={{
      fontSize: 11, padding: "2px 8px", borderRadius: 20,
      color: colour, border: `1px solid ${colour}`,
    }}>{children}</span>
  );
}
