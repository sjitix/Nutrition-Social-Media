import { FEED_RECIPES } from "@/lib/presentation";

/**
 * Every Explore recipe's quantities and method, by dish name, as ONE static JSON file.
 *
 * The cards on /sage/explore carry what the wall and its search need (names, macros, ingredient NAMES) and no
 * longer the quantities and steps: those were about half the page's data, in its HTML on every visit, for a modal
 * most visits never open (2026-10-29: 92 kB gzipped at 582 recipes, growing with each one). RecipeModal fetches this
 * file the first time a recipe is opened and keeps it.
 *
 * `force-static`: it is computed at build from the same FEED_RECIPES the page renders, so it can never describe a
 * different library, and the static export (GitHub Pages, no server) writes it out as a plain file.
 */
export const dynamic = "force-static";

export function GET() {
  return Response.json(
    Object.fromEntries(
      FEED_RECIPES.map((c) => [c.meal.name, { ingredients: c.meal.ingredients.map(({ name, quantity }) => ({ name, quantity })), steps: c.meal.steps }]),
    ),
  );
}
