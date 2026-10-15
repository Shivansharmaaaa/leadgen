"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

async function post(body: unknown) {
  const res = await fetch("/api/inbox", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

export function TakeoverButton({ conversationId, aiPaused }: {
  conversationId: string; aiPaused: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  return (
    <button
      disabled={pending}
      onClick={() =>
        start(async () => {
          await post({ action: aiPaused ? "release" : "takeover", conversationId });
          router.refresh();
        })
      }
      style={{
        fontSize: 11, padding: "3px 10px", borderRadius: 20,
        background: "transparent", color: aiPaused ? "var(--accent)" : "var(--warn)",
        border: `1px solid ${aiPaused ? "var(--accent)" : "var(--warn)"}`,
        opacity: pending ? 0.5 : 1,
      }}
    >
      {pending ? "…" : aiPaused ? "hand back to AI" : "take over"}
    </button>
  );
}

export function ReplyBox({ conversationId }: { conversationId: string }) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [pending, start] = useTransition();

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!value.trim()) return;
        start(async () => {
          await post({ action: "reply", conversationId, body: value });
          setValue("");
          router.refresh();
        });
      }}
      style={{ display: "flex", gap: 8, marginTop: 12 }}
    >
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Reply as a human — this pauses the AI on this thread"
        disabled={pending}
        style={{
          flex: 1, padding: "10px 13px", borderRadius: 9, fontSize: 14,
          border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)",
        }}
      />
      <button
        type="submit"
        disabled={pending || !value.trim()}
        style={{
          padding: "10px 18px", borderRadius: 9, fontSize: 14,
          border: "1px solid var(--accent)", background: "var(--accent-dim)",
          color: "var(--accent)", opacity: pending || !value.trim() ? 0.4 : 1,
        }}
      >
        {pending ? "sending…" : "Send"}
      </button>
    </form>
  );
}

/**
 * A draft the guardrails stopped. The reviewer can send it, fix it, or bin it —
 * and the reason it was held stays visible while they decide.
 */
export function HeldDraft({ messageId, body, reason }: {
  messageId: string; body: string; reason?: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(body);
  const [pending, start] = useTransition();

  const act = (payload: Record<string, unknown>) =>
    start(async () => { await post(payload); router.refresh(); });

  return (
    <div style={{
      border: "1px dashed var(--danger)", borderRadius: 11,
      padding: 12, background: "#1c1314",
    }}>
      <div style={{ fontSize: 11, color: "var(--danger)", marginBottom: 8 }}>
        ⛔ held by guardrail{reason ? ` — ${reason}` : ""}
      </div>

      {editing ? (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          style={{
            width: "100%", padding: 10, borderRadius: 8, fontSize: 14,
            fontFamily: "inherit", resize: "vertical",
            border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)",
          }}
        />
      ) : (
        <div style={{ fontSize: 14, lineHeight: 1.45, whiteSpace: "pre-wrap" }}>{draft}</div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        <Action
          label={editing ? "Send edited" : "Approve & send"}
          tone="accent"
          disabled={pending}
          onClick={() => act({
            action: "approve_draft", messageId,
            ...(editing && draft !== body ? { body: draft } : {}),
          })}
        />
        {!editing && (
          <Action label="Edit" tone="muted" disabled={pending} onClick={() => setEditing(true)} />
        )}
        <Action label="Discard" tone="danger" disabled={pending}
                onClick={() => act({ action: "discard_draft", messageId })} />
      </div>
    </div>
  );
}

function Action({ label, tone, disabled, onClick }: {
  label: string; tone: "accent" | "muted" | "danger"; disabled: boolean; onClick: () => void;
}) {
  const colour = tone === "accent" ? "var(--accent)" : tone === "danger" ? "var(--danger)" : "var(--muted)";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        fontSize: 12, padding: "5px 12px", borderRadius: 7,
        background: "transparent", color: colour,
        border: `1px solid ${colour}`, opacity: disabled ? 0.4 : 1,
      }}
    >{label}</button>
  );
}
