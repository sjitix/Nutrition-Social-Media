/**
 * Ingredient identity.   npm run check:ingredients
 *
 * V1 D5 (docs/v1/06-ingredient-identity.md). Every one of the library's ingredient references must
 * resolve to a curated ingredient with a permanent slug and a real USDA food behind it. Recipes name
 * ingredients in free text today, and a name that resolves to nothing used to be skipped silently by
 * the macro maths — so this gate reads the library the way the engine does and fails on any miss.
 *
 * It also REPORTS (without failing) what an editor should know before the library grows:
 *   - references that resolve only after case/whitespace normalisation (the fragility a slug removes)
 *   - curated ingredients no recipe uses
 *   - several slugs sharing one USDA food (sometimes deliberate: "rice" and "cooked rice" differ in
 *     state, not in food — but worth seeing)
 */
import { RECIPES } from "@/lib/recipeDb";
import { INGREDIENT_SLUGS, INGREDIENTS, resolveIngredient } from "@/lib/data/ingredients";

const problems: string[] = [];
const used = new Set<string>();
let refs = 0;
let normalised = 0;

for (const s of INGREDIENT_SLUGS) {
  const e = INGREDIENTS[s];
  if (!e || !Number.isInteger(e.fdcId) || e.fdcId <= 0) problems.push(`slug "${s}" has no USDA food behind it`);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(s)) problems.push(`slug "${s}" is not kebab-case ASCII`);
}

for (const r of RECIPES) {
  for (const i of r.ingredients) {
    refs++;
    const slug = resolveIngredient(i.name);
    if (!slug) {
      problems.push(`${r.name}: "${i.name}" is not a curated ingredient`);
      continue;
    }
    used.add(slug);
    if (i.name !== INGREDIENTS[slug].name) normalised++;
    // The NAME and the SLUG must name the same ingredient. Lookups resolve by name first and fall back
    // to the slug (data/ingredients.ts tableKey), so a recipe whose two disagree would get its
    // nutrition from one food while its slug claims another (D5 review, 2026-10-04).
    const carried = (i as { slug?: string }).slug;
    if (!carried) problems.push(`${r.name}: "${i.name}" carries no slug`);
    else if (carried !== slug) problems.push(`${r.name}: "${i.name}" resolves to ${slug} but carries slug ${carried}`);
  }
}

const unused = INGREDIENT_SLUGS.filter((s) => !used.has(s));
const byFood = new Map<number, string[]>();
for (const s of INGREDIENT_SLUGS) byFood.set(INGREDIENTS[s].fdcId, [...(byFood.get(INGREDIENTS[s].fdcId) ?? []), s]);
const shared = [...byFood.values()].filter((l) => l.length > 1);

console.log(`curated ingredients: ${INGREDIENT_SLUGS.length}   recipes: ${RECIPES.length}   references: ${refs}   distinct used: ${used.size}`);
console.log(`references resolving only after case/whitespace normalisation: ${normalised}`);
console.log(`curated but unused: ${unused.length ? unused.join(", ") : "none"}`);
console.log(`USDA foods shared by several slugs: ${shared.length ? shared.map((l) => l.join(" + ")).join("; ") : "none"}`);

if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems.slice(0, 40)) console.log("  " + p);
  process.exit(1);
}
console.log("\nOK — every ingredient reference resolves to a curated ingredient with a USDA food behind it.");
