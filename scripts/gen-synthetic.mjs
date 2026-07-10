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

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "data", "synthetic-log.jsonl");
const TARGET = Number(process.argv[2]) || 450;

const rand = (a) => a[Math.floor(Math.random() * a.length)];
const chance = (p) => Math.random() < p;
// DISHES are written as noun phrases ("a curry", "an omelette") because most templates read
// "give me a curry on Tuesday". Templates that supply their own article need the bare name.
const bare = (dish) => dish.replace(/^(an?|the) /, "");

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
    "TOOLS — each operation has a 'tool' plus its fields. Every tool below lists what it REQUIRES: a call without those fields does nothing and wastes the user's turn. Beyond the required ones, OMIT every field you are not setting. Never write nulls, and never invent a value for a field the user did not mention.\n" +
    "REQUIRED FIELDS: compute_targets needs age+heightCm+weightKg+sex+activity+goal. swap_meal needs day+dish. log_meal, eating_out, explain_meal, lock_meal and unlock_meal need day+mealType. substitute_ingredient needs ingredient. symptom_check needs symptom. regenerate_day needs day. rate_meal needs rating, plus dish or day+mealType. hydration needs nothing unless the user states a weight or activity. scale_portions needs portionChange. undo takes no fields and must be alone. If the user gave a number (calories they ate, calories they expect to eat), it goes in loggedCalories or estimatedCalories — never inside the dish name.\n" +
    "- update_profile: change a WEEK-WIDE setting and rebuild the week. Fields: diet, budget, excludeFoods, targetCalories, targetProtein, targetCarbs, targetFat, targetFiber, maxCookTime, cuisine. The plan re-solves to hit any macro target you set.\n" +
    "- regenerate_week: rebuild the whole week (optional cuisine, targetFiber, useIngredients — on-hand foods to prefer, boostNutrient).\n" +
    "- boostNutrient (on update_profile / regenerate_week / regenerate_day): favour foods rich in one nutrient — iron, calcium, magnesium, potassium, zinc, vitD, vitC, folate, b12. The app computes the real amounts from USDA data; never state a nutrient number yourself.\n" +
    "- regenerate_day: rebuild ONE day; requires day. Optional diet, targetCalories, cuisine, targetFiber apply to THAT day only (not saved).\n" +
    "- swap_meal: replace one meal with a specific dish; requires day, mealType, dish. By DEFAULT the app keeps that day on the user's macro targets by adjusting the other meals' portions — automatic, you don't ask for it. Set preserveMacros:false ONLY when the user signals a treat ('cheat day', 'treat', 'don't care about macros'). Never compute macros yourself.\n" +
    "- compute_targets: work out the user's calories/protein/carbs/fat from their body and goal, then rebuild the week. Needs age, heightCm, weightKg, sex (male|female), activity (sedentary|light|moderate|active|very_active) and goal (lose_weight|maintain|build_muscle). If any fact is missing, ASK for it (operations: []) — never guess someone's weight. The app does the arithmetic; you never compute.\n" +
    "- log_meal: the user says what they ACTUALLY ate ('I had pizza for lunch'). Requires day + mealType + dish. The app locks that meal and everything earlier that day, then re-solves the meals still ahead. If the food isn't in the library, pass loggedCalories when the user gives a number; otherwise the app asks. Never estimate calories yourself.\n" +
    "- explain_meal: the user asks WHY a meal is in their plan. Requires day + mealType. Changes nothing; the app computes the reasons.\n" +
    "- substitute_ingredient: the user has run out of an ingredient ('i don't have greek yogurt'). Requires ingredient. Changes nothing; the app checks diet/allergies and computes the macro cost.\n" +
    "- symptom_check: the user reports how they FEEL ('i'm always tired', 'muscle cramps'). Pass their words in `symptom`. Changes nothing. Never map a symptom to a nutrient or diagnose — the app does it.\n" +
    "- lock_meal: the user wants a meal to stay put ('never change my sunday roast'). Requires day + mealType. The app puts it back on every rebuild.\n" +
    "- unlock_meal: undo a pin. Requires day + mealType.\n" +
    "- rate_meal: what the user THOUGHT of a dish ('that salmon was incredible', 'the tofu was awful, never again'). Requires rating (1-5) plus either dish, or day + mealType. hated/never again = 1, didn't like = 2, ok/fine = 3, liked = 4, loved = 5. Contrast with 'i don't like mushrooms' (an ingredient, forever -> update_profile) and log_meal (what they ATE).\n" +
    "- hydration: the user asks about water or fluid ('how much water should i drink?'). Changes nothing. Pass weightKg / activity only if the message gives them. The app computes the litres; never state a figure yourself.\n" +
    "- scale_portions: the user wants MORE or LESS food, not different food ('i'm still hungry', 'too much food'). Requires portionChange: much_smaller | smaller | bigger | much_bigger. day / mealType only if named; no day means the whole week. Never pass a number.\n" +
    "- undo: reverse the last change ('undo that', 'actually put it back', 'revert that'). No fields, and it must be the ONLY operation in the turn.\n" +
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
// Every field in OperationSchema. This list was stale for months: it never learned about
// compute_targets' body stats, log_meal's calories, eating_out's estimate, substitute_ingredient's
// ingredient or symptom_check's symptom — so those fields were SILENTLY DROPPED from every label
// we ever trained on. The model emitted {"tool":"compute_targets"} with an empty body because that
// is exactly what we taught it. check-data now fails when a required field is missing, and this
// list is the thing that must not go stale again.
const OP = (o) => {
  const op = { tool: o.tool };
  for (const k of [
    "day", "mealType", "dish", "cuisine", "diet", "budget",
    "targetCalories", "targetProtein", "targetCarbs", "targetFat", "targetFiber",
    "maxCookTime", "boostNutrient", "preserveMacros",
    "age", "heightCm", "weightKg", "sex", "activity", "goal",
    "loggedCalories", "loggedProtein", "estimatedCalories", "ingredient", "symptom", "rating",
    "portionChange",
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

// eating_out — FUTURE meal, unknown contents. The tense is the whole signal: "i'm going out for
// dinner friday" (eating_out) vs "i went out for dinner" / "i had pizza" (log_meal). Minimal pairs.
// No venue may contain a meal word. "a work dinner" crossed with a random slot produced
// "Friday breakfast is at a work dinner" — an incoherent sentence teaching the model that the meal
// word in the sentence is unreliable. check-data.mjs now fails on any such example.
const VENUES = ["a restaurant", "an italian place", "a sushi place", "my parents'", "a work do", "a birthday party", "the pub", "a steakhouse", "a burger place"];
for (let i = 0; i < 26; i++) {
  const day = rand(DAYS); const mt = rand(MEALS); const v = rand(VENUES);
  push([u(rand([
    `i'm going out for ${mt} on ${day}`,
    `i'm eating at ${v} on ${day} for ${mt}`,
    `${day} ${mt} is at ${v}`,
    `i have a ${mt} out on ${day}`,
    `we're going to ${v} for ${mt} on ${day}`,
  ]))], `Noted — I've set calories aside for ${day} ${mt} and lightened the rest of that day.`,
    [OP({ tool: "eating_out", day, mealType: mt })]);
  // same venue, PAST tense -> log_meal
  push([u(rand([`i went out for ${mt} on ${day}`, `${day} ${mt} was at ${v}, i already ate`, `i ate out for ${mt} on ${day}`]))],
    "Logged it — I've re-solved the rest of that day.",
    [OP({ tool: "log_meal", day, mealType: mt, dish: "meal out" })]);
}
// they offer a number -> estimatedCalories
for (let i = 0; i < 10; i++) {
  const day = rand(DAYS); const mt = rand(MEALS); const cal = rand([600, 800, 1000, 1200, 1500]);
  push([u(rand([
    `i'm out for ${mt} on ${day}, probably around ${cal} calories`,
    `${day} ${mt} out, budget ${cal} kcal for it`,
    `restaurant ${mt} ${day}, reckon ${cal} calories`,
  ]))], `Done — ${cal} kcal set aside for ${day} ${mt}, rest of the day adjusted.`,
    [OP({ tool: "eating_out", day, mealType: mt, estimatedCalories: cal })]);
}
// missing slot -> ask
for (const m of ["i'm eating out this week", "i've got a dinner thing coming up", "we're going to a restaurant"])
  push([u(m)], "Which day, and which meal? I'll set calories aside and lighten the rest of that day.", []);

// explain_meal — "why is this here?" Read-only justification.
for (let i = 0; i < 18; i++) {
  const day = rand(DAYS); const mt = rand(MEALS);
  push([u(rand([
    `why did you give me ${day}'s ${mt}?`,
    `why is that my ${mt} on ${day}?`,
    `what's ${day} ${mt} doing in my plan`,
    `explain ${day}'s ${mt}`,
    `why that ${mt} on ${day}?`,
    `justify ${day} ${mt} for me`,
  ]))], "Here's why it's there:", [OP({ tool: "explain_meal", day, mealType: mt })]);
}
for (const m of ["why is that there?", "why did you pick that", "explain that meal"])
  push([u(m)], "Happy to — which day, and which meal?", []);

// substitute_ingredient — "i've run out of X". Read-only advice, checked against diet + allergies.
const RANOUT = ["greek yogurt", "chicken breast", "quinoa", "eggs", "olive oil", "spinach", "feta", "black beans", "peanut butter", "brown rice", "tofu", "salmon", "cottage cheese", "almonds", "sweet potato"];
for (let i = 0; i < 22; i++) {
  const ing = rand(RANOUT);
  push([u(rand([
    `i don't have ${ing}`,
    `i'm out of ${ing}`,
    `no ${ing} in the house, what can i use?`,
    `can i use something instead of ${ing}?`,
    `what can i swap ${ing} for?`,
    `ran out of ${ing}`,
  ]))], "Here's what I'd use instead:", [OP({ tool: "substitute_ingredient", ingredient: ing })]);
}
// with a meal named
for (let i = 0; i < 6; i++) {
  const ing = rand(RANOUT); const day = rand(DAYS); const mt = rand(MEALS);
  push([u(`i don't have ${ing} for ${day}'s ${mt}`)], "Here's what I'd use instead:",
    [OP({ tool: "substitute_ingredient", ingredient: ing, day, mealType: mt })]);
}
// CONTRAST: "i don't like X" is a permanent preference -> update_profile, not a substitution.
for (const ing of ["mushrooms", "olives", "cilantro", "onions"])
  push([u(rand([`i don't like ${ing}`, `i hate ${ing}`, `no ${ing} please`])), ], `Noted — no more ${ing}.`,
    [OP({ tool: "update_profile", excludeFoods: [ing] })]);

// symptom_check — the model passes the words through; the ENGINE decides everything.
const SYMPTOM_MSGS = [
  "i'm always tired", "i've got no energy lately", "i feel exhausted all the time",
  "my nails keep breaking", "my hair is thinning", "i keep getting muscle cramps",
  "i get pins and needles in my feet", "i keep getting sick", "i catch every cold going",
  "i've been feeling really down", "i can't sleep properly", "my bones ache",
  "i look really pale", "i bruise easily", "i've got brain fog",
  "i'm knackered all the time", "cuts take ages to heal", "i've been getting cramp at night",
];
for (const m of SYMPTOM_MSGS)
  push([u(m)], "Let me look at that against what you're eating:", [OP({ tool: "symptom_check", symptom: m })]);

// Urgent + crisis wording still routes to the tool: the ENGINE holds the safe response, not the
// model. A 1.5B must not be the thing that decides how to answer "i have chest pain".
for (const m of ["i have chest pain", "i've been coughing blood", "i keep fainting", "i feel suicidal"])
  push([u(m)], "", [OP({ tool: "symptom_check", symptom: m })]);

// ---------------------------------------------------------------------------
// TOOL-BOUNDARY CONTRASTS. Nine tools now, and the new ones sit close together. Each pair below
// differs by one word or one tense, and routes somewhere different. Without these a 1.5B collapses
// neighbouring intents into whichever tool it saw most.
// ---------------------------------------------------------------------------

// a KNOWN deficiency (they've had bloodwork) -> boost it. a SYMPTOM -> check it, don't assume.
for (const [msg, ops] of [
  ["my bloods came back low in iron", [OP({ tool: "update_profile", boostNutrient: "iron" })]],
  ["the doctor said my b12 is deficient", [OP({ tool: "update_profile", boostNutrient: "b12" })]],
  ["my vitamin d came back low", [OP({ tool: "update_profile", boostNutrient: "vitD" })]],
  ["i'm always tired", [OP({ tool: "symptom_check", symptom: "i'm always tired" })]],
  ["i think i might be low on iron, i'm exhausted", [OP({ tool: "symptom_check", symptom: "i think i might be low on iron, i'm exhausted" })]],
  ["i feel run down", [OP({ tool: "symptom_check", symptom: "i feel run down" })]],
])
  push([u(msg)], ops[0].tool === "symptom_check" ? "Let me check that against what you're eating:" : "Done — I've rebuilt your week around it.", ops);

// a question about the WEEK's nutrients -> weekly_report. a question about ONE meal -> explain_meal.
for (const [msg, ops] of [
  ["am i low on anything?", [OP({ tool: "weekly_report" })]],
  ["am i getting enough iron?", [OP({ tool: "weekly_report" })]],
  ["how's my week looking?", [OP({ tool: "weekly_report" })]],
])
  push([u(msg)], "Here's the picture across the week:", ops);
for (let i = 0; i < 6; i++) {
  const day = rand(DAYS); const mt = rand(MEALS);
  push([u(`why is ${day}'s ${mt} in my plan?`)], "Here's why:", [OP({ tool: "explain_meal", day, mealType: mt })]);
  // ...but a plain lookup is already in the prompt: just answer it.
  push([u(`what's my ${mt} on ${day}?`)], "It's in your plan above.", []);
}

// FUTURE meal out vs PAST meal eaten vs a REQUEST to change the plan. Same dish, three tools.
for (let i = 0; i < 8; i++) {
  const day = rand(DAYS); const mt = rand(MEALS);
  push([u(`i'm having ${mt} out on ${day}`)], `Noted — I've set calories aside for ${day}.`, [OP({ tool: "eating_out", day, mealType: mt })]);
  push([u(`i had ${mt} out on ${day}`)], "Logged it — the rest of that day is re-solved.", [OP({ tool: "log_meal", day, mealType: mt, dish: "meal out" })]);
  push([u(`give me something different for ${mt} on ${day}`)], `Done — ${day}'s ${mt} is new.`, [OP({ tool: "regenerate_day", day })]);
}

// out of an ingredient -> substitute. dislikes it -> exclude it forever. allergic -> exclude it forever.
for (const ing of ["feta", "quinoa", "spinach", "olive oil"]) {
  push([u(`i've run out of ${ing}`)], "Here's what I'd use instead:", [OP({ tool: "substitute_ingredient", ingredient: ing })]);
  push([u(`i can't stand ${ing}`)], `Noted — no more ${ing}.`, [OP({ tool: "update_profile", excludeFoods: [ing] })]);
}

// ---------------------------------------------------------------------------
// v5 eval failures. Each block is here because the model got a specific case wrong.
// ---------------------------------------------------------------------------

// v5 emitted activity:"desk_job" — not a value in the enum. The enum is fixed; map every way a
// person describes their week onto it.
const ACTIVITY = [
  ["sedentary", ["desk job", "office job, no exercise", "i sit all day", "i don't exercise", "no exercise at all", "mostly sedentary", "i barely move", "desk job and no gym"]],
  ["light", ["i walk a bit", "light exercise once a week", "i walk the dog daily", "i'm on my feet a bit", "gym once a week"]],
  ["moderate", ["i train 3 times a week", "gym 3x a week", "i run a couple of times a week", "moderately active"]],
  ["active", ["i train 4 times a week", "gym 5 days a week", "i lift 4x a week", "i'm quite active", "i run most days"]],
  ["very_active", ["i train twice a day", "i'm an athlete", "manual job and i train daily", "i train 6 days a week"]],
];
for (const [value, phrases] of ACTIVITY)
  for (const phrase of phrases) {
    const age = rand([22, 27, 30, 35, 41, 48]);
    const h = rand([160, 165, 172, 178, 183]);
    const w = rand([55, 62, 70, 78, 85, 95]);
    const sex = rand(["male", "female"]);
    const goal = rand(["lose_weight", "maintain", "build_muscle"]);
    const goalText = goal === "lose_weight" ? "i want to lose fat" : goal === "build_muscle" ? "i want to build muscle" : "i want to maintain";
    push([u(`i'm ${age}, ${h}cm, ${w}kg, ${sex}, ${phrase}, ${goalText}`)],
      "I've worked out your targets and rebuilt the week around them.",
      [OP({ tool: "compute_targets", age, heightCm: h, weightKg: w, sex, activity: value, goal })]);
  }

// v5 put the calories INSIDE the dish name: dish:"a takeaway with about 900 calories in it".
// The dish is a short name. The number goes in loggedCalories. Always.
const OUTFOOD = ["takeaway", "leftovers", "a curry", "a sandwich", "my mum's lasagna", "a kebab", "a burrito", "street food", "a pastry"];
for (let i = 0; i < 20; i++) {
  const day = rand(DAYS); const mt = rand(MEALS); const cal = rand([380, 450, 600, 750, 900, 1100, 1300]);
  const food = rand(OUTFOOD);
  push([u(rand([
    `had ${food} for ${mt}, roughly ${cal} kcal`,
    `had ${food} for ${mt}, roughly ${cal} calories`,
    `i ate ${food} for ${mt}, about ${cal} calories`,
    `${mt} was ${food}, maybe ${cal} kcal`,
    `${food} for ${mt}, i reckon ${cal} calories`,
  ]))], "Logged — I've adjusted the rest of your day.",
    [OP({ tool: "log_meal", day, mealType: mt, dish: food, loggedCalories: cal })]);
}

// v5 read a bare "1500" as a day's calorie target and rebuilt Tuesday. A number with no unit and
// no scope is ambiguous, full stop.
for (const n of ["1500", "1800", "2000", "2200", "2500", "180", "120", "90", "3000"])
  push([u(n)], "What's that — calories a day, grams of protein, something else? And for the whole week or one day?", []);
for (const m of ["make it 1500", "set it to 2000", "change it to 1800"])
  push([u(m)], "Happy to — calories per day for the whole week, or just one day?", []);
// ...but WITH a unit and a scope it is not ambiguous, and the model must still act.
for (let i = 0; i < 8; i++) {
  const c = rand([1500, 1800, 2000, 2200, 2500]);
  push([u(rand([`${c} calories a day`, `set my daily calories to ${c}`, `i want ${c} kcal per day`])),],
    `Updated your daily target to ${c} kcal.`, [OP({ tool: "update_profile", targetCalories: c })]);
}

// v5 invented a tool called "swap_ingredient". The name is `substitute_ingredient` and nothing
// else. More surface area on the phrasings that trigger it.
for (const m of ["i don't have any greek yogurt", "we're out of chicken breast, what can i use?",
  "no feta in the shop, alternatives?", "what's a good replacement for quinoa?",
  "i haven't got any spinach", "can i use something else instead of salmon?",
  "the shop had no tofu", "i'm out of eggs", "no olive oil left", "what else works instead of rice?"]) {
  const ing = ["greek yogurt", "chicken breast", "feta", "quinoa", "spinach", "salmon", "tofu", "eggs", "olive oil", "rice"][
    ["i don't have any greek yogurt", "we're out of chicken breast, what can i use?", "no feta in the shop, alternatives?",
     "what's a good replacement for quinoa?", "i haven't got any spinach", "can i use something else instead of salmon?",
     "the shop had no tofu", "i'm out of eggs", "no olive oil left", "what else works instead of rice?"].indexOf(m)
  ];
  push([u(m)], "Here's what I'd use instead:", [OP({ tool: "substitute_ingredient", ingredient: ing })]);
}

// lock_meal / unlock_meal — "never change my sunday roast". Pinning is a standing instruction, so
// it must be told apart from a one-off swap ("give me the roast on sunday") and from a dislike.
for (let i = 0; i < 20; i++) {
  const day = rand(DAYS); const mt = rand(MEALS);
  push([u(rand([
    `never change my ${day} ${mt}`,
    `keep ${day}'s ${mt} the same every week`,
    `pin ${day} ${mt}`,
    `always give me the same ${mt} on ${day}`,
    `don't touch ${day} ${mt}`,
    `i want to keep ${day}'s ${mt}`,
    `lock in ${day} ${mt}`,
  ]))], `Pinned — I'll build the rest of the week around it.`, [OP({ tool: "lock_meal", day, mealType: mt })]);
  push([u(rand([
    `you can change ${day} ${mt} again`,
    `unpin ${day} ${mt}`,
    `stop keeping ${day}'s ${mt}`,
    `${day} ${mt} doesn't need to stay the same`,
  ]))], `Unpinned — ${day}'s ${mt} is free to change.`, [OP({ tool: "unlock_meal", day, mealType: mt })]);
}
// CONTRAST: a one-off request for a dish is a swap, not a standing pin.
for (let i = 0; i < 8; i++) {
  const day = rand(DAYS); const mt = rand(MEALS); const dish = rand(DISHES);
  push([u(`give me ${dish} for ${mt} on ${day}`)], `Done — ${dish} on ${day}.`, [OP({ tool: "swap_meal", day, mealType: mt, dish })]);
  push([u(`i always want ${dish} for ${mt} on ${day}`)], `Done, and pinned so it stays.`,
    [OP({ tool: "swap_meal", day, mealType: mt, dish }), OP({ tool: "lock_meal", day, mealType: mt })]);
}
for (const m of ["never change it", "pin that one", "keep that meal"])
  push([u(m)], "Happy to — which day, and which meal?", []);

// rate_meal — what the user THOUGHT of a dish, not what they ate and not an ingredient they
// dislike. Three neighbours it must be told apart from, all generated above:
//   "i had the salmon for dinner"      -> log_meal            (what they ate)
//   "i don't like mushrooms"           -> update_profile      (an ingredient, forever)
//   "never change my sunday dinner"    -> lock_meal           (a standing instruction)
const RATE_WORDS = [
  { r: 5, says: ["was incredible", "was amazing", "was the best thing all week", "was outstanding"] },
  { r: 4, says: ["was really good", "was lovely", "was tasty", "i liked it a lot"] },
  { r: 3, says: ["was ok", "was fine", "was alright", "was nothing special"] },
  { r: 2, says: ["wasn't great", "was pretty bland", "i didn't really enjoy it", "was disappointing"] },
  { r: 1, says: ["was awful", "was horrible, never again", "i hated it", "was inedible"] },
];
for (let i = 0; i < 26; i++) {
  const day = rand(DAYS); const mt = rand(MEALS);
  const { r, says } = rand(RATE_WORDS);
  const say = rand(says);
  // By slot...
  push([u(rand([
    `${day}'s ${mt} ${say}`,
    `that ${mt} on ${day} ${say}`,
    `the ${mt} you gave me on ${day} ${say}`,
  ]))], `Noted — I'll remember that.`, [OP({ tool: "rate_meal", day, mealType: mt, rating: r })]);
  // ...and by dish name, with no slot at all. DISHES carry articles ("a curry", "an omelette"),
  // so strip them: "the a curry was lovely" is not a sentence, and the label has to be a name the
  // engine can match against a recipe, not a noun phrase.
  const dish = bare(rand(DISHES));
  push([u(rand([
    `the ${dish} ${say}`,
    `that ${dish} ${say}`,
    `honestly, the ${dish} ${say}`,
  ]))], `Noted — I'll remember that.`, [OP({ tool: "rate_meal", dish, rating: r })]);
}
// Explicit star ratings, the other way people say it.
for (let i = 0; i < 10; i++) {
  const day = rand(DAYS); const mt = rand(MEALS); const r = 1 + Math.floor(Math.random() * 5);
  push([u(rand([
    `${day} ${mt}: ${r}/5`,
    `i'd give ${day}'s ${mt} ${r} out of 5`,
    `${r} stars for ${day} ${mt}`,
  ]))], `Noted — I'll remember that.`, [OP({ tool: "rate_meal", day, mealType: mt, rating: r })]);
}
// CONTRAST: an opinion needs a rating AND a subject. "that was great" alone is neither.
for (const m of ["that was great", "loved it", "that was rank", "didn't like that one"])
  push([u(m)], "Glad to know — which meal was it, and how would you rate it out of 5?", []);
// CONTRAST: disliking an INGREDIENT is a permanent exclusion; disliking a DISH is a rating.
// The pair is the point — the two sentences differ only in what the complaint is aimed at.
for (const [food, dish] of [["mushrooms", "mushroom risotto"], ["olives", "greek salad"],
                            ["cilantro", "chicken curry"], ["feta", "veggie wrap"]]) {
  push([u(`i don't like ${food}`)], `Noted — I'll keep ${food} out of your plan.`,
    [OP({ tool: "update_profile", excludeFoods: [food.replace(/s$/, "")] })]);
  push([u(`${dish} was awful, don't make it again`)], "Noted — I'll remember that.",
    [OP({ tool: "rate_meal", dish, rating: 1 })]);
}

// ---------------------------------------------------------------------------------------------
// MINIMAL PAIRS. v7 answered "breakfast" to "i ate pizza for lunch on monday" because it had
// memorized "i ate pizza for breakfast on Monday" and stopped reading at the dish and the day.
// The cure is not more examples, it is examples that differ ONLY in the field under test.
// ---------------------------------------------------------------------------------------------
for (let i = 0; i < 10; i++) {
  const day = rand(DAYS); const dish = rand(DISHES);
  // Same dish, same day, all three slots. The meal word is the ONLY thing that varies.
  for (const mt of MEALS)
    push([u(`i ate ${dish} for ${mt} on ${day}`)], "Logged it — I've re-solved the rest of that day.",
      [OP({ tool: "log_meal", day, mealType: mt, dish })]);
}
// eating_out: with and without a calorie estimate, in the phrasings v7 mishandled — no "on"
// before the day, no "around" before the number.
for (let i = 0; i < 14; i++) {
  const day = rand(DAYS); const mt = rand(MEALS);
  const n = rand([500, 600, 700, 800, 900, 1000, 1200]);
  push([u(rand([
    `i'm out for ${mt} ${day}, probably ${n} calories`,
    `i'm out for ${mt} ${day}, maybe ${n} calories`,
    `${day} ${mt} out, probably ${n} kcal`,
    `eating out ${day} ${mt}, i reckon ${n} calories`,
  ]))], `Noted — I've set ${n} kcal aside and lightened the rest of that day.`,
    [OP({ tool: "eating_out", day, mealType: mt, estimatedCalories: n })]);
  // The same sentence WITHOUT a number must not invent one.
  push([u(rand([`i'm out for ${mt} ${day}`, `${day} ${mt} out`, `eating out ${day} ${mt}`]))],
    `Noted — I've set calories aside for ${day} ${mt} and lightened the rest of that day.`,
    [OP({ tool: "eating_out", day, mealType: mt })]);
}
// undo — reverse the last change. No fields, and always alone: "undo and make it vegan" is two
// intents and the app can only step back one. The model recognises the ask; the engine holds the
// snapshot, so the model never has to know WHAT the last change was.
for (const m of [
  "undo", "undo that", "undo the last change", "actually put it back", "revert that",
  "no, change it back", "never mind, undo it", "go back", "that was worse, undo",
  "can you undo that", "put it back how it was", "scrap that, back to before",
])
  push([u(m)], "Done — I've put it back to how it was.", [OP({ tool: "undo" })]);
// In context: a change, the user dislikes it, they ask to reverse it.
for (let i = 0; i < 6; i++) {
  const day = rand(DAYS);
  push([
    u(`make ${day} vegan`),
    a(`Done — ${day} is vegan now.`),
    u(rand(["actually undo that", "no, put it back", "revert", "changed my mind, undo"])),
  ], "Done — I've put it back to how it was.", [OP({ tool: "undo" })]);
}
// CONTRAST: "change it TO X" is a new instruction, not an undo.
for (const [m, d] of [["actually make it vegetarian instead", "vegetarian"], ["no, make the week italian", null]])
  push([u(m)], "Sure — done.", [OP(d ? { tool: "update_profile", diet: d } : { tool: "regenerate_week", cuisine: "italian" })]);

// scale_portions — MORE food or LESS food, never different food. The model picks a direction; the
// engine picks the factor, clamps the portion, and checks it against the calorie floor. Emitting a
// number here would be the model doing arithmetic, which it must never do.
const HUNGRY = ["i'm still hungry", "these portions are tiny", "i'm starving on this", "there isn't enough food"];
const STUFFED = ["that's way too much food", "i can't finish these portions", "the servings are huge", "it's too much"];
for (let i = 0; i < 6; i++) {
  const day = rand(DAYS); const mt = rand(MEALS);
  push([u(`${rand(HUNGRY)} on ${day}`)], "Done — bigger portions that day.",
    [OP({ tool: "scale_portions", day, portionChange: "bigger" })]);
  push([u(`${rand(STUFFED)} on ${day}`)], "Done — smaller portions that day.",
    [OP({ tool: "scale_portions", day, portionChange: "smaller" })]);
  push([u(rand([`make ${day}'s portions bigger`, `bigger servings on ${day}`, `more food on ${day}`]))],
    "Done — bigger portions that day.", [OP({ tool: "scale_portions", day, portionChange: "bigger" })]);
  push([u(rand([`${day}'s ${mt} is too big`, `smaller ${mt} on ${day}`, `cut down ${day}'s ${mt}`]))],
    "Done — smaller portion there.", [OP({ tool: "scale_portions", day, mealType: mt, portionChange: "smaller" })]);
  push([u(rand([`${day}'s ${mt} is nowhere near enough`, `bigger ${mt} on ${day}`, `i need more at ${mt} on ${day}`]))],
    "Done — bigger portion there.", [OP({ tool: "scale_portions", day, mealType: mt, portionChange: "bigger" })]);
}
// No day named -> the whole week. And the extremes map to much_bigger / much_smaller.
for (const m of ["i'm still hungry", "these portions are tiny", "there isn't enough food", "i need bigger portions", "everything's too small"])
  push([u(m)], "Done — bigger portions all week.", [OP({ tool: "scale_portions", portionChange: "bigger" })]);
for (const m of ["that's way too much food", "the servings are huge", "i can't finish any of it", "smaller portions please", "it's all too much"])
  push([u(m)], "Done — smaller portions all week.", [OP({ tool: "scale_portions", portionChange: "smaller" })]);
for (const m of ["i'm absolutely starving on this", "these portions are nowhere near enough", "way way too little food"])
  push([u(m)], "Done — much bigger portions.", [OP({ tool: "scale_portions", portionChange: "much_bigger" })]);
for (const m of ["this is way way too much food", "i'm stuffed after every single meal", "the portions are enormous"])
  push([u(m)], "Done — much smaller portions.", [OP({ tool: "scale_portions", portionChange: "much_smaller" })]);
// CONTRAST: a permanent change to how much you SHOULD eat is a target, not a portion.
for (const [m, kc] of [["set my calories to 2500", 2500], ["i should be eating 1800 a day", 1800]])
  push([u(m)], "Updated — I've rebuilt the week around that.", [OP({ tool: "update_profile", targetCalories: kc })]);
// CONTRAST: "more food" is not "different food".
for (const m of ["i don't want this dinner", "give me something else on friday"])
  push([u(m)], "Sure — what would you like instead?", []);

// hydration — a question about water, never about food. The app knows the user's weight if they
// ever worked out their targets, so the DEFAULT call carries no fields at all. The model's only
// job is to notice a weight or an activity level when the sentence happens to contain one.
for (const m of [
  "how much water should i drink", "am i drinking enough water", "what's my water target",
  "how much should i be drinking a day", "how many litres of water do i need",
  "do i drink enough", "what about hydration", "how much fluid a day",
  "should i be drinking more water", "water intake?",
])
  push([u(m)], "Let me work that out from your weight.", [OP({ tool: "hydration" })]);
for (let i = 0; i < 8; i++) {
  const w = rand([55, 60, 65, 70, 75, 80, 85, 90, 95, 100]);
  push([u(rand([
    `i'm ${w}kg, how much water should i drink`,
    `how much water for a ${w}kg person`,
    `i weigh ${w} kg — what's my water target`,
  ]))], "Let me work that out.", [OP({ tool: "hydration", weightKg: w })]);
}
const ACT_WORDS = {
  sedentary: "at a desk all day", light: "training twice a week", moderate: "training 4 times a week",
  active: "training 6 days a week", very_active: "training twice a day",
};
for (let i = 0; i < 8; i++) {
  const w = rand([60, 70, 80, 90]);
  const a = rand(Object.keys(ACT_WORDS));
  push([u(`i'm ${w}kg and ${ACT_WORDS[a]}, how much water do i need`)],
    "Let me work that out.", [OP({ tool: "hydration", weightKg: w, activity: a })]);
}
// CONTRAST: water is not food. A question about drinking must never rebuild the plan.
for (const m of ["is coffee dehydrating", "does tea count towards my water"])
  push([u(m)], "Water, tea and coffee all count towards your fluid for the day — caffeine's diuretic effect is far too small to offset the drink itself.", []);

// A vague command is not permission to rebuild the week. v7 heard "do something different" and
// regenerated everything. Asking one question costs the user a second; guessing costs them a plan.
for (const m of [
  "do it differently", "change something", "mix it up", "switch things around",
  "shake it up a bit", "i want something else", "not this", "try again but different",
])
  push([u(m)], "Happy to — what would you like different: the meals, the calories, the cuisine, or the cost?", []);
// A macro/calorie question with no body stats is a question to ASK, not a report to run. v7
// answered "tell me my macro split" with weekly_report, which reviews the plan it already has.
for (const m of [
  "tell me my macros", "what's my macro breakdown", "what should my protein be",
  "how much should i be eating", "give me my macro targets", "what macros do i need",
])
  push([u(m)], "I can work that out — tell me your age, height, weight, sex, roughly how active you are, and whether you want to lose fat, maintain, or build muscle.", []);

// symptom_check: v7 routed "i feel worn out every afternoon" to weekly_report. Fatigue is the
// most common thing anyone says to a nutritionist; it needs more than three phrasings.
for (const s of [
  "i feel worn out every afternoon", "i'm shattered by 3pm", "i've got no energy in the mornings",
  "i'm knackered all the time", "i feel sluggish lately", "i'm dragging myself through the day",
  "i wake up tired", "my energy crashes after lunch", "i feel drained",
  "i'm exhausted even after a full night's sleep",
])
  push([u(s)], "Let me look at what your week is giving you.", [OP({ tool: "symptom_check", symptom: s })]);

// v6 emitted the right tool with an EMPTY body, because OP() had been silently dropping these
// fields from every label. Now that they survive, give the thin ones more surface.
for (let i = 0; i < 16; i++) {
  const day = rand(DAYS); const mt = rand(MEALS); const cal = rand([600, 750, 900, 1000, 1200, 1500]);
  push([u(rand([
    `i'm out for ${mt} on ${day}, probably ${cal} calories`,
    `${day} ${mt} out, about ${cal} kcal i reckon`,
    `restaurant ${mt} on ${day}, budget ${cal} calories for it`,
    `eating out ${day} ${mt} — figure ${cal} kcal`,
  ]))], `Done — ${cal} kcal set aside for ${day} ${mt}.`,
    [OP({ tool: "eating_out", day, mealType: mt, estimatedCalories: cal })]);
}
// "i don't like X" is a standing exclusion, and v6 started answering it with nothing at all.
const DISLIKED = ["mushrooms", "olives", "cilantro", "onions", "blue cheese", "eggplant", "beetroot", "anchovies", "coconut", "liver"];
for (const f of DISLIKED) {
  push([u(`i don't like ${f}`)], `Noted — no more ${f}.`, [OP({ tool: "update_profile", excludeFoods: [f] })]);
  push([u(rand([`i hate ${f}`, `${f} are gross`, `please no ${f}`, `keep ${f} out of my plan`]))], `Done — ${f} are off the menu.`, [OP({ tool: "update_profile", excludeFoods: [f] })]);
}
// weekly_report: questions about how the WEEK is going
for (const m of ["am i hitting my protein?", "am i getting enough protein?", "how's my protein looking?",
  "am i on track for my macros?", "am i short on fiber?", "is my week balanced?", "how are my calories overall?",
  "am i eating enough?"])
  push([u(m)], "Here's the picture across the week:", [OP({ tool: "weekly_report" })]);

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

// The eval set is held out, and it stays held out. A training example whose message is verbatim an
// eval case turns that case into a recall test. Drop it here, and NAME it — a silent drop is how
// this codebase lost every clarify example once. If one is named, rephrase the generator template;
// don't just accept the smaller set.
const evalNorm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
const evalMsgs = new Set(
  JSON.parse(readFileSync(join(root, "data", "eval-cases.json"), "utf8")).cases.map((c) => evalNorm(c.msg)),
);
const kept = records.filter((r) => !evalMsgs.has(evalNorm(r.message)));
if (kept.length !== records.length) {
  const dropped = [...new Set(records.filter((r) => evalMsgs.has(evalNorm(r.message))).map((r) => r.message))];
  console.warn(`\nDROPPED ${records.length - kept.length} example(s) that collide with the held-out eval set:`);
  for (const m of dropped) console.warn(`  "${m}"  <- rephrase this generator template`);
  console.warn("");
}

if (!existsSync(dirname(OUT))) mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, kept.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
console.log(`Wrote ${kept.length} synthetic examples -> ${OUT}`);
const tools = {};
for (const r of records) {
  const t = r.completion.operations[0]?.tool ?? "answer";
  tools[t] = (tools[t] ?? 0) + 1;
}
console.log("by tool:", tools);
