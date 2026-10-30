/**
 * Check DRAFT recipes before they go into src/lib/data/seeds.ts.   npm run check:drafts -- path/to/drafts.txt
 *
 * The file holds recipe objects exactly as they would be pasted into SEED_RECIPES (comma-separated `{ … }` entries,
 * comments allowed). Each is checked the way the library will check it once it is in, so a batch is fixed in one
 * pass instead of one 25-minute gate per mistake (2026-10-29: a batch of 22 needed two gate runs for what this now
 * catches):
 *   - every ingredient's NAME resolves to a curated ingredient on its own (check:ingredients), not only via its slug;
 *   - every quantity can be weighed, and macros are derived as deriveMacros derives them;
 *   - the slot's calorie floor, keto under 20 g carbs, 4/4/9 within 16%, nutrient coverage over 60% (check:recipes);
 *   - no diet tag its ingredients contradict, and a gluten_free dish is not blocked by a gluten allergy reading its
 *     name, ingredients AND method ("Fill the warm tortillas" read as wheat);
 *   - no name or id already in the library, and a cuisine and mainProtein the library uses.
 * It reads the library and writes nothing.
 */
import { readFileSync } from "node:fs";
import { RECIPES } from "@/lib/recipeDb";
import { tableKey, NUTRIENT_TABLE, resolveIngredient } from "@/lib/data";
import { gramsFor, microsForIngredients, dietTagConflicts, mealHaystack, haystackBlocked, parseExclusionTokens } from "@/lib/nutrition";

type Draft = { id: string; name: string; type: string; cuisine?: string; mainProtein?: string; timeMinutes: number; dietTags: string[]; steps?: string[]; ingredients: { slug: string; name: string; quantity: string }[] };

const path = process.argv[2];
if (!path) {
  console.log("usage: npm run check:drafts -- path/to/drafts.txt");
  process.exit(2);
}
const drafts = new Function(`return [${readFileSync(path, "utf8")}];`)() as Draft[];
// The same limits check:recipes holds the library to.
const FLOOR: Record<string, number> = { breakfast: 250, lunch: 340, dinner: 380, snack: 90 };
const CEILING: Record<string, number> = { breakfast: 900, lunch: 1000, dinner: 1100, snack: 550 };
const names = new Set(RECIPES.map((r) => r.name)), ids = new Set(RECIPES.map((r) => r.id));
// tsc fails a value outside these unions, but only after the drafts are in seeds.ts ("tempeh" is not a mainProtein;
// tempeh dishes are "tofu", 2026-10-30), so they are checked here too, against the values the library uses.
const cuisines = new Set(RECIPES.map((r) => r.cuisine as string)), proteins = new Set(RECIPES.map((r) => r.mainProtein as string));
const gluten = parseExclusionTokens("gluten", "");

let bad = 0;
for (const r of drafts) {
  let cal = 0, p = 0, c = 0, f = 0;
  const issues: string[] = [];
  if (names.has(r.name)) issues.push("a recipe of this name exists");
  if (ids.has(r.id)) issues.push("this id exists");
  if (!cuisines.has(r.cuisine ?? "")) issues.push(`cuisine "${r.cuisine}" is not one of ${[...cuisines].join(", ")}`);
  if (!proteins.has(r.mainProtein ?? "")) issues.push(`mainProtein "${r.mainProtein}" is not one of ${[...proteins].join(", ")}`);
  for (const i of r.ingredients) {
    if (!resolveIngredient(i.name)) issues.push(`"${i.name}" is not a curated name (it resolves only through its slug, if at all)`);
    const key = tableKey(i as never);
    const per = NUTRIENT_TABLE[key]?.per100g;
    const g = gramsFor(key, i.quantity);
    if (!per || !g) { issues.push(`${i.name}: ${per ? `can't weigh "${i.quantity}"` : "no USDA entry"}`); continue; }
    cal += ((per.cal ?? 0) * g) / 100; p += ((per.protein ?? 0) * g) / 100; c += ((per.carbs ?? 0) * g) / 100; f += ((per.fat ?? 0) * g) / 100;
  }
  if (cal < FLOOR[r.type]) issues.push(`${Math.round(cal)} kcal is under the ${r.type} floor ${FLOOR[r.type]}`);
  if (cal > CEILING[r.type]) issues.push(`${Math.round(cal)} kcal is over the ${r.type} ceiling ${CEILING[r.type]}`);
  if (r.dietTags.includes("keto") && Math.round(c) > 20) issues.push(`keto with ${Math.round(c)} g carbs`);
  const atwater = 4 * p + 4 * c + 9 * f;
  if (cal > 0 && Math.abs(atwater - cal) / cal > 0.16) issues.push(`4/4/9 says ${Math.round(atwater)} against ${Math.round(cal)}`);
  const cov = microsForIngredients(r.ingredients as never).coverage;
  if (cov < 0.6) issues.push(`nutrient coverage ${Math.round(cov * 100)}%`);
  for (const t of r.dietTags) {
    const x = dietTagConflicts(t, r.ingredients.map((i) => i.name));
    if (x.length) issues.push(`${t}, but ${x.join(", ")}`);
  }
  if (r.dietTags.includes("gluten_free") && haystackBlocked(mealHaystack(r.name, r.ingredients.map((i) => i.name), r.steps ?? []), gluten))
    issues.push("gluten_free, but a gluten allergy blocks it (its name, ingredients or method)");
  // A warning, not a failure (a dry pan is sometimes meant): a method that fries or softens with no fat in the list. The
  // review of 2026-10-29 found three such methods among 117 recipes ("Soften the onion with the curry powder").
  const fryVerb = /\b(fry|fried|soften|saut[eé]|sear|brown|griddle|stir-fry)\b/i;
  const fat = /\b(oil|butter|ghee)\b/i;
  const warnings: string[] = [];
  if ((r.steps ?? []).some((st) => fryVerb.test(st)) && !r.ingredients.some((i) => fat.test(i.name)) && !(r.steps ?? []).some((st) => /dry pan|in a splash of water/i.test(st)))
    warnings.push("warning: the method fries or softens, but there is no oil or butter in the list");
  if (warnings.length) issues.push(...warnings.map((w) => `(${w})`));
  if (issues.some((i) => !i.startsWith("(warning"))) bad++;
  const label = issues.some((i) => !i.startsWith("(warning")) ? "FIX" : issues.length ? "warn" : "ok ";
  console.log(`${label}  ${r.name.padEnd(46)} ${String(Math.round(cal)).padStart(4)} kcal  P${Math.round(p)} C${Math.round(c)} F${Math.round(f)}  ${r.timeMinutes} min${issues.length ? `\n       ${issues.join("\n       ")}` : ""}`);
}
console.log(`\n${drafts.length} draft(s), ${bad} to fix.${bad ? "" : " Paste them before the closing ]; of SEED_RECIPES, then run npm run check:recipes and check:ingredients."}`);
process.exit(bad ? 1 : 0);
