/**
 * The user's hard rules, as predicates: diet, allergens and exclusions, budget, the dishes they
 * rated 1, how a day's calories split across slots. Pure; no selection happens here.
 *
 * Part of the plan engine (src/lib/plan/, layer L3), split out of recipeDb.ts on 2026-10-03 (V1
 * milestone A3). The public surface is ./index.ts; an export here that index.ts does not re-export
 * is internal to this folder, and check:boundaries fails anything outside the folder that imports it.
 */
import { type Operation, type UserProfile } from "../core";
import { haystackBlocked, parseExclusionTokens } from "../nutrition";
import { type Cuisine, type Recipe } from "../data";

// --- Selection engine ------------------------------------------------------

export type SlotSplit = [Recipe["type"], number][];

export function localSplit(mealsPerDay: number): SlotSplit {
  return mealsPerDay === 4
    ? [
        ["breakfast", 0.27],
        ["lunch", 0.31],
        ["dinner", 0.31],
        ["snack", 0.11],
      ]
    : [
        ["breakfast", 0.3],
        ["lunch", 0.35],
        ["dinner", 0.35],
      ];
}

export function budgetCap(b: UserProfile["budget"]): number {
  return b === "low" ? 2 : 3;
}

export function passesDiet(r: Recipe, diet: UserProfile["diet"]): boolean {
  switch (diet) {
    case "none":
      return true;
    case "vegan":
      return r.dietTags.includes("vegan");
    case "vegetarian":
      return r.dietTags.includes("vegetarian") || r.dietTags.includes("vegan");
    case "keto":
      return r.dietTags.includes("keto");
    case "mediterranean":
      return r.dietTags.includes("mediterranean");
    default:
      return true;
  }
}

export function blockedByExclusions(r: Recipe, tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  // Include steps so method exclusions work too ("no oven" → drop bake/roast recipes).
  // Matching is word-aware and expands categories: "nuts" must block almonds (a raw substring
  // test did not), while "egg" must NOT block eggplant. Allergies are a hard rule.
  const hay = `${r.name} ${r.ingredients.map((i) => i.name).join(" ")} ${r.steps.join(" ")}`;
  return haystackBlocked(hay, tokens);
}

/** The user's ratings as the selector wants them: lowercased name -> 1..5. */
export function ratingMap(profile: UserProfile): ReadonlyMap<string, number> {
  return new Map((profile.mealRatings ?? []).map((r) => [r.name.toLowerCase(), r.rating]));
}

/**
 * "Never serve me this again." Every path that PUTS a recipe into a plan must consult this, not
 * just the day selector — the protein rebalancer and the nutrient boost both re-pick dishes on
 * their own, and a ban that only covers one of the three is not a ban. (It didn't: a one-starred
 * breakfast came back in 5 of 25 weeks, swapped in by the protein lever.)
 *
 * A ban is a preference, so each caller decides its own fallback. Where the fallback is "keep the
 * meal that's already there", skipping is free. Where it's "leave the slot empty", it must relax.
 */
export function bannedForUser(profile: UserProfile, name: string): boolean {
  const list = profile.mealRatings;
  if (!list?.length) return false;
  const lower = name.toLowerCase();
  return list.some((r) => r.rating === 1 && r.name.toLowerCase() === lower);
}

export function exclusionTokens(profile: UserProfile): string[] {
  return parseExclusionTokens(profile.allergies, profile.dislikes);
}

const CUISINE_ALIASES: [RegExp, Cuisine][] = [
  [/mediterran|greek/, "mediterranean"],
  [/asian|chinese|japanese|thai|korean|stir.?fry|teriyaki/, "asian"],
  [/mexican|latin|tex.?mex|taco/, "mexican"],
  [/italian|pasta/, "italian"],
  [/middle.?eastern|lebanese|turkish|shawarma|moroccan/, "middle_eastern"],
  [/indian|curry|tikka|masala/, "indian"],
  [/american|classic|comfort/, "american"],
];

export function normalizeCuisine(input: string | null): Cuisine | undefined {
  if (!input) return undefined;
  const s = input.toLowerCase();
  for (const [re, c] of CUISINE_ALIASES) if (re.test(s)) return c;
  return undefined;
}

export function mergeDislikes(current: string, add: string[]): string {
  const existing = current ? current.split(",").map((s) => s.trim()).filter(Boolean) : [];
  return [...new Set([...existing, ...add.map((s) => s.trim().toLowerCase())])]
    .filter(Boolean)
    .join(", ");
}

export const fiberOn = (op: Operation) => op.targetFiber != null && op.targetFiber > 0;

// The nutritionist default: keep the day on its macro targets. The LLM only turns
// this off (preserveMacros === false) when the user signals a treat / doesn't care
// about macros this time. Omitted/null → default on.
export const keepMacros = (op: Operation) => op.preserveMacros !== false;
