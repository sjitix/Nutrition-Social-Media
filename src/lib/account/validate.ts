/**
 * Is this value something the app can safely put in a store? One answer, used for EVERY way data
 * arrives from outside this browser: an imported file (`portable.ts`) and a row pulled from the account
 * (`sync.ts` via `client.ts`).
 *
 * Why the account counts as "outside": the server stores whatever a signed-in client sent it, and a
 * value written by an older or newer version of the app — or by anyone holding the account's tokens —
 * can be malformed. A pulled row that fails here is NOT written; the local copy is kept and the sync
 * reports it. One bad value must not be able to crash a screen on every device the person owns.
 *
 * ZOD-FREE ON PURPOSE. `client.ts` runs on every /sage screen (through `<AccountSync/>`), and pulling
 * zod and every schema into all of them for this would be a bundle cost the module map warns about.
 * These are structural checks of exactly what the screens rely on, and nothing more.
 *
 * Each checker returns null when the value is acceptable, or a short phrase saying what is wrong,
 * written to complete the sentence "Nothing was imported: …".
 *
 * EVERY FIELD A SCREEN DEREFERENCES IS CHECKED, optional ones included, when present. Review 2 sent a
 * file whose profile had `lockedMeals` as an object and whose meals had object descriptions. It passed
 * here, was mirrored to the account, was pulled by every device, and crashed the Week board, the meal
 * sheet and Today on all of them (`.some is not a function`, "Objects are not valid as a React
 * child"). A field that is merely absent is fine; a field in the wrong shape is refused.
 */
import type { StoreName } from "../storage";
import { DAYS, MEAL_TYPES } from "../slots";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const optNum = (v: unknown) => v === undefined || isNum(v);
const optStr = (v: unknown) => v === undefined || isStr(v);
/** Absent, or one of these values (`null` too where the app writes it to mean "not set"). */
const optOneOf = (v: unknown, values: readonly string[], allowNull = false) =>
  v === undefined || (allowNull && v === null) || (isStr(v) && values.includes(v));
const isDay = (v: unknown) => isStr(v) && (DAYS as readonly string[]).includes(v);
const isMealType = (v: unknown) => isStr(v) && (MEAL_TYPES as readonly string[]).includes(v);
/** Absent, or a list whose every item passes `item`. */
const optList = (v: unknown, item: (x: unknown) => boolean) => v === undefined || (Array.isArray(v) && v.every(item));

function isHttpUrl(v: unknown): boolean {
  if (!isStr(v)) return false;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

const isIngredient = (i: unknown) => isObj(i) && isStr(i.name) && isStr(i.quantity);

function checkMeal(m: unknown): boolean {
  return (
    isObj(m) &&
    isStr(m.name) &&
    isMealType(m.type) &&
    isNum(m.calories) && isNum(m.proteinGrams) && isNum(m.carbsGrams) && isNum(m.fatGrams) &&
    optNum(m.fiberGrams) && isNum(m.timeMinutes) &&
    Array.isArray(m.ingredients) && m.ingredients.every(isIngredient) &&
    isStrArray(m.steps) &&
    // Rendered as text: an object here is "Objects are not valid as a React child" on Today.
    optStr(m.description) &&
    (m.servings === undefined || (isNum(m.servings) && m.servings > 0)) &&
    optStr(m.batchId) &&
    (m.sourceUrl === undefined || isHttpUrl(m.sourceUrl))
  );
}

/** A meal-prep cooking session, as the Week board's batch view reads it. */
const isSession = (s: unknown) =>
  isObj(s) && isStr(s.id) && isDay(s.cookDay) && Array.isArray(s.coversDays) && s.coversDays.every(isDay) && optStr(s.label);

/** A meal-prep batch, as the Week board and the grocery list read it. */
const isBatch = (b: unknown) =>
  isObj(b) && isStr(b.id) && isStr(b.sessionId) && isStr(b.recipeName) && isMealType(b.slot) &&
  isNum(b.totalServings) && b.totalServings > 0 && isNum(b.servingFactor) &&
  isObj(b.perServing) && isNum(b.perServing.calories) && isNum(b.perServing.proteinGrams) &&
  isNum(b.perServing.carbsGrams) && isNum(b.perServing.fatGrams) && optNum(b.perServing.fiberGrams) &&
  Array.isArray(b.placements) && b.placements.every((p) => isObj(p) && isDay(p.day) && isMealType(p.slot)) &&
  optNum(b.keepDays) && optNum(b.freezeFrom) && optList(b.bulkIngredients, isIngredient);

function checkPlan(v: unknown, label: string): string | null {
  if (!isObj(v) || !Array.isArray(v.days)) return `the ${label} is not in a shape this app can read`;
  if (v.days.length === 0 || v.days.length > 7) return `the ${label} doesn't have between one and seven days`;
  for (const d of v.days) {
    if (!isObj(d) || !isDay(d.day) || !Array.isArray(d.meals)) {
      return `the ${label} has a day this app can't read`;
    }
    if (!d.meals.every(checkMeal)) return `the ${label} has a meal this app can't read`;
  }
  if (!isStr(v.weekSummary)) return `the ${label} is missing its summary`;
  if (!optList(v.notes, isStr)) return `the ${label}'s notes are not a list of sentences`;
  if (!optOneOf(v.planMode, ["fresh", "batch"])) return `the ${label} has a planning mode this app doesn't know`;
  if (!optList(v.sessions, isSession) || !optList(v.batches, isBatch)) return `the ${label}'s meal-prep schedule is in a shape this app can't read`;
  return null;
}

/** The profile's optional parts, each checked as the screens use it. */
function checkProfileExtras(v: Record<string, unknown>): string | null {
  if (!optStr(v.name)) return "the profile's name is not text";
  if (!optOneOf(v.planMode, ["fresh", "batch"], true) || !optOneOf(v.batchCadence, ["weekly", "every3days"], true)) {
    return "the profile has a meal-prep setting this app doesn't know";
  }
  for (const k of ["carbsGrams", "fatGrams", "fiberGrams", "maxCookTime", "maxIngredients", "batchVariety"]) {
    if (!optNum(v[k])) return "the profile has a target that is not a number";
  }
  if (!optStr(v.budget)) return "the profile's budget is not text";
  // The Week board and the meal sheet call `.some`/`.find` on these two.
  if (!optList(v.lockedMeals, (m) => isObj(m) && isDay(m.day) && isMealType(m.mealType) && isStr(m.name))) {
    return "the profile's pinned meals are in a shape this app can't read";
  }
  if (!optList(v.mealRatings, (r) => isObj(r) && isStr(r.name) && isNum(r.rating) && r.rating >= 1 && r.rating <= 5)) {
    return "the profile's meal ratings are in a shape this app can't read";
  }
  if (!optList(v.memory, (f) => isObj(f) && isStr(f.fact) && optStr(f.kind) && optStr(f.since))) {
    return "the profile's remembered notes are in a shape this app can't read";
  }
  const b = v.bodyStats;
  if (b !== undefined) {
    const ok = isObj(b) && optNum(b.age) && optNum(b.heightCm) && optNum(b.weightKg) &&
      optOneOf(b.sex, ["male", "female"]) && optOneOf(b.activity, ["sedentary", "light", "moderate", "active", "very_active"]);
    if (!ok) return "the profile's body measurements are in a shape this app can't read";
  }
  return null;
}

function checkImported(r: unknown): boolean {
  return (
    isObj(r) &&
    isStr(r.name) &&
    isHttpUrl(r.sourceUrl) && // /plan renders `new URL(sourceUrl)` — a non-URL here crashes that screen
    (r.servings === undefined || (isNum(r.servings) && r.servings > 0)) &&
    (r.ingredients === undefined || (Array.isArray(r.ingredients) && r.ingredients.every(isIngredient))) &&
    (r.steps === undefined || isStrArray(r.steps)) &&
    optNum(r.timeMinutes) && optNum(r.calories) && optNum(r.proteinGrams) && optNum(r.carbsGrams) &&
    optNum(r.fatGrams) && optNum(r.fiberGrams)
  );
}

export const CHECKS: Record<StoreName, (v: unknown) => string | null> = {
  profile(v) {
    if (!isObj(v)) return "the profile is not an object";
    if (!(isNum(v.targetCalories) && v.targetCalories > 0)) return "the profile has no valid calorie target";
    if (v.mealsPerDay !== 3 && v.mealsPerDay !== 4) return "the profile's meals-per-day is not 3 or 4";
    if (!isStr(v.diet) || !isStr(v.goal)) return "the profile is missing its diet or goal";
    // Plan building reads both as strings (`.trim()`); a missing one makes every rebuild fail.
    if (!isStr(v.allergies) || !isStr(v.dislikes)) return "the profile is missing its allergies or dislikes";
    if (!isNum(v.proteinGrams)) return "the profile has no protein target";
    return checkProfileExtras(v);
  },
  plan: (v) => checkPlan(v, "week plan"),
  batchPlan: (v) => checkPlan(v, "meal-prep week"),
  chat(v) {
    if (!Array.isArray(v)) return "the chat history is not a list";
    const ok = v.every((m) => isObj(m) && (m.role === "user" || m.role === "assistant") && isStr(m.text));
    return ok ? null : "the chat history has a message in an unknown shape";
  },
  imports(v) {
    if (!Array.isArray(v)) return "the imported-recipes history is not a list";
    return v.every(checkImported) ? null : "an imported recipe is missing its name or a valid link, or is in an unknown shape";
  },
  saved: (v) => (isStrArray(v) ? null : "the saved recipes are not a list of names"),
  groceriesChecked: (v) => (isStrArray(v) ? null : "the ticked grocery items are not a list of names"),
  visits(v) {
    if (!isStrArray(v)) return "the visit history is not a list of dates";
    return v.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) ? null : "the visit history has something that isn't a date";
  },
};

/** null when `value` may go into store `name`; otherwise what is wrong with it. `null` (cleared) is always fine. */
export function checkStore(name: StoreName, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const check = CHECKS[name];
  return check ? check(value) : "it is not a store this app knows";
}
