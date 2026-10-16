"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { classifyInterruption, endpointDelayMs } from "./turn-taking";

/** Kept in step with WARM_PHRASES in tts/server.py so these are pre-rendered. */
const FILLERS = ["Let me see.", "One second.", "Mm, okay.", "Right."];

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
  const [ttsReady, setTtsReady] = useState<boolean | null>(null);

  const recognitionRef = useRef<any>(null);
  const sessionIdRef = useRef<string>("");
  const logRef = useRef<HTMLDivElement>(null);

  /** Keeps the mic alive across Chrome's automatic restarts. */
  const wantListening = useRef(false);
  /** The in-flight turn, so a new utterance can cancel it (barge-in). */
  const inflight = useRef<AbortController | null>(null);
  /** The utterance a speculative request was started for. */
  const speculatedFor = useRef<string | null>(null);
  const speculationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fillerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    sessionIdRef.current = `browser_${Math.random().toString(36).slice(2, 10)}`;
    const SR =
      (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!SR) { setSupported(false); return; }

    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    recognitionRef.current = rec;
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, interim]);

  // A silent fallback to the browser voice is indistinguishable from "it just
  // sounds bad", so say which voice is actually in use.
  useEffect(() => {
    fetch("/api/voice/tts")
      .then((r) => r.json())
      .then((d) => setTtsReady(Boolean(d?.ok)))
      .catch(() => setTtsReady(false));
  }, []);


  /**
   * Speak sentences in order as they stream in. Queued rather than fired
   * immediately, because speechSynthesis will talk over itself otherwise.
   */
  /**
   * Speak each sentence as it arrives, in order.
   *
   * Kokoro renders a sentence in well under the time the model takes to
   * generate the next one, so only the FIRST sentence pays the synthesis
   * cost — everything after it is already queued by the time the previous
   * clip finishes. Falls back to the browser's own voice if the local TTS
   * service is not running.
   */
  /**
   * Gapless playback.
   *
   * A reply is spoken as several clips — one per sentence — so that the first
   * sentence starts while the rest is still being generated. Playing them as
   * sequential <audio> elements leaves a pause at every comma and full stop,
   * which is what made the agent sound hesitant.
   *
   * Web Audio schedules each clip to begin exactly where the previous one
   * ends, on the audio clock rather than a JavaScript timer, so the seams are
   * inaudible. Synthesis for every sentence starts the moment its text
   * arrives, so only the first one ever waits — and the common openers are
   * pre-rendered server-side, so usually not even that.
   */
  const audioCtx = useRef<AudioContext | null>(null);
  const nextStartAt = useRef(0);
  const scheduled = useRef<AudioBufferSourceNode[]>([]);
  const chain = useRef<Promise<void>>(Promise.resolve());

  const ctx = useCallback(() => {
    audioCtx.current ??= new (window.AudioContext ?? (window as any).webkitAudioContext)();
    if (audioCtx.current.state === "suspended") void audioCtx.current.resume();
    return audioCtx.current;
  }, []);

  const fetchSpeech = useCallback(async (text: string): Promise<ArrayBuffer | null> => {
    try {
      const res = await fetch("/api/voice/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) return null;
      return await res.arrayBuffer();
    } catch {
      return null;
    }
  }, []);

  const fallbackSpeak = useCallback((text: string) => {
    if (!("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    const voices = window.speechSynthesis.getVoices();
    const preferred =
      voices.find((v) => /Samantha|Ava|Allison|Serena|Daniel/i.test(v.name)) ??
      voices.find((v) => v.lang.startsWith("en"));
    if (preferred) u.voice = preferred;
    u.rate = 1.04;
    window.speechSynthesis.speak(u);
  }, []);

  /**
   * Queue a sentence. Synthesis begins immediately; scheduling is chained so
   * clips are appended to the timeline in the order they were spoken, however
   * the network returns them.
   */
  const enqueueSpeech = useCallback((text: string) => {
    const pending = fetchSpeech(text);
    chain.current = chain.current.then(async () => {
      const bytes = await pending;
      if (!bytes) { fallbackSpeak(text); return; }
      try {
        const ac = ctx();
        const buffer = await ac.decodeAudioData(bytes);
        const src = ac.createBufferSource();
        src.buffer = buffer;
        src.connect(ac.destination);

        // Start where the last clip ends, or now if the queue has drained.
        const startAt = Math.max(ac.currentTime + 0.02, nextStartAt.current);
        src.start(startAt);
        nextStartAt.current = startAt + buffer.duration;

        scheduled.current.push(src);
        src.onended = () => {
          scheduled.current = scheduled.current.filter((x) => x !== src);
        };
      } catch {
        fallbackSpeak(text);
      }
    });
  }, [ctx, fetchSpeech, fallbackSpeak]);

  /** Stop whatever the agent is saying — the caller has started talking. */
  const stopSpeaking = useCallback(() => {
    window.speechSynthesis?.cancel();
    for (const src of scheduled.current) { try { src.stop(); } catch { /* already ended */ } }
    scheduled.current = [];
    nextStartAt.current = 0;
    chain.current = Promise.resolve();
  }, []);

  const send = useCallback(async (text: string, opts: { speculative?: boolean } = {}) => {
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;

    setTurns((t) => [...t, { who: "you", text }]);
    setThinking(true);

    /**
     * Thinking filler.
     *
     * When no canned opener matched, the line is silent until the model
     * produces its first sentence. People do not do that — they say "let me
     * see" and keep the floor. These are pre-rendered, so the filler itself
     * costs nothing, and it is cancelled the moment real speech is ready.
     */
    if (fillerTimer.current) clearTimeout(fillerTimer.current);
    let spokeFiller = false;
    fillerTimer.current = setTimeout(() => {
      spokeFiller = true;
      enqueueSpeech(FILLERS[Math.floor(Math.random() * FILLERS.length)]);
    }, 700);
    const cancelFiller = () => {
      if (fillerTimer.current) { clearTimeout(fillerTimer.current); fillerTimer.current = null; }
    };
    stopSpeaking();

    const tools: { name: string; ok: boolean; ms: number }[] = [];
    let spoken = "";
    let firstWordMs: number | null = null;
    let agentIndex = -1;

    try {
      const res = await fetch("/api/voice/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: sessionIdRef.current, text, speculative: opts.speculative }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const message = await res.text();
        setTurns((t) => [...t, { who: "system", text: message }]);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        let nl: number;
        while ((nl = buf.indexOf("\n\n")) >= 0) {
          const raw = buf.slice(0, nl).replace(/^data: /, "").trim();
          buf = buf.slice(nl + 2);
          if (!raw) continue;

          let ev: Record<string, unknown>;
          try { ev = JSON.parse(raw); } catch { continue; }

          if (ev.type === "sentence") {
            cancelFiller();
            const sentence = String(ev.text);
            firstWordMs ??= Number(ev.msSinceStart);
            spoken = spoken ? `${spoken} ${sentence}` : sentence;
            enqueueSpeech(sentence);
            setThinking(false);

            // Grow one agent bubble rather than adding one per sentence.
            setTurns((t) => {
              const copy = [...t];
              if (agentIndex === -1) {
                agentIndex = copy.length;
                copy.push({ who: "agent", text: sentence, tools, latencyMs: firstWordMs ?? undefined });
              } else {
                copy[agentIndex] = { ...copy[agentIndex], text: spoken };
              }
              return copy;
            });
          } else if (ev.type === "tool") {
            tools.push({ name: String(ev.name), ok: Boolean(ev.ok), ms: Number(ev.ms) });
          } else if (ev.type === "escalated") {
            setTurns((t) => [...t, { who: "system", text: `Handed to a human — ${ev.reason}. The AI stops here.` }]);
          } else if (ev.type === "held") {
            setTurns((t) => {
              const copy = [...t];
              if (agentIndex >= 0) copy[agentIndex] = { ...copy[agentIndex], held: String(ev.reason) };
              return copy;
            });
          } else if (ev.type === "done") {
            setMeta({ provider: String(ev.provider), model: String(ev.model), productionGrade: false });
            setTurns((t) => {
              const copy = [...t];
              if (agentIndex >= 0) {
                copy[agentIndex] = {
                  ...copy[agentIndex],
                  tools,
                  latencyMs: Number(ev.firstWordMs ?? ev.latencyMs),
                };
              }
              return copy;
            });
          } else if (ev.type === "error") {
            setTurns((t) => [...t, { who: "system", text: String(ev.message) }]);
          }
        }
      }
    } catch (err) {
      // An aborted speculative turn is the normal case, not an error.
      if ((err as Error)?.name !== "AbortError") {
        setTurns((t) => [...t, { who: "system", text: String(err) }]);
      }
    } finally {
      cancelFiller();
      void spokeFiller;
      if (inflight.current === controller) inflight.current = null;
      setThinking(false);
    }
  }, [enqueueSpeech, stopSpeaking]);

  const normalise = (t: string) => t.trim().toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ");

  const startListening = useCallback(() => {
    const rec = recognitionRef.current;
    if (!rec) return;
    wantListening.current = true;

    rec.onresult = (e: any) => {
      let finalText = "";
      let interimText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const chunk = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += chunk;
        else interimText += chunk;
      }

      // Only a real floor grab stops the agent. "mm-hmm" and "right" mean
      // carry on, and a single stray word is usually the agent's own audio
      // leaking back into the microphone.
      const heard = (finalText || interimText).trim();
      if (heard) {
        const action = classifyInterruption(heard);
        if (action === "barge_in") stopSpeaking();
        else if (action === "backchannel" || action === "ignore") {
          // Acknowledgement or noise: do not interrupt, and do not treat it
          // as a turn of its own.
          if (!finalText.trim()) { setInterim(interimText); return; }
          if (classifyInterruption(finalText.trim()) !== "barge_in") {
            setInterim("");
            return;
          }
        }
      }

      setInterim(interimText);

      if (finalText.trim()) {
        if (speculationTimer.current) clearTimeout(speculationTimer.current);
        setInterim("");
        const text = finalText.trim();

        // If a speculative turn is already running for exactly this utterance,
        // let it finish rather than starting again.
        if (speculatedFor.current && normalise(speculatedFor.current) === normalise(text)) {
          speculatedFor.current = null;
          return;
        }
        // Otherwise the guess was wrong (or there was none): drop it and run
        // the real thing.
        inflight.current?.abort();
        speculatedFor.current = null;
        void send(text);
        return;
      }

      /**
       * Speculative start.
       *
       * Chrome waits roughly a second of silence before marking a result
       * final. Waiting for that is a second of dead air on every turn, so
       * once the interim transcript has stopped changing for 320ms and looks
       * like a complete thought, the turn starts on the guess. If the final
       * transcript turns out different, the request is aborted and re-sent —
       * the cost of a wrong guess is wasted local compute, not a wrong reply.
       */
      if (speculationTimer.current) clearTimeout(speculationTimer.current);
      const candidate = interimText.trim();
      const delay = endpointDelayMs(candidate);
      if (Number.isFinite(delay) && !speculatedFor.current) {
        speculationTimer.current = setTimeout(() => {
          speculatedFor.current = candidate;
          void send(candidate, { speculative: true });
        }, delay);
      }
    };

    rec.onerror = (e: any) => {
      if (e.error === "no-speech" || e.error === "aborted") return; // normal in continuous mode
      setTurns((t) => [...t, { who: "system", text: `mic error: ${e.error}` }]);
    };

    // Chrome ends the session periodically even with continuous = true.
    rec.onend = () => {
      if (!wantListening.current) { setListening(false); return; }
      try { rec.start(); } catch { /* already starting */ }
    };

    try { rec.start(); setListening(true); } catch { /* already running */ }
  }, [send, stopSpeaking]);

  const stopListening = useCallback(() => {
    wantListening.current = false;
    if (speculationTimer.current) clearTimeout(speculationTimer.current);
    recognitionRef.current?.stop();
    setListening(false);
  }, []);

  const toggleMic = useCallback(() => {
    if (listening) stopListening();
    else startListening();
  }, [listening, startListening, stopListening]);

  useEffect(() => () => { wantListening.current = false; recognitionRef.current?.stop(); }, []);

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
      {ttsReady === false && (
        <Banner tone="warn">
          Kokoro voice service is not running — falling back to the browser&apos;s robotic
          voice. Start it with <code>npm run tts</code>, then reload.
        </Banner>
      )}
      {ttsReady === true && (
        <div style={{
          marginTop: 16, padding: "8px 14px", fontSize: 12, borderRadius: 10,
          border: "1px solid var(--accent)", background: "var(--accent-dim)", color: "var(--accent)",
        }}>
          ♪ Kokoro voice active (Apple GPU)
        </div>
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
            Press the mic once — it keeps listening, so just talk the way you would on a
            call. Try: <em>“Hi, my AC is blowing warm air and the house is 84 degrees.
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
        {listening && !thinking && !interim && (
          <div style={{ color: "var(--accent)", fontSize: 13, display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{
              width: 8, height: 8, borderRadius: "50%", background: "var(--accent)",
              animation: "pulse 1.4s ease-in-out infinite",
            }} />
            listening — speak any time, you can interrupt
          </div>
        )}
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
          title={listening ? "Stop listening" : "Start continuous listening"}
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
          {turn.latencyMs ? `   ·   first word ${turn.latencyMs}ms` : ""}
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
