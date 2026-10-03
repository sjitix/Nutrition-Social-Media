// nutrition — the maths: units, micronutrients, targets, allergen matching, safety, grocery aisles.
// V1 D5a part 3 (2026-10-03). Only what someone outside this folder uses is here; everything else in
// the folder is private, and check:boundaries fails an import that reaches past this file.
export { gramsFor } from "./units";
export { microsForIngredients, microDensity, DAILY_REFERENCE, MICRO_KEYS, MICRO_LABEL, MICRO_UNIT, type MicroKey, type Micros } from "./nutrients";
export {
  computeTargets, bmr, hydrationTarget, explainTargets, explainHydration, CALORIE_FLOOR, DEFAULT_CALORIE_FLOOR,
  BODY_LIMITS, bodyStatProblems, bodyStatMessage, isRealBody, referenceWeightKg, type Activity,
} from "./targets";
export { haystackBlocked, parseExclusionTokens, dietTagConflicts, wordMatches, expandExclusion, EXCLUSION_CATEGORIES } from "./exclusions";
export { redFlag, CRISIS_REPLY, URGENT_REPLY } from "./safety";
export { groupByAisle, aisleFor, AISLE_ORDER, type Aisle } from "./grocery";
