/**
 * The plan engine's public surface — the names recipeDb.ts exported before it was split (V1 A3,
 * 2026-10-03), and nothing more. Everything else in this folder is private to it: rewrite, rename or
 * delete it freely, as long as these promises hold. docs/v1/02-module-map.md §4 L3 is the contract.
 */
export { recipeToMeal, RECIPES, recipeMicros } from "./library";
export { ratingMap } from "./rules";
export { rebalanceWeek } from "./rebalance";
export { findRecipe, withSeed, newReport, reportNotes, selectWeekFromDb, selectDay } from "./select";
export type { SelectionReport } from "./select";
export { keepDays, freezesWell, selectBatchWeek, rebalanceBatchWeek, buildWeek } from "./batch";
export { weeklyReportNote } from "./report";
export { selectConditionAwareWeek } from "./boost";
export { swapCandidates } from "./candidates";
export { applyOperations, previewOperations } from "./execute";
