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
import { selectWeekFromDb, rebalanceWeek, applyOperations, RECIPES, recipeMicros, newReport, reportNotes } from "@/lib/recipeDb";
import type { UserProfile, Operation, DayPlan, WeekPlan, Meal } from "@/lib/types";
import { MealSchema } from "@/lib/types";
import { FEED_RECIPES, filterFeed, sortFeed, HIGH_PROTEIN_G, type FeedFilter } from "@/lib/feed";
import { videoPlatform, extractVideoText } from "@/lib/videoImport";
import { aisleFor, groupByAisle, AISLE_ORDER } from "@/lib/grocery";
import { currentStreak, prevDay, isoDay } from "@/lib/streak";
import { expandConstrain, applyRemember, applyPrimitives, memoryContext, AssistantTurnV2Schema, type PrimitiveOp } from "@/lib/primitives";
import { assistantV2SystemPrompt } from "@/lib/promptV2";
import { validateExample, validateBatch, type TrainingExample } from "@/lib/dataValidate";
import { generateExamples } from "@/lib/genV2";
import { microsForIngredients } from "@/lib/nutrients";
import { haystackBlocked, dietTagConflicts, parseExclusionTokens } from "@/lib/exclusions";
import { bmr, computeTargets, hydrationTarget } from "@/lib/targets";
import { composeReply, planWasChanged, describeOperations, READ_ONLY_TOOLS } from "@/lib/reply";
import { SUBSTITUTES } from "@/lib/substitutions";
import { NUTRIENT_TABLE } from "@/lib/nutrientTable.generated";
import { gramsFor } from "@/lib/nutrients";
import { MICRO_KEYS, DAILY_REFERENCE, MICRO_LABEL } from "@/lib/nutrients";
import { parseRecipeHtml, parseIngredient, isSafePublicUrl, importedToMeal } from "@/lib/import";
import {
  findRecipes, inspectRecipe, getPlan, getProfile, getSaved, report, whatIf,
  runReadTool, isReadTool, READ_TOOL_NAMES, MAX_ROWS,
} from "@/lib/agentTools";

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
      for (const t of tokens)
        if (hay.includes(t)) v.push(`I2 ${d.day} "${m.name}": contains excluded/allergen "${t}"`);

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
  check("swap: emits an honest macro note", r.notes.length === 1 && /protein/.test(r.notes[0]), r.notes[0] ?? "(none)");
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
}
{
  // The tool must refuse to invent a body weight.
  const wk = freshWeek(BASE);
  const partial = applyOperations(BASE, wk, [op({ tool: "compute_targets", age: 30, heightCm: 180 } as never)]);
  check("missing facts -> asks, never guesses", partial.notes.some((n) => /I need your/.test(n)) && partial.profile.targetCalories === 2000, partial.notes[0] ?? "(none)");

  const full = applyOperations(BASE, wk, [op({ tool: "compute_targets", age: 30, heightCm: 180, weightKg: 80, sex: "male", activity: "moderate", goal: "build_muscle" } as never)]);
  check("full facts -> profile targets are set", full.profile.targetCalories > 2900 && full.profile.proteinGrams === 152, `${full.profile.targetCalories} kcal, ${full.profile.proteinGrams}g protein`);
  check("compute_targets explains itself in plain English", full.notes.some((n) => /resting burn/.test(n)), (full.notes[0] ?? "").slice(0, 90));
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
  const meaty = /chicken|beef|pork|turkey|salmon|tuna|shrimp|fish|egg|yogurt|cheese|milk/i.test(names(d));
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

  check("engine notes are authoritative — the model's prose is dropped so it can never duplicate them",
    composeReply({ modelReply: "Done — kept Monday on target.", notes: ["Kept Monday on target — about 1993 kcal."], planChanged: true }) === "Kept Monday on target — about 1993 kcal.");

  check("filler never introduces the engine's facts",
    composeReply({ modelReply: "", notes: ["You're low on vitamin D."], planChanged: false }) === "You're low on vitamin D.");

  check("a silent model with nothing to report still says something",
    composeReply({ modelReply: "", notes: [], planChanged: false }) === "Happy to help.");
  check("a silent model that changed the plan says so",
    composeReply({ modelReply: "", notes: [], planChanged: true }) === "Done — I updated your plan.");

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
    const pinnedThere = applyOperations(BASE, plan, [op({ tool: "lock_meal", day: "Monday", mealType: hitSlot })]).profile;
    const swapNoType = applyOperations(pinnedThere, plan, [op({ tool: "swap_meal", day: "Monday", dish: "salmon" })]);
    check("a swap with no mealType still removes the pin it replaced",
      (swapNoType.profile.lockedMeals ?? []).length === 0, `slot ${hitSlot}`);
    check("...and a pin on a DIFFERENT slot survives that swap", (() => {
      const other = (["breakfast", "lunch", "dinner"] as const).find((t) => t !== hitSlot)!;
      const pinnedElsewhere = applyOperations(BASE, plan, [op({ tool: "lock_meal", day: "Monday", mealType: other })]).profile;
      const r2 = applyOperations(pinnedElsewhere, plan, [op({ tool: "swap_meal", day: "Monday", dish: "salmon" })]);
      return (r2.profile.lockedMeals ?? []).length === 1;
    })());
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
  const changed = applyOperations(BASE, plan, [op({ tool: "regenerate_week" })]);
  check("regenerate_week really does change the plan (control)", JSON.stringify(changed.plan) !== JSON.stringify(plan));
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
  check("streak: isoDay formats UTC", isoDay(new Date(Date.UTC(2026, 7, 4))) === "2026-08-04");

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

// ---------------------------------------------------------------- report
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
