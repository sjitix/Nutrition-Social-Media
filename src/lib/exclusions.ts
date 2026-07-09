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
 */

/** Category token -> the concrete foods it must also block. */
const CATEGORY_TERMS: Record<string, string[]> = {
  nut: ["almond", "walnut", "pecan", "cashew", "hazelnut", "pistachio", "macadamia", "peanut", "nut"],
  nuts: ["almond", "walnut", "pecan", "cashew", "hazelnut", "pistachio", "macadamia", "peanut", "nut"],
  "tree nut": ["almond", "walnut", "pecan", "cashew", "hazelnut", "pistachio", "macadamia"],
  "tree nuts": ["almond", "walnut", "pecan", "cashew", "hazelnut", "pistachio", "macadamia"],

  dairy: ["milk", "cheese", "yogurt", "butter", "cream", "feta", "mozzarella", "cheddar", "parmesan", "ricotta", "halloumi", "dairy"],
  lactose: ["milk", "cheese", "yogurt", "butter", "cream", "feta", "mozzarella", "cheddar", "parmesan", "ricotta", "halloumi"],

  gluten: ["bread", "pasta", "couscous", "bulgur", "orzo", "panko", "spaghetti", "penne", "noodle", "noodles", "bagel", "wrap", "tortilla", "flour", "muesli", "granola", "soy sauce", "wheat", "toast", "bun"],
  wheat: ["bread", "pasta", "couscous", "bulgur", "orzo", "panko", "spaghetti", "penne", "bagel", "wrap", "tortilla", "flour", "wheat", "toast", "bun"],

  shellfish: ["shrimp", "prawn", "prawns", "crab", "lobster"],
  fish: ["salmon", "tuna", "cod", "mackerel", "trout", "anchovy", "fish"],
  seafood: ["salmon", "tuna", "cod", "mackerel", "trout", "shrimp", "prawn", "prawns", "fish"],

  soy: ["tofu", "tempeh", "edamame", "soy", "miso", "soy sauce"],
  sesame: ["sesame", "tahini"],
  pork: ["pork", "bacon", "chorizo", "sausage", "ham"],
  eggs: ["egg", "eggs"],
};

/** Suffixes that still mean "the same food/verb": almond->almonds, bake->baked/baking. */
function wordMatches(word: string, term: string): boolean {
  if (word === term) return true;
  if (word.startsWith(term)) {
    const suffix = word.slice(term.length);
    if (["s", "es", "d", "ed", "ing", "y"].includes(suffix)) return true;
  }
  // bake -> baking (drop the trailing 'e' before -ing)
  if (term.endsWith("e") && word === term.slice(0, -1) + "ing") return true;
  return false;
}

/** Expand a user token into every term it should block. */
export function expandExclusion(token: string): string[] {
  const t = token.trim().toLowerCase();
  return CATEGORY_TERMS[t] ?? [t];
}

/**
 * Does `haystack` (a recipe's name + ingredients + steps) contain an excluded term?
 * Multi-word terms ("soy sauce") are matched as phrases; single words are matched on word
 * boundaries with light plural/verb stemming, so "egg" never blocks "eggplant".
 */
export function haystackBlocked(haystack: string, tokens: string[]): boolean {
  if (!tokens.length) return false;
  const hay = haystack.toLowerCase();
  const words = hay.split(/[^a-z]+/).filter(Boolean);
  for (const token of tokens) {
    for (const term of expandExclusion(token)) {
      if (term.includes(" ")) {
        if (hay.includes(term)) return true; // phrase
      } else if (words.some((w) => wordMatches(w, term))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Parse the profile's free-text allergies/dislikes into tokens.
 * Tokens shorter than 3 characters are dropped: a stray "a" would otherwise match every
 * recipe and silently empty the entire plan.
 */
export function parseExclusionTokens(allergies: string, dislikes: string): string[] {
  return [allergies, dislikes]
    .join(",")
    .toLowerCase()
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length >= 3);
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

/** Ingredient names containing gluten. Substring match against the ingredient name. */
const GLUTEN_INGREDIENTS = [
  "bread", "pasta", "couscous", "bulgur", "orzo", "spaghetti", "penne", "panko", "bagel",
  "tortilla", "wrap", "soy sauce", "muesli", "granola", "noodles", "toast", "bun", "wheat",
  "flour", "pizza base",
];

/**
 * These CONTAIN a gluten word but are gluten-free in reality. Without them the checker
 * flags corn tortillas and chickpea flour, which are perfectly safe for a coeliac.
 * (granola/muesli/soy sauce stay flagged: commercial versions normally contain wheat, and
 * for an allergy the conservative direction is the correct one.)
 */
const GLUTEN_FREE_EXCEPTIONS = ["corn tortillas", "chickpea flour", "oat flour", "rice noodles"];

export function ingredientHasGluten(ingredientName: string): boolean {
  const n = ingredientName.trim().toLowerCase();
  if (GLUTEN_FREE_EXCEPTIONS.some((e) => n.includes(e))) return false;
  return GLUTEN_INGREDIENTS.some((g) => n.includes(g));
}

const NON_VEGAN = [
  "milk", "cheese", "yogurt", "butter", "cream", "feta", "mozzarella", "cheddar", "parmesan",
  "ricotta", "halloumi", "honey", "egg", "chicken", "beef", "pork", "turkey", "salmon", "tuna",
  "cod", "shrimp", "prawns", "mackerel", "trout", "sausage", "steak", "bacon", "protein powder",
  "ice cream",
];
/** Contain a NON_VEGAN word but are plant foods. Without these, peanut butter reads as dairy. */
const VEGAN_EXCEPTIONS = ["peanut butter", "almond butter", "nut butter", "cocoa butter"];

const NON_VEGETARIAN = [
  "chicken", "beef", "pork", "turkey", "salmon", "tuna", "cod", "shrimp", "prawns", "mackerel",
  "trout", "sausage", "steak", "bacon", "anchovy", "gelatin",
];

/** Returns the ingredient names that contradict `tag`, or [] if the tag is honest. */
export function dietTagConflicts(tag: string, ingredientNames: string[]): string[] {
  const names = ingredientNames.map((n) => n.trim().toLowerCase());
  if (tag === "gluten_free") return names.filter(ingredientHasGluten);
  if (tag === "vegan")
    return names.filter(
      (n) => !VEGAN_EXCEPTIONS.some((x) => n.includes(x)) && NON_VEGAN.some((x) => n.includes(x)),
    );
  if (tag === "vegetarian") return names.filter((n) => NON_VEGETARIAN.some((x) => n.includes(x)));
  return [];
}
