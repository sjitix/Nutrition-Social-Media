/**
 * Meal-prep mode: a few cooked batches feeding several days each, chosen for how long they keep
 * and whether they freeze. A batch serving is never rescaled by the rebalancer.
 *
 * Part of the plan engine (src/lib/plan/, layer L3), split out of recipeDb.ts on 2026-10-03 (V1
 * milestone A3). The public surface is ./index.ts; an export here that index.ts does not re-export
 * is internal to this folder, and check:boundaries fails anything outside the folder that imports it.
 */
import { DAYS, type Meal, type UserProfile, type WeekPlan, type Batch, type CookingSession } from "../core";
import { type Recipe } from "../data";
import { scaleRecipeToTarget, toMeal } from "./library";
import { budgetCap, exclusionTokens, localSplit, ratingMap } from "./rules";
import { type LockedSlots, rebalanceDay, rebalanceWeek } from "./rebalance";
import { batchCandidates, selectWeekFromDb, withSeed } from "./select";

// ===========================================================================
// Meal-prep / batch mode — a deterministic SIBLING of the fresh selector above.
// Instead of a distinct dish per meal, it picks a small OVERLAPPING set per slot per
// cooking SESSION, cooks each in bulk, and ROTATES the servings across the session's
// days so no two consecutive days are identical. The bulk multiplier lives on a NEW
// axis (`Batch.totalServings`), never on per-plate macros or the clamped scalers, and
// never on `Meal.servings` (that stays the macro divisor). The fresh path above is
// untouched. See docs/batch-mode/.
// ===========================================================================

const BATCH_SEED = 0x5eed;

 // batch selection is deterministic by construction; the seed only guards any RNG a reused helper might touch

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
