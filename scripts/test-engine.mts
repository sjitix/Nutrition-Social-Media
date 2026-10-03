/**
 * Engine test suite — scenarios + invariants + fuzzer.
 *
 *   npm run test:engine
 *
 * Three layers:
 *  1. SCENARIOS  — user-perspective behaviours ("swap breakfast but keep me lean").
 *  2. INVARIANTS — properties that must hold after ANY operation, ever.
 *  3. FUZZ       — random operation sequences; invariants are asserted after each.
 *
 * The fuzzer exists to break the engine, not to flatter it. Hard constraints
 * (diet, allergies, exclusions, cook time) are rules, not suggestions — a violation
 * is a bug, and this file is where we find it before a user does.
 */
import { selectWeekFromDb, rebalanceWeek, applyOperations, RECIPES, recipeMicros, newReport, reportNotes, selectConditionAwareWeek, buildWeek, selectBatchWeek, rebalanceBatchWeek, withSeed, keepDays, freezesWell, previewOperations, swapCandidates } from "@/lib/recipeDb";
import { conditionBoosts } from "@/lib/conditions";
import type { UserProfile, Operation, DayPlan, WeekPlan, Meal } from "@/lib/types";
import { MealSchema, WeekPlanSchema } from "@/lib/types";
import { FEED_RECIPES, filterFeed, sortFeed, HIGH_PROTEIN_G, type FeedFilter } from "@/lib/feed";
import { videoPlatform, extractVideoText } from "@/lib/videoImport";
import { aisleFor, groupByAisle, AISLE_ORDER } from "@/lib/grocery";
import { currentStreak, prevDay, isoDay } from "@/lib/streak";
import { expandConstrain, applyRemember, applyPrimitives, memoryContext, AssistantTurnV2Schema, allergensInFact, type PrimitiveOp } from "@/lib/primitives";
import { assistantV2SystemPrompt } from "@/lib/promptV2";
import { redFlag, CRISIS_REPLY } from "@/lib/safety";
import { tableKey, INGREDIENTS, resolveIngredient } from "@/lib/data/ingredients";
import { validateExample, validateBatch, type TrainingExample } from "@/lib/dataValidate";
import { generateExamples } from "@/lib/genV2";
import { microsForIngredients } from "@/lib/nutrients";
import { bulkGroceriesFromWeek, formatBulkQuantity, batchEfficiency } from "@/lib/batchGrocery";
import { haystackBlocked, dietTagConflicts, parseExclusionTokens, expandExclusion, EXCLUSION_CATEGORIES } from "@/lib/exclusions";
import { bmr, computeTargets, hydrationTarget, CALORIE_FLOOR, DEFAULT_CALORIE_FLOOR, BODY_LIMITS, bodyStatMessage, referenceWeightKg } from "@/lib/targets";
import { composeReply, planWasChanged, describeOperations, READ_ONLY_TOOLS, claimsChange, NOTHING_CHANGED_REPLY } from "@/lib/reply";
import { SUBSTITUTES } from "@/lib/substitutions";
import { NUTRIENT_TABLE } from "@/lib/nutrientTable.generated";
import { UNIT_GRAMS } from "@/lib/unitGrams.generated";
import { readFileSync } from "node:fs";
import { gramsFor } from "@/lib/nutrients";
import { MICRO_KEYS, DAILY_REFERENCE, MICRO_LABEL } from "@/lib/nutrients";
import { parseRecipeHtml, parseIngredient, isSafePublicUrl, importedToMeal, decodeEntities } from "@/lib/import";
import {
  findRecipes, inspectRecipe, getPlan, getProfile, getSaved, report, whatIf,
  runReadTool, isReadTool, READ_TOOL_NAMES, MAX_ROWS,
} from "@/lib/agentTools";
import { runAgent, MAX_STEPS, FALSE_CLAIM_NUDGE, type AgentTurn, type ModelFn } from "@/lib/agentLoop";

// ---------------------------------------------------------------- harness
let pass = 0;
let fail = 0;
const failures: string[] = [];
const check = (label: string, cond: boolean, detail = "") => {
  if (cond) {
    pass++;
    console.log(`PASS  ${label}${detail ? "  — " + detail : ""}`);
  } else {
    fail++;
    failures.push(`${label}${detail ? "  — " + detail : ""}`);
    console.log(`FAIL  ${label}${detail ? "  — " + detail : ""}`);
  }
};

const BASE: UserProfile = {
  goal: "maintain", diet: "none", allergies: "", dislikes: "", budget: "medium",
  mealsPerDay: 3, targetCalories: 2000, proteinGrams: 150, carbsGrams: 200,
  fatGrams: 65, maxCookTime: 30, maxIngredients: 8,
};

const op = (o: Partial<Operation>): Operation =>
  ({
    tool: "answer", day: null, mealType: null, dish: null, cuisine: null, diet: null,
    budget: null, excludeFoods: [], targetCalories: null, targetProtein: null,
    targetCarbs: null, targetFat: null, targetFiber: null, maxCookTime: null, ...o,
  }) as Operation;

const kcal = (d: DayPlan) => d.meals.reduce((s, m) => s + m.calories, 0);
const prot = (d: DayPlan) => d.meals.reduce((s, m) => s + m.proteinGrams, 0);
const carbsOf = (d: DayPlan) => d.meals.reduce((s, m) => s + m.carbsGrams, 0);
const fatOf = (d: DayPlan) => d.meals.reduce((s, m) => s + m.fatGrams, 0);
const names = (d: DayPlan) => d.meals.map((m) => m.name).join(" | ");
const freshWeek = (p: UserProfile) => rebalanceWeek(selectWeekFromDb(p), p);


// Recompute a week's average for one micronutrient, so tests never trust the engine's own note.
function weekMicroAverage2(plan: WeekPlan, key: (typeof MICRO_KEYS)[number]): number {
  let total = 0;
  for (const d of plan.days)
    for (const m of d.meals)
      total += microsForIngredients(m.ingredients).micros[key] / Math.max(1, m.servings ?? 1);
  return total / (plan.days.length || 1);
}

// ---------------------------------------------------------------- invariants
const recipeByName = new Map(RECIPES.map((r) => [r.name.toLowerCase(), r]));

function dietOk(dietTags: string[], diet: UserProfile["diet"]): boolean {
  switch (diet) {
    case "none": return true;
    case "vegan": return dietTags.includes("vegan");
    case "vegetarian": return dietTags.includes("vegetarian") || dietTags.includes("vegan");
    case "keto": return dietTags.includes("keto");
    case "mediterranean": return dietTags.includes("mediterranean");
    default: return true;
  }
}

const tokensOf = (p: UserProfile) =>
  [p.allergies, p.dislikes].join(",").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);

const mealHay = (m: Meal) =>
  `${m.name} ${m.ingredients.map((i) => i.name).join(" ")} ${m.steps.join(" ")}`.toLowerCase();

const recipeHay = (r: (typeof RECIPES)[number]) =>
  `${r.name} ${r.ingredients.map((i) => i.name).join(" ")} ${r.steps.join(" ")}`.toLowerCase();

/**
 * Does a recipe of this type exist that satisfies the HARD rules AND the cook-time
 * limit? If not, the engine relaxing cook time is unavoidable (better a slower meal
 * than no dinner) and I7 must not flag it. This keeps I7 honest, not lenient.
 */
const compliantExists = (type: Meal["type"], diet: UserProfile["diet"], tokens: string[], maxCook: number) =>
  RECIPES.some(
    (r) =>
      r.type === type &&
      !r.treatOnly && // the planner is FORBIDDEN to use treats, so they are not alternatives
      dietOk(r.dietTags, diet) &&
      !tokens.some((t) => recipeHay(r).includes(t)) &&
      r.timeMinutes <= maxCook + 5,
  );

/**
 * Can the day's chosen recipes even reach the calorie target within the 0.6–1.8x clamp?
 * A meal of `lockedType` (the dish the user explicitly swapped in) is FIXED — it cannot
 * be rescaled — so it contributes its exact calories and narrows the reachable range.
 */
function calorieReachable(d: DayPlan, targetCal: number, lockedTypes?: ReadonlySet<Meal["type"]>): boolean {
  let lo = 0;
  let hi = 0;
  for (const m of d.meals) {
    if (lockedTypes?.has(m.type)) {
      lo += m.calories;
      hi += m.calories;
      continue;
    }
    const base = recipeByName.get(m.name.toLowerCase());
    if (!base) return true; // can't judge; don't flag
    lo += base.calories * 0.6;
    hi += base.calories * 1.8;
  }
  return targetCal >= lo && targetCal <= hi;
}

/**
 * Properties that must hold after ANY operation.
 * `dayDiet` records per-day diet overrides (regenerate_day applies a diet to ONE day
 * without persisting it), so a day is judged against its own effective diet.
 */
function invariants(
  plan: WeekPlan,
  p: UserProfile,
  macrosKept: boolean,
  dayDiet: Record<string, UserProfile["diet"]> = {},
  locked?: { day: string; type: Meal["type"] },
  // Days put into "treat" state by a preserveMacros:false swap. They are SUPPOSED to be off
  // target — that is the whole point of a cheat day — so I5 must not judge them until a
  // macro-preserving operation touches them again.
  treatDays: Set<string> = new Set(),
): string[] {
  const v: string[] = [];
  const tokens = tokensOf(p);
  // A DISLIKE of olives is not a dislike of olive oil, the cooking fat (nor of peppers black pepper,
  // nor of cherries cherry tomatoes): the engine's rule since the D5b review, when a dislike of olives
  // removed 203 of 501 recipes. An ALLERGY keeps the over-block, so only dislikes are exempted here.
  const dislikeTokens = new Set((p.dislikes ?? "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean));
  const NOT_MEMBERS: Record<string, string[]> = {
    olive: ["olive oil"], olives: ["olive oil"], pepper: ["black pepper", "white pepper"], peppers: ["black pepper", "white pepper"],
    cherry: ["cherry tomato"], cherries: ["cherry tomato"],
  };
  for (const d of plan.days) {
    const effectiveDiet = dayDiet[d.day] ?? p.diet;
    // A pinned meal is an explicit instruction by name. It outranks PREFERENCES (cook time), and
    // is a fixed point for the calorie solver — but it may never break diet or an allergy, which
    // is why I1/I2 below make no exception for it.
    const pinned = new Set((p.lockedMeals ?? []).filter((l) => l.day === d.day).map((l) => l.mealType));
    if (d.meals.length !== p.mealsPerDay)
      v.push(`I3 ${d.day}: ${d.meals.length} meals, expected ${p.mealsPerDay}`);

    const seen = new Set<string>();
    for (const m of d.meals) {
      if (seen.has(m.name)) v.push(`I4 ${d.day}: duplicate dish "${m.name}"`);
      seen.add(m.name);

      const hay = mealHay(m);
      for (const t of tokens) {
        const h = dislikeTokens.has(t) ? (NOT_MEMBERS[t] ?? []).reduce((acc, ex) => acc.split(ex).join(" "), hay) : hay;
        if (h.includes(t)) v.push(`I2 ${d.day} "${m.name}": contains excluded/allergen "${t}"`);
      }

      // Only a violation if a compliant recipe actually existed to choose instead — and never for
      // a meal the user pinned by name.
      if (
        !pinned.has(m.type) &&
        m.timeMinutes > p.maxCookTime + 5 &&
        compliantExists(m.type, effectiveDiet, tokens, p.maxCookTime)
      )
        v.push(`I7 ${d.day} "${m.name}": ${m.timeMinutes}min > maxCookTime ${p.maxCookTime}+5`);

      const base = recipeByName.get(m.name.toLowerCase());
      if (base) {
        if (!dietOk(base.dietTags, effectiveDiet)) v.push(`I1 ${d.day} "${m.name}": violates diet=${effectiveDiet}`);
        const f = m.calories / base.calories;
        if (f < 0.58 || f > 1.82) v.push(`I6 ${d.day} "${m.name}": portion scale ${f.toFixed(2)} out of [0.6,1.8]`);
      }
    }

    // Only a violation if the target was physically reachable by portion scaling, and this
    // day isn't a deliberate treat day.
    const fixedHere = new Set(pinned);
    if (locked && locked.day === d.day) fixedHere.add(locked.type);
    const lockedHere = fixedHere.size ? fixedHere : undefined;
    if (macrosKept && !treatDays.has(d.day) && calorieReachable(d, p.targetCalories, lockedHere)) {
      const c = kcal(d);
      if (Math.abs(c - p.targetCalories) > p.targetCalories * 0.15) {
        // Include the scale factor each meal ended on: 1.80 means the clamp bound it.
        const detail = d.meals
          .map((m) => {
            const b = recipeByName.get(m.name.toLowerCase());
            const g = b ? (m.calories / b.calories).toFixed(2) : "?";
            return `${m.type}${lockedHere?.has(m.type) ? "*" : ""}=${m.calories}kcal(x${g})`;
          })
          .join(" ");
        v.push(`I5 ${d.day}: ${c} kcal vs target ${p.targetCalories} (>15% off) [${detail}]`);
      }
    }
  }
  return v;
}

// ---------------------------------------------------------------- 1. scenarios
console.log("\n--- SCENARIOS (user perspective) ---");
{
  const wk = freshWeek(BASE);
  check("initial week: every day within ±120 kcal of 2000", wk.days.every((d) => Math.abs(kcal(d) - 2000) <= 120), `[${wk.days.map(kcal)}]`);
  check("initial week: protein >= 130g every day", wk.days.every((d) => prot(d) >= 130), `[${wk.days.map(prot)}]`);
}
{
  // "I want oatmeal for breakfast, but keep me on my macros."
  const wk = freshWeek(BASE);
  const r = applyOperations(BASE, wk, [op({ tool: "swap_meal", day: "Monday", mealType: "breakfast", dish: "oatmeal" })]);
  const d = r.plan.days.find((x) => x.day === "Monday")!;
  check("swap: requested dish is present", names(d).toLowerCase().includes("oat"), names(d));
  check("swap: calories held (±120)", Math.abs(kcal(d) - 2000) <= 120, `${kcal(d)} kcal`);
  check("swap: protein recovered (>=138g)", prot(d) >= 138, `${prot(d)}g`);
  check("swap: emits an honest macro note (discloses the day's actuals, not a blanket 'on target')",
    r.notes.length === 1 && /protein/.test(r.notes[0]) && /Monday now has/.test(r.notes[0]) && !/Kept Monday on target/.test(r.notes[0]),
    r.notes[0] ?? "(none)");
}
{
  // Executor write-path guards (adversarial review): a swap to a slot the day/week does NOT have must
  // not fabricate success, and a negative/absurd calorie number must not poison the plan. BASE is a
  // 3-meal plan, so no "snack" slot exists; "edamame" matches a real snack recipe (match.type=snack).
  const wk = freshWeek(BASE);
  const s1 = applyOperations(BASE, wk, [op({ tool: "swap_meal", day: "Tuesday", mealType: "snack", dish: "edamame" })]);
  const t = s1.plan.days.find((x) => x.day === "Tuesday")!;
  check("swap to a slot the day lacks adds nothing", t.meals.length === 3 && !t.meals.some((m) => m.type === "snack"));
  check("swap to a slot the day lacks says so, no false 'now has'",
    s1.notes.some((n) => /don't have a snack/i.test(n)) && !s1.notes.some((n) => /now has/i.test(n)), s1.notes.join(" | "));
  const s2 = applyOperations(BASE, wk, [op({ tool: "swap_meal", mealType: "snack", dish: "edamame" })]);
  check("whole-week swap to a missing slot changes nothing", s2.plan.days.every((d) => d.meals.length === 3));
  check("whole-week swap to a missing slot never claims 'every day'",
    s2.notes.some((n) => /none of your days have a snack/i.test(n)) && !s2.notes.some((n) => /every day/i.test(n)), s2.notes.join(" | "));
  const s3 = applyOperations(BASE, wk, [op({ tool: "log_meal", day: "Monday", mealType: "lunch", dish: "zxcvbnm mystery", loggedCalories: -500 } as never)]);
  const md = s3.plan.days.find((x) => x.day === "Monday")!;
  check("log_meal never creates a negative-calorie meal", md.meals.every((mm) => mm.calories > 0));
  check("log_meal with a bad number asks instead of poisoning the day", s3.notes.some((n) => /how many calories/i.test(n)), s3.notes.join(" | "));
  const s4 = applyOperations(BASE, wk, [op({ tool: "eating_out", day: "Wednesday", mealType: "dinner", estimatedCalories: -300 })]);
  const wd = s4.plan.days.find((x) => x.day === "Wednesday")!;
  check("eating_out ignores a negative estimate (sane reserve)", wd.meals.every((mm) => mm.calories > 0));
}
{
  // "It's my cheat day." -> engine must NOT touch the other meals.
  const wk = freshWeek(BASE);
  const before = wk.days.find((x) => x.day === "Tuesday")!;
  const lunchB = before.meals.find((m) => m.type === "lunch")!.name;
  const r = applyOperations(BASE, wk, [op({ tool: "swap_meal", day: "Tuesday", mealType: "breakfast", dish: "pizza", preserveMacros: false })]);
  const d = r.plan.days.find((x) => x.day === "Tuesday")!;
  check("treat mode: other meals untouched", d.meals.find((m) => m.type === "lunch")!.name === lunchB);
  // A substitution disclosure IS allowed in treat mode; a *macro* note is not.
  check("treat mode: no macro-rebalance note", !r.notes.some((n) => /on target/.test(n)), r.notes.join(" | ") || "(none)");
}
{
  // "Set my protein to 200."
  const wk = freshWeek(BASE);
  const avgB = Math.round(wk.days.reduce((s, d) => s + prot(d), 0) / 7);
  const r = applyOperations(BASE, wk, [op({ tool: "update_profile", targetProtein: 200 })]);
  const avgA = Math.round(r.plan.days.reduce((s, d) => s + prot(d), 0) / 7);
  check("targetProtein=200 raises avg protein + persists", avgA > avgB + 8 && r.profile.proteinGrams === 200, `${avgB} -> ${avgA}`);
}
{
  // EDIT PRESERVATION — a week-wide change keeps the plan the user built. The re-solve used to
  // rebuild the week from scratch, silently discarding every dish the user had swapped in; it now
  // keeps each dish that still passes the CHANGED rules and re-picks only the slots that now break.
  const wk = freshWeek(BASE);
  const before = wk.days.flatMap((d) => d.meals.map((m) => m.name));

  // (A) A pure TARGET change touches no dish's eligibility, so every dish is kept and only the
  // portions re-scale. A from-scratch rebuild would reshuffle the whole week.
  const calShift = applyOperations(BASE, wk, [op({ tool: "update_profile", targetCalories: BASE.targetCalories + 150 })]);
  const afterCal = calShift.plan.days.flatMap((d) => d.meals.map((m) => m.name));
  const keptCal = before.filter((n, i) => n === afterCal[i]).length;
  check("update_profile (calorie change) keeps the dishes the user already had",
    keptCal >= before.length - 3, `${keptCal}/${before.length} dishes preserved`);

  // (B) A dish the user SWAPPED in survives a later, unrelated week-wide change.
  const swap = applyOperations(BASE, wk, [op({ tool: "swap_meal", day: "Monday", mealType: "lunch", dish: "chicken" })]);
  const swappedLunch = swap.plan.days.find((d) => d.day === "Monday")!.meals.find((m) => m.type === "lunch")!.name;
  const afterBenign = applyOperations(BASE, swap.plan, [op({ tool: "update_profile", excludeFoods: ["zzznotafood"] })]);
  const lunchAfter = afterBenign.plan.days.find((d) => d.day === "Monday")!.meals.find((m) => m.type === "lunch")!.name;
  check("a swapped-in dish survives a later unrelated week-wide change", lunchAfter === swappedLunch, `${swappedLunch} -> ${lunchAfter}`);

  // (C) A change a dish DOES violate replaces just that dish, while dishes that were already
  // compliant stay in place (position-identical), not reshuffled.
  const meatIn = applyOperations(BASE, wk, [op({ tool: "swap_meal", day: "Monday", mealType: "lunch", dish: "chicken" })]);
  const meatLunch = meatIn.plan.days.find((d) => d.day === "Monday")!.meals.find((m) => m.type === "lunch")!.name;
  const beforeVeg = meatIn.plan.days.flatMap((d) => d.meals.map((m) => m.name));
  const veg = applyOperations(BASE, meatIn.plan, [op({ tool: "update_profile", diet: "vegetarian" })]);
  const afterVeg = veg.plan.days.flatMap((d) => d.meals.map((m) => m.name));
  const monLunchVeg = veg.plan.days.find((d) => d.day === "Monday")!.meals.find((m) => m.type === "lunch")!.name;
  const allVeg = veg.plan.days.every((d) => d.meals.every((m) => {
    const rr = recipeByName.get(m.name.toLowerCase());
    return rr ? dietOk(rr.dietTags, "vegetarian") : true;
  }));
  let keptVeg = 0, wereVeg = 0;
  for (let i = 0; i < beforeVeg.length; i++) {
    const rr = recipeByName.get(beforeVeg[i].toLowerCase());
    if (rr && dietOk(rr.dietTags, "vegetarian")) { wereVeg++; if (afterVeg[i] === beforeVeg[i]) keptVeg++; }
  }
  check("go vegetarian replaces the violating meat dish", monLunchVeg !== meatLunch, `${meatLunch} -> ${monLunchVeg}`);
  check("go vegetarian: the whole week is vegetarian", allVeg);
  // One random week decides nothing here: how many vegetarian dishes survive varies week to week.
  // Measured over 60 seeded weeks (2026-10-03): 64% kept on average, with 1-2 weeks in 60 below half,
  // both before and after D5b. So this check, judged on one unseeded week, failed a ship gate at 3/8.
  // It is judged on the total over this week plus ten seeded ones.
  let keptAll = keptVeg, wereAll = wereVeg;
  for (let s = 0; s < 10; s++)
    withSeed(300 + s, () => {
      const w0 = applyOperations(BASE, freshWeek(BASE), [op({ tool: "swap_meal", day: "Monday", mealType: "lunch", dish: "chicken" })]).plan;
      const b0 = w0.days.flatMap((d) => d.meals.map((m) => m.name));
      const a0 = applyOperations(BASE, w0, [op({ tool: "update_profile", diet: "vegetarian" })]).plan.days.flatMap((d) => d.meals.map((m) => m.name));
      b0.forEach((n, i) => {
        const rr = recipeByName.get(n.toLowerCase());
        if (rr && dietOk(rr.dietTags, "vegetarian")) { wereAll++; if (a0[i] === n) keptAll++; }
      });
    });
  check("go vegetarian: already-vegetarian dishes are kept, not reshuffled (over 11 weeks)",
    keptAll >= Math.ceil(wereAll * 0.5), `${keptAll}/${wereAll} veg dishes preserved`);
}
{
  // === MEAL-PREP / BATCH MODE (M1) ===
  // Fresh path must be byte-identical through buildWeek (no regression). Seed BOTH the same so the
  // one random tiebreak in selection lines up (rebalance has no RNG); buildWeek's fresh branch IS
  // rebalanceWeek(selectWeekFromDb(...)).
  const freshA = withSeed(1, () => JSON.stringify(rebalanceWeek(selectWeekFromDb(BASE), BASE)));
  const freshB = withSeed(1, () => JSON.stringify(buildWeek(BASE)));
  check("batch: fresh path via buildWeek is byte-identical (no fresh regression)", freshA === freshB);

  const bp: UserProfile = { ...BASE, planMode: "batch", batchCadence: "every3days" };
  const w = buildWeek(bp);
  check("batch: 7 days, mealsPerDay meals each",
    w.days.length === 7 && w.days.every((d) => d.meals.length === BASE.mealsPerDay), w.days.map((d) => d.meals.length).join(","));
  check("batch: stamped planMode=batch with 2 sessions",
    w.planMode === "batch" && (w.sessions?.length ?? 0) === 2, `mode=${w.planMode} sessions=${w.sessions?.length}`);
  check("batch: batches present; totalServings === placements",
    (w.batches?.length ?? 0) > 0 && (w.batches ?? []).every((b) => b.totalServings === b.placements.length && b.totalServings > 0), `${w.batches?.length} batches`);

  const distinct = new Set(w.days.flatMap((d) => d.meals.map((m) => m.name))).size;
  const freshDistinct = new Set(freshWeek(BASE).days.flatMap((d) => d.meals.map((m) => m.name))).size;
  check("batch: far fewer distinct dishes than fresh",
    distinct < freshDistinct && distinct <= 5 * BASE.mealsPerDay, `batch ${distinct} vs fresh ${freshDistinct}`);

  let cookOnce = true;
  for (const b of w.batches ?? []) {
    const plates = w.days.flatMap((d) => d.meals).filter((m) => m.batchId === b.id);
    const f = plates[0];
    if (!f || !plates.every((m) => m.name === f.name && m.calories === f.calories && m.proteinGrams === f.proteinGrams)) cookOnce = false;
  }
  check("batch: every serving of a batch is identical (cook once, eat N)", cookOnce);

  let clampOk = true, nameOk = true;
  for (const m of w.days.flatMap((d) => d.meals)) {
    const base = recipeByName.get(m.name.toLowerCase());
    if (!base) { nameOk = false; continue; }
    if (m.calories > base.calories * 1.8 + 1 || m.calories < base.calories * 0.6 - 1) clampOk = false;
  }
  check("batch: base recipe name intact on every plate (rescalable)", nameOk);
  check("batch: every plate within the 0.6-1.8x portion clamp", clampOk);

  // servings stays the seed's divisor, NOT a cook count (the cook count is Batch.totalServings)
  const divisorOk = w.days.flatMap((d) => d.meals).every((m) => m.servings === recipeByName.get(m.name.toLowerCase())?.servings);
  check("batch: Meal.servings unchanged from the seed (divisor not overloaded)", divisorOk);

  let rotationOk = true;
  for (let i = 1; i < w.days.length; i++) {
    const a = w.days[i - 1].meals.map((m) => m.name).join("|");
    const b2 = w.days[i].meals.map((m) => m.name).join("|");
    if (a && a === b2) rotationOk = false;
  }
  check("batch: no two consecutive days identical in every slot", rotationOk);

  const raw = selectBatchWeek(bp);
  const rb = rebalanceBatchWeek(raw, bp);
  check("batch: rebalancer leaves pure-batch days unchanged (no lever-2 swap of a batch)",
    JSON.stringify(raw.days) === JSON.stringify(rb.days));

  const parsed = WeekPlanSchema.safeParse(w);
  check("batch: WeekPlanSchema keeps sessions/batches (not stripped)",
    parsed.success && (parsed.data.sessions?.length ?? 0) === 2 && (parsed.data.batches?.length ?? 0) > 0,
    parsed.success ? "ok" : parsed.error.issues[0]?.message);

  const vegan = buildWeek({ ...BASE, planMode: "batch", batchCadence: "every3days", diet: "vegan" });
  const veganOk = vegan.days.flatMap((d) => d.meals).every((m) => { const r = recipeByName.get(m.name.toLowerCase()); return r ? dietOk(r.dietTags, "vegan") : true; });
  check("batch: vegan week builds and every dish is vegan", veganOk && vegan.days.length === 7);
}
{
  // === BATCH MODE — rebuild-site & op parity (M2) ===
  const bp: UserProfile = { ...BASE, planMode: "batch", batchCadence: "every3days" };
  const bw = buildWeek(bp);

  const rw = applyOperations(bp, bw, [op({ tool: "regenerate_week" })]);
  check("batch M2: regenerate_week stays batch (not reverted to fresh)",
    rw.plan.planMode === "batch" && (rw.plan.sessions?.length ?? 0) === 2 && rw.profile.planMode === "batch",
    `mode=${rw.plan.planMode} sessions=${rw.plan.sessions?.length} profile=${rw.profile.planMode}`);

  const up = applyOperations(bp, bw, [op({ tool: "update_profile", targetProtein: 190 })]);
  const upDistinct = new Set(up.plan.days.flatMap((d) => d.meals.map((m) => m.name))).size;
  check("batch M2: update_profile stays batch-shaped (not a fresh 21-dish week)",
    up.plan.planMode === "batch" && (up.plan.batches?.length ?? 0) > 0 && upDistinct <= 5 * BASE.mealsPerDay,
    `mode=${up.plan.planMode} distinct=${upDistinct}`);

  const ct = applyOperations(bp, bw, [op({ tool: "compute_targets", age: 30, heightCm: 180, weightKg: 80, sex: "male", activity: "moderate" })]);
  check("batch M2: compute_targets stays batch-shaped",
    ct.plan.planMode === "batch" && (ct.plan.sessions?.length ?? 0) === 2, `mode=${ct.plan.planMode}`);

  const rd = applyOperations(bp, bw, [op({ tool: "regenerate_day", day: "Tuesday" })]);
  check("batch M2: regenerate_day is refused with an honest note (no single-day desync)",
    rd.planChanged === false && rd.notes.some((n) => /meal-prep|cook once|batch/i.test(n)), rd.notes.join(" | ") || "(no note)");

  check("batch M2: planMode preserved on the returned profile after every op",
    rw.profile.planMode === "batch" && up.profile.planMode === "batch" && ct.profile.planMode === "batch" && rd.profile.planMode === "batch");

  // Fresh regression: the same ops on a fresh profile stay fresh (the batch branch never fires).
  const fr = applyOperations(BASE, freshWeek(BASE), [op({ tool: "update_profile", targetProtein: 190 })]);
  check("batch M2: a fresh profile's update_profile stays fresh (no planMode/sessions leak)",
    fr.plan.planMode !== "batch" && !fr.plan.sessions && fr.profile.planMode !== "batch");
}
{
  // === BATCH MODE — efficiency + freeze safety (M3) ===
  const salad = RECIPES.find((r) => /salad|greens|slaw/i.test(r.name));
  const keeper = RECIPES.find((r) => /stew|chill?i|curry|soup|lentil|bean/i.test(r.name));
  if (salad) check("batch M3: a salad keeps <=2 fridge days and isn't freeze-tagged",
    keepDays(salad) <= 2 && !freezesWell(salad), `${salad.name} keep=${keepDays(salad)} freeze=${freezesWell(salad)}`);
  if (keeper) check("batch M3: a stew/bean dish keeps 4 days and freezes well",
    keepDays(keeper) === 4 && freezesWell(keeper), `${keeper.name} keep=${keepDays(keeper)} freeze=${freezesWell(keeper)}`);

  // Weekly cadence freeze-tags the later portions — safely.
  const weekly = buildWeek({ ...BASE, planMode: "batch", batchCadence: "weekly" });
  const wkFrozen = (weekly.batches ?? []).flatMap((b) => b.placements.filter((pl) => pl.frozen));
  check("batch M3: weekly cadence freeze-tags some later portions", wkFrozen.length > 0, `${wkFrozen.length} frozen placements`);
  const allFrozenSafe = (weekly.batches ?? []).every((b) =>
    b.placements.every((pl) => !pl.frozen || freezesWell(recipeByName.get(b.recipeName.toLowerCase())!)));
  check("batch M3: every freeze-tagged portion is a dish that freezes well (no false freeze advice)", allFrozenSafe);
  check("batch M3: weekly cadence discloses the freezing in a note",
    (weekly.notes ?? []).some((n) => /freeze/i.test(n)), (weekly.notes ?? []).join(" | ") || "(no notes)");

  const e3 = buildWeek({ ...BASE, planMode: "batch", batchCadence: "every3days" });
  const e3Frozen = (e3.batches ?? []).flatMap((b) => b.placements.filter((pl) => pl.frozen));
  check("batch M3: every-3-days freezes no more than weekly", e3Frozen.length <= wkFrozen.length, `e3=${e3Frozen.length} weekly=${wkFrozen.length}`);

  // Ingredient overlap: the batch week's dishes share staples (the efficiency payoff).
  const dishNames = [...new Set(e3.days.flatMap((d) => d.meals.map((m) => m.name)))];
  const ingCount = new Map<string, number>();
  for (const n of dishNames) {
    const set = new Set((recipeByName.get(n.toLowerCase())?.ingredients ?? []).map((i) => i.name.trim().toLowerCase()));
    for (const ing of set) ingCount.set(ing, (ingCount.get(ing) ?? 0) + 1);
  }
  const shared = [...ingCount.values()].filter((c) => c >= 2).length;
  check("batch M3: the week's dishes share staple ingredients (overlap-driven selection)", shared >= 3, `${shared} ingredients shared by >=2 dishes`);
}
{
  // === BATCH MODE — bulk grocery + efficiency (M4) ===
  check("batch M4: formatBulkQuantity renders friendly packs",
    formatBulkQuantity("rice", 1500) === "1.5 kg" && /egg/.test(formatBulkQuantity("eggs", 165)) && /can/.test(formatBulkQuantity("chopped tomatoes", 700)),
    `${formatBulkQuantity("rice", 1500)} | ${formatBulkQuantity("eggs", 165)} | ${formatBulkQuantity("chopped tomatoes", 700)}`);

  // H1: the ingredient list is per recipe.servings, so bulk divides by servings BEFORE x totalServings.
  const fakeMeal: Meal = { name: "Test Bake", type: "dinner", description: "", calories: 500, proteinGrams: 30, carbsGrams: 50, fatGrams: 15, timeMinutes: 30, servings: 2, ingredients: [{ name: "rice", quantity: "100 g" }], steps: [], batchId: "b1" };
  const fakeWeek: WeekPlan = {
    days: [{ day: "Monday", meals: [fakeMeal] }], weekSummary: "", planMode: "batch",
    sessions: [{ id: "s1", cookDay: "Monday", coversDays: ["Monday"] }],
    batches: [{ id: "b1", sessionId: "s1", recipeName: "Test Bake", slot: "dinner", totalServings: 4, servingFactor: 1, perServing: { calories: 500, proteinGrams: 30, carbsGrams: 50, fatGrams: 15 }, placements: [{ day: "Monday", slot: "dinner" }] }],
  };
  const riceRow = bulkGroceriesFromWeek(fakeWeek)[0]?.aisles.flatMap((a) => a.items).find((it) => it.name === "rice");
  check("batch M4 (H1): bulk grams = list/servings x totalServings (no 3x over-shop)",
    riceRow?.grams === 200, `rice=${riceRow?.grams}g (expected 200 = 100/2 * 4)`);

  const bw = buildWeek({ ...BASE, planMode: "batch", batchCadence: "every3days" });
  const sg = bulkGroceriesFromWeek(bw);
  check("batch M4: a per-session bulk list, fully resolved to grams",
    sg.length === 2 && sg.every((s) => s.coverage === 1 && s.aisles.some((a) => a.items.length > 0)),
    `sessions=${sg.length} coverage=${sg.map((s) => s.coverage.toFixed(2)).join(",")}`);

  const eff = batchEfficiency(bw);
  check("batch M4: efficiency metric — far fewer cook events than fresh",
    eff.cookEvents < eff.freshCookEvents && eff.freshCookEvents === 21 && eff.sessions === 2 && eff.sharedIngredients >= 3,
    `cook ${eff.cookEvents} vs fresh ${eff.freshCookEvents}, shared=${eff.sharedIngredients}`);
}
{
  // === BATCH MODE — assistant integration + H3 (M5) ===
  // Switch fresh -> batch via update_profile (the whole-plan front door both assistants share).
  const toBatch = applyOperations(BASE, freshWeek(BASE), [op({ tool: "update_profile", planMode: "batch" })]);
  check("batch M5: 'switch to meal-prep' via update_profile builds a batch week",
    toBatch.plan.planMode === "batch" && (toBatch.plan.sessions?.length ?? 0) === 2 && toBatch.profile.planMode === "batch" && toBatch.planChanged,
    `mode=${toBatch.plan.planMode} sessions=${toBatch.plan.sessions?.length}`);

  // H3: switching batch -> fresh must REBUILD fresh (~21 distinct), not keep the batch's repeats.
  const bp: UserProfile = { ...BASE, planMode: "batch", batchCadence: "every3days" };
  const bw = buildWeek(bp);
  const toFresh = applyOperations(bp, bw, [op({ tool: "update_profile", planMode: "fresh" })]);
  const freshDistinct = new Set(toFresh.plan.days.flatMap((d) => d.meals.map((m) => m.name))).size;
  check("batch M5 (H3): batch->fresh rebuilds a fresh week, not the batch's repeats",
    toFresh.plan.planMode !== "batch" && !toFresh.plan.sessions && freshDistinct >= 18,
    `mode=${toFresh.plan.planMode} distinct=${freshDistinct}`);

  // v2 primitive carries the mode through to update_profile.
  const ops = expandConstrain({ op: "constrain", scope: "week", planMode: "batch", cadence: "weekly" });
  check("batch M5: constrain{planMode} expands to update_profile carrying planMode",
    ops.length === 1 && ops[0].tool === "update_profile" && ops[0].planMode === "batch",
    JSON.stringify(ops[0]).slice(0, 80));

  // A meal swap in batch replaces the WHOLE batch it belongs to (cook-once preserved).
  const monLunchBatch = bw.days.find((d) => d.day === "Monday")!.meals.find((m) => m.type === "lunch")!.batchId!;
  const sw = applyOperations(bp, bw, [op({ tool: "swap_meal", day: "Monday", mealType: "lunch", dish: "chicken" })]);
  const swBatchMeals = sw.plan.days.flatMap((d) => d.meals).filter((m) => m.batchId === monLunchBatch);
  check("batch M5: a meal swap replaces its whole batch (cook-once preserved)",
    sw.planChanged && swBatchMeals.length > 0 && swBatchMeals.every((m) => m.name === swBatchMeals[0].name) &&
    (sw.plan.batches ?? []).find((b) => b.id === monLunchBatch)?.recipeName === swBatchMeals[0].name,
    `${swBatchMeals.length} servings -> ${swBatchMeals[0]?.name}`);
}
{
  // "I've got salmon to use up."
  const wk = freshWeek(BASE);
  // The fridge used to be a BIAS: the selector preferred matching recipes per slot, but the
  // protein-diversity cap (fish is limited to ~3 days a week) could still crowd salmon out of the
  // whole week. The test could only say "usually", which is another way of saying nobody knew.
  // It's a guarantee now, so this asserts a guarantee.
  const usesIng = (p: WeekPlan, ing: string) =>
    p.days.some((d) => d.meals.some((m) => m.ingredients.some((i) => i.name.trim().toLowerCase() === ing)));
  const N = 12;
  const SETS: string[][] = [["broccoli"], ["salmon fillet"], ["salmon fillet", "broccoli", "chickpeas"]];
  for (const set of SETS) {
    let ok = 0;
    for (let i = 0; i < N; i++) {
      const plan = applyOperations(BASE, freshWeek(BASE), [op({ tool: "regenerate_week", useIngredients: set })]).plan;
      if (set.every((s) => usesIng(plan, s))) ok++;
    }
    check(`fridge: [${set.join(", ")}] always end up in the week`, ok === N, `${ok}/${N} runs`);
  }

  // The guarantee never overrides a hard rule, and never pretends.
  const V: UserProfile = { ...BASE, diet: "vegan" };
  const veganSalmon = applyOperations(V, freshWeek(V), [op({ tool: "regenerate_week", useIngredients: ["salmon fillet"] })]);
  check("fridge: a vegan asking to use up salmon is told, not obeyed",
    !usesIng(veganSalmon.plan, "salmon fillet") && /couldn't work/i.test(veganSalmon.notes.join(" ")),
    veganSalmon.notes.find((n) => /couldn't work/i.test(n))?.slice(0, 70) ?? "silent");

  // Filling the fridge must not knock the week off its macros.
  const filled = applyOperations(BASE, wk, [op({ tool: "regenerate_week", useIngredients: ["salmon fillet", "broccoli"] })]).plan;
  const worst = Math.max(...filled.days.map((d) => Math.abs(kcal(d) - BASE.targetCalories)));
  check("fridge: the week still hits its calorie target", worst <= BASE.targetCalories * 0.15, `worst day off by ${worst} kcal`);

  // A pinned meal is never displaced to make room for the fridge.
  const pinned = applyOperations(BASE, wk, [op({ tool: "lock_meal", day: "Sunday", mealType: "dinner" })]).profile;
  const pinnedName = pinned.lockedMeals![0].name;
  const withFridge = applyOperations(pinned, wk, [op({ tool: "regenerate_week", useIngredients: ["salmon fillet", "broccoli"] })]).plan;
  check("fridge: a pinned meal is never displaced to make room",
    withFridge.days.find((d) => d.day === "Sunday")!.meals.find((m) => m.type === "dinner")!.name === pinnedName);
}

// ---------------------------------------------------------------- 1b. micronutrients
console.log("\n--- MICRONUTRIENTS (USDA-derived) ---");
{
  // Sanity: the table must reflect reality, not vibes.
  const spinach = microsForIngredients([{ name: "spinach", quantity: "100 g" }]).micros;
  const salmon = microsForIngredients([{ name: "salmon fillet", quantity: "100 g" }]).micros;
  const oil = microsForIngredients([{ name: "olive oil", quantity: "100 g" }]).micros;
  check("spinach is iron- and folate-rich", spinach.iron > 2 && spinach.folate > 150, `iron=${spinach.iron.toFixed(1)}mg folate=${Math.round(spinach.folate)}ug`);
  check("salmon carries vitamin D and B12", salmon.vitD > 5 && salmon.b12 > 2, `vitD=${salmon.vitD.toFixed(1)}ug B12=${salmon.b12.toFixed(1)}ug`);
  check("olive oil has essentially no micronutrients", oil.iron < 1 && oil.b12 === 0, `iron=${oil.iron.toFixed(2)}mg`);

  // A count-based quantity must convert: "2" eggs = 100 g, not 2 g.
  const eggs = microsForIngredients([{ name: "eggs", quantity: "2" }]).micros;
  check("bare counts convert to grams (2 eggs -> B12 present)", eggs.b12 > 0.5, `B12=${eggs.b12.toFixed(2)}ug`);

  // A batch recipe's ingredients make several servings. Without dividing, one muffin claims
  // the iron of the whole tin.
  const batch = RECIPES.find((r) => r.servings && r.servings > 1);
  if (batch) {
    const raw = microsForIngredients(batch.ingredients).micros.iron;
    const perServing = recipeMicros(batch).micros.iron;
    const expected = raw / batch.servings!;
    check(
      `batch recipe nutrients are PER SERVING (${batch.name}, x${batch.servings})`,
      Math.abs(perServing - expected) < 0.01 && perServing < raw,
      `batch=${raw.toFixed(2)}mg perServing=${perServing.toFixed(2)}mg`,
    );
  } else check("a batch recipe exists to test servings division", false);
}
{
  // "I'm low on iron" must raise iron WITHOUT breaking calories/protein.
  const ironOf = (p: WeekPlan) =>
    p.days.reduce((s, d) => s + d.meals.reduce((a, m) => a + microsForIngredients(m.ingredients).micros.iron, 0), 0) / p.days.length;
  const N = 8;
  let base = 0;
  let boosted = 0;
  let macrosHeld = true;
  for (let i = 0; i < N; i++) {
    const wk = freshWeek(BASE);
    base += ironOf(wk);
    const r = applyOperations(BASE, wk, [op({ tool: "regenerate_week", boostNutrient: "iron" })]);
    boosted += ironOf(r.plan);
    if (!r.plan.days.every((d) => Math.abs(kcal(d) - 2000) <= 200 && prot(d) >= 125)) macrosHeld = false;
  }
  check("boostNutrient:iron raises weekly iron", boosted / N > base / N, `default=${(base / N).toFixed(1)}mg/day boosted=${(boosted / N).toFixed(1)}mg/day`);
  check("boostNutrient:iron does NOT break calories/protein", macrosHeld);
}
{
  // The engine must refuse to quote a number it half-guessed, and must report honestly.
  const wk = freshWeek(BASE);
  const r = applyOperations(BASE, wk, [op({ tool: "regenerate_week", boostNutrient: "iron" })]);
  check("boost emits an honest iron note", r.notes.some((n) => /iron/.test(n)), r.notes.find((n) => /iron/.test(n)) ?? "(none)");
}

// ---------------------------------------------------------------- 1b2. allergens & data integrity
console.log("\n--- ALLERGENS & DATA INTEGRITY (hard rules) ---");
{
  // The naive substring test served almonds to a "nuts" allergy. Never again.
  const nutAllergy: UserProfile = { ...BASE, allergies: "nuts" };
  const wk = freshWeek(nutAllergy);
  const nutHits: string[] = [];
  for (const d of wk.days)
    for (const m of d.meals)
      if (/\b(almond|walnut|pecan|cashew|hazelnut|pistachio|peanut)/i.test(mealHay(m))) nutHits.push(m.name);
  check("allergy 'nuts' blocks almonds/pecans/cashews, not just 'walnuts'", nutHits.length === 0, nutHits.slice(0, 3).join(", ") || "clean");

  // Peanut butter and almond butter are not dairy. This check used to grep for `\bbutter` and so
  // demanded that a dairy-allergic user be denied Thai Peanut Chicken Rice Bowl — it was asserting
  // the over-block bug. It was also flaky: that recipe only turns up in some random weeks.
  // Scanning several weeks makes the failure deterministic rather than a coin flip.
  const dairyAllergy: UserProfile = { ...BASE, allergies: "dairy" };
  const isDairy = (hay: string) =>
    /\b(milk|cheese|yogurt|feta|mozzarella|cheddar|parmesan|ricotta|halloumi)\b/i.test(hay) ||
    /(?<!peanut |almond |cashew |cocoa |nut )\bbutter\b/i.test(hay);
  const dairyHits: string[] = [];
  for (let i = 0; i < 6; i++)
    for (const d of freshWeek(dairyAllergy).days)
      for (const m of d.meals) if (isDairy(mealHay(m))) dairyHits.push(m.name);
  check("allergy 'dairy' blocks cheese/yogurt/milk/butter", dairyHits.length === 0, dairyHits.slice(0, 3).join(", ") || "clean");
  check("...but a nut butter is not dairy", !isDairy("chicken breast peanut butter brown rice"));
}
{
  // Hidden allergens in prepared/compound foods (adversarial allergen review): the food's NAME never
  // says the allergen, but it carries one. These slipped through until CATEGORY_TERMS learned them.
  check("allergen: 'sesame' blocks hummus (tahini)",
    haystackBlocked("Turkey & Hummus Power Wrap hummus wholemeal wrap", ["sesame"]) === true);
  check("allergen: 'nuts' blocks pesto (pine nuts / cashews)",
    haystackBlocked("Pesto Bean Pot pesto cannellini beans", ["nuts"]) === true);
  check("allergen: 'dairy' blocks pesto (parmesan)",
    haystackBlocked("Pesto Bean Pot pesto cannellini beans", ["dairy"]) === true);
  check("allergen: 'fish' blocks Caesar dressing (anchovy)",
    haystackBlocked("Chicken Caesar Bowl light caesar dressing romaine", ["fish"]) === true);
  // Hyphenated soy sauces (soy-ginger / ginger-soy / sesame-soy) are wheat-bearing soy sauce but did
  // not contain the phrase "soy sauce", so gluten/wheat missed them (adversarial under-block review).
  check("allergen: 'gluten' blocks a hyphenated soy sauce",
    haystackBlocked("Chicken Veg Stir-Fry soy-ginger sauce rice", ["gluten"]) === true);
  check("allergen: 'wheat' blocks a hyphenated soy sauce",
    haystackBlocked("Beef & Broccoli Bowl ginger-soy sauce rice", ["wheat"]) === true);
  // Caesar dressing hides raw egg — and a SINGULAR "egg" allergy must expand to it, not just "eggs".
  check("allergen: 'egg' (singular) blocks Caesar dressing (raw yolk)",
    haystackBlocked("Chicken Caesar Bowl light caesar dressing romaine", ["egg"]) === true);
  check("allergen: 'eggs' (plural) also blocks Caesar dressing",
    haystackBlocked("Chicken Caesar Bowl light caesar dressing romaine", ["eggs"]) === true);
  // ...and the new terms must not over-block a dish that merely rhymes / lacks the compound food.
  check("allergen: 'gluten' leaves a soy-free rice bowl alone",
    haystackBlocked("Chicken Rice Bowl chicken brown rice broccoli", ["gluten"]) === false);
  check("allergen: 'sesame' leaves a hummus-free wrap alone",
    haystackBlocked("Turkey Salad Wrap turkey lettuce wholemeal wrap", ["sesame"]) === false);
  check("allergen: 'nuts' leaves a pesto-free bean pot alone",
    haystackBlocked("Tomato Bean Pot cannellini beans tomato basil", ["nuts"]) === false);
}
{
  // ...but it must not over-block: "egg" is not "eggplant", "oat" is not "goat cheese".
  const noEgg: UserProfile = { ...BASE, dislikes: "egg" };
  check("'egg' does not block eggplant", haystackBlocked("Eggplant Parmesan eggplant", ["egg"]) === false);
  check("'egg' still blocks eggs", haystackBlocked("Veggie Omelette eggs", ["egg"]) === true);
  check("'oat' does not block goat cheese", haystackBlocked("Mushroom & Goat Cheese Frittata goat cheese", ["oat"]) === false);
  check("'oat' still blocks rolled oats", haystackBlocked("Peanut Banana Oatmeal rolled oats", ["oat"]) === true);
  check("'no oven' still blocks baked/roasted", haystackBlocked("Bake at 180C; roasted veg", ["bake", "roast"]) === true);
  // and a one-letter dislike must not wipe out the plan
  const silly: UserProfile = { ...BASE, dislikes: "a" };
  const sw = freshWeek(silly);
  check("a 1-char dislike is ignored (does not empty the plan)", sw.days.every((d) => d.meals.length === 3), `[${sw.days.map((d) => d.meals.length)}]`);
  void noEgg;
}
{
  // DATA INTEGRITY: dietTags must not lie. The fuzzer trusts them, so a wrong tag makes every
  // invariant pass while a coeliac is served couscous. This is how that bug got in.
  const lies: string[] = [];
  for (const r of RECIPES) {
    const names = r.ingredients.map((i) => i.name);
    for (const tag of ["gluten_free", "vegan", "vegetarian"]) {
      if (!r.dietTags.includes(tag as never)) continue;
      const bad = dietTagConflicts(tag, names);
      if (bad.length) lies.push(`${r.id} [${tag}] <- ${bad.join(", ")}`);
    }
  }
  check("no recipe's dietTags contradict its ingredients", lies.length === 0, lies.length ? `${lies.length} lies` : "clean");
  if (lies.length) for (const l of lies) console.log("        " + l);

  const ids = RECIPES.map((r) => r.id);
  const nms = RECIPES.map((r) => r.name.toLowerCase());
  check("no duplicate recipe ids", new Set(ids).size === ids.length);
  check("no duplicate recipe names", new Set(nms).size === nms.length);

  // "eggplant" contains "egg", and dietTagConflicts matches NON_VEGAN on raw substrings. The
  // ALLERGEN path fixed this exact trap with word-aware matching; the diet-tag path did not,
  // so a vegan aubergine dish was reported as containing egg. No recipe paired vegan with
  // eggplant until the library expansion, so the bug sat latent and nothing failed.
  // Rule 10: prove the presence before trusting the absence — the controls below must still
  // catch a real egg, or the exception has over-reached and is worse than the bug.
  check("vegan: eggplant is a vegetable, not an egg", dietTagConflicts("vegan", ["eggplant"]).length === 0);
  for (const real of ["egg", "eggs", "egg whites", "egg noodles"])
    check(`vegan: "${real}" IS still caught (control)`, dietTagConflicts("vegan", [real]).length > 0);
}

// ---------------------------------------------------------------- 1b3. honesty about compromises
console.log("\n--- HONESTY ABOUT COMPROMISES ---");
{
  // keto + 4 meals used to silently yield 3: no snack carried the keto tag.
  const keto4: UserProfile = { ...BASE, diet: "keto", mealsPerDay: 4 };
  const wk = selectWeekFromDb(keto4);
  check("keto + 4 meals/day actually gets 4 meals", wk.days.every((d) => d.meals.length === 4), `[${wk.days.map((d) => d.meals.length)}]`);
}
{
  // When a slot genuinely cannot be filled, the engine must SAY so, not drop it quietly.
  const impossible: UserProfile = { ...BASE, diet: "keto", mealsPerDay: 4, dislikes: "eggs, cheese, almonds, avocado" };
  const rep = newReport();
  const wk = selectWeekFromDb(impossible, undefined, undefined, undefined, undefined, rep);
  const notes = reportNotes(rep, impossible);
  const dropped = wk.days.some((d) => d.meals.length < 4);
  check("an unfillable slot is DISCLOSED, not silently dropped", !dropped || notes.length > 0, `dropped=${dropped} notes=${notes[0] ?? "(none)"}`);
}
{
  // A cook-time relaxation must be disclosed (swap_meal already did; generation did not).
  const busy: UserProfile = { ...BASE, maxCookTime: 5 };
  const rep = newReport();
  selectWeekFromDb(busy, undefined, undefined, undefined, undefined, rep);
  const notes = reportNotes(rep, busy);
  check("relaxing the cook-time limit is disclosed", notes.some((n) => /min/.test(n)), notes[0] ?? "(none)");
}
{
  // A calorie target the recipes cannot reach must be ADMITTED, not reported as success.
  const huge: UserProfile = { ...BASE, targetCalories: 4000 };
  const wk = freshWeek(huge);
  const r = applyOperations(huge, wk, [op({ tool: "regenerate_week" })]);
  const note = r.notes.find((n) => /averages/.test(n)) ?? "";
  check("an unreachable calorie target is admitted", /below your 4000 kcal target/.test(note), note || "(none)");
}

// ---------------------------------------------------------------- 1c. treats
console.log("\n--- TREATS (only on request, never planned for you) ---");
const TREAT_NAMES = new Set(RECIPES.filter((r) => r.treatOnly).map((r) => r.name.toLowerCase()));
{
  check("treat recipes exist (cheat day is reachable at all)", TREAT_NAMES.size >= 5, `${TREAT_NAMES.size} treats`);

  // The planner must never slip a burger into a healthy week.
  let leaked = 0;
  for (let i = 0; i < 15; i++) {
    const wk = freshWeek(BASE);
    for (const d of wk.days) for (const m of d.meals) if (TREAT_NAMES.has(m.name.toLowerCase())) leaked++;
  }
  check("planner NEVER auto-selects a treat", leaked === 0, `${leaked} leaks over 15 weeks`);

  // Protein re-selection (lever 2) must not "upgrade" a meal into fried chicken.
  let upgraded = 0;
  for (let i = 0; i < 15; i++) {
    const wk = freshWeek(BASE);
    const r = applyOperations(BASE, wk, [op({ tool: "swap_meal", day: "Monday", mealType: "breakfast", dish: "oatmeal" })]);
    const d = r.plan.days.find((x) => x.day === "Monday")!;
    for (const m of d.meals) if (TREAT_NAMES.has(m.name.toLowerCase())) upgraded++;
  }
  check("protein upgrade NEVER becomes a treat", upgraded === 0, `${upgraded} over 15 runs`);
}
{
  // The cheat-day flow the probe found broken: it used to answer "I don't have pizza".
  const wk = freshWeek(BASE);
  const before = wk.days.find((x) => x.day === "Saturday")!;
  const lunchB = before.meals.find((m) => m.type === "lunch")!.name;
  const r = applyOperations(BASE, wk, [op({ tool: "swap_meal", day: "Saturday", mealType: "dinner", dish: "pizza", preserveMacros: false })]);
  const d = r.plan.days.find((x) => x.day === "Saturday")!;
  check("cheat day: 'pizza' is actually served", d.meals.some((m) => /pizza/i.test(m.name)), names(d));
  check("cheat day: other meals untouched", d.meals.find((m) => m.type === "lunch")!.name === lunchB);
  check("cheat day: no macro-rebalance note", !r.notes.some((n) => /on target/.test(n)), r.notes.join(" | ") || "(none)");
}
{
  // Hard rules still beat a treat request: a vegan cannot be served a pepperoni pizza.
  const vegan: UserProfile = { ...BASE, diet: "vegan" };
  const wk = freshWeek(vegan);
  const r = applyOperations(vegan, wk, [op({ tool: "swap_meal", day: "Saturday", mealType: "dinner", dish: "pizza", preserveMacros: false })]);
  const d = r.plan.days.find((x) => x.day === "Saturday")!;
  check("vegan + cheat day: pizza refused (diet is a HARD rule)", !d.meals.some((m) => /pizza/i.test(m.name)), names(d));
  check("vegan + cheat day: engine explains the refusal", r.notes.length > 0, r.notes.join(" | ") || "(none)");
}
{
  // An EXACT recipe name must resolve to THAT recipe. Keyword scoring alone handed a request for
  // "Veggie Omelette" a chickpea omelette, because both share the word "omelette" and the tie broke
  // the wrong way. If you name a real dish exactly, you get it.
  const wk = freshWeek(BASE);
  const named = RECIPES.find((x) => x.name === "Veggie Omelette");
  if (named) {
    const r = applyOperations(BASE, wk, [op({ tool: "swap_meal", day: "Monday", mealType: "breakfast", dish: "Veggie Omelette" })]);
    const got = r.plan.days.find((x) => x.day === "Monday")!.meals.find((m) => m.type === "breakfast")!.name;
    check("swap_meal: an exact recipe name resolves to that exact recipe", got === "Veggie Omelette", `got "${got}"`);
  }
  // ...but the exact name is still behind the hard filters: a vegan naming an egg dish is refused.
  const vegan: UserProfile = { ...BASE, diet: "vegan" };
  const vwk = freshWeek(vegan);
  const vr = applyOperations(vegan, vwk, [op({ tool: "swap_meal", day: "Monday", mealType: "breakfast", dish: "Veggie Omelette" })]);
  const vgot = vr.plan.days.find((x) => x.day === "Monday")!.meals.find((m) => m.type === "breakfast")!.name;
  check("swap_meal: an exact name never overrides the diet", vgot !== "Veggie Omelette", `got "${vgot}"`);
}

// ---------------------------------------------------------------- 1d. compute_targets
console.log("\n--- COMPUTE_TARGETS (the engine does the arithmetic) ---");
{
  // Mifflin-St Jeor, checked against the textbook formula by hand.
  // male 30y, 180cm, 80kg: 10*80 + 6.25*180 - 5*30 + 5 = 800 + 1125 - 150 + 5 = 1780
  const m = bmr({ age: 30, heightCm: 180, weightKg: 80, sex: "male" });
  check("BMR male 30y/180cm/80kg = 1780", Math.round(m) === 1780, `${Math.round(m)}`);
  // female 30y, 165cm, 60kg: 600 + 1031.25 - 150 - 161 = 1320.25
  const f = bmr({ age: 30, heightCm: 165, weightKg: 60, sex: "female" });
  check("BMR female 30y/165cm/60kg = 1320", Math.round(f) === 1320, `${Math.round(f)}`);
}
{
  const t = computeTargets({ age: 30, heightCm: 180, weightKg: 80, sex: "male", activity: "moderate", goal: "maintain" });
  // TDEE = 1780 * 1.55 = 2759
  check("maintenance calories ~= TDEE", Math.abs(t.calories - 2759) <= 10, `${t.calories} vs 2759`);
  check("protein at 1.6 g/kg for maintenance", t.proteinGrams === 128, `${t.proteinGrams}g`);
  const macroKcal = t.proteinGrams * 4 + t.carbsGrams * 4 + t.fatGrams * 9;
  check("macros add back up to the calorie target (±3%)", Math.abs(macroKcal - t.calories) < t.calories * 0.03, `${macroKcal} vs ${t.calories}`);
}
{
  const cut = computeTargets({ age: 30, heightCm: 180, weightKg: 80, sex: "male", activity: "moderate", goal: "lose_weight" });
  const gain = computeTargets({ age: 30, heightCm: 180, weightKg: 80, sex: "male", activity: "moderate", goal: "build_muscle" });
  check("cutting < maintenance < bulking", cut.calories < 2759 && gain.calories > 2759, `${cut.calories} / 2759 / ${gain.calories}`);
  check("protein is HIGHER when cutting (protects muscle)", cut.proteinGrams > 128, `${cut.proteinGrams}g`);
}
{
  // A tiny sedentary person on a deficit must not be planned below the floor.
  const t = computeTargets({ age: 65, heightCm: 150, weightKg: 45, sex: "female", activity: "sedentary", goal: "lose_weight" });
  check("calorie floor is enforced and disclosed", t.calories >= 1200 && t.clampedTo === 1200, `${t.calories} clampedTo=${t.clampedTo}`);
  // Unknown / other sex (e.g. a nonbinary user) must still get the floor, not silently skip it.
  const other = computeTargets({ age: 65, heightCm: 150, weightKg: 45, sex: "other" as never, activity: "sedentary", goal: "lose_weight" });
  check("calorie floor applies for an unknown sex too", other.clampedTo === 1200 && other.calories === 1200, `${other.calories} clampedTo=${other.clampedTo}`);
}
{
  // The tool must refuse to invent a body weight.
  const wk = freshWeek(BASE);
  const partial = applyOperations(BASE, wk, [op({ tool: "compute_targets", age: 30, heightCm: 180 } as never)]);
  check("missing facts -> asks, never guesses", partial.notes.some((n) => /I need your/.test(n)) && partial.profile.targetCalories === 2000, partial.notes[0] ?? "(none)");
  // Present but nonsensical (0 / negative) must be refused too — no NaN/zero/negative target slips out.
  const zero = applyOperations(BASE, wk, [op({ tool: "compute_targets", age: 30, heightCm: 180, weightKg: 0, sex: "male", activity: "moderate" } as never)]);
  check("invalid body stats -> refused, targets untouched", zero.notes.some((n) => /doesn't look right/.test(n)) && zero.profile.targetCalories === 2000, zero.notes[0] ?? "(none)");
  const neg = applyOperations(BASE, wk, [op({ tool: "compute_targets", age: 30, heightCm: 180, weightKg: -80, sex: "male", activity: "moderate" } as never)]);
  check("negative body stats -> refused too", neg.notes.some((n) => /doesn't look right/.test(n)) && neg.profile.proteinGrams === 150);

  const full = applyOperations(BASE, wk, [op({ tool: "compute_targets", age: 30, heightCm: 180, weightKg: 80, sex: "male", activity: "moderate", goal: "build_muscle" } as never)]);
  check("full facts -> profile targets are set", full.profile.targetCalories > 2900 && full.profile.proteinGrams === 152, `${full.profile.targetCalories} kcal, ${full.profile.proteinGrams}g protein`);
  check("compute_targets explains itself in plain English", full.notes.some((n) => /resting burn/.test(n)), (full.notes[0] ?? "").slice(0, 90));
}
// ---------------------------------------------------------------- allergen review (D5b, second pass)
// An adversarial review of D5b's parser (2026-10-03, every finding reproduced end to end) showed the
// first fix dropping whole allergy clauses as "allowances": "I can eat anything without gluten" was
// served 41 gluten meals in 5 weeks, "Shellfish - everything else is fine" 10 shellfish meals, and
// "Neither dairy nor eggs are ok" 26 egg meals. A clause is now dropped only when it plainly allows a
// SPECIFIC food. These are the review's own inputs.
console.log("\n--- ALLERGEN REVIEW (the inputs that lost an allergy, or blocked far too much) ---");
{
  const T = (a: string) => parseExclusionTokens(a, "");
  const D = (d: string) => parseExclusionTokens("", d);
  const count = (tokens: string[]) => RECIPES.filter((r) => haystackBlocked(recipeHay(r), tokens)).length;
  const MUST: [string, string][] = [
    ["Everything is fine with the exception of peanuts", "peanut butter"], ["Everything's fine besides nuts", "almonds"],
    ["I'm ok with all foods besides shellfish", "shrimp"], ["I can eat anything aside from nuts", "walnuts"],
    ["I can eat anything that doesn't contain nuts", "almonds"], ["I can eat anything without gluten", "orzo"],
    ["None of the nuts are safe for me", "peanut butter"], ["I can eat nothing with nuts", "almonds"],
    ["Besides gluten I can eat anything", "pasta"], ["I can barely tolerate dairy", "cheddar"], ["I tolerate gluten poorly", "bread"],
    ["Shellfish - everything else is fine", "prawns"], ["peanuts - fine with tree nuts", "peanut butter"],
    ["Apart from shellfish I can eat anything", "shrimp"], ["Except nuts everything is fine", "peanut butter"],
    ["Neither dairy nor eggs are ok for me", "eggs"], ["Neither dairy nor eggs are ok for me", "cheddar"],
    ["Nuts or shellfish - neither is ok", "shrimp"], ["Nuts or shellfish - neither is ok", "almonds"],
    ["shell fish", "shrimp"], ["shell-fish", "crab"], ["sea food", "salmon"], ["sea-food", "prawns"], ["treenuts", "almonds"],
    ["egg's", "eggs"], ["nut's", "almonds"], ["Celiac's disease", "bread"], ["casein", "cheddar"], ["whey", "protein powder"],
    ["tahini", "hummus"], ["CMPA", "greek yogurt"], ["bad reaction to cottage cheese", "cottage cheese"],
    ["avocado - life threatening", "avocado"], ["mushrooms make me sick", "mushrooms"], ["strong mushroom allergy", "mushrooms"],
  ];
  let leak = "";
  for (const [a, food] of MUST) if (!haystackBlocked(food, T(a))) leak += ` ${JSON.stringify(a)}->${food} ${JSON.stringify(T(a))}`;
  check("allergen review: every phrasing the review caught now blocks its food", leak === "", leak || `${MUST.length} cases`);

  const ALLOWED: [string, string][] = [
    ["fine with almonds but allergic to peanuts", "almonds"], ["i can eat almonds but not peanuts", "almonds"],
    ["almonds are fine however peanuts are not", "almonds"], ["peanuts but fine with almonds", "almonds"],
    ["I'm not allergic to almonds, but peanuts yes", "almonds"], ["nuts are fine except peanuts", "walnuts"],
    ["allergic to shellfish but I love fish", "salmon"], ["allergic to peanuts but I eat almonds all the time", "almonds"],
  ];
  let over = "";
  for (const [a, food] of ALLOWED) if (haystackBlocked(food, T(a))) over += ` ${JSON.stringify(a)}->${food}`;
  check("allergen review: a food the person plainly allows is not blocked", over === "", over || `${ALLOWED.length} cases`);

  // Over-blocks: [input, the most recipes it may block]. "fries" used to remove 63 stir-fries (the
  // reverse -ies rule reached the verb "fry"); "onions unless cooked" added the word "cooked" (130).
  const OVER: [string, number][] = [
    ["fries", 5], ["cherries", 3], ["onions unless cooked", 40], ["tomatoes unless cooked", 140], ["carrots except roasted", 15],
    ["spinach (cooked)", 50], ["peppers (green)", 45], ["white or brown rice", 45], ["olives", 35], ["goat cheese", 5],
    ["smoked salmon", 10], ["shrimp paste", 3], ["tortilla chips", 3], ["don't like olives", 35], ["hate mushrooms", 10],
  ];
  let wide = "";
  for (const [d, max] of OVER) { const n = count(D(d)); if (n > max) wide += ` "${d}" ${n} > ${max} ${JSON.stringify(D(d))}`; }
  check("allergen review: no dislike blocks far more than the food it names", wide === "", wide || `${OVER.length} dislikes`);
  check("allergen review: a dislike of olives keeps olive oil; an olive ALLERGY does not",
    !haystackBlocked("olive oil", D("olives")) && haystackBlocked("olive oil", T("olives")) && haystackBlocked("olive oil", T("allergic to olives")));
  check("allergen review: a pronoun is never a token ('Shellfish. I cannot eat them.')", !T("Shellfish. I cannot eat them.").includes("them"), JSON.stringify(T("Shellfish. I cannot eat them.")));
  let lost = "";
  for (const [d, food] of [["don't like olives", "olives"], ["hate mushrooms", "mushrooms"], ["not a fan of mushrooms", "mushrooms"], ["I dislike mushrooms", "mushrooms"]] as const)
    if (!haystackBlocked(food, D(d))) lost += ` "${d}" ${JSON.stringify(D(d))}`;
  check("allergen review: ordinary dislike phrasings still exclude the food", lost === "", lost);

  // The allergen path and the diet path agree in the other direction too: a dish the library verifies
  // as gluten_free (check:recipes) is not removed by a gluten allergy. 17 were: method text said
  // "tortillas" where the ingredients say corn tortillas, which is now spelled out.
  const gfBlocked = RECIPES.filter((r) => r.dietTags.includes("gluten_free") && haystackBlocked(recipeHay(r), T("gluten")));
  check("allergen review: no gluten_free-tagged recipe is blocked by a gluten allergy", gfBlocked.length === 0, gfBlocked.map((r) => r.name).join(" | "));
  let verb = "";
  for (const s of ["Toast pine nuts in a dry pan.", "Toast cumin seeds, then grind.", "Wrap with foil and bake.", "Wrap and chill for an hour."])
    if (haystackBlocked(s, ["gluten"])) verb += ` "${s}"`;
  check("allergen review: an instruction to toast or wrap is not a gluten food", verb === "", verb);
  check("allergen review: ...while toast as food still blocks", haystackBlocked("Avocado Toast. Serve on whole-grain toast.", ["gluten"]));
  let flagged = "";
  for (const [t, n] of [["vegetarian", "soy chorizo"], ["vegetarian", "duck sauce"], ["gluten_free", "rice noodle"], ["gluten_free", "pizza sauce"], ["vegan", "veggie stock"], ["vegan", "honeydew melon"], ["vegan", "butternut squash"]] as const)
    if (dietTagConflicts(t, [n]).length) flagged += ` ${t}:${n}`;
  check("allergen review: the diet path does not flag these plant foods", flagged === "", flagged);

  // The remembered-fact path: what is stored is what the person said, and nothing they love.
  const facts: [string, string[]][] = [
    ["I'm allergic to shellfish but I love fish", ["shellfish"]], ["I am allergic to shell fish", ["shellfish"]],
    ["Heads up, I am allergic to sea food", ["seafood"]], ["allergic to egg's", ["egg"]], ["I have a strong mushroom allergy", ["mushroom"]],
  ];
  for (const [fact, want] of facts) {
    const got = allergensInFact(fact);
    check(`allergen review: remembered "${fact}" stores ${want.join(", ")}`, JSON.stringify([...got].sort()) === JSON.stringify([...want].sort()), JSON.stringify(got));
  }

  // End to end, five seeded weeks each: none may serve what the person named.
  for (const [a, meaning] of [["I can eat anything without gluten", "gluten"], ["Shellfish - everything else is fine", "shellfish"], ["Neither dairy nor eggs are ok for me", "eggs"], ["shell fish", "shellfish"], ["casein", "dairy"]] as const) {
    const p: UserProfile = { ...BASE, allergies: a };
    let served = "";
    for (let s = 1; s <= 5 && !served; s++) {
      const w = withSeed(s, () => freshWeek(p));
      for (const d of w.days) for (const m of d.meals) if (haystackBlocked(mealHay(m), T(meaning))) served = `${d.day} ${m.name}`;
    }
    check(`allergen review, end to end: "${a}" serves no ${meaning}`, served === "", served);
  }
}

// ---------------------------------------------------------------- energy targets as properties (D5b)
console.log("\n--- TARGETS: properties (Mifflin-St Jeor, activity factors, floor, macro sum, hydration, body limits) ---");
{
  const ACTS = ["sedentary", "light", "moderate", "active", "very_active"] as const;
  const GOALS = ["lose_weight", "maintain", "build_muscle"] as const;
  // Mifflin MD, St Jeor ST et al., Am J Clin Nutr 1990;51:241-7, in the rounded form clinical references
  // use: 10*kg + 6.25*cm - 5*age + 5 (men) / - 161 (women). The paper's own regression is
  // 9.99*kg + 6.25*cm - 4.92*age + 166*sex - 161; the app uses the rounded form.
  const MSJ = (age: number, cm: number, kg: number, sex: "male" | "female") =>
    10 * kg + 6.25 * cm - 5 * age + (sex === "male" ? 5 : -161);

  // 1. Worked examples, by hand and one published (Omni Calculator: 60 y man, 5'4" = 162.56 cm,
  //    150 lb = 68.04 kg -> 680.4 + 1016 - 300 + 5 = 1401.4 kcal/day).
  const worked: [string, number, number, number, "male" | "female", number][] = [
    ["M 30y 180cm 80kg", 30, 180, 80, "male", 1780],
    ["F 30y 165cm 60kg", 30, 165, 60, "female", 1320.25],
    ["M 60y 162.56cm 68.04kg (published)", 60, 162.56, 68.04, "male", 1401.4],
    ["F 45y 160cm 55kg", 45, 160, 55, "female", 1164],
    ["M 25y 175cm 70kg", 25, 175, 70, "male", 1673.75],
    ["F 70y 150cm 50kg", 70, 150, 50, "female", 926.5],
  ];
  const offMsj = worked.filter(([, a, h, w, s, want]) => Math.abs(bmr({ age: a, heightCm: h, weightKg: w, sex: s }) - want) > 1e-9);
  check("bmr: Mifflin-St Jeor reproduced exactly on six worked examples", offMsj.length === 0,
    offMsj.map(([l, a, h, w, s]) => `${l} -> ${bmr({ age: a, heightCm: h, weightKg: w, sex: s })}`).join("; "));

  // 2. Monotonicity, as exact partial slopes: +1 kg = +10, +1 cm = +6.25, +1 y = -5, male - female = 166.
  const slopeErr: string[] = [];
  for (const sex of ["male", "female"] as const)
    for (let age = 18; age <= 90; age += 6) for (let h = 140; h <= 210; h += 7) for (let w = 40; w <= 200; w += 8) {
      const b = bmr({ age, heightCm: h, weightKg: w, sex });
      const dw = bmr({ age, heightCm: h, weightKg: w + 1, sex }) - b;
      const dh = bmr({ age, heightCm: h + 1, weightKg: w, sex }) - b;
      const da = bmr({ age: age + 1, heightCm: h, weightKg: w, sex }) - b;
      const ds = bmr({ age, heightCm: h, weightKg: w, sex: "male" }) - bmr({ age, heightCm: h, weightKg: w, sex: "female" });
      if (Math.abs(dw - 10) > 1e-9 || Math.abs(dh - 6.25) > 1e-9 || Math.abs(da + 5) > 1e-9 || Math.abs(ds - 166) > 1e-9)
        slopeErr.push(`${sex} ${age}/${h}/${w}: dW=${dw} dH=${dh} dA=${da} dSex=${ds}`);
    }
  check("bmr: heavier +10/kg, taller +6.25/cm, older -5/y, male-female = 166, everywhere", slopeErr.length === 0, slopeErr[0] ?? "");

  // 2b. The same order survives the whole pipeline: calories never fall with weight, height or
  //     activity, never rise with age, and lose <= maintain <= build.
  const monoErr: string[] = [];
  for (const sex of ["male", "female"] as const)
    for (let age = 18; age <= 90; age += 12) for (let h = 140; h <= 210; h += 14) for (let w = 40; w <= 200; w += 16)
      for (const goal of GOALS) {
        const kc = (o: Partial<{ age: number; heightCm: number; weightKg: number }>, activity: (typeof ACTS)[number]) =>
          computeTargets({ age, heightCm: h, weightKg: w, sex, activity, goal, ...o }).calories;
        const byAct = ACTS.map((a) => kc({}, a));
        for (let i = 1; i < byAct.length; i++) if (byAct[i] < byAct[i - 1]) monoErr.push(`${sex} ${goal} ${age}/${h}/${w} by activity: ${byAct.join(",")}`);
        for (const a of ACTS) {
          const c = kc({}, a);
          if (kc({ weightKg: w + 5 }, a) < c || kc({ heightCm: h + 5 }, a) < c || kc({ age: age + 5 }, a) > c)
            monoErr.push(`${sex} ${a} ${goal} ${age}/${h}/${w}`);
        }
      }
  for (const sex of ["male", "female"] as const) for (const a of ACTS) for (let w = 40; w <= 200; w += 16) {
    const g = GOALS.map((goal) => computeTargets({ age: 40, heightCm: 170, weightKg: w, sex, activity: a, goal }).calories);
    if (!(g[0] <= g[1] && g[1] <= g[2])) monoErr.push(`${sex} ${a} ${w}kg lose/maintain/build ${g.join(",")}`);
  }
  check("computeTargets: calories monotone in weight, height, age, activity and goal", monoErr.length === 0, monoErr[0] ?? "");

  // 3. Activity factors are the Harris-Benedict standard activity factors (1.2 / 1.375 / 1.55 /
  //    1.725 / 1.9). M 25y 160cm 72kg has a BMR of exactly 1600, so every TDEE is an integer.
  const STD = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very_active: 1.9 } as const;
  const b1600 = { age: 25, heightCm: 160, weightKg: 72, sex: "male" as const };
  const tds = ACTS.map((activity) => computeTargets({ ...b1600, activity, goal: "maintain" }));
  check("activity factors: BMR 1600 -> TDEE 1920 / 2200 / 2480 / 2760 / 3040",
    bmr(b1600) === 1600 && tds.map((t) => t.tdee).join() === "1920,2200,2480,2760,3040" && tds.map((t) => t.calories).join() === "1920,2200,2480,2760,3040",
    `tdee ${tds.map((t) => t.tdee).join(",")}, kcal ${tds.map((t) => t.calories).join(",")}`);
  const pipeErr: string[] = [];
  for (const sex of ["male", "female"] as const) for (const a of ACTS)
    for (let age = 18; age <= 90; age += 8) for (let h = 140; h <= 210; h += 10) for (let w = 40; w <= 200; w += 10) {
      const exact = MSJ(age, h, w, sex);
      const t = computeTargets({ age, heightCm: h, weightKg: w, sex, activity: a, goal: "maintain" });
      if (t.bmr !== Math.round(exact) || Math.abs(t.tdee - exact * STD[a]) > 0.5) pipeErr.push(`${sex} ${a} ${age}/${h}/${w}: tdee ${t.tdee} vs ${exact * STD[a]}`);
    }
  check("computeTargets: bmr = round(MSJ), tdee = round(MSJ x standard factor), across a grid", pipeErr.length === 0, pipeErr[0] ?? "");

  // 4. The floor holds on every input, for every sex value the code can be handed — unknown/other
  //    falls back to the lower floor — and a clamp always lands exactly on it.
  check("calorie floors: male 1500, female 1200, default = the lower one",
    CALORIE_FLOOR.male === 1500 && CALORIE_FLOOR.female === 1200 && DEFAULT_CALORIE_FLOOR === 1200);
  const floorErr: string[] = [];
  let floorN = 0, floorClamped = 0;
  for (const sex of ["male", "female", "other", undefined, ""] as unknown as ("male" | "female")[]) {
    const floor = (CALORIE_FLOOR as Record<string, number>)[sex as string] ?? DEFAULT_CALORIE_FLOOR;
    for (const activity of ACTS) for (const goal of GOALS)
      for (let age = 18; age <= 110; age += 4) for (let h = 100; h <= 220; h += 10) for (let w = 25; w <= 250; w += 15) {
        const t = computeTargets({ age, heightCm: h, weightKg: w, sex, activity, goal });
        floorN++;
        if (t.clampedTo !== undefined) floorClamped++;
        if (!(t.calories >= floor)) floorErr.push(`sex=${String(sex)} ${activity} ${goal} ${age}/${h}/${w}: ${t.calories} < ${floor}`);
        if (t.clampedTo !== undefined && (t.clampedTo !== floor || t.calories !== floor))
          floorErr.push(`sex=${String(sex)} ${age}/${h}/${w}: ${t.calories} clampedTo=${t.clampedTo}`);
      }
  }
  check("calorie floor: never below it for male/female/other/unknown, on any input", floorErr.length === 0 && floorClamped > 0,
    floorErr[0] ?? `${floorN} inputs, ${floorClamped} clamped`);

  // 4b. Even handed garbage, computeTargets returns finite, non-negative targets at or above the floor
  //     (a NaN weight used to give NaN calories, and a weight of -80 a protein target of -160 g).
  const garbage = [NaN, Infinity, -Infinity, -80, 0, 1e9];
  const garbageErr: string[] = [];
  for (const g of garbage) for (const field of ["age", "heightCm", "weightKg"] as const) {
    const t = computeTargets({ age: 30, heightCm: 170, weightKg: 70, sex: "female", activity: "light", goal: "lose_weight", [field]: g });
    const nums = [t.calories, t.proteinGrams, t.carbsGrams, t.fatGrams];
    if (!nums.every((n) => Number.isFinite(n) && n >= 0) || t.calories < 1200) garbageErr.push(`${field}=${g}: ${nums.join("/")}`);
  }
  check("computeTargets: never NaN, Infinity or negative, and never below the floor, whatever it is handed", garbageErr.length === 0, garbageErr[0] ?? `${garbage.length * 3} inputs`);

  // 5. The executor refuses a stat that is not a real number INSIDE the adult range, and stores nothing.
  //    Age 500 used to be stored and answered "your resting burn is about -570 kcal"; 5000 kg gave
  //    79,020 kcal and 8,000 g of protein.
  const wk = freshWeek(BASE);
  const absurd: [string, Partial<Operation>][] = [
    ["NaN weight", { weightKg: NaN }], ["Infinity height", { heightCm: Infinity }], ["-Infinity age", { age: -Infinity }],
    ["age 500", { age: 500 }], ["age 2", { age: 2 }], ["weight 5000 kg", { weightKg: 5000 }], ["weight 0.5 kg", { weightKg: 0.5 }],
    ["height 5 cm", { heightCm: 5 }], ["height 2500 cm", { heightCm: 2500 }],
  ];
  for (const [label, bad] of absurd) {
    const r = applyOperations(BASE, wk, [op({ tool: "compute_targets", age: 30, heightCm: 180, weightKg: 80, sex: "male", activity: "moderate", ...bad } as never)]);
    check(`compute_targets refuses ${label}, targets and bodyStats untouched`,
      r.notes.some((n) => /doesn't look right|only work out targets for adults/.test(n)) && r.profile.targetCalories === 2000 &&
        r.profile.proteinGrams === 150 && r.profile.bodyStats === undefined && !r.notes.some((n) => /resting burn/.test(n)),
      `${r.profile.targetCalories} kcal; ${r.notes[0] ?? "(none)"}`);
  }
  // A real body outside the validated range is told the truth, not that it made a typo (D5b review).
  for (const [label, stats, re] of [
    ["115 cm", { age: 30, heightCm: 115, weightKg: 45 }, /isn't validated for a height of 115 cm/],
    ["101 years", { age: 101, heightCm: 170, weightKg: 70 }, /isn't validated for an age of 101 years/],
    ["310 kg", { age: 40, heightCm: 180, weightKg: 310 }, /isn't validated for a weight of 310 kg/],
  ] as const) {
    const r = applyOperations(BASE, wk, [op({ tool: "compute_targets", ...stats, sex: "female", activity: "moderate" } as never)]);
    check(`compute_targets: a real body of ${label} is told the equation isn't validated for it, and nothing is stored`,
      r.notes.some((n) => re.test(n) && /GP or a registered dietitian/.test(n)) && !r.notes.some((n) => /doesn't look right/.test(n)) && r.profile.bodyStats === undefined,
      r.notes[0] ?? "(none)");
  }
  check("bodyStatMessage: two typos read as a list, with 'don't'",
    /^Your age and height don't look right/.test(bodyStatMessage(["age", "heightCm"], { age: 0, heightCm: 1.8 })), bodyStatMessage(["age", "heightCm"], { age: 0, heightCm: 1.8 }));
  const teen = applyOperations(BASE, wk, [op({ tool: "compute_targets", age: 15, heightCm: 165, weightKg: 55, sex: "female", activity: "light", goal: "lose_weight" } as never)]);
  check("compute_targets will not set a deficit for someone under 18, and says who should",
    teen.profile.targetCalories === 2000 && teen.profile.bodyStats === undefined && teen.notes.some((n) => /adults.*GP|dietitian/.test(n)), teen.notes[0] ?? "(none)");
  const edge = applyOperations(BASE, wk, [op({ tool: "compute_targets", age: BODY_LIMITS.age.min, heightCm: BODY_LIMITS.heightCm.max, weightKg: BODY_LIMITS.weightKg.max, sex: "male", activity: "moderate" } as never)]);
  check("compute_targets accepts the limits themselves", edge.profile.bodyStats?.weightKg === BODY_LIMITS.weightKg.max, edge.notes[0] ?? "(none)");

  // 6. The macro split adds back up EVERYWHERE in the executor's domain: 4P + 4C + 9F is within 7 kcal
  //    of the calorie target (carbs round +-2 kcal, calories round to 10 = +-5). It used to break at
  //    high weights, where protein at 2 g per kg of TOTAL weight left nothing for carbs (230 kg: 460 g
  //    of protein, 68% of the calories); protein is now per kg of weight capped at a BMI of 30.
  const macroErr: string[] = [];
  let macroN = 0, macroWorst = 0, zeroCarb = 0;
  for (const sex of ["male", "female"] as const) for (const activity of ACTS) for (const goal of GOALS)
    for (let age = BODY_LIMITS.age.min; age <= BODY_LIMITS.age.max; age += 3)
      for (let h = BODY_LIMITS.heightCm.min; h <= BODY_LIMITS.heightCm.max; h += 7)
        for (let w = BODY_LIMITS.weightKg.min; w <= BODY_LIMITS.weightKg.max; w += 9) {
          const t = computeTargets({ age, heightCm: h, weightKg: w, sex, activity, goal });
          if (t.carbsGrams === 0) zeroCarb++;
          macroN++;
          const d = Math.abs(t.proteinGrams * 4 + t.carbsGrams * 4 + t.fatGrams * 9 - t.calories);
          macroWorst = Math.max(macroWorst, d);
          if (d > 7) macroErr.push(`${sex} ${activity} ${goal} ${age}/${h}/${w}: P${t.proteinGrams} C${t.carbsGrams} F${t.fatGrams} vs ${t.calories}`);
        }
  check("macros: 4P + 4C + 9F within 7 kcal of the calorie target, across the whole accepted range", macroErr.length === 0, macroErr[0] ?? `${macroN} inputs, worst ${macroWorst} kcal`);
  check("macros: carbs never squeezed to 0 anywhere in the accepted range", zeroCarb === 0, `${zeroCarb}`);
  const big = computeTargets({ age: 60, heightCm: 155, weightKg: 230, sex: "female", activity: "sedentary", goal: "lose_weight" });
  check("protein for a very heavy body is set from a BMI-30 reference weight, not total weight",
    big.proteinGrams <= Math.round(2.0 * 30 * 1.55 * 1.55) && big.proteinGrams * 4 <= 0.4 * big.calories, `${big.proteinGrams} g of ${big.calories} kcal`);
  const ordinary = computeTargets({ age: 30, heightCm: 180, weightKg: 80, sex: "male", activity: "moderate", goal: "build_muscle" });
  check("...and an ordinary body's protein is unchanged (1.9 g/kg x 80 kg)", ordinary.proteinGrams === 152, `${ordinary.proteinGrams}`);

  // 7. Hydration: 35 mL/kg + the sweat allowance; drink 80% of it to the nearest 50 mL; low <= drink <= high;
  //    monotone in weight and activity.
  const ALLOW = [0, 250, 500, 750, 1000];
  const hydErr: string[] = [];
  for (let w = 30; w <= 200; w++) ACTS.forEach((a, i) => {
    const h = hydrationTarget(w, a);
    if (h.totalMl !== Math.round(35 * w) + ALLOW[i]) hydErr.push(`total ${w}kg ${a}`);
    if (h.drinksMl % 50 || h.lowMl % 50 || h.highMl % 50) hydErr.push(`not to 50 mL ${w}kg ${a}`);
    if (Math.abs(h.drinksMl - 0.8 * h.totalMl) > 25) hydErr.push(`drinks ${h.drinksMl} vs 80% of ${h.totalMl}`);
    if (!(h.lowMl <= h.drinksMl && h.drinksMl <= h.highMl)) hydErr.push(`band ${w}kg ${a}`);
    if (i && hydrationTarget(w, ACTS[i - 1]).drinksMl > h.drinksMl) hydErr.push(`activity order ${w}kg ${a}`);
    if (hydrationTarget(w + 1, a).drinksMl < h.drinksMl) hydErr.push(`weight order ${w}kg ${a}`);
  });
  check("hydrationTarget: 35 mL/kg + allowance, 80% to drink in 50 mL steps, band brackets it, monotone", hydErr.length === 0, hydErr[0] ?? "");
  check("hydrationTarget: never negative, whatever weight it is handed", [-80, NaN, 0, 1e9].every((w) => hydrationTarget(w, "sedentary").drinksMl > 0));
  // Body water follows lean mass, as protein does: above BMI 30 (when the height is known) fluid is
  // worked from the same reference weight, and the note says so. 300 kg was told 8.4 L a day.
  {
    const tall: UserProfile = { ...BASE, bodyStats: { age: 40, heightCm: 170, weightKg: 150, sex: "female", activity: "sedentary" } };
    const r = applyOperations(tall, wk, [op({ tool: "hydration" } as never)]);
    const ref = Math.round(referenceWeightKg(150, 170));
    check("hydration: above BMI 30 it is worked from the reference weight, and says so",
      ref < 150 && r.notes.some((n) => n.includes(`I worked it from ${ref} kg rather than 150`)), r.notes[0] ?? "(none)");
    const real = applyOperations(BASE, wk, [op({ tool: "hydration", weightKg: 310 } as never)]);
    check("hydration: a real weight above the range is told the rule isn't validated, not that it looks wrong",
      real.notes.some((n) => /isn't validated at 310 kg/.test(n)) && real.profile.bodyStats?.weightKg === undefined, real.notes[0] ?? "(none)");
  }
  for (const w of [-80, 5000, 10]) {
    const r = applyOperations(BASE, wk, [op({ tool: "hydration", weightKg: w } as never)]);
    check(`hydration refuses a weight of ${w} kg and does not store it`,
      r.profile.bodyStats?.weightKg === undefined && !r.notes.some((n) => /aim for about/.test(n)) && r.notes.some((n) => /doesn't look right/.test(n)),
      r.notes[0] ?? "(none)");
  }
}
{
  // gramsFor must read a MIXED number ("1 1/2") as 1.5, not the old silent 100g misparse; and a
  // plain "1/2" must still halve (regression guard for the widened regex). Ratios avoid magic grams.
  const one = gramsFor("olive oil", "1 tbsp");
  const oneHalf = gramsFor("olive oil", "1 1/2 tbsp");
  const half = gramsFor("olive oil", "1/2 tbsp");
  check("gramsFor: '1 1/2 tbsp' parses as 1.5x (mixed number), not a 100g misparse",
    one != null && oneHalf != null && Math.abs(oneHalf - 1.5 * one) < 1e-9, `${one} -> ${oneHalf}`);
  check("gramsFor: '1/2 tbsp' still halves", one != null && half != null && Math.abs(half - 0.5 * one) < 1e-9, `${half}`);

  // Weight + volume units added 2026-09-03 (cup/oz/kg/lb/l), so a pasted/imported quantity resolves
  // to grams instead of silently dropping to null and lowering micro coverage. Weight units are
  // exact; volume assumes a water-like density (a "cup" is the liquid cup). No recipe uses these
  // yet, so this is import robustness, not a change to any existing dish's micros.
  check("gramsFor: ounces (weight, exact)", gramsFor("chicken breast", "4 oz") === 4 * 28.35);
  check("gramsFor: pounds", gramsFor("ground beef", "1 lb") === 453.6);
  check("gramsFor: kilograms", gramsFor("flour", "2 kg") === 2000);
  check("gramsFor: litres (volume, water-like)", gramsFor("stock", "1 l") === 1000);
  check("gramsFor: a cup defaults to a liquid cup (240 g)", gramsFor("yogurt", "1 cup") === 240);
  check("gramsFor: cups plural with a mixed number", gramsFor("rice", "1 1/2 cups") === 360);
}
// ---------------------------------------------------------------- unit conversion laws (D5b)
console.log("\n--- UNIT CONVERSION LAWS (gramsFor + unitGrams.generated) ---");
{
  const D = UNIT_GRAMS.default;
  const P = UNIT_GRAMS.perIngredient;

  // 1. The DEFAULT table agrees with itself. Exact, because every value is a terminating decimal and
  //    the multipliers are small integers. lb/oz are within 0.01% of the international avoirdupois
  //    definitions (28.349523125 g, 453.59237 g); the spoons are the metric 5/15 ml with a 240 ml cup.
  check("units: default 1 tbsp = 3 tsp", D.tbsp === 3 * D.tsp, `${D.tbsp} vs ${3 * D.tsp}`);
  check("units: default 1 cup = 16 tbsp", D.cup === 16 * D.tbsp, `${D.cup} vs ${16 * D.tbsp}`);
  check("units: default kg = 1000 g, l = 1000 ml", D.kg === 1000 * D.g && D.l === 1000 * D.ml);
  check("units: default lb = 16 oz", D.lb === 16 * D.oz, `${D.lb} vs ${16 * D.oz}`);
  check("units: oz and lb within 0.01% of their legal definitions",
    Math.abs(D.oz / 28.349523125 - 1) < 1e-4 && Math.abs(D.lb / 453.59237 - 1) < 1e-4, `oz=${D.oz} lb=${D.lb}`);
  check("units: default singular and plural agree (cup/cups, piece/pieces, slice/slices, clove/cloves)",
    D.cup === D.cups && D.piece === D.pieces && D.slice === D.slices && D.clove === D.cloves);

  // 2. Every weight in the table is a positive finite number, and every key is reachable: gramsFor
  //    lowercases both the ingredient and the unit, and the unit regex only captures [a-zA-Z-].
  const badVal: string[] = [];
  const badKey: string[] = [];
  for (const [u, g] of Object.entries(D)) {
    if (!(Number.isFinite(g) && g > 0)) badVal.push(`default.${u}=${g}`);
    if (!/^[a-z-]+$/.test(u)) badKey.push(`default.${u}`);
  }
  for (const [ing, t] of Object.entries(P)) {
    if (ing !== ing.trim().toLowerCase()) badKey.push(ing);
    for (const [u, g] of Object.entries(t)) {
      if (!(Number.isFinite(g) && g > 0)) badVal.push(`${ing}.${u}=${g}`);
      if (!/^[a-z-]+$/.test(u)) badKey.push(`${ing}.${u}`);
    }
  }
  check("units: every table weight is finite and > 0", badVal.length === 0, badVal.slice(0, 5).join(", "));
  check("units: every table key is reachable (lowercase, matched by the unit regex)", badKey.length === 0, badKey.slice(0, 5).join(", "));

  // 3. The generated module is the JSON it says it is generated from (not stale after a hand edit).
  const json = JSON.parse(readFileSync("scripts/food-units.json", "utf8"));
  check("units: unitGrams.generated.ts matches scripts/food-units.json",
    JSON.stringify(json.default) === JSON.stringify(D) && JSON.stringify(json.perIngredient) === JSON.stringify(P));

  // 4. Amount arithmetic is exact for every (ingredient, unit) the table knows, plus two ingredients
  //    it does not: "2 u" = 2x, "1 1/2 u" = 1.5x, "1/2 u" = 0.5x = "0.5 u", 1/4 + 3/4 = 1, and the
  //    result ignores case and whitespace. "count" is the bare number.
  const ings = [...Object.keys(P), "rice", "za'atar"];
  const units = [...new Set([...Object.keys(D), ...Object.values(P).flatMap((t) => Object.keys(t))])];
  const scaleBad: string[] = [];
  let pairs = 0;
  for (const x of ings) for (const u of units) {
    const sp = u === "count" ? "" : " " + u;
    const one = gramsFor(x, `1${sp}`);
    pairs++;
    // A size word on an item counted by its PARTS (a clove, a slice, a leaf) has no honest weight (D5b review).
    if (one == null) { if (!["small", "medium", "large"].includes(u)) scaleBad.push(`${x}|${u}: 1 -> null`); continue; }
    const two = gramsFor(x, `2${sp}`), mixed = gramsFor(x, `1 1/2${sp}`), half = gramsFor(x, `1/2${sp}`);
    const dec = gramsFor(x, `0.5${sp}`), q1 = gramsFor(x, `1/4${sp}`), q3 = gramsFor(x, `3/4${sp}`);
    const loud = gramsFor(`  ${x.toUpperCase()} `, `  1 / 2${sp.toUpperCase()}  `);
    if (two !== 2 * one) scaleBad.push(`${x}|${u}: 2x ${two} vs ${2 * one}`);
    if (mixed !== 1.5 * one) scaleBad.push(`${x}|${u}: 1 1/2 ${mixed} vs ${1.5 * one}`);
    if (half !== 0.5 * one) scaleBad.push(`${x}|${u}: 1/2 ${half} vs ${0.5 * one}`);
    if (dec !== half) scaleBad.push(`${x}|${u}: 0.5 ${dec} vs 1/2 ${half}`);
    if (q1 == null || q3 == null || Math.abs(q1 + q3 - one) > 1e-9 * one) scaleBad.push(`${x}|${u}: 1/4+3/4 != 1`);
    if (loud !== half) scaleBad.push(`${x}|${u}: case/whitespace ${loud} vs ${half}`);
  }
  check("units: 2x, 1 1/2, 1/2, 0.5 and 1/4+3/4 scale exactly, case- and whitespace-blind",
    scaleBad.length === 0, `${pairs} ingredient/unit pairs; ${scaleBad.slice(0, 3).join("; ")}`);

  // 5. A unit it does not know is null, never a guess — including near-misses of known units
  //    ("tablespoon", "cans", "lbs") and the T/t ambiguity, which must not silently pick one.
  // (Unambiguous spellings — "tablespoons", "grams", "lbs", "cans" — are aliases since the D5b review;
  // "T", "t" and "c" stay unknown, because tablespoon against teaspoon is a 3x error either way.)
  const unknownQ = ["1 pinch", "1 handful", "1 bunch", "1 dash", "2 sprigs", "1 tin", "1 packet", "1 T", "1 t",
    "1 c", "1 fl-oz", "1 to 2 cups", "2-3 cloves", "2 eggs", "1 head", "1 stick", "1 large head", "2 small bulbs"];
  const guessed = unknownQ.filter((q) => gramsFor("rice", q) !== null || gramsFor("eggs", q) !== null);
  check("units: an unknown unit returns null, never a guess", guessed.length === 0, guessed.join(", "));

  // 6. Degenerate amounts are refused, and nothing ever comes back NaN, Infinity, zero or negative.
  const degenerate = ["", "   ", "0", "0 g", "0.0 g", "00 g", "0/1 g", "1/0 g", "0/0 g", "0 1/0 g", "-1 cup", "- 1 cup",
    "NaN g", "Infinity g", "abc", "g", "1e3 g", ".5 cup"];
  const accepted = degenerate.filter((q) => gramsFor("rice", q) !== null);
  check("units: zero, negative, divide-by-zero and non-numeric amounts return null", accepted.length === 0, accepted.join(", "));
  {
    let s = 12345;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const parts = ["0", "1", "2", "10", "1/2", "3/4", "1/0", "0/0", "1.5", ".5", "-", " ", "/", "1 1/2", "cup", "tbsp", "g",
      "piece", "x", "(", ")", "e", "E5", "99999999999999999999999999999999", ",", "."];
    const weird: string[] = [];
    for (let k = 0; k < 20000; k++) {
      let q = "";
      const n = 1 + Math.floor(rnd() * 4);
      for (let j = 0; j < n; j++) q += parts[Math.floor(rnd() * parts.length)] + (rnd() < 0.5 ? " " : "");
      const g = gramsFor(ings[Math.floor(rnd() * ings.length)], q);
      if (g !== null && !(Number.isFinite(g) && g > 0)) weird.push(`"${q}" -> ${g}`);
    }
    check("units: fuzz — 20,000 random quantities give null or a finite positive weight", weird.length === 0, weird.slice(0, 3).join(", "));
  }

  // 7. Every quantity in the library weighs something — by the key the engine uses (tableKey) AND by
  //    the display name, which is what bulkGroceriesFromWeek and the substitute cost read. If the two
  //    paths disagreed, the grocery list would sum different grams from the macros the card shows.
  const unweighable: string[] = [];
  const pathsDiffer: string[] = [];
  let rows = 0;
  for (const r of RECIPES) for (const i of r.ingredients) {
    rows++;
    const g = gramsFor(tableKey(i), i.quantity);
    if (g == null || !Number.isFinite(g) || g <= 0) unweighable.push(`${r.id}: ${i.name} "${i.quantity}"`);
    if (gramsFor(i.name, i.quantity) !== g) pathsDiffer.push(`${r.id}: ${i.name} "${i.quantity}"`);
  }
  check("units: every ingredient quantity in the library resolves to grams", unweighable.length === 0,
    `${rows} rows; ${unweighable.slice(0, 3).join("; ")}`);
  check("units: display-name and tableKey paths weigh every library row the same", pathsDiffer.length === 0, pathsDiffer.slice(0, 3).join("; "));

  // 8. scripts/build-nutrients.mts keeps its OWN, older parser for its accuracy gate, and that one does
  //    not read mixed numbers ("1 1/2 tbsp" olive oil = 100 g there, 20.25 g here). The two agree on
  //    the library only while no seed is written as a mixed number; when one is, port the regex there.
  const mixedSeeds = RECIPES.flatMap((r) => r.ingredients.filter((i) => /^\s*\d+\s+\d+\s*\//.test(i.quantity)).map((i) => `${r.id}: "${i.quantity}"`));
  check("units: no library quantity is a mixed number (build-nutrients.mts's parser can't read one)", mixedSeeds.length === 0, mixedSeeds.slice(0, 3).join("; "));
  // 9. Per INGREDIENT, every unit agrees with the ones it overrides (D5b found these broken: a matcha
  //    tablespoon weighed 15 g though 3 of its teaspoons weigh 6; a cup of olive oil 240 g though 16 of
  //    its tablespoons weigh 216; "bell peppers: 2 pieces" 200 g while "2 piece" was 238 g — a live seed).
  //    3% tolerance: where an ingredient overrides BOTH units of a pair, the two are separate kitchen
  //    measurements (cocoa: 2.5 g a teaspoon, 7.4 g a tablespoon) and need not divide exactly.
  const near = (a: number | null, b: number | null) => a != null && b != null && Math.abs(a - b) <= 0.03 * Math.max(a, b);
  const unitLaw: string[] = [];
  for (const x of Object.keys(P)) {
    const g = (q: string) => gramsFor(x, q);
    if (!near(g("1 tbsp"), 3 * (g("1 tsp") ?? NaN))) unitLaw.push(`${x}: tbsp ${g("1 tbsp")} vs 3 tsp ${3 * (g("1 tsp") ?? NaN)}`);
    if (!near(g("1 cup"), 16 * (g("1 tbsp") ?? NaN))) unitLaw.push(`${x}: cup ${g("1 cup")} vs 16 tbsp`);
    if (!near(g("1 tbsp"), g("15 ml"))) unitLaw.push(`${x}: tbsp ${g("1 tbsp")} vs 15 ml ${g("15 ml")}`);
    if (!near(g("1 l"), 1000 * (g("1 ml") ?? NaN))) unitLaw.push(`${x}: l vs 1000 ml`);
    for (const [a, b] of [["piece", "pieces"], ["slice", "slices"], ["clove", "cloves"], ["cup", "cups"]])
      if (g(`2 ${a}`) !== g(`2 ${b}`)) unitLaw.push(`${x}: 2 ${a} ${g(`2 ${a}`)} vs 2 ${b} ${g(`2 ${b}`)}`);
    const t = P[x] as Record<string, number | undefined>;
    if (t.count != null || t.piece != null || t.pieces != null) {
      if (!(g("1") === g("1 piece") && g("1 piece") === g("1 pieces"))) unitLaw.push(`${x}: count ${g("1")} / piece ${g("1 piece")} / pieces ${g("1 pieces")}`);
      // Both null is the honest answer for an item counted by its parts (garlic by the clove, bread by the slice).
      const sizesNull = g("1 small") === null && g("1 large") === null && [t.clove, t.cloves, t.slice, t.slices, t.leaves].some((p) => p != null && p === g("1"));
      if (!sizesNull && !((g("1 small") ?? NaN) <= (g("1") ?? NaN) && (g("1") ?? NaN) <= (g("1 large") ?? NaN))) unitLaw.push(`${x}: small ${g("1 small")} / count ${g("1")} / large ${g("1 large")}`);
    }
  }
  check("units: per ingredient, tbsp = 3 tsp = 15 ml, cup = 16 tbsp, l = 1000 ml, singular = plural, count = piece, small <= one <= large",
    unitLaw.length === 0, unitLaw.slice(0, 4).join("; ") || `${Object.keys(P).length} ingredients`);
  check("units: eggs come in USDA sizes (small 38, medium 44, large 50 g)",
    gramsFor("eggs", "1 small") === 38 && gramsFor("eggs", "1 medium") === 44 && gramsFor("eggs", "2 large") === 100);

  // 10. A number with text after it that is not a unit is null, not "count"; a whole number is a mixed
  //     number only when a real fraction follows it. ("2 (400 g) cans" was 200 g; "1 2 cups" was 3 cups.)
  const junk = ["2 (400 g) cans", "1,5 g", "1.5.2 g", "1/2/3 cup", "1/-2 cup", "1 (15 oz) can", "1 2 cups", "1 14 oz can", "3 1 g", "10 3 g"];
  const junkWeighed = junk.filter((q) => gramsFor("rice", q) !== null);
  check("units: a number followed by something that is not a unit is null, never a count", junkWeighed.length === 0, junkWeighed.map((q) => `"${q}" -> ${gramsFor("rice", q)}`).join(", "));
  check("units: thousands separators and vulgar fractions read as written (1,000 g; 2 ½ cups; ½ cup)",
    gramsFor("rice", "1,000 g") === 1000 && gramsFor("rice", "2 ½ cups") === 600 && gramsFor("rice", "½ cup") === 120);
  check("units: a unit may still be followed by words (\"70 g dry\", \"2 pieces, beaten\")",
    gramsFor("rice", "70 g dry") === 70 && gramsFor("eggs", "2 pieces, beaten") === 100);

  // 11. From the D5b review. A European decimal is never read as thousands ("0,250 l" of milk was
  //     257 kg). Recipe-site punctuation after a unit still weighs ("2 tbsp.", "200g/7oz"). A size word
  //     before another unit noun has no honest weight ("1 large head" of lettuce was 7.8 g), nor does
  //     one on an item whose count is a part of it (a clove, a slice, a leaf).
  check("units review: '0,250 l' and '0,500 kg' are not read as thousands",
    gramsFor("milk", "0,250 l") === null && gramsFor("rice", "0,500 kg") === null, `${gramsFor("milk", "0,250 l")}`);
  const punct: [string, string, number][] = [["olive oil", "2 tbsp.", 27], ["chicken breast", "1 lb.", 453.6], ["rice", "100g.", 100],
    ["rice", "200g/7oz", 200], ["rice", "2 cups)", 480], ["rice", "1 cup:", 240], ["onion", "2, diced", 220]];
  const punctBad = punct.filter(([i, q, g]) => Math.abs((gramsFor(i, q) ?? NaN) - g) > 1e-6);
  check("units review: punctuation after a unit, and 'N, diced', still weigh", punctBad.length === 0, punctBad.map(([i, q]) => `${i} "${q}" -> ${gramsFor(i, q)}`).join("; "));
  check("units review: '1 (about 150 g)' is still not one of anything", gramsFor("onion", "1 (about 150 g)") === null);
  const sized = [["romaine", "1 large head"], ["lettuce", "1 small head"], ["garlic", "1 large head"], ["garlic", "1 medium bulb"], ["garlic", "1 large"], ["sourdough bread", "1 large"]];
  const sizedBad = sized.filter(([i, q]) => gramsFor(i, q) !== null);
  check("units review: a size word with no honest weight is null, never a leaf or a clove scaled up", sizedBad.length === 0, sizedBad.map(([i, q]) => `${i} "${q}" -> ${gramsFor(i, q)}`).join("; "));
  check("units review: egg whites use USDA-scaled sizes (3 large = 99 g)", gramsFor("egg whites", "3 large") === 99);
  const aliases: [string, string, string][] = [["olive oil", "2 tablespoons", "2 tbsp"], ["cumin", "3 teaspoons", "3 tsp"], ["rice", "200 grams", "200 g"],
    ["chicken breast", "1 lbs", "1 lb"], ["chicken breast", "2 pounds", "2 lb"], ["milk", "1 litre", "1 l"], ["chickpeas", "2 cans", "2 can"], ["protein powder", "2 scoops", "2 scoop"]];
  const aliasBad = aliases.filter(([i, a, b]) => gramsFor(i, a) === null || gramsFor(i, a) !== gramsFor(i, b));
  check("units review: unambiguous unit spellings weigh the same as the short form", aliasBad.length === 0, aliasBad.map(([i, a]) => `${i} "${a}" -> ${gramsFor(i, a)}`).join("; "));
}

// ---------------------------------------------------------------- USDA table + Atwater (D5b)
// The nutrient table is a verbatim copy of USDA SR Legacy (a probe against the CSVs in
// data/usda found 0 differences in 180 entries x 15 nutrients, and 0 description mismatches), except
// that a value a food's entry does not report may be FILLED from another SR Legacy entry for the same
// food (shrimp's B12, from 174210). These laws are what it must satisfy without the 36 MB source.
console.log("\n--- USDA TABLE (per-entry laws, documented gaps, exact use) ---");
{
  type P100 = (typeof NUTRIENT_TABLE)[string]["per100g"];
  type NKey = keyof P100;
  const ENTRIES = Object.entries(NUTRIENT_TABLE);
  const v = (e: { per100g: P100 }, k: NKey) => e.per100g[k] ?? 0;

  // 1. No negative, NaN or infinite value anywhere: a negative gram cannot exist, and a NaN would
  //    poison every sum it reaches (deriveMacros, microsForIngredients) without throwing.
  const bad: string[] = [];
  for (const [k, e] of ENTRIES)
    for (const [n, x] of Object.entries(e.per100g))
      if (typeof x !== "number" || !Number.isFinite(x) || x < 0) bad.push(`${k}.${n}=${x}`);
  check("USDA: no negative or non-finite value in any entry", bad.length === 0, bad.slice(0, 5).join(", "));

  // 2. Energy and the three macros are always present. Fiber is NOT required: SR Legacy has no fiber
  //    row for soba 168906 or tempeh 174272 (raw shrimp's is filled from 174210) — see 2b.
  const noMacro = ENTRIES.filter(([, e]) => (["cal", "protein", "carbs", "fat"] as const).some((m) => e.per100g[m] === undefined)).map(([k]) => k);
  check("USDA: every entry has cal, protein, carbs and fat", noMacro.length === 0, noMacro.join(", "));

  // 2b. Every nutrient an entry lacks is a DOCUMENTED gap, listed on the entry; nothing reads as 0
  //     unannounced. build-nutrients fails on an undocumented one; this proves the table it wrote agrees.
  //     Shrimp used to claim full micronutrient coverage while counting raw shrimp as having no B12,
  //     which the same food's other raw entry reports at 1.11 ug per 100 g (D5b).
  const ALL_KEYS = ["cal", "protein", "carbs", "fat", "fiber", "calcium", "iron", "magnesium", "potassium", "sodium", "zinc", "vitD", "vitC", "folate", "b12"] as const;
  const undocumented: string[] = [];
  for (const [k, e] of ENTRIES) {
    const missing = ALL_KEYS.filter((n) => e.per100g[n] === undefined);
    const gaps = e.gaps ?? [];
    if (missing.join() !== [...gaps].sort((a, b) => ALL_KEYS.indexOf(a as never) - ALL_KEYS.indexOf(b as never)).join()) undocumented.push(`${k}: missing [${missing}] vs gaps [${gaps}]`);
  }
  check("USDA: every missing nutrient is a documented gap, and every documented gap is really missing", undocumented.length === 0, undocumented.slice(0, 4).join("; "));
  check("USDA: shrimp and prawns carry B12 and folate, filled from the same food's other raw entry (174210)",
    (["shrimp", "prawns"] as const).every((k) => NUTRIENT_TABLE[k].per100g.b12 === 1.11 && NUTRIENT_TABLE[k].filledFrom?.fdcId === 174210 && NUTRIENT_TABLE[k].per100g.cal === 85),
    JSON.stringify(NUTRIENT_TABLE.shrimp.filledFrom));

  // 3. Mass balance. USDA carbohydrate is nutrient 1005, "by difference" = 100 - water - ash -
  //    protein - fat (- alcohol), and it INCLUDES fiber, so P + C + F can reach 100 (an oil) but
  //    never pass it. 0.01 g covers the 2-dp rounding of three fields.
  let maxPcf = 0, maxPcfKey = "";
  for (const [k, e] of ENTRIES) {
    const s = v(e, "protein") + v(e, "carbs") + v(e, "fat");
    if (s > maxPcf) { maxPcf = s; maxPcfKey = k; }
  }
  check("USDA: protein + carbs + fat <= 100 g per 100 g", maxPcf <= 100.01, `max ${maxPcf.toFixed(2)} (${maxPcfKey})`);

  //    ...and with the micronutrients added in grams (mg / 1e3, ug / 1e6). Olive oil is 100.005 g:
  //    its fat is printed as exactly 100, so 0.05 g of rounding allowance is needed, and is all.
  const MG: NKey[] = ["calcium", "iron", "magnesium", "potassium", "sodium", "zinc", "vitC"];
  const UG: NKey[] = ["vitD", "folate", "b12"];
  let maxAll = 0, maxAllKey = "";
  for (const [k, e] of ENTRIES) {
    const s = v(e, "protein") + v(e, "carbs") + v(e, "fat")
      + MG.reduce((t, n) => t + v(e, n), 0) / 1000 + UG.reduce((t, n) => t + v(e, n), 0) / 1e6;
    if (s > maxAll) { maxAll = s; maxAllKey = k; }
  }
  check("USDA: macros + micronutrients never outweigh the 100 g they are measured in", maxAll <= 100.05, `max ${maxAll.toFixed(3)} g (${maxAllKey})`);

  // 4. Fiber is a PART of carbohydrate-by-difference, so it can never exceed it.
  const fiberOver = ENTRIES.filter(([, e]) => v(e, "fiber") > v(e, "carbs")).map(([k, e]) => `${k} fiber ${v(e, "fiber")} > carbs ${v(e, "carbs")}`);
  check("USDA: fiber <= carbs in every entry (fiber is inside carbs-by-difference)", fiberOver.length === 0, fiberOver.join("; "));

  // 5. No value exceeds the most extreme food in the WHOLE of SR Legacy for that nutrient (maxima
  //    measured from data/usda, fdc of the record holder in the comment). Catches a unit slip:
  //    vitamin D written in IU or ng, sodium in ug, energy in kJ.
  const SR_LEGACY_MAX: Record<NKey, number> = {
    cal: 902,         // 171400
    protein: 88.32,   // 174276
    carbs: 100,       // 169896
    fat: 100,         // 167625
    fiber: 79,        // 170289
    calcium: 7364,    // 172804
    iron: 123.6,      // 170938
    magnesium: 781,   // 169713
    potassium: 16500, // 175041
    sodium: 38758,    // 173468 (salt)
    zinc: 90.95,      // 171981
    vitD: 250,        // 173577
    vitC: 2732,       // 173487
    folate: 3786,     // 167717
    b12: 98.89,       // 171975
  };
  const overCap: string[] = [];
  for (const [k, e] of ENTRIES)
    for (const n of Object.keys(SR_LEGACY_MAX) as NKey[])
      if (v(e, n) > SR_LEGACY_MAX[n]) overCap.push(`${k}.${n}=${v(e, n)} > ${SR_LEGACY_MAX[n]}`);
  check("USDA: no value exceeds the SR Legacy maximum for its nutrient (unit slips)", overCap.length === 0, overCap.slice(0, 5).join("; "));

  // 6. Energy. USDA computes kcal with FOOD-SPECIFIC Atwater factors, so 4/4/9 is only an
  //    approximation. Every entry must land within max(15 kcal, 10%) of 4/4/9 — the nut/seed/legume
  //    family sits at 7-9% (honey, tempeh, avocado, garlic use 88% of that allowance) — OR be one
  //    of the reviewed outliers below, whose kcal must then match USDA's own specific factors
  //    (protein / carbs / fat, from food_calorie_conversion_factor.csv) to within 1 kcal: USDA
  //    rounds energy to whole kcal. All eight are high-fiber spices, cocoa or citrus; none is a
  //    data error. A NEW entry that misses 4/4/9 badly fails here until someone looks at it.
  const SPECIFIC_FACTORS: Record<number, [number, number, number]> = {
    169593: [1.83, 1.33, 8.37], // cocoa, dry powder, unsweetened   (4/4/9 overshoots 90%)
    171320: [1.82, 2.85, 8.37], // cinnamon, ground                  (42%)
    171329: [3.36, 2.35, 8.37], // paprika (also smoked paprika, cajun spice)  (38%)
    171319: [3.23, 2.39, 8.37], // chili powder (also fajita, taco spice)      (35%)
    170924: [3.12, 2.92, 8.37], // curry powder (also tikka, ras el hanout)    (25%)
    170923: [3.36, 2.9, 8.37],  // cumin seed (also shawarma spice)            (20%)
    168155: [3.36, 2.48, 8.37], // limes, raw                        (56%, 17 kcal)
    167746: [3.36, 2.48, 8.37], // lemons, raw, without peel          (53%, 15 kcal)
  };
  const energyBad: string[] = [];
  const absMiss: number[] = [];
  for (const [k, e] of ENTRIES) {
    const P = v(e, "protein"), C = v(e, "carbs"), F = v(e, "fat"), cal = v(e, "cal");
    const diff = 4 * P + 4 * C + 9 * F - cal;
    absMiss.push(Math.abs(diff));
    if (Math.abs(diff) <= Math.max(15, 0.1 * cal)) continue;
    const f = SPECIFIC_FACTORS[e.fdcId];
    if (!f) { energyBad.push(`${k} (${e.fdcId}): ${cal} kcal vs 4/4/9 ${(cal + diff).toFixed(1)} — unreviewed`); continue; }
    const specific = f[0] * P + f[1] * C + f[2] * F;
    if (Math.abs(specific - cal) > 1) energyBad.push(`${k} (${e.fdcId}): ${cal} kcal vs its specific factors ${specific.toFixed(1)}`);
  }
  absMiss.sort((a, b) => a - b);
  check("USDA: every entry's kcal matches 4/4/9, or its own USDA specific factors (reviewed list)",
    energyBad.length === 0,
    energyBad.length ? energyBad.slice(0, 5).join("; ") : `|4/4/9 - kcal| median ${absMiss[absMiss.length >> 1].toFixed(1)}, max ${absMiss[absMiss.length - 1].toFixed(1)} kcal`);
  // The reviewed list must not rot: every id on it is still in the table.
  const tableIds = new Set(ENTRIES.map(([, e]) => e.fdcId));
  const stale = Object.keys(SPECIFIC_FACTORS).filter((id) => !tableIds.has(Number(id)));
  check("USDA: every reviewed energy outlier is still in the table", stale.length === 0, stale.join(", "));

  // 7. Use: a recipe's macros are EXACTLY the table's numbers summed over its ingredients, per
  //    serving, rounded once at the end. If deriveMacros ever reads a different key for kcal than
  //    for protein, double-counts, or forgets servings on one field, this is where it shows.
  //    (No per-RECIPE Atwater check here, on purpose: with both sides derived from the table, a
  //    recipe's 4/4/9 miss is just the kcal-weighted mean of its ingredients' misses, so it is
  //    fully decided by law 6 plus the ingredient mix. A wrong QUANTITY only moves the weights —
  //    salmon x10 in Baked Salmon & Potatoes takes its miss from +2.05% to -1.74% — so a
  //    recipe-level Atwater tolerance cannot catch the error it was written to catch.)
  const drift: string[] = [];
  for (const r of RECIPES) {
    const servings = Math.max(1, r.servings ?? 1);
    let cal = 0, P = 0, C = 0, F = 0, Fi = 0;
    for (const i of r.ingredients) {
      const key = tableKey(i);
      const e = NUTRIENT_TABLE[key];
      const g = gramsFor(key, i.quantity);
      if (!e || !g) continue;
      const f = g / 100;
      cal += v(e, "cal") * f; P += v(e, "protein") * f; C += v(e, "carbs") * f; F += v(e, "fat") * f; Fi += v(e, "fiber") * f;
    }
    const want = [cal, P, C, F, Fi].map((x) => Math.round(x / servings));
    const got = [r.calories, r.proteinGrams, r.carbsGrams, r.fatGrams, r.fiberGrams];
    if (want.some((x, j) => x !== got[j])) drift.push(`${r.name}: ${got.join("/")} vs table ${want.join("/")}`);
  }
  check("USDA use: every recipe's kcal/P/C/F/fiber is exactly the table sum per serving", drift.length === 0, drift.slice(0, 3).join("; "));
}

// ---------------------------------------------------------------- macro derivation
// deriveMacros (plan/library.ts) is private, so every law here recomputes a recipe's macros from the
// exported pieces — NUTRIENT_TABLE + gramsFor + the ingredient's identity — and compares with RECIPES.
// The full recomputation goes through the SLUG's curated name, not tableKey's name-first route, so a
// display name that drifted onto another food would show up as a disagreement rather than agree with itself.
console.log("\n--- MACRO DERIVATION (recomputed independently) ---");
{
  type Ing = { name: string; quantity: string; slug?: string };
  const MACROS = ["cal", "protein", "carbs", "fat", "fiber"] as const;
  type M = (typeof MACROS)[number];
  const FIELD: Record<M, "calories" | "proteinGrams" | "carbsGrams" | "fatGrams" | "fiberGrams"> = {
    cal: "calories", protein: "proteinGrams", carbs: "carbsGrams", fat: "fatGrams", fiber: "fiberGrams",
  };
  const zero = (): Record<M, number> => ({ cal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 });
  const contribution = (i: Ing, viaSlug: boolean): Record<M, number> | null => {
    const key = viaSlug && i.slug ? INGREDIENTS[i.slug as keyof typeof INGREDIENTS]?.name : tableKey(i);
    const per = key ? NUTRIENT_TABLE[key]?.per100g : undefined;
    const g = key ? gramsFor(key, i.quantity) : null;
    if (!per || !g) return null;
    const out = zero();
    for (const k of MACROS) out[k] = ((per[k] ?? 0) * g) / 100;
    return out;
  };
  const totals = (ings: Ing[], viaSlug = false) => {
    const t = zero();
    for (const i of ings) {
      const c = contribution(i, viaSlug);
      if (c) for (const k of MACROS) t[k] += c[k];
    }
    return t;
  };
  const divisor = (r: { servings?: number }) => Math.max(1, r.servings ?? 1);
  // "1 1/2 cups" -> "3 cups", "1/4 piece" -> "0.5 piece", "70 g dry" -> "140 g dry"
  const doubleQty = (q: string): string | null => {
    const s = q.trim();
    const m = s.match(/^(?:(\d+)\s+)?(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+))?/);
    if (!m) return null;
    const amount = (m[1] ? Number(m[1]) : 0) + (m[3] ? Number(m[2]) / Number(m[3]) : Number(m[2]));
    return `${2 * amount}${s.slice(m[0].length)}`;
  };
  const lineCount = RECIPES.reduce((s, r) => s + r.ingredients.length, 0);

  // No silent skip: deriveMacros `continue`s past an ingredient it cannot find or weigh, which would
  // quietly understate the dish. Every library line must both resolve AND weigh.
  const skipped: string[] = [];
  for (const r of RECIPES) for (const i of r.ingredients) {
    const key = tableKey(i);
    const g = gramsFor(key, i.quantity);
    if (!NUTRIENT_TABLE[key] || !(g != null && g > 0)) skipped.push(`${r.id}: ${i.name} "${i.quantity}"`);
  }
  check("macros: no library ingredient is silently skipped (every line resolves in the table AND weighs)",
    skipped.length === 0, skipped.length ? skipped.slice(0, 5).join("; ") : `${lineCount} ingredient lines`);
  const partial = RECIPES.filter((r) => microsForIngredients(r.ingredients).coverage !== 1).map((r) => r.id);
  check("macros: every recipe has coverage 1 on the micronutrient path too (the same lookup)",
    partial.length === 0, partial.slice(0, 5).join(", "));

  // No `?? 0` fallback on an energy macro: every table entry a recipe uses states cal/protein/carbs/fat.
  // (Fiber is deliberately NOT asserted: SR Legacy omits it for tempeh and soba — documented gaps, above.)
  const usedKeys = new Set(RECIPES.flatMap((r) => r.ingredients.map((i) => tableKey(i))));
  const missingField: string[] = [];
  for (const k of usedKeys) for (const f of ["cal", "protein", "carbs", "fat"] as const) {
    const v = NUTRIENT_TABLE[k]?.per100g[f];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) missingField.push(`${k}.${f}`);
  }
  check("macros: every table entry a recipe uses states cal, protein, carbs and fat (no silent ?? 0)",
    missingField.length === 0, missingField.length ? missingField.slice(0, 8).join(", ") : `${usedKeys.size} entries`);

  // The food the macros come from is the food the seed's slug names (tableKey reads the NAME first).
  const slugMismatch: string[] = [];
  for (const r of RECIPES) for (const i of r.ingredients) {
    if (resolveIngredient(i.name) !== i.slug) slugMismatch.push(`${r.id}: "${i.name}" -> ${resolveIngredient(i.name)}, slug ${i.slug}`);
  }
  check("macros: every library ingredient's display name resolves to its own slug",
    slugMismatch.length === 0, slugMismatch.slice(0, 5).join("; "));

  // Every recipe's five macros equal the sum of its ingredients' USDA contributions, per serving,
  // within rounding (|diff| <= 0.5, tighter than one unit). Exact Math.round agreement is reported too.
  const off: string[] = [];
  let exact = 0, worst = 0;
  for (const r of RECIPES) {
    const t = totals(r.ingredients, true);
    let allExact = true;
    for (const k of MACROS) {
      const want = t[k] / divisor(r);
      const got = r[FIELD[k]] ?? NaN;
      worst = Math.max(worst, Math.abs(got - want));
      if (got !== Math.round(want)) allExact = false;
      if (!(Math.abs(got - want) <= 0.5 + 1e-9)) off.push(`${r.id}.${k}: ${got} vs ${want.toFixed(3)}`);
    }
    if (allExact) exact++;
  }
  check("macros: every recipe equals the sum of its ingredients' USDA contributions per serving (|diff| <= 0.5)",
    RECIPES.length > 0 && off.length === 0,
    off.length ? off.slice(0, 5).join("; ") : `${RECIPES.length} recipes, ${exact} exact to Math.round, worst |diff| ${worst.toFixed(3)}`);

  // Servings: the divisor is a whole number >= 1 (so the Math.max clamp never changes it), and the
  // per-serving figure times servings recovers the whole ingredient list within rounding (s/2).
  const badServings = RECIPES.filter((r) => r.servings !== undefined && !(Number.isInteger(r.servings) && r.servings >= 1)).map((r) => `${r.id}=${r.servings}`);
  check("macros: every recipe's servings is absent or a whole number >= 1", badServings.length === 0, badServings.join(", "));
  const multi = RECIPES.filter((r) => (r.servings ?? 1) > 1);
  const servBad: string[] = [];
  for (const r of multi) {
    const t = totals(r.ingredients);
    const s = divisor(r);
    for (const k of MACROS) {
      const per = r[FIELD[k]] ?? NaN;
      if (!(Math.abs(per * s - t[k]) <= s / 2 + 1e-9)) servBad.push(`${r.id}.${k}: ${per} x ${s} vs ${t[k].toFixed(2)}`);
    }
  }
  check("macros: per-serving x servings = the whole ingredient list's total (within s/2)",
    multi.length > 0 && servBad.length === 0,
    servBad.length ? servBad.slice(0, 5).join("; ") : multi.map((r) => `${r.id} x${r.servings}`).join(", "));
  const microDivBad: string[] = [];
  for (const r of multi) {
    const raw = microsForIngredients(r.ingredients).micros;
    const got = recipeMicros(r).micros;
    for (const k of MICRO_KEYS) if (Math.abs(got[k] - raw[k] / divisor(r)) > 1e-9) microDivBad.push(`${r.id}.${k}`);
  }
  check("macros: recipeMicros divides by the same servings divisor as the macros",
    multi.length > 0 && microDivBad.length === 0, microDivBad.slice(0, 5).join(", "));

  // Linearity of the weighing: doubling the written amount doubles the grams, on EVERY library line —
  // fractions, mixed numbers, "70 g dry", bare counts.
  const nonLinear: string[] = [];
  for (const r of RECIPES) for (const i of r.ingredients) {
    const key = tableKey(i);
    const d = doubleQty(i.quantity);
    const g1 = gramsFor(key, i.quantity);
    const g2 = d == null ? null : gramsFor(key, d);
    if (g1 == null || g2 == null || Math.abs(g2 - 2 * g1) > 1e-9 * Math.max(1, g1)) nonLinear.push(`${key} "${i.quantity}" -> "${d}": ${g1} / ${g2}`);
  }
  check("macros: gramsFor(2 x amount) = 2 x gramsFor(amount) on every library quantity",
    nonLinear.length === 0, nonLinear.length ? nonLinear.slice(0, 5).join("; ") : `${lineCount} lines`);

  // Linearity of the derivation: in a modified seed with ONE ingredient doubled, the total rises by
  // exactly that ingredient's contribution — every macro (reproduced), and every micronutrient through
  // the exported microsForIngredients, which walks the same tableKey + gramsFor path.
  const linBad: string[] = [];
  let probes = 0;
  const sample = RECIPES.filter((_, idx) => idx % 25 === 0).concat(multi);
  for (const r of sample) {
    const base = totals(r.ingredients);
    const baseMicro = microsForIngredients(r.ingredients).micros;
    r.ingredients.forEach((ing, j) => {
      const d = doubleQty(ing.quantity);
      const c = contribution(ing, false);
      if (d == null || c == null) { linBad.push(`${r.id}[${j}] unparseable`); return; }
      const mod = r.ingredients.map((x, k) => (k === j ? { ...x, quantity: d } : x));
      const t2 = totals(mod);
      for (const k of MACROS) if (Math.abs(t2[k] - base[k] - c[k]) > 1e-6) linBad.push(`${r.id}[${j}].${k}`);
      const m2 = microsForIngredients(mod).micros;
      const key = tableKey(ing);
      const g = gramsFor(key, ing.quantity) ?? 0;
      const per = NUTRIENT_TABLE[key].per100g;
      for (const k of MICRO_KEYS) if (Math.abs(m2[k] - baseMicro[k] - ((per[k] ?? 0) * g) / 100) > 1e-6) linBad.push(`${r.id}[${j}].${k} (micro)`);
      probes++;
    });
  }
  check("macros: doubling one ingredient adds exactly its own contribution again (macros + micros)",
    probes > 50 && linBad.length === 0,
    linBad.length ? linBad.slice(0, 5).join("; ") : `${probes} single-ingredient doublings over ${sample.length} recipes`);

  // Order independence, and the output shape every consumer assumes.
  const orderBad = RECIPES.filter((r) => {
    const a = totals(r.ingredients), b = totals([...r.ingredients].reverse());
    return MACROS.some((k) => Math.round(a[k] / divisor(r)) !== Math.round(b[k] / divisor(r)));
  }).map((r) => r.id);
  check("macros: reversing a recipe's ingredient list changes no rounded macro", orderBad.length === 0, orderBad.slice(0, 5).join(", "));
  const shapeBad = RECIPES.filter((r) => MACROS.some((k) => {
    const v = r[FIELD[k]];
    return !(typeof v === "number" && Number.isInteger(v) && v >= 0);
  })).map((r) => r.id);
  check("macros: every recipe's five macros (fiber included) are non-negative integers", shapeBad.length === 0, shapeBad.slice(0, 5).join(", "));
}


// ---------------------------------------------------------------- 1e. log_meal
console.log("\n--- LOG_MEAL (real life derails the plan) ---");
{
  // Meals must stay a sensible SIZE. Hitting macros by squashing breakfast to its floor and
  // inflating dinner to its ceiling is arithmetically right and useless as a meal plan.
  let worstRatio = 0;
  let lopsided = 0;
  for (let i = 0; i < 6; i++) {
    const wk = freshWeek(BASE);
    for (const d of wk.days) {
      const b = d.meals.find((m) => m.type === "breakfast")!.calories;
      const dn = d.meals.find((m) => m.type === "dinner")!.calories;
      worstRatio = Math.max(worstRatio, dn / b);
      if (b < 350 || dn > 950) lopsided++;
    }
  }
  check("meals stay a sensible size (dinner/breakfast < 2x)", worstRatio < 2, `worst ratio ${worstRatio.toFixed(2)}`);
  check("no lopsided days", lopsided === 0, `${lopsided}/42`);
}
{
  // "I ate a burger for lunch" -> the REST of the day re-solves; what you ate is a fact.
  const wk = freshWeek(BASE);
  const before = wk.days.find((x) => x.day === "Monday")!;
  const bBreak = before.meals.find((m) => m.type === "breakfast")!;
  const r = applyOperations(BASE, wk, [op({ tool: "log_meal", day: "Monday", mealType: "lunch", dish: "pizza" } as never)]);
  const d = r.plan.days.find((x) => x.day === "Monday")!;
  const aBreak = d.meals.find((m) => m.type === "breakfast")!;
  check("log_meal: a dish from ANY slot can be eaten (pizza at lunch)", d.meals.some((m) => /pizza/i.test(m.name)), names(d));
  check("log_meal: already-eaten meals are LOCKED", aBreak.name === bBreak.name && aBreak.calories === bBreak.calories);
  check("log_meal: the day still lands near target", Math.abs(kcal(d) - 2000) <= 150, `${kcal(d)} kcal`);
  check("log_meal: reports honestly what it changed", r.notes.some((n) => /Logged .*pizza/i.test(n)), (r.notes[0] ?? "").slice(0, 80));
  check("log_meal: admits a protein shortfall it cannot fix", prot(d) >= 140 || r.notes.some((n) => /Protein lands at/.test(n)), `${prot(d)}g`);
}
{
  // An unknown food: ask for the calories rather than invent them.
  const wk = freshWeek(BASE);
  const ask = applyOperations(BASE, wk, [op({ tool: "log_meal", day: "Monday", mealType: "lunch", dish: "grandma's lasagna" } as never)]);
  check("log_meal: unknown food -> asks for calories, never guesses", ask.notes.some((n) => /how many calories/.test(n)), ask.notes[0] ?? "(none)");

  const told = applyOperations(BASE, wk, [op({ tool: "log_meal", day: "Monday", mealType: "lunch", dish: "grandma's lasagna", loggedCalories: 900, loggedProtein: 35 } as never)]);
  const d = told.plan.days.find((x) => x.day === "Monday")!;
  check("log_meal: accepts user-supplied calories and re-solves", d.meals.some((m) => /lasagna/i.test(m.name)) && Math.abs(kcal(d) - 2000) <= 150, `${kcal(d)} kcal`);
}
{
  // log_meal on a slot the day doesn't have (BASE is 3 meals — no snack) must ABSORB the eaten meal,
  // not silently drop it and then misreport the day. A plain replace-map used to lose it entirely.
  const wk = freshWeek(BASE);
  // No dish -> the user-supplied 900 kcal is used verbatim (a matched recipe would carry its own).
  const r = applyOperations(BASE, wk, [op({ tool: "log_meal", day: "Monday", mealType: "snack", loggedCalories: 900, loggedProtein: 20 } as never)]);
  const mon = r.plan.days.find((x) => x.day === "Monday")!;
  const snack = mon.meals.find((m) => m.type === "snack");
  check("log_meal: a snack logged on a 3-meal day is ADDED at its logged calories, not dropped",
    Boolean(snack) && snack!.calories === 900, `slots ${mon.meals.map((m) => m.type).join(",")}`);
  check("log_meal: adding the snack gives the day a 4th slot (not a silent replace)", mon.meals.length === 4, `${mon.meals.length} meals`);
  check("log_meal: the note reports it was logged", r.notes.some((n) => /Logged/.test(n)), (r.notes[0] ?? "").slice(0, 60));
}

// ---------------------------------------------------------------- 1f. initial-generation macro accuracy
// Calories and protein were already driven hard; carbs/fat/fiber were traded away (weighted 1/1/0.5
// vs 4/3) and UNTESTED — 3 of VISION's 5 "first-class" macro axes unguaranteed. Fat ran 15-25% over
// on every non-keto diet. These lock in the carb/fat selection fit + the honesty disclosure.
console.log("\n--- INITIAL GENERATION: carb / fat / fiber accuracy ---");
{
  // Mirror of the engine's dayTargetMacros (not exported): keto re-solves carbs down and fat up.
  const dietTarget = (p: UserProfile) => {
    const fiber = p.fiberGrams ?? 30;
    if (p.diet !== "keto") return { carbs: p.carbsGrams, fat: p.fatGrams, fiber };
    const carbs = Math.min(p.carbsGrams, 60);
    const fat = Math.max(p.fatGrams, Math.round((p.targetCalories - p.proteinGrams * 4 - carbs * 4) / 9));
    return { carbs, fat, fiber };
  };
  const diets: UserProfile["diet"][] = ["none", "vegetarian", "vegan", "keto", "mediterranean"];
  const WEEKS = 6;
  for (const diet of diets) {
    const p: UserProfile = { ...BASE, diet };
    const t = dietTarget(p);
    let cal = 0, carb = 0, protein = 0, days = 0;
    for (let w = 0; w < WEEKS; w++)
      for (const d of freshWeek(p).days) { cal += kcal(d); carb += carbsOf(d); protein += prot(d); days++; }
    cal /= days; carb /= days; protein /= days;
    // Calories are the axis the user sets hardest; the solver nails them on every diet.
    check(`gen[${diet}]: calories within 5%`, Math.abs(cal - p.targetCalories) <= p.targetCalories * 0.05, `${cal.toFixed(0)} kcal`);
    // Carbs are steered at selection AND rebalanced to the (keto-adjusted) target. On keto that
    // target is a CEILING — lower is better — so assert only the upper bound there.
    check(
      `gen[${diet}]: carbs ${diet === "keto" ? "at/under" : "within 22% of"} ${t.carbs}g`,
      diet === "keto" ? carb <= t.carbs * 1.22 : Math.abs(carb - t.carbs) <= t.carbs * 0.22,
      `${carb.toFixed(0)}g`,
    );
    // Protein must not regress; vegan is the natural floor (~135g), so 85% is the line — never chased below.
    check(`gen[${diet}]: protein >= 85% of ${p.proteinGrams}g`, protein >= p.proteinGrams * 0.85, `${protein.toFixed(0)}g`);
  }
  // Fat is genuinely on target where the recipe pool allows it: the unconstrained and keto diets.
  // (Plant diets carry more fat — their protein sources are fat-dense — which the note discloses.)
  for (const diet of ["none", "keto"] as const) {
    const p: UserProfile = { ...BASE, diet };
    const t = dietTarget(p);
    let fat = 0, days = 0;
    for (let w = 0; w < WEEKS; w++) for (const d of freshWeek(p).days) { fat += fatOf(d); days++; }
    fat /= days;
    check(`gen[${diet}]: fat within 20% of ${t.fat}g`, Math.abs(fat - t.fat) <= t.fat * 0.2, `${fat.toFixed(0)}g`);
  }
}
{
  // Honesty ("hit it or admit it"): a diet whose dishes carry more fat than target must land within
  // 20% or SAY so — never quietly overshoot. Vegetarian is the standing example.
  const veg: UserProfile = { ...BASE, diet: "vegetarian" };
  const r = applyOperations(veg, freshWeek(veg), [op({ tool: "regenerate_week" })]);
  const fat = r.plan.days.reduce((s, d) => s + fatOf(d), 0) / r.plan.days.length;
  const disclosed = r.notes.some((n) => /Fat comes to/.test(n));
  check("gen honesty: fat within 22% or admitted", Math.abs(fat - 65) <= 65 * 0.22 || disclosed, `fat ${fat.toFixed(0)}g, disclosed=${disclosed}`);
}
{
  // Per-user fiber target flows into generation and the note: an 80g target the pool can't reach is
  // disclosed, not silently missed. (Older profiles omit fiberGrams and fall back to 30 g.)
  const hi: UserProfile = { ...BASE, fiberGrams: 80 };
  const r = applyOperations(hi, freshWeek(hi), [op({ tool: "regenerate_week" })]);
  check("gen: per-user fiber target honoured + disclosed when short", r.notes.some((n) => /under the 80g I aim for/.test(n)), (r.notes.find((n) => /Fiber is/.test(n)) ?? "(none)").slice(0, 90));
}

// ---------------------------------------------------------------- 1g. condition -> nutrient detection
// conditionBoosts derives the micronutrients a fresh plan should favour from durable profile facts.
// (Detection only; the generation wiring + ask-vs-auto-apply UX are specced in CONDITION-AWARE-GEN.md
// and land later. This locks the mapping + aging + whole-word matching so that work builds on it.)
console.log("\n--- CONDITION -> NUTRIENT DETECTION ---");
{
  const today = new Date("2026-09-02");
  const withMemory = (memory: UserProfile["memory"]): UserProfile => ({ ...BASE, memory });
  const b = (memory: UserProfile["memory"]) => conditionBoosts(withMemory(memory), today);

  const fresh = b([{ fact: "on my period", kind: "condition", since: "2026-09-01" }]);
  check("period -> iron primary + magnesium", fresh[0] === "iron" && fresh.includes("magnesium"), JSON.stringify(fresh));
  check("period ages out after its 7-day ttl",
    b([{ fact: "on my period", kind: "condition", since: "2026-08-01" }]).length === 0);
  const preg = b([{ fact: "I'm pregnant now", kind: "condition" }]);
  check("pregnancy -> folate primary + iron + calcium",
    preg[0] === "folate" && preg.includes("iron") && preg.includes("calcium"), JSON.stringify(preg));
  check("'low on iron' parses to iron", b([{ fact: "I've been low on iron", kind: "context" }]).includes("iron"));
  check("deficiency parse is adjacency-based (co-mention does not fire)",
    !b([{ fact: "low on time, want calcium-free meals", kind: "context" }]).includes("calcium"));
  check("negated deficiency skipped (iron negated, vitamin D kept)", (() => {
    const r = b([{ fact: "not deficient in iron, but low on vitamin D", kind: "context" }]);
    return !r.includes("iron") && r.includes("vitD");
  })());
  check("whole-word: 'periodically' does NOT fire period", b([{ fact: "I cook periodically", kind: "context" }]).length === 0);
  check("no conditions -> no bias", b([]).length === 0);
}

// ---------------------------------------------------------------- 1h. condition-aware BUILD (capability)
// selectConditionAwareWeek derives a nutrient bias from a durable condition, guarantees it via the
// existing boost machinery while macros hold, and discloses it. Capability is tested but NOT wired
// into the live generatePlan path (ask-vs-auto-apply is a product decision; CONDITION-AWARE-GEN.md).
console.log("\n--- CONDITION-AWARE BUILD (capability, unwired) ---");
{
  const ironOf = (p: WeekPlan) =>
    p.days.reduce((s, d) => s + d.meals.reduce((a, m) => a + microsForIngredients(m.ingredients).micros.iron, 0), 0) / p.days.length;
  const today = new Date().toISOString().slice(0, 10);
  const PERIOD: UserProfile = { ...BASE, memory: [{ fact: "on my period", kind: "condition", since: today }] };
  const N = 8;
  let base = 0, cond = 0, macrosHeld = true, disclosed = false, doctor = false, rideOK = true;
  for (let i = 0; i < N; i++) {
    base += ironOf(freshWeek(BASE));
    const { plan, notes } = selectConditionAwareWeek(PERIOD);
    cond += ironOf(plan);
    if (!plan.days.every((d) => Math.abs(kcal(d) - 2000) <= 200 && prot(d) >= 125)) macrosHeld = false;
    if (notes.some((n) => /iron/i.test(n))) disclosed = true;
    if (notes.some((n) => /doctor/.test(n))) doctor = true;
    if (notes.length && (plan.notes?.length ?? 0) !== notes.length) rideOK = false;
  }
  check("condition-aware: period profile raises weekly iron", cond / N > base / N, `base=${(base / N).toFixed(1)} cond=${(cond / N).toFixed(1)} mg/day`);
  check("condition-aware: calories/protein still on target", macrosHeld);
  check("condition-aware: discloses iron + doctor when it adjusts", disclosed && doctor);
  check("condition-aware: disclosure notes ride on the returned plan", rideOK);
  check("condition-aware: no condition -> no notes, no bias", selectConditionAwareWeek(BASE).notes.length === 0);

  // A different condition's PRIMARY nutrient also rises (pregnancy -> folate).
  const PREG: UserProfile = { ...BASE, memory: [{ fact: "I'm pregnant", kind: "condition" }] };
  const folOf = (p: WeekPlan) => weekMicroAverage2(p, "folate");
  let bFol = 0, cFol = 0;
  for (let i = 0; i < 6; i++) { bFol += folOf(freshWeek(PREG)); cFol += folOf(selectConditionAwareWeek(PREG).plan); }
  check("condition-aware: pregnancy raises weekly folate (primary)", cFol / 6 > bFol / 6, `base=${(bFol / 6).toFixed(0)} cond=${(cFol / 6).toFixed(0)} mcg/day`);
}

// ---------------------------------------------------------------- 2. adversarial
console.log("\n--- ADVERSARIAL / EDGE CASES ---");
{
  // Allergy must win over a requested dish — even in cheat mode.
  const allergic: UserProfile = { ...BASE, allergies: "peanut" };
  const wk = freshWeek(allergic);
  const r = applyOperations(allergic, wk, [op({ tool: "swap_meal", day: "Monday", mealType: "lunch", dish: "thai peanut chicken", preserveMacros: false })]);
  const d = r.plan.days.find((x) => x.day === "Monday")!;
  check("ALLERGY beats requested dish, even on a cheat day", !d.meals.some((m) => mealHay(m).includes("peanut")), names(d));
}
{
  // Vegan + "add chicken" — the diet is a hard rule.
  const vegan: UserProfile = { ...BASE, diet: "vegan" };
  const wk = freshWeek(vegan);
  const r = applyOperations(vegan, wk, [op({ tool: "swap_meal", day: "Friday", mealType: "dinner", dish: "grilled chicken" })]);
  const d = r.plan.days.find((x) => x.day === "Friday")!;
  // Word-bounded, and `eggs?` not bare `egg` — a plain /egg/ matched "Eggplant", so this test flaked
  // whenever the vegan Friday dinner landed on Lentil & Eggplant Stew. Same substring over-match the
  // feed and allergen paths were fixed for; a diet test must not fail on a legitimate vegan dish.
  const meaty = /\b(chicken|beef|pork|turkey|salmon|tuna|shrimp|fish|eggs?|yogurt|cheese|milk)\b/i.test(names(d));
  check("vegan: 'add chicken' cannot introduce animal products", !meaty, names(d));
}
{
  // A dish that matches NOTHING must be a no-op, never a silent wrong swap.
  const wk = freshWeek(BASE);
  const before = names(wk.days.find((x) => x.day === "Sunday")!);
  const r = applyOperations(BASE, wk, [op({ tool: "swap_meal", day: "Sunday", mealType: "dinner", dish: "zorblax fnord" })]);
  const after = names(r.plan.days.find((x) => x.day === "Sunday")!);
  check("unmatchable dish: plan unchanged (no silent wrong swap)", before === after, after);
}
{
  // A PARTIAL match ("unicorn stew" -> some stew) is allowed, but must be disclosed.
  const wk = freshWeek(BASE);
  const r = applyOperations(BASE, wk, [op({ tool: "swap_meal", day: "Sunday", mealType: "dinner", dish: "unicorn stew" })]);
  check("partial match: engine discloses the substitution", r.notes.some((n) => /didn't have/.test(n)), r.notes.join(" | ") || "(no notes)");
}
{
  // A reachable cook-time budget must be respected by a SWAP too, not just generation.
  const busy: UserProfile = { ...BASE, maxCookTime: 20 };
  const wk = freshWeek(busy);
  const r = applyOperations(busy, wk, [op({ tool: "swap_meal", day: "Monday", mealType: "dinner", dish: "chicken" })]);
  const d = r.plan.days.find((x) => x.day === "Monday")!;
  const worst = Math.max(...d.meals.map((m) => m.timeMinutes));
  check("cook-time limit respected after a swap", worst <= busy.maxCookTime + 5, `slowest meal ${worst}min vs limit ${busy.maxCookTime}+5`);
}
{
  // An UNREACHABLE limit must relax (with disclosure), never drop a meal.
  const impossible: UserProfile = { ...BASE, maxCookTime: 5 };
  const wk = freshWeek(impossible);
  check("impossible cook-time: still 3 meals every day (relax, never drop)", wk.days.every((d) => d.meals.length === 3), `[${wk.days.map((d) => d.meals.length)}]`);
}
{
  // Requesting a dish that exceeds a reachable limit: no-op + an explanation, not silence.
  const busy: UserProfile = { ...BASE, maxCookTime: 10 };
  const wk = freshWeek(busy);
  const r = applyOperations(busy, wk, [op({ tool: "swap_meal", day: "Monday", mealType: "dinner", dish: "tikka masala" })]);
  check("dish over cook-time limit: engine explains instead of silently ignoring", r.notes.length > 0, r.notes.join(" | ") || "(no notes)");
}
{
  // Idempotence: applying the same swap twice = same plan.
  const wk = freshWeek(BASE);
  const o = op({ tool: "swap_meal", day: "Wednesday", mealType: "breakfast", dish: "oatmeal" });
  const a = applyOperations(BASE, wk, [o]);
  const b = applyOperations(BASE, a.plan, [o]);
  const dayA = names(a.plan.days.find((x) => x.day === "Wednesday")!);
  const dayB = names(b.plan.days.find((x) => x.day === "Wednesday")!);
  check("swap is idempotent (same op twice = same day)", dayA === dayB, `${dayA} || ${dayB}`);
}
{
  // Per-day overrides must never leak into the saved profile.
  const wk = freshWeek(BASE);
  const r = applyOperations(BASE, wk, [op({ tool: "regenerate_day", day: "Thursday", diet: "vegan", targetCalories: 1500 })]);
  check("I8 per-day override does not persist to profile", r.profile.diet === "none" && r.profile.targetCalories === 2000, `diet=${r.profile.diet} kcal=${r.profile.targetCalories}`);
}
{
  // Compound ops apply in order.
  const wk = freshWeek(BASE);
  const r = applyOperations(BASE, wk, [
    op({ tool: "update_profile", diet: "vegetarian", budget: "low", excludeFoods: ["mushroom"] }),
  ]);
  const meaty = r.plan.days.some((d) => /chicken|beef|pork|turkey|salmon|tuna|shrimp/i.test(names(d)));
  const shroom = r.plan.days.some((d) => d.meals.some((m) => mealHay(m).includes("mushroom")));
  check("compound update: vegetarian + exclusion both applied", !meaty && !shroom);
}


// ---------------------------------------------------------------- weekly_report
console.log("\n--- WEEKLY REPORT (read-only, honest, keeps its promises) ---");
{
  const wr = (p: UserProfile) => {
    const plan = freshWeek(p);
    const r = applyOperations(p, plan, [op({ tool: "weekly_report" })]);
    return { note: r.notes.join(" "), plan, out: r.plan, profile: r.profile };
  };

  const { note, plan, out, profile } = wr(BASE);
  check("weekly_report changes nothing (plan)", JSON.stringify(out) === JSON.stringify(plan));
  check("weekly_report changes nothing (profile)", JSON.stringify(profile) === JSON.stringify(BASE));
  check("weekly_report states the calorie average", /average \d+ kcal a day/.test(note));
  check("weekly_report states protein against target", /\d+g protein \(target 150g\)/.test(note), note.slice(0, 60));

  // The numbers it prints must be the numbers in the plan — not the model's guess.
  const days = plan.days.length;
  const realCal = Math.round(plan.days.reduce((s, d) => s + d.meals.reduce((t, m) => t + m.calories, 0), 0) / days);
  const claimed = Number(/average (\d+) kcal/.exec(note)?.[1] ?? -1);
  check("weekly_report calories are COMPUTED, not narrated", Math.abs(claimed - realCal) <= 1, `claimed ${claimed} vs real ${realCal}`);

  // A vegan week genuinely cannot supply B12 from this library. Saying "I can rebuild
  // the week around it" would be a lie; it must name the limit instead.
  const vegan = wr({ ...BASE, diet: "vegan" });
  const b12Line = /B12[^.]*supplement|supplement[^.]*B12/i.test(vegan.note) || /B12/i.test(vegan.note.split("no food that fits")[1] ?? "");
  check("vegan report: B12 named as unreachable by food, not promised", b12Line, vegan.note.slice(-140));
  check("vegan report: does not promise to 'rebuild around' B12", !/B12[^.]*I can rebuild/i.test(vegan.note));
  check("vegan report: admits the protein shortfall", /protein is \d+g short/i.test(vegan.note));

  // THE PROMISE TEST. Boosting a nutrient must never LOWER it — not on a lucky seed, not on
  // an unlucky one. Selection is randomised, so this runs several trials per nutrient.
  const microAvg = (pl: WeekPlan, k: (typeof MICRO_KEYS)[number]) =>
    pl.days.reduce((s, d) => s + d.meals.reduce((t, m) => {
      const r = RECIPES.find((x) => x.name === m.name);
      return t + (r ? recipeMicros(r).micros[k] : 0);
    }, 0), 0) / pl.days.length;

  let regressions = 0;
  let improved = 0;
  let worst = "";
  for (const k of MICRO_KEYS) {
    for (let trial = 0; trial < 3; trial++) {
      const start = freshWeek(BASE);
      const before = microAvg(start, k);
      const after = microAvg(applyOperations(BASE, start, [op({ tool: "regenerate_week", boostNutrient: k })]).plan, k);
      if (after < before - 1e-6) { regressions++; worst = `${MICRO_LABEL[k]} ${before.toFixed(2)} -> ${after.toFixed(2)}`; }
      if (after > before + 1e-6) improved++;
    }
  }
  check("promise kept: boosting a nutrient NEVER lowers it", regressions === 0, worst || `${MICRO_KEYS.length * 3} trials clean`);
  check("boost is useful: most trials actually raise the nutrient", improved >= MICRO_KEYS.length, `${improved}/${MICRO_KEYS.length * 3} raised`);

  // Never report a nutrient we can't measure: coverage gate must hide, not guess.
  check("weekly_report discloses unmeasurable nutrients rather than faking them",
    !/NaN|undefined|Infinity/.test(note), note.slice(0, 80));
}


// ---------------------------------------------------------------- eating_out
console.log("\n--- EATING OUT (reserve calories, never invent the meal) ---");
{
  const run = (o: Partial<Operation>, prof: UserProfile = BASE) => {
    const plan = freshWeek(prof);
    const r = applyOperations(prof, plan, [op({ tool: "eating_out", day: "Friday", mealType: "dinner", ...o })]);
    const fri = r.plan.days.find((d) => d.day === "Friday")!;
    return { note: r.notes.join(" "), fri, plan, out: r.plan,
      cal: fri.meals.reduce((s, m) => s + m.calories, 0),
      out_meal: fri.meals.find((m) => m.type === (o.mealType ?? "dinner"))! };
  };

  const d = run({});
  check("eating_out reserves the slot", /out$/i.test(d.out_meal.name), d.out_meal.name);
  check("eating_out reserves 40% of the day when not told", d.out_meal.calories === Math.round(BASE.targetCalories * 0.4), `${d.out_meal.calories} kcal`);
  check("eating_out NEVER invents the restaurant meal's protein", d.out_meal.proteinGrams === 0);
  check("eating_out says the reserve is an estimate", /not a measured number/i.test(d.note));
  check("eating_out keeps the day on target", Math.abs(d.cal - BASE.targetCalories) <= BASE.targetCalories * 0.05, `${d.cal} kcal`);
  check("eating_out does not rescale the reserved slot", d.out_meal.calories === Math.round(BASE.targetCalories * 0.4));

  // The generic shortfall note would blame the recipe library for a protein gap WE created by
  // booking zero protein for the restaurant. That is a false explanation.
  check("eating_out never blames the recipes for the protein it deliberately didn't book",
    !/these recipes allow|can't stretch/i.test(d.note), d.note.slice(0, 90));
  // Which branch fires depends on whether the meals at home already cover the protein target, and
  // after the library grew they sometimes do. Test BOTH branches on purpose instead of leaving it
  // to the draw — this was flaky 1 run in 4.
  const hungry = run({}, { ...BASE, proteinGrams: 210 });
  check("eating_out tells the user what to ORDER when protein is short",
    /order something with roughly \d+g/i.test(hungry.note), hungry.note.slice(-110));
  const easy = run({}, { ...BASE, proteinGrams: 60 });
  check("...and tells them to order what they like when it isn't",
    /order whatever you fancy/i.test(easy.note), easy.note.slice(-90));

  // The user's own number is used verbatim — never second-guessed.
  const e = run({ estimatedCalories: 1200 });
  check("eating_out uses the user's estimate exactly", e.out_meal.calories === 1200);
  check("eating_out doesn't call the user's own number an estimate", !/not a measured number/i.test(e.note));

  // A reserve bigger than the whole day must be admitted, not silently absorbed.
  const big = run({ estimatedCalories: 2500 });
  check("eating_out admits an over-target day", /over target/i.test(big.note), big.note.slice(-90));
  check("eating_out doesn't fake hitting target on an absurd reserve", big.cal > BASE.targetCalories * 1.2, `${big.cal} kcal`);

  // Advice must be followable: 4 kcal/g means a small reserve cannot hold a big protein order.
  const hp = run({ estimatedCalories: 300, mealType: "lunch" }, { ...BASE, proteinGrams: 260 });
  check("eating_out won't order 90g of protein inside a 300 kcal salad",
    !/order something with roughly/.test(hp.note) || /more than 300 kcal can physically hold/.test(hp.note), hp.note.slice(0, 150));

  // Nothing else in the week may move.
  const only = run({});
  const others = only.out.days.filter((x) => x.day !== "Friday").map(names).join("||");
  const before = only.plan.days.filter((x) => x.day !== "Friday").map(names).join("||");
  check("eating_out changes only that day", others === before);

  // Missing information -> ask, never guess a day.
  const vague = applyOperations(BASE, freshWeek(BASE), [op({ tool: "eating_out", day: "Friday" })]);
  check("eating_out asks which meal when not told", /which day and which meal/i.test(vague.notes.join(" ")));

  // Hard constraints still hold on the meals it re-solved.
  const veg = run({}, { ...BASE, diet: "vegan", allergies: "peanut" });
  const vegBad = veg.fri.meals.filter((m) => m.type !== "dinner").some((m) => {
    const b = recipeByName.get(m.name.toLowerCase());
    return (b && !dietOk(b.dietTags, "vegan")) || mealHay(m).includes("peanut");
  });
  check("eating_out re-solves the rest of the day within diet + allergies", !vegBad);
}


// ---------------------------------------------------------------- explain_meal
console.log("");
console.log("--- EXPLAIN MEAL (justify the choice, claim only what the data says) ---");
{
  const plan = freshWeek(BASE);
  const ex = (day: string, mt: string, pl = plan, prof = BASE) =>
    applyOperations(prof, pl, [op({ tool: "explain_meal", day: day as DayPlan["day"], mealType: mt as Meal["type"] })]);

  const r = ex("Tuesday", "dinner");
  const note = r.notes.join(" ");
  check("explain_meal changes nothing", JSON.stringify(r.plan) === JSON.stringify(plan));

  // Every number it states must be recomputable from the meal itself.
  const meal = plan.days.find((d) => d.day === "Tuesday")!.meals.find((m) => m.type === "dinner")!;
  check("explain_meal states the meal's real calories", note.includes(`${meal.calories} kcal`), `${meal.calories}`);
  check("explain_meal states the meal's real protein", note.includes(`${meal.proteinGrams}g protein`));
  const pctPro = Math.round((meal.proteinGrams / BASE.proteinGrams) * 100);
  check("explain_meal's % of protein target is arithmetic, not vibes", note.includes(`(${pctPro}% of your ${BASE.proteinGrams}g target)`), `${pctPro}%`);

  // A reserved restaurant slot has no recipe. Inventing reasons for it would be fabrication.
  const out = applyOperations(BASE, plan, [op({ tool: "eating_out", day: "Friday", mealType: "dinner" })]).plan;
  const outNote = ex("Friday", "dinner", out).notes.join(" ");
  check("explain_meal admits it didn't choose a meal you told it about", /isn't one of my recipes/i.test(outNote));
  check("explain_meal makes no nutrient claim about a meal it never saw", !/strong source/i.test(outNote), outNote.slice(0, 80));

  // "Rich in iron" is a claim about someone's blood. Only make it when the data supports it.
  let unsupported = 0;
  for (const d of plan.days)
    for (const m of d.meals) {
      const claim = ex(d.day, m.type).notes.join(" ");
      const cov = microsForIngredients(m.ingredients).coverage;
      if (/strong source/i.test(claim) && cov < 0.6) unsupported++;
      if (cov < 0.6 && !/can't measure its micronutrients/i.test(claim) && RECIPES.some((x) => x.name === m.name)) unsupported++;
    }
  check("explain_meal never claims a nutrient it can't measure", unsupported === 0, `${unsupported} unsupported claims`);

  // Diet compliance is a reason worth stating — and it must be true.
  const V: UserProfile = { ...BASE, diet: "vegan" };
  const vplan = freshWeek(V);
  const vnote = ex("Monday", "dinner", vplan, V).notes.join(" ");
  const vmeal = vplan.days.find((d) => d.day === "Monday")!.meals.find((m) => m.type === "dinner")!;
  const vbase = recipeByName.get(vmeal.name.toLowerCase());
  check("explain_meal only calls a meal vegan when it is", !/it's vegan/.test(vnote) || (!!vbase && dietOk(vbase.dietTags, "vegan")));

  check("explain_meal asks when it doesn't know which meal", /which day/i.test(ex("Monday", "").notes.join(" ")) || /which meal/i.test(applyOperations(BASE, plan, [op({ tool: "explain_meal" })]).notes.join(" ")));
  check("explain_meal handles a slot that isn't in the plan", /don't have a snack/i.test(ex("Monday", "snack").notes.join(" ")));
}


// ---------------------------------------------------------------- substitute_ingredient
console.log("");
console.log("--- SUBSTITUTE INGREDIENT (safe first, honest about the cost) ---");
{
  const plan = freshWeek(BASE);
  const sub = (ing: string, prof: UserProfile = BASE) =>
    applyOperations(prof, plan, [op({ tool: "substitute_ingredient", ingredient: ing })]);

  // A typo in the table would silently drop a substitution and no one would notice.
  const missing: string[] = [];
  for (const [k, vs] of Object.entries(SUBSTITUTES)) {
    if (!NUTRIENT_TABLE[k]) missing.push(`key ${k}`);
    for (const v of vs) if (!NUTRIENT_TABLE[v]) missing.push(`${k} -> ${v}`);
  }
  check("every substitution names a real USDA ingredient", missing.length === 0, missing.slice(0, 3).join("; "));
  for (const [k, vs] of Object.entries(SUBSTITUTES))
    if (vs.includes(k)) check(`substitution "${k}" doesn't suggest itself`, false);

  const r = sub("greek yogurt");
  check("substitute_ingredient changes nothing", JSON.stringify(r.plan) === JSON.stringify(plan));

  // THE SAFETY SWEEP. Every ingredient, every restricted diet: nothing it suggests may break it.
  const say = (n: string) => n.toLowerCase();
  let unsafe = 0;
  let firstUnsafe = "";
  for (const key of Object.keys(SUBSTITUTES)) {
    for (const [diet, allergies] of [["vegan", ""], ["vegetarian", ""], ["none", "nuts"], ["none", "dairy"]] as const) {
      const prof: UserProfile = { ...BASE, diet: diet as UserProfile["diet"], allergies };
      const note = sub(key, prof).notes.join(" ");
      const m = /Use ([a-z\- ]+?) (?:instead|in place)/i.exec(note);
      if (!m) continue; // it refused, which is always allowed
      const suggested = say(m[1].trim());
      const bad =
        (diet !== "none" && dietTagConflicts(diet, [suggested]).length > 0) ||
        (allergies && haystackBlocked(suggested, [allergies]));
      if (bad) { unsafe++; if (!firstUnsafe) firstUnsafe = `${key} -> ${suggested} (${diet}/${allergies})`; }
    }
  }
  check("substitute_ingredient NEVER suggests something that breaks the diet or an allergy", unsafe === 0, firstUnsafe || `${Object.keys(SUBSTITUTES).length * 4} combinations clean`);

  check("substitute_ingredient refuses rather than inventing", /rather say so than invent/i.test(sub("unicorn tears").notes.join(" ")));
  // NB: the refusal echoes the query back, and "unicorn" contains "corn" — so assert on the
  // ABSENCE of a suggestion, not the absence of the substring. The first version of this check
  // failed for exactly that reason: the test was wrong, the engine was right.
  check("substitute_ingredient doesn't match a word inside another word",
    !/Use .+ (instead|in place)/i.test(sub("unicorn tears").notes.join(" ")));
  check("substitute_ingredient says no when every option is unsafe",
    /won't suggest any of them/i.test(sub("greek yogurt", { ...BASE, diet: "vegan" }).notes.join(" ")));
  check("substitute_ingredient understands plurals and spellings",
    /egg whites/i.test(sub("egg").notes.join(" ")) && /cottage cheese|yogurt/i.test(sub("greek yoghurt").notes.join(" ")));
  check("substitute_ingredient asks when told nothing", /which ingredient/i.test(sub("").notes.join(" ")));

  // The macro delta must be arithmetic on the real portion, not a vibe.
  //
  // Every earlier version of this test parsed the note's free text to find the meal and ingredient
  // — and every version was fragile. It sat behind `if (m) { if (g) {`, so a week with no eggs
  // asserted nothing; then the regex `([a-z ]+?)` over-captured "pieces of eggs" from a portion
  // phrased "2 pieces of eggs", and adding one recipe (which shifted the random week) tipped it
  // over. The fix is to stop reading the prose: SCOPE the substitution to a meal we placed
  // ourselves, then read that meal's egg portion directly and recompute the delta from it.
  {
    const eggRecipe = RECIPES.find((r) => r.type === "breakfast" && r.ingredients.some((i) => /^eggs?$/i.test(i.name.trim())))!;
    const eggPlan = applyOperations(BASE, plan, [op({ tool: "swap_meal", day: "Monday", mealType: "breakfast", dish: eggRecipe.name })]).plan;
    const meal = eggPlan.days.find((d) => d.day === "Monday")!.meals.find((x) => x.type === "breakfast")!;
    const egg = meal.ingredients.find((i) => /^eggs?$/i.test(i.name.trim()))!;
    const eggKey = egg.name.trim().toLowerCase();
    const g = gramsFor(eggKey, egg.quantity);

    // Pin the substitution to THAT meal, so it can't wander to another day's egg dish.
    const eggNote = applyOperations(BASE, eggPlan, [
      op({ tool: "substitute_ingredient", ingredient: "eggs", day: "Monday", mealType: "breakfast" }),
    ]).notes.join(" ");

    check("substitute_ingredient priced the meal we asked about", /Monday's breakfast/.test(eggNote), eggNote.slice(0, 90));
    check("the placed egg dish has a weighable egg portion (control)", !!g, `${egg.quantity} of ${eggKey}`);

    const sub0 = NUTRIENT_TABLE[eggKey]?.per100g.cal ?? 0;
    const sub1 = NUTRIENT_TABLE["egg whites"]?.per100g.cal ?? 0;
    const dCal = g ? Math.abs(Math.round(((sub1 - sub0) * g) / 100)) : 0;
    // The engine only prints a delta of 15 kcal or more; below that it stays silent, which is fine.
    const ok = !g || dCal < 15 || eggNote.includes(`${dCal} `);
    check("substitute_ingredient's calorie delta is computed from the real portion", ok, `recomputed ${dCal} kcal from ${egg.quantity}; note "${eggNote.slice(0, 60)}"`);
  }
}


// ---------------------------------------------------------------- symptom_check
console.log("");
console.log("--- SYMPTOM CHECK (never diagnose, never dose, always the doctor) ---");
{
  const plan = freshWeek(BASE);
  const sym = (msg: string, prof: UserProfile = BASE, pl = plan) =>
    applyOperations(prof, pl, [op({ tool: "symptom_check", symptom: msg })]);

  const tired = sym("i'm always tired");
  const tiredNote = tired.notes.join(" ");
  check("symptom_check changes nothing", JSON.stringify(tired.plan) === JSON.stringify(plan));
  check("symptom_check refuses to diagnose", /can't diagnose/i.test(tiredNote));
  check("symptom_check sends them to a doctor", /see a doctor/i.test(tiredNote));
  check("symptom_check names the associated nutrients", /iron.*B12.*folate/i.test(tiredNote));

  // It must never prescribe. No dose, no supplement recommendation, ever.
  const allNotes = ["i'm always tired", "muscle cramps", "brittle nails", "i keep getting sick", "pins and needles", "low mood", "can't sleep", "bone pain", "i look pale", "slow healing"]
    .map((m) => sym(m).notes.join(" "))
    .join(" ");
  check("symptom_check never states a dose", !/\d+\s?(mg|mcg|µg|iu)\b/i.test(allNotes));
  check("symptom_check never tells anyone to take a supplement", !/take (a |an )?(supplement|tablet|pill)/i.test(allNotes));

  // Its numbers come from the user's week, not from anywhere else.
  const vd = weekMicroAverage2(plan, "vitD");
  const claimed = /vitamin D \((\d+)% of the daily reference\)/.exec(tiredNote)?.[1];
  if (claimed) check("symptom_check's percentages come from the real plan", Math.abs(Number(claimed) - Math.round((vd / DAILY_REFERENCE.vitD) * 100)) <= 1, `claimed ${claimed}%`);

  // A symptom it doesn't know is a refusal, not a guess.
  check("symptom_check refuses what it doesn't know", /rather say so than invent/i.test(sym("my left knee clicks").notes.join(" ")));
  check("symptom_check doesn't match a word inside another word", /rather say so than invent/i.test(sym("i just retired and feel great").notes.join(" ")));

  // Word order and filler must not defeat a match.
  check("symptom_check matches an unordered phrase", /brittle hair or nails/i.test(sym("my nails are brittle and my hair is thinning").notes.join(" ")));

  // The note is the WHOLE reply on a feelings message, so it must end with something a "yes please"
  // can accept. When the associated nutrients all look adequate it used to end on "see a doctor" and
  // offer nothing — the next turn had to guess (models lane's conversation eval, 2026-10-03).
  {
    const adequate = sym("my nails are brittle").notes.join(" ");
    if (/look adequate/.test(adequate)) {
      const offered = adequate.match(/lean your week further toward ([a-z0-9 ]+?) —/i);
      check("symptom_check: when nothing is low it still offers ONE concrete nutrient to lean toward", !!offered, adequate.slice(-140));
      check("symptom_check: ...and that offer still sends them to a doctor first", /see a doctor/i.test(adequate));
    } else {
      check("symptom_check: (fixture) brittle nails reads as adequate on this plan, so the offer is exercised", false, adequate.slice(-140));
    }
  }

  // RED FLAGS. These are the tests that actually matter.
  const chest = sym("i have chest pain").notes.join(" ");
  check("chest pain is never answered with food", /doctor or urgent care/i.test(chest) && !/vitamin|iron|magnesium/i.test(chest), chest.slice(0, 60));
  const mixed = sym("i'm really tired and i've got chest pain").notes.join(" ");
  check("a red flag beats a matching symptom", /urgent care/i.test(mixed) && !/vitamin|magnesium/i.test(mixed));
  const crisis = sym("i want to kill myself").notes.join(" ");
  check("self-harm gets a crisis line, not a doctor's appointment", /crisis line|988|116 123/i.test(crisis));
  check("self-harm answer contains no nutrition talk", !/vitamin|iron|magnesium|nutrient/i.test(crisis));
  check("self-harm is not treated as an urgent medical flag", !/urgent care/i.test(crisis));

  // Honesty when food can't fix it.
  const vegan = sym("i'm exhausted all the time", { ...BASE, diet: "vegan" }, freshWeek({ ...BASE, diet: "vegan" })).notes.join(" ");
  check("symptom_check admits when no compliant food carries the nutrient", /no food that fits your vegan rules/i.test(vegan), vegan.slice(-110));

  check("symptom_check asks when told nothing", /what have you been noticing/i.test(sym("").notes.join(" ")));

  // The route joins the MODEL's reply in front of the engine's notes. On a crisis that would let a
  // 1.5B write "sounds like low iron!" above a suicide hotline. The engine takes the whole reply.
  const crisisRes = applyOperations(BASE, plan, [op({ tool: "symptom_check", symptom: "i want to kill myself" })]);
  check("a crisis makes the engine own the entire reply", !!crisisRes.replyOverride && /crisis line/i.test(crisisRes.replyOverride));
  const urgentRes = applyOperations(BASE, plan, [op({ tool: "symptom_check", symptom: "i have chest pain" })]);
  check("an urgent symptom makes the engine own the entire reply", !!urgentRes.replyOverride);
  const normalRes = applyOperations(BASE, plan, [op({ tool: "symptom_check", symptom: "i'm always tired" })]);
  check("an ordinary symptom leaves the model's reply alone", normalRes.replyOverride === undefined);
}


// ---------------------------------------------------------------- reply composition
console.log("");
console.log("--- REPLY COMPOSITION (who gets the last word) ---");
{
  const CRISIS = "Please contact a crisis line straight away.";

  check("a crisis reply discards the model's words entirely",
    composeReply({ modelReply: "Sounds like low iron! Let me fix your week.", notes: [CRISIS], replyOverride: CRISIS, planChanged: false }) === CRISIS);

  // The guard keys off PRESENCE, not truthiness. If a bug ever produced an EMPTY crisis override,
  // truthiness would fall through and let the model speak over the warning; presence yields the
  // (empty) override instead — a safe, visible failure rather than a dangerous, silent one.
  check("a present-but-empty override still silences the model (fail-safe)",
    composeReply({ modelReply: "Sounds like low iron! Let me fix your week.", notes: ["ignored"], replyOverride: "", planChanged: false }) === "");

  check("engine notes are authoritative — the model's prose is dropped so it can never duplicate them",
    composeReply({ modelReply: "Done — kept Monday on target.", notes: ["Kept Monday on target — about 1993 kcal."], planChanged: true }) === "Kept Monday on target — about 1993 kcal.");

  check("filler never introduces the engine's facts",
    composeReply({ modelReply: "", notes: ["You're low on vitamin D."], planChanged: false }) === "You're low on vitamin D.");

  check("a silent model with nothing to report still says something",
    composeReply({ modelReply: "", notes: [], planChanged: false }) === "Happy to help.");
  check("a silent model that changed the plan says so",
    composeReply({ modelReply: "", notes: [], planChanged: true }) === "Done — I updated your plan.");
  // Notes are de-duplicated and empties dropped: the same note via a repeated op (or an op repeated
  // across agent-loop steps, which accumulates every step's notes) must show ONCE, and an all-empty
  // notes array must fall through rather than return a blank reply.
  check("composeReply: a duplicated note is shown once, not twice",
    composeReply({ modelReply: "", notes: ["Kept Monday on target.", "Kept Monday on target."], planChanged: true }) === "Kept Monday on target.");
  check("composeReply: all-empty notes fall through to the model reply, not a blank",
    composeReply({ modelReply: "Which day did you mean?", notes: ["", "  "], planChanged: false }) === "Which day did you mean?");
  check("composeReply: all-empty notes with no model reply use the safe fallback",
    composeReply({ modelReply: "", notes: [" "], planChanged: true }) === "Done — I updated your plan.");

  // Read-only tools must not make the UI think the week was rewritten.
  for (const t of ["answer", "weekly_report", "explain_meal", "substitute_ingredient", "symptom_check"])
    check(`${t} does not flag the plan as changed`, !planWasChanged([op({ tool: t as Operation["tool"] })]));
  for (const t of ["update_profile", "regenerate_week", "regenerate_day", "swap_meal", "compute_targets", "log_meal", "eating_out", "rebalance_day"])
    check(`${t} flags the plan as changed`, planWasChanged([op({ tool: t as Operation["tool"] })]));

  // Every tool in the schema must be classified deliberately, one way or the other.
  const ALL = ["update_profile", "regenerate_week", "regenerate_day", "swap_meal", "compute_targets",
    "log_meal", "weekly_report", "eating_out", "explain_meal", "substitute_ingredient", "symptom_check", "answer"];
  const unclassified = ALL.filter((t) => !READ_ONLY_TOOLS.has(t) && !planWasChanged([op({ tool: t as Operation["tool"] })]));
  check("no tool is left unclassified", unclassified.length === 0, unclassified.join(", "));
}

// ---------------------------------------------------------------- rebalance_day (Phase 2 importer)
console.log("");
console.log("--- REBALANCE_DAY (balance a day around an imported/fixed meal) ---");
{
  const wk = freshWeek(BASE);
  const day = "Wednesday" as const;
  const di = wk.days.findIndex((d) => d.day === day);
  // A heavy imported dinner. It has NO base recipe, so the engine must hold it FIXED and rescale
  // only the day's OTHER meals to bring the day back toward the 2000 target.
  const importedDinner = importedToMeal(
    {
      name: "Imported Feast Bowl", sourceUrl: "https://example.com/feast", servings: 1,
      ingredients: [{ name: "rice", quantity: "2 cups" }], steps: ["Cook."],
      calories: 1100, proteinGrams: 40, carbsGrams: 120, fatGrams: 45, macrosSource: "site",
    },
    "dinner",
  );
  const withImport: WeekPlan = {
    ...wk,
    days: wk.days.map((d) =>
      d.day === day ? { ...d, meals: d.meals.map((m) => (m.type === "dinner" ? importedDinner : m)) } : d,
    ),
  };
  const others = (dp: DayPlan) => dp.meals.filter((m) => m.type !== "dinner").reduce((s, m) => s + m.calories, 0);
  const beforeOthers = others(withImport.days[di]);

  const r = applyOperations(BASE, withImport, [op({ tool: "rebalance_day", day })]);
  const dpAfter = r.plan.days[di];
  const dinnerAfter = dpAfter.meals.find((m) => m.type === "dinner")!;

  check("rebalance_day: flags the plan as changed", r.planChanged === true);
  check("rebalance_day: the imported meal is held FIXED", dinnerAfter.calories === importedDinner.calories && dinnerAfter.name === importedDinner.name);
  check("rebalance_day: the OTHER meals were trimmed toward target", others(dpAfter) < beforeOthers, `${beforeOthers} -> ${others(dpAfter)}`);
  check("rebalance_day: no meal is dropped or zeroed", dpAfter.meals.length === withImport.days[di].meals.length && dpAfter.meals.every((m) => m.calories > 0));
  // An unknown day is an honest no-op, not a crash.
  const bad = applyOperations(BASE, withImport, [op({ tool: "rebalance_day", day: null })]);
  check("rebalance_day: no day -> asks, changes nothing", bad.planChanged === false);
}

// ---------------------------------------------------------------- whole-week swap ("every day")
console.log("");
console.log("--- WHOLE-WEEK SWAP (\"pancakes every day\") ---");
{
  // The exact failure from the screenshot: "I want pancakes for breakfast every day". With no day
  // given, swap_meal must apply the dish to EVERY day's breakfast — not one day with an "every day"
  // fib. ("pancakes" fuzzy-matches "Cottage Cheese Pancakes with Blueberries".)
  const r = applyOperations(BASE, freshWeek(BASE), [op({ tool: "swap_meal", dish: "pancakes", mealType: "breakfast" })]);
  const breakfasts = r.plan.days.map((d) => d.meals.find((m) => m.type === "breakfast")?.name);
  check("swap every day: it changed the plan", r.planChanged === true);
  check("swap every day: EVERY day's breakfast is the same requested dish", breakfasts.every(Boolean) && new Set(breakfasts).size === 1, breakfasts.join(" | "));
  check("swap every day: the dish is the pancakes", /pancake/i.test(breakfasts[0] ?? ""), breakfasts[0] ?? "");
  check("swap every day: the reply says 'every day', not a single day", r.notes.some((n) => /every day/i.test(n)) && !r.notes.some((n) => /^Kept \w+day on target/.test(n)));
  // Every other day's macros still hold (I5-style sanity): days aren't left wildly off target.
  check("swap every day: days stay near target", r.plan.days.every((d) => Math.abs(d.meals.reduce((s, m) => s + m.calories, 0) - BASE.targetCalories) < 400));
  // Single-day swap still works exactly as before. NB compare each other day's breakfast BEFORE vs
  // AFTER — asserting "no other day has pancakes" is a coin flip, because a random week can already
  // contain a pancake breakfast elsewhere. The real property is: only Tuesday moved.
  const wkBefore = freshWeek(BASE);
  const bfBefore = (pl: WeekPlan, day: string) => pl.days.find((d) => d.day === day)?.meals.find((m) => m.type === "breakfast")?.name;
  const one = applyOperations(BASE, wkBefore, [op({ tool: "swap_meal", day: "Tuesday", mealType: "breakfast", dish: "pancakes" })]);
  check("single-day swap: Tuesday's breakfast is now the pancakes", /pancake/i.test(bfBefore(one.plan, "Tuesday") ?? ""), bfBefore(one.plan, "Tuesday"));
  const othersUnchanged = one.plan.days.filter((d) => d.day !== "Tuesday").every((d) => bfBefore(one.plan, d.day) === bfBefore(wkBefore, d.day));
  check("single-day swap: every OTHER day's breakfast is untouched", othersUnchanged);
}

console.log("");
console.log("--- MEALS PER DAY (\"I want 4 meals a day\" / \"add a daily snack\") ---");
{
  const r = applyOperations(BASE, freshWeek(BASE), [op({ tool: "update_profile", mealsPerDay: 4 })]);
  check("meals/day: switching to 4 gives every day 4 meals", r.plan.days.every((d) => d.meals.length === 4), r.plan.days.map((d) => d.meals.length).join(","));
  check("meals/day: 4 adds a snack slot", r.plan.days.every((d) => d.meals.some((m) => m.type === "snack")));
  check("meals/day: it persists to the profile", r.profile.mealsPerDay === 4);
  const back = applyOperations(r.profile, r.plan, [op({ tool: "update_profile", mealsPerDay: 3 })]);
  check("meals/day: back to 3 gives every day 3 meals", back.plan.days.every((d) => d.meals.length === 3));
}

console.log("");
console.log("--- PRIMITIVES v2 (constrain / remember -> tested engine) ---");
{
  // constrain(week) -> one update_profile the engine already runs. Most edits are this one op.
  const wk = expandConstrain({ op: "constrain", diet: "vegetarian", budget: "low", exclude: ["mushrooms"] });
  check("constrain(week): one update_profile op", wk.length === 1 && wk[0].tool === "update_profile");
  check("constrain(week): carries all the fields", (wk[0] as Operation).diet === "vegetarian" && (wk[0] as Operation).budget === "low" && ((wk[0] as Operation).excludeFoods ?? []).includes("mushrooms"));
  const rc = applyOperations(BASE, freshWeek(BASE), wk);
  check("constrain(week): engine applied it (diet persisted)", rc.profile.diet === "vegetarian" && rc.planChanged === true);

  // constrain({days}) -> one regenerate_day each, a per-day override that does NOT persist.
  const days = expandConstrain({ op: "constrain", scope: { days: ["Monday", "Tuesday"] }, diet: "vegetarian" });
  check("constrain(days): one regenerate_day per day", days.length === 2 && days.every((o) => o.tool === "regenerate_day"));
  check("constrain(days): targets exactly those days", days.map((o) => (o as Operation).day).sort().join(",") === "Monday,Tuesday");
  const rd = applyOperations(BASE, freshWeek(BASE), days);
  check("constrain(days): a day override does NOT persist to the profile", rd.profile.diet === "none" && rd.planChanged === true);

  // remember -> the personal-nutritionist memory, deduped, surfaced back into the prompt.
  let pm = applyRemember(BASE, { op: "remember", fact: "lactose intolerant", kind: "allergy" });
  pm = applyRemember(pm, { op: "remember", fact: "hates cilantro", kind: "preference" });
  pm = applyRemember(pm, { op: "remember", fact: "Lactose Intolerant" }); // same fact, different case
  check("remember: stores facts, deduped case-insensitively", (pm.memory ?? []).length === 2);
  check("remember: memory surfaces in the prompt context", /lactose intolerant/i.test(memoryContext(pm)) && /cilantro/i.test(memoryContext(pm)));
  check("remember: empty profile has empty context", memoryContext(BASE) === "");

  // applyPrimitives — THE executor: remember + constrain + pass-through, all through the real engine.
  const t1 = applyPrimitives(BASE, freshWeek(BASE), [
    { op: "remember", fact: "lactose intolerant", kind: "allergy" },
    { op: "constrain", diet: "vegetarian" },
  ]);
  check("applyPrimitives: constrain applied + fact remembered in one turn", t1.profile.diet === "vegetarian" && (t1.profile.memory ?? []).some((f) => /lactose/i.test(f.fact)) && t1.planChanged && t1.profileChanged);

  // A pass-through engine verb still works through the bridge (whole-week swap).
  const t2 = applyPrimitives(BASE, freshWeek(BASE), [op({ tool: "swap_meal", dish: "pancakes", mealType: "breakfast" })]);
  check("applyPrimitives: passes existing verbs straight through (every breakfast is pancakes)", t2.plan.days.every((d) => /pancake/i.test(d.meals.find((m) => m.type === "breakfast")?.name ?? "")));

  // A remember-only turn changes nothing in the plan but must still flag the profile for saving.
  const t3 = applyPrimitives(BASE, freshWeek(BASE), [{ op: "remember", fact: "hates cilantro" }]);
  check("applyPrimitives: remember-only turn flags profileChanged, leaves the plan", t3.profileChanged === true && t3.planChanged === false && (t3.profile.memory ?? []).some((f) => /cilantro/i.test(f.fact)));

  // op-based verbs (the uniform vocabulary) map to the tested engine tools.
  const v1 = applyPrimitives(BASE, freshWeek(BASE), [{ op: "swap", dish: "pancakes", slot: "breakfast" }]);
  check("verb swap (no days = every day) sets all breakfasts", v1.plan.days.every((d) => /pancake/i.test(d.meals.find((m) => m.type === "breakfast")?.name ?? "")));
  const v2 = applyPrimitives(BASE, freshWeek(BASE), [{ op: "rate", rating: 5, day: "Monday", slot: "breakfast" }]);
  check("verb rate stores a rating", (v2.profile.mealRatings ?? []).some((r) => r.rating === 5));
  const v3 = applyPrimitives(BASE, freshWeek(BASE), [{ op: "log", day: "Monday", slot: "lunch", dish: "pizza", calories: 900 }]);
  check("verb log re-solves the day (plan changed)", v3.planChanged === true);
  const v4 = applyPrimitives(BASE, freshWeek(BASE), [{ op: "pin", day: "Sunday", slot: "dinner" }]);
  check("verb pin locks the slot", (v4.profile.lockedMeals ?? []).some((l) => l.day === "Sunday" && l.mealType === "dinner"));

  // The v2 turn schema: a realistic reason-then-act turn validates AND runs end-to-end.
  const sampleTurn = {
    thinking: "They went vegetarian, can't stand mushrooms, and told me they're lactose intolerant. So: remember the intolerance, make the week vegetarian without mushrooms, and set pancakes for breakfast every day like they asked.",
    reply: "Done — your week's vegetarian and mushroom-free, pancakes every morning, and I'll keep dairy out from now on.",
    operations: [
      { op: "remember", fact: "lactose intolerant", kind: "allergy" },
      { op: "constrain", diet: "vegetarian", exclude: ["mushrooms"] },
      { op: "swap", dish: "pancakes", slot: "breakfast" },
    ],
  };
  const parsed = AssistantTurnV2Schema.safeParse(sampleTurn);
  check("v2 turn: a realistic multi-op turn validates", parsed.success);
  if (parsed.success) {
    const res = applyPrimitives(BASE, freshWeek(BASE), parsed.data.operations as PrimitiveOp[]);
    check("v2 turn: runs end-to-end (veg + memory + pancakes every day)", res.profile.diet === "vegetarian" && (res.profile.memory ?? []).some((f) => /lactose/i.test(f.fact)) && res.plan.days.every((d) => /pancake/i.test(d.meals.find((m) => m.type === "breakfast")?.name ?? "")));
  }
  check("v2 turn: rejects an unknown op", !AssistantTurnV2Schema.safeParse({ thinking: "x", reply: "y", operations: [{ op: "teleport" }] }).success);
  check("v2 turn: rejects a bad enum value", !AssistantTurnV2Schema.safeParse({ thinking: "x", reply: "y", operations: [{ op: "constrain", diet: "carnivore" }] }).success);

  // The v2 system prompt teaches the shape + primitives, and folds in remembered facts.
  const sp = assistantV2SystemPrompt(BASE, freshWeek(BASE));
  check("v2 prompt: teaches the reason-then-act shape + primitives + outcomes", /thinking/.test(sp) && /constrain/.test(sp) && /remember/.test(sp) && /FOUR OUTCOMES/.test(sp));
  const pmem = applyRemember(BASE, { op: "remember", fact: "lactose intolerant" });
  check("v2 prompt: folds the user's memory into the context", /lactose intolerant/i.test(assistantV2SystemPrompt(pmem, freshWeek(pmem))));

  // The /api/assistant-v2 route's core logic (minus the network call): a parsed model turn is
  // executed through the previous-threaded executor, and the engine's notes own the final reply.
  const startWk = freshWeek(BASE);
  const doTurn = AssistantTurnV2Schema.safeParse({ thinking: "Whole-week vegan.", reply: "Done — vegan week.", operations: [{ op: "constrain", diet: "vegan" }] });
  check("v2 route: a do-turn parses", doTurn.success);
  if (doTurn.success) {
    const r = applyPrimitives(BASE, startWk, doTurn.data.operations as PrimitiveOp[]);
    const reply = composeReply({ modelReply: doTurn.data.reply, notes: r.notes, replyOverride: r.replyOverride, planChanged: r.planChanged });
    check("v2 route: do-turn executes + composes a non-empty reply", r.profile.diet === "vegan" && r.planChanged && reply.trim().length > 0);
    // undo restores the prior snapshot — the capability the new `previous` arg on applyPrimitives adds.
    const snap = { plan: startWk, profile: BASE, label: "your last change" };
    const undo = applyPrimitives(r.profile, r.plan, [{ op: "undo" }], undefined, snap);
    check("v2 route: undo restores the previous plan+profile via applyPrimitives(previous)", undo.undone === true && undo.profile.diet === "none");
  }
}

console.log("");
console.log("--- DATA VALIDATOR (generate-then-validate: keep only correct examples) ---");
{
  const defaults = { profile: BASE, plan: freshWeek(BASE) };
  const ok = (ex: TrainingExample) => validateExample(ex, defaults).ok;

  check("validator: accepts a correct 'go vegetarian' example", ok({
    turns: [{ role: "user", text: "make my whole week vegetarian" }],
    thinking: "Whole-week diet change.", reply: "Done — your week is vegetarian now.",
    operations: [{ op: "constrain", diet: "vegetarian" }], expect: { dietIs: "vegetarian", planChanged: true },
  }));
  check("validator: accepts a remember example", ok({
    turns: [{ role: "user", text: "just so you know i'm lactose intolerant" }],
    thinking: "A durable allergy to store.", reply: "Noted — I'll keep dairy out.",
    operations: [{ op: "remember", fact: "lactose intolerant", kind: "allergy" }], expect: { remembers: "lactose", profileChanged: true },
  }));
  check("validator: accepts a clarify (no ops, no change)", ok({
    turns: [{ role: "user", text: "change it" }],
    thinking: "Too vague — ask.", reply: "Happy to — what should I change: a day, a meal, or a setting?",
    operations: [], expect: { noChange: true },
  }));

  // Rejections.
  check("validator: REJECTS a schema-invalid op", !ok({
    turns: [{ role: "user", text: "x" }], thinking: "t", reply: "r", operations: [{ op: "teleport" }],
  }));
  check("validator: REJECTS a reply that claims a diet change with no op to back it", !ok({
    turns: [{ role: "user", text: "make it vegetarian" }], thinking: "t", reply: "Done — it's vegetarian!",
    operations: [], expect: { dietIs: "vegetarian" },
  }));
  check("validator: REJECTS an op that claims a change but moves nothing (undo with no history)", !ok({
    turns: [{ role: "user", text: "undo that" }], thinking: "revert", reply: "Reverted.", operations: [{ op: "undo" }],
  }));

  // Batch partitions correctly.
  const batch: TrainingExample[] = [
    { turns: [{ role: "user", text: "go vegan" }], thinking: "t", reply: "Done — vegan now.", operations: [{ op: "constrain", diet: "vegan" }], expect: { dietIs: "vegan" } },
    { turns: [{ role: "user", text: "x" }], thinking: "t", reply: "r", operations: [{ op: "teleport" }] },
  ];
  const { kept, rejected } = validateBatch(batch, defaults);
  check("validator: batch keeps the good, drops the bad", kept.length === 1 && rejected.length === 1 && /schema/.test(rejected[0].reason));

  // The generator's examples must validate through the real engine (correct, not just plausible).
  // Spot-check a fixed-size SAMPLE here (~160, evenly spread across intents) — validating all of
  // them is thousands of week-rebuilds and belongs in the one-shot data-gen script, not this suite.
  // A fixed count (not a fixed fraction) keeps this fast as the generator grows toward thousands.
  const gen = generateExamples();
  check("generator: produces a substantial batch", gen.length >= 200, String(gen.length));
  const step = Math.max(1, Math.ceil(gen.length / 160));
  const sample = gen.filter((_, i) => i % step === 0);
  const g = validateBatch(sample, { profile: BASE, plan: freshWeek(BASE) });
  const rate = g.kept.length / sample.length;
  check(`generator: sample validates end-to-end (${g.kept.length}/${sample.length})`, rate >= 0.98, g.rejected.slice(0, 6).map((r) => r.reason).join("  |  "));
}


// ---------------------------------------------------------------- feed (Phase 3)
console.log("");
console.log("--- FEED (browse the library, filtered) ---");
{
  const all: FeedFilter = { mealType: "all", diet: "all", highProtein: false, maxTime: null, query: "" };
  check("feed: has a substantial number of recipes", FEED_RECIPES.length >= 20, String(FEED_RECIPES.length));
  // A discovery feed must NOT surface treat-only dishes (pizza, burgers) — same rule as the planner.
  check("feed: excludes treat-only dishes", FEED_RECIPES.every((it) => !/pizza|burger/i.test(it.meal.name)));
  check("feed: every card is a valid Meal", FEED_RECIPES.every((it) => MealSchema.safeParse(it.meal).success));
  check("feed: no filter returns everything", filterFeed(FEED_RECIPES, all).length === FEED_RECIPES.length);

  const dinners = filterFeed(FEED_RECIPES, { ...all, mealType: "dinner" });
  check("feed: mealType filter keeps only that slot", dinners.length > 0 && dinners.every((it) => it.meal.type === "dinner"));

  const vegan = filterFeed(FEED_RECIPES, { ...all, diet: "vegan" });
  check("feed: diet filter keeps only that diet", vegan.length > 0 && vegan.every((it) => it.dietTags.includes("vegan")));
  // Correctness that matters: a vegan filter must NEVER surface a meat/fish dish.
  check("feed: vegan filter never shows chicken/salmon/beef", vegan.every((it) => !/chicken|salmon|beef|turkey|tuna|pork/i.test(it.meal.name)));

  const hp = filterFeed(FEED_RECIPES, { ...all, highProtein: true });
  check("feed: high-protein filter respects the floor", hp.length > 0 && hp.every((it) => it.meal.proteinGrams >= HIGH_PROTEIN_G));

  const quick = filterFeed(FEED_RECIPES, { ...all, maxTime: 20 });
  check("feed: time filter respects the cap", quick.every((it) => it.meal.timeMinutes <= 20));

  // Facets AND together, not OR.
  const combo = filterFeed(FEED_RECIPES, { mealType: "lunch", diet: "vegan", highProtein: false, maxTime: null, query: "" });
  check("feed: facets combine (vegan lunches only)", combo.every((it) => it.meal.type === "lunch" && it.dietTags.includes("vegan")));

  // Search over name + ingredients.
  const salmon = filterFeed(FEED_RECIPES, { ...all, query: "salmon" });
  check("feed: search finds a term in name or ingredients", salmon.length > 0 && salmon.every((it) => /salmon/i.test(it.meal.name + " " + it.meal.ingredients.map((i) => i.name).join(" "))));
  // Multi-term is AND across name+ingredients.
  const both = filterFeed(FEED_RECIPES, { ...all, query: "chicken rice" });
  check("feed: multi-term search is AND", both.every((it) => { const h = (it.meal.name + " " + it.meal.ingredients.map((i) => i.name).join(" ")).toLowerCase(); return h.includes("chicken") && h.includes("rice"); }));
  check("feed: an empty query matches everything", filterFeed(FEED_RECIPES, { ...all, query: "   " }).length === FEED_RECIPES.length);
  check("feed: gibberish matches nothing", filterFeed(FEED_RECIPES, { ...all, query: "zzxqwlk" }).length === 0);
  // Word-START matching: "oat" must not collide with "goat"; "chick" must still find chicken.
  const hayOf = (it: (typeof FEED_RECIPES)[number]) => (it.meal.name + " " + it.meal.ingredients.map((i) => i.name).join(" ")).toLowerCase();
  const oatQ = filterFeed(FEED_RECIPES, { ...all, query: "oat" });
  const goatQ = filterFeed(FEED_RECIPES, { ...all, query: "goat" });
  check("feed: 'goat' finds goat dishes but 'oat' no longer collides with them",
    goatQ.some((it) => /goat/i.test(hayOf(it))) && oatQ.every((it) => !/goat/i.test(hayOf(it))), `goat=${goatQ.length} oat=${oatQ.length}`);
  check("feed: 'chick' still finds chicken (word-start prefix preserved)",
    filterFeed(FEED_RECIPES, { ...all, query: "chick" }).some((it) => /chicken/i.test(hayOf(it))));

  // Sorting is a stable, correct re-ordering that preserves the set.
  const base = filterFeed(FEED_RECIPES, all);
  const byProtein = sortFeed(base, "protein");
  check("feed: sort by protein is descending, same count", byProtein.length === base.length && byProtein.every((it, i) => i === 0 || byProtein[i - 1].meal.proteinGrams >= it.meal.proteinGrams));
  const byCal = sortFeed(base, "calories-low");
  check("feed: sort by calories is ascending", byCal.every((it, i) => i === 0 || byCal[i - 1].meal.calories <= it.meal.calories));
  const byTime = sortFeed(base, "time");
  check("feed: sort by time is ascending", byTime.every((it, i) => i === 0 || byTime[i - 1].meal.timeMinutes <= it.meal.timeMinutes));
  check("feed: default sort keeps library order", sortFeed(base, "default").map((it) => it.meal.name).join("|") === base.map((it) => it.meal.name).join("|"));
}

// ---------------------------------------------------------------- audit regressions
console.log("");
console.log("--- ALLERGEN MATCHING (found by audit: a peanut-allergic user was served peanuts) ---");
{
  const T = (a: string) => parseExclusionTokens(a, "");

  // The bug: wordMatches only asked whether the INGREDIENT was a plural of the TOKEN, never the
  // reverse. "peanuts" — the literal placeholder in the onboarding form — did not block "peanut
  // butter", and the planner served Thai Peanut Chicken Rice Bowl.
  const mustBlock: [string, string][] = [
    ["peanuts", "peanut butter"], ["peanut", "peanut butter"], ["almonds", "almond butter"],
    ["eggs", "egg"], ["egg", "eggs"], ["walnuts", "walnut halves"],
    ["soy", "teriyaki sauce"], ["gluten", "teriyaki sauce"],
    ["milk", "cheddar"], ["milk", "greek yogurt"],
    ["allergic to nuts", "almonds"], ["tree nuts and shellfish", "shrimp"],
    ["tree nuts and shellfish", "walnuts"], ["i'm allergic to dairy", "feta"],
    ["shellfish", "prawns"], ["fish", "cod fillet"],
  ];
  let leaks = "";
  for (const [tok, food] of mustBlock)
    if (!haystackBlocked(food, T(tok))) leaks += ` "${tok}"->"${food}"`;
  check("every allergy phrasing blocks the food it names", leaks === "", leaks);

  // ...without over-blocking. "egg" must still not eat "eggplant", and a dairy allergy must not
  // strip peanut butter just because the category lists the bare word "butter".
  const mustNotBlock: [string, string][] = [
    ["egg", "eggplant"], ["oat", "goat cheese"], ["dairy", "peanut butter"],
    ["lactose", "almond butter"], ["nuts", "coconut milk"], ["corn", "unicorn stew"],
  ];
  let over = "";
  for (const [tok, food] of mustNotBlock)
    if (haystackBlocked(food, T(tok))) over += ` "${tok}"->"${food}"`;
  check("no allergy phrasing over-blocks an unrelated food", over === "", over);

  // The invariant that actually matters: it must not reach the plate.
  const ALLERGY_CASES = ["peanuts", "almonds", "eggs", "milk", "allergic to nuts", "shellfish"];
  let served = "";
  for (const allergy of ALLERGY_CASES) {
    const prof: UserProfile = { ...BASE, allergies: allergy };
    const tokens = T(allergy);
    for (let i = 0; i < 4 && !served; i++) {
      const wk = freshWeek(prof);
      for (const d of wk.days)
        for (const m of d.meals)
          if (haystackBlocked(mealHay(m), tokens)) served = `${allergy}: ${d.day} ${m.name}`;
    }
  }
  check("the planner never serves an allergen, in any phrasing", served === "", served);
}

// ---------------------------------------------------------------- allergen laws (D5b)
// Derived as PROPERTIES of the matcher and swept over the whole library (V1 milestone D5b,
// 2026-10-03). The sweep found eleven failing laws with real servings end to end; the second half of
// this block holds each one's cases, now passing, so none can come back quietly.
console.log("");
console.log("--- ALLERGEN LAWS (D5b: properties, swept over the whole library) ---");
{
  const T = (a: string) => parseExclusionTokens(a, "");

  // L1 — an allergen matches its plural and singular BOTH ways, typed either way, and as a modifier
  // ("peanuts" must block "peanut butter"). The one-way version served a peanut allergy Thai Peanut Chicken.
  const pairs: [string, string][] = [
    ["peanut", "peanuts"], ["egg", "eggs"], ["almond", "almonds"], ["prawn", "prawns"], ["walnut", "walnuts"],
    ["pecan", "pecans"], ["cashew", "cashews"], ["hazelnut", "hazelnuts"], ["pistachio", "pistachios"],
    ["shrimp", "shrimps"], ["sardine", "sardines"], ["lobster", "lobsters"], ["tomato", "tomatoes"],
    ["anchovy", "anchovies"], ["berry", "berries"], ["cherry", "cherries"],
  ];
  let oneWay = "";
  for (const [s, p] of pairs) {
    if (!haystackBlocked(p, T(s))) oneWay += ` ${s}->${p}`;
    if (!haystackBlocked(s, T(p))) oneWay += ` ${p}->${s}`;
    if (!haystackBlocked(`${s} butter`, T(p))) oneWay += ` ${p}->"${s} butter"`;
  }
  check("allergen law: singular and plural (-s, -es, -y/-ies) match both ways, incl. as a modifier", oneWay === "", oneWay || `${pairs.length * 3} cases`);
  check("allergen law: the fish category blocks 'anchovies'", haystackBlocked("anchovies", ["fish"]));

  // L2 — a category blocks EVERY member it lists: as the raw key, as parsed, and inside a sentence.
  let memberMiss = "";
  for (const key of EXCLUSION_CATEGORIES)
    for (const term of expandExclusion(key)) {
      if (!haystackBlocked(term, [key])) memberMiss += ` ${key}->${term}`;
      if (!haystackBlocked(term, T(key))) memberMiss += ` T(${key})->${term}`;
      if (!haystackBlocked(`Some Dish ${term} rice`, T(`allergic to ${key}`))) memberMiss += ` "allergic to ${key}"->${term}`;
    }
  check("allergen law: every category blocks every member it lists", memberMiss === "", memberMiss || `${EXCLUSION_CATEGORIES.length} categories`);

  // L3 — the members that matter most, spelled exactly as the library spells them.
  const named: [string, string][] = [
    ["nuts", "peanut butter"], ["nuts", "pesto"], ["nut", "peanuts"], ["nuts", "almonds"], ["nuts", "walnuts"], ["nuts", "pecans"],
    ["tree nuts", "almonds"], ["tree nuts", "pesto"],
    ["dairy", "light caesar dressing"], ["dairy", "pesto"], ["dairy", "greek yogurt"], ["dairy", "cottage cheese"],
    ["dairy", "ice cream"], ["dairy", "butter"], ["milk", "light caesar dressing"], ["lactose", "parmesan"],
    ["gluten", "soy-ginger sauce"], ["gluten", "ginger-soy sauce"], ["gluten", "sesame-soy sauce"], ["gluten", "soy sauce"],
    ["gluten", "teriyaki sauce"], ["gluten", "whole-wheat penne"], ["gluten", "sourdough bread"], ["gluten", "panko"],
    ["gluten", "burger bun"], ["gluten", "soba noodles"], ["gluten", "wholegrain bagel"], ["wheat", "sesame-soy sauce"],
    ["shellfish", "prawns"], ["shellfish", "shrimp"], ["shellfish", "prawn"],
    ["egg", "light caesar dressing"], ["egg", "egg noodles"], ["egg", "egg whites"],
    ["fish", "smoked mackerel"], ["fish", "canned tuna"], ["fish", "cod fillet"], ["fish", "light caesar dressing"],
    ["sesame", "tahini"], ["sesame", "hummus"], ["sesame", "sesame oil"],
    ["soy", "firm tofu"], ["soy", "miso paste"], ["soy", "edamame"], ["soy", "tempeh"], ["soy", "soy protein powder"],
    ["pork", "lean pork sausage"], ["pork", "pork tenderloin"],
  ];
  let namedLeak = "";
  for (const [k, food] of named) if (!haystackBlocked(food, T(k))) namedLeak += ` ${k}->"${food}"`;
  check("allergen law: each category blocks its members as the library spells them", namedLeak === "", namedLeak || `${named.length} cases`);
  check("allergen law: 'tree nuts' does not list peanut (a legume)", !expandExclusion("tree nuts").includes("peanut"));

  // L4 — never a word-fragment false positive. Nutmeg is a seed, not a nut: a nut allergy leaves it alone.
  // Nor a two-letter word read as a stem: "so" is not soy, "co" is not cod. Nor a cooking verb read as a
  // gluten food: nine recipes with no gluten in them were blocked for every coeliac by "toast the cumin".
  const fragments: [string, string][] = [
    ["egg", "eggplant"], ["eggs", "eggplant"], ["oat", "goat cheese"], ["oats", "goat cheese"], ["ham", "graham crackers"],
    ["pork", "graham crackers"], ["ham", "hamburger"], ["nut", "nutmeg"], ["nuts", "nutmeg"], ["tree nuts", "nutmeg"],
    ["nuts", "coconut milk"], ["nuts", "butternut squash"], ["nuts", "nutritional yeast"], ["nut", "doughnut"],
    ["dairy", "butternut squash"], ["dairy", "peanut butter"], ["dairy", "almond butter"], ["milk", "cocoa butter"],
    ["pea", "peanuts"], ["peas", "peanut butter"], ["corn", "unicorn"], ["rice", "licorice"], ["tuna", "fortunate"],
    ["fish", "selfish"], ["ham", "shame"], ["egg", "veggie"], ["cod", "avocado"], ["bun", "bunch of parsley"],
    ["soy", "toss so it coats"], ["fish", "a co op"], ["gluten", "toast the cumin seeds"], ["gluten", "toasted sesame seeds"],
    ["gluten", "wrap in foil and bake"], ["gluten", "mix everything into a dough"], ["dairy", "soy protein powder"],
  ];
  let frag = "";
  for (const [tok, food] of fragments) if (haystackBlocked(food, T(tok))) frag += ` "${tok}"->"${food}"`;
  check("allergen law: no word-fragment false positive (eggplant, goat, graham, nutmeg, 'so', 'toast the')", frag === "", frag || `${fragments.length} cases`);
  check("allergen law: ...while toast and wraps as FOODS still block",
    haystackBlocked("serve on whole-grain toast", T("gluten")) && haystackBlocked("Chilli Avocado Toast", T("gluten")) &&
      haystackBlocked("Beef Fajita Wrap whole-wheat wrap", T("gluten")));
  const gluten = T("gluten");
  const stepOnly = RECIPES.filter((r) => haystackBlocked(recipeHay(r), gluten) &&
    !haystackBlocked(`${r.name} ${r.ingredients.map((i) => i.name).join(" ")}`, gluten));
  check("allergen law: no recipe is blocked for gluten by its METHOD alone", stepOnly.length === 0, stepOnly.map((r) => r.name).join(" | "));

  // L5 — a contrast clause never cancels an allergy, on EITHER side of the contrast word, and a food
  // the user says is fine is not blocked. The first version kept only the clause before the contrast
  // word, so "fine with almonds but allergic to peanuts" was served peanut dishes 7 times in 5 weeks.
  const contrastCases: [string, string, string][] = [
    ["peanuts but fine with almonds", "peanut butter", "almonds"],
    ["fine with almonds but allergic to peanuts", "peanut butter", "almonds"],
    ["i can eat almonds but not peanuts", "peanut butter", "almonds"],
    ["almonds are fine however peanuts are not", "peanut butter", "almonds"],
    ["I'm not allergic to almonds, but peanuts yes", "peanut butter", "almonds"],
    ["nuts are fine except peanuts", "peanut butter", "walnuts"],
  ];
  for (const [typed, block, allow] of contrastCases) {
    const t = T(typed);
    check(`allergen law: "${typed}" blocks ${block} and not ${allow}`, haystackBlocked(block, t) && !haystackBlocked(allow, t), JSON.stringify(t));
  }
  check("allergen law: 'shellfish, except crab' still blocks prawns", haystackBlocked("prawns", T("shellfish, except crab")));
  check("allergen law: 'no dairy except butter' still blocks cheddar", haystackBlocked("cheddar", T("no dairy except butter")));
  check("allergen law: an allowance word inside an allergy does not cancel it ('ok so I'm allergic to peanuts')",
    haystackBlocked("peanut butter", T("ok so I'm allergic to peanuts")));

  // L6 — matching is case- and whitespace-insensitive on both sides.
  check("allergen law: case and padding do not matter",
    haystackBlocked("THAI PEANUT CHICKEN", ["  Peanuts "]) && haystackBlocked("Greek Yogurt", [" DAIRY"]) && haystackBlocked("Prawns", T("SHELLFISH")));

  // L7 — exclusions compose: naming a second allergy never unblocks the first.
  let composeMiss = "";
  for (const a of EXCLUSION_CATEGORIES)
    for (const b of ["peanuts", "sesame", "shellfish"]) {
      const both = parseExclusionTokens(`${a}, ${b}`, "");
      const split = parseExclusionTokens(a, b);
      for (const food of expandExclusion(a))
        if (!haystackBlocked(food, both) || !haystackBlocked(food, split)) composeMiss += ` ${a}+${b}->${food}`;
    }
  check("allergen law: adding an allergy (or splitting it into dislikes) never unblocks another", composeMiss === "", composeMiss || "clean");

  // L8 — every ordinary way of TYPING an allergy blocks the food. 15 of 17 of these lost the allergy
  // before: "severe peanut allergy" was served peanut 9 times in 5 weeks, "dairy-free" dairy 23 times.
  const typings: [string, string][] = [
    ["peanuts.", "peanut butter"], ["Peanuts!", "peanut butter"], ["(peanuts)", "peanut butter"], ["*peanuts*", "peanut"],
    ["\"peanuts\"", "peanut"], ["'peanuts'", "peanut"], ["I’m allergic to peanuts", "peanut butter"],
    ["peanuts\nshellfish", "shrimp"], ["peanuts\nshellfish", "peanut"], ["peanuts shellfish", "prawn"],
    ["shrimp or crab", "prawns"], ["shrimp or crab", "crab"], ["severe peanut allergy", "peanut butter"],
    ["life-threatening peanut allergy", "satay"], ["anaphylactic to peanuts", "peanut butter"],
    ["dairy-free", "cheddar"], ["gluten-free", "bread"], ["nut-free", "almonds"], ["coeliac", "pizza base"],
    ["celiac", "pasta"], ["Coeliac disease", "bread"], ["my son is allergic to nuts", "almond"],
    ["cow's milk", "cheddar"], ["crème fraîche", "creme fraiche"], ["no dairy products please", "milk"],
  ];
  let typedLeak = "";
  for (const [typed, food] of typings) if (!haystackBlocked(food, T(typed))) typedLeak += ` ${JSON.stringify(typed)}->"${food}" ${JSON.stringify(T(typed))}`;
  check("allergen law: every ordinary way of typing an allergy blocks the food", typedLeak === "", typedLeak || `${typings.length} cases`);
  // The form a food comes in is not the allergen: an "oat milk" dislike must not strip dairy milk.
  const carriers: [string, string][] = [["peanut butter", "butter"], ["oat milk", "milk"], ["almond milk", "cheddar"], ["coconut milk", "greek yogurt"]];
  let carrierOver = "";
  for (const [typed, food] of carriers) if (haystackBlocked(food, T(typed))) carrierOver += ` "${typed}"->"${food}"`;
  check("allergen law: a phrase blocks the food it is MADE of, not the form it comes in", carrierOver === "", carrierOver);

  // L9 — synonyms and UK/EU label terms block each other. "prawns" left 12 shrimp recipes eligible and
  // was served shrimp 9 times in 5 weeks; "soya" was served tofu 15 times.
  const synonyms: [string, string][] = [
    ["prawns", "shrimp"], ["shrimp", "prawns"], ["crustaceans", "crab"], ["crustaceans", "shrimp"], ["molluscs", "mussels"],
    ["shellfish", "oysters"], ["soya", "firm tofu"], ["soya", "soy sauce"], ["soybeans", "edamame"], ["yoghurt", "greek yogurt"],
    ["yogurt", "yoghurt"], ["groundnuts", "peanut butter"],
  ];
  let synLeak = "";
  for (const [typed, food] of synonyms) if (!haystackBlocked(food, T(typed))) synLeak += ` "${typed}"->"${food}"`;
  check("allergen law: synonyms and label terms block each other (prawn/shrimp, soya, crustaceans…)", synLeak === "", synLeak || `${synonyms.length} cases`);

  // L10 — compound and prepared foods carry the allergens their usual recipe does (the pesto/Caesar
  // precedent). Whey protein powder passed a milk allergy 27 times in 10 weeks; a pizza base passed a coeliac.
  const compounds: [string, string][] = [
    ["gluten", "pizza base"], ["gluten", "Pepperoni & Mozzarella Pizza"], ["dairy", "protein powder"], ["milk", "protein powder"],
    ["lactose", "protein powder"], ["dairy", "tikka masala sauce"], ["nuts", "tikka masala sauce"], ["fish", "kimchi"],
    ["shellfish", "kimchi"], ["nuts", "granola"], ["nuts", "muesli"], ["tree nuts", "granola"], ["dairy", "buffalo sauce"],
    ["gluten", "enchilada sauce"], ["gluten", "turkey sausage"], ["wheat", "lean pork sausage"], ["pork", "pepperoni"],
    ["pork", "prosciutto"], ["dairy", "buttermilk"], ["dairy", "ghee"], ["dairy", "paneer"], ["dairy", "whey"],
    ["gluten", "breadcrumbs"], ["gluten", "flatbread"], ["gluten", "barley"], ["gluten", "rye crackers"],
    ["soy", "soya milk"], ["egg", "mayonnaise"], ["sesame", "halva"],
  ];
  let compoundLeak = "";
  for (const [k, food] of compounds) if (!haystackBlocked(food, T(k))) compoundLeak += ` ${k}->"${food}"`;
  check("allergen law: compound foods carry their usual allergens (pizza base, whey, tikka masala, kimchi…)", compoundLeak === "", compoundLeak || `${compounds.length} cases`);
  check("allergen law: the allergen path agrees with the diet path on gluten and dairy, across the library", (() => {
    for (const r of RECIPES) {
      const names = r.ingredients.map((i) => i.name);
      if (dietTagConflicts("gluten_free", names).length && !haystackBlocked(recipeHay(r), T("gluten"))) return false;
      const dairy = dietTagConflicts("vegan", names).filter((n) => /milk|cheese|yogurt|butter|cream|whey|protein powder|ghee|paneer/.test(n));
      if (dairy.length && !haystackBlocked(recipeHay(r), T("dairy"))) return false;
    }
    return true;
  })());

  // L11 — LIBRARY SWEEP. An oracle written independently of CATEGORY_TERMS: unambiguous members,
  // word-bounded, with plurals. Every recipe — treats included — that contains a member must be
  // blocked by that category's token, through the same haystack the engine uses.
  const W = (words: string[]) => new RegExp(`\\b(${words.join("|")})(s|es)?\\b`, "i");
  const ORACLE: Record<string, RegExp> = {
    nuts: W(["almond", "walnut", "pecan", "cashew", "hazelnut", "pistachio", "macadamia", "peanut", "pine nut", "pesto"]),
    "tree nuts": W(["almond", "walnut", "pecan", "cashew", "hazelnut", "pistachio", "macadamia", "pine nut", "pesto"]),
    peanuts: W(["peanut"]),
    dairy: W(["milk", "cheese", "yogurt", "yoghurt", "butter(?<!peanut butter)(?<!almond butter)", "cream", "feta", "mozzarella", "cheddar", "parmesan", "ricotta", "halloumi", "paneer", "ghee", "caesar dressing", "pesto", "protein powder(?<!soy protein powder)"]),
    gluten: W(["bread", "pasta", "couscous", "bulgur", "orzo", "panko", "spaghetti", "penne", "noodle", "bagel", "wrap", "tortilla", "flour", "wheat", "toast", "bun", "soy sauce", "soy-ginger sauce", "ginger-soy sauce", "sesame-soy sauce", "teriyaki", "muesli", "granola", "pizza base", "sausage", "enchilada sauce"]),
    shellfish: W(["shrimp", "prawn", "crab", "lobster", "scallop", "mussel", "clam", "oyster"]),
    fish: W(["salmon", "tuna", "cod", "mackerel", "trout", "sardine", "haddock", "fish", "caesar dressing"]),
    egg: W(["egg", "mayonnaise", "mayo", "aioli", "caesar dressing"]),
    soy: W(["tofu", "tempeh", "edamame", "soy", "soya", "miso", "teriyaki"]),
    sesame: W(["sesame", "tahini", "hummus"]),
    pork: W(["pork", "bacon", "ham", "chorizo", "prosciutto", "pancetta", "salami"]),
  };
  const sweepLeaks: string[] = [];
  let pairsSeen = 0;
  // The diet path's own gluten-free foods (corn tortillas, chickpea flour, rice noodles, oat flour) are
  // safe for a coeliac, and the allergen path agrees since the D5b review.
  const GF_SAFE = /^(rice noodles|corn tortillas|chickpea flour|oat flour)$/;
  for (const [token, re] of Object.entries(ORACLE)) {
    const tokens = T(token);
    for (const r of RECIPES) {
      const hit = r.ingredients.map((i) => i.name.toLowerCase()).find((n) => re.test(n) && !(token === "gluten" && GF_SAFE.test(n)));
      if (!hit) continue;
      pairsSeen++;
      if (!haystackBlocked(recipeHay(r), tokens)) sweepLeaks.push(`${token}: ${r.name} <- ${hit}`);
    }
  }
  check("allergen law: every recipe holding a category member is blocked by that category, treats included",
    sweepLeaks.length === 0, sweepLeaks.length ? sweepLeaks.slice(0, 6).join("; ") : `${pairsSeen} recipe x allergen pairs`);
  // Prove the presence: the sweep must actually have looked at every allergen.
  check("...and the sweep exercised every allergen in the oracle",
    Object.values(ORACLE).every((re) => RECIPES.some((r) => r.ingredients.some((i) => re.test(i.name.toLowerCase())))), `${pairsSeen} pairs`);

  // L12 — DIET TAGS against an independent oracle (dietTagConflicts' own sweep is in DATA INTEGRITY;
  // this one uses different lists so a gap in NON_VEGAN/NON_VEGETARIAN cannot hide itself).
  const MEAT_FISH = W(["chicken", "beef", "pork", "turkey", "lamb", "duck", "ham", "bacon", "chorizo", "sausage", "steak", "salmon", "tuna", "cod", "mackerel", "trout", "shrimp", "prawn", "crab", "lobster", "sardine", "fish", "gelatin", "caesar dressing"]);
  const ANIMAL = W(["milk", "cheese", "yogurt", "yoghurt", "butter", "cream", "feta", "mozzarella", "cheddar", "parmesan", "ricotta", "halloumi", "honey", "egg", "ghee", "whey", "pesto", "caesar dressing", "tikka masala sauce"]);
  const PLANT_OK = /^(peanut butter|almond butter|soy protein powder|eggplant|cocoa butter)$/;
  const GLUTEN = W(["bread", "pasta", "couscous", "bulgur", "orzo", "panko", "spaghetti", "penne", "noodle", "bagel", "wrap", "tortilla", "flour", "wheat", "toast", "bun", "rye", "barley", "soy sauce", "soy-ginger sauce", "ginger-soy sauce", "sesame-soy sauce", "teriyaki", "muesli", "granola", "pizza base", "sausage", "enchilada sauce"]);
  const GF_OK = /^(rice noodles|corn tortillas|chickpea flour|oat flour)$/;
  const STARCH = W(["rice", "quinoa", "pasta", "bread", "toast", "tortilla", "oat", "potato", "banana", "honey", "mango", "couscous", "bulgur", "orzo", "noodle", "lentil", "chickpea", "black bean", "kidney bean", "cannellini bean", "corn", "granola", "muesli", "bagel", "wrap", "pizza base", "bun"]);
  const tagLies: string[] = [];
  for (const r of RECIPES) {
    const ing = r.ingredients.map((i) => i.name.toLowerCase());
    const veg = r.dietTags.includes("vegetarian") || r.dietTags.includes("vegan");
    for (const n of ing) {
      if (veg && MEAT_FISH.test(n)) tagLies.push(`${r.id} [vegetarian] <- ${n}`);
      if (r.dietTags.includes("vegan") && !PLANT_OK.test(n) && (ANIMAL.test(n) || n === "protein powder")) tagLies.push(`${r.id} [vegan] <- ${n}`);
      if (r.dietTags.includes("gluten_free") && !GF_OK.test(n) && GLUTEN.test(n)) tagLies.push(`${r.id} [gluten_free] <- ${n}`);
      if (r.dietTags.includes("keto") && STARCH.test(n)) tagLies.push(`${r.id} [keto] <- ${n}`);
    }
  }
  check("diet-tag law: no vegan/vegetarian/gluten_free/keto tag contradicted by an independent ingredient oracle",
    tagLies.length === 0, tagLies.length ? tagLies.slice(0, 6).join("; ") : `${RECIPES.length} recipes`);

  // L13 — dietTagConflicts catches each class it exists for, and leaves compliant foods alone.
  const mustFlag: [string, string][] = [["vegan", "eggs"], ["vegan", "greek yogurt"], ["vegan", "honey"], ["vegan", "protein powder"],
    ["vegetarian", "chicken breast"], ["vegetarian", "smoked salmon"], ["gluten_free", "whole-wheat penne"],
    ["gluten_free", "soy-ginger sauce"], ["gluten_free", "sourdough bread"], ["gluten_free", "pizza base"],
    ["vegetarian", "lamb mince"], ["vegetarian", "ham"], ["vegetarian", "chorizo"], ["vegetarian", "anchovies"], ["vegetarian", "fish sauce"],
    ["vegetarian", "crab"], ["vegetarian", "light caesar dressing"], ["vegan", "anchovy"], ["vegan", "ghee"], ["vegan", "whey"],
    ["vegan", "pesto"], ["vegan", "yoghurt"], ["vegan", "gelatin"], ["vegan", "mayonnaise"], ["vegan", "tikka masala sauce"],
    ["gluten_free", "barley"], ["gluten_free", "rye bread"], ["gluten_free", "turkey sausage"], ["gluten_free", "enchilada sauce"]];
  let unflagged = "";
  for (const [t, n] of mustFlag) if (!dietTagConflicts(t, [n]).length) unflagged += ` ${t}:${n}`;
  check("diet-tag law: dietTagConflicts flags each class of violation", unflagged === "", unflagged || `${mustFlag.length} controls`);
  const mustPass: [string, string][] = [["vegan", "eggplant"], ["vegan", "peanut butter"], ["vegan", "almond butter"], ["vegan", "soy protein powder"],
    ["gluten_free", "corn tortillas"], ["gluten_free", "rice noodles"], ["gluten_free", "chickpea flour"], ["vegetarian", "eggs"], ["vegetarian", "greek yogurt"],
    ["vegetarian", "graham crackers"], ["vegetarian", "collard greens"], ["vegan", "oyster mushrooms"], ["vegan", "vegan pesto"],
    ["gluten_free", "gluten-free sausage"], ["gluten_free", "maltodextrin"]];
  let overflag = "";
  for (const [t, n] of mustPass) if (dietTagConflicts(t, [n]).length) overflag += ` ${t}:${n}`;
  check("diet-tag law: dietTagConflicts leaves compliant foods alone", overflag === "", overflag || `${mustPass.length} controls`);

  // END TO END — the phrasings the sweep caught on a plate. Four seeded weeks each; none may serve it.
  const E2E: [string, string][] = [
    ["fine with almonds but allergic to peanuts", "peanuts"], ["severe peanut allergy", "peanuts"], ["I’m allergic to peanuts.", "peanuts"],
    ["shrimp or crab", "shellfish"], ["dairy-free", "dairy"], ["prawns", "shellfish"], ["crustaceans", "shellfish"], ["soya", "soy"],
    ["yoghurt", "yogurt"], ["groundnuts", "peanuts"], ["milk", "protein powder"],
  ];
  let e2eServed = "";
  for (const [typed, meaning] of E2E) {
    const prof: UserProfile = { ...BASE, allergies: typed };
    const oracle = T(meaning);
    for (let s = 0; s < 4 && !e2eServed; s++) {
      const wk = withSeed(500 + s, () => freshWeek(prof));
      for (const d of wk.days)
        for (const m of d.meals)
          if (haystackBlocked(mealHay(m), oracle)) e2eServed = `"${typed}": ${d.day} ${m.name}`;
    }
  }
  check("end to end: no phrasing the sweep caught is served the food it names", e2eServed === "", e2eServed || `${E2E.length} phrasings x 4 weeks`);
  // …and a direct request cannot route around it: a coeliac asking for pizza does not get the pizza.
  for (const allergy of ["coeliac", "gluten-free", "wheat"]) {
    const prof: UserProfile = { ...BASE, allergies: allergy };
    const r = applyOperations(prof, freshWeek(prof), [op({ tool: "swap_meal", day: "Saturday", mealType: "dinner", dish: "pizza" })]);
    const sat = r.plan.days.find((x) => x.day === "Saturday")!;
    check(`end to end: allergies "${allergy}" + "swap Saturday dinner for pizza" serves no gluten`,
      !sat.meals.some((m) => haystackBlocked(mealHay(m), T("gluten"))), sat.meals.map((m) => m.name).join(" | "));
  }
}

console.log("");
console.log("--- RED FLAGS (found by audit: 'my chest hurts' got a nutrition answer) ---");
{
  const plan = freshWeek(BASE);
  const kind = (msg: string) => {
    const n = applyOperations(BASE, plan, [op({ tool: "symptom_check", symptom: msg })]).notes.join(" ");
    if (/crisis line/i.test(n)) return "crisis";
    if (/urgent care/i.test(n)) return "urgent";
    if (/rather say so than invent/i.test(n)) return "refuse";
    return "symptom";
  };

  const CRISIS = ["i feel suicidal", "i keep thinking about suicide", "i want to end it all",
    "i don't want to live anymore", "i've been cutting myself to cope", "i'd be better off dead",
    "i want to kill myself", "i'm going to hurt myself"];
  let missed = "";
  for (const m of CRISIS) if (kind(m) !== "crisis") missed += ` "${m}"->${kind(m)}`;
  check("every way of saying it reaches the crisis line", missed === "", missed);

  const URGENT = ["my chest hurts", "i've been having chest pains", "im having a heart attack",
    "i'm short of breath", "i cant breath", "i'm throwing up blood", "i blacked out",
    "i've been coughing up blood", "i have blood in my stool", "my speech went slurred"];
  let missedU = "";
  for (const m of URGENT) if (kind(m) !== "urgent") missedU += ` "${m}"->${kind(m)}`;
  check("every urgent phrasing reaches urgent care", missedU === "", missedU);

  // Adjacency, not a scattered word set: "blood ... in ... stool" must not fire on prose.
  check("a scattered word set does not fire a red flag",
    kind("my blood test was low and i sat on a stool in the kitchen") !== "urgent");
  // A delighted dieter is not a medical emergency.
  check("losing weight on a weight-loss app is not urgent care",
    kind("i've been losing weight without even trying") !== "urgent");
  check("an unexplained loss still is", kind("i've got unexplained weight loss") === "urgent");
  check("'my heart is set on pizza' is not a palpitation", kind("my heart is set on pizza") !== "urgent");
}

console.log("");
console.log("--- EATING OUT / EXPLAIN (audit regressions) ---");
{
  const plan = freshWeek(BASE);

  // .map() can only replace a slot. Reserving a "snack" on a 3-meal day reserved NOTHING while
  // the note claimed it had set calories aside and made the other meals lighter.
  const snack = applyOperations(BASE, plan, [op({ tool: "eating_out", day: "Friday", mealType: "snack" })]);
  check("eating_out on a slot you don't have says so", /don't have a snack/i.test(snack.notes.join(" ")));
  // NB: assert on the CLAIM ("I've set aside N kcal"), not the words "set aside" — the refusal
  // itself contains them ("nothing for me to set aside there"). The first version of this check
  // failed for that reason: the test was wrong, the engine was right.
  check("eating_out on a missing slot claims no reservation", !/I've set aside/i.test(snack.notes.join(" ")));
  check("eating_out on a missing slot changes nothing", JSON.stringify(snack.plan) === JSON.stringify(plan));

  // A logged meal has no recipe and CANNOT be rescaled. Flooring it at 0.6x understated the day
  // and suppressed the over-target warning on exactly the days that needed it.
  const logged = applyOperations(BASE, plan, [
    op({ tool: "log_meal", day: "Thursday", mealType: "lunch", dish: "takeout pho", loggedCalories: 1200 }),
  ]).plan;
  const out = applyOperations(BASE, logged, [op({ tool: "eating_out", day: "Thursday", mealType: "dinner" })]);
  const thu = out.plan.days.find((d) => d.day === "Thursday")!;
  const total = thu.meals.reduce((s, m) => s + m.calories, 0);
  const warned = /over target/i.test(out.notes.join(" "));
  check("a day pushed over target by a fixed meal is admitted, not reassured",
    total <= BASE.targetCalories * 1.05 || warned, `${total} kcal, warned=${warned}`);

  // explain_meal quoted the recipe card's fiber, not the portion actually served.
  //
  // This used to emit one check PER DISH of a randomly generated week, so the suite's total wobbled
  // between runs (297 one time, 299 the next) and a genuinely deleted test would have hidden in the
  // noise. Worse, `if (claimed) check(...)` meant a dish whose note omitted fiber was silently never
  // checked at all. Two fixed checks now: every quote is right, and enough dishes quoted to prove
  // the first check looked at something.
  {
    let quoted = 0;
    const wrong: string[] = [];
    for (const d of plan.days)
      for (const m of d.meals) {
        const note = applyOperations(BASE, plan, [op({ tool: "explain_meal", day: d.day, mealType: m.type })]).notes.join(" ");
        const claimed = /it carries (\d+)g of fiber/.exec(note)?.[1];
        if (!claimed) continue;
        quoted++;
        if (Number(claimed) !== m.fiberGrams) wrong.push(`${m.name}: said ${claimed}g, served ${m.fiberGrams}g`);
      }
    check("explain_meal quotes the SERVED fiber, never the recipe card's", wrong.length === 0, wrong.slice(0, 3).join("; "));
    check("...and it quoted enough dishes for that to mean something", quoted >= 5, `${quoted} of 21 meals quoted fiber`);
  }

  // Keto is a number on an ingredient, not a tag. dietTagConflicts can't see it.
  const keto: UserProfile = { ...BASE, diet: "keto" };
  const kn = applyOperations(keto, freshWeek(keto), [op({ tool: "substitute_ingredient", ingredient: "rice" })]).notes.join(" ");
  check("a keto user is never offered quinoa for rice", !/quinoa|couscous|brown rice/i.test(kn), kn.slice(0, 80));
}


// ---------------------------------------------------------------- lock_meal
console.log("");
console.log("--- LOCK MEAL (a plan you can't pin isn't yours) ---");
{
  const plan = freshWeek(BASE);
  const pinSunday = applyOperations(BASE, plan, [op({ tool: "lock_meal", day: "Sunday", mealType: "dinner" })]);
  const pinned = plan.days.find((d) => d.day === "Sunday")!.meals.find((m) => m.type === "dinner")!.name;
  const prof = pinSunday.profile;

  check("lock_meal records the pin on the profile", prof.lockedMeals?.[0]?.name === pinned, pinned);
  check("lock_meal doesn't touch this week's plan", JSON.stringify(pinSunday.plan) === JSON.stringify(plan));
  check("lock_meal says what it pinned", new RegExp(`Pinned: ${pinned.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(pinSunday.notes.join(" ")));

  // The whole point: it must come back, every time, and the day must still hit its target.
  let survived = 0, dupes = 0, offTarget = 0;
  const N = 60; // the duplicate showed up 1-in-25; sample enough that a regression can't hide
  for (let i = 0; i < N; i++) {
    const rebuilt = applyOperations(prof, plan, [op({ tool: "regenerate_week" })]).plan;
    const sun = rebuilt.days.find((d) => d.day === "Sunday")!;
    if (sun.meals.find((m) => m.type === "dinner")!.name === pinned) survived++;
    if (rebuilt.days.flatMap((d) => d.meals).filter((m) => m.name === pinned).length > 1) dupes++;
    if (Math.abs(kcal(sun) - BASE.targetCalories) > BASE.targetCalories * 0.15) offTarget++;
  }
  check("a pinned meal survives every rebuild", survived === N, `${survived}/${N}`);
  check("a pinned meal is never served twice in the week", dupes === 0, `${dupes}/${N} weeks had a duplicate`);
  check("the day still hits its calorie target around the pin", offTarget === 0, `${offTarget}/${N} off target`);

  check("a pin survives a budget change", (() => {
    const r = applyOperations(prof, plan, [op({ tool: "update_profile", budget: "low" })]);
    return r.plan.days.find((d) => d.day === "Sunday")!.meals.find((m) => m.type === "dinner")!.name === pinned;
  })());
  check("a pin survives a nutrient boost", (() => {
    const r = applyOperations(prof, plan, [op({ tool: "regenerate_week", boostNutrient: "iron" })]);
    return r.plan.days.find((d) => d.day === "Sunday")!.meals.find((m) => m.type === "dinner")!.name === pinned;
  })());
  check("regenerating another day leaves the pin alone", (() => {
    const r = applyOperations(prof, plan, [op({ tool: "regenerate_day", day: "Monday" })]);
    return r.plan.days.find((d) => d.day === "Sunday")!.meals.find((m) => m.type === "dinner")!.name === pinned;
  })());

  // A pin outranks preferences. It NEVER outranks a hard rule.
  const meaty = RECIPES.find((r) => r.type === "dinner" && !r.dietTags.includes("vegan") && !r.treatOnly)!;
  const meatProf: UserProfile = { ...BASE, lockedMeals: [{ day: "Sunday", mealType: "dinner", name: meaty.name }] };
  const goneVegan = applyOperations(meatProf, plan, [op({ tool: "update_profile", diet: "vegan" })]);
  check("going vegan evicts a meaty pin", (goneVegan.profile.lockedMeals ?? []).length === 0);
  check("...and says why", /couldn't keep .* pinned .* isn't vegan/i.test(goneVegan.notes.join(" ")), goneVegan.notes[0]?.slice(0, 90));
  const veganViolation = goneVegan.plan.days.flatMap((d) => d.meals).filter((m) => {
    const b = recipeByName.get(m.name.toLowerCase());
    return b && !dietOk(b.dietTags, "vegan");
  });
  check("a pin can never smuggle a diet violation into the plan", veganViolation.length === 0, veganViolation[0]?.name ?? "");

  // ...nor an allergen.
  const nutty = RECIPES.find((r) => /peanut/i.test(recipeHay(r)))!;
  if (nutty) {
    const nutProf: UserProfile = { ...BASE, lockedMeals: [{ day: "Sunday", mealType: nutty.type, name: nutty.name }] };
    const allergic = applyOperations(nutProf, plan, [op({ tool: "update_profile", excludeFoods: ["peanuts"] })]);
    check("an allergy evicts a pin that contains it", (allergic.profile.lockedMeals ?? []).length === 0);
    const served = allergic.plan.days.flatMap((d) => d.meals).some((m) => /peanut/i.test(mealHay(m)));
    check("a pin can never smuggle an allergen into the plan", !served);
  }

  // An explicit swap of the pinned slot is a newer, more specific instruction. It wins, loudly.
  const swapped = applyOperations(prof, plan, [op({ tool: "swap_meal", day: "Sunday", mealType: "dinner", dish: "salmon" })]);
  check("an explicit swap of a pinned slot wins", (swapped.profile.lockedMeals ?? []).length === 0);
  check("...and the swap is disclosed, not silent", /was pinned on Sunday/i.test(swapped.notes.join(" ")));

  // Housekeeping.
  check("unlock_meal removes the pin", (applyOperations(prof, plan, [op({ tool: "unlock_meal", day: "Sunday", mealType: "dinner" })]).profile.lockedMeals ?? []).length === 0);
  check("unlock_meal on an unpinned slot says so", /nothing is pinned/i.test(applyOperations(BASE, plan, [op({ tool: "unlock_meal", day: "Monday", mealType: "lunch" })]).notes.join(" ")));
  check("lock_meal on a slot you don't have says so", /don't have a snack/i.test(applyOperations(BASE, plan, [op({ tool: "lock_meal", day: "Monday", mealType: "snack" })]).notes.join(" ")));
  check("lock_meal asks when it doesn't know which meal", /which day/i.test(applyOperations(BASE, plan, [op({ tool: "lock_meal" })]).notes.join(" ")));

  // A meal we can't rebuild from the library can't be pinned — reimposing it would be a lie.
  const withReserve = applyOperations(BASE, plan, [op({ tool: "eating_out", day: "Friday", mealType: "dinner" })]).plan;
  check("you can't pin a restaurant reserve", /isn't one of my recipes/i.test(
    applyOperations(BASE, withReserve, [op({ tool: "lock_meal", day: "Friday", mealType: "dinner" })]).notes.join(" ")));

  // ---- regressions from the pinned-meals audit -----------------------------------------------

  // A pin is a fixed point for EVERY day re-solve, not just for a rebuild. Logging a huge
  // breakfast used to rescale the pinned dinner to its 0.6x floor, and the protein-upgrade lever
  // was free to replace the dish outright.
  const pinMon = applyOperations(BASE, plan, [op({ tool: "lock_meal", day: "Monday", mealType: "dinner" })]).profile;
  const monDinner = plan.days.find((d) => d.day === "Monday")!.meals.find((m) => m.type === "dinner")!;
  const afterLog = applyOperations(pinMon, plan, [
    op({ tool: "log_meal", day: "Monday", mealType: "breakfast", dish: "fry up", loggedCalories: 1400, loggedProtein: 40 }),
  ]).plan.days.find((d) => d.day === "Monday")!.meals.find((m) => m.type === "dinner")!;
  check("logging a huge breakfast doesn't move the pinned dinner",
    afterLog.name === monDinner.name && afterLog.calories === monDinner.calories,
    `${monDinner.name} ${monDinner.calories} -> ${afterLog.name} ${afterLog.calories}`);

  const afterOut = applyOperations(pinMon, plan, [
    op({ tool: "eating_out", day: "Monday", mealType: "lunch", estimatedCalories: 900 }),
  ]).plan.days.find((d) => d.day === "Monday")!.meals.find((m) => m.type === "dinner")!;
  check("eating out at lunch doesn't move the pinned dinner",
    afterOut.name === monDinner.name && afterOut.calories === monDinner.calories);

  // THE BIG ONE. "make Tuesday vegan" was re-imposing a pinned beef bowl using the SAVED profile,
  // so the day came back with the beef AND a chicken dish the rebalancer then upgraded to. A pin
  // may never break a hard rule — including one the user set for a single day.
  const beef = RECIPES.find((r) => r.type === "lunch" && /beef/i.test(r.name) && !r.treatOnly)!;
  const beefPin: UserProfile = { ...BASE, lockedMeals: [{ day: "Tuesday", mealType: "lunch", name: beef.name }] };
  const veganTue = applyOperations(beefPin, plan, [op({ tool: "regenerate_day", day: "Tuesday", diet: "vegan" })]);
  const tue = veganTue.plan.days.find((d) => d.day === "Tuesday")!;
  const notVegan = tue.meals.filter((m) => {
    const b = recipeByName.get(m.name.toLowerCase());
    return b && !dietOk(b.dietTags, "vegan");
  });
  check("a pin cannot break a ONE-DAY diet override", notVegan.length === 0, notVegan.map((m) => m.name).join(", "));
  check("a one-day override skips the pin but keeps it", (veganTue.profile.lockedMeals ?? []).length === 1);
  check("...and says it stepped around the pin", /pinned on Tuesday, but/i.test(veganTue.notes.join(" ")));

  // mealType is optional. Unpinning keyed off op.mealType alone, so a swap without it left the pin
  // in place and reverted on the next rebuild.
  //
  // Which slot "salmon" lands in is the matcher's choice, not ours — it may well be a lunch bowl.
  // So ask the engine first, THEN pin that slot. (Assuming salmon meant dinner made this test fail
  // the moment recipe macros changed; the engine was right and the test was wrong.)
  const probe = applyOperations(BASE, plan, [op({ tool: "swap_meal", day: "Monday", dish: "salmon" })]).plan;
  const monBefore = plan.days.find((d) => d.day === "Monday")!.meals;
  const monAfter = probe.days.find((d) => d.day === "Monday")!.meals;
  const hitSlot = monBefore.find((mm, i) => mm.name !== monAfter[i].name)?.type;
  if (hitSlot) {
    // The contract: a swap unpins ONLY the slot it actually replaced. Where salmon lands is the
    // matcher's call, and pinning a slot can push salmon elsewhere — so assert against where salmon
    // ACTUALLY landed, not where it landed while unpinned. (Asserting the latter flaked: pin the
    // slot, salmon dodges it, the pin correctly survives, and the fixed assumption fails.)
    const monSalmonSlot = (r: ReturnType<typeof applyOperations>) =>
      r.plan.days.find((d) => d.day === "Monday")!.meals.find((m) => /salmon/i.test(m.name))?.type;

    const pinnedThere = applyOperations(BASE, plan, [op({ tool: "lock_meal", day: "Monday", mealType: hitSlot })]).profile;
    const swapNoType = applyOperations(pinnedThere, plan, [op({ tool: "swap_meal", day: "Monday", dish: "salmon" })]);
    const landed = monSalmonSlot(swapNoType);
    const pins = (swapNoType.profile.lockedMeals ?? []).length;
    check("a swap with no mealType unpins exactly the slot it replaced",
      landed === hitSlot ? pins === 0 : pins === 1, `salmon->${landed ?? "?"}, pinned ${hitSlot}`);

    const other = (["breakfast", "lunch", "dinner"] as const).find((t) => t !== hitSlot)!;
    const pinnedElsewhere = applyOperations(BASE, plan, [op({ tool: "lock_meal", day: "Monday", mealType: other })]).profile;
    const r2 = applyOperations(pinnedElsewhere, plan, [op({ tool: "swap_meal", day: "Monday", dish: "salmon" })]);
    const landed2 = monSalmonSlot(r2);
    check("a pin on a slot the swap did not replace survives",
      landed2 === other ? (r2.profile.lockedMeals ?? []).length === 0 : (r2.profile.lockedMeals ?? []).length === 1,
      `salmon->${landed2 ?? "?"}, pinned ${other}`);
  }

  // A pin on a slot the day no longer has is a phantom: never placed, never dropped, never said.
  const P4: UserProfile = { ...BASE, mealsPerDay: 4 };
  const plan4 = freshWeek(P4);
  const snackPin = applyOperations(P4, plan4, [op({ tool: "lock_meal", day: "Monday", mealType: "snack" })]).profile;
  const backTo3 = applyOperations({ ...snackPin, mealsPerDay: 3 }, plan4, [op({ tool: "regenerate_week" })]);
  check("dropping to 3 meals evicts a pinned snack", (backTo3.profile.lockedMeals ?? []).length === 0);
  check("...and says why", /no snack/i.test(backTo3.notes.join(" ")), backTo3.notes.find((n) => /pinned/.test(n))?.slice(0, 80) ?? "");
}


// ---------------------------------------------------------------- undo
console.log("");
console.log("--- UNDO (put it back, and put back exactly what changed) ---");
{
  const plan = freshWeek(BASE);

  // Nothing to undo yet: say so, change nothing.
  const cold = applyOperations(BASE, plan, [op({ tool: "undo" })]);
  check("undo with no history says there's nothing to undo", /nothing to undo/i.test(cold.notes.join(" ")));
  check("...and changes nothing", JSON.stringify(cold.plan) === JSON.stringify(plan) && !cold.planChanged);

  // The plain case: a change, then undo restores it byte for byte.
  const snapshot = { plan, profile: BASE, label: "rebuilt your week" };
  // Regeneration picks at RANDOM among near-tied recipes (`pickRecipe` in recipeDb), so a
  // regenerated week can legitimately come back identical to the one before it. When that happened
  // this control failed AND "undo reports the plan as changed" failed with it — undo genuinely had
  // nothing to change — so the gate went red on a coin flip rather than on a bug, and cost a
  // session's trust in the suite. That is WORKPLAN lesson 1, still live.
  //
  // Retrying a bounded number of times makes the control a statement about the ENGINE instead of
  // about the dice. A genuinely broken regenerate_week still fails, because it fails all 20 times.
  let changed = applyOperations(BASE, plan, [op({ tool: "regenerate_week" })]);
  let regenTries = 1;
  while (JSON.stringify(changed.plan) === JSON.stringify(plan) && regenTries < 20) {
    changed = applyOperations(BASE, plan, [op({ tool: "regenerate_week" })]);
    regenTries++;
  }
  check("regenerate_week really does change the plan (control)",
    JSON.stringify(changed.plan) !== JSON.stringify(plan),
    `regenerations tried: ${regenTries}`);
  const back = applyOperations(changed.profile, changed.plan, [op({ tool: "undo" })], snapshot);
  check("undo restores the exact plan", JSON.stringify(back.plan) === JSON.stringify(plan));
  check("undo names what it reversed", /before I rebuilt your week/i.test(back.notes.join(" ")), back.notes.join(" "));
  check("undo reports the plan as changed", back.planChanged);

  // A pin lives on the PROFILE, not the plan. Undo has to put the profile back too, or the pin
  // survives an undo of the very turn that created it.
  {
    const pinned = applyOperations(BASE, plan, [op({ tool: "lock_meal", day: "Sunday", mealType: "dinner" })]);
    check("lock_meal changes the profile but not the plan (control)", pinned.profileChanged && !pinned.planChanged);
    const snap = { plan, profile: BASE, label: "pinned that meal" };
    const r = applyOperations(pinned.profile, pinned.plan, [op({ tool: "undo" })], snap);
    check("undo removes a pin the last turn added", !r.profile.lockedMeals?.length, JSON.stringify(r.profile.lockedMeals ?? []));
  }

  // Same for a rating, and for a stored body weight. Assigning the restored profile field-by-field
  // would leave anything the last turn ADDED sitting on top of it.
  {
    const rated = applyOperations(BASE, plan, [op({ tool: "rate_meal", day: "Monday", mealType: "breakfast", rating: 1 })]);
    const snap = { plan, profile: BASE, label: "saved that rating" };
    const r = applyOperations(rated.profile, rated.plan, [op({ tool: "undo" })], snap);
    check("undo forgets a rating the last turn added", !r.profile.mealRatings?.length);
  }
  {
    const hydrated = applyOperations(BASE, plan, [op({ tool: "hydration", weightKg: 82 })]);
    const snap = { plan, profile: BASE, label: "saved your weight" };
    const r = applyOperations(hydrated.profile, hydrated.plan, [op({ tool: "undo" })], snap);
    check("undo forgets a body stat the last turn added", r.profile.bodyStats === undefined);
  }

  // undo is not read-only, and it is not idempotent bookkeeping: the caller must forget the
  // snapshot afterwards, which is what `undone` is for.
  check("undo signals that the snapshot is spent", back.undone && !cold.undone);
  check("undo is not a read-only tool", planWasChanged([op({ tool: "undo" })]));

  // planChanged is MEASURED, not inferred from which tools were named. A swap for a dish we don't
  // stock is a no-op, and it used to answer "Done — I updated your plan."
  {
    const noop = applyOperations(BASE, plan, [op({ tool: "swap_meal", day: "Monday", mealType: "breakfast", dish: "unicorn stew" })]);
    check("a swap for a dish we don't have reports the plan as UNCHANGED", !noop.planChanged, noop.notes.join(" ").slice(0, 70));
    check("...even though planWasChanged(ops) would have said otherwise", planWasChanged([op({ tool: "swap_meal", dish: "unicorn stew" })]));
  }
  check("a real swap reports the plan as changed", (() => {
    const real = applyOperations(BASE, plan, [op({ tool: "swap_meal", day: "Monday", mealType: "breakfast", dish: RECIPES.find((r) => r.type === "breakfast")!.name })]);
    return real.planChanged;
  })());

  // describeOperations is what undo says back to the user, so it must describe the OPS, never the
  // model's prose.
  check("describeOperations names a day and a meal", /Monday's breakfast/.test(describeOperations([op({ tool: "swap_meal", day: "Monday", mealType: "breakfast", dish: "x" })])));
  check("describeOperations joins several changes", /and/.test(describeOperations([op({ tool: "regenerate_week" }), op({ tool: "update_profile", budget: "low" })])));
  check("describeOperations ignores pure-query tools", describeOperations([op({ tool: "weekly_report" })]) === "made that change");
  // lock/unlock/rate change the PROFILE, so undo can reverse them — they must get a real label, not
  // the generic fallback, even though they're read-only for the PLAN.
  check("describeOperations names a pin (profile change, undoable)", /pinned/.test(describeOperations([op({ tool: "lock_meal", day: "Sunday", mealType: "dinner" })])));
  check("describeOperations names a rating (profile change, undoable)", /rating/.test(describeOperations([op({ tool: "rate_meal", dish: "x", rating: 5 })])));
}


// ---------------------------------------------------------------- scale_portions
console.log("");
console.log("--- SCALE PORTIONS (the one tool allowed to leave the target, and it must say so) ---");
{
  const plan = freshWeek(BASE);
  const monBefore = kcal(plan.days.find((d) => d.day === "Monday")!);

  const bigger = applyOperations(BASE, plan, [op({ tool: "scale_portions", day: "Monday", portionChange: "bigger" })]);
  const monAfter = kcal(bigger.plan.days.find((d) => d.day === "Monday")!);
  check("scale_portions bigger adds food to the day", monAfter > monBefore, `${monBefore} -> ${monAfter} kcal`);
  check("...and leaves the other days alone", kcal(bigger.plan.days.find((d) => d.day === "Friday")!) === kcal(plan.days.find((d) => d.day === "Friday")!));
  // It reported the WEEK's average after the user resized one DAY: "Monday now averages 2028 kcal"
  // when Monday came to 2201. A number attached to the wrong noun is a wrong number.
  check("...and says what THAT DAY now totals, not the week's average", (() => {
    const note = bigger.notes.join(" ");
    const weekAvg = Math.round(bigger.plan.days.reduce((s, d) => s + kcal(d), 0) / 7);
    return note.includes(String(monAfter)) && !note.includes(String(weekAvg));
  })(), bigger.notes.join(" ").slice(0, 100));
  check("scale_portions changes the plan", planWasChanged([op({ tool: "scale_portions", portionChange: "bigger" })]));

  const smaller = applyOperations(BASE, plan, [op({ tool: "scale_portions", day: "Monday", portionChange: "smaller" })]);
  check("scale_portions smaller takes food away", kcal(smaller.plan.days.find((d) => d.day === "Monday")!) < monBefore);

  // one meal only
  const tueBefore = plan.days.find((d) => d.day === "Tuesday")!;
  const oneMeal = applyOperations(BASE, plan, [op({ tool: "scale_portions", day: "Tuesday", mealType: "dinner", portionChange: "much_bigger" })]);
  const tueAfter = oneMeal.plan.days.find((d) => d.day === "Tuesday")!;
  check("scaling one meal moves only that meal", (() => {
    const changed = tueAfter.meals.filter((m, i) => m.calories !== tueBefore.meals[i].calories);
    return changed.length === 1 && changed[0].type === "dinner";
  })());
  check("...and the ingredient quantities move with it", (() => {
    const b = tueBefore.meals.find((m) => m.type === "dinner")!;
    const a = tueAfter.meals.find((m) => m.type === "dinner")!;
    return JSON.stringify(a.ingredients) !== JSON.stringify(b.ingredients);
  })());

  // The whole week, and the honest advice that goes with it.
  const week = applyOperations(BASE, plan, [op({ tool: "scale_portions", portionChange: "bigger" })]);
  check("scaling the week touches every day", week.plan.days.every((d, i) => kcal(d) > kcal(plan.days[i])));
  check("...and says a lasting change belongs in the targets", /work out my macros/i.test(week.notes.join(" ")));

  // No direction -> ask, don't guess.
  const vague = applyOperations(BASE, plan, [op({ tool: "scale_portions", day: "Monday" })]);
  check("scale_portions with no direction asks", /bigger or smaller/i.test(vague.notes.join(" ")) && JSON.stringify(vague.plan) === JSON.stringify(plan));

  // SAFETY: "much smaller", repeated, must not become a starvation diet one polite step at a time.
  {
    let p: UserProfile = { ...BASE };
    let cur = freshWeek(p);
    let lastNotes: string[] = [];
    for (let i = 0; i < 8; i++) {
      const r = applyOperations(p, cur, [op({ tool: "scale_portions", portionChange: "much_smaller" })]);
      cur = r.plan; p = r.profile; lastNotes = r.notes;
    }
    const worst = Math.min(...cur.days.map(kcal));
    check("no amount of 'much smaller' takes a day under the calorie floor", worst >= 1200, `worst day ${worst} kcal`);
    check("...and it refuses out loud rather than quietly stopping", /1200 kcal|nutrients you need/i.test(lastNotes.join(" ")), lastNotes.join(" ").slice(0, 110));
  }

  // A user whose target already sits near the floor is refused the FIRST time, and told why.
  {
    const lean: UserProfile = { ...BASE, targetCalories: 1300, bodyStats: { sex: "female" } };
    const leanPlan = freshWeek(lean);
    const r = applyOperations(lean, leanPlan, [op({ tool: "scale_portions", portionChange: "much_smaller" })]);
    check("a day already near the floor is not made smaller", JSON.stringify(r.plan) === JSON.stringify(leanPlan));
    check("...and the refusal offers to redo the targets properly", /redo your targets/i.test(r.notes.join(" ")), r.notes.join(" ").slice(0, 110));
  }

  // Portions stay realistic no matter how often you ask.
  {
    const p: UserProfile = { ...BASE };
    let cur = freshWeek(p);
    for (let i = 0; i < 6; i++) cur = applyOperations(p, cur, [op({ tool: "scale_portions", portionChange: "much_bigger" })]).plan;
    const bad = cur.days.flatMap((d) => d.meals).filter((m) => {
      const base = RECIPES.find((r) => r.name === m.name);
      return base && m.calories / base.calories > 1.82;
    });
    check("no amount of 'much bigger' breaks the 1.8x portion clamp (I6)", bad.length === 0, `${bad.length} meals over the clamp`);
    check("...and it says the portions stopped growing", (() => {
      const r = applyOperations(p, cur, [op({ tool: "scale_portions", portionChange: "much_bigger" })]);
      return /as big as a sensible portion goes/i.test(r.notes.join(" "));
    })());
  }

  // A restaurant reserve has no recipe behind it, so there is nothing to divide.
  {
    const out = applyOperations(BASE, plan, [op({ tool: "eating_out", day: "Friday", mealType: "dinner", estimatedCalories: 900 })]);
    const r = applyOperations(out.profile, out.plan, [op({ tool: "scale_portions", day: "Friday", mealType: "dinner", portionChange: "smaller" })]);
    check("a meal with no recipe behind it can't be resized, and we say so", /isn't a recipe|aren't recipes/i.test(r.notes.join(" ")), r.notes.join(" ").slice(0, 110));
  }

  // Resizing a slot that doesn't exist must NOT claim it did something. (A 3-meal plan has no snack.)
  {
    const r = applyOperations(BASE, plan, [op({ tool: "scale_portions", day: "Monday", mealType: "snack", portionChange: "smaller" })]);
    check("scaling a nonexistent meal says so, doesn't claim a change", /nothing to resize/i.test(r.notes.join(" ")) && !/Made Monday snack/i.test(r.notes.join(" ")), r.notes.join(" ").slice(0, 100));
    check("...and leaves the plan untouched", JSON.stringify(r.plan) === JSON.stringify(plan));
  }
}


// ---------------------------------------------------------------- hydration
console.log("");
console.log("--- HYDRATION (the app knew your calories but not your weight) ---");
{
  const plan = freshWeek(BASE);

  // compute_targets used to compute from the body stats and discard them.
  const ct = applyOperations(BASE, plan, [
    op({ tool: "compute_targets", age: 30, heightCm: 180, weightKg: 80, sex: "male", activity: "moderate", goal: "lose_weight" }),
  ]);
  check("compute_targets remembers the body it computed from", ct.profile.bodyStats?.weightKg === 80 && ct.profile.bodyStats?.activity === "moderate");

  // ...so hydration never has to ask twice.
  const h = applyOperations(ct.profile, ct.plan, [op({ tool: "hydration" })]);
  check("hydration uses the stored weight without asking", !/how much do you weigh/i.test(h.notes.join(" ")));
  check("hydration is read-only", !planWasChanged([op({ tool: "hydration" })]) && JSON.stringify(h.plan) === JSON.stringify(ct.plan));

  // 80kg * 35 = 2800, +500 (moderate) = 3300 total, drinks = 80% = 2640 -> 2650 to a tidy 50.
  const t = hydrationTarget(80, "moderate");
  check("hydration: 35 mL/kg + a training allowance", t.totalMl === 3300, `${t.totalMl} mL`);
  check("hydration: the DRINKS target nets off the water in food", t.drinksMl === 2650, `${t.drinksMl} mL`);
  check("hydration quotes a band, not false precision", t.lowMl < t.drinksMl && t.drinksMl < t.highMl, `${t.lowMl}-${t.highMl}`);
  check("hydration scales with body weight", hydrationTarget(60, "sedentary").drinksMl < hydrationTarget(100, "sedentary").drinksMl);
  check("hydration scales with training", hydrationTarget(80, "sedentary").drinksMl < hydrationTarget(80, "very_active").drinksMl);
  check("a sedentary person gets no sweat allowance", hydrationTarget(80, "sedentary").activityMl === 0);
  check("the note states the litres the engine computed", /2\.6|2\.7/.test(h.notes.join(" ")), h.notes.join(" ").slice(0, 90));

  // With no stored weight, it asks rather than guessing one — the compute_targets rule.
  const cold = applyOperations(BASE, plan, [op({ tool: "hydration" })]);
  check("hydration asks for a weight rather than guessing one", /how much do you weigh/i.test(cold.notes.join(" ")));
  check("...and stores nothing when it doesn't know", !cold.profile.bodyStats);

  // The user can supply the weight in the message itself.
  const inline = applyOperations(BASE, plan, [op({ tool: "hydration", weightKg: 70 })]);
  check("hydration takes a weight given in the message", !/how much do you weigh/i.test(inline.notes.join(" ")));
  check("...remembers it, so it never asks again", inline.profile.bodyStats?.weightKg === 70);
  check("...and never invents the facts it wasn't given", inline.profile.bodyStats?.age === undefined && inline.profile.bodyStats?.heightCm === undefined);
  check("...and says it assumed a sedentary baseline", /assumed you're not training much/i.test(inline.notes.join(" ")));

  // A known-active user is not told the sedentary caveat.
  const active = applyOperations(BASE, plan, [op({ tool: "hydration", weightKg: 70, activity: "active" })]);
  check("no sedentary caveat when the activity is known", !/assumed you're not training much/i.test(active.notes.join(" ")));
  check("an active user is warned that hot days need more", /drink to thirst/i.test(active.notes.join(" ")));
}


// ---------------------------------------------------------------- rate_meal
console.log("");
console.log("--- RATE MEAL (it learns what you like, and never starves you for it) ---");
{
  const plan = freshWeek(BASE);
  const monBreakfast = plan.days.find((d) => d.day === "Monday")!.meals.find((m) => m.type === "breakfast")!.name;

  // --- resolution
  const bySlot = applyOperations(BASE, plan, [op({ tool: "rate_meal", day: "Monday", mealType: "breakfast", rating: 5 })]);
  check("rate_meal resolves the dish from day + mealType", bySlot.profile.mealRatings?.[0]?.name === monBreakfast, monBreakfast);
  check("rate_meal stores the rating", bySlot.profile.mealRatings?.[0]?.rating === 5);
  check("rate_meal never touches the week on screen", JSON.stringify(bySlot.plan) === JSON.stringify(plan));
  check("rate_meal is a read-only tool", !planWasChanged([op({ tool: "rate_meal", rating: 5 })]));

  const byName = applyOperations(BASE, plan, [op({ tool: "rate_meal", dish: RECIPES[0].name, rating: 4 })]);
  check("rate_meal resolves the dish by name", byName.profile.mealRatings?.[0]?.name === RECIPES[0].name);

  check("rate_meal with no rating asks for one", (() => {
    const r = applyOperations(BASE, plan, [op({ tool: "rate_meal", day: "Monday", mealType: "breakfast" })]);
    return !r.profile.mealRatings?.length && /1 to 5/i.test(r.notes.join(" "));
  })());
  check("rate_meal on a dish we don't have asks which meal", (() => {
    const r = applyOperations(BASE, plan, [op({ tool: "rate_meal", dish: "my nan's hotpot", rating: 5 })]);
    return !r.profile.mealRatings?.length && /which day/i.test(r.notes.join(" "));
  })());
  check("re-rating a dish replaces the old rating, never duplicates it", (() => {
    const once = applyOperations(BASE, plan, [op({ tool: "rate_meal", dish: monBreakfast, rating: 1 })]).profile;
    const twice = applyOperations(once, plan, [op({ tool: "rate_meal", dish: monBreakfast, rating: 5 })]).profile;
    return twice.mealRatings?.length === 1 && twice.mealRatings[0].rating === 5;
  })());

  // --- a 1-star dish disappears from future weeks
  const banned = applyOperations(BASE, plan, [op({ tool: "rate_meal", dish: monBreakfast, rating: 1 })]).profile;
  let servedBanned = 0;
  const N = 25;
  for (let i = 0; i < N; i++) {
    const wk = freshWeek(banned);
    if (wk.days.flatMap((d) => d.meals).some((m) => m.name === monBreakfast)) servedBanned++;
  }
  check("a 1-star dish is never planned again", servedBanned === 0, `${servedBanned}/${N} weeks still served it`);

  // --- ...but a rating is a PREFERENCE. It can never leave a slot empty.
  // One-star EVERY breakfast in the library and the user must still get seven breakfasts.
  const hatesBreakfast: UserProfile = {
    ...BASE,
    mealRatings: RECIPES.filter((r) => r.type === "breakfast").map((r) => ({ name: r.name, rating: 1 as const })),
  };
  const desperate = freshWeek(hatesBreakfast);
  const breakfasts = desperate.days.filter((d) => d.meals.some((m) => m.type === "breakfast")).length;
  check("one-starring every breakfast still yields seven breakfasts", breakfasts === 7, `${breakfasts}/7`);
  check("...and the week discloses that it reused a dish you rejected", (() => {
    const rep = newReport();
    rebalanceWeek(selectWeekFromDb(hatesBreakfast, undefined, undefined, undefined, undefined, rep), hatesBreakfast);
    return rep.servedBannedDish && /didn't want/i.test(reportNotes(rep, hatesBreakfast).join(" "));
  })());

  // --- a 5-star dish gets served
  const lovedName = RECIPES.find((r) => r.type === "dinner" && r.dietTags.length === 0)?.name
    ?? RECIPES.find((r) => r.type === "dinner")!.name;
  const loves: UserProfile = { ...BASE, mealRatings: [{ name: lovedName, rating: 5 }] };
  let servedLoved = 0;
  for (let i = 0; i < N; i++) if (freshWeek(loves).days.flatMap((d) => d.meals).some((m) => m.name === lovedName)) servedLoved++;
  check("a 5-star dish shows up in the week", servedLoved === N, `${servedLoved}/${N} weeks served it`);

  // --- a rating is a preference, so it NEVER beats a hard rule.
  // A vegan who adores a beef dish is not served beef. Ever.
  const beef = RECIPES.find((r) => r.mainProtein === "beef")!;
  const veganLovesBeef: UserProfile = { ...BASE, diet: "vegan", mealRatings: [{ name: beef.name, rating: 5 }] };
  let beefServed = 0;
  for (let i = 0; i < N; i++) if (freshWeek(veganLovesBeef).days.flatMap((d) => d.meals).some((m) => m.name === beef.name)) beefServed++;
  check("a 5-star rating never overrides the diet", beefServed === 0, `${beef.name} served ${beefServed}/${N} weeks to a vegan`);

  // An allergen the user loves is still an allergen.
  const eggy = RECIPES.find((r) => r.ingredients.some((i) => /^eggs?$/i.test(i.name.trim())))!;
  const allergicLovesEggs: UserProfile = { ...BASE, allergies: "eggs", mealRatings: [{ name: eggy.name, rating: 5 }] };
  let eggServed = 0;
  for (let i = 0; i < N; i++) if (freshWeek(allergicLovesEggs).days.flatMap((d) => d.meals).some((m) => m.name === eggy.name)) eggServed++;
  check("a 5-star rating never overrides an allergy", eggServed === 0, `${eggy.name} served ${eggServed}/${N} weeks`);

  // --- a pin outranks a rating: the user pinned it, then said they disliked it. The pin wins,
  // because it is the more specific and more recent instruction about THAT slot.
  check("a pinned dish survives being rated 1", (() => {
    const pinned = applyOperations(BASE, plan, [op({ tool: "lock_meal", day: "Sunday", mealType: "dinner" })]).profile;
    const dish = pinned.lockedMeals![0].name;
    const rated = applyOperations(pinned, plan, [op({ tool: "rate_meal", dish, rating: 1 })]).profile;
    const wk = applyOperations(rated, plan, [op({ tool: "regenerate_week" })]).plan;
    return wk.days.find((d) => d.day === "Sunday")!.meals.find((m) => m.type === "dinner")!.name === dish;
  })());

  // --- ratings persist across a rebuild (they live on the profile, not the plan)
  check("ratings survive regenerate_week", (() => {
    const r = applyOperations(banned, plan, [op({ tool: "regenerate_week" })]);
    return r.profile.mealRatings?.length === 1;
  })());

  // --- the ban has to hold on EVERY path that puts a recipe into a plan, not just the day
  // selector. The protein rebalancer leaked (5/25 weeks) until it was patched. These two cover the
  // other two paths, and each first proves the dish WOULD appear unbanned — otherwise the test
  // could pass by testing nothing.
  {
    // The dish the iron boost most wants. It must be ranked the way upgradeForNutrient ranks —
    // ABSOLUTE iron, not iron per calorie. Ranking by density picked a dish the boost never
    // reaches for, and the ban test below passed while testing nothing. That is what the control
    // is here to catch, and it did.
    const ironiest = RECIPES
      .filter((r) => r.type === "dinner" && !r.treatOnly && r.timeMinutes <= BASE.maxCookTime)
      .sort((a, b) => recipeMicros(b).micros.iron - recipeMicros(a).micros.iron)[0];

    const boosted = (p: UserProfile) =>
      applyOperations(p, freshWeek(p), [op({ tool: "regenerate_week", boostNutrient: "iron" })])
        .plan.days.flatMap((d) => d.meals).some((m) => m.name === ironiest.name);

    let unbanned = 0;
    for (let i = 0; i < 8; i++) if (boosted(BASE)) unbanned++;
    check("(control) an iron boost does reach for the iron-richest dinner", unbanned > 0, `${unbanned}/8 — ${ironiest.name}`);

    const hates: UserProfile = { ...BASE, mealRatings: [{ name: ironiest.name, rating: 1 }] };
    let served = 0;
    for (let i = 0; i < 8; i++) if (boosted(hates)) served++;
    check("a 1-star dish never returns via a nutrient boost", served === 0, `${ironiest.name} served ${served}/8`);
  }
  {
    // An ingredient that only ONE recipe uses: banning that recipe means the fridge guarantee and
    // the ban are in direct conflict. The guarantee wins — the user asked for it today — and the
    // engine says so rather than quietly serving a dish they rejected.
    const counts = new Map<string, string[]>();
    for (const r of RECIPES)
      for (const i of r.ingredients) {
        const k = i.name.trim().toLowerCase();
        if (!counts.has(k)) counts.set(k, []);
        if (!counts.get(k)!.includes(r.name)) counts.get(k)!.push(r.name);
      }
    const solo = [...counts.entries()].find(([, rs]) => rs.length === 1);
    if (solo) {
      const [ingredient, [onlyDish]] = solo;
      const hates: UserProfile = { ...BASE, mealRatings: [{ name: onlyDish, rating: 1 }] };
      const r = applyOperations(hates, freshWeek(hates), [
        op({ tool: "regenerate_week", useIngredients: [ingredient] }),
      ]);
      const used = r.plan.days.flatMap((d) => d.meals).some((m) => m.name === onlyDish);
      const note = r.notes.join(" ");
      check(
        "the fridge guarantee outranks a 1-star, and discloses that it did",
        used && /rated poorly/i.test(note),
        `${ingredient} -> ${onlyDish}; used=${used}`,
      );
    }
  }

  // --- the nastiest combination: the diet already narrows the library to a handful of dishes per
  // slot, and then the user one-stars nearly all of them. The week must still be a week, and every
  // meal in it must still be vegan.
  check("a vegan who one-stars almost everything still gets a full, vegan week", (() => {
    const veganDishes = RECIPES.filter((r) => r.dietTags.includes("vegan"));
    // Leave exactly one dinner un-banned; ban every other vegan dish in the library.
    const spare = veganDishes.find((r) => r.type === "dinner")!;
    const hostile: UserProfile = {
      ...BASE,
      diet: "vegan",
      mealRatings: veganDishes.filter((r) => r.name !== spare.name).map((r) => ({ name: r.name, rating: 1 as const })),
    };
    for (let i = 0; i < 10; i++) {
      const wk = freshWeek(hostile);
      if (wk.days.length !== 7) return false;
      for (const d of wk.days) {
        if (d.meals.length !== hostile.mealsPerDay) return false;
        for (const m of d.meals) {
          const base = RECIPES.find((r) => r.name === m.name);
          if (!base || !base.dietTags.includes("vegan")) return false; // a ban must never break the diet
        }
      }
    }
    return true;
  })());

  // --- the note tells the truth about what's still coming
  check("a low rating names the days the dish is still on", (() => {
    const dinner = plan.days.find((d) => d.day === "Tuesday")!.meals.find((m) => m.type === "dinner")!.name;
    const elsewhere = plan.days.filter((d) => d.meals.some((m) => m.name === dinner)).map((d) => d.day);
    const r = applyOperations(BASE, plan, [op({ tool: "rate_meal", dish: dinner, rating: 2 })]);
    const note = r.notes.join(" ");
    return elsewhere.every((d) => note.includes(d)) && /still on your/.test(note);
  })());
  check("a 5-star note doesn't threaten to swap anything", (() => {
    const r = applyOperations(BASE, plan, [op({ tool: "rate_meal", day: "Monday", mealType: "breakfast", rating: 5 })]);
    return !/swap/i.test(r.notes.join(" ")) && /more often/i.test(r.notes.join(" "));
  })());
}


// ---------------------------------------------------------------- library capability
console.log("");
console.log("--- RECIPE LIBRARY: can it actually serve each diet? ---");
{
  // The engine reported a 50g protein shortfall to every vegan, every week — honestly, and
  // uselessly. The gap was in the food, not the solver: the vegan recipes leaned on lentils and
  // chickpeas (~0.07g protein per kcal) while tofu, tempeh, edamame and protein powder sat unused
  // in the same USDA table. This asserts the library can still feed each diet.
  const meanProtein = (diet: UserProfile["diet"], runs = 6) => {
    const prof: UserProfile = { ...BASE, diet };
    let sum = 0;
    for (let i = 0; i < runs; i++) {
      const wk = freshWeek(prof);
      sum += wk.days.reduce((s, d) => s + prot(d), 0) / wk.days.length;
    }
    return sum / runs;
  };
  const targets: [UserProfile["diet"], number][] = [["none", 145], ["vegetarian", 130], ["vegan", 120]];
  for (const [diet, floor] of targets) {
    const got = meanProtein(diet);
    check(`a ${diet} week reaches ${floor}g protein`, got >= floor, `${Math.round(got)}g against a ${BASE.proteinGrams}g target`);
  }

  // A diet is a claim about MACROS, not just a filter on recipes. Keto was only honouring the
  // filter: the user kept their onboarding carb target (200g) and the solver scaled toward it.
  // Keto is judged on NET carbs — total minus fiber, because fiber isn't absorbed.
  {
    const K: UserProfile = { ...BASE, diet: "keto" };
    let worstNet = 0;
    for (let i = 0; i < 6; i++)
      for (const d of freshWeek(K).days) {
        const net = d.meals.reduce((s, m) => s + m.carbsGrams, 0) - d.meals.reduce((s, m) => s + (m.fiberGrams ?? 0), 0);
        worstNet = Math.max(worstNet, net);
      }
    check("a keto week stays under 50g net carbs, every day", worstNet <= 50, `worst day ${Math.round(worstNet)}g net`);

    const note = applyOperations(K, freshWeek(K), [op({ tool: "weekly_report" })]).notes.join(" ");
    check("weekly_report tells a keto user their NET carbs", /net carbs .* average \d+g/i.test(note), note.slice(0, 90));
    const plainNote = applyOperations(BASE, freshWeek(BASE), [op({ tool: "weekly_report" })]).notes.join(" ");
    check("...and doesn't mention net carbs to anyone else", !/net carbs/i.test(plainNote));
  }

  // Every diet needs enough recipes to fill a week without repeating a dish.
  for (const diet of ["vegan", "vegetarian", "keto", "mediterranean"] as const) {
    for (const type of ["breakfast", "lunch", "dinner"] as const) {
      const n = RECIPES.filter((r) => !r.treatOnly && r.type === type && dietOk(r.dietTags, diet)).length;
      check(`${diet}: at least 7 ${type}s so a week never repeats`, n >= 7, `${n} available`);
    }
  }
}

// ---------------------------------------------------------------- recipe import (Phase 2)
console.log("");
console.log("--- RECIPE IMPORT (paste a link -> plan-ready meal, deterministic) ---");
{
  // SSRF guard: this fetches a URL the user pasted, so it must refuse local/private hosts.
  check("import: allows a public https recipe url", isSafePublicUrl("https://www.bbcgoodfood.com/recipes/x"));
  check("import: blocks localhost", !isSafePublicUrl("http://localhost:3000/secret"));
  check("import: blocks loopback IP", !isSafePublicUrl("http://127.0.0.1/x"));
  check("import: blocks private ranges", !isSafePublicUrl("http://192.168.1.1/x") && !isSafePublicUrl("http://10.0.0.5/x") && !isSafePublicUrl("http://169.254.1.1/x"));
  check("import: blocks non-http schemes", !isSafePublicUrl("ftp://example.com/x") && !isSafePublicUrl("file:///etc/passwd"));
  // Extra SSRF bypass classes closed 2026-09-03.
  check("import: blocks a bare internal hostname (no dot)", !isSafePublicUrl("http://metadata/latest") && !isSafePublicUrl("http://intranet/"));
  check("import: blocks 0.0.0.0/8 and CGNAT", !isSafePublicUrl("http://0.0.0.1/x") && !isSafePublicUrl("http://100.64.0.1/x"));
  check("import: blocks the .internal TLD", !isSafePublicUrl("http://foo.internal/x"));
  check("import: blocks a decimal-encoded loopback IP", !isSafePublicUrl("http://2130706433/")); // 127.0.0.1
  // ...without over-blocking ordinary public recipe domains.
  check("import: still allows ordinary public recipe URLs", isSafePublicUrl("https://www.seriouseats.com/recipe") && isSafePublicUrl("http://cooking.nytimes.com/x"));
  // A trailing dot (the DNS root label) resolves to the SAME internal host but slipped every
  // named-host rule (not === "localhost", no .endsWith(".internal"), still contains a ".").
  check("import: blocks trailing-dot internal hosts", !isSafePublicUrl("http://localhost./") &&
    !isSafePublicUrl("http://metadata.google.internal./latest") && !isSafePublicUrl("http://intranet./") &&
    !isSafePublicUrl("http://svc.local./"));
  check("import: a trailing dot on a PUBLIC fqdn is still allowed", isSafePublicUrl("https://www.seriouseats.com./recipe"));

  // decodeEntities must never crash on a malformed numeric entity. An out-of-range code point used
  // to throw a RangeError that surfaced as a 500 on the import route; it is now left literal.
  check("import: decodeEntities decodes valid hex + decimal numeric entities",
    decodeEntities("&#x63;af&#233;") === "café");
  check("import: an out-of-range numeric entity is left literal, not thrown on",
    decodeEntities("x &#99999999; &#x110000; y") === "x &#99999999; &#x110000; y");

  // Ingredient parsing: quantity vs name, units, fractions, and the no-quantity case.
  check("import: parses '2 tbsp cumin seeds'", (() => { const p = parseIngredient("2 tbsp cumin seeds"); return p.quantity === "2 tbsp" && p.name === "cumin seeds"; })());
  check("import: parses a unicode fraction '¼ cup olive oil'", (() => { const p = parseIngredient("¼ cup olive oil"); return /¼/.test(p.quantity) && p.name === "olive oil"; })());
  check("import: an ingredient with no amount keeps its whole name", (() => { const p = parseIngredient("salt to taste"); return p.quantity === "" && p.name === "salt to taste"; })());
  // Dual-unit ingredients (metric + imperial): the alt measure folds into the quantity, not the name.
  check("import: folds a dual-unit '1.2 kg / 2.4lb chuck beef'", (() => { const p = parseIngredient("1.2 kg / 2.4lb chuck beef"); return p.name === "chuck beef" && /kg/.test(p.quantity) && /2\.4lb/.test(p.quantity); })());
  // ...but a normal fraction quantity ("1/2 cup") must NOT be mistaken for a dual unit.
  check("import: a '1/2 cup' fraction is not treated as a dual unit", (() => { const p = parseIngredient("1/2 cup olive oil"); return p.name === "olive oil" && /cup/.test(p.quantity); })());

  // The pure parse: JSON-LD (with @graph nesting + HTML entities + per-serving nutrition) -> recipe.
  const HTML = `<html><head>
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[
      {"@type":"WebPage","name":"page"},
      {"@type":"Recipe","name":"Smoky &amp; Spiced Chili","recipeYield":"4 servings",
       "recipeIngredient":["2 tbsp cumin seeds","&frac14; cup olive oil","1 onion, chopped"],
       "recipeInstructions":[{"@type":"HowToStep","text":"Toast the spices."},{"@type":"HowToStep","text":"Simmer 30 min."}],
       "totalTime":"PT1H30M",
       "nutrition":{"@type":"NutritionInformation","calories":"463 kcal","proteinContent":"46 g","carbohydrateContent":"12 g","fatContent":"24 g","fiberContent":"5 g"}}
    ]}</script></head><body></body></html>`;
  const r = parseRecipeHtml(HTML, "https://example.com/chili");
  check("import: extracts the Recipe from @graph", r.name === "Smoky & Spiced Chili", r.name);
  check("import: reads servings", r.servings === 4, String(r.servings));
  check("import: parses per-serving macros from the site", r.calories === 463 && r.proteinGrams === 46 && r.fiberGrams === 5, JSON.stringify({ c: r.calories, p: r.proteinGrams }));
  check("import: macrosSource is 'site' when nutrition is present", r.macrosSource === "site");
  check("import: parses ISO-8601 totalTime PT1H30M -> 90", r.timeMinutes === 90, String(r.timeMinutes));
  check("import: keeps all ingredients", r.ingredients.length === 3);
  check("import: reads the steps", r.steps.length === 2 && /toast the spices/i.test(r.steps[0]));

  // -> a valid Meal (timeMinutes is required by the schema; macros carry through).
  const meal = importedToMeal(r, "dinner");
  check("import->meal: valid shape with required timeMinutes", meal.type === "dinner" && meal.calories === 463 && typeof meal.timeMinutes === "number");
  // It must satisfy the real MealSchema so it survives every engine round-trip (rate, swap, undo),
  // and it must carry the source link so the drawer can offer "view original".
  check("import->meal: passes MealSchema", MealSchema.safeParse(meal).success);
  check("import->meal: carries the sourceUrl back to the origin", meal.sourceUrl === "https://example.com/chili");

  // Yoast SEO (a huge share of recipe blogs) emits an UNQUOTED type attribute and nests the Recipe
  // in an @graph alongside empty-array members. Requiring quotes skipped every such site (found live
  // on loveandlemons.com). This is the exact shape, minified.
  const YOAST = `<html><head><script type=application/ld+json class=yoast-schema-graph>{"@context":"https://schema.org","@graph":[{"@type":"Article","@id":"x"},[],{"@type":"Recipe","name":"BEST Hummus","recipeYield":"6","recipeIngredient":["1 can chickpeas","2 tbsp tahini"],"recipeInstructions":[{"@type":"HowToStep","text":"Blend."}],"nutrition":{"@type":"NutritionInformation","calories":"120 calories"}}]}</script></head><body></body></html>`;
  const y = parseRecipeHtml(YOAST, "https://www.loveandlemons.com/hummus-recipe/");
  check("import: reads an UNQUOTED Yoast type=application/ld+json tag", y.name === "BEST Hummus" && y.ingredients.length === 2 && y.calories === 120, JSON.stringify({ n: y.name, i: y.ingredients.length, c: y.calories }));

  // No nutrition on the page -> no macros, never guessed; still importable.
  const noNut = parseRecipeHtml(HTML.replace(/,\s*"nutrition":\{[^}]*\}/, ""), "https://example.com/x");
  check("import: no site nutrition -> macrosSource 'none', macros default to 0 in the meal", noNut.macrosSource === "none" && importedToMeal(noNut, "lunch").calories === 0);

  // A page with no recipe throws a user-facing message (not a crash).
  let threw = false;
  try { parseRecipeHtml("<html><body>just a blog post</body></html>", "https://example.com/x"); } catch { threw = true; }
  check("import: a page with no recipe throws a clear error", threw);
}

console.log("--- GROCERY AISLES (shop in one walk, not criss-crossing) ---");
{
  const cases: [string, string][] = [
    ["Chicken breast", "Meat & Fish"],
    ["Salmon fillet", "Meat & Fish"],
    ["Greek yogurt", "Dairy & Eggs"],
    ["Eggs", "Dairy & Eggs"],
    ["Eggplant", "Produce"], // must NOT read "egg"
    ["Spinach", "Produce"],
    ["Bell pepper", "Produce"],
    ["Black pepper", "Pantry"], // must NOT read as a bell "pepper"
    ["Sourdough bread", "Bakery"],
    ["Olive oil", "Pantry"],
    ["Brown rice", "Pantry"],
    ["Chickpeas", "Pantry"], // must NOT read as fresh "peas"
    ["Frozen berries", "Frozen"], // frozen wins over "berries"
    ["Peanut butter", "Pantry"], // must NOT read as dairy "butter"
    ["Almond butter", "Pantry"],
    ["Coconut milk", "Pantry"], // must NOT read as dairy "milk"
    ["Oat milk", "Pantry"],
    ["Chicken stock", "Pantry"], // must NOT read as "chicken" (meat)
    ["Vegetable broth", "Pantry"],
    ["Egg noodles", "Pantry"], // must NOT read as "egg" (dairy)
    ["Unicorn dust", "Other"],
  ];
  for (const [name, want] of cases) check(`aisle: ${name} -> ${want}`, aisleFor(name) === want, aisleFor(name));

  // Grouping keeps every item and lays aisles out in shopping order.
  const items = [
    { name: "Chicken breast", price: 3 },
    { name: "Spinach", price: 1 },
    { name: "Brown rice", price: 1 },
    { name: "Eggs", price: 2 },
  ];
  const groups = groupByAisle(items);
  check("grocery: grouping loses no items", groups.reduce((s, g) => s + g.items.length, 0) === items.length);
  check("grocery: aisles appear in shopping order", groups.map((g) => g.aisle).every((a, i, arr) => i === 0 || AISLE_ORDER.indexOf(arr[i - 1]) < AISLE_ORDER.indexOf(a)));
  check("grocery: an empty list yields no groups", groupByAisle([]).length === 0);
}

console.log("--- STREAK (daily-use habit hook) ---");
{
  check("streak: prevDay steps back one day", prevDay("2026-03-01") === "2026-02-28");
  check("streak: prevDay crosses a year boundary", prevDay("2026-01-01") === "2025-12-31");
  check("streak: isoDay formats a LOCAL day", isoDay(new Date(2026, 7, 4)) === "2026-08-04");
  // Regression: the key is the LOCAL calendar day, so a late-evening open counts on today — not
  // tomorrow's UTC day, which used to break/inflate streaks for users west of UTC.
  check("streak: a late local evening still keys to that local day", isoDay(new Date(2026, 7, 4, 23, 30)) === "2026-08-04");

  const today = "2026-08-04";
  check("streak: today alone is 1", currentStreak([today], today) === 1);
  check("streak: three consecutive days is 3", currentStreak(["2026-08-04", "2026-08-03", "2026-08-02"], today) === 3);
  check("streak: a gap breaks it", currentStreak(["2026-08-04", "2026-08-03", "2026-08-01"], today) === 2);
  check("streak: 0 when today isn't recorded", currentStreak(["2026-08-03", "2026-08-02"], today) === 0);
  check("streak: unordered history still counts", currentStreak(["2026-08-02", "2026-08-04", "2026-08-03"], today) === 3);
  check("streak: empty history is 0", currentStreak([], today) === 0);
  check("streak: duplicates don't inflate it", currentStreak(["2026-08-04", "2026-08-04", "2026-08-03"], today) === 2);
}

console.log("--- VIDEO IMPORT (Phase 2: read a recipe from a reel's caption) ---");
{
  // Platform routing: a video link goes to the model-extraction path; a recipe page stays on JSON-LD.
  check("video: detects YouTube (watch, youtu.be, m.)", videoPlatform("https://www.youtube.com/watch?v=abc") === "youtube" && videoPlatform("https://youtu.be/abc") === "youtube" && videoPlatform("https://m.youtube.com/watch?v=abc") === "youtube");
  check("video: detects TikTok", videoPlatform("https://www.tiktok.com/@chef/video/123") === "tiktok");
  check("video: detects Instagram reels", videoPlatform("https://www.instagram.com/reel/abc/") === "instagram");
  check("video: a recipe PAGE is not a video (routes to JSON-LD)", videoPlatform("https://www.bbcgoodfood.com/recipes/x") === null);
  check("video: junk is not a video", videoPlatform("not a url") === null);

  // Caption extraction is pure/fixture-tested (the model step is not — it's exercised live).
  const tt = `<html><head><meta property="og:description" content="Easy 3-ingredient pasta! You need 200g spaghetti, 2 tbsp olive oil &amp; garlic. Boil, toss, done."></head></html>`;
  const ttText = extractVideoText(tt, "tiktok");
  check("video: reads the caption from og:description (entities decoded)", /200g spaghetti/.test(ttText) && /olive oil & garlic/.test(ttText));

  // YouTube: the FULL description ("shortDescription") must beat the truncated og:description.
  const yt = `<html><head><meta property="og:description" content="short"></head><body><script>var x={"shortDescription":"FULL RECIPE:\\nIngredients:\\n- 2 eggs\\n- 100g flour\\nMethod: mix and fry."};</script></body></html>`;
  const ytText = extractVideoText(yt, "youtube");
  check("video: prefers YouTube's full shortDescription over the short og", /FULL RECIPE/.test(ytText) && /100g flour/.test(ytText) && ytText.length > 20);
  check("video: a caption with no meta yields empty text (-> graceful 'no recipe')", extractVideoText("<html><body>nothing here</body></html>", "instagram") === "");
}


// ---------------------------------------------------------------- DIRECT MANIPULATION (Track E)
// previewOperations and swapCandidates back every control in the direct-manipulation layer
// (docs/v1/05-direct-manipulation.md). They shipped covered only through the HTTP route, which
// tests the wiring rather than the promise; these test the promise. Both are pure, which is why
// they belong here rather than in test:api.
{
  const dmProfile: UserProfile = { ...BASE };
  const dmWeek = rebalanceWeek(selectWeekFromDb(dmProfile), dmProfile);
  const dmDay = dmWeek.days[0].day;
  const dmSlot = dmWeek.days[0].meals[0].type;
  const dmDayKcal = dmWeek.days[0].meals.reduce((t, m) => t + m.calories, 0);

  // --- previewOperations: the confirm-before-commit contract ------------------------------------
  // The whole feature rests on one property: looking must not change anything. A preview that
  // mutated the plan it was handed would corrupt the week by being DISPLAYED.
  const planJson = JSON.stringify(dmWeek);
  const profJson = JSON.stringify(dmProfile);
  const pv = previewOperations(dmProfile, dmWeek, [{ tool: "regenerate_day", day: dmDay }]);
  check("preview: does not mutate the plan it was given", JSON.stringify(dmWeek) === planJson);
  check("preview: does not mutate the profile it was given", JSON.stringify(dmProfile) === profJson);
  check("preview: reports one row per day", pv.days.length === dmWeek.days.length);
  check("preview: says whether the plan would change", typeof pv.wouldChangePlan === "boolean");
  check("preview: carries each day\u2019s calorie target so no caller does the arithmetic",
    pv.days.every((d) => d.targetKcal > 0));

  // Seeded on purpose: a preview that disagreed with itself between two renders is worse than none.
  const pvAgain = previewOperations(dmProfile, dmWeek, [{ tool: "regenerate_day", day: dmDay }]);
  check("preview: is reproducible \u2014 same input, same answer",
    JSON.stringify(pv.days) === JSON.stringify(pvAgain.days));

  // The delta must describe the CHANGE, not the absolute week; moves must be real moves.
  const pvDay = pv.days.find((d) => d.day === dmDay);
  check("preview: the changed day\u2019s delta is the difference it would make",
    !!pvDay && pvDay.deltaKcal === pvDay.kcal - dmDayKcal);
  check("preview: every move names a from and a to that differ",
    pv.moves.every((m) => m.from && m.to && m.from !== m.to));

  // A preview of a refusal must still describe it, because the sheet shows these notes BEFORE
  // committing \u2014 which is the point of previewing at all.
  const pvRefuse = previewOperations({ ...dmProfile, diet: "vegan" }, dmWeek, [
    { tool: "swap_meal", day: dmDay, mealType: dmSlot, dish: "Chicken & Vegetable Stir-Fry with Rice" },
  ]);
  check("preview: a refusal is reported in the preview, not discovered after committing",
    pvRefuse.notes.length > 0);

  // And the simulation must agree with committing the same thing, or the preview lies.
  const pvRebal = previewOperations(dmProfile, dmWeek, [{ tool: "rebalance_day", day: dmDay }]);
  const committed = withSeed(0x9e3d, () =>
    applyOperations(structuredClone(dmProfile), structuredClone(dmWeek), [
      { tool: "rebalance_day", day: dmDay },
    ]),
  );
  const committedKcal = committed.plan.days
    .find((d) => d.day === dmDay)!
    .meals.reduce((t, m) => t + m.calories, 0);
  check("preview: matches what committing the same operation produces",
    pvRebal.days.find((d) => d.day === dmDay)!.kcal === committedKcal,
    `preview ${pvRebal.days.find((d) => d.day === dmDay)!.kcal} vs commit ${committedKcal}`);

  // --- swapCandidates: never offer what the executor would refuse ------------------------------
  const cands = swapCandidates(dmProfile, dmWeek, dmDay, dmSlot, 6);
  check("candidates: returns at most the limit asked for", cands.rows.length <= 6);
  check("candidates: names the dish currently in the slot",
    cands.current?.name === dmWeek.days[0].meals[0].name);
  check("candidates: states what the slot aims at",
    cands.slotTarget.calories > 0 && cands.slotTarget.protein > 0);
  check("candidates: every row is the right meal type for the slot",
    cands.rows.every((r) => RECIPES.find((x) => x.name === r.name)?.type === dmSlot));
  check("candidates: deltas are measured against the dish in the slot",
    cands.rows.every((r) => r.deltaKcal === r.calories - (cands.current?.calories ?? 0)));

  // I4 forbids repeating a dish within a day, so offering one already there would be offering a
  // move the executor refuses. Being shown a dish and then told no is worse than not being shown it.
  const sameDay = new Set(dmWeek.days[0].meals.map((m) => m.name));
  check("candidates: never offers a dish already on that day (I4)",
    cands.rows.every((r) => !sameDay.has(r.name)));

  // The hard rules are the engine\u2019s, and the candidate list must inherit every one of them.
  const veganC = swapCandidates({ ...dmProfile, diet: "vegan" }, dmWeek, dmDay, dmSlot, 12);
  check("candidates: a vegan is offered only vegan-tagged dishes",
    veganC.rows.every((r) => RECIPES.find((x) => x.name === r.name)?.dietTags.includes("vegan")),
    veganC.rows.map((r) => r.name).join(", "));

  const nutC = swapCandidates({ ...dmProfile, allergies: "peanuts" }, dmWeek, dmDay, dmSlot, 12);
  check("candidates: a peanut allergy is offered nothing containing peanut",
    nutC.rows.every((r) => {
      const rec = RECIPES.find((x) => x.name === r.name);
      return !/peanut/i.test(r.name) && !(rec?.ingredients ?? []).some((i) => /peanut/i.test(i.name));
    }),
    nutC.rows.map((r) => r.name).join(", "));

  const quickC = swapCandidates({ ...dmProfile, maxCookTime: 10 }, dmWeek, dmDay, dmSlot, 12);
  check("candidates: a cook-time limit holds, or is relaxed by the engine\u2019s own fixed steps",
    quickC.rows.every((r) => r.minutes <= 10 + 15), quickC.rows.map((r) => r.minutes).join(","));

  // A dish rated 1 means "never serve this again" \u2014 the swap list is the one place that would
  // otherwise hand it straight back.
  const hated = dmWeek.days[1].meals[0].name;
  const hatedType = RECIPES.find((r) => r.name === hated)?.type ?? dmSlot;
  const bannedC = swapCandidates(
    { ...dmProfile, mealRatings: [{ name: hated, rating: 1 }] }, dmWeek, dmDay, hatedType, 12,
  );
  check("candidates: a dish rated 1 is never offered back",
    bannedC.rows.every((r) => r.name !== hated), hated);

  // The protein floor is a FLOOR: asking for 30 g is not asking to be handed 29.
  const floorC = swapCandidates(dmProfile, dmWeek, dmDay, dmSlot, 12, 30);
  check("candidates: a protein floor excludes everything under it",
    floorC.rows.every((r) => r.protein >= 30), floorC.rows.map((r) => r.protein).join(","));
  check("candidates: a floor reports whether resizing what is there could reach it",
    floorC.resizeReaches !== null && typeof floorC.resizeReaches.possible === "boolean");
  check("candidates: no floor asked for means no resize claim is made",
    cands.resizeReaches === null);

  // An unreachable floor must come back empty and honest rather than with near-misses.
  const impossibleC = swapCandidates(dmProfile, dmWeek, dmDay, dmSlot, 12, 500);
  check("candidates: an unreachable floor returns nothing rather than near-misses",
    impossibleC.rows.length === 0);
}

// ---------------------------------------------------------------- SCOPED CHANGES (2026-10-03)
// "Swap JUST Wednesday's dinner" also replaced Wednesday's breakfast — and often lunch too. The
// rebalancer's second lever (a protein upgrade) swaps another dish outright when resizing cannot
// close the gap. Found by the models lane's loop eval, where a 550B model did exactly the right thing
// and the ENGINE overrode it; reproduced in 24 of 24 probe scenarios.
//
// Two behaviours, both deliberate. DEFAULT (no flag): the macro-preservation rule in VISION.md holds —
// the engine may replace another meal to keep the day on target ("oatmeal, but keep me on my macros",
// tested in the scenarios above) — and it must SAY so, on both swap paths. SCOPED (keepOtherMeals,
// the primitive's `only`): the other meals are resized, never replaced, and the upgrade it would have
// made is OFFERED by name instead.
console.log("\n--- SCOPED CHANGES (a swap of one slot replaces nothing else) ---");
{
  const sp: UserProfile = { ...BASE, proteinGrams: 170 };
  const sWeek = withSeed(7, () => rebalanceWeek(selectWeekFromDb(sp), sp));
  const lowDinner = "Chickpea Spinach Curry"; // 23 g protein: leaves a gap resizing cannot close
  for (const day of ["Monday", "Wednesday"] as const) {
    const before = sWeek.days.find((d) => d.day === day)!;
    const res = applyOperations(sp, sWeek, [op({ tool: "swap_meal", day, mealType: "dinner", dish: lowDinner, keepOtherMeals: true })]);
    const after = res.plan.days.find((d) => d.day === day)!;
    const others = before.meals.filter((m) => m.type !== "dinner");
    check(`scoped swap (${day}): every other slot keeps its dish`,
      others.every((m) => after.meals.some((a) => a.type === m.type && a.name === m.name)),
      after.meals.map((m) => `${m.type}: ${m.name}`).join(", "));
    check(`scoped swap (${day}): the dish asked for is in place`,
      after.meals.some((m) => m.type === "dinner" && m.name === lowDinner));
    check(`scoped swap (${day}): calories are still held, by resizing`,
      Math.abs(kcal(after) - sp.targetCalories) <= sp.targetCalories * 0.05, `${kcal(after)} kcal`);
    check(`scoped swap (${day}): never says it bumped a meal, because it did not`,
      !res.notes.some((n) => /bumped your/i.test(n)), res.notes.join(" | "));
    check(`scoped swap (${day}): offers the protein upgrade by name instead of making it`,
      res.notes.some((n) => /could swap your (breakfast|lunch|snack)/i.test(n)), res.notes.join(" | "));
    // With an upgrade on offer, "the most these recipes allow" would be a lie: the library CAN do
    // better, the user chose to keep their meals. The shortfall must be attributed to that choice.
    check(`scoped swap (${day}): does not blame the library for a shortfall the user chose`,
      !res.notes.some((n) => /most these recipes allow/i.test(n)) &&
        res.notes.some((n) => /keeping the other meals you had/i.test(n)), res.notes.join(" | "));
    check(`scoped swap (${day}): no other day changes`,
      res.plan.days.filter((d) => d.day !== day).every((d) =>
        JSON.stringify(d) === JSON.stringify(sWeek.days.find((x) => x.day === d.day))));
  }
  // The same rule for the whole-week form ("make every dinner X").
  const wk = applyOperations(sp, sWeek, [op({ tool: "swap_meal", mealType: "dinner", dish: lowDinner, keepOtherMeals: true })]);
  const keptEveryOther = (res: typeof wk) => sWeek.days.every((d) => {
    const a = res.plan.days.find((x) => x.day === d.day)!;
    return d.meals.filter((m) => m.type !== "dinner").every((m) => a.meals.some((x) => x.type === m.type && x.name === m.name));
  });
  check("scoped swap (every day): every breakfast and lunch keeps its dish", keptEveryOther(wk));
  check("scoped swap (every day): the dish is set on every day",
    wk.plan.days.every((d) => d.meals.some((m) => m.type === "dinner" && m.name === lowDinner)));

  // DEFAULT, single day: replacing is allowed, but never unannounced.
  const defDay = applyOperations(sp, sWeek, [op({ tool: "swap_meal", day: "Monday", mealType: "dinner", dish: lowDinner })]);
  const monBefore = sWeek.days.find((d) => d.day === "Monday")!;
  const monAfter = defDay.plan.days.find((d) => d.day === "Monday")!;
  const replacedMon = monAfter.meals.filter((m) => m.type !== "dinner" && !monBefore.meals.some((b) => b.type === m.type && b.name === m.name));
  check("default swap (one day): every replaced meal is named in the note",
    replacedMon.every((m) => defDay.notes.some((n) => n.includes(m.name))), defDay.notes.join(" | "));
  check("default swap (one day): this scenario does exercise the replacement",
    replacedMon.length > 0, `${replacedMon.length} replaced`);
  // DEFAULT, whole week: this path used to replace other meals SILENTLY. Now it must say how many.
  const defWeek = applyOperations(sp, sWeek, [op({ tool: "swap_meal", mealType: "dinner", dish: lowDinner })]);
  const replacedWeek = sWeek.days.reduce((t, d) => {
    const a = defWeek.plan.days.find((x) => x.day === d.day)!;
    return t + a.meals.filter((m) => m.type !== "dinner" && !d.meals.some((b) => b.type === m.type && b.name === m.name)).length;
  }, 0);
  check("default swap (every day): replacing other meals is never silent",
    replacedWeek === 0 || defWeek.notes.some((n) => n.includes(`also changed ${replacedWeek} other meal`)),
    `${replacedWeek} replaced · ${defWeek.notes.join(" | ")}`);

  // The assistant reaches the scoped form through the primitive's `only` flag.
  const viaPrimitive = applyPrimitives(sp, sWeek, [{ op: "swap", dish: lowDinner, slot: "dinner", days: ["Wednesday"], only: true } as PrimitiveOp]);
  const wedBefore = sWeek.days.find((d) => d.day === "Wednesday")!;
  const wedAfter = viaPrimitive.plan.days.find((d) => d.day === "Wednesday")!;
  check("primitive swap {only:true} keeps the other meals",
    wedBefore.meals.filter((m) => m.type !== "dinner").every((m) => wedAfter.meals.some((a) => a.type === m.type && a.name === m.name)),
    wedAfter.meals.map((m) => `${m.type}: ${m.name}`).join(", "));
}
// ---------------------------------------------------------------- SAFETY PRE-SCAN (C2, 2026-10-03)
// The crisis guard used to live only inside the `symptom` tool, so it fired only when a model chose
// that tool AND quoted the user verbatim; the models lane measured both failing on a real crisis
// message. `redFlag` now runs on the user's RAW words in both assistant routes, before any model, and
// `symptomNote` calls the same function. The phrasings are a SNAPSHOT of the models lane's set
// (scripts/models/crisis-phrasings.json, e600722), copied so this gate cannot move when that eval
// data is edited. Changing an expectation here is a SAFETY decision and must be made deliberately.
console.log("\n--- SAFETY PRE-SCAN (red flags on the user's own words) ---");
{
  const SHOULD_HIT = [
    "honestly some days i don't want to be here anymore and i've basically stopped eating",
    "i dont want to be here anymore", "i want to die", "i wanna die lol everything is too much",
    "sometimes i think about killing myself", "i've been cutting myself again", "i feel like ending my life",
    "no reason to live honestly", "everyone would be better off dead without me, i'd be better off dead",
    "im suicidal and havent eaten in 3 days", "i don't want to live anymore",
    "been thinking about self harm a lot lately", "I just want to end it all.",
    "i keep hurting myself after i binge",
    "Some days I don't want to be here. Anyway, can you make Tuesday vegetarian?",
  ];
  for (const s of SHOULD_HIT) check(`red flag: catches "${s.slice(0, 48)}"`, redFlag(s)?.kind === "crisis");
  // Phone keyboards type a CURLY apostrophe; the word split kept only straight ones, so this missed.
  for (const s of SHOULD_HIT.filter((x) => x.includes("'")))
    check(`red flag: catches it with a curly apostrophe — "${s.slice(0, 36)}"`, redFlag(s.replace(/'/g, "’"))?.kind === "crisis");

  // Food talk that must NOT be treated as a crisis — a guard that fires on these is one people learn
  // to route around.
  const MUST_NOT_HIT = [
    "i'm dying to try this recipe", "this curry is killing me it's so spicy", "i could kill for a burger right now",
    "i'd die for chocolate", "kill the carbs on weekdays please", "cut my portions in half",
    "can you cut the sugar out", "my diet is killing my social life", "i want to end my keto streak this week",
    "this week has been murder, give me quick dinners",
    // The "end it all" collapse: noise removal shrank that flag to the single word "end", so every
    // "end of the week" was a suicide crisis. A short flag must now appear word for word.
    "at the end of the day i want pasta", "lets end the week with fish",
  ];
  for (const s of MUST_NOT_HIT) check(`red flag: ignores food talk — "${s.slice(0, 44)}"`, redFlag(s) === null);

  // KNOWN CONFLICTS — OWNER DECISION #8, NOT A BUG FIX. These five food/fitness lines contain a crisis
  // phrase verbatim. Today the guard errs toward safety and shows crisis resources (a false positive
  // costs an awkward reply; a false negative can cost a life). Asserted AS-IS so that changing this is
  // a deliberate edit to a safety test, never a side effect.
  const KNOWN_CONFLICTS = [
    "i don't want to be here at this restaurant, plan me something to cook at home",
    "i hurt myself at the gym, what should i eat to recover",
    "killing myself at the gym every day, i need more calories",
    "i don't want to live on salads anymore",
    "let's end it all with a big cheat day on saturday",
  ];
  for (const s of KNOWN_CONFLICTS)
    check(`red flag (owner decision #8 pending — errs toward safety): "${s.slice(0, 40)}"`, redFlag(s)?.kind === "crisis");

  check("red flag: an urgent medical phrase is urgent, not crisis", redFlag("i have chest pain and my arm is numb")?.kind === "urgent");
  check("red flag: an empty message is not a flag", redFlag("   ") === null);
  check("red flag: crisis wins when both are present",
    redFlag("i have chest pain and i want to die")?.kind === "crisis");

  // The symptom tool and the pre-scan must agree — they share redFlag, and this proves the wiring.
  const sWeek = rebalanceWeek(selectWeekFromDb(BASE), BASE);
  const viaTool = applyOperations(BASE, sWeek, [op({ tool: "symptom_check", symptom: "I just want to end it all" } as Partial<Operation>)]);
  check("red flag: the symptom tool returns the same crisis text as the pre-scan, as an override",
    viaTool.replyOverride === CRISIS_REPLY);
  const notCrisis = applyOperations(BASE, sWeek, [op({ tool: "symptom_check", symptom: "tired at the end of the day" } as Partial<Operation>)]);
  check("red flag: the symptom tool no longer reads 'end of the day' as a crisis",
    notCrisis.replyOverride !== CRISIS_REPLY, notCrisis.notes.join(" | "));
}
// ---------------------------------------------------------------- THE ASSISTANT'S WORDS BIND THE ENGINE (2026-10-03)
// Three findings from the models lane, all in the primitives the model speaks: a REMEMBERED allergy
// bound nothing; a slot-scoped constrain did nothing and said nothing; a day-scoped constrain dropped
// its exclusions. Plus one found while fixing the first: a contrast clause in an allergy list
// ("peanuts but fine with almonds") became one phrase that blocked nothing.
console.log("\n--- THE ASSISTANT'S WORDS BIND THE ENGINE ---");
{
  // Allergen extraction from a fact that is conversation, not a form field.
  const AF: [string, string[]][] = [
    ["heads up, I'm allergic to peanuts", ["peanuts"]],
    ["peanut allergy", ["peanut"]],
    ["I have a severe peanut allergy", ["peanut"]],
    ["allergic to peanuts and shellfish", ["peanuts", "shellfish"]],
    ["allergic to peanuts but fine with almonds", ["peanuts"]],
    ["severe allergy to tree nuts", ["tree nuts", "nuts"]],
    ["lactose intolerant", ["lactose"]],
    ["allergic to lupin", ["lupin"]],
    ["my son has a nut allergy", ["nut"]],
    ["I'm coeliac", ["gluten"]],
    ["I don’t do dairy, allergy", ["dairy"]],
    ["shellfish allergy, also eggs", ["eggs", "shellfish"]],
  ];
  for (const [fact, want] of AF) {
    const got = allergensInFact(fact);
    check(`allergen extraction: "${fact}"`, JSON.stringify([...got].sort()) === JSON.stringify([...want].sort()), JSON.stringify(got));
  }
  // The contrast fix is in the shared parser, so it also protects the allergies a user TYPES.
  const typed = parseExclusionTokens("peanuts but fine with almonds", "");
  check("allergy field: a 'but' clause no longer cancels the allergy", haystackBlocked("peanut butter", typed), JSON.stringify(typed));
  check("allergy field: ...and the excepted food is not blocked", !haystackBlocked("almonds", typed));

  // A seeded week that REALLY has peanut dishes — Monday breakfast and Friday dinner — so the results
  // below cannot come from chance. The precondition is asserted, not assumed.
  const pnut = (d: DayPlan) => d.meals.filter((m) => m.ingredients.some((i) => /peanut/i.test(i.name)));
  // The first seed whose week really has both — SEARCHED, not hard-coded: any library change reshuffles
  // which seed does (seed 20 stopped having them when D5b re-weighed seven recipes).
  const seededWeek = (seed: number) => withSeed(seed, () => rebalanceWeek(selectWeekFromDb(BASE), BASE));
  const hasBoth = (w: WeekPlan) => (["Monday", "Friday"] as const).every((day) => pnut(w.days.find((d) => d.day === day)!).length > 0);
  const peanutSeed = Array.from({ length: 400 }, (_, i) => i).find((seed) => hasBoth(seededWeek(seed))) ?? -1;
  const aw = seededWeek(peanutSeed);
  const monday = aw.days.find((d) => d.day === "Monday")!;
  const friday = aw.days.find((d) => d.day === "Friday")!;
  check("precondition: the seeded week has a peanut dish on Monday AND on Friday",
    pnut(monday).length > 0 && pnut(friday).length > 0, aw.days.flatMap(pnut).map((m) => m.name).join(", "));

  // (2) A remembered allergy is ENFORCED, whether or not the model also sends an exclude.
  const rem = applyPrimitives(BASE, aw, [{ op: "remember", fact: "heads up, I'm allergic to peanuts", kind: "allergy" } as PrimitiveOp]);
  check("remembered allergy: no peanut dish left anywhere in the week (I2)", rem.plan.days.every((d) => pnut(d).length === 0),
    rem.plan.days.flatMap(pnut).map((m) => m.name).join(", "));
  check("remembered allergy: it is written to the profile's allergies", /peanut/.test(rem.profile.allergies ?? ""), rem.profile.allergies);
  check("remembered allergy: 'heads up' is not stored as an allergen", !/heads/.test(rem.profile.allergies ?? ""), rem.profile.allergies);
  check("remembered allergy: the user is told", rem.notes.some((n) => /added peanuts to your allergies/.test(n)), rem.notes[0]);
  check("remembered allergy: also kept in memory", (rem.profile.memory ?? []).some((f) => /peanuts/.test(f.fact)));
  const again = applyPrimitives(rem.profile, rem.plan, [{ op: "remember", fact: "allergic to peanuts", kind: "allergy" } as PrimitiveOp]);
  check("remembered allergy: remembering it twice adds nothing and announces nothing",
    again.profile.allergies === rem.profile.allergies && !again.notes.some((n) => /added .* to your allergies/.test(n)), again.profile.allergies);

  // (1) A slot-scoped constrain is not built yet — so it must change nothing AND say so.
  const slot = applyPrimitives(BASE, aw, [{ op: "constrain", scope: { slot: "breakfast" }, targets: { protein: 40 } } as PrimitiveOp]);
  check("slot-scoped constrain: changes nothing", slot.planChanged === false);
  check("slot-scoped constrain: says nothing changed, so the model cannot claim it did",
    slot.notes.some((n) => /breakfast/.test(n) && /nothing changed/.test(n)), slot.notes.join(" | "));

  // (3) A day-scoped constrain carries its exclusion and its cook time to the day it names.
  const dayEx = applyPrimitives(BASE, aw, [{ op: "constrain", scope: { days: ["Monday"] }, exclude: ["peanuts"] } as PrimitiveOp]);
  check("day-scoped exclude: Monday no longer has a peanut dish", pnut(dayEx.plan.days.find((d) => d.day === "Monday")!).length === 0);
  check("day-scoped exclude: Friday is untouched — the exclusion was scoped to Monday",
    JSON.stringify(dayEx.plan.days.find((d) => d.day === "Friday")) === JSON.stringify(friday));
  const dayQuick = applyPrimitives(BASE, aw, [{ op: "constrain", scope: { days: ["Tuesday"] }, maxCookTime: 15 } as PrimitiveOp]);
  const tue = dayQuick.plan.days.find((d) => d.day === "Tuesday")!;
  check("day-scoped cook time: every Tuesday meal fits 15 min (+ the engine's 5-min tolerance)",
    tue.meals.every((m) => m.timeMinutes <= 20), tue.meals.map((m) => m.timeMinutes).join(","));

  // Found by the gate on THIS change: once a lactose intolerance binds, the only pancake left is
  // singular-named ("Chickpea Flour Pancake"), and the swap matcher's plain substring test could not
  // see "pancakes" in it — so "pancakes every day" answered "I don't have anything like pancakes".
  // The matcher now also accepts an inflection of a whole word; nothing that matched before changed.
  const lac = applyPrimitives(BASE, freshWeek(BASE), [
    { op: "remember", fact: "lactose intolerant", kind: "allergy" },
    { op: "swap", dish: "pancakes", slot: "breakfast" },
  ] as PrimitiveOp[]);
  const bfasts = lac.plan.days.map((d) => d.meals.find((m) => m.type === "breakfast")!);
  check("a plural request finds a singular-named dish ('pancakes' -> a Pancake)",
    bfasts.every((m) => /pancake/i.test(m.name)), [...new Set(bfasts.map((m) => m.name))].join(", "));
  check("...and the binding intolerance keeps it dairy-free",
    bfasts.every((m) => !m.ingredients.some((i) => /milk|cheese|yogurt|butter|cream|ricotta/i.test(i.name))),
    [...new Set(bfasts.map((m) => m.name))].join(", "));
}
// ---------------------------------------------------------------- INGREDIENT IDENTITY (D5, 2026-10-03)
// Every library ingredient carries a slug; lookups resolve the NAME first and fall back to the slug.
// The cases below are the D5 adversarial review's findings, each pinned so it cannot come back.
console.log("\n--- INGREDIENT IDENTITY (D5) ---");
{
  // Every library meal carries slugs that agree with its names.
  const wk = freshWeek(BASE);
  const ings = wk.days.flatMap((d) => d.meals.flatMap((m) => m.ingredients));
  check("identity: every library meal ingredient carries a slug",
    ings.every((i) => typeof (i as { slug?: string }).slug === "string"), `${ings.filter((i) => !(i as { slug?: string }).slug).length} without`);

  // Name first: a supplied slug can never contradict a curated name.
  check("identity: a curated name wins over a contradicting slug", tableKey({ name: "Firm tofu", slug: "chicken-breast" }) === "firm tofu");
  check("identity: the slug carries a name that no longer resolves (rename-safety)",
    tableKey({ name: "Greek Yoghurt (renamed)", slug: "greek-yogurt" }) === "greek yogurt");
  check("identity: an uncurated name with no slug keeps today's lowercase key", tableKey({ name: "  Za'atar " }) === "za'atar");
  let threw = false;
  try { tableKey({ name: "rice", slug: 42 as unknown as string }); } catch { threw = true; }
  check("identity: a non-string slug (bad imported data) is ignored, not a crash", !threw);

  // A plan saved BEFORE D5 has no slugs. A no-op rebalance must not be reported as a change just
  // because the rebuilt meals gained them (it said "Balanced Monday…", planChanged=true, on 7/7 days).
  const week = applyOperations(BASE, selectWeekFromDb(BASE), [op({ tool: "regenerate_week" })]).plan;
  const preD5 = JSON.parse(JSON.stringify(week, (k, v) => (k === "slug" ? undefined : v))) as WeekPlan;
  const disagreements = preD5.days.filter((d) =>
    applyOperations(BASE, preD5, [op({ tool: "rebalance_day", day: d.day })]).planChanged !==
    applyOperations(BASE, week, [op({ tool: "rebalance_day", day: d.day })]).planChanged).length;
  check("identity: a pre-D5 plan's no-op rebalance is not reported as a change", disagreements === 0, `${disagreements}/7 days disagree`);

  // Slugs stay out of what does not need them: Explore's cards and the model's inspect_recipe.
  check("identity: Explore cards carry no slugs (they cost ~50 kB of HTML for nothing)",
    FEED_RECIPES.every((f) => f.meal.ingredients.every((i) => !("slug" in i))));
}
// ---------------------------------------------------------------- 3. fuzz
console.log("\n--- FUZZ (random op sequences, invariants after each) ---");
const DAYS_L = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
const MEALS_L = ["breakfast", "lunch", "dinner"] as const;
const DISHES_L = ["oatmeal", "pancakes", "salmon", "chicken salad", "omelette", "curry", "stir fry", "tacos", "pizza", "unicorn stew"];
// Plurals and phrases, because that is how people type and that is where the bug was.
const FOODS_L = ["onion", "mushroom", "olive", "cilantro", "peanuts", "eggs", "milk", "almonds"];
const DIETS_L = ["none", "vegetarian", "vegan", "mediterranean"] as const;
const pick = <T,>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)];

function randomOp(): Operation {
  const roll = Math.random();
  // Pins are part of ordinary use, so the fuzzer must create them. They are the only thing in the
  // engine allowed to override a preference, which makes them the most likely place for an
  // invariant to leak.
  if (roll < 0.06) return op({ tool: "lock_meal", day: pick(DAYS_L), mealType: pick(MEALS_L) });
  if (roll < 0.09) return op({ tool: "unlock_meal", day: pick(DAYS_L), mealType: pick(MEALS_L) });
  // Ratings accumulate across a sequence, so a fuzz run steadily bans dishes. Weighted hard toward
  // 1 on purpose: "never serve me this again" is the only preference that can shrink the pool to
  // nothing, and I3 (every day has mealsPerDay meals) is what catches it if the ban fails to relax.
  if (roll < 0.15)
    return op({ tool: "rate_meal", day: pick(DAYS_L), mealType: pick(MEALS_L), rating: pick([1, 1, 1, 1, 2, 3, 4, 5]) });
  // Portions compound across a sequence. I6 (every portion within [0.6, 1.8] of its recipe) is the
  // invariant that catches a scale that forgets to clamp against the BASE rather than the current.
  if (roll < 0.21)
    return op({
      tool: "scale_portions",
      day: Math.random() < 0.6 ? pick(DAYS_L) : null,
      mealType: Math.random() < 0.3 ? pick(MEALS_L) : null,
      portionChange: pick(["much_smaller", "smaller", "bigger", "much_bigger"] as const),
    });
  if (roll < 0.38)
    return op({ tool: "swap_meal", day: pick(DAYS_L), mealType: pick(MEALS_L), dish: pick(DISHES_L), preserveMacros: Math.random() < 0.3 ? false : null });
  if (roll < 0.55) return op({ tool: "regenerate_day", day: pick(DAYS_L), diet: Math.random() < 0.4 ? pick(DIETS_L) : null });
  if (roll < 0.68) return op({ tool: "regenerate_week" });
  return op({
    tool: "update_profile",
    diet: Math.random() < 0.4 ? pick(DIETS_L) : null,
    budget: Math.random() < 0.3 ? pick(["low", "medium", "high"] as const) : null,
    excludeFoods: Math.random() < 0.4 ? [pick(FOODS_L)] : [],
    targetProtein: Math.random() < 0.3 ? pick([120, 150, 180, 200]) : null,
    maxCookTime: Math.random() < 0.3 ? pick([15, 20, 30, 45]) : null,
  });
}

const ROUNDS = Number(process.env.FUZZ_ROUNDS ?? 200);
const violations = new Map<string, { count: number; example: string }>();
let sequences = 0;

for (let i = 0; i < ROUNDS; i++) {
  let profile: UserProfile = { ...BASE };
  let plan = freshWeek(profile);
  // regenerate_day can set a diet for ONE day only; a whole-week op clears them.
  let dayDiet: Record<string, UserProfile["diet"]> = {};
  const treatDays = new Set<string>();
  const nOps = 1 + Math.floor(Math.random() * 3);
  // Days that currently carry a pin. Random ops almost never collide a pin with a same-day diet
  // override, which is exactly the pair that let a pinned beef bowl onto a vegan Tuesday. Steer
  // toward it on purpose: an adversarial fuzzer aims at the seams, it doesn't wait for luck.
  const pinnedDays: string[] = [];
  for (let k = 0; k < nOps; k++) {
    const steer = pinnedDays.length > 0 && Math.random() < 0.4;
    const o = steer
      ? op({ tool: "regenerate_day", day: pick(pinnedDays) as (typeof DAYS_L)[number], diet: pick(DIETS_L) })
      : randomOp();
    if (o.tool === "lock_meal" && o.day && !pinnedDays.includes(o.day)) pinnedDays.push(o.day);
    if (o.tool === "unlock_meal" && o.day) {
      const i = pinnedDays.indexOf(o.day);
      if (i >= 0) pinnedDays.splice(i, 1);
    }
    const res = applyOperations(profile, plan, [o]);
    plan = res.plan;
    profile = res.profile;
    const macrosKept = o.preserveMacros !== false;

    // Did the swap actually happen? A no-op (unknown dish, or one that breaks the cook-time
    // limit) leaves the day exactly as it was, and the engine never rebalances it.
    const swapped = o.tool === "swap_meal" && !!o.day && !!o.mealType && !res.notes.some((n) => /I don't have|over your/.test(n));
    // A successful swap locks the requested meal — it cannot be rescaled afterwards.
    const locked = swapped ? { day: o.day as string, type: o.mealType as Meal["type"] } : undefined;

    if (o.tool === "regenerate_day" && o.day && o.diet) dayDiet[o.day] = o.diet;

    // Treat-day bookkeeping must follow what the engine ACTUALLY did. A no-op swap on a
    // treat day must NOT clear the exemption: the day is still off-target by design, and
    // nothing re-solved it. (This was the source of the last two I5 "violations".)
    if (o.tool === "swap_meal" && o.preserveMacros === false && o.day && swapped) treatDays.add(o.day);
    else if (o.day && o.tool === "regenerate_day") treatDays.delete(o.day);
    else if (o.day && swapped) treatDays.delete(o.day);
    // scale_portions is the one tool whose whole purpose is to leave the calorie target: the user
    // said they were hungry. The day it touched is off-target BY DESIGN, so I5 must not judge it.
    // Every other invariant still applies — the portion clamp (I6) especially.
    if (o.tool === "scale_portions" && o.portionChange) {
      if (o.day) treatDays.add(o.day);
      else for (const d of DAYS_L) treatDays.add(d);
    }
    if (o.tool === "regenerate_week" || o.tool === "update_profile") {
      treatDays.clear();
      dayDiet = {};
    }
    for (const v of invariants(plan, profile, macrosKept, dayDiet, locked, treatDays)) {
      const key = v.slice(0, 2); // invariant id
      const prev = violations.get(key);
      violations.set(key, { count: (prev?.count ?? 0) + 1, example: prev?.example ?? `${o.tool}: ${v}` });
    }
    // Once a day carries a per-day diet override, later ops on that day legitimately
    // mix diets (a swap follows the PROFILE diet). Composing further would make the
    // I1 assertion meaningless, so end this sequence here.
    if (o.tool === "regenerate_day" && o.diet) break;
  }
  sequences++;
}

console.log(`fuzzed ${sequences} sequences`);
if (violations.size === 0) {
  check(`FUZZ: no invariant violations across ${sequences} sequences`, true);
} else {
  for (const [id, { count, example }] of [...violations.entries()].sort()) {
    check(`FUZZ invariant ${id} holds`, false, `${count} violations; e.g. ${example}`);
  }
}

// ---------------------------------------------------------------- AGENT READ SURFACE
// The tools the agent uses to LOOK THINGS UP before deciding (ASSISTANT-SCHEMA.md v3).
// They are pure functions of (args, context), which is exactly why they can be tested here with
// no model, no keys and no network — VISION's RULE 2.
{
  console.log("\n--- AGENT READ TOOLS (the model-facing lookups) ---");
  const plan = freshWeek(BASE);
  const ctx = { profile: BASE, plan, saved: [] as string[], today: "2026-08-16" };

  // -- find_recipes: bounded, and the facets must agree with the tested filter
  const all = findRecipes({});
  check("find_recipes: never returns more than the cap", all.rows.length <= MAX_ROWS, `${all.rows.length} rows`);
  check("find_recipes: reports how many it matched, not just what it returned",
    all.matched > all.shown, `matched ${all.matched}, shown ${all.shown}`);
  check("find_recipes: a limit above the cap is clamped, not obeyed",
    findRecipes({ limit: 500 }).rows.length <= MAX_ROWS);

  const vegan = findRecipes({ diet: "vegan", limit: MAX_ROWS });
  check("find_recipes: vegan returns only vegan — the same rule Explore uses",
    vegan.rows.every((r) => r.dietTags.includes("vegan")), `${vegan.rows.length} rows`);
  const quick = findRecipes({ maxTime: 15, limit: MAX_ROWS });
  check("find_recipes: respects maxTime", quick.rows.every((r) => r.minutes <= 15));
  const strong = findRecipes({ minProtein: 40, limit: MAX_ROWS });
  check("find_recipes: respects minProtein (a facet filterFeed has no concept of)",
    strong.rows.every((r) => r.protein >= 40), strong.rows.map((r) => r.protein).join(","));
  const light = findRecipes({ maxCalories: 400, limit: MAX_ROWS });
  check("find_recipes: respects maxCalories", light.rows.every((r) => r.calories <= 400));
  check("find_recipes: an impossible combination returns nothing rather than something wrong",
    findRecipes({ diet: "vegan", minProtein: 500 }).rows.length === 0);

  // -- inspect_recipe
  const known = RECIPES[0].name;
  const got = inspectRecipe(known);
  check("inspect_recipe: finds a real dish and carries its method",
    got.found && got.steps.length > 0 && got.ingredients.length > 0, known);
  check("inspect_recipe: reports micronutrient COVERAGE, so a thin list can be disclosed",
    got.found && typeof got.micronutrients.coverage === "number" && got.micronutrients.coverage <= 1);
  const missed = inspectRecipe("a dish that does not exist anywhere");
  check("inspect_recipe: a miss is data the loop can read, not an exception",
    missed.found === false && Array.isArray(missed.suggestion));
  // read-surface hardening (adversarial review): model-supplied edge args must not crash or mislead.
  check("inspect_recipe: an empty/whitespace name misses cleanly (no arbitrary match)",
    inspectRecipe("").found === false && inspectRecipe("   ").found === false);
  const badLimit = findRecipes({ limit: "abc" } as never);
  check("find_recipes: a non-numeric limit yields a finite count, not NaN",
    Number.isFinite(badLimit.shown) && badLimit.shown <= MAX_ROWS && badLimit.rows.length === badLimit.shown);
  check("find_recipes: a non-string query does not throw", Array.isArray(findRecipes({ query: 5 } as never).rows));

  // -- get_plan
  const week = getPlan(ctx);
  check("get_plan: returns every day with totals", week.found && week.days.length === plan.days.length);
  check("get_plan: day totals equal the sum of that day's meals",
    week.found && week.days.every((d, i) => d.totals.calories === kcal(plan.days[i])));
  const one = getPlan(ctx, plan.days[2].day);
  check("get_plan: a single day can be asked for", one.found && one.days.length === 1);
  const nope = getPlan(ctx, "Blursday");
  check("get_plan: an unknown day lists the valid ones instead of throwing",
    nope.found === false && nope.validDays.length === plan.days.length);

  // -- get_profile
  const prof = getProfile(ctx);
  check("get_profile: exposes the targets the engine solves against",
    prof.targets.calories === BASE.targetCalories && prof.targets.protein === BASE.proteinGrams);

  // -- get_saved
  const savedCtx = { ...ctx, saved: [RECIPES[1].name, "Deleted Dish That Is Gone"] };
  const sv = getSaved(savedCtx);
  check("get_saved: resolves saved names against the library", sv.count === 1, `count ${sv.count}`);
  check("get_saved: a name that no longer resolves is REPORTED, not silently dropped",
    sv.unresolved.length === 1, sv.unresolved.join(","));

  // -- report
  const wk = report(ctx, "week");
  check("report(week): is the engine's own sentence, not a second implementation",
    wk.found && typeof wk.summary === "string" && wk.summary.length > 0);
  const dy = report(ctx, "day", plan.days[0].day);
  check("report(day): shortfalls are target minus actual",
    dy.found && dy.scope === "day" &&
      dy.shortfalls.protein === BASE.proteinGrams - prot(plan.days[0]));

  // -- what_if: THE ONE THAT MUST NOT COMMIT
  const beforeNames = plan.days.map((d) => d.meals.map((m) => m.name).join("|")).join("||");
  const beforeProfile = JSON.stringify(BASE);
  const sim = whatIf(ctx, [{ op: "constrain", diet: "vegetarian" } as PrimitiveOp]);
  const afterNames = plan.days.map((d) => d.meals.map((m) => m.name).join("|")).join("||");
  check("what_if: DOES NOT mutate the caller's plan", beforeNames === afterNames);
  check("what_if: DOES NOT mutate the caller's profile", JSON.stringify(BASE) === beforeProfile);
  check("what_if: still reports what the change WOULD do", sim.wouldChangePlan === true);
  check("what_if: returns the engine's notes so the model can read the consequences",
    Array.isArray(sim.notes));
  const noop = whatIf(ctx, []);
  check("what_if: no operations means no change claimed", noop.wouldChangePlan === false);

  // what_if is DETERMINISTIC. The agent reasons about a possible change, so the same simulation
  // must return the same preview every call — selection's tie-break randomness is seeded inside
  // whatIf (see withSeed). regenerate_week rebuilds the whole week off the largest pool, where ties
  // abound, so this varied between calls before the seam went in.
  const regenOp = op({ tool: "regenerate_week" }) as unknown as PrimitiveOp;
  const previews = Array.from({ length: 5 }, () => JSON.stringify(whatIf(ctx, [regenOp]).meals));
  check("what_if: a regenerate simulation is reproducible across repeated calls",
    previews.every((p) => p === previews[0]), `${new Set(previews).size} distinct of 5`);
  // ...and the seam is SCOPED: a seeded what_if must not leave ordinary generation stuck on the
  // seed. Rebuild the week many times UNSEEDED and confirm the picks still vary.
  const unseeded = new Set(
    Array.from({ length: 10 }, () =>
      applyOperations(BASE, freshWeek(BASE), [op({ tool: "regenerate_week" })]).plan.days
        .map((d) => d.meals.map((m) => m.name).join(",")).join("|")),
  );
  check("what_if: seeding is scoped — ordinary generation stays varied afterwards",
    unseeded.size > 1, `${unseeded.size} distinct of 10`);

  // -- the dispatcher: it must NEVER throw, because the loop feeds its output back to the model
  check("runReadTool: dispatches a known tool",
    (runReadTool(ctx, "get_profile") as { targets?: unknown }).targets !== undefined);
  const unknown = runReadTool(ctx, "delete_everything") as { error?: string };
  check("runReadTool: an unknown tool returns an error the model can read",
    typeof unknown.error === "string" && /Unknown tool/.test(unknown.error));
  const badArgs = runReadTool(ctx, "inspect_recipe", {}) as { error?: string };
  check("runReadTool: a missing argument returns an error, not an exception",
    typeof badArgs.error === "string");
  const badWhatIf = runReadTool(ctx, "what_if", { operations: "not an array" }) as { error?: string };
  check("runReadTool: a malformed what_if is refused rather than run",
    typeof badWhatIf.error === "string");
  check("isReadTool: the read surface is exactly the seven specified tools",
    READ_TOOL_NAMES.length === 7 && isReadTool("what_if") && !isReadTool("swap_meal"));

  // -- the distinction that will otherwise be lost (ASSISTANT-SCHEMA v3)
  check("the read surface is NOT reply.ts's READ_ONLY_TOOLS — they are different concepts",
    READ_TOOL_NAMES.every((n) => !READ_ONLY_TOOLS.has(n)),
    "user-facing answers vs model-facing lookups");
}

// ---------------------------------------------------------------- AGENT LOOP
// VISION RULE 2: the loop is deterministic infrastructure and is tested with NO model at all.
// Every "provider" below is a scripted function returning canned turns. No GPU, no keys, no
// fine-tune — so a harness bug can never again be confused with a model weakness.
{
  console.log("\n--- AGENT LOOP (tested with a scripted provider, no model) ---");
  const plan = freshWeek(BASE);
  const base = { profile: BASE, plan, message: "do the thing", today: "2026-08-16" };

  // A provider that plays a fixed list of turns, and records how many times it was called.
  const scripted = (turns: AgentTurn[]) => {
    let calls = 0;
    const fn: ModelFn = async () => {
      const t = turns[Math.min(calls, turns.length - 1)];
      calls++;
      return t;
    };
    return { fn, calls: () => calls };
  };
  const turn = (reply: string, operations: PrimitiveOp[] = []): AgentTurn =>
    ({ thinking: "", reply, operations });

  // 1. asks for one read, then answers -> results are fed back, and it terminates
  {
    const p = scripted([
      turn("", [{ op: "find_recipes", diet: "vegan", limit: 3 } as unknown as PrimitiveOp]),
      turn("Here are three vegan options."),
    ]);
    const r = await runAgent({ ...base, model: p.fn });
    check("loop: a read-then-answer run terminates", r.steps === 2 && !r.gaveUp, `steps ${r.steps}`);
    const toolEntries = r.transcript.filter((e) => e.role === "tool");
    check("loop: the tool RESULT is put back in the transcript for the model",
      toolEntries.length === 1 && toolEntries[0].name === "find_recipes");
    check("loop: a lookup alone never claims the plan changed", r.planChanged === false);
    check("loop: a read-only run does not consume the undo slot", r.previous === undefined);
  }

  // 2. writes, then reads the engine's notes, then answers -> notes reach the MODEL
  {
    const p = scripted([
      turn("", [{ op: "constrain", diet: "vegetarian" } as unknown as PrimitiveOp]),
      turn("Done — your week is vegetarian."),
    ]);
    const r = await runAgent({ ...base, model: p.fn });
    const applied = r.transcript.find((e) => e.role === "tool" && e.name === "apply");
    check("loop: engine notes are fed BACK to the model, not only to the user",
      Boolean(applied) && Array.isArray((applied as { result: { notes: string[] } }).result.notes));
    check("loop: a write is applied through the engine", r.planChanged === true);
    check("loop: a write takes exactly one undo snapshot", Boolean(r.previous));
    check("loop: the vegetarian constraint actually held",
      r.plan.days.every((d) => d.meals.every((m) => !/chicken|beef|salmon|turkey|pork|prawn|shrimp|cod/i.test(m.name))),
      r.plan.days[0].meals.map((m) => m.name).join(" | "));
  }

  // 3. never stops asking -> MAX_STEPS holds, and the user is TOLD
  {
    const p = scripted([turn("", [{ op: "get_plan" } as unknown as PrimitiveOp])]); // same turn forever
    const r = await runAgent({ ...base, model: p.fn, maxSteps: 4 });
    check("loop: a model that never stops is capped", r.steps === 4 && r.gaveUp, `steps ${r.steps}`);
    check("loop: hitting the cap is disclosed rather than hidden",
      /without finishing/i.test(r.reply), r.reply.slice(0, 70));
  }

  // 4. emits garbage -> degrades to a plain reply instead of throwing
  {
    const bad: ModelFn = async () => ({ thinking: "", reply: "I think so.", operations: "nope" as unknown as PrimitiveOp[] });
    const r = await runAgent({ ...base, model: bad });
    check("loop: malformed operations degrade to a reply, not an exception",
      r.steps === 1 && r.planChanged === false && r.reply.length > 0, r.reply.slice(0, 40));

    const thrower: ModelFn = async () => { throw new Error("model offline"); };
    const r2 = await runAgent({ ...base, model: thrower });
    check("loop: a model that throws is reported honestly, not as success",
      /couldn't reach/i.test(r2.reply), r2.reply.slice(0, 60));
    check("loop: a failed model leaves the plan untouched", r2.plan === plan);
  }

  // 5. emits ops the engine refuses -> the refusal reaches the model, which can change course
  {
    const p = scripted([
      // a vegan asking to use salmon: the engine must refuse, and SAY so
      turn("", [{ op: "constrain", diet: "vegan" } as unknown as PrimitiveOp,
                { op: "swap", day: "Monday", mealType: "dinner", dish: "Baked Salmon & Potatoes" } as unknown as PrimitiveOp]),
      turn("I couldn't use salmon on a vegan week."),
    ]);
    const r = await runAgent({ ...base, model: p.fn });
    const applied = r.transcript.find((e) => e.role === "tool" && e.name === "apply") as
      | { result: { notes: string[] } } | undefined;
    check("loop: a refusal is visible to the model in the transcript",
      Boolean(applied) && applied!.result.notes.length > 0,
      applied?.result.notes.join(" | ").slice(0, 80) ?? "(none)");
    check("loop: the hard rule still wins — no salmon on a vegan week",
      r.plan.days.every((d) => d.meals.every((m) => !/salmon/i.test(m.name))));
  }

  // A reply may not claim a change the engine did not make (models lane, 2026-10-03). With reasoning
  // off, a fast model imitated the engine's note style and wrote "Wednesday now has 2000 kcal…" with no
  // operation at all. The loop gives it ONE more step to send the operation or retract; if it still
  // claims a change, the user reads an honest line instead.
  {
    // The detector, on the models lane's stored turns: every fabrication caught, no honest reply tripped.
    const FABRICATED = [
      "Wednesday now has 2000 kcal and 144g protein. Fat comes to 82g against about 65g.",
      "Done — dinner is now a lighter portion of Chicken & Vegetable Stir-Fry with Rice. Monday still hits 2000 kcal and 150g protein.",
      "Done — breakfast is off the menu.",
      "Done — I've made your week breakfast-free.",
      "Done — I've swapped your B12 meals for fortified options and kept you vegan.",
      "Done — I've made your breakfast egg-free.",
      "No eggs, no problem — I’ve swapped them out of tomorrow's breakfast…",
      "Done — I've raised the protein target for every breakfast to 55 g.",
    ];
    const HONEST = [
      "I'd be glad to help. The plan right now averages about 2000 kcal a day. For weight loss we'd typically create a deficit — but the right number depends on you. Do you have a calorie target in mind, or …",
      "Your plan currently averages 2000 kcal a day.",
      "Want me to make Wednesday vegetarian too?",
      "Here are three vegan options.",
      "I couldn't use salmon on a vegan week.",
      "Nothing has changed yet — want me to make breakfast egg-free?",
    ];
    const missed = FABRICATED.filter((t) => !claimsChange(t));
    const tripped = HONEST.filter((t) => claimsChange(t));
    check("false claim: claimsChange catches every stored fabrication", missed.length === 0, missed.join(" | "));
    check("false claim: ...and trips on no honest reply (\"right now averages\" is a description)", tripped.length === 0, tripped.join(" | "));

    // composeReply: only a caller that KNOWS nothing changed gets the guard; the legacy routes are untouched.
    const claim = "Done — I've made your breakfast egg-free.";
    check("false claim: composeReply replaces an unbacked claim when it knows nothing changed",
      composeReply({ modelReply: claim, notes: [], planChanged: false, profileChanged: false }) === NOTHING_CHANGED_REPLY);
    check("false claim: ...never when the engine has notes (the notes are the reply)",
      composeReply({ modelReply: claim, notes: ["Your breakfasts are egg-free now."], planChanged: false, profileChanged: false }) === "Your breakfasts are egg-free now.");
    check("false claim: ...never when the profile DID change",
      composeReply({ modelReply: claim, notes: [], planChanged: false, profileChanged: true }) === claim);
    check("false claim: ...and never for a caller that cannot tell (profileChanged undefined)",
      composeReply({ modelReply: claim, notes: [], planChanged: false }) === claim);

    // 1. Claim, then fix it: the nudge reaches the model, the operation runs, the engine speaks.
    {
      const p = scripted([
        turn("Done — I've made your week vegetarian."),
        turn("", [{ op: "constrain", diet: "vegetarian" } as unknown as PrimitiveOp]),
        turn("Your week is vegetarian now."),
      ]);
      const r = await runAgent({ ...base, model: p.fn });
      const nudge = r.transcript.find((e) => e.role === "tool" && e.name === "apply" &&
        (e as { result: { notes: string[] } }).result.notes.includes(FALSE_CLAIM_NUDGE));
      check("false claim, fixed: the model is told nothing was applied (in the transcript, not to the user)",
        Boolean(nudge) && !r.reply.includes("Nothing was applied"));
      check("false claim, fixed: the operation it then sends really runs", r.planChanged === true && r.falseClaimRetried && !r.falseClaimCaught,
        `steps ${r.steps}, planChanged ${r.planChanged}`);
      check("false claim, fixed: the reply is the engine's, so it is true",
        r.notes.length > 0 && r.reply === [...new Set(r.notes.map((n) => n.trim()).filter(Boolean))].join(" "), r.reply.slice(0, 80));
    }
    // 2. Claim twice: the user reads the honest line, and the run says it was caught.
    {
      const p = scripted([turn("Wednesday now has 2000 kcal and 144g protein.")]); // the same claim, forever
      const r = await runAgent({ ...base, model: p.fn });
      check("false claim, repeated: the user reads that nothing changed", r.reply === NOTHING_CHANGED_REPLY, r.reply.slice(0, 80));
      check("false claim, repeated: one retry only, then stop", r.steps === 2 && p.calls() === 2 && r.falseClaimRetried && r.falseClaimCaught, `steps ${r.steps}`);
      check("false claim, repeated: the plan is untouched and not reported as changed", r.plan === plan && r.planChanged === false);
    }
    // 3. Claim, then retract: the honest retraction is the reply.
    {
      const p = scripted([
        turn("Done — I've made your breakfast egg-free."),
        turn("Nothing has changed yet — want me to make breakfast egg-free?"),
      ]);
      const r = await runAgent({ ...base, model: p.fn });
      check("false claim, retracted: the model's own honest reply stands",
        r.reply === "Nothing has changed yet — want me to make breakfast egg-free?" && !r.falseClaimCaught, r.reply);
    }
    // 4. An honest answer is never retried — no extra model call, no extra cost.
    {
      const p = scripted([turn("Your plan currently averages 2000 kcal a day.")]);
      const r = await runAgent({ ...base, model: p.fn });
      check("false claim: an honest no-op answer costs exactly one call", r.steps === 1 && p.calls() === 1 && !r.falseClaimRetried);
    }
    // 5. A step cap of 1 leaves no room to retry: the honest line still replaces the claim.
    {
      const p = scripted([turn("Done — breakfast is off the menu.")]);
      const r = await runAgent({ ...base, model: p.fn, maxSteps: 1 });
      check("false claim: with no step left to retry, the claim is still never shown",
        r.reply === NOTHING_CHANGED_REPLY && r.steps === 1, r.reply.slice(0, 60));
    }
  }

  // the loop must not quietly break the contract the rest of the app depends on
  {
    // Not "All set.": with nothing changed, that is itself an unbacked claim and gets one retry (below).
    const p = scripted([turn("Happy to help.")]);
    const r = await runAgent({ ...base, model: p.fn });
    check("loop: a turn with no operations ends immediately", r.steps === 1);
    check("loop: the transcript keeps the user message first", r.transcript[0].role === "user");
    check("loop: MAX_STEPS defaults to the specified 8", MAX_STEPS === 8);
  }

  // 6. undo THROUGH the loop: the loop threads `previous` so an undo verb restores the pre-write
  //    plan — and one level only, so after an undo there is nothing further back.
  {
    const w = scripted([turn("", [{ op: "constrain", diet: "vegetarian" } as unknown as PrimitiveOp]), turn("done")]);
    const r1 = await runAgent({ ...base, model: w.fn });
    const u = scripted([turn("", [{ op: "undo" } as unknown as PrimitiveOp]), turn("reverted")]);
    const r2 = await runAgent({
      profile: r1.profile, plan: r1.plan, message: "undo that", today: base.today,
      previous: r1.previous, model: u.fn,
    });
    check("loop: undo restores the plan captured before the write",
      Boolean(r1.previous) && JSON.stringify(r2.plan.days) === JSON.stringify(r1.previous!.plan.days));
    check("loop: undo actually reverted the vegetarian week",
      JSON.stringify(r2.plan.days) !== JSON.stringify(r1.plan.days));
    check("loop: after an undo there is nothing further back", r2.previous === undefined);
  }

  // 7. one turn carrying BOTH a read and a write: both run in a single step — the read's result
  //    reaches the model (a tool entry) and the write is applied.
  {
    const p = scripted([
      turn("", [
        { op: "find_recipes", diet: "vegetarian", limit: 2 } as unknown as PrimitiveOp,
        { op: "constrain", diet: "vegetarian" } as unknown as PrimitiveOp,
      ]),
      turn("looked, then applied"),
    ]);
    const r = await runAgent({ ...base, model: p.fn });
    const tools = r.transcript.filter((e) => e.role === "tool");
    check("loop: a read and a write in the same turn both run",
      tools.some((e) => e.name === "find_recipes") && tools.some((e) => e.name === "apply") && r.planChanged);
  }

  // 8. a remember op marks the profile changed, so the caller persists the new memory even on a
  //    plan-unchanged turn.
  {
    const p = scripted([turn("", [{ op: "remember", fact: "lactose intolerant", kind: "allergy" } as unknown as PrimitiveOp]), turn("noted")]);
    const r = await runAgent({ ...base, model: p.fn });
    check("loop: a remember op marks the profile changed", r.profileChanged === true);
  }

  // A MODEL THAT CANNOT BE REACHED. The loop swallows the error so that work the engine already
  // finished survives — but it has to REPORT it, because the caller has to tell an offline
  // provider apart from a finished turn. It could not: a stopped LM Studio came back from
  // /api/assistant-v2 as an ordinary 200 reading "1 of 8 steps", and the 503 assertion in
  // test:api was consequently unreachable. These pin the distinction down.
  {
    const dead: ModelFn = async () => {
      throw new Error("fetch failed");
    };
    const r = await runAgent({ ...base, model: dead });
    check("loop: a model that throws sets modelFailed", r.modelFailed === true);
    check("loop: ...and changes nothing", !r.planChanged && !r.profileChanged);
    check("loop: ...and says so rather than inventing a reply",
      /couldn't reach|could not reach/i.test(r.reply), r.reply.slice(0, 70));
    check("loop: ...and is not reported as giving up (that means the step cap)", r.gaveUp === false);
  }

  // The other half: the model dies AFTER the engine has already carried out a write. The change is
  // real and must be kept, so this is not a failed run — but modelFailed still has to be true, or
  // a half-finished turn is indistinguishable from a complete one.
  {
    // `resize` and not `regenerate_week`: the primitive vocabulary is swap/resize/pin/rate/log/…
    // and has no regenerate. An unknown op is ignored by design, so the first draft of this test
    // wrote nothing and then asserted a change had been kept — it failed, correctly, and the TEST
    // was the thing that was wrong. `resize` bigger changes the plan deterministically, which also
    // keeps this off the random-week dice that lesson 37 is about.
    let calls = 0;
    const diesAfterWriting: ModelFn = async () => {
      calls++;
      if (calls === 1) {
        return turn("", [{ op: "resize", direction: "bigger", day: "Monday" } as unknown as PrimitiveOp]);
      }
      throw new Error("ECONNREFUSED");
    };
    const r = await runAgent({ ...base, model: diesAfterWriting });
    check("loop: a model dying mid-run still reports modelFailed", r.modelFailed === true);
    check("loop: ...but KEEPS the change the engine already made", r.planChanged === true);
    check("loop: ...and still offers the undo snapshot for it", Boolean(r.previous));
  }

  // The ordinary path must not claim failure.
  {
    const p = scripted([turn("All done.")]);
    const r = await runAgent({ ...base, model: p.fn });
    check("loop: a clean run reports modelFailed false", r.modelFailed === false);
  }
}

// ---------------------------------------------------------------- report
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
