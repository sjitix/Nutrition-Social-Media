/**
 * Hold a day or a week on its macro targets by moving PORTIONS (lever 1) and, where allowed,
 * replacing one weak meal with a stronger same-slot recipe (lever 2). Portion scale stays in
 * 0.6–1.8x (I6). `replaceOthers: false` turns lever 2 off for a change the user scoped.
 *
 * Part of the plan engine (src/lib/plan/, layer L3), split out of recipeDb.ts on 2026-10-03 (V1
 * milestone A3). The public surface is ./index.ts; an export here that index.ts does not re-export
 * is internal to this folder, and check:boundaries fails anything outside the folder that imports it.
 */
import { type Meal, type UserProfile, type WeekPlan } from "../core";
import { type Recipe } from "../data";
import { RECIPES, baseRecipeOf, scaleQuantity, scaleRecipeToTarget, toMeal } from "./library";
import { bannedForUser, blockedByExclusions, budgetCap, exclusionTokens, localSplit, passesDiet } from "./rules";

// --- Macro engine (the nutritionist substrate) -----------------------------
// The LLM decides WHAT to do (swap this, regenerate that) and WHETHER to stay on
// the macro targets; this code just does the math reliably once asked. After an
// edit we RE-SOLVE the day so its totals still hit the user's macros — portion-
// scaling is the lever (each meal scales within realistic limits), and a small
// gradient descent picks the scale factors that best match the day's
// {calories, protein, carbs, fat, fiber} targets. Add an axis (a vitamin, later)
// and the same solver balances it — no architecture change.

interface Macros {
  cal: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
}

const MACRO_AXES = ["cal", "protein", "carbs", "fat", "fiber"] as const;

// How hard we try to hit each axis. Calories and protein are the two the user
// actually set and notices; carbs/fat/fiber follow. Calories must out-weigh the
// combined carb+fat+fiber pull, otherwise the solver trades calories away to keep
// those three happy and days land short (observed: 1852 kcal vs a 2000 target).
const MACRO_WEIGHTS: Macros = { cal: 4, protein: 3, carbs: 2, fat: 3, fiber: 0.5 };

const DAY_FIBER_TARGET = 30;

 // g/day (no per-user field yet; sensible default)
const SLOT_WEIGHT = 1.5;

 // how hard we keep each meal near its share of the day
export const SCALE_LO = 0.6;

export const SCALE_HI = 1.8;

 // keep portions realistic (matches scaleRecipeToTarget)
export const clampScale = (f: number) => Math.max(SCALE_LO, Math.min(SCALE_HI, f));

export function recipeMacros(r: Recipe): Macros {
  return { cal: r.calories, protein: r.proteinGrams, carbs: r.carbsGrams, fat: r.fatGrams, fiber: r.fiberGrams ?? 0 };
}

export function mealMacros(m: Meal): Macros {
  return { cal: m.calories, protein: m.proteinGrams, carbs: m.carbsGrams, fat: m.fatGrams, fiber: m.fiberGrams ?? 0 };
}

/**
 * Ketosis is judged on NET carbohydrate — total carbs minus fiber, because fiber isn't absorbed.
 * Under 50g net keeps most people in ketosis; 30 is where a dietitian would aim. The solver works
 * in total carbs, so the target it gets is the net target plus the fiber the week carries anyway.
 */
const KETO_NET_CARB_TARGET = 30;

/**
 * The macro targets a day is solved against.
 *
 * A diet is not just a filter on recipes — it is a claim about macros, and for keto the app was
 * only honouring the filter. A keto user kept whatever carb target their onboarding default gave
 * them (200g), the solver dutifully scaled portions toward it, and their "keto" week landed at
 * 42-74g of carbohydrate a day. Keto in name only.
 *
 * So keto sets its own targets: carbs down to 30g, and the calories that frees go to fat, which is
 * exactly the trade the diet is. Protein is left where the user put it. The profile is NOT
 * modified — this is a derived target, so switching off keto restores what they chose.
 */
export function dayTargetMacros(p: UserProfile): Macros {
  const fiber = p.fiberGrams ?? DAY_FIBER_TARGET;
  if (p.diet !== "keto")
    return { cal: p.targetCalories, protein: p.proteinGrams, carbs: p.carbsGrams, fat: p.fatGrams, fiber };

  const carbs = Math.min(p.carbsGrams, KETO_NET_CARB_TARGET + DAY_FIBER_TARGET);
  const fatCalories = p.targetCalories - p.proteinGrams * 4 - carbs * 4;
  return {
    cal: p.targetCalories,
    protein: p.proteinGrams,
    carbs,
    fat: Math.max(p.fatGrams, Math.round(fatCalories / 9)),
    fiber,
  };
}

export function slotShare(p: UserProfile, type: Recipe["type"]): number {
  return localSplit(p.mealsPerDay).find((s) => s[0] === type)?.[1] ?? 1 / p.mealsPerDay;
}

export function slotTargetMacros(p: UserProfile, type: Recipe["type"]): Macros {
  const t = dayTargetMacros(p);
  const s = slotShare(p, type);
  return { cal: t.cal * s, protein: t.protein * s, carbs: t.carbs * s, fat: t.fat * s, fiber: t.fiber * s };
}

// Scale-free weighted distance between a meal/recipe's macros and a target.
export function macroDistance(m: Macros, target: Macros): number {
  let d = 0;
  for (const a of MACRO_AXES) {
    const rel = (m[a] - target[a]) / Math.max(target[a], 1);
    d += MACRO_WEIGHTS[a] * rel * rel;
  }
  return d;
}

// Scale a recipe by an exact factor. Unlike scaleRecipeToTarget (which ignores any
// change under 8% to avoid pointless re-portioning during generation), the rebalancer
// needs its corrections applied verbatim — otherwise small, deliberate adjustments are
// silently discarded and the day drifts off target.
export function scaleRecipeByFactor(r: Recipe, factor: number): Recipe {
  const f = clampScale(factor);
  if (Math.abs(f - 1) < 0.01) return r;
  return {
    ...r,
    calories: Math.round(r.calories * f),
    proteinGrams: Math.round(r.proteinGrams * f),
    carbsGrams: Math.round(r.carbsGrams * f),
    fatGrams: Math.round(r.fatGrams * f),
    ...(r.fiberGrams != null ? { fiberGrams: Math.round(r.fiberGrams * f) } : {}),
    ingredients: r.ingredients.map((i) => ({ ...i, quantity: scaleQuantity(i.quantity, f) })),
  };
}

// LEVER 1 — portion scaling. Re-solve the adjustable meals' portions so the day's
// totals hit the macro targets. `locked` (the meals the user swapped in, or already ate)
// in) keeps its chosen portion; the OTHER meals absorb the difference. Only meals
// traceable to a library recipe are rescaled; anything else is left untouched.
export type LockedSlots = ReadonlySet<Recipe["type"]>;

export function scaleToTargets(meals: Meal[], profile: UserProfile, locked?: LockedSlots): Meal[] {
  const target = dayTargetMacros(profile);
  const adj = meals
    .map((m) => ({ m, base: baseRecipeOf(m) }))
    .filter((x): x is { m: Meal; base: Recipe } => !!x.base && !locked?.has(x.m.type))
    .map((x) => ({ m: x.m, base: x.base, g: clampScale(x.m.calories / x.base.calories) }));
  if (adj.length === 0) return meals;

  // Fixed contribution: meals we won't rescale (the locked meal + any without a base).
  const fixed: Macros = { cal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 };
  for (const m of meals) {
    if (adj.some((a) => a.m === m)) continue;
    const mm = mealMacros(m);
    for (const a of MACRO_AXES) fixed[a] += mm[a];
  }

  // Gradient descent on the scale factors (scale-free weighted squared error).
  const LR = 0.05;
  for (let iter = 0; iter < 300; iter++) {
    const total: Macros = { ...fixed };
    for (const it of adj) {
      const b = recipeMacros(it.base);
      for (const a of MACRO_AXES) total[a] += b[a] * it.g;
    }
    for (const it of adj) {
      const b = recipeMacros(it.base);
      let grad = 0;
      for (const a of MACRO_AXES) {
        const denom = Math.max(target[a], 1);
        grad += MACRO_WEIGHTS[a] * 2 * ((total[a] - target[a]) / (denom * denom)) * b[a];
      }
      // Keep meals a sensible SIZE. Hitting the day's macros by squashing breakfast to its 0.6x
      // floor and inflating dinner to its 1.8x ceiling is arithmetically correct and useless as
      // a meal plan (observed: a 265 kcal breakfast beside a 1084 kcal dinner). Pull each meal
      // toward its slot's share of the day; the macro terms still dominate.
      const want = target.cal * slotShare(profile, it.m.type);
      const have = b.cal * it.g;
      grad += SLOT_WEIGHT * 2 * ((have - want) / (want * want)) * b.cal;
      it.g = clampScale(it.g - LR * grad);
    }
  }

  // Calorie polish (water-filling). The multi-axis descent balances five goals at once and
  // can settle off-target on calories when carbs/fat/fiber pull the other way. Calories are
  // the axis the user actually set, so close the gap directly.
  //
  // Scaling every meal by the same factor is wrong: a meal already pinned at a clamp absorbs
  // none of the correction, so the day stays short even when the others have headroom
  // (observed: lunch pinned at 0.60x while breakfast sat at 1.49x and the day was 350 kcal
  // under). Instead, each round pushes the remaining deficit ONLY onto meals that can still
  // move, and re-checks. Works in both directions (deficit and surplus).
  const adjCal = () => adj.reduce((s, it) => s + recipeMacros(it.base).cal * it.g, 0);
  const wanted = target.cal - fixed.cal;
  for (let t = 0; t < 12 && wanted > 0; t++) {
    const deficit = wanted - adjCal();
    if (Math.abs(deficit) < 5) break; // close enough
    const free = adj.filter((it) => (deficit > 0 ? it.g < SCALE_HI - 1e-6 : it.g > SCALE_LO + 1e-6));
    if (!free.length) break; // everything is clamped: the target is physically unreachable
    const freeCal = free.reduce((s, it) => s + recipeMacros(it.base).cal * it.g, 0);
    if (freeCal <= 0) break;
    const k = (freeCal + deficit) / freeCal;
    for (const it of free) it.g = clampScale(it.g * k);
  }

  const scaled = new Map<Meal, Meal>();
  for (const it of adj) scaled.set(it.m, toMeal(scaleRecipeByFactor(it.base, it.g)));
  return meals.map((m) => scaled.get(m) ?? m);
}

/**
 * Rough order of a day. Used by log_meal: once you've eaten lunch, breakfast and lunch are
 * facts — only the meals still ahead of you can be adjusted.
 */
const MEAL_ORDER: Record<Recipe["type"], number> = { breakfast: 0, lunch: 1, snack: 2, dinner: 3 };

/** Every slot at or before `type` — i.e. everything already eaten. */
export const slotsUpTo = (type: Recipe["type"]): Set<Recipe["type"]> =>
  new Set((Object.keys(MEAL_ORDER) as Recipe["type"][]).filter((t) => MEAL_ORDER[t] <= MEAL_ORDER[type]));

const dayProtein = (meals: Meal[]) => meals.reduce((s, m) => s + m.proteinGrams, 0);

const PROTEIN_SLACK = 8;

 // g/day we'll tolerate before reaching for lever 2

// Re-solve one day onto the macro targets. Two levers, in order — exactly what a
// nutritionist does:
//  1) SCALE the meals' portions to hold calories + macros.
//  2) if the day is still protein-short (scaling can't raise protein at fixed
//     calories), UPGRADE the weakest eligible meal to a higher-protein same-type
//     recipe to "make room" — then scale again.
// `locked` protects meals that must not move: the dish the user swapped in, or every meal
// they have already EATEN today (log_meal). They are never rescaled or upgraded.
// `avoidNames` are dishes used elsewhere in the week, so an upgrade doesn't create a
// cross-day repeat.
// `replaceOthers: false` turns lever 2 off: portions move, dishes do not. A change the user SCOPED
// to one slot ("swap just Wednesday's dinner") is not permission to replace the others — that used
// to replace breakfast and often lunch as well, in 24 of 24 probe scenarios (found by the models
// lane's loop eval, 2026-10-03). Those callers offer the upgrade by name instead of making it.
export function rebalanceDay(
  meals: Meal[],
  profile: UserProfile,
  locked?: LockedSlots,
  avoidNames?: Set<string>,
  opts: { replaceOthers?: boolean } = {},
): Meal[] {
  if (opts.replaceOthers === false) return scaleToTargets(meals, profile, locked);
  let work = meals;
  const split = localSplit(profile.mealsPerDay);
  const cap = budgetCap(profile.budget);
  const tokens = exclusionTokens(profile);
  // At most two upgrades so we change as few meals as needed.
  for (let pass = 0; pass < 2; pass++) {
    const scaled = scaleToTargets(work, profile, locked);
    const gap = profile.proteinGrams - dayProtein(scaled);
    if (gap <= PROTEIN_SLACK) {
      work = scaled;
      break;
    }
    let best: { i: number; r: Recipe; calTarget: number; gap: number } | null = null;
    for (let i = 0; i < work.length; i++) {
      const cur = work[i];
      if (locked?.has(cur.type) || !baseRecipeOf(cur)) continue;
      const share = split.find((s) => s[0] === cur.type)?.[1] ?? 1 / profile.mealsPerDay;
      const calTarget = Math.round(profile.targetCalories * share);
      const usedElsewhere = new Set([
        ...work.filter((_, j) => j !== i).map((x) => x.name.toLowerCase()),
        ...(avoidNames ?? []),
      ]);
      for (const r of RECIPES) {
        if (
          r.type !== cur.type ||
          r.treatOnly || // a protein upgrade must never become a burger
          !passesDiet(r, profile.diet) ||
          blockedByExclusions(r, tokens) ||
          // Chasing protein is no reason to serve a dish the user rejected. If nothing else beats
          // the current meal, `best` stays null and the meal stays — no slot can be emptied here.
          bannedForUser(profile, r.name) ||
          r.approxCost > cap ||
          r.timeMinutes > profile.maxCookTime + 5 ||
          r.ingredients.length > profile.maxIngredients + 1 ||
          usedElsewhere.has(r.name.toLowerCase())
        )
          continue;
        const trial = work.map((x, j) => (j === i ? toMeal(scaleRecipeToTarget(r, calTarget)) : x));
        const trialGap = Math.abs(profile.proteinGrams - dayProtein(scaleToTargets(trial, profile, locked)));
        if (best === null || trialGap < best.gap) best = { i, r, calTarget, gap: trialGap };
      }
    }
    // Stop if the best available upgrade doesn't meaningfully close the gap.
    if (!best || best.gap >= Math.abs(gap) - 2) {
      work = scaled;
      break;
    }
    work = work.map((x, j) => (j === best!.i ? toMeal(scaleRecipeToTarget(best!.r, best!.calTarget)) : x));
  }
  return scaleToTargets(work, profile, locked);
}

// Re-solve every day of a week onto the macro targets. Used for the initial plan
// and after a week/profile change so the plan the user sees respects their macros
// from the start. Threads a running set of used dish names so a protein upgrade on
// one day never introduces a dish already on another day.
export const rebalanceWeek = (plan: WeekPlan, profile: UserProfile): WeekPlan => {
  // Seed with the pinned dishes too. They are not in `plan` yet — the selector was told to skip
  // them — so without this an upgrade is free to spend one on the wrong day.
  const used = new Set([
    ...plan.days.flatMap((d) => d.meals.map((m) => m.name.toLowerCase())),
    ...(profile.lockedMeals ?? []).map((l) => l.name.toLowerCase()),
  ]);
  const days = plan.days.map((d) => {
    const own = new Set(d.meals.map((m) => m.name.toLowerCase()));
    const avoid = new Set([...used].filter((n) => !own.has(n)));
    const meals = rebalanceDay(d.meals, profile, undefined, avoid);
    for (const m of meals) used.add(m.name.toLowerCase());
    return { ...d, meals };
  });
  return { ...plan, days };
};
