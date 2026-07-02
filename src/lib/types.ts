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

export const AssistantResponseSchema = z.object({
  reply: z.string(),
  planChanged: z.boolean(),
  plan: WeekPlanSchema,
});

export type Ingredient = z.infer<typeof IngredientSchema>;
export type Meal = z.infer<typeof MealSchema>;
export type DayPlan = z.infer<typeof DayPlanSchema>;
export type WeekPlan = z.infer<typeof WeekPlanSchema>;
export type AssistantResponse = z.infer<typeof AssistantResponseSchema>;

export interface UserProfile {
  goal: "lose_weight" | "maintain" | "build_muscle";
  diet: "none" | "vegetarian" | "vegan" | "keto" | "mediterranean";
  allergies: string;
  dislikes: string;
  budget: "low" | "medium" | "high";
  mealsPerDay: 3 | 4;
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}
