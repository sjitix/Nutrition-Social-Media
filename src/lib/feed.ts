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
// Cards carry NO ingredient slugs: they are display and search data, no client code reads a slug, and
// across 495 cards they added ~44–53 kB to Explore's HTML — found by the D5 review, after A4 had just
// paid to shrink that page. A card added to a plan without slugs is fine: lookups resolve by name first.
export const FEED_RECIPES: FeedItem[] = RECIPES.filter((r) => !r.treatOnly).map((r) => ({
  meal: { ...recipeToMeal(r), ingredients: r.ingredients.map(({ name, quantity }) => ({ name, quantity })) },
  image: imageForMeal(r.name),
  gradient: gradientForMeal(r.name),
  dietTags: r.dietTags,
}));
