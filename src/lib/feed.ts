/**
 * Phase 3 — the in-app feed.
 *
 * A browsable, filterable wall of the whole recipe library, each card a plan-ready Meal with an
 * "Add to plan" button. It reuses the SAME macro-validated recipes the planner draws from (so every
 * card's numbers are real, not hand-typed) and the SAME slot-placement logic the importer uses.
 * Deterministic and offline — no model, no network, no cost.
 */
import { RECIPES, recipeToMeal, type DietTag } from "./recipeDb";
import { imageForMeal, gradientForMeal } from "./recipes";
import type { Meal } from "./types";

export interface FeedItem {
  meal: Meal;
  image: string | null; // a bundled photo when a keyword matches; null -> use the gradient
  gradient: string; // deterministic fallback tile, so a card is never blank
  dietTags: DietTag[];
}

// Every library recipe as a feed card, MINUS treat-only dishes (a discovery feed shouldn't push
// burgers and pizza at someone — those stay reachable only when asked for by name, the cheat flow).
export const FEED_RECIPES: FeedItem[] = RECIPES.filter((r) => !r.treatOnly).map((r) => ({
  meal: recipeToMeal(r),
  image: imageForMeal(r.name),
  gradient: gradientForMeal(r.name),
  dietTags: r.dietTags,
}));

export type FeedMealType = Meal["type"] | "all";
export type FeedDiet = DietTag | "all";

export interface FeedFilter {
  mealType: FeedMealType;
  diet: FeedDiet;
  highProtein: boolean;
  maxTime: number | null; // minutes; null = any
  query: string; // free text over name + ingredients; "" = no text filter
}

// "High protein" as an absolute floor, not a ratio — someone filtering for it wants a meal that
// actually delivers, and a 200 kcal snack at 40% protein still only has 20 g.
export const HIGH_PROTEIN_G = 25;

/** Every whitespace-separated term must match a WORD in the name or an ingredient (AND), so
 *  "chicken rice" finds dishes with both. Matched at word STARTS (so "chick" still finds "chicken")
 *  rather than anywhere in the string — a plain substring made "oat" hit "goat cheese" and "ham" hit
 *  "graham", the same over-match the allergen path abandoned. */
function matchesQuery(it: FeedItem, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const words = (it.meal.name + " " + it.meal.ingredients.map((i) => i.name).join(" "))
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return terms.every((t) => words.some((w) => w.startsWith(t)));
}

/** Pure, so it's unit-tested. Narrows the feed by every active facet (AND, not OR). */
export function filterFeed(items: FeedItem[], f: FeedFilter): FeedItem[] {
  return items.filter((it) => {
    if (f.mealType !== "all" && it.meal.type !== f.mealType) return false;
    // A vegan dish satisfies a vegetarian filter (the suite's own dietOk invariant); the tags don't
    // encode that subset, so spell it out rather than silently drop a lone-vegan recipe from the
    // "vegetarian" feed / the agent's diet:"vegetarian" search.
    if (f.diet !== "all" && !it.dietTags.includes(f.diet) && !(f.diet === "vegetarian" && it.dietTags.includes("vegan"))) return false;
    if (f.highProtein && it.meal.proteinGrams < HIGH_PROTEIN_G) return false;
    if (f.maxTime != null && it.meal.timeMinutes > f.maxTime) return false;
    if (!matchesQuery(it, f.query)) return false;
    return true;
  });
}

export type FeedSort = "default" | "protein" | "calories-low" | "time";

/** Sort a filtered feed. "default" keeps library order; the rest are stable, pure re-orderings. */
export function sortFeed(items: FeedItem[], sort: FeedSort): FeedItem[] {
  const copy = items.slice();
  switch (sort) {
    case "protein":
      return copy.sort((a, b) => b.meal.proteinGrams - a.meal.proteinGrams);
    case "calories-low":
      return copy.sort((a, b) => a.meal.calories - b.meal.calories);
    case "time":
      return copy.sort((a, b) => a.meal.timeMinutes - b.meal.timeMinutes);
    default:
      return copy;
  }
}
