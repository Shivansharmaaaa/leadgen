import type { TenantSettings } from "@/server/db";

/**
 * How each sentence should SOUND, decided from the call — engine-neutral.
 *
 * The words come from the model; the delivery is decided here, by rule, the
 * way Gate 1 decides safety: a 3B model asked to annotate its own emotion
 * would do it inconsistently, and a wrong tone on a phone call ("[cheerfully]
 * please leave the house now") is worse than none. Five things a person
 * adjusts without thinking, and how each is read from the call:
 *
 *   tone       the tenant's persona: warm, professional or casual
 *   pacing     slower where a mistake is costly: a time, a price, a number,
 *              a safety instruction; quicker on a short acknowledgement
 *   emotion    from what the caller just said and what the sentence does:
 *              sympathy for a fault, steadiness for an emergency, brightness
 *              for a booking made, calm for bad news
 *   character  per tenant: the agent's name, accent and energy
 *   context    the caller's words, the sentence's place in the reply, and
 *              what happened this turn (a booking, the urgent note, Gate 1)
 *
 * What it never does on a business line: laugh, whisper, sound excited about
 * a problem, or put on any emotion the facts do not support. Those tags are
 * for audiobooks and games; to a caller with no heat they sound like mockery.
 *
 * The plan renders to each engine's own controls: ElevenLabs v3 audio tags
 * (eleven_v3_conversational), SSML (Twilio <Say>, Polly, Azure, Google),
 * a natural-language instruction (instruction-following TTS), or plain speed
 * and silence for engines with no style control (Kokoro).
 */

export type Style = "warm" | "empathetic" | "reassuring" | "calm" | "bright" | "neutral";

export type Persona = {
  name: string;
  tone: "warm" | "professional" | "casual";
  accent: "american" | "canadian" | "british";
  /** The persona's normal pace, relative to the engine's own default. */
  baseRate: number;
  /** One line for engines that take a voice description. */
  description: string;
};

export type DeliveryContext = {
  /** What the caller just said. */
  heard: string;
  /** This sentence's place in the reply, from 0. */
  index: number;
  /** How many sentences the reply has, when known. */
  count?: number;
  /** Gate 1's safety reply: gas, carbon monoxide, fire. */
  safety?: boolean;
  /** A booking was made this turn. */
  booked?: boolean;
  /** The urgent note fired this turn. */
  urgent?: boolean;
};

export type Delivery = {
  text: string;
  style: Style;
  /** Multiplies the engine's default speed: persona pace × this sentence's pace. */
  rate: number;
  pauseBeforeMs: number;
  pauseAfterMs: number;
  /** Exact substrings of `text` to stress: the time, the price, the instruction. */
  emphasis: string[];
  /** Why: for the call log and the tests. */
  reason: string;
};

// ─── Persona ────────────────────────────────────────────────────────────────

const ACCENT: Record<string, Persona["accent"]> = { US: "american", CA: "canadian", GB: "british" };
const ACCENT_WORDS: Record<Persona["accent"], string> = { american: "an American", canadian: "a Canadian", british: "a British" };
const PACE: Record<Persona["tone"], number> = { warm: 1, professional: 0.97, casual: 1.03 };
const MANNER: Record<Persona["tone"], string> = {
  warm: "warm, unhurried and kind",
  professional: "calm, clear and composed",
  casual: "friendly, easy-going and upbeat",
};

export function personaFor(settings: TenantSettings | null | undefined, country = "US"): Persona {
  const tone = settings?.tone ?? "warm";
  const name = settings?.agentName ?? "Alex";
  const accent = ACCENT[country] ?? "american";
  return {
    name, tone, accent, baseRate: PACE[tone],
    description: `${name}: ${ACCENT_WORDS[accent]} voice, ${MANNER[tone]}, speaking on the phone for a small business`,
  };
}

// ─── Reading the call ───────────────────────────────────────────────────────

/** "Tuesday at 10 AM", "today at 3:30 PM", "9:30 AM". */
const TIME = /\b(?:(?:today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+at\s+)?\d{1,2}(?::\d{2})?\s?(?:am|pm|a\.m\.|p\.m\.)/gi;
/** "$89", "£1,450", "eighty-nine dollars", "a hundred and fifty dollars", "ninety-five pounds an hour". */
const MONEY = /[$£€]\s?\d[\d,]*(?:\.\d{2})?|\b(?:(?:a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|and|[-\s])+)\s(?:dollars|pounds|euros|bucks)\b/gi;
const PHONE = /(?:\+?\d[\d\s().-]{7,}\d)/g;

const APOLOGY = /\b(?:sorry|no fun|that's rough|miserable|frustrating|not good|that's a pain|oh no|i'm afraid)\b/i;
const URGENT_ACK = /\b(?:treat (?:this|it) as urgent|as soon as (?:possible|we can)|earliest i have|right away)\b/i;
const CONFIRMED = /\b(?:you're (?:all )?booked|all set|you're down for|that's booked|booked (?:you|it) in)\b/i;
const PLEASANTRY = /^(?:hi|hello|thanks|thank you|you're welcome|no problem|lovely|great|perfect|congratulations|bye|take care|have a (?:good|great|lovely))\b/i;
const BAD_NEWS = /\b(?:we don't|we do not|isn't something we|we only|no one can (?:promise|guarantee)|can't (?:promise|guarantee|change)|i can't see|not (?:something|in our))\b/i;

/** The caller is struggling: a fault with someone vulnerable, fear, a deadline, distress. */
const DISTRESS = /\b(?:newborn|baby|infant|elderly|heart condition|oxygen|freezing|scared|worried|panicking|desperate|stressed|upset|crying|refused|rejected|expires?|expiring|running out|deport\w*|emergency|urgent)\b/i;
/** Pushing back: price, doubt, delay. The answer starts by taking it seriously, not quickly. */
const OBJECTION = /\b(?:steep|expensive|too much|a lot|pricey|cheaper|not sure|think about it|other quotes?|another (?:company|consultant)|legit|guarantee|why would i)\b/i;
/** A fault or a problem worth a moment's sympathy. */
const TROUBLE = /\b(?:broken|not working|stopped|won't|isn't (?:working|cooling|heating)|no heat|leak\w*|noise|grinding|banging|warm air|died|iced|nervous|struggling)\b/i;

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const round = (x: number) => Math.round(x * 100) / 100;

function matches(re: RegExp, text: string): string[] {
  return [...text.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"))]
    .map((m) => m[0].trim()).filter(Boolean);
}

// ─── Planning ───────────────────────────────────────────────────────────────

export function planDelivery(sentence: string, ctx: DeliveryContext, persona: Persona): Delivery {
  const text = sentence.trim();
  const times = matches(TIME, text);
  const money = matches(MONEY, text);
  const phones = matches(PHONE, text).filter((p) => p.replace(/\D/g, "").length >= 7);
  const question = /\?\s*$/.test(text);
  const last = ctx.count != null && ctx.index === ctx.count - 1;

  let style: Style;
  let reason: string;
  let rate = 1;
  let emphasis: string[] = [];

  if (ctx.safety) {
    // A safety instruction is read slowly and evenly: it has to be acted on.
    style = "calm"; reason = "safety instruction"; rate = 0.88;
    emphasis = matches(/\bleave the house now\b|\bcall 911\b|\bcall 999\b|\bdon't switch anything on or off\b/gi, text);
  } else if (URGENT_ACK.test(text) || (ctx.urgent && ctx.index === 0)) {
    style = "reassuring"; reason = "urgent: steady, not rushed"; rate = 0.95;
  } else if (ctx.booked && CONFIRMED.test(text)) {
    style = "bright"; reason = "booking confirmed";
  } else if (APOLOGY.test(text) || (ctx.index === 0 && (DISTRESS.test(ctx.heard) || TROUBLE.test(ctx.heard)) && !PLEASANTRY.test(text))) {
    style = "empathetic"; reason = DISTRESS.test(ctx.heard) ? "caller is distressed" : "caller has a problem";
  } else if (ctx.index === 0 && OBJECTION.test(ctx.heard) && !BAD_NEWS.test(text)) {
    style = "warm"; reason = "acknowledging a concern";
  } else if (BAD_NEWS.test(text)) {
    style = "calm"; reason = "a no, said gently";
  } else if (PLEASANTRY.test(text)) {
    // Never bright at someone in trouble.
    style = DISTRESS.test(ctx.heard) ? "warm" : "bright"; reason = "pleasantry";
  } else if (money.length || phones.length) {
    style = "neutral"; reason = "facts to get right";
  } else {
    style = persona.tone === "professional" ? "neutral" : "warm"; reason = `persona: ${persona.tone}`;
  }

  // Pacing: slow where a mistake is costly, quick where nothing is at stake.
  if (times.length) { rate *= 0.92; emphasis.push(...times); }
  if (money.length) { rate *= 0.94; emphasis.push(...money); }
  if (phones.length) { rate *= 0.85; emphasis.push(...phones); }
  if (!ctx.safety && !times.length && !money.length && words(text) <= 4 && reason !== "acknowledging a concern") rate *= 1.05;
  if (words(text) > 22) rate *= 0.97;
  if (style === "empathetic") rate *= 0.96;

  const pauseBeforeMs = ctx.index === 0 ? 0 : times.length || money.length || ctx.safety ? 160 : 60;
  // After a question the caller should answer at once; after a statement, a beat.
  const pauseAfterMs = question || last ? 0 : ctx.safety ? 260 : words(text) <= 4 ? 80 : 140;

  return {
    text, style, reason,
    rate: round(clamp(rate * persona.baseRate, 0.8, 1.12)),
    pauseBeforeMs, pauseAfterMs,
    emphasis: [...new Set(emphasis)].filter((e) => text.includes(e)),
  };
}

/** A whole reply, sentence by sentence, with the context shared. */
export function planReply(sentences: string[], ctx: Omit<DeliveryContext, "index" | "count">, persona: Persona): Delivery[] {
  return sentences.map((s, index) => planDelivery(s, { ...ctx, index, count: sentences.length }, persona));
}

// ─── Stage directions never reach a caller ──────────────────────────────────

/**
 * "[laughs]", "(sighs)", "*chuckles*", "<laugh>" written by a model. An engine
 * with no tag support reads them out ("laughs"), and on a business line the
 * emotion is not the model's to choose. Delivery is planned here instead.
 */
const STAGE_DIRECTION = /\s*(?:\[[a-z][a-z\s-]{1,24}\]|\((?:laughs?|chuckles?|sighs?|whispers?|giggles?|gasps?|clears throat|pauses?|smiles?|excited|softly|warmly)\)|\*[a-z][a-z\s-]{1,24}\*|<\/?(?:laugh|chuckle|sigh|gasp|cough|sniffle|groan|yawn)>)\s*/gi;

export function stripStageDirections(text: string): string {
  return text.replace(STAGE_DIRECTION, " ").replace(/\s{2,}/g, " ").replace(/\s+([.,!?])/g, "$1").trim();
}

// ─── Renderers ──────────────────────────────────────────────────────────────

/** ElevenLabs v3 audio tags. Only eleven_v3_conversational streams; plain eleven_v3 is not real-time. */
const ELEVEN_TAG: Record<Style, string | null> = {
  warm: "[warmly]", empathetic: "[sympathetic]", reassuring: "[reassuring]", calm: "[calmly]", bright: "[cheerfully]", neutral: null,
};

export function toElevenLabs(d: Delivery): { text: string; voiceSettings: { speed: number } } {
  const tag = ELEVEN_TAG[d.style];
  // Pauses are the player's silence between sentences: an ellipsis makes v3 sound hesitant.
  return {
    text: `${tag ? `${tag} ` : ""}${d.text}`,
    // ElevenLabs accepts 0.7–1.2.
    voiceSettings: { speed: round(clamp(d.rate, 0.7, 1.2)) },
  };
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** SSML: Twilio <Say>, Amazon Polly, Azure, Google. Style is carried by rate and breaks; few engines take more. */
export function toSsml(d: Delivery): string {
  let body = xml(d.text);
  for (const e of [...d.emphasis].sort((a, b) => b.length - a.length)) {
    const safe = xml(e);
    if (body.includes(safe) && !body.includes(`>${safe}<`)) body = body.replace(safe, `<emphasis level="moderate">${safe}</emphasis>`);
  }
  const before = d.pauseBeforeMs ? `<break time="${d.pauseBeforeMs}ms"/>` : "";
  const after = d.pauseAfterMs ? `<break time="${d.pauseAfterMs}ms"/>` : "";
  return `<speak>${before}<prosody rate="${Math.round(d.rate * 100)}%">${body}</prosody>${after}</speak>`;
}

const MOOD: Record<Style, string> = {
  warm: "warmly", empathetic: "with gentle sympathy", reassuring: "steadily and reassuringly",
  calm: "calmly and evenly", bright: "brightly, pleased", neutral: "clearly and plainly",
};

/** For instruction-following TTS: one sentence of direction, never a character to play. */
export function toInstruction(d: Delivery, persona: Persona): string {
  const pace = d.rate < 0.93 ? "a little slower than usual" : d.rate > 1.03 ? "a touch quicker" : "at a natural pace";
  const stress = d.emphasis.length ? ` Stress ${d.emphasis.map((e) => `"${e}"`).join(" and ")}.` : "";
  return `Speak ${MOOD[d.style]}, ${pace}, as ${persona.description}.${stress}`;
}

/** Words inside a stressed span that carry no stress of their own. */
const UNSTRESSED = /^(?:at|and|or|a|an|the|of|for|on|in|to|is|it's|am|pm|dollars|pounds|euros|bucks)$/i;

/**
 * Kokoro's G2P (misaki) reads "[word](+1)" as a stress mark: tested through
 * :8787/speak, the markup is parsed rather than spoken and changes the audio.
 * Only plain words are marked; digits are left as they are, untested.
 */
export function kokoroStress(text: string, emphasis: string[]): string {
  const ranges: [number, number][] = [];
  for (const e of emphasis) {
    const at = text.indexOf(e);
    if (at >= 0 && !ranges.some(([a, b]) => at < b && at + e.length > a)) ranges.push([at, at + e.length]);
  }
  ranges.sort((x, y) => x[0] - y[0]);
  let out = "", cursor = 0;
  for (const [a, b] of ranges) {
    out += text.slice(cursor, a) + text.slice(a, b).replace(/[A-Za-z][A-Za-z'-]*/g, (w) => (UNSTRESSED.test(w) ? w : `[${w}](+1)`));
    cursor = b;
  }
  return out + text.slice(cursor);
}

/**
 * Engines with speed and nothing else (Kokoro): the pace, plus silence the
 * player inserts. `stress` adds Kokoro's stress marks; off until someone has
 * listened and confirmed it sounds like emphasis.
 */
export function toSpeedOnly(d: Delivery, engineDefault: number, opts: { stress?: boolean } = {}) {
  return {
    text: opts.stress ? kokoroStress(d.text, d.emphasis) : d.text,
    speed: round(engineDefault * d.rate), pauseBeforeMs: d.pauseBeforeMs, pauseAfterMs: d.pauseAfterMs,
  };
}

/**
 * Engines whose only style control is the reference clip they clone
 * (OmniVoice): one recording per persona per style, the persona's base clip
 * when that style has none. Speed still comes from the plan.
 */
export function toReferenceClip(d: Delivery, persona: Persona, recorded: ReadonlySet<string>) {
  const key = (style: Style) => `${persona.name.toLowerCase()}-${style}`;
  const base: Style = persona.tone === "professional" ? "neutral" : "warm";
  const clip = recorded.has(key(d.style)) ? key(d.style) : recorded.has(key(base)) ? key(base) : null;
  return { text: d.text, clip, speed: d.rate, pauseBeforeMs: d.pauseBeforeMs, pauseAfterMs: d.pauseAfterMs };
}
