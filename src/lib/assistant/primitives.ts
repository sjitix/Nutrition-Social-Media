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
import { z } from "zod";
import type { Operation, UserProfile, UserFact, WeekPlan, PlanSnapshot } from "../core";
import { DAYS, MEAL_TYPES } from "../core";
import { applyOperations } from "../recipeDb";
import { parseExclusionTokens, EXCLUSION_CATEGORIES } from "../nutrition";
import { INGREDIENTS } from "../data";

/** What counts as a FOOD word below: an allergen category, or any word of a curated ingredient. */
const CATEGORIES = new Set(EXCLUSION_CATEGORIES);
const CURATED_NAMES = new Set(Object.values(INGREDIENTS).map((i) => i.name.toLowerCase()));
const FOOD_WORDS = new Set(
  [...CURATED_NAMES].flatMap((n) => n.split(/[^a-z]+/)).filter((w) => w.length >= 3),
);
const isFood = (w: string) =>
  CATEGORIES.has(w) || FOOD_WORDS.has(w) || FOOD_WORDS.has(w.replace(/(es|s)$/, ""));
/** A phrase we recognise whole: an allergen category ("tree nuts") or a curated name ("peanut butter"). */
const knownPhrase = (t: string) => CATEGORIES.has(t) || CURATED_NAMES.has(t) || CURATED_NAMES.has(t.replace(/s$/, ""));

/**
 * The allergens in a REMEMBERED allergy fact, which is conversation, not a form field: "heads up,
 * I'm allergic to peanuts", "I have a severe peanut allergy", "lactose intolerant". Parsing the whole
 * sentence as an allergy list stored "heads up" as an allergen and kept "severe peanut" as one phrase
 * that blocked nothing. So: take the phrase after ("allergic to X") or before ("X allergy") the cue;
 * split it with the exclusion parser (lists, contrast clauses, noise, categories); and add each FOOD
 * word of a multi-word phrase on its own ("severe peanut" also yields "peanut"). With no cue at all,
 * keep only tokens that name a food. An allergen we do not stock ("lupin") is still kept when the cue
 * names it, so it is enforced the day a recipe with it arrives.
 */
export function allergensInFact(fact: string): string[] {
  const text = fact.toLowerCase().replace(/[‘’]/g, "'");
  const out = new Set<string>();
  // Coeliac disease is a gluten rule whatever words surround it.
  if (/\bc(?:o)?eliac\b/.test(text)) out.add("gluten");
  // Both sides of the cue. AFTER it is an explicit list ("allergic to X", "allergy, also eggs");
  // BEFORE it is often an adjective ("severe allergy to …"), so when an AFTER list exists, words
  // before the cue count only if they name a food ("shellfish allergy, also eggs" keeps both).
  const after = text.match(/\b(?:allerg(?:ic|y|ies)|intoleran(?:t|ce))[\s,]+(?:to\s+)?([^.;:!?]+)/);
  const before = text.match(/([^.,;:!?]*?)\s*\b(?:allerg(?:y|ies)|intoleran(?:t|ce))\b/);
  const afterTokens = after?.[1] ? parseExclusionTokens(after[1], "") : [];
  const beforeTokens = before?.[1]?.trim() ? parseExclusionTokens(before[1], "") : [];
  const fromCue = afterTokens.length
    ? [...afterTokens, ...beforeTokens.filter((t) => t.split(/\s+/).some(isFood))]
    : beforeTokens;
  // A cue whose phrase yields nothing ("I don't do dairy, allergy" — the allergen sits before the
  // comma) falls back to the whole sentence, read for food words only.
  const cue = fromCue.length > 0;
  const tokens = cue ? fromCue : parseExclusionTokens(text, "");
  for (const t of tokens) {
    // "coeliac" is now an exclusion word in its own right (it blocks what "gluten" blocks), but the
    // rule above already stored it AS gluten — keeping both would tell the user "gluten and coeliac".
    if (/^c(?:o)?eliac$/.test(t)) continue;
    if (!t.includes(" ")) {
      if (cue || isFood(t)) out.add(t); // an explicitly named allergen we do not stock ("lupin") is kept
      continue;
    }
    if (knownPhrase(t)) { out.add(t); continue; } // "tree nuts", "peanut butter"
    const foods = t.split(/\s+/).filter(isFood); // "severe peanut" -> "peanut"; "my son has nut" -> "nut"
    if (foods.length) foods.forEach((f) => out.add(f));
    else if (cue) out.add(t); // an unknown multi-word allergen the user named: keep it whole
  }
  return [...out];
}

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
  planMode?: "fresh" | "batch";      // switch fresh <-> meal-prep
  cadence?: "weekly" | "every3days"; // meal-prep cooking cadence
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
        planMode: c.planMode ?? null, batchCadence: c.cadence ?? null,
      } as Operation,
    ];
  }

  if (isDayScope(scope)) {
    // A day range / weekday-weekend → one per-day rebuild each. exclude / use / maxCookTime / budget
    // used to be DROPPED here although regenerate_day honours them — so "no peanuts on Monday"
    // rebuilt Monday without excluding peanuts, and only chance kept them out (found by the models
    // lane, 2026-10-03). mealsPerDay stays week-only: a day cannot have a different number of meals.
    return scope.days.map(
      (day) =>
        ({
          tool: "regenerate_day", day,
          diet: c.diet ?? null, cuisine: c.cuisine ?? null,
          excludeFoods: c.exclude ?? [], useIngredients: c.use ?? [],
          maxCookTime: c.maxCookTime ?? null, budget: c.budget ?? null,
          targetCalories: t.calories ?? null, targetProtein: t.protein ?? null,
          targetFiber: t.fiber ?? null, boostNutrient: c.boostNutrient ?? null,
          preserveMacros: c.preserveMacros ?? null,
        }) as Operation,
    );
  }

  // Slot scope ("more protein at breakfast") is NOT built yet. It used to return nothing at all, so
  // the turn changed nothing, the engine said nothing, and the user read the model's "I've bumped your
  // breakfast protein". `slotScopeNote` (applied in applyPrimitives) now says the truth instead.
  return [];
}

/**
 * A constrain that names nothing to change: no targets, diet, budget, cuisine, meal count, cook time,
 * exclusion, ingredient to use, nutrient or plan mode. "Make the weekend lighter" once arrived as
 * {scope: weekend, preserveMacros: false} and nothing else; the day branch rebuilt all six weekend
 * dishes at the same calories and wrote no note, so the user read the model's "Saturday and Sunday
 * have been scaled down" — false, with planChanged true, so the false-claim guard could not catch it
 * (models lane, 2026-10-03). A random re-roll is worse than doing nothing: it changes nothing and
 * says what it needs.
 *
 * Only when it cannot mean anything else, though: the WEEK scope (a bare re-solve keeps every dish
 * anyway), or `preserveMacros: false` with no new target (leave the targets for… what?). A bare
 * DAY-scoped constrain is how the model asks for different meals on Saturday (the vocabulary has no
 * other re-roll), so that one still re-plans the day, and regenerate_day now always says where it
 * landed. See `noOpConstrain`.
 */
export function isEmptyConstrain(c: ConstrainOp): boolean {
  const t = c.targets ?? {};
  const hasTarget = [t.calories, t.protein, t.carbs, t.fat, t.fiber].some((v) => typeof v === "number" && v > 0);
  return !(
    hasTarget || c.diet || c.budget || c.cuisine || c.mealsPerDay || (c.maxCookTime ?? 0) > 0 || c.exclude?.length ||
    c.use?.length || c.boostNutrient || c.planMode || c.cadence
  );
}

/** An empty constrain that changes nothing (see isEmptyConstrain): week scope, or no-target preserveMacros:false. */
export function noOpConstrain(c: ConstrainOp): boolean {
  const scope = c.scope ?? "week";
  if (!isEmptyConstrain(c)) return false;
  return scope === "week" || (isDayScope(scope) && c.preserveMacros === false);
}

/** What the user reads for an empty constrain: nothing changed, and what would make it change. */
export function emptyConstrainNote(c: ConstrainOp): string {
  const scope = c.scope ?? "week";
  const where = scope === "week" ? "your week" : isDayScope(scope) ? scope.days.join(" and ") : `your ${scope.slot}`;
  return `That didn't say what to change about ${where}, so nothing changed. Tell me what you'd like: fewer calories (and by how much), more protein, a different diet, quicker meals, or a dish to swap.`;
}

/** The honest answer to a slot-scoped constrain, until per-slot targeting exists (milestone C4). */
export function slotScopeNote(c: ConstrainOp): string | null {
  const scope = c.scope ?? "week";
  if (scope === "week" || isDayScope(scope)) return null;
  const slot = scope.slot;
  return `I can't change just your ${slot} that way yet, so nothing changed. I can swap your ${slot} for a dish that fits (for example a higher-protein one), or make it bigger or smaller — tell me which.`;
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
// no days (or all seven) = every day; one or more days = exactly those days. only = the user scoped it
// ("just dinner"): resize the other meals, never replace them.
export interface SwapOp { op: "swap"; dish: string; slot?: MealType; days?: Day[]; only?: boolean }
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

/**
 * A uniform `op` verb → the existing engine Operation(s). `answer` maps to nothing (pure reply).
 *
 * A list, because a swap over SEVERAL days is one engine swap per day. It used to map only a single
 * day and send every longer list down the every-day path, so "make Wednesday to Sunday's breakfast the
 * porridge" replaced Monday's and Tuesday's too, under a note saying "every day" — a real 550B turn
 * (models lane, 2026-10-03). No days, or all seven, is still the one every-day swap and its one note.
 */
export function verbToOperations(o: VerbOp): Operation[] {
  switch (o.op) {
    case "swap": {
      const swap = (day: Day | null) => ({ tool: "swap_meal", dish: o.dish, mealType: o.slot ?? null, day, keepOtherMeals: o.only ?? null }) as Operation;
      const days = [...new Set(o.days ?? [])].sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b));
      if (days.length === 0 || DAYS.every((d) => days.includes(d))) return [swap(null)];
      return days.map(swap);
    }
    default: {
      const one = verbToOperation(o);
      return one ? [one] : [];
    }
  }
}

/** Every verb but `swap`, which can span days and so goes through `verbToOperations`. */
function verbToOperation(o: Exclude<VerbOp, SwapOp>): Operation | null {
  switch (o.op) {
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
export function applyPrimitives(
  profile: UserProfile,
  plan: WeekPlan,
  ops: PrimitiveOp[],
  today?: string,
  previous?: PlanSnapshot,
) {
  let p = profile;
  let remembered = false;
  const flat: Operation[] = [];
  const extraNotes: string[] = [];
  for (const o of ops) {
    if (isRemember(o)) {
      const next = applyRemember(p, o, today);
      remembered = remembered || next !== p;
      p = next;
      // A remembered ALLERGY must bind the ENGINE, not just the assistant's memory. It used to write
      // only profile.memory, so the selector never saw it: "heads up, I'm allergic to peanuts" was
      // remembered, and two peanut dishes stayed in the week unless the model ALSO sent an exclude
      // (found by the models lane; a 550B model did exactly that). Now the allergen joins
      // profile.allergies — the field the exclusion matcher reads — and the week is re-solved, which
      // keeps every dish that still passes and replaces only the ones that no longer do.
      if (o.kind === "allergy") {
        const tokens = allergensInFact(o.fact);
        const have = new Set(parseExclusionTokens(p.allergies ?? "", ""));
        const fresh = tokens.filter((t) => !have.has(t));
        if (fresh.length) {
          p = { ...p, allergies: [p.allergies, ...fresh].filter((s) => s && s.trim()).join(", ") };
          flat.push({ tool: "update_profile" } as Operation);
          extraNotes.push(`I've added ${fresh.join(", ")} to your allergies, so nothing containing ${fresh.length === 1 ? "it" : "them"} will be planned.`);
        }
      }
    } else if (isConstrain(o)) {
      if (noOpConstrain(o)) {
        extraNotes.push(emptyConstrainNote(o));
        continue;
      }
      flat.push(...expandConstrain(o));
      const honest = slotScopeNote(o);
      if (honest) extraNotes.push(honest);
    } else if (isVerb(o)) {
      flat.push(...verbToOperations(o));
    } else {
      flat.push(o as Operation); // a raw {tool:…} Operation, passed straight through
    }
  }
  // `previous` is threaded to the engine so an `undo` verb can restore the prior snapshot, exactly as
  // the live route does — omit it (data pipeline, tests) and undo is simply a no-op.
  const res = applyOperations(p, plan, flat, previous);
  // applyOperations returns the (memory-carrying) profile either way; force profileChanged if a
  // remember happened so the caller persists the new memory even on a plan-only-unchanged turn.
  // The notes written here are ENGINE notes like any other, so composeReply shows them as the truth
  // rather than letting the model's prose claim a change that did not happen.
  return { ...res, notes: [...extraNotes, ...res.notes], profileChanged: res.profileChanged || remembered };
}

/** Render the memory as a compact context line for the model's system prompt each turn. */
export function memoryContext(profile: UserProfile): string {
  const mem = profile.memory ?? [];
  if (!mem.length) return "";
  return "Known about the user (remember and apply these): " + mem.map((f) => f.fact).join("; ") + ".";
}

// --- v2 turn schema (validates the model's output; also constrains local json_schema generation) ---
const dayEnum = z.enum(DAYS);
const slotEnum = z.enum(MEAL_TYPES);
const scopeSchema = z.union([
  z.literal("week"),
  z.object({ days: z.array(dayEnum) }),
  z.object({ slot: slotEnum, days: z.array(dayEnum).optional() }),
]);
const nutrientEnum = z.enum(["iron", "calcium", "magnesium", "potassium", "zinc", "vitD", "vitC", "folate", "b12"]);

/** The model's operation vocabulary, discriminated on `op`. */
export const PrimitiveOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("constrain"),
    scope: scopeSchema.optional(),
    diet: z.enum(["none", "vegetarian", "vegan", "keto", "mediterranean"]).optional(),
    budget: z.enum(["low", "medium", "high"]).optional(),
    cuisine: z.string().optional(),
    mealsPerDay: z.union([z.literal(3), z.literal(4)]).optional(),
    exclude: z.array(z.string()).optional(),
    use: z.array(z.string()).optional(),
    targets: z.object({
      calories: z.number().optional(), protein: z.number().optional(), carbs: z.number().optional(),
      fat: z.number().optional(), fiber: z.number().optional(),
    }).optional(),
    boostNutrient: nutrientEnum.optional(),
    maxCookTime: z.number().optional(),
    preserveMacros: z.boolean().optional(),
    planMode: z.enum(["fresh", "batch"]).optional(),
    cadence: z.enum(["weekly", "every3days"]).optional(),
  }),
  z.object({ op: z.literal("remember"), fact: z.string(), kind: z.enum(["preference", "allergy", "condition", "goal", "context"]).optional() }),
  z.object({ op: z.literal("swap"), dish: z.string(), slot: slotEnum.optional(), days: z.array(dayEnum).optional(), only: z.boolean().optional() }),
  z.object({ op: z.literal("log"), day: dayEnum, slot: slotEnum, dish: z.string(), calories: z.number().optional(), protein: z.number().optional() }),
  z.object({ op: z.literal("reserve"), day: dayEnum, slot: slotEnum, calories: z.number().optional() }),
  z.object({ op: z.literal("resize"), direction: z.enum(["much_smaller", "smaller", "bigger", "much_bigger"]), day: dayEnum.optional(), slot: slotEnum.optional() }),
  z.object({ op: z.literal("rate"), rating: z.number().int().min(1).max(5), dish: z.string().optional(), day: dayEnum.optional(), slot: slotEnum.optional() }),
  z.object({ op: z.literal("pin"), day: dayEnum, slot: slotEnum }),
  z.object({ op: z.literal("unpin"), day: dayEnum, slot: slotEnum }),
  z.object({ op: z.literal("report") }),
  z.object({ op: z.literal("explain"), day: dayEnum, slot: slotEnum }),
  z.object({ op: z.literal("substitute"), ingredient: z.string(), day: dayEnum.optional(), slot: slotEnum.optional() }),
  z.object({ op: z.literal("symptom"), text: z.string() }),
  z.object({ op: z.literal("hydration"), weightKg: z.number().optional(), activity: z.enum(["sedentary", "light", "moderate", "active", "very_active"]).optional() }),
  z.object({ op: z.literal("undo") }),
  z.object({ op: z.literal("answer") }),
]);

/** One reason-then-act turn: the model thinks, replies, and emits primitive operations. */
export const AssistantTurnV2Schema = z.object({
  thinking: z.string(),
  reply: z.string(),
  operations: z.array(PrimitiveOpSchema),
});
export type AssistantTurnV2 = z.infer<typeof AssistantTurnV2Schema>;

/**
 * The agent loop's READ SURFACE as operations (agentTools.ts runs them; results go back to the model
 * only). Without these in the schema a model physically cannot look anything up — a `find_recipes`
 * op fails validation — so the loop's seven read tools were unreachable in production. `report` is
 * already a primitive above (the loop treats it as a read) and is not repeated.
 */
const ReadOpOptions = [
  z.object({
    op: z.literal("find_recipes"),
    mealType: slotEnum.optional(),
    diet: z.enum(["vegetarian", "vegan", "keto", "mediterranean", "gluten_free"]).optional(),
    minProtein: z.number().optional(),
    maxCalories: z.number().optional(),
    maxTime: z.number().optional(),
    query: z.string().optional(),
    sort: z.enum(["default", "protein", "calories-low", "time"]).optional(),
    limit: z.number().int().min(1).max(10).optional(),
  }),
  z.object({ op: z.literal("inspect_recipe"), name: z.string() }),
  z.object({ op: z.literal("get_plan"), day: dayEnum.optional() }),
  z.object({ op: z.literal("get_profile") }),
  z.object({ op: z.literal("get_saved") }),
  z.object({ op: z.literal("what_if"), operations: z.array(PrimitiveOpSchema) }),
] as const;

/** A turn INSIDE the agent loop: primitives plus the read surface. Only the loop's adapter uses it —
 *  single-turn routes, training data and the hard-case eval keep AssistantTurnV2Schema unchanged. */
export const AgentTurnSchema = z.object({
  thinking: z.string(),
  reply: z.string(),
  operations: z.array(z.discriminatedUnion("op", [...PrimitiveOpSchema.options, ...ReadOpOptions])),
});
