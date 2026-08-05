/**
 * The v2 conversation generator. Produces realistic training examples across the whole intent
 * taxonomy — every one carrying a reasoning trace, and every one meant to survive the engine
 * validator (validateExample). Volume comes from phrasing variety here; correctness comes from the
 * validator downstream. This is the seed set the fine-tune learns the primitives + reason-then-act
 * + the four honest outcomes from. Only intents the engine actually supports are generated (no
 * per-slot targeting or bare undo yet — those become honest declines or are added when built).
 */
import type { UserProfile } from "./types";
import type { TrainingExample } from "./dataValidate";

type Diet = UserProfile["diet"];
const U = (text: string) => ({ role: "user" as const, text });
const A = (text: string) => ({ role: "assistant" as const, text });

export function generateExamples(): TrainingExample[] {
  const out: TrainingExample[] = [];
  const push = (
    turns: TrainingExample["turns"],
    thinking: string,
    reply: string,
    operations: unknown[],
    expect?: TrainingExample["expect"],
  ) => out.push({ turns, thinking, reply, operations, expect });

  // ---- constrain: diet (week) ----
  const diets: Diet[] = ["vegetarian", "vegan", "keto", "mediterranean"];
  for (const d of diets)
    for (const p of [`go ${d}`, `make my week ${d}`, `i want to eat ${d}`, `switch me to ${d}`, `${d} please`, `can you make everything ${d}`])
      push([U(p)], `Whole-week diet change to ${d}.`, `Done — your week is ${d} now.`, [{ op: "constrain", diet: d }], { dietIs: d, planChanged: true });

  // ---- constrain: budget ----
  for (const p of ["make it cheaper", "tighter budget please", "i'm broke this week", "budget meals only", "keep it low cost"])
    push([U(p)], "Cheaper week.", "Done — I've switched to budget-friendly meals.", [{ op: "constrain", budget: "low" }], { profileChanged: true });
  for (const p of ["splurge a bit this week", "fancier meals", "money's no object", "treat me to nicer food"])
    push([U(p)], "Pricier week.", "Nice — bumped up to fancier options.", [{ op: "constrain", budget: "high" }], { profileChanged: true });

  // ---- constrain: exclude ----
  for (const f of ["onions", "mushrooms", "cilantro", "olives", "tomatoes", "peppers", "eggplant"])
    for (const p of [`no ${f}`, `i hate ${f}`, `keep ${f} out`, `remove ${f}`, `i can't stand ${f}`, `please avoid ${f}`])
      push([U(p)], `Exclude ${f} week-wide.`, `No problem — I'll keep ${f} out of your week.`, [{ op: "constrain", exclude: [f] }], { profileChanged: true });

  // ---- constrain: calories / protein / fiber ----
  for (const c of [1500, 1800, 2000, 2200, 2500])
    for (const p of [`${c} calories a day`, `set me to ${c} kcal`, `i want ${c} a day`, `cut me to ${c} daily`])
      push([U(p)], `Set daily calories to ${c}.`, `Updated your daily target to ${c} kcal.`, [{ op: "constrain", targets: { calories: c } }], { planChanged: true });
  for (const g of [140, 160, 180, 200, 220])
    for (const p of [`${g}g protein a day`, `bump protein to ${g}`, `i need ${g} grams of protein`, `hit ${g}g protein daily`])
      push([U(p)], `Protein target ${g}g.`, `Done — protein target set to ${g}g a day.`, [{ op: "constrain", targets: { protein: g } }], { planChanged: true });
  for (const g of [25, 30, 35])
    for (const p of [`${g}g fiber a day`, `more fiber, like ${g}g`, `get me to ${g} grams of fiber`])
      push([U(p)], `Fiber target ${g}g.`, `Sure — prioritizing higher-fiber meals.`, [{ op: "constrain", targets: { fiber: g } }], { planChanged: true });

  // ---- constrain: cuisine (week) ----
  for (const c of ["italian", "asian", "mexican", "indian", "mediterranean"])
    for (const p of [`make it ${c}`, `i'm craving ${c}`, `${c} week please`, `give me ${c} food`])
      push([U(p)], `${c} themed week.`, `Yum — rebuilt your week with ${c} dishes.`, [{ op: "constrain", cuisine: c }], { planChanged: true });

  // ---- constrain: mealsPerDay ----
  for (const p of ["i want 4 meals a day", "add a daily snack", "give me four meals", "i prefer 4 meals"])
    push([U(p)], "Four meals a day.", "Done — four meals a day now, with a snack.", [{ op: "constrain", mealsPerDay: 4 }], { planChanged: true });

  // ---- constrain: no oven / quick (week-wide) ----
  for (const p of ["i don't have an oven", "no baking this week", "stovetop only", "my oven's broken"])
    push([U(p)], "No oven — exclude baked/roasted.", "Got it — nothing baked or roasted.", [{ op: "constrain", exclude: ["bake", "roast", "oven"] }], { profileChanged: true });
  for (const p of ["quick meals only", "nothing over 20 minutes", "i'm busy, fast recipes", "keep cooking short"])
    push([U(p)], "Quick meals week-wide.", "Done — everything's quick now.", [{ op: "constrain", maxCookTime: 20 }], { profileChanged: true });

  // ---- constrain: single day + day range + weekend ----
  for (const day of ["Tuesday", "Friday", "Sunday"])
    for (const p of [`make ${day} vegetarian`, `just ${day} veggie`, `${day} should be vegetarian`])
      push([U(p)], `${day} vegetarian, temporary (not saved).`, `Got it — ${day}'s vegetarian, the rest unchanged.`, [{ op: "constrain", scope: { days: [day] }, diet: "vegetarian" }], { planChanged: true });
  for (const p of ["vegetarian monday through wednesday", "mon to wed veggie", "make monday tuesday wednesday vegetarian"])
    push([U(p)], "Day range Mon–Wed vegetarian.", "Done — Monday through Wednesday are vegetarian.", [{ op: "constrain", scope: { days: ["Monday", "Tuesday", "Wednesday"] }, diet: "vegetarian" }], { planChanged: true });
  for (const p of ["lighter on the weekend", "smaller meals saturday and sunday", "cut weekend calories"])
    push([U(p)], "Weekend = Sat+Sun, fewer calories.", "Sure — lighter Saturday and Sunday.", [{ op: "constrain", scope: { days: ["Saturday", "Sunday"] }, targets: { calories: 1600 } }], { planChanged: true });

  // ---- constrain: boostNutrient (+ keep a diet) ----
  const nutrients: [string, string][] = [["iron", "iron"], ["vitD", "vitamin d"], ["b12", "b12"], ["calcium", "calcium"], ["magnesium", "magnesium"]];
  for (const [n, w] of nutrients)
    for (const p of [`i'm low on ${w}`, `i need more ${w}`, `my doctor said my ${w} is low`])
      push([U(p)], `Boost ${n}; engine computes the amounts.`, `Done — rebuilt your week around foods rich in that nutrient.`, [{ op: "constrain", boostNutrient: n }], { planChanged: true });
  push([U("my iron's low but keep me vegetarian")], "Boost iron AND hold vegetarian together.", "Done — more iron-rich foods, still vegetarian.", [{ op: "constrain", boostNutrient: "iron", diet: "vegetarian" }], { dietIs: "vegetarian" });

  // ---- remember ----
  const facts: [string, string, string][] = [
    ["lactose intolerant", "allergy", "lactose"], ["allergic to peanuts", "allergy", "peanuts"],
    ["i hate cilantro", "preference", "cilantro"], ["training for a marathon", "goal", "marathon"],
    ["i have ibs", "condition", "ibs"], ["i'm pescatarian", "preference", "pescatarian"],
  ];
  for (const [f, k, key] of facts)
    for (const p of [f, `just so you know, ${f}`, `fyi ${f}`, `remember that ${f}`])
      push([U(p)], `Durable ${k} to store and apply.`, `Noted — I'll keep that in mind from now on.`, [{ op: "remember", fact: f, kind: k }], { remembers: key, profileChanged: true });

  // ---- swap: whole week + single day ----
  for (const [dish, p] of [["pancakes", "pancakes for breakfast every day"], ["oatmeal", "i want oatmeal every morning"], ["pancakes", "give me pancakes daily for breakfast"]])
    push([U(p)], `Whole-week breakfast swap to ${dish}.`, `Done — ${dish} for breakfast every day.`, [{ op: "swap", dish, slot: "breakfast" }], { planChanged: true });
  for (const p of ["swap monday breakfast for pancakes", "change monday's breakfast to pancakes", "i want pancakes monday breakfast"])
    push([U(p)], "Single-day breakfast swap.", "Swapped Monday's breakfast for pancakes.", [{ op: "swap", dish: "pancakes", slot: "breakfast", days: ["Monday"] }], { planChanged: true });

  // ---- log (past-tense eaten) ----
  for (const p of ["i ate pizza for lunch", "had a burger for lunch today", "i already ate mcdonalds for lunch"])
    push([U(p)], "Past-tense meal — log it, re-solve the day.", "Logged — I've adjusted the rest of today to stay on track.", [{ op: "log", day: "Monday", slot: "lunch", dish: "pizza", calories: 900 }], { planChanged: true });

  // ---- rate / pin / resize ----
  for (const p of ["loved monday's breakfast", "monday breakfast was amazing", "monday's breakfast was incredible"])
    push([U(p)], "Positive rating.", "Glad you liked it — I'll plan it more often.", [{ op: "rate", rating: 5, day: "Monday", slot: "breakfast" }], { profileChanged: true });
  for (const p of ["keep monday breakfast", "always give me monday's breakfast", "pin monday breakfast"])
    push([U(p)], "Pin the slot.", "Pinned — Monday breakfast stays put.", [{ op: "pin", day: "Monday", slot: "breakfast" }], { profileChanged: true });
  for (const p of ["i'm still hungry", "make my portions bigger", "not enough food"])
    push([U(p)], "Bigger portions.", "Bumped your portions up.", [{ op: "resize", direction: "bigger" }], { planChanged: true });
  for (const p of ["that's too much food", "smaller portions please", "i'm overeating"])
    push([U(p)], "Smaller portions.", "Trimmed your portions down.", [{ op: "resize", direction: "smaller" }], { planChanged: true });

  // ---- symptom / report (read-only) ----
  for (const p of ["i'm always tired", "my nails keep breaking", "i keep getting sick", "i have muscle cramps"])
    push([U(p)], "A symptom — pass their words; never diagnose.", "Let me check that against your week.", [{ op: "symptom", text: p }]);
  for (const p of ["how am i doing", "am i hitting my protein", "review my week", "am i missing any vitamins"])
    push([U(p)], "Weekly review, read-only.", "Here's how your week looks.", [{ op: "report" }]);

  // ---- CLARIFY ----
  for (const p of ["change it", "can you fix it", "make it better", "adjust it"])
    push([U(p)], "Too vague — ask one question.", "Happy to — what should I change: a day, a meal, or a setting?", [], { noChange: true });

  // ---- DECLINE (unsupported → honest) ----
  for (const p of ["skip breakfast every day", "i don't eat breakfast, remove it", "no breakfast at all"])
    push([U(p)], "Plans run 3–4 meals; can't drop to 2 yet. Decline + offer nearest.", "I can't remove breakfast entirely yet — plans run on 3 or 4 meals a day. Want a light, quick breakfast instead, or those calories moved into lunch and dinner?", [], { noChange: true });
  for (const p of ["cook for me and my girlfriend", "make portions for two people", "i'm cooking for a family of four"])
    push([U(p)], "Household scaling isn't built. Decline honestly.", "I build for one person's targets right now — I can't scale to a household yet. You could double the quantities when you cook.", [], { noChange: true });
  for (const p of ["i do 16:8 fasting, no food before noon", "set up intermittent fasting", "no meals until 1pm"])
    push([U(p)], "Fasting windows aren't built yet. Decline + offer.", "I can't set a fasting window yet — but I can shift your day to fewer, later meals if that helps. Want that?", [], { noChange: true });

  // ---- REFUSE (contradiction) ----
  for (const p of ["make it vegan but add chicken", "vegan week with beef on friday", "all plant-based except salmon daily"])
    push([U(p)], "Contradiction: vegan excludes meat/fish.", "Those clash — vegan means no meat or fish. Want a fully vegan week, or a non-vegan week with that added?", [], { noChange: true });

  // ---- MULTI-TURN correction (the pancakes bug) ----
  push([U("i want pancakes for breakfast every day"), A("Done — pancakes for Monday breakfast."), U("no i said EVERY day")],
    "They're correcting me — apply to all days, not just Monday.", "You're right — pancakes every day now.", [{ op: "swap", dish: "pancakes", slot: "breakfast" }], { planChanged: true });

  // ---- COMPOUND ----
  for (const p of ["cheaper, vegetarian, no mushrooms", "make it budget and veggie without mushrooms", "vegetarian, cheap, and drop the mushrooms"])
    push([U(p)], "Three changes at once — one constrain.", "Done — cheaper, vegetarian, and no mushrooms.", [{ op: "constrain", budget: "low", diet: "vegetarian", exclude: ["mushrooms"] }], { dietIs: "vegetarian", planChanged: true });

  // ---- RAMBLING multi-intent + remember ----
  push([U("ugh so stressed, i went vegetarian recently, and i really hate mushrooms, can you make my meals quick i work late")],
    "Feelings + a diet change + an exclusion + quick meals. Remember the stress; the rest are real edits.",
    "Got it — vegetarian, no mushrooms, and quick meals. Hope things calm down soon.",
    [{ op: "remember", fact: "feeling stressed lately", kind: "context" }, { op: "constrain", diet: "vegetarian", exclude: ["mushrooms"], maxCookTime: 20 }],
    { dietIs: "vegetarian" });

  return out;
}
