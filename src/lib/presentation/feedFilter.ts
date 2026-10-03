/**
 * The feed's filter and sort, CLIENT-SAFE: pure functions over a card, importing only types.
 *
 * Split out of feed.ts in V1 A4 (2026-10-03). feed.ts builds FEED_RECIPES from the engine, so any
 * client component that imported filterFeed from there shipped the whole recipe library (69 kB
 * gzipped) and the USDA table with it — Explore did. Now Explore's server page builds the cards and
 * passes them in as props, and the browser imports only this file. feed.ts re-exports everything
 * here, so the assistant's find_recipes and the test suite import exactly what they did before.
 */
import type { DietTag } from "../data";
import type { Meal } from "../core";

export interface FeedItem {
  meal: Meal;
  image: string | null; // a bundled photo when a keyword matches; null -> use the gradient
  gradient: string; // deterministic fallback tile, so a card is never blank
  dietTags: DietTag[];
}

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
