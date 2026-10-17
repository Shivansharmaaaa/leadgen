import {
  personaFor, planDelivery, planReply, stripStageDirections, toElevenLabs, toSsml, toInstruction, toSpeedOnly, toReferenceClip,
} from "@/server/voice/delivery";
import { safetyReply } from "@/server/core/guardrails";

/**
 * How each spoken sentence is delivered: tone, pace, emotion, persona and
 * context, decided by rule and rendered for each kind of TTS engine.
 *
 *   npm run delivery:test
 */
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}

const alex = personaFor({ agentName: "Alex", tone: "warm" }, "US");
const sam = personaFor({ agentName: "Sam", tone: "warm" }, "GB");
const pro = personaFor({ agentName: "Maya", tone: "professional" }, "CA");
const plan = (s: string, heard: string, extra: Partial<Parameters<typeof planDelivery>[1]> = {}, p = alex) =>
  planDelivery(s, { heard, index: 0, ...extra }, p);

console.log("\nCharacter: each tenant sounds like itself");
check("Sam is British, Maya is Canadian", sam.accent === "british" && pro.accent === "canadian");
check("a professional persona is a touch slower than a casual one",
  pro.baseRate < personaFor({ tone: "casual" }, "US").baseRate);
check("the description names the agent", sam.description.startsWith("Sam:"), sam.description);
check("… in good English", personaFor({ agentName: "Alex" }, "US").description.startsWith("Alex: an American voice"), personaFor({ agentName: "Alex" }, "US").description);

console.log("\nEmotion: read from the caller and the sentence");
const gas = planReply(safetyReply("Northside Heating & Air").split(/(?<=[.!?])\s+/), { heard: "I smell gas in the basement", safety: true }, alex);
check("the gas-leak instruction is calm, never bright", gas.every((d) => d.style === "calm"), gas.map((d) => d.style).join(","));
check("… and slow enough to act on", gas.every((d) => d.rate <= 0.9), gas.map((d) => d.rate).join(","));
check("… stressing 'leave the house now'", gas[0].emphasis.includes("leave the house now"), gas[0].emphasis.join("|"));
const urgent = plan("With no heat and a newborn at home, I'll treat this as urgent.", "Our furnace stopped and we have a newborn", { urgent: true });
check("an emergency is met steadily", urgent.style === "reassuring", urgent.style);
const sorry = plan("Ninety degrees with warm air coming out is miserable.", "My AC is blowing warm air and it's ninety degrees");
check("a fault gets sympathy first", sorry.style === "empathetic", `${sorry.style}: ${sorry.reason}`);
const booked = planDelivery("You're booked for Tuesday at 10 AM, Dana.", { heard: "Tuesday at 10 works", index: 0, booked: true }, alex);
check("a booking made sounds pleased", booked.style === "bright", booked.style);
const claim = planDelivery("You're booked for Tuesday at 10 AM, Dana.", { heard: "Tuesday at 10 works", index: 0, booked: false }, alex);
check("… but not when no booking was made this turn", claim.style !== "bright", claim.style);
const no = plan("We don't do plumbing, sorry, just heating and cooling.", "Can you fix my water heater?");
check("a no is said gently, not brightly", no.style === "empathetic" || no.style === "calm", no.style);
const thanks = plan("You're welcome, Grace. Bye now.", "Thanks so much, bye");
check("a goodbye is bright", thanks.style === "bright", thanks.style);
const thanksDistressed = plan("Thanks for bearing with me.", "my work permit expires next week and I'm panicking");
check("… but never bright at someone in distress", thanksDistressed.style !== "bright", thanksDistressed.style);
const steep = plan("I understand.", "A hundred and fifty dollars just to talk to someone? That's steep.", {}, pro);
check("a price objection is acknowledged warmly, even by a professional persona", steep.style === "warm", steep.style);
check("… and not hurried", steep.rate <= pro.baseRate, String(steep.rate));
const guarantee = plan("No one can promise an approval, because IRCC makes the decision.", "Can you guarantee my visa?", {}, pro);
check("'no one can promise' is calm", guarantee.style === "calm", guarantee.style);
const plain = plan("Have you taken a language test yet?", "I want to apply for Express Entry", {}, pro);
check("a professional persona's plain question is neutral", plain.style === "neutral", plain.style);

console.log("\nPacing: slow where a mistake costs, quick where nothing is at stake");
const offer = planDelivery("I have Tuesday at 10 AM or Wednesday at 2:30 PM.", { heard: "what times do you have?", index: 1, count: 2 }, alex);
check("two offered times slow the sentence down", offer.rate < alex.baseRate, String(offer.rate));
check("… and both times are stressed", offer.emphasis.includes("Tuesday at 10 AM") && offer.emphasis.includes("Wednesday at 2:30 PM"), offer.emphasis.join("|"));
check("… with a beat before them", offer.pauseBeforeMs > 0);
const price = plan("It's a hundred and fifty dollars for a forty-five-minute consultation.", "how much is it?", {}, pro);
check("a price is stressed and slowed", price.emphasis.some((e) => e.includes("hundred and fifty dollars")) && price.rate < pro.baseRate, `${price.rate} ${price.emphasis.join("|")}`);
const pounds = plan("It's fourteen hundred and fifty pounds for the package.", "and the package?", {}, sam);
check("pounds are found too", pounds.emphasis.some((e) => e.includes("fourteen hundred and fifty pounds")), pounds.emphasis.join("|"));
const ack = plan("Got it.", "my name's Dana");
check("a short acknowledgement is quicker", ack.rate > alex.baseRate, String(ack.rate));
const q = planDelivery("Which works better?", { heard: "", index: 2, count: 3 }, alex);
check("no pause after a question: the caller answers at once", q.pauseAfterMs === 0);
check("rates stay between 0.8 and 1.12", [...gas, urgent, sorry, offer, price, ack].every((d) => d.rate >= 0.8 && d.rate <= 1.12));

console.log("\nStage directions never reach a caller");
check("'[laughs]' is removed", stripStageDirections("[laughs] That's a good one.") === "That's a good one.");
check("'(sighs)', '*chuckles*' and '<laugh>' too",
  stripStageDirections("Okay (sighs) sure *chuckles* fine <laugh> done.") === "Okay sure fine done.", stripStageDirections("Okay (sighs) sure *chuckles* fine <laugh> done."));
check("ordinary brackets are left alone", stripStageDirections("Call us (we're open till five).") === "Call us (we're open till five).");
check("a time in brackets survives", stripStageDirections("Tuesday (10 AM) works.") === "Tuesday (10 AM) works.");

console.log("\nRendering for each engine");
const el = toElevenLabs(urgent);
check("ElevenLabs gets a v3 audio tag", el.text.startsWith("[reassuring] "), el.text);
check("… and no ellipsis: pauses are the player's", !toElevenLabs(offer).text.includes("…"), toElevenLabs(offer).text);
check("… and a speed inside 0.7–1.2", el.voiceSettings.speed >= 0.7 && el.voiceSettings.speed <= 1.2);
check("… never a playful tag", ![...gas, urgent, sorry, booked, no, thanks, offer, price].some((d) =>
  /\[(?:laughs?|whispers?|excited|giggles?|sarcastic)\]/i.test(toElevenLabs(d).text)));
const ssml = toSsml(offer);
check("SSML wraps the pace in prosody", ssml.includes('<prosody rate="') && ssml.startsWith("<speak>"), ssml);
check("… stresses the time", ssml.includes('<emphasis level="moderate">Tuesday at 10 AM</emphasis>'), ssml);
check("… and escapes text", toSsml(plan("Tom & Jerry's AC <unit>", "")).includes("Tom &amp; Jerry's AC &lt;unit&gt;"));
const instr = toInstruction(price, pro);
check("an instruction names the mood, pace and stress", instr.includes("clearly") && instr.includes("slower") && instr.includes("hundred and fifty dollars"), instr);
const kokoro = toSpeedOnly(offer, 0.85);
check("speed-only engines get speed × rate", kokoro.speed === Math.round(0.85 * offer.rate * 100) / 100, String(kokoro.speed));

const clips = new Set(["alex-warm", "alex-calm"]);
check("a cloning engine gets the clip recorded for that style", toReferenceClip(gas[0], alex, clips).clip === "alex-calm");
check("… and the persona's base clip when that style has none", toReferenceClip(booked, alex, clips).clip === "alex-warm");
check("… and no clip, rather than a wrong one, when nothing is recorded", toReferenceClip(booked, sam, clips).clip === null);

console.log(failures ? `\n✗ ${failures} check(s) failed` : "\n✓ all checks passed");
process.exit(failures ? 1 : 0);
