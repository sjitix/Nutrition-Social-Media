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
import { DAYS } from "@/lib/slots";
import type { Meal, WeekPlan } from "@/lib/types";

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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
