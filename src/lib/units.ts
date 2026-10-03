/**
 * Grams from a written quantity: "1 1/2 cups" of rice, "2 tbsp" of oil, "1 piece" of egg.
 *
 * Its own module (V1 A4, 2026-10-03) because of what it does NOT need: the USDA nutrient table.
 * It lived in nutrients.ts beside the micronutrient maths, and a module is as heavy as everything it
 * imports — so the meal-prep grocery list, which runs in the browser and only needs to add up grams,
 * shipped the whole nutrient table with it. This file imports nothing but the unit weights.
 * nutrients.ts re-exports gramsFor, so every caller that imported it from there is unchanged.
 */
import { UNIT_GRAMS } from "./unitGrams.generated";

/**
 * Grams for `quantity` of `ingredient`, or null when the unit is unknown for it. Never guesses: a
 * quantity it cannot weigh returns null, and check:recipes fails any recipe that has one.
 */
export function gramsFor(ingredient: string, quantity: string): number | null {
  // Optional leading whole number so MIXED numbers parse ("1 1/2 cups" = 1.5). Without it the whole
  // was read as the amount and the "1/2" fell through to unit="count" -> a silent 100 g misparse
  // (common on imported recipe pages). Groups: [1] whole, [2] number/numerator, [3] denominator, [4] unit.
  const m = quantity.trim().match(/^(?:(\d+)\s+)?(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+))?\s*([a-zA-Z-]+)?/);
  if (!m) return null;
  const amount = (m[1] ? Number(m[1]) : 0) + (m[3] ? Number(m[2]) / Number(m[3]) : Number(m[2]));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = (m[4] ?? "count").toLowerCase();
  const key = ingredient.trim().toLowerCase();
  const g = UNIT_GRAMS.perIngredient[key]?.[unit] ?? UNIT_GRAMS.default[unit];
  return g == null ? null : amount * g;
}
