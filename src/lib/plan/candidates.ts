/**
 * The dishes that could take one slot, each with the delta it would cause — drawn from the same
 * safe pool selection uses, so a candidate the executor would refuse is never offered.
 *
 * Part of the plan engine (src/lib/plan/, layer L3), split out of recipeDb.ts on 2026-10-03 (V1
 * milestone A3). The public surface is ./index.ts; an export here that index.ts does not re-export
 * is internal to this folder, and check:boundaries fails anything outside the folder that imports it.
 */
import { type DayPlan, type Meal, type UserProfile, type WeekPlan } from "../core";
import { budgetCap, exclusionTokens } from "./rules";
import { SCALE_HI, macroDistance, mealMacros, recipeMacros, slotTargetMacros } from "./rebalance";
import { batchCandidates } from "./select";
import { freezesWell, keepDays } from "./batch";

/**
 * The dishes that could take this slot, ranked by how well they fit it, each with the change it
 * would make to the day.
 *
 * This is what a swap control shows. The point is not a list of names — it is a list of CONSEQUENCES:
 * "+8 g protein, −40 kcal, 15 min" lets someone choose between two honest outcomes instead of
 * guessing from a title. Everything here is existing engine logic exposed as one list:
 *
 *  - `batchCandidates` supplies the safe pool. It already applies the diet, the allergen and dislike
 *    exclusions, the cook-time and ingredient-count limits and the budget cap, relaxes them in a
 *    fixed order when nothing qualifies, and drops anything the user rated 1. Writing a second
 *    filter here is how a swap list ends up offering a peanut dish to a peanut allergy.
 *  - `slotTargetMacros` and `macroDistance` do the ranking, so "fits this slot" means the same thing
 *    here as it does during generation.
 *
 * Same-day dishes are excluded outright because a day may not repeat a dish (invariant I4) — the
 * list must not offer a move the executor will refuse. Dishes used elsewhere in the week are kept
 * but flagged, since repeating one across the week is a preference, not a rule.
 *
 * The deltas are computed HERE rather than in the browser: the client does no macro arithmetic, so
 * there is no second opinion about what a swap would cost.
 */
export function swapCandidates(
  profile: UserProfile,
  plan: WeekPlan,
  day: DayPlan["day"],
  mealType: Meal["type"],
  limit = 6,
  /**
   * "I want at least this much protein in this meal." Narrows the pool before ranking, so the list
   * answers the question that was asked instead of the one the ranking would have answered.
   * Deliberately a FLOOR, not a target: someone asking for 45 g is not asking to be given 44.
   */
  minProtein?: number,
): {
  current: { name: string; calories: number; protein: number } | null;
  /** What this slot is aiming at, so the UI can say "closer to target" without deciding what that means. */
  slotTarget: { calories: number; protein: number };
  /**
   * Whether resizing the dish already in the slot could reach `minProtein` on its own, and what that
   * would cost in calories. The engine clamps a portion to 1.8x, so this is a real limit rather than
   * a preference — and when it IS reachable, resizing beats swapping, because the person keeps the
   * meal they were going to cook. Null when no floor was asked for or there is nothing in the slot.
   */
  resizeReaches: { possible: boolean; atFactor: number; protein: number; calories: number } | null;
  rows: {
    name: string;
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
    fibre: number;
    minutes: number;
    /** Against the dish currently in the slot — what the day's totals would move by. */
    deltaKcal: number;
    deltaProtein: number;
    /** Days it keeps for, and whether it freezes — the meal-prep facts, useful on any plan. */
    keepsDays: number;
    freezesWell: boolean;
    /** Already somewhere else in this week. Allowed, but worth saying. */
    elsewhereThisWeek: boolean;
    /**
     * Whether this dish sits CLOSER to the slot's macro target than the one in the slot now.
     *
     * Worth stating because the ranking is multi-dimensional: it weighs protein, carbs, fat and
     * fibre as well as calories, so the best-fitting dish overall can still be further off on
     * calories than what is already there. Without this flag a reader sees "-47 kcal" and cannot
     * tell whether that is an improvement or a regression.
     */
    closerToTarget: boolean;
  }[];
} {
  const theDay = plan.days.find((d) => d.day === day);
  const current = theDay?.meals.find((m) => m.type === mealType) ?? null;
  const target = slotTargetMacros(profile, mealType);

  const sameDay = new Set((theDay?.meals ?? []).map((m) => m.name.toLowerCase()));
  const elsewhere = new Set(
    plan.days.flatMap((d) => (d.day === day ? [] : d.meals.map((m) => m.name.toLowerCase()))),
  );

  const pool = batchCandidates(profile, mealType, budgetCap(profile.budget), exclusionTokens(profile))
    .filter((r) => !sameDay.has(r.name.toLowerCase()))
    .filter((r) => minProtein == null || r.proteinGrams >= minProtein);

  // Can the dish that is already there get the user what they asked for? SCALE_HI is the engine's
  // own realistic ceiling, so this answers with the same limit the executor would enforce.
  const resizeReaches =
    minProtein != null && current
      ? {
          possible: current.proteinGrams * SCALE_HI >= minProtein,
          atFactor: Math.round(Math.min(SCALE_HI, minProtein / Math.max(1, current.proteinGrams)) * 100) / 100,
          protein: Math.round(Math.min(SCALE_HI, minProtein / Math.max(1, current.proteinGrams)) * current.proteinGrams),
          calories: Math.round(Math.min(SCALE_HI, minProtein / Math.max(1, current.proteinGrams)) * current.calories),
        }
      : null;

  const ranked = [...pool].sort(
    (a, b) => macroDistance(recipeMacros(a), target) - macroDistance(recipeMacros(b), target),
  );
  // The dish in the slot now, measured the same way, so "closer" is a comparison and not an opinion.
  const currentDistance = current ? macroDistance(mealMacros(current), target) : Infinity;

  return {
    current: current
      ? { name: current.name, calories: current.calories, protein: current.proteinGrams }
      : null,
    slotTarget: { calories: Math.round(target.cal), protein: Math.round(target.protein) },
    resizeReaches,
    rows: ranked.slice(0, limit).map((r) => ({
      name: r.name,
      calories: r.calories,
      protein: r.proteinGrams,
      carbs: r.carbsGrams,
      fat: r.fatGrams,
      fibre: r.fiberGrams ?? 0,
      minutes: r.timeMinutes,
      deltaKcal: r.calories - (current?.calories ?? 0),
      deltaProtein: r.proteinGrams - (current?.proteinGrams ?? 0),
      keepsDays: keepDays(r),
      freezesWell: freezesWell(r),
      elsewhereThisWeek: elsewhere.has(r.name.toLowerCase()),
      closerToTarget: macroDistance(recipeMacros(r), target) < currentDistance,
    })),
  };
}
