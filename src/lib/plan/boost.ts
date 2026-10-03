/**
 * Nutrient boosts as a GUARANTEE rather than a bias (only a strict improvement is accepted), and
 * the condition-aware week built on them.
 *
 * Part of the plan engine (src/lib/plan/, layer L3), split out of recipeDb.ts on 2026-10-03 (V1
 * milestone A3). The public surface is ./index.ts; an export here that index.ts does not re-export
 * is internal to this folder, and check:boundaries fails anything outside the folder that imports it.
 */
import { type UserProfile, type WeekPlan } from "../core/types";
import { conditionBoosts } from "../data/conditions";
import { MICRO_LABEL, type MicroKey } from "../nutrition/nutrients";
import { RECIPES, recipeMicros, scaleRecipeToTarget, toMeal } from "./library";
import { bannedForUser, blockedByExclusions, exclusionTokens, localSplit, passesDiet } from "./rules";
import { rebalanceWeek } from "./rebalance";
import { selectWeekFromDb } from "./select";
import { conditionDisclosure, microNote, nutrientReachable, weekMicroAverage } from "./report";

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
 * The contract for a boost: the user ends up with MORE of the nutrient than they had. A fresh
 * random week can easily be worse than the one it replaced, so we upgrade the new week, and if
 * that still doesn't beat what the user already had, we upgrade their existing week instead —
 * less disruption, and the promise holds either way.
 */
export function guaranteeBoost(
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
