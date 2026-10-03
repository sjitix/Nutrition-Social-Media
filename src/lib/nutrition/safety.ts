/**
 * Red flags in what a person WROTE — a crisis, or a medical emergency — checked on their own words,
 * before any model sees them.
 *
 * Why this is its own module (V1 milestone C2, pulled forward 2026-10-03 as a safety fix): the crisis
 * guard used to run only inside the `symptom_check` tool, so it fired only if the model (a) chose to
 * emit a `symptom` op and (b) passed the user's words through unchanged. The models lane measured both
 * failing on a real crisis message ("honestly some days i don't want to be here anymore and i've
 * basically stopped eating"): one model paraphrased it, so no flag phrase matched and the reply was a
 * line about having no nutritional angle; another emitted no op at all and wrote its own reply with no
 * crisis numbers. Neither is fixable by prompting alone. So both assistant routes now call `redFlag`
 * on the RAW latest user message first — including in demo mode, where there is no model at all —
 * and `symptomNote` calls the same function, so the two paths can never disagree about what a crisis is.
 *
 * Matching is the engine's existing red-flag rule, moved here unchanged: noise words are dropped from
 * both sides, then the flag's words must appear ADJACENT (in any order), with the allergen path's
 * stemmer — so "a pain in my chest" finds "chest pain", while "my blood test … a stool" never finds
 * "blood in stool". The lists live in symptoms.ts and may only grow.
 */
import { CRISIS_FLAGS, URGENT_FLAGS, PHRASE_NOISE } from "../data/symptoms";
import { wordMatches } from "./exclusions";

export const CRISIS_REPLY =
  "I'm not the right help for this, and I don't want to talk to you about food right now. Please contact your local emergency number or a crisis line straight away — in the US and Canada you can call or text 988, in the UK call 116 123. If you're in danger, call emergency services.";

export const URGENT_REPLY =
  "That isn't something I should be answering with food. Please contact a doctor or urgent care now — I'll look at your nutrition once you've had it seen to.";

export interface RedFlag {
  kind: "crisis" | "urgent";
  /** The ENTIRE reply. Whatever a model would have said is discarded, never prepended or appended. */
  text: string;
}

/** A crisis or an emergency in `message`, or null. Crisis is checked first and wins. */
export function redFlag(message: string): RedFlag | null {
  // Phone keyboards type a CURLY apostrophe ("don’t"). The word split below keeps only straight ones,
  // so without this "don’t want to be here" became "don" + "t" and matched nothing.
  const said = message.replace(/[‘’ʼ]/g, "'").trim().toLowerCase();
  if (!said) return null;
  const words = said.split(/[^a-z']+/).filter(Boolean);
  const same = (w: string, t: string) => w === t || wordMatches(w, t) || wordMatches(t, w);
  const signal = words.filter((w) => !PHRASE_NOISE.has(w.replace(/'/g, "")));
  const flagIn = (phrase: string) => {
    const full = phrase.split(/\s+/);
    const want = full.filter((w) => !PHRASE_NOISE.has(w.replace(/'/g, "")));
    if (!want.length) return false;
    // A multi-word flag that noise removal shrinks to ONE word must appear WORD FOR WORD instead.
    // "end it all" loses "it" and "all" to the noise list and became just "end" — so "at the end of
    // the day I want pasta" and "let's end the week with fish" were treated as a suicide crisis.
    // Inside the symptom tool that was a rare misfire; as a pre-scan on every message it would have
    // answered every "end" with crisis lines. Found on the models lane's must-not-hit set, 2026-10-03.
    if (full.length > 1 && want.length < 2) {
      const bare = words.map((w) => w.replace(/'/g, ""));
      const seq = full.map((w) => w.replace(/'/g, ""));
      for (let i = 0; i + seq.length <= bare.length; i++)
        if (seq.every((t, k) => bare[i + k] === t)) return true;
      return false;
    }
    // Adjacent but ORDER-FREE: "a pain in my chest" and "my speech is slurred" are the same
    // emergency as "chest pain" and "slurred speech". Strict ordering missed both.
    for (let i = 0; i + want.length <= signal.length; i++) {
      const window = signal.slice(i, i + want.length);
      const taken = new Array(window.length).fill(false);
      const all = want.every((t) => {
        const j = window.findIndex((w, k) => !taken[k] && same(w, t));
        if (j < 0) return false;
        taken[j] = true;
        return true;
      });
      if (all) return true;
    }
    return false;
  };
  if (CRISIS_FLAGS.some(flagIn)) return { kind: "crisis", text: CRISIS_REPLY };
  if (URGENT_FLAGS.some(flagIn)) return { kind: "urgent", text: URGENT_REPLY };
  return null;
}
