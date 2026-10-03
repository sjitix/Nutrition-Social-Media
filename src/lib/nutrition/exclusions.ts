/**
 * Allergen / exclusion matching.
 *
 * The naive version was `haystack.includes(token)`, and it was quietly dangerous:
 *   - allergies "nuts" did NOT match "almonds" (no such substring) -> a tree-nut allergic
 *     user was served almonds. "walnuts" and "peanuts" DID match, so coverage looked fine.
 *   - dislikes "egg" DID match "eggplant"; "oat" matched "goat cheese" -> silent over-blocking.
 *   - a one-character token like "a" matched every recipe -> the whole plan emptied, silently.
 *
 * Allergies are a HARD rule. A miss can hurt someone, so matching is word-aware and expands
 * category words ("nuts", "dairy", "gluten") into their member foods.
 *
 * The lists below were widened on 2026-10-03 after a property-test sweep (V1 milestone D5b) found
 * real servings, end to end, for allergies typed in ordinary ways: "prawns" was served shrimp,
 * "soya" was served tofu, "dairy-free" was served dairy 23 times in five weeks, a whey protein
 * powder passed a milk allergy, and a pizza base passed a coeliac. Each list now names the foods
 * the sweep found missing; scripts/test-engine.mts holds the cases.
 */
import { INGREDIENTS } from "../data/ingredients";

// Prepared/compound foods hide allergens their NAME doesn't spell out: pesto carries tree nuts
// (pine/cashew) AND parmesan; hummus carries tahini (sesame); Caesar dressing carries anchovy (fish)
// and raw egg; a shop tikka masala or korma sauce carries cream and often cashew or almond; granola
// and muesli usually carry nuts; buffalo sauce is hot sauce and butter; enchilada sauce is thickened
// with flour, and sausages are bound with rusk; kimchi is traditionally made with fish sauce and
// salted shrimp. Each is listed under every allergen it can carry. Blocking an occasionally-safe prep
// is the right failure direction — the alternative is putting an allergen on someone's plate.

const TREE_NUTS = [
  "almond", "walnut", "pecan", "cashew", "hazelnut", "pistachio", "macadamia", "brazil nut", "pine nut",
  "pesto", "marzipan", "praline", "granola", "muesli", "tikka masala", "korma",
];
const PEANUTS = ["peanut", "groundnut", "satay"];
const NUTS = [...TREE_NUTS, ...PEANUTS, "nut"];

// "protein powder" is whey unless it says otherwise (TERM_EXCEPTIONS lets the plant kinds through).
const DAIRY = [
  "milk", "cheese", "yogurt", "yoghurt", "butter", "buttermilk", "cream", "feta", "mozzarella", "cheddar",
  "parmesan", "ricotta", "halloumi", "paneer", "ghee", "whey", "kefir", "skyr", "quark", "labneh",
  "custard", "mascarpone", "brie", "gouda", "creme fraiche", "tzatziki", "raita", "alfredo", "bechamel",
  "queso", "dairy", "pesto", "caesar dressing", "protein powder", "tikka masala", "korma", "buffalo sauce",
];

// teriyaki AND the hyphenated soy sauces (soy-ginger / ginger-soy / sesame-soy) are soy sauce with
// wheat in it — they belong in all three lists. The hyphenated names slipped the "soy sauce" term:
// it is matched as a phrase and "soy-ginger sauce" does not contain it, so a coeliac excluding
// "gluten"/"wheat" was served them. (Found by an adversarial under-block review, 2026-09-03.)
// Shared by the allergen path (word-aware) and the diet-tag path (substring) — see GLUTEN_INGREDIENTS.
const GLUTEN_SHARED = [
  "bread", "pasta", "couscous", "bulgur", "orzo", "panko", "spaghetti", "penne", "noodle", "bagel", "wrap",
  "tortilla", "flour", "muesli", "granola", "soy sauce", "soy-ginger sauce", "ginger-soy sauce",
  "sesame-soy sauce", "teriyaki", "wheat", "toast", "bun", "pizza", "pizza base", "pastry", "naan",
  "barley", "rye", "spelt", "semolina", "seitan", "farro", "enchilada sauce", "sausage", "muffin", "cracker",
  "crouton",
];
// Words a word-aware matcher needs spelled out, because it does not see "bread" inside "flatbread".
const GLUTEN = [
  ...GLUTEN_SHARED, "pita", "pitta", "sourdough", "cornbread", "shortbread", "flatbread", "breadcrumb",
  "wholewheat", "wholemeal", "malt",
];
const WHEAT = GLUTEN.filter((t) => !["barley", "rye", "malt"].includes(t));

const FISH = [
  "salmon", "tuna", "cod", "mackerel", "trout", "anchovy", "sardine", "haddock", "pollock", "tilapia",
  "halibut", "herring", "snapper", "swordfish", "sea bass", "seabass", "fish", "caesar dressing",
  "worcestershire", "kimchi",
];
const CRUSTACEANS = ["shrimp", "prawn", "crab", "lobster", "crayfish", "langoustine", "scampi", "crustacean", "kimchi"];
const MOLLUSCS = ["mussel", "clam", "oyster", "scallop", "squid", "calamari", "octopus", "snail", "escargot", "mollusc", "mollusk"];
const SHELLFISH = [...CRUSTACEANS, ...MOLLUSCS, "shellfish"];

const SOY = [
  "tofu", "tempeh", "edamame", "soy", "soya", "soybean", "miso", "natto", "tamari", "soy sauce",
  "soy-ginger sauce", "ginger-soy sauce", "sesame-soy sauce", "teriyaki",
];
const EGG = ["egg", "caesar dressing", "mayonnaise", "mayo", "aioli", "meringue", "custard", "hollandaise", "carbonara"];

/**
 * Category token -> the concrete foods it must also block. A key is also a word people TYPE, so the
 * synonyms and label terms are keys too ("soya", "prawns", "coeliac", "crustaceans"): each must block
 * what its plain-English twin blocks, and a key is how expandExclusion recognises one.
 */
const CATEGORY_TERMS: Record<string, string[]> = {
  nut: NUTS,
  nuts: NUTS,
  "tree nut": TREE_NUTS,
  "tree nuts": TREE_NUTS,
  peanut: PEANUTS,
  groundnut: PEANUTS,

  // "milk" is what people actually type for a cow's-milk-protein allergy. It must mean dairy,
  // not just the literal word, or cheddar sails straight through.
  dairy: DAIRY,
  lactose: DAIRY,
  milk: DAIRY,
  yogurt: ["yogurt", "yoghurt"],
  yoghurt: ["yogurt", "yoghurt"],

  gluten: GLUTEN,
  coeliac: GLUTEN,
  celiac: GLUTEN,
  wheat: WHEAT,

  fish: FISH,
  shellfish: SHELLFISH,
  crustacean: CRUSTACEANS,
  mollusc: MOLLUSCS,
  mollusk: MOLLUSCS,
  seafood: [...FISH, ...SHELLFISH, "seafood"],
  // A prawn and a shrimp are the same animal under two names (UK and US).
  shrimp: ["shrimp", "prawn", "scampi"],
  prawn: ["shrimp", "prawn", "scampi"],

  soy: SOY,
  soya: SOY,
  soybean: SOY,
  sesame: ["sesame", "tahini", "hummus", "halva", "sesame-soy sauce"],
  tahini: ["sesame", "tahini", "hummus", "halva", "sesame-soy sauce"],
  // Milk proteins and the clinical name for a milk allergy: each is the dairy allergy under another name.
  // "casein" blocked no dairy at all, and a typed "whey" still let whey protein powder through.
  casein: DAIRY,
  whey: DAIRY,
  cmpa: DAIRY,
  pork: ["pork", "bacon", "chorizo", "sausage", "ham", "pepperoni", "prosciutto", "salami", "pancetta", "lard", "gammon", "guanciale", "gelatin"],
  // caesar dressing is raw egg yolk + parmesan + anchovy — it hides egg and dairy the way its name
  // hides the anchovy already covered under fish/seafood. Mirror the pesto (nut+dairy) precedent.
  // BOTH "egg" and "eggs" are keyed (like nut/nuts): a singular allergy must expand too, or a user
  // who typed "egg" would get no category expansion and Caesar dressing would slip straight through.
  egg: EGG,
  eggs: EGG,
};

/** The category words above ("nuts", "dairy", "gluten"…) — so other code can recognise an allergen
 *  word without a second copy of the list drifting from this one. */
export const EXCLUSION_CATEGORIES: readonly string[] = Object.keys(CATEGORY_TERMS);

/** Suffixes that still mean "the same food/verb": almond->almonds, bake->baked/baking. */
export function wordMatches(word: string, term: string): boolean {
  if (word === term) return true;
  if (word.startsWith(term)) {
    const suffix = word.slice(term.length);
    if (["s", "es", "d", "ed", "ing", "y"].includes(suffix)) return true;
  }
  // bake -> baking (drop the trailing 'e' before -ing)
  if (term.endsWith("e") && word === term.slice(0, -1) + "ing") return true;
  // anchovy -> anchovies, berry -> berries. Without it the fish category, which lists "anchovy",
  // did not block "anchovies", and a typed "anchovies" did not block "anchovy".
  if (term.length > 2 && term.endsWith("y") && word === term.slice(0, -1) + "ies") return true;
  return false;
}

/** The key a typed word stands for: itself, or its singular ("crustaceans" -> "crustacean"). */
function categoryKey(t: string): string | null {
  if (CATEGORY_TERMS[t]) return t;
  for (const s of [t.replace(/ies$/, "y"), t.replace(/es$/, ""), t.replace(/s$/, "")])
    if (s !== t && CATEGORY_TERMS[s]) return s;
  return null;
}

/** Expand a user token into every term it should block. */
export function expandExclusion(token: string): string[] {
  const t = token.trim().toLowerCase();
  const key = categoryKey(t);
  return key ? CATEGORY_TERMS[key] : [t];
}

/**
 * Word-level match in BOTH directions, because an allergy token and an ingredient can differ by a
 * plural on either side.
 *
 * The one-directional version shipped a real allergen exposure: a user who typed "peanuts" — the
 * literal placeholder in the onboarding form — was served "Thai Peanut Chicken Rice Bowl", because
 * wordMatches("peanut", "peanuts") is false. It only ever asked whether the INGREDIENT was a
 * plural of the TOKEN, never the reverse.
 *
 * This does not reintroduce the "egg" -> "eggplant" over-block: neither direction produces an
 * allowed suffix ("plant" isn't one), and the same holds for "oat" -> "goat".
 *
 * The reverse direction needs a word of 3+ letters: without that, "so" in "toss so it coats" read as
 * a stem of "soy" and "co" in "co-op" as a stem of "cod".
 */
function termMatchesWord(word: string, term: string): boolean {
  if (wordMatches(word, term)) return true;
  if (word.length < 3) return false;
  // The reverse -ies rule needs a real word on the recipe side: "fries" (typed) must not reach the
  // cooking verb "fry", which blocked 63 stir-fries for a dislike of chips (D5b review).
  if (word.length < 4 && term === word.slice(0, -1) + "ies") return false;
  return wordMatches(term, word);
}

/**
 * A term that also names a food it does NOT mean. Peanut butter, almond butter and cocoa butter are
 * not dairy, and soy or pea protein powder is not whey. The "dairy"/"lactose" categories list the bare
 * word "butter", which would otherwise strip every nut butter from a lactose-intolerant user's plan.
 * The diet path already knew this (VEGAN_EXCEPTIONS); the allergen path did not. The gluten words get
 * the diet path's own exceptions too (corn tortillas, chickpea flour, rice noodles are safe for a
 * coeliac), so a "gluten" allergy no longer removes dishes the library tags gluten_free; and a dislike
 * of olives no longer bans olive oil, the default cooking fat.
 */
const TERM_EXCEPTIONS: Record<string, string[]> = {
  butter: ["peanut butter", "almond butter", "cocoa butter", "nut butter", "cashew butter"],
  "protein powder": ["soy protein powder", "pea protein powder", "plant protein powder"],
  tortilla: ["corn tortilla"],
  flour: ["chickpea flour", "oat flour", "rice flour", "almond flour", "coconut flour"],
  noodle: ["rice noodle", "zucchini noodle", "courgette noodle", "glass noodle", "shirataki noodle"],
  cracker: ["rice cracker"],
  muffin: ["egg muffin", "muffin tin"],
  crouton: ["no crouton"],
  olive: ["olive oil"],
  olives: ["olive oil"],
  pepper: ["black pepper", "white pepper"],
  peppers: ["black pepper", "white pepper"],
  cherry: ["cherry tomato"],
  cherries: ["cherry tomato"],
};

/**
 * "toast" and "wrap" are gluten foods and also cooking verbs: "toast the cumin", "wrap in foil".
 * Read as foods, they blocked nine recipes with no gluten in them for every coeliac. One of these
 * words counts as the food unless it is inflected as a verb ("toasted", "wrapping"), starts a
 * sentence (an instruction: "Toast pine nuts.", "Wrap and chill."), or is followed by the word a verb
 * takes ("toast the…", "wrap in…"). A recipe that toasts or wraps a gluten food names that food, and
 * the food itself still blocks it.
 */
const VERB_NOUNS = new Set(["toast", "wrap"]);
const VERB_FOLLOWERS = new Set(["the", "a", "an", "in", "until", "for", "lightly", "briefly", "gently", "over", "them", "it", "each", "both", "tightly", "up", "under", "with", "and", "then", "loosely"]);
// An instruction has an object after it ("Toast pine nuts"); the bare word alone is the food.
const SENTENCE_VERB = /(^|[.!?;:]\s*)(?:toast|wrap)(?:s|ed|ing)?\b(?=\s+[a-z])/g;

/** Lowercase, with accents folded ("crème fraîche" -> "creme fraiche") and typographic apostrophes
 *  made plain, so what people type matches what the lists spell. */
function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[‘’`´]/g, "'");
}

/**
 * Does `haystack` (a recipe's name + ingredients + steps) contain an excluded term?
 * Multi-word terms ("soy sauce") are matched as phrases; single words are matched on word
 * boundaries with light plural/verb stemming, so "egg" never blocks "eggplant".
 */
export function haystackBlocked(haystack: string, tokens: string[]): boolean {
  if (!tokens.length) return false;
  const hay = fold(haystack);
  const words = hay.split(/[^a-z]+/).filter(Boolean);
  let verbWords: string[] | null = null;
  for (const token of tokens) {
    for (const term of expandExclusion(token)) {
      const exceptions = TERM_EXCEPTIONS[term];
      const text = exceptions ? exceptions.reduce((acc, ex) => acc.split(ex).join(" "), hay) : hay;
      if (term.includes(" ")) {
        if (text.includes(term)) return true; // phrase
      } else if (VERB_NOUNS.has(term)) {
        verbWords ??= hay.replace(SENTENCE_VERB, "$1 ").split(/[^a-z]+/).filter(Boolean);
        for (let i = 0; i < verbWords.length; i++)
          if ((verbWords[i] === term || verbWords[i] === term + "s") && !VERB_FOLLOWERS.has(verbWords[i + 1] ?? "")) return true;
      } else if ((exceptions ? text.split(/[^a-z]+/) : words).some((w) => termMatchesWord(w, term))) {
        return true;
      }
    }
  }
  return false;
}

/* ------------------------------------------------------------------------- *
 * Reading what a person TYPED.
 *
 * Three rounds of real failures shaped this (D5b, 2026-10-03). Comma-only splitting turned "allergic
 * to nuts and shellfish" into one token that matched nothing. Then a sweep found 15 of 17 ordinary
 * typings losing the allergy ("peanuts.", "I’m allergic…", a line break, "dairy-free"). Then the first
 * fix for those dropped any clause containing an "allowance" — and a review showed "I can eat
 * anything without gluten" (41 gluten meals in 5 weeks), "Shellfish - everything else is fine" and
 * "Neither dairy nor eggs are ok" all losing the allergy that way. So, in order:
 *   1. fold, join split category names ("shell fish"), strip possessives ("egg's");
 *   2. split into SEGMENTS at punctuation and " - ", then ITEMS at and/or/nor, then CLAUSES at contrast
 *      words ("but", "except", "besides", "unless"…);
 *   3. drop a clause ONLY when it plainly allows a specific food: an allowance phrase, nothing
 *      restrictive in it, no "everything/anything" (the allowance is about the rest, not this food),
 *      and no neither/nor/none anywhere in its segment;
 *   4. from every other clause: the cleaned phrase, plus (allergies only) every allergen word and
 *      every curated food named in it ("strong mushroom allergy" -> "mushroom");
 *   5. never a lone non-food word ("cooked" from "onions unless cooked", "white" from "white or brown
 *      rice", "them" from "I cannot eat them").
 * Anything unclear is kept, so the failure is an over-block, the direction this file chooses.
 * ------------------------------------------------------------------------- */

/** Category names people split or join ("shell fish", "treenuts"): the form the lists use. */
const JOINS: [RegExp, string][] = [
  [/\bshell[\s-]+fish\b/g, "shellfish"],
  [/\bsea[\s-]+food\b/g, "seafood"],
  [/\btree[\s-]*nuts?\b/g, "tree nuts"],
  [/\bpea[\s-]+nuts?\b/g, "peanuts"],
  [/\bground[\s-]+nuts?\b/g, "groundnuts"],
  [/\bsoy[a]?[\s-]+beans?\b/g, "soybeans"],
];

/** Function words and feelings: removed from a phrase so the food in it is what is left. Never a food. */
const TOKEN_NOISE = /\b(i'?m|i've|i'd|i|am|is|are|was|be|been|my|me|myself|we|our|he|she|his|her|they|their|them|it|its|that|this|those|these|to|the|a|an|any|all|of|in|on|at|for|from|with|for|by|as|so|if|no|non|not|never|none|neither|nor|plus|also|just|only|even|still|really|very|extremely|quite|too|please|thanks|thank|you|allergic|allergy|allergies|intolerant|intolerance|sensitive|sensitivity|avoid|avoiding|avoids|cant|can't|cannot|can|could|dont|don't|doesn't|does|do|did|isn't|aren't|won't|without|contain|contains|containing|eat|eating|eats|have|has|had|get|gets|got|make|makes|made|free|severe|severely|mild|mildly|serious|seriously|strong|bad|badly|deadly|life|threatening|anaphylactic|anaphylaxis|reaction|reactions|react|reacts|sick|ill|hives|rash|swell|swelling|barely|hardly|poorly|tolerate|tolerates|like|likes|love|loves|hate|hates|dislike|dislikes|fan|stand|fond|enjoy|adore|fine|ok|okay|alright|safe|good|great|everything|anything|everyone|whatever|nothing|else|other|others|food|foods|thing|things|stuff|kind|kinds|type|types|products|product|one|ones|son|daughter|kid|kids|child|children|wife|husband|partner|family|disease)\b/g;
/** Words that are real but are not foods on their own: dropped when a clause leaves nothing else. */
const LONE_STOP = new Set([
  "cooked", "raw", "baked", "roasted", "fried", "grilled", "steamed", "boiled", "fresh", "frozen", "canned",
  "dried", "whole", "black", "white", "green", "red", "brown", "yellow", "purple", "small", "large", "big",
  "time", "times", "day", "days", "lot", "much", "many", "some", "form", "forms", "amount", "amounts",
  "trace", "traces", "yes", "yeah",
]);

const SEGMENT_SPLIT = /[,;\n\r.!?()[\]{}|:]|\s+[-–—]+\s+|^\s*[-–—]+|[-–—]+\s*$/;
const ITEM_SPLIT = /\b(?:and|or|nor|plus|also)\b|[&+/]/;
/** A contrast word starts a new clause: "nuts but fine with almonds", "everything except peanuts". */
const CONTRAST = /\b(?:but|except for|except|with the exception of|besides|excluding|aside from|apart from|other than|save for|though|although|however|unless)\b/;
/** A clause that says a specific food is ALLOWED: "fine with almonds", "almonds are fine", "I love fish". */
const ALLOWS = /\b(?:(?:is|are|'s|'re)\s+(?:fine|ok|okay|alright|safe|good)|(?:fine|ok|okay|alright|good)\s+with|can\s+(?:have|eat|tolerate)|no problem with|not\s+(?:allergic|intolerant|sensitive)|love|like|enjoy|adore|(?:eat|have)\b.*\b(?:all the time|every day|daily|regularly|often|no problem))\b/;
const ALLOWS_ALL = new RegExp(ALLOWS.source, "g");
/** Anything restrictive in the clause keeps it: dropping an allergy is the failure that hurts. */
const RESTRICTS = /\b(?:allerg\w*|intoleran\w*|sensitiv\w*|avoid\w*|no|not|never|none|nothing|neither|nor|cant|can't|cannot|don't|dont|doesn't|isn't|aren't|won't|without|free|anaphyla\w*|react\w*|coeliac|celiac|barely|hardly|poorly|badly|sick|ill|hives|rash|swell\w*|vomit\w*)\b/;
/** "everything is fine", "I can eat anything": the allowance is about the REST, not the food beside it. */
const GLOBAL = /\b(?:everything|anything|whatever|all foods?|all else|all other|any food|the rest)\b/;
/** neither/nor/none distribute over a whole list ("Neither dairy nor eggs are ok"). */
const SEGMENT_NEGATION = /\b(?:neither|nor|none)\b/;

/** Words that are allergens or name one (keys, and every single-word term) — what a phrase is mined for. */
const ALLERGEN_WORDS = [...new Set([...Object.keys(CATEGORY_TERMS), ...Object.values(CATEGORY_TERMS).flat()].filter((t) => !t.includes(" ")))];
const isAllergenWord = (w: string) => w.length >= 3 && ALLERGEN_WORDS.some((t) => termMatchesWord(w, t));
/** The curated foods, so a phrase is mined for foods that are not allergen categories ("avocado -
 *  life threatening", "mushrooms make me sick" blocked nothing). Single-word names match as words,
 *  multi-word names ("cottage cheese") as phrases. */
const CURATED = Object.values(INGREDIENTS).map((i) => i.name.toLowerCase());
const CURATED_WORDS = CURATED.filter((n) => !/[\s-]/.test(n));
const CURATED_PHRASES = CURATED.filter((n) => /[\s-]/.test(n)).map((n) => n.replace(/-/g, " "));
const isCuratedWord = (w: string) => w.length >= 3 && CURATED_WORDS.some((n) => termMatchesWord(w, n));
/** The food a phrase is made OF is the allergen, not the form it comes in: "peanut butter" is a
 *  peanut allergy, not a dairy one; "oat milk" names no allergen. A carrier counts only when no food
 *  word modifies it ("cow's milk" is still milk, and so is the cheese in "cottage cheese"). */
const CARRIERS = new Set(["butter", "milk", "cream", "flour", "sauce", "oil", "powder", "paste", "dressing", "cheese", "yogurt", "yoghurt", "noodle", "noodles", "bread", "pasta", "tortilla", "tortillas", "wrap", "wraps", "cracker", "crackers"]);
const PLANT_MODIFIERS = new Set(["coconut", "oat", "oats", "rice", "hemp", "pea", "cocoa", "plant", "vegan", "chickpea", "olive", "sunflower", "rapeseed", "canola", "lentil", "gluten", "dairy"]);
/** The category words a DISLIKE is mined for: only the long-standing ones, so a dislike of "shrimp
 *  paste" or "goat cheese" stays that food, not every shrimp or cheese dish. */
const DISLIKE_KEYS = ["nut", "nuts", "tree nut", "tree nuts", "dairy", "lactose", "milk", "gluten", "wheat", "shellfish", "fish", "seafood", "soy", "sesame", "pork", "egg", "eggs"];

function clauseTokens(clause: string, out: Set<string>, allergy: boolean): void {
  const cleaned = clause
    .replace(/-/g, " ") // "dairy-free" -> "dairy free" -> "dairy"
    .replace(TOKEN_NOISE, " ")
    .replace(/[^a-z' ]/g, " ")
    .replace(/(^|[^a-z])'+|'+(?=[^a-z]|$)/g, "$1 ") // stray quotes, not the one in "cow's"
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return;
  const words = cleaned.split(" ");
  if (words.length > 1 || (cleaned.length >= 3 && !LONE_STOP.has(cleaned))) out.add(cleaned);
  if (words.length === 1) return;
  // A phrase may contain a multi-word category ("tree nuts" inside "all tree nuts raw")…
  for (const key of Object.keys(CATEGORY_TERMS))
    if (key.includes(" ") && ` ${cleaned} `.includes(` ${key} `)) out.add(key);
  if (!allergy) {
    for (const key of DISLIKE_KEYS) if (words.includes(key)) out.add(key);
    return;
  }
  // …the allergens it names ("severe peanut" -> "peanut", "peanuts shellfish" -> both)…
  words.forEach((w, i) => {
    if (!isAllergenWord(w) && !isCuratedWord(w)) return;
    const prev = words[i - 1];
    if (CARRIERS.has(w) && prev && (isAllergenWord(prev) || PLANT_MODIFIERS.has(prev))) return;
    out.add(w);
  });
  // …and the curated foods spelled as phrases ("bad reaction to cottage cheese").
  for (const p of CURATED_PHRASES) if (` ${cleaned} `.includes(` ${p} `)) out.add(p);
}

function textTokens(text: string, out: Set<string>, allergy: boolean): void {
  let raw = fold(text);
  for (const [re, to] of JOINS) raw = raw.replace(re, to);
  for (const segment of raw.split(SEGMENT_SPLIT)) {
    if (!segment?.trim()) continue;
    const negated = SEGMENT_NEGATION.test(segment);
    for (const item of segment.split(ITEM_SPLIT)) {
      if (!item?.trim()) continue;
      for (const clause of item.split(CONTRAST)) {
        if (!clause?.trim()) continue;
        const allows =
          !negated && ALLOWS.test(clause) && !GLOBAL.test(clause) && !RESTRICTS.test(clause.replace(ALLOWS_ALL, " "));
        if (allows) continue;
        clauseTokens(clause.replace(/\b([a-z]+)'s\b/g, "$1"), out, allergy); // "egg's" -> "egg"
      }
    }
  }
}

/**
 * Parse the profile's free-text allergies and dislikes into tokens (see the section comment above).
 * The two are read the same way except that only ALLERGIES are mined for every food a phrase names:
 * an allergy over-blocks on purpose, a dislike of "goat cheese" should not remove every cheese.
 */
export function parseExclusionTokens(allergies: string, dislikes: string): string[] {
  const out = new Set<string>();
  textTokens(allergies, out, true);
  // TERM_EXCEPTIONS let a DISLIKE of olives keep olive oil (a dislike of olives removed 203 of 501
  // recipes). An ALLERGY keeps the over-block: the compound becomes a token of its own.
  for (const t of [...out]) for (const c of ALLERGY_KEEPS[t] ?? []) out.add(c);
  textTokens(dislikes, out, false);
  return [...out];
}

/** Compounds an exception lets a dislike keep, which an allergy must still block. */
const ALLERGY_KEEPS: Record<string, string[]> = {
  olive: ["olive oil"], olives: ["olive oil"],
  pepper: ["black pepper", "white pepper"], peppers: ["black pepper", "white pepper"],
};

/* ------------------------------------------------------------------------- *
 * Data integrity: does a recipe's dietTags actually agree with its ingredients?
 *
 * This matters more than it looks. The engine and the whole test suite decide diet
 * compliance by READING dietTags. A wrong tag therefore passes every invariant while the
 * user eats something they must not. A "gluten_free" tagine served over couscous shipped
 * exactly that way.
 *
 * These lists are checked against INGREDIENT NAMES only — never the recipe title — because
 * "Chorizo-Style Tofu Tacos" contains no pork.
 * ------------------------------------------------------------------------- */

/** Ingredient names containing gluten. Substring match against the ingredient name, so "bread" also
 *  covers "flatbread" here; "malt" is spelled out because a bare substring would catch maltodextrin. */
const GLUTEN_INGREDIENTS = [...GLUTEN_SHARED, "malted", "malt vinegar", "malt extract"];

/**
 * These CONTAIN a gluten word but are gluten-free in reality. Without them the checker
 * flags corn tortillas and chickpea flour, which are perfectly safe for a coeliac.
 * (granola/muesli/soy sauce stay flagged: commercial versions normally contain wheat, and
 * for an allergy the conservative direction is the correct one.) An ingredient that SAYS it is
 * gluten-free ("gluten-free sausage") is taken at its word.
 */
const GLUTEN_FREE_EXCEPTIONS = [
  "corn tortilla", "chickpea flour", "oat flour", "rice flour", "rice noodle", "zucchini noodle", "rice cracker", "egg muffin",
  "pizza sauce", "gluten-free", "gluten free",
];

export function ingredientHasGluten(ingredientName: string): boolean {
  const n = ingredientName.trim().toLowerCase();
  if (GLUTEN_FREE_EXCEPTIONS.some((e) => n.includes(e))) return false;
  return GLUTEN_INGREDIENTS.some((g) => n.includes(g));
}

/** Substring matches. Every one also makes a dish non-vegan (NON_VEGAN includes this list). */
const NON_VEGETARIAN = [
  "chicken", "beef", "pork", "turkey", "salmon", "tuna", "cod", "shrimp", "prawn", "mackerel", "trout",
  "sausage", "steak", "bacon", "anchov", "gelatin", "chorizo", "pepperoni", "prosciutto", "salami",
  "pancetta", "venison", "lobster", "calamari", "octopus", "mussel", "scallop", "fish", "sardine",
  "haddock", "pollock", "tilapia", "halibut", "herring", "snapper", "sea bass", "seabass",
  "worcestershire", "caesar dressing", "bone broth",
];
/** Short words that hide inside others ("ham" in "graham", "lard" in "collard"), so whole words only. */
const NON_VEGETARIAN_WORDS = ["ham", "lamb", "lard", "veal", "duck", "crab", "clam", "squid", "oyster"];
/** Plant foods that a non-vegetarian word appears in. */
const VEGETARIAN_EXCEPTIONS = [
  "oyster mushroom", "lamb's lettuce", "lambs lettuce", "vegan ", "vegetarian ", "plant-based ", "soy chorizo", "duck sauce",
];

const NON_VEGAN = [
  ...NON_VEGETARIAN,
  "milk", "cheese", "yogurt", "yoghurt", "butter", "cream", "feta", "mozzarella", "cheddar", "parmesan",
  "ricotta", "halloumi", "honey", "egg", "protein powder", "ice cream", "ghee", "whey", "pesto",
  "mayonnaise", "mayo", "buttermilk", "paneer", "kefir", "skyr", "labneh", "custard", "meringue",
  "tikka masala sauce", "buffalo sauce", "aioli", "brie", "gouda", "mascarpone", "creme fraiche",
];
/** Contain a NON_VEGAN word but are plant foods. Without these, peanut butter reads as dairy. */
// "protein powder" is in NON_VEGAN because the plain kind is whey. A PLANT protein powder is not,
// the same way "peanut butter" is fine though "butter" is not — the qualifier flips it back.
// "eggplant" contains the substring "egg" and is a vegetable. This is the same trap the
// ALLERGEN path fixed with word-aware matching (see the header note: dislikes "egg" matched
// "eggplant"); the diet-tag path still matches on raw substrings, so it needs the exception
// listed explicitly. Without it a vegan aubergine dish is reported as containing egg.
// An ingredient that names itself vegan ("vegan pesto") is taken at its word.
const VEGAN_EXCEPTIONS = [
  "peanut butter", "almond butter", "nut butter", "cocoa butter",
  "soy protein powder", "pea protein powder", "plant protein powder",
  "eggplant", "oyster mushroom", "lamb's lettuce", "lambs lettuce", "vegan ", "plant-based ",
  "veggie", "honeydew", "butternut", "soy chorizo", "duck sauce",
];

const hasWord = (name: string, w: string) => new RegExp(`(^|[^a-z])${w}(s|es)?([^a-z]|$)`).test(name);
const nonVegetarian = (n: string) =>
  !VEGETARIAN_EXCEPTIONS.some((x) => n.includes(x)) &&
  (NON_VEGETARIAN.some((x) => n.includes(x)) || NON_VEGETARIAN_WORDS.some((w) => hasWord(n, w)));

/** Returns the ingredient names that contradict `tag`, or [] if the tag is honest. */
export function dietTagConflicts(tag: string, ingredientNames: string[]): string[] {
  const names = ingredientNames.map((n) => n.trim().toLowerCase());
  if (tag === "gluten_free") return names.filter(ingredientHasGluten);
  if (tag === "vegan")
    return names.filter(
      (n) =>
        !VEGAN_EXCEPTIONS.some((x) => n.includes(x)) &&
        (NON_VEGAN.some((x) => n.includes(x)) || NON_VEGETARIAN_WORDS.some((w) => hasWord(n, w))),
    );
  if (tag === "vegetarian") return names.filter(nonVegetarian);
  return [];
}
