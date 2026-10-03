/**
 * Choose the week's dishes so every hard rule holds and the macros land as close to target as
 * the library allows. Seeded through withSeed, so a preview or a test can reproduce a week exactly.
 *
 * Part of the plan engine (src/lib/plan/, layer L3), split out of recipeDb.ts on 2026-10-03 (V1
 * milestone A3). The public surface is ./index.ts; an export here that index.ts does not re-export
 * is internal to this folder, and check:boundaries fails anything outside the folder that imports it.
 */
import { DAYS, type DayPlan, type Meal, type UserProfile, type WeekPlan } from "../core/types";
import { microDensity, DAILY_REFERENCE, type MicroKey } from "../nutrition/nutrients";
import { type Cuisine, type Recipe } from "../data/seeds";
import { RECIPES, recipeMicros, scaleRecipeToTarget, toMeal } from "./library";
import { type SlotSplit, bannedForUser, blockedByExclusions, budgetCap, exclusionTokens, localSplit, passesDiet, ratingMap } from "./rules";
import { slotTargetMacros } from "./rebalance";

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

function newCtx(): WeekCtx {
  return { proteinDays: {}, usedIds: new Set(), usedNames: new Set(), usedIngredients: new Set() };
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

/**
 * Eligible dishes for one slot, under the same HARD rules + SOFT-relaxation ladder the fresh
 * selector uses. Kept as its own copy (close to pickMealsForDay's candidate block) so the fresh hot
 * path is provably untouched for M1; a later milestone may share it.
 */
export function batchCandidates(profile: UserProfile, type: Recipe["type"], cap: number, tokens: string[]): Recipe[] {
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
