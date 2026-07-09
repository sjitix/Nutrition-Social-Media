import type { MicroKey } from "./nutrients";

/**
 * "I'm always tired." — the symptom → nutrient map.
 *
 * This is the most dangerous feature in the app, so it is the most tightly bounded. Three rules:
 *
 *  1. It NEVER diagnoses. A symptom has a hundred causes and almost none of them are dietary.
 *     The engine says what a symptom is *nutritionally associated with*, then looks at what the
 *     user is actually eating, and says which of those is genuinely low IN THEIR WEEK. That is a
 *     statement about their food, not about their body.
 *  2. It NEVER recommends a supplement or a dose. It can rebuild a week around a nutrient; that
 *     is the whole of its power.
 *  3. It always points at a doctor. Not as a disclaimer bolted on the end — as the actual advice,
 *     because for every symptom here the medically correct answer is "get it looked at".
 *
 * The associations below are the standard, uncontroversial ones (iron/B12/folate for fatigue and
 * pallor, B12 for paraesthesia, magnesium/potassium/calcium for cramp, zinc/vitamin C for wound
 * healing and immunity, vitamin D/calcium for bone pain). Nothing exotic, nothing fringe.
 */
export interface Symptom {
  key: string;
  /** Phrases a user might actually type. Matched as whole words. */
  triggers: string[];
  /** Nutrients whose deficiency is classically associated with this symptom. */
  nutrients: MicroKey[];
  /** How the engine names the symptom back to the user. */
  label: string;
}

export const SYMPTOMS: Symptom[] = [
  {
    key: "fatigue",
    label: "feeling tired",
    triggers: ["tired", "tiredness", "fatigue", "fatigued", "exhausted", "exhaustion", "no energy", "low energy", "knackered", "lethargic", "sluggish", "worn out", "drained"],
    nutrients: ["iron", "b12", "folate", "vitD", "magnesium"],
  },
  {
    key: "pallor",
    label: "looking pale",
    triggers: ["pale", "pallor", "washed out", "anemic", "anaemic", "anemia", "anaemia"],
    nutrients: ["iron", "b12", "folate"],
  },
  {
    key: "cramps",
    label: "muscle cramps",
    triggers: ["cramp", "cramps", "cramping", "charley horse", "muscle spasms", "twitching", "twitches"],
    nutrients: ["magnesium", "potassium", "calcium"],
  },
  {
    key: "tingling",
    label: "tingling or numbness",
    triggers: ["tingling", "numbness", "numb", "pins and needles", "paresthesia", "paraesthesia"],
    nutrients: ["b12", "folate"],
  },
  {
    key: "immunity",
    label: "getting ill often",
    triggers: ["always ill", "keep getting sick", "always sick", "constant colds", "catch everything", "immune", "immunity", "run down", "rundown"],
    nutrients: ["vitC", "zinc", "vitD"],
  },
  {
    key: "hair_nails",
    label: "brittle hair or nails",
    triggers: ["brittle nails", "nails break", "hair loss", "hair falling", "hair thinning", "brittle hair", "weak nails"],
    nutrients: ["iron", "zinc", "b12"],
  },
  {
    key: "bones",
    label: "aching bones or joints",
    triggers: ["bone pain", "aching bones", "achy bones", "joint pain", "weak bones", "bones hurt"],
    nutrients: ["vitD", "calcium", "magnesium"],
  },
  {
    key: "mood",
    label: "low mood",
    triggers: ["low mood", "feeling down", "depressed", "depression", "sad all the time", "no motivation", "brain fog", "foggy"],
    nutrients: ["vitD", "b12", "folate"],
  },
  {
    key: "healing",
    label: "slow healing",
    triggers: ["slow healing", "wounds heal slowly", "cuts take ages", "bruise easily", "bruising"],
    nutrients: ["zinc", "vitC"],
  },
  {
    key: "sleep",
    label: "poor sleep",
    triggers: ["can't sleep", "cant sleep", "insomnia", "sleeping badly", "poor sleep", "restless legs"],
    nutrients: ["magnesium", "iron"],
  },
];

/**
 * Symptoms that are never a nutrition question. Chest pain is not a magnesium problem, and an app
 * that answers it with a meal plan is dangerous. Phrases are matched as WORD SETS — every word
 * must be present somewhere in the message — so word order and filler words don't defeat them.
 */
export const URGENT_FLAGS = [
  // Written the way people type, not the way a textbook does. Every phrase below was a MISS in an
  // audit: "my chest hurts", "i cant breath", "i blacked out", "im having a heart attack",
  // "throwing up blood" all fell through to a bland "I don't have a nutritional angle on that".
  // Where a single word is unambiguous on its own, it is listed on its own.
  "chest pain", "chest pains", "chest tightness", "chest hurts", "chest hurting", "tight chest",
  "chest pressure", "heart attack", "stroke",
  "cant breathe", "can't breathe", "cant breath", "can't breath", "shortness of breath",
  "short of breath", "struggling to breathe", "breathless",
  "coughing blood", "vomiting blood", "throwing up blood", "puking blood",
  "blood in stool", "blood in urine", "blood in my stool", "blood in my urine",
  "fainting", "fainted", "passed out", "blacked out", "black out", "lost consciousness",
  "collapsed", "seizure", "seizures", "numb face",
  "slurred speech", "slurred", "slurring words",
  "blurred vision", "blurry vision", "lost my vision", "vision loss",
  "heart racing", "palpitations",
  // NB: a bare "losing weight without trying" fired on a delighted dieter typing "I've been
  // losing weight without even trying!". Unintentional weight loss is a real red flag, so it
  // stays — but only in phrasings that actually mean unexplained.
  "unexplained weight loss", "losing weight for no reason", "weight loss for no reason",
];

/**
 * Kept apart from URGENT_FLAGS because "see a doctor" is the wrong sentence here. These need a
 * crisis line and they need it in the first clause, not after a paragraph about vitamin D.
 */
export const CRISIS_FLAGS = [
  // A missed phrase here sends someone in crisis to a paragraph about vitamin D, so this list is
  // deliberately generous and every single-word entry is unambiguous on its own.
  "suicidal", "suicide",
  "kill myself", "killing myself", "end my life", "ending my life", "end it all",
  "want to die", "wanna die", "better off dead", "no reason to live", "dont want to live",
  "don't want to live", "live anymore", "dont want to be here", "don't want to be here",
  "self harm", "selfharm", "self-harm", "harming myself", "harm myself",
  "hurt myself", "hurting myself", "cut myself", "cutting myself",
];

/**
 * Words that carry no meaning inside a red-flag phrase. Stripped from BOTH the message and the
 * phrase before matching, so "blood in my stool" matches "blood in stool" while "I sat on a stool
 * … my blood test" does not: after stripping, the flag's words must appear CONSECUTIVELY.
 *
 * Symptoms are matched as unordered word sets (that's what lets "my nails are brittle and my hair
 * is thinning" find "brittle nails"). Red flags are not, because a scattered match on a phrase
 * containing a word as common as "in" is a false positive waiting to happen.
 */
export const PHRASE_NOISE = new Set([
  "i", "im", "ive", "id", "my", "me", "a", "an", "the", "been", "being", "have", "has", "had",
  "am", "is", "are", "was", "were", "up", "of", "to", "and", "or", "it", "its", "that", "this",
  "really", "very", "just", "so", "even", "keep", "keeps", "getting", "got", "get", "feel",
  "feels", "feeling", "think", "on", "in", "for", "with", "some", "lot", "lots", "bit", "kinda",
  "sort", "like", "about", "all", "day", "days", "week", "weeks", "time", "times", "always",
  "sometimes", "often", "lately", "recently", "today", "tonight", "now", "still", "quite",
  // linking verbs: "my speech WENT slurred", "my vision HAS GONE blurry"
  "went", "gone", "go", "goes", "become", "becomes", "becoming", "suddenly", "started",
]);
