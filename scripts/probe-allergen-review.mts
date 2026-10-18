/**
 * Where each finding of the 2026-10-18 allergen review stands on THIS tree.
 *
 *   npm run probe:allergens
 *
 * For each fact the review reproduced, this prints the allergies one `remember` stores, unlabelled and
 * labelled `allergy`, and how many library recipes those allergies block. docs/v1/allergen-review.md's
 * status tables are this output; re-run it before trusting a row older than the last allergen commit.
 * It reads the engine only through the barrels and changes nothing.
 */
import { applyPrimitives, type PrimitiveOp } from "@/lib/assistant";
import { RECIPES, rebalanceWeek, selectWeekFromDb, withSeed } from "@/lib/plan";
import { haystackBlocked, parseExclusionTokens } from "@/lib/nutrition";
import type { UserProfile } from "@/lib/core";

const BASE = {
  goal: "maintain", diet: "none", allergies: "", dislikes: "", budget: "medium", mealsPerDay: 3, targetCalories: 2000,
  proteinGrams: 150, carbsGrams: 200, fatGrams: 65, maxCookTime: 30, maxIngredients: 8,
} as UserProfile;

/** [finding, fact, what the review expected: "nothing" (an over-block) or the allergen that must bind] */
const FACTS: [string, string, string][] = [
  ["OVER-1", "Not lactose intolerant, drinks milk every day", "nothing"],
  ["OVER-2", "No allergies; eats dairy and gluten", "nothing"],
  ["OVER-3", "allergic to cats but loves fish", "nothing"],
  ["OVER-3", "my sister is allergic to eggs but I eat them daily", "nothing for the user"],
  ["OVER-4", "allergic to essential oils", "nothing"],
  ["OVER-5", "I was allergic to milk as a child but grew out of it", "nothing"],
  ["OVER-6", "my coeliac friend visits on Saturday", "decision 12"],
  ["OVER-7", "intolerant to spice", "nothing"],
  ["UNDO-1", "sorry, not lactose intolerant, I meant gluten intolerant", "gluten only"],
  ["U1", "allergic to shellfish", "shellfish (and an imported prawn dish re-picked: C)"],
  ["U2", "can't have dairy", "dairy"],
  ["U3", "food intolerances: lactose", "lactose"],
  ["U4", "allergic to crustaceans", "shellfish"],
  ["U5", "lactose intolerent", "lactose"],
  ["U6", "Allergic to peanuts. Also allergic to sesame.", "peanuts, sesame"],
  ["U7", "egg-allergic toddler", "eggs"],
  ["U7", "allergic to the following: peanuts", "peanuts"],
  ["U9", "I love prawns but I'm allergic to them", "shellfish"],
  ["U10", "allergic to satay", "peanuts"],
  ["U10", "allergic to hummus", "sesame"],
  ["U11", "allergic to legumes", "legumes"],
  ["U12", "has coeliac disease", "gluten (oats: decision 11)"],
  ["LC-04", "not allergic to eggs any more", "nothing"],
  ["LC-08", "allergic to hazelnuts", "hazelnuts"],
];

const week = withSeed(2, () => rebalanceWeek(selectWeekFromDb(BASE), BASE));
const blocks = (allergies: string) => {
  const tokens = parseExclusionTokens(allergies, "");
  return tokens.length ? RECIPES.filter((r) => haystackBlocked(`${r.name} ${r.ingredients.map((i) => i.name).join(" ")}`, tokens)).length : 0;
};
const stored = (fact: string, kind?: string) =>
  applyPrimitives(BASE, week, [{ op: "remember", fact, ...(kind ? { kind } : {}) } as PrimitiveOp]).profile.allergies ?? "";

console.log(`library: ${RECIPES.length} recipes. "(n)" = recipes the stored allergies block.\n`);
for (const [id, fact, expected] of FACTS) {
  const none = stored(fact);
  const labelled = stored(fact, "allergy");
  console.log(`${id.padEnd(7)} ${JSON.stringify(fact).padEnd(60)} unlabelled ${JSON.stringify(none)} (${blocks(none)}) · labelled ${JSON.stringify(labelled)} (${blocks(labelled)}) · expected: ${expected}`);
}
