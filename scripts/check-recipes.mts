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
 *     which means the nutrients are missing too.
 *  4. ATWATER — protein*4 + carbs*4 + fat*9 should land near the calories. A big miss means a
 *     quantity, or a table entry, is wrong.
 */
import { RECIPES } from "@/lib/recipeDb";
import { NUTRIENT_TABLE } from "@/lib/nutrientTable.generated";
import { gramsFor, microsForIngredients } from "@/lib/nutrients";

// What a dish in that slot must at least be, before any portion scaling. Scaling only reaches
// 1.8x, so a dish far below its floor can never fill the slot it was written for.
const FLOOR: Record<string, number> = { breakfast: 250, lunch: 340, dinner: 380, snack: 90 };
const MIN_COVERAGE = 0.6;
const ATWATER_TOLERANCE = 0.2;

const problems: string[] = [];
let worstAtwater = 0;

for (const r of RECIPES) {
  for (const i of r.ingredients) {
    const key = i.name.trim().toLowerCase();
    if (!NUTRIENT_TABLE[key]) problems.push(`${r.name}: "${i.name}" has no USDA entry`);
    else if (!gramsFor(key, i.quantity)) problems.push(`${r.name}: can't weigh "${i.name}" from "${i.quantity}"`);
  }

  const coverage = microsForIngredients(r.ingredients).coverage;
  if (coverage < MIN_COVERAGE)
    problems.push(`${r.name}: only ${Math.round(coverage * 100)}% nutrient coverage — the app will refuse to state its micronutrients`);

  const floor = FLOOR[r.type] ?? 0;
  if (r.calories < floor)
    problems.push(`${r.name}: ${r.calories} kcal is not a ${r.type} (floor ${floor}) — an ingredient is missing`);

  const atwater = r.proteinGrams * 4 + r.carbsGrams * 4 + r.fatGrams * 9;
  const miss = r.calories > 0 ? Math.abs(atwater - r.calories) / r.calories : 0;
  worstAtwater = Math.max(worstAtwater, miss);
  if (miss > ATWATER_TOLERANCE)
    problems.push(`${r.name}: ${r.calories} kcal but 4/4/9 says ${Math.round(atwater)} — a quantity looks wrong`);
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
