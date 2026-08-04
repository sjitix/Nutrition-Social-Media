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
}

// "High protein" as an absolute floor, not a ratio — someone filtering for it wants a meal that
// actually delivers, and a 200 kcal snack at 40% protein still only has 20 g.
export const HIGH_PROTEIN_G = 25;

/** Pure, so it's unit-tested. Narrows the feed by every active facet (AND, not OR). */
export function filterFeed(items: FeedItem[], f: FeedFilter): FeedItem[] {
  return items.filter((it) => {
    if (f.mealType !== "all" && it.meal.type !== f.mealType) return false;
    if (f.diet !== "all" && !it.dietTags.includes(f.diet)) return false;
    if (f.highProtein && it.meal.proteinGrams < HIGH_PROTEIN_G) return false;
    if (f.maxTime != null && it.meal.timeMinutes > f.maxTime) return false;
    return true;
  });
}
