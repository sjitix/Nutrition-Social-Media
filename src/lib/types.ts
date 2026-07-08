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

// The LLM parses a chat message into this structured edit; the database then
// executes it (re-selecting recipes). Keeps plans accurate/cheap while letting
// the user talk naturally. Every field is filled (nullable where not relevant).
export const EditIntentSchema = z.object({
  reply: z.string(), // short friendly confirmation/answer to show the user
  changePlan: z.boolean(), // false = just answering a question
  scope: z.enum(["week", "day"]).nullable(), // whole week or a single day
  day: z.enum(DAYS).nullable(), // set when scope is "day"
  mealType: z.enum(MEAL_TYPES).nullable(), // set when swapping one meal
  swapToDish: z.string().nullable(), // a specific dish the user wants, e.g. "cottage cheese pancakes"
  cuisine: z.string().nullable(), // e.g. "asian", "italian" — or null
  diet: z.enum(["none", "vegetarian", "vegan", "keto", "mediterranean"]).nullable(),
  excludeFoods: z.array(z.string()), // foods to avoid, e.g. ["onions"]
  budget: z.enum(["low", "medium", "high"]).nullable(),
  maxCookTime: z.number().nullable(), // minutes
  targetCalories: z.number().nullable(),
  targetFiber: z.number().nullable(), // grams per day (average)
});

export type Ingredient = z.infer<typeof IngredientSchema>;
export type Meal = z.infer<typeof MealSchema>;
export type DayPlan = z.infer<typeof DayPlanSchema>;
export type WeekPlan = z.infer<typeof WeekPlanSchema>;
export type AssistantResponse = z.infer<typeof AssistantResponseSchema>;
export type EditIntent = z.infer<typeof EditIntentSchema>;

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
