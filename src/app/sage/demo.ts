import { applyOperations, selectWeekFromDb } from "@/lib/recipeDb";
import type { UserProfile } from "@/lib/types";

/**
 * The fixed profile every /sage screen renders from.
 *
 * Kept in one place so Home, Plan, Groceries and Assistant all describe the SAME week —
 * if each page generated its own, the calorie average on Home would disagree with the
 * board on Plan, which is the sort of quiet inconsistency that makes a design look wrong
 * for reasons nobody can name.
 *
 * Fixed rather than read from storage so the pages stay server components and show the
 * same week to anyone evaluating the design.
 */
export const DEMO: UserProfile = {
  goal: "maintain",
  diet: "none",
  allergies: "",
  dislikes: "",
  budget: "medium",
  mealsPerDay: 3,
  targetCalories: 2000,
  proteinGrams: 150,
  carbsGrams: 200,
  fatGrams: 65,
  maxCookTime: 30,
  // 8 was excluding the food this design is built around. The selector keeps recipes with
  // `ingredients.length <= maxIngredients + 1`, so a loaded twelve-ingredient bowl — which is what
  // a poke bowl is — could never be chosen, and the one dish with a cut-out photograph would never
  // appear on the screen composed around it. This is a design fixture, not a user's setting; the
  // real app takes the number from onboarding.
  maxIngredients: 12,
  /**
   * One pinned meal, through the engine's own `lock_meal` mechanism rather than by special-casing
   * anything in a component.
   *
   * The reason is photography. `/sage/today` is composed around a plate, and five of 501 recipes
   * are photographed — so whether the screen has a picture on it was down to whether the selector
   * happened to draw one of the five for the day being shown. A pin is a real product feature
   * ("keep every week"), the selector honours it, and every other figure on every other screen
   * still comes out of the same solver with the same guarantees.
   *
   * Monday, because that is the day Today displays — see the note in `today/page.tsx`. Pinning it
   * on all seven would put the same lunch in the plan seven times, which the Week screen would
   * (rightly) show as a plan with no variety.
   */
  lockedMeals: [{ day: "Monday", mealType: "lunch", name: "Chicken & Egg Poke Bowl" }],
};

export const SLOTS = ["Breakfast", "Lunch", "Dinner", "Snack"] as const;

/**
 * Computed ONCE at module load, not per call.
 *
 * `selectWeekFromDb` randomises its selection, so calling it from each page gave every tab a
 * different week: Home said Saturday was 59 g short, Plan said Thursday 52 g, and the assistant
 * offered to fix Wednesday. Nothing was broken in the engine — the pages were simply describing
 * three different weeks, which is the kind of quiet inconsistency that makes a design feel wrong
 * for reasons nobody can point at.
 *
 * A module-level constant is evaluated once per server process, so every route that imports it
 * gets the identical week. React's `cache()` would not do this — it dedupes within one request,
 * and these are separate navigations.
 */
const WEEK = buildWeek();

export function demoWeek() {
  return WEEK;
}

function buildWeek() {
  // `selectWeekFromDb` RESERVES a pinned dish — it marks it spent so the selector cannot put it in
  // some other slot — but it does not PLACE it. Placement is `reimposeLocks`, which is internal and
  // runs inside `applyOperations`. So the week is built and then regenerated through the public
  // executor, which is the same path the assistant's `regenerate_week` takes: the pin lands, the
  // day is rebalanced around it, and nothing here reaches into the engine's private parts or
  // hand-places a meal behind the solver's back.
  const week = applyOperations(DEMO, selectWeekFromDb(DEMO), [{ tool: "regenerate_week" }]).plan;
  const days = week.days.map((d) => ({
    day: d.day,
    short: d.day.slice(0, 3),
    meals: d.meals,
    kcal: d.meals.reduce((s, m) => s + m.calories, 0),
    protein: d.meals.reduce((s, m) => s + m.proteinGrams, 0),
    carbs: d.meals.reduce((s, m) => s + m.carbsGrams, 0),
    fat: d.meals.reduce((s, m) => s + m.fatGrams, 0),
    fibre: d.meals.reduce((s, m) => s + (m.fiberGrams ?? 0), 0),
  }));
  const avg = (pick: (d: (typeof days)[number]) => number) =>
    Math.round(days.reduce((s, d) => s + pick(d), 0) / days.length);
  return {
    days,
    avgKcal: avg((d) => d.kcal),
    avgProtein: avg((d) => d.protein),
    avgCarbs: avg((d) => d.carbs),
    avgFat: avg((d) => d.fat),
    avgFibre: avg((d) => d.fibre),
    lowest: days.reduce((a, b) => (b.protein < a.protein ? b : a)),
    // Distinct dishes across the week. The board's week is ragged and varied; this is the number
    // that says whether ours actually is, and it is asserted on screen rather than assumed.
    uniqueDishes: new Set(days.flatMap((d) => d.meals.map((m) => m.name))).size,
  };
}
