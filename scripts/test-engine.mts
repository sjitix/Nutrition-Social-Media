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
import { haystackBlocked, dietTagConflicts } from "@/lib/exclusions";
import { bmr, computeTargets } from "@/lib/targets";
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
function calorieReachable(d: DayPlan, targetCal: number, lockedType?: Meal["type"]): boolean {
  let lo = 0;
  let hi = 0;
  for (const m of d.meals) {
    if (m.type === lockedType) {
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
    if (d.meals.length !== p.mealsPerDay)
      v.push(`I3 ${d.day}: ${d.meals.length} meals, expected ${p.mealsPerDay}`);

    const seen = new Set<string>();
    for (const m of d.meals) {
      if (seen.has(m.name)) v.push(`I4 ${d.day}: duplicate dish "${m.name}"`);
      seen.add(m.name);

      const hay = mealHay(m);
      for (const t of tokens)
        if (hay.includes(t)) v.push(`I2 ${d.day} "${m.name}": contains excluded/allergen "${t}"`);

      // Only a violation if a compliant recipe actually existed to choose instead.
      if (
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
    const lockedHere = locked && locked.day === d.day ? locked.type : undefined;
    if (macrosKept && !treatDays.has(d.day) && calorieReachable(d, p.targetCalories, lockedHere)) {
      const c = kcal(d);
      if (Math.abs(c - p.targetCalories) > p.targetCalories * 0.15) {
        // Include the scale factor each meal ended on: 1.80 means the clamp bound it.
        const detail = d.meals
          .map((m) => {
            const b = recipeByName.get(m.name.toLowerCase());
            const g = b ? (m.calories / b.calories).toFixed(2) : "?";
            return `${m.type}${m.type === lockedHere ? "*" : ""}=${m.calories}kcal(x${g})`;
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
  const cnt = (p: WeekPlan) => p.days.reduce((s, d) => s + d.meals.filter((m) => mealHay(m).includes("salmon")).length, 0);
  // Selection is randomised, so compare MEANS over many runs. Use an ingredient with NO
  // protein-diversity cap: salmon is a "fish" main-protein and is capped at ~3 days/week
  // regardless of the fridge, so the lift is swamped by noise and the test flaps.
  const cntOf = (p: WeekPlan, ing: string) =>
    p.days.reduce((s, d) => s + d.meals.filter((m) => mealHay(m).includes(ing)).length, 0);
  const N = 12;
  let defSum = 0;
  let fridgeSum = 0;
  let salmonPresent = 0;
  for (let i = 0; i < N; i++) {
    const w = freshWeek(BASE);
    defSum += cntOf(w, "broccoli");
    fridgeSum += cntOf(applyOperations(BASE, w, [op({ tool: "regenerate_week", useIngredients: ["broccoli"] })]).plan, "broccoli");
    salmonPresent += cntOf(applyOperations(BASE, w, [op({ tool: "regenerate_week", useIngredients: ["salmon"] })]).plan, "salmon") > 0 ? 1 : 0;
  }
  check("fridge: useIngredients:[broccoli] raises mean usage", fridgeSum / N > defSum / N, `default=${(defSum / N).toFixed(1)} fridge=${(fridgeSum / N).toFixed(1)} over ${N} runs`);
  // The fridge is a strong PREFERENCE, not a guarantee: the protein-diversity cap (fish is
  // limited to ~3 days/week) can crowd salmon out. Asserting "always" claimed a promise the
  // engine never made. Making it a guarantee is tracked in WORKPLAN.md.
  check("fridge: a capped protein (salmon) usually appears when requested", salmonPresent >= N - 1, `${salmonPresent}/${N} runs`);
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

  const dairyAllergy: UserProfile = { ...BASE, allergies: "dairy" };
  const dw = freshWeek(dairyAllergy);
  const dairyHits: string[] = [];
  for (const d of dw.days)
    for (const m of d.meals)
      if (/\b(milk|cheese|yogurt|butter|feta|mozzarella|cheddar|parmesan|ricotta|halloumi)/i.test(mealHay(m))) dairyHits.push(m.name);
  check("allergy 'dairy' blocks cheese/yogurt/milk/butter", dairyHits.length === 0, dairyHits.slice(0, 3).join(", ") || "clean");
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

// ---------------------------------------------------------------- 3. fuzz
console.log("\n--- FUZZ (random op sequences, invariants after each) ---");
const DAYS_L = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
const MEALS_L = ["breakfast", "lunch", "dinner"] as const;
const DISHES_L = ["oatmeal", "pancakes", "salmon", "chicken salad", "omelette", "curry", "stir fry", "tacos", "pizza", "unicorn stew"];
const FOODS_L = ["onion", "mushroom", "olive", "cilantro"];
const DIETS_L = ["none", "vegetarian", "vegan", "mediterranean"] as const;
const pick = <T,>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)];

function randomOp(): Operation {
  const roll = Math.random();
  if (roll < 0.3)
    return op({ tool: "swap_meal", day: pick(DAYS_L), mealType: pick(MEALS_L), dish: pick(DISHES_L), preserveMacros: Math.random() < 0.3 ? false : null });
  if (roll < 0.5) return op({ tool: "regenerate_day", day: pick(DAYS_L), diet: Math.random() < 0.4 ? pick(DIETS_L) : null });
  if (roll < 0.65) return op({ tool: "regenerate_week" });
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
  for (let k = 0; k < nOps; k++) {
    const o = randomOp();
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
