/**
 * Assistant v2 — the general, composable primitives, mapped onto the tested engine.
 *
 * The antidote to a narrow if-else tool menu: instead of ~20 buttons, most adjustments are ONE
 * `constrain` with a rich body + a `scope`. This module translates those primitives into the flat
 * `Operation[]` the engine already runs, so every bit of deterministic macro math and every invariant
 * test carries straight over — we're changing the model's vocabulary, not the correctness core.
 *
 * See ASSISTANT-SCHEMA.md for the full design.
 */
import type { Operation, UserProfile, UserFact } from "./types";
import { DAYS, MEAL_TYPES } from "./types";

export type Day = (typeof DAYS)[number];
export type MealType = (typeof MEAL_TYPES)[number];
export type Nutrient =
  | "iron" | "calcium" | "magnesium" | "potassium" | "zinc" | "vitD" | "vitC" | "folate" | "b12";

/** Where a constraint applies. "week" persists to the profile; a day list is a temporary per-day
 *  override; a slot targets one meal across the given days (all days if omitted). */
export type Scope = "week" | { days: Day[] } | { slot: MealType; days?: Day[] };

export interface ConstrainOp {
  op: "constrain";
  scope?: Scope; // default "week"
  diet?: UserProfile["diet"];
  budget?: UserProfile["budget"];
  cuisine?: string;
  mealsPerDay?: 3 | 4;
  exclude?: string[];
  use?: string[];
  targets?: { calories?: number; protein?: number; carbs?: number; fat?: number; fiber?: number };
  boostNutrient?: Nutrient;
  maxCookTime?: number;
  preserveMacros?: boolean;
}

export interface RememberOp {
  op: "remember";
  fact: string;
  kind?: UserFact["kind"];
}

const isSlotScope = (s: Scope): s is { slot: MealType; days?: Day[] } =>
  typeof s === "object" && "slot" in s;
const isDayScope = (s: Scope): s is { days: Day[] } =>
  typeof s === "object" && "days" in s && !("slot" in s);

/**
 * `constrain` → the tested flat Operations.
 *  - scope "week"  → one `update_profile` (persists + rebuilds the week).
 *  - scope {days}  → one `regenerate_day` per day (temporary per-day override, not saved).
 *  - scope {slot}  → per-slot targeting — built in the next step; empty for now so nothing wrong fires.
 */
export function expandConstrain(c: ConstrainOp): Operation[] {
  const t = c.targets ?? {};
  const scope: Scope = c.scope ?? "week";

  if (scope === "week") {
    return [
      {
        tool: "update_profile",
        diet: c.diet ?? null, budget: c.budget ?? null, cuisine: c.cuisine ?? null,
        mealsPerDay: c.mealsPerDay ?? null, maxCookTime: c.maxCookTime ?? null,
        excludeFoods: c.exclude ?? [], useIngredients: c.use ?? [],
        targetCalories: t.calories ?? null, targetProtein: t.protein ?? null,
        targetCarbs: t.carbs ?? null, targetFat: t.fat ?? null, targetFiber: t.fiber ?? null,
        boostNutrient: c.boostNutrient ?? null, preserveMacros: c.preserveMacros ?? null,
      } as Operation,
    ];
  }

  if (isDayScope(scope)) {
    // A day range / weekday-weekend → one per-day rebuild each, carrying only day-supported fields.
    return scope.days.map(
      (day) =>
        ({
          tool: "regenerate_day", day,
          diet: c.diet ?? null, cuisine: c.cuisine ?? null,
          targetCalories: t.calories ?? null, targetProtein: t.protein ?? null,
          targetFiber: t.fiber ?? null, boostNutrient: c.boostNutrient ?? null,
          preserveMacros: c.preserveMacros ?? null,
        }) as Operation,
    );
  }

  // slot scope — per-slot targeting; built in the next step.
  return [];
}

/** Apply a `remember` to the profile's memory: dedupe on the fact text, stamp the day if given. */
export function applyRemember(profile: UserProfile, r: RememberOp, today?: string): UserProfile {
  const text = r.fact.trim();
  if (!text) return profile;
  const fact: UserFact = { fact: text, ...(r.kind ? { kind: r.kind } : {}), ...(today ? { since: today } : {}) };
  const rest = (profile.memory ?? []).filter((f) => f.fact.toLowerCase() !== text.toLowerCase());
  return { ...profile, memory: [...rest, fact] };
}

/** Render the memory as a compact context line for the model's system prompt each turn. */
export function memoryContext(profile: UserProfile): string {
  const mem = profile.memory ?? [];
  if (!mem.length) return "";
  return "Known about the user (remember and apply these): " + mem.map((f) => f.fact).join("; ") + ".";
}
