"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { classifyInterruption, endpointDelayMs } from "./turn-taking";

/** Kept in step with WARM_PHRASES in tts/server.py so these are pre-rendered. */
const FILLERS = [
  "One second.", "Let me check.", "Let me see.", "Bear with me.",
  "Just a sec.", "Let me just have a look.", "Okay, one moment.", "Hmm, let me check that.",
];

const SIGNAL_COLOUR: Record<string, string> = {
  "mic": "var(--muted)",
  "parakeet": "var(--accent)",
  "low confidence": "var(--danger)",
  "backchannel": "var(--accent)",
  "barge-in": "var(--warn)",
  "endpointing": "var(--muted)",
  "filler": "var(--warn)",
};

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
  const [sttReady, setSttReady] = useState<boolean | null>(null);
  /**
   * A live trace of the turn-taking layer.
   *
   * Backchannel detection, semantic endpointing and thinking fillers are all
   * invisible when they work — you notice them only by NOT being interrupted,
   * or by not hearing silence. Showing the decisions makes them checkable
   * rather than something to take on faith.
   */
  const [signals, setSignals] = useState<{ at: number; kind: string; detail: string }[]>([]);
  const note = useCallback((kind: string, detail: string) => {
    setSignals((s) => [...s.slice(-5), { at: Date.now(), kind, detail }]);
  }, []);

  const recognitionRef = useRef<any>(null);
  const sessionIdRef = useRef<string>("");
  const logRef = useRef<HTMLDivElement>(null);

  /** Keeps the mic alive across Chrome's automatic restarts. */
  const wantListening = useRef(false);
  /**
   * In-flight requests, kept apart by kind.
   *
   * There used to be one, and every send cancelled it — including speculative
   * guesses. So while the agent was writing a real reply, the caller's next
   * words started a background guess that cancelled the reply: the opener had
   * already played, and then nothing. A guess may now only cancel another
   * guess. Only a real committed turn supersedes a real reply.
   */
  const inflightReal = useRef<AbortController | null>(null);
  const inflightSpec = useRef<AbortController | null>(null);
  /** The utterance a speculative request was started for. */
  const speculatedFor = useRef<string | null>(null);
  /**
   * Sentences produced by a speculative turn, held back until the transcript
   * confirms the guess.
   *
   * Speculation is meant to hide latency by having the answer READY, not by
   * answering early. Speaking on a guess meant the agent talked over the
   * caller mid-sentence and then stopped and restarted when the real
   * transcript landed — worse than the delay it was avoiding.
   */
  /**
   * Each speculative request owns its own state. A single shared "confirmed"
   * flag meant that a new guess reset it while an earlier confirmed guess was
   * still speaking, and the rest of that reply went back into hiding.
   */
  /** `declined`: the server would not act on this guess (an opt-out). */
  type SpecState = { confirmed: boolean; held: string[]; declined: boolean };
  const currentSpec = useRef<SpecState | null>(null);
  const speculationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fillerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFiller = useRef<string | null>(null);

  /**
   * The turn being spoken, across Chrome's segments.
   *
   * Chrome marks a result "final" after its own short pause — often a breath
   * mid-sentence. Treating that as the end of the turn is what cut callers
   * off before they had finished. Finals are now only segments: they are
   * accumulated here, and the turn is committed by our own endpointing once
   * the caller has actually stopped.
   */
  const utterance = useRef("");
  const liveInterim = useRef("");
  const lastPending = useRef("");
  const lastSpeechAt = useRef(0);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Raw microphone audio for Parakeet, kept in a 60s ring at 16 kHz.
   * `written` counts every sample ever captured, so an utterance can be cut
   * out of the ring by absolute position however many times it has wrapped.
   */
  const RING = 16000 * 60;
  // Lazily allocated: `useRef(new Float32Array(...))` would build and throw
  // away a 3.8 MB buffer on every render.
  const ring = useRef<Float32Array | null>(null);
  const written = useRef(0);
  const utteranceStart = useRef<number | null>(null);
  const capture = useRef<{ ctx: AudioContext; stream: MediaStream } | null>(null);

  /**
   * Echo control. The Parakeet capture is raw — echo cancellation had to go
   * because it starved Chrome's recogniser — so it also hears the agent
   * through the speakers. Two defences: the utterance is cut only from after
   * the agent was last audible, and a transcript that matches something the
   * agent just said is rejected. "AC" was replaced by the agent's own
   * "Let's see." before this.
   */
  const agentAudibleUntil = useRef(0);
  const spokenLog = useRef<{ text: string; at: number }[]>([]);

  useEffect(() => {
    sessionIdRef.current = `browser_${Math.random().toString(36).slice(2, 10)}`;
    const SR =
      (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!SR) { setSupported(false); return; }

    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    // Ask for alternatives so a low-confidence first guess can be replaced by
    // a better-scoring one, rather than being taken as what was said.
    rec.maxAlternatives = 3;
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
    fetch("/api/voice/stt")
      .then((r) => r.json())
      .then((d) => setSttReady(Boolean(d?.ok)))
      .catch(() => setSttReady(false));
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
  /**
   * Prosodic pauses.
   *
   * Butting clips straight together removed the natural breaks in speech and
   * made the agent sound rushed. Human speech pauses roughly 100-300ms at a
   * comma or clause boundary and longer at a full stop, so the gap before the
   * next clip is set by the punctuation the previous one ended on. These are
   * deliberate and consistent, unlike the arbitrary padding the model emits,
   * which is still trimmed.
   */
  const PAUSE_AFTER = (sentence: string): number => {
    const end = sentence.trim().slice(-1);
    if (end === "." || end === "!") return 0.30;
    if (end === "?") return 0.34;   // a question hands over; leave a beat longer
    if (end === "," || end === ";" || end === ":") return 0.14;
    if (end === "—" || end === "-") return 0.18;
    return 0.22;
  };

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
    spokenLog.current = [...spokenLog.current.slice(-12), { text, at: Date.now() }];
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
        nextStartAt.current = startAt + buffer.duration + PAUSE_AFTER(text);

        scheduled.current.push(src);
        src.onended = () => {
          scheduled.current = scheduled.current.filter((x) => x !== src);
        };
      } catch {
        fallbackSpeak(text);
      }
    });
  }, [ctx, fetchSpeech, fallbackSpeak]);

  /** True while agent audio is playing or scheduled to play. */
  const agentSpeaking = useCallback(() => {
    const ac = audioCtx.current;
    if (window.speechSynthesis?.speaking) return true;
    if (!ac) return false;
    return scheduled.current.length > 0 && nextStartAt.current > ac.currentTime;
  }, []);

  /** Stop whatever the agent is saying — the caller has started talking. */
  const stopSpeaking = useCallback(() => {
    window.speechSynthesis?.cancel();
    for (const src of scheduled.current) { try { src.stop(); } catch { /* already ended */ } }
    scheduled.current = [];
    nextStartAt.current = 0;
    chain.current = Promise.resolve();
  }, []);

  const send = useCallback(async (
    text: string,
    // `rerun`: the caller's bubble is already on screen (a released guess the
    // server then declined), so only the reply is still owed.
    opts: { speculative?: boolean; alternatives?: string[]; rerun?: boolean } = {},
  ) => {
    const controller = new AbortController();
    if (opts.speculative) {
      inflightSpec.current?.abort();
      inflightSpec.current = controller;
    } else {
      inflightSpec.current?.abort();
      inflightSpec.current = null;
      inflightReal.current?.abort();
      inflightReal.current = controller;
    }

    const spec: SpecState | null = opts.speculative ? { confirmed: false, held: [], declined: false } : null;
    if (spec) currentSpec.current = spec;

    if (!opts.speculative) {
      if (!opts.rerun) setTurns((t) => [...t, { who: "you", text }]);
      setThinking(true);
    }

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
    if (!opts.speculative) {
      fillerTimer.current = setTimeout(() => {
        spokeFiller = true;
        const choices = FILLERS.filter((x) => x !== lastFiller.current);
        const f = choices[Math.floor(Math.random() * choices.length)];
        lastFiller.current = f;
        note("filler", `nothing ready at 700ms — said "${f}"`);
        enqueueSpeech(f);
      }, 700);
    }
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
        body: JSON.stringify({
          sessionId: sessionIdRef.current, text,
          speculative: opts.speculative,
          alternatives: opts.alternatives?.length ? opts.alternatives : undefined,
        }),
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
            if (spec && !spec.confirmed) {
              // Ready, not spoken. Released only once the caller is confirmed
              // to have said what we guessed.
              spec.held.push(sentence);
              continue;
            }
            firstWordMs ??= Number(ev.msSinceStart);
            spoken = spoken ? `${spoken} ${sentence}` : sentence;
            enqueueSpeech(sentence);
            setThinking(false);

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
          } else if (ev.type === "declined") {
            note("speculate", `declined — ${String(ev.reason)}`);
            // Already released: the caller has finished, so run it for real
            // now. Otherwise commitTurn sees the flag and does.
            if (spec?.confirmed) void send(text, { rerun: true });
            else if (spec) spec.declined = true;
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
      if (inflightReal.current === controller) inflightReal.current = null;
      if (inflightSpec.current === controller) inflightSpec.current = null;
      setThinking(false);
    }
  }, [enqueueSpeech, stopSpeaking, note]);

  /** Open a 16 kHz capture stream feeding the ring buffer. */
  const startCapture = useCallback(async () => {
    if (capture.current) return;
    try {
      /**
       * Raw capture, deliberately with no processing. Asking for echo
       * cancellation on macOS can switch the input into Apple's voice-
       * processing mode, which starved Chrome's own recogniser of audio: the
       * mic appeared on, no events fired, no error was raised, and the agent
       * simply never heard anything. Parakeet copes with unprocessed audio.
       */
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
      const ac = new AudioContext({ sampleRate: 16000 });
      await ac.audioWorklet.addModule("/pcm-capture.js");
      const node = new AudioWorkletNode(ac, "pcm-capture");
      node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
        const frame = ev.data;
        ring.current ??= new Float32Array(RING);
        const buf = ring.current;
        let pos = written.current % RING;
        for (let i = 0; i < frame.length; i++) {
          buf[pos] = frame[i];
          pos = pos + 1 === RING ? 0 : pos + 1;
        }
        written.current += frame.length;
        if (agentSpeaking()) agentAudibleUntil.current = written.current;
      };
      ac.createMediaStreamSource(stream).connect(node);
      capture.current = { ctx: ac, stream };
      note("mic", "parakeet capture running");
      // agentSpeaking is read on every frame; keep it out of the deps loop.
    } catch (err) {
      note("mic", `parakeet capture unavailable — ${(err as Error)?.message ?? "error"}; using browser transcript`);
      // No capture means Parakeet is skipped and the browser transcript is
      // used — accuracy degrades, the call does not.
      capture.current = null;
    }
  }, [note, agentSpeaking]);

  const stopCapture = useCallback(() => {
    capture.current?.stream.getTracks().forEach((t) => t.stop());
    void capture.current?.ctx.close();
    capture.current = null;
  }, []);

  /** Cut [start, now) out of the ring as 16-bit PCM. */
  const cutUtterance = useCallback((start: number): ArrayBuffer | null => {
    const end = written.current;
    const from = Math.max(start, end - RING);
    const n = end - from;
    if (n < 1600) return null; // under 0.1s: nothing worth sending
    const out = new Int16Array(n);
    const buf = ring.current;
    if (!buf) return null;
    for (let i = 0; i < n; i++) {
      const v = buf[(from + i) % RING];
      out[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
    }
    return out.buffer;
  }, []);

  /**
   * Ask Parakeet what was actually said. Bounded: if it is slow or down, the
   * browser's transcript is used, because a correct word late is worse than a
   * near-correct word on time.
   */
  const transcribe = useCallback(async (pcm: ArrayBuffer): Promise<{ text: string | null; why?: string }> => {
    try {
      const res = await fetch("/api/voice/stt", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: pcm,
        signal: AbortSignal.timeout(2500),
      });
      if (!res.ok) return { text: null, why: `service returned ${res.status}` };
      const d = await res.json();
      if (typeof d.text === "string" && d.text.trim()) return { text: d.text.trim() };
      return { text: null, why: "no speech in the captured audio" };
    } catch (err) {
      return { text: null, why: (err as Error)?.name === "TimeoutError" ? "timed out" : "unreachable" };
    }
  }, []);

  /** Share of `a`'s words that also appear in `b`. */
  const coverage = (a: string, b: string) => {
    const aw = normalise(a).split(" ").filter(Boolean);
    const bw = new Set(normalise(b).split(" ").filter(Boolean));
    if (aw.length === 0) return 0;
    return aw.filter((w) => bw.has(w)).length / aw.length;
  };

  /** Does this transcript repeat something the agent said in the last 20s? */
  const isEcho = (heard: string) => {
    const cutoff = Date.now() - 20_000;
    return spokenLog.current.some(
      (s) => s.at >= cutoff && coverage(heard, s.text) >= 0.6,
    );
  };

  const normalise = (t: string) => t.trim().toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ");

  /**
   * The caller said what we guessed. Show their turn, speak whatever the
   * speculative run already produced, and let the rest of that same stream
   * speak as it arrives — so the work done while they were still talking is
   * exactly the latency saved.
   */
  const releaseSpeculation = useCallback((text: string) => {
    const spec = currentSpec.current;
    if (spec) spec.confirmed = true;
    inflightReal.current?.abort();
    inflightReal.current = inflightSpec.current;
    inflightSpec.current = null;
    setTurns((t) => [...t, { who: "you", text }]);
    const held = spec ? spec.held.splice(0) : [];
    for (const sentence of held) enqueueSpeech(sentence);
    if (held.length > 0) setThinking(false);
  }, [enqueueSpeech]);

  const startListening = useCallback(() => {
    const rec = recognitionRef.current;
    if (!rec) return;
    wantListening.current = true;

    /** Commit what the caller has said as one turn. */
    const commitTurn = async () => {
      if (commitTimer.current) { clearTimeout(commitTimer.current); commitTimer.current = null; }
      if (speculationTimer.current) { clearTimeout(speculationTimer.current); speculationTimer.current = null; }

      const browserText = `${utterance.current} ${liveInterim.current}`.trim();
      const start = utteranceStart.current;
      utterance.current = "";
      liveInterim.current = "";
      lastPending.current = "";
      utteranceStart.current = null;
      setInterim("");
      if (!browserText) return;

      /**
       * Two recognisers, reconciled rather than one overriding the other.
       *
       *  - Parakeet repeating the agent's own words is echo: discarded.
       *  - Parakeet covering most of what Chrome heard is a correction or an
       *    extension (Chrome often drops the end of a sentence): Parakeet wins.
       *  - A genuine disagreement is not settled here at all. The model gets
       *    one as the transcript and the other as an alternative hearing, and
       *    decides from the conversation which the caller meant — it knows an
       *    HVAC call is far likelier to contain "AC" than "answer".
       */
      let text = browserText;
      const alternatives: string[] = [];
      const pcm = start !== null ? cutUtterance(start) : null;
      if (pcm) {
        const t0 = performance.now();
        const result = await transcribe(pcm);
        const heard = result.text;
        const ms = Math.round(performance.now() - t0);

        if (!heard) {
          note("parakeet", `${result.why ?? "unavailable"} — used browser transcript`);
        } else if (normalise(heard) === normalise(browserText)) {
          note("parakeet", `${ms}ms — confirmed`);
        } else if (isEcho(heard)) {
          note("parakeet", `${ms}ms — ignored "${heard.slice(0, 26)}": that was the agent's own voice`);
        // Parakeet overrules Chrome only when it contains essentially
        // everything Chrome heard — a corrected word, or the end of a sentence
        // Chrome dropped. At 0.5 it overruled "send me all options of basis"
        // with "all the options of research is like to have"; on real
        // microphone audio Parakeet is not reliably better, so anything short
        // of near-agreement goes to the model as two hearings instead.
        } else if (coverage(browserText, heard) >= 0.8) {
          note("parakeet", `${ms}ms — corrected "${browserText.slice(0, 20)}" → "${heard.slice(0, 22)}"`);
          text = heard;
        } else {
          note("parakeet", `${ms}ms — unsure: "${browserText.slice(0, 18)}" or "${heard.slice(0, 18)}" — model decides`);
          alternatives.push(heard);
        }
      }

      // The speculative run already started on exactly this — release it.
      if (
        speculatedFor.current && normalise(speculatedFor.current) === normalise(text) &&
        !currentSpec.current?.declined
      ) {
        speculatedFor.current = null;
        releaseSpeculation(text);
        return;
      }
      // Guess was wrong, or there was none: drop the guess and run the real turn.
      inflightSpec.current?.abort();
      inflightSpec.current = null;
      currentSpec.current = null;
      speculatedFor.current = null;
      void send(text, { alternatives });
    };

    rec.onresult = (e: any) => {
      let finalText = "";
      let interimText = "";
      let lowestConfidence = 1;

      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        // Prefer the highest-confidence alternative, not simply the first.
        let best = result[0];
        for (let k = 1; k < result.length; k++) {
          if ((result[k]?.confidence ?? 0) > (best?.confidence ?? 0)) best = result[k];
        }
        const chunk = best?.transcript ?? result[0].transcript;
        if (result.isFinal) {
          finalText += chunk;
          const c = best?.confidence ?? 1;
          if (c > 0) lowestConfidence = Math.min(lowestConfidence, c);
        } else {
          interimText += chunk;
        }
      }

      if (finalText.trim() && lowestConfidence < 0.65) {
        note("low confidence", `${(lowestConfidence * 100).toFixed(0)}% — "${finalText.trim().slice(0, 30)}"`);
      }

      const heard = (finalText || interimText).trim();

      /**
       * Backchannel vs barge-in only applies WHILE the agent is talking.
       * "mm-hmm" over the agent means carry on; "yes" after the agent has
       * asked "shall I book Thursday?" is the answer. The old check did not
       * know the difference and could throw a "yes" away.
       */
      if (heard && agentSpeaking()) {
        const action = classifyInterruption(heard);
        if (action === "barge_in") {
          note("barge-in", `"${heard.slice(0, 28)}" — stopped the agent`);
          stopSpeaking();
        } else {
          if (action === "backchannel") note("backchannel", `"${heard.slice(0, 20)}" — kept going`);
          return; // not a turn of its own
        }
      }

      if (utteranceStart.current === null && (finalText.trim() || interimText.trim())) {
        // Pre-roll catches the opening word Chrome reports late, but never
        // reaches back into audio where the agent was talking.
        utteranceStart.current = Math.max(0, written.current - 16000 * 0.8, agentAudibleUntil.current);
      }
      if (finalText.trim()) {
        utterance.current = `${utterance.current} ${finalText.trim()}`.trim();
      }
      liveInterim.current = interimText.trim();

      const pending = `${utterance.current} ${liveInterim.current}`.trim();
      if (!pending) return;

      // Only a change in WHAT was said counts as speech. Chrome's final event
      // usually repeats the last interim word for word, and counting that as
      // fresh speech would double the wait.
      const now = performance.now();
      if (pending !== lastPending.current) {
        lastPending.current = pending;
        lastSpeechAt.current = now;
      }
      const sinceSpeech = now - lastSpeechAt.current;

      setInterim(pending);

      const delay = endpointDelayMs(pending);
      if (!Number.isFinite(delay)) {
        // Too little to judge yet — wait longer, but never forever.
        if (commitTimer.current) clearTimeout(commitTimer.current);
        commitTimer.current = setTimeout(() => void commitTurn(), Math.max(0, 1800 - sinceSpeech));
        return;
      }

      note("endpointing", `waiting ${delay}ms — "${pending.slice(-26)}"`);

      // Commit once the caller has been quiet for the endpoint delay.
      if (commitTimer.current) clearTimeout(commitTimer.current);
      commitTimer.current = setTimeout(() => void commitTurn(), Math.max(0, delay - sinceSpeech));

      /**
       * Speculative start — silent pre-computation, released only on commit.
       * Started at roughly half the commit delay on sentences that sound
       * finished, never on ones trailing off mid-thought.
       */
      if (speculationTimer.current) clearTimeout(speculationTimer.current);
      if (delay <= 900 && normalise(speculatedFor.current ?? "") !== normalise(pending)) {
        const specAt = Math.max(0, Math.min(delay * 0.5, 450) - sinceSpeech);
        speculationTimer.current = setTimeout(() => {
          const guess = `${utterance.current} ${liveInterim.current}`.trim();
          if (!guess) return;
          speculatedFor.current = guess;
          void send(guess, { speculative: true });
        }, specAt);
      }
    };

    rec.onerror = (e: any) => {
      if (e.error === "no-speech" || e.error === "aborted") return; // normal in continuous mode
      note("mic", `recogniser error: ${e.error}`);

      /**
       * Fatal errors must stop the auto-restart. Otherwise onend restarts
       * the recogniser, it fails again at once, and it spins in a tight loop
       * without ever telling the caller what is wrong.
       */
      const FATAL: Record<string, string> = {
        "not-allowed": "Microphone permission is blocked. Click the lock icon in the address bar, allow the microphone, then reload.",
        "service-not-allowed": "Chrome's speech service is not allowed here. Check the site's microphone permission and reload.",
        "audio-capture": "No microphone could be opened. Check it is connected and not in use by another app, then reload.",
        "network": "Chrome's speech recogniser could not reach its service. Check your connection.",
      };
      if (FATAL[e.error]) {
        wantListening.current = false;
        setListening(false);
        setTurns((t) => [...t, { who: "system", text: FATAL[e.error] }]);
      }
    };

    /**
     * Chrome ends a recognition session every few seconds even with
     * `continuous` set, and audio spoken during the gap is simply lost —
     * which is why a sentence sometimes arrives with its middle missing.
     * Restarting on the same tick keeps that window as small as the API
     * allows; a failed immediate restart is retried once on the next frame
     * rather than waiting for a timer.
     */
    rec.onend = () => {
      if (!wantListening.current) { setListening(false); return; }
      try {
        rec.start();
      } catch {
        requestAnimationFrame(() => {
          if (!wantListening.current) return;
          try { rec.start(); } catch { /* already running */ }
        });
      }
    };

    // Visible lifecycle: a recogniser that starts but never receives audio
    // fails silently otherwise, which is exactly the failure being fixed.
    rec.onstart = () => note("mic", "recogniser started");
    rec.onaudiostart = () => {
      note("mic", "recogniser hearing audio");
      // Attach the Parakeet capture only once Chrome's recogniser already has
      // the device, so it is never the one left without audio.
      void startCapture();
    };
    rec.onspeechstart = () => note("mic", "speech detected");

    try {
      rec.start();
      setListening(true);
    } catch (err) {
      // Previously swallowed, which left the button looking idle with no
      // explanation.
      note("mic", `could not start recogniser — ${(err as Error)?.message ?? "error"}`);
    }
  }, [send, stopSpeaking, note, agentSpeaking, releaseSpeculation, startCapture, cutUtterance, transcribe]);

  const stopListening = useCallback(() => {
    wantListening.current = false;
    if (speculationTimer.current) clearTimeout(speculationTimer.current);
    if (commitTimer.current) clearTimeout(commitTimer.current);
    utterance.current = "";
    liveInterim.current = "";
    utteranceStart.current = null;
    stopCapture();
    recognitionRef.current?.stop();
    setListening(false);
  }, [stopCapture]);

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
      {sttReady === true && (
        <div style={{
          marginTop: 8, padding: "8px 14px", fontSize: 12, borderRadius: 10,
          border: "1px solid var(--accent)", background: "var(--accent-dim)", color: "var(--accent)",
        }}>
          🎙 Parakeet transcription active (Apple GPU)
        </div>
      )}
      {sttReady === false && (
        <Banner tone="warn">
          Parakeet is not running — using the browser&apos;s recogniser, which drops words.
          Start it with <code>npm run stt</code>, then reload.
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

      {signals.length > 0 && (
        <div style={{
          marginTop: 10, padding: "8px 12px", borderRadius: 9,
          border: "1px solid var(--border)", background: "var(--panel)",
          fontFamily: "ui-monospace, monospace", fontSize: 11, color: "var(--muted)",
          display: "flex", flexDirection: "column", gap: 3,
        }}>
          <div style={{ color: "var(--muted)", opacity: 0.6, marginBottom: 2 }}>turn-taking</div>
          {signals.map((sig, i) => (
            <div key={sig.at + "-" + i}>
              <span style={{ color: SIGNAL_COLOUR[sig.kind] ?? "var(--muted)" }}>
                {sig.kind.padEnd(12)}
              </span>
              {sig.detail}
            </div>
          ))}
        </div>
      )}

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
