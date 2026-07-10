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
  // How many servings this ingredient list makes. Macros are per SERVING, but a batch
  // recipe's ingredients (a muffin tin, a tray of protein balls) make several. Nutrients
  // derived from the ingredients must be divided by this or a single muffin claims the
  // iron of the whole tin.
  servings: z.number().optional(),
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
// no hardcoded phrase rules.
//
// EVERY FIELD IS OPTIONAL except `tool`. It used to be "present but nullable", which meant
// 76% of the tokens the model emitted were nulls — and a 1.5B leaks memorised values into
// slots it is forced to write. It answered "make Tuesday vegetarian" with diet:null but
// targetFiber:30 and excludeFoods:["bake","roast","oven"]. Emitting only the fields you mean
// removes the opportunity entirely. Missing == not requested.
export const OperationSchema = z.object({
  tool: z.enum([
    "update_profile", // persist week-wide settings, then rebuild the week
    "regenerate_week", // rebuild the whole week (optional cuisine / fiber bias)
    "regenerate_day", // rebuild ONE day with optional per-day diet/calories/cuisine (not persisted)
    "swap_meal", // replace one meal with a specific named dish
    "compute_targets", // work out calories/protein/carbs/fat from body + goal, then rebuild
    "log_meal", // "I ate a burger for lunch" -> re-solve the REST of that day
    "weekly_report", // "how am I doing?" -> computed macro + micronutrient summary, no change
    "eating_out", // "I'm out for dinner Friday" -> reserve calories, lighten the rest of the day
    "explain_meal", // "why is this in my plan?" -> computed reasons, no change
    "substitute_ingredient", // "I have no greek yogurt" -> safe swaps + the macro cost, no change
    "symptom_check", // "I'm always tired" -> check the associated nutrients against THEIR week
    "lock_meal", // "never change my Sunday roast" -> pin it; every rebuild puts it back
    "unlock_meal", // "you can change Sunday again"
    "answer", // no change — just answering a question
  ]),
  day: z.enum(DAYS).nullable().optional(),
  mealType: z.enum(MEAL_TYPES).nullable().optional(),
  dish: z.string().nullable().optional(), // for swap_meal, e.g. "cottage cheese pancakes"
  cuisine: z.string().nullable().optional(),
  diet: z.enum(["none", "vegetarian", "vegan", "keto", "mediterranean"]).nullable().optional(),
  budget: z.enum(["low", "medium", "high"]).nullable().optional(),
  excludeFoods: z.array(z.string()).optional(),
  // "I have chicken, rice and broccoli" → bias selection toward recipes that use
  // these on-hand ingredients. Optional; omit/[] when not relevant.
  useIngredients: z.array(z.string()).optional(),
  targetCalories: z.number().nullable().optional(),
  targetProtein: z.number().nullable().optional(), // grams/day; the plan re-solves to hit it
  targetCarbs: z.number().nullable().optional(),
  targetFat: z.number().nullable().optional(),
  targetFiber: z.number().nullable().optional(),
  // "I'm low on iron" / "boost my vitamin D" → bias meal selection toward foods dense in
  // this nutrient, while the macro engine still holds calories and protein on target.
  boostNutrient: z
    .enum(["iron", "calcium", "magnesium", "potassium", "zinc", "vitD", "vitC", "folate", "b12"])
    .nullable()
    .optional(),
  maxCookTime: z.number().nullable().optional(),
  // compute_targets: the facts the model collects. The ENGINE does the arithmetic
  // (Mifflin-St Jeor + activity factor + goal adjustment); the model never computes.
  age: z.number().nullable().optional(),
  heightCm: z.number().nullable().optional(),
  weightKg: z.number().nullable().optional(),
  sex: z.enum(["male", "female"]).nullable().optional(),
  activity: z.enum(["sedentary", "light", "moderate", "active", "very_active"]).nullable().optional(),
  goal: z.enum(["lose_weight", "maintain", "build_muscle"]).nullable().optional(),
  // log_meal: what the user ACTUALLY ate. If the dish isn't in the library they can tell us the
  // calories; if they can't, we ask rather than guess.
  loggedCalories: z.number().nullable().optional(),
  loggedProtein: z.number().nullable().optional(),
  // eating_out: the user's own guess at the restaurant meal, when they offer one. Omitted means
  // the engine reserves a typical restaurant main and SAYS that it estimated.
  estimatedCalories: z.number().nullable().optional(),
  // substitute_ingredient: the ingredient the user has run out of, as they said it.
  ingredient: z.string().nullable().optional(),
  // symptom_check: what the user reported, in their own words. The engine matches it; the
  // model must never map a symptom to a nutrient itself.
  symptom: z.string().nullable().optional(),
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

/**
 * A meal the user pinned. Stored by NAME, not by reference into the plan, so it survives a
 * regeneration that would otherwise have discarded the dish entirely.
 */
export interface LockedMeal {
  day: (typeof DAYS)[number];
  mealType: (typeof MEAL_TYPES)[number];
  name: string;
}

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
  // "Never change my Sunday roast." Pinned meals are re-imposed after every rebuild. A pin
  // overrides PREFERENCES (cook time, budget, variety); it never overrides diet or an allergy.
  lockedMeals?: LockedMeal[];
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
