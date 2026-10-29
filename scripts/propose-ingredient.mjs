/**
 * Propose USDA matches for a NEW ingredient, for a person to accept or reject (V1 B7).   npm run propose:ingredient -- "name" ...
 *
 * Adding an ingredient is the slow half of growing the library (docs/v1/01-…md §8): each one needs a hand-checked
 * USDA food. scripts/usda-search.mjs already ranks candidates by their description; that is not enough to accept
 * one, because the description alone hides the two classic mistakes:
 *   - the wrong STATE: "Lentils, raw" is ~350 kcal/100 g, "Lentils, mature seeds, cooked, boiled" ~115, and a recipe
 *     weighing "150 g cooked" lentils against the raw entry triples their calories;
 *   - the wrong FOOD: naive matching gave "salmon fillet" -> "Vegetarian fillets".
 * So each candidate is shown with its per-100 g calories, protein, carbs and fat (and whether its own 4/4/9 adds up),
 * whether a curated slug already uses that USDA food, and the exact entry to paste into scripts/ingredient-map.json.
 *
 * It NEVER writes anything. Accepting is a person's call: paste the entry, set `state` to what recipes will weigh,
 * then `npm run build:nutrients -- --emit` and `npm run check:ingredients`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadFoods, search, USDA_DIR } from "./usda-search.mjs";

const args = process.argv.slice(2);
const nArg = args.find((a) => a.startsWith("--n="));
const N = nArg ? Math.max(1, Number(nArg.slice(4)) || 6) : 6;
const names = args.filter((a) => !a.startsWith("--"));
if (!names.length) {
  console.log('usage: npm run propose:ingredient -- "smoked tofu" "pearl barley" [--n=6]');
  process.exit(2);
}

// The curated set: which names and slugs exist, and which USDA foods are already behind one.
const map = JSON.parse(readFileSync(join(process.cwd(), "scripts", "ingredient-map.json"), "utf8")).map;
const table = readFileSync(join(process.cwd(), "src", "lib", "data", "nutrientTable.generated.ts"), "utf8");
const usedBy = new Map(); // fdcId -> curated names
for (const m of table.matchAll(/^  "([^"]+)": \{\s*\n\s*"fdcId": (\d+)/gm)) {
  const id = Number(m[2]);
  usedBy.set(id, [...(usedBy.get(id) ?? []), m[1]]);
}
const slugs = new Set(Object.values(map).map((e) => e.slug));
const slugFor = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const foods = loadFoods();
const proposals = names.map((name) => ({ name, candidates: search(foods, name, N) }));
const wanted = new Set(proposals.flatMap((p) => p.candidates.map((c) => c.fdcId)));

// Per-100 g figures for just those foods: one pass over the 36 MB nutrient file.
const IDS = { 1008: "kcal", 1003: "protein", 1005: "carbs", 1004: "fat" };
const per100 = new Map();
for (const line of readFileSync(join(USDA_DIR, "food_nutrient.csv"), "utf8").split("\n")) {
  const parts = line.split(",");
  if (parts.length < 4) continue;
  const fdc = Number(parts[1].replace(/"/g, ""));
  if (!wanted.has(fdc)) continue;
  const key = IDS[parts[2].replace(/"/g, "")];
  if (!key) continue;
  const amt = Number(parts[3].replace(/"/g, ""));
  if (!Number.isFinite(amt)) continue;
  per100.set(fdc, { ...(per100.get(fdc) ?? {}), [key]: amt });
}

const fmt = (v) => (v === undefined ? "  ?" : String(Math.round(v)).padStart(3));
for (const { name, candidates } of proposals) {
  const key = name.toLowerCase().trim();
  console.log(`\n### ${name}`);
  if (map[key]) console.log(`  ALREADY CURATED as slug "${map[key].slug}" (q: ${map[key].q ?? `id ${map[key].id}`}). Nothing to add.`);
  if (!candidates.length) {
    console.log("  no USDA candidate: try the USDA word for it (e.g. 'garbanzo' for chickpea), or a broader name");
    continue;
  }
  // The food is named in the first comma-segments of a USDA description: "Salmonberries, raw", or "Fish, salmon, chinook,
  // raw" with its class first. A candidate whose first two segments hold none of the asked-for words as a WHOLE word is
  // flagged: the trap usda-search's own header names.
  const words = key.split(/[^a-z]+/).filter((w) => w.length > 2);
  const sameFood = (desc) => words.some((w) => new RegExp(`\\b${w}s?\\b`, "i").test(desc.split(",").slice(0, 2).join(",")));
  console.log("  #  fdcId    kcal  P    C    F   4/4/9  description");
  for (const [i, c] of candidates.entries()) {
    const f = per100.get(c.fdcId) ?? {};
    const atwater = f.kcal && f.protein !== undefined && f.carbs !== undefined && f.fat !== undefined
      ? 4 * f.protein + 4 * f.carbs + 9 * f.fat : undefined;
    // Within 20% is how USDA's own energy factors usually land; fibre and alcohol move it further, so a miss is a
    // reason to look, not a verdict.
    const fits = atwater === undefined ? "  -  " : Math.abs(atwater - f.kcal) <= Math.max(15, f.kcal * 0.2) ? " ok  " : " LOOK";
    const taken = usedBy.get(c.fdcId);
    const flags = [taken ? `already behind: ${taken.join(", ")}` : "", sameFood(c.desc) ? "" : "NOT the same food by name?"].filter(Boolean);
    console.log(`  ${i + 1}  ${String(c.fdcId).padEnd(7)} ${fmt(f.kcal)}  ${fmt(f.protein)}  ${fmt(f.carbs)}  ${fmt(f.fat)} ${fits}  ${c.desc}${flags.length ? `   [${flags.join("; ")}]` : ""}`);
  }
  if (map[key]) continue;
  const slug = slugFor(name);
  // A template, not a pick: the ranking put "Tofu yogurt" first for smoked tofu and "Salmonberries" for salmon fillet.
  console.log(`  entry to paste once you have chosen a row (slug ${slugs.has(slug) ? `"${slug}" is TAKEN, pick another` : `"${slug}" is free`}):`);
  console.log(`    "${key}": { "slug": "${slug}", "q": "<that row's description, exactly>", "state": "<what recipes weigh: raw | cooked | dry>" }`);
}
console.log("\nNothing was written. Accept by pasting an entry into scripts/ingredient-map.json, then:");
console.log("  npm run build:nutrients -- --emit && npm run check:ingredients");
