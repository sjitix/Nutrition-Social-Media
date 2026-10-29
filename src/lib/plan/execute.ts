/**
 * The only code allowed to change a plan, and to say that it changed. applyOperations runs every
 * tool; previewOperations runs it against a clone and commits nothing. Never mutates its inputs; a
 * refusal is reported, never faked; planChanged is a deep comparison, never a guess.
 *
 * Part of the plan engine (src/lib/plan/, layer L3), split out of recipeDb.ts on 2026-10-03 (V1
 * milestone A3). The public surface is ./index.ts; an export here that index.ts does not re-export
 * is internal to this folder, and check:boundaries fails anything outside the folder that imports it.
 */
import { DAYS, type DayPlan, type Meal, type Operation, type UserProfile, type WeekPlan, type LockedMeal, type MealRating, type PlanSnapshot } from "../core";
import { computeTargets, explainTargets, hydrationTarget, explainHydration, CALORIE_FLOOR, DEFAULT_CALORIE_FLOOR, BODY_LIMITS, bodyStatProblems, bodyStatMessage, isRealBody, referenceWeightKg } from "../nutrition/client";
import { type Recipe } from "../data";
import { CRISIS_REPLY, MICRO_LABEL, exclusionCovers, haystackBlocked, mealHaystack, parseExclusionTokens, wordMatches, type MicroKey } from "../nutrition";
import { RECIPES, baseRecipeOf, isRecord, recordKind, scaleQuantity, scaleRecipeToTarget, toMeal } from "./library";
import { bannedForUser, blockedByExclusions, budgetCap, exclusionKey, exclusionTokens, fiberOn, isSeafood, isSeafoodWord, keepMacros, localSplit, mergeDislikes, normalizeCuisine, passesDiet, wantsSeafood } from "./rules";
import { SCALE_LO, clampScale, dayTargetMacros, macroDistance, rebalanceDay, rebalanceWeek, recipeMacros, scaleRecipeByFactor, scaleToTargets, slotShare, slotTargetMacros, slotsUpTo } from "./rebalance";
import { brokenImports, importBreaks, importNotes, newReport, reportNotes, selectDay, selectWeekFromDb, withSeed, type ReplacedImport } from "./select";
import { buildWeek } from "./batch";
import { PROTEIN_MISS, achievementNote, dayTotals, dayTotalsFull, explainMealNote, figuresNote, listPhrase, microNote, rateMealNote, resolveRatedDish, substituteNote, symptomNote, weekAveragesFull, weeklyReportNote } from "./report";
import { guaranteeBoost } from "./boost";

// Macro-aware swap: among the recipes that match the requested dish name, pick the
// one whose macro profile best fits the slot — so "pancakes" on a high-protein plan
// auto-selects the protein-forward pancake (the user never has to say "protein").
/** The words of a swap request that count toward a match (three letters or more). "sea food" is one word. */
const askedWords = (query: string) => query.toLowerCase().replace(/\bsea\s+food/g, "seafood").split(/[^a-z]+/).filter((w) => w.length > 2);

/** How many of the request's words a dish matches: the swap lookup's own score. A substring hit, OR the
 *  asked word is an inflection of a whole word in the dish: "pancakes" must find "Chickpea Flour Pancake".
 *  Substring alone missed it, and it surfaced the day a remembered lactose intolerance became binding:
 *  the only pancake left was singular-named, so "pancakes every day" answered "I don't have anything like
 *  pancakes". (The wider fuzzy-match rewrite is D6's.) */
function keywordHits(words: string[], r: Recipe, seafood = false): number {
  const hay = `${r.name} ${r.description} ${r.ingredients.map((i) => i.name).join(" ")}`.toLowerCase();
  const hayWords = hay.split(/[^a-z]+/).filter((h) => h.length >= 3);
  // "seafood" is met by any fish or shrimp dish, when the request asks for it (rules.ts, wantsSeafood).
  return words.filter((w) => (seafood && isSeafoodWord(w) ? isSeafood(r) : hay.includes(w) || hayWords.some((h) => wordMatches(w, h)))).length;
}

/** Words a request carries that no dish name is asked to: "some seafood", "a seafood dinner for tonight". */
const FILLER = new Set(["some", "any", "the", "and", "for", "with", "nice", "good", "something", "please", "more", "dinner", "lunch", "breakfast", "snack", "meal", "dish", "tonight", "today", "tomorrow"]);
/** The words of a swap request the placed dish does not carry, for the "I didn't have …" note. "seafood" is
 *  carried by any fish or shrimp dish: "I didn't have \"seafood\" — I used Cod Curry" was false, and so was
 *  "I didn't have \"some seafood\"" over a tuna bake. */
const unmetWords = (dish: string, match: Recipe) => {
  const sea = wantsSeafood(dish);
  const got = match.name.toLowerCase();
  return askedWords(dish).filter((w) => !FILLER.has(w) && !(sea && isSeafoodWord(w) && isSeafood(match)) && !got.includes(w));
};

/** Words that size or place a meal someone ate without naming the food: "a slice of pizza", "leftover chilli". */
const PORTION = new Set(["slice", "slices", "bowl", "bowls", "plate", "plates", "piece", "pieces", "portion", "portions", "serving", "servings", "cup", "cups", "half", "big", "small", "large", "huge", "little", "homemade", "leftover", "leftovers", "ate", "had", "just", "bit", "lot", "lots", "our", "my", "was", "then"]);
/**
 * Whether a library dish IS the food someone says they ate. A log is a fact, so the swap lookup's best keyword guess
 * is not good enough: "office birthday cake" was logged as Cottage Cheese Pancakes, its calories and all, on "cake"
 * inside "pancakes" (D6, the fuzzy match). Two conditions: every word naming the food is a whole word of the dish's
 * name (or an inflection of one), and one of them is a HEAD of the name, the last word of a part split at "&", "and"
 * or "with": "pizza" is Pepperoni & Mozzarella Pizza, "chilli" is not Chilli-Lime Prawn Tacos, and "chicken caesar"
 * is not a Grilled Chicken Caesar Wrap. A food that fails is asked about, or logged at the person's own figure.
 */
const foodWords = (said: string) => askedWords(said).filter((w) => !FILLER.has(w) && !PORTION.has(w));
function namesSameFood(said: string, r: Recipe): boolean {
  const words = foodWords(said);
  const same = (w: string, h: string) => wordMatches(w, h) || wordMatches(h, w);
  const name = r.name.toLowerCase().split(/[^a-z]+/).filter((h) => h.length >= 3);
  const heads = r.name.toLowerCase().split(/\s*(?:&|\band\b|\bwith\b|,)\s*/).map((part) => part.split(/[^a-z]+/).filter(Boolean).pop() ?? "");
  return words.length > 0 && words.every((w) => name.some((h) => same(w, h))) && words.some((w) => heads.some((h) => same(w, h)));
}

/**
 * "I kept shellfish out: it's in your allergies." A request for seafood under an allergy to part of it (shrimp,
 * or fish) is answered with the part that is left, and says what it left out and why (the models lane's
 * diagnosis, step 11). Null when the request is not for seafood or no allergy touches it. Given the dish it
 * `placed`, it names it too, because "seafood" names no dish: "I used White Bean & Tuna Bake, and kept shellfish
 * out…" (the models lane's wording note); with no allergy touching it, "I used White Bean & Tuna Bake."
 */
function seafoodKeptOut(dish: string, p: UserProfile, placed?: string): string | null {
  if (!wantsSeafood(dish)) return null;
  const allergies = parseExclusionTokens(p.allergies ?? "", "");
  const blocks = (part: string) => allergies.filter((t) => haystackBlocked(part, [t]));
  const named = uniqueByKey([...blocks("shrimp"), ...blocks("salmon"), ...blocks("cod")]).map(shownToken);
  const why = named.length ? `kept ${listPhrase(named)} out: ${pluralList(named) ? "they're" : "it's"} in your allergies.` : "";
  if (placed) return why ? `I used ${placed}, and ${why}` : `I used ${placed}.`;
  return why ? `I ${why}` : null;
}

// Dish match wins first; macro fit only breaks ties between equally-matching dishes.
// `respectSoft` = also honour the user's cook-time / ingredient-count limits. We try
// with them on first; if nothing fits we retry with them off purely to tell the user
// WHY we couldn't do it ("that dahl takes 30 min, over your 15-min limit").
function findRecipeForSwap(
  query: string,
  type: Recipe["type"] | undefined,
  profile: UserProfile,
  respectSoft = true,
  // Only dishes this accepts are considered (a log asks for the same food: namesSameFood).
  accept: (r: Recipe) => boolean = () => true,
): Recipe | null {
  const words = askedWords(query);
  const seafood = wantsSeafood(query);
  if (words.length === 0) return null;
  const cap = budgetCap(profile.budget);
  const tokens = exclusionTokens(profile);
  const eligible = (r: Recipe) =>
    (!type || r.type === type) &&
    passesDiet(r, profile.diet) &&
    !blockedByExclusions(r, tokens) &&
    r.approxCost <= cap &&
    accept(r) &&
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
    const kw = keywordHits(words, r, seafood);
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
 * Saying WHY a dish was refused
 *
 * After a shellfish allergy bound, "swap in the Shrimp & Tomato Rice" answered "I didn't have "Shrimp &
 * Tomato Rice" — I used Turkey & Bean Chilli instead": the library has it, and the reason, the allergy,
 * was hidden at the one moment a wrongly bound allergy would surface (review of 49385e5, LC-07). So when
 * a lookup fails or lands on another dish, the SAME lookup runs again with the allergies and dislikes
 * cleared, only to explain. What it finds is named in a note and NEVER placed.
 * ------------------------------------------------------------------------- */

/** The tokens as the person would name them: one per key, and none another in the list already covers, so a
 *  compound the matcher keeps for an allergy is never named beside it ("Tofu Pad Thai contains noodles and rice
 *  noodle", "That also took tortilla and corn tortilla off your allergies"; review, 2026-10-22). Of two that
 *  cover each other, the first stays. */
const uniqueByKey = (tokens: string[]) => {
  const seen = new Set<string>();
  const once = tokens.filter((t) => !seen.has(exclusionKey(t)) && Boolean(seen.add(exclusionKey(t))));
  // Judged on the words: does the other one, read as an allergy (with the compounds it keeps), block this one?
  const covers = (u: string, t: string) => haystackBlocked(t, parseExclusionTokens(u, ""));
  return once.filter((t, i) => !once.some((u, j) => j !== i && covers(u, t) && (!covers(t, u) || j < i)));
};
const pluralList = (items: string[]) => items.length > 1 || /[^siu]s$/.test(items[0] ?? "");
/** A typed "coeliac" blocks gluten, and the dish contains gluten, not "coeliac". */
const shownToken = (t: string) => (/^c(?:o)?eli(?:ac|ak)s?$/.test(t) ? "gluten" : t);

/** "shellfish, which is in your allergies" / "mushrooms, which you avoid" — or null when neither the
 *  allergies nor the dislikes block this recipe. */
function exclusionReason(r: Recipe, p: UserProfile): string | null {
  const hay = mealHaystack(r.name, r.ingredients.map((i) => i.name), r.steps);
  const hits = (tokens: string[]) => uniqueByKey(tokens.filter((t) => haystackBlocked(hay, [t]))).map(shownToken);
  const allergy = [...new Set(hits(parseExclusionTokens(p.allergies ?? "", "")))];
  const avoid = [...new Set(hits(parseExclusionTokens("", p.dislikes ?? "")))].filter((t) => !allergy.includes(t));
  const parts = [
    ...(allergy.length ? [`${listPhrase(allergy)}, which ${pluralList(allergy) ? "are" : "is"} in your allergies`] : []),
    ...(avoid.length ? [`${listPhrase(avoid)}, which you avoid`] : []),
  ];
  return parts.length ? parts.join(", and ") : null;
}

/**
 * The dish the person asked for, if a rule of theirs kept it out, with the clause that says which rule:
 * "contains shellfish, which is in your allergies" or "isn't vegetarian". Used for a note and nothing
 * else: what it finds is NEVER placed. `placed` is what the real lookup chose (null when it found none).
 *
 * Named only when it is really the dish asked for (review of B2, 2026-10-20): an EXACT name, or a dish
 * matching strictly more of the request's words than the one placed. The lookup with the allergies
 * cleared used to break a word tie differently and blame an allergy for "veggie burger" ("Cheeseburger &
 * Fries contains dairy") or "a light soup", in 45 of 92 refused-dish notes; and a dish the DIET refused
 * was explained by another dish's allergy.
 */
function refusedForExclusions(
  query: string,
  type: Recipe["type"] | undefined,
  p: UserProfile,
  placed: Recipe | null,
  respectSoft = true,
): { dish: Recipe; why: string } | null {
  const q = query.trim().toLowerCase();
  const named = RECIPES.find((r) => r.name.toLowerCase() === q && (!type || r.type === type));
  if (named) {
    if (named.name === placed?.name) return null;
    const reason = exclusionReason(named, p);
    if (reason) return { dish: named, why: `contains ${reason}` };
    if (!passesDiet(named, p.diet)) return { dish: named, why: `isn't ${p.diet}` };
    return null;
  }
  const free = findRecipeForSwap(query, type, { ...p, allergies: "", dislikes: "" }, respectSoft);
  if (!free || free.name === placed?.name) return null;
  // It must match EVERY word asked for, in its NAME: "veggie burger" is not a cheeseburger, even when
  // "burger" is the only word anything in the library matches. Words found only in a dish's ingredients or
  // description used to count, so the note still named a dish nobody asked for (review, 2026-10-21).
  const words = askedWords(query);
  const nameHits = (r: Recipe) => {
    const name = r.name.toLowerCase();
    const nameWords = name.split(/[^a-z]+/).filter((h) => h.length >= 3);
    return words.filter((w) => name.includes(w) || nameWords.some((h) => wordMatches(w, h))).length;
  };
  const hits = nameHits(free);
  if (hits < words.length || hits <= (placed ? nameHits(placed) : 0)) return null;
  const reason = exclusionReason(free, p);
  return reason ? { dish: free, why: `contains ${reason}` } : null;
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

/** A recipe at exactly `f` times its portion, unclamped: for a meal the person says they ate, whose size is a
 *  fact the planner's 0.6-1.8x portion range does not apply to. */
function atFactor(r: Recipe, f: number): Recipe {
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

function lockKey(day: string, mealType: string): string {
  return `${day}|${mealType}`;
}

function lockedSlotsFor(p: UserProfile, day: DayPlan["day"]): Set<Meal["type"]> {
  return new Set((p.lockedMeals ?? []).filter((l) => l.day === day).map((l) => l.mealType));
}

/** A boost asked in meal-prep mode: the batches are built without it, and the reply says so. It was dropped
 *  with nothing said (E6, review 2026-10-21). */
const batchBoostNote = (key: MicroKey) =>
  `In meal-prep mode I can't favour ${MICRO_LABEL[key]} yet, so your batches are planned as usual.`;

/**
 * Every dish a re-plan left over the person's cook-time limit, named, read off the operation's FINAL
 * week. The selector meets the limit exactly while anything fits, so a dish over it means nothing
 * quicker fits the rest of the rules for that slot. Named: the dishes this operation placed, or, when the
 * operation set the limit itself, every dish in reach. Not named: a pinned dish (the person's own
 * choice), an imported one (placed on purpose), and one `skip` says another note already explains (a
 * use-up dish: guaranteeFridge says why it runs long). The selector's own count went stale whenever a
 * rebalance swapped its slow pick for a quicker one, and it said nothing about a dish up to 5 minutes
 * over, so "15 minutes or less" got a 20-minute dinner with no word (models lane, 2026-10-21).
 */
function overLimitNote(
  prev: WeekPlan,
  plan: WeekPlan,
  p: UserProfile,
  opts: { limitSet: boolean; days?: ReadonlySet<string>; skip?: (m: Meal) => boolean },
): string[] {
  const over: string[] = [];
  for (const d of plan.days) {
    if (opts.days && !opts.days.has(d.day)) continue;
    const pinned = lockedSlotsFor(p, d.day);
    const before = prev.days.find((x) => x.day === d.day);
    for (const m of d.meals) {
      if (m.sourceUrl || pinned.has(m.type) || opts.skip?.(m)) continue;
      const base = baseRecipeOf(m);
      if (!base || base.timeMinutes <= p.maxCookTime) continue;
      if (!opts.limitSet && before?.meals.find((x) => x.type === m.type)?.name === m.name) continue;
      over.push(`${base.name} (${d.day}'s ${m.type}, ${base.timeMinutes} min)`);
    }
  }
  if (!over.length) return [];
  if (over.length === 1) return [`Nothing quicker fits your other rules there, so ${over[0]} runs over your ${p.maxCookTime}-min limit.`];
  const shown = over.length > 4 ? [...over.slice(0, 3), `${over.length - 3} more`] : over;
  return [`Nothing quicker fits your other rules for these, so ${over.length} dishes run over your ${p.maxCookTime}-min limit: ${listPhrase(shown)}.`];
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

/**
 * Put the person's records back where they were before a re-plan (V1 D7): every meal they logged as eaten,
 * every meal set aside for eating out, and every recipe they imported that still keeps to the rules. A
 * boost, a re-theme, a fridge clear-out, a new week and a mode switch all select from scratch, and took all
 * three out with nothing said (27 of 27 re-plans in the D7 probe, 9 of 9 boosts on `ef71993`). Called after
 * the pins go back, so a record outranks a pin in the same slot: what was eaten is a fact. Each day a
 * record went back into is re-solved around it with it held fixed, as log_meal and eating_out do.
 *
 * An import that breaks a rule the change brought (importBreaks against `before`) is not put back: the
 * re-solve already took it out and named it. A logged meal whose slot the day no longer has (a snack, after
 * dropping to three meals) is added, as log_meal adds it; a reservation or an import there is lost, and said.
 */
function reimposeRecords(
  p: UserProfile,
  plan: WeekPlan,
  from: WeekPlan,
  onlyDays?: ReadonlySet<string>,
  before?: UserProfile,
): { plan: WeekPlan; lost: string[] } {
  const lost: string[] = [];
  const days = plan.days.map((d) => {
    if (onlyDays && !onlyDays.has(d.day)) return d;
    const was = from.days.find((x) => x.day === d.day);
    const records = (was?.meals ?? []).filter((m) => isRecord(m) || (m.sourceUrl && !importBreaks(m, p, before)));
    if (!records.length) return d;
    const meals = [...d.meals];
    let changed = false;
    for (const r of records) {
      const i = meals.findIndex((m) => m.type === r.type);
      if (i >= 0) {
        if (sameContent(meals[i], r)) continue;
        meals[i] = r;
      } else if (recordKind(r) === "logged") {
        meals.push(r);
      } else {
        lost.push(`${r.name} on ${d.day}`);
        continue;
      }
      changed = true;
    }
    if (!changed) return d;
    // In meal-prep mode the day's other meals are servings of batches cooked once, identical on every day they
    // feed: resizing them around the record would break that, so the record goes back and the day is not
    // re-solved.
    if (p.planMode === "batch") return { ...d, meals };
    const fixed = new Set<Meal["type"]>([...records.map((r) => r.type), ...lockedSlotsFor(p, d.day)]);
    return { ...d, meals: rebalanceDay(meals, p, fixed, namesOnOtherDays(plan, d.day, p)) };
  });
  return { plan: { ...plan, days }, lost };
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
function guaranteeFridge(
  p: UserProfile,
  plan: WeekPlan,
  wanted: string[],
  notes: string[],
  /** Collects the dishes placed over the cook-time limit, which this function's own note explains. */
  explained?: Set<string>,
): WeekPlan {
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

    // Displace a slot of the same type that is neither pinned, the person's own (a record or an import:
    // V1 D7), nor already earning its keep.
    const target = cur.days.find((d) => {
      const m = d.meals.find((x) => x.type === pick.type);
      return !!m && !pinned.has(lockKey(d.day, m.type)) && !isRecord(m) && !m.sourceUrl && !want.some((w) => uses(m, w));
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
    if (relaxed.includes(ing)) explained?.add(pick.name);
  }

  if (relaxed.length)
    notes.push(`Nothing with ${listPhrase(relaxed)} fits your ${p.maxCookTime}-min limit, so that meal takes a little longer.`);
  if (forcedBanned.length)
    notes.push(`The only dish I have that uses ${listPhrase(forcedBanned)} is one you rated poorly — I've used it anyway so nothing goes to waste.`);
  // An ingredient only the allergies or dislikes rule out says so (LC-07): "use up the shrimp" after a
  // shellfish allergy used to read "nothing I have with it fits your plan". Those dishes are only named.
  const unexplained: string[] = [];
  const inWeek = new Set(cur.days.flatMap((d) => d.meals.map((m) => m.name.toLowerCase())));
  for (const ing of unusable) {
    const withIt = RECIPES.filter(
      (r) =>
        !r.treatOnly && passesDiet(r, p.diet) && !inWeek.has(r.name.toLowerCase()) &&
        r.ingredients.some((i) => i.name.trim().toLowerCase() === ing),
    );
    const reasons = withIt.every((r) => blockedByExclusions(r, tokens)) ? withIt.map((r) => exclusionReason(r, p)) : [];
    if (!reasons.length || reasons.some((x) => !x)) {
      unexplained.push(ing);
      continue;
    }
    const why = [...new Set(reasons)];
    notes.push(why.length === 1
      ? `I couldn't work ${ing} into the week — ${withIt.length === 1 ? "the only dish I have with it contains" : "the dishes I have with it contain"} ${why[0]}.`
      : `I couldn't work ${ing} into the week — every dish I have with it contains something in your allergies or that you avoid.`);
  }
  if (unexplained.length)
    notes.push(`I couldn't work ${listPhrase(unexplained)} into the week — nothing I have with ${unexplained.length > 1 ? "them" : "it"} fits your plan.`);
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
    record: "out",
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
    // suppressed the "you'll be over target" warning on exactly the days that needed it. Looked up the way
    // rebalanceDay looks it up: an import titled like a library dish is held fixed there, so flooring it at
    // the library dish's portion hid the warning (review, 2026-10-21).
    const base = baseRecipeOf(m);
    return sum + (base ? base.calories * SCALE_LO : m.calories);
  }, 0);

  // The reserved slot is fixed, and so is every pinned slot on that day.
  const meals = rebalanceDay(withReserve, p, new Set([mealType, ...lockedSlotsFor(p, day)]), namesOnOtherDays(plan, day, p));
  const total = meals.reduce((sum, m) => sum + m.calories, 0);
  const pct = Math.round((reserve / p.targetCalories) * 100);
  // "Made the other meals lighter" only when they did: with an imported dish held fixed, the reserve can already
  // fill the day, and the protein term then grew breakfast from 587 to 657 kcal under that claim (review,
  // 2026-10-21).
  const othersKcal = (ms: Meal[]) => ms.filter((m) => m.type !== mealType).reduce((sum, m) => sum + m.calories, 0);
  const lighter = othersKcal(meals) < othersKcal(origDay.meals) - 1;

  // A dish the re-plan put in another slot is named, as every replacement is (decision 7): "made the other meals
  // lighter" was the whole note while both of Friday's other dishes had been swapped (the models lane's diagnosis,
  // step 16). Only a dish that took the place of a different one counts: a resize keeps its name.
  const swapped = meals.filter((m) => m.type !== mealType && !origDay.meals.some((o) => o.type === m.type && o.name === m.name));
  notes.push(
    `I've set aside ${reserve} kcal for ${day} ${mealType} — about ${pct}% of your day${lighter ? " — and made the other meals lighter" : ""}.` +
      (swapped.length ? ` To fit the rest of ${day} around it, I switched your ${swapped.map((m) => `${m.type} to ${m.name}`).join(" and ")}.` : ""),
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
  // An imported recipe keeps the portions its site gives: "isn't a recipe of mine, so there's nothing to
  // scale" was written for a reserve or a logged meal, and an import lists quantities (review, 2026-10-21).
  const imported = new Set<string>();
  const importedNote = () =>
    `${listPhrase([...imported])} ${imported.size > 1 ? "are recipes" : "is a recipe"} you imported, so I keep ${imported.size > 1 ? "their" : "its"} portions as the site gives them.`;
  let atLimit = 0;
  let changed = 0; // meals actually rescaled — so we never CLAIM a change that didn't happen
  const blockedByFloor: string[] = [];

  const days = plan.days.map((d) => {
    if (day && d.day !== day) return d;

    const meals = d.meals.map((m) => {
      if (!inScope(d, m)) return m;
      const base = baseRecipeOf(m);
      if (!base) {
        (m.sourceUrl ? imported : unscalable).add(m.name);
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
    else if (unscalable.size || imported.size) {
      if (unscalable.size)
        notes.push(`I can't resize ${listPhrase([...unscalable])} — ${unscalable.size > 1 ? "they aren't recipes" : "that isn't a recipe"} of mine, so there's nothing to scale there.`);
      if (imported.size) notes.push(importedNote());
    } else
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
  if (imported.size) note += ` ${importedNote()}`;
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
    const eff = effective ?? p;
    applyPins(eff, onlyDays);
    // Then the person's records, from the week as this operation found it (V1 D7).
    const rec = reimposeRecords(eff, curPlan, opStart.plan, onlyDays, opStart.profile);
    curPlan = rec.plan;
    if (rec.lost.length)
      notes.push(`You eat ${p.mealsPerDay} meals a day now, so ${listPhrase(rec.lost)} ${rec.lost.length === 1 ? "has" : "have"} no slot left and ${rec.lost.length === 1 ? "is" : "are"} no longer in your week.`);
  };
  /** The pins and then the records, as the person will see the week: what guaranteeBoost measures. */
  const withPinsAndRecords = (pl: WeekPlan) =>
    reimposeRecords(p, reimposeLocks(p, pl).plan, opStart.plan, undefined, opStart.profile).plan;
  const applyPins = (eff: UserProfile, onlyDays?: Set<string>) => {
    if (!p.lockedMeals?.length) return;
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
  // The week and profile as the current operation found them: where its records are put back from.
  let opStart = { plan, profile: { ...p } };
  // Factual macro notes the LLM can't produce (it does no math) — the route appends
  // these so the assistant reports honestly what the engine did.
  const notes: string[] = [];
  const replacedImports: ReplacedImport[] = [];
  // What a meal-prep week cannot take (a boost, a cuisine, more fiber, a fridge clear-out), and where the
  // boost lines sit: both settled once the call's final week and mode are known (the end). `level` is the
  // "about 35mg of iron a day" line; the other is the boost's verdict against the week before it.
  const prepAsked = { boosts: new Set<MicroKey>(), themes: new Set<string>() };
  const boostNotes: { at: number; key: MicroKey; level: boolean; op: number }[] = [];
  let lastChangeOp = -1;
  const noteAsks = (op: Operation) => {
    if (op.boostNutrient) prepAsked.boosts.add(op.boostNutrient);
    if (op.cuisine) prepAsked.themes.add(`${op.cuisine.charAt(0).toUpperCase()}${op.cuisine.slice(1).toLowerCase()} food`);
    if (fiberOn(op)) prepAsked.themes.add("more fiber");
    if (op.useIngredients?.length) prepAsked.themes.add(`using up ${listPhrase(op.useIngredients)}`);
  };

  for (const [opIndex, op] of operations.entries()) {
    const planBefore = curPlan;
    opStart = { plan: curPlan, profile: { ...p } };
    switch (op.tool) {
      case "update_profile": {
        // The profile before this op changes it: an imported dish that breaks a diet or an exclusion this
        // op introduces is re-picked, while one that already broke the old rule stays (importBreaks).
        const was: UserProfile = { ...p };
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
        // repeats instead of 21 distinct dishes) — so capture it BEFORE applying the new mode. An unset mode
        // is fresh (withPlanDefaults): a restated "fresh" on an onboarded profile, which saves no mode, counted
        // as a switch and rebuilt the week from scratch (review, 2026-10-21).
        const modeChanged = !!op.planMode && op.planMode !== (p.planMode ?? "fresh");
        if (op.planMode) p.planMode = op.planMode;
        if (op.batchCadence) p.batchCadence = op.batchCadence;
        profileChanged = true;
        noteAsks(op);
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
            // Leaving a fresh week: its imports that break a rule are named, as on a re-theme. A meal-prep
            // week holds none, so the switch took them all with nothing said (review, 2026-10-21).
            if (modeChanged) replacedImports.push(...brokenImports(curPlan, p, was));
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
            // Met exactly, like the selector (no silent 5-minute grace): a kept dish over a limit just set
            // is re-picked, and if nothing quicker fits, overLimitNote names what stays over.
            (op.maxCookTime && op.maxCookTime > 0 ? r.timeMinutes <= p.maxCookTime : true);
          // A re-THEME request (a cuisine, a fiber/nutrient push, or a fridge clear-out) is the user
          // asking for DIFFERENT dishes — those preferences only take effect during SELECTION, so a
          // "keep everything" pass would silently ignore them. Preserve edits only for FILTER and
          // TARGET changes; a re-theme reselects the week from scratch, exactly as before.
          const reTheme = !!(op.cuisine || fiberOn(op) || op.boostNutrient || op.useIngredients?.length);
          const built = selectWeekFromDb(p, normalizeCuisine(op.cuisine ?? null), fiberOn(op), op.useIngredients, op.boostNutrient ?? undefined, rep, (reTheme || modeChanged) ? undefined : { plan: prev, keepIf, before: was });
          curPlan = keepMacros(op) ? rebalanceWeek(built, p) : built;
          notes.push(...reportNotes(rep, p));
          replacedImports.push(...rep.replacedImports);
          // Picked from scratch, with no keep pass to record them: the old week's imports that break a rule
          // are named all the same. "Make it Italian" beside "I'm allergic to peanuts" took a peanut import out
          // with nothing said (review, 2026-10-21; a boost names it through its own keep pass, since F1).
          if (reTheme || modeChanged) replacedImports.push(...brokenImports(prev, p, was));
          if (op.boostNutrient) {
            // The old week as the rest of this request lets it stay (E4, and the review of E): as it was
            // when nothing else was asked; else re-solved through the keep path, so only its dishes that
            // break the rules as they are now are re-picked and its portions follow new targets; not at all
            // for a cuisine, a fiber push, a different number of meals, or a switch out of meal-prep (whose
            // repeated batches the fresh week must not inherit: E5, review 2026-10-21). An import the re-solve
            // takes out is named from the final week (importNotes).
            // "Nothing else asked" reads an unset mode as fresh too: a restated "fresh" on an onboarded profile
            // counted as another change, re-solved the old week and blamed "the other changes you asked for".
            const sameAsked = (q: UserProfile) => ({ ...q, planMode: q.planMode ?? "fresh", memory: undefined });
            const keep = op.cuisine || fiberOn(op) || was.mealsPerDay !== p.mealsPerDay || modeChanged ? null : {
              unchanged: sameContent(sameAsked(was), sameAsked(p)),
              resolve: () => {
                const repKeep = newReport();
                const fixed = rebalanceWeek(selectWeekFromDb(p, undefined, false, undefined, undefined, repKeep, { plan: prev, keepIf, before: was }), p);
                replacedImports.push(...repKeep.replacedImports);
                return fixed;
              },
            };
            // Measured with the pins back in place, as the person will see the week (E7).
            const g = guaranteeBoost(p, prev, curPlan, op.boostNutrient, was, keep, withPinsAndRecords);
            curPlan = g.plan;
            if (g.note) { boostNotes.push({ at: notes.length, key: op.boostNutrient, level: false, op: opIndex }); notes.push(g.note); }
          }
          applyLocks();
          const explained = new Set<string>();
          if (op.useIngredients?.length) curPlan = guaranteeFridge(p, curPlan, op.useIngredients, notes, explained);
          notes.push(...overLimitNote(prev, curPlan, p, { limitSet: !!(op.maxCookTime && op.maxCookTime > 0), skip: (m) => explained.has(m.name) }));
          if (keepMacros(op)) notes.push(achievementNote("Your week now averages", weekAveragesFull(curPlan), p));
          if (op.boostNutrient) {
            boostNotes.push({ at: notes.length, key: op.boostNutrient, level: true, op: opIndex });
            notes.push(microNote(curPlan, op.boostNutrient));
          }
        }
        break;
      }
      case "regenerate_week": {
        noteAsks(op);
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
            // A cuisine or a fiber push asked with the boost would be dropped if the old week came back (E4).
            // A week that breaks the rules is re-solved through the keep path, not thrown out whole.
            const tokNow = exclusionTokens(p);
            const g = guaranteeBoost(p, prev, curPlan, op.boostNutrient, undefined, op.cuisine || fiberOn(op) ? null : {
              unchanged: true,
              resolve: () => rebalanceWeek(selectWeekFromDb(p, undefined, false, undefined, undefined, newReport(),
                { plan: prev, keepIf: (r) => passesDiet(r, p.diet) && !blockedByExclusions(r, tokNow) }), p),
            }, withPinsAndRecords);
            curPlan = g.plan;
            if (g.note) { boostNotes.push({ at: notes.length, key: op.boostNutrient, level: false, op: opIndex }); notes.push(g.note); }
          }
          applyLocks();
          const explained = new Set<string>();
          if (op.useIngredients?.length) curPlan = guaranteeFridge(p, curPlan, op.useIngredients, notes, explained);
          notes.push(...overLimitNote(prev, curPlan, p, { limitSet: false, skip: (m) => explained.has(m.name) }));
          if (keepMacros(op)) notes.push(achievementNote("Your week now averages", weekAveragesFull(curPlan), p));
          if (op.boostNutrient) {
            boostNotes.push({ at: notes.length, key: op.boostNutrient, level: true, op: opIndex });
            notes.push(microNote(curPlan, op.boostNutrient));
          }
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
        const prevWeek = curPlan;
        const newDay = selectDay(tp, op.day, curPlan, normalizeCuisine(op.cuisine ?? null), fiberOn(op), op.useIngredients, op.boostNutrient ?? undefined, rep);
        if (op.mealType) {
          // ONE slot under the day's overrides ("only 20 minutes for tonight's dinner", V1 D9a): that slot takes the
          // dish the selector picked for it under them, and the day's other dishes stay, their portions balanced
          // around it. A slot-scoped constrain had no engine path, and was answered "I can't change just your dinner".
          const cur = curPlan.days.find((d) => d.day === op.day);
          const old = cur?.meals.find((m) => m.type === op.mealType);
          const fresh = newDay.meals.find((m) => m.type === op.mealType);
          if (!cur || !old || !fresh) {
            notes.push(`${op.day} has no ${op.mealType} in your plan.`);
            break;
          }
          if (isRecord(old) || lockedSlotsFor(p, op.day).has(op.mealType)) {
            notes.push(recordKind(old) === "out" ? `${op.day}'s ${op.mealType} is set aside for eating out, so I left it.`
              : isRecord(old) ? `${old.name} is logged as eaten on ${op.day}, so I left it.`
              : `${old.name} is pinned to ${op.day}'s ${op.mealType}. Unpin it first if you'd like it changed.`);
            break;
          }
          if (fresh.name === old.name) {
            notes.push(`${old.name} already fits that, so ${op.day}'s ${op.mealType} stays as it is.`);
            break;
          }
          const meals = scaleToTargets(cur.meals.map((m) => (m.type === op.mealType ? fresh : m)), tp).map((m, i) => ({ ...m, type: cur.meals[i].type }));
          curPlan = { ...curPlan, days: curPlan.days.map((d) => (d.day === op.day ? { ...d, meals } : d)) };
          const minutes = baseRecipeOf(fresh)?.timeMinutes;
          notes.push(`${op.day}'s ${op.mealType} is now ${fresh.name}${minutes ? ` (${minutes} min)` : ""}, in place of ${old.name}.` +
            (figuresNote(curPlan, tp, op.day) ? ` ${figuresNote(curPlan, tp, op.day)}` : ""));
          notes.push(...overLimitNote(prevWeek, curPlan, tp, { limitSet: !!(op.maxCookTime && op.maxCookTime > 0), days: new Set([op.day]), skip: (m) => m.type !== op.mealType }));
          break;
        }
        notes.push(...reportNotes(rep, tp));
        const meals = keepMacros(op)
          ? rebalanceDay(newDay.meals, tp, undefined, namesOnOtherDays(curPlan, op.day, tp))
          : newDay.meals;
        curPlan = { ...curPlan, days: curPlan.days.map((d) => (d.day === op.day ? { ...newDay, meals } : d)) };
        applyLocks(new Set([op.day]), tp);
        notes.push(...overLimitNote(prevWeek, curPlan, tp, { limitSet: !!(op.maxCookTime && op.maxCookTime > 0), days: new Set([op.day]) }));
        const finalDay = curPlan.days.find((d) => d.day === op.day);
        // Always, not only when macros were kept: a re-plan with preserveMacros false wrote NO note, so
        // the model's prose ("the weekend has been scaled down") was the whole reply and could be false.
        if (finalDay) notes.push(achievementNote(`${op.day} now has`, dayTotalsFull(finalDay), tp));
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
            const refused = refusedForExclusions(op.dish, op.mealType ?? undefined, p, null) ??
              refusedForExclusions(op.dish, op.mealType ?? undefined, p, null, false);
            notes.push(refused
              ? `${refused.dish.name} ${refused.why}, so I left the week as it is.`
              : seafoodKeptOut(op.dish, p)
                ? `${seafoodKeptOut(op.dish, p)} Nothing else from the sea fits your plan, so I left the week as it is.`
                : `I don't have anything like "${op.dish}" that fits your plan, so I left the week as it is.`);
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
          const keptOut = seafoodKeptOut(op.dish, p);
          if (keptOut) notes.push(keptOut);
          if (unmetWords(op.dish, match).length) {
            const refused = refusedForExclusions(op.dish, op.mealType ?? undefined, p, match);
            notes.push(refused
              ? `${refused.dish.name} ${refused.why}, so I used ${match.name} instead.`
              : `I didn't have "${op.dish}" — I used ${match.name}.`);
          }
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
            const refused = refusedForExclusions(op.dish, op.mealType ?? undefined, p, null) ??
              refusedForExclusions(op.dish, op.mealType ?? undefined, p, null, false);
            notes.push(refused
              ? `${refused.dish.name} ${refused.why}, so I left the week as it is.`
              : seafoodKeptOut(op.dish, p)
                ? `${seafoodKeptOut(op.dish, p)} Nothing else from the sea fits your plan, so I left the week as it is.`
                : `I don't have anything like "${op.dish}" that fits your plan, so I left the week as it is.`);
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
          const keptOut = seafoodKeptOut(op.dish, p);
          if (keptOut) notes.push(keptOut);
          if (unmetWords(op.dish, match).length) {
            const refused = refusedForExclusions(op.dish, op.mealType ?? undefined, p, match);
            notes.push(refused
              ? `${refused.dish.name} ${refused.why}, so I used ${match.name} instead.`
              : `I didn't have "${op.dish}" — I used ${match.name}.`);
          }
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
          // Say WHY we couldn't. A silent no-op looks like the app ignored you. An allergy or a dislike
          // that refused the closest dish comes first; then the cook-time limit; then "not stocked".
          const mt = op.mealType ?? undefined;
          const refused = refusedForExclusions(op.dish, mt, p, null);
          const loose = refused ? null : findRecipeForSwap(op.dish, mt, p, false);
          const refusedSlow = refused || loose ? null : refusedForExclusions(op.dish, mt, p, null, false);
          const why = refused ?? refusedSlow;
          notes.push(
            why
              ? `${why.dish.name} ${why.why}, so I left ${op.day} as it is.`
              : loose
                ? `${loose.name} takes ${loose.timeMinutes} min, over your ${p.maxCookTime}-min limit — I left ${op.day} as it is.`
                : seafoodKeptOut(op.dish, p)
                  ? `${seafoodKeptOut(op.dish, p)} Nothing else from the sea fits your plan, so I left ${op.day} as it is.`
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
        // One day's swap names no dish in its other notes, so a seafood swap says which it used.
        const keptOut = seafoodKeptOut(op.dish, p, match.name);
        if (keptOut) notes.push(keptOut);
        const unmatched = unmetWords(op.dish, match);
        if (unmatched.length) {
          // …unless the library HAS the dish and an allergy or a dislike kept it out: then say that.
          const refused = refusedForExclusions(op.dish, op.mealType ?? undefined, p, match);
          notes.push(refused
            ? `${refused.dish.name} ${refused.why}, so I used ${match.name} instead.`
            : `I didn't have "${op.dish}" — I used ${match.name} instead.`);
        }

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
        // Present but nonsensical must be refused too — this is the layer that does the arithmetic so
        // the model never does, and it must not turn a bad number into a NaN, negative or absurd target.
        // "Nonsensical" is not only 0 or negative: age 500 was accepted, stored, and answered with "your
        // resting burn is about -570 kcal" (D5b). BODY_LIMITS is the adult range the equation is for.
        const stats = { age: op.age!, heightCm: op.heightCm!, weightKg: op.weightKg! };
        const bad = bodyStatProblems(stats);
        if (bad.length) {
          notes.push(bodyStatMessage(bad, stats));
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
        const before = curPlan;
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
        replacedImports.push(...rep.replacedImports);
        if (p.planMode !== "batch") notes.push(...overLimitNote(before, curPlan, p, { limitSet: false }));
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

        // Guard the model's number the way update_profile/compute_targets do: a negative or non-finite
        // logged calorie count is "truthy", was locked into the day, and then the rebalancer inflated
        // the other meals to cover the phantom deficit. A bad number is treated as no number, so we
        // fall through to the !eaten branch below and ask, rather than poisoning the day.
        const stated = op.loggedCalories && op.loggedCalories > 0 && Number.isFinite(op.loggedCalories) ? op.loggedCalories : null;
        const statedProtein = op.loggedProtein && op.loggedProtein > 0 && Number.isFinite(op.loggedProtein) ? op.loggedProtein : null;
        let eaten: Meal | null = null;
        // "I ate this": the dish named IS the one planned in that slot, so it is logged as it was planned — its
        // portion, and an import as itself. Matched through the library instead, the planned 1.3x portion came
        // back at the library's size, and an import could come back as a library dish of a similar name.
        const planned = origDay.meals.find((m) => m.type === op.mealType);
        // With a figure of their own it is a different portion, which the library path below scales to.
        if (op.dish && !stated && planned && !isRecord(planned) && planned.name.trim().toLowerCase() === op.dish.trim().toLowerCase())
          eaten = { ...planned, description: "Logged by you.", record: "logged" };
        if (!eaten && op.dish) {
          // Search ALL slots, not just the logged one: pizza is a "dinner" recipe but people
          // eat it at lunch. respectSoft=false because they already ate it — cook time and
          // budget are irrelevant to a meal that is already in the past.
          // Looked up by the food words alone, so "a slice of pizza" is not steered to a dish with "sliced" in it.
          const said = op.dish;
          const match = findRecipeForSwap(foodWords(said).join(" ") || said, undefined, p, false, (r) => namesSameFood(said, r));
          // The person's own figures win over the library's portion: "burger and chips, 900 kcal" was logged
          // as the library's 769 (V1 D7). The dish is scaled to what they said, with no 0.6-1.8x clamp, since
          // it is a fact and not a plan; it is marked as a record and described as theirs, where it used to
          // carry the library's description and look like a planned meal (review #18).
          if (match) {
            const eatenAs = stated ? atFactor(match, stated / match.calories) : match;
            eaten = {
              ...toMeal(eatenAs), type: op.mealType, description: "Logged by you.", record: "logged",
              ...(stated ? { calories: stated } : {}), ...(statedProtein ? { proteinGrams: statedProtein } : {}),
            };
          }
        }
        if (!eaten && stated) {
          eaten = {
            name: op.dish ? op.dish : "Logged meal",
            type: op.mealType,
            description: "Logged by you.",
            record: "logged",
            calories: stated,
            proteinGrams: statedProtein ?? 0,
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
        // can't rebuild (a restaurant reserve, something the user logged) cannot be pinned. Nor can an
        // imported recipe, even titled like a library dish: its pin came back as the library's dish, and the
        // person's own recipe was gone with nothing said (review, 2026-10-21).
        if (meal.sourceUrl) {
          notes.push(`${meal.name} is a recipe you imported, and I can only pin my own recipes for now, so I can't pin it.`);
          break;
        }
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
        // An allergy leaving the profile (or coming back) is never silent: the undo of a remembered
        // allergy read only "put things back", while eggs left the allergies (LC-12). Compared by what
        // each token blocks, so "peanut" against "peanuts" is no difference, and neither is "walnut"
        // against "walnuts": "That also took walnut off your allergies" was said while all 14 walnut
        // recipes stayed blocked (review, 2026-10-21). Wording only: what is restored below is unchanged.
        const nowAllergies = parseExclusionTokens(p.allergies ?? "", "");
        const thenAllergies = parseExclusionTokens(previous.profile.allergies ?? "", "");
        const nowKeys = new Set(nowAllergies.map(exclusionKey));
        const thenKeys = new Set(thenAllergies.map(exclusionKey));
        const takenOff = uniqueByKey(nowAllergies.filter((t) => !thenKeys.has(exclusionKey(t)) && !exclusionCovers(thenAllergies, t)));
        const putBack = uniqueByKey(thenAllergies.filter((t) => !nowKeys.has(exclusionKey(t)) && !exclusionCovers(nowAllergies, t)));
        curPlan = previous.plan;
        // The restored week replaces everything before it in this call, so an import a re-solve took out
        // earlier in the call is not named: the undo took it out by restoring a week without it, and the
        // note read "contains shrimp, which you avoid" with no dislike left (review, 2026-10-21).
        replacedImports.length = 0;
        // Replace the working profile wholesale. Assigning field-by-field would leave anything the
        // last turn ADDED (a pin, a rating, a stored body weight) sitting on the restored profile.
        for (const k of Object.keys(p)) delete (p as unknown as Record<string, unknown>)[k];
        Object.assign(p, previous.profile);
        profileChanged = true;
        undone = true;
        notes.push(`Done — I've put things back to how they were before I ${previous.label}.`);
        if (takenOff.length) notes.push(`That also took ${listPhrase(takenOff)} off your allergies.`);
        if (putBack.length) notes.push(`That also put ${listPhrase(putBack)} back on your allergies.`);
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
      case "move_meal": {
        // "Move Tuesday's dinner to Thursday" (V1 D9a). The two meals change places exactly as they are, so an
        // import moves as itself; by dish name through swap_meal it would be looked up in the library within the
        // slot's type, and an import, or a lunch moved to a dinner slot, came back as some other dish. Each day
        // touched is then balanced (scaleToTargets: an import stays fixed, the rest of the day's portions move).
        const toDay = op.toDay ?? op.day;
        const toSlot = op.toMealType ?? op.mealType;
        if (!op.day || !op.mealType || !toDay || !toSlot) {
          notes.push("Which meal should I move, and to which day?");
          break;
        }
        if (toDay === op.day && toSlot === op.mealType) {
          notes.push(`That is already ${op.day}'s ${op.mealType}.`);
          break;
        }
        if (p.planMode === "batch") {
          notes.push("In meal-prep mode each meal is a serving of a batch you cook once, so I can't move one on its own. Switch to Fresh to move meals between days.");
          break;
        }
        const a = curPlan.days.find((d) => d.day === op.day)?.meals.find((m) => m.type === op.mealType);
        const b = curPlan.days.find((d) => d.day === toDay)?.meals.find((m) => m.type === toSlot);
        if (!a) {
          notes.push(`${op.day} has no ${op.mealType} to move.`);
          break;
        }
        if (!b) {
          notes.push(`${toDay} has no ${toSlot} in your plan to move it to.`);
          break;
        }
        // A logged meal or a meal out is a fact about the day it happened on, and a pin is the person's own
        // "keep this here": neither moves, and the reply says which and why.
        const held = ([[a, op.day, op.mealType], [b, toDay, toSlot]] as const).find(([m, d, s]) => isRecord(m) || lockedSlotsFor(p, d).has(s));
        if (held) {
          const [m, d, s] = held;
          const kind = recordKind(m);
          notes.push(
            kind === "out" ? `${d}'s ${s} is set aside for eating out, so it stays on ${d}.`
              : kind === "logged" ? `${m.name} is logged as eaten on ${d}, so it stays where it happened.`
              : `${m.name} is pinned to ${d}'s ${s}. Unpin it first if you'd like it moved.`,
          );
          break;
        }
        const placed = (day: string, slot: string, meal: Meal) => (d: DayPlan) =>
          d.day !== day ? d : { ...d, meals: d.meals.map((m) => (m.type === slot ? { ...meal, type: m.type } : m)) };
        let moved = curPlan.days.map(placed(op.day, op.mealType, b)).map(placed(toDay, toSlot, a));
        const touched = [...new Set([op.day, toDay])];
        // scaleToTargets rebuilds a library meal from its recipe, recipe type and all, so each slot's type is put back:
        // a lunch moved to a dinner slot otherwise left the day with two lunches and no dinner.
        moved = moved.map((d) => (touched.includes(d.day) ? { ...d, meals: scaleToTargets(d.meals, p).map((m, i) => ({ ...m, type: d.meals[i].type })) } : d));
        curPlan = { ...curPlan, days: moved };
        notes.push(
          `Moved ${a.name} to ${toDay}'s ${toSlot}, and ${b.name} to ${op.day}'s ${op.mealType}.` +
            touched.map((d) => figuresNote(curPlan, p, d)).filter(Boolean).map((s) => ` ${s}`).join(""),
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
        // A weight we would not compute targets from is not one to prescribe fluid from, or to keep:
        // -80 kg used to answer "aim for about -2.3 L a day" and store the -80 (D5b).
        if (bodyStatProblems({ weightKg }).length) {
          notes.push(
            isRealBody("weightKg", weightKg)
              ? `The per-kilo rule I use isn't validated at ${weightKg} kg, so I won't guess — a GP or a registered dietitian can give you a fluid target that fits you.`
              : `${weightKg} kg doesn't look right, so I haven't used it — fluid needs scale with body weight, and I work them out for ${BODY_LIMITS.weightKg.min}–${BODY_LIMITS.weightKg.max} kg.`,
          );
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
        // Per kg of a weight capped at BMI 30 when the height is known: body water follows lean mass,
        // the same reason protein does, so 35 mL per kg of TOTAL weight overstated a larger body's need.
        const refKg = Math.round(referenceWeightKg(weightKg, p.bodyStats?.heightCm));
        let note = explainHydration(hydrationTarget(refKg, activity), weightKg, activity);
        if (refKg < weightKg)
          note += ` I worked it from ${refKg} kg rather than ${weightKg}: fluid needs follow lean mass, so the per-kilo rule would overstate them.`;
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
        // A crisis outranks an urgent reply, in whichever order the symptoms came (review of F5a, 2026-10-22).
        if (res.override && replyOverride !== CRISIS_REPLY) replyOverride = res.text;
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
    if (curPlan !== planBefore) lastChangeOp = opIndex;
  }

  // A boost's lines are about the week it built. A later op in the same call that changed the week left
  // "about 35mg of iron a day" over a final week of 21.9 mg: after a switch to meal-prep, and as much after
  // a cuisine, a calorie target, a cook-time limit or a diet (review, 2026-10-21). So the level is read off
  // the FINAL week, and the verdict against the week before ("less than before", "couldn't put more in")
  // is dropped once a later op moved the week. In a call that ends in meal-prep, both go: the batches
  // ignore the boost, which the meal-prep line says, judged on the mode the call ends in (a boost asked in
  // meal-prep and then a switch to fresh was blamed on meal-prep).
  const endsInPrep = p.planMode === "batch";
  for (const b of [...boostNotes].reverse()) {
    if (endsInPrep || (!b.level && lastChangeOp > b.op)) notes.splice(b.at, 1);
    else if (b.level && lastChangeOp > b.op) notes[b.at] = microNote(curPlan, b.key);
  }
  if (endsInPrep) {
    for (const key of prepAsked.boosts) notes.push(batchBoostNote(key));
    if (prepAsked.themes.size)
      notes.push(`In meal-prep mode I can't plan your batches around ${listPhrase([...prepAsked.themes])} yet, so they're planned as usual.`);
  }

  // Compared, not inferred. `planWasChanged(operations)` asks which tools were NAMED; this asks
  // what actually moved. A swap for a dish we don't have is a no-op, and used to tell the user
  // "Done — I updated your plan."
  // Imported dishes a re-solve took out, named from the FINAL plan: a rebalance or a pin may have changed
  // the slot after selection, and the note must name what is really there.
  notes.push(...importNotes(replacedImports, curPlan, p));
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
