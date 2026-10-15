"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Turn = {
  who: "you" | "agent" | "system";
  text: string;
  tools?: { name: string; ok: boolean; ms: number }[];
  latencyMs?: number;
  held?: string | null;
};

export default function VoicePage() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [listening, setListening] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [interim, setInterim] = useState("");
  const [supported, setSupported] = useState(true);
  const [meta, setMeta] = useState<{ provider?: string; model?: string; productionGrade?: boolean }>({});

  const recognitionRef = useRef<any>(null);
  const sessionIdRef = useRef<string>("");
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    sessionIdRef.current = `browser_${Math.random().toString(36).slice(2, 10)}`;
    const SR =
      (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!SR) { setSupported(false); return; }

    const rec = new SR();
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = "en-US";
    recognitionRef.current = rec;
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, interim]);

  const speak = useCallback((text: string) => {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const voices = window.speechSynthesis.getVoices();
    // Prefer a natural macOS voice when one is installed.
    const preferred =
      voices.find((v) => /Samantha|Ava|Allison|Serena|Daniel/i.test(v.name)) ??
      voices.find((v) => v.lang.startsWith("en"));
    if (preferred) u.voice = preferred;
    u.rate = 1.05;
    window.speechSynthesis.speak(u);
  }, []);

  const send = useCallback(async (text: string) => {
    setTurns((t) => [...t, { who: "you", text }]);
    setThinking(true);
    try {
      const res = await fetch("/api/voice/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: sessionIdRef.current, text }),
      });
      const data = await res.json();

      if (!res.ok) {
        setTurns((t) => [...t, { who: "system", text: data.error ?? "request failed" }]);
        return;
      }

      setMeta({ provider: data.provider, model: data.model, productionGrade: data.productionGrade });

      if (data.reply) {
        setTurns((t) => [...t, {
          who: "agent", text: data.reply, tools: data.toolCalls,
          latencyMs: data.latencyMs, held: data.held,
        }]);
        if (!data.held) speak(data.reply);
      } else {
        setTurns((t) => [...t, {
          who: "system",
          text: data.escalated
            ? `Handed to a human${data.held ? ` — ${data.held}` : ""}. The AI stops here.`
            : "No reply produced.",
          tools: data.toolCalls, latencyMs: data.latencyMs,
        }]);
      }
    } catch (err) {
      setTurns((t) => [...t, { who: "system", text: String(err) }]);
    } finally {
      setThinking(false);
    }
  }, [speak]);

  const toggleMic = useCallback(() => {
    const rec = recognitionRef.current;
    if (!rec) return;

    if (listening) { rec.stop(); setListening(false); return; }

    window.speechSynthesis?.cancel();
    setInterim("");

    rec.onresult = (e: any) => {
      let finalText = "";
      let interimText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const chunk = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += chunk;
        else interimText += chunk;
      }
      setInterim(interimText);
      if (finalText.trim()) { setInterim(""); void send(finalText.trim()); }
    };
    rec.onerror = (e: any) => {
      setTurns((t) => [...t, { who: "system", text: `mic error: ${e.error}` }]);
      setListening(false);
    };
    rec.onend = () => setListening(false);

    rec.start();
    setListening(true);
  }, [listening, send]);

  return (
    <main style={{ maxWidth: 780, margin: "0 auto", padding: "40px 24px 120px" }}>
      <h1 style={{ fontSize: 24, marginBottom: 4 }}>Talk to the agent</h1>
      <p style={{ color: "var(--muted)", marginTop: 0, fontSize: 14 }}>
        You are calling <strong>Northside Heating &amp; Air</strong>. Same pipeline a real
        phone call uses — your browser just replaces the phone line.
      </p>

      {!supported && (
        <Banner tone="danger">
          This browser has no SpeechRecognition API. Use Chrome, or type below.
        </Banner>
      )}
      {meta.provider && !meta.productionGrade && (
        <Banner tone="warn">
          Running on <code>{meta.provider}:{meta.model}</code> — free and local, but slow and
          loose with tools. Set <code>ANTHROPIC_API_KEY</code> for production-speed replies.
        </Banner>
      )}

      <div ref={logRef} style={{
        marginTop: 20, height: 420, overflowY: "auto", padding: 16,
        background: "var(--panel)", border: "1px solid var(--border)",
        borderRadius: "var(--radius)", display: "flex", flexDirection: "column", gap: 14,
      }}>
        {turns.length === 0 && (
          <p style={{ color: "var(--muted)", fontSize: 14, margin: 0 }}>
            Hit the mic and try: <em>“Hi, my AC is blowing warm air and the house is 84 degrees.
            Can someone come out tomorrow?”</em>
          </p>
        )}

        {turns.map((t, i) => <TurnRow key={i} turn={t} />)}

        {interim && (
          <div style={{ alignSelf: "flex-end", color: "var(--muted)", fontStyle: "italic", fontSize: 14 }}>
            {interim}…
          </div>
        )}
        {thinking && <div style={{ color: "var(--muted)", fontSize: 14 }}>agent is thinking…</div>}
      </div>

      <div style={{ display: "flex", gap: 12, marginTop: 16, alignItems: "center" }}>
        <button
          onClick={toggleMic}
          disabled={!supported || thinking}
          style={{
            width: 64, height: 64, borderRadius: "50%",
            border: `2px solid ${listening ? "var(--accent)" : "var(--border)"}`,
            background: listening ? "var(--accent-dim)" : "var(--panel-2)",
            color: "var(--text)", fontSize: 24,
            opacity: !supported || thinking ? 0.4 : 1,
          }}
          aria-label={listening ? "Stop listening" : "Start listening"}
        >
          {listening ? "■" : "🎙"}
        </button>
        <TypeFallback onSend={send} disabled={thinking} />
      </div>
    </main>
  );
}

function TurnRow({ turn }: { turn: Turn }) {
  const isYou = turn.who === "you";
  const isSystem = turn.who === "system";
  return (
    <div style={{ alignSelf: isYou ? "flex-end" : "flex-start", maxWidth: "80%" }}>
      <div style={{
        padding: "10px 14px", borderRadius: 14, fontSize: 15, lineHeight: 1.45,
        background: isYou ? "var(--panel-2)" : isSystem ? "transparent" : "#1d2b22",
        border: isSystem ? "1px dashed var(--border)" : "1px solid var(--border)",
        color: isSystem ? "var(--warn)" : "var(--text)",
      }}>
        {turn.text}
      </div>
      {turn.held && (
        <div style={{ fontSize: 12, color: "var(--danger)", marginTop: 4 }}>
          ⛔ held from sending — {turn.held}
        </div>
      )}
      {(turn.tools?.length || turn.latencyMs) && (
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4, fontFamily: "ui-monospace, monospace" }}>
          {turn.tools?.map((t) => `${t.ok ? "✓" : "✗"} ${t.name} ${t.ms}ms`).join("  ")}
          {turn.latencyMs ? `   ·   ${turn.latencyMs}ms total` : ""}
        </div>
      )}
    </div>
  );
}

function TypeFallback({ onSend, disabled }: { onSend: (t: string) => void; disabled: boolean }) {
  const [value, setValue] = useState("");
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); if (value.trim()) { onSend(value.trim()); setValue(""); } }}
      style={{ flex: 1, display: "flex", gap: 8 }}
    >
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="…or type it instead"
        disabled={disabled}
        style={{
          flex: 1, padding: "14px 16px", borderRadius: 10,
          border: "1px solid var(--border)", background: "var(--panel)",
          color: "var(--text)", fontSize: 15,
        }}
      />
    </form>
  );
}

function Banner({ tone, children }: { tone: "warn" | "danger"; children: React.ReactNode }) {
  return (
    <div style={{
      marginTop: 16, padding: "10px 14px", fontSize: 13, borderRadius: 10,
      border: `1px solid ${tone === "warn" ? "var(--warn)" : "var(--danger)"}`,
      background: tone === "warn" ? "#2a2310" : "#2a1414",
      color: tone === "warn" ? "var(--warn)" : "var(--danger)",
    }}>
      {children}
    </div>
  );
}
