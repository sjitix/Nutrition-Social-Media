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

/**
 * Lowest daily intake we will ever plan for. Below this you cannot eat enough nutrients.
 * Exported because scale_portions has to honour the same floor: "make it all much smaller",
 * said enough times, must not walk someone into a starvation diet one polite step at a time.
 */
export const CALORIE_FLOOR: Record<Sex, number> = { female: 1200, male: 1500 };
/** When we don't know someone's sex, use the lower floor — under-restricting is the safe error. */
export const DEFAULT_CALORIE_FLOOR = CALORIE_FLOOR.female;

/**
 * The bodies these equations are for. Mifflin-St Jeor was fitted on adults; past these limits it
 * extrapolates into nonsense, and the executor used to store and SAY the result: age 500 gave "your
 * resting burn is about -570 kcal", 5000 kg gave 79,020 kcal and 8 kg of protein a day, and a weight
 * of -80 kg prescribed -2.3 L of fluid (found by the D5b property sweep, 2026-10-03). Under 18,
 * growth changes the numbers, and setting a child's calorie deficit is not this app's job.
 */
export const BODY_LIMITS = {
  age: { min: 18, max: 100, unit: "years" },
  heightCm: { min: 120, max: 230, unit: "cm" },
  weightKg: { min: 30, max: 300, unit: "kg" },
} as const;
export type BodyStat = keyof typeof BODY_LIMITS;

/** The stats given that are not real numbers inside BODY_LIMITS. A stat not given is not a problem. */
export function bodyStatProblems(s: Partial<Record<BodyStat, number>>): BodyStat[] {
  return (Object.keys(BODY_LIMITS) as BodyStat[]).filter((k) => {
    const v = s[k];
    return v != null && (!Number.isFinite(v) || v < BODY_LIMITS[k].min || v > BODY_LIMITS[k].max);
  });
}

/**
 * What no adult body measures: outside this, a stat is a typo or the wrong unit ("1.8" for a height,
 * "0"). Between this and BODY_LIMITS is a REAL body the equation was not validated for: someone 115 cm
 * tall, 101 years old or 310 kg is not mistaken, and was told their stat "doesn't look right" (D5b
 * review). They are told the truth instead: this maths was not made for them, and who can do better.
 */
const PLAUSIBLE: Record<BodyStat, { min: number; max: number }> = {
  age: { min: 1, max: 125 },
  heightCm: { min: 50, max: 280 },
  weightKg: { min: 15, max: 700 },
};

const STAT_NAME: Record<BodyStat, string> = { age: "age", heightCm: "height", weightKg: "weight" };
/** "a", "a and b", "a, b and c". */
const listOf = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
/** Is this out-of-range stat a real body (rather than a typo)? */
export const isRealBody = (k: BodyStat, v: number | undefined) =>
  v != null && Number.isFinite(v) && v >= PLAUSIBLE[k].min && v <= PLAUSIBLE[k].max;

/** What to tell the person about the stats bodyStatProblems found — for the user, not a log. */
export function bodyStatMessage(problems: BodyStat[], s: Partial<Record<BodyStat, number>>): string {
  if (problems.includes("age") && isRealBody("age", s.age) && (s.age as number) < BODY_LIMITS.age.min)
    return "I can only work out targets for adults. Under 18, growth changes the numbers — a GP or a registered dietitian is the right person to set them.";
  const typos = problems.filter((k) => !isRealBody(k, s[k]));
  const real = problems.filter((k) => isRealBody(k, s[k]));
  const parts: string[] = [];
  if (typos.length) {
    const ranges = typos.map((k) => `${STAT_NAME[k]} ${BODY_LIMITS[k].min}–${BODY_LIMITS[k].max} ${BODY_LIMITS[k].unit}`);
    parts.push(`Your ${listOf(typos.map((k) => STAT_NAME[k]))} ${typos.length > 1 ? "don't" : "doesn't"} look right — I can work targets out for ${listOf(ranges)}.`);
  }
  if (real.length) {
    const what = real.map((k) => `${k === "age" ? "an age" : `a ${STAT_NAME[k]}`} of ${s[k]} ${BODY_LIMITS[k].unit}`);
    parts.push(`The equation I use isn't validated for ${listOf(what)}, so I won't guess. A GP or a registered dietitian can set targets that fit you.`);
  }
  return parts.join(" ");
}

/**
 * The weight a per-kilo figure is OF: body weight, capped at a BMI of 30. Protein and body water both
 * follow lean mass, not total mass, so per kg of total weight they overstate a larger body's needs (a
 * 230 kg person was set 460 g of protein; 300 kg was told 8.4 L of fluid a day). Below BMI 30, and
 * with no height to work from, it is the weight itself.
 */
export function referenceWeightKg(weightKg: number, heightCm: number | undefined): number {
  if (heightCm == null || !Number.isFinite(heightCm) || heightCm <= 0) return weightKg;
  return Math.min(weightKg, 30 * (heightCm / 100) ** 2);
}

/** A stat forced into its limits: what the arithmetic below uses, so it can never return NaN or a
 *  negative. Callers refuse an out-of-range stat BEFORE this (bodyStatProblems); this is the floor
 *  under a caller that forgets. */
const within = (k: BodyStat, v: number) =>
  Number.isFinite(v) ? Math.min(BODY_LIMITS[k].max, Math.max(BODY_LIMITS[k].min, v)) : BODY_LIMITS[k].min;

/** Mifflin-St Jeor resting metabolic rate. */
export function bmr({ age, heightCm, weightKg, sex }: Pick<TargetInput, "age" | "heightCm" | "weightKg" | "sex">): number {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  return sex === "male" ? base + 5 : base - 161;
}

export function computeTargets(raw: TargetInput): Targets {
  const input: TargetInput = {
    ...raw,
    age: within("age", raw.age),
    heightCm: within("heightCm", raw.heightCm),
    weightKg: within("weightKg", raw.weightKg),
  };
  const b = bmr(input);
  const tdee = b * ACTIVITY_FACTOR[input.activity];

  // Goal adjustment. A ~20% deficit loses roughly 0.5 kg/week without wrecking adherence;
  // a ~10% surplus builds muscle without excessive fat gain.
  let calories =
    input.goal === "lose_weight" ? tdee * 0.8 : input.goal === "build_muscle" ? tdee * 1.1 : tdee;

  // Never plan below the floor — you cannot hit micronutrient needs on less.
  let clampedTo: number | undefined;
  // Fall back to the lower floor when sex is anything but male/female (unknown/other) — otherwise the
  // safety floor is silently skipped and a small person on a deficit can be walked below it.
  const floor = CALORIE_FLOOR[input.sex] ?? DEFAULT_CALORIE_FLOOR;
  if (calories < floor) {
    clampedTo = floor;
    calories = floor;
  }

  // Protein: higher in a deficit (protects muscle) and when building. g/kg bodyweight.
  // The weight it is per kg OF is capped at a BMI of 30: protein tracks lean mass, not total mass, and
  // per kg of total weight a 230 kg person was set 460 g a day — 68% of their calories, with carbs
  // forced to zero and the macros no longer adding up to the calories (D5b). Below BMI 30 this
  // changes nothing.
  const proteinPerKg = input.goal === "lose_weight" ? 2.0 : input.goal === "build_muscle" ? 1.9 : 1.6;
  const referenceKg = referenceWeightKg(input.weightKg, input.heightCm);

  // Fat at 25% of calories (a sane floor for hormones), carbs take the remainder.
  const fatGrams = Math.round((calories * 0.25) / 9);
  // …and protein never takes more than the calories fat leaves, so the macros always sum to the target.
  const proteinGrams = Math.min(Math.round(referenceKg * proteinPerKg), Math.floor((calories - fatGrams * 9) / 4));
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

/**
 * Daily fluid, from body weight and how hard the person trains.
 *
 * Method: ~35 mL per kg of body weight for the baseline, which is the figure clinical dietetics
 * uses for healthy adults under 65, plus an allowance for training losses. Roughly a fifth of what
 * you take in comes from food, so the number we ask someone to DRINK is 80% of the total — telling
 * a 70 kg person to drink 2.5 L when 0.5 L of it is in their dinner is telling them to drink too
 * much.
 *
 * Ranges, not points. Sweat rate varies several-fold between people and with the weather, so a
 * single number would be false precision. We give the band and say what moves it.
 */
export interface Hydration {
  totalMl: number; // everything: drinks + the water in food
  drinksMl: number; // what to actually drink
  lowMl: number; // the band we quote, +/- 10%
  highMl: number;
  perKgMl: number;
  activityMl: number; // the training allowance inside totalMl
}

/** mL added per day for training losses, by activity level. */
const SWEAT_ALLOWANCE: Record<Activity, number> = {
  sedentary: 0,
  light: 250,
  moderate: 500,
  active: 750,
  very_active: 1000,
};

const ML_PER_KG = 35;
const FROM_FOOD = 0.2; // a fifth of total water intake arrives as food

export function hydrationTarget(weightKg: number, activity: Activity): Hydration {
  const perKgMl = Math.round(within("weightKg", weightKg) * ML_PER_KG);
  const activityMl = SWEAT_ALLOWANCE[activity];
  const totalMl = perKgMl + activityMl;
  const drinksMl = Math.round((totalMl * (1 - FROM_FOOD)) / 50) * 50; // to a tidy 50 mL
  return {
    totalMl,
    drinksMl,
    lowMl: Math.round((drinksMl * 0.9) / 50) * 50,
    highMl: Math.round((drinksMl * 1.1) / 50) * 50,
    perKgMl,
    activityMl,
  };
}

const L = (ml: number) => (ml / 1000).toFixed(1).replace(/\.0$/, "");

/** The engine speaks these numbers; the model never invents them. */
export function explainHydration(h: Hydration, weightKg: number, activity: Activity): string {
  let s = `At ${weightKg} kg, aim for about ${L(h.drinksMl)} L of fluid a day — call it ${L(h.lowMl)} to ${L(h.highMl)} L.`;
  s += ` That's ${ML_PER_KG} mL per kg`;
  if (h.activityMl) s += `, plus ${h.activityMl} mL for your training`;
  s += `, less the ~20% of your water that comes from food.`;
  if (activity === "active" || activity === "very_active")
    s += ` On heavy or hot training days you'll need more than that — drink to thirst and check your urine is pale.`;
  s += ` Water, tea and coffee all count.`;
  return s;
}

/** A plain-English explanation. The engine speaks these numbers; the model never invents them. */
export function explainTargets(t: Targets, input: TargetInput): string {
  const goalWord =
    input.goal === "lose_weight" ? "a ~20% deficit to lose fat" : input.goal === "build_muscle" ? "a ~10% surplus to build muscle" : "maintenance";
  let s = `Your resting burn is about ${t.bmr} kcal and, at your activity level, you burn roughly ${t.tdee} kcal a day. For ${goalWord} I've set ${t.calories} kcal, ${t.proteinGrams}g protein, ${t.carbsGrams}g carbs and ${t.fatGrams}g fat.`;
  if (t.clampedTo) s += ` I stopped at ${t.clampedTo} kcal rather than go lower — below that it's very hard to get enough nutrients.`;
  return s;
}
