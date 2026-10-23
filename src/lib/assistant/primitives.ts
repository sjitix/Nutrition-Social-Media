/**
 * Assistant v2 — the general, composable primitives, mapped onto the tested engine.
 *
 * The antidote to a narrow if-else tool menu: instead of ~20 buttons, most adjustments are ONE
 * `constrain` with a rich body + a `scope`. This module translates those primitives into the flat
 * `Operation[]` the engine already runs, so every bit of deterministic macro math and every invariant
 * test carries straight over — we're changing the model's vocabulary, not the correctness core.
 *
 * See ASSISTANT-SCHEMA.md for the full design.
 */
import { z } from "zod";
import type { Meal, Operation, UserProfile, UserFact, WeekPlan, PlanSnapshot } from "../core";
import { DAYS, MEAL_TYPES } from "../core";
import { applyOperations } from "../recipeDb";
import { CRISIS_REPLY, parseExclusionTokens, EXCLUSION_CATEGORIES, expandExclusion, exclusionCovers, haystackBlocked, mealHaystack } from "../nutrition";
import { INGREDIENTS } from "../data";

/** What counts as a FOOD word below: an allergen category, or any word of a curated ingredient. */
const CATEGORIES = new Set(EXCLUSION_CATEGORIES);
const ALLERGEN_KEYS = [...EXCLUSION_CATEGORIES];
const ALLERGEN_TERMS = new Set(ALLERGEN_KEYS.flatMap((k) => expandExclusion(k)));
const CURATED_NAMES = new Set(Object.values(INGREDIENTS).map((i) => i.name.toLowerCase()));
const FOOD_WORDS = new Set(
  [...CURATED_NAMES].flatMap((n) => n.split(/[^a-z]+/)).filter((w) => w.length >= 3),
);
// Plural-tolerant for categories as well as ingredient words: "allergic to crustaceans", "groundnuts"
// and "soybeans" were dropped by the unlabelled filter because only "crustacean" is a category key.
const isFood = (w: string) =>
  [w, w.replace(/ies$/, "y"), w.replace(/es$/, ""), w.replace(/s$/, "")].some((s) => CATEGORIES.has(s) || FOOD_WORDS.has(s));
/**
 * Whether a whole token NAMES a food, for binding it and for keeping a word a cue sentence offers. Wider than
 * isFood in two ways (review, 2026-10-21). Plural-tolerant both ways: the curated names are often plural, so
 * "allergic to walnut" bound nothing while "walnuts" did. And the matcher's own allergen words count (LC-08):
 * no curated ingredient is a cashew, a scallop or a hazelnut, so unlabelled, 93 of the 182 foods the matcher
 * blocks on bound nothing; a phrase counts when it is one ("sea bass") or holds one. It is a closed
 * vocabulary of foods, so "spring", "skin" and "pets" still bind nothing. Never for the words of a phrase being
 * split: "glass noodle" split into "noodle" stored a word whose exceptions serve glass noodles, and "sesame
 * seed" stored "seed", which blocks every seed dish. Splitting keeps isFood.
 */
const namesFood = (t: string) => {
  const food = (w: string) =>
    [w, w.replace(/ies$/, "y"), w.replace(/es$/, ""), w.replace(/s$/, ""), `${w}s`, `${w}es`, w.replace(/y$/, "ies")]
      .some((s) => CATEGORIES.has(s) || ALLERGEN_TERMS.has(s) || FOOD_WORDS.has(s));
  return food(t) || t.split(/\s+/).some(food);
};
/**
 * The words that make a remembered fact an allergy whatever the model labelled it: one closed list,
 * shared by the gate, the denial check and the coeliac rule so the three cannot drift apart. It takes
 * the plurals ("allergens", "intolerances", "coeliacs") and the misspellings people actually type
 * ("alergic", "allergie", "intolerent", "intollerant", "celiak"). It is a CLOSED list on purpose: the
 * wide forms the review tried (\ballerg\w*) read "allergist cleared him to eat eggs" as an egg allergy.
 */
const CUE_WORDS = String.raw`al+erg(?:ic|y|ies|ie|ens?)|intol+er[ae]n(?:t|ces?)|c(?:o)?eli(?:ac|ak)s?`;
const ALLERGY_CUE = new RegExp(String.raw`\b(?:${CUE_WORDS})\b|\banaphyla`, "i");
const COELIAC = /\bc(?:o)?eli(?:ac|ak)s?\b/;
const COELIAC_WORD = /^c(?:o)?eli(?:ac|ak)s?$/;
/** A phrase we recognise whole: an allergen category ("tree nuts") or a curated name ("peanut butter"). Not
 *  the matcher's other two-word foods: kept whole, "tikka masala" stopped storing "tikka" and "masala" and
 *  blocked 13 dishes fewer. Unlabelled, such a phrase still binds whole ("sea bass"), by the gate. */
const knownPhrase = (t: string) => CATEGORIES.has(t) || CURATED_NAMES.has(t) || CURATED_NAMES.has(t.replace(/s$/, ""));

/**
 * Words that never name an allergen on their own when a longer phrase is split: carriers and
 * modifiers. Without this, "allergic to tea tree oil" or "allergic to essential oils" stored "oil" and
 * banned every dish cooked with any oil (230 of 495 recipes), "washing powder" stored "powder", and
 * "dairy-allergic baby" stored "baby" (a word of "baby potatoes"). A phrase left with no food word
 * after this is kept whole, so a real one still binds: "sesame oil" keeps "sesame", "heavy cream" is a
 * phrase of its own. Measured by the adversarial review of 49385e5 (2026-10-18): it loses no allergen
 * the patch enforced.
 */
const NOT_ALONE = new Set([
  "oil", "oils", "powder", "powders", "sauce", "paste", "dressing", "stock", "cube", "cubes", "spice", "spices",
  "mixed", "ground", "whole", "green", "brown", "black", "red", "white", "yellow", "light", "dark", "baby", "plain",
  "sweet", "smoked", "roasted", "cooked", "chopped", "rolled", "firm", "fillet", "fillets", "breast", "breasts",
  "thigh", "thighs", "bell", "lean", "extra", "greek", "flakes", "cream", "creams",
]);

/**
 * A fact that mentions an allergy only to DENY it binds nothing: "not lactose intolerant, drinks milk
 * every day", "No allergies; eats dairy and gluten", "outgrew an egg allergy as a kid", "Allergies: none".
 * Once any fact that says "allergy" could bind (49385e5), these read as allergies to the very foods the
 * person eats: the whole-sentence fallback turned "No allergies; eats dairy and gluten" into a ban on
 * 59% of the library, and a person's natural correction ("not lactose intolerant any more, eats dairy")
 * WIDENED the ban instead of lifting it.
 *
 * A fact is skipped only when EVERY cue in it is denied. It is never skipped when it names an exception
 * ("no allergies except shellfish") or a reaction or restriction ("no known allergy, but eggs make her
 * sick"), and "not just / only / even" affirms ("not just lactose intolerant"). Measured by the review:
 * the denial cases bind nothing, and none of the 138 must-bind phrasings the patch binds is lost,
 * labelled or not. It applies to kind "allergy" too: "I'm not lactose intolerant" labelled as an allergy
 * used to store lactose.
 */
const CUE_AT = new RegExp(String.raw`\b(?:${CUE_WORDS}|anaphyla\w*)\b`, "g");
/** Up to three plain words, never across punctuation or a contrast or connective word ("tho" as typed: "not
 *  shellfish tho i'm allergic" was read as a denial; the history allergy's blind sweep, 2026-10-23). */
const RUN = String.raw`(?:(?!(?:but|though|tho|although|altho|yet|however|and|or|so|because|as|since|while)\b)[a-z']+\s+){0,3}$`;
/** A negation that governs the cue after it: "not lactose intolerant", "no known food allergies",
 *  "doesn't have a nut allergy", "tested negative for coeliac", "ruled out a peanut allergy". */
const NEG_BEFORE = new RegExp(String.raw`(?:\b(?:no|not|never)|n't|\bnegative for|\bruled out)\s+(?!(?:just|only|merely|simply|even|so)\b)` + RUN);
/** "outgrew an egg allergy", "used to be lactose intolerant" — unless itself negated ("hasn't outgrown"). */
const PAST_BEFORE = new RegExp(String.raw`\b(?:outgrew|outgrown|grew out of|used to (?:be|have))\s+` + RUN);
const PAST_NEGATED = /(?:n't|\bnot|\bnever|\byet to)\s+(?:[a-z']+\s+)?(?:outgr|grew out)/;
/** "allergies: none", "allergy - no.", "allergy ruled out", "intolerance test came back negative". */
const NONE_AFTER = /^\s*(?:[:\-–—]\s*)?(?:none|nil|n\/a|no)\s*(?:[.;,!?)]|$)|^\s*(?:(?:was|is|has been|were|been|got|now)\s+)?ruled out\b|^\s*(?:test(?:s|ed)?\s+)?(?:was\s+|came back\s+)?negative\b/;
const GREW_OUT_AFTER = /(?<!(?:never|n't|not|yet to)\s)\b(?:grew out of (?:it|them)|outgrew (?:it|them)|outgrown (?:it|them))\b/;
/** An exception keeps the fact live: "no allergies except shellfish", "no allergies (only lactose intolerance)". */
const EXCEPT = /\b(?:except|apart from|other than|besides|aside from|save for|excluding|but for|only)\b/;
/** So does a reaction or a restriction anywhere in it: "no known allergy, but eggs make her sick". */
const REACTS_OR_RESTRICTS = /\b(?:react\w*|sick|ill|itch\w*|hives|rash\w*|swell\w*|swollen|vomit\w*|throws? up|cramp\w*|bloat\w*|diarrh\w*|nause\w*|wheez\w*|tingl\w*|breaks? out|epi-?pen|avoid\w*|can'?t (?:eat|have|tolerate)|cannot (?:eat|have|tolerate)|(?:doesn'?t|don'?t|won'?t|never) (?:eat|eats|touch)|must not|stay away|steer clear)\b/;
function everyCueDenied(fact: string): boolean {
  const t = fact.toLowerCase().replace(/[‘’]/g, "'");
  if (EXCEPT.test(t) || REACTS_OR_RESTRICTS.test(t)) return false;
  let any = false;
  for (const m of t.matchAll(CUE_AT)) {
    any = true;
    const i = m.index ?? 0;
    const before = t.slice(Math.max(0, i - 60), i);
    const after = t.slice(i + m[0].length, i + m[0].length + 45);
    const lastWords = before.match(/(?:[a-z']+\s+){0,6}$/)?.[0] ?? "";
    const negated = NEG_BEFORE.test(before) && !/\b(?:outgr|grew out)/.test(lastWords);
    const past = PAST_BEFORE.test(before) && !PAST_NEGATED.test(lastWords);
    const none = NONE_AFTER.test(after) || GREW_OUT_AFTER.test(after);
    if (!(negated || past || none)) return false; // one affirmed cue: the fact is read as an allergy
  }
  return any;
}

/**
 * The allergens in a REMEMBERED allergy fact, which is conversation, not a form field: "heads up,
 * I'm allergic to peanuts", "I have a severe peanut allergy", "lactose intolerant". Parsing the whole
 * sentence as an allergy list stored "heads up" as an allergen and kept "severe peanut" as one phrase
 * that blocked nothing. So: take the phrase after ("allergic to X") or before ("X allergy") the cue;
 * split it with the exclusion parser (lists, contrast clauses, noise, categories); and add each FOOD
 * word of a multi-word phrase on its own ("severe peanut" also yields "peanut"). With no cue at all,
 * keep only tokens that name a food. An allergen we do not stock ("lupin") is still kept when the cue
 * names it, so it is enforced the day a recipe with it arrives.
 */
/** "allergic to X", "intolerant to X", "allergens: X" — every one of them, not just the first. */
const AFTER_CUE = /\b(?:allerg(?:ic|y|ies|ens?)|intoleran(?:t|ces?))[\s,]+(?:to\s+)?([^.;:!?]+)/g;
/** "X allergy", "X intolerance", "X allergens". */
const BEFORE_CUE = /\b(?:allerg(?:y|ies|ens?)|intoleran(?:t|ces?))\b/g;
/**
 * The phrase BEFORE each cue: the text back to the last punctuation mark, or to the end of the previous
 * cue. This is what /([^.,;:!?]*?)\s*\bcue\b/g captured, found in ONE pass. The lazy regex re-scanned
 * from every start position, so a long fact that says "allergic" but never "allergy" took 1.5 s at 20k
 * characters, inside the route (the review measured it quadratic).
 */
function beforeCuePhrases(text: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (const m of text.matchAll(BEFORE_CUE)) {
    const i = m.index ?? 0;
    let start = from;
    for (let k = i - 1; k >= from; k--) if (".,;:!?".includes(text[k])) { start = k + 1; break; }
    out.push(text.slice(start, i).replace(/\s+$/, ""));
    from = i + m[0].length;
  }
  return out;
}

export function allergensInFact(fact: string): string[] {
  const text = fact.toLowerCase().replace(/[‘’]/g, "'");
  const out = new Set<string>();
  // Coeliac disease is a gluten rule whatever words surround it.
  if (COELIAC.test(text)) out.add("gluten");
  // Both sides of EVERY cue: "Allergic to peanuts. Also allergic to sesame." used to bind peanuts and
  // leave all five sesame dishes, even labelled. AFTER a cue is an explicit list ("allergic to X",
  // "allergy, also eggs"); BEFORE it is often an adjective ("severe allergy to …"), so when an AFTER
  // list exists, words before a cue count only if they name a food ("shellfish allergy, also eggs").
  const afterTokens = [...text.matchAll(AFTER_CUE)].flatMap((m) => (m[1] ? parseExclusionTokens(m[1], "") : []));
  const beforeTokens = beforeCuePhrases(text).flatMap((p) => (p.trim() ? parseExclusionTokens(p, "") : []));
  const fromCue = afterTokens.length
    ? [...afterTokens, ...beforeTokens.filter(namesFood)]
    : beforeTokens;
  // A cue whose phrase yields nothing ("I don't do dairy, allergy" — the allergen sits before the
  // comma) falls back to the whole sentence, read for food words only.
  const cue = fromCue.length > 0;
  const tokens = cue ? fromCue : parseExclusionTokens(text, "");
  // The parser also hands back compounds an allergy must keep blocking ("tortillas" brings "corn tortilla"),
  // which the person never said; enforcement adds them again from the stored word. Split as phrases, they
  // stored "corn", and "rice" and "zucchini" from "allergic to noodle" (review, 2026-10-22). So a phrase
  // counts only when the fact holds its words, in any number: the parser returns "tree nuts" for "tree nut".
  const folded = text.normalize("NFD").replace(/[̀-ͯ]/g, "");
  const stem = (w: string) => w.replace(/(?:ies|es|s)$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const said = (t: string) => !t.includes(" ") || t.split(/\s+/).every((w) => new RegExp(`(?:^|[^a-z])${stem(w)}`).test(folded));
  for (const t of tokens) {
    if (!said(t)) continue;
    // "coeliac" is now an exclusion word in its own right (it blocks what "gluten" blocks), but the
    // rule above already stored it AS gluten — keeping both would tell the user "gluten and coeliac".
    if (COELIAC_WORD.test(t)) continue;
    if (!t.includes(" ")) {
      if (cue || namesFood(t)) out.add(t); // an explicitly named allergen we do not stock ("lupin") is kept
      continue;
    }
    if (knownPhrase(t)) { out.add(t); continue; } // "tree nuts", "peanut butter"
    // "severe peanut" -> "peanut"; "my son has nut" -> "nut". Never a carrier or modifier on its own
    // (NOT_ALONE), and never "coeliac", which the gluten rule above already stored as gluten.
    const foods = t.split(/\s+/).filter((w) => isFood(w) && !NOT_ALONE.has(w) && !COELIAC_WORD.test(w));
    if (foods.length) {
      foods.forEach((f) => out.add(f));
      // The phrase too, when its food words do not block it: an exception keeps a "rice noodle" out of
      // "noodle", so storing the word alone would serve the very food the person named. Only a word that
      // blocks itself can be escaped that way: "lactose", "gluten", "casein" and "cmpa" block the foods
      // they expand to, never their own name, so "fyi i have a lactose intolerance" stored "fyi lactose"
      // beside "lactose", a phrase that blocks nothing and was announced as an allergy.
      const escapable = foods.filter((f) => haystackBlocked(f, [f]));
      if (escapable.length && !haystackBlocked(t, escapable)) out.add(t);
      // An unknown multi-word allergen the user named after a cue: keep it whole. With no cue, only a phrase that
      // is itself one of the matcher's foods ("sea bass"): one that merely holds a food word was a sentence,
      // and "prefers a light dinner after a big lunch" was stored as an allergy.
    } else if (cue || ALLERGEN_TERMS.has(t)) out.add(t);
  }
  return [...out];
}

/**
 * Two allergy tokens are the SAME allergy when the matcher expands them to the same foods: "peanut" and
 * "peanuts", "egg" and "eggs", "lactose", "dairy" and "milk". It is the matcher's own expansion, so a
 * token judged already present can never block less than the one already stored. Allergies used to
 * grow by surface form ("peanuts, peanut, nuts, tree nuts, nuts"), each with an "I've added" note
 * although nothing new was excluded (review of 49385e5, LC-16).
 */
const allergyKey = (t: string) => [...new Set(expandExclusion(t))].sort().join("|");

/** Whether `t` is one of these allergies, or one of them covers it ("walnuts" under "nuts"). */
const amongAllergies = (t: string, list: string[]) =>
  list.some((s) => allergyKey(s) === allergyKey(t)) || exclusionCovers(list, t);

/**
 * The clause around each cue word of a message. Fed a whole message, the gate reads every food in it: "I'm
 * allergic to peanuts, can you add more chicken and rice?" bound chicken and rice, because a cue anywhere sends
 * the whole fact to the parser. So a clause runs from the last break before its cue to the first break after it:
 * punctuation, a bracket, a contrast word ("tho" too), a new subject ("…this week hes allergic to tomatoes") or a
 * new request. "and" breaks only before a new subject or request ("…and i'm allergic", "…and can you"), never
 * inside a list ("a cashew and pistachio allergy"); "except" is no break ("no allergies except shellfish" is one
 * statement), and nor is a colon straight after the cue ("allergies: peanuts, sesame"). A cue with nothing of its
 * own around it ("he's allergic", "properly intolerant") takes the words just before it: "My husband can't have
 * shellfish, he's allergic". `own` is the clause without those words, which is what the statement test reads.
 */
const CUE_ANY = new RegExp(String.raw`\b(?:${CUE_WORDS})\b|\banaphyla\w*`, "g");
const CLAUSE_END = /[.;:!?()]|\s[—–-]\s|\s(?:but|so|because|though|tho|although|while|whereas)\s|,\s*(?:can|could|would|will|please|also|then|now|give|add|swap|put|make|use|keep|get|want|need|show|find|let's|lets|anyway|the|we|i|i'm|i'd|i'll|it|it's|that|this|which|and\s+(?:can|could|please|i|i'd|give|add|swap|put|make|use))\b|\s+and\s+(?:also|then|can|could|please|i|i'd|i'll|give|add|swap|put|make|use|hate|love|like|want|our|we|we're|it)\b/;
const CLAUSE_START = /[,(]|\s(?:but|so|because|though|tho|although|while|whereas)\s|\sand\s(?=(?:i|i'm|im|i've|my|he|he's|she|she's|we|they|also|then|can|could|please|add|make|swap|give)\b)|\s(?=(?:i'm|im|i am|i've|ive|he's|hes|he is|she's|shes|she is|they're|theyre|we're)\s)/g;
/** Nothing but a subject and filler before the cue, and nothing after it: the allergen was said just before. */
const BARE_BEFORE = /^(?:(?:oh|also|and|plus|btw|fyi|so|tho|though|but|i'm|im|i|am|he's|hes|he|she's|shes|she|is|they're|theyre|they|are|we're|we|very|really|severely|super|seriously|quite|badly|proper|properly|mildly|extremely|deathly|highly|just|actually|totally|definitely|too|both|all|each)\s+)*$/;
interface CueClause { clause: string; own: string; sentence: string; rest: string; next: string }
function cueClauses(message: string): CueClause[] {
  const out: CueClause[] = [];
  // An age in brackets is no break: "theo (6) is allergic to egg and sesame".
  const t = message.toLowerCase().replace(/[‘’]/g, "'").replace(/\s*\(\s*\d+\s*\)/g, "");
  let said = ""; // the message up to the current sentence, for a bare cue
  const sentences = t.split(/(?<=[.;!?])\s+|\n+/);
  for (const [si, sentence] of sentences.entries()) {
    let consumed = 0;
    for (const m of sentence.matchAll(CUE_ANY)) {
      const i = m.index ?? 0;
      if (i < consumed) continue; // already inside the clause of the cue before it
      const before = sentence.slice(consumed, i);
      let start = 0;
      for (const b of before.matchAll(CLAUSE_START)) start = (b.index ?? 0) + b[0].length;
      const after = sentence.slice(i + m[0].length);
      const colon = after.match(/^\s*:/)?.[0].length ?? 0;
      const end = after.slice(colon).search(CLAUSE_END);
      const tail = end < 0 ? after : after.slice(0, colon + end);
      const head = before.slice(start);
      const own = `${head}${m[0]}${tail}`.trim();
      const bare = BARE_BEFORE.test(head.trim() ? `${head.trim()} ` : "") && !tail.trim();
      const lead = bare ? (sentence.slice(0, consumed + start).replace(/[,(]\s*$/, "").trim() || said.trim().split(/(?<=[.;!?])\s+/).pop() || "") : "";
      const clause = lead ? `${lead} ${own}` : own;
      if (!out.some((c) => c.clause === clause)) out.push({ clause, own, sentence, rest: after.slice(tail.length), next: sentences[si + 1] ?? "" });
      consumed = i + m[0].length + tail.length;
    }
    said += ` ${sentence}`;
  }
  return out;
}

/**
 * The clauses that STATE an allergy to plan around. Unlike the live gate, which sees only what a model chose to
 * remember, the history scan reads every clause with a cue in it. Three sets of messages that state none, each
 * written blind by another agent and each used once to find what generalizes, first bound one in 10 of 24, 15 of
 * 60 and 14 of 50. So a clause is skipped when it:
 * - asks, wonders or doubts: "is this safe for a coeliac?", "what if I was…", "we thought my son had…", "my
 *   housemate thinks he has…", "getting tested for coeliac, no result yet";
 * - is about people in general, or someone the person does not feed: "dinner for people with gluten intolerance",
 *   "everyone's gluten intolerant these days", a coworker, a client, a cousin abroad, a dog. The same person
 *   coming to eat ("…is coming for dinner") binds, as every person mentioned does on the live path (decision 12);
 * - is about allergies as a subject: an article, a documentary, rates, a story's character, revision notes;
 * - is past or dismissed, there or in the words after it that name no food: "as a baby", "long gone", "a
 *   myth", "the test came back negative", "…but it was a false positive";
 * - uses the word as an adjective: "a coeliac-friendly bake sale", "allergy-free";
 * - jokes: "allergic to vegetables lol", "jk". A laugh alone does not make a joke: "im alergic to shrimp lol
 *   forgot to mention" is an allergy. It takes a laugh over a whole food group, or a plain "kidding".
 */
const WONDERS = /\bwhat if\b|\bif (?:i|you|he|she|they|we)(?: was| were| had| am|'m|'d)\b|\bif i (?:type|say|write|put|tell you)\b|\bsuppose\b|\bimagine\b|\bpretend\b|\bhypothetic|\bthought\b|\bthinks\b|\bclaims?\b|\b(?:am i|could i be|might i be|do i have|how (?:do|would|can) i (?:know|tell))\b|\bwonder(?:ing)? (?:if|whether)\b|\btest(?:ed|ing|s)? for\b|\brule out\b|\bno results? yet\b|\buntil we know\b/;
const ASKS = /^(?:do|does|did|is|are|was|were|can(?!'t)|could(?!n't)|would(?!n't)|will|should|shall|what|what's|whats|which|how|why|where|who|whose)\b/;
const NOBODY_IN_PARTICULAR = /\b(?:someone|somebody|anyone|anybody|everyone|everyone's|everybody|nobody|no one|people|a person|those|asking for)\b/;
const NOT_OURS = /\b(?:co-?workers?|colleagues?|teammates?|boss|manager|clients?|customers?|regulars?|patients?|cousins?|neighbou?rs?|teachers?|classmates?|celebrit\w*|guy|girl|woman|man|lady|dude|stranger|waiter|waitress|dogs?|cats?|pets?|puppy|kitten|ex|old (?:room+ate|flatmate|housemate)|friend'?s (?:kid|son|daughter|child|baby|boy|girl))\b/;
const COMES_TO_EAT = /\b(?:coming|visiting|visit|staying|stay|over for|for dinner|for lunch|cooking for|cook for|feeding|hosting|sleepover|moving in|moved in)\b/;
const A_SUBJECT = /\b(?:article|documentary|video|podcast|study|studies|news|research|rates?|statistics?|read (?:that|about|an?)|revising|studying|exams?|lecture|essay|story|novel|character|series|book)\b/;
const PAST_OR_DISMISSED = /\bnegative\b|\bmyth\b|\bfalse positive\b|\bmisdiagnos\w*|\bcleared up\b|\bruled out\b|\bturned out\b|\bnot actually\b|\ball clear\b|\bas a (?:baby|kid|child|teen|teenager|toddler)\b|\bused to\b|\bgrew out\b|\boutgr\w*|\blong gone\b|\bwent away\b|\bno longer\b|\bnot any ?more\b/;
const AS_ADJECTIVE = /(?:co?eliac|allerg(?:y|en|ies)|intolerance)[- ](?:friendly|free|safe|aware)\b/;
const KIDDING = /\b(?:jk|j\/k|kidding|joking)\b/;
const LAUGHS = /\b(?:lol|lmao|rofl|haha\w*)\b/;
const FOOD_GROUP = /\b(?:vegetables?|veggies|veg|greens|salads?|fruits?|healthy|food|everything|carbs)\b/;
const jokes = (own: string) => KIDDING.test(own) || (LAUGHS.test(own) && FOOD_GROUP.test(own));
/** Taken back in the next words, naming no food of their own: "my husband is allergic to vegetables (he's not, he's
 *  just 5)", "…they're not." ("I'm not allergic to eggs" after a peanut allergy names eggs, so takes nothing back.) */
const TAKEN_BACK = /^\W*(?:i'm|im|i am|he's|hes|he is|she's|shes|she is|they're|theyre|they are|we're|we are) not\b|^\W*not really\b/;
function statements(message: string): CueClause[] {
  return cueClauses(message).filter(({ own, sentence, rest, next }) =>
    ![WONDERS, ASKS, NOBODY_IN_PARTICULAR, A_SUBJECT, PAST_OR_DISMISSED, AS_ADJECTIVE].some((rx) => rx.test(own)) && !jokes(own) &&
    ![rest, next].some((w) => TAKEN_BACK.test(w) && !allergensInFact(w).length) &&
    // Someone the person does not feed, unless the sentence says they are coming to eat.
    !(NOT_OURS.test(own) && !COMES_TO_EAT.test(sentence)) &&
    // "…but it was a false positive": a dismissal after it in the sentence that names no food of its own.
    !(PAST_OR_DISMISSED.test(rest) && !allergensInFact(rest).length),
  );
}
export function allergyClauses(message: string): string[] {
  return statements(message).map((c) => c.clause);
}

/**
 * The speaker stating their own allergy in so many words: "i'm allergic to peanuts", "I have a severe nut allergy",
 * "my peanut allergy", "im coeliac", "lactose intolerant here". Never someone else's ("my son's egg allergy").
 */
const LEAD_IN = String.raw`(?:(?:oh|also|and|plus|btw|fyi|ps|so|ok|okay|yeah|heads up|just so you know|by the way|forgot to say|forgot to mention)\W+)*`;
const FIRST_PERSON = new RegExp(String.raw`^${LEAD_IN}(?:i'm|im|i am|i've got|ive got|i have|i've|ive|i got)\b|\bmy\s+(?![a-z]+'s\b)(?:[a-z-]+\s+){0,2}(?:al+erg|intol+eran)|^${LEAD_IN}(?:[a-z-]+\s+){1,3}(?:al+erg(?:ic|y)|intol+er[ae]nt|co?eli[ac]+k?)\s+(?:here|me)\b`);

const WHOLE_GROUP = /^(?:vegetables?|veggies|veg|fruits?|greens|salads?)$/;

/** An earlier user message, and the assistant's reply to it: null when it got none (its turn failed). */
export interface EarlierMessage { text: string; reply: string | null }
/** A reply that says it will keep a food out: "Noted — I'll keep peanuts out of everything." */
const KEEPS_OUT = /\ballerg|\bintoleran|\bco?eliac|\bkeep\b[^.]*\bout\b|\bleave\b[^.]*\bout\b|\bavoid|\bnoted\b|\bwon'?t (?:include|use|add|put|serve|plan)|\bwithout\b|-free\b|\bfree of\b|\bsteer clear|\bno more\b/;
const mentions = (reply: string, t: string) =>
  haystackBlocked(reply, [t]) || new RegExp(String.raw`\b${t.replace(/(?:ies|es|s)$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(reply);

/**
 * THE HISTORY ALLERGY: the allergies the person stated in EARLIER messages that are not bound, as remember
 * facts for the gate. An allergy said in a turn the model failed (it never answered, or its turn could not be
 * read) was lost for good: the next message's model saw only the transcript, and nothing bound it.
 *
 * WHICH messages: one whose turn got no answer is read for statements (`allergyClauses`). One that was answered
 * binds what the reply said it would keep out ("Noted — I'll keep peanuts out of everything", with nothing bound:
 * the models lane's memory-allergy case), and what the speaker stated as their own in so many words
 * (FIRST_PERSON): "i'm allergic to peanuts, can you add more chicken and rice?", answered by a run that only did
 * the swap, is the reasoning-off pattern the models lane measured (history allergies carried 2 in 9). Anything
 * else of an answered message is left to the model that answered it: the statement test is a keyword test, and
 * on the blind sets above it still bound one in four of the messages that state no allergy.
 *
 * Each clause goes through the same gate the live path uses, so it binds exactly what that gate binds (another
 * person's allergy too, as today; decision 12). Skipped: a clause that adds nothing, any food a LATER message,
 * or the current one, denies by name ("actually I'm not allergic to peanuts"), and any food the person removed
 * by hand (`removedAllergies`), which no old message may put back. A clause that names some of those and others
 * is reduced to the others. A denial that names nothing ("I don't have any allergies") cancels nothing: it may
 * be about the speaker while the earlier clause was about their son, and on the live path no denial ever took a
 * bound allergy off.
 *
 * `bind` is what binds now. `held` is what the conversation states that is already bound: an undo in this run
 * keeps both (rule G), or an undo would take off an allergy the next message's scan puts straight back.
 */
export function earlierAllergyFacts(earlier: EarlierMessage[], current: string, profile: UserProfile): { bind: string[]; held: string[] } {
  const removed = (profile.removedAllergies ?? []).flatMap((r) => parseExclusionTokens(r, ""));
  // The foods each message denies by name, and so every message after it: only a denial at least as broad as
  // the food counts ("not allergic to dairy" covers "lactose"), never a narrower one ("not allergic to peanuts"
  // leaves "nuts").
  const denies = [...earlier.map((e) => e.text), current].map((m) =>
    cueClauses(m).map((c) => c.clause).filter(everyCueDenied).flatMap(allergensInFact).flatMap((d) => parseExclusionTokens(d, "")));
  const bind: string[] = [];
  const held: string[] = [];
  let p = profile;
  earlier.forEach(({ text, reply }, i) => {
    const denied = denies.slice(i + 1).flat();
    const said = reply?.toLowerCase().replace(/[‘’]/g, "'");
    for (const { clause, own } of statements(text)) {
      // Never a whole food group from an old message: "I'm basically allergic to vegetables (I just don't like them)"
      // would empty the week, and nobody states a real allergy that way.
      const named = allergensInFact(clause).filter((t) => !WHOLE_GROUP.test(t));
      const theirs = FIRST_PERSON.test(own);
      const keep = named.filter((t) =>
        !amongAllergies(t, removed) &&
        !denied.some((d) => allergyKey(d) === allergyKey(t) || haystackBlocked(t, [d])) &&
        (said === undefined || theirs || (KEEPS_OUT.test(said) && mentions(said, t))));
      if (!keep.length) continue;
      const fact = keep.length === named.length ? clause : `allergic to ${keep.join(", ")}`;
      const out = allergyOutcome(fact, false, p);
      if (out.add.length) {
        bind.push(fact);
        p = { ...p, allergies: [p.allergies, ...out.add].filter((s) => s && s.trim()).join(", ") };
      } else if (out.already.length || out.covered.length) held.push(fact);
    }
  });
  return { bind, held };
}

/** "eggs", "tree nuts" and "peanuts" read as plural; "shellfish", "hummus" and "lactose" as one thing. */
const plural = (items: string[]) => items.length > 1 || /[^siu]s$/.test(items[0] ?? "");
const itOrThem = (items: string[]) => (plural(items) ? "them" : "it");
const isOrAre = (items: string[]) => (plural(items) ? "are" : "is");
const listOf = (items: string[]) =>
  items.length <= 1 ? items[0] ?? "" : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A word the matcher knows as a member of an allergen family ("walnut", "barley", "custard"). Only these
 *  are NAMED when they are not added: the parser also hands back words like "now", "him" or "toddler"
 *  from the same sentences, and "I haven't added toddler" would be nonsense. */
const namesAllergen = (t: string) =>
  ALLERGEN_TERMS.has(t) || t.split(/\s+/).every((w) => haystackBlocked(w, ALLERGEN_KEYS));

/** The allergies a DENIAL is about that are still on the list ("not allergic to eggs any more" while eggs
 *  are bound). A denial never takes anything off the allergies: there is no removal in chat. */
function stillDenied(fact: string, have: string[]): string[] {
  const named = allergensInFact(fact);
  // The allergies this fact is about: those that block a food it names, or, when it names none
  // ("no allergies"), every one on the list.
  const touched = named.length ? have.filter((s) => named.some((t) => haystackBlocked(t, [s]))) : have;
  const seen = new Set<string>();
  return touched.filter((s) => !seen.has(allergyKey(s)) && Boolean(seen.add(allergyKey(s))));
}

/** A dish the week SERVES (from the library or imported), not a record of a meal already eaten or a slot
 *  held for eating out: those carry "Logged by you." or no ingredients. */
const served = (m: Meal) => m.ingredients.length > 0 && !/^Logged by you\./.test(m.description ?? "");

/** The served dishes in the week that hold any of these foods, by the library's own matcher. */
function servedWith(items: string[], plan: WeekPlan): string[] {
  const tokens = items.flatMap((t) => parseExclusionTokens(t, ""));
  if (!tokens.length) return [];
  const hits = plan.days.flatMap((d) => d.meals).filter(served)
    .filter((m) => haystackBlocked(mealHaystack(m.name, m.ingredients.map((i) => i.name), m.steps), tokens));
  return [...new Set(hits.map((m) => m.name))];
}

/** What a remembered allergy fact did, as data: the sentences are written from the FINAL week and
 *  profile (allergyNotes), so a promise like "nothing with it is planned" is checked, not assumed. */
interface AllergyOutcome {
  add: string[]; //      bound now
  already: string[]; //  named, and already in the allergies
  covered: string[]; //  named, and blocked by a broader allergy
  kept: string[]; //     named, and among the foods the person avoids
  notAdded: string[]; // named allergen words that were not added
  unknown: string[]; //  named words the matcher does not know ("celery", "penicillin", "toddler")
  denied?: string[]; //  every cue denied: the allergies it is about that are still on the list
  nameless?: boolean; // a cue that names nothing ("I have bad allergies")
}

/**
 * What a remembered allergy fact adds to profile.allergies, and what happened to every food it named.
 * EVERY fact that reaches here gets a note, because composeReply shows the engine's notes instead of the
 * model's prose: a model that wrote "I'll keep celery out of your meals" over a fact that bound nothing
 * used to be the whole reply, and the person believed a screening that was not happening (review of
 * 49385e5, LC-06, LC-08, LC-11).
 *
 * Which tokens bind is unchanged: the unlabelled food filter, then the matcher's own parser, so what is
 * stored is exactly what is enforced. A word the parser drops ("red" from a dye) is neither stored nor
 * announced (LC-09); a token that expands to an allergy already stored is not stored again (LC-16), and
 * nor is one an allergy already stored covers ("walnuts" under "nuts"), which is named as covered.
 */
function allergyOutcome(fact: string, labelled: boolean, profile: UserProfile): AllergyOutcome {
  const none: AllergyOutcome = { add: [], already: [], covered: [], kept: [], notAdded: [], unknown: [] };
  const have = parseExclusionTokens(profile.allergies ?? "", "");
  if (everyCueDenied(fact)) return { ...none, denied: stillDenied(fact, have) };
  const named = allergensInFact(fact);
  if (!named.length) return { ...none, nameless: true };

  const haveKeys = new Set(have.map(allergyKey));
  const factKeys = new Set<string>();
  const add: string[] = [];
  const already: string[] = [];
  const covered: string[] = [];
  const unread: string[] = []; // named, but the food filter or the parser dropped it
  for (const t of named) {
    // Unlabelled, only FOOD words count, so "allergic to penicillin" blocks nothing.
    const keys = labelled || namesFood(t) ? parseExclusionTokens(t, "").map(allergyKey) : [];
    if (!keys.length) { unread.push(t); continue; }
    if (keys.every((k) => factKeys.has(k))) continue; // the same allergy twice in one fact
    const isNew = !keys.every((k) => haveKeys.has(k) || factKeys.has(k));
    // A food the stored allergies already block entirely ("walnuts" under "nuts", "oat" beside "oats") is
    // named as covered, not added: storing it excludes nothing new (LC-16, from the same foods to fewer).
    if (isNew && exclusionCovers(have, t)) covered.push(t);
    else if (isNew) add.push(t);
    else if (keys.every((k) => haveKeys.has(k))) already.push(t);
    keys.forEach((k) => factKeys.add(k));
  }

  // A named word that was not added is either screened anyway (a broader allergy, or a food the person
  // avoids), or it is not, and then the person is told so in plain words.
  const enforced = [...have, ...add.flatMap((t) => parseExclusionTokens(t, ""))];
  const avoided = parseExclusionTokens("", profile.dislikes ?? "");
  const kept: string[] = [];
  const notAdded: string[] = [];
  const unknown: string[] = [];
  for (const t of unread) {
    if (haveKeys.has(allergyKey(t))) { if (!already.includes(t)) already.push(t); }
    else if (haystackBlocked(t, enforced)) covered.push(t);
    // Said as an ALLERGY while it is only among the foods avoided: bind it as one (the dislike already
    // blocks the same library dishes, so this adds no over-block), because an allergy is held to more
    // than a dislike, an imported dish holding it among them (review, 2026-10-20).
    else if (avoided.length && haystackBlocked(t, avoided) && parseExclusionTokens(t, "").length) add.push(t);
    else if (avoided.length && haystackBlocked(t, avoided)) kept.push(t);
    else if (namesAllergen(t)) notAdded.push(t);
    else unknown.push(t);
  }
  return { add, already, covered, kept, notAdded, unknown };
}

/** What a denial, or a fact that names no food, says when it bound nothing. "Your allergies haven't changed"
 *  is true of that one fact only, so it is taken back when anything else in the same reply moved them
 *  (withoutUnchangedClaims). */
const DENIED_NOTHING_BOUND = "I've noted that. Your allergies haven't changed.";
const NAMES_NO_FOOD = "I've noted that. It doesn't name a food, so your allergies haven't changed.";

/** The same allergies when each list blocks what the other does: "walnut" and "walnuts", or "nuts" against
 *  "nuts, walnuts", are no change. */
export function sameAllergies(a = "", b = ""): boolean {
  const A = parseExclusionTokens(a, ""), B = parseExclusionTokens(b, "");
  const within = (xs: string[], ys: string[]) => xs.every((t) => ys.some((u) => allergyKey(u) === allergyKey(t)) || exclusionCovers(ys, t));
  return within(A, B) && within(B, A);
}

/**
 * A reply's notes with "your allergies haven't changed" taken out, for when something else in the same reply
 * did change them: an undo that took one off, or another fact that bound one. "That also took peanuts off your
 * allergies. I've noted that. Your allergies haven't changed." was said in one turn, and through the agent
 * loop, which runs the undo as a step of its own (review, 2026-10-21). Called once per call by applyPrimitives
 * and once per run by runAgent, each comparing its start with its end.
 */
export function withoutUnchangedClaims(notes: string[]): string[] {
  return notes.map((n) => (n === DENIED_NOTHING_BOUND ? "I've noted that." : n === NAMES_NO_FOOD ? "I've noted that. It doesn't name a food." : n));
}

/**
 * The sentences for one remembered allergy fact, written from the FINAL week and profile of the turn.
 * "…so nothing with it is planned" is said only when no dish the week serves still holds it, and "your
 * meals aren't screened for it" only when nothing in the final allergies or exclusions covers it: the
 * same turn may exclude the food ("allergic to celery" plus exclude:[celery]), and a dish imported after
 * the allergy bound used to sit in the week under "nothing with it is planned" (review of B2, 2026-10-20).
 */
function allergyNotes(o: AllergyOutcome, plan: WeekPlan, profile: UserProfile): string[] {
  const promise = (items: string[], verb: string, tense: string) => {
    const left = servedWith(items, plan);
    return left.length
      ? `, but ${listOf(left)} in your plan still ${left.length > 1 ? "have" : "has"} ${itOrThem(items)}.`
      : `, so nothing ${verb} ${itOrThem(items)} ${tense}.`;
  };
  if (o.nameless) return [NAMES_NO_FOOD];
  if (o.denied) {
    return [o.denied.length ? `Your allergies still include ${listOf(o.denied)}${promise(o.denied, "with", "is planned")}` : DENIED_NOTHING_BOUND];
  }
  const screened = parseExclusionTokens(profile.allergies ?? "", profile.dislikes ?? "");
  const excludedNow = (w: string) => haystackBlocked(w, screened);
  const excluded = [...o.notAdded, ...o.unknown].filter(excludedNow);
  const notScreened = o.notAdded.filter((w) => !excludedNow(w));
  const notes: string[] = [];
  if (o.add.length) notes.push(`I've added ${listOf(o.add)} to your allergies${promise(o.add, "containing", "will be planned")}`);
  if (o.already.length) notes.push(`${capital(listOf(o.already))} ${isOrAre(o.already)} already in your allergies${promise(o.already, "with", "is planned")}`);
  if (o.covered.length) notes.push(`${capital(listOf(o.covered))} ${isOrAre(o.covered)} already covered by your allergies${promise(o.covered, "with", "is planned")}`);
  if (o.kept.length) notes.push(`${capital(listOf(o.kept))} ${isOrAre(o.kept)} already among the foods you avoid${promise(o.kept, "with", "is planned")}`);
  if (excluded.length) notes.push(`I haven't added ${listOf(excluded)} as an allergy, but you've excluded ${itOrThem(excluded)}${promise(excluded, "with", "is planned")}`);
  if (notScreened.length) notes.push(`I haven't added ${listOf(notScreened)} as an allergy, so your meals aren't screened for ${itOrThem(notScreened)}.`);
  // Nothing above: every word named was one the matcher does not know ("celery", "penicillin", "spring").
  if (!notes.length) notes.push("I've noted that, but I haven't added it as an allergy, so your meals aren't screened for it.");
  return notes;
}

export type Day = (typeof DAYS)[number];
export type MealType = (typeof MEAL_TYPES)[number];
export type Nutrient =
  | "iron" | "calcium" | "magnesium" | "potassium" | "zinc" | "vitD" | "vitC" | "folate" | "b12";

/** Where a constraint applies. "week" persists to the profile; a day list is a temporary per-day
 *  override; a slot targets one meal across the given days (all days if omitted). */
export type Scope = "week" | { days: Day[] } | { slot: MealType; days?: Day[] };

export interface ConstrainOp {
  op: "constrain";
  scope?: Scope; // default "week"
  diet?: UserProfile["diet"];
  budget?: UserProfile["budget"];
  cuisine?: string;
  mealsPerDay?: 3 | 4;
  exclude?: string[];
  use?: string[];
  targets?: { calories?: number; protein?: number; carbs?: number; fat?: number; fiber?: number };
  boostNutrient?: Nutrient;
  maxCookTime?: number;
  preserveMacros?: boolean;
  planMode?: "fresh" | "batch";      // switch fresh <-> meal-prep
  cadence?: "weekly" | "every3days"; // meal-prep cooking cadence
}

export interface RememberOp {
  op: "remember";
  fact: string;
  kind?: UserFact["kind"];
}

const isSlotScope = (s: Scope): s is { slot: MealType; days?: Day[] } =>
  typeof s === "object" && "slot" in s;
const isDayScope = (s: Scope): s is { days: Day[] } =>
  typeof s === "object" && "days" in s && !("slot" in s);

/**
 * `constrain` → the tested flat Operations.
 *  - scope "week"  → one `update_profile` (persists + rebuilds the week).
 *  - scope {days}  → one `regenerate_day` per day (temporary per-day override, not saved).
 *  - scope {slot}  → per-slot targeting — built in the next step; empty for now so nothing wrong fires.
 */
export function expandConstrain(c: ConstrainOp): Operation[] {
  const t = c.targets ?? {};
  const scope: Scope = c.scope ?? "week";

  if (scope === "week") {
    return [
      {
        tool: "update_profile",
        diet: c.diet ?? null, budget: c.budget ?? null, cuisine: c.cuisine ?? null,
        mealsPerDay: c.mealsPerDay ?? null, maxCookTime: c.maxCookTime ?? null,
        excludeFoods: c.exclude ?? [], useIngredients: c.use ?? [],
        targetCalories: t.calories ?? null, targetProtein: t.protein ?? null,
        targetCarbs: t.carbs ?? null, targetFat: t.fat ?? null, targetFiber: t.fiber ?? null,
        boostNutrient: c.boostNutrient ?? null, preserveMacros: c.preserveMacros ?? null,
        planMode: c.planMode ?? null, batchCadence: c.cadence ?? null,
      } as Operation,
    ];
  }

  if (isDayScope(scope)) {
    // A day range / weekday-weekend → one per-day rebuild each. exclude / use / maxCookTime / budget
    // used to be DROPPED here although regenerate_day honours them — so "no peanuts on Monday"
    // rebuilt Monday without excluding peanuts, and only chance kept them out (found by the models
    // lane, 2026-10-03). mealsPerDay stays week-only: a day cannot have a different number of meals.
    return scope.days.map(
      (day) =>
        ({
          tool: "regenerate_day", day,
          diet: c.diet ?? null, cuisine: c.cuisine ?? null,
          excludeFoods: c.exclude ?? [], useIngredients: c.use ?? [],
          maxCookTime: c.maxCookTime ?? null, budget: c.budget ?? null,
          targetCalories: t.calories ?? null, targetProtein: t.protein ?? null,
          targetFiber: t.fiber ?? null, boostNutrient: c.boostNutrient ?? null,
          preserveMacros: c.preserveMacros ?? null,
        }) as Operation,
    );
  }

  // Slot scope ("more protein at breakfast") is NOT built yet. It used to return nothing at all, so
  // the turn changed nothing, the engine said nothing, and the user read the model's "I've bumped your
  // breakfast protein". `slotScopeNote` (applied in applyPrimitives) now says the truth instead.
  return [];
}

/**
 * A constrain that names nothing to change: no targets, diet, budget, cuisine, meal count, cook time,
 * exclusion, ingredient to use, nutrient or plan mode. "Make the weekend lighter" once arrived as
 * {scope: weekend, preserveMacros: false} and nothing else; the day branch rebuilt all six weekend
 * dishes at the same calories and wrote no note, so the user read the model's "Saturday and Sunday
 * have been scaled down" — false, with planChanged true, so the false-claim guard could not catch it
 * (models lane, 2026-10-03). A random re-roll is worse than doing nothing: it changes nothing and
 * says what it needs.
 *
 * Only when it cannot mean anything else, though: the WEEK scope (a bare re-solve keeps every dish
 * anyway), or `preserveMacros: false` with no new target (leave the targets for… what?). A bare
 * DAY-scoped constrain is how the model asks for different meals on Saturday (the vocabulary has no
 * other re-roll), so that one still re-plans the day, and regenerate_day now always says where it
 * landed. See `noOpConstrain`.
 */
export function isEmptyConstrain(c: ConstrainOp): boolean {
  const t = c.targets ?? {};
  const hasTarget = [t.calories, t.protein, t.carbs, t.fat, t.fiber].some((v) => typeof v === "number" && v > 0);
  return !(
    hasTarget || c.diet || c.budget || c.cuisine || c.mealsPerDay || (c.maxCookTime ?? 0) > 0 || c.exclude?.length ||
    c.use?.length || c.boostNutrient || c.planMode || c.cadence
  );
}

/** An empty constrain that changes nothing (see isEmptyConstrain): week scope, or no-target preserveMacros:false. */
export function noOpConstrain(c: ConstrainOp): boolean {
  const scope = c.scope ?? "week";
  if (!isEmptyConstrain(c)) return false;
  return scope === "week" || (isDayScope(scope) && c.preserveMacros === false);
}

/** What the user reads for an empty constrain: nothing changed, and what would make it change. */
export function emptyConstrainNote(c: ConstrainOp): string {
  const scope = c.scope ?? "week";
  const where = scope === "week" ? "your week" : isDayScope(scope) ? scope.days.join(" and ") : `your ${scope.slot}`;
  return `That didn't say what to change about ${where}, so nothing changed. Tell me what you'd like: fewer calories (and by how much), more protein, a different diet, quicker meals, or a dish to swap.`;
}

/** The honest answer to a slot-scoped constrain, until per-slot targeting exists (milestone C4). */
export function slotScopeNote(c: ConstrainOp): string | null {
  const scope = c.scope ?? "week";
  if (scope === "week" || isDayScope(scope)) return null;
  const slot = scope.slot;
  return `I can't change just your ${slot} that way yet, so nothing changed. I can swap your ${slot} for a dish that fits (for example a higher-protein one), or make it bigger or smaller — tell me which.`;
}

/** Apply a `remember` to the profile's memory: dedupe on the fact text, stamp the day if given. A fact
 *  already stored leaves the profile EXACTLY as it was (position, first `since` and label kept): restating
 *  it used to move it to the end with a new stamp, which counted as a change and took the undo slot from
 *  the person's last real change (review, 2026-10-20). The same text under another label is the same fact
 *  too: models label one fact inconsistently, and the engine never reads the stored label (the prompt line
 *  and the condition triggers read the text; an allergy binds by the op's own label, in applyPrimitives).
 *  The model's get_profile read shows the label as first stored. */
export function applyRemember(profile: UserProfile, r: RememberOp, today?: string): UserProfile {
  const text = r.fact.trim();
  if (!text) return profile;
  const same = (profile.memory ?? []).some((f) => f.fact.toLowerCase() === text.toLowerCase());
  if (same) return profile;
  const fact: UserFact = { fact: text, ...(r.kind ? { kind: r.kind } : {}), ...(today ? { since: today } : {}) };
  const rest = (profile.memory ?? []).filter((f) => f.fact.toLowerCase() !== text.toLowerCase());
  return { ...profile, memory: [...rest, fact] };
}

/** A v2 operation is either a general primitive or a pass-through of an existing engine verb
 *  (swap_meal, log_meal, rate_meal, lock_meal, scale_portions, weekly_report, …). */
// The uniform `op`-based verbs (so the model speaks ONE vocabulary — every op has an `op`), each
// mapping to an existing tested engine tool. This keeps the model's surface general while the
// engine keeps its proven internals.
// no days (or all seven) = every day; one or more days = exactly those days. only = the user scoped it
// ("just dinner"): resize the other meals, never replace them.
export interface SwapOp { op: "swap"; dish: string; slot?: MealType; days?: Day[]; only?: boolean }
export interface LogOp { op: "log"; day: Day; slot: MealType; dish: string; calories?: number; protein?: number }
export interface ReserveOp { op: "reserve"; day: Day; slot: MealType; calories?: number }
export interface ResizeOp { op: "resize"; direction: "much_smaller" | "smaller" | "bigger" | "much_bigger"; day?: Day; slot?: MealType }
export interface RateOp { op: "rate"; rating: 1 | 2 | 3 | 4 | 5; dish?: string; day?: Day; slot?: MealType }
export interface PinOp { op: "pin" | "unpin"; day: Day; slot: MealType }
export interface ReportOp { op: "report" }
export interface ExplainOp { op: "explain"; day: Day; slot: MealType }
export interface SubstituteOp { op: "substitute"; ingredient: string; day?: Day; slot?: MealType }
export interface SymptomOp { op: "symptom"; text: string }
export interface HydrationOp { op: "hydration"; weightKg?: number; activity?: string }
export interface UndoOp { op: "undo" }
export interface AnswerOp { op: "answer" }
/** The model's flag that someone may not be safe (applyPrimitives answers it before anything else). */
export interface CrisisOp { op: "crisis" }

export type VerbOp =
  | SwapOp | LogOp | ReserveOp | ResizeOp | RateOp | PinOp | ReportOp
  | ExplainOp | SubstituteOp | SymptomOp | HydrationOp | UndoOp | AnswerOp | CrisisOp;

/**
 * A uniform `op` verb → the existing engine Operation(s). `answer` maps to nothing (pure reply).
 *
 * A list, because a swap over SEVERAL days is one engine swap per day. It used to map only a single
 * day and send every longer list down the every-day path, so "make Wednesday to Sunday's breakfast the
 * porridge" replaced Monday's and Tuesday's too, under a note saying "every day" — a real 550B turn
 * (models lane, 2026-10-03). No days, or all seven, is still the one every-day swap and its one note.
 */
export function verbToOperations(o: VerbOp): Operation[] {
  switch (o.op) {
    case "swap": {
      const swap = (day: Day | null) => ({ tool: "swap_meal", dish: o.dish, mealType: o.slot ?? null, day, keepOtherMeals: o.only ?? null }) as Operation;
      const days = [...new Set(o.days ?? [])].sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b));
      if (days.length === 0 || DAYS.every((d) => days.includes(d))) return [swap(null)];
      return days.map(swap);
    }
    default: {
      const one = verbToOperation(o);
      return one ? [one] : [];
    }
  }
}

/** Every verb but `swap`, which can span days and so goes through `verbToOperations`. */
function verbToOperation(o: Exclude<VerbOp, SwapOp>): Operation | null {
  switch (o.op) {
    case "log": return { tool: "log_meal", day: o.day, mealType: o.slot, dish: o.dish, loggedCalories: o.calories ?? null, loggedProtein: o.protein ?? null } as Operation;
    case "reserve": return { tool: "eating_out", day: o.day, mealType: o.slot, estimatedCalories: o.calories ?? null } as Operation;
    case "resize": return { tool: "scale_portions", portionChange: o.direction, day: o.day ?? null, mealType: o.slot ?? null } as Operation;
    case "rate": return { tool: "rate_meal", rating: o.rating, dish: o.dish ?? null, day: o.day ?? null, mealType: o.slot ?? null } as Operation;
    case "pin": return { tool: "lock_meal", day: o.day, mealType: o.slot } as Operation;
    case "unpin": return { tool: "unlock_meal", day: o.day, mealType: o.slot } as Operation;
    case "report": return { tool: "weekly_report" } as Operation;
    case "explain": return { tool: "explain_meal", day: o.day, mealType: o.slot } as Operation;
    case "substitute": return { tool: "substitute_ingredient", ingredient: o.ingredient, day: o.day ?? null, mealType: o.slot ?? null } as Operation;
    case "symptom": return { tool: "symptom_check", symptom: o.text } as Operation;
    case "hydration": return { tool: "hydration", weightKg: o.weightKg ?? null, activity: (o.activity ?? null) as Operation["activity"] } as Operation;
    case "undo": return { tool: "undo" } as Operation;
    case "answer": return null;
    // Never reaches the engine: applyPrimitives answers a crisis before mapping anything.
    case "crisis": return null;
    default: return null;
  }
}

export type PrimitiveOp = ConstrainOp | RememberOp | VerbOp | Operation;

const isConstrain = (o: PrimitiveOp): o is ConstrainOp => (o as ConstrainOp).op === "constrain";
const isRemember = (o: PrimitiveOp): o is RememberOp => (o as RememberOp).op === "remember";
const isVerb = (o: PrimitiveOp): o is VerbOp => "op" in o && (o as { op: string }).op !== "constrain" && (o as { op: string }).op !== "remember";

/**
 * THE executor. Runs a turn's primitives against the deterministic engine and returns the same shape
 * as `applyOperations`: apply `remember` to the profile's memory, expand every `constrain`, pass the
 * rest straight through, then hand the flat op list to the proven engine. This bridge is what both
 * the live assistant AND the generate-then-validate data pipeline call.
 */
export function applyPrimitives(
  profile: UserProfile,
  plan: WeekPlan,
  ops: PrimitiveOp[],
  today?: string,
  previous?: PlanSnapshot,
): ReturnType<typeof applyOperations> {
  // A crisis the model flagged is the whole answer: the reviewed crisis reply, the same one the pre-scan gives,
  // and nothing else from the turn applied, not even an undo. With reasoning off, Nemotron sent crisis words to
  // the symptom tool (6 of 8), where a phrasing the pre-scan misses got a nutrition note: "honestly i wish i was
  // dead" got one about iron and fatigue (the models lane's diagnosis, 2026-10-22). No new crisis wording here.
  if (ops.some((o) => (o as { op?: string }).op === "crisis")) {
    return { plan, profile, notes: [CRISIS_REPLY], replyOverride: CRISIS_REPLY, planChanged: false, profileChanged: false, undone: false };
  }
  // An UNDO restores the whole state before the last change. In one pass with the turn's other ops it
  // ran after them, so "I'm allergic to peanuts — and undo that swap" bound peanuts and then restored the
  // profile from before: no allergy, a peanut dish left in the week, and the note "nothing containing
  // them will be planned" (models lane audit, undo-flow#2; an I2 hole, in either order). So the undo runs
  // FIRST, alone, and everything else in the turn applies on top of what it restored.
  const isUndoOp = (o: PrimitiveOp) => (o as { op?: string }).op === "undo" || (o as { tool?: string }).tool === "undo";
  const undoOp = ops.find(isUndoOp);
  if (undoOp && ops.some((o) => !isUndoOp(o))) {
    const back = applyPrimitives(profile, plan, [undoOp], today, previous);
    const rest = applyPrimitives(back.profile, back.plan, ops.filter((o) => !isUndoOp(o)), today);
    const notes = [...back.notes, ...rest.notes];
    return {
      ...rest,
      notes: sameAllergies(profile.allergies, rest.profile.allergies) ? notes : withoutUnchangedClaims(notes),
      planChanged: back.planChanged || rest.planChanged,
      profileChanged: back.profileChanged || rest.profileChanged,
      undone: back.undone || rest.undone,
      replyOverride: rest.replyOverride ?? back.replyOverride,
    };
  }

  let p = profile;
  let remembered = false;
  const flat: Operation[] = [];
  // A note is text, or a function of the turn's FINAL week and profile (an allergy fact's sentences).
  const extraNotes: (string | ((final: { plan: WeekPlan; profile: UserProfile }) => string[]))[] = [];
  for (const o of ops) {
    if (isRemember(o)) {
      const next = applyRemember(p, o, today);
      remembered = remembered || next !== p;
      p = next;
      // A remembered ALLERGY must bind the ENGINE, not just the assistant's memory. It used to write
      // only profile.memory, so the selector never saw it: "heads up, I'm allergic to peanuts" was
      // remembered, and two peanut dishes stayed in the week unless the model ALSO sent an exclude
      // (found by the models lane; a 550B model did exactly that). Now the allergen joins
      // profile.allergies — the field the exclusion matcher reads — and the week is re-solved, which
      // keeps every dish that still passes and replaces only the ones that no longer do.
      // The LABEL is the model's and optional, so a fact that SAYS allergy, intolerance or coeliac binds
      // the engine whatever it was labelled: {fact:"allergic to shellfish"} with no kind left shrimp in
      // the week, and "has coeliac disease" labelled a condition left every gluten meal (models lane,
      // 2026-10-18). Unlabelled, only FOOD words count, so "allergic to penicillin" blocks nothing; and
      // with no cue the fact is never parsed, because the parser alone reads "a high-protein snack" as
      // a "protein" allergy. And a fact that only DENIES an allergy binds nothing, labelled or not
      // (everyCueDenied): "No allergies; eats dairy and gluten" had banned 59% of the library.
      // Whatever it binds, the person is told exactly what happened (allergyOutcome, allergyNotes).
      const labelled = o.kind === "allergy";
      if (labelled || ALLERGY_CUE.test(o.fact)) {
        const out = allergyOutcome(o.fact, labelled, p);
        if (out.add.length) {
          p = { ...p, allergies: [p.allergies, ...out.add].filter((s) => s && s.trim()).join(", ") };
          // Said again, so no longer a hand removal: a removed allergy the person states anew is theirs again.
          if (p.removedAllergies?.length) {
            const left = p.removedAllergies.filter((r) => !parseExclusionTokens(r, "").some((t) => amongAllergies(t, out.add)));
            const { removedAllergies: _gone, ...rest } = p;
            p = left.length ? { ...p, removedAllergies: left } : rest;
          }
          flat.push({ tool: "update_profile" } as Operation);
        } else if (servedWith([...out.already, ...out.covered, ...(out.denied ?? [])], plan).length && !flat.some((f) => f.tool === "update_profile")) {
          // Mentioned (restated, or even denied) while a dish the week serves still holds a BOUND allergy
          // (one imported after it bound): re-solve, so the dish is replaced, rather than answer "nothing
          // with it is planned" over it. A denial never unbinds; it only gets the week back in line.
          flat.push({ tool: "update_profile" } as Operation);
        }
        extraNotes.push((final) => allergyNotes(out, final.plan, final.profile));
      }
    } else if (isConstrain(o)) {
      if (noOpConstrain(o)) {
        extraNotes.push(emptyConstrainNote(o));
        continue;
      }
      flat.push(...expandConstrain(o));
      const honest = slotScopeNote(o);
      if (honest) extraNotes.push(honest);
    } else if (isVerb(o)) {
      flat.push(...verbToOperations(o));
    } else {
      flat.push(o as Operation); // a raw {tool:…} Operation, passed straight through
    }
  }
  // `previous` is threaded to the engine so an `undo` verb can restore the prior snapshot, exactly as
  // the live route does — omit it (data pipeline, tests) and undo is simply a no-op.
  const res = applyOperations(p, plan, flat, previous);
  // applyOperations returns the (memory-carrying) profile either way; force profileChanged if a
  // remember happened so the caller persists the new memory even on a plan-only-unchanged turn.
  // The notes written here are ENGINE notes like any other, so composeReply shows them as the truth
  // rather than letting the model's prose claim a change that did not happen.
  const written = extraNotes.flatMap((n) => (typeof n === "string" ? [n] : n({ plan: res.plan, profile: res.profile })));
  const notes = [...written, ...res.notes];
  return {
    ...res,
    notes: sameAllergies(profile.allergies, res.profile.allergies) ? notes : withoutUnchangedClaims(notes),
    profileChanged: res.profileChanged || remembered,
  };
}

/** Render the memory as a compact context line for the model's system prompt each turn. */
export function memoryContext(profile: UserProfile): string {
  const mem = profile.memory ?? [];
  if (!mem.length) return "";
  return "Known about the user (remember and apply these): " + mem.map((f) => f.fact).join("; ") + ".";
}

// --- v2 turn schema (validates the model's output; also constrains local json_schema generation) ---
const dayEnum = z.enum(DAYS);
const slotEnum = z.enum(MEAL_TYPES);
// {slot, days?} comes BEFORE {days}: a union takes its first member that parses, and zod strips the keys
// a member does not name, so {slot:"lunch", days:["Wednesday"]} used to parse as {days:["Wednesday"]}.
// The whole day was re-planned, and the "can't change just your lunch" note never fired (models lane,
// 2026-10-20). {days} is strict too: a slot the first member refuses ({slot:"brunch"}, a list of slots) used
// to fall through to it with the slot stripped, re-planning whole days again (review, 2026-10-21). Such a turn
// is now refused. The provider first reads what it can (ai.ts normalizeScope): a slot under another key or in
// capitals is the slot, and a key that names no meal (null, "", "all") or no meal at all is dropped, so those
// still mean the whole day(s).
const scopeSchema = z.union([
  z.literal("week"),
  z.object({ slot: slotEnum, days: z.array(dayEnum).optional() }),
  z.object({ days: z.array(dayEnum) }).strict(),
]);
const nutrientEnum = z.enum(["iron", "calcium", "magnesium", "potassium", "zinc", "vitD", "vitC", "folate", "b12"]);

/** The model's operation vocabulary, discriminated on `op`. */
export const PrimitiveOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("constrain"),
    scope: scopeSchema.optional(),
    diet: z.enum(["none", "vegetarian", "vegan", "keto", "mediterranean"]).optional(),
    budget: z.enum(["low", "medium", "high"]).optional(),
    cuisine: z.string().optional(),
    mealsPerDay: z.union([z.literal(3), z.literal(4)]).optional(),
    exclude: z.array(z.string()).optional(),
    use: z.array(z.string()).optional(),
    targets: z.object({
      calories: z.number().optional(), protein: z.number().optional(), carbs: z.number().optional(),
      fat: z.number().optional(), fiber: z.number().optional(),
    }).optional(),
    boostNutrient: nutrientEnum.optional(),
    maxCookTime: z.number().optional(),
    preserveMacros: z.boolean().optional(),
    planMode: z.enum(["fresh", "batch"]).optional(),
    cadence: z.enum(["weekly", "every3days"]).optional(),
  }),
  z.object({ op: z.literal("remember"), fact: z.string(), kind: z.enum(["preference", "allergy", "condition", "goal", "context"]).optional() }),
  z.object({ op: z.literal("swap"), dish: z.string(), slot: slotEnum.optional(), days: z.array(dayEnum).optional(), only: z.boolean().optional() }),
  z.object({ op: z.literal("log"), day: dayEnum, slot: slotEnum, dish: z.string(), calories: z.number().optional(), protein: z.number().optional() }),
  z.object({ op: z.literal("reserve"), day: dayEnum, slot: slotEnum, calories: z.number().optional() }),
  z.object({ op: z.literal("resize"), direction: z.enum(["much_smaller", "smaller", "bigger", "much_bigger"]), day: dayEnum.optional(), slot: slotEnum.optional() }),
  z.object({ op: z.literal("rate"), rating: z.number().int().min(1).max(5), dish: z.string().optional(), day: dayEnum.optional(), slot: slotEnum.optional() }),
  z.object({ op: z.literal("pin"), day: dayEnum, slot: slotEnum }),
  z.object({ op: z.literal("unpin"), day: dayEnum, slot: slotEnum }),
  z.object({ op: z.literal("report") }),
  z.object({ op: z.literal("explain"), day: dayEnum, slot: slotEnum }),
  z.object({ op: z.literal("substitute"), ingredient: z.string(), day: dayEnum.optional(), slot: slotEnum.optional() }),
  z.object({ op: z.literal("symptom"), text: z.string() }),
  // The model's own flag that someone may not be safe. No fields: the app answers with its reviewed crisis
  // reply, and applies nothing else from the turn (applyPrimitives).
  z.object({ op: z.literal("crisis") }),
  z.object({ op: z.literal("hydration"), weightKg: z.number().optional(), activity: z.enum(["sedentary", "light", "moderate", "active", "very_active"]).optional() }),
  z.object({ op: z.literal("undo") }),
  z.object({ op: z.literal("answer") }),
]);

/** One reason-then-act turn: the model thinks, replies, and emits primitive operations. */
export const AssistantTurnV2Schema = z.object({
  thinking: z.string(),
  reply: z.string(),
  operations: z.array(PrimitiveOpSchema),
});
export type AssistantTurnV2 = z.infer<typeof AssistantTurnV2Schema>;

/**
 * The agent loop's READ SURFACE as operations (agentTools.ts runs them; results go back to the model
 * only). Without these in the schema a model physically cannot look anything up — a `find_recipes`
 * op fails validation — so the loop's seven read tools were unreachable in production. `report` is
 * already a primitive above (the loop treats it as a read) and is not repeated.
 */
const ReadOpOptions = [
  z.object({
    op: z.literal("find_recipes"),
    mealType: slotEnum.optional(),
    diet: z.enum(["vegetarian", "vegan", "keto", "mediterranean", "gluten_free"]).optional(),
    minProtein: z.number().optional(),
    maxCalories: z.number().optional(),
    maxTime: z.number().optional(),
    query: z.string().optional(),
    sort: z.enum(["default", "protein", "calories-low", "time"]).optional(),
    limit: z.number().int().min(1).max(10).optional(),
  }),
  z.object({ op: z.literal("inspect_recipe"), name: z.string() }),
  z.object({ op: z.literal("get_plan"), day: dayEnum.optional() }),
  z.object({ op: z.literal("get_profile") }),
  z.object({ op: z.literal("get_saved") }),
  z.object({ op: z.literal("what_if"), operations: z.array(PrimitiveOpSchema) }),
] as const;

/** A turn INSIDE the agent loop: primitives plus the read surface. Only the loop's adapter uses it —
 *  single-turn routes, training data and the hard-case eval keep AssistantTurnV2Schema unchanged. */
export const AgentTurnSchema = z.object({
  thinking: z.string(),
  reply: z.string(),
  operations: z.array(z.discriminatedUnion("op", [...PrimitiveOpSchema.options, ...ReadOpOptions])),
});
