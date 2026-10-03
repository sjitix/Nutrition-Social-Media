/**
 * An imported recipe, and the converter that makes it a plan Meal: pure, no network (V1 D5a,
 * 2026-10-03). Both lived in providers/import.ts beside the fetch and the SSRF guard, so the /plan
 * page, which only converts, pulled the network adapter into the browser — a listed debt of the
 * boundary gate. import.ts re-exports both, so every other caller is unchanged.
 */
import type { Meal } from "./types";

export interface ImportedRecipe {
  name: string;
  sourceUrl: string;
  servings: number;
  ingredients: { name: string; quantity: string }[];
  steps: string[];
  timeMinutes?: number;
  // Per-serving, when we could establish them.
  calories?: number;
  proteinGrams?: number;
  carbsGrams?: number;
  fatGrams?: number;
  fiberGrams?: number;
  macrosSource: "site" | "none";
}

/** Turn an imported recipe into a plan Meal for a given slot. Macros are the site's PER-SERVING
 *  values; they default to 0 when the site gave none (the UI flags that), never guessed. */
export function importedToMeal(r: ImportedRecipe, type: Meal["type"]): Meal {
  return {
    type,
    name: r.name,
    description: `Imported from ${new URL(r.sourceUrl).hostname.replace(/^www\./, "")}`,
    sourceUrl: r.sourceUrl,
    calories: r.calories ?? 0,
    proteinGrams: r.proteinGrams ?? 0,
    carbsGrams: r.carbsGrams ?? 0,
    fatGrams: r.fatGrams ?? 0,
    ...(r.fiberGrams != null ? { fiberGrams: r.fiberGrams } : {}),
    timeMinutes: r.timeMinutes ?? 0, // required by the schema; 0 renders as no time badge
    // The ingredient list is the whole batch; the macros are per serving. servings lets any
    // ingredient-derived nutrient math divide correctly.
    ...(r.servings > 1 ? { servings: r.servings } : {}),
    ingredients: r.ingredients,
    steps: r.steps.length ? r.steps : ["See the original recipe for the method."],
  };
}
