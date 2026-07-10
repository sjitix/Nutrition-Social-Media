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
import { microsForIngredients } from "@/lib/nutrients";
import { haystackBlocked, dietTagConflicts, parseExclusionTokens } from "@/lib/exclusions";
import { bmr, computeTargets } from "@/lib/targets";
import { composeReply, planWasChanged, READ_ONLY_TOOLS } from "@/lib/reply";
import { SUBSTITUTES } from "@/lib/substitutions";
import { NUTRIENT_TABLE } from "@/lib/nutrientTable.generated";
import { gramsFor } from "@/lib/nutrients";
import { MICRO_KEYS, DAILY_REFERENCE, MICRO_LABEL } from "@/lib/nutrients";

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
  check("eating_out tells the user what to ORDER", /order something with roughly \d+g/i.test(d.note), d.note.slice(0, 120));

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

  // The macro delta must be arithmetic on the real portion, not a vibe. Read the note for WHICH
  // meal and WHICH ingredient it actually used — it may match "egg" where we asked for "eggs", and
  // hard-coding the meal made this test break whenever recipe selection changed.
  const eggNote = sub("eggs").notes.join(" ");
  const m = /instead of the (.+?) (?:of )?([a-z ]+?) in (\w+)'s (\w+)/.exec(eggNote);
  if (m) {
    const [, qty, ingName, dayName, slot] = m;
    const meal = plan.days.find((d) => d.day === dayName)!.meals.find((x) => x.type === slot)!;
    const ing = meal.ingredients.find((i) => i.name.trim().toLowerCase() === ingName.trim());
    const g = ing ? gramsFor(ingName.trim(), ing.quantity) : null;
    const sub0 = NUTRIENT_TABLE[ingName.trim()]?.per100g.cal ?? 0;
    const sub1 = NUTRIENT_TABLE["egg whites"]?.per100g.cal ?? 0;
    if (g) {
      const dCal = Math.abs(Math.round(((sub1 - sub0) * g) / 100));
      check("substitute_ingredient's calorie delta is computed from the real portion",
        dCal < 15 || eggNote.includes(`${dCal} `), `note said "${eggNote.slice(0, 70)}", recomputed ${dCal} from ${qty}`);
    }
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

  check("an ordinary turn keeps the model's reply and appends the engine's facts",
    composeReply({ modelReply: "Done!", notes: ["Your week averages 2000 kcal."], planChanged: true }) === "Done! Your week averages 2000 kcal.");

  check("filler never introduces the engine's facts",
    composeReply({ modelReply: "", notes: ["You're low on vitamin D."], planChanged: false }) === "You're low on vitamin D.");

  check("a silent model with nothing to report still says something",
    composeReply({ modelReply: "", notes: [], planChanged: false }) === "Happy to help.");
  check("a silent model that changed the plan says so",
    composeReply({ modelReply: "", notes: [], planChanged: true }) === "Done — I updated your plan.");

  // Read-only tools must not make the UI think the week was rewritten.
  for (const t of ["answer", "weekly_report", "explain_meal", "substitute_ingredient", "symptom_check"])
    check(`${t} does not flag the plan as changed`, !planWasChanged([op({ tool: t as Operation["tool"] })]));
  for (const t of ["update_profile", "regenerate_week", "regenerate_day", "swap_meal", "compute_targets", "log_meal", "eating_out"])
    check(`${t} flags the plan as changed`, planWasChanged([op({ tool: t as Operation["tool"] })]));

  // Every tool in the schema must be classified deliberately, one way or the other.
  const ALL = ["update_profile", "regenerate_week", "regenerate_day", "swap_meal", "compute_targets",
    "log_meal", "weekly_report", "eating_out", "explain_meal", "substitute_ingredient", "symptom_check", "answer"];
  const unclassified = ALL.filter((t) => !READ_ONLY_TOOLS.has(t) && !planWasChanged([op({ tool: t as Operation["tool"] })]));
  check("no tool is left unclassified", unclassified.length === 0, unclassified.join(", "));
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
  for (const d of plan.days)
    for (const m of d.meals) {
      const note = applyOperations(BASE, plan, [op({ tool: "explain_meal", day: d.day, mealType: m.type })]).notes.join(" ");
      const claimed = /it carries (\d+)g of fiber/.exec(note)?.[1];
      if (claimed) check(`explain_meal quotes the served fiber for ${m.name}`, Number(claimed) === m.fiberGrams, `said ${claimed}, served ${m.fiberGrams}`);
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

  // Every diet needs enough recipes to fill a week without repeating a dish.
  for (const diet of ["vegan", "vegetarian", "keto", "mediterranean"] as const) {
    for (const type of ["breakfast", "lunch", "dinner"] as const) {
      const n = RECIPES.filter((r) => !r.treatOnly && r.type === type && dietOk(r.dietTags, diet)).length;
      check(`${diet}: at least 7 ${type}s so a week never repeats`, n >= 7, `${n} available`);
    }
  }
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
  if (roll < 0.34)
    return op({ tool: "swap_meal", day: pick(DAYS_L), mealType: pick(MEALS_L), dish: pick(DISHES_L), preserveMacros: Math.random() < 0.3 ? false : null });
  if (roll < 0.52) return op({ tool: "regenerate_day", day: pick(DAYS_L), diet: Math.random() < 0.4 ? pick(DIETS_L) : null });
  if (roll < 0.67) return op({ tool: "regenerate_week" });
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

// ---------------------------------------------------------------- report
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
