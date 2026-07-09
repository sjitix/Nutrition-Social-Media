/**
 * Search the USDA SR Legacy food table for candidate matches.
 *
 *   node scripts/usda-search.mjs "chicken breast" "olive oil" ...
 *
 * Used to build/audit the ingredient -> fdc_id mapping. We never guess a nutrient
 * number; we pick a real FDC food and record its id so every value is traceable.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const USDA_DIR = join(ROOT, "data", "usda", "FoodData_Central_sr_legacy_food_csv_2018-04");

/** Minimal RFC4180-ish CSV parser (handles quoted fields with commas). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function loadFoods() {
  const rows = parseCsv(readFileSync(join(USDA_DIR, "food.csv"), "utf8"));
  const head = rows[0];
  const iId = head.indexOf("fdc_id");
  const iType = head.indexOf("data_type");
  const iDesc = head.indexOf("description");
  const foods = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length < 3 || r[iType] !== "sr_legacy_food") continue;
    foods.push({ fdcId: Number(r[iId]), desc: r[iDesc] });
  }
  return foods;
}

const STOP = new Set(["raw", "fresh", "cooked", "boiled", "all", "types", "and", "or", "with", "without"]);
const toks = (s) => s.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2);

// Naive token-overlap matching produced "salmon fillet" -> "Vegetarian fillets" and
// "eggs" -> "Eggs, scrambled, frozen mixture". These heuristics exist to surface
// plausible candidates for HUMAN review, not to pick automatically.
const JUNK =
  /babyfood|baby food|snacks?|chips|souffle|flour|breaded|frozen mixture|dehydrated|infant|formula|candy|dessert|pie |soup|sauce,|salad dressing|restaurant|fast food|school lunch|UPC|GTIN/i;
const PREPARED = /\bwith\b|\band\b|,\s*(prepared|reconstituted|canned)\b/i;

/** Score a candidate for review. Requires the head noun to appear as a whole word. */
export function scoreFood(queryToks, desc) {
  const d = desc.toLowerCase();
  if (!queryToks.length) return -1;

  // The last query token is the head noun ("salmon fillet" -> fillet is a modifier,
  // so we require ALL query tokens to appear, preferring whole-word matches).
  let hit = 0;
  let wholeWord = 0;
  for (const t of queryToks) {
    if (d.includes(t)) hit++;
    if (new RegExp(`\\b${t}`).test(d)) wholeWord++;
  }
  if (!hit) return -1;

  const dToks = toks(desc).filter((w) => !STOP.has(w));
  const coverage = hit / queryToks.length;
  const wordBonus = (wholeWord / queryToks.length) * 0.8;
  // Prefer short, generic entries — "Spinach, raw" over "Spinach souffle".
  const brevity = 1 / (1 + Math.max(0, dToks.length - queryToks.length) * 0.45);
  const rawBonus = /\braw\b/.test(d) ? 0.35 : 0;
  // The first comma-segment is the food itself; a match there is far stronger.
  const headSeg = d.split(",")[0];
  const headBonus = queryToks.some((t) => new RegExp(`\\b${t}`).test(headSeg)) ? 0.6 : 0;
  const junkPenalty = JUNK.test(desc) ? 2.5 : 0;
  const preparedPenalty = PREPARED.test(desc) ? 0.6 : 0;
  const brandPenalty = /\b[A-Z]{3,}\b/.test(desc) ? 0.8 : 0; // e.g. UNCLE BENS, CHOBANI

  return (
    coverage * 2 + wordBonus + brevity + rawBonus + headBonus - junkPenalty - preparedPenalty - brandPenalty
  );
}

export function search(foods, query, n = 5) {
  const q = toks(query);
  return foods
    .map((f) => ({ ...f, s: scoreFood(q, f.desc) }))
    .filter((f) => f.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, n);
}

if (process.argv[2]) {
  const foods = loadFoods();
  console.error(`loaded ${foods.length} SR Legacy foods\n`);
  for (const q of process.argv.slice(2)) {
    console.log(`### ${q}`);
    for (const c of search(foods, q)) console.log(`  ${c.fdcId}  ${c.s.toFixed(2)}  ${c.desc}`);
    console.log();
  }
}
