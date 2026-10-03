// nutrition, browser-safe: no USDA table, no ingredient data.
// V1 D5a part 3 (2026-10-03). Only what someone outside this folder uses is here; everything else in
// the folder is private, and check:boundaries fails an import that reaches past this file.
export { gramsFor } from "./units";
export {
  computeTargets, bmr, hydrationTarget, explainTargets, explainHydration, CALORIE_FLOOR, DEFAULT_CALORIE_FLOOR,
  BODY_LIMITS, bodyStatProblems, bodyStatMessage, isRealBody, referenceWeightKg, type Activity,
} from "./targets";
export { groupByAisle, aisleFor, AISLE_ORDER, type Aisle } from "./grocery";
