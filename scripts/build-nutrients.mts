/**
 * Resolve the curated ingredient map against USDA SR Legacy, then VALIDATE it.
 *
 *   npm run build:nutrients          # report only
 *   npm run build:nutrients -- --emit  # also write src/lib/nutrientTable.generated.ts
 *
 * The accuracy gate: every recipe already carries hand-authored macros. Recomputing
 * those macros from the mapped ingredients + gram conversions must land close to them.
 * A large divergence means a bad ingredient mapping or a bad unit conversion — which is
 * how we validate 174 mappings without eyeballing each one.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RECIPES } from "@/lib/recipeDb";

// The bundled output lives in node_modules/.cache, so resolve paths from the project
// root (this script is always run via npm from the repo root), not from import.meta.url.
const ROOT = process.cwd();
const USDA = join(ROOT, "data", "usda", "FoodData_Central_sr_legacy_food_csv_2018-04");

// USDA nutrient ids -> our keys. Units: G, MG, UG, KCAL.
const NUTRIENTS: Record<string, { key: string; unit: string }> = {
  "1008": { key: "cal", unit: "KCAL" },
  "1003": { key: "protein", unit: "G" },
  "1004": { key: "fat", unit: "G" },
  "1005": { key: "carbs", unit: "G" },
  "1079": { key: "fiber", unit: "G" },
  "1087": { key: "calcium", unit: "MG" },
  "1089": { key: "iron", unit: "MG" },
  "1090": { key: "magnesium", unit: "MG" },
  "1092": { key: "potassium", unit: "MG" },
  "1093": { key: "sodium", unit: "MG" },
  "1095": { key: "zinc", unit: "MG" },
  "1114": { key: "vitD", unit: "UG" },
  "1162": { key: "vitC", unit: "MG" },
  "1177": { key: "folate", unit: "UG" },
  "1178": { key: "b12", unit: "UG" },
};

type Row = string[];
function parseCsv(text: string): Row[] {
  const rows: Row[] = [];
  let row: Row = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ---- load USDA foods -------------------------------------------------------
const foodRows = parseCsv(readFileSync(join(USDA, "food.csv"), "utf8"));
const fh = foodRows[0];
const [iId, iType, iDesc] = [fh.indexOf("fdc_id"), fh.indexOf("data_type"), fh.indexOf("description")];
const foods = foodRows.slice(1)
  .filter((r) => r.length > 2 && r[iType] === "sr_legacy_food")
  .map((r) => ({ fdcId: Number(r[iId]), desc: r[iDesc] }));

// ---- resolve the curated map ----------------------------------------------
const mapFile = JSON.parse(readFileSync(join(ROOT, "scripts", "ingredient-map.json"), "utf8"));
const unitFile = JSON.parse(readFileSync(join(ROOT, "scripts", "food-units.json"), "utf8"));
const CURATED: Record<string, { q?: string; id?: number; state?: string; negligible?: boolean }> = mapFile.map;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Exact-ish resolution: the curated query should match a real description closely. */
function resolve(q: string): { fdcId: number; desc: string; exact: boolean } | null {
  const nq = norm(q);
  let best: { fdcId: number; desc: string; score: number } | null = null;
  for (const f of foods) {
    const nd = norm(f.desc);
    let score = 0;
    if (nd === nq) score = 1000;
    else if (nd.startsWith(nq)) score = 500 - (nd.length - nq.length) * 0.1;
    else if (nd.includes(nq)) score = 300 - (nd.length - nq.length) * 0.1;
    else {
      const qt = nq.split(" ").filter((w) => w.length > 2);
      const hit = qt.filter((t) => nd.includes(t)).length;
      if (hit === qt.length && qt.length) score = 100 - (nd.length - nq.length) * 0.05;
    }
    if (score > 0 && (!best || score > best.score)) best = { fdcId: f.fdcId, desc: f.desc, score };
  }
  return best ? { fdcId: best.fdcId, desc: best.desc, exact: best.score >= 500 } : null;
}

const resolved = new Map<string, { fdcId: number; desc: string; exact: boolean; negligible: boolean }>();
const unresolved: string[] = [];
for (const [ing, spec] of Object.entries(CURATED)) {
  if (spec.id) { resolved.set(ing, { fdcId: spec.id, desc: "(pinned)", exact: true, negligible: !!spec.negligible }); continue; }
  const r = spec.q ? resolve(spec.q) : null;
  if (r) resolved.set(ing, { ...r, negligible: !!spec.negligible });
  else unresolved.push(ing);
}

// ---- pull nutrients for the resolved fdc_ids -------------------------------
const wanted = new Set([...resolved.values()].map((r) => r.fdcId));
const per100 = new Map<number, Record<string, number>>();
const fnText = readFileSync(join(USDA, "food_nutrient.csv"), "utf8");
for (const line of fnText.split("\n")) {
  if (!line || line[0] === '"' === false) { /* keep going */ }
  const parts = line.split(",");
  if (parts.length < 4) continue;
  const fdc = Number(parts[1].replace(/"/g, ""));
  if (!wanted.has(fdc)) continue;
  const nid = parts[2].replace(/"/g, "");
  const spec = NUTRIENTS[nid];
  if (!spec) continue;
  const amt = Number(parts[3].replace(/"/g, ""));
  if (!Number.isFinite(amt)) continue;
  if (!per100.has(fdc)) per100.set(fdc, {});
  per100.get(fdc)![spec.key] = amt;
}

// ---- quantity -> grams -----------------------------------------------------
function gramsFor(ingredient: string, quantity: string): number | null {
  const m = quantity.trim().match(/^(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+))?\s*([a-zA-Z-]+)?/);
  if (!m) return null;
  const amount = m[2] ? Number(m[1]) / Number(m[2]) : Number(m[1]);
  if (!Number.isFinite(amount)) return null;
  const unit = (m[3] ?? "count").toLowerCase();
  const over = unitFile.perIngredient[ingredient] ?? {};
  const g = over[unit] ?? unitFile.default[unit];
  if (g == null) return null;
  return amount * g;
}

// ---- ACCURACY GATE: recompute recipe macros from ingredients ---------------
const MACROS = ["cal", "protein", "carbs", "fat"] as const;
type Diff = { name: string; got: Record<string, number>; want: Record<string, number>; err: number };
const diffs: Diff[] = [];
const missingIng = new Map<string, number>();
const badUnit = new Map<string, number>();
let fullyCovered = 0;

for (const r of RECIPES) {
  let covered = true;
  const got: Record<string, number> = { cal: 0, protein: 0, carbs: 0, fat: 0 };
  for (const ing of r.ingredients) {
    const key = ing.name.trim().toLowerCase();
    const res = resolved.get(key);
    if (!res) { missingIng.set(key, (missingIng.get(key) ?? 0) + 1); covered = false; continue; }
    const g = gramsFor(key, ing.quantity);
    if (g == null) { badUnit.set(`${key} :: ${ing.quantity}`, 1); covered = false; continue; }
    const n = per100.get(res.fdcId);
    if (!n) { covered = false; continue; }
    for (const k of MACROS) got[k] += ((n[k] ?? 0) * g) / 100;
  }
  if (!covered) continue;
  // A batch recipe's ingredients make several servings; its macros are per serving.
  const per = Math.max(1, (r as { servings?: number }).servings ?? 1);
  if (per !== 1) for (const k of MACROS) got[k] /= per;
  fullyCovered++;
  const want = { cal: r.calories, protein: r.proteinGrams, carbs: r.carbsGrams, fat: r.fatGrams };
  const err = Math.abs(got.cal - want.cal) / Math.max(want.cal, 1);
  diffs.push({ name: r.name, got, want, err });
}

// ---- report ----------------------------------------------------------------
console.log(`USDA foods loaded          : ${foods.length}`);
console.log(`curated ingredients        : ${Object.keys(CURATED).length}`);
console.log(`resolved to an fdc_id      : ${resolved.size}  (exact: ${[...resolved.values()].filter((r) => r.exact).length})`);
console.log(`with nutrient rows         : ${[...resolved.values()].filter((r) => per100.has(r.fdcId)).length}`);
if (unresolved.length) console.log(`UNRESOLVED queries         : ${unresolved.length} -> ${unresolved.slice(0, 12).join(", ")}`);
console.log(`recipes fully covered      : ${fullyCovered}/${RECIPES.length}`);

if (missingIng.size) {
  console.log(`\n--- ingredients with no mapping (top) ---`);
  for (const [k, c] of [...missingIng.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${String(c).padStart(3)}  ${k}`);
}
if (badUnit.size) {
  console.log(`\n--- quantities we could not convert (top) ---`);
  for (const k of [...badUnit.keys()].slice(0, 15)) console.log(`  ${k}`);
}

// Audit: what did the highest-usage ingredients actually resolve to? Traceability is the
// whole point — a wrong mapping here silently poisons every nutrient number downstream.
if (process.argv.includes("--audit")) {
  const usage = new Map<string, number>();
  for (const r of RECIPES) for (const i of r.ingredients) {
    const k = i.name.trim().toLowerCase();
    usage.set(k, (usage.get(k) ?? 0) + 1);
  }
  console.log(`\n--- AUDIT: top-usage ingredient -> chosen USDA food ---`);
  for (const [k, c] of [...usage.entries()].sort((a, b) => b[1] - a[1]).slice(0, 28)) {
    const r = resolved.get(k);
    const n = r ? per100.get(r.fdcId) : undefined;
    console.log(`${String(c).padStart(3)}x ${k.padEnd(20)} -> ${r ? `${r.fdcId} ${r.desc}` : "!! UNMAPPED"}${n ? `  [${Math.round(n.cal ?? 0)} kcal/100g]` : ""}`);
  }
}

if (diffs.length) {
  const errs = diffs.map((d) => d.err).sort((a, b) => a - b);
  const median = errs[Math.floor(errs.length / 2)];
  const within20 = errs.filter((e) => e <= 0.2).length;
  console.log(`\n=== ACCURACY GATE (calories, ${diffs.length} fully-covered recipes) ===`);
  console.log(`median abs error : ${(median * 100).toFixed(1)}%`);
  console.log(`within 20%       : ${within20}/${diffs.length}`);
  console.log(`\n--- worst 12 (likely bad mapping or unit) ---`);
  for (const d of [...diffs].sort((a, b) => b.err - a.err).slice(0, 12))
    console.log(`  ${(d.err * 100).toFixed(0).padStart(4)}%  ${d.name.padEnd(42)} got ${d.got.cal.toFixed(0)} kcal / want ${d.want.cal}`);
}

// ---- emit ------------------------------------------------------------------
if (process.argv.includes("--emit")) {
  const table: Record<string, unknown> = {};
  for (const [ing, r] of resolved) {
    const n = per100.get(r.fdcId);
    if (!n) continue;
    table[ing] = { fdcId: r.fdcId, desc: r.desc, per100g: n };
  }
  // Emit the unit table alongside so src/ has a single generated source of truth and cannot
  // drift from scripts/food-units.json.
  const out =
    `// GENERATED by scripts/build-nutrients.mts from USDA FoodData Central SR Legacy.\n` +
    `// Do not edit by hand — run \`npm run build:nutrients -- --emit\`.\n` +
    `// Every entry records the fdc_id it came from, so every nutrient value is traceable.\n\n` +
    `export interface Per100g {\n  cal?: number; protein?: number; carbs?: number; fat?: number; fiber?: number;\n  calcium?: number; iron?: number; magnesium?: number; potassium?: number; sodium?: number;\n  zinc?: number; vitD?: number; vitC?: number; folate?: number; b12?: number;\n}\n\n` +
    `export const NUTRIENT_TABLE: Record<string, { fdcId: number; desc: string; per100g: Per100g }> = ${JSON.stringify(table, null, 2)};\n\n` +
    `export const UNIT_GRAMS: { default: Record<string, number>; perIngredient: Record<string, Record<string, number>> } = ${JSON.stringify(
      { default: unitFile.default, perIngredient: unitFile.perIngredient },
      null,
      2,
    )};\n`;
  writeFileSync(join(ROOT, "src", "lib", "nutrientTable.generated.ts"), out, "utf8");
  console.log(`\nwrote src/lib/nutrientTable.generated.ts (${Object.keys(table).length} ingredients)`);
}
