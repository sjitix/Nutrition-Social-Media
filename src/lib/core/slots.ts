/**
 * The two constant lists the whole app counts in: the days of a week, and the slots in a day.
 *
 * They live APART from `types.ts` for one measured reason. `types.ts` imports zod and defines every
 * schema, so importing a value from it — even a seven-string array — pulls zod and the entire
 * contract layer into whatever bundle did the importing. A command parser that needed nothing but
 * these two arrays took `/sage/plan` from ~109 kB to 225 kB of first-load JavaScript that way.
 *
 * So: zod-free, value-only, safe for a client component to import. `types.ts` re-exports both, which
 * means every existing caller is unchanged and nobody has to know this file exists.
 *
 * The general rule, which the module map states and this file is the scar from: a module is as heavy
 * as its heaviest import, and a constant does not care what else lives beside it.
 */
export const MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack"] as const;

/**
 * The display names of the slots, in MEAL_TYPES order. Here rather than in `sage/demo.ts` — where it
 * used to live — for the same reason as the rest of this file, measured again on 2026-10-03: the Week
 * board imported these four words from demo.ts, demo.ts builds the fixture week with the engine, and
 * so the whole recipe library (69 kB gzipped) and the USDA table (11 kB) rode along on `/sage/plan`.
 */
export const SLOT_LABELS = ["Breakfast", "Lunch", "Dinner", "Snack"] as const;

export const DAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;
