"use client";

import { loadBatchPlan, loadPlan, loadProfile, saveBatchPlan, savePlan, saveProfile } from "@/lib/storage";
import { notifyPlanChanged } from "./myPlan";
import { summariseWeek, type WeekStats } from "./weekStats";
import type { DayPlan, Meal, Operation, PlanSnapshot, UserProfile, WeekPlan } from "@/lib/types";

/**
 * The ONE path every direct action takes — tap a meal, drag it, resize it, log what you really ate.
 *
 * Three rules hold this layer together, and breaking any of them breaks the product's honesty:
 *
 *  1. THE BROWSER NEVER IMPORTS THE ENGINE. Every write goes to /api/operation, where the engine
 *     runs server-side. `recipeDb` carries all 501 recipes; importing it here would serialise the
 *     whole library into the bundle (the Explore payload bug, docs/v1/02-module-map.md §6). The only
 *     client-side arithmetic allowed is `summariseWeek`, which imports a type and nothing else.
 *  2. THE ENGINE'S NUMBERS WIN. A control may render an optimistic state, but the figures shown
 *     afterwards are the ones the response carried. Nothing here computes a macro.
 *  3. THE ENGINE'S NOTES ARE SHOWN, NOT SUMMARISED. When it clamps a portion, relaxes a cook-time
 *     limit or refuses a swap, that sentence is the truth about what happened and the UI must
 *     surface it. A silent refusal is the worst outcome this layer can produce.
 *
 * No model is involved in any of it: a button press already states its intent, so routing it through
 * an LLM would be slower, cost a call, and risk misreading a request the user made precisely.
 */

/** What a committed action gives back to the caller. */
export interface ActionResult {
  week: WeekPlan;
  stats: WeekStats;
  profile: UserProfile;
  /** The engine's own account. Show it. */
  notes: string[];
  planChanged: boolean;
  /** True while an `undo` would restore something — drives the toast's Undo button. */
  canUndo: boolean;
}

/** What a simulation gives back: the consequence, before anyone commits to it. */
export interface PreviewResult {
  notes: string[];
  wouldChangePlan: boolean;
  days: {
    day: DayPlan["day"];
    kcal: number;
    protein: number;
    deltaKcal: number;
    deltaProtein: number;
    targetKcal: number;
  }[];
  moves: { day: DayPlan["day"]; slot: Meal["type"]; from: string; to: string }[];
}

export class ActionError extends Error {}

/**
 * The one-level undo snapshot, held in memory for the life of the tab.
 *
 * Deliberately NOT a storage key: `storage.ts` is the only module allowed to name one (and a second
 * ad-hoc key has already drifted once in this repo — see its header). A module-level variable
 * survives client-side navigation, because the /sage layout outlives every tab press, and is lost on
 * a hard reload — which is the honest lifetime for a one-step undo anyway. `canUndo` reflects it, so
 * the button is never offered when it would do nothing.
 */
let snapshot: PlanSnapshot | undefined;

/** A short label for what the last change was, for the toast ("Swapped Tuesday lunch"). */
let lastLabel: string | null = null;

export function canUndo(): boolean {
  return snapshot !== undefined;
}
export function lastChangeLabel(): string | null {
  return lastLabel;
}

function currentState(): { profile: UserProfile; plan: WeekPlan } {
  const profile = loadProfile();
  if (!profile) throw new ActionError("Set up your plan first — this needs your profile.");
  const plan = profile.planMode === "batch" ? loadBatchPlan() : loadPlan();
  if (!plan || !Array.isArray(plan.days) || plan.days.length === 0) {
    throw new ActionError("No week saved on this device yet.");
  }
  return { profile, plan };
}

async function post(body: unknown): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch("/api/operation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // Offline or the dev server is down. Say which, rather than "something went wrong".
    throw new ActionError("Couldn't reach the planner — is the app still running?");
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ActionError(String(data.error ?? "That change didn't go through."));
  return data;
}

/**
 * Show what an operation WOULD do. Commits nothing, and the caller's plan is untouched.
 *
 * The returned figures are a seeded prediction, not a promise: the engine picks at random among
 * near-tied recipes, so a commit can land on a different dish of equal fit. Label previewed numbers
 * as a preview and re-read the committed ones from `runOperation`.
 */
export async function previewOperation(operation: Operation): Promise<PreviewResult> {
  const { profile, plan } = currentState();
  const data = await post({ profile, plan, operation, preview: true });
  return {
    notes: Array.isArray(data.notes) ? (data.notes as string[]) : [],
    wouldChangePlan: Boolean(data.wouldChangePlan),
    days: (data.days ?? []) as PreviewResult["days"],
    moves: (data.moves ?? []) as PreviewResult["moves"],
  };
}

/**
 * Run an operation for real: persist the result under the key for the current mode, take the undo
 * snapshot, and tell every mounted screen to re-read so Week, Today and Groceries move together.
 */
export async function runOperation(operation: Operation, label?: string): Promise<ActionResult> {
  const { profile, plan } = currentState();
  const data = await post({ profile, plan, operation, previous: snapshot });

  const week = data.plan as WeekPlan;
  const nextProfile = (data.profile as UserProfile) ?? profile;
  const planChanged = Boolean(data.planChanged);

  // The route hands back the snapshot to keep (or undefined once an undo has spent it), so undo
  // bookkeeping stays in one place — the engine's — rather than being re-derived here.
  snapshot = (data.previous as PlanSnapshot | undefined) ?? undefined;
  if (operation.tool === "undo") lastLabel = null;
  else if (planChanged) lastLabel = label ?? null;

  if (nextProfile.planMode === "batch") saveBatchPlan(week);
  else savePlan(week);
  if (data.profile) saveProfile(nextProfile);

  notifyPlanChanged();

  const reply = typeof data.reply === "string" ? data.reply.trim() : "";
  return {
    week,
    stats: summariseWeek(week),
    profile: nextProfile,
    notes: reply ? [reply] : [],
    planChanged,
    canUndo: snapshot !== undefined,
  };
}

/** Reverse the last change. Safe to call when there is nothing to undo — the engine says so. */
export async function undoLast(): Promise<ActionResult> {
  return runOperation({ tool: "undo" });
}

/* ------------------------------------------------------------------------------------------------
 * The named actions. Each one is a control's whole vocabulary, so a component never has to know the
 * operation shape — which is what keeps the engine's contract in one place and the UI replaceable.
 * ---------------------------------------------------------------------------------------------- */

export const actions = {
  swapMeal: (day: DayPlan["day"], mealType: Meal["type"], dish: string) =>
    runOperation({ tool: "swap_meal", day, mealType, dish }, `Swapped ${day} ${mealType}`),

  /** The macro dial: ask for a protein figure and let the engine decide HOW to reach it. */
  setDayProtein: (day: DayPlan["day"], grams: number) =>
    runOperation({ tool: "rebalance_day", day, targetProtein: grams }, `Set ${day} protein`),

  resize: (day: DayPlan["day"], mealType: Meal["type"], portionChange: NonNullable<Operation["portionChange"]>) =>
    runOperation({ tool: "scale_portions", day, mealType, portionChange }, `Resized ${day} ${mealType}`),

  rebalanceDay: (day: DayPlan["day"]) =>
    runOperation({ tool: "rebalance_day", day }, `Rebalanced ${day}`),

  regenerateDay: (day: DayPlan["day"], extra?: Pick<Operation, "cuisine" | "maxCookTime" | "diet">) =>
    runOperation({ tool: "regenerate_day", day, ...extra }, `Regenerated ${day}`),

  lock: (day: DayPlan["day"], mealType: Meal["type"]) =>
    runOperation({ tool: "lock_meal", day, mealType }, `Pinned ${day} ${mealType}`),

  unlock: (day: DayPlan["day"], mealType: Meal["type"]) =>
    runOperation({ tool: "unlock_meal", day, mealType }, `Unpinned ${day} ${mealType}`),

  rate: (day: DayPlan["day"], mealType: Meal["type"], rating: number) =>
    runOperation({ tool: "rate_meal", day, mealType, rating }, "Saved your rating"),

  /** "I ate something else." The engine re-solves the REST of that day around it. */
  logMeal: (day: DayPlan["day"], mealType: Meal["type"], dish: string, loggedCalories?: number) =>
    runOperation(
      { tool: "log_meal", day, mealType, dish, ...(loggedCalories != null ? { loggedCalories } : {}) },
      `Logged ${dish}`,
    ),

  /** "I'm out for dinner." Reserves the calories and lightens the rest of the day. */
  eatingOut: (day: DayPlan["day"], mealType: Meal["type"], estimatedCalories?: number) =>
    runOperation(
      { tool: "eating_out", day, mealType, ...(estimatedCalories != null ? { estimatedCalories } : {}) },
      `Reserved ${day} ${mealType}`,
    ),

  /* Read-only: these answer a question and must never report a plan change. */
  explain: (day: DayPlan["day"], mealType: Meal["type"]) =>
    runOperation({ tool: "explain_meal", day, mealType }),

  substitute: (ingredient: string, day?: DayPlan["day"], mealType?: Meal["type"]) =>
    runOperation({ tool: "substitute_ingredient", ingredient, day, mealType }),

  weeklyReport: () => runOperation({ tool: "weekly_report" }),
};

/* ------------------------------------------------------------------------------------------------
 * Previews of the same actions, for the reconcile sheet.
 * ---------------------------------------------------------------------------------------------- */

export const previews = {
  swapMeal: (day: DayPlan["day"], mealType: Meal["type"], dish: string) =>
    previewOperation({ tool: "swap_meal", day, mealType, dish }),

  /** Moving a meal is a swap on each end, so a move's preview is the pair taken together. */
  move: (
    from: { day: DayPlan["day"]; mealType: Meal["type"]; dish: string },
    to: { day: DayPlan["day"]; mealType: Meal["type"]; dish: string },
  ) => Promise.all([
    previewOperation({ tool: "swap_meal", day: to.day, mealType: to.mealType, dish: from.dish }),
    previewOperation({ tool: "swap_meal", day: from.day, mealType: from.mealType, dish: to.dish }),
  ]),

  setDayProtein: (day: DayPlan["day"], grams: number) =>
    previewOperation({ tool: "rebalance_day", day, targetProtein: grams }),

  resize: (day: DayPlan["day"], mealType: Meal["type"], portionChange: NonNullable<Operation["portionChange"]>) =>
    previewOperation({ tool: "scale_portions", day, mealType, portionChange }),

  logMeal: (day: DayPlan["day"], mealType: Meal["type"], dish: string, loggedCalories?: number) =>
    previewOperation({
      tool: "log_meal", day, mealType, dish,
      ...(loggedCalories != null ? { loggedCalories } : {}),
    }),

  regenerateDay: (day: DayPlan["day"]) => previewOperation({ tool: "regenerate_day", day }),
};
