/**
 * Recipe data integrity.   npm run check:recipes
 *
 * Macros are derived from the ingredient list (see `deriveMacros` in recipeDb.ts), so a recipe can
 * no longer disagree with itself. What it CAN still be is an incomplete or mis-measured recipe, and
 * that is what this gate is for. Everything the app says about nutrition rests on these lists.
 *
 * Four failures, in the order they matter:
 *
 *  1. UNPRICED INGREDIENT — no USDA entry, or a quantity we can't weigh. It contributes nothing, so
 *     the dish silently under-reports its calories AND every nutrient in it.
 *  2. LOW COVERAGE — under 60% of the ingredients carry nutrient data, so the app already refuses
 *     to state this dish's micronutrients. Better to know than to find out from a user.
 *  3. IMPLAUSIBLE MEAL — a 110 kcal dinner is not a dinner. It means an ingredient is missing,
 *     which means the nutrients are missing too. And a 3,500 kcal dinner is not one either: it means a
 *     quantity is wrong (a "1500 g" that meant "150 g").
 *  4. ATWATER — protein*4 + carbs*4 + fat*9 should land near the calories. A miss means a TABLE
 *     entry is wrong. It cannot catch a wrong quantity, and used to claim it could: with every number
 *     derived from the same table, a recipe's miss is just the kcal-weighted mean of its ingredients'
 *     misses, and ten times the salmon in Baked Salmon & Potatoes moves it from +2% to -2% (D5b). The
 *     ceiling in 3 is what catches a quantity; test:engine checks each table entry's own 4/4/9.
 */
import { RECIPES } from "@/lib/recipeDb";
import { NUTRIENT_TABLE } from "@/lib/nutrientTable.generated";
import { gramsFor, microsForIngredients } from "@/lib/nutrients";
import { tableKey } from "@/lib/data/ingredients";

// What a dish in that slot must at least be, before any portion scaling. Scaling only reaches
// 1.8x, so a dish far below its floor can never fill the slot it was written for.
const FLOOR: Record<string, number> = { breakfast: 250, lunch: 340, dinner: 380, snack: 90 };
// …and what it may at most be. Scaling only reaches 0.6x, so a dish far above its ceiling can never
// fit the slot either — and the usual reason is a mistyped quantity. About 1.3x the largest dish in
// each slot today (2026-10-03: 678 / 759 / 840 / 412), so it flags a slip, not a hearty meal.
const CEILING: Record<string, number> = { breakfast: 900, lunch: 1000, dinner: 1100, snack: 550 };
const MIN_COVERAGE = 0.6;
// The tightest the library passes (worst miss 15%, 2026-10-03), down from 20%.
const ATWATER_TOLERANCE = 0.16;
// A "keto" tag is a claim about carbohydrate, and the app filters entire weeks on it. Verify it.
const KETO_MAX_CARBS = 20;

const problems: string[] = [];
let worstAtwater = 0;

for (const r of RECIPES) {
  for (const i of r.ingredients) {
    const key = tableKey(i); // the one lookup rule (D5): the same key deriveMacros uses
    if (!NUTRIENT_TABLE[key]) problems.push(`${r.name}: "${i.name}" has no USDA entry`);
    else if (!gramsFor(key, i.quantity)) problems.push(`${r.name}: can't weigh "${i.name}" from "${i.quantity}"`);
  }

  const coverage = microsForIngredients(r.ingredients).coverage;
  if (coverage < MIN_COVERAGE)
    problems.push(`${r.name}: only ${Math.round(coverage * 100)}% nutrient coverage — the app will refuse to state its micronutrients`);

  const floor = FLOOR[r.type] ?? 0;
  if (r.calories < floor)
    problems.push(`${r.name}: ${r.calories} kcal is not a ${r.type} (floor ${floor}) — an ingredient is missing`);
  const ceiling = CEILING[r.type] ?? Infinity;
  if (r.calories > ceiling)
    problems.push(`${r.name}: ${r.calories} kcal is not a ${r.type} (ceiling ${ceiling}) — a quantity looks wrong`);

  if (r.dietTags.includes("keto") && r.carbsGrams > KETO_MAX_CARBS)
    problems.push(`${r.name}: tagged keto but ${r.carbsGrams}g carbs (max ${KETO_MAX_CARBS})`);

  const atwater = r.proteinGrams * 4 + r.carbsGrams * 4 + r.fatGrams * 9;
  const miss = r.calories > 0 ? Math.abs(atwater - r.calories) / r.calories : 0;
  worstAtwater = Math.max(worstAtwater, miss);
  if (miss > ATWATER_TOLERANCE)
    problems.push(`${r.name}: ${r.calories} kcal but 4/4/9 says ${Math.round(atwater)} — a table entry looks wrong`);
}

const byType: Record<string, number[]> = {};
for (const r of RECIPES) (byType[r.type] ??= []).push(r.calories);
console.log(`recipes: ${RECIPES.length}   macros derived from ingredients`);
for (const [t, v] of Object.entries(byType)) {
  const sorted = [...v].sort((a, b) => a - b);
  console.log(`  ${t.padEnd(9)} n=${String(v.length).padStart(3)}  kcal ${sorted[0]}-${sorted[sorted.length - 1]} (median ${sorted[sorted.length >> 1]})`);
}
console.log(`worst Atwater miss: ${Math.round(worstAtwater * 100)}%`);

if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems.slice(0, 30)) console.log("  " + p);
  console.log("\nFix the RECIPE. The USDA values are not in doubt; the ingredient list is.");
  process.exit(1);
}
console.log("\nOK — every ingredient is priced, every dish is a plausible meal, and the macros add up.");
