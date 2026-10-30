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
 *   - no name or id already in the library, and a cuisine and mainProtein the library uses;
 *   - a warning for an ingredient the USDA map holds raw or dry (rice, quinoa, pasta, chicken, shrimp, eggs...) that no
 *     step cooks: 52 recipes had one on 2026-10-30, most "serve over rice" with raw brown rice.
 * `--library` runs that last rule over every recipe in the library instead of a drafts file.
 * It reads the library and writes nothing.
 */
import { readFileSync } from "node:fs";
import { RECIPES } from "@/lib/recipeDb";
import { tableKey, NUTRIENT_TABLE, resolveIngredient } from "@/lib/data";
import { gramsFor, microsForIngredients, dietTagConflicts, mealHaystack, haystackBlocked, parseExclusionTokens } from "@/lib/nutrition";

type Draft = { id: string; name: string; type: string; cuisine?: string; mainProtein?: string; timeMinutes: number; dietTags: string[]; steps?: string[]; ingredients: { slug: string; name: string; quantity: string }[] };

/**
 * Ingredients the USDA map holds RAW or DRY that a method must cook, each with the words a step names it by. A step
 * counts as cooked when a step with a cooking verb comes at or after the first step that names it ("mix the batter… /
 * fry spoonfuls"), or a cooking step covers everything ("toss everything… / roast"). A heuristic: on the library as it
 * stood before the audit's fixes it flagged 30 of the audit's 39 clear cases, plus the poke bowl and a backwards
 * omelette. It misses a verb that belongs to something else in the same step ("Simmer in the sauce; serve over quinoa"). Smoked fish, canned beans, cooked rice and cooked
 * lentils are ready to eat and are not here; oats are left out (soaked, blended or baked, all fine).
 */
const MUST_COOK: Record<string, RegExp> = {
  rice: /\brice\b/, "brown-rice": /\brice\b/, quinoa: /\bquinoa\b/, bulgur: /\bbulgur\b|tabbouleh/, couscous: /\bcouscous\b/,
  "whole-wheat-pasta": /\bpasta\b/, "whole-wheat-penne": /\bpenne\b|\bpasta\b/, "whole-wheat-spaghetti": /\bspaghetti\b|\bpasta\b/,
  orzo: /\borzo\b/, "egg-noodles": /\bnoodles?\b/, "soba-noodles": /\bsoba\b|\bnoodles?\b/, "rice-noodles": /\bnoodles?\b/,
  "chicken-breast": /\bchicken\b/, "chicken-thigh": /\bchicken\b|\bthighs?\b/, "turkey-breast": /\bturkey\b/, "ground-turkey": /\bturkey\b|meatballs?|kofta|keema/,
  "lean-beef": /\bbeef\b/, "lean-steak": /\bsteak\b|\bbeef\b/, "beef-strips": /\bbeef\b/, "lean-ground-beef": /\bbeef\b|kofta|meatballs?|\bpatty\b|\bburgers?\b/,
"pork-tenderloin": /\bpork\b/, "lean-pork-sausage": /\bsausages?\b/, "turkey-sausage": /\bsausages?\b/,
  "salmon-fillet": /\bsalmon\b/, "cod-fillet": /\bcod\b|\bfish\b/, shrimp: /\bshrimp\b|\bprawns?\b/, prawns: /\bprawns?\b|\bshrimp\b/,
  eggs: /\beggs?\b|omelette|frittata|scramble/, egg: /\beggs?\b|omelette|frittata|scramble/, "egg-whites": /\beggs?\b|\bwhites\b|omelette/,
  "red-lentils": /\blentils?\b|\bdal\b/, "sweet-potato": /\bsweet potato|\bpotato/, "baby-potatoes": /\bpotato/, "chickpea-flour": /\bbatter\b|\bflour\b|pancake|omelette|chilla/,
};
// Stems, not whole words ("Sauté" ends in a letter \b does not see; "finish roasting"), and the phrases that say heat without a
// verb: "for 3 minutes", "until just set", "until tender".
const COOKS = /\b(cook|boil|simmer|fry|fried|frie|sear|roast|bak|grill|griddl|poach|scrambl|stir-fr|brown|blanch|steam|microwav|soak|crisp|toast|glaz|char|saut)|\bfor (?:the last )?\d+ min|\bset\b|until (?:just )?(?:set|creamy|tender|golden|pink|cooked)|waffle iron/;

function uncooked(r: { ingredients: { slug: string; name: string }[]; steps?: string[] }): string[] {
  const steps = (r.steps ?? []).map((st) => st.toLowerCase());
  // "Toss everything with the oil. / Roast on one tray": a step that takes everything, with a cooking step at or after it.
  const all = steps.findIndex((st) => /\b(everything|all of it|all ingredients|the batter|the mixture|the filling)\b/.test(st));
  const covered = (j: number) => all >= 0 && j >= all;
  return r.ingredients
    .filter((i) => {
      const re = MUST_COOK[i.slug];
      if (!re) return false;
      const first = steps.findIndex((st) => re.test(st));
      return !steps.some((st, j) => COOKS.test(st) && ((first >= 0 && j >= first) || covered(j)));
    })
    .map((i) => i.name);
}

if (process.argv[2] === "--library") {
  const hits = RECIPES.map((r) => ({ r, raw: uncooked(r as never) })).filter((x) => x.raw.length);
  for (const { r, raw } of hits) console.log(`${r.id.padEnd(40)} ${raw.join(", ")}  |  ${r.steps.join(" / ").slice(0, 140)}`);
  console.log(`\n${hits.length} of ${RECIPES.length} recipes name a raw or dry ingredient that no step cooks.`);
  process.exit(0);
}

const path = process.argv[2];
if (!path) {
  console.log("usage: npm run check:drafts -- path/to/drafts.txt   (or -- --library)");
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
  // test:engine's allergen law, for every dish: the METHOD alone may not block a gluten allergy that the ingredients
  // do not ("crisp the tortilla strips" over corn tortillas, 2026-10-30). Name the corn, or the grain, in the steps.
  const byList = haystackBlocked(mealHaystack("", r.ingredients.map((i) => i.name), []), gluten);
  if (!byList && haystackBlocked(mealHaystack("", r.ingredients.map((i) => i.name), r.steps ?? []), gluten))
    issues.push("its method alone reads as gluten to the allergy matcher (a word in the steps the ingredient list does not have)");
  // A warning, not a failure (a dry pan is sometimes meant): a method that fries or softens with no fat in the list. The
  // review of 2026-10-29 found three such methods among 117 recipes ("Soften the onion with the curry powder").
  const fryVerb = /\b(fry|fried|soften|saut[eé]|sear|brown|griddle|stir-fry)\b/i;
  const fat = /\b(oil|butter|ghee)\b/i;
  const warnings: string[] = [];
  if ((r.steps ?? []).some((st) => fryVerb.test(st)) && !r.ingredients.some((i) => fat.test(i.name)) && !(r.steps ?? []).some((st) => /dry pan|in a splash of water/i.test(st)))
    warnings.push("warning: the method fries or softens, but there is no oil or butter in the list");
  const raw = uncooked(r);
  if (raw.length) warnings.push(`warning: no step cooks ${raw.join(", ")} (raw or dry in the USDA map)`);
  if (warnings.length) issues.push(...warnings.map((w) => `(${w})`));
  if (issues.some((i) => !i.startsWith("(warning"))) bad++;
  const label = issues.some((i) => !i.startsWith("(warning")) ? "FIX" : issues.length ? "warn" : "ok ";
  console.log(`${label}  ${r.name.padEnd(46)} ${String(Math.round(cal)).padStart(4)} kcal  P${Math.round(p)} C${Math.round(c)} F${Math.round(f)}  ${r.timeMinutes} min${issues.length ? `\n       ${issues.join("\n       ")}` : ""}`);
}
console.log(`\n${drafts.length} draft(s), ${bad} to fix.${bad ? "" : " Paste them before the closing ]; of SEED_RECIPES, then run npm run check:recipes and check:ingredients."}`);
process.exit(bad ? 1 : 0);
