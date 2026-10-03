

import {
  DAYS,
  type DayPlan,
  type Meal,
  type Operation,
  type UserProfile,
  type WeekPlan,
  type LockedMeal,
  type MealRating,
  type PlanSnapshot,
  type Batch,
  type CookingSession,
} from "./types";
import { haystackBlocked, parseExclusionTokens, dietTagConflicts, wordMatches } from "./exclusions";
import {
  computeTargets, explainTargets, hydrationTarget, explainHydration,
  CALORIE_FLOOR, DEFAULT_CALORIE_FLOOR,
} from "./targets";
import { SUBSTITUTES, INGREDIENT_ALIASES } from "./substitutions";
import { SYMPTOMS, URGENT_FLAGS, CRISIS_FLAGS, PHRASE_NOISE } from "./symptoms";
import { conditionBoosts } from "./conditions";
import { NUTRIENT_TABLE } from "./nutrientTable.generated";
import {
  microsForIngredients,
  microDensity,
  gramsFor,
  MICRO_KEYS,
  MICRO_LABEL,
  MICRO_UNIT,
  DAILY_REFERENCE,
  type MicroKey,
} from "./nutrients";
import {
  SEED_RECIPES,
  type Cuisine,
  type DietTag,
  type MainProtein,
  type Recipe,
  type RecipeSeed,
} from "./data/seeds";

// The recipe vocabulary lives with the data it describes (src/lib/data/seeds.ts). Re-exported so
// every "@/lib/recipeDb" import that used these names keeps working unchanged.
export type { Cuisine, DietTag, MainProtein, Recipe } from "./data/seeds";

// ---------------------------------------------------------------------------
// Recipe database (Phase A scaffolding — see VISION.md "Recipe data strategy").
//
// This is the structure + selection engine that will eventually hold a large,
// curated, USDA-accurate recipe library. Right now it ships with a small seed
// set so the DB-backed plan works end to end; the seed grows later via the
// offline ingest/clean pipeline. Selection is deterministic-ish (constraint
// filtering + diversity), so plans are accurate and free to produce at scale.
//
// It is OFF by default — the plan route only uses it when PLAN_ENGINE=db, so
// the live LLM path is untouched while this matures.
// ---------------------------------------------------------------------------

/** Public Recipe -> Meal, for surfaces (the browse feed) that show library recipes as plan-ready. */
export const recipeToMeal = (r: Recipe): Meal => toMeal(r);

// Convert a stored Recipe into the app's Meal shape.
function toMeal(r: Recipe): Meal {
  return {
    name: r.name,
    type: r.type,
    description: r.description,
    calories: r.calories,
    proteinGrams: r.proteinGrams,
    carbsGrams: r.carbsGrams,
    fatGrams: r.fatGrams,
    fiberGrams: r.fiberGrams,
    timeMinutes: r.timeMinutes,
    servings: r.servings,
    ingredients: r.ingredients,
    steps: r.steps,
  };
}

// --- The library ---------------------------------------------------------
// The seeds and their types live in ./data/seeds. Here they become the library the engine uses:
// each seed's macros computed from its own ingredient list.

/**
 * Add up what the ingredients actually are, per serving, from USDA per-100g values.
 *
 * `gramsFor` knows the unit conventions ("1 tbsp", "70 g dry", "1 can"). An ingredient we cannot
 * price contributes nothing — which would quietly understate the dish, so check-recipes.mts fails
 * on any unpriced ingredient rather than letting it pass.
 */
function deriveMacros(r: RecipeSeed): Recipe {
  const servings = Math.max(1, r.servings ?? 1);
  let cal = 0, protein = 0, carbs = 0, fat = 0, fiber = 0;
  for (const i of r.ingredients) {
    const key = i.name.trim().toLowerCase();
    const per = NUTRIENT_TABLE[key]?.per100g;
    const grams = gramsFor(key, i.quantity);
    if (!per || !grams) continue;
    const f = grams / 100;
    cal += (per.cal ?? 0) * f;
    protein += (per.protein ?? 0) * f;
    carbs += (per.carbs ?? 0) * f;
    fat += (per.fat ?? 0) * f;
    fiber += (per.fiber ?? 0) * f;
  }
  return {
    ...r,
    calories: Math.round(cal / servings),
    proteinGrams: Math.round(protein / servings),
    carbsGrams: Math.round(carbs / servings),
    fatGrams: Math.round(fat / servings),
    fiberGrams: Math.round(fiber / servings),
  };
}

/** The library the whole engine uses. Macros come from the food, not from a card. */
export const RECIPES: Recipe[] = SEED_RECIPES.map(deriveMacros);

// --- Selection engine ------------------------------------------------------

type SlotSplit = [Recipe["type"], number][];

function localSplit(mealsPerDay: number): SlotSplit {
  return mealsPerDay === 4
    ? [
        ["breakfast", 0.27],
        ["lunch", 0.31],
        ["dinner", 0.31],
        ["snack", 0.11],
      ]
    : [
        ["breakfast", 0.3],
        ["lunch", 0.35],
        ["dinner", 0.35],
      ];
}

function budgetCap(b: UserProfile["budget"]): number {
  return b === "low" ? 2 : 3;
}

function passesDiet(r: Recipe, diet: UserProfile["diet"]): boolean {
  switch (diet) {
    case "none":
      return true;
    case "vegan":
      return r.dietTags.includes("vegan");
    case "vegetarian":
      return r.dietTags.includes("vegetarian") || r.dietTags.includes("vegan");
    case "keto":
      return r.dietTags.includes("keto");
    case "mediterranean":
      return r.dietTags.includes("mediterranean");
    default:
      return true;
  }
}

function blockedByExclusions(r: Recipe, tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  // Include steps so method exclusions work too ("no oven" → drop bake/roast recipes).
  // Matching is word-aware and expands categories: "nuts" must block almonds (a raw substring
  // test did not), while "egg" must NOT block eggplant. Allergies are a hard rule.
  const hay = `${r.name} ${r.ingredients.map((i) => i.name).join(" ")} ${r.steps.join(" ")}`;
  return haystackBlocked(hay, tokens);
}

// Find the library recipe that best matches a free-text dish request (e.g.
// "cottage cheese pancakes"), respecting diet/exclusions/budget and an optional
// meal type. Used for "swap X with <specific dish>".
export function findRecipe(
  query: string,
  type: Recipe["type"] | undefined,
  profile: UserProfile,
): Recipe | null {
  const words = query
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length > 2);
  if (words.length === 0) return null;
  const cap = budgetCap(profile.budget);
  const tokens = exclusionTokens(profile);
  let best: Recipe | null = null;
  let bestScore = 0;
  for (const r of RECIPES) {
    if (type && r.type !== type) continue;
    if (!passesDiet(r, profile.diet) || blockedByExclusions(r, tokens) || r.approxCost > cap) continue;
    const hay =
      `${r.name} ${r.description} ${r.ingredients.map((i) => i.name).join(" ")}`.toLowerCase();
    let score = 0;
    for (const w of words) if (hay.includes(w)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return bestScore > 0 ? best : null;
}

// Micronutrients per recipe, computed once from the USDA-mapped ingredients.
const microsCache = new Map<string, ReturnType<typeof microsForIngredients>>();
export function recipeMicros(r: Recipe) {
  let m = microsCache.get(r.id);
  if (!m) {
    const raw = microsForIngredients(r.ingredients);
    const per = Math.max(1, r.servings ?? 1);
    m = per === 1
      ? raw
      : { coverage: raw.coverage, micros: Object.fromEntries(Object.entries(raw.micros).map(([k, v]) => [k, v / per])) as typeof raw.micros };
    microsCache.set(r.id, m);
  }
  return m;
}

interface PickContext {
  target: number;
  proteinTarget?: number; // grams of protein this slot should aim for
  carbTarget?: number; // grams of carbohydrate this slot should aim for
  fatTarget?: number; // grams of fat this slot should aim for
  proteinDays: Record<string, number>;
  usedIds: Set<string>;
  usedNames: Set<string>;
  dayCuisines: Set<string>;
  usedIngredients: Set<string>;
  fridge?: Set<string>; // on-hand ingredients to prefer ("use what's in my fridge")
  preferFiber?: boolean;
  boost?: MicroKey; // nutrient to favour ("I'm low on iron")
  ketoCarbs?: boolean; // prefer the lowest-carb dish among keto-eligible ones
  ratings?: ReadonlyMap<string, number>; // lowercased recipe name -> 1..5, what the user thought
}

// Selection makes ONE random choice — the tie-break among the near-best dishes in chooseRecipe —
// and that is deliberately what keeps "generate again" fresh. `what_if` needs the opposite: a
// simulation the agent can re-run and get the SAME answer, so it can reason about a change instead
// of chasing a different preview each call. So the one random draw reads through this seam. The
// default is Math.random (fresh); a caller wanting reproducibility wraps a SYNCHRONOUS selection
// call in `withSeed`. Nothing else changes, so ordinary generation keeps its variety.
let _rng: () => number = Math.random;

/** mulberry32 — a tiny, fast, seedable PRNG. Uniform enough for a single tie-break index. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Run `fn` with selection's randomness seeded, so its result is reproducible. SYNCHRONOUS only —
 * the seam is restored the instant `fn` returns, so anything async would run under the restored
 * (unseeded) rng and defeat the point. `what_if` uses this to make a simulation stable; ordinary
 * generation does not, so "generate again" stays fresh.
 */
export function withSeed<T>(seed: number, fn: () => T): T {
  const prev = _rng;
  _rng = mulberry32(seed);
  try {
    return fn();
  } finally {
    _rng = prev;
  }
}

// Choose the best candidate: prefer unused dishes, then a fresh protein, then a
// new cuisine for the day, then closest to the calorie target — with a little
// randomness among the top few so "generate again" varies.
function chooseRecipe(candidates: Recipe[], ctx: PickContext): Recipe | null {
  if (candidates.length === 0) return null;
  let pool = candidates.filter(
    (r) => !ctx.usedIds.has(r.id) && !ctx.usedNames.has(r.name.toLowerCase()),
  );
  if (pool.length === 0) pool = candidates; // relax: allow a repeat if we must

  const freshProtein = pool.filter((r) => (ctx.proteinDays[r.mainProtein] ?? 0) < 3);
  if (freshProtein.length) pool = freshProtein;

  const newCuisine = pool.filter((r) => !ctx.dayCuisines.has(r.cuisine));
  if (newCuisine.length) pool = newCuisine;

  // Dishes the user loved (4-5). Applied as a pool filter, not a score bonus, because the scoring
  // window below is the six closest dishes by calorie distance — a loved dish sitting seventh
  // would never be seen. Placed BEFORE the fridge filter so "use up the salmon", which is a
  // guarantee, still wins over a taste preference.
  if (ctx.ratings?.size) {
    const loved = pool.filter((r) => (ctx.ratings!.get(r.name.toLowerCase()) ?? 0) >= 4);
    if (loved.length) pool = loved;
  }

  // "Use what's in my fridge" — strongly prefer recipes built on on-hand items.
  const fridgeMatch = ctx.fridge
    ? pool.filter((r) => r.ingredients.some((i) => ctx.fridge!.has(i.name.trim().toLowerCase())))
    : [];
  if (fridgeMatch.length) pool = fridgeMatch;

  // PRIMARY RANK — macro fit, scored on density PER CALORIE (portions scale to the slot's calorie
  // target anyway, so what a dish really contributes is its grams-per-calorie). This used to be a
  // pure calorie-distance sort with the macro terms bolted onto the tiebreak below, where they were
  // outvoted by ingredient-reuse and fat ran 15-25% over target on every non-keto diet. Macro fit is
  // the ONLY lever for a day's carb/fat balance — portion-scaling moves a meal's macros together,
  // never their ratio — so it belongs in the primary rank, not the tiebreak.
  const targetDensity = ctx.proteinTarget && ctx.target > 0 ? ctx.proteinTarget / ctx.target : 0;
  const carbDensity = ctx.carbTarget && ctx.target > 0 ? ctx.carbTarget / ctx.target : 0;
  const fatDensity = ctx.fatTarget && ctx.target > 0 ? ctx.fatTarget / ctx.target : 0;
  const calDenom = Math.max(ctx.target, 1);
  const fitDistance = (r: Recipe) => {
    // Guard the divisor: fitDistance drives the PRIMARY sort now, so a 0-calorie recipe producing a
    // NaN would corrupt the ordering, not just lose a tiebreak.
    const cal = Math.max(1, r.calories);
    return (
      // Stay scalable to the slot's calories (the clamp is 0.6-1.8x), so calorie distance leads.
      (Math.abs(r.calories - ctx.target) / calDenom) * 2 +
      // Fat and carbs, two-sided — a dish can miss high or low. Keto keeps its own stronger one-sided
      // carb pull below, so the generic carb term steps aside when keto is active.
      (fatDensity > 0 ? Math.abs(r.fatGrams / cal - fatDensity) * 24 : 0) +
      (carbDensity > 0 && !ctx.ketoCarbs ? Math.abs(r.carbsGrams / cal - carbDensity) * 11 : 0) +
      // Protein only penalised when SHORT — scaling can't raise protein per calorie, so a low-protein
      // pick can't be rescued downstream; being over is fine.
      (targetDensity > 0 ? Math.max(0, targetDensity - r.proteinGrams / cal) * 12 : 0) +
      // Keto: drive carbs as low as the eligible pool allows. Weighted to DOMINATE the fit (net carbs
      // under 50g/day is a hard invariant, not a preference), the way the old one-sided carb term did.
      (ctx.ketoCarbs ? (r.carbsGrams / cal) * 250 : 0)
    );
  };
  const sorted = [...pool].sort((a, b) => fitDistance(a) - fitDistance(b));
  // Among the best-fitting few, break ties by shopping convenience: reuse the week's ingredients,
  // pick cheaper dishes, favour the fridge and a nutrient boost, and shed a "meh" rating. A little
  // randomness among the near-best keeps "generate again" fresh.
  const top = sorted.slice(0, Math.min(8, sorted.length));
  const score = (r: Recipe) =>
    r.ingredients.filter((i) => ctx.usedIngredients.has(i.name.trim().toLowerCase())).length -
    r.approxCost +
    (ctx.preferFiber ? (r.fiberGrams ?? 0) * 0.5 : 0) +
    (ctx.fridge
      ? r.ingredients.filter((i) => ctx.fridge!.has(i.name.trim().toLowerCase())).length * 3
      : 0) +
    (ctx.boost
      ? microDensity(recipeMicros(r).micros, r.calories, ctx.boost) *
        (2000 / DAILY_REFERENCE[ctx.boost]) *
        4
      : 0) +
    // Keto again in the final pick: the fit-sort above puts the lowest-carb dishes in the window,
    // but the random tiebreak must not then trade one away for a cheaper, higher-carb dish. Net
    // carbs under 50g/day is a hard invariant, so keto carbs dominate the pick as well as the sort.
    (ctx.ketoCarbs ? -(r.carbsGrams / Math.max(1, r.calories)) * 900 : 0) -
    ((ctx.ratings?.get(r.name.toLowerCase()) ?? 0) === 2 ? 8 : 0);
  const maxScore = Math.max(...top.map(score));
  const best = top.filter((r) => score(r) >= maxScore - 0.5);
  return best[Math.floor(_rng() * best.length)];
}

// Scale a numeric ingredient quantity ("150 g", "1/2 piece") by a factor so the
// recipe's portions match its scaled calories. Best-effort: leaves anything it
// can't parse untouched.
function scaleQuantity(q: string, f: number): string {
  const m = q.match(/^(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+))?/);
  if (!m) return q;
  const value = (m[2] ? Number(m[1]) / Number(m[2]) : Number(m[1])) * f;
  if (!Number.isFinite(value) || value <= 0) return q;
  const rest = q.slice(m[0].length);
  const isMass = /\b(g|ml|kg|l)\b/i.test(rest);
  let rounded = isMass ? Math.round(value / 5) * 5 : Math.round(value * 2) / 2;
  if (rounded <= 0) rounded = isMass ? 5 : 0.5;
  const num = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${num}${rest}`;
}

// Portion-scale a recipe so its calories/macros hit the per-meal target. This is
// what lets a modest library hit any calorie goal without needing a perfectly
// sized recipe for every target. Factor is clamped so portions stay realistic.
function scaleRecipeToTarget(r: Recipe, target: number): Recipe {
  const f = Math.max(0.6, Math.min(1.8, target / r.calories));
  if (Math.abs(f - 1) < 0.08) return r; // already close — don't fiddle
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

// Week-level state carried across days so the plan stays varied (no repeated
// dishes/proteins) and cheap (reuses ingredients already on the list).
interface WeekCtx {
  proteinDays: Record<string, number>;
  usedIds: Set<string>;
  usedNames: Set<string>;
  usedIngredients: Set<string>;
  fridge?: Set<string>; // on-hand ingredients to prefer across the week
  boost?: MicroKey; // nutrient to favour across the week
  ketoCarbs?: boolean; // prefer the lowest-carb dish among keto-eligible ones
  ratings?: ReadonlyMap<string, number>; // lowercased recipe name -> 1..5
}

/** The user's ratings as the selector wants them: lowercased name -> 1..5. */
export function ratingMap(profile: UserProfile): ReadonlyMap<string, number> {
  return new Map((profile.mealRatings ?? []).map((r) => [r.name.toLowerCase(), r.rating]));
}

/**
 * "Never serve me this again." Every path that PUTS a recipe into a plan must consult this, not
 * just the day selector — the protein rebalancer and the nutrient boost both re-pick dishes on
 * their own, and a ban that only covers one of the three is not a ban. (It didn't: a one-starred
 * breakfast came back in 5 of 25 weeks, swapped in by the protein lever.)
 *
 * A ban is a preference, so each caller decides its own fallback. Where the fallback is "keep the
 * meal that's already there", skipping is free. Where it's "leave the slot empty", it must relax.
 */
function bannedForUser(profile: UserProfile, name: string): boolean {
  const list = profile.mealRatings;
  if (!list?.length) return false;
  const lower = name.toLowerCase();
  return list.some((r) => r.rating === 1 && r.name.toLowerCase() === lower);
}

function newCtx(): WeekCtx {
  return { proteinDays: {}, usedIds: new Set(), usedNames: new Set(), usedIngredients: new Set() };
}

function exclusionTokens(profile: UserProfile): string[] {
  return parseExclusionTokens(profile.allergies, profile.dislikes);
}

/**
 * What the selector had to compromise on. The product rule is "soft preferences may be relaxed
 * but ONLY with disclosure" — before this existed, pickMealsForDay quietly handed a 30-minute
 * meal to a user who asked for 15, and quietly dropped a meal entirely when no recipe fit the
 * diet (keto + 4 meals silently produced 3).
 */
export interface SelectionReport {
  droppedSlots: string[];
  slowestOverLimit: number; // worst cook time placed above the user's limit (0 = none)
  relaxedBudget: boolean;
  // A slot where every remaining dish was one the user asked never to see again. We served one
  // anyway — and, per the disclosure rule, we say so.
  servedBannedDish: boolean;
}

export const newReport = (): SelectionReport => ({
  droppedSlots: [], slowestOverLimit: 0, relaxedBudget: false, servedBannedDish: false,
});

/** Turn a report into honest, user-facing sentences. Empty when nothing was compromised. */
export function reportNotes(rep: SelectionReport, profile: UserProfile): string[] {
  const out: string[] = [];
  if (rep.droppedSlots.length) {
    const uniq = [...new Set(rep.droppedSlots)];
    out.push(
      `I couldn't find a ${uniq.join(" or ")} that fits your ${profile.diet !== "none" ? profile.diet + " " : ""}rules, so ${uniq.length > 1 ? "those meals are" : "that meal is"} missing from some days.`,
    );
  }
  if (rep.slowestOverLimit > profile.maxCookTime + 5)
    out.push(
      `Heads up: you asked for meals under ${profile.maxCookTime} min, but the only options that fit your other rules take up to ${rep.slowestOverLimit} min.`,
    );
  if (rep.relaxedBudget) out.push(`Some meals came out pricier than your budget setting — there wasn't a cheaper option that fit.`);
  if (rep.servedBannedDish)
    out.push(`I've had to reuse a dish you told me you didn't want — there's nothing else in that slot that fits your other rules. Rate a few more meals and I'll have more to work with.`);
  return out;
}

// Select one day's meals under all constraints. Shared by the full-week
// generator and single-day edits. An optional cuisine preference biases picks.
function pickMealsForDay(
  profile: UserProfile,
  split: SlotSplit,
  cap: number,
  tokens: string[],
  ctx: WeekCtx,
  cuisinePref?: Cuisine,
  preferFiber?: boolean,
  report?: SelectionReport,
  keep?: KeepDay,
): Meal[] {
  const dayCuisines = new Set<string>();
  const meals: Meal[] = [];
  for (const [type, share] of split) {
    const target = Math.round(profile.targetCalories * share);
    // Edit-preserving re-solve: if the user already has a dish in this slot and it still satisfies
    // the CHANGED rules, keep it in place rather than re-pick — so a week-wide change keeps the plan
    // they built and only replaces the slots that now break. The kept meal is pushed VERBATIM (its
    // current portions), not re-cooked from base: rebalanceWeek runs afterward and re-scales it if a
    // target actually changed, so a no-op change (relaxing a diet, restating the current target)
    // reproduces the week exactly instead of jittering the portions. A meal we can't find in the
    // library (a logged / eating-out entry) is likewise kept verbatim, never guessed at.
    if (keep) {
      const existing = keep.meals.find((m) => m.type === type);
      if (existing) {
        const base = RECIPES.find((r) => r.name === existing.name);
        if (!base) {
          meals.push(existing);
          continue;
        }
        if (keep.keepIf(base)) {
          ctx.usedIds.add(base.id);
          ctx.usedNames.add(base.name.toLowerCase());
          ctx.proteinDays[base.mainProtein] = (ctx.proteinDays[base.mainProtein] ?? 0) + 1;
          dayCuisines.add(base.cuisine);
          for (const ing of base.ingredients) ctx.usedIngredients.add(ing.name.trim().toLowerCase());
          meals.push(existing);
          continue;
        }
      }
    }
    const st = slotTargetMacros(profile, type); // this slot's macro share (keto-adjusted)
    // HARD rules — diet, allergies and exclusions are never relaxed.
    const hard = RECIPES.filter(
      (r) =>
        r.type === type &&
        !r.treatOnly && // never plan a treat for someone; only serve it on request
        passesDiet(r, profile.diet) &&
        !blockedByExclusions(r, tokens),
    );
    // SOFT preferences — relax in stages rather than silently drop a meal from the day. A
    // pricier meal beats a missing one; a nutritionist would never leave you without dinner.
    //
    // ORDER MATTERS. Cook time is relaxed LAST: someone who says "nothing over 15 minutes"
    // usually cannot cook for 25, whereas price is elastic. Relaxing time to save money
    // (the earlier order) handed a 25-min meal to a user with a 15-min limit.
    const fast = (r: Recipe) => r.timeMinutes <= profile.maxCookTime + 5;
    let candidates = hard.filter(
      (r) => fast(r) && r.ingredients.length <= profile.maxIngredients + 1 && r.approxCost <= cap,
    );
    if (!candidates.length) candidates = hard.filter((r) => fast(r) && r.approxCost <= cap); // drop ingredient cap
    if (!candidates.length) {
      candidates = hard.filter(fast); // drop budget, keep the time limit
      if (candidates.length && report) report.relaxedBudget = true;
    }
    if (!candidates.length) candidates = hard.filter((r) => r.timeMinutes <= profile.maxCookTime + 15);
    if (!candidates.length) candidates = hard; // last resort: honour only the hard rules
    if (!hard.length && report) report.droppedSlots.push(type); // no recipe can satisfy the HARD rules
    // "Never serve me this again" (rating 1). A preference, so it relaxes like one: if banning
    // the dishes would leave this slot with nothing, they come back. A dinner you disliked beats
    // no dinner, and a user who one-stars every keto breakfast must still get breakfast.
    if (profile.mealRatings?.length) {
      const allowed = candidates.filter((r) => !bannedForUser(profile, r.name));
      if (allowed.length) candidates = allowed;
      else if (report) report.servedBannedDish = true;
    }
    if (cuisinePref) {
      const pref = candidates.filter((r) => r.cuisine === cuisinePref);
      if (pref.length) candidates = pref;
    }
    const pick = chooseRecipe(candidates, {
      target,
      proteinTarget: Math.round(profile.proteinGrams * share),
      carbTarget: st.carbs,
      fatTarget: st.fat,
      proteinDays: ctx.proteinDays,
      usedIds: ctx.usedIds,
      usedNames: ctx.usedNames,
      dayCuisines,
      usedIngredients: ctx.usedIngredients,
      fridge: ctx.fridge,
      preferFiber,
      boost: ctx.boost,
      ketoCarbs: ctx.ketoCarbs,
      ratings: ctx.ratings,
    });
    if (!pick && hard.length && report) report.droppedSlots.push(type);
    if (pick) {
      if (report && pick.timeMinutes > profile.maxCookTime + 5)
        report.slowestOverLimit = Math.max(report.slowestOverLimit, pick.timeMinutes);
      ctx.usedIds.add(pick.id);
      ctx.usedNames.add(pick.name.toLowerCase());
      ctx.proteinDays[pick.mainProtein] = (ctx.proteinDays[pick.mainProtein] ?? 0) + 1;
      dayCuisines.add(pick.cuisine);
      for (const ing of pick.ingredients) ctx.usedIngredients.add(ing.name.trim().toLowerCase());
      meals.push(toMeal(scaleRecipeToTarget(pick, target)));
    }
  }
  return meals;
}

// Assemble a full week by selecting from the library under all constraints.
/**
 * Edit-preserving re-solve. When a WEEK-WIDE change comes in (go vegetarian, no onions, protein
 * 180, cheaper), the old behaviour rebuilt the week from scratch and silently discarded every dish
 * the user had swapped in. Passing `keep` tells the selector instead: keep each dish in `plan` that
 * still passes `keepIf`, and only re-pick the slots that now break a rule. Kept dishes are pre-marked
 * used so a replaced slot can't duplicate one that survived on another day.
 */
type KeepEdits = { plan: WeekPlan; keepIf: (r: Recipe) => boolean };
type KeepDay = { meals: Meal[]; keepIf: (r: Recipe) => boolean };

export function selectWeekFromDb(
  profile: UserProfile,
  cuisinePref?: Cuisine,
  preferFiber?: boolean,
  seedIngredients?: string[],
  boost?: MicroKey,
  report?: SelectionReport,
  keep?: KeepEdits,
): WeekPlan {
  const split = localSplit(profile.mealsPerDay);
  const cap = budgetCap(profile.budget);
  const tokens = exclusionTokens(profile);
  const ctx = newCtx();
  if (seedIngredients?.length)
    ctx.fridge = new Set(seedIngredients.map((s) => s.trim().toLowerCase()).filter(Boolean));
  ctx.boost = boost;
  ctx.ketoCarbs = profile.diet === "keto";
  ctx.ratings = ratingMap(profile);
  // A pinned dish is going back into its slot after this, so the selector must not spend it
  // somewhere else — otherwise the week serves the user's Sunday roast twice. (It did, in 6 of
  // every 30 rebuilds, until the selector was told.)
  for (const l of profile.lockedMeals ?? []) {
    const r = RECIPES.find((x) => x.name === l.name);
    if (r) {
      ctx.usedIds.add(r.id);
      ctx.usedNames.add(r.name.toLowerCase());
    }
  }

  // Edit-preserving re-solve: pre-mark every dish we intend to KEEP as already used, so a slot we
  // DO re-pick can't duplicate a kept dish that survives on another day (the same reason a locked
  // dish is pre-marked above).
  if (keep) {
    for (const d of keep.plan.days) {
      for (const m of d.meals) {
        const r = RECIPES.find((x) => x.name === m.name);
        if (r && keep.keepIf(r)) {
          ctx.usedIds.add(r.id);
          ctx.usedNames.add(r.name.toLowerCase());
        }
      }
    }
  }

  const days = DAYS.map((day) => ({
    day,
    meals: pickMealsForDay(
      profile, split, cap, tokens, ctx, cuisinePref, preferFiber, report,
      keep ? { meals: keep.plan.days.find((d) => d.day === day)?.meals ?? [], keepIf: keep.keepIf } : undefined,
    ),
  }));

  const avg = Math.round(
    days.reduce((s, d) => s + d.meals.reduce((m, x) => m + x.calories, 0), 0) / days.length,
  );
  return {
    days,
    weekSummary: `A varied week from the recipe library, averaging about ${avg.toLocaleString()} kcal per day.`,
  };
}

// Regenerate a single day, seeded from the rest of the week so it stays varied
// (no repeated dishes) and reuses ingredients already on the shopping list.
export function selectDay(
  profile: UserProfile,
  dayName: DayPlan["day"],
  plan: WeekPlan,
  cuisinePref?: Cuisine,
  preferFiber?: boolean,
  seedIngredients?: string[],
  boost?: MicroKey,
  report?: SelectionReport,
): DayPlan {
  const split = localSplit(profile.mealsPerDay);
  const cap = budgetCap(profile.budget);
  const tokens = exclusionTokens(profile);
  const ctx = newCtx();
  if (seedIngredients?.length)
    ctx.fridge = new Set(seedIngredients.map((s) => s.trim().toLowerCase()).filter(Boolean));
  ctx.boost = boost;
  ctx.ketoCarbs = profile.diet === "keto";
  ctx.ratings = ratingMap(profile);
  for (const d of plan.days) {
    if (d.day === dayName) continue;
    for (const m of d.meals) {
      ctx.usedNames.add(m.name.toLowerCase());
      for (const ing of m.ingredients) ctx.usedIngredients.add(ing.name.trim().toLowerCase());
    }
  }
  // A dish pinned to ANOTHER day is spent, even when it is transiently absent from the plan (a
  // restaurant reserve sits in its slot, say). Otherwise this day picks it, the pin is re-imposed
  // later, and the week serves it twice.
  for (const l of profile.lockedMeals ?? []) {
    if (l.day === dayName) continue;
    const r = RECIPES.find((x) => x.name === l.name);
    if (r) {
      ctx.usedIds.add(r.id);
      ctx.usedNames.add(r.name.toLowerCase());
    }
  }
  return {
    day: dayName,
    meals: pickMealsForDay(profile, split, cap, tokens, ctx, cuisinePref, preferFiber, report),
  };
}

const CUISINE_ALIASES: [RegExp, Cuisine][] = [
  [/mediterran|greek/, "mediterranean"],
  [/asian|chinese|japanese|thai|korean|stir.?fry|teriyaki/, "asian"],
  [/mexican|latin|tex.?mex|taco/, "mexican"],
  [/italian|pasta/, "italian"],
  [/middle.?eastern|lebanese|turkish|shawarma|moroccan/, "middle_eastern"],
  [/indian|curry|tikka|masala/, "indian"],
  [/american|classic|comfort/, "american"],
];

function normalizeCuisine(input: string | null): Cuisine | undefined {
  if (!input) return undefined;
  const s = input.toLowerCase();
  for (const [re, c] of CUISINE_ALIASES) if (re.test(s)) return c;
  return undefined;
}

function mergeDislikes(current: string, add: string[]): string {
  const existing = current ? current.split(",").map((s) => s.trim()).filter(Boolean) : [];
  return [...new Set([...existing, ...add.map((s) => s.trim().toLowerCase())])]
    .filter(Boolean)
    .join(", ");
}

const fiberOn = (op: Operation) => op.targetFiber != null && op.targetFiber > 0;

// The nutritionist default: keep the day on its macro targets. The LLM only turns
// this off (preserveMacros === false) when the user signals a treat / doesn't care
// about macros this time. Omitted/null → default on.
const keepMacros = (op: Operation) => op.preserveMacros !== false;

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
const DAY_FIBER_TARGET = 30; // g/day (no per-user field yet; sensible default)
const SLOT_WEIGHT = 1.5; // how hard we keep each meal near its share of the day
const SCALE_LO = 0.6;
const SCALE_HI = 1.8; // keep portions realistic (matches scaleRecipeToTarget)
const clampScale = (f: number) => Math.max(SCALE_LO, Math.min(SCALE_HI, f));

function recipeMacros(r: Recipe): Macros {
  return { cal: r.calories, protein: r.proteinGrams, carbs: r.carbsGrams, fat: r.fatGrams, fiber: r.fiberGrams ?? 0 };
}
function mealMacros(m: Meal): Macros {
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
function dayTargetMacros(p: UserProfile): Macros {
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
function slotShare(p: UserProfile, type: Recipe["type"]): number {
  return localSplit(p.mealsPerDay).find((s) => s[0] === type)?.[1] ?? 1 / p.mealsPerDay;
}
function slotTargetMacros(p: UserProfile, type: Recipe["type"]): Macros {
  const t = dayTargetMacros(p);
  const s = slotShare(p, type);
  return { cal: t.cal * s, protein: t.protein * s, carbs: t.carbs * s, fat: t.fat * s, fiber: t.fiber * s };
}
// Scale-free weighted distance between a meal/recipe's macros and a target.
function macroDistance(m: Macros, target: Macros): number {
  let d = 0;
  for (const a of MACRO_AXES) {
    const rel = (m[a] - target[a]) / Math.max(target[a], 1);
    d += MACRO_WEIGHTS[a] * rel * rel;
  }
  return d;
}

const recipeByName = new Map(RECIPES.map((r) => [r.name.toLowerCase(), r]));
const baseRecipeOf = (m: Meal): Recipe | undefined => recipeByName.get(m.name.toLowerCase());

// Scale a recipe by an exact factor. Unlike scaleRecipeToTarget (which ignores any
// change under 8% to avoid pointless re-portioning during generation), the rebalancer
// needs its corrections applied verbatim — otherwise small, deliberate adjustments are
// silently discarded and the day drifts off target.
function scaleRecipeByFactor(r: Recipe, factor: number): Recipe {
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
type LockedSlots = ReadonlySet<Recipe["type"]>;

function scaleToTargets(meals: Meal[], profile: UserProfile, locked?: LockedSlots): Meal[] {
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
const slotsUpTo = (type: Recipe["type"]): Set<Recipe["type"]> =>
  new Set((Object.keys(MEAL_ORDER) as Recipe["type"][]).filter((t) => MEAL_ORDER[t] <= MEAL_ORDER[type]));

const dayProtein = (meals: Meal[]) => meals.reduce((s, m) => s + m.proteinGrams, 0);
const PROTEIN_SLACK = 8; // g/day we'll tolerate before reaching for lever 2

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
function rebalanceDay(
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

// ===========================================================================
// Meal-prep / batch mode — a deterministic SIBLING of the fresh selector above.
// Instead of a distinct dish per meal, it picks a small OVERLAPPING set per slot per
// cooking SESSION, cooks each in bulk, and ROTATES the servings across the session's
// days so no two consecutive days are identical. The bulk multiplier lives on a NEW
// axis (`Batch.totalServings`), never on per-plate macros or the clamped scalers, and
// never on `Meal.servings` (that stays the macro divisor). The fresh path above is
// untouched. See docs/batch-mode/.
// ===========================================================================

const BATCH_SEED = 0x5eed; // batch selection is deterministic by construction; the seed only guards any RNG a reused helper might touch

/** Split the fixed Mon–Sun week into cooking sessions for the cadence. */
function partitionSessions(cadence: NonNullable<UserProfile["batchCadence"]>): CookingSession[] {
  if (cadence === "weekly") {
    return [{ id: "s1", cookDay: DAYS[0], coversDays: [...DAYS], label: `${DAYS[0]} cook` }];
  }
  // every3days: cook twice — Mon covers Mon–Wed (3 days), Thu covers Thu–Sun (4, at the fridge edge;
  // M3 freeze-tags the tail). Two sessions.
  return [
    { id: "s1", cookDay: DAYS[0], coversDays: [DAYS[0], DAYS[1], DAYS[2]], label: `${DAYS[0]} cook` },
    { id: "s2", cookDay: DAYS[3], coversDays: [DAYS[3], DAYS[4], DAYS[5], DAYS[6]], label: `${DAYS[3]} cook` },
  ];
}

// Coarse, curated fridge-shelf-life + freezability heuristics for meal-prep (labelled coarse in the UI).
// keepDays = days a cooked portion stays good REFRIGERATED. freezesWell is an ALLOW-list — we never tell
// someone to freeze a dish that freezes badly; an unknown dish defaults to "don't freeze".
const BATCH_SHORT_KEEP = /salad|lettuce|greens|slaw|poke|ceviche|sashimi|sushi|tartare|carpaccio/i;
const BATCH_LONG_KEEP = /stew|chill?i|curry|soup|bake|casserole|ragu|bolognes|dal|daal|lentil|bean|chickpea|braise|roast|stock|sauce/i;
export function keepDays(r: Recipe): number {
  const hay = `${r.name} ${r.ingredients.map((i) => i.name).join(" ")}`.toLowerCase();
  if (BATCH_SHORT_KEEP.test(hay)) return 2;
  if (BATCH_LONG_KEEP.test(hay)) return 4;
  return 3;
}
const BATCH_FREEZE_BAD = /salad|lettuce|greens|slaw|poke|ceviche|sashimi|sushi|tartare|avocado|yogurt|yoghurt|crisp|fried/i;
const BATCH_FREEZE_OK = /stew|chill?i|curry|soup|bake|casserole|ragu|bolognes|dal|daal|lentil|bean|chickpea|braise|sauce|stock|meatball|patty|burger|burrito|wrap|muffin|ball|bread|porridge|oat|rice|grain|pasta|noodle/i;
export function freezesWell(r: Recipe): boolean {
  const hay = `${r.name} ${r.ingredients.map((i) => i.name).join(" ")}`.toLowerCase();
  if (BATCH_FREEZE_BAD.test(hay)) return false;
  return BATCH_FREEZE_OK.test(hay);
}

/**
 * Eligible dishes for one slot, under the same HARD rules + SOFT-relaxation ladder the fresh
 * selector uses. Kept as its own copy (close to pickMealsForDay's candidate block) so the fresh hot
 * path is provably untouched for M1; a later milestone may share it.
 */
function batchCandidates(profile: UserProfile, type: Recipe["type"], cap: number, tokens: string[]): Recipe[] {
  const hard = RECIPES.filter(
    (r) => r.type === type && !r.treatOnly && passesDiet(r, profile.diet) && !blockedByExclusions(r, tokens),
  );
  const fast = (r: Recipe) => r.timeMinutes <= profile.maxCookTime + 5;
  let c = hard.filter((r) => fast(r) && r.ingredients.length <= profile.maxIngredients + 1 && r.approxCost <= cap);
  if (!c.length) c = hard.filter((r) => fast(r) && r.approxCost <= cap);
  if (!c.length) c = hard.filter(fast);
  if (!c.length) c = hard.filter((r) => r.timeMinutes <= profile.maxCookTime + 15);
  if (!c.length) c = hard;
  if (profile.mealRatings?.length) {
    const allowed = c.filter((r) => !bannedForUser(profile, r.name));
    if (allowed.length) c = allowed;
  }
  return c;
}

/**
 * Pick K DISTINCT dishes for a slot, deterministically. Selection blends macro FIT with ingredient
 * OVERLAP against the session's growing staple set (M3 promotes overlap to a primary term — the
 * efficiency payoff), penalises a dish that won't keep for the whole session and can't be frozen (so
 * long sessions lean on fridge/freezer-safe dishes and the freeze advice stays honest), and shades
 * cheaper. No RNG — ties break on recipe id.
 */
function pickKForSlot(
  pool: Recipe[],
  k: number,
  ctx: {
    target: number; proteinTarget: number; ketoCarbs: boolean;
    ratings: ReadonlyMap<string, number>; staples: Set<string>; coverDays: number;
  },
): Recipe[] {
  // Fit distance (lower = better): calorie distance leads (portions scale within the clamp), plus a
  // protein SHORTFALL penalty (scaling can't raise protein per calorie) and a keto carb pull.
  const fit = (r: Recipe) => {
    const cal = Math.max(1, r.calories);
    const calDist = Math.abs(r.calories - ctx.target) / Math.max(ctx.target, 1);
    const protShort = ctx.target > 0 ? Math.max(0, ctx.proteinTarget / ctx.target - r.proteinGrams / cal) : 0;
    return calDist * 2 + protShort * 12 + (ctx.ketoCarbs ? (r.carbsGrams / cal) * 250 : 0);
  };
  const chosen: Recipe[] = [];
  const usedIds = new Set<string>();
  const staples = new Set<string>(ctx.staples); // grows as we pick -> the K dishes share ingredients
  for (let i = 0; i < k; i++) {
    const cands = pool.filter((r) => !usedIds.has(r.id));
    if (!cands.length) break;
    const score = (r: Recipe) => {
      const overlap = r.ingredients.filter((ing) => staples.has(ing.name.trim().toLowerCase())).length;
      const rating = ctx.ratings.get(r.name.toLowerCase()) ?? 0;
      const unsafe = ctx.coverDays > keepDays(r) && !freezesWell(r) ? 10 : 0;
      return fit(r) - overlap * 0.9 + r.approxCost * 0.3 + (rating === 1 ? 6 : rating === 2 ? 1 : 0) + unsafe;
    };
    let best = cands[0];
    let bestScore = score(best);
    for (const r of cands) {
      const s = score(r);
      if (s < bestScore || (s === bestScore && r.id < best.id)) { best = r; bestScore = s; }
    }
    chosen.push(best);
    usedIds.add(best.id);
    for (const ing of best.ingredients) staples.add(ing.name.trim().toLowerCase());
  }
  return chosen;
}

/**
 * Build a meal-prep week: a small overlapping recipe set per slot per session, cooked in bulk and
 * rotated across the session's days. Deterministic. Each plated Meal is one normal serving (per-
 * serving macros, base name intact), tagged with its `batchId`; the bulk count is `Batch.totalServings`.
 */
export function selectBatchWeek(profile: UserProfile): WeekPlan {
  return withSeed(BATCH_SEED, () => {
    const split = localSplit(profile.mealsPerDay);
    const cap = budgetCap(profile.budget);
    const tokens = exclusionTokens(profile);
    const ratings = ratingMap(profile);
    const sessions = partitionSessions(profile.batchCadence ?? "every3days");
    const batches: Batch[] = [];
    const placed = new Map<string, Meal>(); // `${day}|${type}` -> the plated serving
    const notes: string[] = [];
    const unsafe = new Set<string>(); // dishes eaten past fridge life that also don't freeze -> warn

    for (const session of sessions) {
      const staples = new Set<string>(); // ingredients used so far this session -> rewards overlap
      split.forEach(([type, share], slotIndex) => {
        const target = Math.round(profile.targetCalories * share);
        const pool = batchCandidates(profile, type, cap, tokens);
        if (!pool.length) {
          notes.push(`I couldn't find a ${type} that fits your ${profile.diet !== "none" ? profile.diet + " " : ""}rules for the ${session.label}.`);
          return;
        }
        const want = profile.batchVariety && profile.batchVariety > 0
          ? profile.batchVariety
          : session.coversDays.length >= 4 ? 3 : 2;
        const k = Math.min(want, pool.length);
        const chosen = pickKForSlot(pool, k, {
          target, proteinTarget: Math.round(profile.proteinGrams * share),
          ketoCarbs: profile.diet === "keto", ratings, staples, coverDays: session.coversDays.length,
        });
        if (!chosen.length) return;
        if (chosen.length < 2 && session.coversDays.length > 1)
          notes.push(`Only one ${type} fits your rules, so it repeats across the ${session.label}.`);
        for (const r of chosen) for (const ing of r.ingredients) staples.add(ing.name.trim().toLowerCase());

        const batchByDish = new Map<string, Batch>();
        session.coversDays.forEach((day, i) => {
          const dish = chosen[(i + slotIndex) % chosen.length]; // rotate; different offset per slot
          const kd = keepDays(dish);
          const fw = freezesWell(dish);
          let b = batchByDish.get(dish.id);
          if (!b) {
            const scaled = scaleRecipeToTarget(dish, target);
            b = {
              id: `${session.id}-${type}-${dish.id}`,
              sessionId: session.id,
              recipeName: dish.name,
              slot: type,
              totalServings: 0,
              servingFactor: Math.max(0.6, Math.min(1.8, target / dish.calories)),
              perServing: {
                calories: scaled.calories, proteinGrams: scaled.proteinGrams,
                carbsGrams: scaled.carbsGrams, fatGrams: scaled.fatGrams,
                ...(scaled.fiberGrams != null ? { fiberGrams: scaled.fiberGrams } : {}),
              },
              placements: [],
              keepDays: kd,
            };
            batchByDish.set(dish.id, b);
            batches.push(b);
          }
          b.totalServings += 1;
          // `i` is the day-offset within the session. A portion eaten past the dish's fridge life is
          // freeze-tagged ONLY if it freezes well; a past-life dish that freezes badly becomes a safety
          // warning, never a false "freeze it".
          const past = i >= kd;
          const frozen = past && fw;
          if (frozen && b.freezeFrom == null) b.freezeFrom = i;
          if (past && !fw) unsafe.add(dish.name);
          b.placements.push({ day, slot: type, ...(frozen ? { frozen: true } : {}) });
          placed.set(`${day}|${type}`, { ...toMeal(scaleRecipeToTarget(dish, target)), batchId: b.id });
        });
      });
    }

    // Disclose freezing (weekly cadence, or the tail of an every-3-days session) and any dish that
    // won't keep or freeze — honest, coarse guidance, never a false "freeze this".
    const frozenNames = [...new Set(batches.filter((b) => b.placements.some((pl) => pl.frozen)).map((b) => b.recipeName))];
    if (frozenNames.length)
      notes.push(`Some portions sit past their fridge life — freeze the later servings of ${frozenNames.slice(0, 4).join(", ")}${frozenNames.length > 4 ? " and others" : ""}. (Shelf-life here is a coarse guide.)`);
    if (unsafe.size)
      notes.push(`Heads up: ${[...unsafe].slice(0, 3).join(", ")} keep best eaten within a few days and don't freeze well — the every-3-days cadence suits them better.`);

    const days = DAYS.map((day) => ({
      day,
      meals: split.map(([type]) => placed.get(`${day}|${type}`)).filter((m): m is Meal => !!m),
    }));
    const avg = Math.round(days.reduce((s, d) => s + d.meals.reduce((m, x) => m + x.calories, 0), 0) / Math.max(1, days.length));
    return {
      days,
      weekSummary: `A meal-prep week: ${batches.length} dishes cooked over ${sessions.length} session${sessions.length > 1 ? "s" : ""}, rotated across the week (about ${avg.toLocaleString()} kcal/day).`,
      planMode: "batch" as const,
      sessions,
      batches,
      ...(notes.length ? { notes } : {}),
    };
  });
}

/**
 * Rebalance a batch week. Every batch-cooked slot is passed as a LockedSlot, so the rebalancer's
 * portion-scaling (lever 1) and protein upgrade-swap (lever 2) both SKIP it — a batch serving is
 * cooked once and eaten identically across its days, and lever 2 must never swap one instance for a
 * different dish. A non-batch slot (none in M1) still balances.
 */
export const rebalanceBatchWeek = (plan: WeekPlan, profile: UserProfile): WeekPlan => {
  const days = plan.days.map((d) => {
    const locked: LockedSlots = new Set(d.meals.filter((m) => m.batchId).map((m) => m.type));
    return { ...d, meals: rebalanceDay(d.meals, profile, locked) };
  });
  return { ...plan, days };
};

/**
 * The single mode gate for the PRIMARY generation entry (ai.ts generatePlan) and the demo. The
 * edit/rebuild sites in applyOperations keep their OWN per-site gate (they pass keep/cuisine/boost/
 * report), so fresh behavior there is untouched — do NOT route those through this one-arg helper.
 */
export function buildWeek(profile: UserProfile): WeekPlan {
  return profile.planMode === "batch"
    ? rebalanceBatchWeek(selectBatchWeek(profile), profile)
    : rebalanceWeek(selectWeekFromDb(profile), profile);
}

// Macro-aware swap: among the recipes that match the requested dish name, pick the
// one whose macro profile best fits the slot — so "pancakes" on a high-protein plan
// auto-selects the protein-forward pancake (the user never has to say "protein").
// Dish match wins first; macro fit only breaks ties between equally-matching dishes.
// `respectSoft` = also honour the user's cook-time / ingredient-count limits. We try
// with them on first; if nothing fits we retry with them off purely to tell the user
// WHY we couldn't do it ("that dahl takes 30 min, over your 15-min limit").
function findRecipeForSwap(
  query: string,
  type: Recipe["type"] | undefined,
  profile: UserProfile,
  respectSoft = true,
): Recipe | null {
  const words = query.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2);
  if (words.length === 0) return null;
  const cap = budgetCap(profile.budget);
  const tokens = exclusionTokens(profile);
  const eligible = (r: Recipe) =>
    (!type || r.type === type) &&
    passesDiet(r, profile.diet) &&
    !blockedByExclusions(r, tokens) &&
    r.approxCost <= cap &&
    (!respectSoft || (r.timeMinutes <= profile.maxCookTime + 5 && r.ingredients.length <= profile.maxIngredients + 1));

  // An EXACT name match wins outright. "Swap in the Veggie Omelette" must give the Veggie Omelette,
  // not the dish that happens to share the most keywords with it — a keyword tie once handed a
  // request for "Veggie Omelette" a chickpea omelette instead. Still behind the hard filters, so a
  // vegan who names an egg dish is refused, not served it.
  const q = query.trim().toLowerCase();
  const exact = RECIPES.find((r) => r.name.toLowerCase() === q && eligible(r));
  if (exact) return exact;

  const scored: { r: Recipe; kw: number }[] = [];
  for (const r of RECIPES) {
    if (!eligible(r)) continue;
    const hay = `${r.name} ${r.description} ${r.ingredients.map((i) => i.name).join(" ")}`.toLowerCase();
    let kw = 0;
    for (const w of words) if (hay.includes(w)) kw++;
    if (kw > 0) scored.push({ r, kw });
  }
  if (scored.length === 0) return null;
  const maxKw = Math.max(...scored.map((s) => s.kw));
  const top = scored.filter((s) => s.kw === maxKw).map((s) => s.r);
  if (top.length === 1) return top[0];
  const st = slotTargetMacros(profile, type ?? top[0].type);
  return top.slice().sort((a, b) => macroDistance(recipeMacros(a), st) - macroDistance(recipeMacros(b), st))[0];
}

const dayTotals = (d: DayPlan) => ({
  kcal: d.meals.reduce((s, m) => s + m.calories, 0),
  protein: d.meals.reduce((s, m) => s + m.proteinGrams, 0),
});

// Fuller totals for the honesty note (carbs/fat/fiber too). Kept separate from dayTotals, whose
// two-field shape flows into the agent read-tools and shouldn't grow here.
const dayTotalsFull = (d: DayPlan) => ({
  kcal: d.meals.reduce((s, m) => s + m.calories, 0),
  protein: d.meals.reduce((s, m) => s + m.proteinGrams, 0),
  carbs: d.meals.reduce((s, m) => s + m.carbsGrams, 0),
  fat: d.meals.reduce((s, m) => s + m.fatGrams, 0),
  fiber: d.meals.reduce((s, m) => s + (m.fiberGrams ?? 0), 0),
});

const weekAveragesFull = (plan: WeekPlan) => {
  const n = plan.days.length || 1;
  const t = plan.days.map(dayTotalsFull);
  const avg = (k: keyof ReturnType<typeof dayTotalsFull>) =>
    Math.round(t.reduce((s, x) => s + x[k], 0) / n);
  return { kcal: avg("kcal"), protein: avg("protein"), carbs: avg("carbs"), fat: avg("fat"), fiber: avg("fiber") };
};


/** Average daily amount of a micronutrient across the week, from the mapped ingredients. */
function weekMicroAverage(plan: WeekPlan, key: MicroKey): { amount: number; coverage: number } {
  const n = plan.days.length || 1;
  let total = 0;
  let cov = 0;
  let meals = 0;
  for (const d of plan.days)
    for (const m of d.meals) {
      const r = microsForIngredients(m.ingredients);
      total += r.micros[key] / Math.max(1, m.servings ?? 1);
      cov += r.coverage;
      meals++;
    }
  return { amount: total / n, coverage: meals ? cov / meals : 0 };
}

const PROTEIN_MISS = 8; // g/day we'll tolerate before admitting we fell short

/**
 * Report what the plan ACTUALLY achieved. The model writes the friendly sentence but does
 * no arithmetic, so left alone it will happily claim "I hit 190g protein" when the recipe
 * pool tops out at 167g. That is a trust violation. The engine appends the truth — including
 * an explicit admission when a target is out of reach under the user's constraints.
 */
function achievementNote(
  label: string,
  got: { kcal: number; protein: number; carbs?: number; fat?: number; fiber?: number },
  p: UserProfile,
  // `keptByChoice`: the day was held by RESIZING only, because the user scoped the change to one
  // slot. Then "the most these recipes allow" would be false — replacing another dish could do
  // better, and the caller offers exactly that — so the shortfall is attributed to its real cause.
  opts: { keptByChoice?: boolean } = {},
): string {
  let note = `${label} ${got.kcal} kcal and ${got.protein}g protein.`;
  const short = p.proteinGrams - got.protein;
  if (short > PROTEIN_MISS)
    note += opts.keptByChoice
      ? ` That's ${short}g under your ${p.proteinGrams}g protein target, keeping the other meals you had.`
      : ` I couldn't reach ${p.proteinGrams}g protein within your diet, budget and time limits — ${got.protein}g is the most these recipes allow.`;
  // Calories were only ever reported, never admitted as missed. A user setting 4000 kcal was
  // told "your week averages 2100 kcal" as though that were success.
  const calMiss = got.kcal - p.targetCalories;
  if (Math.abs(calMiss) > p.targetCalories * 0.1)
    note += ` That's ${Math.abs(calMiss)} kcal ${calMiss < 0 ? "below" : "above"} your ${p.targetCalories} kcal target — these recipes can't stretch further without unrealistic portions.`;
  // Carbs and fat are steered at selection time but can't always land exactly; the note owes the
  // user the same honesty on them as on calories/protein. Only disclose a real miss (>20% off),
  // measured against the keto-adjusted day target.
  const tgt = dayTargetMacros(p);
  const keto = p.diet === "keto";
  // On keto, carbs are a CEILING (the whole point is to drive them as low as the pool allows), so
  // landing under is success — only flag carbs that run OVER. Every other diet treats carbs as a
  // target and discloses a miss in either direction.
  if (got.carbs != null && tgt.carbs > 0) {
    const missed = keto ? got.carbs - tgt.carbs > tgt.carbs * 0.2 : Math.abs(got.carbs - tgt.carbs) > tgt.carbs * 0.2;
    if (missed) note += ` Carbs come to ${got.carbs}g against about ${Math.round(tgt.carbs)}g.`;
  }
  if (got.fat != null && tgt.fat > 0 && Math.abs(got.fat - tgt.fat) > tgt.fat * 0.2)
    note += ` Fat comes to ${got.fat}g against about ${Math.round(tgt.fat)}g.`;
  // Fiber is a floor, not a ceiling — only flag a real shortfall, and not on keto, which is
  // inherently low in fibre (and whose fix, more beans/whole grains, would break the diet).
  if (!keto && got.fiber != null && got.fiber < tgt.fiber * 0.7)
    note += ` Fiber is ${got.fiber}g, under the ${Math.round(tgt.fiber)}g I aim for — a serving of veg, beans or whole grains closes it.`;
  return note;
}


/**
 * A nutrient boost must be a GUARANTEE, not a bias. Scoring recipes higher for iron and then
 * re-rolling a random week can hand the user LESS iron than they started with — which makes
 * "I'll rebuild your week around iron" a lie. This pass only ever accepts a strict improvement,
 * so the nutrient can go up or stay put, never down.
 *
 * Variety still matters: a nutritionist doesn't prescribe salmon seven nights running, so no
 * recipe may appear more than twice a week, and never twice in one day.
 */
function upgradeForNutrient(profile: UserProfile, plan: WeekPlan, key: MicroKey): WeekPlan {
  const tokens = exclusionTokens(profile);
  const eligible = RECIPES.filter(
    (r) =>
      !r.treatOnly &&
      passesDiet(r, profile.diet) &&
      !blockedByExclusions(r, tokens) &&
      // An iron-rich dish the user hated is not an upgrade. Nothing better => keep the meal.
      !bannedForUser(profile, r.name) &&
      r.timeMinutes <= profile.maxCookTime,
  );
  const density = new Map(eligible.map((r) => [r.id, recipeMicros(r).micros[key]] as const));
  const uses = new Map<string, number>();
  for (const d of plan.days) for (const m of d.meals) uses.set(m.name, (uses.get(m.name) ?? 0) + 1);

  const days = plan.days.map((d) => ({ ...d, meals: [...d.meals] }));
  for (const d of days) {
    for (let i = 0; i < d.meals.length; i++) {
      const cur = d.meals[i];
      const curRecipe = RECIPES.find((r) => r.name === cur.name);
      const curAmount = curRecipe ? recipeMicros(curRecipe).micros[key] : 0;
      const inDay = new Set(d.meals.map((m) => m.name));
      const best = eligible
        .filter(
          (r) =>
            r.type === cur.type &&
            !inDay.has(r.name) &&
            (uses.get(r.name) ?? 0) < 2 &&
            (density.get(r.id) ?? 0) > curAmount,
        )
        .sort((a, b) => (density.get(b.id) ?? 0) - (density.get(a.id) ?? 0))[0];
      if (!best) continue; // nothing strictly better — keep what's there
      const share = localSplit(profile.mealsPerDay).find((sp) => sp[0] === best.type)?.[1] ?? 1 / profile.mealsPerDay;
      d.meals[i] = toMeal(scaleRecipeToTarget(best, Math.round(profile.targetCalories * share)));
      uses.set(cur.name, Math.max(0, (uses.get(cur.name) ?? 1) - 1));
      uses.set(best.name, (uses.get(best.name) ?? 0) + 1);
    }
  }
  return rebalanceWeek({ ...plan, days }, profile);
}

/**
 * "I'm always tired." The only defensible thing an app can do here is refuse to guess.
 *
 * It does not diagnose: it names what the symptom is nutritionally ASSOCIATED with, then checks
 * those nutrients against what the user is actually eating this week, and reports which are low.
 * That is a claim about their food, which we can support, and never about their body, which we
 * cannot. It recommends no supplement and no dose. It sends them to a doctor, because for every
 * symptom in the table the medically correct answer is "get it looked at".
 *
 * Red-flag symptoms short-circuit the whole thing. Chest pain is not a magnesium problem, and an
 * app that answers it with a meal plan is dangerous.
 */
function symptomNote(plan: WeekPlan, p: UserProfile, reported: string): { text: string; override: boolean } {
  const said = reported.trim().toLowerCase();
  if (!said) return { text: "What have you been noticing?", override: false };

  const words = said.split(/[^a-z']+/).filter(Boolean);
  const same = (w: string, t: string) => w === t || wordMatches(w, t) || wordMatches(t, w);

  // SYMPTOMS match as an unordered WORD SET, with the same stemmer the allergen filter uses:
  // "my nails are brittle and my hair is thinning" must find "brittle nails" and "hair thinning";
  // "retired" must never find "tired".
  const hasWord = (t: string) => words.some((w) => same(w, t));
  const phraseIn = (phrase: string) => phrase.split(/\s+/).every(hasWord);

  // RED FLAGS match on ADJACENCY, not on a scattered set. "blood in stool" contains the word
  // "in"; as a word set it would fire on "my blood test was low and I sat on a stool in the
  // kitchen". Noise words are dropped from both sides, then the phrase must appear as
  // consecutive words — which still lets "coughing up blood" find "coughing blood".
  const signal = words.filter((w) => !PHRASE_NOISE.has(w.replace(/'/g, "")));
  const flagIn = (phrase: string) => {
    const want = phrase.split(/\s+/).filter((w) => !PHRASE_NOISE.has(w.replace(/'/g, "")));
    if (!want.length) return false;
    // Adjacent but ORDER-FREE: "a pain in my chest" and "my speech is slurred" are the same
    // emergency as "chest pain" and "slurred speech". Strict ordering missed both.
    for (let i = 0; i + want.length <= signal.length; i++) {
      const window = signal.slice(i, i + want.length);
      const taken = new Array(window.length).fill(false);
      const all = want.every((t) => {
        const j = window.findIndex((w, k) => !taken[k] && same(w, t));
        if (j < 0) return false;
        taken[j] = true;
        return true;
      });
      if (all) return true;
    }
    return false;
  };

  // Crisis first. Nothing else in this function runs.
  // `override` means: the model's own words are DISCARDED and this text is the entire reply. A
  // 1.5B must not be able to prepend "sounds like low iron!" to a chest-pain warning.
  if (CRISIS_FLAGS.some(flagIn))
    return {
      text: "I'm not the right help for this, and I don't want to talk to you about food right now. Please contact your local emergency number or a crisis line straight away — in the US and Canada you can call or text 988, in the UK call 116 123. If you're in danger, call emergency services.",
      override: true,
    };

  if (URGENT_FLAGS.some(flagIn))
    return {
      text: "That isn't something I should be answering with food. Please contact a doctor or urgent care now — I'll look at your nutrition once you've had it seen to.",
      override: true,
    };

  const hit = SYMPTOMS.find((sym) => sym.triggers.some(phraseIn));
  if (!hit)
    return {
      text: "I don't have a nutritional angle on that, and I'd rather say so than invent one. If it's bothering you, a doctor is the right person to ask.",
      override: false,
    };

  const low: string[] = [];
  const fine: string[] = [];
  const unmeasured: string[] = [];
  const lowKeys: MicroKey[] = [];
  for (const k of hit.nutrients) {
    const { amount, coverage } = weekMicroAverage(plan, k);
    if (coverage < 0.6) { unmeasured.push(MICRO_LABEL[k]); continue; }
    const pct = Math.round((amount / DAILY_REFERENCE[k]) * 100);
    if (pct < 80) { low.push(`${MICRO_LABEL[k]} (${pct}% of the daily reference)`); lowKeys.push(k); }
    else fine.push(`${MICRO_LABEL[k]} (${pct}%)`);
  }

  const parts = [
    `${cap(hit.label)} can have many causes and most of them aren't dietary — I can't diagnose it, and if it's persisted you should see a doctor.`,
    `What I can do is check the nutrients it's classically associated with — ${listPhrase(hit.nutrients.map((k) => MICRO_LABEL[k]))} — against what you're actually eating.`,
  ];

  if (low.length) {
    parts.push(`In your current week, ${listPhrase(low)} ${low.length > 1 ? "are" : "is"} below the reference.`);
    const fixable = lowKeys.filter((k) => nutrientReachable(p, k));
    const stuck = lowKeys.filter((k) => !nutrientReachable(p, k));
    if (fixable.length) parts.push(`I can rebuild your week around ${listPhrase(fixable.map((k) => MICRO_LABEL[k]))} if you'd like.`);
    if (stuck.length)
      parts.push(`No food that fits your ${p.diet !== "none" ? p.diet + " " : ""}rules carries enough ${listPhrase(stuck.map((k) => MICRO_LABEL[k]))} — that's worth raising with a doctor or dietitian rather than something I can fix with recipes.`);
  } else if (fine.length) {
    parts.push(`In your current week they all look adequate — ${listPhrase(fine)} — so your food probably isn't the explanation. That's a reason to see a doctor, not to ignore it.`);
  }
  if (unmeasured.length) parts.push(`(I can't measure ${listPhrase(unmeasured)} reliably from these ingredients.)`);
  return { text: parts.join(" "), override: false };
}

/**
 * "I've run out of Greek yogurt." A substitution has to clear three bars, in this order:
 *
 *  1. SAFETY. It must not be something they're allergic to, dislike, or that breaks their diet.
 *     Suggesting butter to a vegan, or almond butter to a nut-allergic user, is the single worst
 *     thing this feature could do — so candidates are filtered before anything else is computed.
 *  2. SENSE. Which foods stand in for which is curated (see substitutions.ts); a nutrient table
 *     doesn't know that lentils don't belong where a chicken breast was.
 *  3. HONESTY about the cost. The macro difference is computed from USDA data at the portion the
 *     recipe actually calls for, and stated. "Basically the same" is a claim, not a courtesy.
 */
/**
 * Substring matching once served almonds to a user allergic to nuts, because "nuts" is inside
 * "almonds"... backwards. Here it made "unicorn tears" match corn. Ingredients match on WORD
 * boundaries or not at all.
 */
function nameMatches(ingredientName: string, want: string): boolean {
  const n = ingredientName.trim().toLowerCase();
  if (n === want) return true;
  // Compare word by word, with the same stemming the allergen filter uses, so "egg" finds "eggs"
  // and "tortilla" finds "corn tortillas" — but "unicorn tears" never finds corn.
  const nw = n.split(/[^a-z]+/).filter(Boolean);
  const ww = want.split(/[^a-z]+/).filter(Boolean);
  if (!ww.length) return false;
  const covers = (hay: string[], needles: string[]) =>
    needles.every((t) => hay.some((w) => wordMatches(w, t) || wordMatches(t, w)));
  return covers(nw, ww) || covers(ww, nw);
}

/**
 * "almond" must not resolve to "almond butter" just because that key is listed first. Among the
 * keys that match, prefer the one that says the least beyond what the user said.
 */
function bestKey(want: string): string | undefined {
  const alias = INGREDIENT_ALIASES[want];
  if (alias && SUBSTITUTES[alias]) return alias;
  const words = (x: string) => x.split(/[^a-z]+/).filter(Boolean).length;
  return Object.keys(SUBSTITUTES)
    .filter((k) => nameMatches(k, want))
    .sort((a, b) => Math.abs(words(a) - words(want)) - Math.abs(words(b) - words(want)) || a.length - b.length)[0];
}

function substituteNote(
  plan: WeekPlan,
  p: UserProfile,
  query: string,
  day: DayPlan["day"] | undefined,
  type: Meal["type"] | undefined,
): string {
  const raw = query.trim().toLowerCase();
  if (!raw) return "Which ingredient have you run out of?";
  const want = INGREDIENT_ALIASES[raw] ?? raw;

  // Find where it appears in the plan, so the advice is about a real portion.
  const scope = plan.days.filter((d) => !day || d.day === day);
  let found: { day: string; meal: Meal; name: string; quantity: string } | null = null;
  for (const d of scope)
    for (const m of d.meals) {
      if (type && m.type !== type) continue;
      const hit = m.ingredients.find((i) => nameMatches(i.name, want));
      if (hit && !found) found = { day: d.day, meal: m, name: hit.name.trim().toLowerCase(), quantity: hit.quantity };
    }

  const key = found?.name ?? want;
  const candidates = SUBSTITUTES[key] ?? SUBSTITUTES[want] ?? SUBSTITUTES[bestKey(key) ?? bestKey(want) ?? ""] ?? [];
  if (!candidates.length)
    return found
      ? `I don't have a substitution I trust for ${key}. Leaving it out of ${found.day}'s ${found.meal.type} is usually safer than guessing.`
      : `I don't know what to swap for "${query}", and I'd rather say so than invent something.`;

  // 1. SAFETY FIRST — diet, allergies, dislikes.
  const tokens = exclusionTokens(p);
  const dietTag = p.diet === "vegan" ? "vegan" : p.diet === "vegetarian" ? "vegetarian" : "";
  const safe = candidates.filter((c: string) => {
    if (haystackBlocked(c, tokens)) return false;
    if (dietTag && dietTagConflicts(dietTag, [c]).length) return false;
    // Keto isn't a tag on an ingredient, it's a number on one. dietTagConflicts can't see it, so
    // a keto user was being told to replace rice with... quinoa and couscous.
    if (p.diet === "keto" && (NUTRIENT_TABLE[c]?.per100g.carbs ?? 0) > KETO_MAX_CARBS_PER_100G) return false;
    return true;
  });
  if (!safe.length)
    return `Everything I'd normally swap for ${key} breaks your ${p.diet !== "none" ? p.diet + " diet" : "restrictions"} or something you avoid, so I won't suggest any of them.`;

  const best = safe[0];
  const parts: string[] = [];

  // 3. THE COST, computed. Only when we know both foods and the portion.
  const grams = found ? gramsFor(found.name, found.quantity) : null;
  const a = NUTRIENT_TABLE[key]?.per100g;
  const b = NUTRIENT_TABLE[best]?.per100g;
  if (found && grams && a && b) {
    const f = grams / 100;
    const dCal = Math.round(((b.cal ?? 0) - (a.cal ?? 0)) * f);
    const dPro = Math.round(((b.protein ?? 0) - (a.protein ?? 0)) * f);
    const cost: string[] = [];
    if (Math.abs(dCal) >= 15) cost.push(`${Math.abs(dCal)} ${dCal > 0 ? "more" : "fewer"} kcal`);
    if (Math.abs(dPro) >= 3) cost.push(`${Math.abs(dPro)}g ${dPro > 0 ? "more" : "less"} protein`);
    parts.push(
      `Use ${best} instead of the ${portion(found.quantity, key)} in ${found.day}'s ${found.meal.type}` +
        (cost.length ? ` — that's ${listPhrase(cost)} for that portion.` : ` — near enough identical for that portion.`),
    );
  } else if (found) {
    parts.push(`Use ${best} instead of the ${portion(found.quantity, key)} in ${found.day}'s ${found.meal.type}.`);
    parts.push(`I can't put a number on the macro difference — I don't have full data for both.`);
  } else {
    parts.push(`Use ${best} in place of ${key}.`);
    parts.push(`It isn't in this week's plan, so I'm speaking generally.`);
  }

  const others = safe.slice(1, 3);
  if (others.length) parts.push(`${listPhrase(others.map(cap))} also work${others.length > 1 ? "" : "s"}.`);
  const dropped = candidates.length - safe.length;
  if (dropped) parts.push(`(I left out ${dropped} I'd normally suggest — ${dropped > 1 ? "they don't" : "it doesn't"} fit your diet or what you avoid.)`);
  return parts.join(" ");
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "150 g of greek yogurt", but "1 egg" — a bare count doesn't take "of". */
function portion(quantity: string, ingredient: string): string {
  return /[a-z]/i.test(quantity) ? `${quantity} of ${ingredient}` : `${quantity} ${ingredient}`;
}

/**
 * "Why is this in my plan?" An assistant that cannot justify its own choices is a black box, and
 * a black box cannot replace a nutritionist. Every clause below is derived from the plan and the
 * USDA table — the model narrates it, it never invents it.
 *
 * Where the data is thin (an ingredient list we can't fully match), the nutrient claim is dropped
 * rather than softened. "Rich in iron" is a claim about someone's blood; we make it only when the
 * numbers actually say so.
 */
function explainMealNote(plan: WeekPlan, p: UserProfile, day: DayPlan["day"], type: Meal["type"]): string {
  const d = plan.days.find((x) => x.day === day);
  const meal = d?.meals.find((m) => m.type === type);
  if (!meal) return `I don't have a ${type} on ${day}.`;

  const t = dayTargetMacros(p);
  const pctCal = Math.round((meal.calories / t.cal) * 100);
  const pctPro = t.protein > 0 ? Math.round((meal.proteinGrams / t.protein) * 100) : 0;
  const parts: string[] = [
    `${day}'s ${type} is ${meal.name}: ${meal.calories} kcal (${pctCal}% of your day) and ${meal.proteinGrams}g protein (${pctPro}% of your ${Math.round(t.protein)}g target).`,
  ];

  // A reserved or logged meal has no recipe behind it — say that plainly rather than pretending.
  const base = RECIPES.find((r) => r.name === meal.name);
  if (!base) {
    parts.push(`It isn't one of my recipes — it's a meal you told me about, so I planned the rest of the day around it.`);
    return parts.join(" ");
  }

  const why: string[] = [];
  const density = meal.calories > 0 ? (meal.proteinGrams * 4) / meal.calories : 0;
  if (density >= 0.3) why.push(`it's protein-dense (${Math.round(density * 100)}% of its calories)`);
  if (base.timeMinutes <= 15) why.push(`it's quick (${base.timeMinutes} min)`);
  else if (base.timeMinutes <= p.maxCookTime) why.push(`it fits your ${p.maxCookTime}-min limit at ${base.timeMinutes} min`);
  if (base.approxCost === 1) why.push("it's one of the cheaper recipes");
  // The SERVED portion, not the recipe card: everything else in this sentence is scaled.
  if ((meal.fiberGrams ?? 0) >= 8) why.push(`it carries ${meal.fiberGrams}g of fiber`);
  if (p.diet !== "none") why.push(`it's ${p.diet}`);

  // Ingredient reuse is a real reason: it's why the grocery list stays short.
  const mine = new Set(base.ingredients.map((i) => i.name.trim().toLowerCase()));
  const shared = new Set<string>();
  for (const other of plan.days.flatMap((x) => x.meals))
    if (other !== meal)
      for (const ing of other.ingredients)
        if (mine.has(ing.name.trim().toLowerCase())) shared.add(ing.name.trim().toLowerCase());
  if (shared.size >= 2) why.push(`it reuses ${shared.size} ingredients already on your shopping list`);

  if (why.length) parts.push(`I picked it because ${listPhrase(why)}.`);

  // Micronutrients: only claim what the data supports.
  const { micros, coverage } = microsForIngredients(meal.ingredients);
  if (coverage >= 0.6) {
    const per = Math.max(1, meal.servings ?? 1);
    const top = MICRO_KEYS.map((k) => ({ k, pct: (micros[k] / per) / DAILY_REFERENCE[k] }))
      .filter((x) => x.pct >= 0.3)
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 2);
    if (top.length)
      parts.push(
        `It's a strong source of ${listPhrase(top.map((x) => `${MICRO_LABEL[x.k]} (${Math.round(x.pct * 100)}% of a day's reference)`))}.`,
      );
  } else {
    parts.push(`I can't measure its micronutrients reliably — I don't have full data for its ingredients.`);
  }
  return parts.join(" ");
}

function listPhrase(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/* ------------------------------------------------------------------------- *
 * Pinned meals — "never change my Sunday roast"
 *
 * A plan you cannot pin is not yours. A locked meal is re-imposed after EVERY rebuild (a new
 * week, a new day, a nutrient boost, a macro re-solve) and the day is then re-solved around it as
 * a fixed point, exactly like a meal the user has already eaten.
 *
 * A pin outranks PREFERENCES — cook time, budget, variety — because the user asked for it by
 * name. A pin never outranks a HARD RULE. If they go vegan, a pinned chicken roast cannot stay,
 * so the pin is dropped and they are told. Silently serving it would break I1/I2, the two
 * invariants that exist to protect someone's health.
 * ------------------------------------------------------------------------- */

function lockKey(day: string, mealType: string): string {
  return `${day}|${mealType}`;
}

function lockedSlotsFor(p: UserProfile, day: DayPlan["day"]): Set<Meal["type"]> {
  return new Set((p.lockedMeals ?? []).filter((l) => l.day === day).map((l) => l.mealType));
}

/**
 * Would this pinned recipe break a hard rule under the CURRENT profile? Diet and allergies are the
 * only things allowed to evict a pin.
 */
function lockViolatesHardRule(p: UserProfile, lock: LockedMeal): string | null {
  const recipe = RECIPES.find((r) => r.name === lock.name);
  if (!recipe) return "it isn't one of my recipes any more";
  // A pin on a slot the day no longer has (they dropped from 4 meals to 3) can never be placed.
  // Left alive it becomes a phantom: silently ignored, silently resurrected on the way back.
  if (!localSplit(p.mealsPerDay).some(([t]) => t === lock.mealType))
    return `you eat ${p.mealsPerDay} meals a day now, so there's no ${lock.mealType}`;
  if (!passesDiet(recipe, p.diet)) return `it isn't ${p.diet}`;
  if (blockedByExclusions(recipe, exclusionTokens(p))) return "it contains something you avoid";
  return null;
}

/**
 * Put every surviving pin back into its slot and re-solve those days around them.
 * Returns the plan plus any pins that had to be dropped, so the caller can update the profile
 * and say so out loud.
 */
function reimposeLocks(
  p: UserProfile,
  plan: WeekPlan,
  onlyDays?: Set<string>,
): { plan: WeekPlan; dropped: { lock: LockedMeal; why: string }[] } {
  const locks = p.lockedMeals ?? [];
  if (!locks.length) return { plan, dropped: [] };

  const dropped: { lock: LockedMeal; why: string }[] = [];
  const live: LockedMeal[] = [];
  for (const l of locks) {
    const why = lockViolatesHardRule(p, l);
    if (why) dropped.push({ lock: l, why });
    else live.push(l);
  }

  const touched = new Set(live.filter((l) => !onlyDays || onlyDays.has(l.day)).map((l) => l.day));
  const days = plan.days.map((d) => {
    if (!touched.has(d.day)) return d;
    const here = live.filter((l) => l.day === d.day);
    const meals = d.meals.map((m) => {
      const lock = here.find((l) => l.mealType === m.type);
      if (!lock || m.name === lock.name) return m;
      const recipe = RECIPES.find((r) => r.name === lock.name)!;
      const share = localSplit(p.mealsPerDay).find((sp) => sp[0] === recipe.type)?.[1] ?? 1 / p.mealsPerDay;
      return { ...toMeal(scaleRecipeToTarget(recipe, Math.round(p.targetCalories * share))), type: m.type };
    });
    const pinned = new Set(here.map((l) => l.mealType));
    return { ...d, meals: rebalanceDay(meals, p, pinned, namesOnOtherDays(plan, d.day, p)) };
  });

  return { plan: { ...plan, days }, dropped };
}

/* ------------------------------------------------------------------------- *
 * "Use up the salmon and broccoli I have"
 *
 * Preferring on-hand food was a BIAS: the selector filtered each slot toward matching recipes, but
 * the protein-diversity cap could still push fish out of the whole week, so the salmon the user
 * asked to use up simply didn't appear. Some runs, not others — the test for it could only say
 * "usually", which is another way of saying nobody knew.
 *
 * It is a guarantee now, in the same shape as the nutrient boost: build the week, then check, then
 * place what's missing. Hard rules still win — nothing on-hand gets used if it breaks the diet or
 * an allergy, and a pinned meal is never displaced to make room. When an ingredient cannot be
 * used, the engine says so instead of quietly ignoring it.
 * ------------------------------------------------------------------------- */
function guaranteeFridge(p: UserProfile, plan: WeekPlan, wanted: string[], notes: string[]): WeekPlan {
  const want = wanted.map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (!want.length) return plan;

  const tokens = exclusionTokens(p);
  const uses = (m: Meal, ing: string) => m.ingredients.some((i) => i.name.trim().toLowerCase() === ing);
  const pinned = new Set((p.lockedMeals ?? []).map((l) => lockKey(l.day, l.mealType)));
  const unusable: string[] = [];
  const relaxed: string[] = [];
  const forcedBanned: string[] = []; // ingredients only a rejected dish can use up
  let cur = plan;

  for (const ing of want) {
    if (cur.days.some((d) => d.meals.some((m) => uses(m, ing)))) continue;

    const inWeek = new Set(cur.days.flatMap((d) => d.meals.map((m) => m.name.toLowerCase())));
    const eligible = RECIPES.filter(
      (r) =>
        !r.treatOnly &&
        passesDiet(r, p.diet) &&
        !blockedByExclusions(r, tokens) &&
        !inWeek.has(r.name.toLowerCase()) &&
        r.ingredients.some((i) => i.name.trim().toLowerCase() === ing),
    );
    // Cook time is a preference, so it may be relaxed — but only with disclosure, and only when
    // nothing quick enough exists.
    let cands = eligible.filter((r) => r.timeMinutes <= p.maxCookTime);
    if (!cands.length && eligible.length) {
      cands = eligible;
      relaxed.push(ing);
    }
    // "Use up the salmon" is a guarantee the user just asked for; a rating is a standing
    // preference. Prefer a dish they haven't rejected — but if the only way to use the ingredient
    // is a dish they one-starred, honour the request they made today, and say so.
    const notBanned = cands.filter((r) => !bannedForUser(p, r.name));
    if (notBanned.length) cands = notBanned;
    else if (cands.length) forcedBanned.push(ing);
    if (!cands.length) {
      unusable.push(ing);
      continue;
    }
    const score = (r: Recipe) => r.ingredients.filter((i) => want.includes(i.name.trim().toLowerCase())).length;
    cands.sort((a, b) => score(b) - score(a) || a.approxCost - b.approxCost);
    const pick = cands[0];

    // Displace a slot of the same type that is neither pinned nor already earning its keep.
    const target = cur.days.find((d) => {
      const m = d.meals.find((x) => x.type === pick.type);
      return !!m && !pinned.has(lockKey(d.day, m.type)) && !want.some((w) => uses(m, w));
    });
    if (!target) {
      unusable.push(ing);
      continue;
    }

    const share = localSplit(p.mealsPerDay).find((sp) => sp[0] === pick.type)?.[1] ?? 1 / p.mealsPerDay;
    const placed = toMeal(scaleRecipeToTarget(pick, Math.round(p.targetCalories * share)));
    const days = cur.days.map((d) => {
      if (d.day !== target.day) return d;
      const meals = d.meals.map((m) => (m.type === pick.type ? { ...placed, type: m.type } : m));
      const fixed = new Set<Meal["type"]>([pick.type, ...lockedSlotsFor(p, d.day)]);
      return { ...d, meals: rebalanceDay(meals, p, fixed, namesOnOtherDays(cur, d.day, p)) };
    });
    cur = { ...cur, days };
  }

  if (relaxed.length)
    notes.push(`Nothing with ${listPhrase(relaxed)} fits your ${p.maxCookTime}-min limit, so that meal takes a little longer.`);
  if (forcedBanned.length)
    notes.push(`The only dish I have that uses ${listPhrase(forcedBanned)} is one you rated poorly — I've used it anyway so nothing goes to waste.`);
  if (unusable.length)
    notes.push(`I couldn't work ${listPhrase(unusable)} into the week — nothing I have with ${unusable.length > 1 ? "them" : "it"} fits your plan.`);
  return cur;
}

/**
 * The contract for a boost: the user ends up with MORE of the nutrient than they had. A fresh
 * random week can easily be worse than the one it replaced, so we upgrade the new week, and if
 * that still doesn't beat what the user already had, we upgrade their existing week instead —
 * less disruption, and the promise holds either way.
 */
function guaranteeBoost(
  profile: UserProfile,
  prev: WeekPlan,
  built: WeekPlan,
  key: MicroKey,
): { plan: WeekPlan; note?: string } {
  const level = (pl: WeekPlan) => weekMicroAverage(pl, key).amount;
  const before = level(prev);
  const candidates = [upgradeForNutrient(profile, built, key), upgradeForNutrient(profile, prev, key)];
  const best = candidates.reduce((a, b) => (level(b) > level(a) ? b : a));
  // Portion rebalancing can claw back what the swaps gained, so the win is verified, not assumed.
  if (level(best) > before) return { plan: best };
  return {
    plan: prev,
    note: `I couldn't put more ${MICRO_LABEL[key]} into your week than it already has, so I left it alone.`,
  };
}

/**
 * Name a condition-driven micronutrient bias to the user, honestly. Sits next to microNote and
 * mirrors symptomNote's rule: food guidance, and it points at a doctor. Never claims completeness —
 * the engine can only favour the nutrients it actually tracks.
 */
function conditionDisclosure(keys: MicroKey[]): string {
  const labels = keys.map((k) => MICRO_LABEL[k]);
  const list =
    labels.length === 1
      ? labels[0]
      : labels.slice(0, -1).join(", ") + " and " + labels[labels.length - 1];
  return (
    `Because your profile notes a condition that calls for more ${list}, I've favoured meals ` +
    `richer in ${list} while keeping your calories and protein on target. This is food guidance, ` +
    `not medical advice — check anything health-related with your doctor.`
  );
}

/**
 * A first-plan build that honours durable conditions/deficiencies in the profile: the PRIMARY
 * derived nutrient biases selection, the rest are secured in turn by guaranteeBoost. Macros stay
 * the hard invariant (every guaranteeBoost path ends in rebalanceWeek), and no already-secured
 * nutrient is allowed to fall below the unbiased baseline. Returns the plan (carrying its disclosure
 * notes when it adjusted anything) plus those notes.
 *
 * Reuses the existing boost machinery end-to-end — no new hard-coded tools. NOT yet wired into the
 * live generatePlan path: whether a fresh plan may auto-apply a condition (vs the assistant ASKing
 * first, and free-text matching's false-positive risk) is a product decision. See
 * CONDITION-AWARE-GEN.md. Exposed + tested so wiring is a one-line change once decided.
 */
export function selectConditionAwareWeek(profile: UserProfile): { plan: WeekPlan; notes: string[] } {
  const wanted = conditionBoosts(profile).filter((k) => nutrientReachable(profile, k));
  const baseline = rebalanceWeek(selectWeekFromDb(profile, undefined, false), profile);
  if (!wanted.length) return { plan: baseline, notes: [] };

  // The primary nutrient biases which dishes are chosen; a macro re-solve always follows.
  const primary = wanted[0];
  let plan = rebalanceWeek(selectWeekFromDb(profile, undefined, false, undefined, primary), profile);

  // Secure each wanted nutrient in turn. guaranteeBoost only accepts a strict gain for its own key,
  // but a later pass could claw an earlier one back down, so reject any pass that lowers an
  // already-secured nutrient.
  const secured: MicroKey[] = [];
  const EPS = 1e-6;
  for (const key of wanted) {
    const candidate = guaranteeBoost(profile, baseline, plan, key).plan;
    const holds = secured.every(
      (s) => weekMicroAverage(candidate, s).amount >= weekMicroAverage(plan, s).amount - EPS,
    );
    if (holds) {
      plan = candidate;
      secured.push(key);
    }
  }

  // Disclose only nutrients that actually ended above baseline — never claim a bias we couldn't
  // deliver from the library.
  const raised = secured.filter(
    (k) => weekMicroAverage(plan, k).amount > weekMicroAverage(baseline, k).amount + EPS,
  );
  const notes: string[] = [];
  if (raised.length) {
    notes.push(conditionDisclosure(raised));
    for (const k of raised) notes.push(microNote(plan, k));
  }
  return { plan: notes.length ? { ...plan, notes } : plan, notes };
}

/**
 * "I'm going out for dinner on Friday." The meal is in the FUTURE and its contents are unknown,
 * which makes it the opposite of log_meal: nothing about it is a fact.
 *
 * A nutritionist does two things here. They set aside a realistic calorie budget for the meal —
 * restaurant portions are large, and pretending otherwise is how a week quietly goes 3,000 kcal
 * over — and they do NOT count on it for protein, because you cannot know what you'll order. So
 * the reserved slot contributes calories and zero protein, and the rest of the day is re-solved
 * to carry the full protein target within what calories are left.
 *
 * Every assumption here is disclosed to the user. An estimate presented as a measurement is a lie.
 */
const RESTAURANT_SHARE = 0.4; // a restaurant main is a big meal, not an average one

/** Above this, a food is not a keto food. Bell peppers pass; rice, couscous and banana do not. */
const KETO_MAX_CARBS_PER_100G = 10;

function eatingOut(
  p: UserProfile,
  plan: WeekPlan,
  day: DayPlan["day"],
  mealType: Meal["type"],
  estimated: number | undefined,
  notes: string[],
): WeekPlan {
  const origDay = plan.days.find((d) => d.day === day);
  if (!origDay) return plan;
  // .map() below can only REPLACE a slot, never add one. On a 3-meal plan an eating_out for
  // "snack" silently reserved nothing while the note cheerfully claimed it had. Say the truth.
  if (!origDay.meals.some((m) => m.type === mealType)) {
    notes.push(`You don't have a ${mealType} on ${day}, so there's nothing for me to set aside there.`);
    return plan;
  }
  // A negative / non-finite estimate is treated as no estimate — otherwise `-300 ?? default` keeps
  // the -300 and reserves a negative block. Fall back to the computed restaurant-sized reserve.
  const reserve = estimated != null && estimated > 0 && Number.isFinite(estimated)
    ? estimated
    : Math.round(p.targetCalories * Math.max(slotShare(p, mealType), RESTAURANT_SHARE));

  const placeholder: Meal = {
    name: `${mealType[0].toUpperCase()}${mealType.slice(1)} out`,
    type: mealType,
    description: "Eating out — calories reserved. Log what you actually had and I'll rebalance.",
    calories: reserve,
    proteinGrams: 0,
    carbsGrams: 0,
    fatGrams: 0,
    timeMinutes: 0,
    ingredients: [],
    steps: ["Enjoy it. Tell me what you ate afterwards and I'll re-solve the rest of the week."],
  };

  const withReserve = origDay.meals.map((m) => (m.type === mealType ? placeholder : m));
  const rest = withReserve.filter((m) => m.type !== mealType);
  // Can the remaining meals even fit in what's left? At minimum portion (0.6x) they still cost
  // something; if the reserve eats the whole day, say so instead of quietly blowing the target.
  const restFloor = rest.reduce((sum, m) => {
    // A meal with no library recipe behind it (a logged meal, an earlier reserve) CANNOT be
    // rescaled — scaleToTargets skips it. Flooring it at 0.6x understated the day and silently
    // suppressed the "you'll be over target" warning on exactly the days that needed it.
    const base = RECIPES.find((r) => r.name === m.name);
    return sum + (base ? base.calories * SCALE_LO : m.calories);
  }, 0);

  // The reserved slot is fixed, and so is every pinned slot on that day.
  const meals = rebalanceDay(withReserve, p, new Set([mealType, ...lockedSlotsFor(p, day)]), namesOnOtherDays(plan, day, p));
  const total = meals.reduce((sum, m) => sum + m.calories, 0);
  const pct = Math.round((reserve / p.targetCalories) * 100);

  notes.push(
    `I've set aside ${reserve} kcal for ${day} ${mealType} — about ${pct}% of your day — and made the other meals lighter.`,
  );
  if (!estimated)
    notes.push(
      `That ${reserve} is a typical restaurant main, not a measured number. Tell me what you actually ate and I'll rebalance.`,
    );

  // Turn the protein gap into an INSTRUCTION, not an apology. The generic shortfall note would
  // say "these recipes can't reach 150g", which is false and unhelpful: the recipes are fine, we
  // deliberately booked no protein for a meal we can't see. What the user needs is what to order.
  const homeProtein = Math.round(meals.filter((m) => m.type !== mealType).reduce((sum, m) => sum + m.proteinGrams, 0));
  const wantProtein = Math.round(dayTargetMacros(p).protein);
  const gap = wantProtein - homeProtein;
  // Protein has 4 kcal per gram, so a reserve can only physically hold so much of it. Telling
  // someone to find 90g of protein inside a 300 kcal salad is advice that cannot be followed.
  const proteinCal = gap * 4;
  if (gap <= 10)
    notes.push(`Your other meals already carry your ${wantProtein}g of protein, so order whatever you fancy.`);
  else if (proteinCal > reserve)
    notes.push(
      `To finish on ${wantProtein}g you'd need about ${gap}g of protein from that meal, which is more than ${reserve} kcal can physically hold. Either it'll be a bigger meal than that, or you'll end the day around ${gap}g short — both are fine, just tell me which and I'll plan the week around it.`,
    );
  else
    notes.push(
      `Your other meals carry ${homeProtein}g of protein, so order something with roughly ${gap}g — a chicken, fish, steak or tofu main rather than a pasta or a pizza — and you'll finish the day on your ${wantProtein}g.`,
    );

  if (reserve + restFloor > p.targetCalories * 1.05)
    notes.push(
      `Heads up: even with everything else as light as I can make it, ${day} lands about ${Math.round(total - p.targetCalories)} kcal over target. I can pull the rest of your week down to absorb it — just say the word.`,
    );
  else notes.push(`${day} still comes to ${Math.round(total)} kcal, reserve included.`);

  return { ...plan, days: plan.days.map((d) => (d.day === day ? { ...d, meals } : d)) };
}

/**
 * Can this nutrient actually be raised, given the user's diet and exclusions? Offering to
 * "rebuild the week around your B12" when no vegan food in the library carries any is a false
 * promise. A nutritionist would say plainly that food alone won't cover it.
 */
function nutrientReachable(p: UserProfile, key: MicroKey): boolean {
  const tokens = exclusionTokens(p);
  // "Reachable" must mean the gap can actually be CLOSED, not that a trace exists. One meal
  // carrying a quarter of the daily reference means three such meals get the week near target.
  const meaningful = 0.25 * DAILY_REFERENCE[key];
  return RECIPES.some(
    (r) =>
      !r.treatOnly &&
      passesDiet(r, p.diet) &&
      !blockedByExclusions(r, tokens) &&
      recipeMicros(r).micros[key] > meaningful,
  );
}

/**
 * "How am I doing this week?" Every number here is COMPUTED — averages from the plan, micros
 * from the USDA-mapped ingredients. The model never states a figure it did not get from here.
 * Nutrients whose ingredient coverage is too thin are omitted rather than guessed at.
 */
/**
 * Exported for the agent's `report` read tool (`agentTools.ts`), which must not reimplement this.
 * It is pure — plan and profile in, a sentence out — and it is the same function the
 * `weekly_report` operation pushes as a note, so the agent and the user are told the same thing by
 * the same code.
 */
export function weeklyReportNote(plan: WeekPlan, p: UserProfile): string {
  const n = plan.days.length || 1;
  const sum = (f: (m: Meal) => number) => plan.days.reduce((s, d) => s + d.meals.reduce((a, m) => a + f(m), 0), 0);
  const kcal = Math.round(sum((m) => m.calories) / n);
  const protein = Math.round(sum((m) => m.proteinGrams) / n);
  const carbs = Math.round(sum((m) => m.carbsGrams) / n);
  const fat = Math.round(sum((m) => m.fatGrams) / n);
  const fiber = Math.round(sum((m) => m.fiberGrams ?? 0) / n);

  let s = `This week you average ${kcal} kcal a day (target ${p.targetCalories}), ${protein}g protein (target ${p.proteinGrams}g), ${carbs}g carbs, ${fat}g fat and ${fiber}g fiber.`;

  const calOff = kcal - p.targetCalories;
  if (Math.abs(calOff) > p.targetCalories * 0.1)
    s += ` That's ${Math.abs(calOff)} kcal ${calOff > 0 ? "above" : "below"} your target.`;
  const protOff = p.proteinGrams - protein;
  if (protOff > PROTEIN_MISS) s += ` Protein is ${protOff}g short.`;

  if (p.diet === "keto") {
    // Total carbs include fiber, which ketosis doesn't. Reporting 51g of carbs to someone who is
    // actually eating 30g net tells them they've failed when they haven't.
    const net = Math.max(0, Math.round(carbs - fiber));
    s +=
      net <= 50
        ? ` Net carbs — what counts for ketosis — average ${net}g a day, under the 50g that keeps you in it.`
        : ` Net carbs average ${net}g a day, above the 50g that keeps you in ketosis.`;
  }

  const fixable: string[] = [];
  const unfixable: string[] = [];
  let skipped = 0;
  for (const k of MICRO_KEYS) {
    const { amount, coverage } = weekMicroAverage(plan, k);
    if (coverage < 0.6) { skipped++; continue; }
    const pct = amount / DAILY_REFERENCE[k];
    if (pct >= 0.8) continue;
    const shown = `${MICRO_LABEL[k]} (${Math.round(pct * 100)}% of the daily reference)`;
    (nutrientReachable(p, k) ? fixable : unfixable).push(shown);
  }
  if (fixable.length)
    s += ` You're running low on ${fixable.join(", ")} — I can rebuild the week around ${fixable.length > 1 ? "any of them" : "it"}.`;
  if (unfixable.length) {
    const many = unfixable.length > 1;
    s += ` ${fixable.length ? "You're also low on" : "You're running low on"} ${unfixable.join(", ")}, and no food that fits your ${p.diet !== "none" ? p.diet + " " : ""}rules carries enough of ${many ? "them" : "it"} — that normally needs a fortified food or a supplement, which is worth raising with a doctor or dietitian.`;
  }
  if (!fixable.length && !unfixable.length) s += ` Your micronutrients all look adequate against the daily reference.`;
  if (skipped) s += ` (${skipped} nutrient${skipped > 1 ? "s" : ""} I can't measure reliably from these ingredients.)`;
  return s;
}

// Dish names used on days OTHER than `day` — so a single-day rebalance/upgrade
// doesn't introduce a dish already on the plate elsewhere in the week.
/**
 * Dishes a re-solve of `day` must not introduce, because they belong to another day.
 *
 * That includes any dish PINNED to another day, even if it isn't in the plan yet: a pin is
 * re-imposed after the rebuild, so a protein upgrade that grabs it now produces a week serving the
 * user's Sunday roast twice. (It did, in 1 of every 25 rebuilds.)
 */
function namesOnOtherDays(plan: WeekPlan, day: DayPlan["day"], profile?: UserProfile): Set<string> {
  const names = plan.days
    .filter((d) => d.day !== day)
    .flatMap((d) => d.meals.map((m) => m.name.toLowerCase()));
  for (const l of profile?.lockedMeals ?? []) if (l.day !== day) names.push(l.name.toLowerCase());
  return new Set(names);
}

/**
 * "I'm still hungry" / "that's way too much food".
 *
 * The model says which direction; these are the factors. Deliberately gentle — a nutritionist
 * nudges a portion, they don't halve it — and repeatable, because the clamp against the BASE
 * recipe means saying "smaller" five times saturates at 0.6x rather than compounding to nothing.
 */
const PORTION_FACTOR: Record<NonNullable<Operation["portionChange"]>, number> = {
  much_smaller: 0.75,
  smaller: 0.9,
  bigger: 1.1,
  much_bigger: 1.25,
};

/**
 * Resize the servings in a meal, a day, or the whole week.
 *
 * This is the one tool that deliberately moves a day OFF its calorie target: that is what the user
 * asked for. So it owes them three honest sentences — what the day now totals, what could not be
 * moved, and (for a change to the whole week) that a lasting change belongs in the target, not in
 * the portions.
 *
 * Two things it will not do. It will not rescale a meal with no recipe behind it — a restaurant
 * reserve, or something the user logged as eaten — because there are no ingredients to divide. And
 * it will not take a day below the calorie floor, however politely it's asked: "make it all much
 * smaller", repeated, must not become a starvation diet one step at a time.
 */
function scalePortions(
  p: UserProfile,
  plan: WeekPlan,
  change: NonNullable<Operation["portionChange"]>,
  day: string | undefined,
  mealType: string | undefined,
  notes: string[],
): WeekPlan {
  const factor = PORTION_FACTOR[change];
  const down = factor < 1;
  const floor = p.bodyStats?.sex ? CALORIE_FLOOR[p.bodyStats.sex] : DEFAULT_CALORIE_FLOOR;

  const inScope = (d: DayPlan, m: Meal) =>
    (!day || d.day === day) && (!mealType || m.type === mealType);

  const unscalable = new Set<string>();
  let atLimit = 0;
  let changed = 0; // meals actually rescaled — so we never CLAIM a change that didn't happen
  const blockedByFloor: string[] = [];

  const days = plan.days.map((d) => {
    if (day && d.day !== day) return d;

    const meals = d.meals.map((m) => {
      if (!inScope(d, m)) return m;
      const base = baseRecipeOf(m);
      if (!base) {
        unscalable.add(m.name);
        return m;
      }
      const current = m.calories / base.calories;
      const wanted = current * factor;
      const clamped = clampScale(wanted);
      if (Math.abs(clamped - current) < 0.02) {
        atLimit++;
        return m;
      }
      changed++;
      return { ...toMeal(scaleRecipeByFactor(base, clamped)), type: m.type };
    });

    // The floor is judged on the DAY, after everything in scope has moved. A single small meal is
    // fine; a day that adds up to less than someone can get their nutrients from is not.
    const total = meals.reduce((s, m) => s + m.calories, 0);
    if (down && total < floor) {
      blockedByFloor.push(d.day);
      return d; // leave the day exactly as it was
    }
    return { ...d, meals };
  });

  const scaled: WeekPlan = { ...plan, days };

  // Four scopes: one meal, one day, one slot across the week, or everything.
  const scope =
    day && mealType ? `${day} ${mealType}` : day ? day : mealType ? `every ${mealType}` : "the week";
  const word = change.replace("_", " ");
  if (blockedByFloor.length === plan.days.length || (day && blockedByFloor.length)) {
    notes.push(
      `I've left ${scope} as it is. Going smaller would drop ${blockedByFloor.length > 1 ? "those days" : "that day"} under ${floor} kcal, and below that it's very hard to get the nutrients you need. If you want to eat less overall, let's redo your targets properly — tell me your age, height, weight, sex and how active you are.`,
    );
    return plan;
  }

  // Nothing actually moved — don't claim it did. Say WHY: already at the sensible limit, nothing
  // resizable in scope (a restaurant reserve), or no such meal to resize at all.
  if (changed === 0) {
    if (atLimit)
      notes.push(`${scope[0].toUpperCase() + scope.slice(1)} ${atLimit === 1 ? "is" : "are"} already as ${down ? "small" : "big"} as a sensible portion goes — I've left ${atLimit === 1 ? "it" : "them"} be.`);
    else if (unscalable.size)
      notes.push(`I can't resize ${listPhrase([...unscalable])} — ${unscalable.size > 1 ? "they aren't recipes" : "that isn't a recipe"} of mine, so there's nothing to scale there.`);
    else
      notes.push(`There's nothing to resize on ${scope} — I couldn't find a meal there.`);
    return plan;
  }

  // The number has to match the scope. Reporting the week's average after the user resized one
  // day told them "Monday now averages 2028 kcal" when Monday came to 2201.
  const dayTotal = (d: DayPlan) => d.meals.reduce((t, m) => t + m.calories, 0);
  let note =
    day && mealType ? `Made ${scope} ${word}.`
    : day ? `Made ${day}'s meals ${word}.`
    : mealType ? `Made ${scope} ${word}.`
    : `Made every meal ${word}.`;
  if (day) {
    const total = dayTotal(scaled.days.find((d) => d.day === day)!);
    note += ` ${day} now comes to ${total} kcal against your ${p.targetCalories} kcal target.`;
  } else {
    const avg = Math.round(scaled.days.reduce((s, d) => s + dayTotal(d), 0) / scaled.days.length);
    note += ` Your week now averages ${avg} kcal a day against your ${p.targetCalories} kcal target.`;
  }

  if (blockedByFloor.length)
    note += ` I left ${listPhrase(blockedByFloor)} alone — going smaller would put ${blockedByFloor.length > 1 ? "them" : "it"} under ${floor} kcal.`;
  if (atLimit)
    note += ` ${atLimit === 1 ? "One meal was" : `${atLimit} meals were`} already as ${down ? "small" : "big"} as a sensible portion goes, so ${atLimit === 1 ? "it" : "they"} didn't move.`;
  if (unscalable.size)
    note += ` I couldn't resize ${listPhrase([...unscalable])} — ${unscalable.size > 1 ? "they aren't recipes" : "that isn't a recipe"} of mine.`;
  if (!day)
    note += ` If this is how you want to eat from now on, it belongs in your targets rather than your portions — say "work out my macros" and I'll set them properly.`;

  notes.push(note);
  return scaled;
}

/**
 * Resolve the dish a rating is about: the name the user said, or whatever is in the slot they
 * named. Returns null when neither identifies a real recipe.
 *
 * Only library recipes can be rated. A restaurant reserve or something the user logged has no
 * recipe behind it, so a rating on it could never change a future week — saying so beats storing
 * a preference that silently does nothing.
 */
function resolveRatedDish(plan: WeekPlan, dish?: string, day?: string, mealType?: string): Recipe | null {
  const want = dish?.trim().toLowerCase();
  if (want) {
    const exact = RECIPES.find((r) => r.name.toLowerCase() === want);
    if (exact) return exact;
    const fuzzy = RECIPES.filter((r) => nameMatches(r.name, want));
    if (fuzzy.length === 1) return fuzzy[0];
    // Ambiguous by name — fall through to the slot, which is unambiguous.
  }
  if (day && mealType) {
    const meal = plan.days.find((d) => d.day === day)?.meals.find((m) => m.type === mealType);
    if (meal) return RECIPES.find((r) => r.name === meal.name) ?? null;
  }
  return null;
}

/**
 * "That salmon was incredible" (5) / "never make me the tofu again" (1).
 *
 * A rating changes what the NEXT week looks like, not this one. We don't quietly rewrite a plan
 * the user is looking at because they passed a comment on a meal — we record the taste, and if the
 * dish is still coming up this week, we say where, so they can ask for a swap if they want one.
 */
function rateMealNote(plan: WeekPlan, recipe: Recipe, rating: number, day?: string, mealType?: string): string {
  const upcoming = plan.days
    .filter((d) => d.meals.some((m) => m.name === recipe.name))
    .map((d) => d.day)
    .filter((d) => !(d === day && mealType)); // the meal they just rated isn't "still coming up"

  if (rating >= 4) {
    const note = `Noted — you rated ${recipe.name} ${rating}/5. I'll reach for it more often.`;
    return note;
  }
  if (rating === 3) return `Noted — ${recipe.name} was a 3/5. I'll keep it in the rotation but won't favour it.`;

  const verb = rating === 1 ? `I won't plan ${recipe.name} again` : `I'll steer away from ${recipe.name}`;
  if (!upcoming.length) return `Noted — ${recipe.name} was a ${rating}/5. ${verb}.`;
  return `Noted — ${recipe.name} was a ${rating}/5. ${verb}. It's still on your ${upcoming.join(" and ")} this week; say "swap ${upcoming[0].toLowerCase()} ${recipe.type}" and I'll replace it now.`;
}

/**
 * Honest reporting for a nutrient boost: the achieved daily average against the reference
 * intake, plus the ingredient coverage behind it. We never present a number we half-guessed:
 * if too few ingredients resolved to USDA records, we say so instead of quoting a figure.
 */
function microNote(plan: WeekPlan, key: MicroKey): string {
  const { amount, coverage } = weekMicroAverage(plan, key);
  const label = MICRO_LABEL[key];
  const unit = MICRO_UNIT[key];
  if (coverage < 0.6)
    return `I've favoured ${label}-rich meals, but I can't put a reliable number on it — only ${Math.round(coverage * 100)}% of these ingredients have nutrition data.`;
  const pct = Math.round((amount / DAILY_REFERENCE[key]) * 100);
  const round = (x: number) => (x >= 10 ? Math.round(x) : Math.round(x * 10) / 10);
  return `Your week now averages about ${round(amount)}${unit} of ${label} a day — roughly ${pct}% of the daily reference.`;
}

// Execute a list of tool-call operations against the plan + profile, in order.
// `update_profile` changes persist to the profile; per-day overrides don't. This
// is the general executor the tool-calling assistant drives — no per-phrase rules,
// and multiple ops compose ("cheaper and vegetarian and no onions").
export function applyOperations(
  profile: UserProfile,
  plan: WeekPlan,
  operations: Operation[],
  /** The state before the LAST change, so `undo` can restore it. The server keeps none. */
  previous?: PlanSnapshot,
): {
  plan: WeekPlan;
  profile: UserProfile;
  notes: string[];
  replyOverride?: string;
  /** What ACTUALLY changed, compared. Not inferred from which tools were named: a swap for a dish
   *  we don't have is a no-op, and used to report "Done — I updated your plan." */
  planChanged: boolean;
  profileChanged: boolean;
  /** True when this turn restored a snapshot; the caller must then forget it. */
  undone: boolean;
} {
  const p: UserProfile = { ...profile };
  let curPlan = plan;
  let profileChanged = false;
  let undone = false;
  // Set when the engine must own the ENTIRE reply and the model's words are discarded — a
  // crisis or an urgent medical symptom. Nothing the LLM writes may sit in front of it.
  let replyOverride: string | undefined;

  /**
   * Put the user's pinned meals back. Called after EVERY rebuild, and always BEFORE the engine
   * states any number — otherwise achievementNote reports a week the user is not getting.
   *
   * `effective` is the profile the day is judged against. For regenerate_day it is the per-day
   * override ("make Tuesday vegan"), NOT the saved profile — otherwise a pinned beef bowl is
   * re-imposed onto a vegan Tuesday, and the day's other meals get re-solved against the wrong
   * diet too. A pin may never break a hard rule; that includes a rule the user set for one day.
   *
   * A pin that a permanent change made impossible is dropped for good and said out loud. A pin
   * that merely conflicts with a ONE-DAY override is skipped for that day and kept — the user
   * said "make Tuesday vegan", not "stop pinning my roast".
   */
  const applyLocks = (onlyDays?: Set<string>, effective?: UserProfile) => {
    if (!p.lockedMeals?.length) return;
    const eff = effective ?? p;
    const temporary = eff !== p;
    const res = reimposeLocks(eff, curPlan, onlyDays);
    curPlan = res.plan;
    if (!res.dropped.length) return;
    if (temporary) {
      for (const d of res.dropped)
        notes.push(`${d.lock.name} is pinned on ${d.lock.day}, but ${d.why} — I've left it out just for this change and kept the pin.`);
      return;
    }
    const gone = new Set(res.dropped.map((d) => lockKey(d.lock.day, d.lock.mealType)));
    p.lockedMeals = p.lockedMeals.filter((l) => !gone.has(lockKey(l.day, l.mealType)));
    profileChanged = true;
    for (const d of res.dropped)
      notes.push(`I couldn't keep ${d.lock.name} pinned on ${d.lock.day} — ${d.why}. I've unpinned it.`);
  };
  // Factual macro notes the LLM can't produce (it does no math) — the route appends
  // these so the assistant reports honestly what the engine did.
  const notes: string[] = [];

  for (const op of operations) {
    switch (op.tool) {
      case "update_profile": {
        if (op.diet) p.diet = op.diet;
        if (op.budget) p.budget = op.budget;
        if (op.mealsPerDay === 3 || op.mealsPerDay === 4) p.mealsPerDay = op.mealsPerDay;
        if (op.maxCookTime && op.maxCookTime > 0) p.maxCookTime = op.maxCookTime;
        if (op.targetCalories && op.targetCalories > 0) p.targetCalories = op.targetCalories;
        if (op.targetProtein && op.targetProtein > 0) p.proteinGrams = op.targetProtein;
        if (op.targetCarbs && op.targetCarbs > 0) p.carbsGrams = op.targetCarbs;
        if (op.targetFat && op.targetFat > 0) p.fatGrams = op.targetFat;
        if (op.excludeFoods?.length) p.dislikes = mergeDislikes(p.dislikes, op.excludeFoods);
        // A planning-mode switch (fresh <-> meal-prep). A mode CHANGE must rebuild from scratch in the
        // new mode, never keep-path the old mode's dishes (fix H3: batch->fresh keeping the batch's
        // repeats instead of 21 distinct dishes) — so capture it BEFORE applying the new mode.
        const modeChanged = !!op.planMode && op.planMode !== p.planMode;
        if (op.planMode) p.planMode = op.planMode;
        if (op.batchCadence) p.batchCadence = op.batchCadence;
        profileChanged = true;
        // Re-solve every day onto the macro targets so the base plan actually hits
        // protein/calories, not just each meal's calorie share. This re-solve PRESERVES the plan the
        // user built: keep every dish that still satisfies the CHANGED rules and only re-pick the
        // slots that now break, instead of a from-scratch week that silently discarded their swaps.
        // Diet and dislikes are hard; budget and cook-time force a replacement only when the user
        // actually tightened them this turn.
        {
          // Batch mode rebuilds the whole meal-prep week deterministically via buildWeek (=
          // selectBatchWeek + rebalanceBatchWeek). The fresh keep/cuisine/boost path below is left
          // UNTOUCHED (fix H2 — the one-arg gate is used ONLY for the batch branch, never over fresh's args).
          if (p.planMode === "batch") {
            curPlan = buildWeek(p);
            if (curPlan.notes?.length) notes.push(...curPlan.notes);
            applyLocks();
            notes.push(achievementNote("Your week now averages", weekAveragesFull(curPlan), p));
            break;
          }
          const rep = newReport();
          const prev = curPlan;
          const capNew = budgetCap(p.budget);
          const tokNew = exclusionTokens(p);
          const keepIf = (r: Recipe) =>
            passesDiet(r, p.diet) &&
            !blockedByExclusions(r, tokNew) &&
            (op.budget ? r.approxCost <= capNew : true) &&
            (op.maxCookTime && op.maxCookTime > 0 ? r.timeMinutes <= p.maxCookTime + 5 : true);
          // A re-THEME request (a cuisine, a fiber/nutrient push, or a fridge clear-out) is the user
          // asking for DIFFERENT dishes — those preferences only take effect during SELECTION, so a
          // "keep everything" pass would silently ignore them. Preserve edits only for FILTER and
          // TARGET changes; a re-theme reselects the week from scratch, exactly as before.
          const reTheme = !!(op.cuisine || fiberOn(op) || op.boostNutrient || op.useIngredients?.length);
          const built = selectWeekFromDb(p, normalizeCuisine(op.cuisine ?? null), fiberOn(op), op.useIngredients, op.boostNutrient ?? undefined, rep, (reTheme || modeChanged) ? undefined : { plan: prev, keepIf });
          curPlan = keepMacros(op) ? rebalanceWeek(built, p) : built;
          notes.push(...reportNotes(rep, p));
          if (op.boostNutrient) {
            const g = guaranteeBoost(p, prev, curPlan, op.boostNutrient);
            curPlan = g.plan;
            if (g.note) notes.push(g.note);
          }
          applyLocks();
          if (op.useIngredients?.length) curPlan = guaranteeFridge(p, curPlan, op.useIngredients, notes);
          if (keepMacros(op)) notes.push(achievementNote("Your week now averages", weekAveragesFull(curPlan), p));
          if (op.boostNutrient) notes.push(microNote(curPlan, op.boostNutrient));
        }
        break;
      }
      case "regenerate_week": {
        {
          // Batch mode regenerates the meal-prep week deterministically; the fresh path is unchanged.
          if (p.planMode === "batch") {
            curPlan = buildWeek(p);
            if (curPlan.notes?.length) notes.push(...curPlan.notes);
            applyLocks();
            notes.push(achievementNote("Your week now averages", weekAveragesFull(curPlan), p));
            break;
          }
          const rep = newReport();
          const prev = curPlan;
          const built = selectWeekFromDb(p, normalizeCuisine(op.cuisine ?? null), fiberOn(op), op.useIngredients, op.boostNutrient ?? undefined, rep);
          curPlan = keepMacros(op) ? rebalanceWeek(built, p) : built;
          notes.push(...reportNotes(rep, p));
          if (op.boostNutrient) {
            const g = guaranteeBoost(p, prev, curPlan, op.boostNutrient);
            curPlan = g.plan;
            if (g.note) notes.push(g.note);
          }
          applyLocks();
          if (op.useIngredients?.length) curPlan = guaranteeFridge(p, curPlan, op.useIngredients, notes);
          if (keepMacros(op)) notes.push(achievementNote("Your week now averages", weekAveragesFull(curPlan), p));
          if (op.boostNutrient) notes.push(microNote(curPlan, op.boostNutrient));
        }
        break;
      }
      case "regenerate_day": {
        if (!op.day) break;
        // In meal-prep mode a day's meals are servings from a cooking session, so rebuilding a single
        // day in isolation would break "cook once, eat across days". Refuse honestly rather than desync.
        if (p.planMode === "batch") {
          notes.push(`In meal-prep mode ${op.day}'s meals come from a batch you cook once, so I can't rebuild just that day without breaking the plan. Regenerate the whole week, or switch to Fresh to change a single day.`);
          break;
        }
        const tp: UserProfile = { ...p }; // per-day overrides — not persisted
        if (op.diet) tp.diet = op.diet;
        if (op.targetCalories && op.targetCalories > 0) tp.targetCalories = op.targetCalories;
        if (op.targetProtein && op.targetProtein > 0) tp.proteinGrams = op.targetProtein;
        if (op.excludeFoods?.length) tp.dislikes = mergeDislikes(tp.dislikes, op.excludeFoods);
        const rep = newReport();
        const newDay = selectDay(tp, op.day, curPlan, normalizeCuisine(op.cuisine ?? null), fiberOn(op), op.useIngredients, op.boostNutrient ?? undefined, rep);
        notes.push(...reportNotes(rep, tp));
        const meals = keepMacros(op)
          ? rebalanceDay(newDay.meals, tp, undefined, namesOnOtherDays(curPlan, op.day, tp))
          : newDay.meals;
        curPlan = { ...curPlan, days: curPlan.days.map((d) => (d.day === op.day ? { ...newDay, meals } : d)) };
        applyLocks(new Set([op.day]), tp);
        const finalDay = curPlan.days.find((d) => d.day === op.day);
        if (keepMacros(op) && finalDay) notes.push(achievementNote(`${op.day} now has`, dayTotalsFull(finalDay), tp));
        break;
      }
      case "swap_meal": {
        if (!op.dish) break;
        // Meal-prep: a meal is one serving of a batch cooked once. Swapping "Monday lunch" swaps the
        // WHOLE batch that serving belongs to (every day it feeds), so the cook stays in sync and every
        // serving stays identical. With no day, set the dish across every batch in that slot.
        if (p.planMode === "batch") {
          const match = findRecipeForSwap(op.dish, op.mealType ?? undefined, p);
          if (!match) {
            notes.push(`I don't have anything like "${op.dish}" that fits your plan, so I left the week as it is.`);
            break;
          }
          const slot = op.mealType ?? match.type;
          const targetBatchIds = new Set<string>();
          if (op.day) {
            const m = curPlan.days.find((d) => d.day === op.day)?.meals.find((x) => x.type === slot);
            if (m?.batchId) targetBatchIds.add(m.batchId);
          } else {
            for (const b of curPlan.batches ?? []) if (b.slot === slot) targetBatchIds.add(b.id);
          }
          if (!targetBatchIds.size) {
            notes.push(`You don't have a ${slot} batch to swap. Regenerate the week if you'd like ${match.name} added.`);
            break;
          }
          const share = localSplit(p.mealsPerDay).find((s) => s[0] === slot)?.[1] ?? 1 / p.mealsPerDay;
          const target = Math.round(p.targetCalories * share);
          const scaled = scaleRecipeToTarget(match, target);
          const plate = toMeal(scaled);
          curPlan = {
            ...curPlan,
            days: curPlan.days.map((d) => ({
              ...d,
              meals: d.meals.map((m) => (m.batchId && targetBatchIds.has(m.batchId) ? { ...plate, batchId: m.batchId } : m)),
            })),
            batches: (curPlan.batches ?? []).map((b) => targetBatchIds.has(b.id)
              ? {
                  ...b,
                  recipeName: match.name,
                  servingFactor: Math.max(0.6, Math.min(1.8, target / match.calories)),
                  perServing: {
                    calories: scaled.calories, proteinGrams: scaled.proteinGrams,
                    carbsGrams: scaled.carbsGrams, fatGrams: scaled.fatGrams,
                    ...(scaled.fiberGrams != null ? { fiberGrams: scaled.fiberGrams } : {}),
                  },
                }
              : b),
          };
          const asked = op.dish.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2);
          if (asked.length && asked.some((w) => !match.name.toLowerCase().includes(w)))
            notes.push(`I didn't have "${op.dish}" — I used ${match.name}.`);
          notes.push(op.day
            ? `Swapped your ${op.day} ${slot} to ${match.name} — that's a whole batch, so every day it feeds now has it.`
            : `Set ${match.name} as your ${slot} across the week.`);
          break;
        }
        // "Pancakes every day", "make every lunch a big salad" — NO specific day means apply the dish
        // to that slot on ALL days. This is the whole-week operation the model previously couldn't
        // express: it had to emit seven separate swaps, so it did one (Monday) and falsely claimed
        // "every day". Now it's a single, honest operation.
        if (!op.day) {
          const match = findRecipeForSwap(op.dish, op.mealType ?? undefined, p);
          if (!match) {
            notes.push(`I don't have anything like "${op.dish}" that fits your plan, so I left the week as it is.`);
            break;
          }
          const slot = op.mealType ?? match.type;
          let placedDays = 0;
          const scopedWeek = op.keepOtherMeals === true;
          // Meals OTHER than the swapped slot that the rebalancer replaced, across the week. This path
          // used to do that SILENTLY; replacing what the user did not mention is only acceptable said aloud.
          const replacedWeek: string[] = [];
          for (const day of DAYS) {
            const origDay = curPlan.days.find((d) => d.day === day);
            if (!origDay) continue;
            // Only days that HAVE this slot can be swapped — the .map below can't add one. Skipping
            // stops a "snack every day" on a 3-meal plan from silently rebalancing every day and then
            // claiming a swap that never happened (guarded after the loop).
            if (!origDay.meals.some((m) => m.type === match.type)) continue;
            // A pin on this slot is overridden by an explicit whole-week swap (and removed, quietly
            // here — one summary note below covers the week rather than seven pin notices).
            if (p.lockedMeals?.some((l) => l.day === day && l.mealType === slot)) {
              p.lockedMeals = p.lockedMeals.filter((l) => !(l.day === day && l.mealType === slot));
              profileChanged = true;
            }
            const dayShare = localSplit(p.mealsPerDay).find((s) => s[0] === match.type)?.[1] ?? 1 / p.mealsPerDay;
            const dish = toMeal(scaleRecipeToTarget(match, Math.round(p.targetCalories * dayShare)));
            const swapped = origDay.meals.map((m) => (m.type === match.type ? dish : m));
            // Scoped ("just the dinners"): resize the others, never replace them. Default: the macro-
            // preservation rebalance, which may replace a meal — collected so the note can say so.
            const newMeals = keepMacros(op)
              ? rebalanceDay(swapped, p, new Set([match.type, ...lockedSlotsFor(p, day)]), namesOnOtherDays(curPlan, day, p), { replaceOthers: !scopedWeek })
              : swapped;
            for (const nm of newMeals)
              if (nm.type !== match.type && !origDay.meals.some((om) => om.type === nm.type && om.name === nm.name))
                replacedWeek.push(`${day} ${nm.type} to ${nm.name}`);
            curPlan = { ...curPlan, days: curPlan.days.map((d) => (d.day === day ? { ...d, meals: newMeals } : d)) };
            placedDays++;
          }
          // No day had the slot — nothing was placed, so don't claim it was.
          if (placedDays === 0) {
            notes.push(`None of your days have a ${slot} to swap, so I left the week as it is. Tell me if you'd like to add ${match.name} as a new ${slot} and I'll fit it in.`);
            break;
          }
          const wanted = op.dish.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2);
          if (wanted.length && wanted.some((w) => !match.name.toLowerCase().includes(w)))
            notes.push(`I didn't have "${op.dish}" — I used ${match.name}.`);
          // Say what changed, then disclose the week's macros honestly (the same achievementNote the
          // regenerate paths use) rather than an unverified blanket "kept each day on target".
          notes.push(placedDays === DAYS.length
            ? `Set ${match.name} as your ${slot} every day.`
            : `Set ${match.name} as your ${slot} on the ${placedDays} day${placedDays === 1 ? "" : "s"} that have one.`);
          if (keepMacros(op)) {
            // Scoped = resizing only, so a shortfall is the cost of keeping the other meals, not a
            // limit of the library.
            let note = achievementNote("Your week now averages", weekAveragesFull(curPlan), p, { keptByChoice: scopedWeek });
            if (replacedWeek.length)
              note += ` To hold your macros I also changed ${replacedWeek.length} other meal${replacedWeek.length === 1 ? "" : "s"}: ${replacedWeek.slice(0, 3).join(", ")}${replacedWeek.length > 3 ? ", and more" : ""}.`;
            notes.push(note);
          }
          break;
        }
        // Macro-aware pick: matches the requested dish, tie-broken toward the slot's
        // macro profile (e.g. the protein-forward pancake on a high-protein plan).
        const match = findRecipeForSwap(op.dish, op.mealType ?? undefined, p);
        // A pin says "don't change this when you rebuild". An explicit swap of that very slot is a
        // newer, more specific instruction, so it wins — but the pin is removed and the user is
        // told, rather than the swap silently reverting on their next regeneration.
        //
        // mealType is OPTIONAL, so the slot that actually gets swapped is the matched recipe's.
        // Keying the unpin off op.mealType alone left the pin in place and the swap reverted on
        // the next rebuild, silently.
        const swapSlot = op.mealType ?? match?.type;
        if (swapSlot && p.lockedMeals?.some((l) => l.day === op.day && l.mealType === swapSlot)) {
          const gone = p.lockedMeals.find((l) => l.day === op.day && l.mealType === swapSlot)!;
          p.lockedMeals = p.lockedMeals.filter((l) => !(l.day === op.day && l.mealType === swapSlot));
          profileChanged = true;
          notes.push(`${gone.name} was pinned on ${op.day} — I've swapped it and removed the pin.`);
        }
        const origDay = curPlan.days.find((d) => d.day === op.day);
        if (!origDay) break;
        if (!match) {
          // Say WHY we couldn't. A silent no-op looks like the app ignored you.
          const loose = findRecipeForSwap(op.dish, op.mealType ?? undefined, p, false);
          notes.push(
            loose
              ? `${loose.name} takes ${loose.timeMinutes} min, over your ${p.maxCookTime}-min limit — I left ${op.day} as it is.`
              : `I don't have anything like "${op.dish}" that fits your plan.`,
          );
          break;
        }
        // swap_meal REPLACES a slot; the .map below cannot add one. On a 3-meal plan a swap for a
        // "snack" matches a real snack recipe but replaces nothing, then the note falsely claims the
        // day was updated — the missing-slot bug log_meal and eating_out already guard. A swap edits
        // an EXISTING slot, so (like eating_out) say the truth rather than fabricating one.
        if (!origDay.meals.some((m) => m.type === match.type)) {
          notes.push(`You don't have a ${op.mealType ?? match.type} on ${op.day} to swap. Tell me if you'd like to add one and I'll fit it in.`);
          break;
        }
        const share =
          localSplit(p.mealsPerDay).find((s) => s[0] === match.type)?.[1] ?? 1 / p.mealsPerDay;
        const meal = toMeal(scaleRecipeToTarget(match, Math.round(p.targetCalories * share)));
        // Be honest when we substituted something other than what was asked for.
        // "unicorn stew" matching "Cod & Smoky Bean Stew" is a reasonable guess, but
        // the user must be told — a silent wrong swap is worse than no swap.
        const asked = op.dish.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2);
        const got = match.name.toLowerCase();
        const unmatched = asked.filter((w) => !got.includes(w));
        if (asked.length && unmatched.length)
          notes.push(`I didn't have "${op.dish}" — I used ${match.name} instead.`);

        const swapped = origDay.meals.map((m) => (m.type === match.type ? meal : m));
        // Keep the day on its macro targets by rebalancing the OTHER meals — the swapped-in dish stays
        // as the user requested (locked). By default that may REPLACE another meal when resizing
        // cannot hold protein (the macro-preservation default in VISION.md), and the note says so.
        // When the user scoped the change ("just the dinner"), keepOtherMeals makes it resize-only.
        const scoped = op.keepOtherMeals === true;
        const scopedLocked = new Set([match.type, ...lockedSlotsFor(p, op.day)]);
        const avoid = namesOnOtherDays(curPlan, op.day, p);
        const newMeals = keepMacros(op)
          ? rebalanceDay(swapped, p, scopedLocked, avoid, { replaceOthers: !scoped })
          : swapped;
        curPlan = {
          ...curPlan,
          days: curPlan.days.map((d) => (d.day === op.day ? { ...d, meals: newMeals } : d)),
        };
        if (keepMacros(op)) {
          // Disclose the day's ACTUAL macros (the same achievementNote the regenerate and whole-week
          // swap paths use) instead of an unconditional "Kept on target". A large or lean requested
          // dish can push the day off target, and claiming "on target" when it isn't is the exact
          // dishonesty the two-layer design forbids.
          const finalDay = curPlan.days.find((d) => d.day === op.day);
          if (finalDay && scoped) {
            // What replacing another dish WOULD have bought, offered by name rather than done. The
            // same rebalance with lever 2 on, compared against the swap the user actually asked for.
            const offer = rebalanceDay(swapped, p, scopedLocked, avoid).filter(
              (nm) => nm.type !== match.type && !swapped.some((sm) => sm.type === nm.type && sm.name === nm.name),
            );
            let note = achievementNote(`${op.day} now has`, dayTotalsFull(finalDay), p, { keptByChoice: offer.length > 0 });
            if (offer.length)
              note += ` If you'd like protein closer to target, I could swap your ${offer.map((o) => `${o.type} to ${o.name}`).join(" and your ")} — just say so.`;
            notes.push(note);
          } else if (finalDay) {
            // Meals the engine replaced (a non-locked dish whose name changed) to hold the macros.
            // Never silent: replacing something the user did not mention is only acceptable said aloud.
            const bumped = newMeals.filter(
              (nm) => nm.type !== match.type && !origDay.meals.some((om) => om.type === nm.type && om.name === nm.name),
            );
            let note = achievementNote(`${op.day} now has`, dayTotalsFull(finalDay), p);
            if (bumped.length)
              note += ` I bumped your ${bumped.map((b) => `${b.type} to ${b.name}`).join(" and ")} to make room.`;
            notes.push(note);
          }
        }
        break;
      }
      case "compute_targets": {
        // The model gathers the facts; the arithmetic lives here. If a fact is missing we say
        // so rather than guessing a body weight.
        const missing = (
          [
            ["age", op.age],
            ["height", op.heightCm],
            ["weight", op.weightKg],
            ["sex", op.sex],
            ["activity level", op.activity],
          ] as const
        ).filter(([, v]) => v == null).map(([k]) => k);
        if (missing.length) {
          notes.push(`I need your ${missing.join(", ")} before I can work out your targets.`);
          break;
        }
        // Present but nonsensical (0, negative, non-finite) must be refused too — this is the layer
        // that does the arithmetic so the model never does, and it must not turn a bad number into a
        // NaN/negative calorie or protein target.
        const bad = (
          [
            ["age", op.age],
            ["height", op.heightCm],
            ["weight", op.weightKg],
          ] as const
        ).filter(([, v]) => !Number.isFinite(v as number) || (v as number) <= 0).map(([k]) => k);
        if (bad.length) {
          notes.push(`Your ${bad.join(", ")} doesn't look right — I can only work targets from real, positive numbers.`);
          break;
        }
        const t = computeTargets({
          age: op.age!,
          heightCm: op.heightCm!,
          weightKg: op.weightKg!,
          sex: op.sex!,
          activity: op.activity!,
          goal: op.goal ?? p.goal,
        });
        p.goal = op.goal ?? p.goal;
        p.targetCalories = t.calories;
        p.proteinGrams = t.proteinGrams;
        p.carbsGrams = t.carbsGrams;
        p.fatGrams = t.fatGrams;
        // Remember the facts, not just what we computed from them. Without the weight, the app
        // cannot answer "how much water should I drink?" without asking for it a second time.
        p.bodyStats = {
          age: op.age!, heightCm: op.heightCm!, weightKg: op.weightKg!,
          sex: op.sex!, activity: op.activity!,
        };
        profileChanged = true;
        const rep = newReport();
        if (p.planMode === "batch") {
          // Batch mode: rebuild the meal-prep week onto the new targets (deterministic).
          curPlan = buildWeek(p);
          if (curPlan.notes?.length) notes.push(...curPlan.notes);
        } else {
          // Targets changed, not constraints — every current dish is still valid, so keep them all and
          // just re-scale onto the new macros (a from-scratch week would needlessly reshuffle dishes).
          const tok = exclusionTokens(p);
          const keepIf = (r: Recipe) => passesDiet(r, p.diet) && !blockedByExclusions(r, tok);
          curPlan = rebalanceWeek(selectWeekFromDb(p, undefined, false, undefined, undefined, rep, { plan: curPlan, keepIf }), p);
        }
        applyLocks();
        notes.push(
          explainTargets(t, {
            age: op.age!, heightCm: op.heightCm!, weightKg: op.weightKg!,
            sex: op.sex!, activity: op.activity!, goal: p.goal,
          }),
        );
        notes.push(...reportNotes(rep, p));
        notes.push(achievementNote("Your week now averages", weekAveragesFull(curPlan), p));
        break;
      }
      case "log_meal": {
        // "I ate a burger for lunch." Real life derails plans constantly; the plan should absorb
        // it rather than pretend. What you ate is a FACT — it is locked, along with everything
        // earlier in the day — and only the meals still ahead of you are re-solved.
        if (!op.day || !op.mealType) break;
        const origDay = curPlan.days.find((d) => d.day === op.day);
        if (!origDay) break;

        let eaten: Meal | null = null;
        if (op.dish) {
          // Search ALL slots, not just the logged one: pizza is a "dinner" recipe but people
          // eat it at lunch. respectSoft=false because they already ate it — cook time and
          // budget are irrelevant to a meal that is already in the past.
          const match = findRecipeForSwap(op.dish, undefined, p, false);
          if (match) eaten = { ...toMeal(match), type: op.mealType };
        }
        // Guard the model's number the way update_profile/compute_targets do: a negative or non-finite
        // logged calorie count is "truthy", was locked into the day, and then the rebalancer inflated
        // the other meals to cover the phantom deficit. A bad number is treated as no number, so we
        // fall through to the !eaten branch below and ask, rather than poisoning the day.
        if (!eaten && op.loggedCalories && op.loggedCalories > 0 && Number.isFinite(op.loggedCalories)) {
          eaten = {
            name: op.dish ? op.dish : "Logged meal",
            type: op.mealType,
            description: "Logged by you.",
            calories: op.loggedCalories,
            proteinGrams: op.loggedProtein && op.loggedProtein > 0 ? op.loggedProtein : 0,
            carbsGrams: 0,
            fatGrams: 0,
            timeMinutes: 0,
            ingredients: [],
            steps: [],
          };
        }
        if (!eaten) {
          notes.push(`I don't know what's in "${op.dish ?? "that"}" — roughly how many calories was it?`);
          break;
        }
        if (op.dish && !op.loggedCalories && eaten.proteinGrams === 0 && !eaten.ingredients.length)
          notes.push(`I logged it at ${eaten.calories} kcal but I don't know its protein.`);

        // Everything already eaten today is fixed — and so is anything the user pinned. Without
        // this, logging a 1400 kcal breakfast rescaled the pinned dinner to its 0.6x floor and the
        // protein-upgrade lever was free to replace the dish outright.
        const locked = new Set([...slotsUpTo(op.mealType), ...lockedSlotsFor(p, op.day)]);
        // A logged meal is a FACT to absorb, not an edit to an existing slot. If the day has no slot
        // of this type (a 3-meal plan, a snack logged), ADD it — a plain replace-map would drop the
        // eaten meal, rebalance the day as if it never happened, and then the note would claim
        // calories the plan never actually carried (silent data loss + a false accounting).
        const hasSlot = origDay.meals.some((m) => m.type === op.mealType);
        const withEaten = hasSlot
          ? origDay.meals.map((m) => (m.type === op.mealType ? eaten! : m))
          : [...origDay.meals, eaten!];
        const newMeals = rebalanceDay(withEaten, p, locked, namesOnOtherDays(curPlan, op.day, p));
        curPlan = { ...curPlan, days: curPlan.days.map((d) => (d.day === op.day ? { ...d, meals: newMeals } : d)) };

        const tot = dayTotals({ ...origDay, meals: newMeals });
        const ahead = newMeals.filter((m) => !locked.has(m.type));
        const changed = ahead.filter((nm) => !origDay.meals.some((om) => om.type === nm.type && om.name === nm.name));
        let note = `Logged ${eaten.name} (${eaten.calories} kcal) for ${op.mealType}.`;
        if (ahead.length === 0) note += ` That was your last meal of the day — ${op.day} lands at ${tot.kcal} kcal and ${tot.protein}g protein.`;
        else {
          note += ` I re-solved the rest of ${op.day}: it now lands at ${tot.kcal} kcal and ${tot.protein}g protein.`;
          if (changed.length) note += ` I switched your ${changed.map((c) => `${c.type} to ${c.name}`).join(" and ")}.`;
        }
        const over = tot.kcal - p.targetCalories;
        if (Math.abs(over) > p.targetCalories * 0.15)
          note += ` That's still ${Math.abs(over)} kcal ${over > 0 ? "over" : "under"} your ${p.targetCalories} kcal target — there isn't enough left in the day to fix it.`;
        const pShort = p.proteinGrams - tot.protein;
        if (pShort > PROTEIN_MISS)
          note += ` Protein lands at ${tot.protein}g against your ${p.proteinGrams}g target — what you ate didn't leave room to make it up.`;
        notes.push(note);
        break;
      }
      case "eating_out": {
        if (!op.day || !op.mealType) {
          notes.push("Which day and which meal are you eating out for?");
          break;
        }
        curPlan = eatingOut(p, curPlan, op.day, op.mealType, op.estimatedCalories ?? undefined, notes);
        break;
      }
      case "lock_meal": {
        if (!op.day || !op.mealType) {
          notes.push("Which meal would you like me to pin — which day, and breakfast, lunch or dinner?");
          break;
        }
        const day = curPlan.days.find((d) => d.day === op.day);
        const meal = day?.meals.find((m) => m.type === op.mealType);
        if (!meal) {
          notes.push(`You don't have a ${op.mealType} on ${op.day} to pin.`);
          break;
        }
        // Pins are stored by name and re-cooked from the library on every rebuild, so a meal we
        // can't rebuild (a restaurant reserve, something the user logged) cannot be pinned.
        if (!RECIPES.some((r) => r.name === meal.name)) {
          notes.push(`${meal.name} isn't one of my recipes — it's something you told me about, so I can't pin it.`);
          break;
        }
        p.lockedMeals = [
          ...(p.lockedMeals ?? []).filter((l) => !(l.day === op.day && l.mealType === op.mealType)),
          { day: op.day, mealType: op.mealType, name: meal.name },
        ];
        profileChanged = true;
        notes.push(`Pinned: ${meal.name} stays as your ${op.day} ${op.mealType}. I'll build the rest of the week around it.`);
        break;
      }
      case "unlock_meal": {
        if (!op.day || !op.mealType) {
          notes.push("Which pin should I remove — which day, and which meal?");
          break;
        }
        const had = p.lockedMeals?.find((l) => l.day === op.day && l.mealType === op.mealType);
        if (!had) {
          notes.push(`Nothing is pinned on ${op.day} ${op.mealType}.`);
          break;
        }
        p.lockedMeals = (p.lockedMeals ?? []).filter((l) => !(l.day === op.day && l.mealType === op.mealType));
        profileChanged = true;
        notes.push(`Unpinned ${had.name} — I can change ${op.day} ${op.mealType} again.`);
        break;
      }
      case "undo": {
        if (!previous) {
          notes.push("There's nothing to undo — I haven't changed anything yet.");
          break;
        }
        curPlan = previous.plan;
        // Replace the working profile wholesale. Assigning field-by-field would leave anything the
        // last turn ADDED (a pin, a rating, a stored body weight) sitting on the restored profile.
        for (const k of Object.keys(p)) delete (p as unknown as Record<string, unknown>)[k];
        Object.assign(p, previous.profile);
        profileChanged = true;
        undone = true;
        notes.push(`Done — I've put things back to how they were before I ${previous.label}.`);
        break;
      }
      case "scale_portions": {
        if (!op.portionChange) {
          notes.push("Would you like the portions bigger or smaller?");
          break;
        }
        curPlan = scalePortions(p, curPlan, op.portionChange, op.day ?? undefined, op.mealType ?? undefined, notes);
        break;
      }
      case "rebalance_day": {
        // "Balance my day around this" — the coach move after importing a meal. scaleToTargets holds
        // anything without a base recipe (an imported meal, a logged meal, a restaurant reserve) as a
        // FIXED contribution and rescales the day's OTHER meals' portions to hit the calorie/macro
        // target around it. Portions only — it never swaps the dishes the user chose.
        if (!op.day) {
          notes.push("Which day should I balance around your other meals?");
          break;
        }
        const dp = curPlan.days.find((d) => d.day === op.day);
        if (!dp) {
          notes.push(`I don't see ${op.day} in your plan.`);
          break;
        }
        const scaled = scaleToTargets(dp.meals, p);
        const changed = scaled.some((m, i) => JSON.stringify(m) !== JSON.stringify(dp.meals[i]));
        if (!changed) {
          notes.push(`${op.day} is already balanced around your targets — nothing to move.`);
          break;
        }
        curPlan = { ...curPlan, days: curPlan.days.map((d) => (d.day === op.day ? { ...d, meals: scaled } : d)) };
        const total = Math.round(scaled.reduce((s, m) => s + m.calories, 0));
        const tgt = Math.round(dayTargetMacros(p).cal);
        const off = total - tgt;
        notes.push(
          Math.abs(off) <= 60
            ? `Balanced ${op.day} around your other meals — the day now lands at about ${total} kcal, on your ${tgt} target.`
            : `Balanced ${op.day} as far as realistic portions allow: about ${total} kcal, still ${off > 0 ? `${off} over` : `${-off} under`} your ${tgt} target — the fixed meal is too ${off > 0 ? "large" : "small"} for the rest of the day to fully offset.`,
        );
        break;
      }
      case "hydration": {
        // Read-only. The weight comes from the profile (compute_targets stored it) or from what
        // the user just said. We never guess a body weight — the same rule compute_targets follows.
        const weightKg = op.weightKg ?? p.bodyStats?.weightKg;
        if (!weightKg) {
          notes.push("How much do you weigh? Fluid needs scale with body weight, and I'd rather ask than guess.");
          break;
        }
        // No stored activity means we don't know it. Assume the least, and say so below — a
        // sedentary baseline under-promises, where guessing "active" would over-promise.
        const known = op.activity ?? p.bodyStats?.activity;
        const activity = known ?? "sedentary";
        if (op.weightKg || op.activity) {
          // They just told us something. Keep it, so we never ask twice.
          p.bodyStats = {
            ...p.bodyStats,
            ...(op.weightKg ? { weightKg: op.weightKg } : {}),
            ...(op.activity ? { activity: op.activity } : {}),
          };
          profileChanged = true;
        }
        let note = explainHydration(hydrationTarget(weightKg, activity), weightKg, activity);
        if (!known) note += " I've assumed you're not training much — tell me how active you are and I'll adjust it.";
        notes.push(note);
        break;
      }
      case "rate_meal": {
        const rating = op.rating;
        if (rating == null) {
          notes.push("How would you rate it, 1 to 5?");
          break;
        }
        const recipe = resolveRatedDish(curPlan, op.dish ?? undefined, op.day ?? undefined, op.mealType ?? undefined);
        if (!recipe) {
          notes.push(
            op.dish
              ? `I don't have a recipe called "${op.dish}" — which day and meal was it?`
              : "Which meal are you rating — which day, and breakfast, lunch or dinner?",
          );
          break;
        }
        p.mealRatings = [
          ...(p.mealRatings ?? []).filter((r) => r.name.toLowerCase() !== recipe.name.toLowerCase()),
          { name: recipe.name, rating: rating as MealRating["rating"] },
        ];
        profileChanged = true;
        notes.push(rateMealNote(curPlan, recipe, rating, op.day ?? undefined, op.mealType ?? undefined));
        break;
      }
      case "symptom_check": {
        // Read-only, and deliberately so: a symptom never silently rewrites someone's food.
        const res = symptomNote(curPlan, p, op.symptom ?? op.dish ?? "");
        notes.push(res.text);
        if (res.override) replyOverride = res.text;
        break;
      }
      case "substitute_ingredient": {
        // Read-only advice: the user is at the counter, not asking for a new plan.
        notes.push(
          substituteNote(curPlan, p, op.ingredient ?? op.dish ?? "", op.day ?? undefined, op.mealType ?? undefined),
        );
        break;
      }
      case "explain_meal": {
        // Read-only: justify, never change.
        if (!op.day || !op.mealType) {
          notes.push("Which meal would you like me to explain — which day, and breakfast, lunch or dinner?");
          break;
        }
        notes.push(explainMealNote(curPlan, p, op.day, op.mealType));
        break;
      }
      case "weekly_report": {
        // Read-only: report, never change. Facts computed here; the model narrates them.
        notes.push(weeklyReportNote(curPlan, p));
        break;
      }
      case "answer":
        break;
    }
  }

  // Compared, not inferred. `planWasChanged(operations)` asks which tools were NAMED; this asks
  // what actually moved. A swap for a dish we don't have is a no-op, and used to tell the user
  // "Done — I updated your plan."
  const planChanged = JSON.stringify(curPlan) !== JSON.stringify(plan);
  return {
    plan: curPlan,
    profile: profileChanged ? p : profile,
    notes,
    replyOverride,
    planChanged,
    profileChanged,
    undone,
  };
}

/** Seeded so a preview is reproducible: the selector picks at random among near-tied recipes, and a
 *  preview that disagreed with itself on two consecutive renders would be worse than no preview. */
const PREVIEW_SEED = 0x9e3d;

/**
 * Run operations against a COPY and report what they would do, committing nothing.
 *
 * This is what makes a confirm-before-commit interface honest: a button can show the consequence of
 * a change — the new day totals, the deltas, which dishes move, and anything the engine would refuse
 * or relax — before the user accepts it. The UI then commits the SAME operations through
 * `applyOperations`.
 *
 * Two things it is careful about:
 *  - It `structuredClone`s both profile and plan first, so a preview can never leak into the real
 *    week. The caller's objects are untouched even if an operation mutates deeply.
 *  - It reuses `dayTotals`, the engine's own arithmetic, rather than recomputing totals beside it.
 *    (`agentTools.whatIf` still carries its own copy of that helper for the model-facing read
 *    surface; collapsing the two onto this one belongs to the plan/execute split — see
 *    docs/v1/02-module-map.md.)
 *
 * A preview is a PREDICTION, not a promise: it is seeded, the commit is not, so a caller must show
 * the committed figures from `applyOperations` rather than keeping the previewed ones on screen.
 */
export function previewOperations(
  profile: UserProfile,
  plan: WeekPlan,
  operations: Operation[],
): {
  /** The engine's own account, including what it would refuse or relax. */
  notes: string[];
  wouldChangePlan: boolean;
  wouldChangeProfile: boolean;
  days: {
    day: DayPlan["day"];
    kcal: number;
    protein: number;
    deltaKcal: number;
    deltaProtein: number;
    /** The day's calorie target, so the UI can say "this takes you 180 over" without doing maths. */
    targetKcal: number;
  }[];
  /** Only the slots whose dish actually changes, so the UI can list the moves it is about to make. */
  moves: { day: DayPlan["day"]; slot: Meal["type"]; from: string; to: string }[];
} {
  const p = structuredClone(profile);
  const base = structuredClone(plan);
  const before = base.days.map((d) => ({ day: d.day, ...dayTotals(d) }));

  const res = withSeed(PREVIEW_SEED, () => applyOperations(p, base, operations));

  const target = dayTargetMacros(p).cal;
  const days = res.plan.days.map((d, i) => {
    const t = dayTotals(d);
    return {
      day: d.day,
      kcal: t.kcal,
      protein: t.protein,
      deltaKcal: t.kcal - (before[i]?.kcal ?? 0),
      deltaProtein: t.protein - (before[i]?.protein ?? 0),
      targetKcal: Math.round(target),
    };
  });

  const moves: { day: DayPlan["day"]; slot: Meal["type"]; from: string; to: string }[] = [];
  res.plan.days.forEach((d, i) => {
    d.meals.forEach((m, j) => {
      // Compare slot-for-slot against the pre-change plan. `plan` is the caller's original; `base`
      // was handed to the executor and may have been mutated, so it is not a safe "before".
      const from = plan.days[i]?.meals[j];
      if (from && from.name !== m.name) {
        moves.push({ day: d.day, slot: m.type, from: from.name, to: m.name });
      }
    });
  });

  return {
    notes: res.notes,
    wouldChangePlan: res.planChanged,
    wouldChangeProfile: res.profileChanged,
    days,
    moves,
  };
}

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
