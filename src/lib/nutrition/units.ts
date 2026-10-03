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

type Units = Record<string, number | undefined>;

/** Two spellings of one unit. An ingredient that overrides one must weigh the other the same:
 *  "bell peppers: 2 pieces" weighed 200 g while "2 piece" weighed 238 g (D5b). */
const TWIN: Record<string, string> = {
  piece: "pieces", pieces: "piece", slice: "slices", slices: "slice", clove: "cloves", cloves: "clove", cup: "cups", cups: "cup",
  can: "cans", cans: "can", scoop: "scoops", scoops: "scoop",
};
/** Spellings that mean exactly one unit the table knows. Only the unambiguous ones: "T", "t" and "c"
 *  stay unknown (null), because guessing tablespoon against teaspoon is a 3x error either way. */
const ALIAS: Record<string, string> = {
  tablespoon: "tbsp", tablespoons: "tbsp", tbs: "tbsp", tbsps: "tbsp",
  teaspoon: "tsp", teaspoons: "tsp", tsps: "tsp",
  gram: "g", grams: "g", gr: "g", kilogram: "kg", kilograms: "kg", kgs: "kg",
  ounce: "oz", ounces: "oz", pound: "lb", pounds: "lb", lbs: "lb",
  litre: "l", litres: "l", liter: "l", liters: "l", millilitre: "ml", millilitres: "ml", milliliter: "ml", milliliters: "ml",
};
/** After a size word, a word like these names a DIFFERENT unit than the item: "1 large head" of
 *  lettuce is a head, not a large leaf (it weighed 7.8 g). There is no honest weight for it, so null. */
const CONTAINER_NOUN = /^\s*(heads?|bulbs?|bunch(es)?|cans?|tins?|jars?|packets?|packs?|bags?|boxes|box|cloves?|slices?|stalks?|sprigs?|handfuls?|cups?|pieces?|fillets?|loaf|loaves)\b/i;
/** A bare number and "a piece" are the same thing: one of the item, whatever the item's natural unit. */
const COUNT_LIKE = ["count", "piece", "pieces"];
/** A size word is relative to the item. The default table's 70 g / 150 g made "2 large eggs" 300 g and
 *  a "large" avocado lighter than a plain one. These ratios are the USDA small / large portions over
 *  the medium one, averaged across eggs, apples, bananas and onions (about 0.75 and 1.3). */
const SIZE_RATIO: Record<string, number> = { small: 0.75, medium: 1, large: 1.3 };

/**
 * The grams one `unit` of this ingredient weighs, keeping every unit consistent with the ones the
 * ingredient DOES override: the other spelling, the count, the spoons at the ingredient's own
 * density (tbsp = 3 tsp, cup = 16 tbsp, 1 tbsp = 15 ml, 1 l = 1000 ml). Falls back to the default
 * table only when the ingredient says nothing that bears on the unit. Found by the D5b property sweep:
 * a cup of olive oil weighed 240 g though 16 of its tablespoons weigh 216, and a cup of cumin 240 g
 * though its tablespoons say 101.
 */
function unitGrams(per: Units, unit: string): number | undefined {
  if (per[unit] != null) return per[unit];
  if (TWIN[unit] && per[TWIN[unit]] != null) return per[TWIN[unit]];
  if (COUNT_LIKE.includes(unit)) for (const u of COUNT_LIKE) if (per[u] != null) return per[u];
  if (SIZE_RATIO[unit] != null) {
    // When an item's count is a PART of it (a clove of garlic, a leaf of lettuce, a slice of bread), a
    // size word describes the whole thing, which the table does not weigh: "1 large" garlic is a bulb,
    // not 1.3 cloves. No honest answer, so none.
    const part = [per.clove, per.cloves, per.slice, per.slices, per.leaves].find((g) => g != null);
    const count = per.count ?? per.piece ?? per.pieces;
    if (count != null) return part != null && part === count ? undefined : count * SIZE_RATIO[unit];
  }
  const tbsp = per.tbsp ?? (per.tsp != null ? per.tsp * 3 : per.ml != null ? per.ml * 15 : undefined);
  if (tbsp != null) {
    if (unit === "tbsp") return tbsp;
    if (unit === "tsp") return tbsp / 3;
    if (unit === "cup" || unit === "cups") return tbsp * 16;
    if (unit === "ml") return tbsp / 15;
    if (unit === "l") return (tbsp / 15) * 1000;
  }
  return UNIT_GRAMS.default[unit] ?? (TWIN[unit] ? UNIT_GRAMS.default[TWIN[unit]] : undefined);
}

/** "½" and friends, as typed on recipe sites. */
const VULGAR: Record<string, string> = { "½": "1/2", "⅓": "1/3", "⅔": "2/3", "¼": "1/4", "¾": "3/4", "⅛": "1/8" };

/**
 * Grams for `quantity` of `ingredient`, or null when the unit is unknown for it. Never guesses: a
 * quantity it cannot weigh returns null, and check:recipes fails any recipe that has one.
 *
 * "Never guesses" now covers the number too. The old parser read the first number it could and
 * called whatever followed a 'count': "2 (400 g) cans" was 200 g, "1,000 g" 100 g, "1 2 cups" three
 * cups. A quantity is now a number (a mixed number only when a real fraction follows the whole), then
 * an optional unit, then the end or a word break; anything else is null — honest, and visible.
 */
export function gramsFor(ingredient: string, quantity: string): number | null {
  const q = quantity
    .trim()
    .replace(/[½⅓⅔¼¾⅛]/g, (c) => ` ${VULGAR[c]}`)
    // 1,000 g -> 1000 g. Only a real thousands lead (1-9, up to three digits): "0,250 l" is a European
    // decimal, and reading it as 250 l made a quarter litre of milk weigh 257 kg (D5b review).
    .replace(/\b([1-9]\d{0,2}),(\d{3})(?![\d,])/g, "$1$2")
    .trim();
  // Groups: [1] whole (only before a fraction), [2] number/numerator, [3] denominator, [4] unit.
  // After a unit: the end, a space, or the punctuation recipe sites put there ("2 tbsp.", "200g/7oz",
  // "2 cups)", "1 cup:").
  const m = q.match(/^(?:(\d+)\s+(?=\d+\s*\/\s*\d))?(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+))?(?:\s*([a-zA-Z]+(?:-[a-zA-Z]+)*))?(?=$|[\s,;(./):])/);
  if (!m) return null;
  const rest = q.slice(m[0].length);
  // A number with no unit must stand alone, or be followed by a comma and words ("2, diced"):
  // "2 (400 g) cans" is not two of anything, and "1.5.2 g" is not a number.
  if (!m[4] && rest.trim() && !/^\s*,\s*[^\d\s]/.test(rest)) return null;
  const amount = (m[1] ? Number(m[1]) : 0) + (m[3] ? Number(m[2]) / Number(m[3]) : Number(m[2]));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const written = (m[4] ?? "count").toLowerCase();
  const unit = ALIAS[written] ?? written;
  if (SIZE_RATIO[unit] != null && CONTAINER_NOUN.test(rest)) return null;
  const key = ingredient.trim().toLowerCase();
  const g = unitGrams(UNIT_GRAMS.perIngredient[key] ?? {}, unit);
  return g == null ? null : amount * g;
}
