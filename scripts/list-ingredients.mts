/**
 * Inventory of every distinct ingredient + quantity unit used by the recipe library.
 * Feeds the USDA mapping step (scripts/build-nutrients.mjs).
 *
 *   npx esbuild scripts/list-ingredients.mts --bundle --platform=node --format=esm \
 *     --tsconfig=tsconfig.json --outfile=node_modules/.cache/li.mjs && node node_modules/.cache/li.mjs
 */
import { RECIPES } from "@/lib/recipeDb";

const byName = new Map<string, number>();
const units = new Map<string, number>();

for (const r of RECIPES) {
  for (const ing of r.ingredients) {
    const n = ing.name.trim().toLowerCase();
    byName.set(n, (byName.get(n) ?? 0) + 1);
    // "200 g" -> "g", "1/2 piece" -> "piece", "1 tbsp" -> "tbsp"
    const m = ing.quantity.trim().match(/^[\d./\s]*\s*([a-zA-Z]+)?/);
    const u = (m?.[1] ?? "(none)").toLowerCase();
    units.set(u, (units.get(u) ?? 0) + 1);
  }
}

console.log(`recipes: ${RECIPES.length}`);
console.log(`distinct ingredients: ${byName.size}`);
console.log(`\n--- units used ---`);
for (const [u, c] of [...units.entries()].sort((a, b) => b[1] - a[1])) console.log(`${String(c).padStart(4)}  ${u}`);

console.log(`\n--- ingredients (usage count, name) ---`);
for (const [n, c] of [...byName.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))
  console.log(`${String(c).padStart(3)}  ${n}`);
