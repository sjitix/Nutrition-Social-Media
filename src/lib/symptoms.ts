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
  "chest pain", "chest tightness", "cant breathe", "can't breathe", "shortness of breath",
  "breathless", "coughing blood", "vomiting blood", "blood in stool", "blood in urine",
  "fainting", "fainted", "passed out", "seizure", "seizures", "numb face", "slurred speech",
  "heart racing", "palpitations", "losing weight without trying", "unexplained weight loss",
];

/**
 * Kept apart from URGENT_FLAGS because "see a doctor" is the wrong sentence here. These need a
 * crisis line and they need it in the first clause, not after a paragraph about vitamin D.
 */
export const CRISIS_FLAGS = [
  "suicidal", "kill myself", "end my life", "self harm", "selfharm", "hurt myself",
  "want to die", "no reason to live",
];
