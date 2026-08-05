/**
 * The v2 conversation generator. Produces realistic training examples across the whole intent
 * taxonomy — every one carrying a reasoning trace, and every one meant to survive the engine
 * validator (validateExample). Volume comes from phrasing variety here; correctness comes from the
 * validator downstream. This is the seed set the fine-tune learns the primitives + reason-then-act
 * + the four honest outcomes from. Only intents the engine actually supports are generated (no
 * per-slot targeting or bare undo yet — those become honest declines or are added when built).
 *
 * How the diversity is manufactured (so the model generalizes instead of memorizing):
 *  1. `surfaces(base)` spins each core request into several natural surface forms — a casual opener
 *     ("hey ", "ok so "), chat-register substitutions (you→u, please→pls, want to→wanna), and the
 *     plain form. The MEANING is unchanged, so the ops/expect stay valid; only the wording varies.
 *  2. Every intent draws `thinking` and `reply` from ROTATING banks via `rot(bank, k)` as the running
 *     counter `k` advances — so even the surface variants of one request get different reasoning and
 *     different replies. The model learns the reasoning *pattern* and a range of phrasings, never a
 *     single string to echo.
 *  3. Wide value ranges (calories, protein, foods, days, cuisines) and combinatorial cross-products
 *     (diet × exclude × budget × cuisine × macros) multiply coverage honestly.
 *  4. A final exact-duplicate pass drops any identical (turns + thinking + reply + ops) tuples.
 *
 * EXPAND controls how many surface forms each base yields — raise it to grow the set further.
 */
import type { UserProfile, UserFact } from "./types";
import type { TrainingExample } from "./dataValidate";

type Diet = UserProfile["diet"];
const U = (text: string) => ({ role: "user" as const, text });
const A = (text: string) => ({ role: "assistant" as const, text });
/** Deterministic rotation through a bank — no Math.random, so the set is reproducible. */
const rot = <T>(a: T[], i: number): T => a[((i % a.length) + a.length) % a.length];

const BASE: UserProfile = {
  goal: "maintain", diet: "none", allergies: "", dislikes: "", budget: "medium",
  mealsPerDay: 3, targetCalories: 2000, proteinGrams: 150, carbsGrams: 200,
  fatGrams: 65, maxCookTime: 30, maxIngredients: 8,
};
const withDiet = (d: Diet): UserProfile => ({ ...BASE, diet: d });

// --- surface-form multiplier ---------------------------------------------------------------------
// Openers safe before both imperatives and statements ("hey make it vegan", "ok so i'm broke").
const OPENERS = ["hey ", "ok ", "so ", "ok so ", "honestly ", "alright ", "yeah so ", "um ", "hmm ", "pls "];
const casual = (s: string) =>
  s.replace(/\byou\b/g, "u").replace(/\byour\b/g, "ur").replace(/\bplease\b/g, "pls")
    .replace(/\bwant to\b/g, "wanna").replace(/\bgoing to\b/g, "gonna").replace(/\bbecause\b/g, "cuz");
/** Up to EXPAND natural surface forms of one request; deduped so "" -openers don't collide. */
const EXPAND = 4;
function surfaces(base: string, seed: number): string[] {
  const forms = [base, rot(OPENERS, seed) + base, casual(base), rot(OPENERS, seed + 5) + casual(base)];
  return Array.from(new Set(forms)).slice(0, EXPAND);
}

export function generateExamples(): TrainingExample[] {
  const out: TrainingExample[] = [];
  const push = (
    turns: TrainingExample["turns"],
    thinking: string,
    reply: string,
    operations: unknown[],
    expect?: TrainingExample["expect"],
    profile?: UserProfile,
  ) => out.push({ turns, thinking, reply, operations, expect, ...(profile ? { profile } : {}) });

  // A running counter so reasoning/reply banks rotate across the whole file, spreading variety
  // instead of clustering identical strings within a section.
  let k = 0;

  // A single-request emitter that fans a base phrasing out into surface forms, rotating the reason
  // and reply banks per variant. `fill` templates in {d}/{f}/… before surfacing.
  const emit = (
    base: string,
    think: string[],
    reply: string[],
    operations: unknown[],
    expect?: TrainingExample["expect"],
    profile?: UserProfile,
  ) => {
    for (const p of surfaces(base, k)) {
      push([U(p)], rot(think, k), rot(reply, k), operations, expect, profile);
      k++;
    }
  };

  // ================================================================= constrain: diet (whole week)
  {
    const diets: Diet[] = ["vegetarian", "vegan", "keto", "mediterranean"];
    const tmpl = [
      "go {d}", "make my week {d}", "i want to eat {d}", "switch me to {d}", "{d} please",
      "can you make everything {d}", "turn my plan {d}", "i'm going {d} starting now", "{d} the whole week",
      "make the whole week {d} please", "everything should be {d}", "i decided to eat {d}", "put me on a {d} diet",
    ];
    const think = [
      "Clear whole-week diet switch to {d} — persist it to the profile and rebuild every day around it.",
      "They want the entire plan {d}. That's a durable change, one constrain scoped to the week.",
      "Whole-week {d}. Save it so future days stay {d}, then regenerate the week.",
      "Straightforward diet change: make the week {d}. Scope is the week, so it sticks.",
      "The request is unambiguous — {d} across the board. Update the profile's diet and re-solve.",
      "{d}, whole week. One constrain, persisted; the engine rebuilds around it.",
    ];
    const reply = [
      "Done — your whole week is {d} now.",
      "You're all set — every day is {d}.",
      "Rebuilt the week {d}. Want me to keep anything from before?",
      "Switched — your plan's {d} from here on.",
      "Got it, {d} it is. The week's regenerated around that.",
      "All set — {d}, top to bottom.",
    ];
    for (const d of diets)
      for (const t of tmpl) {
        const F = (s: string) => s.replaceAll("{d}", d);
        emit(F(t), think.map(F), reply.map(F), [{ op: "constrain", diet: d }], { dietIs: d, planChanged: true });
      }
    // back to no restrictions — starts from a restricted profile so the change is real
    for (const t of ["go back to normal", "no more diet restrictions", "drop the diet", "i want to eat everything again", "remove my diet please", "un-restrict me", "forget the diet, back to normal"])
      emit(t, ["They're lifting the diet — set it back to none and rebuild unrestricted.", "Remove the diet restriction; scope week, persist it.", "No more restriction — diet none, re-solve the week."],
        ["Done — no diet restrictions anymore.", "All set — your week's open again, anything goes.", "Cleared it — you can eat everything now."],
        [{ op: "constrain", diet: "none" }], { dietIs: "none", planChanged: true }, withDiet("vegetarian"));
  }

  // ================================================================= constrain: diet × exclude / budget / cuisine
  {
    const diets: Diet[] = ["vegetarian", "vegan", "mediterranean"];
    for (const d of diets)
      for (const food of ["mushrooms", "onions", "cilantro", "olives"])
        for (const base of [`${d} but no ${food}`, `make it ${d} and drop the ${food}`, `${d}, and i hate ${food}`])
          emit(base, [`Two things at once: diet ${d} and exclude ${food}. One constrain carries both.`, `They want ${d} AND ${food} gone — combine into a single constrain.`],
            [`Done — ${d}, and no ${food}.`, `You're set: ${d} week with ${food} left out.`],
            [{ op: "constrain", diet: d, exclude: [food] }], { dietIs: d, planChanged: true });
    for (const d of diets)
      for (const [b, w] of [["low", "cheap"], ["high", "fancier"]] as const)
        emit(`${d} and ${w}`, [`Diet ${d} plus a ${b} budget — one constrain.`, `${d} with a ${b} budget; fold both in.`],
          [`Done — ${d}, ${w}.`, `Set — a ${w} ${d} week.`],
          [{ op: "constrain", diet: d, budget: b }], { dietIs: d, planChanged: true });
    for (const d of diets)
      for (const c of ["italian", "mediterranean", "mexican"])
        emit(`a ${d} ${c} week`, [`Diet ${d} themed ${c}.`, `${d} plus a ${c} theme; one constrain.`],
          [`Yum — a ${d} ${c} week, coming up.`, `Done — ${c} dishes, all ${d}.`],
          [{ op: "constrain", diet: d, cuisine: c }], { dietIs: d, planChanged: true });
  }

  // ================================================================= constrain: budget
  {
    const cheaper = ["make it cheaper", "tighter budget please", "i'm broke this week", "budget meals only", "keep it low cost", "spend less on food", "cheapest options you've got", "i can't afford much right now", "money's tight, cut costs", "i'm on a shoestring this week"];
    const fancier = ["splurge a bit this week", "fancier meals", "money's no object", "treat me to nicer food", "go premium this week", "i want to eat well, budget's fine", "nicer ingredients please", "spare no expense"];
    for (const t of cheaper)
      emit(t, ["Cheaper week — set budget low and rebuild.", "They want to spend less; budget → low, persist it.", "Money's tight — low budget, re-solve the week."],
        ["Done — switched to budget-friendly meals.", "Got it, keeping it cheap this week.", "All set — low-cost meals across the week."],
        [{ op: "constrain", budget: "low" }], { profileChanged: true });
    for (const t of fancier)
      emit(t, ["Pricier week — budget high.", "They want to splurge; bump budget to high.", "Premium week — set budget high and rebuild."],
        ["Nice — bumped up to fancier options.", "Done, treating you to nicer meals this week.", "All set — premium ingredients this week."],
        [{ op: "constrain", budget: "high" }], { profileChanged: true });
  }

  // ================================================================= constrain: exclude (single + pairs)
  {
    const foods = ["onions", "mushrooms", "cilantro", "olives", "tomatoes", "peppers", "eggplant", "garlic", "shrimp", "pork", "celery", "coconut", "beans", "fish"];
    const tmpl = ["no {f}", "i hate {f}", "keep {f} out", "remove {f}", "i can't stand {f}", "please avoid {f}", "leave out the {f}", "{f} makes me gag", "absolutely no {f}", "skip the {f}", "i'm not a fan of {f}"];
    for (const food of foods)
      for (const t of tmpl) {
        const F = (s: string) => s.replaceAll("{f}", food);
        emit(F(t), [F("Exclude {f} week-wide; persist to the profile."), F("They dislike {f} — add it to the exclusion list and re-solve."), F("{f} out for the whole week. Save the exclusion.")],
          [F("No problem — I'll keep {f} out of your week."), F("Done, no more {f}."), F("Got it — {f} is off the menu.")],
          [{ op: "constrain", exclude: [food] }], { profileChanged: true });
      }
    for (const [a, b] of [["onions", "garlic"], ["mushrooms", "olives"], ["cilantro", "peppers"], ["shrimp", "pork"], ["tomatoes", "eggplant"]])
      for (const base of [`no ${a} or ${b}`, `drop the ${a} and ${b}`, `i hate ${a} and ${b}`])
        emit(base, [`Two exclusions: ${a} and ${b}. One constrain.`], [`Done — no ${a}, no ${b}.`],
          [{ op: "constrain", exclude: [a, b] }], { profileChanged: true });
  }

  // ================================================================= constrain: calories / protein / carbs / fat / fiber
  {
    const cals = [1400, 1500, 1600, 1700, 1800, 1900, 2000, 2100, 2200, 2400, 2500, 2800];
    const calTmpl = ["{c} calories a day", "set me to {c} kcal", "i want {c} a day", "cut me to {c} daily", "{c} cals per day", "aim for {c} a day", "keep me around {c} calories", "target {c} kcal"];
    for (const c of cals)
      for (const t of calTmpl) {
        const F = (s: string) => s.replaceAll("{c}", String(c));
        emit(F(t), [F("Set the daily calorie target to {c}; the engine re-solves macros."), F("Daily calories → {c}. Persist and rebuild."), F("They want {c} kcal/day — update the target, re-solve.")],
          [F("Updated your daily target to {c} kcal."), F("Done — {c} a day now."), F("Set — aiming for {c} calories daily.")],
          [{ op: "constrain", targets: { calories: c } }], { planChanged: true });
      }
    const prot = [120, 130, 140, 150, 160, 170, 180, 190, 200, 220];
    const protTmpl = ["{g}g protein a day", "bump protein to {g}", "i need {g} grams of protein", "hit {g}g protein daily", "more protein, like {g}g", "get me to {g}g protein", "{g} of protein a day"];
    for (const g of prot)
      for (const t of protTmpl) {
        const F = (s: string) => s.replaceAll("{g}", String(g));
        emit(F(t), [F("Protein target {g}g/day — the engine rebalances the rest."), F("Set protein to {g}g and re-solve macros."), F("They want {g}g protein daily; update the target.")],
          [F("Done — protein target set to {g}g a day."), F("Set — {g}g of protein daily."), F("Bumped protein to {g}g/day.")],
          [{ op: "constrain", targets: { protein: g } }], { planChanged: true });
      }
    for (const g of [25, 28, 30, 32, 35, 38, 40])
      for (const t of ["{g}g fiber a day", "more fiber, like {g}g", "get me to {g} grams of fiber", "i need {g}g of fiber"]) {
        const F = (s: string) => s.replaceAll("{g}", String(g));
        emit(F(t), [F("Fiber target {g}g — prioritize higher-fiber foods."), F("Set fiber to {g}g/day and re-solve.")],
          [F("Sure — prioritizing higher-fiber meals ({g}g)."), F("Done — targeting {g}g of fiber a day.")],
          [{ op: "constrain", targets: { fiber: g } }], { planChanged: true });
      }
    for (const g of [100, 120, 150, 180, 200, 220, 250])
      for (const t of ["{g}g carbs a day", "set carbs to {g}", "keep carbs around {g}g"]) {
        const F = (s: string) => s.replaceAll("{g}", String(g));
        emit(F(t), [F("Carb target {g}g/day; re-solve.")], [F("Done — carbs set to {g}g a day.")],
          [{ op: "constrain", targets: { carbs: g } }], { planChanged: true });
      }
    for (const g of [45, 50, 55, 60, 70, 80])
      for (const t of ["{g}g fat a day", "set fat to {g}", "keep fat near {g}g"]) {
        const F = (s: string) => s.replaceAll("{g}", String(g));
        emit(F(t), [F("Fat target {g}g/day; re-solve.")], [F("Done — fat set to {g}g a day.")],
          [{ op: "constrain", targets: { fat: g } }], { planChanged: true });
      }
    for (const [c, g] of [[1800, 160], [2000, 180], [2200, 200], [1600, 140], [2400, 190]])
      for (const base of [`${c} calories and ${g}g protein`, `${c} cals, ${g} protein`, `keep me at ${c} with ${g}g protein`])
        emit(base, [`Two macro targets at once: ${c} kcal and ${g}g protein. One constrain.`],
          [`Done — ${c} calories a day with ${g}g of protein.`],
          [{ op: "constrain", targets: { calories: c, protein: g } }], { planChanged: true });
  }

  // ================================================================= constrain: cuisine (whole week)
  {
    const cuisines = ["italian", "asian", "mexican", "indian", "mediterranean"];
    const tmpl = ["make it {c}", "i'm craving {c}", "{c} week please", "give me {c} food", "i want {c} this week", "everything {c}", "surprise me with {c} dishes", "in the mood for {c}"];
    for (const c of cuisines)
      for (const t of tmpl) {
        const F = (s: string) => s.replaceAll("{c}", c);
        emit(F(t), [F("Themed week: {c}. Persist the cuisine preference and rebuild."), F("They're craving {c} — set cuisine and re-solve the week."), F("Whole-week {c} theme; update the profile.")],
          [F("Yum — rebuilt your week with {c} dishes."), F("Done — a {c} week coming up."), F("All set, {c} all week.")],
          [{ op: "constrain", cuisine: c }], { planChanged: true });
      }
  }

  // ================================================================= constrain: mealsPerDay
  {
    for (const t of ["i want 4 meals a day", "add a daily snack", "give me four meals", "i prefer 4 meals", "make it 4 meals a day", "i graze, four meals please", "split it into 4 meals"])
      emit(t, ["Four meals a day — add the snack slot, persist, rebuild.", "They want 4 meals/day; update mealsPerDay and re-solve."],
        ["Done — four meals a day now, with a snack.", "Set — you've got four meals a day."],
        [{ op: "constrain", mealsPerDay: 4 }], { planChanged: true });
    for (const t of ["back to 3 meals", "drop the snack", "just three meals a day", "i only want 3 meals"])
      emit(t, ["Back to three meals — remove the snack slot."], ["Done — three meals a day."],
        [{ op: "constrain", mealsPerDay: 3 }], { planChanged: true }, { ...BASE, mealsPerDay: 4 });
  }

  // ================================================================= constrain: no oven / quick / cook time
  {
    for (const t of ["i don't have an oven", "no baking this week", "stovetop only", "my oven's broken", "can't use the oven right now", "no-bake meals only"])
      emit(t, ["No oven — exclude baked/roasted so nothing needs one.", "Their oven's out; exclude bake/roast/oven and rebuild."],
        ["Got it — nothing baked or roasted.", "Done — everything's stovetop from here."],
        [{ op: "constrain", exclude: ["bake", "roast", "oven"] }], { profileChanged: true });
    for (const [mins, phr] of [[20, "quick meals only"], [20, "nothing over 20 minutes"], [15, "nothing over 15 min"], [20, "i'm busy, fast recipes"], [25, "keep cooking under 25 minutes"], [20, "quick stuff, i work late"], [15, "15 minute meals max"]] as const)
      emit(phr, [`Cap cook time at ${mins} minutes, week-wide.`], [`Done — everything's ${mins} minutes or less.`],
        [{ op: "constrain", maxCookTime: mins }], { profileChanged: true });
  }

  // ================================================================= constrain: day scope (single / range / weekend)
  {
    const diets: Diet[] = ["vegetarian", "vegan", "keto"];
    for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"])
      for (const d of diets)
        for (const base of [`make ${day} ${d}`, `just ${day} ${d}`, `${day} should be ${d}`])
          emit(base, [`Single day ${day} → ${d}, temporary (a per-day override, not saved to the profile).`, `Only ${day} is ${d}; rebuild that one day, leave the rest and the profile alone.`],
            [`Got it — ${day}'s ${d}, the rest unchanged.`, `Done — just ${day} is ${d} now.`],
            [{ op: "constrain", scope: { days: [day] }, diet: d }], { planChanged: true });
    for (const t of ["vegetarian monday through wednesday", "mon to wed veggie", "make monday tuesday wednesday vegetarian", "veggie for the first half of the week"])
      emit(t, ["Day range Mon–Wed vegetarian — three per-day rebuilds, nothing persisted."], ["Done — Monday through Wednesday are vegetarian."],
        [{ op: "constrain", scope: { days: ["Monday", "Tuesday", "Wednesday"] }, diet: "vegetarian" }], { planChanged: true });
    for (const t of ["lighter on the weekend", "smaller meals saturday and sunday", "cut weekend calories", "go easy on sat and sun"])
      emit(t, ["Weekend = Sat+Sun, fewer calories. Per-day override on those two days."], ["Sure — lighter Saturday and Sunday."],
        [{ op: "constrain", scope: { days: ["Saturday", "Sunday"] }, targets: { calories: 1600 } }], { planChanged: true });
    for (const [day, c] of [["Friday", "italian"], ["Saturday", "mexican"], ["Sunday", "indian"]] as const)
      for (const base of [`make ${day} ${c}`, `i want ${c} on ${day}`])
        emit(base, [`Single-day cuisine: ${day} → ${c}, temporary.`], [`Done — ${day}'s ${c}.`],
          [{ op: "constrain", scope: { days: [day] }, cuisine: c }], { planChanged: true });
  }

  // ================================================================= constrain: boostNutrient (+ hold a diet)
  {
    const nutrients: [string, string][] = [["iron", "iron"], ["vitD", "vitamin d"], ["b12", "b12"], ["calcium", "calcium"], ["magnesium", "magnesium"], ["potassium", "potassium"], ["zinc", "zinc"], ["folate", "folate"], ["vitC", "vitamin c"]];
    for (const [n, w] of nutrients)
      for (const base of [`i'm low on ${w}`, `i need more ${w}`, `my doctor said my ${w} is low`, `boost my ${w}`, `more ${w} in my meals`])
        emit(base, [`Boost ${n}; the engine picks foods and computes amounts — I never guess numbers.`, `They're low on ${n} — set boostNutrient and re-solve around rich foods.`],
          [`Done — rebuilt your week around foods rich in that nutrient.`, `Got it — more ${w}-rich meals this week.`],
          [{ op: "constrain", boostNutrient: n }], { planChanged: true });
    for (const [n, w, d] of [["iron", "iron", "vegetarian"], ["calcium", "calcium", "vegan"]] as const)
      for (const base of [`my ${w}'s low but keep me ${d}`, `more ${w}, still ${d}`])
        emit(base, [`Boost ${n} AND hold ${d} together — one constrain carries both.`],
          [`Done — more ${w}-rich foods, still ${d}.`],
          [{ op: "constrain", boostNutrient: n, diet: d }], { dietIs: d, planChanged: true });
    // The honest edge case: b12 can't be sourced from plant foods, so a vegan plan can't fix it by
    // food alone. Don't fake a plan change — advise supplementation. This is the DECLINE-honestly
    // outcome, and it's exactly the kind of real-nutrition judgment the assistant must get right.
    for (const base of ["my b12's low but keep me vegan", "more b12, still vegan", "how do i get b12 on a vegan diet"])
      emit(base, ["b12 is essentially absent from plant foods, so a vegan plan can't fix a deficiency by food alone. Be honest — recommend a supplement / fortified foods; don't pretend a rebuild solves it."],
        ["Honest answer: b12 is the one nutrient a vegan diet can't reliably cover — it isn't in plant foods in usable amounts. I'll keep your week vegan, but you'll want a b12 supplement or fortified foods (nutritional yeast, fortified plant milk). Want me to lean the plan toward those fortified options?"],
        [{ op: "answer" }]);
  }

  // ================================================================= remember (+ remember-and-act)
  {
    const facts: [string, string, string][] = [
      ["lactose intolerant", "allergy", "lactose"], ["allergic to peanuts", "allergy", "peanuts"],
      ["allergic to shellfish", "allergy", "shellfish"], ["i hate cilantro", "preference", "cilantro"],
      ["training for a marathon", "goal", "marathon"], ["i have ibs", "condition", "ibs"],
      ["i'm pescatarian", "preference", "pescatarian"], ["i work night shifts", "context", "night shift"],
      ["i'm trying to lose weight", "goal", "lose weight"], ["i'm diabetic", "condition", "diabetic"],
      ["i don't like fish", "preference", "fish"], ["i'm gluten free", "preference", "gluten"],
    ];
    const tmpl = ["{f}", "just so you know, {f}", "fyi {f}", "remember that {f}", "keep in mind i'm {f}", "note that {f}", "btw {f}", "for the record, {f}"];
    for (const [fct, kind, key] of facts)
      for (const t of tmpl) {
        const F = (s: string) => s.replaceAll("{f}", fct);
        emit(F(t), [`Durable ${kind} to store and apply going forward — remember it; no plan change needed unless asked.`, `This is a lasting fact (${kind}). Save it to memory so every future turn respects it.`],
          ["Noted — I'll keep that in mind from now on.", "Got it, I'll remember that.", "Thanks — I'll factor that into your plans."],
          [{ op: "remember", fact: fct, kind }], { remembers: key, profileChanged: true });
      }
    for (const [fct, op, exp] of [
      ["i just went vegan", { op: "constrain", diet: "vegan" }, { dietIs: "vegan" as Diet }],
      ["i'm allergic to mushrooms now", { op: "constrain", exclude: ["mushrooms"] }, { profileChanged: true }],
      ["i went keto this week", { op: "constrain", diet: "keto" }, { dietIs: "keto" as Diet }],
    ] as const)
      emit(`${fct}, update my plan`, ["Remember the durable fact AND apply it to the week now — two ops."],
        ["Noted, and I've updated your week to match."], [{ op: "remember", fact: fct }, op], exp);
  }

  // ================================================================= swap (whole week + single day)
  {
    for (const [dish, base] of [["pancakes", "pancakes for breakfast every day"], ["oatmeal", "i want oatmeal every morning"], ["pancakes", "give me pancakes daily for breakfast"], ["eggs", "eggs every morning"], ["yogurt", "yogurt every morning please"], ["oatmeal", "just oatmeal for breakfast, every day"]] as const)
      emit(base, [`Whole-week breakfast swap to ${dish} — no day given means every day.`, `They want ${dish} every morning; swap breakfast across all seven days.`],
        [`Done — ${dish} for breakfast every day.`, `You've got ${dish} every morning now.`],
        [{ op: "swap", dish, slot: "breakfast" }], { planChanged: true });
    for (const day of ["Monday", "Tuesday", "Wednesday", "Friday", "Saturday"])
      for (const [dish, slot] of [["pancakes", "breakfast"], ["a salad", "lunch"], ["pasta", "dinner"]] as const)
        for (const base of [`change ${day} ${slot} to ${dish}`, `i want ${dish} for ${day} ${slot}`])
          emit(base, [`Single-day swap: ${day} ${slot} → ${dish}. One day only.`],
            [`Swapped ${day}'s ${slot} for ${dish}.`],
            [{ op: "swap", dish, slot, days: [day] }], { planChanged: true });
  }

  // ================================================================= log (past-tense eaten)
  {
    const meals: [string, string, string, number][] = [
      ["Monday", "lunch", "pizza", 900], ["Tuesday", "lunch", "a burger", 800], ["Wednesday", "breakfast", "a donut", 450],
      ["Thursday", "dinner", "takeout thai", 1000], ["Friday", "lunch", "mcdonalds", 1100], ["Saturday", "breakfast", "a big brunch", 800],
      ["Sunday", "dinner", "pizza", 950],
    ];
    for (const [day, slot, dish, cals] of meals)
      for (const t of [`i ate ${dish} for ${slot}`, `had ${dish} for ${slot} today`, `i already ate ${dish} for ${slot}`, `just had ${dish} for ${slot}`])
        emit(t, ["Past-tense meal — log what they ate, then re-solve the rest of the day to stay on target.", "They already ate it; log it and rebalance the remaining meals."],
          ["Logged — I've adjusted the rest of today to stay on track.", "Got it, logged. The rest of the day's rebalanced."],
          [{ op: "log", day, slot, dish, calories: cals }], { planChanged: true });
  }

  // ================================================================= reserve (eating out, future)
  {
    for (const [day, slot, cals] of [["Friday", "dinner", 900], ["Saturday", "lunch", 800], ["Sunday", "dinner", 1000]] as const)
      for (const base of [`i'm eating out ${day} ${slot}`, `reserve about ${cals} for ${day} ${slot}, going out`, `${day} ${slot} is a restaurant, save room`])
        emit(base, [`Future meal out — reserve the calories for ${day} ${slot} and rebalance the day around it.`, `They'll eat out ${day} ${slot}; hold ~${cals} kcal and re-solve the rest.`],
          [`Done — held room for ${day} ${slot} and adjusted the day.`, `Got it — I've reserved ${day} ${slot} for eating out.`],
          [{ op: "reserve", day, slot, calories: cals }], { planChanged: true });
  }

  // ================================================================= rate / pin / resize
  {
    for (const [day, slot] of [["Monday", "breakfast"], ["Tuesday", "lunch"], ["Wednesday", "dinner"]] as const)
      for (const base of [`loved ${day}'s ${slot}`, `${day} ${slot} was amazing`, `${day}'s ${slot} was incredible`, `5 stars for ${day} ${slot}`])
        emit(base, [`Positive rating on ${day} ${slot} — record it so it recurs.`, `They loved ${day} ${slot}; rate it high to bias future plans.`],
          ["Glad you liked it — I'll plan it more often.", "Noted — I'll bring that back."],
          [{ op: "rate", rating: 5, day, slot }], { profileChanged: true });
    for (const [day, slot] of [["Thursday", "dinner"], ["Friday", "lunch"]] as const)
      for (const base of [`hated ${day}'s ${slot}`, `${day} ${slot} was gross`, `1 star for ${day} ${slot}`])
        emit(base, [`Negative rating on ${day} ${slot} — record it so it's avoided.`], ["Sorry to hear — I'll steer clear of that one."],
          [{ op: "rate", rating: 1, day, slot }], { profileChanged: true });
    for (const [day, slot] of [["Monday", "breakfast"], ["Wednesday", "lunch"], ["Sunday", "dinner"]] as const)
      for (const base of [`keep ${day} ${slot}`, `always give me ${day}'s ${slot}`, `pin ${day} ${slot}`, `lock in ${day} ${slot}`])
        emit(base, [`Pin ${day} ${slot} so future rebuilds leave it in place.`, `They want ${day} ${slot} kept; lock the slot.`],
          [`Pinned — ${day} ${slot} stays put.`, `Done — ${day} ${slot} won't change.`],
          [{ op: "pin", day, slot }], { profileChanged: true });
    for (const t of ["i'm still hungry", "make my portions bigger", "not enough food", "i need more on my plate", "bump everything up a bit"])
      emit(t, ["Bigger portions across the board.", "They're hungry — scale portions up."], ["Bumped your portions up.", "Done — bigger servings now."],
        [{ op: "resize", direction: "bigger" }], { planChanged: true });
    for (const t of ["that's too much food", "smaller portions please", "i'm overeating", "cut my portions down"])
      emit(t, ["Smaller portions across the board.", "They want less food — scale portions down."], ["Trimmed your portions down.", "Done — smaller servings now."],
        [{ op: "resize", direction: "smaller" }], { planChanged: true });
    for (const t of ["way too much food", "i'm super full, cut it a lot"])
      emit(t, ["Much smaller portions."], ["Cut them down a lot."], [{ op: "resize", direction: "much_smaller" }], { planChanged: true });
    for (const t of ["i'm starving all day, way bigger", "i lift heavy, load me up"])
      emit(t, ["Much bigger portions."], ["Loaded you up — much bigger servings."], [{ op: "resize", direction: "much_bigger" }], { planChanged: true });
  }

  // ================================================================= symptom / report (read-only)
  {
    for (const t of ["i'm always tired", "my nails keep breaking", "i keep getting sick", "i have muscle cramps", "i've been so fatigued lately", "my hair's falling out", "i bruise easily", "i'm dizzy in the afternoons", "i get headaches every day"])
      emit(t, ["A symptom — pass their exact words to the checker; never diagnose, just relate it to their week.", "They describe a symptom; hand it to symptom_check, don't invent a diagnosis."],
        ["Let me check that against your week.", "I'm not a doctor, but let me see how your plan lines up with that."],
        [{ op: "symptom", text: t }]);
    for (const t of ["how am i doing", "am i hitting my protein", "review my week", "am i missing any vitamins", "give me a summary", "how's my week looking", "am i on track", "what do my macros look like"])
      emit(t, ["Weekly review — read-only, just report the numbers.", "They want a status check; run the weekly report, change nothing."],
        ["Here's how your week looks.", "Let me pull your weekly summary."],
        [{ op: "report" }]);
  }

  // ================================================================= explain / substitute / hydration / answer (read-only)
  {
    for (const [day, slot] of [["Monday", "breakfast"], ["Wednesday", "lunch"], ["Friday", "dinner"]] as const)
      for (const base of [`why is ${day} ${slot} what it is`, `explain ${day}'s ${slot}`, `why'd you pick ${day} ${slot}`])
        emit(base, [`They want the reasoning behind ${day} ${slot} — explain it, change nothing.`], [`Here's why ${day}'s ${slot} is on your plan.`],
          [{ op: "explain", day, slot }]);
    for (const ing of ["eggs", "butter", "rice", "chicken", "milk", "flour"])
      for (const base of [`what can i use instead of ${ing}`, `i'm out of ${ing}, what's a sub`, `swap out the ${ing} for something`])
        emit(base, [`Ingredient substitution question for ${ing} — suggest alternatives, no plan change.`], [`Here are a few good swaps for ${ing}.`],
          [{ op: "substitute", ingredient: ing }]);
    for (const t of ["how much water should i drink", "am i drinking enough water", "what's my hydration target", "how much should i hydrate"])
      emit(t, ["Hydration question — compute a target from their profile; read-only."], ["Here's a good daily water target for you."],
        [{ op: "hydration" }]);
    for (const [w, a, base] of [[80, "very_active", "i weigh 80kg and train hard, water target?"], [65, "moderate", "i'm 65 kilos, moderately active — how much water"]] as const)
      emit(base, ["Hydration with weight + activity — compute from those; read-only."], ["Here's your water target based on that."],
        [{ op: "hydration", weightKg: w, activity: a }]);
    for (const t of ["what's a good source of protein", "is oatmeal healthy", "should i eat before a workout", "are eggs good for me", "what's better, rice or quinoa", "how much protein do i actually need", "is intermittent fasting worth it"])
      emit(t, ["General nutrition question — just answer it; no plan or profile change.", "Pure Q&A; reply with advice and emit no changes."],
        ["Happy to help — here's the short version.", "Good question — here's what I'd suggest."],
        [{ op: "answer" }]);
  }

  // ================================================================= CLARIFY (too vague → one question)
  {
    for (const t of ["change it", "can you fix it", "make it better", "adjust it", "do something different", "i don't like it", "switch it up", "redo it", "this isn't working", "help me lose weight"])
      emit(t, ["Too vague to act on — ask ONE focused question, don't guess.", "Ambiguous; a single clarifying question beats a wrong change."],
        ["Happy to — what should I change: a day, a meal, or a setting?", "Sure — which part: a specific day, one meal, or your overall targets?"],
        [], { noChange: true });
  }

  // ================================================================= DECLINE (unsupported → honest + nearest offer)
  {
    for (const t of ["skip breakfast every day", "i don't eat breakfast, remove it", "no breakfast at all", "delete breakfast"])
      emit(t, ["Plans run 3–4 meals; can't drop to 2 yet. Decline honestly and offer the nearest thing."],
        ["I can't remove breakfast entirely yet — plans run on 3 or 4 meals a day. Want a light, quick breakfast instead, or those calories moved into lunch and dinner?"], [], { noChange: true });
    for (const t of ["cook for me and my girlfriend", "make portions for two people", "i'm cooking for a family of four", "double it for me and my partner"])
      emit(t, ["Household scaling isn't built. Decline honestly, suggest a manual workaround."],
        ["I build for one person's targets right now — I can't scale to a household yet. You could double the quantities when you cook."], [], { noChange: true });
    for (const t of ["i do 16:8 fasting, no food before noon", "set up intermittent fasting", "no meals until 1pm", "i fast in the mornings"])
      emit(t, ["Fasting windows aren't built yet. Decline, offer the closest supported thing."],
        ["I can't set a fasting window yet — but I can shift your day to fewer, later meals if that helps. Want that?"], [], { noChange: true });
    for (const t of ["plan my whole month", "give me a 30 day plan", "do the next four weeks"])
      emit(t, ["Only a single week is supported. Decline honestly."],
        ["I plan one week at a time right now — a full month isn't supported yet. I can rebuild this week however you like, though."], [], { noChange: true });
  }

  // ================================================================= REFUSE (internal contradiction)
  {
    for (const t of ["make it vegan but add chicken", "vegan week with beef on friday", "all plant-based except salmon daily", "vegan but i want eggs every morning"])
      emit(t, ["Contradiction: vegan excludes all animal products. Don't silently pick one side — surface the clash."],
        ["Those clash — vegan means no meat, fish, or eggs. Want a fully vegan week, or a non-vegan week with that added?"], [], { noChange: true });
    for (const t of ["keto but high carb", "low carb but lots of rice and pasta", "keto with 300g of carbs"])
      emit(t, ["Contradiction: keto is inherently low-carb. Surface it rather than guessing."],
        ["That doesn't quite work — keto is low-carb by definition. Do you want keto, or a higher-carb plan? I'll build whichever."], [], { noChange: true });
  }

  // ================================================================= MULTI-TURN (correction / follow-up / clarify→resolve)
  {
    push([U("i want pancakes for breakfast every day"), A("Done — pancakes for Monday breakfast."), U("no i said EVERY day")],
      "They're correcting me — the swap should span all days, not just Monday.", "You're right — pancakes every day now.",
      [{ op: "swap", dish: "pancakes", slot: "breakfast" }], { planChanged: true }); k++;
    push([U("make it cheaper"), A("Done — budget-friendly meals across the week."), U("actually also make it vegetarian")],
      "Follow-up adds a diet change on top of the earlier budget change; apply the new one.", "Done — still cheap, and now vegetarian too.",
      [{ op: "constrain", diet: "vegetarian" }], { dietIs: "vegetarian", planChanged: true }); k++;
    push([U("change my week"), A("Sure — what should I change: a day, a meal, or a setting?"), U("make the whole thing vegan")],
      "They answered my clarifying question — now I can act: whole-week vegan.", "Got it — your whole week's vegan now.",
      [{ op: "constrain", diet: "vegan" }], { dietIs: "vegan", planChanged: true }); k++;
    push([U("i'm vegetarian"), A("Noted — I'll keep that in mind."), U("ok now build my week around it")],
      "They stated a preference, then asked to apply it — set the diet on the week.", "Done — a vegetarian week, built around what you told me.",
      [{ op: "constrain", diet: "vegetarian" }], { dietIs: "vegetarian", planChanged: true }); k++;
    push([U("more protein"), A("How much protein are you aiming for a day?"), U("like 180 grams")],
      "They gave the number after I asked — set protein to 180g.", "Done — 180g of protein a day.",
      [{ op: "constrain", targets: { protein: 180 } }], { planChanged: true }); k++;
    push([U("i had a huge lunch out"), A("Roughly how many calories was it?"), U("probably 1200")],
      "They answered with the estimate — log the eaten lunch at 1200 and rebalance the day.", "Logged 1200 for lunch — I've lightened the rest of today to balance it.",
      [{ op: "log", day: "Monday", slot: "lunch", dish: "lunch out", calories: 1200 }], { planChanged: true }); k++;
    push([U("make it keto"), A("Done — your week's keto now."), U("wait no, i meant just mediterranean")],
      "They're correcting the diet — switch from keto to mediterranean.", "No problem — switched to mediterranean instead.",
      [{ op: "constrain", diet: "mediterranean" }], { dietIs: "mediterranean", planChanged: true }); k++;
  }

  // ================================================================= COMPOUND (several changes, one constrain)
  {
    const combos: [string[], Record<string, unknown>, string][] = [
      [["cheaper, vegetarian, no mushrooms", "make it budget and veggie without mushrooms", "vegetarian, cheap, and drop the mushrooms"], { budget: "low", diet: "vegetarian", exclude: ["mushrooms"] }, "cheaper, vegetarian, and no mushrooms"],
      [["vegan, italian, and quick", "make it vegan italian and fast", "quick vegan italian week"], { diet: "vegan", cuisine: "italian", maxCookTime: 20 }, "vegan, Italian, and quick"],
      [["keto, no onions, 1800 calories", "keto week, 1800 cals, hold the onions"], { diet: "keto", exclude: ["onions"], targets: { calories: 1800 } }, "keto, no onions, at 1800 a day"],
      [["mediterranean, 160g protein, no olives", "med diet with 160 protein and no olives"], { diet: "mediterranean", exclude: ["olives"], targets: { protein: 160 } }, "Mediterranean, 160g protein, no olives"],
    ];
    for (const [phrs, body, summary] of combos)
      for (const base of phrs) {
        const exp = (body.diet ? { dietIs: body.diet as Diet, planChanged: true } : { planChanged: true }) as TrainingExample["expect"];
        emit(base, ["Several changes at once — fold them into a single constrain, don't split into many turns."], [`Done — ${summary}.`],
          [{ op: "constrain", ...body }], exp);
      }
  }

  // ================================================================= RAMBLING (feelings + real edits + a fact to remember)
  {
    push([U("ugh so stressed, i went vegetarian recently, and i really hate mushrooms, can you make my meals quick i work late")],
      "Emotion + a diet change + an exclusion + quick meals. Remember the stress as context; the rest are real edits in one constrain.",
      "Got it — vegetarian, no mushrooms, and quick meals. Hope things calm down soon.",
      [{ op: "remember", fact: "feeling stressed lately", kind: "context" }, { op: "constrain", diet: "vegetarian", exclude: ["mushrooms"], maxCookTime: 20 }],
      { dietIs: "vegetarian" }); k++;
    push([U("so my doctor called, iron's low again, and honestly i've been vegan for years so no meat, help me out here")],
      "A durable fact (vegan, years) + a health boost (iron) while holding vegan. Remember the vegan history; boost iron with the diet held.",
      "Done — more iron-rich foods while keeping everything vegan. Worth pairing them with vitamin C to absorb it better.",
      [{ op: "remember", fact: "vegan for years", kind: "preference" }, { op: "constrain", boostNutrient: "iron", diet: "vegan" }],
      { dietIs: "vegan", planChanged: true }); k++;
    push([U("kinda broke till payday, also i can't do dairy, just make it work")],
      "Money context + a dairy exclusion. Cheaper budget and exclude dairy in one constrain.",
      "No worries — cheaper meals and no dairy this week.",
      [{ op: "constrain", budget: "low", exclude: ["dairy"] }], { profileChanged: true }); k++;
    push([U("new job starts monday, gonna be slammed, keep everything under 20 min and honestly i'm trying to hit more protein like 180")],
      "Life context + two real edits: quick meals and a protein target. One constrain carries both.",
      "Congrats on the job — everything's under 20 minutes now, and I've set protein to 180g a day.",
      [{ op: "constrain", maxCookTime: 20, targets: { protein: 180 } }], { planChanged: true }); k++;
  }

  // ================================================================= MEMORY APPLICATION
  // The profile already carries a stored fact; a new request must be executed while honoring it.
  // The op is ordinary, but the reasoning + reply must show the fact shaping the answer — this is
  // what makes the assistant feel like it remembers you, the whole point of the memory layer.
  {
    const mem = (fact: string, kind: UserFact["kind"]): UserProfile => ({ ...BASE, memory: [{ fact, kind }] });
    const cases: [string, UserProfile, string, string, unknown[], TrainingExample["expect"]][] = [
      ["bump my protein to 180", mem("allergic to peanuts", "allergy"), "They told me before they're allergic to peanuts — hit 180g protein but keep it peanut-free.", "Done — 180g of protein a day, and I've kept it peanut-free like you told me.", [{ op: "constrain", targets: { protein: 180 } }], { planChanged: true }],
      ["make this week cheaper", mem("i'm lactose intolerant", "allergy"), "Budget down to low, and remember they can't do lactose — no dairy sneaking in.", "Got it — cheaper meals, and still no dairy since you're lactose intolerant.", [{ op: "constrain", budget: "low" }], { profileChanged: true }],
      ["give me an italian week", mem("i hate mushrooms", "preference"), "Italian theme, but they've told me mushrooms are a hard no — keep them out.", "Yum — an Italian week, and no mushrooms, just how you like it.", [{ op: "constrain", cuisine: "italian" }], { planChanged: true }],
      ["more iron please", mem("vegetarian for years", "preference"), "Boost iron, and I already know they're a long-time vegetarian — keep it meat-free and pair with vitamin C.", "Done — more iron-rich foods, all vegetarian. I've leaned on lentils and greens with some vitamin C to help you absorb it.", [{ op: "constrain", boostNutrient: "iron" }], { planChanged: true }],
      ["make it quick, i'm slammed", mem("training for a marathon", "goal"), "Quick meals, but they're marathon training — keep the carbs and calories where they need to be for that.", "Done — everything's under 20 minutes, and I've kept your carbs up for marathon training.", [{ op: "constrain", maxCookTime: 20 }], { profileChanged: true }],
    ];
    for (const [base, profile, think, reply, ops, expect] of cases)
      emit(base, [think], [reply], ops, expect, profile);
  }

  // ================================================================= DEEPER MULTI-TURN (context carry)
  // 3–4 turn threads where the final action depends on everything said before — the model has to hold
  // the conversation, not just the last line.
  {
    push([U("i'm trying to eat healthier"), A("Love that. Want me to set a direction — more veggies, a diet like Mediterranean, or a calorie target?"), U("mediterranean sounds good"), A("Great choice. Whole week Mediterranean?"), U("yeah do it")],
      "Four turns of narrowing; they've now confirmed a whole-week Mediterranean switch.", "Done — your whole week's Mediterranean now. It's a great, sustainable way to eat.",
      [{ op: "constrain", diet: "mediterranean" }], { dietIs: "mediterranean", planChanged: true }); k++;
    push([U("make it vegetarian"), A("Done — vegetarian week."), U("and cheaper"), A("Got it — budget-friendly too."), U("oh and no tofu, i'm sick of it")],
      "Third change in the thread — exclude tofu on top of the vegetarian, cheap week already set.", "No problem — no more tofu.",
      [{ op: "constrain", exclude: ["tofu"] }], { profileChanged: true }); k++;
    push([U("i keep getting hungry at night"), A("A few things can cause that. Want me to shift more calories to dinner, or bump your overall intake?"), U("bump it up, i think i'm just not eating enough"), A("How's 2300 a day sound?"), U("perfect")],
      "They landed on raising intake to 2300 after the back-and-forth.", "Done — 2300 calories a day. That should keep the late-night hunger down.",
      [{ op: "constrain", targets: { calories: 2300 } }], { planChanged: true }); k++;
    push([U("my sister's coming to stay, she's vegan"), A("Nice — want the whole week vegan while she's here?"), U("no just make thursday and friday vegan")],
      "They narrowed it to two specific days — a temporary per-day override, not a profile change.", "Got it — Thursday and Friday are vegan, the rest of your week stays as is.",
      [{ op: "constrain", scope: { days: ["Thursday", "Friday"] }, diet: "vegan" }], { planChanged: true }); k++;
    push([U("i had surgery, on a soft foods diet for 2 weeks"), A("I'm sorry to hear that — I hope recovery's smooth. I can't set a dedicated soft-foods mode yet, but I can steer toward softer, easy-to-eat meals. Want that?"), U("yes please, and nothing spicy")],
      "No soft-foods mode exists, but they accepted the nearest thing and added a real exclusion — apply the spice exclusion honestly and note the soft-food steer in the reply.", "Done — I've kept things mild with no spice, and leaned toward softer meals. Take care of yourself.",
      [{ op: "constrain", exclude: ["spicy"] }], { profileChanged: true }); k++;
  }

  // ================================================================= MORE HONEST DECLINES (breadth)
  {
    for (const t of ["track my macros in grams to the decimal", "calorie cycle me, high on workout days", "sync this to my apple watch", "order the groceries for me", "count my alcohol calories too"])
      emit(t, ["Not a supported capability. Decline honestly and, where possible, offer the nearest thing I can do."],
        ["That's not something I can do yet — I'd rather be straight with you than fake it. Tell me the part I can help with (targets, meals, a grocery list) and I'll take care of that."], [], { noChange: true });
    for (const t of ["prescribe me a supplement stack", "how many mg of iron should i take", "diagnose why i'm tired"])
      emit(t, ["This crosses into medical advice / dosing — decline and point to a professional; I can still shape the food side."],
        ["I can't give medical or dosing advice — that's worth a doctor or dietitian. What I can do is build your meals to support it. Want me to steer your week toward more of that nutrient?"], [], { noChange: true });
  }

  // Drop exact duplicates (identical turns + reasoning + reply + ops), which the surface multiplier
  // can occasionally produce when an opener collapses to the plain form.
  const seen = new Set<string>();
  return out.filter((ex) => {
    const key = JSON.stringify([ex.turns, ex.thinking, ex.reply, ex.operations, ex.expect, ex.profile]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
