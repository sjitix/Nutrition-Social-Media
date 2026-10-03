/**
 * Sensible starting values for a general healthy adult. Prefilled in onboarding and used as fallbacks
 * for any older saved profile that predates these fields.
 *
 * Its own file so the browser can have it WITHOUT zod: it sat in types.ts, which builds every schema
 * at load, and onboarding — the one client component that needs it — shipped the whole of zod for
 * six numbers (found by the D5a review, 2026-10-03). types.ts re-exports it, so no caller changed.
 */
export const DEFAULT_TARGETS = {
  targetCalories: 2000,
  proteinGrams: 150,
  carbsGrams: 200,
  fatGrams: 65,
  maxCookTime: 30,
  maxIngredients: 8,
} as const;
