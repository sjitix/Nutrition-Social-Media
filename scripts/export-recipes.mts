/**
 * Export the whole recipe library to a spreadsheet.   npm run export:recipes
 *
 * Written as a real .xlsx (SpreadsheetML 2003 XML, which Excel opens natively) so it carries
 * multiple sheets, typed number cells, a frozen header and column widths — a .csv could not.
 * No dependency is added for this; the format is plain XML.
 *
 * Everything here is READ from the engine, never re-stated: macros come from `RECIPES` (which
 * is `SEED_RECIPES.map(deriveMacros)`, i.e. computed from the ingredient list against USDA),
 * and micros from `microsForIngredients`. If a number looks wrong in the sheet, the ingredient
 * list is wrong — the sheet is not a second source of truth.
 *
 * Sheets:
 *   Recipes     one row per recipe, macros + micros + tags + ingredient/step text
 *   Ingredients one row per ingredient use, with the grams it resolves to and its FDC id
 *   Coverage    the pool-size table — how many recipes survive each filter, per slot
 *   Gaps        the thin cells, worst first: what to write next
 */
import { writeFileSync } from "node:fs";
import { RECIPES } from "@/lib/recipeDb";
import { NUTRIENT_TABLE } from "@/lib/nutrientTable.generated";
import { gramsFor, microsForIngredients, MICRO_KEYS, MICRO_LABEL, MICRO_UNIT } from "@/lib/nutrients";

const OUT = process.argv[2] ?? "NutriFlow-recipes.xls";

// --- tiny SpreadsheetML writer ---------------------------------------------
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

type Cell = string | number | undefined;

function cell(v: Cell): string {
  if (v === undefined || v === "") return "<Cell/>";
  if (typeof v === "number" && Number.isFinite(v))
    return `<Cell><Data ss:Type="Number">${v}</Data></Cell>`;
  return `<Cell><Data ss:Type="String">${esc(String(v))}</Data></Cell>`;
}

function sheet(name: string, headers: string[], rows: Cell[][], widths?: number[]): string {
  const cols = (widths ?? headers.map(() => 120))
    .map((w) => `<Column ss:AutoFitWidth="0" ss:Width="${w}"/>`)
    .join("");
  const head = `<Row ss:StyleID="hdr">${headers.map((h) => cell(h)).join("")}</Row>`;
  const body = rows.map((r) => `<Row>${r.map(cell).join("")}</Row>`).join("");
  // FreezePanes keeps the header visible while scrolling 500+ rows.
  return `<Worksheet ss:Name="${esc(name)}"><Table>${cols}${head}${body}</Table>
<WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel">
<FreezePanes/><FrozenNoSplit/><SplitHorizontal>1</SplitHorizontal><TopRowBottomPane>1</TopRowBottomPane>
<ActivePane>2</ActivePane></WorksheetOptions></Worksheet>`;
}

function workbook(sheets: string[]): string {
  return `<?xml version="1.0"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Styles>
<Style ss:ID="Default" ss:Name="Normal"><Alignment ss:Vertical="Top"/></Style>
<Style ss:ID="hdr"><Font ss:Bold="1"/><Interior ss:Color="#E8E4F3" ss:Pattern="Solid"/>
<Alignment ss:Vertical="Bottom"/></Style>
</Styles>
${sheets.join("\n")}
</Workbook>`;
}

// --- Sheet 1: Recipes -------------------------------------------------------
const recipeHeaders = [
  "id", "name", "type", "cuisine", "mainProtein",
  "calories", "protein g", "carbs g", "fat g", "fiber g",
  "timeMinutes", "approxCost", "servings", "dietTags", "treatOnly",
  "nutrientCoverage %",
  ...MICRO_KEYS.map((k) => `${MICRO_LABEL[k]} (${MICRO_UNIT[k]})`),
  "ingredientCount", "ingredients", "steps", "description",
];

const recipeRows: Cell[][] = RECIPES.map((r) => {
  const { micros, coverage } = microsForIngredients(r.ingredients);
  return [
    r.id, r.name, r.type, r.cuisine, r.mainProtein,
    r.calories, r.proteinGrams, r.carbsGrams, r.fatGrams, r.fiberGrams ?? 0,
    r.timeMinutes, r.approxCost, r.servings ?? 1,
    r.dietTags.join(", "), r.treatOnly ? "yes" : "",
    Math.round(coverage * 100),
    ...MICRO_KEYS.map((k) => Math.round(micros[k] * 10) / 10),
    r.ingredients.length,
    r.ingredients.map((i) => `${i.quantity} ${i.name}`).join("; "),
    r.steps.map((s, n) => `${n + 1}. ${s}`).join(" "),
    r.description,
  ];
});

// --- Sheet 2: Ingredients (one row per use, so a bad quantity is visible) ----
const ingHeaders = ["recipe", "recipe type", "ingredient", "quantity", "grams", "fdcId", "USDA description", "kcal contributed"];
const ingRows: Cell[][] = [];
for (const r of RECIPES) {
  for (const i of r.ingredients) {
    const key = i.name.trim().toLowerCase();
    const entry = NUTRIENT_TABLE[key];
    const grams = gramsFor(key, i.quantity);
    ingRows.push([
      r.name, r.type, i.name, i.quantity,
      grams == null ? "UNWEIGHABLE" : Math.round(grams),
      entry?.fdcId ?? "NO USDA ENTRY",
      entry?.desc ?? "",
      entry && grams != null ? Math.round(((entry.per100g.cal ?? 0) * grams) / 100) : "",
    ]);
  }
}

// --- Sheet 3: Coverage — the pool a user actually picks from ----------------
const TYPES = ["breakfast", "lunch", "dinner", "snack"] as const;
const DIETS = ["vegetarian", "vegan", "keto", "mediterranean", "gluten_free"] as const;
const selectable = RECIPES.filter((r) => !r.treatOnly);

const covHeaders = ["filter", ...TYPES, "total"];
const covRows: Cell[][] = [];
const countBy = (label: string, pool: typeof RECIPES) => {
  covRows.push([label, ...TYPES.map((t) => pool.filter((r) => r.type === t).length), pool.length]);
};
countBy("ALL (selectable)", selectable);
for (const d of DIETS) countBy(`diet: ${d}`, selectable.filter((r) => r.dietTags.includes(d)));
for (const c of [...new Set(selectable.map((r) => r.cuisine))].sort())
  countBy(`cuisine: ${c}`, selectable.filter((r) => r.cuisine === c));
countBy("quick: <=20 min", selectable.filter((r) => r.timeMinutes <= 20));
countBy("high protein: >=25g", selectable.filter((r) => r.proteinGrams >= 25));
countBy("cheap: cost 1", selectable.filter((r) => r.approxCost === 1));
// The stacked filters are where a pool actually collapses.
for (const d of ["vegan", "keto"] as const)
  countBy(`diet: ${d} + <=20 min`, selectable.filter((r) => r.dietTags.includes(d) && r.timeMinutes <= 20));

// --- Sheet 4: Gaps — thin cells, worst first --------------------------------
// A week needs 7 dishes per slot with no repeat, so under 7 is a guaranteed repeat and
// under 14 gives a user almost no variety across a fortnight.
const gapHeaders = ["filter", "slot", "recipes available", "verdict"];
const gapRows: Cell[][] = [];
const verdict = (n: number) =>
  n === 0 ? "EMPTY — filter cannot be honored"
  : n < 7 ? "CRITICAL — fewer than 7, a week must repeat"
  : n < 14 ? "THIN — under two weeks of variety"
  : "ok";
for (const [label, pool] of [
  ["ALL", selectable] as const,
  ...DIETS.map((d) => [`diet: ${d}`, selectable.filter((r) => r.dietTags.includes(d))] as const),
  ...[...new Set(selectable.map((r) => r.cuisine))].sort().map(
    (c) => [`cuisine: ${c}`, selectable.filter((r) => r.cuisine === c)] as const),
]) {
  for (const t of TYPES) {
    const n = pool.filter((r) => r.type === t).length;
    gapRows.push([label, t, n, verdict(n)]);
  }
}
const rank = { "EMPTY — filter cannot be honored": 0, "CRITICAL — fewer than 7, a week must repeat": 1, "THIN — under two weeks of variety": 2, ok: 3 } as Record<string, number>;
gapRows.sort((a, b) => (rank[a[3] as string] - rank[b[3] as string]) || (a[2] as number) - (b[2] as number));

writeFileSync(OUT, workbook([
  sheet("Recipes", recipeHeaders, recipeRows,
    [90, 220, 80, 110, 100, 70, 70, 70, 60, 60, 85, 80, 65, 150, 65, 110,
     ...MICRO_KEYS.map(() => 90), 95, 420, 420, 300]),
  sheet("Ingredients", ingHeaders, ingRows, [200, 80, 140, 90, 65, 70, 300, 100]),
  sheet("Coverage", covHeaders, covRows, [200, 90, 90, 90, 90, 70]),
  sheet("Gaps", gapHeaders, gapRows, [180, 90, 120, 280]),
]));

console.log(`Wrote ${OUT}`);
console.log(`  Recipes     ${recipeRows.length} rows`);
console.log(`  Ingredients ${ingRows.length} rows`);
console.log(`  Coverage    ${covRows.length} rows`);
console.log(`  Gaps        ${gapRows.length} rows (${gapRows.filter((r) => r[3] !== "ok").length} not ok)`);
