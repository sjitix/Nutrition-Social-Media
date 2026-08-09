import { selectWeekFromDb } from "@/lib/recipeDb";
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
  maxIngredients: 8,
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
  const week = selectWeekFromDb(DEMO);
  const days = week.days.map((d) => ({
    day: d.day,
    short: d.day.slice(0, 3),
    meals: d.meals,
    kcal: d.meals.reduce((s, m) => s + m.calories, 0),
    protein: d.meals.reduce((s, m) => s + m.proteinGrams, 0),
    fibre: d.meals.reduce((s, m) => s + (m.fiberGrams ?? 0), 0),
  }));
  return {
    days,
    avgKcal: Math.round(days.reduce((s, d) => s + d.kcal, 0) / days.length),
    avgProtein: Math.round(days.reduce((s, d) => s + d.protein, 0) / days.length),
    avgFibre: Math.round(days.reduce((s, d) => s + d.fibre, 0) / days.length),
    lowest: days.reduce((a, b) => (b.protein < a.protein ? b : a)),
  };
}
