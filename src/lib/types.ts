import { z } from "zod";

export const MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack"] as const;
export const DAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

export const IngredientSchema = z.object({
  name: z.string(),
  quantity: z.string(),
});

export const MealSchema = z.object({
  name: z.string(),
  type: z.enum(MEAL_TYPES),
  description: z.string(),
  calories: z.number(),
  proteinGrams: z.number(),
  carbsGrams: z.number(),
  fatGrams: z.number(),
  fiberGrams: z.number().optional(),
  timeMinutes: z.number(),
  ingredients: z.array(IngredientSchema),
  steps: z.array(z.string()),
});

export const DayPlanSchema = z.object({
  day: z.enum(DAYS),
  meals: z.array(MealSchema),
});

export const WeekPlanSchema = z.object({
  days: z.array(DayPlanSchema),
  weekSummary: z.string(),
});

// The assistant returns only the days it modified (cheaper and far more
// reliable than regenerating the whole week); the server merges them in.
export const AssistantResponseSchema = z.object({
  reply: z.string(),
  changedDays: z.array(DayPlanSchema),
});

// The assistant is tool-calling: the LLM emits a REPLY plus a list of OPERATIONS
// (tool calls) that the database executes. This composes any request ("cheaper and
// vegetarian and no onions" = one turn, several ops) and keeps the LLM general —
// no hardcoded phrase rules. Every field is present (nullable where a given tool
// doesn't use it) so the JSON schema stays strict for the local model.
export const OperationSchema = z.object({
  tool: z.enum([
    "update_profile", // persist week-wide settings, then rebuild the week
    "regenerate_week", // rebuild the whole week (optional cuisine / fiber bias)
    "regenerate_day", // rebuild ONE day with optional per-day diet/calories/cuisine (not persisted)
    "swap_meal", // replace one meal with a specific named dish
    "answer", // no change — just answering a question
  ]),
  day: z.enum(DAYS).nullable(),
  mealType: z.enum(MEAL_TYPES).nullable(),
  dish: z.string().nullable(), // for swap_meal, e.g. "cottage cheese pancakes"
  cuisine: z.string().nullable(),
  diet: z.enum(["none", "vegetarian", "vegan", "keto", "mediterranean"]).nullable(),
  budget: z.enum(["low", "medium", "high"]).nullable(),
  excludeFoods: z.array(z.string()),
  // "I have chicken, rice and broccoli" → bias selection toward recipes that use
  // these on-hand ingredients. Optional; omit/[] when not relevant.
  useIngredients: z.array(z.string()).optional(),
  targetCalories: z.number().nullable(),
  targetProtein: z.number().nullable(), // grams/day; the plan re-solves to hit it
  targetCarbs: z.number().nullable(),
  targetFat: z.number().nullable(),
  targetFiber: z.number().nullable(),
  // "I'm low on iron" / "boost my vitamin D" → bias meal selection toward foods dense in
  // this nutrient, while the macro engine still holds calories and protein on target.
  boostNutrient: z
    .enum(["iron", "calcium", "magnesium", "potassium", "zinc", "vitD", "vitC", "folate", "b12"])
    .nullable()
    .optional(),
  maxCookTime: z.number().nullable(),
  // LLM-controlled intent: when swapping/regenerating, should the day stay on the
  // user's macro targets (the engine rebalances the other meals to hold protein/
  // calories/etc.)? Default = yes (the nutritionist default). The model sets this
  // false only when the user signals a treat / "don't care about macros this time".
  // Omitted/null = default (preserve) — keeps the small model's job simple.
  preserveMacros: z.boolean().nullable().optional(),
});

export const AssistantTurnSchema = z.object({
  reply: z.string(), // natural, friendly message shown to the user
  operations: z.array(OperationSchema),
});

export type Ingredient = z.infer<typeof IngredientSchema>;
export type Meal = z.infer<typeof MealSchema>;
export type DayPlan = z.infer<typeof DayPlanSchema>;
export type WeekPlan = z.infer<typeof WeekPlanSchema>;
export type AssistantResponse = z.infer<typeof AssistantResponseSchema>;
export type Operation = z.infer<typeof OperationSchema>;
export type AssistantTurn = z.infer<typeof AssistantTurnSchema>;

export interface UserProfile {
  goal: "lose_weight" | "maintain" | "build_muscle";
  diet: "none" | "vegetarian" | "vegan" | "keto" | "mediterranean";
  allergies: string;
  dislikes: string;
  budget: "low" | "medium" | "high";
  mealsPerDay: 3 | 4;
  // Daily targets the plan must hit. Defaulted in onboarding so the user doesn't
  // have to set them every time; enforced in code during generation.
  targetCalories: number;
  proteinGrams: number;
  carbsGrams: number;
  fatGrams: number;
  // Simplicity controls, also defaulted + enforced in generation.
  maxCookTime: number; // minutes per meal (approx upper bound)
  maxIngredients: number; // ingredients per meal (upper bound)
}

// Sensible starting values for a general healthy adult. Prefilled in onboarding
// and used as fallbacks for any older saved profile that predates these fields.
export const DEFAULT_TARGETS = {
  targetCalories: 2000,
  proteinGrams: 150,
  carbsGrams: 200,
  fatGrams: 65,
  maxCookTime: 30,
  maxIngredients: 8,
} as const;

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}
