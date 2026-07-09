// Generate a diverse SYNTHETIC training set for the tool-calling assistant.
//
//   node scripts/gen-synthetic.mjs [count]
//
// Writes data/synthetic-log.jsonl in the same record shape the app logs
// ({ message, systemPrompt, history, completion }), so prep-finetune.mjs turns it
// into training data alongside the real edit-log.
//
// Covers how people actually talk to an assistant: your examples + compound
// requests, one-word messages, rambling paragraphs, vague/underspecified asks
// (where the model should ask to clarify), chit-chat, typos, and grounded
// questions. Labels are hand-authored (correct), NOT the small model's guesses.

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "data", "synthetic-log.jsonl");
const TARGET = Number(process.argv[2]) || 450;

const rand = (a) => a[Math.floor(Math.random() * a.length)];
const chance = (p) => Math.random() < p;

// ---- a couple of realistic sample plans so questions are grounded ----------
const POOL = {
  breakfast: [
    ["Greek Yogurt & Berry Bowl", 380, 22, 6, 8],
    ["Veggie Omelette", 420, 27, 5, 12],
    ["Avocado & Chickpea Toast", 390, 16, 11, 10],
    ["Overnight Protein Oats", 420, 32, 9, 5],
    ["Spinach & Feta Egg Muffins", 360, 28, 5, 25],
  ],
  lunch: [
    ["Chicken Quinoa Bowl", 560, 42, 11, 20],
    ["Lentil & Roasted Veg Bowl", 520, 26, 18, 30],
    ["Tuna & White Bean Salad", 480, 42, 12, 10],
    ["Turkey & Hummus Wrap", 500, 40, 10, 10],
    ["Shrimp Fried Rice", 560, 32, 9, 20],
  ],
  dinner: [
    ["Baked Salmon & Potatoes", 590, 38, 10, 30],
    ["Turkey Chili", 540, 40, 16, 30],
    ["Chickpea Curry", 520, 20, 16, 25],
    ["Chicken Fajitas", 580, 44, 11, 25],
    ["Beef & Broccoli Bowl", 600, 44, 9, 20],
  ],
};
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function buildPlan() {
  const days = DAYS.map((day) => {
    const meals = ["breakfast", "lunch", "dinner"].map((t) => {
      const [name, calories, proteinGrams, fiberGrams, timeMinutes] = rand(POOL[t]);
      return { name, type: t, calories, proteinGrams, fiberGrams, timeMinutes };
    });
    return { day, meals };
  });
  return { days, weekSummary: "A varied week from the recipe library." };
}

function renderSystemPrompt(profile, plan) {
  const stats = plan.days.map((d) => ({
    day: d.day,
    kcal: d.meals.reduce((s, m) => s + m.calories, 0),
    protein: d.meals.reduce((s, m) => s + m.proteinGrams, 0),
    carbs: d.meals.reduce((s, m) => s + m.carbsGrams, 0),
    fat: d.meals.reduce((s, m) => s + m.fatGrams, 0),
    fiber: d.meals.reduce((s, m) => s + (m.fiberGrams ?? 0), 0),
    meals: d.meals,
  }));
  const n = stats.length || 1;
  const avgKcal = Math.round(stats.reduce((s, d) => s + d.kcal, 0) / n);
  const avgProtein = Math.round(stats.reduce((s, d) => s + d.protein, 0) / n);
  const avgFiber = Math.round(stats.reduce((s, d) => s + d.fiber, 0) / n);
  const planText = stats
    .map((d) => {
      const meals = d.meals
        .map(
          (m) =>
            `${m.type} ${m.name} (${m.calories} kcal, ${m.proteinGrams}g P, ${m.carbsGrams}g C, ${m.fatGrams}g F, ${m.fiberGrams ?? 0}g fiber, ${m.timeMinutes}min)`,
        )
        .join("; ");
      return `${d.day} — day total ${d.kcal} kcal, ${d.protein}g protein, ${d.carbs}g carbs, ${d.fat}g fat, ${d.fiber}g fiber: ${meals}`;
    })
    .join("\n");
  return (
    "You are the meal-plan assistant. Read the user's message and the recent conversation, then output JSON: a natural 'reply' plus a list of 'operations' (tool calls) the app runs in order. Use the conversation to resolve references ('do that', 'only Tuesday', 'make it 1500').\n\n" +
    "TOOLS — each operation has a 'tool' and ONLY the fields that tool actually needs. OMIT every field you are not setting. Never write nulls, and never invent a value for a field the user did not mention.\n" +
    "- update_profile: change a WEEK-WIDE setting and rebuild the week. Fields: diet, budget, excludeFoods, targetCalories, targetProtein, targetCarbs, targetFat, targetFiber, maxCookTime, cuisine. The plan re-solves to hit any macro target you set.\n" +
    "- regenerate_week: rebuild the whole week (optional cuisine, targetFiber, useIngredients — on-hand foods to prefer, boostNutrient).\n" +
    "- boostNutrient (on update_profile / regenerate_week / regenerate_day): favour foods rich in one nutrient — iron, calcium, magnesium, potassium, zinc, vitD, vitC, folate, b12. The app computes the real amounts from USDA data; never state a nutrient number yourself.\n" +
    "- regenerate_day: rebuild ONE day; requires day. Optional diet, targetCalories, cuisine, targetFiber apply to THAT day only (not saved).\n" +
    "- swap_meal: replace one meal with a specific dish; requires day, mealType, dish. By DEFAULT the app keeps that day on the user's macro targets by adjusting the other meals' portions — automatic, you don't ask for it. Set preserveMacros:false ONLY when the user signals a treat ('cheat day', 'treat', 'don't care about macros'). Never compute macros yourself.\n" +
    "- compute_targets: work out the user's calories/protein/carbs/fat from their body and goal, then rebuild the week. Needs age, heightCm, weightKg, sex (male|female), activity (sedentary|light|moderate|active|very_active) and goal (lose_weight|maintain|build_muscle). If any fact is missing, ASK for it (operations: []) — never guess someone's weight. The app does the arithmetic; you never compute.\n" +
    "- log_meal: the user says what they ACTUALLY ate ('I had pizza for lunch'). Requires day + mealType + dish. The app locks that meal and everything earlier that day, then re-solves the meals still ahead. If the food isn't in the library, pass loggedCalories when the user gives a number; otherwise the app asks. Never estimate calories yourself.\n" +
    "- answer: no change; just answering a question.\n\n" +
    "Rules:\n" +
    "- Only a question -> operations: []. Put the answer in reply. For facts use the EXACT numbers below; the AVERAGES line is already per-day.\n" +
    "- Compound requests -> SEVERAL operations, or one update_profile with several fields.\n" +
    "- Use word stems in excludeFoods so 'bake' also matches 'baked'/'baking'.\n" +
    "- Macros are kept on target automatically; only use preserveMacros:false for an explicit treat.\n" +
    "- Emit ONLY the fields you mean. 'make Tuesday vegetarian' is exactly {tool:regenerate_day, day:Tuesday, diet:vegetarian} — nothing else.\n" +
    "- reply: natural and friendly.\n\n" +
    `Weekly AVERAGES per day: ${avgKcal} kcal, ${avgProtein}g protein, ${avgFiber}g fiber.\n` +
    `Current plan:\n${planText}\n\n` +
    `Profile: diet=${profile.diet}, budget=${profile.budget}, ~${profile.targetCalories} kcal/day, dislikes=${profile.dislikes || "none"}.\n`
  );
}

const PROFILE = {
  goal: "maintain",
  diet: "none",
  allergies: "",
  dislikes: "",
  budget: "medium",
  mealsPerDay: 3,
  targetCalories: 2000,
  proteinGrams: 150,
  carbsGrams: 200,
  fatGrams: 65,
  maxCookTime: 30,
  maxIngredients: 8,
};

// Build one operation with all schema fields present.
// Emit ONLY the fields this operation actually sets. Previously every field was written
// (76% of emitted tokens were nulls) and the model leaked memorised values into slots it was
// forced to fill: "make Tuesday vegetarian" came back with diet:null but targetFiber:30 and
// excludeFoods:["bake","roast","oven"]. Omitting unused fields removes the opportunity.
const OP = (o) => {
  const op = { tool: o.tool };
  for (const k of [
    "day", "mealType", "dish", "cuisine", "diet", "budget",
    "targetCalories", "targetProtein", "targetCarbs", "targetFat", "targetFiber",
    "maxCookTime", "boostNutrient", "preserveMacros",
  ]) if (o[k] !== undefined && o[k] !== null) op[k] = o[k];
  if (o.excludeFoods && o.excludeFoods.length) op.excludeFoods = o.excludeFoods;
  if (o.useIngredients && o.useIngredients.length) op.useIngredients = o.useIngredients;
  return op;
};

// ---- vocabulary --------------------------------------------------------------
const FOODS = ["onions", "mushrooms", "cilantro", "olives", "bell peppers", "tomatoes", "eggs", "tofu", "pork", "beef", "shrimp", "coconut", "chickpeas", "feta", "avocado"];
const CUISINES = ["italian", "asian", "mexican", "indian", "mediterranean", "middle eastern", "american"];
const DIETS = ["vegetarian", "vegan", "keto", "mediterranean"];
const MEALS = ["breakfast", "lunch", "dinner"];
const DISHES = ["oatmeal", "pancakes", "grilled salmon", "chicken salad", "an omelette", "a smoothie bowl", "a stir fry", "tacos", "a curry", "avocado toast", "a burrito", "greek yogurt with granola", "a protein shake", "a veggie wrap"];

const examples = [];
const push = (history, reply, operations) =>
  examples.push({ history: history.map((h) => ({ role: h.r, text: h.t })), completion: { reply, operations } });
const u = (t) => ({ r: "user", t });
const a = (t) => ({ r: "assistant", t });

// ---- generators (each pushes several variants) -------------------------------

// budget cheaper / fancier
const cheaper = ["make it cheaper", "this is too expensive", "i'm broke lol", "can you make it more affordable", "keep it budget friendly", "money's tight this week", "cheapest possible pls", "reduce the cost", "im a student, cheap meals only"];
for (const m of cheaper) push([u(m)], "Sure — I've switched to budget-friendly meals and rebuilt your week.", [OP({ tool: "update_profile", budget: "low" })]);
for (const m of ["splurge a little this week", "i got paid, make it fancier", "budget isn't a problem, nicer meals"]) push([u(m)], "Nice — bumped up to fancier options and rebuilt the week.", [OP({ tool: "update_profile", budget: "high" })]);

// diet (week)
const wkDiet = { vegetarian: ["make it vegetarian", "no meat please", "i want a veggie plan", "go vegetarian"], vegan: ["make it vegan", "plant based only", "no animal products"], keto: ["i want keto", "low carb keto plan", "put me on keto"], mediterranean: ["mediterranean diet please", "do a mediterranean week"] };
for (const [d, ms] of Object.entries(wkDiet)) for (const m of ms) push([u(m)], `Done — your whole week is now ${d}.`, [OP({ tool: "update_profile", diet: d })]);

// diet (single day) — the model dropped `diet` here, so cover it harder
for (let i = 0; i < 26; i++) { const day = rand(DAYS); const d = rand(DIETS); push([u(rand([`make ${day} ${d}`, `${day} should be ${d}`, `can ${day} be ${d}`, d === "vegetarian" ? `meatless ${day}` : `${d} ${day}`]))], `Got it — ${day} is now ${d}, the rest of the week is unchanged.`, [OP({ tool: "regenerate_day", day, diet: d })]); }

// exclusions (foods)
for (let i = 0; i < 22; i++) { const f = rand(FOODS); push([u(rand([`no ${f}`, `i hate ${f}`, `i don't like ${f}`, `can you remove ${f}`, `cut the ${f}`, `${f} makes me sick`, `please avoid ${f} this week`, `allergic to ${f}`]))], `No problem — I'll keep ${f} out of your week.`, [OP({ tool: "update_profile", excludeFoods: [f] })]); }

// method exclusion (no oven)
for (const m of ["i don't have an oven", "no oven this week", "nothing that needs baking", "swap out the baked and roasted meals", "my oven is broken, avoid it", "stovetop only, no oven"]) push([u(m)], "Got it — I'll skip anything baked or roasted.", [OP({ tool: "update_profile", excludeFoods: ["bake", "roast", "oven"] })]);

// calorie target (week)
for (let i = 0; i < 12; i++) { const c = rand([1500, 1600, 1800, 2000, 2200, 2500, 3000]); push([u(rand([`${c} calories a day`, `set me to ${c} kcal`, `i want ${c} calories daily`, `cut me to ${c} a day`, `bump calories to ${c}`]))], `Updated your daily target to ${c} kcal and rebuilt the week.`, [OP({ tool: "update_profile", targetCalories: c })]); }
// calorie target (day)
for (let i = 0; i < 8; i++) { const day = rand(DAYS); const c = rand([1200, 1500, 1800, 2500]); push([u(rand([`make ${day} ${c} calories`, `${day} should be lighter, ${c} cals`, `lower ${day} to ${c}`]))], `Done — ${day} is now around ${c} kcal.`, [OP({ tool: "regenerate_day", day, targetCalories: c })]); }

// fiber
for (const m of ["more fiber please", "i want at least 30g fiber a day", "add more fiber", "high fiber plan", "can you get me to 35g fiber daily", "not enough fiber, increase it"]) { const g = /(\d+)/.exec(m)?.[1]; push([u(m)], `Sure — I've prioritized higher-fiber meals${g ? ` to hit about ${g}g a day` : ""}.`, [OP({ tool: "update_profile", targetFiber: g ? Number(g) : 30 })]); }

// protein target (week). The reply states the TARGET SET, never an achieved number — the
// model does no arithmetic and the recipe pool may not reach the target. The engine appends
// what was actually achieved (and admits when it fell short).
for (let i = 0; i < 14; i++) { const g = rand([120, 140, 150, 160, 180, 200, 220]); push([u(rand([`set my protein to ${g}g`, `i want ${g}g protein a day`, `bump protein to ${g}`, `${g} grams of protein daily`, `hit ${g}g protein`, `more protein, like ${g}g`]))], `Done — I've set your protein target to ${g}g a day and rebuilt the week around it.`, [OP({ tool: "update_profile", targetProtein: g })]); }
// vague "more protein" with no number → sensible bump
for (const m of ["i need more protein", "add more protein", "high protein plan please", "protein is too low, raise it"]) push([u(m)], "Sure — I've rebuilt the week around higher-protein meals.", [OP({ tool: "update_profile", targetProtein: 180 })]);
// protein target (single day)
for (let i = 0; i < 6; i++) { const day = rand(DAYS); const g = rand([180, 200, 220]); push([u(rand([`make ${day} high protein`, `${day} needs ${g}g protein`, `more protein on ${day}`]))], `Got it — I've rebuilt ${day} around a higher protein target.`, [OP({ tool: "regenerate_day", day, targetProtein: g })]); }
// carbs / fat targets
for (let i = 0; i < 6; i++) { const g = rand([120, 150, 180, 220]); push([u(rand([`set carbs to ${g}g`, `i want ${g}g carbs a day`, `${g} grams carbs daily`]))], `Done — targeting about ${g}g carbs a day.`, [OP({ tool: "update_profile", targetCarbs: g })]); }
for (let i = 0; i < 6; i++) { const g = rand([50, 60, 70, 80]); push([u(rand([`keep fat around ${g}g`, `${g}g fat a day`, `limit fat to ${g} grams`]))], `Got it — holding fat near ${g}g a day.`, [OP({ tool: "update_profile", targetFat: g })]); }

// cook time
for (const m of ["quick meals only", "nothing over 20 minutes", "i'm busy, 15 min meals max", "keep cooking short", "fast recipes please, 25 min tops"]) { const t = /(\d+)/.exec(m)?.[1]; push([u(m)], `Done — I've kept everything quick${t ? ` (under ~${t} min)` : ""}.`, [OP({ tool: "update_profile", maxCookTime: t ? Number(t) : 20 })]); }

// cuisine (week)
for (const c of CUISINES) for (const m of [`make it ${c}`, `i'm craving ${c} food`, `${c} week please`]) push([u(m)], `Yum — rebuilt your week with ${c} dishes.`, [OP({ tool: "regenerate_week", cuisine: c })]);
// cuisine (day)
for (let i = 0; i < 12; i++) { const day = rand(DAYS); const c = rand(CUISINES); push([u(rand([`make ${day} ${c}`, `${day} should be ${c}`, `give ${day} an ${c} theme`, `i want ${c} on ${day}`]))], `Done — ${day} now has an ${c} theme.`, [OP({ tool: "regenerate_day", day, cuisine: c })]); }

// swap specific dish
for (let i = 0; i < 26; i++) { const day = rand(DAYS); const mt = rand(MEALS); const dish = rand(DISHES); push([u(rand([`swap ${day} ${mt} for ${dish}`, `change ${day}'s ${mt} to ${dish}`, `i want ${dish} for ${mt} on ${day}`, `replace ${day} ${mt} with ${dish}`]))], `Swapped ${day}'s ${mt} for ${dish}.`, [OP({ tool: "swap_meal", day, mealType: mt, dish })]); }

// swap while watching macros. CONTRASTIVE with the cheat-day block below: both mention
// "macros", but here the user wants them KEPT. Emit preserveMacros:true explicitly so the
// model learns the distinction from INTENT, not from the presence of the word "macros".
// (A fine-tune trained without this learned the shortcut `"macros" -> preserveMacros:false`
// and turned preservation OFF for "keep me on my macros". Exactly backwards.)
const LEAN = ["but i'm cutting", "i'm trying to stay lean", "keep me on my macros", "but keep my protein up", "without wrecking my diet", "i'm on a high protein plan", "don't ruin my macros", "stay on my macros", "keep my macros the same", "but i still want to hit my macros"];
for (let i = 0; i < 24; i++) { const day = rand(DAYS); const mt = rand(MEALS); const dish = rand(DISHES); const lean = rand(LEAN); push([u(rand([`i want ${dish} for ${mt} on ${day} ${lean}`, `can i have ${dish} ${day} ${mt}? ${lean}`, `${day} ${mt} ${dish}, ${lean}`, `swap ${day} ${mt} for ${dish}, ${lean}`]))], `Done — ${dish} for ${day} ${mt}, and I balanced the rest of the day so your macros stay on target.`, [OP({ tool: "swap_meal", day, mealType: mt, dish, preserveMacros: true })]); }

// treat / cheat day — user explicitly going off-plan → preserveMacros:false
const TREATS = ["pizza", "a burger", "ice cream", "fried chicken", "mac and cheese", "a big bowl of pasta", "nachos"];
// Note the overlap with LEAN: some of these also say "macros". The signal must be the
// INTENT (cheat / treat / don't care / go off-plan), never the word itself.
const CHEAT = ["it's my cheat day", "treat day today", "i don't care about macros today", "screw the diet today", "cheat meal time", "going off plan today", "forget the diet just this once"];
for (let i = 0; i < 14; i++) { const day = rand(DAYS); const mt = rand(MEALS); const dish = rand(TREATS); const cheat = rand(CHEAT); push([u(rand([`${cheat}, swap ${day} ${mt} for ${dish}`, `${cheat} — give me ${dish} for ${mt} on ${day}`, `${day} ${mt} should be ${dish}, ${cheat}`]))], `You got it — ${dish} for ${day} ${mt}. Enjoy the treat; I left the rest of your day as-is.`, [OP({ tool: "swap_meal", day, mealType: mt, dish, preserveMacros: false })]); }

// nutrient boost — the app computes real USDA amounts, so the reply never states a number.
const NUTRIENTS = [
  ["iron", ["i'm low on iron", "my iron is low", "i need more iron", "doctor said i'm anemic, more iron please", "boost my iron"]],
  ["vitD", ["my vitamin d is low", "i need more vitamin d", "not enough sun, more vitamin d"]],
  ["b12", ["my b12 is low", "i need more b12", "doctor says my b12 is deficient"]],
  ["calcium", ["i need more calcium", "boost calcium for my bones"]],
  ["magnesium", ["i need more magnesium", "more magnesium please"]],
  ["potassium", ["i get leg cramps, more potassium", "boost potassium"]],
  ["folate", ["i need more folate", "boost folate"]],
  ["zinc", ["more zinc please", "i'm low on zinc"]],
  ["vitC", ["i need more vitamin c", "boost vitamin c"]],
];
for (const [key, msgs] of NUTRIENTS)
  for (const m of msgs)
    push([u(m)], `Got it — I've rebuilt your week around foods rich in that nutrient, keeping your macros on target.`, [OP({ tool: "update_profile", boostNutrient: key })]);
// per-day boost
for (let i = 0; i < 6; i++) { const day = rand(DAYS); const key = rand(["iron", "vitD", "b12", "calcium"]); push([u(rand([`make ${day} high in ${key === "vitD" ? "vitamin d" : key === "b12" ? "b12" : key}`, `${day} needs more ${key === "vitD" ? "vitamin d" : key}`]))], `Done — ${day} now favours foods rich in that nutrient.`, [OP({ tool: "regenerate_day", day, boostNutrient: key })]); }

// regenerate week
for (const m of ["give me a whole new plan", "start over", "regenerate everything", "this is boring, redo it", "new week please", "shuffle it up", "i want different meals"]) push([u(m)], "Fresh week coming up — I've rebuilt the whole plan.", [OP({ tool: "regenerate_week" })]);

// log_meal — "I ate a burger for lunch". Real life derails the plan; the plan absorbs it.
const ATE = ["pizza", "a burger", "fried chicken", "nachos", "ice cream", "mac and cheese", "a chicken salad", "oatmeal", "a protein shake"];
for (let i = 0; i < 22; i++) {
  const day = rand(DAYS); const mt = rand(MEALS); const dish = rand(ATE);
  push([u(rand([
    `i ate ${dish} for ${mt} on ${day}`,
    `i had ${dish} for ${mt}`,
    `just ate ${dish}, that was my ${mt}`,
    `${day} ${mt} was ${dish}, i already ate it`,
  ]))], `Logged it — I've re-solved the rest of the day around it.`, [OP({ tool: "log_meal", day, mealType: mt, dish })]);
}
// the user supplies calories for a food we don't know
for (let i = 0; i < 8; i++) {
  const day = rand(DAYS); const mt = rand(MEALS); const cal = rand([450, 600, 750, 900, 1100]);
  push([u(rand([
    `i ate my mum's lasagna for ${mt}, about ${cal} calories`,
    `had a takeaway for ${mt}, roughly ${cal} kcal`,
    `${cal} calorie ${mt} today, some leftovers`,
  ]))], "Logged — I've adjusted the rest of your day.", [OP({ tool: "log_meal", day, mealType: mt, dish: "logged meal", loggedCalories: cal })]);
}
// they ate something we don't know and gave no number -> log it anyway; the app asks
for (const m of ["i ate my nan's stew for dinner", "had something random for lunch"])
  push([u(m)], "Logged it — roughly how many calories was it, so I can balance the rest of your day?", [OP({ tool: "log_meal", day: "Monday", mealType: m.includes("dinner") ? "dinner" : "lunch", dish: "unknown meal" })]);

// weekly_report — "how am I doing?" The engine computes; the model must NOT narrate numbers.
const REVIEW = [
  "how am I doing this week?", "how's my week looking?", "am i hitting my protein?",
  "review my week", "give me a summary of the week", "am i missing any vitamins?",
  "how are my macros overall?", "any nutrients i'm low on?", "is my plan actually healthy?",
  "check my week for me", "am i short on anything?", "whats my weekly average",
  "do i get enough iron?", "am i deficient in anything?", "how's my nutrition overall",
  "score my week", "am i on track?", "break down my week for me",
];
for (const m of REVIEW)
  push([u(m)], rand([
    "Here's how your week is shaping up:",
    "Let me look at the whole week:",
    "Here's the picture across all seven days:",
  ]), [OP({ tool: "weekly_report" })]);

// CONTRAST: a fact about ONE day is already in the prompt -> answer, not a report.
// Without these the model learns "any question about food = weekly_report".
for (const m of ["how many calories is monday?", "what's for dinner on friday?", "how much protein is tuesday's lunch?", "what am i eating thursday?"])
  push([u(m)], "It's in your plan above — happy to change it if you'd like.", []);

// ---------------------------------------------------------------------------
// v4 eval failures, trained out. Each block below exists because the model got a
// specific real case wrong; the comment says which.
// ---------------------------------------------------------------------------

// v4 said swap_meal for "i had a burger for dinner" — it CHANGED the plan when the user was
// telling it what they'd already eaten. The signal is grammatical: past tense = log, imperative
// = swap. Same dish, same day, same slot; only the tense differs.
for (let i = 0; i < 30; i++) {
  const day = rand(DAYS); const mt = rand(MEALS); const dish = rand(TREATS);
  push([u(rand([`i had ${dish} for ${mt}`, `i ate ${dish} for ${mt} on ${day}`, `just had ${dish} for ${mt}`, `${dish} was my ${mt}`, `i already ate ${dish} for ${mt}`]))],
    "Logged it — I've re-solved the rest of the day around it.",
    [OP({ tool: "log_meal", day, mealType: mt, dish })]);
  push([u(rand([`give me ${dish} for ${mt} on ${day}`, `swap ${day} ${mt} for ${dish}`, `i want ${dish} for ${mt} on ${day}`, `put ${dish} on ${day} ${mt}`]))],
    `Done — ${dish} for ${day} ${mt}, and I balanced the rest of the day.`,
    [OP({ tool: "swap_meal", day, mealType: mt, dish })]);
}

// v4 read "i ate pizza for lunch on monday" as mealType:dinner. The slot and the day are stated
// in the sentence; copy them, never guess. Cover every day x every slot.
for (const day of DAYS) for (const mt of MEALS) {
  const dish = rand(ATE);
  push([u(rand([`i ate ${dish} for ${mt} on ${day}`, `on ${day} i had ${dish} for ${mt}`, `${day}'s ${mt} was ${dish}, i already ate it`]))],
    "Logged — I've adjusted the rest of that day.",
    [OP({ tool: "log_meal", day, mealType: mt, dish })]);
}

// v4 emitted dish:"a takeaway with about 900 kcal of calories" and preserveMacros:false on a
// log_meal. The dish is a SHORT name; the number goes in loggedCalories; log_meal never carries
// preserveMacros.
for (let i = 0; i < 14; i++) {
  const day = rand(DAYS); const mt = rand(MEALS); const cal = rand([420, 550, 680, 900, 1100, 1250]);
  const food = rand(["takeaway", "leftovers", "lasagna", "a sandwich", "a wrap", "a curry", "a kebab"]);
  push([u(rand([`had ${food} for ${mt}, roughly ${cal} kcal`, `i ate ${food} for ${mt}, about ${cal} calories`, `${cal} calorie ${mt}, it was ${food}`]))],
    "Logged — I've adjusted the rest of your day.",
    [OP({ tool: "log_meal", day, mealType: mt, dish: food, loggedCalories: cal })]);
}

// v4 dropped preserveMacros:false on "it's my cheat day, swap saturday dinner for pizza".
// More phrasings, and the cheat signal arriving in an EARLIER turn (the model must carry intent
// across the conversation, not pattern-match one sentence).
const CHEAT2 = ["it's my cheat day", "cheat day", "treat day today", "i don't care about macros today", "screw the diet today", "cheat meal time", "going off plan today", "forget the diet just this once", "i'm having a blowout today", "no macros today, i want to enjoy myself", "today doesn't count", "i'm treating myself"];
for (let i = 0; i < 26; i++) {
  const day = rand(DAYS); const mt = rand(MEALS); const dish = rand(TREATS); const cheat = rand(CHEAT2);
  push([u(rand([`${cheat}, swap ${day} ${mt} for ${dish}`, `${cheat} — give me ${dish} for ${mt} on ${day}`, `${day} ${mt} should be ${dish}, ${cheat}`, `swap ${day} ${mt} for ${dish}. ${cheat}`]))],
    `You got it — ${dish} for ${day} ${mt}. Enjoy the treat; I left the rest of your day as-is.`,
    [OP({ tool: "swap_meal", day, mealType: mt, dish, preserveMacros: false })]);
}
for (let i = 0; i < 10; i++) {
  const day = rand(DAYS); const mt = rand(MEALS); const dish = rand(TREATS);
  push([u(rand(CHEAT2)), a("Sounds good — what would you like?"), u(`swap ${day} ${mt} for ${dish}`)],
    `Enjoy — ${dish} for ${day} ${mt}, rest of the day untouched.`,
    [OP({ tool: "swap_meal", day, mealType: mt, dish, preserveMacros: false })]);
}

// v4 answered a bare "1500" by editing the plan. A number with no unit and no scope is
// ambiguous — ask. Same for "what should my macros be" (that needs their body stats).
for (const m of ["1500", "2000", "180", "1800?", "make it 1500", "2200"])
  push([u(m)], "Just to be sure — is that calories per day for the whole week, or for one day? And which day?", []);
for (const m of ["what should my macros be", "what should my calories be", "how many calories do i need", "how much protein should i eat", "what's my ideal calorie intake"])
  push([u(m)], "I can work that out — tell me your age, height, weight, sex, roughly how active you are, and whether you want to lose fat, maintain, or build muscle.", []);

// compute_targets: the model collects FACTS, the engine does the arithmetic and states the
// numbers. The reply never contains a calorie figure the model made up.
const ACT = [
  ["desk job, no exercise", "sedentary"], ["i barely move", "sedentary"],
  ["i walk a bit, gym once a week", "light"], ["light exercise", "light"],
  ["i train 3 times a week", "moderate"], ["gym 4x a week", "moderate"], ["i train 4 times a week", "moderate"],
  ["i train 6 days a week", "active"], ["gym almost every day", "active"],
  ["i'm a builder and i lift twice a day", "very_active"],
];
const GOALW = [["lose fat", "lose_weight"], ["cut", "lose_weight"], ["lose weight", "lose_weight"],
  ["maintain", "maintain"], ["stay the same", "maintain"],
  ["build muscle", "build_muscle"], ["bulk", "build_muscle"], ["gain muscle", "build_muscle"]];
for (let i = 0; i < 26; i++) {
  const age = rand([21, 24, 27, 30, 33, 38, 42, 47, 55]);
  const h = rand([158, 163, 168, 172, 178, 183, 188]);
  const w = rand([52, 58, 64, 70, 75, 80, 88, 95]);
  const sex = rand(["male", "female"]);
  const [actWord, activity] = rand(ACT);
  const [goalWord, goal] = rand(GOALW);
  push(
    [u(rand([
      `i'm ${age}, ${h}cm, ${w}kg, ${sex}, ${actWord}, i want to ${goalWord}`,
      `work out my macros: ${age} years old, ${h} cm, ${w} kg, ${sex}, ${actWord}, goal is to ${goalWord}`,
      `can you set my calories? ${sex}, ${age}, ${w}kg, ${h}cm, ${actWord}, trying to ${goalWord}`,
    ]))],
    "Done — I've worked out your targets and rebuilt the week around them.",
    [OP({ tool: "compute_targets", age, heightCm: h, weightKg: w, sex, activity, goal })],
  );
}
// missing facts -> ASK. Never guess someone's body.
for (const m of [
  "work out my calories", "what should my macros be", "set my targets for me",
  "how many calories should i eat", "calculate my tdee", "i want to lose fat, what calories?",
  "i'm 80kg, what should i eat", "i'm 30 and male, set my macros",
]) push([u(m)], "Happy to work that out — tell me your age, height, weight, sex, roughly how active you are, and whether you want to lose fat, maintain, or build muscle.", []);

// AMBIGUOUS -> ask, never guess. The evaluated model failed exactly these: it "fixed"
// "make it better" by silently changing the diet, and read a bare "1500" as a day's calories.
// Guessing is worse than asking: it edits the user's week on a coin flip.
const VAGUE = [
  ["make it better", "Happy to — what would 'better' look like? More protein, cheaper, quicker to cook, or more variety?"],
  ["change it", "Sure — what should I change? The whole week, one day, or a single meal?"],
  ["fix it", "What's wrong with it? Too expensive, too repetitive, too many calories, or something else?"],
  ["improve my plan", "Of course — what matters most to you: protein, cost, cooking time, or variety?"],
  ["1500", "Do you mean 1500 calories a day for the whole week, or just for one day?"],
  ["2000?", "Would you like me to set your daily target to 2000 calories?"],
  ["more", "More of what — protein, fiber, variety, or calories?"],
  ["less", "Less of what — calories, carbs, cost, or cooking time?"],
  ["i don't like it", "Sorry! Is it the meals themselves, the cost, the cooking time, or the macros?"],
  ["do something", "Tell me what you'd like changed and I'll do it — meals, macros, budget, or cooking time?"],
  ["make monday different", "Sure — different how? A new set of meals, a different cuisine, or different macros?"],
  ["it's too much", "Too much of what — calories, cooking time, or cost?"],
];
for (const [m, reply] of VAGUE) push([u(m)], reply, []);

// More clarify coverage. Only ~12% of examples had empty operations vs 444 that act, so the
// model's prior was overwhelmingly "do something", and it kept acting on "make it better".
const VAGUE_MORE = [
  ["make it better pls", "Happy to — better how? More protein, cheaper, quicker, or more variety?"],
  ["can you make it better", "Sure — what should I optimise for: protein, cost, cooking time, or variety?"],
  ["improve it", "What would you like improved — the macros, the cost, the cooking time, or the meals themselves?"],
  ["optimize my plan", "Optimise for what? Protein, calories, budget, or time in the kitchen?"],
  ["make this good", "Tell me what 'good' means for you — higher protein, lower cost, faster meals?"],
  ["adjust it", "Sure — adjust what? The whole week, one day, or one meal?"],
  ["update the plan", "Of course — what should I update: diet, macros, budget, or cooking time?"],
  ["redo", "Redo the whole week, or just one day?"],
  ["switch it up", "Happy to — the whole week, or a particular day?"],
  ["idk", "No problem — want me to change the meals, the macros, the budget, or the cook time?"],
  ["whatever you think", "I can rebuild the week, or tune protein/cost/time. Which would help most?"],
  ["something's off", "What feels off — the calories, the protein, the cost, or the meals themselves?"],
  ["too many calories", "Would you like me to lower your daily calorie target? If so, to what?"],
  ["not enough food", "Should I raise your daily calorie target? What would you like it set to?"],
  ["help", "Sure — I can change your diet, macros, budget, cook time, or swap individual meals. What do you need?"],
  ["hmm", "Something you'd like changed? I can adjust meals, macros, budget or cooking time."],
];
for (const [m, reply] of VAGUE_MORE) push([u(m)], reply, []);

// A bare number is ambiguous: calories? protein? fiber? minutes? Ask, never guess.
for (const n of [1200, 1500, 1800, 2000, 2200, 2500, 3000])
  push([u(String(n))], `Do you mean ${n} calories a day? And for the whole week, or just one day?`, []);
for (const n of [120, 140, 150, 180, 200])
  push([u(String(n))], `Is that ${n}g of protein a day, or ${n === 200 ? "something else" : `${n} calories`}? Let me know and I'll set it.`, []);
for (const n of [15, 20, 25, 30, 35])
  push([u(String(n))], `Do you mean ${n} minutes of cooking time, or ${n}g of fiber a day?`, []);

// "use what's in my fridge" — bias selection toward on-hand ingredients
const FRIDGE = ["chicken", "salmon", "rice", "broccoli", "eggs", "sweet potato", "spinach", "chickpeas", "tofu", "ground turkey", "black beans", "quinoa"];
for (let i = 0; i < 18; i++) {
  const a = rand(FRIDGE); let b = rand(FRIDGE); if (b === a) b = rand(FRIDGE);
  const items = [a, b];
  push([u(rand([`i have ${a} and ${b} to use up`, `use the ${a} and ${b} in my fridge`, `build the week around ${a} and ${b}`, `i've got ${a} and ${b}, plan around that`, `${a} and ${b} need using, work them in`]))], `Nice — I've built the week around your ${a} and ${b}.`, [OP({ tool: "regenerate_week", useIngredients: items })]);
}
for (let i = 0; i < 6; i++) { const day = rand(DAYS); const a = rand(FRIDGE); push([u(rand([`use my ${a} on ${day}`, `${day} should use up the ${a} i have`]))], `Done — ${day} now uses your ${a}.`, [OP({ tool: "regenerate_day", day, useIngredients: [a] })]); }

// regenerate one day
for (let i = 0; i < 8; i++) { const day = rand(DAYS); push([u(rand([`redo ${day}`, `i don't like ${day}, change it`, `give me different meals for ${day}`, `${day} again please`]))], `Done — ${day} has fresh meals.`, [OP({ tool: "regenerate_day", day })]); }

// GROUNDED questions (computed per plan at emit time via placeholders)
const QMETRICS = [
  { ask: ["what's my average fiber", "how much fiber do i get a day", "average fiber?", "am i getting enough fiber"], kind: "avgFiber" },
  { ask: ["how much protein do i average", "what's my daily protein", "average protein per day?"], kind: "avgProtein" },
  { ask: ["how many calories a day", "what's my average calories", "daily calorie average?"], kind: "avgKcal" },
];
// day/meal questions
const QDAY = ["how many calories on {day}", "what's for dinner on {day}", "how much protein on {day}", "what's {day} look like", "how long does {day} lunch take"];

// chit-chat / no-op
// Keep these SHORT. A long, enumerating reply taught the model to ramble and it began
// dropping the "operations" key entirely on "thanks!" — a schema break caused by verbosity.
for (const m of ["hey", "hi", "hello", "thanks!", "thank you", "this looks great", "cool", "ok", "nice", "awesome", "you're helpful", "sounds good", "perfect", "ty", "great job", "cheers", "no worries", "thx", "appreciate it", "lovely"]) push([u(m)], rand(["Anytime — just say what you'd like changed.", "Glad it helps! Tell me if you want anything tweaked.", "You're welcome. Anything you'd like adjusted?", "Happy to help."]), []);
push([u("what can you do")], "I can rebuild your week, swap meals, change your diet, budget, calories, fiber or cook time, avoid foods you dislike, set cuisine themes, and answer questions about your plan. What would you like?", []);
push([u("who are you")], "I'm your meal-plan assistant — tell me anything to change about your week and I'll do it.", []);

// vague / underspecified -> ask to clarify (no ops)
for (const m of ["make it better", "change something", "i don't like this", "hmm", "not sure", "idk", "do something", "fix it", "this isn't right", "meh"]) push([u(m)], rand(["Happy to help — what would you like changed? Cheaper, a different diet, quicker meals, swap a specific meal…?", "Sure — tell me what to adjust: budget, calories, a certain day, or a specific meal?", "What should I change — the whole week, one day, or a single meal?"]), []);
// ambiguous number
push([u("make it 1500")], "Do you mean 1500 calories per day for the whole week, or just one day?", []);
push([u("only tuesday")], "Got it — what should I change about Tuesday?", []);

// compound (multi-field or multi-op)
push([u("make it cheaper and vegetarian and no onions")], "Done — your week is now vegetarian, budget-friendly, and onion-free.", [OP({ tool: "update_profile", budget: "low", diet: "vegetarian", excludeFoods: ["onions"] })]);
push([u("high protein but quick, nothing over 20 min")], "Rebuilt with quick, protein-forward meals under 20 minutes.", [OP({ tool: "update_profile", maxCookTime: 20 })]);
push([u("vegan and at least 30g fiber a day")], "Done — a vegan week averaging 30g+ fiber a day.", [OP({ tool: "update_profile", diet: "vegan", targetFiber: 30 })]);
push([u("make monday asian and wednesday italian")], "Done — Monday's now Asian and Wednesday's Italian.", [OP({ tool: "regenerate_day", day: "Monday", cuisine: "asian" }), OP({ tool: "regenerate_day", day: "Wednesday", cuisine: "italian" })]);
push([u("no dairy, no nuts, and keep it under 1800 calories")], "Done — dairy- and nut-free, capped around 1800 kcal a day.", [OP({ tool: "update_profile", excludeFoods: ["dairy", "nuts"], targetCalories: 1800 })]);

// long rambly
push([u("So I've got a super busy week — work is insane and I'm training for a half marathon, so I really don't have time to cook, like 15-20 minutes tops, and I'm trying to keep costs down because rent just went up. Can you sort that out?")], "Absolutely — quick meals (~20 min) and a budget-friendly week, sorted.", [OP({ tool: "update_profile", maxCookTime: 20, budget: "low" })]);
push([u("honestly I've been feeling kinda sluggish lately and I read that fiber helps, so I'd like way more fiber, and also I've gone off red meat recently so maybe cut the beef and pork if you can")], "Got it — more fiber and no red meat this week.", [OP({ tool: "update_profile", targetFiber: 30, excludeFoods: ["beef", "pork"] })]);
push([u("my partner is coming over Friday and they're vegetarian so can you make just Friday veggie, everything else can stay the same")], "Done — Friday is vegetarian, the rest of your week is unchanged.", [OP({ tool: "regenerate_day", day: "Friday", diet: "vegetarian" })]);

// multi-turn context (references)
push([u("i think tuesday has too many calories"), a("Tuesday is on the higher side. Want me to lower it?"), u("yeah do 1500")], "Done — Tuesday is now around 1500 kcal.", [OP({ tool: "regenerate_day", day: "Tuesday", targetCalories: 1500 })]);
push([u("can you make it cheaper"), a("Sure, I can switch to budget-friendly meals. Want me to?"), u("yes please")], "Done — I've made your week budget-friendly.", [OP({ tool: "update_profile", budget: "low" })]);
push([u("i'm thinking of going vegan"), a("I can make your whole week vegan whenever you like."), u("do it")], "Done — your week is now vegan.", [OP({ tool: "update_profile", diet: "vegan" })]);

// typos / casual
push([u("mak it vegitarian pls")], "Done — your week is now vegetarian.", [OP({ tool: "update_profile", diet: "vegetarian" })]);
push([u("no mushroms they r gross")], "Ha, understood — no mushrooms.", [OP({ tool: "update_profile", excludeFoods: ["mushrooms"] })]);
push([u("swp sundy dinner 4 salmon")], "Swapped Sunday's dinner for grilled salmon.", [OP({ tool: "swap_meal", day: "Sunday", mealType: "dinner", dish: "grilled salmon" })]);

// ---- assemble records --------------------------------------------------------
const records = [];
function emit(ex) {
  const plan = buildPlan();
  const sys = renderSystemPrompt(PROFILE, plan);
  // ground metric questions against this plan
  let comp = ex.completion;
  if (ex.metric) {
    const n = plan.days.length;
    const avg = {
      avgFiber: Math.round(plan.days.reduce((s, d) => s + d.meals.reduce((x, m) => x + m.fiberGrams, 0), 0) / n),
      avgProtein: Math.round(plan.days.reduce((s, d) => s + d.meals.reduce((x, m) => x + m.proteinGrams, 0), 0) / n),
      avgKcal: Math.round(plan.days.reduce((s, d) => s + d.meals.reduce((x, m) => x + m.calories, 0), 0) / n),
    }[ex.metric];
    const unit = ex.metric === "avgKcal" ? "kcal" : "g";
    const label = ex.metric === "avgFiber" ? "fiber" : ex.metric === "avgProtein" ? "protein" : "calories";
    comp = { reply: `You average about ${avg}${unit === "kcal" ? " kcal" : "g"} of ${label} per day.`, operations: [] };
  }
  const lastUser = [...ex.history].reverse().find((h) => h.role === "user")?.text ?? "";
  records.push({
    message: lastUser,
    systemPrompt: sys,
    history: ex.history,
    completion: comp,
  });
}

// metric questions become examples grounded per-plan
for (const q of QMETRICS) for (const ask of q.ask) examples.push({ history: [{ role: "user", text: ask }], completion: null, metric: q.kind });
// day questions -> answered from the plan
for (let i = 0; i < 10; i++) {
  const day = rand(DAYS);
  examples.push({ history: [{ role: "user", text: QDAY[i % QDAY.length].replaceAll("{day}", day) }], completion: null, dayQ: day });
}

// Expand to TARGET by repeating generator variety (fresh plans/phrasing each time).
// NEVER slice below examples.length: a plain slice(0, TARGET) silently deleted whole
// categories once the hand-written tail (clarify, compound, multi-turn) grew past the cap,
// and the model quietly lost the ability to ask a question instead of guessing.
let pool = [...examples];
while (pool.length < TARGET) pool = pool.concat(examples);
pool = pool.slice(0, Math.max(TARGET, examples.length));
if (examples.length > TARGET) console.warn(`note: ${examples.length} base examples exceeds TARGET ${TARGET}; keeping all of them.`);

for (const ex of pool) {
  if (ex.dayQ) {
    const plan = buildPlan();
    const d = plan.days.find((x) => x.day === ex.dayQ);
    const kcal = d.meals.reduce((s, m) => s + m.calories, 0);
    const dinner = d.meals.find((m) => m.type === "dinner");
    const protein = d.meals.reduce((s, m) => s + m.proteinGrams, 0);
    const q = ex.history[0].text;
    let reply;
    if (/dinner/.test(q)) reply = `${ex.dayQ}'s dinner is ${dinner.name}.`;
    else if (/protein/.test(q)) reply = `${ex.dayQ} has ${protein}g of protein.`;
    else if (/how long|take/.test(q)) reply = `${ex.dayQ}'s lunch takes about ${d.meals.find((m) => m.type === "lunch").timeMinutes} minutes.`;
    else if (/calorie|calories/.test(q)) reply = `${ex.dayQ} totals ${kcal} kcal.`;
    else reply = `On ${ex.dayQ}: ${d.meals.map((m) => m.name).join(", ")}.`;
    records.push({ message: q, systemPrompt: renderSystemPrompt(PROFILE, plan), history: [{ role: "user", text: q }], completion: { reply, operations: [] } });
  } else if (ex.metric) {
    emit(ex);
  } else {
    // normalize history roles to {role,text}
    const hist = ex.history.map((h) => ({ role: h.role, text: h.text }));
    const plan = buildPlan();
    records.push({ message: [...hist].reverse().find((h) => h.role === "user").text, systemPrompt: renderSystemPrompt(PROFILE, plan), history: hist, completion: ex.completion });
  }
}

if (!existsSync(dirname(OUT))) mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
console.log(`Wrote ${records.length} synthetic examples -> ${OUT}`);
const tools = {};
for (const r of records) {
  const t = r.completion.operations[0]?.tool ?? "answer";
  tools[t] = (tools[t] ?? 0) + 1;
}
console.log("by tool:", tools);
