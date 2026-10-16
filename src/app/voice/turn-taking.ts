/**
 * Turn-taking: telling a backchannel from a barge-in, and knowing when a
 * caller has actually finished.
 *
 * The 2026 production stack has moved away from "any speech energy means
 * stop" because it is wrong about half the time. People say "mm-hmm" and
 * "right" WHILE you speak to signal keep going — that is a backchannel, and
 * cutting yourself off is the wrong response. "Wait" or a real sentence is a
 * barge-in, where the caller is taking the floor.
 *
 * Treating the two the same is what made the agent cut out whenever someone
 * made a noise of agreement.
 */

/** Short acknowledgements that mean "carry on", not "stop". */
const BACKCHANNEL = new Set([
  "mm", "mmm", "mhm", "mmhm", "mm-hmm", "uh huh", "uhhuh", "aha", "ah", "oh",
  "yeah", "yep", "yup", "yes", "ok", "okay", "right", "sure", "i see", "got it",
  "gotcha", "hmm", "huh", "alright", "cool", "nice", "wow", "really",
]);

/** Words that unambiguously take the floor, however short. */
const HARD_BARGE = /\b(?:wait|stop|hold on|hang on|sorry|actually|no|excuse me|hello|listen)\b/i;

export type FloorAction = "backchannel" | "barge_in" | "ignore";

export function classifyInterruption(text: string): FloorAction {
  const t = text.trim().toLowerCase().replace(/[.,!?]/g, "");
  if (!t) return "ignore";

  if (HARD_BARGE.test(t)) return "barge_in";
  if (BACKCHANNEL.has(t)) return "backchannel";

  // One or two words that are not a known backchannel are usually recognition
  // noise picked up from the agent's own audio. Ignore rather than cut off.
  const words = t.split(/\s+/);
  if (words.length <= 2 && words.every((w) => BACKCHANNEL.has(w))) return "backchannel";
  if (words.length <= 1) return "ignore";

  return "barge_in";
}

/**
 * Semantic endpointing.
 *
 * Waiting for silence adds a fixed second to every turn, and the right amount
 * to wait is not fixed at all: "my AC is broken" is finished, "my AC is
 * broken and" plainly is not. So the pause before acting on a guess is set by
 * how complete the sentence sounds.
 */
const TRAILING_INCOMPLETE =
  /\b(?:and|but|or|so|because|if|when|the|a|an|my|your|is|are|was|were|to|for|with|at|on|in|it'?s|that|this|i|we|they|he|she)$/i;

/** Mid-utterance hesitations — the caller is thinking, not finished. */
const HESITATION = /\b(?:um|uh|er|erm|like|you know|i mean)$/i;

export function endpointDelayMs(interim: string): number {
  const t = interim.trim();
  if (!t) return Infinity;

  const words = t.split(/\s+/);
  if (words.length < 3) return Infinity; // too little to guess from

  // Still clearly mid-sentence — give them room.
  if (TRAILING_INCOMPLETE.test(t) || HESITATION.test(t)) return 1200;

  // A question is a strong finish signal: the caller is handing over.
  if (/\?$/.test(t) || /^(?:what|when|where|who|why|how|can|could|do|does|did|is|are|will|would|should)\b/i.test(t)) {
    return 200;
  }

  // Ends on a noun-ish word with enough length to be a complete thought.
  if (words.length >= 5) return 300;

  return 500;
}
