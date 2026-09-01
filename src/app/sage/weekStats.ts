import type { WeekPlan } from "@/lib/types";

/**
 * Derive the display figures for a week — totals per day, weekly averages, the weakest day.
 *
 * This lives apart from `demo.ts` for one reason: `demo.ts` imports the engine, and the engine
 * carries all 501 recipes. The assistant screen is a CLIENT component that has to recompute these
 * figures after the agent changes the plan, and importing `demo.ts` to do it would serialise the
 * whole recipe database into the browser bundle. Nothing here imports anything but a type, so it
 * costs the client nothing.
 *
 * It is also the only copy of this arithmetic. `demo.ts` used to hold its own inline version; two
 * implementations of "the average protein this week" is exactly the drift this project keeps
 * writing rules against, so there is now one, and both callers use it.
 */
export interface DayStats {
  day: string;
  short: string;
  meals: WeekPlan["days"][number]["meals"];
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  fibre: number;
}

export interface WeekStats {
  days: DayStats[];
  avgKcal: number;
  avgProtein: number;
  avgCarbs: number;
  avgFat: number;
  avgFibre: number;
  lowest: DayStats;
  /** Distinct dishes across the week — the number that says whether the week is actually varied. */
  uniqueDishes: number;
}

export function summariseWeek(week: WeekPlan): WeekStats {
  const days: DayStats[] = week.days.map((d) => ({
    day: d.day,
    short: d.day.slice(0, 3),
    meals: d.meals,
    kcal: d.meals.reduce((s, m) => s + m.calories, 0),
    protein: d.meals.reduce((s, m) => s + m.proteinGrams, 0),
    carbs: d.meals.reduce((s, m) => s + m.carbsGrams, 0),
    fat: d.meals.reduce((s, m) => s + m.fatGrams, 0),
    fibre: d.meals.reduce((s, m) => s + (m.fiberGrams ?? 0), 0),
  }));
  const avg = (pick: (d: DayStats) => number) =>
    Math.round(days.reduce((s, d) => s + pick(d), 0) / Math.max(1, days.length));
  return {
    days,
    avgKcal: avg((d) => d.kcal),
    avgProtein: avg((d) => d.protein),
    avgCarbs: avg((d) => d.carbs),
    avgFat: avg((d) => d.fat),
    avgFibre: avg((d) => d.fibre),
    lowest: days.reduce((a, b) => (b.protein < a.protein ? b : a)),
    uniqueDishes: new Set(days.flatMap((d) => d.meals.map((m) => m.name))).size,
  };
}
