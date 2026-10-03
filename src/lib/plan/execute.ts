/**
 * The only code allowed to change a plan, and to say that it changed. applyOperations runs every
 * tool; previewOperations runs it against a clone and commits nothing. Never mutates its inputs; a
 * refusal is reported, never faked; planChanged is a deep comparison, never a guess.
 *
 * Part of the plan engine (src/lib/plan/, layer L3), split out of recipeDb.ts on 2026-10-03 (V1
 * milestone A3). The public surface is ./index.ts; an export here that index.ts does not re-export
 * is internal to this folder, and check:boundaries fails anything outside the folder that imports it.
 */
import { DAYS, type DayPlan, type Meal, type Operation, type UserProfile, type WeekPlan, type LockedMeal, type MealRating, type PlanSnapshot } from "../types";
import { computeTargets, explainTargets, hydrationTarget, explainHydration, CALORIE_FLOOR, DEFAULT_CALORIE_FLOOR } from "../targets";
import { type Recipe } from "../data/seeds";
import { wordMatches } from "../exclusions";
import { RECIPES, baseRecipeOf, scaleRecipeToTarget, toMeal } from "./library";
import { bannedForUser, blockedByExclusions, budgetCap, exclusionTokens, fiberOn, keepMacros, localSplit, mergeDislikes, normalizeCuisine, passesDiet } from "./rules";
import { SCALE_LO, clampScale, dayTargetMacros, macroDistance, rebalanceDay, rebalanceWeek, recipeMacros, scaleRecipeByFactor, scaleToTargets, slotShare, slotTargetMacros, slotsUpTo } from "./rebalance";
import { newReport, reportNotes, selectDay, selectWeekFromDb, withSeed } from "./select";
import { buildWeek } from "./batch";
import { PROTEIN_MISS, achievementNote, dayTotals, dayTotalsFull, explainMealNote, listPhrase, microNote, rateMealNote, resolveRatedDish, substituteNote, symptomNote, weekAveragesFull, weeklyReportNote } from "./report";
import { guaranteeBoost } from "./boost";

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
    const hayWords = hay.split(/[^a-z]+/).filter((h) => h.length >= 3);
    let kw = 0;
    // A substring hit, OR the asked word is an inflection of a whole word in the dish: "pancakes"
    // must find "Chickpea Flour Pancake". Substring alone missed it, and it surfaced the day a remembered
    // lactose intolerance became binding: the only pancake left was singular-named, so "pancakes every
    // day" answered "I don't have anything like pancakes". This only ADDS matches — every request that
    // matched before still matches the same way. (The wider fuzzy-match rewrite is D6's.)
    for (const w of words) if (hay.includes(w) || hayWords.some((h) => wordMatches(w, h))) kw++;
    if (kw > 0) scored.push({ r, kw });
  }
  if (scored.length === 0) return null;
  const maxKw = Math.max(...scored.map((s) => s.kw));
  const top = scored.filter((s) => s.kw === maxKw).map((s) => s.r);
  if (top.length === 1) return top[0];
  const st = slotTargetMacros(profile, type ?? top[0].type);
  return top.slice().sort((a, b) => macroDistance(recipeMacros(a), st) - macroDistance(recipeMacros(b), st))[0];
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
const RESTAURANT_SHARE = 0.4;

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

// Execute a list of tool-call operations against the plan + profile, in order.
// `update_profile` changes persist to the profile; per-day overrides don't. This
// is the general executor the tool-calling assistant drives — no per-phrase rules,
// and multiple ops compose ("cheaper and vegetarian and no onions").
/**
 * "Did anything the user can see change?" — a deep comparison that ignores ingredient `slug`s.
 *
 * A slug is an identity annotation (D5), not content. Plans saved before D5 carry none, and any meal
 * the engine rebuilds from the library now does, so a plain JSON comparison saw every rebuilt meal as
 * changed: "Balance Monday" on an untouched, already-balanced pre-D5 day answered "Balanced Monday…"
 * with planChanged=true, Fix my week counted it as fixed, the preview showed a change, and sync pushed
 * a write — on every day, once. Found by an adversarial review before D5 shipped.
 */
function sameContent(a: unknown, b: unknown): boolean {
  const dropSlug = (k: string, v: unknown) => (k === "slug" ? undefined : v);
  return JSON.stringify(a, dropSlug) === JSON.stringify(b, dropSlug);
}

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
        // Per-day cook time and budget ("quick dinners on weekdays", "cheaper on Friday"): the
        // day-scoped constrain now passes them, so the day honours them too. Not persisted, like the
        // other per-day overrides above.
        if (op.maxCookTime && op.maxCookTime > 0) tp.maxCookTime = op.maxCookTime;
        if (op.budget) tp.budget = op.budget;
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
        const changed = scaled.some((m, i) => !sameContent(m, dp.meals[i]));
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
  const planChanged = !sameContent(curPlan, plan);
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
