/**
 * The agent's READ SURFACE — the tools it uses to look things up before deciding.
 *
 * Specified in ASSISTANT-SCHEMA.md v3; the reasoning is VISION.md's RULE 1: **a tool call is a
 * query, and queries beat context stuffing.** The library is 501 recipes with ingredients and
 * steps. It cannot go in a prompt, and putting a slice of it there is worse — the model then
 * reasons over an arbitrary, stale subset and cannot tell that it is doing so. So it asks instead,
 * the same way a coding agent greps a repository rather than reading all of it.
 *
 * ── THESE ARE NOT `READ_ONLY_TOOLS` ────────────────────────────────────────────────────────────
 * `src/lib/reply.ts` exports a set with a confusingly similar name. Those are **user-facing
 * answers**: the tool's output IS the reply, and the set exists so an answer never falsely claims
 * the plan changed. Everything here is **model-facing**: the output goes back into the loop as
 * input to the next model call and the user never sees it. Both are "does not change the plan" and
 * nothing else about them is alike — do not merge the two sets.
 *
 * ── RULES THIS FILE HOLDS TO ───────────────────────────────────────────────────────────────────
 * 1. **Pure.** Every tool is a function of its arguments and the context it is handed. No I/O, no
 *    network, no clock, no localStorage. That is what makes them unit-testable and what stops the
 *    loop having to reason about a tool failing.
 * 2. **Bounded.** `find_recipes` caps at ten rows. An unbounded query is context stuffing with
 *    extra steps.
 * 3. **Reuse, never reimplement.** Filtering is `filterFeed`/`sortFeed`, the report is
 *    `weeklyReportNote`, micros are `microsForIngredients`. A second implementation of "vegan"
 *    that disagrees with the tested one is precisely the bug this project keeps finding.
 * 4. **No arithmetic the engine could do.** Totals here are sums of figures the engine already
 *    derived; nothing is estimated, and no macro is ever invented.
 */
import {
  RECIPES,
  recipeToMeal,
  weeklyReportNote,
  type DietTag,
  type Recipe,
} from "./recipeDb";
import { FEED_RECIPES, filterFeed, sortFeed, type FeedSort } from "./feed";
import { microsForIngredients, DAILY_REFERENCE, MICRO_KEYS, MICRO_LABEL, MICRO_UNIT } from "./nutrients";
import { applyPrimitives, type PrimitiveOp } from "./primitives";
import type { DayPlan, Meal, UserProfile, WeekPlan } from "./types";

/** Everything the tools may read. Passed in, never fetched — see rule 1. */
export interface AgentContext {
  profile: UserProfile;
  plan: WeekPlan;
  /**
   * Saved recipe names. Passed IN rather than read here: saves live in the browser (and will live
   * in an account), and this module runs on the server, where `localStorage` does not exist.
   */
  saved?: string[];
  /** ISO date, for ops that care what day it is. Injected so the tools stay pure. */
  today?: string;
}

export const MAX_ROWS = 10;

/* ── find_recipes ─────────────────────────────────────────────────────────────────────────────
 * The most-used tool: it is how the agent sees the library at all. */

export interface FindRecipesArgs {
  mealType?: Meal["type"];
  diet?: DietTag;
  minProtein?: number;
  maxCalories?: number;
  maxTime?: number;
  query?: string;
  sort?: FeedSort;
  limit?: number;
}

export interface RecipeRow {
  name: string;
  type: Meal["type"];
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  fibre: number;
  minutes: number;
  dietTags: DietTag[];
}

const toRow = (m: Meal, dietTags: DietTag[]): RecipeRow => ({
  name: m.name,
  type: m.type,
  calories: m.calories,
  protein: m.proteinGrams,
  carbs: m.carbsGrams,
  fat: m.fatGrams,
  fibre: m.fiberGrams ?? 0,
  minutes: m.timeMinutes,
  dietTags,
});

export function findRecipes(args: FindRecipesArgs = {}): { rows: RecipeRow[]; matched: number; shown: number } {
  // The facets filterFeed already owns go through filterFeed — a second "vegan" would be a bug.
  const base = filterFeed(FEED_RECIPES, {
    mealType: args.mealType ?? "all",
    diet: args.diet ?? "all",
    highProtein: false,
    maxTime: args.maxTime ?? null,
    query: typeof args.query === "string" ? args.query : "",
  });

  // Two numeric facets filterFeed has no concept of. Applied here rather than by widening
  // filterFeed, because filterFeed backs the Explore UI and its filters are user-facing chips.
  const narrowed = base.filter(
    (it) =>
      (args.minProtein == null || it.meal.proteinGrams >= args.minProtein) &&
      (args.maxCalories == null || it.meal.calories <= args.maxCalories),
  );

  const sorted = sortFeed(narrowed, args.sort ?? "default");
  // Coerce a model-supplied limit defensively: a non-numeric value must not become NaN and return an
  // empty list with a NaN count.
  const wantLimit = Number(args.limit);
  const limit = Math.min(Number.isFinite(wantLimit) && wantLimit >= 1 ? Math.floor(wantLimit) : MAX_ROWS, MAX_ROWS);
  return {
    matched: sorted.length,
    shown: Math.min(limit, sorted.length),
    rows: sorted.slice(0, limit).map((it) => toRow(it.meal, it.dietTags)),
  };
}

/* ── inspect_recipe ───────────────────────────────────────────────────────────────────────── */

export function inspectRecipe(name: string) {
  const key = name.trim().toLowerCase();
  // An empty/whitespace name must miss cleanly — otherwise the includes() fallback below matches
  // every recipe ("".includes("") === true) and hands back an arbitrary dish as a confident match.
  if (!key) return { found: false as const, name, suggestion: [] as RecipeRow[] };
  const recipe: Recipe | undefined =
    RECIPES.find((r) => r.name.toLowerCase() === key) ??
    RECIPES.find((r) => r.name.toLowerCase().includes(key));
  if (!recipe) {
    // An honest miss, not an exception: the loop must be able to read this and try another name.
    return { found: false as const, name, suggestion: findRecipes({ query: name, limit: 3 }).rows };
  }

  const meal = recipeToMeal(recipe);
  const { micros, coverage } = microsForIngredients(recipe.ingredients);
  return {
    found: true as const,
    ...toRow(meal, recipe.dietTags),
    description: recipe.description,
    cuisine: recipe.cuisine,
    mainProtein: recipe.mainProtein,
    servings: recipe.servings ?? 1,
    ingredients: recipe.ingredients,
    steps: recipe.steps,
    // Coverage is reported so a nutrient claim can be withheld when the ingredient list is thin —
    // the same honesty rule `explain_meal` follows.
    micronutrients: {
      coverage: Number(coverage.toFixed(2)),
      values: MICRO_KEYS.map((k) => ({
        key: k,
        label: MICRO_LABEL[k],
        unit: MICRO_UNIT[k],
        amount: Math.round(micros[k] * 10) / 10,
        percentOfReference: Math.round((micros[k] / DAILY_REFERENCE[k]) * 100),
      })),
    },
  };
}

/* ── get_plan ─────────────────────────────────────────────────────────────────────────────── */

const dayTotals = (d: DayPlan) => ({
  calories: d.meals.reduce((s, m) => s + m.calories, 0),
  protein: d.meals.reduce((s, m) => s + m.proteinGrams, 0),
  carbs: d.meals.reduce((s, m) => s + m.carbsGrams, 0),
  fat: d.meals.reduce((s, m) => s + m.fatGrams, 0),
  fibre: d.meals.reduce((s, m) => s + (m.fiberGrams ?? 0), 0),
});

export function getPlan(ctx: AgentContext, day?: string) {
  const wanted = day?.trim().toLowerCase();
  const days = wanted ? ctx.plan.days.filter((d) => d.day.toLowerCase() === wanted) : ctx.plan.days;
  if (wanted && !days.length) {
    return { found: false as const, day, validDays: ctx.plan.days.map((d) => d.day) };
  }
  return {
    found: true as const,
    targets: { calories: ctx.profile.targetCalories, protein: ctx.profile.proteinGrams },
    days: days.map((d) => ({
      day: d.day,
      totals: dayTotals(d),
      meals: d.meals.map((m) => ({
        slot: m.type,
        name: m.name,
        calories: m.calories,
        protein: m.proteinGrams,
        fibre: m.fiberGrams ?? 0,
        minutes: m.timeMinutes,
      })),
    })),
  };
}

/* ── get_profile ──────────────────────────────────────────────────────────────────────────── */

export function getProfile(ctx: AgentContext) {
  const p = ctx.profile;
  return {
    goal: p.goal,
    diet: p.diet,
    allergies: p.allergies,
    dislikes: p.dislikes,
    budget: p.budget,
    mealsPerDay: p.mealsPerDay,
    targets: {
      calories: p.targetCalories,
      protein: p.proteinGrams,
      carbs: p.carbsGrams,
      fat: p.fatGrams,
    },
    maxCookTime: p.maxCookTime,
    maxIngredients: p.maxIngredients,
    pinned: (p.lockedMeals ?? []).map((l) => ({ day: l.day, slot: l.mealType, name: l.name })),
    ratings: (p.mealRatings ?? []).map((r) => ({ name: r.name, rating: r.rating })),
    // What it has been told to remember about the person. The whole point of a personal
    // nutritionist is that this is queryable rather than only injected as prompt decoration.
    remembered: p.memory ?? [],
  };
}

/* ── get_saved ────────────────────────────────────────────────────────────────────────────── */

export function getSaved(ctx: AgentContext) {
  const names = ctx.saved ?? [];
  const rows = names
    .map((n) => RECIPES.find((r) => r.name === n))
    .filter((r): r is Recipe => Boolean(r))
    .map((r) => toRow(recipeToMeal(r), r.dietTags));
  return {
    count: rows.length,
    // A saved name that no longer resolves to a recipe is reported rather than silently dropped —
    // the same rule the interface follows when counting photographed dishes.
    unresolved: names.filter((n) => !RECIPES.some((r) => r.name === n)),
    rows: rows.slice(0, MAX_ROWS),
  };
}

/* ── report ───────────────────────────────────────────────────────────────────────────────── */

export function report(ctx: AgentContext, scope: "week" | "day" = "week", day?: string) {
  if (scope === "day") {
    const found = ctx.plan.days.find((d) => d.day.toLowerCase() === day?.trim().toLowerCase());
    if (!found) return { found: false as const, day, validDays: ctx.plan.days.map((d) => d.day) };
    const totals = dayTotals(found);
    return {
      found: true as const,
      scope: "day" as const,
      day: found.day,
      totals,
      against: { calories: ctx.profile.targetCalories, protein: ctx.profile.proteinGrams },
      shortfalls: {
        calories: ctx.profile.targetCalories - totals.calories,
        protein: ctx.profile.proteinGrams - totals.protein,
      },
    };
  }
  // The week summary is the ENGINE's own sentence — the same one the weekly_report operation
  // gives the user — so the agent and the person are never told different things.
  return { found: true as const, scope: "week" as const, summary: weeklyReportNote(ctx.plan, ctx.profile) };
}

/* ── what_if ──────────────────────────────────────────────────────────────────────────────── */

/**
 * Simulate operations WITHOUT committing them.
 *
 * This is the tool with no equivalent in the old design and the most leverage: the engine is pure,
 * so a proposed change can be inspected before it is made. It is the agent's version of running
 * the tests before claiming the work is done, and it is what lets the assistant say "that would
 * put you 300 kcal over, here is a better option" rather than doing it and apologising.
 *
 * The inputs are DEEP-CLONED before the engine sees them. `applyPrimitives` is believed to be
 * functional, but "believed" is not good enough for a dry run whose entire purpose is to not
 * change anything — a clone makes the guarantee structural rather than a matter of trust.
 */
export function whatIf(ctx: AgentContext, operations: PrimitiveOp[]) {
  const profile = structuredClone(ctx.profile);
  const plan = structuredClone(ctx.plan);
  const before = plan.days.map((d) => ({ day: d.day, ...dayTotals(d) }));

  const res = applyPrimitives(profile, plan, operations, ctx.today);

  const after = res.plan.days.map((d) => ({ day: d.day, ...dayTotals(d) }));
  return {
    wouldChangePlan: res.planChanged,
    wouldChangeProfile: res.profileChanged,
    // The engine's own account of what it did, including anything it refused or relaxed.
    notes: res.notes,
    days: after.map((a, i) => ({
      day: a.day,
      calories: a.calories,
      protein: a.protein,
      fibre: a.fibre,
      deltaCalories: a.calories - before[i].calories,
      deltaProtein: a.protein - before[i].protein,
    })),
    meals: res.plan.days.map((d, i) => ({
      day: d.day,
      changed: d.meals
        .map((m, j) => ({ slot: m.type, from: plan.days[i]?.meals[j]?.name, to: m.name }))
        .filter((c) => c.from !== c.to),
    })).filter((d) => d.changed.length),
  };
}

/* ── the dispatcher ───────────────────────────────────────────────────────────────────────── */

export const READ_TOOL_NAMES = [
  "find_recipes",
  "inspect_recipe",
  "get_plan",
  "get_profile",
  "get_saved",
  "report",
  "what_if",
] as const;
export type ReadToolName = (typeof READ_TOOL_NAMES)[number];

export const isReadTool = (name: string): name is ReadToolName =>
  (READ_TOOL_NAMES as readonly string[]).includes(name);

/**
 * Run one read tool. Never throws: an unknown tool or a bad argument comes back as `{ error }` so
 * the LOOP can feed it to the model and let it try again, which is the whole point of the agent
 * observing its own actions. A thrown exception would end the turn instead.
 */
export function runReadTool(
  ctx: AgentContext,
  name: string,
  args: Record<string, unknown> = {},
): unknown {
  try {
    switch (name) {
      case "find_recipes":
        return findRecipes(args as FindRecipesArgs);
      case "inspect_recipe":
        return typeof args.name === "string"
          ? inspectRecipe(args.name)
          : { error: "inspect_recipe needs a recipe name." };
      case "get_plan":
        return getPlan(ctx, typeof args.day === "string" ? args.day : undefined);
      case "get_profile":
        return getProfile(ctx);
      case "get_saved":
        return getSaved(ctx);
      case "report":
        return report(
          ctx,
          args.scope === "day" ? "day" : "week",
          typeof args.day === "string" ? args.day : undefined,
        );
      case "what_if":
        return Array.isArray(args.operations)
          ? whatIf(ctx, args.operations as PrimitiveOp[])
          : { error: "what_if needs an operations array." };
      default:
        return { error: `Unknown tool "${name}". Available: ${READ_TOOL_NAMES.join(", ")}.` };
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
