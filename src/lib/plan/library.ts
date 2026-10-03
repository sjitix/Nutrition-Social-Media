/**
 * The library as the engine sees it: every seed with its macros COMPUTED from its ingredients
 * (deriveMacros — macros are never written on a recipe), the Recipe -> Meal projection, and portion
 * scaling of a recipe to a calorie target.
 *
 * Part of the plan engine (src/lib/plan/, layer L3), split out of recipeDb.ts on 2026-10-03 (V1
 * milestone A3). The public surface is ./index.ts; an export here that index.ts does not re-export
 * is internal to this folder, and check:boundaries fails anything outside the folder that imports it.
 */
import { type Meal } from "../types";
import { NUTRIENT_TABLE } from "../nutrientTable.generated";
import { microsForIngredients, gramsFor } from "../nutrients";
import { SEED_RECIPES, type Recipe, type RecipeSeed } from "../data/seeds";
import { tableKey } from "../data/ingredients";

/** Public Recipe -> Meal, for surfaces (the browse feed) that show library recipes as plan-ready. */
export const recipeToMeal = (r: Recipe): Meal => toMeal(r);

// Convert a stored Recipe into the app's Meal shape.
export function toMeal(r: Recipe): Meal {
  return {
    name: r.name,
    type: r.type,
    description: r.description,
    calories: r.calories,
    proteinGrams: r.proteinGrams,
    carbsGrams: r.carbsGrams,
    fatGrams: r.fatGrams,
    fiberGrams: r.fiberGrams,
    timeMinutes: r.timeMinutes,
    servings: r.servings,
    ingredients: r.ingredients,
    steps: r.steps,
  };
}

// --- The library ---------------------------------------------------------
// The seeds and their types live in ./data/seeds. Here they become the library the engine uses:
// each seed's macros computed from its own ingredient list.

/**
 * Add up what the ingredients actually are, per serving, from USDA per-100g values.
 *
 * `gramsFor` knows the unit conventions ("1 tbsp", "70 g dry", "1 can"). An ingredient we cannot
 * price is REFUSED, not skipped (V1 D5b): skipping it quietly understated the dish's calories and
 * every nutrient in it, and only check:recipes stood between that and a user. Now the library will
 * not load with one in it — `next build` fails, so it cannot deploy — and the error names the line.
 */
function deriveMacros(r: RecipeSeed, unpriced: string[]): Recipe {
  const servings = Math.max(1, r.servings ?? 1);
  let cal = 0, protein = 0, carbs = 0, fat = 0, fiber = 0;
  for (const i of r.ingredients) {
    const key = tableKey(i); // the one rule (D5): name first, the slug if the name stops resolving
    const per = NUTRIENT_TABLE[key]?.per100g;
    const grams = gramsFor(key, i.quantity);
    if (!per || !grams) {
      unpriced.push(`${r.id}: "${i.name}" ${per ? `can't be weighed from "${i.quantity}"` : "has no USDA entry"}`);
      continue;
    }
    const f = grams / 100;
    cal += (per.cal ?? 0) * f;
    protein += (per.protein ?? 0) * f;
    carbs += (per.carbs ?? 0) * f;
    fat += (per.fat ?? 0) * f;
    fiber += (per.fiber ?? 0) * f;
  }
  return {
    ...r,
    calories: Math.round(cal / servings),
    proteinGrams: Math.round(protein / servings),
    carbsGrams: Math.round(carbs / servings),
    fatGrams: Math.round(fat / servings),
    fiberGrams: Math.round(fiber / servings),
  };
}

/** The library the whole engine uses. Macros come from the food, not from a card. */
export const RECIPES: Recipe[] = (() => {
  const unpriced: string[] = [];
  const recipes = SEED_RECIPES.map((r) => deriveMacros(r, unpriced));
  if (unpriced.length)
    throw new Error(`Recipe library: ${unpriced.length} ingredient(s) cannot be priced, so their dishes would under-report every nutrient:\n  ${unpriced.join("\n  ")}`);
  return recipes;
})();

// Micronutrients per recipe, computed once from the USDA-mapped ingredients.
const microsCache = new Map<string, ReturnType<typeof microsForIngredients>>();

export function recipeMicros(r: Recipe) {
  let m = microsCache.get(r.id);
  if (!m) {
    const raw = microsForIngredients(r.ingredients);
    const per = Math.max(1, r.servings ?? 1);
    m = per === 1
      ? raw
      : { coverage: raw.coverage, micros: Object.fromEntries(Object.entries(raw.micros).map(([k, v]) => [k, v / per])) as typeof raw.micros };
    microsCache.set(r.id, m);
  }
  return m;
}

// Scale a numeric ingredient quantity ("150 g", "1/2 piece") by a factor so the
// recipe's portions match its scaled calories. Best-effort: leaves anything it
// can't parse untouched.
export function scaleQuantity(q: string, f: number): string {
  const m = q.match(/^(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+))?/);
  if (!m) return q;
  const value = (m[2] ? Number(m[1]) / Number(m[2]) : Number(m[1])) * f;
  if (!Number.isFinite(value) || value <= 0) return q;
  const rest = q.slice(m[0].length);
  const isMass = /\b(g|ml|kg|l)\b/i.test(rest);
  let rounded = isMass ? Math.round(value / 5) * 5 : Math.round(value * 2) / 2;
  if (rounded <= 0) rounded = isMass ? 5 : 0.5;
  const num = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${num}${rest}`;
}

// Portion-scale a recipe so its calories/macros hit the per-meal target. This is
// what lets a modest library hit any calorie goal without needing a perfectly
// sized recipe for every target. Factor is clamped so portions stay realistic.
export function scaleRecipeToTarget(r: Recipe, target: number): Recipe {
  const f = Math.max(0.6, Math.min(1.8, target / r.calories));
  if (Math.abs(f - 1) < 0.08) return r; // already close — don't fiddle
  return {
    ...r,
    calories: Math.round(r.calories * f),
    proteinGrams: Math.round(r.proteinGrams * f),
    carbsGrams: Math.round(r.carbsGrams * f),
    fatGrams: Math.round(r.fatGrams * f),
    ...(r.fiberGrams != null ? { fiberGrams: Math.round(r.fiberGrams * f) } : {}),
    ingredients: r.ingredients.map((i) => ({ ...i, quantity: scaleQuantity(i.quantity, f) })),
  };
}

const recipeByName = new Map(RECIPES.map((r) => [r.name.toLowerCase(), r]));

export const baseRecipeOf = (m: Meal): Recipe | undefined => recipeByName.get(m.name.toLowerCase());
