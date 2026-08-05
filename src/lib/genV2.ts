/**
 * The v2 conversation generator. Produces realistic training examples across the whole intent
 * taxonomy — every one carrying a reasoning trace, and every one meant to survive the engine
 * validator (validateExample). Volume comes from phrasing variety here; correctness comes from the
 * validator downstream. This is the seed set the fine-tune learns the primitives + reason-then-act
 * + the four honest outcomes from. Only intents the engine actually supports are generated (no
 * per-slot targeting or bare undo yet — those become honest declines or are added when built).
 *
 * Two deliberate anti-overfit choices:
 *  1. Every intent draws its `thinking` and `reply` from ROTATING banks (not one fixed string), so
 *     the model learns the reasoning *pattern* and a range of natural replies, never a template to
 *     parrot. `rot(bank, k)` walks the bank as the running counter `k` advances.
 *  2. Phrasings lean casual/typo'd/emotional/run-on — the way people actually type — because the
 *     point is to survive messy input, not clean commands.
 */
import type { UserProfile } from "./types";
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

  // ================================================================= constrain: diet (whole week)
  {
    const diets: Diet[] = ["vegetarian", "vegan", "keto", "mediterranean"];
    const tmpl = [
      "go {d}", "make my week {d}", "i want to eat {d}", "switch me to {d}", "{d} please",
      "can you make everything {d}", "turn my plan {d}", "i'm going {d} starting now", "{d} the whole week",
      "make the whole week {d} pls", "everything should be {d}", "i decided to eat {d}",
    ];
    const think = [
      "Clear whole-week diet switch to {d} — persist it to the profile and rebuild every day around it.",
      "They want the entire plan {d}. That's a durable change, one constrain scoped to the week.",
      "Whole-week {d}. Save it so future days stay {d}, then regenerate the week.",
      "Straightforward diet change: make the week {d}. Scope is the week, so it sticks.",
      "The request is unambiguous — {d} across the board. Update the profile's diet and re-solve.",
    ];
    const reply = [
      "Done — your whole week is {d} now.",
      "You're all set — every day is {d}.",
      "Rebuilt the week {d}. Want me to keep anything from before?",
      "Switched — your plan's {d} from here on.",
      "Got it, {d} it is. The week's regenerated around that.",
    ];
    for (const d of diets)
      for (const t of tmpl) {
        const f = (s: string) => s.replaceAll("{d}", d);
        push([U(f(t))], f(rot(think, k)), f(rot(reply, k)), [{ op: "constrain", diet: d }], { dietIs: d, planChanged: true });
        k++;
      }
    // back to no restrictions — starts from a restricted profile so the change is real
    const off = ["go back to normal", "no more diet restrictions", "drop the diet", "i want to eat everything again", "remove my diet please", "un-restrict me"];
    for (const p of off) {
      push([U(p)], rot(["They're lifting the diet — set it back to none and rebuild unrestricted.", "Remove the diet restriction; scope week, persist it."], k),
        rot(["Done — no diet restrictions anymore.", "All set — your week's open again, anything goes."], k),
        [{ op: "constrain", diet: "none" }], { dietIs: "none", planChanged: true }, withDiet("vegetarian"));
      k++;
    }
  }

  // ================================================================= constrain: diet × exclude / budget / cuisine
  {
    const diets: Diet[] = ["vegetarian", "vegan", "mediterranean"];
    // diet + exclude
    for (const d of diets)
      for (const food of ["mushrooms", "onions", "cilantro"]) {
        for (const p of [`${d} but no ${food}`, `make it ${d} and drop the ${food}`, `${d}, and i hate ${food}`]) {
          push([U(p)], rot([`Two things at once: diet {d} and exclude {food}. One constrain carries both.`, `They want {d} AND {food} gone — combine into a single constrain.`], k).replaceAll("{d}", d).replaceAll("{food}", food),
            rot([`Done — {d}, and no {food}.`, `You're set: {d} week with {food} left out.`], k).replaceAll("{d}", d).replaceAll("{food}", food),
            [{ op: "constrain", diet: d, exclude: [food] }], { dietIs: d, planChanged: true });
          k++;
        }
      }
    // diet + budget
    for (const d of diets)
      for (const [b, w] of [["low", "cheap"], ["high", "fancier"]] as const) {
        push([U(`${d} and ${w}`)], `Diet {d} plus a {b} budget — one constrain.`.replaceAll("{d}", d).replaceAll("{b}", b),
          `Done — {d}, {w}.`.replaceAll("{d}", d).replaceAll("{w}", w),
          [{ op: "constrain", diet: d, budget: b }], { dietIs: d, planChanged: true });
        k++;
      }
    // diet + cuisine
    for (const d of diets)
      for (const c of ["italian", "mediterranean", "mexican"]) {
        push([U(`a ${d} ${c} week`)], `Diet {d} themed {c}.`.replaceAll("{d}", d).replaceAll("{c}", c),
          `Yum — a {d} {c} week, coming up.`.replaceAll("{d}", d).replaceAll("{c}", c),
          [{ op: "constrain", diet: d, cuisine: c }], { dietIs: d, planChanged: true });
        k++;
      }
  }

  // ================================================================= constrain: budget
  {
    const cheaper = ["make it cheaper", "tighter budget please", "i'm broke this week", "budget meals only", "keep it low cost", "spend less on food", "cheapest options you've got", "i can't afford much rn", "money's tight, cut costs"];
    const fancier = ["splurge a bit this week", "fancier meals", "money's no object", "treat me to nicer food", "go premium this week", "i want to eat well, budget's fine", "nicer ingredients please"];
    for (const p of cheaper) {
      push([U(p)], rot(["Cheaper week — set budget low and rebuild.", "They want to spend less; budget → low, persist it.", "Money's tight — low budget, re-solve the week."], k),
        rot(["Done — switched to budget-friendly meals.", "Got it, keeping it cheap this week.", "All set — low-cost meals across the week."], k),
        [{ op: "constrain", budget: "low" }], { profileChanged: true }); k++;
    }
    for (const p of fancier) {
      push([U(p)], rot(["Pricier week — budget high.", "They want to splurge; bump budget to high.", "Premium week — set budget high and rebuild."], k),
        rot(["Nice — bumped up to fancier options.", "Done, treating you to nicer meals this week.", "All set — premium ingredients this week."], k),
        [{ op: "constrain", budget: "high" }], { profileChanged: true }); k++;
    }
  }

  // ================================================================= constrain: exclude (single + pairs)
  {
    const foods = ["onions", "mushrooms", "cilantro", "olives", "tomatoes", "peppers", "eggplant", "garlic", "shrimp", "pork"];
    const tmpl = ["no {f}", "i hate {f}", "keep {f} out", "remove {f}", "i can't stand {f}", "please avoid {f}", "leave out the {f}", "{f} makes me gag", "absolutely no {f}", "skip the {f}"];
    for (const food of foods)
      for (const t of tmpl) {
        const f = (s: string) => s.replaceAll("{f}", food);
        push([U(f(t))], f(rot(["Exclude {f} week-wide; persist to the profile.", "They dislike {f} — add it to the exclusion list and re-solve.", "{f} out for the whole week. Save the exclusion."], k)),
          f(rot(["No problem — I'll keep {f} out of your week.", "Done, no more {f}.", "Got it — {f} is off the menu."], k)),
          [{ op: "constrain", exclude: [food] }], { profileChanged: true }); k++;
      }
    for (const [a, b] of [["onions", "garlic"], ["mushrooms", "olives"], ["cilantro", "peppers"], ["shrimp", "pork"]]) {
      for (const p of [`no ${a} or ${b}`, `drop the ${a} and ${b}`, `i hate ${a} and ${b}`]) {
        push([U(p)], `Two exclusions: {a} and {b}. One constrain.`.replaceAll("{a}", a).replaceAll("{b}", b),
          `Done — no {a}, no {b}.`.replaceAll("{a}", a).replaceAll("{b}", b),
          [{ op: "constrain", exclude: [a, b] }], { profileChanged: true }); k++;
      }
    }
  }

  // ================================================================= constrain: calories / protein / carbs / fat / fiber
  {
    const cals = [1500, 1600, 1800, 2000, 2200, 2500];
    const calTmpl = ["{c} calories a day", "set me to {c} kcal", "i want {c} a day", "cut me to {c} daily", "{c} cals per day", "aim for {c} a day", "keep me around {c} calories"];
    for (const c of cals)
      for (const t of calTmpl) {
        const f = (s: string) => s.replaceAll("{c}", String(c));
        push([U(f(t))], f(rot(["Set the daily calorie target to {c}; the engine re-solves macros.", "Daily calories → {c}. Persist and rebuild.", "They want {c} kcal/day — update the target, re-solve."], k)),
          f(rot(["Updated your daily target to {c} kcal.", "Done — {c} a day now.", "Set — aiming for {c} calories daily."], k)),
          [{ op: "constrain", targets: { calories: c } }], { planChanged: true }); k++;
      }
    const prot = [130, 140, 160, 180, 200, 220];
    const protTmpl = ["{g}g protein a day", "bump protein to {g}", "i need {g} grams of protein", "hit {g}g protein daily", "more protein, like {g}g", "get me to {g}g protein"];
    for (const g of prot)
      for (const t of protTmpl) {
        const f = (s: string) => s.replaceAll("{g}", String(g));
        push([U(f(t))], f(rot(["Protein target {g}g/day — the engine rebalances the rest.", "Set protein to {g}g and re-solve macros.", "They want {g}g protein daily; update the target."], k)),
          f(rot(["Done — protein target set to {g}g a day.", "Set — {g}g of protein daily.", "Bumped protein to {g}g/day."], k)),
          [{ op: "constrain", targets: { protein: g } }], { planChanged: true }); k++;
      }
    for (const g of [25, 30, 35, 40])
      for (const t of ["{g}g fiber a day", "more fiber, like {g}g", "get me to {g} grams of fiber", "i need {g}g of fiber"]) {
        const f = (s: string) => s.replaceAll("{g}", String(g));
        push([U(f(t))], f(rot(["Fiber target {g}g — prioritize higher-fiber foods.", "Set fiber to {g}g/day and re-solve."], k)),
          f(rot(["Sure — prioritizing higher-fiber meals ({g}g).", "Done — targeting {g}g of fiber a day."], k)),
          [{ op: "constrain", targets: { fiber: g } }], { planChanged: true }); k++;
      }
    for (const g of [120, 150, 180, 220])
      for (const t of ["{g}g carbs a day", "set carbs to {g}", "keep carbs around {g}g"]) {
        const f = (s: string) => s.replaceAll("{g}", String(g));
        push([U(f(t))], f("Carb target {g}g/day; re-solve."), f("Done — carbs set to {g}g a day."),
          [{ op: "constrain", targets: { carbs: g } }], { planChanged: true }); k++;
      }
    for (const g of [50, 60, 70, 80])
      for (const t of ["{g}g fat a day", "set fat to {g}", "keep fat near {g}g"]) {
        const f = (s: string) => s.replaceAll("{g}", String(g));
        push([U(f(t))], f("Fat target {g}g/day; re-solve."), f("Done — fat set to {g}g a day."),
          [{ op: "constrain", targets: { fat: g } }], { planChanged: true }); k++;
      }
    // calories + protein together
    for (const [c, g] of [[1800, 160], [2000, 180], [2200, 200], [1600, 140]]) {
      for (const p of [`${c} calories and ${g}g protein`, `${c} cals, ${g} protein`, `keep me at ${c} with ${g}g protein`]) {
        push([U(p)], `Two macro targets at once: {c} kcal and {g}g protein. One constrain.`.replaceAll("{c}", String(c)).replaceAll("{g}", String(g)),
          `Done — {c} calories a day with {g}g of protein.`.replaceAll("{c}", String(c)).replaceAll("{g}", String(g)),
          [{ op: "constrain", targets: { calories: c, protein: g } }], { planChanged: true }); k++;
      }
    }
  }

  // ================================================================= constrain: cuisine (whole week)
  {
    const cuisines = ["italian", "asian", "mexican", "indian", "mediterranean"];
    const tmpl = ["make it {c}", "i'm craving {c}", "{c} week please", "give me {c} food", "i want {c} this week", "everything {c}", "surprise me with {c} dishes"];
    for (const c of cuisines)
      for (const t of tmpl) {
        const f = (s: string) => s.replaceAll("{c}", c);
        push([U(f(t))], f(rot(["Themed week: {c}. Persist the cuisine preference and rebuild.", "They're craving {c} — set cuisine and re-solve the week.", "Whole-week {c} theme; update the profile."], k)),
          f(rot(["Yum — rebuilt your week with {c} dishes.", "Done — a {c} week coming up.", "All set, {c} all week."], k)),
          [{ op: "constrain", cuisine: c }], { planChanged: true }); k++;
      }
  }

  // ================================================================= constrain: mealsPerDay
  {
    for (const p of ["i want 4 meals a day", "add a daily snack", "give me four meals", "i prefer 4 meals", "make it 4 meals a day", "i graze, four meals please", "split it into 4 meals"]) {
      push([U(p)], rot(["Four meals a day — add the snack slot, persist, rebuild.", "They want 4 meals/day; update mealsPerDay and re-solve."], k),
        rot(["Done — four meals a day now, with a snack.", "Set — you've got four meals a day."], k),
        [{ op: "constrain", mealsPerDay: 4 }], { planChanged: true }); k++;
    }
    for (const p of ["back to 3 meals", "drop the snack", "just three meals a day", "i only want 3 meals"]) {
      push([U(p)], "Back to three meals — remove the snack slot.", "Done — three meals a day.",
        [{ op: "constrain", mealsPerDay: 3 }], { planChanged: true }, { ...BASE, mealsPerDay: 4 }); k++;
    }
  }

  // ================================================================= constrain: no oven / quick / cook time
  {
    for (const p of ["i don't have an oven", "no baking this week", "stovetop only", "my oven's broken", "can't use the oven right now", "no-bake meals only"]) {
      push([U(p)], rot(["No oven — exclude baked/roasted so nothing needs one.", "Their oven's out; exclude bake/roast/oven and rebuild."], k),
        rot(["Got it — nothing baked or roasted.", "Done — everything's stovetop from here."], k),
        [{ op: "constrain", exclude: ["bake", "roast", "oven"] }], { profileChanged: true }); k++;
    }
    for (const [mins, phr] of [[20, "quick meals only"], [20, "nothing over 20 minutes"], [15, "nothing over 15 min"], [20, "i'm busy, fast recipes"], [25, "keep cooking under 25 minutes"], [20, "quick stuff, i work late"]] as const) {
      push([U(phr)], `Cap cook time at {m} minutes, week-wide.`.replaceAll("{m}", String(mins)),
        `Done — everything's {m} minutes or less.`.replaceAll("{m}", String(mins)),
        [{ op: "constrain", maxCookTime: mins }], { profileChanged: true }); k++;
    }
  }

  // ================================================================= constrain: day scope (single / range / weekend)
  {
    const diets: Diet[] = ["vegetarian", "vegan", "keto"];
    for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"])
      for (const d of diets) {
        for (const p of [`make ${day} ${d}`, `just ${day} ${d}`, `${day} should be ${d}`]) {
          push([U(p)], rot([`Single day {day} → {d}, temporary (a per-day override, not saved to the profile).`, `Only {day} is {d}; rebuild that one day, leave the rest and the profile alone.`], k).replaceAll("{day}", day).replaceAll("{d}", d),
            rot([`Got it — {day}'s {d}, the rest unchanged.`, `Done — just {day} is {d} now.`], k).replaceAll("{day}", day).replaceAll("{d}", d),
            [{ op: "constrain", scope: { days: [day] }, diet: d }], { planChanged: true }); k++;
        }
      }
    for (const p of ["vegetarian monday through wednesday", "mon to wed veggie", "make monday tuesday wednesday vegetarian", "veggie for the first half of the week"])
      push_i(out, () => k++, [U(p)], "Day range Mon–Wed vegetarian — three per-day rebuilds, nothing persisted.", "Done — Monday through Wednesday are vegetarian.",
        [{ op: "constrain", scope: { days: ["Monday", "Tuesday", "Wednesday"] }, diet: "vegetarian" }], { planChanged: true });
    for (const p of ["lighter on the weekend", "smaller meals saturday and sunday", "cut weekend calories", "go easy on sat and sun"])
      push_i(out, () => k++, [U(p)], "Weekend = Sat+Sun, fewer calories. Per-day override on those two days.", "Sure — lighter Saturday and Sunday.",
        [{ op: "constrain", scope: { days: ["Saturday", "Sunday"] }, targets: { calories: 1600 } }], { planChanged: true });
    for (const [day, c] of [["Friday", "italian"], ["Saturday", "mexican"], ["Sunday", "indian"]] as const)
      for (const p of [`make ${day} ${c}`, `i want ${c} on ${day}`])
        push_i(out, () => k++, [U(p)], `Single-day cuisine: {day} → {c}, temporary.`.replaceAll("{day}", day).replaceAll("{c}", c),
          `Done — {day}'s {c}.`.replaceAll("{day}", day).replaceAll("{c}", c),
          [{ op: "constrain", scope: { days: [day] }, cuisine: c }], { planChanged: true });
  }

  // ================================================================= constrain: boostNutrient (+ hold a diet)
  {
    const nutrients: [string, string][] = [["iron", "iron"], ["vitD", "vitamin d"], ["b12", "b12"], ["calcium", "calcium"], ["magnesium", "magnesium"], ["potassium", "potassium"], ["zinc", "zinc"], ["folate", "folate"], ["vitC", "vitamin c"]];
    for (const [n, w] of nutrients)
      for (const p of [`i'm low on ${w}`, `i need more ${w}`, `my doctor said my ${w} is low`, `boost my ${w}`, `more ${w} in my meals`]) {
        push([U(p)], rot([`Boost {n}; the engine picks foods and computes amounts — I never guess numbers.`, `They're low on {n} — set boostNutrient and re-solve around rich foods.`], k).replaceAll("{n}", n),
          rot([`Done — rebuilt your week around foods rich in that nutrient.`, `Got it — more {w}-rich meals this week.`], k).replaceAll("{w}", w),
          [{ op: "constrain", boostNutrient: n }], { planChanged: true }); k++;
      }
    for (const [n, w, d] of [["iron", "iron", "vegetarian"], ["calcium", "calcium", "vegan"]] as const)
      for (const p of [`my ${w}'s low but keep me ${d}`, `more ${w}, still ${d}`])
        push_i(out, () => k++, [U(p)], `Boost {n} AND hold {d} together — one constrain carries both.`.replaceAll("{n}", n).replaceAll("{d}", d),
          `Done — more {w}-rich foods, still {d}.`.replaceAll("{w}", w).replaceAll("{d}", d),
          [{ op: "constrain", boostNutrient: n, diet: d }], { dietIs: d, planChanged: true });
    // The honest edge case: b12 can't be sourced from plant foods, so a vegan plan can't fix it by
    // food alone. Don't fake a plan change — advise supplementation. This is the DECLINE-honestly
    // outcome, and it's exactly the kind of real-nutrition judgment the assistant must get right.
    for (const p of ["my b12's low but keep me vegan", "more b12, still vegan", "how do i get b12 on a vegan diet"])
      push_i(out, () => k++, [U(p)],
        "b12 is essentially absent from plant foods, so a vegan plan can't fix a deficiency by food alone. Be honest — recommend a supplement / fortified foods; don't pretend a rebuild solves it.",
        "Honest answer: b12 is the one nutrient a vegan diet can't reliably cover — it isn't in plant foods in usable amounts. I'll keep your week vegan, but you'll want a b12 supplement or fortified foods (nutritional yeast, fortified plant milk). Want me to lean the plan toward those fortified options?",
        [{ op: "answer" }]);
  }

  // ================================================================= remember
  {
    const facts: [string, string, string][] = [
      ["lactose intolerant", "allergy", "lactose"], ["allergic to peanuts", "allergy", "peanuts"],
      ["allergic to shellfish", "allergy", "shellfish"], ["i hate cilantro", "preference", "cilantro"],
      ["training for a marathon", "goal", "marathon"], ["i have ibs", "condition", "ibs"],
      ["i'm pescatarian", "preference", "pescatarian"], ["i work night shifts", "context", "night shift"],
      ["i'm trying to lose weight", "goal", "lose weight"], ["i'm diabetic", "condition", "diabetic"],
    ];
    const tmpl = ["{f}", "just so you know, {f}", "fyi {f}", "remember that {f}", "keep in mind i'm {f}", "note that {f}", "btw {f}"];
    for (const [fct, kind, key] of facts)
      for (const t of tmpl) {
        const f = (s: string) => s.replaceAll("{f}", fct);
        push([U(f(t))], rot([`Durable ${kind} to store and apply going forward — remember it; no plan change needed unless asked.`, `This is a lasting fact (${kind}). Save it to memory so every future turn respects it.`], k),
          rot(["Noted — I'll keep that in mind from now on.", "Got it, I'll remember that.", "Thanks — I'll factor that into your plans."], k),
          [{ op: "remember", fact: fct, kind }], { remembers: key, profileChanged: true }); k++;
      }
    // remember + act in the same turn
    for (const [fct, key, op, exp] of [
      ["i just went vegan", "vegan", { op: "constrain", diet: "vegan" }, { dietIs: "vegan" as Diet }],
      ["i'm allergic to mushrooms now", "mushroom", { op: "constrain", exclude: ["mushrooms"] }, { profileChanged: true }],
    ] as const) {
      push([U(`${fct}, update my plan`)], "Remember the durable fact AND apply it to the week now — two ops.",
        "Noted, and I've updated your week to match.",
        [{ op: "remember", fact: fct }, op], exp); k++;
    }
  }

  // ================================================================= swap (whole week + single day)
  {
    const daily: [string, string][] = [["pancakes", "pancakes for breakfast every day"], ["oatmeal", "i want oatmeal every morning"], ["pancakes", "give me pancakes daily for breakfast"], ["eggs", "eggs every morning"], ["yogurt", "yogurt every morning please"]];
    for (const [dish, p] of daily) {
      push([U(p)], rot([`Whole-week breakfast swap to ${dish} — no day given means every day.`, `They want ${dish} every morning; swap breakfast across all seven days.`], k),
        rot([`Done — ${dish} for breakfast every day.`, `You've got ${dish} every morning now.`], k),
        [{ op: "swap", dish, slot: "breakfast" }], { planChanged: true }); k++;
    }
    for (const day of ["Monday", "Tuesday", "Wednesday", "Friday", "Saturday"])
      for (const [dish, verb] of [["pancakes", "swap"], ["a salad", "change"], ["pasta", "make"]] as const) {
        const slot = dish === "pancakes" ? "breakfast" : dish === "a salad" ? "lunch" : "dinner";
        for (const p of [`${verb} ${day} ${slot} to ${dish}`, `i want ${dish} for ${day} ${slot}`]) {
          push([U(p)], `Single-day swap: ${day} ${slot} → ${dish}. One day only.`,
            `Swapped ${day}'s ${slot} for ${dish}.`,
            [{ op: "swap", dish, slot, days: [day] }], { planChanged: true }); k++;
        }
      }
  }

  // ================================================================= log (past-tense eaten)
  {
    const meals: [string, string, string, number][] = [
      ["Monday", "lunch", "pizza", 900], ["Tuesday", "lunch", "a burger", 800], ["Wednesday", "breakfast", "a donut", 450],
      ["Thursday", "dinner", "takeout thai", 1000], ["Friday", "lunch", "mcdonalds", 1100], ["Saturday", "breakfast", "a big brunch", 800],
    ];
    const tmpl = ["i ate {dish} for {slot}", "had {dish} for {slot} today", "i already ate {dish} for {slot}", "just had {dish} for {slot}"];
    for (const [day, slot, dish, cals] of meals)
      for (const t of tmpl) {
        const f = (s: string) => s.replaceAll("{dish}", dish).replaceAll("{slot}", slot);
        push([U(f(t))], rot(["Past-tense meal — log what they ate, then re-solve the rest of the day to stay on target.", "They already ate it; log it and rebalance the remaining meals."], k),
          rot(["Logged — I've adjusted the rest of today to stay on track.", "Got it, logged. The rest of the day's rebalanced."], k),
          [{ op: "log", day, slot, dish, calories: cals }], { planChanged: true }); k++;
      }
  }

  // ================================================================= reserve (eating out, future)
  {
    for (const [day, slot, cals] of [["Friday", "dinner", 900], ["Saturday", "lunch", 800], ["Sunday", "dinner", 1000]] as const)
      for (const p of [`i'm eating out ${day} ${slot}`, `reserve about ${cals} for ${day} ${slot}, going out`, `${day} ${slot} is a restaurant, save room`]) {
        push([U(p)], rot([`Future meal out — reserve the calories for ${day} ${slot} and rebalance the day around it.`, `They'll eat out ${day} ${slot}; hold ~${cals} kcal and re-solve the rest.`], k),
          rot([`Done — held room for ${day} ${slot} and adjusted the day.`, `Got it — I've reserved ${day} ${slot} for eating out.`], k),
          [{ op: "reserve", day, slot, calories: cals }], { planChanged: true }); k++;
      }
  }

  // ================================================================= rate / pin / resize
  {
    for (const [day, slot] of [["Monday", "breakfast"], ["Tuesday", "lunch"], ["Wednesday", "dinner"]] as const)
      for (const p of [`loved ${day}'s ${slot}`, `${day} ${slot} was amazing`, `${day}'s ${slot} was incredible`, `5 stars for ${day} ${slot}`]) {
        push([U(p)], rot([`Positive rating on ${day} ${slot} — record it so it recurs.`, `They loved ${day} ${slot}; rate it high to bias future plans.`], k),
          rot(["Glad you liked it — I'll plan it more often.", "Noted — I'll bring that back."], k),
          [{ op: "rate", rating: 5, day, slot }], { profileChanged: true }); k++;
      }
    for (const [day, slot] of [["Thursday", "dinner"], ["Friday", "lunch"]] as const)
      for (const p of [`hated ${day}'s ${slot}`, `${day} ${slot} was gross`, `1 star for ${day} ${slot}`]) {
        push([U(p)], `Negative rating on ${day} ${slot} — record it so it's avoided.`, "Sorry to hear — I'll steer clear of that one.",
          [{ op: "rate", rating: 1, day, slot }], { profileChanged: true }); k++;
      }
    for (const [day, slot] of [["Monday", "breakfast"], ["Wednesday", "lunch"], ["Sunday", "dinner"]] as const)
      for (const p of [`keep ${day} ${slot}`, `always give me ${day}'s ${slot}`, `pin ${day} ${slot}`, `lock in ${day} ${slot}`]) {
        push([U(p)], rot([`Pin ${day} ${slot} so future rebuilds leave it in place.`, `They want ${day} ${slot} kept; lock the slot.`], k),
          rot([`Pinned — ${day} ${slot} stays put.`, `Done — ${day} ${slot} won't change.`], k),
          [{ op: "pin", day, slot }], { profileChanged: true }); k++;
      }
    for (const p of ["i'm still hungry", "make my portions bigger", "not enough food", "i need more on my plate", "bump everything up a bit"]) {
      push([U(p)], rot(["Bigger portions across the board.", "They're hungry — scale portions up."], k), rot(["Bumped your portions up.", "Done — bigger servings now."], k),
        [{ op: "resize", direction: "bigger" }], { planChanged: true }); k++;
    }
    for (const p of ["that's too much food", "smaller portions please", "i'm overeating", "cut my portions down"]) {
      push([U(p)], rot(["Smaller portions across the board.", "They want less food — scale portions down."], k), rot(["Trimmed your portions down.", "Done — smaller servings now."], k),
        [{ op: "resize", direction: "smaller" }], { planChanged: true }); k++;
    }
    for (const p of ["way too much food", "i'm super full, cut it a lot"]) {
      push([U(p)], "Much smaller portions.", "Cut them down a lot.", [{ op: "resize", direction: "much_smaller" }], { planChanged: true }); k++;
    }
    for (const p of ["i'm starving all day, way bigger", "i lift heavy, load me up"]) {
      push([U(p)], "Much bigger portions.", "Loaded you up — much bigger servings.", [{ op: "resize", direction: "much_bigger" }], { planChanged: true }); k++;
    }
  }

  // ================================================================= symptom / report (read-only — advice, no change)
  {
    for (const p of ["i'm always tired", "my nails keep breaking", "i keep getting sick", "i have muscle cramps", "i've been so fatigued lately", "my hair's falling out", "i bruise easily", "i'm dizzy in the afternoons"]) {
      push([U(p)], rot(["A symptom — pass their exact words to the checker; never diagnose, just relate it to their week.", "They describe a symptom; hand it to symptom_check, don't invent a diagnosis."], k),
        rot(["Let me check that against your week.", "I'm not a doctor, but let me see how your plan lines up with that."], k),
        [{ op: "symptom", text: p }]); k++;
    }
    for (const p of ["how am i doing", "am i hitting my protein", "review my week", "am i missing any vitamins", "give me a summary", "how's my week looking", "am i on track"]) {
      push([U(p)], rot(["Weekly review — read-only, just report the numbers.", "They want a status check; run the weekly report, change nothing."], k),
        rot(["Here's how your week looks.", "Let me pull your weekly summary."], k),
        [{ op: "report" }]); k++;
    }
  }

  // ================================================================= explain / substitute / hydration / answer (read-only)
  {
    for (const [day, slot] of [["Monday", "breakfast"], ["Wednesday", "lunch"], ["Friday", "dinner"]] as const)
      for (const p of [`why is ${day} ${slot} what it is`, `explain ${day}'s ${slot}`, `why'd you pick ${day} ${slot}`]) {
        push([U(p)], `They want the reasoning behind ${day} ${slot} — explain it, change nothing.`, `Here's why ${day}'s ${slot} is on your plan.`,
          [{ op: "explain", day, slot }]); k++;
      }
    for (const ing of ["eggs", "butter", "rice", "chicken", "milk"])
      for (const p of [`what can i use instead of ${ing}`, `i'm out of ${ing}, what's a sub`, `swap out the ${ing} for something`]) {
        push([U(p)], `Ingredient substitution question for ${ing} — suggest alternatives, no plan change.`, `Here are a few good swaps for ${ing}.`,
          [{ op: "substitute", ingredient: ing }]); k++;
      }
    for (const p of ["how much water should i drink", "am i drinking enough water", "what's my hydration target", "how much should i hydrate"]) {
      push([U(p)], "Hydration question — compute a target from their profile; read-only.", "Here's a good daily water target for you.",
        [{ op: "hydration" }]); k++;
    }
    for (const p of ["what's a good source of protein", "is oatmeal healthy", "should i eat before a workout", "are eggs good for me", "what's better, rice or quinoa"]) {
      push([U(p)], rot(["General nutrition question — just answer it; no plan or profile change.", "Pure Q&A; reply with advice and emit no changes."], k),
        rot(["Happy to help — here's the short version.", "Good question — here's what I'd suggest."], k),
        [{ op: "answer" }]); k++;
    }
  }

  // ================================================================= CLARIFY (too vague → one question)
  {
    for (const p of ["change it", "can you fix it", "make it better", "adjust it", "do something different", "i don't like it", "switch it up", "redo it"]) {
      push([U(p)], rot(["Too vague to act on — ask ONE focused question, don't guess.", "Ambiguous; a single clarifying question beats a wrong change."], k),
        rot(["Happy to — what should I change: a day, a meal, or a setting?", "Sure — which part: a specific day, one meal, or your overall targets?"], k),
        [], { noChange: true }); k++;
    }
  }

  // ================================================================= DECLINE (unsupported → honest + nearest offer)
  {
    for (const p of ["skip breakfast every day", "i don't eat breakfast, remove it", "no breakfast at all", "delete breakfast"])
      push_i(out, () => k++, [U(p)], "Plans run 3–4 meals; can't drop to 2 yet. Decline honestly and offer the nearest thing.",
        "I can't remove breakfast entirely yet — plans run on 3 or 4 meals a day. Want a light, quick breakfast instead, or those calories moved into lunch and dinner?", [], { noChange: true });
    for (const p of ["cook for me and my girlfriend", "make portions for two people", "i'm cooking for a family of four", "double it for me and my partner"])
      push_i(out, () => k++, [U(p)], "Household scaling isn't built. Decline honestly, suggest a manual workaround.",
        "I build for one person's targets right now — I can't scale to a household yet. You could double the quantities when you cook.", [], { noChange: true });
    for (const p of ["i do 16:8 fasting, no food before noon", "set up intermittent fasting", "no meals until 1pm", "i fast in the mornings"])
      push_i(out, () => k++, [U(p)], "Fasting windows aren't built yet. Decline, offer the closest supported thing.",
        "I can't set a fasting window yet — but I can shift your day to fewer, later meals if that helps. Want that?", [], { noChange: true });
    for (const p of ["plan my whole month", "give me a 30 day plan", "do the next four weeks"])
      push_i(out, () => k++, [U(p)], "Only a single week is supported. Decline honestly.",
        "I plan one week at a time right now — a full month isn't supported yet. I can rebuild this week however you like, though.", [], { noChange: true });
  }

  // ================================================================= REFUSE (internal contradiction)
  {
    for (const p of ["make it vegan but add chicken", "vegan week with beef on friday", "all plant-based except salmon daily", "vegan but i want eggs every morning"])
      push_i(out, () => k++, [U(p)], "Contradiction: vegan excludes all animal products. Don't silently pick one side — surface the clash.",
        "Those clash — vegan means no meat, fish, or eggs. Want a fully vegan week, or a non-vegan week with that added?", [], { noChange: true });
    for (const p of ["keto but high carb", "low carb but lots of rice and pasta", "keto with 300g of carbs"])
      push_i(out, () => k++, [U(p)], "Contradiction: keto is inherently low-carb. Surface it rather than guessing.",
        "That doesn't quite work — keto is low-carb by definition. Do you want keto, or a higher-carb plan? I'll build whichever.", [], { noChange: true });
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
  }

  // ================================================================= COMPOUND (several changes, one constrain)
  {
    const combos: [string[], Record<string, unknown>, string][] = [
      [["cheaper, vegetarian, no mushrooms", "make it budget and veggie without mushrooms", "vegetarian, cheap, and drop the mushrooms"], { budget: "low", diet: "vegetarian", exclude: ["mushrooms"] }, "cheaper, vegetarian, and no mushrooms"],
      [["vegan, italian, and quick", "make it vegan italian and fast", "quick vegan italian week"], { diet: "vegan", cuisine: "italian", maxCookTime: 20 }, "vegan, Italian, and quick"],
      [["keto, no onions, 1800 calories", "keto week, 1800 cals, hold the onions"], { diet: "keto", exclude: ["onions"], targets: { calories: 1800 } }, "keto, no onions, at 1800 a day"],
    ];
    for (const [phrs, body, summary] of combos)
      for (const p of phrs) {
        const exp = (body.diet ? { dietIs: body.diet as Diet, planChanged: true } : { planChanged: true }) as TrainingExample["expect"];
        push([U(p)], "Several changes at once — fold them into a single constrain, don't split into many turns.", `Done — ${summary}.`,
          [{ op: "constrain", ...body }], exp); k++;
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
  }

  return out;
}

// ---- tiny helpers (kept out of the hot path above) --------------------------------------------
// A variant of push that also bumps the shared rotation counter via a passed-in incrementer, used
// where a for-loop body reads cleaner as a single call.
function push_i(
  out: TrainingExample[],
  bump: () => void,
  turns: TrainingExample["turns"],
  thinking: string,
  reply: string,
  operations: unknown[],
  expect?: TrainingExample["expect"],
) {
  out.push({ turns, thinking, reply, operations, expect });
  bump();
}
