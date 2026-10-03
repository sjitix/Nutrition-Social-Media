/**
 * Micronutrients, computed from real USDA data — never guessed.
 *
 * Recipe macros stay hand-authored (the recipe ingredient lists are deliberately short, so
 * summing them under-counts a dish that omits its oil). Micronutrients, by contrast, are
 * DERIVED from the mapped ingredients: the dominant sources of iron, folate, B12 and vitamin
 * D are exactly the ingredients that get listed (lentils, spinach, salmon, eggs).
 *
 * Values are per 100 g from USDA SR Legacy, keyed to an fdc_id (see nutrientTable.generated.ts,
 * produced by `npm run build:nutrients -- --emit`). Coverage is reported, never assumed: an
 * unmapped ingredient contributes nothing, so callers can refuse to show a number they'd be
 * guessing at.
 */
import { NUTRIENT_TABLE, type Per100g } from "./nutrientTable.generated";
// Unit conversion lives in ./units (A4): it needs only the unit weights, and the browser's grocery
// list should not download this module's USDA table to add up grams. Re-exported, so every caller
// that imports gramsFor from here is unchanged; client code imports it from ./units directly.
import { gramsFor } from "./units";
import { tableKey } from "./data/ingredients";
export { gramsFor };

export const MICRO_KEYS = [
  "iron", "calcium", "magnesium", "potassium", "zinc", "vitD", "vitC", "folate", "b12",
] as const;
export type MicroKey = (typeof MICRO_KEYS)[number];
export type Micros = Record<MicroKey, number>;

export const emptyMicros = (): Micros =>
  Object.fromEntries(MICRO_KEYS.map((k) => [k, 0])) as Micros;

export interface MicroResult {
  micros: Micros;
  /** Fraction of the recipe's ingredients we could actually resolve (0..1). */
  coverage: number;
}

/** Sum micronutrients across a recipe's ingredients. Unmapped ingredients lower coverage. */
export function microsForIngredients(ingredients: { name: string; quantity: string; slug?: string }[]): MicroResult {
  const micros = emptyMicros();
  if (!ingredients.length) return { micros, coverage: 1 };
  let resolved = 0;
  for (const ing of ingredients) {
    const key = tableKey(ing); // the one rule (D5): name first, then the slug, then the raw name
    const entry = NUTRIENT_TABLE[key];
    const grams = gramsFor(key, ing.quantity);
    if (!entry || grams == null) continue;
    resolved++;
    const per: Per100g = entry.per100g;
    for (const k of MICRO_KEYS) micros[k] += ((per[k] ?? 0) * grams) / 100;
  }
  return { micros, coverage: resolved / ingredients.length };
}

/**
 * Nutrient density per calorie. This is the right signal for "boost my iron": scaling a
 * portion raises calories and the nutrient together, so only DENSITY distinguishes an
 * iron-rich meal from a merely large one.
 */
export function microDensity(micros: Micros, calories: number, key: MicroKey): number {
  return calories > 0 ? micros[key] / calories : 0;
}

/** Adult reference intakes (per day). Used to phrase results, not to prescribe. */
export const DAILY_REFERENCE: Micros = {
  iron: 14, calcium: 1000, magnesium: 375, potassium: 3500, zinc: 10,
  vitD: 15, vitC: 80, folate: 400, b12: 2.4,
};

export const MICRO_LABEL: Record<MicroKey, string> = {
  iron: "iron", calcium: "calcium", magnesium: "magnesium", potassium: "potassium",
  zinc: "zinc", vitD: "vitamin D", vitC: "vitamin C", folate: "folate", b12: "vitamin B12",
};

export const MICRO_UNIT: Record<MicroKey, string> = {
  iron: "mg", calcium: "mg", magnesium: "mg", potassium: "mg", zinc: "mg",
  vitD: "µg", vitC: "mg", folate: "µg", b12: "µg",
};
