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
import type { Operation, UserProfile, UserFact, WeekPlan } from "./types";
import { DAYS, MEAL_TYPES } from "./types";
import { applyOperations } from "./recipeDb";

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

/** A v2 operation is either a general primitive or a pass-through of an existing engine verb
 *  (swap_meal, log_meal, rate_meal, lock_meal, scale_portions, weekly_report, …). */
// The uniform `op`-based verbs (so the model speaks ONE vocabulary — every op has an `op`), each
// mapping to an existing tested engine tool. This keeps the model's surface general while the
// engine keeps its proven internals.
export interface SwapOp { op: "swap"; dish: string; slot?: MealType; days?: Day[] } // no days = every day
export interface LogOp { op: "log"; day: Day; slot: MealType; dish: string; calories?: number; protein?: number }
export interface ReserveOp { op: "reserve"; day: Day; slot: MealType; calories?: number }
export interface ResizeOp { op: "resize"; direction: "much_smaller" | "smaller" | "bigger" | "much_bigger"; day?: Day; slot?: MealType }
export interface RateOp { op: "rate"; rating: 1 | 2 | 3 | 4 | 5; dish?: string; day?: Day; slot?: MealType }
export interface PinOp { op: "pin" | "unpin"; day: Day; slot: MealType }
export interface ReportOp { op: "report" }
export interface ExplainOp { op: "explain"; day: Day; slot: MealType }
export interface SubstituteOp { op: "substitute"; ingredient: string; day?: Day; slot?: MealType }
export interface SymptomOp { op: "symptom"; text: string }
export interface HydrationOp { op: "hydration"; weightKg?: number; activity?: string }
export interface UndoOp { op: "undo" }
export interface AnswerOp { op: "answer" }

export type VerbOp =
  | SwapOp | LogOp | ReserveOp | ResizeOp | RateOp | PinOp | ReportOp
  | ExplainOp | SubstituteOp | SymptomOp | HydrationOp | UndoOp | AnswerOp;

/** A uniform `op` verb → the existing engine Operation. `answer` maps to nothing (pure reply). */
export function verbToOperation(o: VerbOp): Operation | null {
  switch (o.op) {
    case "swap": {
      const day = o.days && o.days.length === 1 ? o.days[0] : null; // no/none-single day = every day
      return { tool: "swap_meal", dish: o.dish, mealType: o.slot ?? null, day } as Operation;
    }
    case "log": return { tool: "log_meal", day: o.day, mealType: o.slot, dish: o.dish, loggedCalories: o.calories ?? null, loggedProtein: o.protein ?? null } as Operation;
    case "reserve": return { tool: "eating_out", day: o.day, mealType: o.slot, estimatedCalories: o.calories ?? null } as Operation;
    case "resize": return { tool: "scale_portions", portionChange: o.direction, day: o.day ?? null, mealType: o.slot ?? null } as Operation;
    case "rate": return { tool: "rate_meal", rating: o.rating, dish: o.dish ?? null, day: o.day ?? null, mealType: o.slot ?? null } as Operation;
    case "pin": return { tool: "lock_meal", day: o.day, mealType: o.slot } as Operation;
    case "unpin": return { tool: "unlock_meal", day: o.day, mealType: o.slot } as Operation;
    case "report": return { tool: "weekly_report" } as Operation;
    case "explain": return { tool: "explain_meal", day: o.day, mealType: o.slot } as Operation;
    case "substitute": return { tool: "substitute_ingredient", ingredient: o.ingredient, day: o.day ?? null, mealType: o.slot ?? null } as Operation;
    case "symptom": return { tool: "symptom_check", symptom: o.text } as Operation;
    case "hydration": return { tool: "hydration", weightKg: o.weightKg ?? null, activity: (o.activity ?? null) as Operation["activity"] } as Operation;
    case "undo": return { tool: "undo" } as Operation;
    case "answer": return null;
    default: return null;
  }
}

export type PrimitiveOp = ConstrainOp | RememberOp | VerbOp | Operation;

const isConstrain = (o: PrimitiveOp): o is ConstrainOp => (o as ConstrainOp).op === "constrain";
const isRemember = (o: PrimitiveOp): o is RememberOp => (o as RememberOp).op === "remember";
const isVerb = (o: PrimitiveOp): o is VerbOp => "op" in o && (o as { op: string }).op !== "constrain" && (o as { op: string }).op !== "remember";

/**
 * THE executor. Runs a turn's primitives against the deterministic engine and returns the same shape
 * as `applyOperations`: apply `remember` to the profile's memory, expand every `constrain`, pass the
 * rest straight through, then hand the flat op list to the proven engine. This bridge is what both
 * the live assistant AND the generate-then-validate data pipeline call.
 */
export function applyPrimitives(profile: UserProfile, plan: WeekPlan, ops: PrimitiveOp[], today?: string) {
  let p = profile;
  let remembered = false;
  const flat: Operation[] = [];
  for (const o of ops) {
    if (isRemember(o)) {
      const next = applyRemember(p, o, today);
      remembered = remembered || next !== p;
      p = next;
    } else if (isConstrain(o)) {
      flat.push(...expandConstrain(o));
    } else if (isVerb(o)) {
      const mapped = verbToOperation(o);
      if (mapped) flat.push(mapped);
    } else {
      flat.push(o as Operation); // a raw {tool:…} Operation, passed straight through
    }
  }
  const res = applyOperations(p, plan, flat);
  // applyOperations returns the (memory-carrying) profile either way; force profileChanged if a
  // remember happened so the caller persists the new memory even on a plan-only-unchanged turn.
  return { ...res, profileChanged: res.profileChanged || remembered };
}

/** Render the memory as a compact context line for the model's system prompt each turn. */
export function memoryContext(profile: UserProfile): string {
  const mem = profile.memory ?? [];
  if (!mem.length) return "";
  return "Known about the user (remember and apply these): " + mem.map((f) => f.fact).join("; ") + ".";
}
