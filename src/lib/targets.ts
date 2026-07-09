/**
 * Work out a person's daily targets from their body and their goal.
 *
 * Nobody knows their own numbers. Asking a user to type "2000 kcal, 150g protein" is asking
 * them to do a nutritionist's job. Give age/height/weight/sex/activity/goal and this returns
 * the targets — deterministically. The model collects the facts; this file does the arithmetic,
 * because the model does no arithmetic, ever.
 *
 * Method: Mifflin-St Jeor BMR (the standard, and more accurate than Harris-Benedict for modern
 * populations) x an activity factor = TDEE, then a goal adjustment.
 */

export type Sex = "male" | "female";
export type Activity = "sedentary" | "light" | "moderate" | "active" | "very_active";
export type Goal = "lose_weight" | "maintain" | "build_muscle";

export interface TargetInput {
  age: number;
  heightCm: number;
  weightKg: number;
  sex: Sex;
  activity: Activity;
  goal: Goal;
}

export interface Targets {
  calories: number;
  proteinGrams: number;
  carbsGrams: number;
  fatGrams: number;
  bmr: number;
  tdee: number;
  /** Set when a safety floor changed the answer, so the engine can disclose it. */
  clampedTo?: number;
}

const ACTIVITY_FACTOR: Record<Activity, number> = {
  sedentary: 1.2, // desk job, little exercise
  light: 1.375, // 1-3 sessions/week
  moderate: 1.55, // 3-5 sessions/week
  active: 1.725, // 6-7 sessions/week
  very_active: 1.9, // physical job or twice-daily training
};

/** Lowest daily intake we will ever plan for. Below this you cannot eat enough nutrients. */
const CALORIE_FLOOR: Record<Sex, number> = { female: 1200, male: 1500 };

/** Mifflin-St Jeor resting metabolic rate. */
export function bmr({ age, heightCm, weightKg, sex }: Pick<TargetInput, "age" | "heightCm" | "weightKg" | "sex">): number {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  return sex === "male" ? base + 5 : base - 161;
}

export function computeTargets(input: TargetInput): Targets {
  const b = bmr(input);
  const tdee = b * ACTIVITY_FACTOR[input.activity];

  // Goal adjustment. A ~20% deficit loses roughly 0.5 kg/week without wrecking adherence;
  // a ~10% surplus builds muscle without excessive fat gain.
  let calories =
    input.goal === "lose_weight" ? tdee * 0.8 : input.goal === "build_muscle" ? tdee * 1.1 : tdee;

  // Never plan below the floor — you cannot hit micronutrient needs on less.
  let clampedTo: number | undefined;
  const floor = CALORIE_FLOOR[input.sex];
  if (calories < floor) {
    clampedTo = floor;
    calories = floor;
  }

  // Protein: higher in a deficit (protects muscle) and when building. g/kg bodyweight.
  const proteinPerKg = input.goal === "lose_weight" ? 2.0 : input.goal === "build_muscle" ? 1.9 : 1.6;
  const proteinGrams = Math.round(input.weightKg * proteinPerKg);

  // Fat at 25% of calories (a sane floor for hormones), carbs take the remainder.
  const fatGrams = Math.round((calories * 0.25) / 9);
  const carbsGrams = Math.max(0, Math.round((calories - proteinGrams * 4 - fatGrams * 9) / 4));

  return {
    calories: Math.round(calories / 10) * 10, // round to a tidy 10 kcal
    proteinGrams,
    carbsGrams,
    fatGrams,
    bmr: Math.round(b),
    tdee: Math.round(tdee),
    clampedTo,
  };
}

/** A plain-English explanation. The engine speaks these numbers; the model never invents them. */
export function explainTargets(t: Targets, input: TargetInput): string {
  const goalWord =
    input.goal === "lose_weight" ? "a ~20% deficit to lose fat" : input.goal === "build_muscle" ? "a ~10% surplus to build muscle" : "maintenance";
  let s = `Your resting burn is about ${t.bmr} kcal and, at your activity level, you burn roughly ${t.tdee} kcal a day. For ${goalWord} I've set ${t.calories} kcal, ${t.proteinGrams}g protein, ${t.carbsGrams}g carbs and ${t.fatGrams}g fat.`;
  if (t.clampedTo) s += ` I stopped at ${t.clampedTo} kcal rather than go lower — below that it's very hard to get enough nutrients.`;
  return s;
}
