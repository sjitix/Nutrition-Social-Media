/**
 * Tests for the PURE functions in the presentation layer.  npm run test:ui
 *
 * `test:engine` covers `src/lib` and `test:api` covers the HTTP routes, which left a gap: two pure
 * functions under `src/app/sage` that nothing tests, both of which decide what the user sees.
 *
 *  - `parseCommand` turns a typed line into an engine operation. It is the command palette's whole
 *    brain and it has no model behind it, so a mis-parse is silent and permanent. It shipped verified
 *    only by a throwaway bundle check during the session that wrote it — and that check is how BOTH
 *    of its bugs were found ("log 2 eggs on toast 320" recording a two-calorie breakfast, and
 *    "yesterday" ending up in a dish's name). A check that valuable deserved to be kept.
 *  - `summariseWeek` is the single copy of the week arithmetic, shared by `demo.ts` and the client.
 *    Two implementations of "the average protein this week" is exactly the drift this project keeps
 *    writing rules against; one implementation with no test is the quieter version of the same risk.
 *
 * Neither touches the DOM, the network or a model, so this suite needs no browser and no server.
 */
import { parseCommand, COMMAND_EXAMPLES } from "@/app/sage/commands";
import { summariseWeek } from "@/app/sage/weekStats";
import { canonicalJson } from "@/app/sage/canonical";
import { shortDays, suggestionText } from "@/app/sage/suggest";
import { DAYS } from "@/lib/core";
import type { Meal, WeekPlan } from "@/lib/core";

let pass = 0;
let fail = 0;
const failures: string[] = [];
const check = (label: string, cond: boolean, detail = "") => {
  if (cond) {
    pass++;
    console.log(`PASS  ${label}${detail ? "  — " + detail : ""}`);
  } else {
    fail++;
    failures.push(`${label}${detail ? "  — " + detail : ""}`);
    console.log(`FAIL  ${label}${detail ? "  — " + detail : ""}`);
  }
};

/** The day `parseCommand` resolves "today" to, computed the same way it does. */
const today = DAYS[(new Date().getDay() + 6) % 7];
const yesterday = DAYS[(DAYS.indexOf(today) + 6) % 7];
const tomorrow = DAYS[(DAYS.indexOf(today) + 1) % 7];
const first = (line: string) => parseCommand(line)[0];

console.log("\n--- parseCommand: it must read a command, or refuse ---\n");

// A verb is mandatory. Without one there is nothing to do, and guessing is the one thing a
// deterministic parser must never do — that is what the assistant is for.
check("refuses an empty line", parseCommand("").length === 0);
check("refuses whitespace", parseCommand("   ").length === 0);
check("refuses a line with no verb it knows", parseCommand("asdfghjkl").length === 0);
check("refuses a bare day with no verb", parseCommand("tuesday").length === 0);

// Days, in every shape a person types them.
check("reads a full day name", first("regenerate tuesday")?.operation.day === "Tuesday");
check("reads a three-letter day", first("regen tue")?.operation.day === "Tuesday");
check("reads tues", first("regenerate tues")?.operation.day === "Tuesday");
check("reads thurs", first("regenerate thurs")?.operation.day === "Thursday");
check("reads today", first("balance today")?.operation.day === today);
check("reads tomorrow", first("regenerate tomorrow")?.operation.day === tomorrow);
check("reads yesterday", first("ate a kebab yesterday")?.operation.day === yesterday);
check("defaults to today when no day is named", first("regenerate")?.operation.day === today);

// Slots.
check("reads a slot", first("log pizza for dinner")?.operation.mealType === "dinner");
check("reads an abbreviated slot", first("log pizza breakf")?.operation.mealType === "breakfast");

// The verbs map to the right engine tool, which is the contract that matters.
check("regenerate -> regenerate_day", first("regenerate monday")?.operation.tool === "regenerate_day");
check("balance -> rebalance_day", first("balance monday")?.operation.tool === "rebalance_day");
check("protein + a number -> rebalance_day with a target",
  first("protein 180")?.operation.tool === "rebalance_day" &&
    first("protein 180")?.operation.targetProtein === 180);
check("log -> log_meal", first("log pizza")?.operation.tool === "log_meal");
check("out -> eating_out", first("out friday")?.operation.tool === "eating_out");
check("pin + day + slot -> lock_meal", first("pin monday lunch")?.operation.tool === "lock_meal");
check("undo -> undo", first("undo")?.operation.tool === "undo");
check("lighter -> scale_portions smaller",
  first("lighter dinner")?.operation.portionChange === "smaller");
check("bigger -> scale_portions bigger",
  first("bigger breakfast")?.operation.portionChange === "bigger");

// THE BUG THAT MATTERED MOST. "log 2 eggs on toast 320" took the FIRST number and recorded a
// two-calorie breakfast. A calorie figure is the largest value at or above a floor, because a meal
// is not 2 kcal and a quantity is rarely in the hundreds.
{
  const r = first("log 2 eggs on toast 320");
  check("a quantity is not mistaken for a calorie count", r?.operation.loggedCalories === 320,
    String(r?.operation.loggedCalories));
  check("...and no number is left inside the dish name", !/\d/.test(r?.operation.dish ?? ""),
    String(r?.operation.dish));
}

// THE SECOND BUG: grammar words ended up in the dish. Logging after the fact is the common case.
{
  const r = first("ate a kebab for dinner yesterday");
  check("filler words are stripped from the dish name", r?.operation.dish === "kebab", String(r?.operation.dish));
  check("...and the day word does not land in the dish either", r?.operation.day === yesterday);
}
{
  const r = first("log a burger and chips 900 for lunch");
  check("a multi-word dish survives intact", r?.operation.dish === "burger and chips", String(r?.operation.dish));
  check("...with its calories read correctly", r?.operation.loggedCalories === 900);
  check("...and its slot", r?.operation.mealType === "lunch");
}

// A reading must never be offered without the parameters its operation needs.
check("log with no dish at all is refused rather than logging nothing",
  parseCommand("log").every((r) => r.operation.tool !== "log_meal"));
check("pin without a day and slot is not offered as a pin",
  parseCommand("pin").every((r) => r.operation.tool !== "lock_meal"));

// Everything that moves the plan asks to be previewed; undo and pin do not need one.
check("a plan-moving reading asks for a preview",
  first("regenerate monday")?.preview === true);
check("undo does not ask for a preview", first("undo")?.preview === false);
check("every reading carries a human label", parseCommand("regenerate monday").every((r) => r.label.length > 0));

// The examples shown in the palette must themselves parse — a menu of commands that do not work
// is worse than no menu.
for (const ex of COMMAND_EXAMPLES) {
  check(`the palette's own example parses: "${ex}"`, parseCommand(ex).length > 0);
}

console.log("\n--- summariseWeek: the single copy of the week arithmetic ---\n");

const meal = (name: string, kcal: number, protein: number, type: Meal["type"] = "lunch"): Meal => ({
  name, type, description: "", calories: kcal, proteinGrams: protein,
  carbsGrams: 10, fatGrams: 5, fiberGrams: 3, timeMinutes: 10, ingredients: [], steps: [],
});

const week: WeekPlan = {
  days: DAYS.map((day, i) => ({
    day,
    meals: [meal(`B${i}`, 100 + i, 10 + i, "breakfast"), meal(`L${i}`, 200, 20)],
  })),
} as WeekPlan;

const stats = summariseWeek(week);
check("one row per day", stats.days.length === 7);
check("a day's calories are the sum of its meals", stats.days[0].kcal === 300);
check("a day's protein is the sum of its meals", stats.days[0].protein === 30);
check("fibre is summed, treating a missing value as zero", stats.days[0].fibre === 6);
check("the weekly average is the mean of the days",
  stats.avgKcal === Math.round(stats.days.reduce((t, d) => t + d.kcal, 0) / 7));
check("the weakest day is the one lowest on PROTEIN, not calories",
  stats.lowest.day === DAYS[0], stats.lowest.day);
check("unique dishes counts distinct names across the week", stats.uniqueDishes === 14);
check("the short label is three letters", stats.days[0].short === DAYS[0].slice(0, 3));

// A repeated dish must not be counted twice — that number is what tells the owner whether a week
// is actually varied.
const repeated: WeekPlan = {
  days: DAYS.map((day) => ({ day, meals: [meal("Same Dish", 500, 40)] })),
} as WeekPlan;
check("a dish repeated all week counts once", summariseWeek(repeated).uniqueDishes === 1);

// canonicalJson: how the chat and the undo snapshot tell "storage still holds what I wrote" from "something
// else wrote since" (a sync pull, Delete everything, a mode switch). Key order must not count as a change
// (storage and Postgres both reorder keys), and a real change, at any depth, must.
console.log("\n--- canonicalJson (is this still the week I wrote?) ---");
{
  const a = { profile: { goal: "maintain", diet: "none" }, week: { days: [{ day: "Monday", meals: [{ name: "Oats", calories: 400 }] }] } };
  const b = { week: { days: [{ meals: [{ calories: 400, name: "Oats" }], day: "Monday" }] }, profile: { diet: "none", goal: "maintain" } };
  check("the same content in another key order is the same", canonicalJson(a) === canonicalJson(b));
  const c = structuredClone(a);
  c.week.days[0].meals[0].calories = 401;
  check("a change deep inside a meal is a change", canonicalJson(a) !== canonicalJson(c));
  const d = structuredClone(a);
  d.week.days[0].meals.push({ name: "Eggs", calories: 300 });
  const e = structuredClone(d);
  e.week.days[0].meals.reverse();
  check("array order still counts (meals are ordered)", canonicalJson(d) !== canonicalJson(e));
  check("an undefined field is the same as a missing one (JSON drops it on save)",
    canonicalJson({ x: 1, y: undefined }) === canonicalJson({ x: 1 }));
}

// SKIP AND MOVE in the palette (V1 D9a): the same engine operations the meal sheet and the drag send.
{
  const first = (line: string) => parseCommand(line)[0]?.operation as Record<string, unknown> | undefined;
  const skip = first("skip tuesday lunch");
  const move = first("move tuesday dinner to thursday");
  const across = first("move mon lunch to wed dinner");
  check("palette: 'skip tuesday lunch' is a skip_meal on that slot, previewed",
    skip?.tool === "skip_meal" && skip.day === "Tuesday" && skip.mealType === "lunch" && parseCommand("skip tuesday lunch")[0].preview, JSON.stringify(skip));
  check("palette: 'skip' with no meal named is refused rather than guessed", !parseCommand("skip tuesday").some((c) => c.operation.tool === "skip_meal"));
  check("palette: 'move tuesday dinner to thursday' keeps the slot; 'move mon lunch to wed dinner' moves across slots",
    move?.tool === "move_meal" && move.day === "Tuesday" && move.mealType === "dinner" && move.toDay === "Thursday" && move.toMealType === "dinner" &&
      across?.tool === "move_meal" && across.day === "Monday" && across.mealType === "lunch" && across.toDay === "Wednesday" && across.toMealType === "dinner",
    `${JSON.stringify(move)} | ${JSON.stringify(across)}`);
  check("palette: a move onto itself is refused", !parseCommand("move tuesday dinner").some((c) => c.operation.tool === "move_meal"));
  // A protein figure with a meal named is that meal's floor; without one it is still the day's target.
  const meal = first("40g protein at tuesday breakfast");
  const meal2 = first("protein 35 lunch wed");
  const whole = first("protein 180 tuesday");
  check("palette: '40g protein at tuesday breakfast' is that meal's floor (regenerate_day + mealProtein); 'protein 180' still the day's",
    meal?.tool === "regenerate_day" && meal.day === "Tuesday" && meal.mealType === "breakfast" && meal.mealProtein === 40 &&
      meal2?.mealProtein === 35 && meal2.mealType === "lunch" && meal2.day === "Wednesday" &&
      whole?.tool === "rebalance_day" && whole.targetProtein === 180 && !parseCommand("protein 180 tuesday").some((c) => c.operation.tool === "regenerate_day"),
    `${JSON.stringify(meal)} | ${JSON.stringify(meal2)} | ${JSON.stringify(whole)}`);
}

// THE SUGGESTION (V1 D9): which days the bar may speak about, and what it says. The engine half (whether a re-plan
// closes the gap) is test-engine.mts's; here, the arithmetic and the words.
{
  const meal = (name: string, type: Meal["type"], proteinGrams: number, record?: Meal["record"]): Meal =>
    ({ name, type, description: "", calories: 600, proteinGrams, carbsGrams: 60, fatGrams: 20, timeMinutes: 20, ingredients: [], steps: [], ...(record ? { record } : {}) }) as Meal;
  const week = (protein: Record<string, number>, logged: string[] = []): WeekPlan => ({
    weekSummary: "",
    days: DAYS.map((day) => ({ day, meals: [
      meal("Oats", "breakfast", 30, logged.includes(day) ? "logged" : undefined),
      meal("Bowl", "lunch", 50, logged.includes(day) ? "logged" : undefined),
      meal("Stew", "dinner", (protein[day] ?? 150) - 80, logged.includes(day) ? "out" : undefined),
    ] })),
  }) as WeekPlan;
  const days = (w: WeekPlan, only?: string[]) => shortDays(summariseWeek(w), 150, only).map((d) => d.day).join(",");
  check("suggestion: a week on target, or short by no more than the engine's 8 g, has no short day",
    days(week({})) === "" && days(week({ Tuesday: 142 })) === "", days(week({ Tuesday: 142 })));
  check("suggestion: short days come worst first",
    days(week({ Tuesday: 128, Friday: 120, Sunday: 140 })) === "Friday,Tuesday,Sunday", days(week({ Tuesday: 128, Friday: 120, Sunday: 140 })));
  check("suggestion: Today asks about its own day only", days(week({ Tuesday: 128, Friday: 120 }), ["Tuesday"]) === "Tuesday");
  check("suggestion: a day that is all logged meals and a meal out is a set of facts, not offered",
    days(week({ Tuesday: 128, Friday: 120 }, ["Friday"])) === "Tuesday", days(week({ Tuesday: 128, Friday: 120 }, ["Friday"])));
  const reach = suggestionText({ day: "Tuesday", protein: 128, after: 146, target: 150, moves: [
    { slot: "lunch", from: "Bowl", to: "Chicken Caesar, No Croutons" }, { slot: "dinner", from: "Pizza", to: "Turkey & Bean Chilli" }] });
  const part = suggestionText({ day: "Tuesday", protein: 110, after: 130, target: 150, moves: [] });
  check("suggestion: the line gives the gap, names every dish it would change, and says 'on your target' only when it gets there",
    reach === "Tuesday is 22 g short of protein. Switching lunch to Chicken Caesar, No Croutons and dinner to Turkey & Bean Chilli brings it to 146 g, on your 150 g." &&
      part === "Tuesday is 40 g short of protein. Re-planning it brings it to 130 g.", `${reach} | ${part}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
