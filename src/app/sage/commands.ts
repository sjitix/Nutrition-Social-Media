import { DAYS, MEAL_TYPES } from "@/lib/core/client";
import type { DayPlan, Meal, Operation } from "@/lib/core";

/**
 * Turn a typed line into an engine operation, deterministically.
 *
 * This is the command palette's brain, and it contains NO MODEL on purpose. A model would be slower,
 * cost a call, and — the part that matters — could misread an instruction the user stated precisely.
 * "regenerate tuesday" is not ambiguous; sending it somewhere that might come back with Wednesday is
 * a downgrade dressed as intelligence. The assistant still exists for the sentences this cannot
 * parse, which is exactly the division `/api/operation` was built around.
 *
 * It is a pure function of a string, so it is cheap to reason about and cheap to test. The parse is
 * deliberately forgiving about ORDER and strict about MEANING: it looks for a verb, a day, a slot and
 * a number anywhere in the line, and refuses rather than guesses when the verb is missing.
 */

export interface ParsedCommand {
  /** What the user will see as the thing about to happen. */
  label: string;
  operation: Operation;
  /** True when the change wants a preview before committing (anything that moves the plan). */
  preview: boolean;
  /** The day a rebalance could be offered for, when the change sits inside one. */
  day?: DayPlan["day"];
}

const DAY_ALIASES: Record<string, DayPlan["day"]> = {};
for (const d of DAYS) {
  DAY_ALIASES[d.toLowerCase()] = d;
  DAY_ALIASES[d.toLowerCase().slice(0, 3)] = d; // mon, tue, wed…
}
DAY_ALIASES.tues = "Tuesday";
DAY_ALIASES.thurs = "Thursday";
DAY_ALIASES.thur = "Thursday";

/**
 * Words that are grammar rather than food. Without this, "log a burger and chips 900 for lunch"
 * records a dish called "a burger and chips for" — the slot word is consumed correctly and the
 * preposition pointing at it is left behind.
 */
const FILLER = new Set([
  "log", "ate", "had", "eat", "today", "tomorrow", "kcal", "cal", "cals", "calories",
  "for", "at", "a", "an", "the", "my", "on", "of", "with", "some", "in", "yesterday",
]);

/** Today's name, so "regenerate today" works without the user counting days. */
function todayName(): DayPlan["day"] {
  // getDay() is 0 = Sunday; DAYS starts at Monday.
  const i = (new Date().getDay() + 6) % 7;
  return DAYS[i];
}

function findDay(words: string[]): DayPlan["day"] | undefined {
  for (const w of words) {
    if (w === "today") return todayName();
    if (w === "tomorrow") {
      const i = (DAYS.indexOf(todayName()) + 1) % 7;
      return DAYS[i];
    }
    // Logging the day after the fact is the common case, not an edge one.
    if (w === "yesterday") {
      const i = (DAYS.indexOf(todayName()) + 6) % 7;
      return DAYS[i];
    }
    const hit = DAY_ALIASES[w];
    if (hit) return hit;
  }
  return undefined;
}

function findSlot(words: string[]): Meal["type"] | undefined {
  for (const w of words) {
    const hit = MEAL_TYPES.find((t) => t === w || (w.length > 3 && t.startsWith(w)));
    if (hit) return hit;
  }
  return undefined;
}

/**
 * The number that is plausibly a CALORIE figure, not a quantity.
 *
 * "log 2 eggs on toast 320" contains two numbers and the first one is the eggs. Taking the first
 * match recorded a 2-calorie breakfast, so: prefer values at or above FOOD_FLOOR, and among those
 * take the largest. A real meal is not 2 kcal, and a quantity is rarely in the hundreds.
 */
const FOOD_FLOOR = 50;
function findNumber(words: string[]): number | undefined {
  const nums = words
    .map((w) => Number(w.replace(/[^\d.]/g, "")))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!nums.length) return undefined;
  const plausible = nums.filter((n) => n >= FOOD_FLOOR);
  return plausible.length ? Math.max(...plausible) : undefined;
}

/**
 * Parse one line. Returns every reading that makes sense, best first, so the palette can show what
 * it is about to do rather than acting on a guess. An empty list means "I don't understand this" —
 * which is a better answer than running something adjacent.
 */
export function parseCommand(input: string): ParsedCommand[] {
  const line = input.trim().toLowerCase();
  if (!line) return [];
  const words = line.split(/[\s,]+/).filter(Boolean);
  const day = findDay(words);
  const slot = findSlot(words);
  const num = findNumber(words);
  const has = (...keys: string[]) => keys.some((k) => words.some((w) => w === k || w.startsWith(k)));

  const out: ParsedCommand[] = [];

  if (has("undo", "revert", "back")) {
    out.push({ label: "Undo the last change", operation: { tool: "undo" }, preview: false });
  }

  if (has("balance", "rebalance", "fix")) {
    // "fix my week" has no day and means every day; the caller handles that composite.
    if (day) {
      out.push({
        label: `Rebalance ${day} to hit your targets`,
        operation: { tool: "rebalance_day", day },
        preview: true,
        day,
      });
    }
  }

  if (has("regenerate", "regen", "new", "redo")) {
    const d = day ?? todayName();
    out.push({
      label: `Pick new dishes for ${d}`,
      operation: { tool: "regenerate_day", day: d },
      preview: true,
      day: d,
    });
  }

  if (has("protein") && num) {
    const d = day ?? todayName();
    out.push({
      label: `Aim ${d} at ${num} g protein`,
      operation: { tool: "rebalance_day", day: d, targetProtein: num },
      preview: true,
      day: d,
    });
  }

  if (has("log", "ate", "had")) {
    const d = day ?? todayName();
    const s = slot ?? "lunch";
    // Everything that isn't a keyword, a day, a slot or the number is the dish's name.
    const dish = words
      .filter(
        (w) =>
          !FILLER.has(w) &&
          !DAY_ALIASES[w] &&
          !MEAL_TYPES.includes(w as Meal["type"]) &&
          // Every number is a quantity or a calorie figure — neither belongs in the dish's name.
          !/^\d/.test(w),
      )
      .join(" ")
      .trim();
    if (dish) {
      out.push({
        label: `Log "${dish}" for ${d} ${s}${num ? ` at ${num} kcal` : ""} and re-solve the rest of the day`,
        operation: {
          tool: "log_meal",
          day: d,
          mealType: s,
          dish,
          ...(num ? { loggedCalories: num } : {}),
        },
        preview: true,
        day: d,
      });
    }
  }

  if (has("out", "restaurant", "takeaway", "takeout")) {
    const d = day ?? todayName();
    const s = slot ?? "dinner";
    out.push({
      label: `Reserve ${d} ${s} for eating out and lighten the rest of the day`,
      operation: { tool: "eating_out", day: d, mealType: s, ...(num ? { estimatedCalories: num } : {}) },
      preview: true,
      day: d,
    });
  }

  if (has("pin", "lock", "keep") && day && slot) {
    out.push({
      label: `Pin ${day} ${slot} so rebuilds keep it`,
      operation: { tool: "lock_meal", day, mealType: slot },
      preview: false,
    });
  }

  if (has("bigger", "more", "hungry") && !has("protein")) {
    const d = day ?? todayName();
    out.push({
      label: `Make ${d}${slot ? ` ${slot}` : "'s meals"} bigger`,
      operation: { tool: "scale_portions", day: d, ...(slot ? { mealType: slot } : {}), portionChange: "bigger" },
      preview: true,
      day: d,
    });
  }

  if (has("smaller", "less", "lighter")) {
    const d = day ?? followDay(day);
    out.push({
      label: `Make ${d}${slot ? ` ${slot}` : "'s meals"} smaller`,
      operation: { tool: "scale_portions", day: d, ...(slot ? { mealType: slot } : {}), portionChange: "smaller" },
      preview: true,
      day: d,
    });
  }

  return out;
}

function followDay(day: DayPlan["day"] | undefined): DayPlan["day"] {
  return day ?? todayName();
}

/** The examples the palette shows before anything is typed — a menu, not a guessing game. */
export const COMMAND_EXAMPLES = [
  "regenerate tuesday",
  "balance today",
  "protein 180",
  "log burger 650",
  "lighter dinner",
  "out friday",
  "undo",
] as const;
