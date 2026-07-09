/**
 * Training-data integrity check.  node scripts/check-data.mjs
 *
 * The model can only be as coherent as its labels. A silent truncation once deleted every
 * clarify example; a shortcut label once taught it that the word "macros" means "turn macro
 * preservation OFF". Both were invisible in the loss curve and obvious here.
 *
 * Fails loudly on:
 *  - the same user message labelled with two different tool sequences (contradiction)
 *  - null / undefined field values (the model copies them, then the schema rejects the turn)
 *  - fields that aren't in the operation schema (invented fields)
 *  - a tool with too few examples to learn, or a missing category
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rows = readFileSync(join(root, "data", "synthetic-log.jsonl"), "utf8")
  .trim().split("\n").map((l) => JSON.parse(l));

// Mirrors OperationSchema in src/lib/types.ts. Anything else is an invented field.
const FIELDS = new Set([
  "tool", "day", "mealType", "dish", "cuisine", "diet", "budget", "excludeFoods",
  "useIngredients", "targetCalories", "targetProtein", "targetCarbs", "targetFat",
  "targetFiber", "boostNutrient", "maxCookTime", "age", "heightCm", "weightKg", "sex",
  "activity", "goal", "loggedCalories", "loggedProtein", "preserveMacros", "estimatedCalories",
]);
const TOOLS = [
  "update_profile", "regenerate_week", "regenerate_day", "swap_meal",
  "compute_targets", "log_meal", "weekly_report", "eating_out", "explain_meal", "answer",
];
const MIN_PER_TOOL = 15;

const problems = [];
const counts = Object.fromEntries(TOOLS.map((t) => [t, 0]));
let clarify = 0;

for (const r of rows) {
  const ops = r.completion?.operations ?? [];
  if (!ops.length) clarify++;
  for (const op of ops) {
    if (!TOOLS.includes(op.tool)) problems.push(`unknown tool "${op.tool}" for: ${r.message}`);
    else counts[op.tool]++;
    for (const [k, v] of Object.entries(op)) {
      if (!FIELDS.has(k)) problems.push(`invented field "${k}" for: ${r.message}`);
      if (v === null || v === undefined) problems.push(`null field "${k}" for: ${r.message}`);
    }
    // A logged meal is a record of the past; it never carries a macro-preservation choice.
    if (op.tool === "log_meal" && "preserveMacros" in op)
      problems.push(`log_meal must not set preserveMacros: ${r.message}`);
    // The engine computes every number. A label that states one teaches the model to invent them.
    if (op.tool === "weekly_report" && Object.keys(op).length > 1)
      problems.push(`weekly_report takes no fields: ${r.message}`);
    // A restaurant meal is in the future: it has no dish in our library and no logged calories.
    if (op.tool === "eating_out" && ("dish" in op || "loggedCalories" in op))
      problems.push(`eating_out must not carry dish/loggedCalories: ${r.message}`);
    // Read-only tools take a location, never a change.
    if (op.tool === "explain_meal" && Object.keys(op).some((k) => !["tool", "day", "mealType"].includes(k)))
      problems.push(`explain_meal takes only day+mealType: ${r.message}`);
  }
}

// Contradiction: identical single-turn message, two different tool sequences.
const byMsg = new Map();
for (const r of rows) {
  if ((r.history?.length ?? 0) !== 1) continue;
  const key = r.history[0].text.toLowerCase().trim();
  const sig = JSON.stringify((r.completion?.operations ?? []).map((o) => o.tool));
  if (!byMsg.has(key)) byMsg.set(key, new Set());
  byMsg.get(key).add(sig);
}
for (const [msg, sigs] of byMsg)
  if (sigs.size > 1) problems.push(`contradictory labels for "${msg}": ${[...sigs].join(" VS ")}`);

for (const t of TOOLS) {
  if (t === "answer") continue; // "answer" is expressed as an empty operations list
  if (counts[t] < MIN_PER_TOOL) problems.push(`tool "${t}" has only ${counts[t]} examples (min ${MIN_PER_TOOL})`);
}
if (clarify < 30) problems.push(`only ${clarify} clarify/answer examples — the model will guess instead of asking`);

console.log(`rows: ${rows.length}   clarify/answer: ${clarify}`);
console.log(Object.entries(counts).map(([k, v]) => `  ${k.padEnd(17)} ${v}`).join("\n"));

const shown = [...new Set(problems)];
if (shown.length) {
  console.log(`\n${shown.length} PROBLEM(S):`);
  for (const p of shown.slice(0, 25)) console.log("  " + p);
  process.exit(1);
}
console.log("\nOK — no contradictions, no nulls, no invented fields.");
