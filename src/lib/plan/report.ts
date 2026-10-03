/**
 * Read-only descriptions of a plan — totals, the honest achievement note, the weekly review, and
 * the note-writers for symptoms, substitutions, explanations and ratings. Computes; never writes.
 *
 * Part of the plan engine (src/lib/plan/, layer L3), split out of recipeDb.ts on 2026-10-03 (V1
 * milestone A3). The public surface is ./index.ts; an export here that index.ts does not re-export
 * is internal to this folder, and check:boundaries fails anything outside the folder that imports it.
 */
import { type DayPlan, type Meal, type UserProfile, type WeekPlan } from "../types";
import { haystackBlocked, dietTagConflicts, wordMatches } from "../exclusions";
import { SUBSTITUTES, INGREDIENT_ALIASES } from "../substitutions";
import { SYMPTOMS } from "../symptoms";
import { redFlag } from "../safety";
import { NUTRIENT_TABLE } from "../nutrientTable.generated";
import { microsForIngredients, gramsFor, MICRO_KEYS, MICRO_LABEL, MICRO_UNIT, DAILY_REFERENCE, type MicroKey } from "../nutrients";
import { type Recipe } from "../data/seeds";
import { RECIPES, recipeMicros } from "./library";
import { blockedByExclusions, exclusionTokens, passesDiet } from "./rules";
import { dayTargetMacros } from "./rebalance";

export const dayTotals = (d: DayPlan) => ({
  kcal: d.meals.reduce((s, m) => s + m.calories, 0),
  protein: d.meals.reduce((s, m) => s + m.proteinGrams, 0),
});

// Fuller totals for the honesty note (carbs/fat/fiber too). Kept separate from dayTotals, whose
// two-field shape flows into the agent read-tools and shouldn't grow here.
export const dayTotalsFull = (d: DayPlan) => ({
  kcal: d.meals.reduce((s, m) => s + m.calories, 0),
  protein: d.meals.reduce((s, m) => s + m.proteinGrams, 0),
  carbs: d.meals.reduce((s, m) => s + m.carbsGrams, 0),
  fat: d.meals.reduce((s, m) => s + m.fatGrams, 0),
  fiber: d.meals.reduce((s, m) => s + (m.fiberGrams ?? 0), 0),
});

export const weekAveragesFull = (plan: WeekPlan) => {
  const n = plan.days.length || 1;
  const t = plan.days.map(dayTotalsFull);
  const avg = (k: keyof ReturnType<typeof dayTotalsFull>) =>
    Math.round(t.reduce((s, x) => s + x[k], 0) / n);
  return { kcal: avg("kcal"), protein: avg("protein"), carbs: avg("carbs"), fat: avg("fat"), fiber: avg("fiber") };
};

/** Average daily amount of a micronutrient across the week, from the mapped ingredients. */
export function weekMicroAverage(plan: WeekPlan, key: MicroKey): { amount: number; coverage: number } {
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

export const PROTEIN_MISS = 8;

 // g/day we'll tolerate before admitting we fell short

/**
 * Report what the plan ACTUALLY achieved. The model writes the friendly sentence but does
 * no arithmetic, so left alone it will happily claim "I hit 190g protein" when the recipe
 * pool tops out at 167g. That is a trust violation. The engine appends the truth — including
 * an explicit admission when a target is out of reach under the user's constraints.
 */
export function achievementNote(
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
export function symptomNote(plan: WeekPlan, p: UserProfile, reported: string): { text: string; override: boolean } {
  const said = reported.trim().toLowerCase();
  if (!said) return { text: "What have you been noticing?", override: false };

  const words = said.split(/[^a-z']+/).filter(Boolean);
  const same = (w: string, t: string) => w === t || wordMatches(w, t) || wordMatches(t, w);

  // SYMPTOMS match as an unordered WORD SET, with the same stemmer the allergen filter uses:
  // "my nails are brittle and my hair is thinning" must find "brittle nails" and "hair thinning";
  // "retired" must never find "tired".
  const hasWord = (t: string) => words.some((w) => same(w, t));
  const phraseIn = (phrase: string) => phrase.split(/\s+/).every(hasWord);

  // RED FLAGS first: a crisis, then a medical emergency. Nothing else in this function runs.
  // `override` means: the model's own words are DISCARDED and this text is the entire reply. A
  // 1.5B must not be able to prepend "sounds like low iron!" to a chest-pain warning. The matching
  // lives in safety.ts so the assistant routes' pre-scan (which runs on the user's RAW message,
  // before any model) and this tool can never disagree about what a red flag is.
  const flag = redFlag(reported);
  if (flag) return { text: flag.text, override: true };

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
    // A CONCRETE offer, so a "yes please" has one thing to accept. This note is the whole reply on a
    // feelings message (engine notes outrank the model's prose), so the model's own offer never reached
    // the user, and the next turn had to guess what "yes" meant — a 550B guessed vitamin D for
    // "run down and tired" (models lane's conversation eval). ONE nutrient, and only one that the
    // user's rules can actually reach, so accepting it maps to a single boost that can succeed.
    const lean = hit.nutrients.find((k) => nutrientReachable(p, k));
    if (lean) parts.push(`If you'd still like, I can lean your week further toward ${MICRO_LABEL[lean]} — just say so.`);
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

export function substituteNote(
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
export function explainMealNote(plan: WeekPlan, p: UserProfile, day: DayPlan["day"], type: Meal["type"]): string {
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

export function listPhrase(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Name a condition-driven micronutrient bias to the user, honestly. Sits next to microNote and
 * mirrors symptomNote's rule: food guidance, and it points at a doctor. Never claims completeness —
 * the engine can only favour the nutrients it actually tracks.
 */
export function conditionDisclosure(keys: MicroKey[]): string {
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

 // a restaurant main is a big meal, not an average one

/** Above this, a food is not a keto food. Bell peppers pass; rice, couscous and banana do not. */
const KETO_MAX_CARBS_PER_100G = 10;

/**
 * Can this nutrient actually be raised, given the user's diet and exclusions? Offering to
 * "rebuild the week around your B12" when no vegan food in the library carries any is a false
 * promise. A nutritionist would say plainly that food alone won't cover it.
 */
export function nutrientReachable(p: UserProfile, key: MicroKey): boolean {
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

/**
 * Resolve the dish a rating is about: the name the user said, or whatever is in the slot they
 * named. Returns null when neither identifies a real recipe.
 *
 * Only library recipes can be rated. A restaurant reserve or something the user logged has no
 * recipe behind it, so a rating on it could never change a future week — saying so beats storing
 * a preference that silently does nothing.
 */
export function resolveRatedDish(plan: WeekPlan, dish?: string, day?: string, mealType?: string): Recipe | null {
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
export function rateMealNote(plan: WeekPlan, recipe: Recipe, rating: number, day?: string, mealType?: string): string {
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
export function microNote(plan: WeekPlan, key: MicroKey): string {
  const { amount, coverage } = weekMicroAverage(plan, key);
  const label = MICRO_LABEL[key];
  const unit = MICRO_UNIT[key];
  if (coverage < 0.6)
    return `I've favoured ${label}-rich meals, but I can't put a reliable number on it — only ${Math.round(coverage * 100)}% of these ingredients have nutrition data.`;
  const pct = Math.round((amount / DAILY_REFERENCE[key]) * 100);
  const round = (x: number) => (x >= 10 ? Math.round(x) : Math.round(x * 10) / 10);
  return `Your week now averages about ${round(amount)}${unit} of ${label} a day — roughly ${pct}% of the daily reference.`;
}
