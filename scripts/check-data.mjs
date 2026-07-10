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
 *  - a training message that is VERBATIM an eval case
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rows = readFileSync(join(root, "data", "synthetic-log.jsonl"), "utf8")
  .trim().split("\n").map((l) => JSON.parse(l));

// A model that has already seen the eval question cannot be measured by it. On 2026-07-10, 24 of
// the 56 eval cases were verbatim training strings — "i'm always tired", "make it better", "i need
// more b12" — so every score from v4 to v7 was part memorization. Held out means held out.
// Near-duplicates are fine, and wanted: "pizza for breakfast" in training against "pizza for lunch"
// in the eval asks whether the model reads the sentence. An identical string asks nothing.
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
const evalMsgs = new Set(
  JSON.parse(readFileSync(join(root, "data", "eval-cases.json"), "utf8")).cases.map((c) => norm(c.msg)),
);

// Mirrors OperationSchema in src/lib/types.ts. Anything else is an invented field.
const FIELDS = new Set([
  "tool", "day", "mealType", "dish", "cuisine", "diet", "budget", "excludeFoods",
  "useIngredients", "targetCalories", "targetProtein", "targetCarbs", "targetFat",
  "targetFiber", "boostNutrient", "maxCookTime", "age", "heightCm", "weightKg", "sex",
  "activity", "goal", "loggedCalories", "loggedProtein", "preserveMacros", "estimatedCalories",
  "ingredient", "symptom",
]);
const TOOLS = [
  "update_profile", "regenerate_week", "regenerate_day", "swap_meal",
  "compute_targets", "log_meal", "weekly_report", "eating_out", "explain_meal",
  "substitute_ingredient", "symptom_check", "lock_meal", "unlock_meal", "answer",
];
const MIN_PER_TOOL = 15;

// Fields without which a tool call is useless. The model learned "omit what you don't mean" so
// well that it started emitting {"tool":"compute_targets"} with no body at all — the right tool,
// carrying nothing. A label that does the same teaches exactly that, so labels are checked here.
const REQUIRED = {
  compute_targets: ["age", "heightCm", "weightKg", "sex", "activity", "goal"],
  swap_meal: ["day", "dish"],
  log_meal: ["day", "mealType"],
  eating_out: ["day", "mealType"],
  explain_meal: ["day", "mealType"],
  lock_meal: ["day", "mealType"],
  unlock_meal: ["day", "mealType"],
  substitute_ingredient: ["ingredient"],
  symptom_check: ["symptom"],
  regenerate_day: ["day"],
};

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
    // The model must pass the user's words through, never a nutrient it guessed itself.
    if (op.tool === "symptom_check" && Object.keys(op).some((k) => !["tool", "symptom"].includes(k)))
      problems.push(`symptom_check takes only the reported symptom: ${r.message}`);
    for (const f of REQUIRED[op.tool] ?? [])
      if (!(f in op)) problems.push(`${op.tool} is missing required field "${f}": ${r.message}`);
    // A pin names a SLOT. The dish it holds is whatever is in that slot; the model never picks it.
    if ((op.tool === "lock_meal" || op.tool === "unlock_meal") &&
        Object.keys(op).some((k) => !["tool", "day", "mealType"].includes(k)))
      problems.push(`${op.tool} takes only day+mealType: ${r.message}`);
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

// A slot-carrying message must not name a meal it isn't about. "Friday breakfast is at a work
// dinner" was generated by crossing a random slot with a venue containing the word "dinner". Two
// such examples were enough to teach the model that the meal word in a sentence can be ignored,
// and it duly answered "breakfast" to "i ate pizza for lunch on monday".
const MEAL_WORDS = ["breakfast", "lunch", "dinner"];
for (const r of rows) {
  const msg = (r.message ?? "").toLowerCase();
  for (const op of r.completion?.operations ?? []) {
    if (!op.mealType) continue;
    const named = MEAL_WORDS.filter((w) => new RegExp(`\\b${w}\\b`).test(msg));
    if (named.length && !named.includes(op.mealType))
      problems.push(`says "${named.join('/')}" but labelled ${op.mealType}: ${r.message}`);
    else if (named.length > 1)
      problems.push(`names two meals (${named.join('/')}), slot is ambiguous: ${r.message}`);
  }
}

// Eval contamination. Every hit here is a case that measures recall, not skill.
let contaminated = 0;
for (const r of rows) {
  const msg = r.message ?? r.history?.[r.history.length - 1]?.text;
  if (msg && evalMsgs.has(norm(msg))) {
    contaminated++;
    problems.push(`TRAINS ON AN EVAL CASE: "${msg}" — the eval no longer measures anything here`);
  }
}

for (const t of TOOLS) {
  if (t === "answer") continue; // "answer" is expressed as an empty operations list
  if (counts[t] < MIN_PER_TOOL) problems.push(`tool "${t}" has only ${counts[t]} examples (min ${MIN_PER_TOOL})`);
}
if (clarify < 30) problems.push(`only ${clarify} clarify/answer examples — the model will guess instead of asking`);

console.log(`rows: ${rows.length}   clarify/answer: ${clarify}   eval collisions: ${contaminated}`);
console.log(Object.entries(counts).map(([k, v]) => `  ${k.padEnd(17)} ${v}`).join("\n"));

const shown = [...new Set(problems)];
if (shown.length) {
  console.log(`\n${shown.length} PROBLEM(S):`);
  for (const p of shown.slice(0, 25)) console.log("  " + p);
  process.exit(1);
}
console.log("\nOK — no contradictions, no nulls, no invented fields, no eval leakage.");
