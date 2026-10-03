/**
 * The plan engine, by its historical name. Since V1 milestone A3 (2026-10-03) the engine lives in
 * src/lib/plan/ — library, rules, rebalance, select, batch, report, boost, candidates, execute — and
 * this file only re-exports its public surface, so every "@/lib/recipeDb" import keeps working
 * unchanged. Add code in plan/, not here. The recipes themselves are in src/lib/data/seeds.ts.
 */
export * from "./plan";
// The recipe vocabulary lives with the data it describes (src/lib/data/seeds.ts). Re-exported so
// every "@/lib/recipeDb" import that used these names keeps working unchanged.
export type { Cuisine, DietTag, MainProtein, Recipe } from "./data";
