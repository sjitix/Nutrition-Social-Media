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
  return wordMatches(word, term) || (word.length >= 3 && wordMatches(term, word));
}

/**
 * A term that also names a food it does NOT mean. Peanut butter, almond butter and cocoa butter are
 * not dairy, and soy or pea protein powder is not whey. The "dairy"/"lactose" categories list the bare
 * word "butter", which would otherwise strip every nut butter from a lactose-intolerant user's plan.
 * The diet path already knew this (VEGAN_EXCEPTIONS); the allergen path did not.
 */
const TERM_EXCEPTIONS: Record<string, string[]> = {
  butter: ["peanut butter", "almond butter", "cocoa butter", "nut butter", "cashew butter"],
  "protein powder": ["soy protein powder", "pea protein powder", "plant protein powder"],
};

/**
 * "toast" and "wrap" are gluten foods and also cooking verbs: "toast the cumin", "wrap in foil".
 * Read as foods, they blocked nine recipes with no gluten in them for every coeliac. One of these
 * words counts as the food unless it is inflected as a verb ("toasted", "wrapping") or followed by
 * the word a verb takes ("toast the…", "wrap in…"). A recipe that toasts or wraps a gluten food
 * names that food, and the food itself still blocks it.
 */
const VERB_NOUNS = new Set(["toast", "wrap"]);
const VERB_FOLLOWERS = new Set(["the", "a", "an", "in", "until", "for", "lightly", "briefly", "gently", "over", "them", "it", "each", "both", "tightly", "up", "under"]);

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
  for (const token of tokens) {
    for (const term of expandExclusion(token)) {
      const exceptions = TERM_EXCEPTIONS[term];
      const text = exceptions ? exceptions.reduce((acc, ex) => acc.split(ex).join(" "), hay) : hay;
      if (term.includes(" ")) {
        if (text.includes(term)) return true; // phrase
      } else if (VERB_NOUNS.has(term)) {
        for (let i = 0; i < words.length; i++)
          if ((words[i] === term || words[i] === term + "s") && !VERB_FOLLOWERS.has(words[i + 1] ?? "")) return true;
      } else if ((exceptions ? text.split(/[^a-z]+/) : words).some((w) => termMatchesWord(w, term))) {
        return true;
      }
    }
  }
  return false;
}

/** Filler that means nothing on its own but wraps what people actually type. */
const TOKEN_NOISE = /\b(i'?m|i|am|is|are|my|allergic|allergy|allergies|to|the|a|an|any|all|of|no|non|not|never|plus|also|avoid|avoiding|cant|can't|cannot|dont|don't|eat|have|intolerant|intolerance|sensitive|free|severe|severely|mild|mildly|serious|seriously|very|really|extremely|deadly|anaphylactic|anaphylaxis|reaction|reactions|please)\b/g;

/** Splits a list into items: punctuation, line breaks, and the words people join a list with. */
const LIST_SEPARATORS = /[,;/\n\r.!?()[\]{}|:&+]|\b(?:and|or|nor|plus|also)\b/;
/** A contrast word starts a new clause: "nuts but fine with almonds", "fine with almonds but not peanuts". */
const CONTRAST = /\b(?:but|except|though|although|however|unless|apart from|other than)\b/;
/** A clause that says a food is ALLOWED: "fine with almonds", "almonds are fine", "I can eat almonds". */
const ALLOWS = /\b(?:(?:is|are|'s|'re)\s+(?:fine|ok|okay|alright|safe)|(?:fine|ok|okay|alright)\s+with|can\s+(?:have|eat|tolerate)|tolerate|no problem with|not\s+(?:allergic|intolerant|sensitive))\b/;
const ALLOWS_ALL = new RegExp(ALLOWS.source, "g");
/** A clause that RESTRICTS a food. A clause doing both is kept: dropping an allergy is what hurts. */
const RESTRICTS = /\b(?:allerg\w*|intoleran\w*|sensitive|avoid\w*|no|not|never|cant|can't|cannot|don't|dont|free|anaphyla\w*|react\w*|coeliac|celiac)\b/;

/** Words that are allergens or name one (keys, and every single-word term) — what a phrase is mined for. */
const ALLERGEN_WORDS = [...new Set([...Object.keys(CATEGORY_TERMS), ...Object.values(CATEGORY_TERMS).flat()].filter((t) => !t.includes(" ")))];
const isAllergenWord = (w: string) => w.length >= 3 && ALLERGEN_WORDS.some((t) => termMatchesWord(w, t));
/** The food a phrase is made OF is the allergen, not the form it comes in: "peanut butter" is a
 *  peanut allergy, not a dairy one; "oat milk" names no allergen. A carrier counts only when no food
 *  word modifies it ("cow's milk" is still milk). */
const CARRIERS = new Set(["butter", "milk", "cream", "flour", "sauce", "oil", "powder", "paste", "dressing", "cheese", "yogurt", "yoghurt", "noodle", "noodles", "bread", "pasta", "tortilla", "tortillas", "wrap", "wraps", "cracker", "crackers"]);
const PLANT_MODIFIERS = new Set(["coconut", "oat", "oats", "rice", "hemp", "pea", "cocoa", "plant", "vegan", "corn", "chickpea", "olive", "sunflower", "rapeseed", "canola", "vegetable", "cottage", "potato", "lentil", "gluten", "dairy"]);

/**
 * Parse the profile's free-text allergies/dislikes into tokens.
 *
 * People do not type "nuts, shellfish". They type "allergic to nuts and shellfish". The old
 * comma-only split turned that into ONE token that matched no ingredient anywhere, so the user's
 * allergies were silently ignored — the most dangerous possible failure, and a silent one.
 *
 * The same failure hid in every other ordinary way of typing an allergy, found by a property sweep
 * (2026-10-03, D5b): "peanuts." kept its full stop, "I’m allergic…" kept its curly apostrophe, a line
 * break or "or" did not split a list, "severe peanut allergy" left the phrase "severe peanut", and
 * "dairy-free" left "dairy-". Each made a token that matched nothing, with dishes served end to end.
 * So: fold accents and apostrophes, split on every list separator, split each item at a contrast word,
 * drop only a clause that says a food is ALLOWED, and mine a multi-word phrase for the allergens it
 * names ("severe peanut" also yields "peanut").
 *
 * Tokens shorter than 3 characters are dropped: a stray "a" would otherwise match every recipe
 * and empty the entire plan.
 */
export function parseExclusionTokens(allergies: string, dislikes: string): string[] {
  const raw = fold([allergies, dislikes].join(","));
  const out = new Set<string>();
  for (const piece of raw.split(LIST_SEPARATORS)) {
    if (!piece) continue;
    // A CONTRAST word starts a new clause, and EVERY clause is read. The first version kept only the
    // clause before the contrast word, which made "peanuts but fine with almonds" work and dropped the
    // allergy in "fine with almonds but allergic to peanuts" — the planner then served peanut dishes
    // seven times in five weeks (found by the D5b sweep, the same day). Only a clause that ALLOWS a
    // food, and says nothing restrictive, is dropped; anything unclear is kept, so the failure is an
    // over-block, the direction this file chooses everywhere.
    for (const clause of piece.split(CONTRAST)) {
      if (!clause) continue;
      if (ALLOWS.test(clause) && !RESTRICTS.test(clause.replace(ALLOWS_ALL, " "))) continue;
      const cleaned = clause
        .replace(/-/g, " ") // "dairy-free" -> "dairy free" -> "dairy"
        .replace(TOKEN_NOISE, " ")
        .replace(/[^a-z' ]/g, " ")
        .replace(/(^|[^a-z])'+|'+(?=[^a-z]|$)/g, "$1 ") // quotes around a word, not the one in "cow's"
        .replace(/\s+/g, " ")
        .trim();
      if (cleaned.length >= 3) out.add(cleaned);
      if (!cleaned.includes(" ")) continue;
      // A phrase may contain a multi-word category ("tree nuts" inside "all tree nuts raw")…
      for (const key of Object.keys(CATEGORY_TERMS))
        if (key.includes(" ") && ` ${cleaned} `.includes(` ${key} `)) out.add(key);
      // …and the allergens it names: "severe peanut" -> "peanut", "peanuts shellfish" -> both.
      const words = cleaned.split(" ");
      words.forEach((w, i) => {
        if (!isAllergenWord(w)) return;
        const prev = words[i - 1];
        if (CARRIERS.has(w) && prev && (isAllergenWord(prev) || PLANT_MODIFIERS.has(prev))) return;
        out.add(w);
      });
    }
  }
  return [...out];
}

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
const GLUTEN_FREE_EXCEPTIONS = ["corn tortillas", "chickpea flour", "oat flour", "rice noodles", "rice cracker", "gluten-free", "gluten free"];

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
const VEGETARIAN_EXCEPTIONS = ["oyster mushroom", "lamb's lettuce", "lambs lettuce", "vegan ", "vegetarian ", "plant-based "];

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
