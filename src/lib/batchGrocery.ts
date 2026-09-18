/**
 * Meal-prep bulk shopping + efficiency, derived from a batch WeekPlan. PURE and client-safe (only
 * `gramsFor` from nutrients + `groupByAisle` from grocery), so it runs in the browser without pulling
 * the 501-recipe engine into the bundle.
 *
 * The fresh grocery list (myPlan.groceriesFromWeek) counts how many SLOTS reference an ingredient. A
 * meal-prep list is different: you cook each batch to `totalServings`, so you buy `totalServings`
 * servings' worth of every ingredient — grouped BY COOKING SESSION (one shop per cook).
 *
 * H1 (the trap): a recipe's authored ingredient list makes `recipe.servings` servings (a muffin tin,
 * a tray), while its macros are PER serving. So one serving's ingredients = list / recipe.servings.
 * Bulk grams therefore = gramsFor(quantity) / (meal.servings ?? 1) * batch.totalServings — divide
 * FIRST, or a `servings: 3` recipe over-shops 3x.
 */
import type { WeekPlan, Meal, CookingSession } from "./types";
import { gramsFor } from "./nutrients";
import { groupByAisle, type Aisle } from "./grocery";

export interface BulkRow {
  name: string;
  /** Human pack size ("1.5 kg", "2 × 400 g can", "3 eggs"), or "check amount" when unresolved. */
  quantity: string;
  grams: number;
  /** Set when the quantity couldn't be summed to grams (an odd unit); the row says "check amount". */
  note?: string;
}

export interface SessionGroceries {
  session: CookingSession;
  aisles: { aisle: Aisle; items: BulkRow[] }[];
  /** Fraction of this session's ingredient lines that resolved to grams (1 = fully summed). */
  coverage: number;
}

// Common bulk items sold by count or by a standard pack, so the list reads "3 eggs" / "2 × 400 g can"
// rather than a raw gram weight. Everything else falls back to g / kg.
const BULK_PACKS: { re: RegExp; per: number; unit: (n: number) => string }[] = [
  { re: /\beggs?\b/, per: 55, unit: (n) => `${n} egg${n === 1 ? "" : "s"}` },
  { re: /can|chickpea|black bean|kidney bean|cannellini|butter bean|chopped tomato|tinned|coconut milk/, per: 400, unit: (n) => `${n} × 400 g can${n === 1 ? "" : "s"}` },
];

/** Turn a summed gram weight into a friendly pack size. Rounds UP for count/can packs. */
export function formatBulkQuantity(name: string, grams: number): string {
  const n = name.toLowerCase();
  for (const p of BULK_PACKS) if (p.re.test(n)) return p.unit(Math.max(1, Math.ceil(grams / p.per)));
  if (grams >= 1000) return `${(Math.ceil(grams / 100) / 10).toFixed(1)} kg`;
  return `${Math.max(5, Math.round(grams / 5) * 5)} g`;
}

/** Per-session bulk shopping list for a batch week, grouped by aisle. Empty for a non-batch week. */
export function bulkGroceriesFromWeek(week: WeekPlan): SessionGroceries[] {
  const sessions = week.sessions ?? [];
  const batches = week.batches ?? [];
  // One representative plated serving per batch (they're identical), to read the ingredient list from.
  const mealByBatch = new Map<string, Meal>();
  for (const d of week.days) for (const m of d.meals) if (m.batchId && !mealByBatch.has(m.batchId)) mealByBatch.set(m.batchId, m);

  return sessions.map((session) => {
    const acc = new Map<string, { name: string; g: number; resolved: boolean }>();
    let total = 0, resolved = 0;
    for (const b of batches.filter((x) => x.sessionId === session.id)) {
      const meal = mealByBatch.get(b.id);
      if (!meal) continue;
      const listServings = meal.servings ?? 1; // the ingredient list makes this many servings (H1)
      for (const ing of meal.ingredients) {
        total++;
        const key = ing.name.trim().toLowerCase();
        const cur = acc.get(key) ?? { name: ing.name, g: 0, resolved: true };
        const g = gramsFor(ing.name, ing.quantity);
        if (g == null) cur.resolved = false;
        else { cur.g += (g / listServings) * b.totalServings; resolved++; }
        acc.set(key, cur);
      }
    }
    const rows: BulkRow[] = [...acc.values()].map((v) => ({
      name: v.name,
      grams: Math.round(v.g),
      quantity: v.resolved && v.g > 0 ? formatBulkQuantity(v.name, v.g) : "check amount",
      ...(v.resolved ? {} : { note: "couldn't auto-sum this quantity" }),
    }));
    return { session, aisles: groupByAisle(rows), coverage: total ? resolved / total : 1 };
  });
}

export interface BatchEfficiency {
  /** Cooking events (one per batch) vs fresh mode's one-cook-per-meal. The headline saving. */
  cookEvents: number;
  freshCookEvents: number;
  sessions: number;
  distinctDishes: number;
  totalMeals: number;
  /** Ingredient names used by ≥2 distinct dishes — the shared-staples payoff. */
  sharedIngredients: number;
}

/** The measurable payoff of a batch week: fewer cooks, shared staples. */
export function batchEfficiency(week: WeekPlan): BatchEfficiency {
  const meals = week.days.flatMap((d) => d.meals);
  const names = [...new Set(meals.map((m) => m.name))];
  const ingCount = new Map<string, number>();
  for (const n of names) {
    const meal = meals.find((m) => m.name === n)!;
    for (const ing of new Set(meal.ingredients.map((i) => i.name.trim().toLowerCase()))) {
      ingCount.set(ing, (ingCount.get(ing) ?? 0) + 1);
    }
  }
  return {
    cookEvents: week.batches?.length ?? names.length,
    freshCookEvents: meals.length,
    sessions: week.sessions?.length ?? 0,
    distinctDishes: names.length,
    totalMeals: meals.length,
    sharedIngredients: [...ingCount.values()].filter((c) => c >= 2).length,
  };
}
