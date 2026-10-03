/**
 * Phase 3 — the in-app feed.
 *
 * A browsable, filterable wall of the whole recipe library, each card a plan-ready Meal with an
 * "Add to plan" button. It reuses the SAME macro-validated recipes the planner draws from (so every
 * card's numbers are real, not hand-typed) and the SAME slot-placement logic the importer uses.
 * Deterministic and offline — no model, no network, no cost.
 */
import { RECIPES, recipeToMeal } from "./recipeDb";
import { imageForMeal, gradientForMeal } from "./recipes";
import type { FeedItem } from "./feedFilter";

// The client-safe half (the card type, filterFeed, sortFeed) lives in ./feedFilter. Re-exported so
// every importer of @/lib/feed is unchanged. A CLIENT component must import ./feedFilter instead —
// this file builds FEED_RECIPES from the engine, and check:boundaries rule 4 fails the other way.
export * from "./feedFilter";

// Every library recipe as a feed card, MINUS treat-only dishes (a discovery feed shouldn't push
// burgers and pizza at someone — those stay reachable only when asked for by name, the cheat flow).
export const FEED_RECIPES: FeedItem[] = RECIPES.filter((r) => !r.treatOnly).map((r) => ({
  meal: recipeToMeal(r),
  image: imageForMeal(r.name),
  gradient: gradientForMeal(r.name),
  dietTags: r.dietTags,
}));
