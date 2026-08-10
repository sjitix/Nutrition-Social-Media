import { imageForMeal, cutoutForMeal } from "@/lib/recipes";
import { demoWeek, DEMO } from "../demo";
import { TodayClient, type DayFeed } from "./TodayClient";

/**
 * Today — an exploration, built from `designs/references/boards/sage-04`.
 *
 * That board is the inversion of the others: a near-black forest GROUND carrying cream cards,
 * with three circular arc gauges and a plate photograph inside the largest card. Ana's brief for
 * what those parts should hold: the photograph is the dish coming up next, the three circles are
 * the macros already hit, and the upcoming meals sit below them. The week screen stays as it is —
 * this is the day.
 *
 * WHY THE WHOLE WEEK IS SENT TO THE CLIENT. "Today" and "already eaten" both depend on a clock,
 * and the server's clock is not the reader's — on the static Pages export it is the clock at BUILD
 * time, which could be days old. So the server hands over the week and the browser decides which
 * day it is and which meals are behind it. First client render matches the server exactly (nothing
 * eaten yet), then an effect moves it to the real time, so there is no hydration mismatch.
 *
 * The engine is untouched: the week is `selectWeekFromDb`'s, shared through `demo.ts` with every
 * other screen, and the macros are derived from ingredients against USDA.
 */
export default function SageTodayPage() {
  const { days } = demoWeek();

  // Only what the screen needs, so the payload is 21 small objects rather than the recipe library.
  const feed: DayFeed[] = days.map((d) => ({
    day: d.day,
    meals: d.meals.map((m) => ({
      name: m.name,
      type: m.type,
      description: m.description,
      calories: m.calories,
      protein: m.proteinGrams,
      carbs: m.carbsGrams,
      fat: m.fatGrams,
      fibre: m.fiberGrams ?? 0,
      minutes: m.timeMinutes,
      // The left panel of the main card shows the photograph when the dish has one and the
      // ingredient list when it does not — 496 of 500 recipes are in the second case, so that
      // panel has to be worth looking at without a picture, and a dish's own ingredients are the
      // most useful thing that can honestly go there.
      ingredients: m.ingredients.map((i) => ({ name: i.name, quantity: i.quantity })),
      image: imageForMeal(m.name),
      cutout: cutoutForMeal(m.name),
    })),
  }));

  return (
    <TodayClient
      week={feed}
      targets={{
        calories: DEMO.targetCalories,
        protein: DEMO.proteinGrams,
        carbs: DEMO.carbsGrams,
        fat: DEMO.fatGrams,
        fibre: 30,
      }}
    />
  );
}
