/**
 * Nutrient boosts as a GUARANTEE rather than a bias (only a strict improvement is accepted), and
 * the condition-aware week built on them.
 *
 * Part of the plan engine (src/lib/plan/, layer L3), split out of recipeDb.ts on 2026-10-03 (V1
 * milestone A3). The public surface is ./index.ts; an export here that index.ts does not re-export
 * is internal to this folder, and check:boundaries fails anything outside the folder that imports it.
 */
import { type UserProfile, type WeekPlan } from "../core";
import { conditionBoosts } from "../data";
import { MICRO_LABEL, type MicroKey } from "../nutrition";
import { RECIPES, baseRecipeOf, recipeMicros, scaleRecipeToTarget, toMeal } from "./library";
import { bannedForUser, blockedByExclusions, exclusionTokens, localSplit, passesDiet } from "./rules";
import { rebalanceWeek } from "./rebalance";
import { importBreaks, selectWeekFromDb } from "./select";
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
  /** The profile before the change that came with the boost, so an import is judged as the re-solve
   *  judged it (importBreaks). Omitted: only the allergies are judged against imports. */
  before?: UserProfile,
  /** How the week the person had may stay, as the rest of THIS request lets it. null: not at all (a
   *  cuisine, a fiber push, a different number of meals). Otherwise `prev` itself when the request asked
   *  nothing else (`unchanged`) and it fits the rules, and else `resolve()`: `prev` re-solved under the
   *  request, its rule-breaking dishes re-picked and its portions following new targets (the keep path),
   *  run only when needed because a re-solve is not byte-identical even when nothing changes. It replaced:
   *  - handing back `prev` whatever came with the boost, which dropped the other change with no word (E4:
   *    a 1600 kcal target in 8 of 8 seeded runs, "Italian" in 8 of 8, a low budget in 1 of 8; 2026-10-21);
   *  - dropping `prev` whole when one dish broke a rule, which lowered the nutrient for no reason under a
   *    note blaming the rules: excluding greek yogurt with a zinc boost took zinc from 28.1 to 26.8 mg a
   *    day, where removing that one dish leaves 27.5 and the two changes asked apart reach 28.7 (review). */
  keep: { unchanged: boolean; resolve: () => WeekPlan } | null = { unchanged: true, resolve: () => prev },
): { plan: WeekPlan; note?: string } {
  const EPS = 1e-6;
  const level = (pl: WeekPlan) => weekMicroAverage(pl, key).amount;
  const start = level(prev);
  const label = MICRO_LABEL[key];
  // A week is a candidate only while every dish in it passes the rules as they are NOW. A diet change or a
  // new exclusion arriving in the same request as the boost used to upgrade the old week in place: its
  // unreplaced dishes kept the old rules, so "go vegetarian, and more B12" returned salmon and tuna in a
  // "vegetarian" week, with no word said (models lane audit, iron-veg#2).
  const prevFits = fitsHardRules(prev, profile, before);
  const kept = !keep ? null : keep.unchanged && prevFits ? prev : keep.resolve();
  const keptOk = !!kept && fitsHardRules(kept, profile, before);
  // The kept week itself is a candidate too: portion rebalancing can claw back what an upgrade's swaps
  // gained, so the win is verified, never assumed.
  const candidates = [upgradeForNutrient(profile, built, key), ...(keptOk ? [upgradeForNutrient(profile, kept!, key), kept!] : [])];
  const best = candidates.reduce((a, b) => (level(b) > level(a) ? b : a));
  if (level(best) > start + EPS) return { plan: best };
  if (keptOk && kept === prev) {
    return { plan: prev, note: `I couldn't put more ${label} into your week than it already has, so I left it alone.` };
  }
  // The week has to change for the rest of the request, and the nutrient could not rise above where it
  // was. Say what the boost achieved, and give the true reason: "less" only when there is less (it once
  // fired at 0 -> 0), the old week's rule-breaking dishes by name when they are the reason, and no claim
  // that what was used is the richest possible (the upgrade is greedy, not a maximum).
  const less = level(best) < start - EPS;
  if (!prevFits) {
    const broke = brokenDishes(prev, profile, before);
    const why = broke.length === 1 ? `${broke[0]} no longer fits your rules`
      : broke.length <= 3 ? `${broke.slice(0, -1).join(", ")} and ${broke[broke.length - 1]} no longer fit your rules`
      : `${broke.length} of its dishes, among them ${broke[0]} and ${broke[1]}, no longer fit your rules`;
    return {
      plan: best,
      note: less
        ? `Your week has less ${label} than before: ${why}, and nothing that fits made up for ${broke.length === 1 ? "it" : "them"}.`
        : `I couldn't put more ${label} into your week while keeping to your rules.`,
    };
  }
  return {
    plan: best,
    note: less
      ? `Your week has less ${label} than before, with the other changes you asked for.`
      : `I couldn't put more ${label} into your week while making the other changes you asked for.`,
  };
}

/** The names of the week's dishes that break the profile's hard rules (fitsHardRules, dish by dish). */
function brokenDishes(plan: WeekPlan, profile: UserProfile, before?: UserProfile): string[] {
  const tokens = exclusionTokens(profile);
  const names = plan.days.flatMap((d) => d.meals).filter((m) => {
    if (importBreaks(m, profile, before)) return true;
    const r = baseRecipeOf(m);
    return !!r && (!passesDiet(r, profile.diet) || blockedByExclusions(r, tokens));
  }).map((m) => m.name);
  return [...new Set(names)];
}

/** Every dish in the week passes the profile's hard rules: a library dish its diet, allergies and
 *  exclusions (looked up the way rebalanceWeek looks it up); an imported dish what importBreaks judges,
 *  on its own text first. A logged or eating-out entry passes: it records what was eaten. */
function fitsHardRules(plan: WeekPlan, profile: UserProfile, before?: UserProfile): boolean {
  const tokens = exclusionTokens(profile);
  return plan.days.every((d) =>
    d.meals.every((m) => {
      if (importBreaks(m, profile, before)) return false;
      const r = baseRecipeOf(m);
      return !r || (passesDiet(r, profile.diet) && !blockedByExclusions(r, tokens));
    }),
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
