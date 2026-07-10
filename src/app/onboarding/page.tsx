"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Wordmark } from "@/components/icons";
import { saveChat, savePlan, saveProfile } from "@/lib/storage";
import { DEFAULT_TARGETS, type BodyStats, type UserProfile } from "@/lib/types";
import { computeTargets, type Activity } from "@/lib/targets";

const ACTIVITIES: { value: Activity; label: string }[] = [
  { value: "sedentary", label: "Desk job, little exercise" },
  { value: "light", label: "Light (1–3×/week)" },
  { value: "moderate", label: "Moderate (3–5×/week)" },
  { value: "active", label: "Active (6–7×/week)" },
  { value: "very_active", label: "Very active / physical job" },
];

const GOALS: { value: UserProfile["goal"]; label: string; hint: string }[] = [
  { value: "lose_weight", label: "Lose weight", hint: "Moderate calorie deficit" },
  { value: "maintain", label: "Eat healthier", hint: "Balanced maintenance" },
  { value: "build_muscle", label: "Build muscle", hint: "High protein surplus" },
];

const DIETS: { value: UserProfile["diet"]; label: string }[] = [
  { value: "none", label: "No restrictions" },
  { value: "vegetarian", label: "Vegetarian" },
  { value: "vegan", label: "Vegan" },
  { value: "keto", label: "Keto" },
  { value: "mediterranean", label: "Mediterranean" },
];

const BUDGETS: { value: UserProfile["budget"]; label: string }[] = [
  { value: "low", label: "Tight" },
  { value: "medium", label: "Normal" },
  { value: "high", label: "Flexible" },
];

export default function OnboardingPage() {
  const router = useRouter();
  const [goal, setGoal] = useState<UserProfile["goal"]>("maintain");
  const [diet, setDiet] = useState<UserProfile["diet"]>("none");
  const [budget, setBudget] = useState<UserProfile["budget"]>("medium");
  const [mealsPerDay, setMealsPerDay] = useState<3 | 4>(3);
  const [allergies, setAllergies] = useState("");
  const [dislikes, setDislikes] = useState("");
  const [targetCalories, setTargetCalories] = useState<number>(DEFAULT_TARGETS.targetCalories);
  const [proteinGrams, setProteinGrams] = useState<number>(DEFAULT_TARGETS.proteinGrams);
  const [carbsGrams, setCarbsGrams] = useState<number>(DEFAULT_TARGETS.carbsGrams);
  const [fatGrams, setFatGrams] = useState<number>(DEFAULT_TARGETS.fatGrams);
  const [maxCookTime, setMaxCookTime] = useState<number>(DEFAULT_TARGETS.maxCookTime);
  const [maxIngredients, setMaxIngredients] = useState<number>(DEFAULT_TARGETS.maxIngredients);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Optional body stats. If given, we compute the targets (Mifflin-St Jeor) instead of asking the
  // user to guess calorie numbers — a nutritionist's job — and remember them so hydration and any
  // later re-calc never has to ask again. Empty = the user set macros by hand, which still works.
  const [age, setAge] = useState<string>("");
  const [heightCm, setHeightCm] = useState<string>("");
  const [weightKg, setWeightKg] = useState<string>("");
  const [sex, setSex] = useState<"male" | "female" | "">("");
  const [activity, setActivity] = useState<Activity | "">("");
  const [computed, setComputed] = useState(false);

  const bodyStatsComplete = !!(age && heightCm && weightKg && sex && activity);

  function calculateTargets() {
    if (!bodyStatsComplete) return;
    const t = computeTargets({
      age: Number(age), heightCm: Number(heightCm), weightKg: Number(weightKg),
      sex: sex as "male" | "female", activity: activity as Activity, goal,
    });
    setTargetCalories(t.calories);
    setProteinGrams(t.proteinGrams);
    setCarbsGrams(t.carbsGrams);
    setFatGrams(t.fatGrams);
    setComputed(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const bodyStats: BodyStats | undefined = bodyStatsComplete
      ? {
          age: Number(age), heightCm: Number(heightCm), weightKg: Number(weightKg),
          sex: sex as "male" | "female", activity: activity as Activity,
        }
      : undefined;
    const profile: UserProfile = {
      goal,
      diet,
      allergies,
      dislikes,
      budget,
      mealsPerDay,
      targetCalories,
      proteinGrams,
      carbsGrams,
      fatGrams,
      maxCookTime,
      maxIngredients,
      ...(bodyStats ? { bodyStats } : {}),
    };
    try {
      const res = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profile),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Something went wrong.");
      saveProfile(profile);
      savePlan(data.plan);
      saveChat([]);
      router.push("/plan");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setLoading(false);
    }
  }

  const optionClass = (selected: boolean) =>
    `cursor-pointer rounded-xl border-2 px-4 py-3 text-left transition ${
      selected
        ? "border-vio bg-lav font-semibold"
        : "border-transparent bg-white hover:border-vio/40"
    }`;

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <Wordmark />
      <h1 className="font-display mt-8 text-4xl font-bold tracking-tight">
        Let&rsquo;s plan your week
      </h1>
      <p className="mt-2 text-mut">A few quick answers — then the AI builds your plan.</p>

      <form onSubmit={handleSubmit} className="mt-10 space-y-10">
        <section>
          <h2 className="mb-3 font-semibold">1. What&rsquo;s your goal?</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            {GOALS.map((g) => (
              <button type="button" key={g.value} onClick={() => setGoal(g.value)} className={optionClass(goal === g.value)}>
                <div>{g.label}</div>
                <div className="text-xs font-normal text-mut">{g.hint}</div>
              </button>
            ))}
          </div>
        </section>

        <section>
          <h2 className="mb-3 font-semibold">2. Any diet?</h2>
          <div className="flex flex-wrap gap-3">
            {DIETS.map((d) => (
              <button type="button" key={d.value} onClick={() => setDiet(d.value)} className={optionClass(diet === d.value)}>
                {d.label}
              </button>
            ))}
          </div>
        </section>

        <section>
          <h2 className="mb-3 font-semibold">3. Allergies?</h2>
          <input
            value={allergies}
            onChange={(e) => setAllergies(e.target.value)}
            placeholder="e.g. peanuts, shellfish — leave empty if none"
            className="w-full rounded-xl border-2 border-transparent bg-white px-4 py-3 outline-none focus:border-vio"
          />
        </section>

        <section>
          <h2 className="mb-3 font-semibold">4. Foods you dislike?</h2>
          <input
            value={dislikes}
            onChange={(e) => setDislikes(e.target.value)}
            placeholder="e.g. mushrooms, olives"
            className="w-full rounded-xl border-2 border-transparent bg-white px-4 py-3 outline-none focus:border-vio"
          />
        </section>

        <section>
          <h2 className="mb-3 font-semibold">5. Budget?</h2>
          <div className="flex gap-3">
            {BUDGETS.map((b) => (
              <button type="button" key={b.value} onClick={() => setBudget(b.value)} className={optionClass(budget === b.value)}>
                {b.label}
              </button>
            ))}
          </div>
        </section>

        <section>
          <h2 className="mb-3 font-semibold">6. Meals per day?</h2>
          <div className="flex gap-3">
            {([3, 4] as const).map((n) => (
              <button type="button" key={n} onClick={() => setMealsPerDay(n)} className={optionClass(mealsPerDay === n)}>
                {n === 3 ? "3 meals" : "3 meals + snack"}
              </button>
            ))}
          </div>
        </section>

        <section>
          <h2 className="mb-1 font-semibold">7. Daily targets</h2>
          <p className="mb-3 text-sm text-mut">
            Don&rsquo;t know your numbers? Give your stats and I&rsquo;ll work them out — or set
            them yourself below. Either way you can adjust any time.
          </p>

          {/* Optional: compute targets from body stats instead of guessing calorie numbers. */}
          <div className="mb-5 rounded-2xl bg-white p-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-mut">Age</span>
                <input type="number" min={0} value={age} onChange={(e) => setAge(e.target.value)}
                  className="w-full rounded-xl border-2 border-transparent bg-bgsoft px-3 py-2 outline-none focus:border-vio" />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-mut">Height (cm)</span>
                <input type="number" min={0} value={heightCm} onChange={(e) => setHeightCm(e.target.value)}
                  className="w-full rounded-xl border-2 border-transparent bg-bgsoft px-3 py-2 outline-none focus:border-vio" />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-mut">Weight (kg)</span>
                <input type="number" min={0} value={weightKg} onChange={(e) => setWeightKg(e.target.value)}
                  className="w-full rounded-xl border-2 border-transparent bg-bgsoft px-3 py-2 outline-none focus:border-vio" />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-mut">Sex</span>
                <select value={sex} onChange={(e) => setSex(e.target.value as "male" | "female" | "")}
                  className="w-full rounded-xl border-2 border-transparent bg-bgsoft px-3 py-2 outline-none focus:border-vio">
                  <option value="">—</option>
                  <option value="female">Female</option>
                  <option value="male">Male</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-mut">Activity</span>
                <select value={activity} onChange={(e) => setActivity(e.target.value as Activity | "")}
                  className="w-full rounded-xl border-2 border-transparent bg-bgsoft px-3 py-2 outline-none focus:border-vio">
                  <option value="">—</option>
                  {ACTIVITIES.map((a) => (
                    <option key={a.value} value={a.value}>{a.label}</option>
                  ))}
                </select>
              </label>
            </div>
            <button type="button" onClick={calculateTargets} disabled={!bodyStatsComplete}
              className="mt-3 rounded-full bg-vio px-4 py-2 text-sm font-bold text-white transition hover:bg-vio-deep disabled:opacity-50">
              {computed ? "Recalculate my targets" : "Calculate my targets"}
            </button>
            {computed && (
              <span className="ml-3 text-sm text-mut">
                Done — {targetCalories} kcal, {proteinGrams}g protein. Tweak below if you like.
              </span>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {(
              [
                { label: "Calories", unit: "kcal", value: targetCalories, set: setTargetCalories, step: 50 },
                { label: "Protein", unit: "g", value: proteinGrams, set: setProteinGrams, step: 5 },
                { label: "Carbs", unit: "g", value: carbsGrams, set: setCarbsGrams, step: 5 },
                { label: "Fat", unit: "g", value: fatGrams, set: setFatGrams, step: 5 },
              ] as const
            ).map((f) => (
              <label key={f.label} className="block">
                <span className="mb-1 block text-sm font-medium">
                  {f.label} <span className="font-normal text-mut">({f.unit})</span>
                </span>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={f.value}
                  onChange={(e) => f.set(Math.max(0, Number(e.target.value)))}
                  className="w-full rounded-xl border-2 border-transparent bg-white px-4 py-3 outline-none focus:border-vio"
                />
              </label>
            ))}
          </div>
        </section>

        <section>
          <h2 className="mb-1 font-semibold">8. Time &amp; simplicity</h2>
          <p className="mb-3 text-sm text-mut">
            Keep meals quick and easy — the plan won&rsquo;t exceed these.
          </p>
          <div className="grid grid-cols-2 gap-4">
            {(
              [
                { label: "Max cook time", unit: "min / meal", value: maxCookTime, set: setMaxCookTime, step: 5 },
                { label: "Max ingredients", unit: "per meal", value: maxIngredients, set: setMaxIngredients, step: 1 },
              ] as const
            ).map((f) => (
              <label key={f.label} className="block">
                <span className="mb-1 block text-sm font-medium">
                  {f.label} <span className="font-normal text-mut">({f.unit})</span>
                </span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={f.value}
                  onChange={(e) => f.set(Math.max(1, Number(e.target.value)))}
                  className="w-full rounded-xl border-2 border-transparent bg-white px-4 py-3 outline-none focus:border-vio"
                />
              </label>
            ))}
          </div>
        </section>

        {error && (
          <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-full bg-vio px-8 py-4 text-lg font-semibold text-white shadow-lg shadow-vio/30 transition hover:bg-vio-deep disabled:opacity-60"
        >
          {loading ? "Planning your week — this can take up to a minute" : "Generate my week"}
        </button>
      </form>
    </main>
  );
}
